// Offline Ed25519 licence verification.
//
// Key format (issued by the store's get-licence Netlify function):
//   WL1.<base64url(payload_json)>.<base64url(signature)>
// payload_json: {"email":"...","sid":"cs_...","iat":1234567890}
// The signature is Ed25519 over the raw payload-JSON bytes. The matching
// private key lives only in the store's Netlify env (LICENCE_SIGNING_KEY) —
// this binary embeds the public half and never phones home.

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

/// Raw 32-byte Ed25519 public key, hex. Pair generated 2026-06-13.
const LICENCE_PUBLIC_KEY_HEX: &str =
    "f380f74ef29ee00dbd33c8f0e4088249cb536f7cd3d5220c8d566def07791352";

/// Media at or under this duration transcribes without a licence.
pub const FREE_LIMIT_SECS: u64 = 5 * 60;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LicencePayload {
    pub email: String,
    pub sid: String,
    pub iat: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct LicenceStatus {
    pub licensed: bool,
    pub email: Option<String>,
    pub free_limit_secs: u64,
}

fn verifying_key() -> VerifyingKey {
    let mut bytes = [0u8; 32];
    hex::decode_to_slice(LICENCE_PUBLIC_KEY_HEX, &mut bytes)
        .expect("embedded licence public key is valid hex");
    VerifyingKey::from_bytes(&bytes).expect("embedded licence public key is a valid point")
}

/// Parse + cryptographically verify a licence key string. Returns the
/// payload on success so the UI can show which email the licence is bound to.
pub fn verify(key: &str) -> Result<LicencePayload, String> {
    let key = key.trim();
    let mut parts = key.split('.');
    let (magic, payload_b64, sig_b64) = match (parts.next(), parts.next(), parts.next(), parts.next()) {
        (Some(m), Some(p), Some(s), None) => (m, p, s),
        _ => return Err("malformed licence key — expected WL1.<payload>.<signature>".into()),
    };
    if magic != "WL1" {
        return Err(format!("unsupported licence version '{magic}'"));
    }
    let payload_bytes = URL_SAFE_NO_PAD
        .decode(payload_b64)
        .map_err(|_| "licence payload is not valid base64url".to_string())?;
    let sig_bytes = URL_SAFE_NO_PAD
        .decode(sig_b64)
        .map_err(|_| "licence signature is not valid base64url".to_string())?;
    let sig_arr: [u8; 64] = sig_bytes
        .as_slice()
        .try_into()
        .map_err(|_| "licence signature has the wrong length".to_string())?;
    let signature = Signature::from_bytes(&sig_arr);

    verifying_key()
        .verify(&payload_bytes, &signature)
        .map_err(|_| "licence signature check failed — key may be mistyped or tampered".to_string())?;

    serde_json::from_slice::<LicencePayload>(&payload_bytes)
        .map_err(|_| "licence payload is not valid JSON".to_string())
}

fn licence_path(config_dir: &PathBuf) -> PathBuf {
    config_dir.join("licence.key")
}

/// Persist a verified licence key to the app config dir.
pub fn save(config_dir: &PathBuf, key: &str) -> std::io::Result<()> {
    std::fs::create_dir_all(config_dir)?;
    std::fs::write(licence_path(config_dir), key.trim())
}

/// Load + re-verify the stored licence, if any. A stored key that no longer
/// verifies (corrupt, tampered) is treated as absent rather than an error.
pub fn load(config_dir: &PathBuf) -> Option<LicencePayload> {
    let raw = std::fs::read_to_string(licence_path(config_dir)).ok()?;
    verify(&raw).ok()
}

pub fn remove(config_dir: &PathBuf) -> std::io::Result<()> {
    match std::fs::remove_file(licence_path(config_dir)) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        other => other,
    }
}
