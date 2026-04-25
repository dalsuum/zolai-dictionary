# Zolai Dictionary

[![License: MIT](https://img.shields.io/badge/License-MIT-amber.svg)](LICENSE)
[![Deploy to Firebase](https://github.com/dalsuum/zolai-dictionary/actions/workflows/deploy.yml/badge.svg)](https://github.com/dalsuum/zolai-dictionary/actions/workflows/deploy.yml)
[![Words](https://img.shields.io/badge/words-7%2C861-teal)](db/words.json)
[![Languages](https://img.shields.io/badge/languages-Zolai%20%C2%B7%20English%20%C2%B7%20Myanmar-blue)](#)

A free, open-source trilingual dictionary for the **Zolai (Tedim Chin / Zomi)** language with English and Myanmar (Burmese) translations. Built as a zero-dependency static site with real-time admin corrections.

> 🌐 **Live site:** https://zolai-dictionary.web.app

---

## Overview

The Zolai language (also called Tedim Chin) is spoken by the Zomi people of the Chin Hills (Myanmar/India). This dictionary preserves and makes the language accessible by combining a curated grammar seed with vocabulary extracted from the full Lai Siangtho Bible corpus (30,758 verses), aligned word-for-word with parallel English (KJV) and Myanmar Bible translations.

---

## Features

- 🔍 **Ranked trilingual search** — type in Zolai, English, or Myanmar; results sorted by relevance
- 📖 **7,861 headwords** with English + Myanmar translations
- 🎯 **Bidirectional lookup** — search "debt" finds Zolai `leiba`; search Myanmar `အာဏာ` finds `aana`
- 🖼 **Smart images** — Wikipedia thumbnails for real definitions, Google Images search for verse-based words
- 🔤 **Color-coded POS badges** — Noun, Verb, Adjective, etc.
- 📝 **Example sentences** with parallel English Bible translations
- ✦ **AI cultural context** (optional) — powered by OpenRouter, free tier
- 📄 **Paginated browse** with A–Z alphabet jump
- ⚙️ **Admin panel** at `/admin` — Google Sign-In protected, edits sync live to all visitors
- 🔄 **Real-time corrections** via Firestore overlay (admin saves → live for everyone in < 1s)
- 🔍 **Match highlighting** in search results and detail panel
- 📊 **Google Analytics** with custom events (search, view_word, ai_context_request)
- 🌙 **Dark mode** — respects `prefers-color-scheme`
- 📱 **Responsive** — works on mobile and desktop
- 💾 **Offline-friendly** — IndexedDB caches data for instant subsequent loads

---

## Pages

| URL | Description |
|-----|-------------|
| `/` | Public dictionary — search and browse |
| `/admin` | Admin panel — Google Sign-In; manage words + settings |

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| **Web** | HTML5, CSS3 custom properties, ES Modules — no framework, no build step |
| **App** | Vanilla JS — `DictionaryService`, `AuthService`, `FirestoreSync`, `LocalStorageAdapter` |
| **Base data** | Static JSON (`db/words.json`) — exported from SQLite schema |
| **Live edits** | Firestore overlay (`/edits` collection) — admin corrections sync in real-time |
| **Cache** | IndexedDB — instant subsequent loads (< 100ms) |
| **Auth** | Firebase Authentication — Google Sign-In with email whitelist |
| **AI** | OpenRouter API — free tier, 100+ models, OpenAI-compatible |
| **Hosting** | Google Firebase Hosting (CDN-backed, HTTPS, free tier) |
| **CI/CD** | GitHub Actions → auto-deploy on push to `main` |
| **Analytics** | Google Analytics GA4 |

---

## Architecture

```
zolai-dictionary/
│
├── db/
│   └── words.json               # Base database (7,861 words · 15,702 senses)
│
├── app/
│   ├── auth.js                  # Firebase Auth — Google Sign-In + email whitelist
│   ├── dictionary.js            # DictionaryService — search, CRUD, IndexedDB cache, overlay merge
│   ├── firestore-sync.js        # Real-time overlay sync — admin edits → all visitors
│   ├── storage.js               # LocalStorageAdapter — prefs only
│   └── utils.js                 # sanitize, debounce, parseSense, parseExam, truncate
│
├── assets/css/
│   ├── main.css                 # Design tokens + shared components
│   └── admin.css                # Admin-only styles
│
├── scripts/
│   ├── extract-bible-words.mjs  # Data pipeline — extract Zolai tokens from Bible
│   └── enrich-definitions.mjs   # Fill English + Myanmar via verse alignment
│
├── .github/workflows/
│   └── deploy.yml               # CI/CD — validate JSON, deploy to Firebase
│
├── index.html                   # Public dictionary
├── admin.html                   # Admin panel (separate route, noindex)
├── firebase.json                # Firebase Hosting config + cache headers
├── firestore.rules              # Firestore security rules (admin email whitelist)
└── LICENSE                      # MIT
```

### How the overlay system works

```
                         ┌──────────────────────┐
                         │   words.json (CDN)   │  Base: 7,861 Bible-extracted words
                         │     ~4.6 MB cached    │  Read-only
                         └──────────┬───────────┘
                                    │
                 boot ↓              │  load once per session
                                    ↓
                        ┌──────────────────────┐
                        │  IndexedDB (browser) │   Cached for 24h
                        └──────────┬───────────┘
                                    │
                                    ↓
                        ┌──────────────────────┐
                        │  In-memory Maps      │   _wordMap, _senseMap
                        └──────────┬───────────┘
                                    │
                                    ↓ applyOverlay()
                        ┌──────────────────────┐
                        │  Firestore /edits    │   Admin corrections
                        │  (live snapshot)     │   Real-time updates
                        └──────────────────────┘
```

When an admin saves an edit, Firestore broadcasts the change via `onSnapshot` to every open browser tab — including casual readers — and the UI updates within ~1 second.

---

## Database Schema

Follows the [ZomiLanguage/dictionary](https://github.com/ZomiLanguage/dictionary) SQLite schema, exported to JSON:

```jsonc
{
  "synset": [{ "id": 0, "name": "Noun", "shortname": "n" }, ...],
  "words":  [{ "id": 1, "word": "Pasian", "derived": 0 }],
  "senses": [
    { "id": 1, "word": "Pasian", "wrte": 0, "sense": "God",          "exam": "...", "wseq": 0 },
    { "id": 2, "word": "Pasian", "wrte": 0, "sense": "ဘုရားသခင်", "exam": "...", "wseq": 1 }
  ]
}
```

`wseq=0` → English · `wseq=1` → Myanmar

### Firestore overlay schema

```jsonc
// /edits/{wordKey}
{
  word:     "aana",
  wrte:     0,
  senseEn:  "Authority / power",
  senseMy:  "အာဏာ / တန်ခိုး",
  exam:     "...",
  notes:    "...",
  deleted:  false,
  editedBy: "admin@example.com",
  editedAt: 1730000000  // server timestamp
}
```

---

## Search Logic

8-tier ranked scoring with minimum-length thresholds to reduce noise:

| Score | Match | Min query length |
|------:|-------|------------------|
| 100 | Exact headword | 1+ |
| 75  | Headword starts with query | 1+ |
| 50  | Headword contains query | 1+ |
| 40  | English exam (verse) word-boundary | 5+ |
| 35  | English sense starts with query | 3+ |
| 30  | English sense word-boundary | 3+ |
| 20  | Myanmar sense contains query | 2+ |
| 15  | English exam substring | 5+ |
| 10  | English sense substring | 3+ |

Higher minimums on exam/sense fields prevent short queries like `"la"` from matching thousands of Bible verse fragments.

---

## Data Sources

| Source | Role |
|--------|------|
| [ZomiLanguage/dictionary](https://github.com/ZomiLanguage/dictionary) | SQLite schema |
| *Paunam Khenna Leh Kampau Luanzia* | 60-word grammar seed |
| [dalsuum/bible](https://github.com/dalsuum/bible) `json/3561.json` | Lai Siangtho — 30,758 Zolai verses |
| [dalsuum/bible](https://github.com/dalsuum/bible) `json/1.json` | KJV — parallel English |
| [dalsuum/bible](https://github.com/dalsuum/bible) `json/1391.json` | သမ္မာကျမ်း — parallel Myanmar |

---

## Getting Started

No build step. Clone and serve:

```bash
git clone https://github.com/dalsuum/zolai-dictionary.git
cd zolai-dictionary
python3 -m http.server 8000
# Open http://localhost:8000
```

### Re-seeding the local cache

To force a fresh fetch of `words.json` (e.g. after editing it), clear IndexedDB in browser DevTools:

```
DevTools → Application → IndexedDB → zolai_dict → Delete database
```

### Running the data pipeline

```bash
node scripts/extract-bible-words.mjs --bible ../bible/json/3561.json --freq 3
node scripts/enrich-definitions.mjs
```

---

## Deployment

Every push to `main` auto-deploys via GitHub Actions.

### One-time Firebase setup

1. **Firebase Console → Project settings → Service accounts → Generate new private key**
2. **GitHub repo → Settings → Secrets → Actions** — add `FIREBASE_SERVICE_ACCOUNT` with the JSON contents
3. **Firebase Console → Authentication → Sign-in method → Google → Enable**
4. **Firebase Console → Build → Firestore Database → Create database** (production mode, choose region)
5. **Firestore Database → Rules tab** — paste contents of [`firestore.rules`](firestore.rules) → Publish

### Adding admin emails

Two places need updating:

1. [`app/auth.js`](app/auth.js) — `AUTHORIZED_EMAILS` array (controls login access)
2. [`firestore.rules`](firestore.rules) — email list inside `request.auth.token.email in [...]` (controls write access)

Both must match. Push to `main` to redeploy auth.js; manually publish updated rules in Firebase Console.

---

## Admin Settings

Sign in at `/admin` to access **⚙️ Site settings**:

| Setting | Storage | Purpose |
|---------|---------|---------|
| Google Analytics Measurement ID | localStorage `ga_measurement_id` | GA4 tracking ID |
| OpenRouter API Key | localStorage `ai_api_key` | AI cultural context (free key at [openrouter.ai](https://openrouter.ai/keys)) |
| OpenRouter Model | localStorage `ai_model` | Which model to use (default: `meta-llama/llama-3.1-8b-instruct:free`) |

These settings live in the admin's browser only — they don't affect other users.

---

## Contributing

Contributions are welcome — especially:

- **Better definitions** for Bible-extracted words (currently use verse context — many are not accurate dictionary entries)
- **More words** from other Zolai/Tedim texts
- **Audio pronunciations**
- **Zolai keyboard input** support

Two ways to contribute:

1. **Direct admin edits** (if you have admin access) — edits sync live to all users via Firestore
2. **Pull requests** — fork, edit `db/words.json`, open a PR

All PRs are reviewed before merge.

---

## License

MIT — see [LICENSE](LICENSE).

You are free to use, copy, modify, merge, publish, distribute, sublicense, and sell copies of this software.

The Zolai word data sourced from the Lai Siangtho Bible is used for linguistic and educational purposes.
