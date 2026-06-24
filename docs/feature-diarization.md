# Feature: Local Speaker Diarization

> **Status:** design doc for AI dev agents. Date: 2026-06-23.
> **Why now:** the MVP shipped with everything labelled `S1` (no diarization). The founder flagged this as
> unusable: the editor must show real **speaker turns**, role assignment is **per-speaker**, and
> synthesis / diff / chat are all **role/attribution-based**. Diarization (who-spoke-when) is therefore the
> blocker for the rest of the product, not a nice-to-have. This doc picks a local engine and specifies the
> integration.
>
> **Reads / amends:** `reuse-landscape.md` (flagged WhisperX/pyannote as the diarization upgrade path — we
> reject that for MVP, see §3), `product-spec.md` §6 (transcription) and §6.7/§2.1 (segment schema). This
> doc adds a new pipeline stage **between transcribe and cleanup** and turns the spec's "manual diarization"
> (§3.5, risk #7) into automatic diarization + manual correction.

---

## 1. Recommendation (TL;DR)

**Ship `sherpa-onnx` offline speaker diarization, linked in-process via the official `sherpa-onnx` Rust
crate — pure-native ONNX Runtime, no Python.** Pipeline = **pyannote-segmentation-3.0 (ONNX)** +
**3D-Speaker ERes2Net embedding (ONNX)** + **FastClustering**. Run it on the existing **16 kHz mono WAV**
that whisper.cpp already produces, then assign each whisper ASR segment to the diarized speaker by
**maximum time-overlap**. Default to **auto-detect speaker count** (`num_clusters = -1` + a tuned
`threshold`) with an optional **"expected speakers" hint** (default 2) in the editor.

This is the lazy-senior choice: it **reuses the same vendor we already mine for ASR** (sherpa-rs/sherpa-onnx
are by `thewh1teagle`, author of Vibe), adds **one Rust crate + two small model files (~15 MB)**, keeps the
**Python-free** stack the project deliberately chose, and the future **Mac M3 Pro** path is the same crate
on a CoreML/CPU provider. No training, no second runtime, no PyTorch.

**Reject for MVP:** WhisperX / pyannote.audio (heavy PyTorch sidecar + **HF-gated** models — see §3), and
whisper.cpp tinydiarize (English-only, no clustering — see §3).

### Decisions to confirm with the founder
1. **Engine:** sherpa-onnx (pyannote-seg-3.0 + 3D-Speaker ERes2Net + FastClustering). **(recommended)**
2. **Python-or-not:** **No Python** — native ONNX via Rust crate. (pyannote/WhisperX would reintroduce a
   PyTorch sidecar; rejected.)
3. **#speakers:** **auto-detect by default** (`num_clusters=-1` + `threshold`), with a per-interview
   **"expected speakers" hint** (default 2) the user can set when auto guesses wrong.
4. **Integration:** **linked in-process** via the official `sherpa-onnx` crate (same model as `whisper-rs`),
   **not** a separate sidecar binary. (Sidecar CLI is the documented fallback if the crate build fights us.)
5. **GPU:** diarization runs **on CPU by default** (the models are tiny; CPU is ~real-time) — GPU is an
   optional optimisation, **not** a dependency. This de-risks the CUDA-DLL story for diarization.

---

## 2. Candidate comparison

| Candidate | License (engine / models) | Python? | Windows + Nvidia GPU | Accuracy (2-spkr interview) | Footprint | Rust integration |
|---|---|---|---|---|---|---|
| **sherpa-onnx** (pyannote-seg-3.0 + 3D-Speaker/NeMo embed + FastClustering) **← LEAD** | engine Apache-2.0; pyannote-seg-3.0 ONNX **MIT, gating-free**; embeddings Apache-2.0/MIT | **No** (ONNX Runtime, C++ core) | **Yes** — prebuilt Win x64 static libs; ORT CUDA + DirectML providers; **diarization fine on CPU** | Good for clean 2-spkr; same pyannote-3.0 segmentation backbone as the quality leaders; weakest on heavy crosstalk/overlap | **~15 MB models** + ORT DLLs; no extra runtime | **Official `sherpa-onnx` crate** (v1.13.3+), in-process; or bundleable CLI |
| **WhisperX** (faster-whisper + pyannote 3.1) | MIT / **pyannote models MIT but HF-GATED** | **Yes — PyTorch** | Yes, but via Python+CUDA | **Best** (forced-align + pyannote 3.1, DER ~11–19%) | **Heavy**: Python + PyTorch + CUDA ≈ **2–4 GB** sidecar; PyInstaller/uv brittle | None native; Python sidecar only |
| **pyannote.audio 3.1** (standalone) | MIT code / **models HF-GATED (token + accept terms)** | **Yes — PyTorch** | Yes via Python+CUDA | **Best-in-class** quality benchmark | Heavy PyTorch sidecar | None native; sidecar |
| **whisper.cpp tinydiarize (tdrz)** | MIT | No | Yes (already in our stack) | **Insufficient** — `small.en` **English-only**, turn-markers only, **no speaker clustering / IDs** | tiny | already linked, but unusable for us |
| **NVIDIA NeMo** (Sortformer / clustering diar) | Apache-2.0 / models permissive | **Yes — PyTorch** | Yes via Python+CUDA | Very good | Heavy PyTorch sidecar | None native; sidecar |
| **diart** (online/streaming) | MIT / wraps pyannote (gated) | **Yes — PyTorch** | Yes via Python | Good, but built for *streaming* (we have files) | Heavy | None native |
| **3D-Speaker (standalone)** | Apache-2.0 | **Yes** | Yes via Python | Good (it IS our embedder) | Heavy as a standalone pipeline | We use its ONNX **embedding** inside sherpa-onnx instead |

**Read of the table:** only **sherpa-onnx** and **tinydiarize** are Python-free. tinydiarize is disqualified
(English-only, no IDs). Everything else is a PyTorch sidecar. sherpa-onnx uses the **same pyannote-3.0
segmentation backbone** as the heavyweight pipelines (so it inherits most of their segmentation quality),
adds a strong speaker embedder + clustering, and ships as native ONNX. That is the only candidate that
satisfies "best quality achievable **without** Python."

### Why the rejections, concretely
- **WhisperX / pyannote 3.1 (quality reference, rejected):** pyannote 3.1 is excellent (DER ~11–19% on
  standard benchmarks) and MIT-licensed, but the models are **gated on Hugging Face** — the user must create
  an HF token and **accept the model's license terms** before download. That is a non-starter for a
  consumer desktop app's first-run flow. It is also **PyTorch**: bundling means a frozen Python + PyTorch +
  CUDA runtime (~2–4 GB, PyInstaller/uv-brittle) — exactly the bundle the project rejected for ASR. Keep it
  only as the **quality yardstick** and a possible "advanced accuracy" sidecar far later if a user opts in.
- **whisper.cpp tinydiarize (insufficient):** the finetune exists **only for `small.en`** (English), it just
  inserts `[SPEAKER_TURN]` markers (local segmentation), and explicitly does **not** do global speaker
  clustering / stable speaker IDs. Useless for Russian, useless for "S1 vs S2 across the whole interview."
- **NeMo / diart / 3D-Speaker standalone:** all PyTorch sidecars. We get the good part of 3D-Speaker (its
  ERes2Net embedder) **for free** as an ONNX model inside sherpa-onnx, with no Python.

---

## 3. The chosen engine — verified details (2026)

### 3.1 Pipeline inside sherpa-onnx
`OfflineSpeakerDiarization` runs three stages on a mono 16 kHz wav, all in ONNX Runtime:
1. **Segmentation** — `sherpa-onnx-pyannote-segmentation-3-0` (ONNX export of pyannote/segmentation-3.0):
   sliding-window local segmentation + overlap-aware speaker activity.
2. **Speaker embedding** — extract an embedding per local speaker region. Default recommended:
   `3dspeaker_speech_eres2net_base_sv_zh-cn_3dspeaker_16k.onnx` (3D-Speaker ERes2Net). NeMo and wespeaker
   embedders are drop-in alternatives.
3. **Clustering** — `FastClustering` groups embeddings into global speakers and stitches the per-window
   activity into final **{start, end, speaker_index}** turns.

Output is a list of segments labelled by integer speaker index (`speaker_00`, `speaker_01`, …) — exactly the
"speaker turns" the editor needs. **Diarization is language-agnostic** (it works on the acoustic signal, not
words), so **Russian is fully supported** — the pyannote-3.0 backbone is trained multi-domain; no
Russian-specific model needed. (Verify on a real Russian 2-speaker clip in M2.)

### 3.2 Auto-detect vs. hint — confirmed mechanism
`FastClusteringConfig` has two fields: `num_clusters: i32` and `threshold: f32`. Per the official example's
docstring:
- **Known speaker count → set `num_clusters = N`** (forces exactly N speakers; `threshold` ignored).
- **Unknown → set `num_clusters = -1`** and tune **`threshold`** (cosine-distance cut): *"A smaller
  threshold leads to more clusters (more speakers); a larger threshold leads to fewer clusters (fewer
  speakers)."*

**Our policy:** default `num_clusters = -1` with a tuned `threshold` (calibrate on Russian 2-speaker samples
in M2; start ~0.5 and adjust). The editor exposes an **"Expected speakers"** field (default *auto*, presets
2 / 3 / 4); if the user sets it, we pass `num_clusters = that value` for a re-diarize. So: **auto by
default, hint on demand.**

### 3.3 Models — sizes, source, licenses
| Model | Role | Size (approx) | Source | License |
|---|---|---|---|---|
| `sherpa-onnx-pyannote-segmentation-3-0` | segmentation | ~6 MB (`model.onnx`) | k2-fsa release `speaker-segmentation-models`; ONNX also at `onnx-community/pyannote-segmentation-3.0` | **MIT — NOT gated** (this is the key win vs. the HF-gated pyannote pipeline) |
| `3dspeaker_…_eres2net_base_sv…_16k.onnx` | speaker embedding | ~8–25 MB depending on variant (base ≈ small) | k2-fsa release `speaker-recongition-models` | **Apache-2.0** (3D-Speaker) |

Total diarization model footprint **≈ 15–30 MB** — negligible next to the 3 GB whisper large-v3. **Bundle
both ONNX files in the installer** (`bundle.resources`) — they are tiny and there is no gating/license-accept
to handle, so no first-run download needed (unlike whisper weights). Repackaged pyannote-seg-3.0 ONNX is
**gating-free**, which is the whole reason this path beats raw pyannote.

### 3.4 Rust integration — use the OFFICIAL crate
- **Use the official `sherpa-onnx` crate** (docs.rs/sherpa-onnx, v1.13.3+). It exposes
  `OfflineSpeakerDiarization`, `OfflineSpeakerDiarizationConfig`,
  `OfflineSpeakerSegmentationModelConfig`, and `FastClusteringConfig`, returning segments labelled by speaker
  index. Prebuilt **Windows x64 static archives**; DLLs auto-copied next to the binary.
- **IMPORTANT — do NOT use `thewh1teagle/sherpa-rs`:** that crate (the one Vibe-adjacent author wrote) was
  **archived on 2026-06-06**, with an explicit pointer to the official k2-fsa bindings. Its API (and the
  `download-binaries` / `static` / `cuda` / `directml` feature flags) is still the best *reference* for how
  to wire the build, but **depend on the official crate**, not the archived fork. (This is a change from any
  assumption that sherpa-rs is the binding to use.)
- **Linking:** in-process, same as `whisper-rs`. Use the crate's static-link feature for a single binary;
  it bundles the ONNX Runtime libs. No sidecar process, no IPC.
- **GPU:** ORT execution providers — **CUDA** (Nvidia) and **DirectML** (any DX12 GPU on Windows) — are
  available, but **diarization models are tiny CNNs/TDNNs that run at roughly real-time on CPU**. We run
  diarization **on CPU by default** and treat GPU as an optional later optimisation. This deliberately keeps
  diarization **off** the fragile CUDA-DLL bundling path (that risk stays scoped to whisper). If we later
  want GPU diar, DirectML on Windows avoids needing the CUDA toolkit.
- **Mac (future):** same crate; CPU is fine for these small models, CoreML provider optional. No second
  engine — mirrors the whisper.cpp `metal` story.

---

## 4. Pipeline + merge algorithm

### 4.1 Where it slots (new stage)
```
recording ─ffmpeg→ 16kHz mono wav
   ├─ whisper.cpp ─────────────→ ASR segments (verbatim, all speaker_label = "S1")   [existing]
   └─ sherpa-onnx diarize ─────→ speaker TURNS  [{start_ms,end_ms,speaker_idx}, …]    [NEW]
                                        │
        ┌───────────────────────────────┘
        ▼
   ASSIGN each ASR segment → speaker by max time-overlap   [NEW]
        ▼
   speaker-labelled ASR segments  (real S1/S2/…)  → transcript v1 `kind=raw`
        ▼
   group consecutive same-speaker segments into TURNS for the editor   [NEW, fixes "too many tiny segments" #4]
        ▼
   CLI 'transcript-cleanup'  (unchanged — rewrites text only)           [existing §6.7]
```
New stage runs **after transcribe, before cleanup**. ASR and diarization both consume the same `16k.wav` and
can run **concurrently** (diar is cheap); we join their outputs. The raw transcript stored in `transcript`
v1 now carries **real `speaker_label`s** instead of all `S1`. Cleanup is untouched — it still only rewrites
`text` and preserves ids/timing/labels (spec §6.7 / §7.3.1).

### 4.2 Overlap assignment algorithm (ASR segment → speaker)
Whisper segments and diarization turns are two independent timelines over the same audio. Assign each ASR
segment to the diarized speaker it overlaps most:

```
INPUT:  asr_segments [{start_ms,end_ms,text}]              (from whisper.cpp)
        diar_turns   [{start_ms,end_ms,speaker_idx}]       (from sherpa-onnx, sorted)
For each asr_seg:
  best_spk   = None ; best_overlap = 0
  for each diar_turn overlapping [asr_seg.start, asr_seg.end]:        # sorted → binary-search / two-pointer
      ov = max(0, min(asr_seg.end, turn.end) - max(asr_seg.start, turn.start))
      if ov > best_overlap: best_overlap = ov ; best_spk = turn.speaker_idx
  asr_seg.speaker_label = label_of(best_spk if best_spk is not None
                                   else nearest_turn_by_midpoint(asr_seg))   # fallback: no overlap → nearest turn
OUTPUT: asr_segments with speaker_label set (S1 = speaker_00, S2 = speaker_01, …)
```
- **Tie / no-overlap fallback:** if an ASR segment has no overlapping turn (silence-padded edges, VAD gaps),
  assign the speaker of the **temporally nearest** turn by midpoint. Never leave a segment unlabelled.
- **Cross-talk note:** a single whisper segment can straddle a real speaker change (whisper doesn't cut on
  speaker boundaries). Max-overlap picks the dominant speaker — acceptable for MVP; the user fixes the rare
  mislabel by hand (§6). A future refinement is splitting an ASR segment at a turn boundary, **deferred**.
- **Complexity:** O(N+M) with both lists sorted (two-pointer). Trivial for interview-length audio.

### 4.3 Turn grouping (fixes issue #4 "too many tiny segments")
The editor renders **turns**, not raw whisper segments. After labelling, **fold consecutive segments with
the same `speaker_label` into one turn** for display (concatenate text, span = first.start..last.end). The
underlying segment list (ids/timing) is unchanged — grouping is a **view transform**, so cleanup, evidence
refs (`segment_id`), and media-sync stay intact. This makes the transcript read like a real
interviewer/respondent dialogue instead of a wall of 2-second fragments.

---

## 5. Data model + commands

### 5.1 Schema impact — minimal
The existing `segment` shape `{start_ms,end_ms,speaker_label,text}` (spec §2.1) is **unchanged**;
`speaker_label` simply gets **real** values (`S1`,`S2`,… mapped from diarization `speaker_00`,…) instead of
a constant `S1`. The `participant.speaker_label` mapping (spec §2.2) **already exists** for binding speakers
to roles — diarization just makes it auto-populated and meaningful. Add to `transcript`:
- record diarization provenance in the existing `engine` column, e.g.
  `engine = "whisper.cpp:large-v3@cuda + sherpa-onnx:pyannote-seg-3.0/eres2net@cpu"`.
- optional: store the raw diarization turns alongside segments (a `diar_turns` JSON array in
  `segments_json`'s envelope) so **re-grouping / re-assignment** doesn't require re-running the models.

No new tables. (Lazy-senior call: reuse `speaker_label` + `participant`; store turns in the same blob.)

### 5.2 Commands / flow
- Extend `asr::transcribe` (or add `diarize::run`) so transcription returns **already-speaker-labelled**
  segments. Concretely: a new `diarize::diarize(wav_path, hint) -> Vec<Turn>` (Rust, in-process, on a
  `tokio` blocking task with progress events), then `assign_speakers(asr_segments, turns)` (§4.2). One
  combined result → `transcript` v1.
- New Tauri command **`rediarize_interview(interview_id, expected_speakers?: u8)`** — re-runs only
  diarization + re-assignment (whisper output is cached/unchanged), letting the user retry with a hint
  without re-transcribing. Produces a new `transcript` version.
- The `Asr` trait gains a sibling `Diarizer` trait (`diarize(wav) -> turns`) so the engine is swappable
  (the documented future WhisperX/pyannote sidecar would implement the same trait), mirroring spec §6.6's
  trait-based design.

---

## 6. UX

- **Auto on transcribe:** transcription now yields real `S1/S2/…`. The editor's left pane already has a
  **speaker → participant/role** mapping list (spec §4.3); the user maps **once per interview**
  (S1 → Interviewer, S2 → Respondent/persona). Persisted in `participant.speaker_label`.
- **Expected-speakers hint:** a small **Select** in the editor / transcribe dialog: *Auto (default) / 2 / 3 /
  4*. Default 2 (1 interviewer + 1 respondent). Setting it enables a precise re-diarize.
- **Re-diarize action:** a **Button** "Re-diarize" (and a row action) → `rediarize_interview` with the
  current hint; shows Progress; on completion the editor reloads with new turns and a Sonner toast. Useful
  when auto over/under-counts speakers.
- **Manual correction:** each turn's speaker **Badge** is clickable → **Popover + Command** to reassign that
  turn (and optionally "and all following until next change") to a different speaker — same control the spec
  already specced for manual labelling (§4.3/§4.5), now used for *correcting* auto output rather than doing
  it all by hand. Reassignment edits `speaker_label` on the affected segments and writes an `edited` version.
- **Turn view:** consecutive same-speaker segments render as one grouped turn (§4.3) — the editor finally
  reads like a dialogue. Timestamps and per-segment inline edit remain available within a turn.
- **Unassigned/extra speaker warning:** if diarization finds **more speakers than mapped participants**, show
  a warning Badge ("3 speakers detected, 2 mapped") prompting the user to add a participant or re-diarize
  with hint = 2.

---

## 7. Build plan (milestone-sized)

Each milestone ends with a concrete verification. Slots into spec §9 between M4 (ASR) and M5 (editor).

- **M1 — Engine spike (de-risk the crate + build).** Add the official `sherpa-onnx` crate; bundle
  pyannote-seg-3.0 + 3D-Speaker ERes2Net ONNX; write `diarize::diarize(wav) -> Vec<Turn>` running on CPU.
  *Verify:* a real **Russian 2-speaker** clip returns ~2 speaker turns with sane boundaries; the crate links
  and the Windows build produces a runnable binary with the ONNX DLLs alongside.
- **M2 — Tune auto-detect + Russian validation.** Calibrate `threshold` (with `num_clusters=-1`) on 3–5 real
  Russian interview clips; confirm 2-speaker auto-count is reliable and measure DER informally vs. ground
  truth. *Verify:* auto picks the right speaker count on the calibration set; hint=2 fixes the misses.
- **M3 — Merge + turn grouping.** Implement §4.2 max-overlap assignment + §4.3 turn grouping; wire into
  `transcribe` so `transcript` v1 carries real labels; store `diar_turns` in the blob. *Verify:* on a known
  clip, ASR segments carry correct `S1/S2`; consecutive-same-speaker segments group into turns; ids/timing
  unchanged; cleanup still passes its invariants.
- **M4 — Editor: turns, mapping, correction.** Render grouped turns; speaker→role mapping uses auto labels;
  per-turn reassignment Popover; "Expected speakers" Select; "Re-diarize" button → `rediarize_interview`.
  *Verify:* user maps S1/S2 to roles once; reassigning a mislabeled turn persists; re-diarize with hint=2
  re-labels and reloads.
- **M5 — Hardening.** `Diarizer` trait seam; provenance in `engine`; warning Badge for extra speakers;
  concurrency (diar alongside ASR); installer includes the two ONNX models. *Verify:* fresh-machine install
  transcribes **and** diarizes a Russian clip end-to-end with no Python and no system CUDA toolkit.

---

## 8. Risks

1. **Accuracy on overlap / cross-talk (MEDIUM–HIGH).** Diarization degrades on talk-over, laughter, far-field
   mics; a single whisper segment can straddle a speaker change. *Mitigation:* pyannote-3.0 seg is
   overlap-aware; max-overlap assignment picks the dominant speaker; the editor's per-turn correction is the
   safety net; deferred refinement = split ASR segments at turn boundaries. Validate on real audio in M2.
2. **Auto speaker-count mis-estimation (MEDIUM).** Threshold-based auto can over/under-count (e.g. one speaker
   split into two on channel/mic change). *Mitigation:* tune `threshold` on Russian samples (M2); default
   expectation is 2; expose the **hint** + **re-diarize**; warning Badge when count ≠ mapped participants.
3. **Russian suitability (LOW).** Diarization is acoustic, not lexical, so language is mostly irrelevant — but
   the segmentation model's training domains may not match noisy Russian field recordings. *Mitigation:*
   explicit Russian validation in M2; the embedder/threshold are tunable; manual correction always available.
4. **Official `sherpa-onnx` crate maturity / build on Windows (MEDIUM).** The crate is the right dependency
   (the older `sherpa-rs` is archived), but its Windows static-link + DLL story must be proven early.
   *Mitigation:* M1 is a dedicated spike; **fallback = bundle the sherpa-onnx CLI/shared-lib as a Tauri
   sidecar** and shell out (the binary distributions are first-class) if the crate fights the build.
5. **pyannote licensing (LOW — by design).** We deliberately use the **MIT, gating-free** ONNX re-export of
   pyannote-segmentation-3.0 (not the HF-gated pyannote *pipeline*), so there is **no token / license-accept
   gate** in first-run. *Mitigation:* none needed; this is the reason we avoid raw pyannote/WhisperX. Pin the
   model file in-repo/installer so an upstream gating change can't affect us.
6. **GPU not used for diarization (LOW / accepted).** We run diar on CPU. *Mitigation:* it's ~real-time on
   CPU for interview-length audio; if a very long file is slow, DirectML/CUDA providers are a config flip,
   and ASR (the real GPU consumer) is unaffected.
7. **"Best" quality ceiling below pyannote-3.1 (LOW / accepted).** A PyTorch pyannote-3.1 pipeline would
   score a bit better on DER. *Mitigation:* accepted trade for "no Python"; the `Diarizer` trait leaves an
   opt-in WhisperX/pyannote sidecar as a clearly-scoped future upgrade for power users.

---

## 9. Sources (verified 2026-06)
- sherpa-onnx speaker diarization (pipeline, models) — https://k2-fsa.github.io/sherpa/onnx/speaker-diarization/index.html ; https://deepwiki.com/k2-fsa/sherpa-onnx
- Official `sherpa-onnx` Rust crate (`OfflineSpeakerDiarization`, config structs, v1.13.3, Win static + DLL copy) — https://docs.rs/sherpa-onnx
- `thewh1teagle/sherpa-rs` — **ARCHIVED 2026-06-06**, points to official k2-fsa bindings; MIT; `cuda`/`directml`/`download-binaries`/`static` feature-flag reference — https://github.com/thewh1teagle/sherpa-rs
- FastClustering `num_clusters` / `threshold` auto-vs-hint semantics (official example docstring) — https://github.com/k2-fsa/sherpa-onnx (python-api-examples/offline-speaker-diarization.py)
- pyannote-segmentation-3.0 ONNX, **MIT, gating-free** — https://huggingface.co/onnx-community/pyannote-segmentation-3.0
- 3D-Speaker / NeMo / wespeaker embedding models (sherpa-onnx releases) — https://github.com/k2-fsa/sherpa-onnx/releases/tag/speaker-recongition-models ; https://github.com/k2-fsa/sherpa-onnx/releases/tag/speaker-segmentation-models
- sherpa-onnx GPU (CUDA + DirectML execution providers; Windows CUDA build needs toolkit + cuDNN) — https://deepwiki.com/k2-fsa/sherpa-onnx/7.1-gpu-support-(cuda-and-directml) ; https://k2-fsa.github.io/sherpa/onnx/install/windows/build-cuda.html
- pyannote.audio 3.1 / speaker-diarization-3.1 — MIT code but **HF-gated**, pure PyTorch (no ONNX) — https://huggingface.co/pyannote/speaker-diarization-3.1 ; https://github.com/pyannote/pyannote-audio
- WhisperX (faster-whisper + pyannote) — diarization quality leader, Python sidecar — https://github.com/m-bain/whisperX
- Speaker-diarization model comparison 2026 (pyannote 3.1 DER ~11–19%) — https://brasstranscripts.com/blog/speaker-diarization-models-comparison
- whisper.cpp tinydiarize (tdrz): `small.en` English-only, turn-markers only, no clustering — https://github.com/akashmjn/tinydiarize ; https://github.com/ggml-org/whisper.cpp/pull/1058
- Local private diarization shipped via sherpa-onnx in a Tauri/desktop app (Apr 2026, no Python) — https://openwhispr.com/blog/local-speaker-diarization
