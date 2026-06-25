// Local speaker diarization (feature-diarization.md).
//
// In-process, Python-free, CPU-only diarization via the OFFICIAL k2-fsa `sherpa-onnx`
// Rust crate (NOT the archived thewh1teagle/sherpa-rs). The pipeline is:
//   pyannote-segmentation-3.0 (ONNX)  →  3D-Speaker ERes2Net embedding (ONNX)  →  FastClustering
// all running on the 16 kHz mono WAV whisper.cpp already produces, so ASR + diarization
// share the same audio. Output is a list of speaker TURNS {start_ms,end_ms,speaker} that
// the pipeline then assigns to whisper ASR segments by max time-overlap (see assign.rs).
//
// Why this design (per feature-diarization.md §1, §3):
//   - same vendor we already mine for ASR (sherpa-onnx), one crate + two small ONNX models,
//   - NO Python, NO PyTorch, NO second runtime — pure-native ONNX Runtime, statically linked
//     (the crate's prebuilt win-x64-static-MT bundle links onnxruntime straight into the binary,
//     so there are NO ONNX DLLs to ship — verified at build time),
//   - runs on CPU by design (the models are tiny CNNs/TDNNs ~real-time on CPU), deliberately
//     OFF the fragile CUDA-DLL path that ASR uses. Mac-ready: same crate, CPU/CoreML provider.
//
// Conventions mirror asr.rs: a pure-compute `diarize()` (no async/DB) meant to run on a
// `spawn_blocking` task, typed structs, models resolved under the app models dir.
//
// ponytail: this module is JUST the engine + the overlap/turn helpers. The Tauri commands,
// progress events, DB writes and pipeline wiring live in asr.rs (transcribe) and the new
// rediarize command, reusing asr.rs's Segment type + transcript storage — no parallel stack.

use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::Manager;

use crate::asr::Segment;

// --- diarization model files (feature-diarization.md §3.3) --------------------
//
// Two ONNX files under <app_data>/models/diarization/. Tiny (~6 MB + ~38 MB), MIT /
// Apache-2.0, gating-free — so first-run downloads them with no token/license-accept
// (mirrors the ASR model UX). The segmentation file is pyannote-segmentation-3.0's
// model.onnx; the embedding is 3D-Speaker ERes2Net base.
pub const SEGMENTATION_FILE: &str = "segmentation.onnx";
pub const EMBEDDING_FILE: &str = "embedding.onnx";

// Release asset URLs (k2-fsa sherpa-onnx model releases, verified 2026-06). The
// segmentation model ships inside a .tar.bz2 (we extract model.onnx); the embedding is a
// bare .onnx. Kept here so the download command + the first-run UX share one source.
pub const SEGMENTATION_ARCHIVE_URL: &str = "https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-segmentation-models/sherpa-onnx-pyannote-segmentation-3-0.tar.bz2";
pub const SEGMENTATION_ARCHIVE_MEMBER: &str = "sherpa-onnx-pyannote-segmentation-3-0/model.onnx";
pub const EMBEDDING_URL: &str = "https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/3dspeaker_speech_eres2net_base_sv_zh-cn_3dspeaker_16k.onnx";

// Auto-detect default threshold (feature-diarization.md §3.2): with num_clusters=-1, a
// smaller threshold → more speakers, larger → fewer.
//
// Calibrated on a real Russian 2-speaker podcast clip (w1_a) — speaker count vs threshold:
//   0.5→11   0.6→6   0.7→5   0.8→5   0.9→3   1.0→2   (the doc's 0.5 starting point badly
// over-counts on this audio with the zh-cn-trained ERes2Net embedder; the count falls
// monotonically as the threshold rises). 1.0 auto-detects exactly 2 speakers here — the
// same clean result as forcing the hint — so we default to 1.0. The "Expected speakers"
// hint (forces num_clusters=N) remains the reliable escape hatch + the "Re-diarize" retry
// when auto over/under-counts on harder audio (feature-diarization.md risk #2).
pub const DEFAULT_THRESHOLD: f32 = 1.0;

// models/diarization/ dir under the app-data dir (weights live OUTSIDE cycle dirs, like ASR).
pub fn diarization_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let base = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir: {e}"))?;
    Ok(base.join("models").join("diarization"))
}

// True when both ONNX files are present (drives the first-run download UX + a clear error).
pub fn models_present(dir: &Path) -> bool {
    dir.join(SEGMENTATION_FILE).exists() && dir.join(EMBEDDING_FILE).exists()
}

