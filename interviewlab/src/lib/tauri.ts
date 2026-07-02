import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { mockInvoke, mockOnChatEvent } from "./dev-mock";

// dev-mock: browser-only, never active under Tauri.
// Detect whether we are running inside the real Tauri runtime. In a plain browser
// (Vite dev server at localhost:1420) this is false and the mock takes over so the
// app renders populated screens for design review; inside Tauri it is true and the
// genuine `invoke` is used, byte-for-byte unchanged.
export const IN_TAURI =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

// Single seam: every command goes through this. Real Tauri → genuine invoke;
// browser → in-memory mock. The signature matches @tauri-apps/api `invoke`.
const invoke: typeof tauriInvoke = ((cmd: string, args?: Record<string, unknown>) =>
  IN_TAURI ? tauriInvoke(cmd, args) : mockInvoke(cmd, args)) as typeof tauriInvoke;

// Mirror of the Rust `DbHealth` struct returned by the `db_health` command (see src-tauri/src/lib.rs).
export type DbHealth = {
  db_path: string;
  schema_version: number;
};

// ponytail: one thin typed wrapper around invoke; we add more commands as later milestones need them.
export function dbHealth(): Promise<DbHealth> {
  return invoke<DbHealth>("db_health");
}

// --- Cycle CRUD (Milestone 2) -------------------------------------------------
// Mirror of the Rust `Cycle` struct (src-tauri/src/cycle.rs) = the `cycle` table.
export type Cycle = {
  id: string;
  name: string;
  product_desc: string;
  // Products library: the linked library product (nullable). The inline `product_desc`
  // text is kept for back-compat; the pipeline prefers this linked product's content when set.
  product_id: string | null;
  guide: string;
  // M10a: the linked library guide (nullable). The inline `guide` text is kept for
  // back-compat; synthesis prefers this linked guide's content when set.
  guide_id: string | null;
  prev_cycle_id: string | null;
  created_at: number; // unix ms
  updated_at: number; // unix ms
};

// Mirrors Rust UpdateCycle: id selects the row, the rest overwrite the editable fields.
export type UpdateCycleInput = {
  id: string;
  name: string;
  product_desc: string;
  // Products library: the linked library product (null = no link → falls back to product_desc).
  product_id: string | null;
  guide: string;
  guide_id: string | null;
  prev_cycle_id: string | null;
};

export function listCycles(): Promise<Cycle[]> {
  return invoke<Cycle[]>("list_cycles");
}

export function getCycle(id: string): Promise<Cycle> {
  return invoke<Cycle>("get_cycle", { id });
}

export function createCycle(name: string): Promise<Cycle> {
  // Rust command takes a `req: CreateCycle` struct → nest under `req`.
  return invoke<Cycle>("create_cycle", { req: { name } });
}

export function updateCycle(input: UpdateCycleInput): Promise<Cycle> {
  return invoke<Cycle>("update_cycle", { req: input });
}

export function deleteCycle(id: string): Promise<void> {
  return invoke<void>("delete_cycle", { id });
}

// --- Interview ingest (Milestone 3) -------------------------------------------
// Mirror of the Rust `InterviewRow` (src-tauri/src/interview.rs): an interview row
// flattened with its recording's source/audio/duration/format fields.
export type InterviewRow = {
  id: string;
  cycle_id: string;
  title: string;
  status: string; // 'importing' | 'new' (ready) | 'error' | …(later milestones)
  created_at: number;
  updated_at: number;
  source_path: string | null;
  audio_path: string | null;
  duration_ms: number | null;
  format: string | null;
  bytes: number | null;
};

// Payload of the `interview://progress` Tauri event (Rust `ProgressEvent`).
export type InterviewProgress = {
  cycle_id: string;
  interview_id: string;
  status: string;
  audio_path: string | null;
  duration_ms: number | null;
  error: string | null;
};

export const INTERVIEW_PROGRESS_EVENT = "interview://progress";

export function listInterviews(cycleId: string): Promise<InterviewRow[]> {
  return invoke<InterviewRow[]>("list_interviews", { cycleId });
}

// Ingest a batch of absolute source paths into a cycle. Returns the freshly
// created rows (status 'importing'); ffmpeg prep then streams progress events.
export function addInterviewFiles(
  cycleId: string,
  paths: string[],
): Promise<InterviewRow[]> {
  return invoke<InterviewRow[]>("add_interview_files", { cycleId, paths });
}

export function renameInterview(id: string, title: string): Promise<void> {
  return invoke<void>("rename_interview", { id, title });
}

export function deleteInterview(id: string): Promise<void> {
  return invoke<void>("delete_interview", { id });
}

// --- ASR engine (Milestone 4) -------------------------------------------------
// Mirrors of the Rust ASR structs/commands (src-tauri/src/asr.rs).

// Detected ASR device for the Transcription settings Badge (Rust `DeviceInfo`).
export type DeviceInfo = {
  device: string; // "cuda" | "metal" | "cpu"
  use_gpu: boolean;
  gpu_name: string | null;
  cuda_build: boolean;
  detail: string;
  // "gpu_active" | "get_gpu_build" | "cpu_only_no_gpu" — what the Device UI should offer.
  recommendation: string;
};

// One selectable Whisper model in the catalog (Rust `ModelInfo`).
export type ModelInfo = {
  id: string;
  label: string;
  file: string;
  approx_mb: number;
  default: boolean;
  downloaded: boolean;
  // Characteristics for the picker. multilingual=false → English-only (.en).
  multilingual: boolean;
  quantized: boolean;
  speed: "fastest" | "fast" | "medium" | "slow" | "slowest";
  accuracy: "lowest" | "basic" | "good" | "high" | "highest";
  note: string;
};

// A stored transcript row (Rust `TranscriptRow`). segments_json is JSON of Segment[].
export type TranscriptRow = {
  id: string;
  interview_id: string;
  version: number;
  kind: string;
  language: string | null;
  engine: string | null;
  segments_json: string;
  created_at: number;
};

// Payload of the `asr://progress` event (Rust `AsrProgress`). progress < 0 means a
// live segment update (no percent); status drives the interview row badge. `segment`
// carries the full live segment (timing + text) as whisper decodes it, so a watching
// editor can accumulate the transcript in real time — `segment_text` is its text alone.
export type AsrProgress = {
  interview_id: string;
  status: string; // 'transcribing' | 'transcribed' | 'error'
  progress: number; // 0..100, or -1 for a live segment tick
  segment_text: string | null;
  segment: Segment | null;
  error: string | null;
};

// Payload of the `asr://model-progress` event (Rust `ModelProgress`).
export type ModelProgress = {
  model_id: string;
  downloaded_bytes: number;
  total_bytes: number;
  done: boolean;
  error: string | null;
};

export const ASR_PROGRESS_EVENT = "asr://progress";
export const MODEL_PROGRESS_EVENT = "asr://model-progress";

export function asrDevice(): Promise<DeviceInfo> {
  return invoke<DeviceInfo>("asr_device");
}

export function listModels(): Promise<ModelInfo[]> {
  return invoke<ModelInfo[]>("list_models");
}

// Kick off a model download; progress streams via MODEL_PROGRESS_EVENT.
export function downloadModel(modelId: string): Promise<void> {
  return invoke<void>("download_model", { modelId });
}

