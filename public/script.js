/* Whisperline app shell — Tauri build.
 *
 * This talks to the Rust core in src-tauri via window.__TAURI__ (the config
 * sets withGlobalTauri: true). The old Express/fetch transport is gone:
 *
 *   POST /api/transcribe   → invoke('start_transcription', { args: { path, diarise } })
 *   GET  /api/jobs         → invoke('list_jobs')
 *   GET  /api/status/:id   → invoke('get_job', { id })
 *   DELETE /api/jobs/:id    → invoke('delete_job', { id })
 *
 * Plus the settings + licence surface:
 *   invoke('get_settings') / ('set_api_key', { key })
 *   invoke('licence_status') / ('activate_licence', { key }) / ('deactivate_licence')
 *
 * File selection no longer goes through <input type=file> + FormData — the
 * webview can't read arbitrary local paths. Instead the dialog plugin's
 * open() (click) and Tauri's native drag-drop events hand us absolute path
 * strings, which the Rust side reads directly.
 *
 * Design rules carried over from the Express build:
 *   - No alert()/confirm() — Tauri's webview locks on native dialogs.
 *     Non-blocking toasts + two-click inline confirm instead.
 *   - All server-or-user data is set via textContent / DOM construction,
 *     never innerHTML, so an odd filename can't inject markup. Button
 *     label save/restore clones childNodes rather than touching innerHTML.
 *   - Polling pauses while the window is hidden.
 */

