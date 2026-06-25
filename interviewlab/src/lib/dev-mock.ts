// dev-mock: browser-only, never active under Tauri.
//
// An in-memory stand-in for the Tauri Rust backend so the app renders populated,
// realistic screens when loaded in a plain browser (Vite at localhost:1420, no
// Tauri runtime). This exists purely for design/screenshot review and is wired in
// behind a runtime `IN_TAURI` check in tauri.ts + interviews-tab.tsx. It MUST
// never run inside the real Tauri app.
//
// Every exported function mirrors a real `invoke` command 1:1 (same command name,
// same args, same return type as the genuine Rust commands). Shapes are taken from
// tauri.ts (DbHealth / Cycle / InterviewRow / InterviewProgress) and the Rust
// status vocabulary in src-tauri/src/interview.rs (importing | new | error).

import type {
  AdapterSummary,
  AsrProgress,
  ChatEvent,
  ChatMessage,
  ChatThread,
  CleanupProgress,
  CreateGuideInput,
  CreateRoleInput,
  Cycle,
  DbHealth,
  DeviceInfo,
  DiarModelProgress,
  DiarProgress,
  DiffDoc,
  DiffProgress,
  DiffRow,
  DiffStatusRow,
  Goal,
  Guide,
  InterviewProgress,
  InterviewRow,
  InterviewSummaryDoc,
  InterviewSummaryProgress,
  InterviewSummaryRow,
  ModelInfo,
  ModelProgress,
  Participant,
  ParticipantInput,
  ProbeResult,
  Product,
  CreateProductInput,
  UpdateProductInput,
  GlossaryTerm,
  CreateGlossaryTermInput,
  UpdateGlossaryTermInput,
  NewGlossaryTerm,
  SuggestResult,
  SuggestedTerm,
  Role,
  Segment,
  SynthesisDoc,
  SynthesisProgress,
  SynthesisRow,
  TranscriptRow,
  TranscriptVersion,
  UpdateCycleInput,
  UpdateGuideInput,
  UpdateRoleInput,
  VersionInfo,
} from "./tauri";
import { MOCK_AUDIO_DATA_URI } from "./mock-audio";

// --- tiny helpers -------------------------------------------------------------

function uuid(): string {
  // crypto.randomUUID is available in all modern browsers (dev-only path).
  return crypto.randomUUID();
}

const now = Date.now();
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

// --- seed store ---------------------------------------------------------------

// Stable ids so prev_cycle_id can point at a real cycle and interviews can be
// attached to the populated one.
const ID = {
  onboarding: "11111111-1111-4111-8111-111111111111",
  pricing: "22222222-2222-4222-8222-222222222222",
  activation: "33333333-3333-4333-8333-333333333333",
  churn: "44444444-4444-4444-8444-444444444444",
};

// Stable guide ids (M10a) so the Activation cycle can link to a library guide and the
// Guides library renders populated for design review.
const GUIDE_ID = {
  activation: "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d",
  pricing: "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb7e",
};

// Stable product ids (Products library) so the Activation cycle can link to a library
// product and the Products library renders populated (markdown RENDERED) for design review.
const PRODUCT_ID = {
  acme: "7c1deb4d-3b7d-4bad-9bdd-2b0d7b3dca01",
};

const cycles: Cycle[] = [
  {
    id: ID.activation,
    name: "Activation deep-dive",
    product_desc:
      "# Acme Analytics\n\nA self-serve product analytics tool for early-stage SaaS teams. " +
      "Users connect a data source, define key events, and get funnels + retention out of the box. " +
      "The activation milestone is **first funnel created within 24h of signup**.\n\n" +
      "Primary persona: a technical founder or first PM wiring up tracking before launch.",
    // Products library: linked to the Acme product in the library (preferred over inline).
    product_id: PRODUCT_ID.acme,
    guide:
      "Goals:\n" +
      "- G1: Why do new accounts stall before creating their first funnel?\n" +
      "- G2: Which onboarding step causes the most confusion (source connect vs. event mapping)?\n" +
      "- G3: What would make someone invite a teammate in week one?\n\n" +
      "Target conclusions:\n" +
      "- A ranked list of activation blockers with supporting quotes.\n" +
      "- A recommendation on whether to add a guided setup wizard.",
    // M10a: linked to the Activation guide in the library (preferred over the inline text).
    guide_id: GUIDE_ID.activation,
    prev_cycle_id: ID.onboarding,
    created_at: now - 9 * DAY,
    updated_at: now - 2 * HOUR,
  },
  {
    id: ID.onboarding,
    name: "Onboarding · Wave 3",
    product_desc:
      "Third wave of onboarding research following the new signup flow. Focus on the first-run " +
      "experience and time-to-value.",
    product_id: null,
    // Same guide goals (stable G1/G2/G3 ids) as the Activation wave so the M9 diff can
    // align findings by goal across the two waves (spec §8.3: goals reused → stable ids).
    guide:
      "Goals:\n" +
      "- G1: Why do new accounts stall before creating their first funnel?\n" +
      "- G2: Which onboarding step causes the most confusion (source connect vs. event mapping)?\n" +
      "- G3: What would make someone invite a teammate in week one?\n\n" +
      "Target conclusions:\n- A ranked list of activation blockers.",
    // The previous wave reuses the SAME library guide (stable goal ids → clean M9 diff).
    guide_id: GUIDE_ID.activation,
    prev_cycle_id: null,
    created_at: now - 47 * DAY,
    updated_at: now - 41 * DAY,
  },
  {
    id: ID.pricing,
    name: "Pricing interviews Q2",
    product_desc: "",
    product_id: null,
    guide: "",
    guide_id: GUIDE_ID.pricing,
    prev_cycle_id: null,
    created_at: now - 23 * DAY,
    updated_at: now - 20 * DAY,
  },
  {
    id: ID.churn,
    name: "Churn signals · SMB",
    product_desc: "",
    product_id: null,
    guide: "",
    guide_id: null,
    prev_cycle_id: null,
    created_at: now - 5 * DAY,
    updated_at: now - 1 * DAY,
  },
];

// --- M10a role library seed (browser preview) --------------------------------
//
// A flat role library replacing the old fixed enum: the conventional Interviewer plus
// the user's custom team roles (Фронт / Дизайнер / Продакт), each with a muted color so
// chips read as a coherent system. Ids equal what participant.role references (the seeded
// "interviewer" matches the legacy backfill; custom roles get slugs).
const roles: Role[] = [
  { id: "interviewer", name: "Interviewer", color: "#7c86e3", sort: 0, created_at: now - 47 * DAY, updated_at: now - 47 * DAY },
  { id: "front", name: "Фронт", color: "#5ab0c4", sort: 1, created_at: now - 40 * DAY, updated_at: now - 40 * DAY },
  { id: "designer", name: "Дизайнер", color: "#c08bd6", sort: 2, created_at: now - 40 * DAY, updated_at: now - 40 * DAY },
  { id: "product", name: "Продакт", color: "#3fb68b", sort: 3, created_at: now - 40 * DAY, updated_at: now - 40 * DAY },
];

// --- M10a guide library seed (browser preview) -------------------------------
//
// Two reusable guides authored in markdown (with a Goals section so derived goals render).
// The Activation guide mirrors the populated cycle's goals (G1/G2/G3) so the linked-guide
// preview + Overview goals stay consistent. goals are DERIVED here the same way Rust does
// (deriveGoals, defined below) so the library + pickers show "N goals".
const ACTIVATION_GUIDE_MD = `## Goals

- G1: Why do new accounts stall before creating their first funnel?
- G2: Which onboarding step causes the most confusion (source connect vs. event mapping)?
- G3: What would make someone invite a teammate in week one?

## Target conclusions

- A ranked list of activation blockers with supporting quotes.
- A recommendation on whether to add a guided setup wizard.

## Probes

- Walk me through the **first time** you logged in.
- Where did you get stuck, and what did you do next?
`;

const PRICING_GUIDE_MD = `## Goals

- G1: How do teams currently budget for analytics tooling?
- G2: What pricing model feels fairest (seat vs. usage)?
- G3: Which feature would justify moving up a tier?

## Target conclusions

- A recommended pricing structure with a defensible anchor.
`;

// Lazily-derived goals are filled in after deriveGoals is defined (see below).
const guides: Guide[] = [
  {
    id: GUIDE_ID.activation,
    name: "Activation deep-dive",
    content_md: ACTIVATION_GUIDE_MD,
    goals: [],
    created_at: now - 41 * DAY,
    updated_at: now - 3 * DAY,
  },
  {
    id: GUIDE_ID.pricing,
    name: "Pricing & packaging",
    content_md: PRICING_GUIDE_MD,
    goals: [],
    created_at: now - 22 * DAY,
    updated_at: now - 20 * DAY,
  },
];

// --- Products library seed (browser preview) ---------------------------------
//
// One reusable product authored in markdown (headings + bold + bullets) so the Products
// library renders populated AND the Overview product preview demonstrates the markdown-
// RENDER fix (ui-backlog.md #2) — the preview shows formatted text, not raw `#`/`-`. The
// Activation cycle links to it (product_id above). Mirrors the Acme inline product_desc.
const ACME_PRODUCT_MD = `# Acme Analytics

A **self-serve product analytics** tool for early-stage SaaS teams. Users connect a data
source, define key events, and get funnels + retention out of the box.

The activation milestone is **first funnel created within 24h of signup**.

## Persona

- A technical founder or first PM wiring up tracking before launch.

## Key terms

- **Funnel** — an ordered set of events users move through.
- **Source connect** — linking a data warehouse (Snowflake, BigQuery, …).
- **Event mapping** — choosing which raw events count toward a funnel step.
`;

const products: Product[] = [
  {
    id: PRODUCT_ID.acme,
    name: "Acme Analytics",
    content_md: ACME_PRODUCT_MD,
    created_at: now - 41 * DAY,
    updated_at: now - 3 * DAY,
  },
];

// A small seeded glossary for the Acme product so the editor panel renders populated.
const glossaryTerms: GlossaryTerm[] = [
  {
    id: "g1111111-1111-4111-8111-111111111111",
    product_id: PRODUCT_ID.acme,
    canonical: "API",
    aliases: ["эй-пи-ай", "апишка"],
    notes: "",
    created_at: now - 3 * DAY,
    updated_at: now - 3 * DAY,
  },
  {
    id: "g2222222-2222-4222-8222-222222222222",
    product_id: PRODUCT_ID.acme,
    canonical: "Acme Analytics",
    aliases: ["акме", "акми аналитикс"],
    notes: "the product name",
    created_at: now - 3 * DAY,
    updated_at: now - 3 * DAY,
  },
];

// Interviews for the populated cycle (Activation deep-dive). Varied statuses
// (new / importing / error) and realistic durations (18-52 min in ms).
function mediaPath(cycleId: string, file: string): string {
  return `C:/Users/stas/AppData/Roaming/com.interviewlab.app/cycles/${cycleId}/media/${file}`;
}

// Stable id for the first (already-transcribed) interview so the M5 editor mock can
// attach a seeded raw transcript + participants to it for design review.
const FIRST_INTERVIEW_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

