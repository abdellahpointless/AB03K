import { DatabaseState, User, KanbanItem, Transaction, Role } from './db';
import { supabase, isSupabaseConfigured } from './supabase';
import { localDb } from './db/indexedDb';
import { recordRealtimeEvent } from './lib/db';

const DB_KEY = 'kanban_offline_db';
const DEFAULT_SETTINGS = { picturePosition: '50% 50%', pictureScale: 1.0 };

// Singleton in-memory state
let state: DatabaseState = {
  users: [],
  items: [],
  transactions: [],
  settings: { ...DEFAULT_SETTINGS }
};

const listeners = new Set<(state: DatabaseState) => void>();

function notifyUpdate() {
  // Fresh array references so React re-renders when items change in place
  const snapshot: DatabaseState = {
    ...state,
    users: [...state.users],
    items: [...state.items],
    transactions: [...state.transactions],
    settings: state.settings ? { ...state.settings } : undefined
  };
  listeners.forEach(l => l(snapshot));
}

export function getSocketState(): DatabaseState {
  return state;
}

export function subscribeToSocketState(listener: (state: DatabaseState) => void) {
  listeners.add(listener);
  listener({ ...state, items: [...state.items], users: [...state.users] });
  return () => {
    listeners.delete(listener);
  };
}

/** Logs an error and tells the user, so failed writes are never silent. */
export function reportError(context: string, err: unknown) {
  console.error(context, err);
  const message = (err as { message?: string })?.message || String(err);
  alert(`${context}: ${message}`);
}

function sortItems() {
  state.items.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
}

// Session cache for item histories to avoid repeated fetches
const itemHistorySessionCache = new Map<string, { txs: Transaction[]; timestamp: number }>();

// Track when items were last fetched to enable delta sync
let lastItemsSyncTime = 0;
let tabHiddenTime = 0;
let initPromise: Promise<void> | null = null;

/**
 * Loads items from local Dexie database for instant UI paint
 */
async function loadItemsFromLocalDb(): Promise<boolean> {
  try {
    const localItems = await localDb.items.toArray();
    if (localItems.length > 0) {
      localItems.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
      state.items = localItems;
    }
  } catch (e) {
    console.error('Failed to load items from IndexedDB', e);
  }

  try {
    const saved = localStorage.getItem(DB_KEY);
    if (saved) {
      const parsed = JSON.parse(saved);
      if (state.items.length === 0 && parsed.items && parsed.items.length > 0) {
        state.items = parsed.items;
      }
      if (parsed.settings) state.settings = parsed.settings;
    }
  } catch {
    // Ignore JSON errors
  }

  notifyUpdate();
  return state.items.length > 0;
}

/**
 * Mirrors the current item list to Dexie and localStorage.
 * Replaces the table so boxes deleted elsewhere don't come back from the cache.
 */
async function persistItemsLocally() {
  try {
    await localDb.transaction('rw', localDb.items, async () => {
      await localDb.items.clear();
      await localDb.items.bulkPut(state.items);
    });
  } catch (e) {
    console.error('Error writing items to IndexedDB', e);
  }

  try {
    localStorage.setItem(DB_KEY, JSON.stringify({
      items: state.items,
      settings: state.settings
    }));
  } catch {
    // Quota reached, safe to ignore
  }
}

function normalizeItemRecord(r: any): KanbanItem {
  return {
    id: r.id,
    reference: r.reference,
    quantity: typeof r.quantity === 'number' ? r.quantity : (parseInt(r.quantity) || 0),
    securityLimit: r.securityLimit ?? r.securitylimit ?? r.security_limit ?? 0,
    pictureUrl: r.pictureUrl ?? r.pictureurl ?? undefined,
    order: typeof r.order === 'number' ? r.order : 0,
    updated_at: r.updated_at
  };
}

const ITEM_COLUMNS = 'id, reference, quantity, "securityLimit", "pictureUrl", order, updated_at';
const TX_COLUMNS = 'id, "itemId", reference, type, reason, quantity, "poNumber", "pictureUrl", date, "userId", username';

