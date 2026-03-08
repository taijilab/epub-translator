# CLAUDE.md — AI Assistant Guide for epub-translator

## Project Overview

This is a **client-side EPUB multi-language translation tool** built with vanilla HTML, JavaScript, and Tailwind CSS. It translates EPUB files using external LLM translation APIs (OpenRouter, Zhipu AI, or any OpenAI-compatible endpoint) entirely in the browser — no backend server required.

**Key characteristics:**
- Single-page application (SPA) — everything runs in the browser
- No build step or compilation required
- No backend/server component
- Supports batch translation of multiple EPUB files concurrently
- Preserves original HTML/XML structure, CSS, and formatting

---

## Repository Structure

```
epub-translator/
├── index.html              # Main UI (single HTML file, ~540 lines)
├── js/
│   └── app.js              # All application logic (~4,816 lines)
├── css/
│   ├── styles.css          # Custom CSS overrides (minimal)
│   ├── tailwind-cdn.css    # Tailwind from CDN
│   ├── tailwind-clean.css  # Compiled Tailwind variant
│   └── tailwind-compiled.css
├── tailwind.config.js      # Tailwind CSS configuration
├── package.json            # NPM dev dependencies (tailwindcss only)
├── README.md               # User-facing documentation
├── PERFORMANCE.md          # Performance optimization notes
└── .claude/
    └── settings.local.json # Claude Code permissions
```

**No test directory**, no `src/` split, no build output directories.

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| UI | HTML5 + Tailwind CSS v4 (CDN) |
| Logic | Vanilla JavaScript (ES6+, no frameworks) |
| EPUB Parsing | JSZip v3.10.1 (CDN) |
| Translation | External LLM APIs (OpenRouter, Zhipu AI, Custom) |
| Build | None — static files served directly |

**External CDN dependencies loaded in `index.html`:**
- `https://cdn.tailwindcss.com` — Tailwind CSS
- `https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js` — JSZip

---

## How to Run

```bash
# Python (simplest)
python -m http.server 8000
# Open http://localhost:8000

# Node.js
npx serve .
```

Or open `index.html` directly in a browser (`file://` protocol works).

**No `npm install` or build step needed to run the app.**

---

## No Tests

There is no test suite. `npm test` exits with an error by design. When adding features, verify manually using:
1. Demo Mode (built into the UI — no API key required)
2. Browser DevTools console
3. Sample EPUB files

---

## app.js Architecture

`js/app.js` is the entire application. It is organized as follows:

### Global State (lines 1–126)
```javascript
let epubFile, epubZip, translatedEpub   // Single-file state
let isTranslating, shouldCancel          // Translation control flags
const translationCache = new Map()       // LRU cache (max 1,000 entries)
let fileListData = []                    // Multi-file batch state
let isVerticalMode = false               // Vertical EPUB detection flag
```

### Key Function Groups

**File Handling**
- `handleFileSelect()` — drag-and-drop and file input handler
- `parseEpub()` — unzips EPUB (ZIP archive) using JSZip
- `analyzeEpubContent()` — extracts metadata, character counts
- `detectVerticalMode()` — checks CSS for `writing-mode: vertical-rl`

**Translation Pipeline**
- `handleTranslate()` — main entry point; orchestrates the full pipeline
- `translateText()` — routes to appropriate service based on user config
- `translateWithOpenRouter()` — OpenRouter API call
- `translateWithZhipuAI()` — Zhipu AI (GLM-4-Flash) call
- `translateWithCustomAPI()` — any OpenAI-compatible endpoint
- `demoTranslate()` — offline testing mode

**Text/Format Processing**
- `convertVerticalToHorizontal()` — converts Japanese vertical EPUBs
- `cleanTranslatedText()` — strips AI response artifacts
- `escapeHtml()` — HTML-safe escaping

**Batch Processing**
- `processMultipleFiles()` — translates multiple EPUBs concurrently
- `updateFileStatus()` — updates per-file status in UI
- `previewTranslatedFile()` — in-browser preview
- `downloadTranslatedFile()` — triggers browser download

**UI Utilities**
- `renderFileList()` — renders file list with status badges
- `updateProgress()` — updates progress bar and counters
- `addLog()` — appends messages to log panel
- `updateTokenDisplay()` — shows token usage and cost estimate
- `throttle()` — rate-limits UI update calls (100ms default)

### Event Listeners (lines 376–493)
All DOM event listeners are registered at the bottom of the file after function definitions. This is the established pattern — maintain it.

---

## Performance-Critical Patterns

These patterns are intentional optimizations — do not revert them:

| Pattern | Value | Reason |
|---------|-------|--------|
| Concurrent API requests | 30 | Maximizes throughput |
| Batch character size | 300–500 chars/group | Reduces API call count |
| Retry strategy | Exponential backoff (500→1000→2000ms) | Handles rate limits |
| Translation cache | Map, max 1,000 entries | Avoids duplicate API calls |
| UI update throttle | 100ms | Prevents render jank |
| Parallel HTML files | 4 at a time | Balances speed vs. memory |

See `PERFORMANCE.md` for full details.

