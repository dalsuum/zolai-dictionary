/**
 * scripts/extract-bible-words.mjs
 *
 * Extracts unique Zolai (Tedim Chin) word tokens from the Lai Siangtho Bible
 * (dalsuum/bible, json/3561.json) and appends them to db/words.json.
 *
 * Usage:
 *   node scripts/extract-bible-words.mjs [--bible <path>] [--freq <n>]
 *
 * Options:
 *   --bible <path>   Path to the Lai Siangtho JSON file
 *                    (default: ../../bible/json/3561.json)
 *   --freq  <n>      Minimum word frequency to include (default: 3)
 *
 * ─── Bug catalogue (original script → this fix) ──────────────────────────────
 *
 * BUG 1 — Wrong schema target
 *   Original:  dictionary.synset.map(s => s.word.toLowerCase())
 *   Problem:   `synset` is the POS lookup table [{id,name,shortname}], NOT words.
 *              It has no `.word` field → every lookup returns undefined → Set is
 *              populated with 'undefined' strings → all real words appear "new".
 *   Fix:       Read existing headwords from `dictionary.words`, not `dictionary.synset`.
 *
 * BUG 2 — Wrong insert target
 *   Original:  dictionary.synset.push(...newEntries)
 *   Problem:   Corrupts the POS lookup table by injecting word entries into it.
 *              The app's synset() call then returns wrong POS for everything.
 *   Fix:       Push to `dictionary.words` AND `dictionary.senses` separately,
 *              matching the actual schema.
 *
 * BUG 3 — Entry structure mixes two tables into one object
 *   Original:  { id, word, wrte, sense, exam, wseq }   → single object
 *   Problem:   `wrte/sense/exam/wseq` are sense-table fields; `word/derived` are
 *              word-table fields. Mixing them produces objects that match neither
 *              table and break every query in DictionaryService.
 *   Fix:       Create two separate objects per headword:
 *              words  row  → { id, word, derived }
 *              senses row  → { id, word, wrte, sense, exam, wseq }
 *
 * BUG 4 — ID collision
 *   Original:  Math.max(...dictionary.synset.map(s => s.id)) + 1
 *   Problem:   Because synset is used, the "max id" is the highest POS id (19),
 *              not the highest word id (60+). New word ids start at 20, colliding
 *              with existing seed entries (ids 1–60).
 *   Fix:       Compute max separately for words table AND senses table.
 *
 * BUG 5 — Sense id collision (second table never given its own counter)
 *   Original:  Single `currentId` counter for everything.
 *   Problem:   The senses table has its own id sequence. Using the word counter
 *              for senses creates duplicate ids across the two tables and breaks
 *              sense lookups.
 *   Fix:       Maintain `nextWordId` and `nextSenseId` as independent counters.
 *
 * BUG 6 — Wrong Bible JSON traversal
 *   Original:  bibleVerses = [{ ref, text }]  (mock flat array)
 *   Problem:   The actual Bible JSON is deeply nested:
 *              bible.book[bookId].chapter[chId].verse[vId].text
 *              A flat-array traversal would miss the entire corpus.
 *   Fix:       Walk book → chapter → verse using the actual JSON shape.
 *
 * BUG 7 — Missing verse reference in sense field
 *   Original:  sense: `[Bible word · ${verse.ref}]`
 *   Problem:   Sense field mixes a status marker with a reference. The app's
 *              parseSense() splits on ' — ' expecting "definition — notes".
 *              A bare reference string produces an empty definition.
 *   Fix:       Store reference as a proper sense string:
 *              "Bible: <BookName> <ch>:<v>" so parseSense returns it as the definition.
 *
 * BUG 8 — No stop-word / particle filter
 *   Original:  if (!existingWords.has(word) && word.length > 2)
 *   Problem:   Grammatical particles (hi, in, uh, tua, na, ka…) are extremely
 *              frequent, meaningless as dictionary headwords, and would flood the
 *              DB with thousands of useless entries.
 *   Fix:       Apply a STOP_WORDS set covering known Zolai particles and auxiliaries.
 *
 * BUG 9 — Punctuation stripping too aggressive
 *   Original:  verse.text.toLowerCase().replace(/[.,!?;:]/g, '').split(' ')
 *   Problem:   Hyphenated Zolai compounds (e.g. "ki-in", "cil-in") get split on
 *              the hyphen → produces partial tokens. Also Myanmar-script verses
 *              would be mangled.
 *   Fix:       Use a regex token extractor that keeps only Latin-script runs
 *              (Zolai uses Latin script), preserving internal hyphens within words
 *              but not using them as word boundaries.
 *
 * BUG 10 — Duplicate prevention only works within the current run
 *   Original:  existingWords.add(word)  inside the loop
 *   Problem:   This prevents intra-run duplicates but if the script is run twice,
 *              the second run re-inserts everything because the Set is rebuilt from
 *              the file each time (which still only has the original 60 words on
 *              disk until the script finishes).
 *   Fix:       Build the existingWords Set once from the file, add each new word
 *              to it immediately so both intra- and inter-run deduplication work.
 */

