# Comprehensive error logging

InterviewLab logs **every notable error** — with special depth around the four heavy,
fragile subsystems: the local **AI CLI integration**, **ASR/transcription**, transcript
**cleanup**, and **synthesis/diff**. Before this, the backend only had scattered
`eprintln!`/`println!` (mostly in tests), so a real failure in a packaged build left no
trace. Now there is one durable, structured log.

## Where the log lives

A single global logger (`src-tauri/src/logging.rs`) tees every record to:

1. **stderr** — so `npm run tauri dev` / `cargo test -- --nocapture` keep showing output, and
2. a **rolling file** at the OS app-log dir:
   - Windows: `%APPDATA%\com.interviewlab.app\logs\interviewlab.log`
   - macOS: `~/Library/Logs/com.interviewlab.app/interviewlab.log`
   - Linux: `~/.local/share/com.interviewlab.app/logs/interviewlab.log`

The file rolls to `interviewlab.log.old` past 8 MB (one backup kept). The frontend can
fetch the exact path via the `log_file_path` Tauri command (e.g. for an "Open logs" button).

It is installed as the **global `log` logger**, so errors that libraries emit through the
`log` facade are captured too, on top of our own `log::error!/warn!/info!/debug!` calls.
A **panic hook** routes panics (location + payload + thread) into the same file, so a crash
on a background ASR/cleanup task is no longer silent.

## Verbosity

Default: our crate logs at `DEBUG`, third-party crates at `WARN` (so library errors land
but their chatter doesn't drown ours). Override at launch with the `INTERVIEWLAB_LOG` env
var — `off | error | warn | info | debug | trace` — handy when an agent wants the full
firehose while reproducing a bug:

```bash
INTERVIEWLAB_LOG=trace npm run tauri dev
```

## Record format

One self-contained line per record (greppable):

```
2026-06-25T12:34:56.789+03:00  ERROR  interviewlab_lib::cleanup  cleanup.rs:761  [E-CLEAN-GIVEUP] cleanup batch GAVE UP (ids 60..=119, 60 segments): …
```

`timestamp  LEVEL  target(module)  file:line  message`.

## Agent-navigable error codes

Every notable error message **starts with a stable, greppable code** `[E-<SUBSYS>-<KIND>]`
so an AI agent (or a human) can triage fast and act:

- `grep '\[E-' interviewlab.log` → enumerate every failure class that fired.
- Map a code → a known remedy without parsing prose.
- Correlate a user-visible toast with the exact backend code path.

The codes are the single source of truth in `logging::codes` (each documented with the
typical **fix:** an agent can apply). They are **append-only** — never reuse or repurpose a
code, so historical logs stay interpretable. Messages also carry a `hint:`/`fix:` clause and
the full context (ids, sizes, the CLI's stderr) so the same line serves a person and an agent.

| Code | Meaning / typical fix |
|------|-----------------------|
| `E-CLI-SPAWN` | CLI binary couldn't start — not installed / not on PATH. Fix: install it or correct `command` in the manifest. |
| `E-CLI-TIMEOUT` | CLI exceeded its timeout and was killed. Fix: raise `io.timeout_sec`, shrink payload, check the model isn't overloaded. |
| `E-CLI-EXIT` | CLI exited non-zero (full stderr captured). Fix: act on the stderr — often auth/quota/bad-flag. |
| `E-CLI-PARSE` | CLI output unparseable as JSON after a retry. Fix: check `--output-format` + `result_extract`; model may wrap JSON in prose. |
| `E-CLI-CONFIG` | Misconfig before spawn (payload too big, missing task/io). Fix: correct the manifest or reduce input. |
| `E-CLI-AUTH` | Round-trip looks like an auth failure. Fix: log the CLI in (`claude login`) or set the API-key env var. |
| `E-CLI-PLUGIN` | A plugin manifest was malformed and skipped. Fix: correct it against `manifest.schema.json`. |
| `E-ASR-MODEL-MISSING` | whisper model weights missing. Fix: download the model in Settings. |
| `E-ASR-AUDIO-MISSING` | Prepared 16k wav missing. Fix: re-run ingest. |
| `E-ASR-DECODE` | whisper.cpp decode failed. Fix: try CPU, a smaller model, check VRAM. |
| `E-ASR-TIMEOUT` | Watchdog killed a runaway/stuck run. Fix: check the audio has speech. |
| `E-ASR-DIARIZE` | Diarization failed (NON-FATAL, single speaker kept). Fix: ensure diar models present + CPU free; retry re-diarize. |
| `E-ASR-DOWNLOAD` | A model / diar-model download failed. Fix: check network/proxy + disk. |
| `E-ASR-STORE` | Transcribed OK but persisting failed. Fix: check DB/disk. |
| `E-CLEAN-ALIGN` | Model broke the segment count/id invariant on a batch. Fix: usually transient; smaller batch / stronger model if it recurs. |
| `E-CLEAN-SHAPE` | Cleanup output had the wrong JSON shape. Fix: check the cleanup schema + model. |
| `E-CLEAN-GIVEUP` | A cleanup batch gave up after retries. Fix: see the preceding align/shape warnings. |
| `E-CLEAN-INVARIANT` | Post-cleanup invariant failed (count/timing/label drift) — refused to store. Fix: report it; transcript left intact. |
| `E-CLEAN-STORE` | Cleaned OK but storing failed. Fix: check DB/disk. |
| `E-SYN-EXTRACT` | One interview's MAP extraction failed/empty (NON-FATAL, its points dropped). Fix: re-run; check that transcript + the CLI. |
| `E-SYN-REDUCE` | REDUCE stage failed (FATAL — no findings). Fix: check the CLI + reduce schema. |
| `E-SYN-STORE` | Synthesis/summary succeeded but storing failed. Fix: check DB/disk. |
| `E-SYN-NO-GOALS` | No goals derivable from the guide. Fix: add a Goals section. |
| `E-SYN-NO-INTERVIEWS` | No transcribed interviews. Fix: transcribe at least one first. |
| `E-DIFF-RUN` | The diff run failed. Fix: ensure both waves are synthesized; check the CLI. |
| `E-DIFF-STORE` | Diff produced but storing failed. Fix: check DB/disk. |
| `E-CHAT-SPAWN` | Chat CLI failed to start. Fix: same as `E-CLI-SPAWN`. |
| `E-CHAT-NO-ANSWER` | Chat CLI produced no answer (non-zero exit; stderr captured). Fix: see stderr. |
| `E-CHAT-TURN` | A chat turn failed for another reason. Fix: see the message. |
| `E-INGEST-COPY` | Copying source media into the cycle failed. Fix: check path/disk/permissions. |
| `E-INGEST-TRANSCODE` | ffmpeg transcode → 16k wav failed. Fix: source may be corrupt/non-media/unsupported codec. |
| `E-DB-INIT` | Database init failed at launch (FATAL). Fix: check app-data dir is writable + DB not corrupt. |

## Adding a new error

1. Log it with the right level: `error!` for a failure the user feels, `warn!` for a
   recovered/degraded path, `info!` for lifecycle milestones, `debug!` for detail.
2. Prefix the message with a code from `logging::codes` (add a new append-only code there if
   none fits, with its `fix:` note), then describe the failure **as fully as possible**:
   include the ids/sizes/paths involved and, for a CLI failure, the captured stderr
   (use `logging::truncate` for bulky stdout/payloads).
3. Use a `target:` of `"interviewlab::<module>"` so the module is obvious in the log.
