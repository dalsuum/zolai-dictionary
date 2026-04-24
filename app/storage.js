/**
 * app/storage.js — StorageAdapter
 *
 * Only lightweight prefs are stored in localStorage.
 * Word/sense data uses IndexedDB (see dictionary.js).
 * Quota: localStorage ~5 MB limit; prefs are ~50 bytes.
 */

const KEYS = {
  PREFS: 'zolai_prefs_v3',
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
  clear()     { Object.values(KEYS).forEach(k => localStorage.removeItem(k)); }
}

export { KEYS };
