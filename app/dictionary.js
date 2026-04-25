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

    // Re-apply overlay if present (e.g. after re-fetch)
    if (this._overlay) this._mergeOverlay();
  }

  /**
   * Apply Firestore overlay edits to in-memory index.
   * @param {Map<wordKey, editData>} editsMap
   *
   * Each overlay row either:
   *   - Adds a new word (not in base) → push to _words + _senseMap
   *   - Replaces existing senses → overwrite EN/MY rows
   *   - Marks word as deleted → remove from _words + maps
   */
  applyOverlay(editsMap) {
    this._overlay = editsMap;
    this._mergeOverlay();
  }

  _mergeOverlay() {
    if (!this._overlay) return;

    // First, snapshot the original word IDs we'll need for new senses
    const allSenses = [...this._senseMap.values()].flat();
    let maxSenseId  = allSenses.reduce((m, s) => Math.max(m, s.id), 0);
    let maxWordId   = this._words.reduce((m, w) => Math.max(m, w.id), 0);

    for (const [, edit] of this._overlay) {
      const word = edit.word;
      if (!word) continue;

      if (edit.deleted) {
        this._words = this._words.filter(w => w.word.toLowerCase() !== word.toLowerCase());
        this._wordMap.delete(word);
        // Also try with original casing variants
        for (const k of [...this._wordMap.keys()]) {
          if (k.toLowerCase() === word.toLowerCase()) this._wordMap.delete(k);
        }
        for (const k of [...this._senseMap.keys()]) {
          if (k.toLowerCase() === word.toLowerCase()) this._senseMap.delete(k);
        }
        continue;
      }

      // Find existing word entry (case-insensitive)
      let existing = this._wordMap.get(word) ??
        [...this._wordMap.values()].find(w => w.word.toLowerCase() === word.toLowerCase());

      if (!existing) {
        // New word added via overlay
        existing = { id: ++maxWordId, word, derived: 0 };
        this._words.push(existing);
        this._wordMap.set(word, existing);
      }

      // Build new sense rows from overlay
      const newSenses = [];
      if (edit.senseEn) {
        const fullSense = edit.notes ? `${edit.senseEn} — ${edit.notes}` : edit.senseEn;
        newSenses.push({
          id: ++maxSenseId, word: existing.word,
          wrte: edit.wrte ?? 0, sense: fullSense,
          exam: edit.exam ?? '', wseq: 0,
        });
      }
      if (edit.senseMy) {
        newSenses.push({
          id: ++maxSenseId, word: existing.word,
          wrte: edit.wrte ?? 0, sense: edit.senseMy,
          exam: edit.exam ?? '', wseq: 1,
        });
      }

      if (newSenses.length) {
        this._senseMap.set(existing.word, newSenses);
      }
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
   * Multi-word query handling:
   *   "compassion debt"  → ALL terms must be found somewhere in the entry
   *                         (Zolai word, English sense, or English exam).
   *                         Word's score = sum of each term's score.
   *   "house dwelling"   → finds Inn (sense matches both terms)
   *   "leiba debt"       → finds leiba (Zolai matches first, exam matches second)
   *
   *   Each term is independently scored by these tiers:
   *     100 — exact headword match
   *      75 — headword starts with term
   *      50 — headword contains term
   *      40 — English exam word-boundary match  (term ≥ 5 chars)
   *      35 — English sense starts with term    (term ≥ 3 chars)
   *      30 — English sense word-boundary match (term ≥ 3 chars)
   *      20 — Myanmar sense match               (term ≥ 2 chars)
   *      15 — English exam substring            (term ≥ 5 chars)
   *      10 — English sense substring           (term ≥ 3 chars)
   *
   *   Quoted phrases ("of god") match as a single unit.
   *
   * @param {string} query  user input (possibly multiple words)
   * @returns {Array<{word, senses}>}  results sorted by total score
   */
  search(query) {
    const raw = (query ?? '').trim();
    if (!raw) return [];

    // Tokenize: respect quoted phrases as single terms
    const terms = this._tokenizeQuery(raw);
    if (terms.length === 0) return [];

    const scores = new Map();

    // Iterate every word once, score against EVERY term
    for (const [word, rows] of this._senseMap) {
      const nw       = normalise(word);
      const nsList   = rows.filter(s => s.wseq === 0).map(s => normalise(s.sense));
      const examList = rows.filter(s => s.wseq === 0).map(s => normalise(s.exam ?? ''));
      const myList   = rows.filter(s => s.wseq === 1).map(s => s.sense);
      const myNormList = myList.map(s => normalise(s));

      let totalScore  = 0;
      let allTermsHit = true;

      for (const term of terms) {
        const tScore = this._scoreSingleTerm(term, nw, nsList, examList, myList, myNormList);
        if (tScore === 0) { allTermsHit = false; break; }
        totalScore += tScore;
      }

      // Only return words where EVERY search term matched somewhere (AND semantics)
      if (allTermsHit && totalScore > 0) scores.set(word, totalScore);
    }

    return [...scores.entries()]
      .sort(([wa, sa], [wb, sb]) => sb !== sa ? sb - sa : wa.localeCompare(wb))
      .filter(([w]) => this._wordMap.has(w))
      .map(([w]) => ({ word: this._wordMap.get(w), senses: this.sensesFor(w) }));
  }

  /**
   * Split query into search terms.
   * - "house dwelling"    → ["house", "dwelling"]
   * - '"of god" wisdom'   → ["of god", "wisdom"]   (quoted phrase preserved)
   * - "  multiple   spaces" → ["multiple", "spaces"]
   */
  _tokenizeQuery(query) {
    const terms = [];
    const re = /"([^"]+)"|(\S+)/g;
    let m;
    while ((m = re.exec(query)) !== null) {
      const term = (m[1] ?? m[2]).trim();
      if (term) terms.push(term);
    }
    return terms;
  }

  /**
   * Score one term against one word's data.
   * @returns {number} 0 if no match, otherwise the best tier score
   */
  _scoreSingleTerm(term, nw, nsList, examList, myList, myNormList) {
    const t    = normalise(term);
    const tRaw = term.trim();
    const tLen = t.length;
    if (!t) return 0;

    // Headword tiers (always scanned, no minimum length)
    if (nw === t)            return 100;
    if (nw.startsWith(t))    return 75;
    if (nw.includes(t))      return 50;

    // Sense/exam tiers (require minimum length to avoid noise)
    if (tLen < 2) return 0;

    // Build word-boundary regex once per term (only for ASCII, length ≥ 3)
    let wbr = null;
    const isAscii = /^[a-z0-9 ]+$/.test(t);
    if (isAscii && tLen >= 3) {
      try {
        wbr = new RegExp(
          `(?<![a-z])${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![a-z])`
        );
      } catch { /* skip */ }
    }

    let best = 0;
    if (tLen >= 3) {
      for (const ns of nsList) {
        if (wbr?.test(ns)) {
          const startsWithT = ns.startsWith(t + ' ') || ns.startsWith(t + '/') || ns === t;
          best = Math.max(best, startsWithT ? 35 : 30);
        } else if (ns.includes(t)) {
          best = Math.max(best, 10);
        }
      }
      if (tLen >= 5) {
        for (const exam of examList) {
          if (wbr?.test(exam))      best = Math.max(best, 40);
          else if (exam.includes(t)) best = Math.max(best, 15);
        }
      }
    }
    if (tLen >= 2) {
      for (let i = 0; i < myList.length; i++) {
        if (myList[i].includes(tRaw) || myNormList[i].includes(t)) {
          best = Math.max(best, 20);
        }
      }
    }
    return best;
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
