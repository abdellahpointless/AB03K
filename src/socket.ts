import { DatabaseState, User, KanbanItem, Transaction } from './db';
import { supabase, isSupabaseConfigured } from './supabase';
import { localDb } from './db/indexedDb';
import { recordRealtimeEvent } from './lib/db';

const DB_KEY = 'kanban_offline_db';

// Singleton in-memory state
let state: DatabaseState = { 
  users: [], 
  items: [], 
  transactions: [], 
  settings: { picturePosition: '50% 50%', pictureScale: 1.0 } 
};

const listeners = new Set<(state: DatabaseState) => void>();

function notifyUpdate() {
  const snapshot = { ...state };
  listeners.forEach(l => l(snapshot));
}

export function getSocketState(): DatabaseState {
  return state;
}

export function subscribeToSocketState(listener: (state: DatabaseState) => void) {
  listeners.add(listener);
  listener({ ...state });
  return () => {
    listeners.delete(listener);
  };
}

// Session cache for item histories to avoid repeated fetches
const itemHistorySessionCache = new Map<string, { txs: Transaction[]; timestamp: number }>();

// Track when items were last fetched to enable delta sync
let lastItemsSyncTime: number = 0;
let tabHiddenTime: number = 0;
let hasInitialItemsLoaded = false;

/**
 * Loads items from local Dexie database for instant UI paint
 */
async function loadItemsFromLocalDb(): Promise<boolean> {
  try {
    const localItems = await localDb.items.toArray();
    if (localItems.length > 0) {
      localItems.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
      state.items = localItems;
      notifyUpdate();
      return true;
    }
  } catch (e) {
    console.error("Failed to load items from IndexedDB", e);
  }

  // Fallback to localStorage if IndexedDB is empty
  try {
    const saved = localStorage.getItem(DB_KEY);
    if (saved) {
      const parsed = JSON.parse(saved);
      if (parsed.items && parsed.items.length > 0) {
        state.items = parsed.items;
        if (parsed.settings) state.settings = parsed.settings;
        notifyUpdate();
        return true;
      }
    }
  } catch {
    // Ignore JSON errors
  }

  return false;
}

/**
 * Saves specific items to Dexie without wiping tables
 */
async function persistItemsLocally(itemsToSave: KanbanItem[]) {
  try {
    await localDb.items.bulkPut(itemsToSave);
  } catch (e) {
    console.error("Error writing items to IndexedDB", e);
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
    pictureUrl: r.pictureUrl ?? r.pictureurl ?? null,
    order: typeof r.order === 'number' ? r.order : 0,
    updated_at: r.updated_at
  };
}

/**
 * Downloads items ONLY from Supabase (rule 6: only displayed columns, paged, ordered)
 */
async function fetchItemsFromSupabase(): Promise<KanbanItem[]> {
  if (!isSupabaseConfigured) return [];

  const pageSize = 1000;
  let allItems: KanbanItem[] = [];
  let from = 0;

  while (true) {
    let { data, error } = await supabase
      .from('items')
      .select('id, reference, quantity, "securityLimit", "pictureUrl", order, updated_at')
      .order('order', { ascending: true })
      .range(from, from + pageSize - 1);

    if (error) {
      console.warn('Exact column fetch failed, trying generic select fallback:', error.message);
      const fallback = await supabase
        .from('items')
        .select('*')
        .order('order', { ascending: true })
        .range(from, from + pageSize - 1);

      if (fallback.error) {
        console.error('Items fetch error from Supabase:', fallback.error);
        break;
      }
      data = fallback.data;
    }

    if (!data || data.length === 0) break;
    const normalized = data.map(normalizeItemRecord);
    allItems.push(...normalized);
    if (data.length < pageSize) break;
    from += pageSize;
  }

  return allItems;
}

/**
 * Delta sync: fetches only items updated since lastSeen
 */
async function syncUpdatedItemsOnly(lastSeenIso: string) {
  if (!isSupabaseConfigured) return;

  try {
    const { data, error } = await supabase
      .from('items')
      .select('id, reference, quantity, "securityLimit", "pictureUrl", order, updated_at')
      .gt('updated_at', lastSeenIso)
      .limit(200);

    if (error) {
      console.warn('Delta sync error (updated_at query):', error);
      return;
    }

    if (data && data.length > 0) {
      const updatedList = data.map(normalizeItemRecord);
      const itemsMap = new Map(state.items.map(i => [i.id!, i]));
      
      updatedList.forEach(item => {
        if (item.id) itemsMap.set(item.id, item);
      });

      const merged = Array.from(itemsMap.values()).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
      state.items = merged;
      persistItemsLocally(updatedList);
      notifyUpdate();
    }
  } catch (e) {
    console.error('Failed delta sync', e);
  }
}