(function () {
    'use strict';

    // ── Tauri bridge ───────────────────────────────────────────────────
    const TAURI = window.__TAURI__ || null;
    function hasTauri() { return !!(TAURI && TAURI.core && typeof TAURI.core.invoke === 'function'); }

    async function invoke(cmd, args) {
        if (!hasTauri()) throw new Error('Whisperline core unavailable — run inside the desktop app.');
        return TAURI.core.invoke(cmd, args);
    }

    // Tauri commands reject with the WlError string (it serializes to a
    // plain message). Normalise everything to a readable string.
    function errMsg(err) {
        if (err == null) return 'Unknown error';
        if (typeof err === 'string') return err;
        if (err.message) return err.message;
        try { return JSON.stringify(err); } catch (_) { return String(err); }
    }

    // ── DOM helpers ─────────────────────────────────────────────────────
    function el(tag, attrs, ...children) {
        const node = document.createElement(tag);
        if (attrs) {
            for (const [k, v] of Object.entries(attrs)) {
                if (v == null || v === false) continue;
                if (k === 'class')  { node.className = v; continue; }
                if (k === 'text')   { node.textContent = v; continue; }
                if (k === 'html')   { /* deliberately unsupported */ continue; }
                if (k.startsWith('on') && typeof v === 'function') {
                    node.addEventListener(k.slice(2), v);
                    continue;
                }
                if (k === 'dataset' && v && typeof v === 'object') {
                    for (const [dk, dv] of Object.entries(v)) node.dataset[dk] = dv;
                    continue;
                }
                node.setAttribute(k, v);
            }
        }
        for (const c of children) {
            if (c == null || c === false) continue;
            node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
        }
        return node;
    }

    // Snapshot/restore a node's children without ever touching innerHTML.
    function snapshotChildren(node) {
        return Array.from(node.childNodes).map((n) => n.cloneNode(true));
    }
    function restoreChildren(node, snapshot) {
        node.replaceChildren(...snapshot.map((n) => n.cloneNode(true)));
    }

    // ── Toast ───────────────────────────────────────────────────────────
    function ensureToastHost() {
        let host = document.getElementById('toast');
        if (host) return host;
        host = el('div', { id: 'toast', role: 'status', 'aria-live': 'polite' });
        document.body.appendChild(host);
        return host;
    }
    function toast(message, kind = 'info', ttlMs = 4000) {
        const host = ensureToastHost();
        const item = el('div', { class: `toast-item toast-${kind}`, text: message });
        host.appendChild(item);
        requestAnimationFrame(() => item.classList.add('show'));
        setTimeout(() => {
            item.classList.remove('show');
            setTimeout(() => item.remove(), 240);
        }, ttlMs);
    }

    // ── Small utils ──────────────────────────────────────────────────────
    function basename(p) {
        if (!p) return 'Untitled';
        const parts = String(p).split(/[\\/]/);
        return parts[parts.length - 1] || String(p);
    }

    function fileIconClass(name) {
        const ext = (name.split('.').pop() || '').toLowerCase();
        if (['mp4', 'mov', 'avi', 'mkv', 'webm', 'm4v'].includes(ext)) return 'fas fa-film';
        if (['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg'].includes(ext)) return 'fas fa-music';
        return 'fas fa-file-audio';
    }

    // Rust JobStatus serialises lowercase: queued | uploading | processing
    // | completed | failed. Map each to a badge data-status + label.
    const STATUS_MAP = {
        queued:     { data: 'pending',    label: 'Queued' },
        uploading:  { data: 'processing', label: 'Uploading' },
        processing: { data: 'processing', label: 'Transcribing' },
        completed:  { data: 'completed',  label: 'Completed' },
        failed:     { data: 'failed',     label: 'Failed' },
    };

    // job.created_at is unix seconds (Rust now_unix()).
    function relativeTime(unixSecs) {
        const ts = Number(unixSecs);
        if (!Number.isFinite(ts) || ts <= 0) return '';
        const sec = Math.floor(Date.now() / 1000 - ts);
        if (sec < 5)   return 'just now';
        if (sec < 60)  return `${sec}s ago`;
        const min = Math.floor(sec / 60);
        if (min < 60)  return `${min}m ago`;
        const hr = Math.floor(min / 60);
        if (hr < 24)   return `${hr}h ago`;
        return `${Math.floor(hr / 24)}d ago`;
    }

    const ACCEPT_EXTS = ['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'mp4', 'mov', 'avi', 'mkv', 'webm', 'm4v'];

    class Whisperline {
        constructor() {
            this.selectedPaths = [];
            this.currentTranscript = null;
            this.pollHandle = null;
            this.licensed = false;
            this.hasApiKey = false;

            this.initEventListeners();
            this.initTauriDragDrop();

            if (!hasTauri()) {
                toast('Whisperline core not detected — open this from the desktop app.', 'error', 8000);
            }

            this.refreshStatus();
            this.loadJobs();
            this.startPolling();
        }

        initEventListeners() {
            const uploadArea = document.getElementById('uploadArea');
            const uploadBtn  = document.getElementById('uploadBtn');
            const fileInput  = document.getElementById('fileInput');
            if (!uploadArea || !uploadBtn) {
                console.error('[whisperline] required DOM missing');
                return;
            }

            // The old hidden <input type=file> can't surface a usable path in
            // a Tauri webview — neutralise it and route clicks to the native
            // dialog instead.
            if (fileInput) fileInput.disabled = true;
            uploadArea.addEventListener('click', (e) => {
                if (e.target.closest('button, a')) return;
                this.pickFiles();
            });

            uploadBtn.addEventListener('click', () => this.startTranscription());

            // Transcript modal (view + export — read-only, modal is fine here).
            const modal = document.getElementById('transcriptModal');
            document.querySelectorAll('#transcriptModal .close, #transcriptModal .modal-close')
                .forEach((b) => b.addEventListener('click', () => this.closeModal()));
            if (modal) modal.addEventListener('click', (e) => { if (e.target === modal) this.closeModal(); });
            document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { this.closeModal(); this.closeDrawer(); } });

            const copyBtn     = document.getElementById('copyBtn');
            const downloadBtn = document.getElementById('downloadBtn');
            if (copyBtn)     copyBtn.addEventListener('click',     () => this.copyToClipboard());
            if (downloadBtn) downloadBtn.addEventListener('click', () => this.downloadTranscript());

            // Settings drawer.
            const settingsBtn   = document.getElementById('settingsBtn');
            const licencePill   = document.getElementById('licencePill');
            const settingsClose = document.getElementById('settingsClose');
            const scrim         = document.getElementById('settingsScrim');
            if (settingsBtn)   settingsBtn.addEventListener('click', () => this.openDrawer());
            if (licencePill)   licencePill.addEventListener('click', () => this.openDrawer());
            if (settingsClose) settingsClose.addEventListener('click', () => this.closeDrawer());
            if (scrim)         scrim.addEventListener('click', () => this.closeDrawer());

            const apiKeySave        = document.getElementById('apiKeySave');
            const licenceActivate   = document.getElementById('licenceActivate');
            const licenceDeactivate = document.getElementById('licenceDeactivate');
            if (apiKeySave)        apiKeySave.addEventListener('click', () => this.saveApiKey());
            if (licenceActivate)   licenceActivate.addEventListener('click', () => this.activateLicence());
            if (licenceDeactivate) licenceDeactivate.addEventListener('click', () => this.deactivateLicence());
        }

        // ── File selection ─────────────────────────────────────────────
        async pickFiles() {
            if (!TAURI || !TAURI.dialog || typeof TAURI.dialog.open !== 'function') {
                toast('File picker needs the desktop app.', 'error');
                return;
            }
            try {
                const selected = await TAURI.dialog.open({
                    multiple: true,
                    directory: false,
                    filters: [{ name: 'Audio & video', extensions: ACCEPT_EXTS }],
                });
                if (selected == null) return; // cancelled
                const paths = Array.isArray(selected) ? selected : [selected];
                this.setSelectedPaths(paths);
            } catch (err) {
                console.error('[whisperline] dialog failed', err);
                toast(`Couldn't open the file picker: ${errMsg(err)}`, 'error');
            }
        }

        // Native OS drag-drop. Tauri intercepts file drops before the HTML
        // drop event, so we listen to its events to get absolute paths +
        // drive the dragover styling. Handles both v2 ('tauri://drag-*') and
        // legacy ('tauri://file-drop*') event names.
        async initTauriDragDrop() {
            if (!TAURI || !TAURI.event || typeof TAURI.event.listen !== 'function') return;
            const uploadArea = document.getElementById('uploadArea');
            const setHover = (on) => { if (uploadArea) uploadArea.classList.toggle('dragover', on); };

            const onDrop = (event) => {
                setHover(false);
                const p = event && event.payload;
                const paths = Array.isArray(p) ? p : (p && p.paths) || [];
                if (paths.length) this.setSelectedPaths(paths);
            };

            try {
                await TAURI.event.listen('tauri://drag-enter', () => setHover(true));
                await TAURI.event.listen('tauri://drag-over',  () => setHover(true));
                await TAURI.event.listen('tauri://drag-leave', () => setHover(false));
                await TAURI.event.listen('tauri://drag-drop',  onDrop);
                // Legacy aliases (older Tauri 2 betas).
                await TAURI.event.listen('tauri://file-drop-hover',     () => setHover(true));
                await TAURI.event.listen('tauri://file-drop-cancelled', () => setHover(false));
                await TAURI.event.listen('tauri://file-drop',           onDrop);
            } catch (err) {
                console.error('[whisperline] drag-drop wiring failed', err);
            }
        }

        setSelectedPaths(paths) {
            // Filter to supported extensions; warn on the rest.
            const ok = [], skipped = [];
            for (const p of paths) {
                const ext = (basename(p).split('.').pop() || '').toLowerCase();
                (ACCEPT_EXTS.includes(ext) ? ok : skipped).push(p);
            }
            if (skipped.length) toast(`Skipped ${skipped.length} unsupported file(s).`, 'info');
            this.selectedPaths = ok;
            this.renderFileInfo();
            const uploadBtn = document.getElementById('uploadBtn');
            if (uploadBtn) uploadBtn.style.display = ok.length > 0 ? 'inline-flex' : 'none';
            this.updateWorkingState({ hasFiles: ok.length > 0 });
        }

        updateWorkingState({ hasFiles, hasJobs } = {}) {
            const main = document.querySelector('.app-main');
            if (!main) return;
            if (typeof hasFiles === 'boolean') this._stateFiles = hasFiles;
            if (typeof hasJobs  === 'boolean') this._stateJobs  = hasJobs;
            main.classList.toggle('is-working', !!(this._stateFiles || this._stateJobs));
        }

        renderFileInfo() {
            const fileInfo = document.getElementById('fileInfo');
            if (!fileInfo) return;
            if (this.selectedPaths.length === 0) {
                fileInfo.style.display = 'none';
                fileInfo.replaceChildren();
                return;
            }
            fileInfo.style.display = 'block';
            const rows = this.selectedPaths.map((p) => {
                const name = basename(p);
                return el('div', { class: 'file-row' },
                    el('i', { class: fileIconClass(name), 'aria-hidden': 'true' }),
                    el('span', { class: 'file-name', text: name }),
                    el('span', { class: 'file-size', text: '' }),
                );
            });
            fileInfo.replaceChildren(...rows);
        }

        // ── Start transcription ─────────────────────────────────────────
        async startTranscription() {
            if (this.selectedPaths.length === 0) return;
            const uploadBtn = document.getElementById('uploadBtn');
            const originalLabel = snapshotChildren(uploadBtn);
            uploadBtn.disabled = true;
            uploadBtn.replaceChildren(
                el('i', { class: 'fas fa-spinner fa-spin', 'aria-hidden': 'true' }),
                document.createTextNode(' Starting…'),
            );

            let started = 0;
            let needsSetup = false;
            for (const path of this.selectedPaths) {
                try {
                    // The Rust command parameter is named `args` (a
                    // StartTranscriptionArgs struct), so Tauri expects the
                    // payload nested under that key — not flattened.
                    await invoke('start_transcription', { args: { path, diarise: true } });
                    started += 1;
                } catch (err) {
                    const msg = errMsg(err);
                    console.error('[whisperline] start failed', msg);
                    if (/API key|licence|Settings/i.test(msg)) needsSetup = true;
                    toast(msg, 'error', 7000);
                }
            }

            if (started) toast(`${started} file(s) queued for transcription`, 'success');
            if (needsSetup) this.pulseSettings();

            uploadBtn.disabled = false;
            restoreChildren(uploadBtn, originalLabel);
            uploadBtn.style.display = 'none';
            this.selectedPaths = [];
            const fileInfo = document.getElementById('fileInfo');
            if (fileInfo) fileInfo.style.display = 'none';
            this.loadJobs();
        }

        // ── Jobs ────────────────────────────────────────────────────────
        async loadJobs() {
            if (!hasTauri()) return;
            try {
                const jobs = await invoke('list_jobs');
                this.renderJobs(jobs);
            } catch (err) {
                console.error('[whisperline] loadJobs failed', errMsg(err));
            }
        }

        renderJobs(jobs) {
            const list = document.getElementById('jobsList');
            if (!list) return;
            const hasJobs = Array.isArray(jobs) && jobs.length > 0;
            this.updateWorkingState({ hasJobs });
            if (!hasJobs) {
                list.replaceChildren(
                    el('div', { class: 'no-jobs' },
                        el('span', { class: 'no-jobs-icon', 'aria-hidden': 'true' }, el('i', { class: 'fas fa-inbox' })),
                        el('p', { class: 'no-jobs-text', text: 'No jobs yet. Drop a file above to start.' }),
                    ),
                );
                return;
            }
            jobs.sort((a, b) => Number(b.created_at) - Number(a.created_at));
            list.replaceChildren(...jobs.map((j) => this.createJobElement(j)));
        }

        createJobElement(job) {
            const status   = STATUS_MAP[job.status] || { data: 'pending', label: String(job.status || 'pending') };
            const inFlight = job.status !== 'completed' && job.status !== 'failed';

            const row = el('div', { class: 'job-item', dataset: { jobId: String(job.id) } });
            row.appendChild(el('p', { class: 'job-title', text: job.source_name || basename(job.source_path) || 'Untitled' }));
            row.appendChild(el('span', { class: 'job-status', dataset: { status: status.data }, text: status.label }));
            row.appendChild(el('p', { class: 'job-meta', text: relativeTime(job.created_at) }));

            const actions = el('div', { class: 'job-actions' });
            if (job.status === 'completed') {
                actions.appendChild(
                    el('button', { type: 'button', onclick: () => this.viewTranscript(job.id, job.source_name) },
                        el('i', { class: 'fas fa-eye', 'aria-hidden': 'true' }), document.createTextNode(' View')),
                );
            }
            const delBtn = el('button', { type: 'button', 'data-action': 'delete' },
                el('i', { class: 'fas fa-trash', 'aria-hidden': 'true' }), document.createTextNode(' Delete'));
            delBtn.addEventListener('click', () => this.deleteJob(job.id, delBtn));
            actions.appendChild(delBtn);
            row.appendChild(actions);

            // No percentage from the backend — show an indeterminate shimmer
            // while in flight so the user knows work is happening.
            if (inFlight) {
                row.appendChild(
                    el('div', { class: 'progress-track progress-track--indeterminate', 'aria-hidden': 'true' },
                        el('div', { class: 'progress-fill' })),
                );
            }

            if (job.error) {
                row.appendChild(
                    el('p', { class: 'job-error' },
                        el('i', { class: 'fas fa-triangle-exclamation', 'aria-hidden': 'true' }),
                        document.createTextNode(' '), document.createTextNode(String(job.error))),
                );
            }
            return row;
        }

        async viewTranscript(jobId, fileName) {
            try {
                const job = await invoke('get_job', { id: jobId });
                if (!job || !job.transcript) { toast('Transcript not ready yet', 'info'); return; }
                document.getElementById('modalTitle').textContent = `Transcript — ${fileName || basename(job.source_path)}`;
                document.getElementById('modalTranscript').textContent = job.transcript;
                this.currentTranscript = { text: job.transcript, fileName: fileName || basename(job.source_path) };
                const modal = document.getElementById('transcriptModal');
                if (modal) modal.classList.add('show');
            } catch (err) {
                console.error('[whisperline] viewTranscript failed', errMsg(err));
                toast('Could not load transcript', 'error');
            }
        }

        closeModal() {
            const modal = document.getElementById('transcriptModal');
            if (modal) modal.classList.remove('show');
        }

        // Two-click confirm — no window.confirm() (Tauri-lockup risk).
        async deleteJob(jobId, btn) {
            if (!btn) return;
            if (btn.dataset.armed !== 'true') {
                btn.dataset.armed = 'true';
                btn._label = snapshotChildren(btn);
                btn.replaceChildren(
                    el('i', { class: 'fas fa-triangle-exclamation', 'aria-hidden': 'true' }),
                    document.createTextNode(' Click again'),
                );
                btn.classList.add('is-armed');
                btn._armedTimer = setTimeout(() => {
                    btn.dataset.armed = 'false';
                    if (btn._label) restoreChildren(btn, btn._label);
                    btn.classList.remove('is-armed');
                }, 4000);
                return;
            }
            clearTimeout(btn._armedTimer);
            btn.disabled = true;
            try {
                await invoke('delete_job', { id: jobId });
                toast('Job deleted', 'success');
                this.loadJobs();
            } catch (err) {
                console.error('[whisperline] delete failed', errMsg(err));
                toast('Could not delete job', 'error');
                btn.disabled = false;
                btn.dataset.armed = 'false';
                if (btn._label) restoreChildren(btn, btn._label);
            }
        }

        async copyToClipboard() {
            if (!this.currentTranscript || !this.currentTranscript.text) return;
            try {
                await navigator.clipboard.writeText(this.currentTranscript.text);
                const copyBtn = document.getElementById('copyBtn');
                const original = snapshotChildren(copyBtn);
                copyBtn.replaceChildren(el('i', { class: 'fas fa-check', 'aria-hidden': 'true' }), document.createTextNode(' Copied'));
                setTimeout(() => { restoreChildren(copyBtn, original); }, 1800);
            } catch (err) {
                console.error('[whisperline] copy failed', errMsg(err));
                toast('Clipboard access denied', 'error');
            }
        }

        downloadTranscript() {
            if (!this.currentTranscript || !this.currentTranscript.text) return;
            const safeName = String(this.currentTranscript.fileName || 'transcript').replace(/[^a-z0-9_\-.]+/gi, '_');
            const blob = new Blob([this.currentTranscript.text], { type: 'text/plain' });
            const url = URL.createObjectURL(blob);
            const a = el('a', { href: url, download: `${safeName}_transcript.txt` });
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
            toast('Transcript saved', 'success');
        }

        // ── Settings + licence ───────────────────────────────────────────
        openDrawer() {
            const drawer = document.getElementById('settingsDrawer');
            const scrim  = document.getElementById('settingsScrim');
            if (!drawer) return;
            this.refreshStatus();
            drawer.classList.add('open');
            drawer.setAttribute('aria-hidden', 'false');
            if (scrim) { scrim.hidden = false; requestAnimationFrame(() => scrim.classList.add('show')); }
        }
        closeDrawer() {
            const drawer = document.getElementById('settingsDrawer');
            const scrim  = document.getElementById('settingsScrim');
            if (!drawer || !drawer.classList.contains('open')) return;
            drawer.classList.remove('open');
            drawer.setAttribute('aria-hidden', 'true');
            if (scrim) { scrim.classList.remove('show'); setTimeout(() => { scrim.hidden = true; }, 240); }
        }
        pulseSettings() {
            const btn = document.getElementById('settingsBtn');
            if (!btn) return;
            btn.classList.add('pulse');
            setTimeout(() => btn.classList.remove('pulse'), 2400);
        }

        async refreshStatus() {
            if (!hasTauri()) return;
            try {
                const settings = await invoke('get_settings');
                this.hasApiKey = !!(settings && settings.has_api_key);
                const apiStatus = document.getElementById('apiKeyStatus');
                if (apiStatus) {
                    apiStatus.hidden = false;
                    if (this.hasApiKey) {
                        apiStatus.textContent = settings.api_key_hint
                            ? `Key saved — ending in …${settings.api_key_hint}`
                            : 'Key saved.';
                        apiStatus.classList.add('drawer-status--ok');
                    } else {
                        apiStatus.textContent = 'No key yet — transcription needs one.';
                        apiStatus.classList.remove('drawer-status--ok');
                    }
                }
            } catch (err) {
                console.error('[whisperline] get_settings failed', errMsg(err));
            }

            try {
                const lic = await invoke('licence_status');
                this.applyLicenceStatus(lic);
            } catch (err) {
                console.error('[whisperline] licence_status failed', errMsg(err));
            }

            // Connection label reflects whether the app is ready to transcribe.
            const conn = document.getElementById('connectionStatus');
            if (conn) conn.textContent = this.hasApiKey ? 'Local · ready' : 'Local · add API key';
        }

        applyLicenceStatus(lic) {
            this.licensed = !!(lic && lic.licensed);
            const pill      = document.getElementById('licencePill');
            const pillLabel = document.getElementById('licencePillLabel');
            const freeBox   = document.getElementById('licenceFree');
            const proBox    = document.getElementById('licencePro');
            const email     = document.getElementById('licenceEmail');

            if (pill)      pill.dataset.tier = this.licensed ? 'pro' : 'free';
            if (pillLabel) pillLabel.textContent = this.licensed ? 'Pro' : 'Free tier';
            if (freeBox)   freeBox.hidden = this.licensed;
            if (proBox)    proBox.hidden  = !this.licensed;
            if (email && lic && lic.email) email.textContent = lic.email;
        }

        async saveApiKey() {
            const input = document.getElementById('apiKeyInput');
            if (!input) return;
            const key = input.value.trim();
            if (!key) { toast('Paste a key first.', 'info'); return; }
            try {
                await invoke('set_api_key', { key });
                input.value = '';
                toast('API key saved.', 'success');
                this.refreshStatus();
            } catch (err) {
                toast(`Couldn't save key: ${errMsg(err)}`, 'error');
            }
        }

        async activateLicence() {
            const input = document.getElementById('licenceInput');
            if (!input) return;
            const key = input.value.trim();
            if (!key) { toast('Paste your licence key first.', 'info'); return; }
            try {
                const lic = await invoke('activate_licence', { key });
                input.value = '';
                this.applyLicenceStatus(lic);
                toast('Pro licence activated — unlimited length unlocked.', 'success', 6000);
            } catch (err) {
                toast(`Activation failed: ${errMsg(err)}`, 'error', 7000);
            }
        }

        async deactivateLicence() {
            try {
                const lic = await invoke('deactivate_licence');
                this.applyLicenceStatus(lic);
                toast('Licence removed from this machine.', 'info');
            } catch (err) {
                toast(`Couldn't remove licence: ${errMsg(err)}`, 'error');
            }
        }

        startPolling() {
            const tick = () => this.loadJobs();
            this.pollHandle = setInterval(() => { if (!document.hidden) tick(); }, 3000);
            document.addEventListener('visibilitychange', () => { if (!document.hidden) tick(); });
        }
    }

    document.addEventListener('DOMContentLoaded', () => {
        window.whisperline = new Whisperline();
    });
})();
