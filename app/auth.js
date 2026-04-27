/**
 * app/auth.js — Firebase Authentication Service
 *
 * Replaces the localStorage password with Google OAuth 2.0.
 *
 * WHY Google Sign-In over a password?
 *   localStorage passwords can be read/set by anyone with DevTools access.
 *   Google Sign-In tokens are verified by Google's servers — the browser
 *   cannot forge them. Identity is guaranteed by Google, not by us.
 *
 * Security model:
 *   1. User clicks "Sign in with Google" → Google popup appears
 *   2. Google verifies identity → returns a signed JWT token
 *   3. We check if the verified email is in AUTHORIZED_EMAILS
 *   4. If yes → admin access granted
 *   5. If no → "Access denied" shown, signed out immediately
 *
 * The firebaseConfig values are SAFE to commit — they are public
 * client-side identifiers, not secrets. Firebase Security Rules
 * (not these keys) control what the app can read/write.
 */

import { initializeApp }                            from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import { getAuth, signInWithPopup, signOut,
         GoogleAuthProvider, onAuthStateChanged }   from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';

// ── Firebase project config (public client-side, safe to commit) ─────────────
const firebaseConfig = {
  apiKey:            'AIzaSyCbDaQbsRETHjUVzUiJnr7IBNI_lbISfv0',
  authDomain:        'zolai-dictionary.firebaseapp.com',
  //projectId:         'zolai-dictionary',
  //storageBucket:     'zolai-dictionary.firebasestorage.app',
  //messagingSenderId: '677623846772',
  //appId:             '1:677623846772:web:4d4b2b5e354dd532263e21',
  //authDomain: "zolai-dictionary.web.app", 
  projectId: "zolai-dictionary",
  storageBucket: "zolai-dictionary.firebasestorage.app",
  messagingSenderId: "677623846772",
  appId: "1:677623846772:web:4d4b2b5e354dd532263e21"
};

// ── Authorized admin emails ───────────────────────────────────────────────────
// WHY a whitelist?
//   Firebase Auth verifies *who* signed in but not *whether* they should
//   have admin access. Any Google account could sign in without this check.
//   Only emails listed here are allowed into the admin panel.
const AUTHORIZED_EMAILS = [
  'dalsuum08@gmail.com',
  // Add more admin emails here if needed
];

// ── Initialize Firebase ───────────────────────────────────────────────────────
const app      = initializeApp(firebaseConfig);
const auth     = getAuth(app);
const provider = new GoogleAuthProvider();

// Force account picker every time so admins can switch accounts
provider.setCustomParameters({ prompt: 'select_account' });

// ── AuthService ───────────────────────────────────────────────────────────────
export class AuthService {
  constructor() {
    this._user     = null;   // current Firebase user object (or null)
    this._onChange = null;   // callback: (user|null) => void
  }

  /**
   * Subscribe to auth state changes.
   * Callback receives the verified user if authorized, null otherwise.
   * @param {Function} callback  (user: FirebaseUser|null) => void
   */
  onAuthChange(callback) {
    this._onChange = callback;
    onAuthStateChanged(auth, (user) => {
      if (user && this._isAuthorized(user)) {
        this._user = user;
        callback(user);
      } else {
        this._user = null;
        callback(null);
        // If signed in but not authorized, sign them out cleanly
        if (user) signOut(auth);
      }
    });
  }

  /**
   * Open the Google Sign-In popup.
   * Returns the authorized user or throws a typed error.
   * @returns {Promise<FirebaseUser>}
   */
  async signIn() {
    try {
      const result = await signInWithPopup(auth, provider);
      const user   = result.user;
      if (!this._isAuthorized(user)) {
        await signOut(auth);
        const err = new Error(`Access denied for ${user.email}. Contact the site owner.`);
        err.code = 'AUTH_UNAUTHORIZED';
        throw err;
      }
      return user;
    } catch (err) {
      // Re-throw so the UI can display the right message
      if (err.code === 'auth/popup-closed-by-user') {
        const e = new Error('Sign-in cancelled.');
        e.code = 'AUTH_CANCELLED';
        throw e;
      }
      throw err;
    }
  }

  /** Sign out the current user. */
  async signOut() {
    await signOut(auth);
    this._user = null;
  }

  /** Returns the current verified user, or null if not signed in. */
  get currentUser() {
    return this._user;
  }

  /** Returns true if a verified, authorized user is signed in. */
  get isAuthenticated() {
    return this._user !== null;
  }

  // ── Private ─────────────────────────────────────────────────────────────────
  _isAuthorized(user) {
    return user?.email && AUTHORIZED_EMAILS.includes(user.email.toLowerCase());
  }
}