// Transcribe one interview's prepared 16k wav. Resolves with the new transcript id;
// status + percent stream via ASR_PROGRESS_EVENT. language: 'auto' | 'ru' | 'en' | …
// expectedSpeakers gates diarization: null = auto-detect the count, a number forces it.
export function transcribeInterview(
  interviewId: string,
  modelId: string,
  language: string,
  expectedSpeakers: number | null,
): Promise<string> {
  return invoke<string>("transcribe_interview", {
    interviewId,
    modelId,
    language,
    expectedSpeakers,
  });
}

// Manually stop an in-progress transcription (bug #5). Flips the per-interview cancel
// flag in the backend; whisper aborts mid-run, the interview lands on `error`, and the
// concurrency=1 queue frees. Resolves once the stop is signalled (no-op if nothing's running).
export function cancelTranscription(interviewId: string): Promise<void> {
  return invoke<void>("cancel_transcription", { interviewId });
}

export function getTranscript(
  interviewId: string,
): Promise<TranscriptRow | null> {
  return invoke<TranscriptRow | null>("get_transcript", { interviewId });
}

// --- Speaker diarization ------------------------------------------------------
// Local diarization assigns each segment a real speaker label ("S1", "S2", …) instead
// of a single bucket. It needs its own model files (a separate download from the ggml
// ASR models). transcribe_interview gained an expectedSpeakers arg (see above); these
// commands cover re-diarizing an existing transcript + the model presence/download UX.

// Payload of the `asr://diar-progress` event (Rust `DiarProgress`). Per-interview:
// drives the row's diarization badge; speakers is the detected count once status='done'.
export type DiarProgress = {
  interview_id: string;
  status: string; // 'diarizing' | 'done' | 'error'
  progress: number; // 0..100
  speakers: number | null;
};

// Payload of the `asr://diar-model-progress` event (Rust `DiarModelProgress`). Step-level:
// the diarization-model download runs a few steps (segmentation + embedding files) and
// emits one tick per step.
export type DiarModelProgress = {
  step: number;
  total_steps: number;
  label: string;
  done: boolean;
  error: string | null;
};

export const DIAR_PROGRESS_EVENT = "asr://diar-progress";
export const DIAR_MODEL_PROGRESS_EVENT = "asr://diar-model-progress";

// Are the diarization model files present on disk? Gates the Transcribe/Re-diarize UX.
export function diarizationModelsPresent(): Promise<boolean> {
  return invoke<boolean>("diarization_models_present");
}

// Kick off the diarization-model download; progress streams via DIAR_MODEL_PROGRESS_EVENT.
export function downloadDiarizationModels(): Promise<void> {
  return invoke<void>("download_diarization_models");
}

// Re-run diarization on an existing transcript with a fresh expected-speaker count.
// Resolves with the detected speaker count; progress streams via DIAR_PROGRESS_EVENT.
// expectedSpeakers: null = auto-detect, a number forces that many speakers.
export function rediarizeInterview(
  interviewId: string,
  expectedSpeakers: number | null,
): Promise<number> {
  return invoke<number>("rediarize_interview", {
    interviewId,
    expectedSpeakers,
  });
}

// Re-transcribe + re-diarize just a TIME RANGE of the audio (redo a chunk that came out
// wrong). Runs whisper on [startMs, endMs], splices the result over the stored transcript in
// that window, then re-diarizes the whole audio. Streams live progress via ASR_PROGRESS_EVENT;
// resolves with the new transcript id. The window is taken from the editor's selected segments.
export function retranscribeRange(
  interviewId: string,
  startMs: number,
  endMs: number,
  modelId: string,
  language: string,
  expectedSpeakers: number | null,
): Promise<string> {
  return invoke<string>("retranscribe_range", {
    interviewId,
    startMs,
    endMs,
    modelId,
    language,
    expectedSpeakers,
  });
}

// A saved transcription checkpoint (Rust `Checkpoint`): the partial result of a run that
// failed/crashed, so the editor can offer "resume from M:SS". null when there's nothing to resume.
export type Checkpoint = {
  interview_id: string;
  processed_ms: number; // last decoded segment end — where resume continues
  total_ms: number | null; // audio duration — resume's target end
  model_id: string;
  language: string | null;
  segments_json: string;
  updated_at: number;
};

// Read the saved checkpoint for an interview (drives the "resume" banner). null = none.
export function getTranscribeCheckpoint(
  interviewId: string,
): Promise<Checkpoint | null> {
  return invoke<Checkpoint | null>("get_transcribe_checkpoint", { interviewId });
}

// Resume a failed/crashed transcription from its checkpoint: re-transcribes only the
// remaining tail [processed_ms, total_ms], appends to the saved prefix, then diarizes the
// whole audio. Streams live progress via ASR_PROGRESS_EVENT; resolves with the transcript id.
export function resumeTranscription(
  interviewId: string,
  language: string,
  expectedSpeakers: number | null,
): Promise<string> {
  return invoke<string>("resume_transcription", {
    interviewId,
    language,
    expectedSpeakers,
  });
}

// --- Transcript editor (Milestone 5) ------------------------------------------
// Mirrors of the Rust transcript-editor structs/commands (src-tauri/src/transcript.rs).

// One transcript segment (schema §2.2 segment shape). Timing is immutable in the
// editor — only text + speaker_label are user-editable.
export type Segment = {
  start_ms: number;
  end_ms: number;
  speaker_label: string;
  text: string;
};

// A transcript version with parsed segments (Rust `TranscriptVersion`).
export type TranscriptVersion = {
  id: string;
  interview_id: string;
  version: number;
  kind: string; // 'raw' | 'cleaned' | 'edited'
  language: string | null;
  engine: string | null;
  segments: Segment[];
  created_at: number;
};

// A lightweight descriptor of an available version, for the version Select (Rust `VersionInfo`).
export type VersionInfo = {
  kind: string;
  version: number;
  created_at: number;
};

// A participant row (Rust `Participant`) = the `participant` table.
export type Participant = {
  id: string;
  interview_id: string;
  display_name: string;
  role: string; // back-compat role NAME, e.g. 'Interviewer' (derived from role_id server-side)
  role_id: string | null; // role-library FK, e.g. 'interviewer' — the id the UI resolves against `roles`
  speaker_label: string | null;
};

// Input for replacing the participant set (Rust `ParticipantInput`).
export type ParticipantInput = {
  id: string | null;
  display_name: string;
  role: string;
  role_id?: string | null; // role-library id; backend derives the role NAME from it
  speaker_label: string | null;
};

// Input for the Save action (Rust `SaveEditedInput`).
export type SaveEditedInput = {
  interview_id: string;
  segments: Segment[];
  participants: ParticipantInput[];
  language: string | null;
};

export function listTranscriptVersions(
  interviewId: string,
): Promise<VersionInfo[]> {
  return invoke<VersionInfo[]>("list_transcript_versions", { interviewId });
}

export function getTranscriptVersion(
  interviewId: string,
  kind: string,
): Promise<TranscriptVersion | null> {
  return invoke<TranscriptVersion | null>("get_transcript_version", {
    interviewId,
    kind,
  });
}

