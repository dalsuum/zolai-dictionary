# Zolai Dictionary

[![License: MIT](https://img.shields.io/badge/License-MIT-amber.svg)](LICENSE)
[![Deploy to Firebase](https://github.com/dalsuum/zolai-dictionary/actions/workflows/deploy.yml/badge.svg)](https://github.com/dalsuum/zolai-dictionary/actions/workflows/deploy.yml)
[![Words](https://img.shields.io/badge/words-7%2C861-teal)](db/words.json)
[![Languages](https://img.shields.io/badge/languages-Zolai%20%C2%B7%20English%20%C2%B7%20Myanmar-blue)](#)

A free, open-source trilingual dictionary for the **Zolai (Tedim Chin / Zomi)** language — with English and Myanmar (Burmese) translations. Built as a zero-dependency static site.

> 🌐 **Live site:** https://zolai-dictionary.web.app

---

## Overview

The Zolai language (also called Tedim Chin) is spoken by the Zomi people of the Chin Hills (Myanmar). This dictionary aims to preserve and make accessible the language by combining a curated grammar seed with vocabulary extracted from the full Lai Siangtho Bible corpus (30,758 verses).

---

## Features

- 🔍 **Trilingual search** — type in Zolai, English, or Myanmar script
- 📖 **7,861 headwords** with English + Myanmar translations
- 🖼 **Images** per word via loremflickr + Google Images / Unsplash links
- 🔤 **POS badges** — colour-coded parts of speech (Noun, Verb, Adjective…)
- 📝 **Example sentences** with parallel English translations from the Bible
- 🤖 **AI cultural context** button (Anthropic Claude)
- 📄 **Paginated browse** with A–Z alphabet jump
- ⚙️ **Admin panel** at `/admin` — password-protected CRUD
- 🌙 **Dark mode** — respects `prefers-color-scheme`
- 📱 **Responsive** — works on mobile and desktop

---

## Pages

| URL | Description |
|-----|-------------|
| `/` | Public dictionary — search and browse |
| `/admin` | Admin panel — add / edit / delete words (password-protected) |

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| **Web** | HTML5, CSS3 custom properties, ES Modules |
| **App** | Vanilla JS — `DictionaryService`, `LocalStorageAdapter`, pure utils |
| **DB** | Static JSON (`db/words.json`) — exported from SQLite schema |
| **Images** | loremflickr (embedded) + Google Images + Unsplash (links) |
| **AI** | Anthropic Claude `claude-sonnet-4-20250514` |
| **Hosting** | Google Firebase Hosting |
| **CI/CD** | GitHub Actions → auto-deploy on push to `main` |

---

## Architecture

```
zolai-dictionary/
│
├── db/
│   └── words.json               # Full database (7,861 words · 15,702 senses)
│
├── app/
│   ├── dictionary.js            # DictionaryService — all CRUD + search
│   ├── storage.js               # LocalStorageAdapter — persistence abstraction
│   └── utils.js                 # Pure helpers — debounce, sanitize, parseSense…
│
├── assets/css/
│   ├── main.css                 # Design tokens + shared components
│   └── admin.css                # Admin-only delta styles
│
├── scripts/
│   ├── extract-bible-words.mjs  # Data pipeline — extracts Zolai tokens from Bible
│   └── enrich-definitions.mjs  # Fills English + Myanmar via verse alignment
│
├── .github/workflows/
│   └── deploy.yml               # CI/CD — validate + deploy to Firebase on push
│
├── index.html                   # Client dictionary
├── admin.html                   # Admin panel (separate URL)
├── firebase.json                # Firebase Hosting config
└── LICENSE                      # MIT
```

---

## Database Schema

Follows the [ZomiLanguage/dictionary](https://github.com/ZomiLanguage/dictionary) SQLite schema, exported to JSON:

```jsonc
{
  "synset": [{ "id": 0, "name": "Noun", "shortname": "n" }, ...],
  "words":  [{ "id": 1, "word": "Pasian", "derived": 0 }],
  "senses": [
    { "id": 1, "word": "Pasian", "wrte": 0, "sense": "God", "exam": "...", "wseq": 0 },
    { "id": 2, "word": "Pasian", "wrte": 0, "sense": "ဘုရားသခင်",    "exam": "...", "wseq": 1 }
  ]
}
```

`wseq=0` → English · `wseq=1` → Myanmar

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

No build step needed. Clone and open:

```bash
git clone https://github.com/dalsuum/zolai-dictionary.git
cd zolai-dictionary
# Serve locally (required for ES module imports)
python3 -m http.server 8000
# Open http://localhost:8000
```

### Setting the admin password

The admin password is **never stored in source code**. Set it directly in the browser on your live site:

1. Open `https://zolai-dictionary.web.app/admin`
2. Open DevTools console (F12)
3. Run: `localStorage.setItem("zolai_admin_pw", "your-strong-password")`
4. Refresh — your password is now active on that browser

Repeat on every device you want admin access from.

### Re-seeding the database

To force the app to reload `words.json` (e.g. after updating it), clear the storage keys in browser DevTools:

```js
localStorage.removeItem('zolai_prefs_v3');
localStorage.removeItem('zolai_ai_cache_v3');
```

### Running the data pipeline

```bash
# Extract new words from the Bible corpus
node scripts/extract-bible-words.mjs --bible ../bible/json/3561.json --freq 3

# Enrich with translations
node scripts/enrich-definitions.mjs
```

---

## Deployment

Every push to `main` auto-deploys via GitHub Actions.

**One-time setup:**
1. Create a Firebase project at [console.firebase.google.com](https://console.firebase.google.com)
2. Enable Hosting
3. Download the service account JSON (Project settings → Service accounts)
4. Add it as a GitHub secret: `FIREBASE_SERVICE_ACCOUNT`

---

## Contributing

Contributions are welcome — especially:

- **Better definitions** for Bible-extracted words (currently verse-context based)
- **More words** from other Zolai/Tedim texts
- **Audio pronunciations**
- **Zolai keyboard input** support

Please open an issue or pull request. All PRs are reviewed before merge.

---

## License

This project is licensed under the **MIT License** — see [LICENSE](LICENSE) for the full text.

You are free to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of this software.

The word data sourced from the Lai Siangtho Bible is used for linguistic and educational purposes.
