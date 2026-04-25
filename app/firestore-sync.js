/**
 * app/firestore-sync.js — Firestore overlay for word edits
 *
 * ─────────────────────────────────────────────────────────────────────
 * ARCHITECTURE
 * ─────────────────────────────────────────────────────────────────────
 *
 * Static data: db/words.json    ← 7,861 base words from Bible corpus
 * Overlay:     Firestore /edits ← admin corrections, sparse, per-word
 *
 * Why this design instead of storing all 7,861 words in Firestore?
 *   1. Cost: free tier = 50K reads/day. Each visit reads up to 7,861
 *      docs = 6 visits/day max. With overlay, base words cost 0 reads.
 *   2. Speed: words.json is one HTTP request, served from CDN cache.
 *      Firestore would need pagination or large query loops.
 *   3. Performance: overlay is small — only edited words are stored.
 *      With 100 edits, we do 100 reads on first load, then cached.
 *
 * Data shape in Firestore:
 *   /edits/{wordKey}
 *     word:    "aana"
 *     wrte:    0                                  (POS id)
 *     senseEn: "Authority / power"
 *     senseMy: "အာဏာ / တန်ခိုး"
 *     exam:    "..."                              (optional)
 *     notes:   "..."                              (optional)
 *     deleted: false                              (true = hide from UI)
 *     editedBy:    "dalsuum08@gmail.com"
 *     editedAt:    serverTimestamp()
 *
 * wordKey is the lowercased word (so case differences merge).
 *
 * Real-time sync:
 *   onSnapshot() listens for changes. When admin edits in one tab,
 *   any open tab (including other users on the live site) receives
 *   the update within ~1 second.
 *
 * Security:
 *   Firestore rules below — only AUTHORIZED_EMAILS can write.
 *   Anyone can read (public dictionary).
 */

import { initializeApp, getApp, getApps }      from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import { getFirestore, doc, setDoc, deleteDoc,
         collection, onSnapshot, serverTimestamp,
         getDocs }                              from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
import { getAuth }                              from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';

const firebaseConfig = {
  apiKey:            'AIzaSyCbDaQbsRETHjUVzUiJnr7IBNI_lbISfv0',
  authDomain:        'zolai-dictionary.firebaseapp.com',
  projectId:         'zolai-dictionary',
  storageBucket:     'zolai-dictionary.firebasestorage.app',
  messagingSenderId: '677623846772',
  appId:             '1:677623846772:web:4d4b2b5e354dd532263e21',
};

// Reuse Firebase app if auth.js already initialised it
const app = getApps().length ? getApp() : initializeApp(firebaseConfig);
const db  = getFirestore(app);

const COLLECTION = 'edits';

/** Normalize word into a Firestore-safe document key. */
function wordKey(word) {
  return String(word ?? '').toLowerCase().trim()
    .replace(/[^\w-]/g, '_');   // Firestore doc IDs cannot contain / . etc.
}

export class FirestoreSync {
  constructor() {
    this._unsub        = null;
    this._editsByKey   = new Map();   // wordKey → edit doc data
    this._onUpdate     = null;
  }

  /**
   * Start listening for edits. Calls onUpdate() whenever overlay changes.
   * @param {Function} onUpdate  receives Map<wordKey, editData>
   */
  startListening(onUpdate) {
    this._onUpdate = onUpdate;

    // First fetch existing edits, then subscribe to changes
    this._unsub = onSnapshot(
      collection(db, COLLECTION),
      snapshot => {
        snapshot.docChanges().forEach(change => {
          const k = change.doc.id;
          if (change.type === 'removed') {
            this._editsByKey.delete(k);
          } else {
            this._editsByKey.set(k, change.doc.data());
          }
        });
        if (this._onUpdate) this._onUpdate(this._editsByKey);
      },
      err => console.warn('[FirestoreSync] listen error:', err.message)
    );
  }

  /** Stop listening (e.g. on sign-out). */
  stopListening() {
    if (this._unsub) { this._unsub(); this._unsub = null; }
  }

  /**
   * One-time fetch of all edits. Used for initial page load before
   * subscribing — gives the public site instant access to corrections
   * without needing to wait for the snapshot listener.
   */
  async fetchAll() {
    const snap = await getDocs(collection(db, COLLECTION));
    snap.forEach(d => this._editsByKey.set(d.id, d.data()));
    return this._editsByKey;
  }

  /** Save (or overwrite) an edit for a word. Requires admin auth. */
  async saveEdit(word, payload) {
    const user = getAuth(app).currentUser;
    if (!user) throw new Error('Must be signed in to edit.');

    const k    = wordKey(word);
    const ref  = doc(db, COLLECTION, k);
    await setDoc(ref, {
      word:       word.trim(),
      wrte:       payload.wrte ?? 0,
      senseEn:    payload.senseEn?.trim() ?? '',
      senseMy:    payload.senseMy?.trim() ?? '',
      exam:       payload.exam?.trim()    ?? '',
      notes:      payload.notes?.trim()   ?? '',
      deleted:    false,
      editedBy:   user.email,
      editedAt:   serverTimestamp(),
    }, { merge: true });
  }

  /**
   * Mark a word as deleted. We don't physically remove the doc so
   * we have an audit trail of who deleted what and when.
   */
  async markDeleted(word) {
    const user = getAuth(app).currentUser;
    if (!user) throw new Error('Must be signed in to delete.');

    const k   = wordKey(word);
    const ref = doc(db, COLLECTION, k);
    await setDoc(ref, {
      word:     word.trim(),
      deleted:  true,
      editedBy: user.email,
      editedAt: serverTimestamp(),
    }, { merge: true });
  }

  /** Permanently revert a word — delete the overlay row entirely. */
  async revertEdit(word) {
    const user = getAuth(app).currentUser;
    if (!user) throw new Error('Must be signed in to revert.');
    await deleteDoc(doc(db, COLLECTION, wordKey(word)));
  }

  /** Returns the current overlay map (read-only snapshot). */
  getEdits() { return this._editsByKey; }
}

export { wordKey };
