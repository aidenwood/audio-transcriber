// Single error type shared across every Tauri command. Implements Serialize
// so Tauri can ship it back to the frontend as a structured JSON error.

use serde::{Serialize, Serializer};

#[derive(Debug, thiserror::Error)]
pub enum WlError {
    #[error("file not found: {0}")]
    FileNotFound(String),

    #[error("job not found: {0}")]
    JobNotFound(String),

    #[error("no AssemblyAI API key set — add one in Settings")]
    ApiKeyMissing,

    #[error("{0}")]
    LicenceRequired(String),

    #[error("licence error: {0}")]
    Licence(String),

    #[error("network error: {0}")]
    Network(#[from] reqwest::Error),

    #[error("io error: {0}")]
    Io(#[from] std::io::Error),

    #[error("internal error: {0}")]
    Internal(#[from] anyhow::Error),
}

impl Serialize for WlError {
    fn serialize<S>(&self, ser: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        ser.serialize_str(&self.to_string())
    }
}