// --- first-run model download (mirrors asr.rs's ggml download UX) --------------

// Download + extract both diarization ONNX models into `dir`. Blocking I/O (ureq + tar +
// bzip2) → callers run it on a spawn_blocking task. `on_progress(done, total, label)` is
// called for coarse UI ticks (2 steps: segmentation, embedding). Idempotent: skips a model
// that's already present, so a retry after a flaky download is cheap. Gating-free models
// (MIT / Apache-2.0) → no token/license-accept, unlike the whisper weights.
pub fn download_models(
    dir: &Path,
    mut on_progress: impl FnMut(u32, u32, &str),
) -> Result<(), String> {
    use std::io::Read as _;
    std::fs::create_dir_all(dir).map_err(|e| format!("create diarization dir: {e}"))?;

    // 1/2 — segmentation model: ships inside a .tar.bz2; we extract just model.onnx.
    let seg_dst = dir.join(SEGMENTATION_FILE);
    if !seg_dst.exists() {
        on_progress(0, 2, "segmentation");
        let resp = ureq::get(SEGMENTATION_ARCHIVE_URL)
            .call()
            .map_err(|e| format!("download segmentation archive: {e}"))?;
        let mut buf = Vec::new();
        resp.into_body()
            .into_reader()
            .read_to_end(&mut buf)
            .map_err(|e| format!("read segmentation archive: {e}"))?;
        // .tar.bz2 → find the model.onnx member and write it to seg_dst.
        let decompressed = bzip2::read::BzDecoder::new(std::io::Cursor::new(buf));
        let mut archive = tar::Archive::new(decompressed);
        let mut found = false;
        for entry in archive.entries().map_err(|e| format!("read tar: {e}"))? {
            let mut entry = entry.map_err(|e| format!("tar entry: {e}"))?;
            let path = entry.path().map_err(|e| format!("tar path: {e}"))?;
            if path.to_string_lossy().replace('\\', "/").ends_with("/model.onnx") {
                let part = seg_dst.with_extension("part");
                let mut out = std::fs::File::create(&part).map_err(|e| format!("create seg part: {e}"))?;
                std::io::copy(&mut entry, &mut out).map_err(|e| format!("extract seg: {e}"))?;
                drop(out);
                std::fs::rename(&part, &seg_dst).map_err(|e| format!("finalize seg: {e}"))?;
                found = true;
                break;
            }
        }
        if !found {
            return Err(format!("segmentation archive missing {SEGMENTATION_ARCHIVE_MEMBER}"));
        }
    }

    // 2/2 — embedding model: a bare .onnx, streamed straight to disk.
    let emb_dst = dir.join(EMBEDDING_FILE);
    if !emb_dst.exists() {
        on_progress(1, 2, "embedding");
        let resp = ureq::get(EMBEDDING_URL)
            .call()
            .map_err(|e| format!("download embedding model: {e}"))?;
        let part = emb_dst.with_extension("part");
        let mut out = std::fs::File::create(&part).map_err(|e| format!("create emb part: {e}"))?;
        let mut reader = resp.into_body().into_reader();
        std::io::copy(&mut reader, &mut out).map_err(|e| format!("write embedding: {e}"))?;
        drop(out);
        std::fs::rename(&part, &emb_dst).map_err(|e| format!("finalize embedding: {e}"))?;
    }

    on_progress(2, 2, "done");
    Ok(())
}

// --- a diarized speaker turn (feature-diarization.md §3.1 output) -------------

// One speaker turn from diarization: a contiguous span attributed to one global speaker.
// `speaker` is the 0-based cluster index (speaker_00, speaker_01, …); the pipeline maps it
// to the S1/S2/… label the rest of the app uses (label_for).
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Turn {
    pub start_ms: i64,
    pub end_ms: i64,
    pub speaker: i32,
}

// Map a 0-based diarization speaker index to the app's "S{n}" label (speaker_00 → "S1").
pub fn label_for(speaker: i32) -> String {
    format!("S{}", speaker + 1)
}

// --- the diarization engine (pure compute → spawn_blocking) -------------------

