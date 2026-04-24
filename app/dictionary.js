/**
 * app/dictionary.js — DictionaryService
 *
 * All business logic; zero DOM knowledge.
 *
 * Architecture change from v1 → v3
 * ──────────────────────────────────
 * v1 stored words + senses in localStorage → 6 MB quota exceeded (BUG 1).
 * v3 keeps word/sense data IN MEMORY only (loaded once from words.json).
 *    Only prefs + AI cache go to localStorage (< 100 KB total).
 *
 * In-memory indices (BUG 8 + BUG 13 fix)
 * ────────────────────────────────────────
 * After init(), we build two Maps for O(1) / O(n) access:
 *   _wordMap:  Map<word_string, WordRow>
 *   _senseMap: Map<word_string, SenseRow[]>
 * This means sensesFor() and search() never scan the full array again.
 */

import { LocalStorageAdapter, KEYS } from './storage.js';
import { normalise } from './utils.js';

export class DictionaryService {
  /**
   * @param {LocalStorageAdapter} storage
   * @param {string}              seedUrl   path to db/words.json
   */
  constructor(storage = new LocalStorageAdapter(), seedUrl = './db/words.json') {
    // FIX BUG 4: './db/words.json' relative to index.html at site root
    this._storage  = storage;
    this._seedUrl  = seedUrl;
    this._synset   = [];
    this._words    = [];          // full word list (in memory)
    this._wordMap  = new Map();   // word_string → WordRow
    this._senseMap = new Map();   // word_string → SenseRow[]
    this._ready    = false;
  }

  // ── Init ────────────────────────────────────────────────────────────────────

  /**
   * FIX BUG 5: fetch seed ONCE and build in-memory indices.
   * No localStorage write for words/senses — avoids quota (BUG 1).
   */
  async init() {
    const seed = await this._fetchSeed();
    this._synset = seed.synset ?? [];
    this._buildIndex(seed.words ?? [], seed.senses ?? []);
    this._ready = true;
  }

  async _fetchSeed() {
    const res = await fetch(this._seedUrl);
    if (!res.ok) throw new Error(`Seed fetch failed: ${res.status} ${this._seedUrl}`);
    return res.json();
  }

  /** Build O(1) lookup maps from the raw arrays. FIX BUG 8 + BUG 13. */
  _buildIndex(words, senses) {
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
    // Sort each word's senses by wseq ascending
    for (const rows of this._senseMap.values()) {
      rows.sort((a, b) => (a.wseq ?? 0) - (b.wseq ?? 0));
    }
  }

  // ── Read ────────────────────────────────────────────────────────────────────

  /** All words sorted alphabetically. */
  allWords() {
    return this._words.slice().sort((a, b) => a.word.localeCompare(b.word));
  }

  /** First `n` words sorted alphabetically (for paginated browse). */
  pagedWords(offset = 0, limit = 100) {
    return this.allWords().slice(offset, offset + limit);
  }

  /** Total word count. */
  get wordCount() { return this._words.length; }

  /**
   * O(1) sense lookup — FIX BUG 8.
   * No full array scan; reads directly from pre-built Map.
   */
  sensesFor(word) {
    return this._senseMap.get(word) ?? [];
  }

  /**
   * Ranked full-text search across Zolai, English, and Myanmar.
   *
   * WHY ranked instead of flat?
   *   A flat search returns "Inn", "Inning", "Beginning" in alphabetical
   *   order — the exact match isn't first. Ranking by match type ensures
   *   the most relevant result always appears at the top.
   *
   * Score tiers (higher = better):
   *   100 — headword exactly equals query          ("inn"  → "Inn")
   *    75 — headword starts with query             ("inn"  → "Innkiu")
   *    50 — headword contains query anywhere       ("inn"  → "Planning")
   *    30 — English sense contains query as a word ("house"→ words defined as "house")
   *    20 — Myanmar sense contains query           ("အိမ်" → words with that Myanmar text)
   *    10 — English sense contains query anywhere  (broad fallback)
   *
   * @param {string} query
   * @returns {Array<{word, senses}>}  sorted by score desc, then alpha
   */
  search(query) {
    const q     = normalise(query);
    const qRaw  = (query ?? '').trim();   // for Myanmar script (no lowercase)
    if (!q) return [];

    // Precompile word-boundary regex once per query (only for ASCII queries)
    const isAscii  = /^[a-z0-9 ]+$/.test(q);
    const wordBoundaryRe = isAscii ? new RegExp(`(?<![a-z])${q.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}(?![a-z])`) : null;

    const scores = new Map(); // word → score

    for (const [word, rows] of this._senseMap) {
      const nw = normalise(word);

      // ── Tier 1: exact headword ───────────────────────────────────────────
      if (nw === q) { scores.set(word, 100); continue; }

      // ── Tier 2: headword starts with query ───────────────────────────────
      if (nw.startsWith(q)) { scores.set(word, 75); continue; }

      // ── Tier 3: headword contains query ──────────────────────────────────
      if (nw.includes(q)) { scores.set(word, 50); continue; }

      // ── Tiers 4–5: sense matching ─────────────────────────────────────────
      let best = 0;
      for (const s of rows) {
        if (s.wseq === 0) {
          // English sense — word-boundary match scores higher than substring
          const ns = normalise(s.sense);
          if (wordBoundaryRe && wordBoundaryRe.test(ns)) { best = Math.max(best, 30); }
          else if (ns.includes(q))                       { best = Math.max(best, 10); }
        } else if (s.wseq === 1) {
          // Myanmar sense — exact substring (Myanmar doesn't lowercase)
          if (s.sense.includes(qRaw)) { best = Math.max(best, 20); }
        }
      }
      if (best > 0) scores.set(word, best);
    }

    return [...scores.entries()]
      .sort(([wa, sa], [wb, sb]) =>
        sb !== sa ? sb - sa : wa.localeCompare(wb)   // score desc → alpha asc
      )
      .filter(([w]) => this._wordMap.has(w))
      .map(([w]) => ({ word: this._wordMap.get(w), senses: this.sensesFor(w) }));
  }