/**
 * Downloads all items from Supabase (paged, ordered). Throws on error so a
 * failed fetch is never mistaken for an empty rack.
 */
async function fetchItemsFromSupabase(): Promise<KanbanItem[]> {
  const pageSize = 1000;
  const allItems: KanbanItem[] = [];
  let from = 0;

  while (true) {
    const { data, error } = await supabase
      .from('items')
      .select(ITEM_COLUMNS)
      .order('order', { ascending: true })
      .range(from, from + pageSize - 1);

    if (error) throw error;
    if (!data || data.length === 0) break;
    allItems.push(...data.map(normalizeItemRecord));
    if (data.length < pageSize) break;
    from += pageSize;
  }

  return allItems;
}

async function fetchSettingsFromSupabase() {
  const { data, error } = await supabase
    .from('app_settings')
    .select('"picturePosition", "pictureScale"')
    .eq('id', 1)
    .maybeSingle();
  if (error) {
    console.warn('Could not load shared settings:', error.message);
    return;
  }
  if (data) {
    state.settings = { picturePosition: data.picturePosition, pictureScale: Number(data.pictureScale) };
  }
}

/** Re-downloads the whole rack, used to recover after a failed write. */
export async function refreshItems() {
  if (!isSupabaseConfigured) return;
  try {
    state.items = await fetchItemsFromSupabase();
    lastItemsSyncTime = Date.now();
    await persistItemsLocally();
    notifyUpdate();
  } catch (e) {
    console.error('Failed to refresh items', e);
  }
}

/**
 * Delta sync: fetches only items updated since lastSeen
 */
async function syncUpdatedItemsOnly(lastSeenIso: string) {
  if (!isSupabaseConfigured) return;

  try {
    const { data, error } = await supabase
      .from('items')
      .select(ITEM_COLUMNS)
      .gt('updated_at', lastSeenIso)
      .limit(200);

    if (error) {
      console.warn('Delta sync error (updated_at query):', error);
      return;
    }

    if (data && data.length > 0) {
      const itemsMap = new Map(state.items.map(i => [i.id!, i]));
      data.map(normalizeItemRecord).forEach(item => {
        if (item.id) itemsMap.set(item.id, item);
      });
      state.items = Array.from(itemsMap.values());
      sortItems();
      await persistItemsLocally();
      notifyUpdate();
    }
  } catch (e) {
    console.error('Failed delta sync', e);
  }
}

/**
 * Loads data for a signed-in session: paints from the local cache instantly,
 * then synchronizes once with Supabase and starts realtime updates.
 */
export function initializeData(): Promise<void> {
  if (!initPromise) {
    initPromise = (async () => {
      await loadItemsFromLocalDb();

      if (isSupabaseConfigured) {
        try {
          const [remoteItems] = await Promise.all([fetchItemsFromSupabase(), fetchSettingsFromSupabase()]);
          state.items = remoteItems;
          lastItemsSyncTime = Date.now();
          await persistItemsLocally();
          notifyUpdate();
        } catch (err) {
          console.error('Initial Supabase items fetch failed, continuing with cached items:', err);
        }
        setupRealtime();
      }
    })();
  }
  return initPromise;
}

// Window focus / visibility listener: refetch only if tab hidden > 5 minutes
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (!initPromise) return;
    if (document.visibilityState === 'hidden') {
      tabHiddenTime = Date.now();
    } else if (document.visibilityState === 'visible') {
      const hiddenDuration = Date.now() - tabHiddenTime;
      if (tabHiddenTime > 0 && hiddenDuration > 5 * 60 * 1000) {
        const lastIso = new Date(lastItemsSyncTime || (Date.now() - hiddenDuration)).toISOString();
        lastItemsSyncTime = Date.now();
        syncUpdatedItemsOnly(lastIso);
      }
    }
  });
}

