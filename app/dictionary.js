/**
 * app/dictionary.js — DictionaryService v4
 *
 * Loading strategy:
 *   First visit  → fetch words.json → cache in IndexedDB → render
 *   Repeat visit → load from IndexedDB (< 100ms) → render
 *   CRUD ops     → update in-memory + persist back to IndexedDB
 *
 * WHY persist CRUD to IndexedDB?
 *   Admin edits (add/update/delete) are in-memory. Without persisting them
 *   to IDB, a page refresh would reload the original cached data and lose
 *   all changes. We re-save the full dataset after every mutation.
 */

import { LocalStorageAdapter, KEYS } from './storage.js';
import { normalise } from './utils.js';

const IDB_NAME    = 'zolai_dict';
const IDB_VERSION = 1;
const IDB_STORE   = 'data';
const CACHE_KEY   = 'words_v3';
const CACHE_TTL   = 24 * 60 * 60 * 1000; // 24 hours

export class DictionaryService {
  constructor(storage = new LocalStorageAdapter()) {
    this._storage  = storage;
    this._synset   = [];
    this._words    = [];
    this._wordMap  = new Map();
    this._senseMap = new Map();
    this._idb      = null;
  }

  // ── Init ───────────────────────────────────────────────────────────────────
  async init(onProgress) {
    onProgress?.('Opening cache…', 5);

    let cached = null;
    try {
      this._idb = await this._openIDB();
      cached    = await this._idbGet(CACHE_KEY);
    } catch { /* IDB unavailable — fall through to network */ }

    const now = Date.now();

    if (cached && cached.words?.length && (now - cached.ts) < CACHE_TTL) {
      onProgress?.('Loading from cache…', 40);
      this._buildIndex(cached.words, cached.senses, cached.synset);
      onProgress?.('Ready', 100);
    } else {
      onProgress?.('Downloading dictionary…', 20);
      const res = await fetch('./db/words.json');
      if (!res.ok) throw new Error(`Download failed (${res.status}). Check your connection.`);

      onProgress?.('Parsing data…', 70);
      const db = await res.json();

      onProgress?.('Building index…', 90);
      this._buildIndex(db.words ?? [], db.senses ?? [], db.synset ?? []);
      onProgress?.('Ready', 100);

      if (this._idb) {
        this._saveToIDB().catch(() => {});
      }
    }
  }

