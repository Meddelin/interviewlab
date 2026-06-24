# E2E bug log — fix in ONE pass (not piecemeal)

Found while driving the **real app** end-to-end (CDP over the live WebView2 + real Rust backend, real `claude`, real ASR). Reset DB, created everything through the app. To be fixed together in a single dedicated pass.

**STATUS (2026-06-24): ALL bugs #1–#7 RESOLVED.** Full e2e chain verified live (ingest → ASR → diarize → cleanup → roles → synthesis → per-interview summary → diff → chat, 3 plugins).

7. **Active `claude-code` plugin couldn't drive chat — stale legacy descriptor shadowed the folder manifest.**
   - **Symptom:** `cycle_chat_send` → "the active plugin `claude-code` does not support streaming chat". `list_adapters` showed claude-code with caps `[batch-tasks]` only, sourced from `adapters/claude-code.json` (the old M6 flat descriptor) instead of `plugins/claude-code/manifest.json` (which declares `streaming`+`multi-turn`+`tool-use`+`chat.stream`).
   - **Cause:** `discover_plugins` loaded folder manifests (step 2) **before** legacy flat `adapters/*.json` (step 3), and `upsert` lets the later writer win — so a stale auto-written legacy file downgraded the richer folder manifest for the same id.
   - **Fix (`src-tauri/src/adapter.rs`):** reorder precedence to bundled < legacy flat < **folder manifest** (folder loads last and wins). Also deleted the stale `adapters/claude-code.json` from the live profile. After rescan, claude-code → full caps; chat streams a grounded answer with `[[finding:Fn]]` citations.
   - **Verified (rebuilt CUDA binary):** with the stale legacy file deliberately restored, the new binary's first scan still resolved claude-code from `plugins/claude-code/manifest.json` with full caps (folder wins) and chat streamed `[[finding:F3]]` — proving the reorder, not just the file deletion.

> **Diarization note (not a bug):** monologue clips (w1_a) yield a single/untagged speaker — expected; multi-voice clips (w2_a) tag S1/S2 correctly. Diarization does **not** auto-create participants (manual role assignment via `save_participants`). DLL/dylib bundling into the installer remains a packaging follow-up.

**STATUS (2026-06-24): ALL bugs #1–#5 RESOLVED.** #2 (speaker separation) + #4 (turn merging) fixed by the **diarization** feature (sherpa-onnx); #1 (ASR runaway/hang) + #5 (manual Stop) + #3 (ingest hygiene) fixed by the **ASR-robustness pass** (anti-hallucination params + temperature fallback + watchdog timeout + startup zombie-recovery + cancel/abort + Stop button + basename title). All verified (`w1_b` runaway now terminates via watchdog; 83 tests pass). Packaging follow-up only: bundle the onnxruntime/sherpa DLLs into the installer.

> **🚧 BLOCKER — #2 (speaker diarization) gates the whole chain.** Per the founder: cleanup → roles → synthesis (by role) → diff → chat are all meaningless without knowing **who said what**. Solve diarization FIRST; downstream E2E is **paused** until then. (Reverses the MVP "no diarization / manual roles" call.) See `docs/feature-diarization.md`.

## HIGH
1. **ASR runaway / hallucination — transcription can hang, no guard.**
   - **Symptom:** interview `w1_b` stuck in `transcribing` and **hangs INDEFINITELY — it never self-terminates** (confirmed running 10+ min on a 4-min clip; had to kill the app process to stop it). whisper outputs fluent **English on Russian audio** (language forced `ru`), one **never-terminating segment** (`result_len` 169+ and growing), crawling at ~3 tokens/s. The whole transcription can't progress and a 2nd interview stays queued forever (ASR concurrency=1) — so one bad file blocks the entire cycle. A **hard per-interview watchdog timeout is mandatory**, not optional.
   - **Cause:** no whisper anti-hallucination/anti-runaway params; pure **greedy** decoding (`best_of:1`); `base` model is weak; the clip (trimmed from 0:30) likely hit intro music/jingle/silence.
   - **Fix (`src-tauri/src/asr.rs`, whisper-rs `FullParams`):** set `no_speech_thold` / `entropy_thold` / `logprob_thold`, enable **temperature fallback** (`temperature_inc`) instead of pure greedy, `suppress_non_speech_tokens`, cap segment length / max tokens; add a **per-interview watchdog timeout** so one pathological chunk can't hang the run (mark interview `error`, free the queue). Consider beam search. Real interviews + large-v3 are more robust, but the guard is mandatory (music/silence/crosstalk happen).