export function listParticipants(interviewId: string): Promise<Participant[]> {
  return invoke<Participant[]>("list_participants", { interviewId });
}

export function saveParticipants(
  interviewId: string,
  participants: ParticipantInput[],
): Promise<Participant[]> {
  return invoke<Participant[]>("save_participants", {
    interviewId,
    participants,
  });
}

// Save the edited segments + participants → writes the 'edited' transcript version.
// Returns the persisted version (with canonical, timing-immutable segments).
export function saveEditedTranscript(
  input: SaveEditedInput,
): Promise<TranscriptVersion> {
  return invoke<TranscriptVersion>("save_edited_transcript", { input });
}

// What import_transcript_file reports back for the success toast (Rust `ImportResult`).
export type ImportResult = {
  transcript_id: string;
  segments: number;
  speakers: number;
};

// Import a diarized transcript (.txt: `M:SS - M:SS` / speaker / text blocks) and attach it
// to an interview as its raw transcript — skips local ASR while keeping every downstream
// feature (media seek, clear, re-transcribe a range, re-diarize, clean, synthesis) working
// against the still-attached audio. Flips the interview to 'transcribed' on success.
export function importTranscriptFile(
  interviewId: string,
  path: string,
): Promise<ImportResult> {
  return invoke<ImportResult>("import_transcript_file", { interviewId, path });
}

// --- CLI adapter layer (Milestone 6, spec §7) ---------------------------------
// Mirrors of the Rust adapter structs/commands (src-tauri/src/adapter.rs).

// A capability a plugin declares (feature-cli-plugins.md §3.1). Drives the UI chips +
// graceful degradation.
export type Capability = "batch-tasks" | "streaming" | "multi-turn" | "tool-use";

// One selectable model the active plugin offers (Rust `ModelOption`), for the Settings
// "Task models" picker. `label` is the human-readable option text (falls back to `id`).
export type ModelOption = {
  id: string;
  label: string;
};

// A light summary of a discovered plugin for the Settings AI CLI tab (Rust
// `AdapterSummary`). The full manifest stays in Rust; the UI only needs this. A summary
// with `ok: false` is a MALFORMED manifest (skipped) carrying the validation `error`
// (feature-cli-plugins.md §2.2) — the UI lists it so the user can fix the file.
export type AdapterSummary = {
  id: string;
  name: string;
  version: string;
  vendor: string;
  command: string;
  auth_type: string; // 'session' | 'env' | …
  auth_note: string;
  builtin: boolean; // a bundled (compiled-in) plugin
  tasks: string[];
  capabilities: Capability[];
  runs_external_program: boolean; // adapter-program tier → "runs external program" label
  models: ModelOption[]; // the plugin's offered models for the Task-models picker (empty = CLI default)
  ok: boolean; // false = malformed manifest (see `error`)
  error?: string | null; // validation error for a malformed manifest
  source?: string | null; // folder/file the manifest loaded from
};

// The "Test CLI" probe status (Rust `ProbeStatus`, kebab-cased).
export type ProbeStatus = "available" | "not-found" | "not-logged-in" | "error";

// The probe result (Rust `ProbeResult`).
export type ProbeResult = {
  status: ProbeStatus;
  detail: string;
  version?: string | null;
};

// List all discovered plugins (bundled defaults + user-added in plugins/ + legacy
// adapters/), including malformed manifests (ok:false) so the UI can surface them.
export function listAdapters(): Promise<AdapterSummary[]> {
  return invoke<AdapterSummary[]>("list_adapters");
}

// "Rescan plugins" (feature-cli-plugins.md §2.2): re-enumerate the plugins/ + adapters/
// folders and return the fresh list. Same shape as listAdapters.
export function rescanPlugins(): Promise<AdapterSummary[]> {
  return invoke<AdapterSummary[]>("rescan_plugins");
}

// The manifest JSON Schema (feature-cli-plugins.md §3.3) for the Add-plugin dialog.
export function pluginManifestSchema(): Promise<string> {
  return invoke<string>("plugin_manifest_schema");
}

// Save (create or overwrite) a USER plugin manifest from the Settings UI. The backend
// validates `manifestJson` through the loader's own path (rejecting anything that would
// load as "(invalid plugin)") and writes plugins/<id>/manifest.json. Rejects builtin ids.
export function savePluginManifest(
  id: string,
  manifestJson: string,
): Promise<void> {
  return invoke<void>("save_plugin_manifest", { id, manifestJson });
}

// Delete a USER plugin folder (plugins/<id>). Builtin (bundled) ids are refused server-side.
export function deletePlugin(id: string): Promise<void> {
  return invoke<void>("delete_plugin", { id });
}

// Read the active adapter id (default 'claude-code').
export function getActiveAdapter(): Promise<string> {
  return invoke<string>("get_active_adapter");
}

// Persist the active adapter id (spec §4.4 "persist the choice").
export function setActiveAdapter(id: string): Promise<void> {
  return invoke<void>("set_active_adapter", { id });
}

// The per-task model buckets the user can override (the three user-facing groupings of the
// pipeline's tasks). The picker writes/reads one model id per bucket.
export type TaskModelBucket = "cleanup" | "synthesis" | "diff";

// The user's saved model override for a bucket ("" = use the plugin's per-task default).
export function getTaskModel(bucket: TaskModelBucket): Promise<string> {
  return invoke<string>("get_task_model", { bucket });
}

// Persist (or clear, with "") the user's model override for a bucket.
export function setTaskModel(
  bucket: TaskModelBucket,
  model: string,
): Promise<void> {
  return invoke<void>("set_task_model", { bucket, model });
}

// Run the two-step "Test CLI" probe for an adapter (or the active one when omitted).
export function testCli(adapterId?: string): Promise<ProbeResult> {
  return invoke<ProbeResult>("test_cli", { adapterId: adapterId ?? null });
}

// Run a task through the generic runner (M6 exposes this for the ping verify; M7–M9
// build on run_cli_task in Rust). Returns the parsed task JSON.
export function runTask(
  task: string,
  input: unknown,
  adapterId?: string,
): Promise<unknown> {
  return invoke<unknown>("run_task", {
    task,
    input,
    adapterId: adapterId ?? null,
  });
}

// The agent-facing meta-instruction doc (spec §7.4) for the "Add adapter…" dialog.
export function adapterMetaInstructions(): Promise<string> {
  return invoke<string>("adapter_meta_instructions");
}

// --- Transcript cleanup (Milestone 7, spec §6.7 / §7.3.1) ---------------------
// The "no grammar errors" pass: raw ASR → CLI cleanup → cleaned version. The Rust
// side enforces count/id/timing/label invariants and stores the `cleaned` version.

// Payload of the `cleanup://progress` event (Rust `CleanupProgress`). Batch-level:
// the cleanup runs the CLI in batches and emits one tick per batch.
export type CleanupProgress = {
  interview_id: string;
  status: string; // 'cleaning' | 'cleaned' | 'error'
  batch: number;
  total_batches: number;
  progress: number; // 0..100 (batches done / total)
  error: string | null;
};

export const CLEANUP_PROGRESS_EVENT = "cleanup://progress";