import fs   from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dir = path.dirname(fileURLToPath(import.meta.url));

// ─── CLI args ────────────────────────────────────────────────────────────────
const args     = process.argv.slice(2);
const getArg   = (flag, def) => { const i = args.indexOf(flag); return i !== -1 ? args[i+1] : def; };
const BIBLE_PATH = getArg('--bible', path.resolve(__dir, '../../bible/json/3561.json'));
const MIN_FREQ   = parseInt(getArg('--freq', '3'), 10);
const DB_PATH    = path.resolve(__dir, '../db/words.json');

// ─── POS id lookup (mirrors synset in words.json) ────────────────────────────
const POS = { noun:0, verb:1, adjective:2, adverb:3, preposition:4,
              conjunction:5, pronoun:6, interjection:7, number:19 };

/**
 * Zolai morphological POS heuristic.
 * WHY: Most corpus words lack hand-annotated POS. Tedim Chin has consistent
 * derivational suffixes that allow reasonable guesses without a tagger.
 * @param {string} word  lowercase headword
 * @returns {number}     synset id
 */
function guessPos(word) {
  if (/(?:sak|bawl|gen|pia|kap|sim|nei|zin|dawn|nui|it|taang|theih|gelh|thei|zuan|tawl|lam|bel|san|kik|zawh|khak|khua)$/.test(word)) return POS.verb;
  if (/(?:ciangin|hangin|ahihzaw|zongin|napi|ahih)$/.test(word))  return POS.conjunction;
  if (/(?:mahmah|takin|zawzaw|mawkmawk|zaw)$/.test(word))          return POS.adverb;
  if (/(?:ah|panin|tungah|kiangah|sungah|tawh)$/.test(word))       return POS.preposition;
  return POS.noun; // default — most common POS in any lexicon
}

// ─── Stop words (particles, auxiliaries, pronouns already in seed) ───────────
// WHY: These tokens are grammatically obligatory but semantically empty as
// standalone dictionary headwords. Including them inflates the DB with noise.
const STOP_WORDS = new Set([
  // Verb particles / auxiliaries
  'hi','ahi','ahih','hiam','hen','cih','ci','ding','ta','lo',
  // Postpositions / case markers (short)
  'in','ah','un','tua','leh','uh','na','ka','pa','ma','le','tawh','hong',
  'ama','ang','bang','hih','om','ciangin','hangin','bangin','panin',
  'tungah','tawh','kong','hiam','pen','aw','zen','mah','zong',
  // Pronouns (already in seed dictionary)
  'kei','nang','amah','eite','note','amaute',
  // Common inflectional suffixes that appear isolated
  'te','pa','nu','ni','nih','thum','li','nga','guk','khat',
]);

// ─── Validate paths ──────────────────────────────────────────────────────────
if (!fs.existsSync(BIBLE_PATH)) {
  console.error(`✗  Bible file not found: ${BIBLE_PATH}`);
  console.error(`   Run:  git clone https://github.com/dalsuum/bible.git  beside this repo`);
  process.exit(1);
}

// ─── Load files ──────────────────────────────────────────────────────────────
console.log('Loading Bible …');
const bible = JSON.parse(fs.readFileSync(BIBLE_PATH, 'utf8'));
console.log(`  Bible: ${bible.info?.name}  (lang: ${bible.info?.language?.text})`);

console.log('Loading dictionary …');
// FIX BUG 1 + 4: read from `words` table, compute correct max ids
const db         = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
let nextWordId   = Math.max(0, ...db.words.map(w => w.id))  + 1;   // BUG 4 fix
let nextSenseId  = Math.max(0, ...db.senses.map(s => s.id)) + 1;   // BUG 5 fix
// FIX BUG 1: use words array, not synset
const existingWords = new Set(db.words.map(w => w.word.toLowerCase()));
console.log(`  Existing words: ${existingWords.size}  (next word id: ${nextWordId}, next sense id: ${nextSenseId})`);

// ─── Load English Bible for parallel example sentences ───────────────────────
const engPath = path.resolve(path.dirname(BIBLE_PATH), '1.json');
const engBible = fs.existsSync(engPath)
  ? JSON.parse(fs.readFileSync(engPath, 'utf8'))
  : null;
if (engBible) console.log(`  English parallel: ${engBible.info?.name}`);

// ─── Extract book names from Zolai Bible ─────────────────────────────────────
const bookNames = {};
for (const [bookId, book] of Object.entries(bible.book ?? {})) {
  bookNames[bookId] = book.info?.name ?? `Book ${bookId}`;
}