const interviews: InterviewRow[] = [
  {
    id: FIRST_INTERVIEW_ID,
    cycle_id: ID.activation,
    title: "P01 - Founder, dev-tools startup",
    // Already transcribed AND cleaned → the editor opens with Raw + Cleaned in the
    // version Select (status 'cleaned', M7 demo).
    status: "cleaned",
    created_at: now - 8 * DAY,
    updated_at: now - 8 * DAY + 30 * MIN,
    source_path: "C:/Users/stas/Recordings/p01-founder-devtools.m4a",
    audio_path: mediaPath(ID.activation, "p01.16k.wav"),
    duration_ms: 42 * MIN + 18_000,
    format: "m4a",
    bytes: 58_900_224,
  },
  {
    id: uuid(),
    cycle_id: ID.activation,
    title: "P02 - First PM, fintech",
    status: "new",
    created_at: now - 7 * DAY,
    updated_at: now - 7 * DAY + 35 * MIN,
    source_path: "C:/Users/stas/Recordings/p02-pm-fintech.mp3",
    audio_path: mediaPath(ID.activation, "p02.16k.wav"),
    duration_ms: 51 * MIN + 7_000,
    format: "mp3",
    bytes: 73_400_320,
  },
  {
    id: uuid(),
    cycle_id: ID.activation,
    title: "P03 - Solo founder, no-code SaaS",
    status: "new",
    created_at: now - 6 * DAY,
    updated_at: now - 6 * DAY + 22 * MIN,
    source_path: "C:/Users/stas/Recordings/p03-solo-nocode.mp4",
    audio_path: mediaPath(ID.activation, "p03.16k.wav"),
    duration_ms: 18 * MIN + 44_000,
    format: "mp4",
    bytes: 412_876_544,
  },
  {
    id: uuid(),
    cycle_id: ID.activation,
    title: "P04 - Growth lead, B2B analytics",
    status: "new",
    created_at: now - 4 * DAY,
    updated_at: now - 4 * DAY + 40 * MIN,
    source_path: "C:/Users/stas/Recordings/p04-growth-b2b.wav",
    audio_path: mediaPath(ID.activation, "p04.16k.wav"),
    duration_ms: 37 * MIN + 12_000,
    format: "wav",
    bytes: 213_909_504,
  },
  {
    id: uuid(),
    cycle_id: ID.activation,
    title: "P05 - Technical co-founder, marketplace",
    status: "importing",
    created_at: now - 12 * MIN,
    updated_at: now - 12 * MIN,
    source_path: "C:/Users/stas/Recordings/p05-cofounder-marketplace.mov",
    audio_path: null,
    duration_ms: null,
    format: "mov",
    bytes: 689_414_144,
  },
  {
    id: uuid(),
    cycle_id: ID.activation,
    title: "P06 - PM, devtools (corrupted upload)",
    status: "error",
    created_at: now - 3 * DAY,
    updated_at: now - 3 * DAY + 1 * MIN,
    source_path: "C:/Users/stas/Recordings/p06-pm-devtools.aac",
    audio_path: null,
    duration_ms: null,
    format: "aac",
    bytes: 1_280_000,
  },
];

// --- fake progress event bus (mirrors the Tauri `interview://progress` event) -

type ProgressHandler = (payload: InterviewProgress) => void;
const progressHandlers = new Set<ProgressHandler>();

function emitProgress(payload: InterviewProgress) {
  for (const h of progressHandlers) h(payload);
}

// Subscribe to the mock progress event. Returns an unsubscribe fn (matches the
// Tauri unlisten contract used by interviews-tab.tsx).
export function mockOnProgress(handler: ProgressHandler): () => void {
  progressHandlers.add(handler);
  return () => progressHandlers.delete(handler);
}

// Mock drag-drop: there is no real OS drag-drop in a browser, so this listener is
// registered (so the component's effect runs cleanly) but never fires. Returns an
// unsubscribe fn to match the Tauri contract.
export function mockOnDragDrop(): () => void {
  return () => {};
}

// --- ASR mock event bus (mirrors `asr://progress` + `asr://model-progress`) ----

type AsrHandler = (payload: AsrProgress) => void;
const asrHandlers = new Set<AsrHandler>();
export function mockOnAsrProgress(handler: AsrHandler): () => void {
  asrHandlers.add(handler);
  return () => asrHandlers.delete(handler);
}
function emitAsr(payload: AsrProgress) {
  for (const h of asrHandlers) h(payload);
}

type ModelHandler = (payload: ModelProgress) => void;
const modelHandlers = new Set<ModelHandler>();
export function mockOnModelProgress(handler: ModelHandler): () => void {
  modelHandlers.add(handler);
  return () => modelHandlers.delete(handler);
}
function emitModel(payload: ModelProgress) {
  for (const h of modelHandlers) h(payload);
}

// Diarization-model download bus (mirrors `asr://diar-model-progress`). Step-level: the
// download fetches a couple of files (segmentation + embedding), one tick per step.
type DiarModelHandler = (payload: DiarModelProgress) => void;
const diarModelHandlers = new Set<DiarModelHandler>();
export function mockOnDiarModelProgress(handler: DiarModelHandler): () => void {
  diarModelHandlers.add(handler);
  return () => diarModelHandlers.delete(handler);
}
function emitDiarModel(payload: DiarModelProgress) {
  for (const h of diarModelHandlers) h(payload);
}

// Per-interview diarization bus (mirrors `asr://diar-progress`). Drives a re-diarize run's
// progress; speakers carries the detected count once status='done'.
type DiarHandler = (payload: DiarProgress) => void;
const diarHandlers = new Set<DiarHandler>();
export function mockOnDiarProgress(handler: DiarHandler): () => void {
  diarHandlers.add(handler);
  return () => diarHandlers.delete(handler);
}
function emitDiar(payload: DiarProgress) {
  for (const h of diarHandlers) h(payload);
}

// Cleanup event bus (mirrors the Tauri `cleanup://progress` event, M7).
type CleanupHandler = (payload: CleanupProgress) => void;
const cleanupHandlers = new Set<CleanupHandler>();
export function mockOnCleanupProgress(handler: CleanupHandler): () => void {
  cleanupHandlers.add(handler);
  return () => cleanupHandlers.delete(handler);
}
function emitCleanup(payload: CleanupProgress) {
  for (const h of cleanupHandlers) h(payload);
}

// Synthesis event bus (mirrors the Tauri `synthesis://progress` event, M8).
type SynthesisHandler = (payload: SynthesisProgress) => void;
const synthesisHandlers = new Set<SynthesisHandler>();
export function mockOnSynthesisProgress(handler: SynthesisHandler): () => void {
  synthesisHandlers.add(handler);
  return () => synthesisHandlers.delete(handler);
}
function emitSynthesis(payload: SynthesisProgress) {
  for (const h of synthesisHandlers) h(payload);
}

// Diff event bus (mirrors the Tauri `diff://progress` event, M9).
type DiffHandler = (payload: DiffProgress) => void;
const diffHandlers = new Set<DiffHandler>();
export function mockOnDiffProgress(handler: DiffHandler): () => void {
  diffHandlers.add(handler);
  return () => diffHandlers.delete(handler);
}
function emitDiff(payload: DiffProgress) {
  for (const h of diffHandlers) h(payload);
}

// Per-interview summary event bus (mirrors `interview-summary://progress`, M10b).
type SummaryHandler = (payload: InterviewSummaryProgress) => void;
const summaryHandlers = new Set<SummaryHandler>();
export function mockOnInterviewSummaryProgress(
  handler: SummaryHandler,
): () => void {
  summaryHandlers.add(handler);
  return () => summaryHandlers.delete(handler);
}
function emitSummary(payload: InterviewSummaryProgress) {
  for (const h of summaryHandlers) h(payload);
}

// --- Chat mock bus + state (mirrors the chat://<thread_id> event, M11 Phase A) -
// Per-thread handler sets (the real backend emits on a per-thread event name).
type ChatHandler = (payload: ChatEvent) => void;
const chatHandlers = new Map<string, Set<ChatHandler>>();
export function mockOnChatEvent(
  threadId: string,
  handler: ChatHandler,
): () => void {
  let set = chatHandlers.get(threadId);
  if (!set) {
    set = new Set();
    chatHandlers.set(threadId, set);
  }
  set.add(handler);
  return () => set?.delete(handler);
}
function emitChat(threadId: string, payload: ChatEvent) {
  const set = chatHandlers.get(threadId);
  if (set) for (const h of set) h(payload);
}

// In-memory chat threads + messages, keyed so list/get reflect sends. Cancel flags
// stop a streaming turn mid-flight (Stop button).
const mockChatThreads: ChatThread[] = [];
const mockChatMessages: Record<string, ChatMessage[]> = {};
const mockChatCancelled = new Set<string>();
let mockChatTimer: ReturnType<typeof setTimeout> | null = null;

// ponytail: seed two per-cycle chat threads (with distinct histories) for the Activation
// cycle so the thread-switcher demo is meaningful on first open in the browser preview —
// you can switch between threads and watch the messages change without having to send a
// turn first. Under Tauri none of this runs; threads come from the real chat_thread table.
function seedChatThread(
  id: string,
  title: string,
  ageMs: number,
  turns: Array<[role: "user" | "assistant", content: string, citations?: string]>,
): void {
  const created = now - ageMs;
  mockChatThreads.push({
    id,
    cycle_id: ID.activation,
    title,
    session_id: "dev-mock-session-" + id.slice(0, 8),
    created_at: created,
    updated_at: created + turns.length * MIN,
  });
  mockChatMessages[id] = turns.map(([role, content, citations], i) => ({
    id: `${id}-m${i}`,
    thread_id: id,
    role,
    content,
    citations_json: citations ?? "[]",
    status: "complete",
    error: null,
    cost_usd: role === "assistant" ? 0.0098 : null,
    created_at: created + i * 1000,
  }));
}

seedChatThread("chat-thread-objections", "Top objections", 2 * HOUR, [
  ["user", "Summarize the top objections in this cycle"],
  [
    "assistant",
    'The two recurring objections are the **data-source connect** (users lack warehouse credentials at signup) and **event-mapping overwhelm** (too many fields, so they guess).',
  ],
]);

seedChatThread("chat-thread-onboarding", "Onboarding confusion", 26 * HOUR, [
  ["user", "What did designers say about onboarding?"],
  [
    "assistant",
    'Designers flagged the **empty dashboard** as the real blocker — there was no obvious first action — and asked for three suggested events with inline examples instead of a long field list.',
  ],
]);

// Audio source for the editor's player in the BROWSER preview: there is no real file
// on disk, so every interview maps to the bundled mock WAV data URI (mock-audio.ts).
// Under Tauri this is never called — the editor uses convertFileSrc(audio_path).
export function mockAudioSrc(_interviewId: string): string {
  return MOCK_AUDIO_DATA_URI;
}

// dev-mock ASR catalog: in the browser preview, pretend the small "base" model is
// already downloaded so the Transcribe button is enabled for design review.
const mockModels: ModelInfo[] = [
  { id: "large-v3", label: "Large v3 (best, Russian default)", file: "ggml-large-v3.bin", approx_mb: 3094, default: true, downloaded: false },
  { id: "large-v3-turbo", label: "Large v3 Turbo (faster)", file: "ggml-large-v3-turbo.bin", approx_mb: 1624, default: false, downloaded: false },
  { id: "medium", label: "Medium (lighter)", file: "ggml-medium.bin", approx_mb: 1533, default: false, downloaded: false },
  { id: "base", label: "Base (small, for testing)", file: "ggml-base.bin", approx_mb: 148, default: false, downloaded: true },
  { id: "tiny", label: "Tiny (smallest, for testing)", file: "ggml-tiny.bin", approx_mb: 78, default: false, downloaded: false },
];

// Transcripts the mock stored per interview (so get_transcript reflects a run).
const mockTranscripts: Record<string, TranscriptRow> = {};

// --- M5 transcript-editor seed (browser preview) -----------------------------
//
// A realistic raw transcript (~13 segments of plausible interview dialogue) + a
// couple of participants for the first Activation interview, plus an in-memory store
// keyed by interview→kind so save_edited_transcript round-trips for design review.
// Timecodes line up with the ~13s mock WAV (mock-audio.ts) so segment→audio sync is
// demonstrable. Spoken English here keeps the preview readable; real data is Russian.

// Diarization now produces REAL alternating speaker labels: S1 is the interviewer (the
// short questions), S2 the respondent (the longer answers). The participants seed below
// binds S1→interviewer and S2→product so the editor's turn grouping reads as a clean
// back-and-forth dialogue (S1 turn, S2 turn, …) for design review.
const RAW_DIALOGUE: Array<[number, number, string, string]> = [
  [0, 1300, "S1", "So, to start — can you walk me through what you did the first time you logged in?"],
  [1300, 5600, "S2", "Yeah. Honestly I just kind of poked around. I saw the dashboard was empty and I wasn't totally sure what the first thing I was supposed to do was."],
  [5600, 7200, "S1", "Got it. And was there anything that pointed you toward connecting a data source?"],
  [7200, 12800, "S2", "There was a button, but it asked me to pick a warehouse and I didn't have those credentials on hand, so I sort of stalled there for a bit."],
  [12800, 14100, "S1", "That makes sense. Did you end up finding them?"],
  [14100, 19400, "S2", "Eventually, yeah, but I had to go bug our data engineer on Slack, and by then I'd already lost the thread of what I was trying to set up."],
  [19400, 21000, "S1", "When you came back, what did you do next?"],
  [21000, 26800, "S2", "I tried to define an event, but the mapping screen had a lot of fields and I wasn't confident I was picking the right ones. I kind of guessed."],
  [26800, 28300, "S1", "And did the guessing work out?"],
  [28300, 33900, "S2", "Half of it. The funnel showed up but two steps were empty, and I couldn't tell if that was my setup or just no data yet."],
  [33900, 35600, "S1", "If there'd been a guided setup, would that have helped?"],
  [35600, 41200, "S2", "A hundred percent. If something had just said 'connect this, then map these three events,' I'd have been done in five minutes instead of two days."],
  [41200, 44800, "S1", "That's really useful. Last thing — what would've made you invite a teammate that first week?"],
];

