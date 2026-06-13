// Local media-duration probe for the free-mode gate.
//
// lofty parses the container headers only (no decode), so this is fast even
// on multi-GB video. It covers MP3/WAV/FLAC/OGG/AAC plus the ISOBMFF family
// (M4A/MP4/MOV). Formats it can't parse (MKV, AVI, some WebM) return None —
// the caller treats unknown duration as "licence required" rather than
// silently letting unbounded files through the free gate.

use lofty::file::AudioFile;
use lofty::probe::Probe;
use std::path::Path;
use std::time::Duration;

pub fn probe_duration(path: &Path) -> Option<Duration> {
    let tagged = Probe::open(path).ok()?.read().ok()?;
    let dur = tagged.properties().duration();
    if dur.is_zero() {
        None
    } else {
        Some(dur)
    }
}