// ----------------------------------------------------
// Realtime: items and shared settings
// ----------------------------------------------------
let realtimeChannel: ReturnType<typeof supabase.channel> | null = null;

function setupRealtime() {
  if (!isSupabaseConfigured || realtimeChannel) return;

  realtimeChannel = supabase.channel('kanban-changes')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'items' }, (payload) => {
      const { eventType, new: newRecord, old: oldRecord } = payload;
      recordRealtimeEvent('items', eventType);

      if ((eventType === 'UPDATE' || eventType === 'INSERT') && newRecord) {
        const item = normalizeItemRecord(newRecord);
        const idx = state.items.findIndex(i => i.id === item.id);
        if (idx > -1) {
          state.items[idx] = { ...state.items[idx], ...item };
        } else {
          state.items.push(item);
        }
        sortItems();
      } else if (eventType === 'DELETE' && oldRecord) {
        const deletedId = (oldRecord as { id: string }).id;
        state.items = state.items.filter(i => i.id !== deletedId);
        itemHistorySessionCache.delete(deletedId);
      } else {
        return;
      }
      persistItemsLocally();
      notifyUpdate();
    })
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'app_settings' }, (payload) => {
      const s = payload.new as { picturePosition?: string; pictureScale?: number };
      if (s) {
        state.settings = {
          picturePosition: s.picturePosition ?? DEFAULT_SETTINGS.picturePosition,
          pictureScale: Number(s.pictureScale ?? DEFAULT_SETTINGS.pictureScale)
        };
        notifyUpdate();
      }
    })
    .subscribe((status) => {
      if (status === 'CHANNEL_ERROR') {
        console.warn('Supabase Realtime channel error. Check Replication settings on the items table.');
      }
    });
}

function teardownRealtime() {
  if (realtimeChannel) {
    supabase.removeChannel(realtimeChannel);
    realtimeChannel = null;
  }
}

// Clean up channel on Vite HMR dispose to prevent duplicate listeners
if (import.meta.hot) {
  import.meta.hot.dispose(teardownRealtime);
}

// ----------------------------------------------------
// Authentication (Supabase Auth)
// ----------------------------------------------------

/**
 * Supabase Auth signs in with an e-mail, so each username maps to a fixed
 * internal address. Must match public.username_to_email() in supabase/schema.sql.
 */