// Run sherpa-onnx offline diarization on 16 kHz mono f32 samples.
//
// `expected` is the "Expected speakers" hint (feature-diarization.md §3.2):
//   Some(n) → force exactly n speakers (num_clusters = n, threshold ignored),
//   None    → auto-detect (num_clusters = -1 + DEFAULT_THRESHOLD).
//
// Returns turns sorted by start time, in MILLISECONDS (sherpa returns seconds as f32).
// Pure compute (no async, no DB) so callers run it on a blocking task, same as run_whisper.
pub fn diarize_samples(
    seg_model: &Path,
    emb_model: &Path,
    samples: &[f32],
    sample_rate: i32,
    expected: Option<i32>,
) -> Result<Vec<Turn>, String> {
    use sherpa_onnx::{
        FastClusteringConfig, OfflineSpeakerDiarization, OfflineSpeakerDiarizationConfig,
        OfflineSpeakerSegmentationModelConfig, OfflineSpeakerSegmentationPyannoteModelConfig,
        SpeakerEmbeddingExtractorConfig,
    };

    // num_clusters = -1 (auto) unless the user supplied a hint; threshold only matters in
    // the auto case but is harmless when num_clusters is fixed.
    let num_clusters = expected.filter(|n| *n > 0).unwrap_or(-1);

    // sherpa defaults BOTH ONNX sessions to num_threads = 1, so diarization runs single-threaded
    // and is the pipeline's slow pole on long interviews (the segmentation + per-segment embedding
    // forward passes dominate). Give the ONNX intra-op pool more cores — a multi-× speedup with NO
    // quality change. Measured on a 9-min clip (12-core box): 1 thread 214s → 4 threads 88s (2.4×);
    // 8 threads REGRESSED to 98s (the embedding model's many small ops don't scale past ~4-6 + ORT
    // thread overhead). So target ~physical/performance cores: half the logical count, capped [2, 6]
    // — floor lifts it off 1, ceiling stays under the regression point. // ponytail: tunable knob.
    let cores = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4);
    let n_threads = (cores / 2).clamp(2, 6) as i32;

    // ONNX Runtime execution provider. On Apple Silicon ask for CoreML (Apple Neural Engine /
    // GPU) — it offloads the segmentation + embedding forward passes (the pipeline's slow pole)
    // off the CPU. ORT silently falls back to CPU for any op CoreML doesn't support, and a
    // missing CoreML EP just fails session-create (which diarize_and_store already treats as
    // best-effort → single speaker), so this can never break transcription. Everywhere else:
    // CPU (the sherpa default). // ponytail: flip to "cpu" if CoreML regresses on a real Mac.
    let provider = if cfg!(target_os = "macos") { "coreml" } else { "cpu" };

    let config = OfflineSpeakerDiarizationConfig {
        segmentation: OfflineSpeakerSegmentationModelConfig {
            pyannote: OfflineSpeakerSegmentationPyannoteModelConfig {
                model: Some(seg_model.to_string_lossy().into_owned()),
            },
            num_threads: n_threads,
            provider: Some(provider.to_string()),
            ..Default::default()
        },
        embedding: SpeakerEmbeddingExtractorConfig {
            model: Some(emb_model.to_string_lossy().into_owned()),
            num_threads: n_threads,
            provider: Some(provider.to_string()),
            ..Default::default()
        },
        clustering: FastClusteringConfig {
            num_clusters,
            threshold: DEFAULT_THRESHOLD,
        },
        ..Default::default()
    };

    let sd = OfflineSpeakerDiarization::create(&config)
        .ok_or("failed to initialize sherpa-onnx diarization (check the ONNX models)")?;

    // The segmentation model expects 16 kHz; our WAVs are always 16k mono, but guard anyway
    // so a wrong-rate input fails loudly instead of producing garbage turns.
    let want = sd.sample_rate();
    if want != sample_rate {
        return Err(format!(
            "diarization model expects {want} Hz but got {sample_rate} Hz audio"
        ));
    }

    let result = sd
        .process(samples)
        .ok_or("sherpa-onnx diarization returned no result")?;

    // sherpa returns start/end in SECONDS (f32) → ms. sort_by_start_time gives a clean,
    // chronological turn list (what the overlap assignment + turn grouping expect).
    let turns = result
        .sort_by_start_time()
        .into_iter()
        .map(|s| Turn {
            start_ms: (s.start * 1000.0).round() as i64,
            end_ms: (s.end * 1000.0).round() as i64,
            speaker: s.speaker,
        })
        .collect();
    Ok(turns)
}

// --- segment → speaker assignment by max time-overlap (feature-diarization.md §4.2) ---

