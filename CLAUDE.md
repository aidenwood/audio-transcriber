# Audio Transcriber — Hall (slim)

One-liner: Localhost audio/video transcription tool — drag a file in, get text back via AssemblyAI. Personal utility, runs on `node server.js`.

## Stack
Plain Node.js + Express 4, Multer for uploads, fluent-ffmpeg + ffmpeg-static for audio extraction from video, AssemblyAI v4 SDK for transcription, fs-extra for file ops, CORS enabled. No framework, no TS. Static HTML/CSS/JS frontend served from `public/`. Run `npm start` (prod) or `npm run dev` (nodemon).

## Key files
| Path | Purpose |
|------|---------|
| `server.js` | Express server — upload, ffmpeg extract, AssemblyAI submit, return transcript |
| `package.json` | Deps (express, multer, assemblyai, ffmpeg-static, fluent-ffmpeg) |
| `public/` | Static frontend (upload UI) |
| `uploads/` | Temp file storage during transcribe |
| `setup.sh` / `setup.bat` | One-shot env bootstrap (install + start) |
| `README.md` | User-facing setup docs |

## Status
**The shipping product is now the Tauri desktop app** (`src-tauri/`, branded Whisperline), not the Express server. The Rust core handles uploads → AssemblyAI → transcript directly; the `public/` frontend talks to it via `window.__TAURI__` invoke(). Monetisation: free for media ≤ 5:00, Ed25519 Pro licence unlocks any length, BYO AssemblyAI key. Cross-platform builds ship via `.github/workflows/release.yml` (tag push → draft release). See `TAURI_PORT.md` for the full state.

`server.js` + the Express stack are **legacy** — kept for the old `npm start` localhost workflow but superseded by the desktop app. Don't add features there; build them in `src-tauri/` + `public/`.

## Inherited from Global
`~/CLAUDE.md` covers Playwright/npx/just-build/brand/tone/caveman. Don't restate.