/**
 * Initializes data: paints from Dexie instantly, then synchronizes once with Supabase
 */
export async function initializeData() {
  if (hasInitialItemsLoaded) return;

  // 1. Paint immediately from local storage
  const hadLocalItems = await loadItemsFromLocalDb();

  // 2. If Supabase configured, perform single network fetch for items
  if (isSupabaseConfigured) {
    try {
      const remoteItems = await fetchItemsFromSupabase();
      if (remoteItems.length > 0) {
        state.items = remoteItems;
        await persistItemsLocally(remoteItems);
        notifyUpdate();
      } else if (hadLocalItems && state.items.length > 0) {
        // Supabase is connected but empty, while local DB has items.
        // Auto-seed Supabase so local data is published online immediately!
        console.log('Publishing existing local items to Supabase...');
        const upsertPayload = state.items.map(it => ({
          id: it.id,
          reference: it.reference,
          quantity: it.quantity,
          securityLimit: it.securityLimit,
          pictureUrl: it.pictureUrl,
          order: it.order ?? 0,
          updated_at: it.updated_at || new Date().toISOString()
        }));
        await supabase.from('items').upsert(upsertPayload, { onConflict: 'id' });
      }
      lastItemsSyncTime = Date.now();
    } catch (err) {
      console.error('Initial Supabase items fetch failed, continuing with cached items:', err);
    }
  }

  hasInitialItemsLoaded = true;
}

export const dataReady = initializeData();

// Window focus / visibility listener: refetch only if tab hidden > 5 minutes (Rule 3 & 11)
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      tabHiddenTime = Date.now();
    } else if (document.visibilityState === 'visible') {
      const hiddenDuration = Date.now() - tabHiddenTime;
      // 5 minutes = 300,000 ms
      if (tabHiddenTime > 0 && hiddenDuration > 5 * 60 * 1000) {
        const lastIso = new Date(lastItemsSyncTime || (Date.now() - hiddenDuration)).toISOString();
        lastItemsSyncTime = Date.now();
        syncUpdatedItemsOnly(lastIso);
      }
    }
  });
}

// ----------------------------------------------------
// Realtime Singleton: Items table ONLY (Rules 4, 5, 7)
// ----------------------------------------------------
let itemsRealtimeChannel: ReturnType<typeof supabase.channel> | null = null;

function setupRealtime() {
  if (!isSupabaseConfigured || itemsRealtimeChannel) return;

  // Single shared singleton channel for items
  itemsRealtimeChannel = supabase.channel('singleton:items-changes')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'items' }, (payload) => {
      const { eventType, new: newRecord, old: oldRecord } = payload;
      recordRealtimeEvent('items', eventType);

      if (eventType === 'UPDATE' && newRecord) {
        const updatedItem = normalizeItemRecord(newRecord);
        const idx = state.items.findIndex(i => i.id === updatedItem.id);
        if (idx > -1) {
          state.items[idx] = { ...state.items[idx], ...updatedItem };
        } else {
          state.items.push(updatedItem);
        }
        state.items.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
        localDb.items.put(updatedItem).catch(console.error);
        persistItemsLocally(state.items);
        notifyUpdate();
      } else if (eventType === 'INSERT' && newRecord) {
        const newItem = normalizeItemRecord(newRecord);
        if (!state.items.some(i => i.id === newItem.id)) {
          state.items.push(newItem);
          state.items.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
          localDb.items.put(newItem).catch(console.error);
          persistItemsLocally(state.items);
          notifyUpdate();
        }
      } else if (eventType === 'DELETE' && oldRecord) {
        const deletedId = (oldRecord as { id: string }).id;
        state.items = state.items.filter(i => i.id !== deletedId);
        localDb.items.delete(deletedId).catch(console.error);
        persistItemsLocally(state.items);
        notifyUpdate();
      }
    })
    .subscribe((status) => {
      if (status === 'SUBSCRIBED') {
        console.log('Supabase Realtime connected for items channel.');
      } else if (status === 'CHANNEL_ERROR') {
        console.warn('Supabase Realtime channel error. Check Replication settings on items table.');
      }
    });
}

if (isSupabaseConfigured) {
  setupRealtime();
}