  /** Resolve a synset id → POS descriptor. */
  synset(wrteId) {
    return this._synset.find(s => s.id === Number(wrteId))
      ?? { id: wrteId, name: 'Word', shortname: '' };
  }

  allSynsets() { return this._synset; }

  // ── Write (operates on in-memory data + rebuilds index) ───────────────────

  addWord(payload) {
    const lower = normalise(payload.word);
    if ([...this._wordMap.keys()].some(w => normalise(w) === lower)) {
      throw new Error(`"${payload.word}" already exists.`);
    }
    const maxWordId  = this._words.length  ? Math.max(...this._words.map(w => w.id))  : 0;
    const maxSenseId = [...this._senseMap.values()].flat().reduce((m, s) => Math.max(m, s.id), 0);

    const newWord = { id: maxWordId + 1, word: payload.word.trim(), derived: 0 };
    const newSenses = [{
      id: maxSenseId + 1, word: newWord.word,
      wrte: payload.wrte, sense: payload.senseEn.trim(),
      exam: payload.exam?.trim() ?? '', wseq: 0,
    }];
    if (payload.senseMy?.trim()) {
      newSenses.push({
        id: maxSenseId + 2, word: newWord.word,
        wrte: payload.wrte, sense: payload.senseMy.trim(),
        exam: payload.exam?.trim() ?? '', wseq: 1,
      });
    }
    this._words.push(newWord);
    this._senseMap.set(newWord.word, newSenses);
    this._wordMap.set(newWord.word, newWord);
    return newWord;
  }

  updateWord(originalWord, payload) {
    const wordIdx = this._words.findIndex(w => w.word === originalWord);
    if (wordIdx === -1) throw new Error(`"${originalWord}" not found.`);

    const newWord = payload.word.trim();
    this._words[wordIdx].word = newWord;
    this._wordMap.delete(originalWord);
    this._wordMap.set(newWord, this._words[wordIdx]);

    const oldSenses = this._senseMap.get(originalWord) ?? [];
    const maxSenseId = oldSenses.length ? Math.max(...oldSenses.map(s => s.id)) : 0;
    const updated = [{
      id: maxSenseId + 1, word: newWord,
      wrte: payload.wrte, sense: payload.senseEn.trim(),
      exam: payload.exam?.trim() ?? '', wseq: 0,
    }];
    if (payload.senseMy?.trim()) {
      updated.push({
        id: maxSenseId + 2, word: newWord,
        wrte: payload.wrte, sense: payload.senseMy.trim(),
        exam: payload.exam?.trim() ?? '', wseq: 1,
      });
    }
    this._senseMap.delete(originalWord);
    this._senseMap.set(newWord, updated);
  }

  deleteWord(word) {
    this._words = this._words.filter(w => w.word !== word);
    this._wordMap.delete(word);
    this._senseMap.delete(word);
  }

  // ── Preferences (lightweight → localStorage is fine) ──────────────────────

  getPrefs() {
    return this._storage.get(KEYS.PREFS) ?? { showImages: true };
  }
  setPrefs(prefs) {
    this._storage.set(KEYS.PREFS, { ...this.getPrefs(), ...prefs });
  }

  // ── AI cache (per-word strings → localStorage is fine) ────────────────────

  getAICache() {
    return this._storage.get(KEYS.AI_CACHE) ?? {};
  }
  setAICache(cache) {
    this._storage.set(KEYS.AI_CACHE, cache);
  }
}