// Clean an interview's raw transcript and store it as the `cleaned` version. Resolves
// with the cleaned transcript id; progress streams via CLEANUP_PROGRESS_EVENT. The
// adapter defaults to the active one when omitted.
export function cleanTranscript(
  interviewId: string,
  adapterId?: string,
): Promise<string> {
  return invoke<string>("clean_transcript", {
    interviewId,
    adapterId: adapterId ?? null,
  });
}

// Rewrite ONE transcript segment's text via the CLI ("rewrite segment"). Sends just this
// segment's text and gets back PLAIN TEXT — the simplest shape, far less prone to the
// hallucination the whole-transcript JSON-echo cleanup invites. Resolves with the cleaned text
// (or the original unchanged when the model returns nothing usable). Stateless server-side: the
// editor applies the result to its local buffer and persists it on Save (the `edited` version).
export function rewriteSegment(
  interviewId: string,
  text: string,
  adapterId?: string,
): Promise<string> {
  return invoke<string>("rewrite_segment", {
    interviewId,
    text,
    adapterId: adapterId ?? null,
  });
}

// --- Cycle synthesis (Milestone 8, spec §8 / §7.3.2) --------------------------
// The cycle's guide is parsed into stable GOALS; a map-reduce over the role-labeled
// transcripts produces findings tied to goal_ids, each with evidence quotes. The Rust
// side validates goal_ids + evidence refs and stores the result in `synthesis`.

// A discrete research goal derived from the guide (Rust `Goal`). Ids are stable across
// waves (positional G1, G2, … or an explicit "G1:" tag) so the M9 diff can align by goal.
export type Goal = {
  id: string;
  text: string;
};

// One evidence reference on a finding (Rust `Evidence`): the interview + segment a
// verbatim quote came from, so findings are traceable.
export type Evidence = {
  interview_id: string;
  segment_id: number;
  quote: string;
};

// A validated, server-stamped finding (Rust `Finding`, §7.3.2 shape).
export type Finding = {
  id: string; // F1..Fn (stamped server-side)
  goal_id: string;
  statement: string;
  confidence: string; // 'high' | 'medium' | 'low'
  support_count: number;
  evidence: Evidence[];
  recommendation?: string;
};

// M10b: one by-role note (what a role said about a goal) — Rust `RoleNote`.
export type RoleNote = {
  role: string;
  note: string;
};

// M10b: a by-goal grouping of by-role notes — Rust `RoleBreakdownGroup`.
export type RoleBreakdownGroup = {
  goal_id: string;
  notes: RoleNote[];
};

// The full structured synthesis document (Rust `SynthesisDoc`) stored in the CYCLE row's
// synthesis.findings_json: goals + findings + open questions + (M10b) an executive summary
// and an optional by-role breakdown. The diff (M9) reads the findings/goals from here.
// A cross-interview verdict on one guide hypothesis (Rust HypothesisVerdict). `verdict` ∈
// confirmed | partially | refuted | inconclusive.
export type HypothesisVerdict = {
  id: string; // H1..
  text: string;
  verdict: string;
  confidence: string; // high | medium | low
  rationale?: string;
  evidence?: Evidence[];
};

// A cross-interview consolidated answer to one guide question (Rust QuestionAnswer). `status`
// ∈ answered | partially | not_answered.
export type QuestionAnswer = {
  id: string; // Q1..
  text: string;
  section?: string; // qualifying | main | hypothesis
  block?: string;
  status: string;
  answer?: string;
  evidence?: Evidence[];
};

export type SynthesisDoc = {
  goals: Goal[];
  findings: Finding[];
  open_questions: string[];
  // M10b additions (default empty on older rows).
  executive_summary?: string;
  by_role?: RoleBreakdownGroup[];
  // Templated-guide additions (default empty on older rows / legacy guides).
  hypotheses?: TemplateItem[];
  questions?: GuideQuestion[];
  hypothesis_verdicts?: HypothesisVerdict[];
  question_answers?: QuestionAnswer[];
};

// A stored CYCLE synthesis row (Rust `SynthesisRow`). M10b: `content_md` is the
// human-editable markdown artifact (rendered/edited via the Plate editor); `doc` is the
// structured layer the diff still reads.
export type SynthesisRow = {
  id: string;
  cycle_id: string;
  doc: SynthesisDoc;
  content_md: string;
  model_meta: string | null;
  created_at: number;
  // True once the user's markdown edits diverged from the structured doc (cleared on re-run).
  edited_diverged: boolean;
};

// --- Per-interview summary (Milestone 10b) ------------------------------------
// The MAP stage is now a stored, editable artifact per interview: a concise summary
// structured by the guide's goals (per goal: key points + supporting quotes with segment
// refs) + notable quotes/surprises. Shown in the transcript editor's Summary section.

// One supporting quote on a per-interview point (Rust `InterviewQuote`).
export type InterviewQuote = {
  segment_id: number;
  quote: string;
};

// One key point under a goal in a per-interview summary (Rust `InterviewPoint`).
export type InterviewPoint = {
  point: string;
  quotes: InterviewQuote[];
};

// One goal section in a per-interview summary (Rust `InterviewGoalSummary`).
export type InterviewGoalSummary = {
  goal_id: string;
  points: InterviewPoint[];
};

// A notable quote / surprise from one interview (Rust `NotableQuote`).
export type NotableQuote = {
  segment_id: number;
  quote: string;
  note: string;
};

// A per-interview answer to one guide question (Rust InterviewQuestionAnswer). `status` ∈
// direct | indirect | not_answered.
export type InterviewQuestionAnswer = {
  question_id: string;
  status: string;
  summary?: string;
  quotes?: InterviewQuote[];
};

// A per-interview signal on one hypothesis (Rust InterviewHypothesisSignal). `stance` ∈
// supports | contradicts | mixed | neutral.
export type InterviewHypothesisSignal = {
  hypothesis_id: string;
  stance: string;
  note?: string;
  quotes?: InterviewQuote[];
};

// The structured per-interview summary doc (Rust `InterviewSummaryDoc`).
export type InterviewSummaryDoc = {
  goals: Goal[];
  by_goal: InterviewGoalSummary[];
  notable: NotableQuote[];
  // Templated-guide additions (default empty on older rows / legacy guides).
  hypotheses?: TemplateItem[];
  questions?: GuideQuestion[];
  question_answers?: InterviewQuestionAnswer[];
  hypothesis_signals?: InterviewHypothesisSignal[];
};

// A stored per-interview summary row (Rust `InterviewSummaryRow`): structured doc +
// editable markdown.
export type InterviewSummaryRow = {
  id: string;
  cycle_id: string;
  interview_id: string;
  doc: InterviewSummaryDoc;
  content_md: string;
  model_meta: string | null;
  created_at: number;
};

// Payload of the `interview-summary://progress` event (Rust `InterviewSummaryProgress`).
export type InterviewSummaryProgress = {
  interview_id: string;
  stage: string; // 'running' | 'done' | 'error'
  progress: number; // 0..100
  error: string | null;
};

export const INTERVIEW_SUMMARY_PROGRESS_EVENT = "interview-summary://progress";