// Clean up channel on Vite HMR dispose to prevent duplicate listeners
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    if (itemsRealtimeChannel) {
      supabase.removeChannel(itemsRealtimeChannel);
      itemsRealtimeChannel = null;
    }
  });
}

// ----------------------------------------------------
// Authentication: Single-row query (Rule 3 & 6)
// ----------------------------------------------------
export async function loginUser(username: string, password: string): Promise<User | null> {
  const cleanUsername = username.trim();

  if (!isSupabaseConfigured) {
    // Offline mode authentication using Dexie or localStorage
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
    return found || null;
  }

  // Check first-admin bootstrap using a count query (head: true)
  const { count, error: countErr } = await supabase
    .from('users')
    .select('id', { count: 'exact', head: true });

  if (!countErr && (count === 0 || count === null) && cleanUsername === 'admin' && password === '121') {
    const newAdmin: User = {
      id: crypto.randomUUID(),
      username: 'admin',
      password: '121',
      role: 'Admin',
      theme: 'dark',
      settings: { notificationMethod: 'none', alertThreshold: 150 }
    };
    await supabase.from('users').insert(newAdmin);
    return {
      id: newAdmin.id,
      username: newAdmin.username,
      role: newAdmin.role,
      theme: newAdmin.theme,
      settings: newAdmin.settings
    };
  }

  // Single-row query: does NOT fetch passwords of other users or large base64 rows
  const { data, error } = await supabase
    .from('users')
    .select('id, username, role, theme, avatarUrl, settings')
    .eq('username', cleanUsername)
    .eq('password', password)
    .maybeSingle();

  if (error || !data) {
    return null;
  }

  return data as User;
}