// Assign each ASR segment to the diarized speaker it overlaps most, setting speaker_label
// to "S1"/"S2"/…. Two independent timelines over the same audio:
//   - for each ASR segment, find the diar turn with the largest temporal overlap,
//   - no overlap (VAD gaps / silence-padded edges) → fall back to the temporally NEAREST
//     turn by midpoint, so a segment is NEVER left unlabelled.
// Segment COUNT + TIMING are untouched — only speaker_label changes (so the cleanup
// contract / evidence refs / media-sync all stay intact). O(N*M) is trivial for
// interview-length audio; turns are already sorted.
pub fn assign_speakers(segments: &mut [Segment], turns: &[Turn]) {
    if turns.is_empty() {
        return; // nothing to assign from — leave labels as-is (single-speaker fallback).
    }
    for seg in segments.iter_mut() {
        let mut best_overlap: i64 = 0;
        let mut best_speaker: Option<i32> = None;
        for t in turns {
            let overlap = (seg.end_ms.min(t.end_ms) - seg.start_ms.max(t.start_ms)).max(0);
            if overlap > best_overlap {
                best_overlap = overlap;
                best_speaker = Some(t.speaker);
            }
        }
        let speaker = best_speaker.unwrap_or_else(|| nearest_turn_speaker(seg, turns));
        seg.speaker_label = label_for(speaker);
    }
}

// Fallback for a segment with no overlapping turn: the speaker of the turn whose midpoint
// is closest to the segment's midpoint.
fn nearest_turn_speaker(seg: &Segment, turns: &[Turn]) -> i32 {
    let mid = (seg.start_ms + seg.end_ms) / 2;
    turns
        .iter()
        .min_by_key(|t| ((t.start_ms + t.end_ms) / 2 - mid).abs())
        .map(|t| t.speaker)
        .unwrap_or(0)
}

// --- turn grouping for the editor (feature-diarization.md §4.3, fixes bug #4) ----

// A display turn: consecutive same-speaker segments folded into one block. Carries the
// span (first.start..last.end) + the underlying segment INDICES (so play/seek + per-segment
// timing-immutability are preserved) + the concatenated text. This is a VIEW transform —
// the stored segment list is unchanged, so cleanup/evidence/media-sync are unaffected.
//
// ponytail: the EDITOR does the actual turn grouping in TS (it owns the render); this Rust
// version is the reference algorithm + its unit test (the brief asks for a turn-grouping
// test) and a ready seam for any future backend consumer. #[allow(dead_code)] because it's
// intentionally not called from Rust yet.
#[allow(dead_code)]
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct GroupedTurn {
    pub speaker_label: String,
    pub start_ms: i64,
    pub end_ms: i64,
    pub segment_indices: Vec<usize>,
    pub text: String,
}

// Fold consecutive segments with the same speaker_label into turns (in order). A run of
// 2-second whisper fragments from one speaker becomes one readable paragraph.
#[allow(dead_code)]
pub fn group_turns(segments: &[Segment]) -> Vec<GroupedTurn> {
    let mut turns: Vec<GroupedTurn> = Vec::new();
    for (i, seg) in segments.iter().enumerate() {
        match turns.last_mut() {
            Some(last) if last.speaker_label == seg.speaker_label => {
                last.end_ms = seg.end_ms;
                last.segment_indices.push(i);
                if !seg.text.is_empty() {
                    if !last.text.is_empty() {
                        last.text.push(' ');
                    }
                    last.text.push_str(&seg.text);
                }
            }
            _ => turns.push(GroupedTurn {
                speaker_label: seg.speaker_label.clone(),
                start_ms: seg.start_ms,
                end_ms: seg.end_ms,
                segment_indices: vec![i],
                text: seg.text.clone(),
            }),
        }
    }
    turns
}

#[cfg(test)]
mod tests {
    use super::*;

    fn seg(start_ms: i64, end_ms: i64, text: &str) -> Segment {
        Segment {
            start_ms,
            end_ms,
            speaker_label: "S1".to_string(),
            text: text.to_string(),
        }
    }

    // label_for maps 0-based diarization indices to the app's 1-based S-labels.
    #[test]
    fn label_mapping() {
        assert_eq!(label_for(0), "S1");
        assert_eq!(label_for(1), "S2");
        assert_eq!(label_for(2), "S3");
    }