// ─── BUG 9 fix: token extractor preserving Latin Zolai tokens ────────────────
// Matches runs of Latin letters (Zolai script). Apostrophes/hyphens mid-word
// are part of the token only if flanked by letters.
const TOKEN_RE = /[A-Za-zÀ-ÖØ-öø-ÿ]+(?:['-][A-Za-zÀ-ÖØ-öø-ÿ]+)*/g;

// ─── BUG 6 fix: correct Bible JSON traversal ─────────────────────────────────
// Structure: bible.book[bookId].chapter[chId].verse[vId].text
const wordFreq    = new Map();  // lowercase_word → count
const bestExample = new Map();  // lowercase_word → { headword, zolai, english, ref }

let versesProcessed = 0;

for (const [bookId, book] of Object.entries(bible.book ?? {})) {
  const bookName = bookNames[bookId] ?? '';
  const engBook  = engBible?.book?.[bookId] ?? {};

  for (const [chId, chData] of Object.entries(book.chapter ?? {})) {
    const engVerses = engBook?.chapter?.[chId]?.verse ?? {};

    for (const [vId, verseData] of Object.entries(chData.verse ?? {})) {
      const text    = verseData?.text ?? '';
      if (!text) continue;
      versesProcessed++;

      const engText = engVerses[vId]?.text ?? '';
      const ref     = `${bookName} ${chId}:${vId}`;

      for (const match of text.matchAll(TOKEN_RE)) {
        const token = match[0];
        const lower = token.toLowerCase();

        // BUG 8 fix: skip stop words and very short tokens
        if (lower.length < 3 || STOP_WORDS.has(lower)) continue;

        // Frequency tracking
        wordFreq.set(lower, (wordFreq.get(lower) ?? 0) + 1);

        // Keep shortest verse as the canonical example
        if (!bestExample.has(lower) || text.length < bestExample.get(lower).zolai.length) {
          bestExample.set(lower, {
            headword: token,   // preserve original casing from Bible
            zolai:    text,
            english:  engText,
            ref,
          });
        }
      }
    }
  }
}

console.log(`\nVerse traversal complete:`);
console.log(`  Verses processed : ${versesProcessed.toLocaleString()}`);
console.log(`  Unique token forms: ${wordFreq.size.toLocaleString()}`);

// ─── Filter and build new entries ────────────────────────────────────────────
const newWords  = [];   // rows for db.words
const newSenses = [];   // rows for db.senses  (BUG 3 fix: separate objects)

for (const [lower, freq] of [...wordFreq.entries()].sort((a,b) => b[1]-a[1])) {
  // Frequency threshold
  if (freq < MIN_FREQ) continue;

  // BUG 10 fix: skip if already present (covers seed + previously added words)
  if (existingWords.has(lower)) continue;

  const ex       = bestExample.get(lower);
  const headword = ex.headword;   // original casing from Bible text
  const wrte     = guessPos(lower);

  // BUG 7 fix: produce a real sense string parseSense() can split
  // Format: "Bible: <ref> — freq <n>"  →  definition="Bible: ref", notes="freq n"
  const senseStr = `Bible: ${ex.ref} — freq ${freq}`;

  // Exam: "Zolai sentence (English parallel)"  (truncated for readability)
  const examZolai = ex.zolai.length > 120 ? ex.zolai.slice(0, 117) + '…' : ex.zolai;
  const examEng   = ex.english.length > 100 ? ex.english.slice(0, 97) + '…' : ex.english;
  const examStr   = examEng ? `${examZolai} (${examEng})` : examZolai;

  // BUG 3 + 5 fix: two separate objects with independent id counters
  newWords.push({
    id:      nextWordId++,
    word:    headword,
    derived: 0,
  });

  newSenses.push({
    id:   nextSenseId++,
    word: headword,
    wrte,
    sense: senseStr,
    exam:  examStr,
    wseq:  0,           // wseq=0 = primary (English) sense lane
  });

  // BUG 10 fix: mark as seen so a second run skips it
  existingWords.add(lower);
}

console.log(`\nNew entries to add : ${newWords.length.toLocaleString()}`);

// ─── BUG 2 fix: append to correct tables, NOT to synset ──────────────────────
db.words  = [...db.words,  ...newWords];
db.senses = [...db.senses, ...newSenses];

// Update metadata
db._meta.version      = '2.0.0';
db._meta.words_count  = db.words.length;
db._meta.senses_count = db.senses.length;
db._meta.source       = [
  'ZomiLanguage/dictionary (schema)',
  `seed: ${existingWords.size - newWords.length} curated words`,
  `dalsuum/bible Lai Siangtho — ${versesProcessed.toLocaleString()} verses`,
].join(' + ');
db._meta.extraction = {
  bible_file:   path.basename(BIBLE_PATH),
  min_freq:     MIN_FREQ,
  extracted_at: new Date().toISOString(),
};

// ─── Write ────────────────────────────────────────────────────────────────────
fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2), 'utf8');

console.log('\n✓  db/words.json updated');
console.log(`   words  : ${db.words.length.toLocaleString()}  (was ${db.words.length - newWords.length})`);
console.log(`   senses : ${db.senses.length.toLocaleString()}  (was ${db.senses.length - newSenses.length})`);
console.log(`\nNext step: run 'node scripts/enrich-definitions.mjs' to fill sense definitions via AI.`);