// Payload of the `synthesis://progress` event (Rust `SynthesisProgress`). Stage-level:
// the map-reduce emits one tick per interview during extract, then a reduce tick, then done.
export type SynthesisProgress = {
  cycle_id: string;
  stage: string; // 'extract' | 'reduce' | 'done' | 'error'
  done: number;
  total: number;
  progress: number; // 0..100 overall
  error: string | null;
};

export const SYNTHESIS_PROGRESS_EVENT = "synthesis://progress";

// Get the stored synthesis for a cycle (null before the first run).
export function getSynthesis(cycleId: string): Promise<SynthesisRow | null> {
  return invoke<SynthesisRow | null>("get_synthesis", { cycleId });
}

// Preview the goals derived from a cycle's current guide (for the "N goals" hint).
export function cycleGoals(cycleId: string): Promise<Goal[]> {
  return invoke<Goal[]>("cycle_goals", { cycleId });
}

// Run synthesis for a cycle: gather goals + role-labeled transcripts, map-reduce through
// the CLI, store + return the result. Progress streams via SYNTHESIS_PROGRESS_EVENT. M10b:
// also stores per-interview summaries + the editable cycle markdown artifact.
export function runSynthesis(
  cycleId: string,
  adapterId?: string,
): Promise<SynthesisRow> {
  return invoke<SynthesisRow>("run_synthesis", {
    cycleId,
    adapterId: adapterId ?? null,
  });
}

// Save the user's edit of the CYCLE synthesis markdown artifact (M10b). Returns the row.
export function saveCycleSynthesis(
  cycleId: string,
  contentMd: string,
): Promise<SynthesisRow> {
  return invoke<SynthesisRow>("save_cycle_synthesis", {
    cycleId,
    contentMd,
  });
}

// Get a stored per-interview summary (null before the first run) — Milestone 10b.
export function getInterviewSummary(
  interviewId: string,
): Promise<InterviewSummaryRow | null> {
  return invoke<InterviewSummaryRow | null>("get_interview_summary", {
    interviewId,
  });
}

// Run (or regenerate) the per-interview summary for one interview (M10b). Progress streams
// via INTERVIEW_SUMMARY_PROGRESS_EVENT.
export function runInterviewSummary(
  interviewId: string,
  adapterId?: string,
): Promise<InterviewSummaryRow> {
  return invoke<InterviewSummaryRow>("run_interview_summary", {
    interviewId,
    adapterId: adapterId ?? null,
  });
}

// Save the user's edit of a per-interview summary markdown artifact (M10b).
export function saveInterviewSummary(
  interviewId: string,
  contentMd: string,
): Promise<InterviewSummaryRow> {
  return invoke<InterviewSummaryRow>("save_interview_summary", {
    interviewId,
    contentMd,
  });
}

// --- Cycle diff (Milestone 9, spec §8.3 / §7.3.3) -----------------------------
// A findings-level diff vs the previous wave: align the current + previous syntheses'
// findings BY MEANING within each shared goal, classify each new/changed/dropped/unchanged
// with a `why`. The Rust side validates goal_ids + finding refs and stores it in `diff`.

// One diff entry's status (Rust `DiffStatus`, kebab-cased). Reuses the status-color
// vocabulary in the UI: new=ready/green, changed=importing/amber, dropped=error/red,
// unchanged=neutral.
export type DiffStatus = "new" | "changed" | "dropped" | "unchanged";

// One validated diff entry (Rust `DiffEntry`, §7.3.3). `finding_id` resolves into the
// current synthesis, `prev_finding_id` into the previous — present only where the status
// implies (new→current only, dropped→previous only, changed/unchanged→both).
export type DiffEntry = {
  status: DiffStatus;
  finding_id?: string | null;
  prev_finding_id?: string | null;
  statement: string;
  why?: string;
  // Referenced findings' confidence labels resolved at diff time (serde-default in Rust —
  // absent on rows stored before the fields shipped, hence optional).
  confidence?: string | null;
  prev_confidence?: string | null;
};

// One goal's diff entries (Rust `GoalDiff`) — the grouping the UI renders.
export type GoalDiff = {
  goal_id: string;
  entries: DiffEntry[];
};

// A goal label stored in the diff doc (Rust `DiffGoalRef`): id + aligned text.
export type DiffGoalRef = {
  id: string;
  text: string;
};

// One hypothesis compared wave-over-wave (Rust HypothesisDiffEntry). `shift` ∈ unchanged |
// strengthened | weakened | new | dropped. Verdict labels are authoritative from each
// synthesis; `why` explains the move.
export type HypothesisDiffEntry = {
  hypothesis_id: string;
  text: string;
  prev_verdict?: string | null;
  verdict?: string | null;
  shift: string;
  why?: string;
};

// The full diff document (Rust `DiffDoc`) stored in diff.diff_json: the shared goals +
// per-goal entries + a one-line summary of what changed this wave + (templated guide) the
// hypothesis verdict shifts.
export type DiffDoc = {
  goals: DiffGoalRef[];
  by_goal: GoalDiff[];
  summary: string;
  hypotheses?: HypothesisDiffEntry[];
};

// A stored diff row (Rust `DiffRow`).
export type DiffRow = {
  id: string;
  cycle_id: string;
  prev_cycle_id: string;
  doc: DiffDoc;
  created_at: number;
};

// The Diff tab's precondition state (Rust `DiffReadiness`, kebab-cased): can we run a diff,
// or which precondition is missing (drives the empty states).
export type DiffReadiness =
  | "ready"
  | "no-prev-cycle"
  | "no-current-synthesis"
  | "no-prev-synthesis";

// The precondition status the tab reads to render the right empty state vs the run action
// (Rust `DiffStatusRow`).
export type DiffStatusRow = {
  readiness: DiffReadiness;
  prev_cycle_id?: string | null;
  prev_cycle_name?: string | null;
};

// Payload of the `diff://progress` event (Rust `DiffProgress`). Single-stage: diffing → done.
export type DiffProgress = {
  cycle_id: string;
  stage: string; // 'diffing' | 'done' | 'error'
  progress: number; // 0..100
  error: string | null;
};

export const DIFF_PROGRESS_EVENT = "diff://progress";

// Get the stored diff for a cycle (null before the first run).
export function getDiff(cycleId: string): Promise<DiffRow | null> {
  return invoke<DiffRow | null>("get_diff", { cycleId });
}

// The Diff tab's precondition status (prev wave set? both syntheses present?).
export function diffStatus(cycleId: string): Promise<DiffStatusRow> {
  return invoke<DiffStatusRow>("diff_status", { cycleId });
}

// Run the findings-level diff for a cycle vs its previous wave: load both syntheses + the
// shared goals, single `cycle-diff` call, store + return. Progress streams via
// DIFF_PROGRESS_EVENT. Re-run overwrites.
export function runDiff(cycleId: string, adapterId?: string): Promise<DiffRow> {
  return invoke<DiffRow>("run_diff", {
    cycleId,
    adapterId: adapterId ?? null,
  });
}

// --- Role library (Milestone 10a, feature-roles-and-guides.md §1) -------------
// A flat, user-managed list of roles (no is_interviewer flag) replacing the old fixed
// enum. The editor's speaker→role picker pulls from this library; chips use each role's
// color. Mirror of the Rust `Role` struct (src-tauri/src/roles.rs) = the `role` table.
export type Role = {
  id: string;
  name: string;
  color: string; // hex used for the chip color
  sort: number;
  created_at: number;
  updated_at: number;
};

