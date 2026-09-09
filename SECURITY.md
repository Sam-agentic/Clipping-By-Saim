# Security Assessment — Clipping by Saim

**Date:** 2026-09-08
**Scope:** Electron desktop app + Supabase licensing backend

---

## Verdict: ✅ Safe for distribution

The app follows Electron security best practices and the licensing backend
uses a proper server-verified model. No critical vulnerabilities found.

---

## What is already secure

### Electron hardening (main.js)
| Control | Status |
|---|---|
| `contextIsolation: true` | ✅ Renderer isolated from Node |
| `nodeIntegration: false` | ✅ No Node access in renderer |
| `webSecurity: true` | ✅ Web security enforced |
| `allowRunningInsecureContent: false` | ✅ Mixed content blocked |
| Popup windows denied | ✅ `setWindowOpenHandler` blocks all popups |
| Navigation blocked | ✅ `will-navigate` prevented |
| `windowsHide: true` on all spawns | ✅ No console windows |
| No `shell: true` in spawn | ✅ No shell injection possible |

### Preload bridge (preload.js)
- Explicit **allow-list** of IPC channels — renderer can only call what is
  exposed, nothing else.
- Encrypted session + device hash stay in the **main process** — the renderer
  never sees them.

### Input validation (main.js)
- `safeCaptionStyle()` — whitelist, unknown → `'bold'`
- `safeFraming()` — whitelist, unknown → `'crop'`
- `safeLanguage()` — whitelist, unknown → `'auto'`
- `safeColour()` — strict `#RRGGBB` regex, else dropped
- `safeText()` — strips line breaks, limits length
- `clampInt()` / `clampFloat()` — numeric bounds enforced
- `assertInsideProjects()` (clipStudio.js) — **path traversal protection** for
  all project-dir operations

### Licensing backend (Supabase)
- **RLS enabled** on all 3 tables (`profiles`, `access_requests`,
  `licensed_devices`) — no direct client access
- **Service-role key** only lives as an Edge Function secret — never in the app
- **JWT validated server-side** in `verify-license` via `auth.getUser(jwt)`
- **Device limits enforced** — device hash count checked against `device_limit`
- **Owner-only approval** — `admin-approve` checks `role = 'owner'` before
  inviting customers
- **Public sign-ups disabled** — only owner-invited users can join
- **Auto-profile trigger** — profiles always in sync with `auth.users`

### Network (main.js)
- `download-preset-pack` — **whitelisted URL** (only the emoji pack from
  `raw.githubusercontent.com`), response JSON-validated
- `downloadText` — redirects followed, non-200 rejected

### File handling
- `save-project` — atomic write (temp file + rename)
- `load-project` — `formatVersion === 1` validated
- `clip-discard` — path validated via `assertInsideProjects`
- Stale temp projects swept on startup and before each new job

---

## Improvements — all implemented ✅

| # | Issue | Status | Fix applied |
|---|---|---|---|
| 1 | **No Content-Security-Policy** in `index.html` | ✅ Fixed | `<meta http-equiv="Content-Security-Policy">` added — `default-src 'self' file:`; scripts, styles, images, media, fonts, connect-src all locked down; `object-src 'none'`, `base-uri 'none'`, `form-action 'none'` |
| 2 | `sandbox: false` in webPreferences | ✅ Fixed | `sandbox: true` set in `main.js` — renderer fully sandboxed, preload still works via contextBridge |
| 3 | `open-file` / `reveal-file` accept any path | ✅ Fixed | `isSafeToReveal()` added — only files inside `DATA_DIR` can be revealed/opened |
| 4 | `license-approve-customer` has no try/catch in main.js | ✅ Fixed | Wrapped in try/catch — returns `{ success: false, error }` instead of throwing |
| 5 | `download-preset-pack` has no size limit | ✅ Fixed | `MAX_PACK_BYTES = 10 MB` — response destroyed if exceeded |
| 6 | **YouTube download size limit** | ✅ Fixed | `MAX_VIDEO_BYTES = 1 GB` in `ytDownloader.js` — download aborted with a clear message if the video is bigger |

---

## What cannot be fully protected (inherent to desktop apps)

- **Local license bypass** — a determined user can always patch a desktop app
  or modify `licensing.config.json`. This is true for *every* desktop app
  (Adobe, Office, etc.). The server-side checks make casual sharing hard, but
  not impossible.
- **Screen recording / sharing** — once a customer has the app, they can
  record the output. This is a business reality, not a code flaw.

---

## Security checklist (all ✅)

- [x] `contextIsolation: true`
- [x] `nodeIntegration: false`
- [x] `sandbox: true`
- [x] Content-Security-Policy in index.html
- [x] Popups + navigation blocked
- [x] No shell injection (no `shell: true`)
- [x] Path traversal protected (`assertInsideProjects`)
- [x] `open-file` / `reveal-file` restricted to DATA_DIR
- [x] Input whitelists for captions, framing, language, colour, text
- [x] RLS enabled on all tables
- [x] Service-role key never in the app
- [x] JWT validated server-side
- [x] Device limits enforced
- [x] Owner-only approval
- [x] Public sign-ups disabled
- [x] Whitelisted download URLs
- [x] Preset-pack download capped at 10 MB
- [x] YouTube download capped at 1 GB
- [x] Atomic file writes
- [x] License enforced on all expensive operations
