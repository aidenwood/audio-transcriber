// AssemblyAI client — thin Rust port of the parts of the JS SDK we actually
// use: upload, create transcript, poll. Skips the streaming + LLM features
// we don't need yet.

use anyhow::{anyhow, Result};
use reqwest::Client;
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::time::Duration;
use tokio::fs::File;
use tokio::time::sleep;

const API_BASE: &str = "https://api.assemblyai.com/v2";

pub struct AssemblyAi {
    client: Client,
    api_key: String,
}

impl AssemblyAi {
    pub fn new(api_key: String) -> Self {
        Self {
            client: Client::builder()
                .timeout(Duration::from_secs(60 * 30))
                .build()
                .expect("failed to build reqwest client"),
            api_key,
        }
    }

    /// Stream a local file to AssemblyAI's /upload endpoint. Returns the
    /// remote upload_url that subsequent transcript creation references.
    pub async fn upload_file(&self, path: &Path) -> Result<String> {
        let file = File::open(path).await?;
        let len = file.metadata().await?.len();
        let stream = tokio_util::io::ReaderStream::new(file);
        let body = reqwest::Body::wrap_stream(stream);

        let resp = self
            .client
            .post(format!("{}/upload", API_BASE))
            .header("authorization", &self.api_key)
            .header("content-length", len.to_string())
            .body(body)
            .send()
            .await?;

        if !resp.status().is_success() {
            return Err(anyhow!(
                "upload failed: {} — {}",
                resp.status(),
                resp.text().await.unwrap_or_default()
            ));
        }
        let body: UploadResponse = resp.json().await?;
        Ok(body.upload_url)
    }

    /// Tell AssemblyAI to start transcribing the given upload URL.
    pub async fn create_transcript(&self, upload_url: &str, diarise: bool) -> Result<String> {
        let body = CreateTranscriptRequest {
            audio_url: upload_url.to_string(),
            speaker_labels: diarise,
        };
        let resp = self
            .client
            .post(format!("{}/transcript", API_BASE))
            .header("authorization", &self.api_key)
            .json(&body)
            .send()
            .await?;
        if !resp.status().is_success() {
            return Err(anyhow!(
                "create_transcript failed: {} — {}",
                resp.status(),
                resp.text().await.unwrap_or_default()
            ));
        }
        let body: TranscriptHandle = resp.json().await?;
        Ok(body.id)
    }

    /// Poll the transcript endpoint every 2 s until status is `completed`
    /// or `error`. Returns the final text on success.
    pub async fn poll_until_done(&self, transcript_id: &str) -> Result<String> {
        loop {
            let resp = self
                .client
                .get(format!("{}/transcript/{}", API_BASE, transcript_id))
                .header("authorization", &self.api_key)
                .send()
                .await?;
            let body: TranscriptStatus = resp.json().await?;
            match body.status.as_str() {
                "completed" => {
                    return Ok(body.text.unwrap_or_default());
                }
                "error" => {
                    return Err(anyhow!(body.error.unwrap_or_else(|| "unknown error".into())));
                }
                _ => {
                    sleep(Duration::from_secs(2)).await;
                }
            }
        }
    }
}

#[derive(Debug, Deserialize)]
struct UploadResponse {
    upload_url: String,
}

#[derive(Debug, Serialize)]
struct CreateTranscriptRequest {
    audio_url: String,
    speaker_labels: bool,
}

#[derive(Debug, Deserialize)]
struct TranscriptHandle {
    id: String,
}

#[derive(Debug, Deserialize)]
struct TranscriptStatus {
    status: String,
    text: Option<String>,
    error: Option<String>,
}