// Create: a name (+ optional color/sort; the id is server-generated). Mirrors Rust CreateRole.
export type CreateRoleInput = {
  name: string;
  color?: string;
  sort?: number | null;
};

// Update: id selects the row; name/color/sort overwrite. Mirrors Rust UpdateRole.
export type UpdateRoleInput = {
  id: string;
  name: string;
  color: string;
  sort: number;
};

export function listRoles(): Promise<Role[]> {
  return invoke<Role[]>("list_roles");
}

export function createRole(req: CreateRoleInput): Promise<Role> {
  return invoke<Role>("create_role", { req });
}

export function updateRole(req: UpdateRoleInput): Promise<Role> {
  return invoke<Role>("update_role", { req });
}

// Delete a role; the backend guards against deleting one still bound to participants
// (rejects with an explanatory message the caller surfaces as a toast).
export function deleteRole(id: string): Promise<void> {
  return invoke<void>("delete_role", { id });
}

// --- Guide / "Designs" library (Milestone 10a, feature-roles-and-guides.md §2) -
// A global, reusable library of interview guides authored in markdown. Each cycle runs
// against a chosen guide (cycle.guide_id). A guide's goals are DERIVED from content_md
// (stable ids → clean M9 diffs) and returned parsed. Mirror of the Rust `Guide` struct
// (src-tauri/src/guides.rs); `goals` are the derived Goal[] (same shape as M8's Goal).
// --- Templated guide (the 5 fixed blocks) -------------------------------------
// A structured guide the user fills by clicking "+ add": hypotheses to validate, research
// tasks (= the synthesis goals), qualifying questions, main questions grouped by theme, and
// hypothesis questions. Stored as `template` (Rust GuideTemplate); the backend renders
// content_md canonically from it. Empty template → a legacy free-markdown guide.

// One item in a template block (Rust TemplateItem). Ids are stamped server-side: hypotheses
// H1.., tasks G1.. (the goal ids), every question Q1.. (global, document order).
export type TemplateItem = {
  id: string;
  text: string;
};

// One themed sub-block of main questions (Rust QuestionBlock).
export type QuestionBlock = {
  title: string;
  questions: TemplateItem[];
};

// The structured guide template (Rust GuideTemplate). All blocks optional/empty for a
// free-markdown guide.
export type GuideTemplate = {
  hypotheses: TemplateItem[];
  tasks: TemplateItem[];
  qualifying_questions: TemplateItem[];
  main_blocks: QuestionBlock[];
  hypothesis_questions: TemplateItem[];
};

// One guide question flattened with its section context (Rust GuideQuestion).
export type GuideQuestion = {
  id: string;
  text: string;
  section: string; // "qualifying" | "main" | "hypothesis"
  block?: string;
};

// An empty template — the starting shape for a new structured guide.
export const EMPTY_TEMPLATE: GuideTemplate = {
  hypotheses: [],
  tasks: [],
  qualifying_questions: [],
  main_blocks: [],
  hypothesis_questions: [],
};

export function templateIsEmpty(t: GuideTemplate | undefined | null): boolean {
  if (!t) return true;
  return (
    t.hypotheses.length === 0 &&
    t.tasks.length === 0 &&
    t.qualifying_questions.length === 0 &&
    t.hypothesis_questions.length === 0 &&
    t.main_blocks.every((b) => b.questions.length === 0 && b.title.trim() === "")
  );
}

// Re-stamp stable ids + trim/drop blanks, mirroring Rust GuideTemplate::normalized: hypotheses
// → H1.., tasks → G1.., every question Q1.. (global, document order). One client-side source of
// truth shared by the structured editor + the browser dev-mock (the real backend re-normalizes
// authoritatively on write).
export function normalizeTemplate(t: GuideTemplate): GuideTemplate {
  const stamp = (items: TemplateItem[], prefix: string, start: number): [TemplateItem[], number] => {
    const out: TemplateItem[] = [];
    let n = start;
    for (const it of items) {
      const text = (it.text ?? "").trim();
      if (!text) continue;
      out.push({ id: `${prefix}${n}`, text });
      n += 1;
    }
    return [out, n];
  };
  const [hypotheses] = stamp(t.hypotheses ?? [], "H", 1);
  const [tasks] = stamp(t.tasks ?? [], "G", 1);
  let q = 1;
  const [qualifying_questions, n1] = stamp(t.qualifying_questions ?? [], "Q", q);
  q = n1;
  const main_blocks: QuestionBlock[] = [];
  for (const block of t.main_blocks ?? []) {
    const [questions, n2] = stamp(block.questions ?? [], "Q", q);
    q = n2;
    const title = (block.title ?? "").trim();
    if (!title && questions.length === 0) continue;
    main_blocks.push({ title, questions });
  }
  const [hypothesis_questions] = stamp(t.hypothesis_questions ?? [], "Q", q);
  return { hypotheses, tasks, qualifying_questions, main_blocks, hypothesis_questions };
}

// The goals (Rust Goal[]) derived from a template's tasks — the synthesis spine.
export function templateGoals(t: GuideTemplate): Goal[] {
  return t.tasks.map((x) => ({ id: x.id, text: x.text }));
}

// Every guide question flattened with section context, in document order.
export function templateQuestions(t: GuideTemplate): GuideQuestion[] {
  const out: GuideQuestion[] = [];
  for (const it of t.qualifying_questions) out.push({ id: it.id, text: it.text, section: "qualifying" });
  for (const b of t.main_blocks)
    for (const it of b.questions) out.push({ id: it.id, text: it.text, section: "main", block: b.title });
  for (const it of t.hypothesis_questions) out.push({ id: it.id, text: it.text, section: "hypothesis" });
  return out;
}

// Render a (normalized) template into the canonical markdown guide, mirroring Rust
// render_template_md: tasks under "## Goals" so deriveGoals re-reads identical ids.
export function renderTemplateMd(t: GuideTemplate): string {
  if (templateIsEmpty(t)) return "";
  const lines: string[] = [];
  const section = (heading: string, items: TemplateItem[]) => {
    if (items.length === 0) return;
    lines.push(`## ${heading}`, "");
    for (const it of items) lines.push(`- ${it.id}: ${it.text}`);
    lines.push("");
  };
  section("Hypotheses", t.hypotheses);
  section("Goals", t.tasks);
  section("Qualifying questions", t.qualifying_questions);
  if (t.main_blocks.some((b) => b.title.trim() !== "" || b.questions.length > 0)) {
    lines.push("## Main questions", "");
    t.main_blocks.forEach((b, i) => {
      lines.push(`### ${b.title.trim() || `Block ${i + 1}`}`, "");
      for (const it of b.questions) lines.push(`- ${it.id}: ${it.text}`);
      lines.push("");
    });
  }
  section("Hypothesis questions", t.hypothesis_questions);
  return lines.join("\n").trimEnd();
}

export type Guide = {
  id: string;
  name: string;
  content_md: string;
  goals: Goal[];
  template: GuideTemplate;
  created_at: number;
  updated_at: number;
};

