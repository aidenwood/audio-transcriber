# Whisperline — Tauri port

The Express-based `server.js` is being replaced with a native Tauri desktop
app. This document tracks where the port currently sits and what's left.

## Status (updated 2026-06-13)

| Piece                              | State        |
|------------------------------------|--------------|
| Cargo.toml + tauri.conf.json       | **done**     |
| Rust commands (start/get/list)     | **done**     |
| AssemblyAI client (Rust, reqwest)  | **done**     |
| Capabilities (dialog, fs, shell)   | **done**     |
| Existing `public/` UI as webview   | **done**     |
| Frontend `invoke()` calls          | **done**     |
| Settings + licence drawer (UI)     | **done**     |
| Free-tier 5:00 gate (lofty probe)  | **done**     |
| Licence verification (Ed25519)     | **done**     |
| Bundle icons (32, 128, ico, icns)  | **done**     |
| macOS build verified locally       | **done** (.app + .dmg, aarch64) |
| CI cross-compile (mac/win/linux)   | **done** (`.github/workflows/release.yml`, draft release) |
| ffmpeg sidecar for video extract   | **not yet** (AssemblyAI ingests video audio directly for now) |
| Code signing + notarization        | **not yet** (builds ship unsigned — Gatekeeper/SmartScreen warning) |

## How it works now

- **Free tier:** files whose duration `lofty` can measure at ≤ 5:00 transcribe
  without a licence. Unknown-duration formats (MKV/AVI/some WebM) fail closed
  → "licence required" until the ffmpeg sidecar lands.
- **Pro:** a `WL1.<payload>.<sig>` Ed25519 licence (minted by the store's
  `get-licence` Netlify function after Stripe payment, verified fully offline
  against the embedded public key) unlocks unlimited length.
- **BYO key:** users paste their own AssemblyAI key in Settings → stored in
  `app_config_dir/settings.json`. Never embedded.

## Remaining next steps

1. Bundle `ffmpeg` as a Tauri sidecar so MKV/AVI/WebM get a local duration
   probe (and the free-tier gate stops failing closed on them).
2. Wire macOS notarization + Windows signing certs into the release workflow
   (secrets are stubbed in `.github/workflows/release.yml`).
3. (historical) Set up GitHub Actions: macOS (x64 + aarch64), Windows (x64), Linux
   (AppImage + .deb). Notarize the macOS build, sign the Windows .msi.

## Why Tauri (not Electron)

- Binary size: ~12MB vs Electron's ~150MB. Single dmg.
- Memory: shares the OS webview (WKWebView on macOS, WebView2 on Windows,
  WebKitGTK on Linux) instead of bundling Chromium.
- Rust backend: the AssemblyAI + ffmpeg orchestration is a much better fit
  for Rust's error handling than a long-running Node process.
- Plugin ecosystem covers everything we need (dialog, fs, shell, store).

## Why not native each-OS

Aiden ships solo. One codebase, one webview, one Rust core. No SwiftUI/WPF
parallel maintenance.
