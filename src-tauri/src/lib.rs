// Whisperline core — Tauri commands exposed to the webview frontend.
//
// The Express server.js this replaces did three things:
//   1. Accept file uploads via multer to ./uploads
//   2. Optionally extract audio from video via ffmpeg
//   3. Send the file to AssemblyAI, poll the job, return the transcript
//
// In Tauri we don't need the "upload" step at all — the frontend hands us a
// local file path via the dialog plugin, and we read the bytes directly.
// Video goes straight to AssemblyAI, which ingests the audio track itself
// (an ffmpeg sidecar for local extraction remains a follow-up). The
// transcription pass talks to AssemblyAI over HTTPS via reqwest.
//
// Monetisation model (v1):
//   - BYO AssemblyAI key, stored locally in settings.json — never embedded.
//   - Free mode: files up to 5 minutes transcribe without a licence.
//   - A WL1 Ed25519 licence (verified fully offline, see licence.rs)
//     unlocks unlimited length.

mod assemblyai;
mod errors;
mod licence;
mod media;

use crate::assemblyai::AssemblyAi;
use crate::errors::WlError;
use crate::licence::{LicenceStatus, FREE_LIMIT_SECS};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Arc;
use tauri::Manager;
use tokio::sync::Mutex;

/// In-memory record of every transcription the user has kicked off this
/// session. Mirrors the `transcriptionJobs` Map in the old server.js.
#[derive(Debug, Clone, Serialize)]
pub struct Job {
    pub id: String,
    pub source_path: String,
    pub source_name: String,
    pub status: JobStatus,
    pub created_at: i64,
    pub transcript: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum JobStatus {
    Queued,
    Uploading,
    Processing,
    Completed,
    Failed,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct Settings {
    #[serde(default)]
    assemblyai_api_key: String,
}

pub struct AppState {
    pub jobs: Mutex<Vec<Job>>,
    pub api_key: Mutex<String>,
    pub config_dir: PathBuf,
}

impl AppState {
    fn settings_path(&self) -> PathBuf {
        self.config_dir.join("settings.json")
    }

    fn load_settings(&self) -> Settings {
        std::fs::read_to_string(self.settings_path())
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default()
    }

    fn save_settings(&self, settings: &Settings) -> std::io::Result<()> {
        std::fs::create_dir_all(&self.config_dir)?;
        std::fs::write(
            self.settings_path(),
            serde_json::to_string_pretty(settings).expect("settings serialise"),
        )
    }
}

#[derive(Debug, Deserialize)]
pub struct StartTranscriptionArgs {
    /// Absolute path to a local audio or video file.
    pub path: String,
    /// Whether to ask AssemblyAI for speaker diarisation. Default true.
    #[serde(default = "default_true")]
    pub diarise: bool,
}

fn default_true() -> bool {
    true
}

// ─── Tauri commands ──────────────────────────────────────────────────────
//
// Each #[tauri::command] is callable from the webview as
//   await window.__TAURI__.core.invoke('command_name', { ...args })

/// Kick off a new transcription job. Returns the job ID immediately; the
/// caller polls `get_job` for status. Mirrors the legacy POST /upload route.
#[tauri::command]
async fn start_transcription(
    state: tauri::State<'_, Arc<AppState>>,
    args: StartTranscriptionArgs,
) -> Result<String, WlError> {
    let path = PathBuf::from(&args.path);
    if !path.exists() {
        return Err(WlError::FileNotFound(args.path.clone()));
    }

    let api_key = state.api_key.lock().await.clone();
    if api_key.is_empty() {
        return Err(WlError::ApiKeyMissing);
    }

    // Free-mode gate: without a licence, only media we can locally measure
    // at ≤ 5 minutes goes through. Unknown duration fails closed.
    if licence::load(&state.config_dir).is_none() {
        match media::probe_duration(&path) {
            Some(d) if d.as_secs() <= FREE_LIMIT_SECS => {}
            Some(d) => {
                return Err(WlError::LicenceRequired(format!(
                    "this file runs {}:{:02} — free mode covers up to 5:00. \
                     Add a licence key in Settings to unlock unlimited length.",
                    d.as_secs() / 60,
                    d.as_secs() % 60
                )))
            }
            None => {
                return Err(WlError::LicenceRequired(
                    "couldn't measure this file's duration locally, so it can't \
                     use free mode (under 5:00). Add a licence key in Settings \
                     to transcribe it."
                        .into(),
                ))
            }
        }
    }

    let id = uuid::Uuid::new_v4().to_string();
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| args.path.clone());

    let job = Job {
        id: id.clone(),
        source_path: args.path.clone(),
        source_name: name,
        status: JobStatus::Queued,
        created_at: now_unix(),
        transcript: None,
        error: None,
    };
    state.jobs.lock().await.push(job);

    // Spawn the actual upload + poll work off the command thread so the
    // command returns instantly — the frontend re-polls `get_job` to track
    // progress.
    let state = state.inner().clone();
    let id_clone = id.clone();
    tokio::spawn(async move {
        if let Err(e) = run_job(state.clone(), id_clone.clone(), path, args.diarise, api_key).await
        {
            let mut jobs = state.jobs.lock().await;
            if let Some(j) = jobs.iter_mut().find(|j| j.id == id_clone) {
                j.status = JobStatus::Failed;
                j.error = Some(format!("{}", e));
            }
        }
    });

    Ok(id)
}

async fn run_job(
    state: Arc<AppState>,
    id: String,
    path: PathBuf,
    diarise: bool,
    api_key: String,
) -> anyhow::Result<()> {
    let ai = AssemblyAi::new(api_key);
    {
        let mut jobs = state.jobs.lock().await;
        if let Some(j) = jobs.iter_mut().find(|j| j.id == id) {
            j.status = JobStatus::Uploading;
        }
    }
    let upload_url = ai.upload_file(&path).await?;

    {
        let mut jobs = state.jobs.lock().await;
        if let Some(j) = jobs.iter_mut().find(|j| j.id == id) {
            j.status = JobStatus::Processing;
        }
    }
    let transcript_id = ai.create_transcript(&upload_url, diarise).await?;
    let transcript = ai.poll_until_done(&transcript_id).await?;

    let mut jobs = state.jobs.lock().await;
    if let Some(j) = jobs.iter_mut().find(|j| j.id == id) {
        j.status = JobStatus::Completed;
        j.transcript = Some(transcript);
    }
    Ok(())
}

/// Get the current status + transcript (if ready) for a job.
#[tauri::command]
async fn get_job(state: tauri::State<'_, Arc<AppState>>, id: String) -> Result<Job, WlError> {
    let jobs = state.jobs.lock().await;
    jobs.iter()
        .find(|j| j.id == id)
        .cloned()
        .ok_or(WlError::JobNotFound(id))
}

/// List every job the user has kicked off this session.
#[tauri::command]
async fn list_jobs(state: tauri::State<'_, Arc<AppState>>) -> Result<Vec<Job>, WlError> {
    Ok(state.jobs.lock().await.clone())
}

/// Drop a job from the session list. In-flight work isn't cancelled (the
/// AssemblyAI job simply completes into the void) — same semantics as the
/// legacy DELETE /api/jobs/:id.
#[tauri::command]
async fn delete_job(state: tauri::State<'_, Arc<AppState>>, id: String) -> Result<(), WlError> {
    let mut jobs = state.jobs.lock().await;
    let before = jobs.len();
    jobs.retain(|j| j.id != id);
    if jobs.len() == before {
        return Err(WlError::JobNotFound(id));
    }
    Ok(())
}

// ─── Settings + licence commands ─────────────────────────────────────────

#[derive(Debug, Serialize)]
struct SettingsStatus {
    has_api_key: bool,
    /// Last 4 chars only, for "key ending in …abcd" display.
    api_key_hint: Option<String>,
}

#[tauri::command]
async fn get_settings(state: tauri::State<'_, Arc<AppState>>) -> Result<SettingsStatus, WlError> {
    let key = state.api_key.lock().await;
    Ok(SettingsStatus {
        has_api_key: !key.is_empty(),
        api_key_hint: (key.len() >= 4).then(|| key[key.len() - 4..].to_string()),
    })
}

#[tauri::command]
async fn set_api_key(state: tauri::State<'_, Arc<AppState>>, key: String) -> Result<(), WlError> {
    let key = key.trim().to_string();
    state.save_settings(&Settings {
        assemblyai_api_key: key.clone(),
    })?;
    *state.api_key.lock().await = key;
    Ok(())
}

#[tauri::command]
async fn licence_status(state: tauri::State<'_, Arc<AppState>>) -> Result<LicenceStatus, WlError> {
    let payload = licence::load(&state.config_dir);
    Ok(LicenceStatus {
        licensed: payload.is_some(),
        email: payload.map(|p| p.email),
        free_limit_secs: FREE_LIMIT_SECS,
    })
}

#[tauri::command]
async fn activate_licence(
    state: tauri::State<'_, Arc<AppState>>,
    key: String,
) -> Result<LicenceStatus, WlError> {
    let payload = licence::verify(&key).map_err(WlError::Licence)?;
    licence::save(&state.config_dir, &key)?;
    Ok(LicenceStatus {
        licensed: true,
        email: Some(payload.email),
        free_limit_secs: FREE_LIMIT_SECS,
    })
}

#[tauri::command]
async fn deactivate_licence(
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<LicenceStatus, WlError> {
    licence::remove(&state.config_dir)?;
    Ok(LicenceStatus {
        licensed: false,
        email: None,
        free_limit_secs: FREE_LIMIT_SECS,
    })
}

fn now_unix() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![
            start_transcription,
            get_job,
            list_jobs,
            delete_job,
            get_settings,
            set_api_key,
            licence_status,
            activate_licence,
            deactivate_licence,
        ])
        .setup(|app| {
            // State needs the config dir, which needs the app handle — so
            // it's managed here in setup (which runs before the webview can
            // invoke any command).
            let config_dir = app
                .path()
                .app_config_dir()
                .expect("no app config dir on this platform");

            let state = Arc::new(AppState {
                jobs: Mutex::new(Vec::new()),
                api_key: Mutex::new(String::new()),
                config_dir,
            });

            // AssemblyAI key priority: env var (developer override) beats
            // the locally stored settings.json (normal BYO-key users).
            let stored = state.load_settings().assemblyai_api_key;
            let initial_key = std::env::var("ASSEMBLYAI_API_KEY").unwrap_or(stored);
            if initial_key.is_empty() {
                eprintln!("ℹ no AssemblyAI key yet — user sets one in Settings.");
            }
            *state.api_key.blocking_lock() = initial_key;

            app.manage(state);

            use tauri::{
                image::Image,
                menu::{Menu, MenuItem, PredefinedMenuItem},
                tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
            };

            // Menu items: Show window, Hide window, separator, Quit.
            // Built with explicit IDs so the menu-event handler below can
            // route each click without string-matching on labels.
            let show = MenuItem::with_id(app, "show", "Show Whisperline", true, None::<&str>)?;
            let hide = MenuItem::with_id(app, "hide", "Hide window", true, None::<&str>)?;
            let sep = PredefinedMenuItem::separator(app)?;
            let quit = MenuItem::with_id(app, "quit", "Quit", true, Some("Cmd+Q"))?;
            let menu = Menu::with_items(app, &[&show, &hide, &sep, &quit])?;

            // Tray icon — monochrome silhouette mic so macOS treats it
            // as a template image and inverts for the menu bar's mode.
            // Tauri 2.11's Image::new_owned wants raw RGBA bytes, so we
            // decode the bundled PNG with the `image` crate first.
            let tray_bytes = include_bytes!("../icons/tray-icon.png");
            let decoded = ::image::load_from_memory(tray_bytes)
                .map_err(|e| Box::<dyn std::error::Error>::from(e.to_string()))?
                .to_rgba8();
            let (tw, th) = decoded.dimensions();
            let tray_image = Image::new_owned(decoded.into_raw(), tw, th);

            TrayIconBuilder::with_id("whisperline-tray")
                .tooltip("Whisperline — local-first transcription")
                .icon(tray_image)
                .icon_as_template(true)
                .menu(&menu)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => {
                        if let Some(win) = app.get_webview_window("main") {
                            let _ = win.show();
                            let _ = win.set_focus();
                            let _ = win.unminimize();
                        }
                    }
                    "hide" => {
                        if let Some(win) = app.get_webview_window("main") {
                            let _ = win.hide();
                        }
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                // Left-click anywhere on the tray icon toggles the window.
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        let app = tray.app_handle();
                        if let Some(win) = app.get_webview_window("main") {
                            if win.is_visible().unwrap_or(false) {
                                let _ = win.hide();
                            } else {
                                let _ = win.show();
                                let _ = win.set_focus();
                                let _ = win.unminimize();
                            }
                        }
                    }
                })
                .build(app)?;

            Ok(())
        })
        .on_window_event(|win, event| {
            // Close button → hide the window instead of quitting. The user
            // can still quit from the tray menu (or Cmd+Q from the app
            // menu). Matches macOS "menu bar app" conventions.
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let _ = win.hide();
                api.prevent_close();
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running Whisperline");
}