function rawSegments(): Segment[] {
  return RAW_DIALOGUE.map(([start_ms, end_ms, speaker_label, text]) => ({
    start_ms,
    end_ms,
    speaker_label,
    text,
  }));
}

// A toy "cleanup" for the BROWSER PREVIEW ONLY: trims a few filler words, collapses
// whitespace, and ensures sentence-casing + a trailing period, so the Cleaned version
// reads visibly tidier than Raw. The REAL cleanup runs the CLI in Rust (cleanup.rs);
// this only powers the design-review demo. Crucially it changes ONLY text — timing,
// speaker labels and segment count are carried over untouched, mirroring the invariant.
function mockCleanText(text: string): string {
  const filler =
    /\b(ну вот|ну как бы|как бы|значит|это самое|honestly|kind of|sort of|i mean|you know|um|uh|like)\b/gi;
  let t = text.replace(filler, " ").replace(/\s+/g, " ").trim();
  if (t.length > 0) {
    t = t[0].toUpperCase() + t.slice(1);
    if (!/[.!?…]$/.test(t)) t += ".";
  }
  return t;
}

// Per-interview transcript versions: interviewId → kind → version. Seeded with the
// first interview's raw AND a cleaned version (so the editor's version Select demo
// shows Raw + Cleaned for design review, M7); 'edited' is created on save.
const mockVersions: Record<string, Record<string, TranscriptVersion>> = {
  [FIRST_INTERVIEW_ID]: {
    raw: {
      id: "raw-" + FIRST_INTERVIEW_ID,
      interview_id: FIRST_INTERVIEW_ID,
      version: 1,
      kind: "raw",
      language: "en",
      engine: "whisper.cpp:large-v3@cuda",
      segments: rawSegments(),
      created_at: now - 8 * DAY + 30 * MIN,
    },
    cleaned: {
      id: "cleaned-" + FIRST_INTERVIEW_ID,
      interview_id: FIRST_INTERVIEW_ID,
      version: 2,
      kind: "cleaned",
      language: "en",
      engine: "cli:transcript-cleanup",
      // Same count/timing/labels as raw, only text rewritten (the M7 invariant).
      segments: rawSegments().map((s) => ({ ...s, text: mockCleanText(s.text) })),
      created_at: now - 8 * DAY + 45 * MIN,
    },
  },
};

// Participants per interview (name + role + speaker_label binding). Seeded so the
// editor's speaker→role mapping renders populated for review.
// M10a: role now holds a role-library id. The interviewer keeps the seeded "interviewer"
// id; the respondent is mapped to the custom "product" (Продакт) role to show a custom
// role chip with its own color in the editor.
const mockParticipants: Record<string, Participant[]> = {
  [FIRST_INTERVIEW_ID]: [
    {
      id: "part-interviewer",
      interview_id: FIRST_INTERVIEW_ID,
      display_name: "Researcher",
      role: "Interviewer",
      role_id: "interviewer",
      speaker_label: "S1",
    },
    {
      id: "part-respondent",
      interview_id: FIRST_INTERVIEW_ID,
      display_name: "P01 · Founder",
      role: "Продакт",
      role_id: "product",
      speaker_label: "S2",
    },
  ],
};

// --- M6 CLI-adapter seed (browser preview) -----------------------------------
//
// Stub the bundled Claude Code adapter so the Settings AI CLI tab renders populated.
// In the browser there is no real `claude` CLI, so the "Test CLI" probe returns a
// deterministic "available" result for design review (the real probe runs the CLI).
// The three BUNDLED plugins (feature-cli-plugins.md): the Claude Code reference (full four
// capabilities) + the two proof plugins (Antigravity CLI + Qwen Code) so the Settings AI
// CLI tab renders the multi-plugin UI for design review. Mirrors the Rust bundled
// descriptors' summaries (capabilities, vendor, ok). The "Test CLI" probe (below) returns
// 'available' for claude and 'not-found' for the others (not installed in the browser).
const mockAdapters: AdapterSummary[] = [
  {
    id: "claude-code",
    name: "Claude Code",
    version: "1.0",
    vendor: "Anthropic",
    command: "claude",
    auth_type: "session",
    auth_note:
      "Uses the user's `claude login` session (Pro/Max subscription, or ANTHROPIC_API_KEY if set). Plain -p reads keychain/OAuth. Do NOT pass --bare (it ignores OAuth and forces ANTHROPIC_API_KEY).",
    builtin: true,
    tasks: ["ping", "transcript-cleanup", "cycle-synthesis", "cycle-diff"],
    capabilities: ["batch-tasks", "streaming", "multi-turn", "tool-use"],
    runs_external_program: false,
    models: [
      { id: "haiku", label: "Haiku (fast)" },
      { id: "sonnet", label: "Sonnet (balanced)" },
      { id: "opus", label: "Opus (best)" },
    ],
    ok: true,
    error: null,
    source: "<bundled>/claude-code",
  },
  {
    id: "antigravity-cli",
    name: "Antigravity CLI",
    version: "0.1",
    vendor: "Google",
    command: "agy",
    auth_type: "session",
    auth_note:
      "Google account OAuth via `agy auth login`, or an API key (GEMINI_API_KEY / ANTIGRAVITY_API_KEY). BEST-EFFORT: `--output-format json` is not stable on current `agy` builds, so this descriptor parses raw stdout. Verify the JSON flag, the non-TTY stdout-drop bug, and the API-key env var your build honors.",
    builtin: true,
    tasks: ["ping", "transcript-cleanup", "cycle-synthesis", "cycle-diff"],
    capabilities: ["batch-tasks"],
    runs_external_program: false,
    models: [], // no models block → uses its built-in model
    ok: true,
    error: null,
    source: "<bundled>/antigravity-cli",
  },
  {
    id: "qwen-code",
    name: "Qwen Code",
    version: "1.0",
    vendor: "Alibaba",
    command: "qwen",
    auth_type: "env",
    auth_note:
      "Qwen Code is a Gemini-CLI fork. Auth via an API key (OPENAI_API_KEY + OPENAI_BASE_URL, DashScope, or others) selected in ~/.qwen/settings.json. The free Qwen OAuth tier ended 2026-04-15.",
    builtin: true,
    tasks: ["ping", "transcript-cleanup", "cycle-synthesis", "cycle-diff"],
    capabilities: ["batch-tasks", "streaming", "tool-use"],
    runs_external_program: false,
    models: [], // no models block → uses its built-in model
    ok: true,
    error: null,
    source: "<bundled>/qwen-code",
  },
];

// Active adapter id (persisted across the session in the browser mock).
let mockActiveAdapter = "claude-code";

// Per-bucket task-model overrides (persisted across the session in the browser mock).
// Empty string = the plugin's per-task default (no override).
const mockTaskModels: Record<string, string> = {
  cleanup: "",
  synthesis: "",
  diff: "",
};

// The §9 plugin-authoring meta-instruction, abridged for the browser preview (the real
// Rust command returns the full text). Tells any AI agent how to drop in a new CLI plugin.
const MOCK_META_INSTRUCTIONS = `# Onboard a new CLI as an InterviewLab plugin

You are authoring a self-contained plugin so InterviewLab can drive a local AI CLI for batch tasks and/or agentic chat — by dropping a folder into \`%APPDATA%/com.interviewlab.app/plugins/<id>/\`. You will NOT edit the app's source.

## Plugin layout
\`\`\`
plugins/<id>/
  manifest.json    # REQUIRED — the plugin descriptor (alias: adapter.json)
  README.md        # which CLI, how to install/login, caveats
  adapter[.exe|.js]# OPTIONAL — adapter program (Tier 2)
\`\`\`
The folder name IS the canonical \`id\` and must equal \`manifest.id\`. Legacy flat \`adapters/<id>.json\` files still load.

## 1. Decide the tier
Run the CLI's \`--help\`. **Tier 1 (descriptor-only, zero code)** works if it has a one-shot prompt + JSON mode (\`batch-tasks\`), a streaming ndjson mode matching a shipped parser (\`streaming\`), session/resume (\`multi-turn\`), and/or MCP (\`tool-use\`). If something doesn't map → **Tier 2: ship a small adapter program** speaking the stdio chat protocol.

## 2. Write the manifest (validate against manifest.schema.json)
- \`id\` = folder name; \`command\` = the executable; \`capabilities\` = the subset you verified.
- Fill ONLY the blocks for those capabilities: \`io\`+\`tasks\` (batch), \`chat.stream\`+\`parse\` (streaming), \`chat.session\` (multi-turn), \`chat.tools\` (tool-use). Use placeholders \`{prompt}\`, \`{system_prompt_file}\`, \`{session_id}\`, \`{session_args}\`.
- Constraints: cleanup preserves segment ids/timing/labels (only \`text\` changes); synthesis findings carry \`goal_id\` + evidence; diff is findings-level.
- Write a \`probe\` (cheap command + exit code) + an \`auth\` note (prefer the CLI's own login; Claude Code avoids \`--bare\`, which forces an API key).

## 3. Self-test
Validate the manifest → run \`probe\` → pipe a fixture through each batch task → chat smoke (≥1 token + a session_id) → drop the folder in \`plugins/<id>/\`, **Rescan plugins**, select it, **Test CLI** → Available.

## Worked example — Claude Code (reference plugin, all four capabilities)
\`-p --output-format json\` (batch), \`stream-json --verbose --include-partial-messages\` (stream), \`--resume\` (multi-turn), \`--mcp-config … --strict-mcp-config\` + \`--allowedTools\` + \`--tools ""\` (scoped MCP tools), \`--setting-sources ""\` + NO \`--bare\` (subscription auth). Clone its manifest for the next CLI (Gemini-CLI forks like Qwen Code reuse \`parse: "gemini-stream-json"\`).`;

// The manifest JSON Schema, abridged for the browser preview (the real command returns the
// full schema; the Add-plugin dialog shows it so an authoring agent self-validates).
const MOCK_MANIFEST_SCHEMA = `{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "InterviewLab plugin manifest",
  "type": "object",
  "required": ["id", "name", "command", "capabilities", "probe", "auth"],
  "properties": {
    "id": { "type": "string" },
    "name": { "type": "string" },
    "command": { "type": "string" },
    "capabilities": { "type": "array", "items": { "enum": ["batch-tasks", "streaming", "multi-turn", "tool-use"] } },
    "probe": { "type": "object", "required": ["args"] },
    "auth": { "type": "object", "required": ["type"] },
    "io": { "type": "object", "description": "Required iff 'batch-tasks'." },
    "tasks": { "type": "object", "description": "Required iff 'batch-tasks'." },
    "chat": { "type": "object", "description": "stream (streaming), session (multi-turn), tools (tool-use)." }
  }
}`;

// --- M8 synthesis seed (browser preview) -------------------------------------
//
// A realistic synthesis for the populated Activation cycle so the Synthesis tab renders
// findings Cards by goal for design review. Goals match the Activation guide's G1/G2/G3
// (derived deterministically in Rust); findings carry evidence quotes referencing the
// first interview's seeded segments (so the "open interview" link resolves). The REAL
// synthesis runs the CLI map-reduce in Rust (synthesis.rs); this only powers the demo.

const ACTIVATION_GOALS: Goal[] = [
  { id: "G1", text: "Why do new accounts stall before creating their first funnel?" },
  { id: "G2", text: "Which onboarding step causes the most confusion (source connect vs. event mapping)?" },
  { id: "G3", text: "What would make someone invite a teammate in week one?" },
];

// Browser-side mirror of the Rust `derive_goals` (synthesis.rs): parse the guide's "Goals"
// bullet list into stable ids (explicit "G1:" tags kept, else positional G1, G2, …),
// stopping at a blank line / next heading; fall back to all bullets, then the whole guide.
function deriveGoals(guide: string): Goal[] {
  const lines = guide.split("\n");
  const bulletText = (line: string): string | null => {
    const t = line.trim();
    const m = t.match(/^(?:[-*]\s+|\d+[.)]\s*)(.*)$/);
    return m ? m[1].trim() : null;
  };
  const goalsStart = lines.findIndex((l) => {
    const t = l.trim().replace(/^#+\s*/, "").toLowerCase();
    return t === "goals" || t === "goals:" || t.startsWith("goals:");
  });

  let raw: string[] = [];
  if (goalsStart >= 0) {
    let seen = false;
    for (const line of lines.slice(goalsStart + 1)) {
      const g = bulletText(line);
      if (g) {
        if (g) raw.push(g);
        seen = true;
      } else if (line.trim() === "") {
        if (seen) break;
      } else if (seen) {
        break;
      }
    }
  }
  if (raw.length === 0) {
    raw = lines.map(bulletText).filter((g): g is string => !!g);
  }
  if (raw.length === 0 && guide.trim()) raw = [guide.trim()];

  return raw.map((text, i) => {
    const m = text.match(/^G(\d+)\s*[:\-—]?\s*(.*)$/i);
    if (m) {
      const rest = m[2].trim();
      return { id: "G" + m[1], text: rest || text };
    }
    return { id: "G" + (i + 1), text };
  });
}

