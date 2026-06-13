// Whisperline — Tauri entry point.
//
// The interesting work lives in lib.rs (commands + AssemblyAI client). This
// file is the slim binary entry that just hands off to the library. Splitting
// it this way keeps unit tests possible against the library and lets the iOS
// / Android targets (future) reuse the same code surface.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    whisperline_lib::run();
}