// Create needs a name (+ optional markdown body and/or structured template). Mirrors Rust
// CreateGuide.
export type CreateGuideInput = {
  name: string;
  content_md?: string;
  template?: GuideTemplate;
};

// Update: id selects the row; name + content_md/template overwrite (goals + content_md
// re-derived/re-rendered server-side).
export type UpdateGuideInput = {
  id: string;
  name: string;
  content_md: string;
  template?: GuideTemplate;
};

export function listGuides(): Promise<Guide[]> {
  return invoke<Guide[]>("list_guides");
}

export function getGuide(id: string): Promise<Guide | null> {
  return invoke<Guide | null>("get_guide", { id });
}

export function createGuide(req: CreateGuideInput): Promise<Guide> {
  return invoke<Guide>("create_guide", { req });
}

export function updateGuide(req: UpdateGuideInput): Promise<Guide> {
  return invoke<Guide>("update_guide", { req });
}

export function deleteGuide(id: string): Promise<void> {
  return invoke<void>("delete_guide", { id });
}

// --- Products library (ui-backlog.md "Products library"; req #2 product context) ----
// A global, reusable library of product descriptions authored in markdown, mirroring the
// guide library. Each cycle references a product (cycle.product_id); the product's content
// feeds the ASR initial_prompt + cleanup + synthesis prompts. Mirror of the Rust `Product`
// struct (src-tauri/src/product.rs). ponytail: a product is plain markdown — no derived
// goals like a guide — so this is the guide API minus `goals`.
export type Product = {
  id: string;
  name: string;
  content_md: string;
  created_at: number;
  updated_at: number;
};

// Create only needs a name (+ optional markdown body). Mirrors Rust CreateProduct.
export type CreateProductInput = {
  name: string;
  content_md?: string;
};

// Update: id selects the row; name + content_md overwrite. Mirrors Rust UpdateProduct.
export type UpdateProductInput = {
  id: string;
  name: string;
  content_md: string;
};

export function listProducts(): Promise<Product[]> {
  return invoke<Product[]>("list_products");
}

export function getProduct(id: string): Promise<Product | null> {
  return invoke<Product | null>("get_product", { id });
}

export function createProduct(req: CreateProductInput): Promise<Product> {
  return invoke<Product>("create_product", { req });
}

export function updateProduct(req: UpdateProductInput): Promise<Product> {
  return invoke<Product>("update_product", { req });
}

export function deleteProduct(id: string): Promise<void> {
  return invoke<void>("delete_product", { id });
}

// --- Glossary (docs/transcription-terminology.md) ----------------------------
// A per-product, focused `term → canonical` list that anchors anglicisms / technical terms /
// local product names across the pipeline: it feeds the whisper initial_prompt (so the ASR gets
// the terms right up-front) and every cleanup/rewrite prompt (so terms normalize consistently).
// `canonical` is the authoritative spelling; `aliases` are the garbled/variant forms the ASR
// produces. Mirror of the Rust `GlossaryTerm` (src-tauri/src/glossary.rs).
export type GlossaryTerm = {
  id: string;
  product_id: string;
  canonical: string;
  aliases: string[];
  notes: string;
  created_at: number;
  updated_at: number;
};

export type CreateGlossaryTermInput = {
  product_id: string;
  canonical: string;
  aliases?: string[];
  notes?: string;
};

export type UpdateGlossaryTermInput = {
  id: string;
  canonical: string;
  aliases?: string[];
  notes?: string;
};

// A bare term used for bulk-add (accepting suggestions or importing).
export type NewGlossaryTerm = {
  canonical: string;
  aliases?: string[];
  notes?: string;
};

// A model-suggested candidate (B/C). `reason` explains why it's worth adding; it is NOT
// persisted — only canonical/aliases/notes become a term on accept.
export type SuggestedTerm = {
  canonical: string;
  aliases: string[];
  notes: string;
  reason: string;
};

// The result of a suggest run: the candidates + the product they'd be saved to (resolved from
// the interview's cycle). product_id is null when the cycle has no LINKED product.
export type SuggestResult = {
  product_id: string | null;
  product_name: string | null;
  terms: SuggestedTerm[];
};

export function listGlossaryTerms(productId: string): Promise<GlossaryTerm[]> {
  return invoke<GlossaryTerm[]>("list_glossary_terms", { productId });
}

export function createGlossaryTerm(req: CreateGlossaryTermInput): Promise<GlossaryTerm> {
  return invoke<GlossaryTerm>("create_glossary_term", { req });
}

export function updateGlossaryTerm(req: UpdateGlossaryTermInput): Promise<GlossaryTerm> {
  return invoke<GlossaryTerm>("update_glossary_term", { req });
}

export function deleteGlossaryTerm(id: string): Promise<void> {
  return invoke<void>("delete_glossary_term", { id });
}

export function addGlossaryTerms(
  productId: string,
  terms: NewGlossaryTerm[],
): Promise<GlossaryTerm[]> {
  return invoke<GlossaryTerm[]>("add_glossary_terms", { productId, terms });
}

// B — mine candidate terms from an interview's transcript + product context.
export function suggestGlossaryTerms(
  interviewId: string,
  adapterId?: string,
): Promise<SuggestResult> {
  return invoke<SuggestResult>("suggest_glossary_terms", { interviewId, adapterId });
}

// C — mine candidate terms from the user's own raw→edited corrections.
export function suggestGlossaryTermsFromEdits(
  interviewId: string,
  adapterId?: string,
): Promise<SuggestResult> {
  return invoke<SuggestResult>("suggest_glossary_terms_from_edits", { interviewId, adapterId });
}

// --- Cycle chat (Milestone 11 Phase A, feature-cycle-chat.md) -----------------
// The grounded streaming Q&A side panel. Threads + messages persist per cycle; a turn
// streams tokens via the chat://<thread_id> Tauri event. Mirrors the Rust chat.rs types.

// A chat thread row (Rust `ChatThread`) = the chat_thread table (migration 0004).
export type ChatThread = {
  id: string;
  cycle_id: string;
  title: string;
  session_id: string | null; // Claude Code --resume id (null until turn 1 completes)
  created_at: number;
  updated_at: number;
};

// One parsed citation (Rust chat.rs `Citation`, kebab/snake kinds). Stored in a message's
// citations_json; the panel renders each as a clickable chip.
export type ChatCitation =
  | { kind: "finding"; finding_id: string }
  | { kind: "interview"; interview_id: string }
  | { kind: "segment"; interview_id: string; segment_id: number };

// A chat message row (Rust `ChatMessage`) = the chat_message table.
export type ChatMessage = {
  id: string;
  thread_id: string;
  role: "user" | "assistant";
  content: string;
  citations_json: string; // JSON array of ChatCitation
  status: "streaming" | "complete" | "error";
  error: string | null;
  cost_usd: number | null;
  created_at: number;
};

// The streamed event payload on chat://<thread_id> (Rust `ChatEvent`, tagged `kind`).
// `action` (Phase B): one processed whitelisted action from the assistant's turn —
// emitted BEFORE `done` so the panel can render the chip live; `summary` is the short
// human string (Russian) the chip shows.
export type ChatEvent =
  | { kind: "token"; thread_id: string; text: string }
  | {
      kind: "done";
      thread_id: string;
      message_id: string;
      session_id: string | null;
      cost_usd: number | null;
    }
  | { kind: "error"; thread_id: string; message: string }
  | {
      kind: "action";
      thread_id: string;
      tool_call_id: string;
      tool: string;
      status: "applied" | "rejected" | "failed";
      summary: string;
    };