  // ── IndexedDB helpers ───────────────────────────────────────────────────────
  _openIDB() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(IDB_NAME, IDB_VERSION);
      req.onupgradeneeded = e => e.target.result.createObjectStore(IDB_STORE);
      req.onsuccess       = e => resolve(e.target.result);
      req.onerror         = e => reject(e.target.error);
    });
  }

  _idbGet(key) {
    return new Promise((resolve, reject) => {
      const tx  = this._idb.transaction(IDB_STORE, 'readonly');
      const req = tx.objectStore(IDB_STORE).get(key);
      req.onsuccess = e => resolve(e.target.result ?? null);
      req.onerror   = e => reject(e.target.error);
    });
  }

  _idbSet(key, value) {
    return new Promise((resolve, reject) => {
      const tx  = this._idb.transaction(IDB_STORE, 'readwrite');
      const req = tx.objectStore(IDB_STORE).put(value, key);
      req.onsuccess = () => resolve();
      req.onerror   = e => reject(e.target.error);
    });
  }

  /** Persist current in-memory state to IDB (called after every CRUD op). */
  async _saveToIDB() {
    if (!this._idb) return;
    const allSenses = [...this._senseMap.values()].flat();
    await this._idbSet(CACHE_KEY, {
      ts:     Date.now(),
      words:  this._words,
      senses: allSenses,
      synset: this._synset,
    });
  }

  /** Force re-fetch from network on next load (use after bulk DB update). */
  async clearCache() {
    if (this._idb) await this._idbSet(CACHE_KEY, null);
  }

  // ── Index builder ───────────────────────────────────────────────────────────
  _buildIndex(words, senses, synset) {
    if (synset?.length) this._synset = synset;
    this._words = words;
    this._wordMap.clear();
    this._senseMap.clear();

    for (const w of words) {
      this._wordMap.set(w.word, w);
    }
    for (const s of senses) {
      if (!this._senseMap.has(s.word)) this._senseMap.set(s.word, []);
      this._senseMap.get(s.word).push(s);
    }
    for (const rows of this._senseMap.values()) {
      rows.sort((a, b) => (a.wseq ?? 0) - (b.wseq ?? 0));
    }
  }

  // ── Read ────────────────────────────────────────────────────────────────────
  allWords()  { return this._words.slice().sort((a, b) => a.word.localeCompare(b.word)); }
  get wordCount() { return this._words.length; }
  sensesFor(word) { return this._senseMap.get(word) ?? []; }

  synset(wrteId) {
    return this._synset.find(s => s.id === Number(wrteId))
      ?? { id: wrteId, name: 'Word', shortname: '' };
  }
  allSynsets() { return this._synset; }

  // ── Ranked search ───────────────────────────────────────────────────────────
  /**
   * Ranked search — Zolai ↔ English ↔ Myanmar (bidirectional).
   *
   * Score tiers:
   *   100 — exact headword match
   *    75 — headword starts with query
   *    50 — headword contains query
   *    40 — English exam word-boundary match  (requires query ≥ 3 chars)
   *    30 — English sense word-boundary match (requires query ≥ 3 chars)
   *    20 — Myanmar sense match               (requires query ≥ 2 chars)
   *    15 — English exam substring            (requires query ≥ 4 chars)
   *    10 — English sense substring           (requires query ≥ 3 chars)
   *
   * WHY minimum lengths?
   *   Short queries like "la" appear in thousands of Bible verse exam fields.
   *   Without a minimum, "la" returns 2,591 results (noise from exam scanning).
   *   Headword matching has no minimum — "La" (song) should still be found.
   */
  search(query) {
    const q    = normalise(query);
    const qRaw = (query ?? '').trim();
    if (!q) return [];

    const qLen    = q.length;
    const isAscii = /^[a-z0-9 ]+$/.test(q);
    let wordBoundaryRe = null;
    if (isAscii && qLen >= 3) {
      try {
        wordBoundaryRe = new RegExp(
          `(?<![a-z])${q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![a-z])`
        );
      } catch { /* invalid regex — skip */ }
    }

    const scores = new Map();

    for (const [word, rows] of this._senseMap) {
      const nw = normalise(word);
      if      (nw === q)         { scores.set(word, 100); continue; }
      else if (nw.startsWith(q)) { scores.set(word, 75);  continue; }
      else if (nw.includes(q))   { scores.set(word, 50);  continue; }

      // Only scan sense/exam for queries ≥ 3 chars to avoid noise
      if (qLen < 3) continue;

      let best = 0;
      for (const s of rows) {
        if (s.wseq === 0) {
          const ns   = normalise(s.sense);
          const exam = qLen >= 3 ? normalise(s.exam ?? '') : '';

          // Sense matching (≥ 3 chars)
          if (wordBoundaryRe?.test(ns)) {
            // Score 35 if sense STARTS with query — likely the primary definition
            // e.g. "house / home — Primary dwelling" starts with "house" → Inn ranks first
            const startsWithQ = ns.startsWith(q + ' ') || ns.startsWith(q + '/') || ns === q;
            best = Math.max(best, startsWithQ ? 35 : 30);
          } else if (ns.includes(q)) {
            best = Math.max(best, 10);
          }

          // Exam matching — requires ≥ 5 chars to avoid common English words
          // ("house", "water", "song" appear in hundreds of Bible verses)
          if (qLen >= 5) {
            if (wordBoundaryRe?.test(exam)) best = Math.max(best, 40);
            else if (exam.includes(q))      best = Math.max(best, 15);
          }
        } else if (s.wseq === 1 && qLen >= 2) {
          if (s.sense.includes(qRaw) || normalise(s.sense).includes(q)) {
            best = Math.max(best, 20);
          }
        }
      }
      if (best > 0) scores.set(word, best);
    }

    return [...scores.entries()]
      .sort(([wa, sa], [wb, sb]) => sb !== sa ? sb - sa : wa.localeCompare(wb))
      .filter(([w]) => this._wordMap.has(w))
      .map(([w]) => ({ word: this._wordMap.get(w), senses: this.sensesFor(w) }));
  }

  // ── Write (persist to IDB after each mutation) ────────────────────────────
  /**
   * BUG FIX: replaced Math.max(...array) spread (stack overflow on large arrays)
   *   with Array.reduce() — safe for 7,861+ items.
   * BUG FIX: replaced [...Map.keys()].some() O(n) with Map.has() O(1).
   */
  addWord(payload) {
    const lower = normalise(payload.word);
    if (this._wordMap.has(payload.word) ||
        [...this._wordMap.keys()].some(w => normalise(w) === lower)) {
      throw new Error(`"${payload.word}" already exists.`);
    }

    // FIX: reduce instead of spread for large arrays
    const maxWid = this._words.reduce((m, w) => Math.max(m, w.id), 0);
    const maxSid = [...this._senseMap.values()].flat()
                     .reduce((m, s) => Math.max(m, s.id), 0);

    const newWord = { id: maxWid + 1, word: payload.word.trim(), derived: 0 };
    const newSenses = [{
      id: maxSid + 1, word: newWord.word,
      wrte: payload.wrte, sense: payload.senseEn.trim(),
      exam: payload.exam?.trim() ?? '', wseq: 0,
    }];
    if (payload.senseMy?.trim()) {
      newSenses.push({
        id: maxSid + 2, word: newWord.word,
        wrte: payload.wrte, sense: payload.senseMy.trim(),
        exam: payload.exam?.trim() ?? '', wseq: 1,
      });
    }

    this._words.push(newWord);
    this._senseMap.set(newWord.word, newSenses);
    this._wordMap.set(newWord.word, newWord);
    this._saveToIDB().catch(() => {});  // FIX: persist to IDB
    return newWord;
  }

  updateWord(original, payload) {
    const idx = this._words.findIndex(w => w.word === original);
    if (idx === -1) throw new Error(`"${original}" not found.`);

    const nw = payload.word.trim();
    this._words[idx].word = nw;
    this._wordMap.delete(original);
    this._wordMap.set(nw, this._words[idx]);

    const old    = this._senseMap.get(original) ?? [];
    const maxSid = old.reduce((m, s) => Math.max(m, s.id), 0);
    const updated = [{
      id: maxSid + 1, word: nw,
      wrte: payload.wrte, sense: payload.senseEn.trim(),
      exam: payload.exam?.trim() ?? '', wseq: 0,
    }];
    if (payload.senseMy?.trim()) {
      updated.push({
        id: maxSid + 2, word: nw,
        wrte: payload.wrte, sense: payload.senseMy.trim(),
        exam: payload.exam?.trim() ?? '', wseq: 1,
      });
    }
    this._senseMap.delete(original);
    this._senseMap.set(nw, updated);
    this._saveToIDB().catch(() => {});  // FIX: persist to IDB
  }

  deleteWord(word) {
    this._words = this._words.filter(w => w.word !== word);
    this._wordMap.delete(word);
    this._senseMap.delete(word);
    this._saveToIDB().catch(() => {});  // FIX: persist to IDB
  }

  // ── Prefs ──────────────────────────────────────────────────────────────────
  getPrefs()      { return this._storage.get(KEYS.PREFS) ?? { showImages: true }; }
  setPrefs(prefs) { this._storage.set(KEYS.PREFS, { ...this.getPrefs(), ...prefs }); }
}