    // Max-overlap assignment: each ASR segment gets the speaker it overlaps most, even when
    // it straddles a turn boundary (dominant speaker wins).
    #[test]
    fn assign_by_max_overlap() {
        let turns = vec![
            Turn { start_ms: 0, end_ms: 5000, speaker: 0 },
            Turn { start_ms: 5000, end_ms: 10000, speaker: 1 },
        ];
        let mut segs = vec![
            seg(0, 4000, "a"),       // fully inside speaker 0
            seg(6000, 9000, "b"),    // fully inside speaker 1
            seg(4000, 6000, "c"),    // straddles: 1000ms in spk0, 1000ms in spk1 → tie broken by first-seen (spk0)
            seg(4200, 6000, "d"),    // 800ms spk0 vs 1000ms spk1 → spk1 dominates
        ];
        assign_speakers(&mut segs, &turns);
        assert_eq!(segs[0].speaker_label, "S1");
        assert_eq!(segs[1].speaker_label, "S2");
        assert_eq!(segs[2].speaker_label, "S1"); // equal overlap → first turn wins (> not >=)
        assert_eq!(segs[3].speaker_label, "S2"); // more overlap with speaker 1
    }

    // A segment with NO overlapping turn falls back to the nearest turn by midpoint — never
    // left unlabelled.
    #[test]
    fn assign_nearest_when_no_overlap() {
        let turns = vec![
            Turn { start_ms: 0, end_ms: 1000, speaker: 0 },
            Turn { start_ms: 10000, end_ms: 12000, speaker: 1 },
        ];
        let mut segs = vec![
            seg(1500, 2000, "near spk0"),   // midpoint 1750, closest to spk0 (mid 500)
            seg(8000, 9000, "near spk1"),   // midpoint 8500, closest to spk1 (mid 11000)
        ];
        assign_speakers(&mut segs, &turns);
        assert_eq!(segs[0].speaker_label, "S1");
        assert_eq!(segs[1].speaker_label, "S2");
    }

    // Empty turns (single-speaker / diar produced nothing) → labels untouched, no panic.
    #[test]
    fn assign_empty_turns_is_noop() {
        let mut segs = vec![seg(0, 1000, "x")];
        assign_speakers(&mut segs, &[]);
        assert_eq!(segs[0].speaker_label, "S1"); // unchanged
    }

    // Turn grouping folds consecutive same-speaker segments into one block, preserving the
    // span, the underlying indices, and concatenated text.
    #[test]
    fn group_consecutive_same_speaker() {
        let mut segs = vec![
            seg(0, 1000, "hello"),
            seg(1000, 2000, "there"),
            seg(2000, 3000, "how are you"),
            seg(3000, 4000, "fine thanks"),
        ];
        // S1, S1, S2, S1  → three turns: [0,1] / [2] / [3]
        segs[0].speaker_label = "S1".into();
        segs[1].speaker_label = "S1".into();
        segs[2].speaker_label = "S2".into();
        segs[3].speaker_label = "S1".into();

        let turns = group_turns(&segs);
        assert_eq!(turns.len(), 3);
        assert_eq!(turns[0].speaker_label, "S1");
        assert_eq!(turns[0].segment_indices, vec![0, 1]);
        assert_eq!(turns[0].start_ms, 0);
        assert_eq!(turns[0].end_ms, 2000);
        assert_eq!(turns[0].text, "hello there");
        assert_eq!(turns[1].speaker_label, "S2");
        assert_eq!(turns[1].segment_indices, vec![2]);
        assert_eq!(turns[2].segment_indices, vec![3]);
        // Grouping never changes the underlying segment count.
        assert_eq!(segs.len(), 4);
    }