---

## Translation API Services

### OpenRouter (recommended)
- Endpoint: `https://openrouter.ai/api/v1/chat/completions`
- Format: OpenAI-compatible chat completions
- Default model: DeepSeek Chat
- Function: `translateWithOpenRouter()`

### Zhipu AI
- Base URL: `https://open.bigmodel.cn/api/paas/v4/`
- Default model: GLM-4-Flash
- Function: `translateWithZhipuAI()`

### Custom API
- Any OpenAI-compatible chat completions endpoint
- Function: `translateWithCustomAPI()`

### Demo Mode
- No API key required
- Prefixes text with language codes for UI testing
- Function: `demoTranslate()`

API keys are stored in `localStorage` — never hardcoded.

---

## Supported Languages

| Language | Code |
|----------|------|
| Chinese (中文) | zh |
| English | en |
| Japanese (日語) — includes vertical detection | ja |
| Korean (韩语) | ko |
| French (法语) | fr |
| Spanish (西班牙语) | es |
| German (德语) | de |
| Russian (俄语) | ru |
| Portuguese (葡萄牙语) | pt |

---

## Code Conventions

### Naming
- **camelCase** for variables and functions
- **UPPER_CASE** for constants (e.g., `UI_UPDATE_THROTTLE`)
- Boolean variables prefixed: `is`, `should`, `has` (e.g., `isTranslating`, `shouldCancel`, `isVerticalMode`)

### DOM Manipulation
- Use `textContent` instead of `innerHTML` for user-provided content to prevent XSS
- Create elements with `document.createElement()` for dynamic content
- Use `escapeHtml()` when inserting untrusted content as HTML

### Async Patterns
- Use `async/await` with `try/catch` around all API calls
- Use `Promise.all()` for concurrent operations
- Implement exponential backoff for retries

### Logging
- Use `addLog(message, type)` for user-visible log messages
- `type` values: `'info'`, `'success'`, `'warning'`, `'error'`
- Console logs are used for debugging; minimize in production paths

### State Management
- Global variables at the top of `app.js` hold all application state
- No state management library — direct mutation of module-level variables
- Reset state at the start of each translation run

---

## Vertical EPUB Handling

Japanese manga/light novels often use vertical writing mode. The app detects and converts these:

**Detection:** Scans OPF spine and CSS for:
- `writing-mode: vertical-rl`
- `direction: rtl`

**Conversion (`convertVerticalToHorizontal()`):**
- Rewrites CSS: `vertical-rl` → `horizontal-tb`, `rtl` → `ltr`
- Handles quoted and unquoted attribute values
- Corrects page order metadata in OPF
- Applies to all CSS and HTML files in the EPUB

---

## EPUB File Format Notes

EPUB files are ZIP archives containing:
- `META-INF/container.xml` — locates the OPF file
- `*.opf` — package metadata, spine (reading order), manifest
- `*.html` / `*.xhtml` — content files (what gets translated)
- `*.css` — stylesheets (modified for vertical conversion)
- Images, fonts, etc. (passed through unchanged)

JSZip handles all ZIP reading/writing. The app parses OPF XML to find content files, translates them, then repacks everything into a new ZIP for download.

---

## What NOT to Do

- **Do not add a backend.** This is intentionally client-side.
- **Do not add a framework** (React, Vue, etc.) — the codebase is vanilla JS by design.
- **Do not hardcode API keys.** Keys must come from user input stored in `localStorage`.
- **Do not use `eval()`** or dynamic code execution.
- **Do not modify the original EPUB files** — always create new output files.
- **Do not reduce concurrency limits** without benchmarking — they were tuned deliberately.
- **Do not break the `app.js.bak` backup** — it is a manual snapshot; do not delete it.

---

## Common Development Tasks

### Adding a New Translation Service
1. Add a new option to the `<select id="translationService">` in `index.html`
2. Create a `translateWithNewService(text, sourceLang, targetLang)` function in `app.js`
3. Add a case for it in `translateText()` routing function
4. Add a conditional block in `handleServiceChange()` to show/hide config fields
5. Add a new config section in `index.html` (following existing patterns)

### Adding a New Target Language
1. Add a new `<option>` to the language `<select>` elements in `index.html`
2. No changes needed in `app.js` — language codes are passed through dynamically

### Modifying Translation Prompts
- Prompts are constructed inside `translateWithOpenRouter()`, `translateWithZhipuAI()`, etc.
- Search for `"你是专业翻译"` or `"system"` role in `app.js` to locate them

### Debugging Translation Issues
1. Enable Demo Mode to isolate from API issues
2. Check browser console for errors
3. Look at the log panel in the UI (`addLog` messages)
4. Check `translationCache` in DevTools console

---

## Git Workflow

- Active development branch: `claude/claude-md-mlu87ti7lc4soysg-X2qGp`
- Remote: `http://local_proxy@127.0.0.1:52469/git/taijilab/epub-translator`
- Commit messages use Chinese prefixes: `fix:`, `feat:`, `perf:`

```bash
git add <files>
git commit -m "fix: description of fix"
git push -u origin <branch-name>
```