// The per-thread event name a turn streams on.
export function chatEventName(threadId: string): string {
  return `chat://${threadId}`;
}

export function listChatThreads(cycleId: string): Promise<ChatThread[]> {
  return invoke<ChatThread[]>("list_chat_threads", { cycleId });
}

export function createChatThread(
  cycleId: string,
  title?: string,
): Promise<ChatThread> {
  return invoke<ChatThread>("create_chat_thread", {
    cycleId,
    title: title ?? null,
  });
}

export function renameChatThread(
  threadId: string,
  title: string,
): Promise<ChatThread> {
  return invoke<ChatThread>("rename_chat_thread", { threadId, title });
}

export function deleteChatThread(threadId: string): Promise<void> {
  return invoke<void>("delete_chat_thread", { threadId });
}

export function getChatMessages(threadId: string): Promise<ChatMessage[]> {
  return invoke<ChatMessage[]>("get_chat_messages", { threadId });
}

// Persist a user message (assistant-ui's onNew persists before sending the turn).
export function cycleChatAppend(
  threadId: string,
  content: string,
): Promise<ChatMessage> {
  return invoke<ChatMessage>("cycle_chat_append", { threadId, content });
}

// Send a chat turn. Returns immediately; tokens stream via the chat://<thread_id> event.
// The user message must already be persisted (cycleChatAppend).
export function cycleChatSend(
  threadId: string,
  cycleId: string,
  text: string,
  adapterId?: string,
): Promise<void> {
  return invoke<void>("cycle_chat_send", {
    threadId,
    cycleId,
    text,
    adapterId: adapterId ?? null,
  });
}

// Cancel (Stop) the in-flight turn for a thread.
export function cycleChatCancel(threadId: string): Promise<void> {
  return invoke<void>("cycle_chat_cancel", { threadId });
}

// --- Chat actions (M11 Phase B) -------------------------------------------------
// A chat_tool_call row (Rust `ChatToolCall`): one processed whitelisted action from an
// assistant turn. `kind` is always 'write' today; result_json carries { summary, … };
// undo_token (applied rows only) is what undo_chat_action consumes.
export type ChatToolCall = {
  id: string;
  message_id: string;
  thread_id: string;
  tool: string;
  kind: string;
  args_json: string;
  result_json: string | null;
  status: "applied" | "rejected" | "failed" | "undone";
  error: string | null;
  undo_token: string | null;
  undone_at: number | null;
  created_at: number;
};

// All processed actions for a thread (for re-rendering chips on reload).
export function listChatToolCalls(threadId: string): Promise<ChatToolCall[]> {
  return invoke<ChatToolCall[]>("list_chat_tool_calls", { threadId });
}

// Undo one APPLIED action (consumes its undo_token). Returns the updated row
// (status 'undone', undone_at stamped).
export function undoChatAction(toolCallId: string): Promise<ChatToolCall> {
  return invoke<ChatToolCall>("undo_chat_action", { toolCallId });
}

// Subscribe to a thread's stream. Real Tauri → webview event on chat://<thread_id>;
// browser → the dev-mock bus. Returns an unlisten fn (matches the Tauri contract).
export function onChatEvent(
  threadId: string,
  handler: (e: ChatEvent) => void,
): () => void {
  if (!IN_TAURI) {
    return mockOnChatEvent(threadId, handler);
  }
  const unlisten = getCurrentWebview().listen<ChatEvent>(
    chatEventName(threadId),
    (e) => handler(e.payload),
  );
  return () => {
    unlisten.then((fn) => fn());
  };
}

// --- Guide coverage (v3 B1, docs/v3-roast-and-plan.md) --------------------------
// "Did we ask everything?" — the LLM maps every guide goal/question of an interview's
// cycle to covered | partial | missed with evidence quotes, an overall 0-100 score, and
// suggested follow-up questions. Mirrors the Rust coverage.rs structs.

// One guide item's coverage status.
export type CoverageStatus = "covered" | "partial" | "missed";

// One evidence reference: transcript segment index + a short verbatim quote.
export type CoverageEvidence = {
  segment_id: number;
  quote: string;
};

// One guide item's verdict (Rust `CoverageItem`). id/text/kind/section are stamped
// server-side from the GUIDE; only status/evidence/note come from the model.
export type CoverageItem = {
  id: string; // G1.. (goal) or Q1.. (question)
  text: string;
  kind: "goal" | "question";
  section?: string; // questions only: 'qualifying' | 'main' | 'hypothesis'
  status: CoverageStatus;
  evidence: CoverageEvidence[];
  note?: string;
};

// A suggested follow-up question for a missed/partial item (Rust `CoverageFollowUp`).
// related_id points at the CoverageItem it targets ("" = a general suggestion).
export type CoverageFollowUp = {
  related_id: string;
  question: string;
};

// The full validated coverage document (Rust `CoverageDoc`).
export type CoverageDoc = {
  items: CoverageItem[];
  score: number; // 0..100
  summary: string;
  follow_ups: CoverageFollowUp[];
};

// A stored coverage row (Rust `CoverageRow`). One per interview; re-runs overwrite.
export type CoverageRow = {
  interview_id: string;
  doc: CoverageDoc;
  model_meta: string | null;
  created_at: number;
  updated_at: number;
};

// Payload of the `coverage://progress` event (Rust `CoverageProgress`), for the global
// task center + the coverage panel.
export type CoverageProgress = {
  interview_id: string;
  stage: string; // 'started' | 'running' | 'done' | 'error'
  progress: number; // 0..100
  error: string | null;
};

export const COVERAGE_PROGRESS_EVENT = "coverage://progress";

// Run (or re-run) the guide-coverage analysis for one interview. Progress streams via
// COVERAGE_PROGRESS_EVENT; resolves with the stored coverage row.
export function runGuideCoverage(
  interviewId: string,
  adapterId?: string,
): Promise<CoverageRow> {
  return invoke<CoverageRow>("run_guide_coverage", {
    interviewId,
    adapterId: adapterId ?? null,
  });
}

// Get the stored coverage doc for an interview (null before the first run).
export function getGuideCoverage(
  interviewId: string,
): Promise<CoverageRow | null> {
  return invoke<CoverageRow | null>("get_guide_coverage", { interviewId });
}

// --- Guide draft generation (v3 B1) ---------------------------------------------
// Generate a guide DRAFT from a product + the researcher's research questions: the LLM
// returns a structured template (цели / гипотезы / вопросные блоки) and the backend
// stores a new Guide named "Draft: <product> (<date>)" with canonically-rendered,
// derive_goals-compatible content_md. Resolves with the stored guide, ready to edit/link.
export function generateGuideDraft(
  productId: string,
  researchQuestions: string,
  adapterId?: string,
): Promise<Guide> {
  return invoke<Guide>("generate_guide_draft", {
    productId,
    researchQuestions,
    adapterId: adapterId ?? null,
  });
}