    // ===================================================================================
    // M1 SPIKE — REAL diarization on a real Russian 2-speaker WAV. #[ignore]d so the normal
    // suite stays offline/fast. Proves the sherpa-onnx crate links + runs on Windows (CPU)
    // and returns ≥2 speaker turns with sane boundaries on a clean 2-speaker clip.
    //
    // Requires:
    //   - the two ONNX models at %APPDATA%/com.interviewlab.app/models/diarization/,
    //   - a real Russian make-sense podcast clip at C:\ai-interview\_seedwork\w1_a.16k.wav
    //     (host + guest = 2 speakers; avoid w1_b which hits a jingle).
    // Run (CPU): src-tauri\target\cpu-build.cmd test diarize_spike_real -- --ignored --nocapture
    #[test]
    #[ignore]
    fn diarize_spike_real() {
        let appdata = std::env::var("APPDATA").expect("APPDATA");
        let dir = std::path::Path::new(&appdata)
            .join("com.interviewlab.app")
            .join("models")
            .join("diarization");
        let seg_model = dir.join(SEGMENTATION_FILE);
        let emb_model = dir.join(EMBEDDING_FILE);
        assert!(seg_model.exists(), "segmentation model missing at {seg_model:?}");
        assert!(emb_model.exists(), "embedding model missing at {emb_model:?}");

        let wav = std::path::Path::new(r"C:\ai-interview\_seedwork\w1_a.16k.wav");
        assert!(wav.exists(), "test wav missing at {wav:?}");

        // Reuse asr.rs's 16k mono reader (the exact format ffmpeg writes).
        let samples = crate::asr::read_wav_16k_mono(wav).expect("read wav");
        assert!(samples.len() > 16000 * 30, "expected a long clip, got {} samples", samples.len());

        // AUTO-detect (no hint): the clean 2-speaker clip should yield ≥2 speakers.
        let turns = diarize_samples(&seg_model, &emb_model, &samples, 16000, None)
            .expect("diarize");
        let speakers: std::collections::BTreeSet<i32> = turns.iter().map(|t| t.speaker).collect();
        println!("AUTO: {} turns across {} speakers", turns.len(), speakers.len());
        for t in turns.iter().take(8) {
            println!("  {:>7}..{:<7}ms  {}", t.start_ms, t.end_ms, label_for(t.speaker));
        }
        assert!(speakers.len() >= 2, "expected >=2 speakers (auto), got {}", speakers.len());
        assert!(turns.iter().all(|t| t.end_ms >= t.start_ms), "turn timings must be monotonic");
        assert!(turns.windows(2).all(|w| w[0].start_ms <= w[1].start_ms), "turns must be sorted by start");

        // HINT = 2: forcing exactly 2 speakers must also produce exactly 2.
        let turns2 = diarize_samples(&seg_model, &emb_model, &samples, 16000, Some(2))
            .expect("diarize hint=2");
        let speakers2: std::collections::BTreeSet<i32> = turns2.iter().map(|t| t.speaker).collect();
        println!("HINT=2: {} turns across {} speakers", turns2.len(), speakers2.len());
        assert_eq!(speakers2.len(), 2, "hint=2 must force exactly 2 speakers");
    }

    // Threshold calibration sweep (feature-diarization.md §3.2 / M2). #[ignore]d. Loads the
    // models once and reports the auto speaker-count at a range of thresholds on the real
    // 2-speaker clip, so we can pick a DEFAULT_THRESHOLD that auto-detects 2 reliably. A
    // larger threshold → fewer speakers. Run:
    //   src-tauri\target\cpu-build.cmd test diarize_threshold_sweep -- --ignored --nocapture
    #[test]
    #[ignore]
    fn diarize_threshold_sweep() {
        use sherpa_onnx::{
            FastClusteringConfig, OfflineSpeakerDiarization, OfflineSpeakerDiarizationConfig,
            OfflineSpeakerSegmentationModelConfig, OfflineSpeakerSegmentationPyannoteModelConfig,
            SpeakerEmbeddingExtractorConfig,
        };
        let appdata = std::env::var("APPDATA").expect("APPDATA");
        let dir = std::path::Path::new(&appdata)
            .join("com.interviewlab.app").join("models").join("diarization");
        let seg = dir.join(SEGMENTATION_FILE);
        let emb = dir.join(EMBEDDING_FILE);
        let wav = std::path::Path::new(r"C:\ai-interview\_seedwork\w1_a.16k.wav");
        let samples = crate::asr::read_wav_16k_mono(wav).expect("read wav");

        for thr in [0.5f32, 0.6, 0.7, 0.8, 0.9, 1.0, 1.1] {
            let config = OfflineSpeakerDiarizationConfig {
                segmentation: OfflineSpeakerSegmentationModelConfig {
                    pyannote: OfflineSpeakerSegmentationPyannoteModelConfig { model: Some(seg.to_string_lossy().into_owned()) },
                    ..Default::default()
                },
                embedding: SpeakerEmbeddingExtractorConfig { model: Some(emb.to_string_lossy().into_owned()), ..Default::default() },
                clustering: FastClusteringConfig { num_clusters: -1, threshold: thr },
                ..Default::default()
            };
            let sd = OfflineSpeakerDiarization::create(&config).expect("create");
            let res = sd.process(&samples).expect("process");
            println!("threshold {:.2} -> {} speakers, {} segments", thr, res.num_speakers(), res.num_segments());
        }
    }
}
