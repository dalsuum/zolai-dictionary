/**
 * scripts/enrich-definitions.mjs
 *
 * Fills proper English definitions AND Myanmar (Burmese) translations for every
 * Bible-extracted word that still has a placeholder sense ("Bible: ref — freq N").
 *
 * Strategy
 * ─────────
 * 1. Find all senses where sense starts with "Bible:" (placeholder).
 * 2. Batch 50 words per Anthropic API call → ask for JSON array with
 *    { word, pos, def_en, def_my } per entry.
 * 3. Update the English sense row in-place; insert a new Myanmar sense row
 *    (wseq=1) if def_my is non-empty.
 * 4. Write a checkpoint every CHECKPOINT_EVERY batches so progress survives
 *    an interruption.
 * 5. A second run is safe — already-enriched words are skipped.
 *
 * Usage
 * ─────
 *   node scripts/enrich-definitions.mjs [--batch <n>] [--checkpoint <n>]
 *
 * Environment
 * ───────────
 *   ANTHROPIC_API_KEY  must be set (standard Anthropic SDK convention)
 */

import fs   from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import Anthropic from '@anthropic-ai/sdk';

const __dir   = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.resolve(__dir, '../db/words.json');

// ─── CLI args ────────────────────────────────────────────────────────────────
const args           = process.argv.slice(2);
const getArg         = (flag, def) => { const i = args.indexOf(flag); return i !== -1 ? args[i+1] : def; };
const BATCH_SIZE     = parseInt(getArg('--batch',      '50'),  10);
const CHECKPOINT_N   = parseInt(getArg('--checkpoint', '20'),  10);

// ─── POS maps ────────────────────────────────────────────────────────────────
const POS_ID_TO_NAME = {
  0:'noun', 1:'verb', 2:'adjective', 3:'adverb',
  4:'preposition', 5:'conjunction', 6:'pronoun', 7:'interjection', 19:'number'
};
const POS_NAME_TO_ID = Object.fromEntries(Object.entries(POS_ID_TO_NAME).map(([k,v])=>[v,+k]));

// ─── Load DB ─────────────────────────────────────────────────────────────────
console.log('Loading dictionary …');
const db = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));

// ─── Find placeholders ───────────────────────────────────────────────────────
// A placeholder sense starts with "Bible:" — set by extract-bible-words.mjs
const placeholderSenseIndices = db.senses
  .map((s, i) => s.sense?.startsWith('Bible:') ? i : -1)
  .filter(i => i !== -1);

console.log(`Placeholder senses to enrich : ${placeholderSenseIndices.length}`);
if (placeholderSenseIndices.length === 0) {
  console.log('Nothing to do — all senses already enriched.');
  process.exit(0);
}

// Track max sense id for inserting new Myanmar rows
let maxSenseId = Math.max(...db.senses.map(s => s.id));

// ─── Helper: build batch prompt ───────────────────────────────────────────────
/**
 * @param {Array<{idx, word, pos, exam}>} items
 * @returns {string} prompt text
 */
function buildPrompt(items) {
  const wordList = items.map(item => {
    // Extract Zolai part of exam (before the English in parentheses)
    const zolaiEx = item.exam.replace(/\s*\([^)]*\)\s*$/, '').trim().slice(0, 80);
    const engEx   = (item.exam.match(/\(([^)]*)\)/) ?? [])[1]?.slice(0, 80) ?? '';
    return `${item.word}|${item.pos}|${zolaiEx}|${engEx}`;
  }).join('\n');

  return `You are a Zolai (Tedim Chin / Zomi) – English – Myanmar trilingual lexicographer.

For each word below, provide:
1. A concise English dictionary definition (5–12 words, no leading article)
2. The Myanmar (Burmese) equivalent word or short phrase
3. Corrected part-of-speech if the hint is wrong (else repeat it)

Input format: zolai_word | pos_hint | zolai_example_sentence | english_parallel_verse

${wordList}

Respond with a JSON array — one object per input line, in the same order:
[
  {"word":"<zolai>","def_en":"<english definition>","def_my":"<myanmar>","pos":"<pos>"},
  ...
]
Rules:
- def_en: short definition, no quotes, no trailing period
- def_my: Myanmar script only (e.g. "ဘုရားသခင်"), empty string if unknown
- pos: one of noun/verb/adjective/adverb/conjunction/preposition/pronoun/interjection/number
- Output ONLY the JSON array, no markdown fences, no extra text`;
}

// ─── Helper: safe JSON parse from API response ────────────────────────────────
function parseResponse(text) {
  // Strip markdown fences if present
  const clean = text.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/,'').trim();
  try {
    const parsed = JSON.parse(clean);
    if (Array.isArray(parsed)) return parsed;
  } catch (_) {}

  // Fallback: extract individual JSON objects line by line
  const results = [];
  for (const line of clean.split('\n')) {
    const trimmed = line.trim().replace(/,$/, '');
    if (!trimmed.startsWith('{')) continue;
    try { results.push(JSON.parse(trimmed)); } catch (_) {}
  }
  return results;
}