// Now that deriveGoals exists, populate each seeded guide's derived goals (the real Rust
// backend derives + caches these; the mock derives on seed so the library/picker render
// "N goals" with stable ids).
for (const g of guides) {
  g.goals = deriveGoals(g.content_md);
}

// --- M10b: render the cycle synthesis as editable markdown (mirrors Rust
// render_cycle_markdown) so the dev-mock seeds + run_synthesis produce a realistic artifact
// the Plate editor shows. Structure: Executive summary → per goal (finding + confidence +
// evidence quotes w/ interview refs + recommendation) → by-role → open questions.
function titleForMock(interviewId: string): string {
  return interviews.find((i) => i.id === interviewId)?.title ?? interviewId;
}

function renderCycleMarkdown(doc: SynthesisDoc): string {
  const lines: string[] = ["# Cycle synthesis", ""];
  lines.push("## Executive summary", "");
  lines.push(doc.executive_summary?.trim() || "_No summary._", "");
  for (const goal of doc.goals) {
    lines.push(`## ${goal.id} · ${goal.text}`, "");
    const findings = doc.findings.filter((f) => f.goal_id === goal.id);
    if (findings.length === 0) {
      lines.push("_No findings surfaced for this goal in this wave._", "");
      continue;
    }
    for (const f of findings) {
      const plural = f.support_count === 1 ? "" : "s";
      lines.push(
        `### ${f.statement.trim()} — _${f.confidence} confidence · ${f.support_count} interview${plural}_`,
        "",
      );
      for (const e of f.evidence) {
        if (!e.quote.trim()) continue;
        lines.push(
          `> ${e.quote.trim()}`,
          `> — ${titleForMock(e.interview_id)} · segment ${e.segment_id + 1}`,
          "",
        );
      }
      if (f.recommendation && f.recommendation.trim()) {
        lines.push(`**Recommendation:** ${f.recommendation.trim()}`, "");
      }
    }
  }
  if (doc.by_role && doc.by_role.length > 0) {
    lines.push("## By role", "");
    for (const group of doc.by_role) {
      const gtext = doc.goals.find((g) => g.id === group.goal_id)?.text ?? "";
      lines.push(`### ${group.goal_id} · ${gtext}`, "");
      for (const n of group.notes) {
        lines.push(`- **${n.role || "Role"}:** ${n.note.trim()}`);
      }
      lines.push("");
    }
  }
  if (doc.open_questions.length > 0) {
    lines.push("## Open questions", "");
    for (const q of doc.open_questions) lines.push(`- ${q.trim()}`);
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}

// Render a per-interview summary as editable markdown (mirrors Rust render_interview_markdown).
function renderInterviewMarkdown(doc: InterviewSummaryDoc, title: string): string {
  const lines: string[] = [`# Summary · ${title.trim()}`, ""];
  if (doc.by_goal.length === 0) {
    lines.push(
      "_No goal-relevant points were extracted from this interview._",
      "",
    );
  }
  for (const goal of doc.goals) {
    const group = doc.by_goal.find((g) => g.goal_id === goal.id);
    if (!group) continue;
    lines.push(`## ${goal.id} · ${goal.text}`, "");
    for (const p of group.points) {
      lines.push(`- ${p.point.trim()}`);
      for (const q of p.quotes) {
        if (!q.quote.trim()) continue;
        lines.push(`  > ${q.quote.trim()} _(segment ${q.segment_id + 1})_`);
      }
    }
    lines.push("");
  }
  if (doc.notable.length > 0) {
    lines.push("## Notable quotes & surprises", "");
    for (const n of doc.notable) {
      if (n.quote.trim())
        lines.push(`> ${n.quote.trim()} _(segment ${n.segment_id + 1})_`);
      if (n.note.trim()) lines.push(`- ${n.note.trim()}`);
      lines.push("");
    }
  }
  return lines.join("\n").trimEnd();
}

const mockSynthesis: Record<string, SynthesisRow> = {
  [ID.activation]: {
    id: "synth-" + ID.activation,
    cycle_id: ID.activation,
    created_at: now - 2 * HOUR,
    model_meta: JSON.stringify({
      adapter: "claude-code",
      cycle: "Activation deep-dive",
      interviews: 4,
      goals: 3,
      findings: 4,
    }),
    content_md: "", // filled by a post-pass via renderCycleMarkdown (see below).
    doc: {
      goals: ACTIVATION_GOALS,
      executive_summary:
        "Activation stalls before the first funnel for two concrete reasons: the data-source connect demands warehouse credentials users don't have at signup, and the event-mapping screen overwhelms them into guessing. Users explicitly want a guided wizard, and they only invite teammates once they have a result to show — so the invite nudge should follow activation, not precede it.",
      by_role: [
        {
          goal_id: "G1",
          notes: [
            { role: "Продакт", note: "Wants a sample dataset so they can reach a first funnel before chasing credentials." },
            { role: "Фронт", note: "Saw the empty dashboard as the real blocker — no obvious first action." },
          ],
        },
        {
          goal_id: "G2",
          notes: [
            { role: "Дизайнер", note: "Asked for three suggested events with inline examples instead of a long field list." },
          ],
        },
      ],
      open_questions: [
        "Did mobile-first signups stall at the same step, or is this desktop-only?",
        "Would a sample/demo dataset reduce the data-source blocker enough to defer the real connect?",
      ],
      findings: [
        {
          id: "F1",
          goal_id: "G1",
          statement:
            "New accounts stall at the data-source connect because it demands warehouse credentials users don't have on hand at signup.",
          confidence: "high",
          support_count: 4,
          evidence: [
            {
              interview_id: FIRST_INTERVIEW_ID,
              segment_id: 3,
              quote:
                "There was a button, but it asked me to pick a warehouse and I didn't have those credentials on hand, so I sort of stalled there for a bit.",
            },
            {
              interview_id: FIRST_INTERVIEW_ID,
              segment_id: 5,
              quote:
                "I had to go bug our data engineer on Slack, and by then I'd already lost the thread of what I was trying to set up.",
            },
          ],
          recommendation:
            "Defer the live data-source connect — offer a sample dataset so users can reach a first funnel before chasing credentials.",
        },
        {
          id: "F2",
          goal_id: "G2",
          statement:
            "Event mapping is the most confusing step: too many fields with no guidance, so users guess and get half-empty funnels.",
          confidence: "high",
          support_count: 3,
          evidence: [
            {
              interview_id: FIRST_INTERVIEW_ID,
              segment_id: 7,
              quote:
                "The mapping screen had a lot of fields and I wasn't confident I was picking the right ones. I kind of guessed.",
            },
            {
              interview_id: FIRST_INTERVIEW_ID,
              segment_id: 9,
              quote:
                "The funnel showed up but two steps were empty, and I couldn't tell if that was my setup or just no data yet.",
            },
          ],
          recommendation:
            "Reduce the mapping screen to three suggested events with inline examples; flag empty funnel steps as 'no data yet' vs. 'misconfigured'.",
        },
        {
          id: "F3",
          goal_id: "G2",
          statement:
            "A guided setup wizard would collapse a two-day stall into minutes — users explicitly asked for prescriptive steps.",
          confidence: "medium",
          support_count: 2,
          evidence: [
            {
              interview_id: FIRST_INTERVIEW_ID,
              segment_id: 11,
              quote:
                "If something had just said 'connect this, then map these three events,' I'd have been done in five minutes instead of two days.",
            },
          ],
          recommendation:
            "Ship a linear setup wizard (connect → map three events → first funnel) as the default first-run path.",
        },
        {
          id: "F4",
          goal_id: "G3",
          statement:
            "Users won't invite a teammate until they themselves have something to show — activation must precede any invite prompt.",
          confidence: "medium",
          support_count: 2,
          evidence: [
            {
              interview_id: FIRST_INTERVIEW_ID,
              segment_id: 1,
              quote:
                "I saw the dashboard was empty and I wasn't totally sure what the first thing I was supposed to do was.",
            },
          ],
          recommendation:
            "Hold the 'invite a teammate' nudge until a first funnel exists, then frame the invite around sharing that result.",
        },
      ],
    } satisfies SynthesisDoc,
  },

  // The PREVIOUS wave (Onboarding · Wave 3) — seeded so the M9 diff has BOTH syntheses to
  // compare. Shares G1/G2/G3 (same guide goals) but with the EARLIER state of the
  // conclusions, chosen to make the diff demonstrate every status:
  //   - G1 finding present but at LOW confidence + a vaguer root cause → `changed` this wave,
  //   - a G2 pricing-objection finding that's GONE in Activation        → `dropped` this wave,
  //   - the G2 wizard finding (Activation F3) + the G3 invite finding (F4) had no prior
  //     match → `new` this wave,
  //   - the G2 event-mapping finding is essentially the same            → `unchanged`.
  [ID.onboarding]: {
    id: "synth-" + ID.onboarding,
    cycle_id: ID.onboarding,
    created_at: now - 42 * DAY,
    model_meta: JSON.stringify({
      adapter: "claude-code",
      cycle: "Onboarding · Wave 3",
      interviews: 3,
      goals: 3,
      findings: 3,
    }),
    content_md: "", // filled by a post-pass via renderCycleMarkdown (see below).
    doc: {
      goals: ACTIVATION_GOALS,
      executive_summary:
        "Early signal that new accounts stall around connecting a data source, though the root cause is unclear. Event mapping is confusing, and pricing surfaced as an objection that stalled some users mid-onboarding.",
      by_role: [],
      open_questions: [
        "Is the data-source step or the event mapping the bigger blocker? Evidence was thin.",
      ],
      findings: [
        {
          id: "pF1",
          goal_id: "G1",
          statement:
            "Some new accounts seem to stall around connecting a data source, though it's unclear why.",
          confidence: "low",
          support_count: 1,
          evidence: [],
          recommendation:
            "Investigate the data-source step more closely next wave.",
        },
        {
          id: "pF2",
          goal_id: "G2",
          statement:
            "Event mapping is confusing — too many fields and no guidance, so users guess.",
          confidence: "high",
          support_count: 3,
          evidence: [],
          recommendation:
            "Reduce the mapping screen to a few suggested events with examples.",
        },
        {
          id: "pF3",
          goal_id: "G2",
          statement:
            "Pricing came up as an objection that stalled some users mid-onboarding.",
          confidence: "medium",
          support_count: 2,
          evidence: [],
          recommendation:
            "Clarify pricing earlier, or defer the paywall past activation.",
        },
      ],
    } satisfies SynthesisDoc,
  },
};

// Fill each seeded cycle synthesis's editable markdown artifact from its doc (the real Rust
// backend renders this server-side on run_synthesis; the mock renders on seed so the Plate
// editor in the Synthesis tab shows a realistic, editable report — M10b).
for (const row of Object.values(mockSynthesis)) {
  row.content_md = renderCycleMarkdown(row.doc);
}

// --- M10b per-interview summary seed (browser preview) -----------------------
//
// Seed a per-interview summary for the first (already-transcribed) Activation interview so
// the editor's "Summary" section renders populated for design review. Structured by the
// Activation goals (G1/G2/G3), with supporting quotes referencing the seeded raw segments.
// Keyed by interview id; run_interview_summary / save_interview_summary round-trip here.
const mockInterviewSummaries: Record<string, InterviewSummaryRow> = {
  [FIRST_INTERVIEW_ID]: {
    id: "summary-" + FIRST_INTERVIEW_ID,
    cycle_id: ID.activation,
    interview_id: FIRST_INTERVIEW_ID,
    created_at: now - 2 * HOUR,
    model_meta: JSON.stringify({ adapter: "claude-code", goals: 3 }),
    content_md: "", // filled by the post-pass below.
    doc: {
      goals: ACTIVATION_GOALS,
      by_goal: [
        {
          goal_id: "G1",
          points: [
            {
              point:
                "Stalled at the data-source connect because warehouse credentials weren't on hand at signup.",
              quotes: [
                {
                  segment_id: 3,
                  quote:
                    "There was a button, but it asked me to pick a warehouse and I didn't have those credentials on hand, so I sort of stalled there for a bit.",
                },
                {
                  segment_id: 5,
                  quote:
                    "I had to go bug our data engineer on Slack, and by then I'd already lost the thread of what I was trying to set up.",
                },
              ],
            },
          ],
        },
        {
          goal_id: "G2",
          points: [
            {
              point:
                "Event mapping had too many fields with no guidance, so they guessed and got half-empty funnels.",
              quotes: [
                {
                  segment_id: 7,
                  quote:
                    "The mapping screen had a lot of fields and I wasn't confident I was picking the right ones. I kind of guessed.",
                },
              ],
            },
          ],
        },
        {
          goal_id: "G3",
          points: [
            {
              point:
                "Wouldn't invite a teammate until there was something to show — activation has to come first.",
              quotes: [],
            },
          ],
        },
      ],
      notable: [
        {
          segment_id: 11,
          quote:
            "If something had just said 'connect this, then map these three events,' I'd have been done in five minutes instead of two days.",
          note: "Explicit ask for a guided setup wizard.",
        },
      ],
    } satisfies InterviewSummaryDoc,
  },
};

// Fill each seeded per-interview summary's editable markdown from its doc (mirrors the Rust
// render_interview_markdown; lets the editor's Summary section show a realistic artifact).
for (const row of Object.values(mockInterviewSummaries)) {
  row.content_md = renderInterviewMarkdown(row.doc, titleForMock(row.interview_id));
}

// --- M9 diff seed (browser preview) ------------------------------------------
//
// A realistic findings-level diff for the populated Activation cycle vs its previous wave
// (Onboarding · Wave 3), so the Diff tab renders populated for design review. Mirrors what
// the REAL `cycle-diff` (diff.rs) produces: per-goal entries with a status + why, refs
// resolving into each synthesis. Statuses cover all four cases (see the prev synthesis seed
// above). The real diff runs the single CLI call in Rust; this only powers the demo.

const mockDiff: Record<string, DiffRow> = {
  [ID.activation]: {
    id: "diff-" + ID.activation,
    cycle_id: ID.activation,
    prev_cycle_id: ID.onboarding,
    created_at: now - 90 * MIN,
    doc: {
      goals: ACTIVATION_GOALS.map((g) => ({ id: g.id, text: g.text })),
      summary:
        "Net: the data-source blocker firmed up from a hunch to a high-confidence root cause; two new onboarding findings (a guided wizard and an activation-before-invite pattern) surfaced; the pricing objection from last wave disappeared.",
      by_goal: [
        {
          goal_id: "G1",
          entries: [
            {
              status: "changed",
              finding_id: "F1",
              prev_finding_id: "pF1",
              statement:
                "New accounts stall at the data-source connect because it demands warehouse credentials users don't have on hand at signup.",
              why: "Confidence rose low→high and the root cause sharpened — last wave it was a vague 'something around connecting a data source', now it's specifically missing credentials at signup. Support grew 1→4.",
            },
          ],
        },
        {
          goal_id: "G2",
          entries: [
            {
              status: "unchanged",
              finding_id: "F2",
              prev_finding_id: "pF2",
              statement:
                "Event mapping is the most confusing step: too many fields with no guidance, so users guess and get half-empty funnels.",
              why: "Same conclusion and recommendation as last wave; no material shift.",
            },
            {
              status: "new",
              finding_id: "F3",
              prev_finding_id: null,
              statement:
                "A guided setup wizard would collapse a two-day stall into minutes — users explicitly asked for prescriptive steps.",
              why: "No matching finding last wave; the explicit ask for a wizard is new this cycle.",
            },
            {
              status: "dropped",
              finding_id: null,
              prev_finding_id: "pF3",
              statement:
                "Pricing came up as an objection that stalled some users mid-onboarding.",
              why: "No supporting evidence this wave — the pricing objection did not recur in any interview.",
            },
          ],
        },
        {
          goal_id: "G3",
          entries: [
            {
              status: "new",
              finding_id: "F4",
              prev_finding_id: null,
              statement:
                "Users won't invite a teammate until they themselves have something to show — activation must precede any invite prompt.",
              why: "The previous wave surfaced nothing for the invite goal; this is the first finding tied to G3.",
            },
          ],
        },
      ],
    } satisfies DiffDoc,
  },
};

// Compute the Diff tab's precondition status for a cycle the same way Rust's diff_status
// does: no prev cycle → 'no-prev-cycle'; else check both syntheses exist.
function mockDiffStatus(cycleId: string): DiffStatusRow {
  const cycle = cycles.find((c) => c.id === cycleId);
  const prevId = cycle?.prev_cycle_id ?? null;
  if (!prevId) {
    return { readiness: "no-prev-cycle", prev_cycle_id: null, prev_cycle_name: null };
  }
  const prev = cycles.find((c) => c.id === prevId);
  const prevName = prev?.name ?? null;
  if (!mockSynthesis[cycleId]) {
    return { readiness: "no-current-synthesis", prev_cycle_id: prevId, prev_cycle_name: prevName };
  }
  if (!mockSynthesis[prevId]) {
    return { readiness: "no-prev-synthesis", prev_cycle_id: prevId, prev_cycle_name: prevName };
  }
  return { readiness: "ready", prev_cycle_id: prevId, prev_cycle_name: prevName };
}

// --- the mock invoke dispatcher ----------------------------------------------

function findCycle(id: string): Cycle {
  const c = cycles.find((c) => c.id === id);
  if (!c) throw new Error(`cycle not found: ${id}`);
  return c;
}

// Mirror the Rust effective_guide_db (M10a): prefer the cycle's linked guide content when
// set + non-empty, else fall back to the inline guide text. Used for goal derivation.
function effectiveGuide(cycleId: string): string {
  const cycle = cycles.find((c) => c.id === cycleId);
  if (!cycle) return "";
  if (cycle.guide_id) {
    const g = guides.find((g) => g.id === cycle.guide_id);
    if (g && g.content_md.trim()) return g.content_md;
  }
  return cycle.guide ?? "";
}

// Mirror the Rust effective_product_db (Products library): prefer the cycle's linked product
// content when set + non-empty, else fall back to the inline product_desc text. The pipeline
// uses this for the ASR initial_prompt + cleanup + synthesis product context (req #2). In the
// browser mock the pipeline doesn't run prompts, so this is surfaced in run_synthesis's
// model_meta (product_chars) to make the product-context flow observable for review.
function effectiveProduct(cycleId: string): string {
  const cycle = cycles.find((c) => c.id === cycleId);
  if (!cycle) return "";
  if (cycle.product_id) {
    const p = products.find((p) => p.id === cycle.product_id);
    if (p && p.content_md.trim()) return p.content_md;
  }
  return cycle.product_desc ?? "";
}

// Mirrors @tauri-apps/api `invoke`: dispatch by command name, return a Promise of
// the same payload the Rust command would return. Unknown commands reject, just
// like a missing Tauri handler would.
export function mockInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const a = (args ?? {}) as Record<string, unknown>;

  switch (cmd) {
    case "db_health": {
      const health: DbHealth = {
        db_path:
          "C:/Users/stas/AppData/Roaming/com.interviewlab.app/interviewlab.db (dev mock)",
        // Five migrations applied (0001..0005_products) → schema version 5.
        schema_version: 5,
      };
      return Promise.resolve(health as T);
    }

    case "list_cycles": {
      // Newest first by updated_at (the real query orders by the DB; the table
      // doesn't depend on order, but this reads naturally).
      const sorted = [...cycles].sort((x, y) => y.updated_at - x.updated_at);
      return Promise.resolve(sorted as T);
    }

    case "get_cycle": {
      return Promise.resolve(findCycle(String(a.id)) as T);
    }

    case "create_cycle": {
      const req = (a.req ?? {}) as { name?: string };
      const ts = Date.now();
      const cycle: Cycle = {
        id: uuid(),
        name: req.name ?? "Untitled cycle",
        product_desc: "",
        product_id: null,
        guide: "",
        guide_id: null,
        prev_cycle_id: null,
        created_at: ts,
        updated_at: ts,
      };
      cycles.push(cycle);
      return Promise.resolve(cycle as T);
    }

    case "update_cycle": {
      const req = a.req as UpdateCycleInput;
      const cycle = findCycle(req.id);
      cycle.name = req.name;
      cycle.product_desc = req.product_desc;
      cycle.product_id = req.product_id ?? null;
      cycle.guide = req.guide;
      cycle.guide_id = req.guide_id ?? null;
      cycle.prev_cycle_id = req.prev_cycle_id;
      cycle.updated_at = Date.now();
      return Promise.resolve(cycle as T);
    }

    case "delete_cycle": {
      const id = String(a.id);
      const i = cycles.findIndex((c) => c.id === id);
      if (i >= 0) cycles.splice(i, 1);
      // Cascade: drop the cycle's interviews too (real schema has ON DELETE CASCADE).
      for (let j = interviews.length - 1; j >= 0; j--) {
        if (interviews[j].cycle_id === id) interviews.splice(j, 1);
      }
      return Promise.resolve(undefined as T);
    }

    case "list_interviews": {
      const cycleId = String(a.cycleId);
      const rows = interviews
        .filter((r) => r.cycle_id === cycleId)
        .sort((x, y) => x.created_at - y.created_at);
      return Promise.resolve(rows as T);
    }

    case "add_interview_files": {
      const cycleId = String(a.cycleId);
      const paths = (a.paths as string[]) ?? [];
      const created: InterviewRow[] = paths.map((p) => {
        const file = p.split(/[\\/]/).pop() ?? p;
        const dot = file.lastIndexOf(".");
        const title = dot > 0 ? file.slice(0, dot) : file;
        const ext = dot > 0 ? file.slice(dot + 1).toLowerCase() : null;
        const ts = Date.now();
        const row: InterviewRow = {
          id: uuid(),
          cycle_id: cycleId,
          title,
          status: "importing",
          created_at: ts,
          updated_at: ts,
          source_path: p,
          audio_path: null,
          duration_ms: null,
          format: ext,
          bytes: 12_345_678,
        };
        interviews.push(row);

        // Simulate ffmpeg prep finishing: flip importing -> new after a short
        // timer and emit a fake progress event so the table refreshes (matches
        // the real backend's importing -> new transition).
        const audio = mediaPath(cycleId, `${row.id}.16k.wav`);
        const duration = (20 + Math.floor(Math.random() * 25)) * MIN;
        setTimeout(() => {
          row.status = "new";
          row.audio_path = audio;
          row.duration_ms = duration;
          row.updated_at = Date.now();
          emitProgress({
            cycle_id: cycleId,
            interview_id: row.id,
            status: "new",
            audio_path: audio,
            duration_ms: duration,
            error: null,
          });
        }, 2500);

        return row;
      });
      return Promise.resolve(created as T);
    }

    case "delete_interview": {
      const id = String(a.id);
      const i = interviews.findIndex((r) => r.id === id);
      if (i >= 0) interviews.splice(i, 1);
      return Promise.resolve(undefined as T);
    }

    // --- ASR (Milestone 4) ---------------------------------------------------

    case "asr_device": {
      // The browser preview can't probe a GPU; report the CPU fallback the same
      // way a CUDA-less build would (matches Rust detect_device on a CPU build).
      const info: DeviceInfo = {
        device: "cpu",
        use_gpu: false,
        gpu_name: null,
        cuda_build: false,
        detail: "Browser preview — device probe runs only in the desktop app (CPU).",
      };
      return Promise.resolve(info as T);
    }

    case "list_models": {
      return Promise.resolve(mockModels.map((m) => ({ ...m })) as T);
    }

    case "download_model": {
      const modelId = String(a.modelId);
      const model = mockModels.find((m) => m.id === modelId);
      const total = (model?.approx_mb ?? 100) * 1_000_000;
      // Stream a few fake progress ticks, then mark done + downloaded.
      let downloaded = 0;
      const step = Math.max(1, Math.round(total / 8));
      const tick = () => {
        downloaded = Math.min(total, downloaded + step);
        const done = downloaded >= total;
        emitModel({ model_id: modelId, downloaded_bytes: downloaded, total_bytes: total, done, error: null });
        if (done) {
          if (model) model.downloaded = true;
        } else {
          setTimeout(tick, 150);
        }
      };
      setTimeout(tick, 150);
      return Promise.resolve(undefined as T);
    }

    case "transcribe_interview": {
      const interviewId = String(a.interviewId);
      const language = String(a.language ?? "auto");
      const modelId = String(a.modelId);
      // expectedSpeakers (null = auto, a number forces the count) — diarization gates this
      // arg in the real backend; the browser preview just ignores it and produces the same
      // demo segments.
      void a.expectedSpeakers;
      const iv = interviews.find((r) => r.id === interviewId);
      if (iv) {
        iv.status = "transcribing";
        iv.updated_at = Date.now();
      }
      emitAsr({ interview_id: interviewId, status: "transcribing", progress: 0, segment_text: null, error: null });
      // Stream percent, then a couple of fake segments, then finish. Diarization now yields
      // REAL alternating speaker labels (S1 interviewer / S2 respondent), so the mock segments
      // alternate too — the editor groups them into one S1 turn + one S2 turn.
      const segs = [
        { start_ms: 0, end_ms: 2400, speaker_label: "S1", text: "This is a mock transcript for the browser preview." },
        { start_ms: 2400, end_ms: 5200, speaker_label: "S2", text: "Real transcription runs locally in the desktop app." },
      ];
      let p = 0;
      const step = () => {
        p += 25;
        if (p < 100) {
          emitAsr({ interview_id: interviewId, status: "transcribing", progress: p, segment_text: null, error: null });
          setTimeout(step, 250);
        } else {
          const tid = uuid();
          mockTranscripts[interviewId] = {
            id: tid,
            interview_id: interviewId,
            version: 1,
            kind: "raw",
            language: language === "auto" ? null : language,
            engine: `whisper.cpp:${modelId}@cpu`,
            segments_json: JSON.stringify(segs),
            created_at: Date.now(),
          };
          if (iv) {
            iv.status = "transcribed";
            iv.updated_at = Date.now();
          }
          emitAsr({ interview_id: interviewId, status: "transcribed", progress: 100, segment_text: null, error: null });
        }
      };
      setTimeout(step, 250);
      // Resolve once the run finishes (matches the Rust command returning the id).
      return new Promise<T>((resolve) => {
        const wait = () => {
          const row = mockTranscripts[interviewId];
          if (row) resolve(row.id as T);
          else setTimeout(wait, 200);
        };
        wait();
      });
    }

    case "get_transcript": {
      const interviewId = String(a.interviewId);
      return Promise.resolve((mockTranscripts[interviewId] ?? null) as T);
    }

    // --- Speaker diarization -------------------------------------------------

    case "diarization_models_present": {
      // In the browser preview, pretend the diarization models are already on disk so the
      // status line + Re-diarize action render the happy path for design review.
      return Promise.resolve(true as T);
    }

    case "download_diarization_models": {
      // Stream a couple of step ticks (segmentation + embedding), then mark done. ponytail:
      // two fixed steps is enough to demo the Progress UX; the real download fetches the
      // actual model files in Rust.
      const steps = [
        { label: "Segmentation model" },
        { label: "Speaker-embedding model" },
      ];
      const total = steps.length;
      let i = 0;
      const tick = () => {
        i += 1;
        const done = i >= total;
        emitDiarModel({
          step: i,
          total_steps: total,
          label: steps[i - 1]?.label ?? "Diarization models",
          done,
          error: null,
        });
        if (!done) setTimeout(tick, 350);
      };
      setTimeout(tick, 300);
      return Promise.resolve(undefined as T);
    }

    case "rediarize_interview": {
      // Re-run diarization on an existing transcript with a fresh expected-speaker count.
      // The browser preview just resolves with a fixed detected count (2) after emitting a
      // couple of progress ticks — the real backend re-labels the stored segments in Rust.
      const interviewId = String(a.interviewId);
      const expected = a.expectedSpeakers == null ? null : Number(a.expectedSpeakers);
      const detected = expected ?? 2;
      emitDiar({ interview_id: interviewId, status: "diarizing", progress: 20, speakers: null });
      setTimeout(() => {
        emitDiar({ interview_id: interviewId, status: "diarizing", progress: 70, speakers: null });
      }, 300);
      setTimeout(() => {
        emitDiar({ interview_id: interviewId, status: "done", progress: 100, speakers: detected });
      }, 600);
      return Promise.resolve(detected as T);
    }

    // --- M5 transcript editor ------------------------------------------------

    case "list_transcript_versions": {
      const interviewId = String(a.interviewId);
      const byKind = mockVersions[interviewId] ?? {};
      const order: Record<string, number> = { raw: 0, cleaned: 1, edited: 2 };
      const list: VersionInfo[] = Object.values(byKind)
        .map((v) => ({ kind: v.kind, version: v.version, created_at: v.created_at }))
        .sort((x, y) => (order[x.kind] ?? 9) - (order[y.kind] ?? 9));
      return Promise.resolve(list as T);
    }

    case "get_transcript_version": {
      const interviewId = String(a.interviewId);
      const kind = String(a.kind);
      const v = mockVersions[interviewId]?.[kind] ?? null;
      // Return a deep clone so the editor's local edits don't mutate the seed.
      return Promise.resolve(
        (v ? { ...v, segments: v.segments.map((s) => ({ ...s })) } : null) as T,
      );
    }

    case "list_participants": {
      const interviewId = String(a.interviewId);
      const ps = (mockParticipants[interviewId] ?? []).map((p) => ({ ...p }));
      return Promise.resolve(ps as T);
    }

    case "save_participants": {
      const interviewId = String(a.interviewId);
      const input = (a.participants as ParticipantInput[]) ?? [];
      const saved: Participant[] = input.map((p) => ({
        id: p.id ?? uuid(),
        interview_id: interviewId,
        display_name: p.display_name,
        role: p.role,
        role_id: p.role_id ?? null,
        speaker_label: p.speaker_label && p.speaker_label.length ? p.speaker_label : null,
      }));
      mockParticipants[interviewId] = saved;
      return Promise.resolve(saved.map((p) => ({ ...p })) as T);
    }

    case "save_edited_transcript": {
      const input = a.input as {
        interview_id: string;
        segments: Segment[];
        participants: ParticipantInput[];
        language: string | null;
      };
      const interviewId = input.interview_id;
      const byKind = (mockVersions[interviewId] ??= {});
      // Enforce timing-immutability the same way the Rust path does: re-stamp each
      // saved segment's timing from the best stored source (edited→cleaned→raw).
      const source =
        byKind.edited?.segments ?? byKind.cleaned?.segments ?? byKind.raw?.segments ?? [];
      const segments: Segment[] = input.segments.map((s, i) => ({
        start_ms: source[i]?.start_ms ?? s.start_ms,
        end_ms: source[i]?.end_ms ?? s.end_ms,
        speaker_label: s.speaker_label,
        text: s.text,
      }));
      const existing = byKind.edited;
      const edited: TranscriptVersion = {
        id: existing?.id ?? "edited-" + interviewId,
        interview_id: interviewId,
        version: existing?.version ?? (byKind.raw?.version ?? 1) + 1,
        kind: "edited",
        language: input.language,
        engine: "editor",
        segments,
        created_at: Date.now(),
      };
      byKind.edited = edited;
      // Persist participants too + flip the interview row to 'edited'.
      mockParticipants[interviewId] = input.participants.map((p) => ({
        id: p.id ?? uuid(),
        interview_id: interviewId,
        display_name: p.display_name,
        role: p.role,
        role_id: p.role_id ?? null,
        speaker_label: p.speaker_label && p.speaker_label.length ? p.speaker_label : null,
      }));
      const iv = interviews.find((r) => r.id === interviewId);
      if (iv) {
        iv.status = "edited";
        iv.updated_at = Date.now();
      }
      return Promise.resolve(
        { ...edited, segments: edited.segments.map((s) => ({ ...s })) } as T,
      );
    }

    // --- M7 transcript cleanup -----------------------------------------------

    case "clean_transcript": {
      const interviewId = String(a.interviewId);
      const byKind = (mockVersions[interviewId] ??= {});
      const raw = byKind.raw;
      if (!raw) {
        return Promise.reject(
          new Error("no raw transcript to clean (transcribe first)"),
        );
      }
      const iv = interviews.find((r) => r.id === interviewId);
      if (iv) {
        iv.status = "cleaning";
        iv.updated_at = Date.now();
      }
      // Stream a couple of batch ticks, then store the cleaned version + flip the row.
      const total = raw.segments.length;
      const totalBatches = Math.max(1, Math.ceil(total / 40));
      let b = 0;
      emitCleanup({
        interview_id: interviewId,
        status: "cleaning",
        batch: 0,
        total_batches: totalBatches,
        progress: 0,
        error: null,
      });
      const tick = () => {
        b += 1;
        if (b < totalBatches) {
          emitCleanup({
            interview_id: interviewId,
            status: "cleaning",
            batch: b,
            total_batches: totalBatches,
            progress: Math.round((b / totalBatches) * 100),
            error: null,
          });
          setTimeout(tick, 300);
          return;
        }
        // Build the cleaned version: same count/timing/labels, only text rewritten.
        const cleaned: TranscriptVersion = {
          id: "cleaned-" + interviewId,
          interview_id: interviewId,
          version: (raw.version ?? 1) + 1,
          kind: "cleaned",
          language: raw.language,
          engine: "cli:transcript-cleanup",
          segments: raw.segments.map((s) => ({
            start_ms: s.start_ms,
            end_ms: s.end_ms,
            speaker_label: s.speaker_label,
            text: mockCleanText(s.text),
          })),
          created_at: Date.now(),
        };
        byKind.cleaned = cleaned;
        if (iv) {
          iv.status = "cleaned";
          iv.updated_at = Date.now();
        }
        emitCleanup({
          interview_id: interviewId,
          status: "cleaned",
          batch: totalBatches,
          total_batches: totalBatches,
          progress: 100,
          error: null,
        });
      };
      setTimeout(tick, 300);
      // Resolve once the cleaned row exists (matches the Rust command returning the id).
      return new Promise<T>((resolve) => {
        const wait = () => {
          const c = mockVersions[interviewId]?.cleaned;
          if (c) resolve(c.id as T);
          else setTimeout(wait, 150);
        };
        wait();
      });
    }

    case "rewrite_segment": {
      // Per-segment rewrite ("хуйня, переписывай"): the real backend sends ONE segment's text to
      // the CLI and gets back plain text. The browser preview has no CLI, so reuse the toy
      // mockCleanText after a short delay to demonstrate the loading → replace flow for review.
      const original = String(a.text ?? "");
      return new Promise<T>((resolve) => {
        setTimeout(() => {
          const cleaned = mockCleanText(original);
          resolve((cleaned.trim() ? cleaned : original) as T);
        }, 600);
      });
    }

    // --- M6/M11 CLI plugin layer ------------------------------------------
    case "list_adapters":
    case "rescan_plugins": {
      // Both return the same fresh list (the loader is stateless). Rescan is just the
      // re-enumerate-on-demand entry point the UI binds a button to.
      return Promise.resolve(mockAdapters.map((a) => ({ ...a })) as T);
    }

    case "get_active_adapter": {
      return Promise.resolve(mockActiveAdapter as T);
    }

    case "set_active_adapter": {
      mockActiveAdapter = String(a.id);
      return Promise.resolve(undefined as T);
    }

    case "get_task_model": {
      const bucket = String(a.bucket);
      return Promise.resolve((mockTaskModels[bucket] ?? "") as T);
    }

    case "set_task_model": {
      mockTaskModels[String(a.bucket)] = String(a.model);
      return Promise.resolve(undefined as T);
    }

    case "test_cli": {
      // No real CLI in the browser. The bundled Claude Code reference probes 'available'
      // (happy path); the proof plugins (Antigravity / Qwen) aren't installed → 'not-found',
      // exactly what the real probe reports for an absent CLI. Lets the Settings UI show
      // every status for design review.
      const id = a.adapterId ? String(a.adapterId) : mockActiveAdapter;
      const result: ProbeResult =
        id === "claude-code"
          ? {
              status: "available",
              detail: "CLI is installed and logged in. (dev mock)",
              version: "2.1.x (mock)",
            }
          : {
              status: "not-found",
              detail: `\`${
                mockAdapters.find((x) => x.id === id)?.command ?? id
              }\` is not installed or not on PATH. (dev mock)`,
              version: null,
            };
      return Promise.resolve(result as T);
    }

    case "run_task": {
      // The browser mock can't shell out; echo the trivial ping payload so any
      // verify wiring resolves. Real tasks land in M7–M9.
      return Promise.resolve({ ok: true } as T);
    }

    case "adapter_meta_instructions": {
      return Promise.resolve(MOCK_META_INSTRUCTIONS as T);
    }

    case "plugin_manifest_schema": {
      return Promise.resolve(MOCK_MANIFEST_SCHEMA as T);
    }

    // --- M8 cycle synthesis ----------------------------------------------------

    case "get_synthesis": {
      const cycleId = String(a.cycleId);
      const row = mockSynthesis[cycleId] ?? null;
      // Deep-ish clone so the tab's reads don't mutate the seed.
      return Promise.resolve(
        (row ? { ...row, doc: structuredClone(row.doc) } : null) as T,
      );
    }

    case "cycle_goals": {
      // Mirror the Rust derive_goals: parse the cycle's guide into discrete goals. For
      // the preview we use a small parser equivalent to the Rust one (Goals bullets →
      // G1, G2, …, keeping explicit "G1:" tags).
      const cycleId = String(a.cycleId);
      // M10a: source goals from the linked guide's content when set, else the inline text.
      return Promise.resolve(deriveGoals(effectiveGuide(cycleId)) as T);
    }

    case "run_synthesis": {
      const cycleId = String(a.cycleId);
      const goals = deriveGoals(effectiveGuide(cycleId));
      const ivs = interviews.filter((r) => r.cycle_id === cycleId);
      const total = Math.max(1, ivs.length);

      // Stream extract ticks (one per interview), then a reduce tick, then done.
      let done = 0;
      emitSynthesis({ cycle_id: cycleId, stage: "extract", done: 0, total, progress: 0, error: null });
      const tick = () => {
        done += 1;
        if (done < total) {
          emitSynthesis({
            cycle_id: cycleId,
            stage: "extract",
            done,
            total,
            progress: Math.round((done / total) * 80),
            error: null,
          });
          setTimeout(tick, 350);
          return;
        }
        emitSynthesis({ cycle_id: cycleId, stage: "reduce", done: total, total, progress: 85, error: null });
        setTimeout(() => {
          // Use the seeded synthesis if we have one for this cycle, else a minimal
          // goals-only doc so the run still resolves with something coherent.
          const seeded = mockSynthesis[cycleId];
          const doc: SynthesisDoc = seeded
            ? structuredClone(seeded.doc)
            : { goals, findings: [], open_questions: [], executive_summary: "", by_role: [] };
          const row: SynthesisRow = {
            id: seeded?.id ?? "synth-" + cycleId,
            cycle_id: cycleId,
            created_at: Date.now(),
            // M10b: re-render the editable markdown artifact from the (regenerated) doc.
            content_md: renderCycleMarkdown(doc),
            model_meta: JSON.stringify({
              adapter: "claude-code (dev mock)",
              interviews: ivs.length,
              goals: doc.goals.length,
              findings: doc.findings.length,
              // Product context (req #2) the real backend feeds the synthesis prompt.
              product_chars: effectiveProduct(cycleId).trim().length,
            }),
            doc,
          };
          mockSynthesis[cycleId] = row;
          emitSynthesis({ cycle_id: cycleId, stage: "done", done: total, total, progress: 100, error: null });
        }, 500);
      };
      setTimeout(tick, 350);

      return new Promise<T>((resolve) => {
        const wait = () => {
          const r = mockSynthesis[cycleId];
          // Resolve once the done tick has refreshed the row's created_at to ~now.
          if (r && Date.now() - r.created_at < 5000) {
            resolve({ ...r, doc: structuredClone(r.doc) } as T);
          } else {
            setTimeout(wait, 150);
          }
        };
        wait();
      });
    }

    // M10b: save the user's edit of the cycle synthesis markdown artifact.
    case "save_cycle_synthesis": {
      const cycleId = String(a.cycleId);
      const contentMd = String(a.contentMd ?? "");
      const row = mockSynthesis[cycleId];
      if (!row) {
        return Promise.reject(
          new Error("no synthesis to edit — run synthesis first"),
        );
      }
      row.content_md = contentMd; // structured doc untouched (matches Rust).
      return Promise.resolve(
        { ...row, doc: structuredClone(row.doc) } as T,
      );
    }

    // --- M10b per-interview summary -------------------------------------------

    case "get_interview_summary": {
      const interviewId = String(a.interviewId);
      const row = mockInterviewSummaries[interviewId] ?? null;
      return Promise.resolve(
        (row ? { ...row, doc: structuredClone(row.doc) } : null) as T,
      );
    }

    case "run_interview_summary": {
      const interviewId = String(a.interviewId);
      emitSummary({ interview_id: interviewId, stage: "running", progress: 20, error: null });
      setTimeout(() => {
        emitSummary({ interview_id: interviewId, stage: "running", progress: 60, error: null });
      }, 350);
      setTimeout(() => {
        const iv = interviews.find((r) => r.id === interviewId);
        const cycleId = iv?.cycle_id ?? "";
        const seeded = mockInterviewSummaries[interviewId];
        const doc: InterviewSummaryDoc = seeded
          ? structuredClone(seeded.doc)
          : { goals: deriveGoals(effectiveGuide(cycleId)), by_goal: [], notable: [] };
        const row: InterviewSummaryRow = {
          id: seeded?.id ?? "summary-" + interviewId,
          cycle_id: cycleId,
          interview_id: interviewId,
          created_at: Date.now(),
          model_meta: JSON.stringify({ adapter: "claude-code (dev mock)", goals: doc.goals.length }),
          content_md: renderInterviewMarkdown(doc, titleForMock(interviewId)),
          doc,
        };
        mockInterviewSummaries[interviewId] = row;
        emitSummary({ interview_id: interviewId, stage: "done", progress: 100, error: null });
      }, 700);

      return new Promise<T>((resolve) => {
        const wait = () => {
          const r = mockInterviewSummaries[interviewId];
          if (r && Date.now() - r.created_at < 5000) {
            resolve({ ...r, doc: structuredClone(r.doc) } as T);
          } else {
            setTimeout(wait, 150);
          }
        };
        wait();
      });
    }

    case "save_interview_summary": {
      const interviewId = String(a.interviewId);
      const contentMd = String(a.contentMd ?? "");
      const row = mockInterviewSummaries[interviewId];
      if (!row) {
        return Promise.reject(
          new Error("no interview summary to edit — run it first"),
        );
      }
      row.content_md = contentMd;
      return Promise.resolve(
        { ...row, doc: structuredClone(row.doc) } as T,
      );
    }

    // --- M9 cycle diff ---------------------------------------------------------

    case "get_diff": {
      const cycleId = String(a.cycleId);
      const row = mockDiff[cycleId] ?? null;
      return Promise.resolve(
        (row ? { ...row, doc: structuredClone(row.doc) } : null) as T,
      );
    }

    case "diff_status": {
      const cycleId = String(a.cycleId);
      return Promise.resolve(mockDiffStatus(cycleId) as T);
    }

    case "run_diff": {
      const cycleId = String(a.cycleId);
      const status = mockDiffStatus(cycleId);
      if (status.readiness !== "ready") {
        // Mirror the Rust precondition guard — a not-ready cycle rejects with a message.
        return Promise.reject(
          new Error(
            status.readiness === "no-prev-cycle"
              ? "This cycle has no previous wave set."
              : status.readiness === "no-current-synthesis"
                ? "Run synthesis on this cycle first."
                : "The previous wave has no synthesis yet.",
          ),
        );
      }

      // Stream a couple of progress ticks, then resolve with the seeded diff (or, for an
      // un-seeded ready cycle, an empty-but-coherent diff so the run still resolves).
      emitDiff({ cycle_id: cycleId, stage: "diffing", progress: 20, error: null });
      setTimeout(() => {
        emitDiff({ cycle_id: cycleId, stage: "diffing", progress: 60, error: null });
      }, 350);
      setTimeout(() => {
        const seeded = mockDiff[cycleId];
        const doc: DiffDoc = seeded
          ? structuredClone(seeded.doc)
          : {
              goals: deriveGoals(effectiveGuide(cycleId)).map((g) => ({
                id: g.id,
                text: g.text,
              })),
              by_goal: [],
              summary: "No material changes detected between the two waves.",
            };
        const row: DiffRow = {
          id: seeded?.id ?? "diff-" + cycleId,
          cycle_id: cycleId,
          prev_cycle_id: status.prev_cycle_id ?? "",
          created_at: Date.now(),
          doc,
        };
        mockDiff[cycleId] = row;
        emitDiff({ cycle_id: cycleId, stage: "done", progress: 100, error: null });
      }, 700);

      return new Promise<T>((resolve) => {
        const wait = () => {
          const r = mockDiff[cycleId];
          if (r && Date.now() - r.created_at < 5000) {
            resolve({ ...r, doc: structuredClone(r.doc) } as T);
          } else {
            setTimeout(wait, 150);
          }
        };
        wait();
      });
    }

    // --- M10a role library ----------------------------------------------------

    case "list_roles": {
      const sorted = [...roles].sort(
        (x, y) => x.sort - y.sort || x.created_at - y.created_at,
      );
      return Promise.resolve(sorted.map((r) => ({ ...r })) as T);
    }

    case "create_role": {
      const req = (a.req ?? {}) as CreateRoleInput;
      const ts = Date.now();
      const sort =
        req.sort != null
          ? req.sort
          : (roles.reduce((m, r) => Math.max(m, r.sort), -1) + 1);
      const role: Role = {
        id: uuid(),
        name: (req.name ?? "").trim() || "Untitled role",
        color: req.color || "#9a9ca3",
        sort,
        created_at: ts,
        updated_at: ts,
      };
      roles.push(role);
      return Promise.resolve({ ...role } as T);
    }

    case "update_role": {
      const req = a.req as UpdateRoleInput;
      const role = roles.find((r) => r.id === req.id);
      if (!role) return Promise.reject(new Error(`role not found: ${req.id}`));
      role.name = req.name.trim() || role.name;
      role.color = req.color;
      role.sort = req.sort;
      role.updated_at = Date.now();
      return Promise.resolve({ ...role } as T);
    }

    case "delete_role": {
      const id = String(a.id);
      // Guard: refuse to delete a role still bound to a participant (mirrors Rust).
      let used = 0;
      for (const list of Object.values(mockParticipants)) {
        used += list.filter((p) => (p.role_id ?? p.role) === id).length;
      }
      if (used > 0) {
        return Promise.reject(
          new Error(
            `This role is used by ${used} participant${used === 1 ? "" : "s"} — reassign them first.`,
          ),
        );
      }
      const i = roles.findIndex((r) => r.id === id);
      if (i >= 0) roles.splice(i, 1);
      return Promise.resolve(undefined as T);
    }

    // --- M10a guide library ---------------------------------------------------

    case "list_guides": {
      const sorted = [...guides].sort((x, y) => y.updated_at - x.updated_at);
      return Promise.resolve(
        sorted.map((g) => ({ ...g, goals: g.goals.map((x) => ({ ...x })) })) as T,
      );
    }

    case "get_guide": {
      const id = String(a.id);
      const g = guides.find((g) => g.id === id) ?? null;
      return Promise.resolve(
        (g ? { ...g, goals: g.goals.map((x) => ({ ...x })) } : null) as T,
      );
    }

    case "create_guide": {
      const req = (a.req ?? {}) as CreateGuideInput;
      const ts = Date.now();
      const content_md = req.content_md ?? "";
      const guide: Guide = {
        id: uuid(),
        name: (req.name ?? "").trim() || "Untitled guide",
        content_md,
        goals: deriveGoals(content_md),
        created_at: ts,
        updated_at: ts,
      };
      guides.push(guide);
      return Promise.resolve({ ...guide, goals: guide.goals.map((x) => ({ ...x })) } as T);
    }

    case "update_guide": {
      const req = a.req as UpdateGuideInput;
      const guide = guides.find((g) => g.id === req.id);
      if (!guide) return Promise.reject(new Error(`guide not found: ${req.id}`));
      guide.name = req.name.trim() || guide.name;
      guide.content_md = req.content_md;
      // Re-derive goals from the new content (stable ids), exactly like the Rust backend.
      guide.goals = deriveGoals(req.content_md);
      guide.updated_at = Date.now();
      return Promise.resolve({ ...guide, goals: guide.goals.map((x) => ({ ...x })) } as T);
    }

    case "delete_guide": {
      const id = String(a.id);
      const i = guides.findIndex((g) => g.id === id);
      if (i >= 0) guides.splice(i, 1);
      // Unlink any cycle pointing at it (mirrors Rust: guide_id cleared, inline text kept).
      for (const c of cycles) if (c.guide_id === id) c.guide_id = null;
      return Promise.resolve(undefined as T);
    }

    // --- Products library -----------------------------------------------------

    case "list_products": {
      const sorted = [...products].sort((x, y) => y.updated_at - x.updated_at);
      return Promise.resolve(sorted.map((p) => ({ ...p })) as T);
    }

    case "get_product": {
      const id = String(a.id);
      const p = products.find((p) => p.id === id) ?? null;
      return Promise.resolve((p ? { ...p } : null) as T);
    }

    case "create_product": {
      const req = (a.req ?? {}) as CreateProductInput;
      const ts = Date.now();
      const product: Product = {
        id: uuid(),
        name: (req.name ?? "").trim() || "Untitled product",
        content_md: req.content_md ?? "",
        created_at: ts,
        updated_at: ts,
      };
      products.push(product);
      return Promise.resolve({ ...product } as T);
    }

    case "update_product": {
      const req = a.req as UpdateProductInput;
      const product = products.find((p) => p.id === req.id);
      if (!product) return Promise.reject(new Error(`product not found: ${req.id}`));
      product.name = req.name.trim() || product.name;
      product.content_md = req.content_md;
      product.updated_at = Date.now();
      return Promise.resolve({ ...product } as T);
    }

    case "delete_product": {
      const id = String(a.id);
      const i = products.findIndex((p) => p.id === id);
      if (i >= 0) products.splice(i, 1);
      // Unlink any cycle pointing at it (mirrors Rust: product_id cleared, inline kept).
      for (const c of cycles) if (c.product_id === id) c.product_id = null;
      // Cascade-delete the product's glossary (mirrors the FK ON DELETE CASCADE).
      for (let i = glossaryTerms.length - 1; i >= 0; i--) {
        if (glossaryTerms[i].product_id === id) glossaryTerms.splice(i, 1);
      }
      return Promise.resolve(undefined as T);
    }

    // --- Glossary (docs/transcription-terminology.md) -------------------------
    case "list_glossary_terms": {
      const productId = String(a.productId);
      const rows = glossaryTerms
        .filter((t) => t.product_id === productId)
        .sort((x, y) => x.canonical.localeCompare(y.canonical));
      return Promise.resolve(rows.map((t) => ({ ...t })) as T);
    }

    case "create_glossary_term": {
      const req = (a.req ?? {}) as CreateGlossaryTermInput;
      const ts = Date.now();
      const term: GlossaryTerm = {
        id: uuid(),
        product_id: req.product_id,
        canonical: (req.canonical ?? "").trim(),
        aliases: (req.aliases ?? []).map((s) => s.trim()).filter(Boolean),
        notes: (req.notes ?? "").trim(),
        created_at: ts,
        updated_at: ts,
      };
      glossaryTerms.push(term);
      return Promise.resolve({ ...term } as T);
    }

    case "update_glossary_term": {
      const req = a.req as UpdateGlossaryTermInput;
      const term = glossaryTerms.find((t) => t.id === req.id);
      if (!term) return Promise.reject(new Error(`glossary term not found: ${req.id}`));
      term.canonical = req.canonical.trim() || term.canonical;
      term.aliases = (req.aliases ?? []).map((s) => s.trim()).filter(Boolean);
      term.notes = (req.notes ?? "").trim();
      term.updated_at = Date.now();
      return Promise.resolve({ ...term } as T);
    }

    case "delete_glossary_term": {
      const id = String(a.id);
      const i = glossaryTerms.findIndex((t) => t.id === id);
      if (i >= 0) glossaryTerms.splice(i, 1);
      return Promise.resolve(undefined as T);
    }

    case "add_glossary_terms": {
      const productId = String(a.productId);
      const incoming = (a.terms ?? []) as NewGlossaryTerm[];
      const seen = new Set(
        glossaryTerms
          .filter((t) => t.product_id === productId)
          .map((t) => t.canonical.trim().toLowerCase()),
      );
      const ts = Date.now();
      const inserted: GlossaryTerm[] = [];
      for (const n of incoming) {
        const key = (n.canonical ?? "").trim().toLowerCase();
        if (!key || seen.has(key)) continue;
        seen.add(key);
        const term: GlossaryTerm = {
          id: uuid(),
          product_id: productId,
          canonical: n.canonical.trim(),
          aliases: (n.aliases ?? []).map((s) => s.trim()).filter(Boolean),
          notes: (n.notes ?? "").trim(),
          created_at: ts,
          updated_at: ts,
        };
        glossaryTerms.push(term);
        inserted.push({ ...term });
      }
      return Promise.resolve(inserted as T);
    }

    case "suggest_glossary_terms":
    case "suggest_glossary_terms_from_edits": {
      const interviewId = String(a.interviewId);
      const iv = interviews.find((i) => i.id === interviewId);
      const cycle = iv ? cycles.find((c) => c.id === iv.cycle_id) : undefined;
      const productId = cycle?.product_id ?? null;
      const product = productId ? products.find((p) => p.id === productId) : undefined;
      const existing = new Set(
        glossaryTerms
          .filter((t) => t.product_id === productId)
          .map((t) => t.canonical.trim().toLowerCase()),
      );
      const pool: SuggestedTerm[] =
        cmd === "suggest_glossary_terms_from_edits"
          ? [
              { canonical: "Jira", aliases: ["джира"], notes: "", reason: "you corrected «джира» → «Jira» in your edits" },
              { canonical: "churn", aliases: ["чёрн"], notes: "", reason: "kept the English term, fixed the spelling" },
            ]
          : [
              { canonical: "Figma", aliases: ["фигма"], notes: "", reason: "design tool mentioned several times" },
              { canonical: "retention", aliases: ["ретеншн"], notes: "", reason: "core metric in the interview" },
              { canonical: "MVP", aliases: ["эм-ви-пи"], notes: "", reason: "acronym rendered phonetically" },
            ];
      const terms = pool.filter((t) => !existing.has(t.canonical.toLowerCase()));
      const result: SuggestResult = {
        product_id: productId,
        product_name: product?.name ?? null,
        terms,
      };
      return new Promise((resolve) => setTimeout(() => resolve(result as T), 500));
    }

    // --- Cycle chat (M11 Phase A) ---------------------------------------------
    case "list_chat_threads": {
      const cycleId = String(a.cycleId);
      const rows = mockChatThreads
        .filter((t) => t.cycle_id === cycleId)
        .sort((x, y) => y.updated_at - x.updated_at);
      return Promise.resolve(rows.map((t) => ({ ...t })) as T);
    }

    case "create_chat_thread": {
      const cycleId = String(a.cycleId);
      const ts = Date.now();
      const thread: ChatThread = {
        id: uuid(),
        cycle_id: cycleId,
        title: (a.title as string | null) ?? "New chat",
        session_id: null,
        created_at: ts,
        updated_at: ts,
      };
      mockChatThreads.push(thread);
      mockChatMessages[thread.id] = [];
      return Promise.resolve({ ...thread } as T);
    }

    case "rename_chat_thread": {
      const threadId = String(a.threadId);
      const t = mockChatThreads.find((x) => x.id === threadId);
      if (t) {
        t.title = String(a.title);
        t.updated_at = Date.now();
      }
      return Promise.resolve({ ...(t as ChatThread) } as T);
    }

    case "delete_chat_thread": {
      const threadId = String(a.threadId);
      mockChatCancelled.add(threadId);
      const i = mockChatThreads.findIndex((x) => x.id === threadId);
      if (i >= 0) mockChatThreads.splice(i, 1);
      delete mockChatMessages[threadId];
      return Promise.resolve(undefined as T);
    }

    case "get_chat_messages": {
      const threadId = String(a.threadId);
      const rows = mockChatMessages[threadId] ?? [];
      return Promise.resolve(rows.map((m) => ({ ...m })) as T);
    }

    case "cycle_chat_append": {
      const threadId = String(a.threadId);
      const ts = Date.now();
      const msg: ChatMessage = {
        id: uuid(),
        thread_id: threadId,
        role: "user",
        content: String(a.content),
        citations_json: "[]",
        status: "complete",
        error: null,
        cost_usd: null,
        created_at: ts,
      };
      (mockChatMessages[threadId] ??= []).push(msg);
      const t = mockChatThreads.find((x) => x.id === threadId);
      if (t) t.updated_at = ts;
      return Promise.resolve({ ...msg } as T);
    }

    case "cycle_chat_send": {
      const threadId = String(a.threadId);
      const text = String(a.text).toLowerCase();
      // Auto-title a fresh thread from the first question (mirrors the Rust runner).
      const thread = mockChatThreads.find((x) => x.id === threadId);
      if (thread && (thread.title === "" || thread.title === "New chat")) {
        thread.title = String(a.text).slice(0, 60);
      }
      mockChatCancelled.delete(threadId);

      // A canned, GROUNDED answer with a citation or two (so the panel renders +
      // streams Streamdown markdown + chips in the browser preview). Tailored a little
      // to the question so the demo reads naturally.
      const answer = text.includes("chang")
        ? "Versus the previous wave, the **data-source connect** blocker is unchanged and still the top stall point [[finding:F1]], while confusion on the event-mapping step has eased after the inline examples shipped. The clearest new signal is the explicit ask for a guided setup wizard [[finding:F1]].\n\nFor the verbatim, see [[iv:" +
          FIRST_INTERVIEW_ID +
          " seg:3]]."
        : "The top objections in this cycle:\n\n1. **Data-source connect** — new accounts stall because it demands warehouse credentials they don't have at signup [[finding:F1]]. One participant put it plainly: \"it asked me to pick a warehouse and I didn't have those credentials on hand\" [[iv:" +
          FIRST_INTERVIEW_ID +
          " seg:3]].\n2. **Event-mapping overwhelm** — the long field list pushes people to guess [[interview:" +
          FIRST_INTERVIEW_ID +
          "]].\n\n> Recommendation: defer the live connect and offer a sample dataset so users reach a first funnel sooner.";

      // Stream it word-by-word, then persist + emit done. Respects the cancel flag.
      const words = answer.split(/(\s+)/);
      let i = 0;
      let full = "";
      const step = () => {
        if (mockChatCancelled.has(threadId)) {
          emitChat(threadId, { kind: "error", thread_id: threadId, message: "cancelled" });
          return;
        }
        if (i < words.length) {
          const chunk = words[i];
          full += chunk;
          emitChat(threadId, { kind: "token", thread_id: threadId, text: chunk });
          i += 1;
          mockChatTimer = setTimeout(step, 24);
          return;
        }
        // Done: persist the assistant message + parse citations (mirror the Rust regex).
        const ts = Date.now();
        const citations = mockParseCitations(full);
        const msg: ChatMessage = {
          id: uuid(),
          thread_id: threadId,
          role: "assistant",
          content: full,
          citations_json: JSON.stringify(citations),
          status: "complete",
          error: null,
          cost_usd: 0.0123,
          created_at: ts,
        };
        (mockChatMessages[threadId] ??= []).push(msg);
        if (thread) {
          thread.session_id = thread.session_id ?? "dev-mock-session-" + threadId.slice(0, 8);
          thread.updated_at = ts;
        }
        emitChat(threadId, {
          kind: "done",
          thread_id: threadId,
          message_id: msg.id,
          session_id: thread?.session_id ?? null,
          cost_usd: 0.0123,
        });
      };
      mockChatTimer = setTimeout(step, 120);
      return Promise.resolve(undefined as T);
    }

    case "cycle_chat_cancel": {
      const threadId = String(a.threadId);
      mockChatCancelled.add(threadId);
      if (mockChatTimer) clearTimeout(mockChatTimer);
      return Promise.resolve(undefined as T);
    }

    default:
      return Promise.reject(new Error(`dev-mock: unhandled command "${cmd}"`));
  }
}

// Parse [[…]] citation tokens (mirror of the Rust chat.rs parse_citations) for the mock.
function mockParseCitations(
  content: string,
): Array<
  | { kind: "finding"; finding_id: string }
  | { kind: "interview"; interview_id: string }
  | { kind: "segment"; interview_id: string; segment_id: number }
> {
  const out: ReturnType<typeof mockParseCitations> = [];
  const re = /\[\[([^\]]+)\]\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    const inner = m[1].trim();
    if (inner.startsWith("finding:")) {
      out.push({ kind: "finding", finding_id: inner.slice(8).trim() });
    } else if (inner.startsWith("interview:")) {
      out.push({ kind: "interview", interview_id: inner.slice(10).trim() });
    } else if (inner.startsWith("iv:")) {
      const parts = inner.slice(3).trim().split(/\s+/);
      if (parts.length === 2 && parts[1].startsWith("seg:")) {
        const n = parseInt(parts[1].slice(4), 10);
        if (!Number.isNaN(n))
          out.push({ kind: "segment", interview_id: parts[0], segment_id: n });
      }
    }
  }
  return out;
}
