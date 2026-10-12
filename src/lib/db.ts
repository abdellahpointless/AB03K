import { supabase, isSupabaseConfigured } from '../supabase';

const IS_DEV = import.meta.env.DEV;

// ---------------------------------------------------------------------------
// Circuit Breaker: > 60 requests in 1 minute halts calls & alerts UI
// ---------------------------------------------------------------------------
const REQUEST_WINDOW_MS = 60 * 1000;
const MAX_REQUESTS_PER_MINUTE = 60;
let requestTimestamps: number[] = [];
let isBreakerTripped = false;
let breakerBannerElement: HTMLDivElement | null = null;

const breakerListeners = new Set<(tripped: boolean) => void>();

export function isCircuitBreakerOpen(): boolean {
  return isBreakerTripped;
}

export function subscribeToCircuitBreaker(listener: (tripped: boolean) => void) {
  breakerListeners.add(listener);
  return () => {
    breakerListeners.delete(listener);
  };
}

function showCircuitBreakerBanner() {
  if (typeof document === 'undefined') return;
  if (!breakerBannerElement) {
    breakerBannerElement = document.createElement('div');
    breakerBannerElement.id = 'supabase-circuit-breaker-banner';
    breakerBannerElement.className = 
      'fixed top-0 left-0 right-0 z-[9999] bg-rose-600 text-white font-bold py-2.5 px-4 text-center text-sm shadow-xl flex items-center justify-center gap-3 animate-bounce';
    breakerBannerElement.innerHTML = `
      <span>🚨 <strong>Circuit Breaker Activated:</strong> Exceeded 60 Supabase requests/min. Network writes paused to protect your free tier budget.</span>
      <button id="reset-circuit-breaker" class="bg-white/20 hover:bg-white/30 text-white text-xs px-2.5 py-1 rounded transition">Reset</button>
    `;
    document.body.appendChild(breakerBannerElement);

    const resetBtn = document.getElementById('reset-circuit-breaker');
    resetBtn?.addEventListener('click', () => {
      resetCircuitBreaker();
    });
  }
}

export function resetCircuitBreaker() {
  isBreakerTripped = false;
  requestTimestamps = [];
  if (breakerBannerElement && breakerBannerElement.parentNode) {
    breakerBannerElement.parentNode.removeChild(breakerBannerElement);
    breakerBannerElement = null;
  }
  breakerListeners.forEach(l => l(false));
}

function recordRequest(): boolean {
  const now = Date.now();
  requestTimestamps = requestTimestamps.filter(t => now - t < REQUEST_WINDOW_MS);

  if (requestTimestamps.length >= MAX_REQUESTS_PER_MINUTE) {
    if (!isBreakerTripped) {
      isBreakerTripped = true;
      console.error(`🚨 [Usage Guard] Circuit breaker tripped! ${requestTimestamps.length} requests in last 60 seconds.`);
      showCircuitBreakerBanner();
      breakerListeners.forEach(l => l(true));
    }
    return false;
  }

  requestTimestamps.push(now);
  return true;
}

// ---------------------------------------------------------------------------
// Query Duplication & Size Guard (Development only)
// ---------------------------------------------------------------------------
interface QueryLog {
  key: string;
  timestamps: number[];
}
const queryLogs = new Map<string, QueryLog>();

function logQueryDev(table: string, operation: string, responseData?: any) {
  if (!IS_DEV) return;

  const now = Date.now();
  const queryKey = `${table}:${operation}`;
  
  let entry = queryLogs.get(queryKey);
  if (!entry) {
    entry = { key: queryKey, timestamps: [] };
    queryLogs.set(queryKey, entry);
  }
  entry.timestamps = entry.timestamps.filter(t => now - t < 10000); // 10s window
  entry.timestamps.push(now);

  if (entry.timestamps.length > 3) {
    console.warn(`⚠️ [Usage Guard] High query frequency: ${queryKey} executed ${entry.timestamps.length} times in 10s!`);
  }

  if (responseData) {
    try {
      const approxBytes = new Blob([JSON.stringify(responseData)]).size;
      const kb = (approxBytes / 1024).toFixed(1);
      if (approxBytes > 200 * 1024) {
        console.warn(`⚠️ [Usage Guard] Large payload: ${queryKey} response is ${kb} KB (> 200 KB threshold)!`);
      }
      console.debug(`[Supabase Guard] ${queryKey} -> ~${kb} KB`);
    } catch {
      // ignore
    }
  }
}

// ---------------------------------------------------------------------------
// Realtime Event Rate Guard: warn if > 60 events / min
// ---------------------------------------------------------------------------
let realtimeEventTimestamps: number[] = [];

export function recordRealtimeEvent(table: string, eventType: string) {
  const now = Date.now();
  realtimeEventTimestamps = realtimeEventTimestamps.filter(t => now - t < 60000);
  realtimeEventTimestamps.push(now);

  if (IS_DEV && realtimeEventTimestamps.length > 60) {
    console.warn(`⚠️ [Usage Guard] Realtime event flood: received ${realtimeEventTimestamps.length} events in 1 minute on ${table}:${eventType}`);
  }
}

// ---------------------------------------------------------------------------
// Unified DB Accessor with Usage Guard
// ---------------------------------------------------------------------------
export async function executeGuarded<T>(
  table: string,
  operation: string,
  action: () => Promise<{ data: T | null; error: any }>
): Promise<{ data: T | null; error: any }> {
  if (!isSupabaseConfigured) {
    return { data: null, error: new Error('Supabase not configured') };
  }

  if (!recordRequest()) {
    return { data: null, error: new Error('Circuit breaker open - rate limit exceeded') };
  }

  try {
    const res = await action();
    if (res.data) {
      logQueryDev(table, operation, res.data);
    }
    return res;
  } catch (err) {
    return { data: null, error: err };
  }
}

export { supabase, isSupabaseConfigured };
