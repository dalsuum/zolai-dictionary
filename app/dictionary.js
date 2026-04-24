/**
 * app/dictionary.js — DictionaryService v4
 *
 * Loading strategy:
 *   First visit  → fetch words.json once → cache in IndexedDB → render
 *   Repeat visit → load from IndexedDB instantly (< 100ms) → render
 *   Background   → re-fetch if cache is > 24h old
 *
 * WHY IndexedDB instead of split files?
 *   Split files had a race condition: Phase 2 senses could arrive before
 *   Phase 1 index was fully indexed, causing empty renders.
 *   IndexedDB stores the full dataset locally after the first fetch,
 *   making every subsequent load instant regardless of connection speed.
 */

import { LocalStorageAdapter, KEYS } from './storage.js';
import { normalise } from './utils.js';

const DB_NAME    = 'zolai_dict';
const DB_VERSION = 1;
const STORE      = 'data';
const CACHE_KEY  = 'words_v3';
const CACHE_TTL  = 24 * 60 * 60 * 1000; // 24 hours

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

    // 1. Try IndexedDB cache first
    let cached = null;
    try {
      this._idb = await this._openIDB();
      cached    = await this._idbGet(CACHE_KEY);
    } catch { /* IDB unavailable — fall through to network */ }

    const now = Date.now();

    if (cached && (now - cached.ts) < CACHE_TTL) {
      // ── Fast path: load from cache ──────────────────────────────────────
      onProgress?.('Loading from cache…', 40);
      this._buildIndex(cached.words, cached.senses, cached.synset);
      onProgress?.('Ready', 100);
    } else {
      // ── Network path: fetch words.json ──────────────────────────────────
      onProgress?.('Downloading dictionary…', 20);

      const res = await fetch('./db/words.json');
      if (!res.ok) throw new Error(`Download failed (${res.status}). Check your connection.`);

      onProgress?.('Parsing data…', 70);
      const db = await res.json();

      onProgress?.('Building index…', 90);
      this._buildIndex(db.words ?? [], db.senses ?? [], db.synset ?? []);

      onProgress?.('Ready', 100);

      // Cache for next visit (non-blocking)
      if (this._idb) {
        this._idbSet(CACHE_KEY, {
          ts:     now,
          words:  db.words  ?? [],
          senses: db.senses ?? [],
          synset: db.synset ?? [],
        }).catch(() => {});
      }
    }
  }

  // ── IndexedDB helpers ───────────────────────────────────────────────────────
  _openIDB() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = e => e.target.result.createObjectStore(STORE);
      req.onsuccess       = e => resolve(e.target.result);
      req.onerror         = e => reject(e.target.error);
    });
  }

  _idbGet(key) {
    return new Promise((resolve, reject) => {
      const tx  = this._idb.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).get(key);
      req.onsuccess = e => resolve(e.target.result ?? null);
      req.onerror   = e => reject(e.target.error);
    });
  }

  _idbSet(key, value) {
    return new Promise((resolve, reject) => {
      const tx  = this._idb.transaction(STORE, 'readwrite');
      const req = tx.objectStore(STORE).put(value, key);
      req.onsuccess = () => resolve();
      req.onerror   = e => reject(e.target.error);
    });
  }

  /** Clear IndexedDB cache (call when words.json is updated). */
  async clearCache() {
    if (!this._idb) return;
    await this._idbSet(CACHE_KEY, null);
  }

  // ── Index builder ───────────────────────────────────────────────────────────
  _buildIndex(words, senses, synset) {
    if (synset.length) this._synset = synset;
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
  allWords()               { return this._words.slice().sort((a,b) => a.word.localeCompare(b.word)); }
  pagedWords(offset, limit){ return this.allWords().slice(offset, offset + limit); }
  get wordCount()          { return this._words.length; }
  sensesFor(word)          { return this._senseMap.get(word) ?? []; }
  synset(wrteId)           { return this._synset.find(s => s.id === Number(wrteId)) ?? {id:wrteId,name:'Word',shortname:''}; }
  allSynsets()             { return this._synset; }

  // ── Ranked search ───────────────────────────────────────────────────────────
  search(query) {
    const q    = normalise(query);
    const qRaw = (query ?? '').trim();
    if (!q) return [];

    const isAscii        = /^[a-z0-9 ]+$/.test(q);
    const wordBoundaryRe = isAscii
      ? new RegExp(`(?<![a-z])${q.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}(?![a-z])`)
      : null;

    const scores = new Map();

    for (const [word, rows] of this._senseMap) {
      const nw = normalise(word);
      if      (nw === q)           { scores.set(word, 100); continue; }
      else if (nw.startsWith(q))   { scores.set(word, 75);  continue; }
      else if (nw.includes(q))     { scores.set(word, 50);  continue; }

      let best = 0;
      for (const s of rows) {
        if (s.wseq === 0) {
          const ns = normalise(s.sense);
          if (wordBoundaryRe && wordBoundaryRe.test(ns)) best = Math.max(best, 30);
          else if (ns.includes(q))                       best = Math.max(best, 10);
        } else if (s.wseq === 1 && s.sense.includes(qRaw)) {
          best = Math.max(best, 20);
        }
      }
      if (best > 0) scores.set(word, best);
    }

    return [...scores.entries()]
      .sort(([wa,sa],[wb,sb]) => sb !== sa ? sb-sa : wa.localeCompare(wb))
      .filter(([w]) => this._wordMap.has(w))
      .map(([w]) => ({ word: this._wordMap.get(w), senses: this.sensesFor(w) }));
  }

  // ── Write ───────────────────────────────────────────────────────────────────
  addWord(payload) {
    const lower = normalise(payload.word);
    if ([...this._wordMap.keys()].some(w => normalise(w) === lower))
      throw new Error(`"${payload.word}" already exists.`);

    const maxWid = this._words.length ? Math.max(...this._words.map(w=>w.id)) : 0;
    const maxSid = [...this._senseMap.values()].flat().reduce((m,s)=>Math.max(m,s.id),0);

    const newWord = {id:maxWid+1, word:payload.word.trim(), derived:0};
    const newSenses = [{id:maxSid+1,word:newWord.word,wrte:payload.wrte,sense:payload.senseEn.trim(),exam:payload.exam?.trim()??'',wseq:0}];
    if (payload.senseMy?.trim())
      newSenses.push({id:maxSid+2,word:newWord.word,wrte:payload.wrte,sense:payload.senseMy.trim(),exam:payload.exam?.trim()??'',wseq:1});

    this._words.push(newWord);
    this._senseMap.set(newWord.word, newSenses);
    this._wordMap.set(newWord.word, newWord);
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
    const maxSid = old.length ? Math.max(...old.map(s=>s.id)) : 0;
    const updated = [{id:maxSid+1,word:nw,wrte:payload.wrte,sense:payload.senseEn.trim(),exam:payload.exam?.trim()??'',wseq:0}];
    if (payload.senseMy?.trim())
      updated.push({id:maxSid+2,word:nw,wrte:payload.wrte,sense:payload.senseMy.trim(),exam:payload.exam?.trim()??'',wseq:1});
    this._senseMap.delete(original);
    this._senseMap.set(nw, updated);
  }

  deleteWord(word) {
    this._words = this._words.filter(w => w.word !== word);
    this._wordMap.delete(word);
    this._senseMap.delete(word);
  }

  // ── Prefs & AI cache ────────────────────────────────────────────────────────
  getPrefs()       { return this._storage.get(KEYS.PREFS)    ?? {showImages:true}; }
  setPrefs(prefs)  { this._storage.set(KEYS.PREFS, {...this.getPrefs(),...prefs}); }
  getAICache()     { return this._storage.get(KEYS.AI_CACHE) ?? {}; }
  setAICache(c)    { this._storage.set(KEYS.AI_CACHE, c); }
}
