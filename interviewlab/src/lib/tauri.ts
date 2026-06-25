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

export function deleteInterview(id: string): Promise<void> {
  return invoke<void>("delete_interview", { id });
}

// --- ASR engine (Milestone 4) -------------------------------------------------
// Mirrors of the Rust ASR structs/commands (src-tauri/src/asr.rs).

// Detected ASR device for the Transcription settings Badge (Rust `DeviceInfo`).
export type DeviceInfo = {
  device: string; // "cuda" | "cpu"
  use_gpu: boolean;
  gpu_name: string | null;
  cuda_build: boolean;
  detail: string;
};

// One selectable Whisper model in the catalog (Rust `ModelInfo`).
export type ModelInfo = {
  id: string;
  label: string;
  file: string;
  approx_mb: number;
  default: boolean;
  downloaded: boolean;
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
// live segment-text update (no percent); status drives the interview row badge.
export type AsrProgress = {
  interview_id: string;
  status: string; // 'transcribing' | 'transcribed' | 'error'
  progress: number; // 0..100, or -1 for a segment-text tick
  segment_text: string | null;
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

// Rewrite ONE transcript segment's text via the CLI ("хуйня, переписывай"). Sends just this
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
export type SynthesisDoc = {
  goals: Goal[];
  findings: Finding[];
  open_questions: string[];
  // M10b additions (default empty on older rows).
  executive_summary?: string;
  by_role?: RoleBreakdownGroup[];
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

// The structured per-interview summary doc (Rust `InterviewSummaryDoc`).
export type InterviewSummaryDoc = {
  goals: Goal[];
  by_goal: InterviewGoalSummary[];
  notable: NotableQuote[];
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

// The full diff document (Rust `DiffDoc`) stored in diff.diff_json: the shared goals +
// per-goal entries + a one-line summary of what changed this wave.
export type DiffDoc = {
  goals: DiffGoalRef[];
  by_goal: GoalDiff[];
  summary: string;
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
export type Guide = {
  id: string;
  name: string;
  content_md: string;
  goals: Goal[];
  created_at: number;
  updated_at: number;
};

// Create only needs a name (+ optional markdown body). Mirrors Rust CreateGuide.
export type CreateGuideInput = {
  name: string;
  content_md?: string;
};

// Update: id selects the row; name + content_md overwrite (goals re-derived server-side).
export type UpdateGuideInput = {
  id: string;
  name: string;
  content_md: string;
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
export type ChatEvent =
  | { kind: "token"; thread_id: string; text: string }
  | {
      kind: "done";
      thread_id: string;
      message_id: string;
      session_id: string | null;
      cost_usd: number | null;
    }
  | { kind: "error"; thread_id: string; message: string };

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