export async function usernameToEmail(username: string): Promise<string> {
  const bytes = new TextEncoder().encode(username.trim().toLowerCase());
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const hex = Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 32)}@kanban.local`;
}

async function fetchProfile(userId: string): Promise<User | null> {
  const { data, error } = await supabase
    .from('users')
    .select('id, username, role, theme, avatarUrl, settings')
    .eq('id', userId)
    .maybeSingle();
  if (error) throw error;
  return (data as User) || null;
}

export async function loginUser(username: string, password: string): Promise<User | null> {
  const cleanUsername = username.trim();

  if (!isSupabaseConfigured) {
    // Offline mode authentication using the browser's local database
    const localUsers = await localDb.users.toArray();
    if (localUsers.length === 0 && cleanUsername === 'admin' && password === '121') {
      const adminUser: User = {
        id: crypto.randomUUID(),
        username: 'admin',
        password: '121',
        role: 'Admin',
        theme: 'dark',
        settings: { notificationMethod: 'none', alertThreshold: 150 }
      };
      await localDb.users.put(adminUser);
      return adminUser;
    }
    const found = localUsers.find(u => u.username.toLowerCase() === cleanUsername.toLowerCase() && u.password === password);
    if (!found) return null;
    const { password: _pw, ...safeUser } = found;
    return safeUser;
  }

  const { data, error } = await supabase.auth.signInWithPassword({
    email: await usernameToEmail(cleanUsername),
    password
  });
  if (error) {
    if (error.status === 400) return null; // wrong username or password
    throw error;
  }

  const profile = await fetchProfile(data.user.id);
  if (!profile) {
    await supabase.auth.signOut();
    throw new Error('This login has no user profile. Ask an Admin to recreate the user.');
  }
  return profile;
}

/** Returns the signed-in user from the stored Supabase session, if any. */
export async function restoreSession(): Promise<User | null> {
  if (!isSupabaseConfigured) {
    // Offline mode: re-read the cached user from the local database so a
    // role edited in localStorage is not trusted.
    try {
      const cached = JSON.parse(localStorage.getItem('kanbanUser') || 'null') as User | null;
      if (!cached?.id) return null;
      const found = await localDb.users.get(cached.id);
      if (!found) return null;
      const { password: _pw, ...safeUser } = found;
      return safeUser;
    } catch {
      return null;
    }
  }

  const { data } = await supabase.auth.getSession();
  if (!data.session) return null;
  try {
    return await fetchProfile(data.session.user.id);
  } catch (e) {
    console.error('Failed to load profile for stored session', e);
    return null;
  }
}

export async function logoutUser() {
  teardownRealtime();
  initPromise = null;
  itemHistorySessionCache.clear();
  state = { users: [], items: [], transactions: [], settings: { ...DEFAULT_SETTINGS } };
  notifyUpdate();
  if (isSupabaseConfigured) {
    await supabase.auth.signOut();
  }
}

// ----------------------------------------------------
// Users
// ----------------------------------------------------
export async function fetchUsersList(): Promise<User[]> {
  if (!isSupabaseConfigured) {
    const list = (await localDb.users.toArray()).map(({ password: _pw, ...u }) => u);
    state.users = list;
    return list;
  }

  const { data, error } = await supabase
    .from('users')
    .select('id, username, role, theme, avatarUrl, settings')
    .order('username', { ascending: true });

  if (error) {
    console.error('Failed to load users list:', error);
    return state.users;
  }

  state.users = (data || []) as User[];
  notifyUpdate();
  return state.users;
}

/** Updates the signed-in user's own preferences (theme, avatar, alert settings). */
export async function updateOwnProfile(userId: string, updates: Pick<Partial<User>, 'theme' | 'avatarUrl' | 'settings'>) {
  if (isSupabaseConfigured) {
    const { error } = await supabase.from('users').update(updates).eq('id', userId);
    if (error) throw error;
  } else {
    await localDb.users.update(userId, updates);
  }
}

export async function createUser(username: string, password: string, role: Role) {
  if (isSupabaseConfigured) {
    const { error } = await supabase.rpc('admin_create_user', { p_username: username, p_password: password, p_role: role });
    if (error) throw error;
    return;
  }
  const exists = (await localDb.users.toArray()).some(u => u.username.toLowerCase() === username.trim().toLowerCase());
  if (exists) throw new Error(`Username "${username}" is already taken`);
  await localDb.users.put({
    id: crypto.randomUUID(),
    username: username.trim(),
    password,
    role,
    theme: 'dark',
    settings: { notificationMethod: 'none', alertThreshold: 150 }
  });
}

/** Admin edit of another user. An empty password leaves it unchanged. */
export async function adminUpdateUser(userId: string, username: string, role: Role, password?: string) {
  if (isSupabaseConfigured) {
    const { error } = await supabase.rpc('admin_update_user', {
      p_user_id: userId,
      p_username: username,
      p_role: role,
      p_password: password || null
    });
    if (error) throw error;
    return;
  }
  const updates: Partial<User> = { username: username.trim(), role };
  if (password) updates.password = password;
  await localDb.users.update(userId, updates);
}

export async function deleteUser(userId: string) {
  if (isSupabaseConfigured) {
    const { error } = await supabase.rpc('admin_delete_user', { p_user_id: userId });
    if (error) throw error;
    return;
  }
  await localDb.users.delete(userId);
}

// ----------------------------------------------------
// Item history and transaction queries
// ----------------------------------------------------
export async function fetchItemHistory(itemId: string, limit = 20): Promise<Transaction[]> {
  const cached = itemHistorySessionCache.get(itemId);
  if (cached && (Date.now() - cached.timestamp < 5 * 60 * 1000)) {
    return cached.txs;
  }

  if (!isSupabaseConfigured) {
    try {
      const localTxs = await localDb.transactions.where('itemId').equals(itemId).reverse().sortBy('date');
      const sliced = localTxs.slice(0, limit);
      itemHistorySessionCache.set(itemId, { txs: sliced, timestamp: Date.now() });
      return sliced;
    } catch {
      return [];
    }
  }

  try {
    const { data, error } = await supabase
      .from('transactions')
      .select(TX_COLUMNS)
      .eq('itemId', itemId)
      .order('date', { ascending: false })
      .limit(limit);

    if (error) {
      console.error(`Failed to fetch history for item ${itemId}:`, error);
      return cached ? cached.txs : [];
    }

    const txs = (data || []) as Transaction[];
    itemHistorySessionCache.set(itemId, { txs, timestamp: Date.now() });
    return txs;
  } catch (e) {
    console.error('Exception fetching item history:', e);
    return [];
  }
}

export interface TransactionPageResult {
  transactions: Transaction[];
  totalCount: number;
}

/** Strips characters that have meaning inside a PostgREST or() filter. */
function sanitizeSearch(search: string): string {
  return search.replace(/[,()*%\\:"']/g, ' ').trim();
}

export async function fetchTransactionsPage(params: {
  page: number;
  pageSize: number;
  search?: string;
  type?: 'ALL' | 'ADD' | 'REMOVE';
}): Promise<TransactionPageResult> {
  const { page, pageSize, type } = params;
  const search = sanitizeSearch(params.search || '');
  const from = (page - 1) * pageSize;
  const to = from + pageSize - 1;

  if (!isSupabaseConfigured) {
    let all = await localDb.transactions.orderBy('date').reverse().toArray();
    if (search) {
      const q = search.toLowerCase();
      all = all.filter(t => t.reference.toLowerCase().includes(q) || t.username.toLowerCase().includes(q) || (t.poNumber && t.poNumber.toLowerCase().includes(q)));
    }
    if (type && type !== 'ALL') {
      all = all.filter(t => t.type === type);
    }
    return {
      transactions: all.slice(from, to + 1),
      totalCount: all.length
    };
  }

  let query = supabase
    .from('transactions')
    .select(TX_COLUMNS, { count: 'exact' });

  if (search) {
    query = query.or(`reference.ilike.*${search}*,username.ilike.*${search}*,poNumber.ilike.*${search}*`);
  }
  if (type && type !== 'ALL') {
    query = query.eq('type', type);
  }

  const { data, count, error } = await query.order('date', { ascending: false }).range(from, to);
  if (error) {
    console.error('Error fetching transactions page:', error);
    return { transactions: [], totalCount: 0 };
  }

  return {
    transactions: (data || []) as Transaction[],
    totalCount: count || 0
  };
}

/** Every transaction, oldest first. Used for Excel exports and weekly archives. */
export async function fetchAllTransactions(): Promise<Transaction[]> {
  if (!isSupabaseConfigured) {
    return localDb.transactions.orderBy('date').toArray();
  }

  const pageSize = 1000;
  const all: Transaction[] = [];
  let from = 0;
  while (true) {
    const { data, error } = await supabase
      .from('transactions')
      .select(TX_COLUMNS)
      .order('date', { ascending: true })
      .range(from, from + pageSize - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    all.push(...(data as Transaction[]));
    if (data.length < pageSize) break;
    from += pageSize;
  }
  return all;
}

export async function fetchDashboardWindowTransactions(
  startTimestamp: number,
  endTimestamp: number = Date.now()
): Promise<Transaction[]> {
  if (!isSupabaseConfigured) {
    return localDb.transactions.where('date').between(startTimestamp, endTimestamp).toArray();
  }

  const pageSize = 1000;
  const all: Transaction[] = [];
  let from = 0;
  while (true) {
    const { data, error } = await supabase
      .from('transactions')
      .select('id, type, quantity, reference, date, username')
      .gte('date', startTimestamp)
      .lte('date', endTimestamp)
      .order('date', { ascending: true })
      .range(from, from + pageSize - 1);

    if (error) {
      console.error('Error fetching dashboard window transactions:', error);
      break;
    }
    if (!data || data.length === 0) break;
    all.push(...(data as Transaction[]));
    if (data.length < pageSize) break;
    from += pageSize;
  }
  return all;
}

// ----------------------------------------------------
// Items
// ----------------------------------------------------
export async function addItem(item: KanbanItem) {
  const newItem: KanbanItem = {
    ...item,
    id: item.id || crypto.randomUUID(),
    quantity: 0, // initial stock is recorded through adjustStock so it is logged
    order: item.order ?? (state.items.reduce((max, i) => Math.max(max, i.order ?? 0), -1) + 1),
    updated_at: new Date().toISOString()
  };

  if (isSupabaseConfigured) {
    const { error } = await supabase.from('items').insert({
      id: newItem.id,
      reference: newItem.reference,
      quantity: 0,
      securityLimit: newItem.securityLimit,
      pictureUrl: newItem.pictureUrl ?? null,
      order: newItem.order
    });
    if (error) throw error;
  }

  if (!state.items.some(i => i.id === newItem.id)) {
    state.items.push(newItem);
    sortItems();
  }
  await persistItemsLocally();
  notifyUpdate();
  return newItem;
}

/** Edits a box's details. Quantity changes go through adjustStock instead. */
export async function updateItemDetails(itemId: string, updates: Pick<Partial<KanbanItem>, 'reference' | 'securityLimit' | 'pictureUrl'>) {
  if (isSupabaseConfigured) {
    const { error } = await supabase.from('items').update({
      reference: updates.reference,
      securityLimit: updates.securityLimit,
      pictureUrl: updates.pictureUrl ?? null
    }).eq('id', itemId);
    if (error) throw error;
  }
  const idx = state.items.findIndex(i => i.id === itemId);
  if (idx > -1) {
    state.items[idx] = { ...state.items[idx], ...updates, updated_at: new Date().toISOString() };
    await persistItemsLocally();
    notifyUpdate();
  }
}

export async function deleteItem(itemId: string) {
  if (isSupabaseConfigured) {
    const { error } = await supabase.from('items').delete().eq('id', itemId);
    if (error) throw error;
  }
  itemHistorySessionCache.delete(itemId);
  state.items = state.items.filter(i => i.id !== itemId);
  await persistItemsLocally();
  notifyUpdate();
}

export async function reorderItems(updates: { id: string; order: number }[]) {
  if (updates.length === 0) return;

  const updateMap = new Map(updates.map(u => [u.id, u.order]));
  state.items = state.items.map(it => (it.id && updateMap.has(it.id) ? { ...it, order: updateMap.get(it.id) } : it));
  sortItems();
  await persistItemsLocally();
  notifyUpdate();

  if (isSupabaseConfigured) {
    const { error } = await supabase.rpc('reorder_items', { updates });
    if (error) {
      await refreshItems();
      throw error;
    }
  }
}

// ----------------------------------------------------
// Stock movements (atomic on the server, always logged)
// ----------------------------------------------------
export interface StockChange {
  item: KanbanItem;
  /** Positive to add stock, negative to take. */
  delta: number;
  reason?: Transaction['reason'];
  poNumber?: string;
  pictureUrl?: string | null;
}

export interface StockResult {
  transactionId: string;
}

function buildLocalTransaction(change: StockChange, user: User, id: string): Transaction {
  return {
    id,
    itemId: change.item.id!,
    reference: change.item.reference,
    type: change.delta < 0 ? 'REMOVE' : 'ADD',
    reason: change.reason,
    quantity: Math.abs(change.delta),
    poNumber: change.poNumber || undefined,
    pictureUrl: change.pictureUrl || undefined,
    date: Date.now(),
    userId: user.id!,
    username: user.username
  };
}

function applyLocalQuantity(itemId: string, quantity: number) {
  const idx = state.items.findIndex(i => i.id === itemId);
  if (idx > -1) {
    state.items[idx] = { ...state.items[idx], quantity, updated_at: new Date().toISOString() };
  }
}

/**
 * Applies one or more stock changes. Online, the database applies them all or
 * none, rejects anything that would go below zero, and records who did it.
 */
export async function adjustStock(changes: StockChange[], user: User): Promise<StockResult[]> {
  if (changes.length === 0) return [];
  const ids = changes.map(() => crypto.randomUUID());
  changes.forEach(c => itemHistorySessionCache.delete(c.item.id!));

  if (!isSupabaseConfigured) {
    for (const c of changes) {
      const current = state.items.find(i => i.id === c.item.id);
      if (!current || current.quantity + c.delta < 0) {
        throw new Error(`Only ${current?.quantity ?? 0} left of ${c.item.reference}`);
      }
    }
    const txs = changes.map((c, i) => buildLocalTransaction(c, user, ids[i]));
    changes.forEach(c => {
      const current = state.items.find(i => i.id === c.item.id)!;
      applyLocalQuantity(c.item.id!, current.quantity + c.delta);
    });
    await localDb.transactions.bulkPut(txs);
    await persistItemsLocally();
    notifyUpdate();
    return ids.map(transactionId => ({ transactionId }));
  }

  const operations = changes.map((c, i) => ({
    itemId: c.item.id,
    delta: c.delta,
    tx: {
      id: ids[i],
      reason: c.reason || null,
      poNumber: c.poNumber || null,
      pictureUrl: c.pictureUrl || null
    }
  }));

  const { data, error } = await supabase.rpc('adjust_stock_bulk', { operations });
  if (error) {
    await refreshItems();
    throw error;
  }

  (data as { itemId: string; newQuantity: number; transactionId: string }[]).forEach(r => {
    applyLocalQuantity(r.itemId, r.newQuantity);
  });
  await persistItemsLocally();
  notifyUpdate();
  return ids.map(transactionId => ({ transactionId }));
}

/** Reverses a stock movement made a moment ago and removes its log entry. */
export async function undoTransaction(transactionId: string, itemId: string) {
  itemHistorySessionCache.delete(itemId);

  if (!isSupabaseConfigured) {
    const tx = await localDb.transactions.get(transactionId);
    if (!tx) return;
    const current = state.items.find(i => i.id === itemId);
    if (current) {
      applyLocalQuantity(itemId, Math.max(0, current.quantity + (tx.type === 'REMOVE' ? tx.quantity : -tx.quantity)));
    }
    await localDb.transactions.delete(transactionId);
    await persistItemsLocally();
    notifyUpdate();
    return;
  }

  const { data, error } = await supabase.rpc('undo_transaction', { p_tx_id: transactionId });
  if (error) throw error;
  const r = data as { itemId: string | null; newQuantity: number | null };
  if (r?.itemId && r.newQuantity !== null) {
    applyLocalQuantity(r.itemId, r.newQuantity);
    await persistItemsLocally();
    notifyUpdate();
  }
}

// ----------------------------------------------------
// Shared settings
// ----------------------------------------------------
export async function updateSettings(updates: { picturePosition: string; pictureScale: number }) {
  if (isSupabaseConfigured) {
    const { error } = await supabase.from('app_settings').update(updates).eq('id', 1);
    if (error) throw error;
  }
  state.settings = { ...DEFAULT_SETTINGS, ...state.settings, ...updates };
  try {
    localStorage.setItem(DB_KEY, JSON.stringify({ items: state.items, settings: state.settings }));
  } catch {
    // ignore quota
  }
  notifyUpdate();
}