// ─── Helper: save checkpoint ─────────────────────────────────────────────────
function saveCheckpoint(wordsEnriched, sensesAdded) {
  db._meta.words_count  = db.words.length;
  db._meta.senses_count = db.senses.length;
  db._meta.enriched_at  = new Date().toISOString();
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2), 'utf8');
  console.log(`  ✓ checkpoint — enriched: ${wordsEnriched}, myanmar rows added: ${sensesAdded}, total senses: ${db.senses.length}`);
}

// ─── Main enrichment loop ────────────────────────────────────────────────────
const client = new Anthropic();

// Build work items
const workItems = placeholderSenseIndices.map(idx => {
  const s = db.senses[idx];
  return { idx, word: s.word, pos: POS_ID_TO_NAME[s.wrte] ?? 'noun', exam: s.exam ?? '' };
});

// Chunk into batches
const batches = [];
for (let i = 0; i < workItems.length; i += BATCH_SIZE) {
  batches.push(workItems.slice(i, i + BATCH_SIZE));
}

console.log(`Batches: ${batches.length} × up to ${BATCH_SIZE} words each`);
console.log(`Checkpoint every ${CHECKPOINT_N} batches\n`);

let totalEnriched  = 0;
let totalMyanmar   = 0;
let totalErrors    = 0;

for (let batchNum = 0; batchNum < batches.length; batchNum++) {
  const batch  = batches[batchNum];
  const prompt = buildPrompt(batch);

  try {
    const msg = await client.messages.create({
      model:      'claude-sonnet-4-5',
      max_tokens: 4096,
      messages:   [{ role: 'user', content: prompt }],
    });

    const results = parseResponse(msg.content[0].text);

    // Build a map keyed by zolai word for O(1) lookup
    const resultMap = Object.fromEntries(results.map(r => [r.word?.toLowerCase(), r]));

    for (const item of batch) {
      const res = resultMap[item.word.toLowerCase()];
      if (!res) continue;

      const defEn = (res.def_en ?? '').trim();
      const defMy = (res.def_my ?? '').trim();
      const pos   = (res.pos ?? '').toLowerCase();

      if (!defEn) continue;

      // ── Update English sense row in-place ──
      const senseRow = db.senses[item.idx];
      senseRow.sense = defEn;
      if (pos && POS_NAME_TO_ID[pos] !== undefined) {
        senseRow.wrte = POS_NAME_TO_ID[pos];
      }
      totalEnriched++;

      // ── Insert Myanmar sense row (wseq=1) if we have a translation ──
      if (defMy) {
        // Avoid duplicate: check if a wseq=1 row already exists for this word
        const hasMy = db.senses.some(s => s.word === senseRow.word && s.wseq === 1);
        if (!hasMy) {
          db.senses.push({
            id:    ++maxSenseId,
            word:  senseRow.word,
            wrte:  senseRow.wrte,
            sense: defMy,
            exam:  senseRow.exam,
            wseq:  1,
          });
          totalMyanmar++;
        }
      }
    }

    const pct = (((batchNum + 1) / batches.length) * 100).toFixed(1);
    process.stdout.write(`\r  batch ${batchNum+1}/${batches.length} (${pct}%) — enriched: ${totalEnriched}, myanmar: ${totalMyanmar}, errors: ${totalErrors}`);

  } catch (err) {
    totalErrors++;
    console.error(`\n  ✗ batch ${batchNum+1} error: ${err.message}`);
    // Short back-off on error
    await new Promise(r => setTimeout(r, 3000));
  }

  // Checkpoint
  if ((batchNum + 1) % CHECKPOINT_N === 0) {
    console.log('');
    saveCheckpoint(totalEnriched, totalMyanmar);
  }

  // Polite rate-limit pause (50 req/min default tier = 1.2s between calls)
  await new Promise(r => setTimeout(r, 400));
}

// ─── Final save ───────────────────────────────────────────────────────────────
console.log('\n');
saveCheckpoint(totalEnriched, totalMyanmar);

// ─── Summary ──────────────────────────────────────────────────────────────────
const stillPlaceholder = db.senses.filter(s => s.sense?.startsWith('Bible:')).length;
console.log('\n══════════════════════════════════');
console.log(`English senses enriched : ${totalEnriched.toLocaleString()}`);
console.log(`Myanmar rows added      : ${totalMyanmar.toLocaleString()}`);
console.log(`API errors              : ${totalErrors}`);
console.log(`Remaining placeholders  : ${stillPlaceholder}`);
console.log(`Total senses in DB      : ${db.senses.length.toLocaleString()}`);
console.log('══════════════════════════════════');