// ----------------------------------------------------
// Users Tab on demand: loads only when opened (Rule 6)
// ----------------------------------------------------
export async function fetchUsersList(): Promise<User[]> {
  if (!isSupabaseConfigured) {
    const list = await localDb.users.toArray();
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

  const userList = (data || []) as User[];
  state.users = userList;
  notifyUpdate();
  return userList;
}

// ----------------------------------------------------
// Box History on demand: last 20 for that itemId (Rule 4)
// ----------------------------------------------------
export async function fetchItemHistory(itemId: string, limit = 20): Promise<Transaction[]> {
  // Check session cache first (valid for 5 minutes)
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
      .select('id, "itemId", reference, type, quantity, "poNumber", "pictureUrl", date, "userId", username')
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

// ----------------------------------------------------
// Admin Transactions Tab: Server-side Pagination & Filter
// ----------------------------------------------------
export interface TransactionPageResult {
  transactions: Transaction[];
  totalCount: number;
}

export async function fetchTransactionsPage(params: {
  page: number;
  pageSize: number;
  search?: string;
  type?: 'ALL' | 'ADD' | 'REMOVE';
}): Promise<TransactionPageResult> {
  const { page, pageSize, search, type } = params;
  const from = (page - 1) * pageSize;
  const to = from + pageSize - 1;

  if (!isSupabaseConfigured) {
    let collection = localDb.transactions.orderBy('date').reverse();
    let all = await collection.toArray();
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
    .select('id, "itemId", reference, type, quantity, "poNumber", "pictureUrl", date, "userId", username', { count: 'exact' });

  if (search) {
    query = query.or(`reference.ilike.%${search}%,username.ilike.%${search}%,poNumber.ilike.%${search}%`);
  }
  if (type && type !== 'ALL') {
    query = query.eq('type', type);
  }

  query = query.order('date', { ascending: false }).range(from, to);

  const { data, count, error } = await query;
  if (error) {
    console.error('Error fetching transactions page:', error);
    return { transactions: [], totalCount: 0 };
  }

  return {
    transactions: (data || []) as Transaction[],
    totalCount: count || 0
  };
}

// ----------------------------------------------------
// Admin Dashboard Telemetry: Query minimal columns in window
// ----------------------------------------------------
export async function fetchDashboardWindowTransactions(
  startTimestamp: number,
  endTimestamp: number = Date.now()
): Promise<Transaction[]> {
  if (!isSupabaseConfigured) {
    const all = await localDb.transactions.where('date').between(startTimestamp, endTimestamp).toArray();
    return all;
  }

  const { data, error } = await supabase
    .from('transactions')
    .select('id, type, quantity, reference, date, username')
    .gte('date', startTimestamp)
    .lte('date', endTimestamp)
    .order('date', { ascending: true });

  if (error) {
    console.error('Error fetching dashboard window transactions:', error);
    return [];
  }

  return (data || []) as Transaction[];
}

// ----------------------------------------------------
// Socket Operations with Batching & Targeted Writes
// ----------------------------------------------------
export const socket = {
  emit: async (event: string, ...args: any[]) => {
    try {
      if (event === 'addUser') {
        const user = args[0] as User;
        user.id = user.id || crypto.randomUUID();
        if (isSupabaseConfigured) {
          const { error } = await supabase.from('users').insert(user);
          if (error) console.error('Supabase addUser error:', error);
        }
        await localDb.users.put(user);
        state.users.push(user);
        notifyUpdate();

      } else if (event === 'updateUser') {
        const [userId, updates] = args;
        if (isSupabaseConfigured) {
          const { error } = await supabase.from('users').update(updates).eq('id', userId);
          if (error) console.error('Supabase updateUser error:', error);
        }
        await localDb.users.update(userId, updates);
        const idx = state.users.findIndex(u => u.id === userId);
        if (idx > -1) state.users[idx] = { ...state.users[idx], ...updates };
        notifyUpdate();

      } else if (event === 'deleteUser') {
        const [userId] = args;
        if (isSupabaseConfigured) {
          const { error } = await supabase.from('users').delete().eq('id', userId);
          if (error) console.error('Supabase deleteUser error:', error);
        }
        await localDb.users.delete(userId);
        state.users = state.users.filter(u => u.id !== userId);
        notifyUpdate();

      } else if (event === 'addItem') {
        const item = args[0] as KanbanItem;
        item.id = item.id || crypto.randomUUID();
        item.updated_at = new Date().toISOString();
        if (isSupabaseConfigured) {
          const { error } = await supabase.from('items').insert({
            id: item.id,
            reference: item.reference,
            quantity: item.quantity,
            securityLimit: item.securityLimit,
            pictureUrl: item.pictureUrl,
            order: item.order ?? state.items.length,
            updated_at: item.updated_at
          });
          if (error) console.error('Supabase addItem error:', error);
        }
        await localDb.items.put(item);
        state.items.push(item);
        state.items.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
        await persistItemsLocally(state.items);
        notifyUpdate();

      } else if (event === 'updateItem') {
        const [itemId, updates] = args;
        const nowIso = new Date().toISOString();
        const payload = { ...updates, updated_at: nowIso };

        if (isSupabaseConfigured) {
          const { error } = await supabase.from('items').update(payload).eq('id', itemId);
          if (error) console.error('Supabase updateItem error:', error);
        }
        const idx = state.items.findIndex(i => i.id === itemId);
        if (idx > -1) {
          state.items[idx] = { ...state.items[idx], ...payload };
          await localDb.items.put(state.items[idx]);
          await persistItemsLocally(state.items);
          notifyUpdate();
        }

      } else if (event === 'deleteItem') {
        const [itemId] = args;
        if (isSupabaseConfigured) {
          const { error } = await supabase.from('items').delete().eq('id', itemId);
          if (error) console.error('Supabase deleteItem error:', error);
        }
        await localDb.items.delete(itemId);
        itemHistorySessionCache.delete(itemId);
        state.items = state.items.filter(i => i.id !== itemId);
        await persistItemsLocally(state.items);
        notifyUpdate();

      } else if (event === 'reorderItems') {
        // PROPER BATCH REORDER (Fixes Bug F)
        const updates = args[0] as { id: string; order: number }[];
        if (!updates || updates.length === 0) return;

        // Apply immediately to local memory
        const updateMap = new Map(updates.map(u => [u.id, u.order]));
        state.items.forEach(it => {
          if (it.id && updateMap.has(it.id)) {
            it.order = updateMap.get(it.id);
          }
        });
        state.items.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
        await persistItemsLocally(state.items);
        notifyUpdate();

        // Batch persist to Dexie
        const itemsToSave = state.items.filter(it => it.id && updateMap.has(it.id));
        await localDb.items.bulkPut(itemsToSave);

        // Batch update to Supabase using a single upsert (Rule 9 & 12)
        if (isSupabaseConfigured) {
          const upsertPayload = updates.map(u => ({
            id: u.id,
            order: u.order,
            updated_at: new Date().toISOString()
          }));
          const { error } = await supabase.from('items').upsert(upsertPayload, { onConflict: 'id' });
          if (error) {
            console.error('Failed to batch reorder items in Supabase:', error);
          }
        }

      } else if (event === 'batchTake') {
        // BATCH TAKE METHOD: replaces sequential loops (Fixes Bug B & F)
        const { itemUpdates, transactions } = args[0] as {
          itemUpdates: { id: string; quantity: number }[];
          transactions: Transaction[];
        };

        const nowIso = new Date().toISOString();

        // 1. Update items in local memory
        const updateMap = new Map(itemUpdates.map(u => [u.id, u.quantity]));
        state.items.forEach(it => {
          if (it.id && updateMap.has(it.id)) {
            it.quantity = updateMap.get(it.id)!;
            it.updated_at = nowIso;
          }
        });
        await persistItemsLocally(state.items);
        notifyUpdate();

        // 2. Persist updated items to Dexie
        const modifiedItems = state.items.filter(it => it.id && updateMap.has(it.id));
        await localDb.items.bulkPut(modifiedItems);

        // 3. Persist transactions locally
        await localDb.transactions.bulkPut(transactions);

        // Invalidate box history caches for affected items
        transactions.forEach(t => {
          if (t.itemId) itemHistorySessionCache.delete(t.itemId);
        });

        // 4. Batch updates to Supabase (Rule 12: try RPC adjust_stock_bulk first, then fallback)
        if (isSupabaseConfigured) {
          try {
            const bulkOps = itemUpdates.map(u => {
              const matchingTx = transactions.find(t => t.itemId === u.id);
              const delta = matchingTx 
                ? (matchingTx.type === 'REMOVE' ? -matchingTx.quantity : matchingTx.quantity)
                : 0;
              return {
                itemId: u.id,
                delta,
                tx: matchingTx || null
              };
            });

            const { error: rpcErr } = await supabase.rpc('adjust_stock_bulk', { operations: bulkOps });
            if (rpcErr) {
              // Graceful fallback to batch insert and upsert
              const { error: txErr } = await supabase.from('transactions').insert(
                transactions.map(t => ({
                  id: t.id || crypto.randomUUID(),
                  itemId: t.itemId,
                  reference: t.reference,
                  type: t.type,
                  reason: t.reason || null,
                  quantity: t.quantity,
                  poNumber: t.poNumber || null,
                  pictureUrl: t.pictureUrl || null,
                  date: t.date,
                  userId: t.userId,
                  username: t.username
                }))
              );
              if (txErr) console.error('Batch transaction insert error:', txErr);

              const itemsPayload = itemUpdates.map(u => ({
                id: u.id,
                quantity: u.quantity,
                updated_at: nowIso
              }));
              const { error: itemsErr } = await supabase.from('items').upsert(itemsPayload, { onConflict: 'id' });
              if (itemsErr) console.error('Batch item upsert error:', itemsErr);
            }
          } catch (e) {
            console.error('Error during batchTake online sync:', e);
          }
        }

      } else if (event === 'addTransaction') {
        const trans = args[0] as Transaction;
        trans.id = trans.id || crypto.randomUUID();

        // Clear session history cache for this item so next view re-fetches
        if (trans.itemId) {
          itemHistorySessionCache.delete(trans.itemId);
        }

        // Save locally to Dexie
        await localDb.transactions.put(trans);

        if (isSupabaseConfigured) {
          const insertPayload: any = {
            id: trans.id,
            itemId: trans.itemId,
            reference: trans.reference,
            type: trans.type,
            quantity: trans.quantity,
            poNumber: trans.poNumber || null,
            pictureUrl: trans.pictureUrl || null,
            date: trans.date,
            userId: trans.userId,
            username: trans.username
          };
          if (trans.reason) insertPayload.reason = trans.reason;

          const { error } = await supabase.from('transactions').insert(insertPayload);
          if (error) {
            console.error('Supabase transaction insert error:', error);
          }
        }

      } else if (event === 'deleteTransaction') {
        const [txId] = args;
        if (isSupabaseConfigured) {
          await supabase.from('transactions').delete().eq('id', txId);
        }
        await localDb.transactions.delete(txId);

      } else if (event === 'updateSettings') {
        state.settings = { ...state.settings, ...args[0] };
        try {
          localStorage.setItem(DB_KEY, JSON.stringify({
            items: state.items,
            settings: state.settings
          }));
        } catch {
          // ignore quota
        }
        notifyUpdate();
      }

    } catch (e) {
      console.error('Socket emit error:', e);
    }
  },

  on: () => {
    // Unused: React components subscribe via subscribeToSocketState
  }
};