5. **No way to manually STOP a running transcription.**
   - **Symptom:** when transcription hangs (#1), there's no Cancel/Stop in the UI — the only recourse was killing the whole app process. The user must be able to stop a stuck (or unwanted) transcription.
   - **Fix:** a **Cancel/Stop** action on an in-progress interview that aborts the ASR task, frees the concurrency=1 queue, and marks the interview `new`/`error`. Backend: a per-interview **cancellation flag** (AtomicBool / a cancel registry) checked inside whisper's callback — whisper.cpp supports an **`abort_callback`** (and the progress/new-segment callback can signal abort) to interrupt mid-run on the blocking task. Pairs with #1's auto-watchdog (manual stop + automatic timeout). Files: `src-tauri/src/asr.rs` (+ a `cancel_transcription` command) and the Interviews UI.

## MEDIUM
2. **No speaker separation in transcripts (diarization gap).**
   - **Symptom:** `w1_a` transcript is entirely one speaker (`S1`); speakers are not split — user expected separation.
   - **Cause:** auto-diarization was deferred in the MVP (manual role assignment only).
   - **Fix / decision needed:** either add local diarization (WhisperX/pyannote — heavy, Windows/CUDA caveats) OR make manual speaker-splitting fast (e.g. split a segment at a point + assign turns). **Product decision** — revisit the "no diarization" MVP call with the founder.

4. **Transcript chopped into many tiny segments — no turn merging.**
   - **Symptom:** the editor shows the transcript as dozens of tiny rows (~2–5s each) even when one speaker talks continuously the whole time — hard to read, tedious to assign roles per micro-segment.
   - **Cause:** whisper emits fine-grained segments; the editor renders one row per raw segment with no coalescing of consecutive same-speaker turns.
   - **Fix:** group **consecutive same-speaker segments into one turn/paragraph** block in the editor; keep each underlying segment's `start_ms`/`end_ms` for playback/seek + the timing-immutability invariant (merging is a presentation/turn layer, not a data rewrite). Pairs with **#2** — role assignment should be **per turn**, not per micro-segment. File: `src/pages/transcript-editor.tsx` (+ a turn-grouping helper).

## LOW
3. **Ingest of an unreadable/odd file path → `error` interview row with an ugly title.**
   - **Symptom:** a bad source path created an `interview` row with `status='error'` and title derived oddly from the raw path (`ai-interview_e2ew1_a_short`); `source_path` stored mangled.
   - **Cause:** title derived from the full (mangled) path, not the basename; an unreadable file still creates a persisted row. (The mangling itself was a test-harness artifact — Git Bash backslash munging — not the app, but the title/error-row handling is real.)
   - **Fix (`src-tauri/src/interview.rs` ingest):** derive title from the file **basename** (no path), and either don't persist a row for a file that fails to copy/probe, or make the `error` row clearly removable/retryable in the UI.

## In progress (not a bug — already addressed)
- **Long-interview performance:** fast per-task models (cleanup→Haiku, synthesis/diff→Sonnet) + bounded-parallel LLM calls already landed. Real interviews are 30+ min, so this matters; validate in the fix pass.

---
*Append new findings here as the E2E continues (synthesis / diff / chat / UI states still to exercise).*
