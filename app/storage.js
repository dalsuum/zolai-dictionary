/**
 * app/storage.js — StorageAdapter
 *
 * WHY prefs-only localStorage after v3?
 *   The full dictionary (7,861 words + 15,702 senses) is 6.34 MB which exceeds
 *   the 5 MB localStorage quota. Storing it causes a silent QuotaExceededError.
 *
 *   FIX BUG 1 + BUG 6:
 *     - Only store lightweight prefs + AI cache in localStorage
 *     - Bump key version to v3 so old stale v1 cached data is ignored
 *     - Word/sense data lives in memory (fetched from words.json once per session)
 */

const KEYS = {
  PREFS:    'zolai_prefs_v3',     // bumped from v1 → forces re-init (BUG 6)
  AI_CACHE: 'zolai_ai_cache_v3',
};

export class LocalStorageAdapter {
  get(key) {
    try {
      const raw = localStorage.getItem(key);
      return raw !== null ? JSON.parse(raw) : null;
    } catch { return null; }
  }
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); return true; }
    catch (err) { console.warn(`[StorageAdapter] "${key}":`, err.message); return false; }
  }
  remove(key) { localStorage.removeItem(key); }
  clear() { Object.values(KEYS).forEach(k => localStorage.removeItem(k)); }
}

export { KEYS };
