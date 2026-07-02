import { useEffect } from "react";
import { create } from "zustand";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import {
  ASR_PROGRESS_EVENT,
  CLEANUP_PROGRESS_EVENT,
  COVERAGE_PROGRESS_EVENT,
  DIAR_PROGRESS_EVENT,
  INTERVIEW_PROGRESS_EVENT,
  MODEL_PROGRESS_EVENT,
  SYNTHESIS_PROGRESS_EVENT,
  IN_TAURI,
  type AsrProgress,
  type CleanupProgress,
  type DiarProgress,
  type InterviewProgress,
  type InterviewRow,
  type ModelProgress,
  type SynthesisProgress,
} from "@/lib/tauri";

// Global background-task center (v3 F1, P1 fix): long-op progress used to live in
// page-local state and DIED on navigation. This store subscribes ONCE (useTaskEvents,
// mounted in App) to every progress event the backend streams and normalizes them into
// one task list the header TaskCenter renders — so progress survives any navigation.
//
// EPHEMERAL UI state, no persistence: the authoritative status is always the backend's.
// Task ids are stable per kind+entity (`asr:<interview_id>`, `synthesis:<cycle_id>`, …)
// so a stream of events updates one row instead of appending.

// `model` = a Whisper model download (asr://model-progress) — not in the original kind
// list but it is a long op the user loses track of just the same.
export type TaskKind =
  | "asr"
  | "import"
  | "cleanup"
  | "synthesis"
  | "diarize"
  | "coverage"
  | "model";

export type TaskStatus = "running" | "done" | "error";

export type BackgroundTask = {
  id: string;
  kind: TaskKind;
  // The localized kind name renders in the UI; `label` is the entity hint next to it
  // (interview title / model id), resolved best-effort from the react-query cache.
  label?: string;
  cycleId?: string;
  interviewId?: string;
  progressPct?: number; // undefined = indeterminate
  status: TaskStatus;
  detail?: string; // error message or secondary info ("2/5")
  startedAt: number; // unix ms — drives the elapsed readout
  finishedAt?: number; // stamped on done/error
};

// What event handlers pass in; the store merges it over the existing task.
type TaskPatch = {
  id: string;
  kind: TaskKind;
  status: TaskStatus;
  label?: string;
  cycleId?: string;
  interviewId?: string;
  progressPct?: number;
  detail?: string;
};

type TaskState = {
  tasks: Record<string, BackgroundTask>;
  // The header popover's open state lives here (not ui-store) so the palette + the
  // ⌘⇧B shortcut can toggle it without prop-drilling.
  open: boolean;
  setOpen: (open: boolean) => void;
  toggleOpen: () => void;
  upsert: (patch: TaskPatch) => void;
  dismiss: (id: string) => void;
};

// Done tasks linger a minute (so a finished run is still visible after you look away),
// then auto-prune. Errors stay until dismissed.
const DONE_TTL_MS = 60_000;
const pruneTimers = new Map<string, ReturnType<typeof setTimeout>>();

export const useTaskStore = create<TaskState>((set) => ({
  tasks: {},
  open: false,
  setOpen: (open) => set({ open }),
  toggleOpen: () => set((s) => ({ open: !s.open })),

  upsert: (patch) =>
    set((s) => {
      const prev = s.tasks[patch.id];
      // A running event after a terminal state (or from nothing) starts a FRESH run:
      // restart the clock and drop stale progress/detail.
      const restarted =
        patch.status === "running" && (!prev || prev.status !== "running");
      const task: BackgroundTask = {
        id: patch.id,
        kind: patch.kind,
        status: patch.status,
        label: patch.label ?? prev?.label,
        cycleId: patch.cycleId ?? prev?.cycleId,
        interviewId: patch.interviewId ?? prev?.interviewId,
        progressPct:
          patch.status === "done"
            ? 100
            : (patch.progressPct ?? (restarted ? undefined : prev?.progressPct)),
        detail: patch.detail ?? (restarted ? undefined : prev?.detail),
        startedAt: restarted || !prev ? Date.now() : prev.startedAt,
        finishedAt:
          patch.status === "running"
            ? undefined
            : prev?.status === patch.status && prev.finishedAt
              ? prev.finishedAt
              : Date.now(),
      };

      // (Re)schedule the done auto-prune; any newer event cancels the pending one.
      const pending = pruneTimers.get(patch.id);
      if (pending) {
        clearTimeout(pending);
        pruneTimers.delete(patch.id);
      }
      if (patch.status === "done") {
        pruneTimers.set(
          patch.id,
          setTimeout(() => {
            pruneTimers.delete(patch.id);
            const cur = useTaskStore.getState().tasks[patch.id];
            if (cur && cur.status === "done")
              useTaskStore.getState().dismiss(patch.id);
          }, DONE_TTL_MS),
        );
      }

      return { tasks: { ...s.tasks, [patch.id]: task } };
    }),

  dismiss: (id) =>
    set((s) => {
      if (!s.tasks[id]) return s;
      const next = { ...s.tasks };
      delete next[id];
      return { tasks: next };
    }),
}));

// --- helpers -------------------------------------------------------------------

// Best-effort resolve an interview row (title + cycle) from ANY cached interview list.
// Events only carry ids; the cache usually has the row because the user just acted on it.
function findInterview(
  qc: QueryClient,
  interviewId: string,
): InterviewRow | undefined {
  for (const [, rows] of qc.getQueriesData<InterviewRow[]>({
    queryKey: ["interviews"],
  })) {
    const hit = rows?.find((r) => r.id === interviewId);
    if (hit) return hit;
  }
  return undefined;
}

// Where clicking a task should land. null = nowhere to go (yet).
export function taskTarget(
  task: BackgroundTask,
  qc: QueryClient,
): string | null {
  if (task.kind === "model") return "/settings?tab=transcription";
  let cycleId = task.cycleId;
  if (!cycleId && task.interviewId)
    cycleId = findInterview(qc, task.interviewId)?.cycle_id;
  if (!cycleId) return null;
  if (task.kind === "synthesis") return `/cycles/${cycleId}?tab=synthesis`;
  if (task.kind === "import") return `/cycles/${cycleId}?tab=interviews`;
  if (task.interviewId)
    return `/cycles/${cycleId}/interviews/${task.interviewId}`;
  return `/cycles/${cycleId}`;
}

// --- the single global subscription ---------------------------------------------

// v3 coverage (B1, lands in parallel): the event name comes from the tauri.ts seam, but
// the payload is read defensively — every field optional, so a payload-shape drift
// degrades to an indeterminate task instead of a crash.
type CoverageProgressLoose = {
  interview_id?: string | null;
  cycle_id?: string | null;
  stage?: string | null; // 'started' | 'running' | 'done' | 'error'
  status?: string | null;
  progress?: number | null;
  error?: string | null;
};

// Mount ONCE, in App. Normalizes every backend progress stream into the task store.
// Purely additive: existing page-local listeners (row badges, toasts, invalidations)
// keep working — Tauri delivers app-emitted events to every listener.
export function useTaskEvents() {
  const qc = useQueryClient();

  useEffect(() => {
    if (!IN_TAURI) return;
    const upsert = (patch: TaskPatch) => useTaskStore.getState().upsert(patch);
    const w = getCurrentWebview();

    const subs = [
      // asr://progress — whisper transcription per interview. progress -1 = a live
      // segment tick (no percent): keep the previous pct, just keep the task running.
      w.listen<AsrProgress>(ASR_PROGRESS_EVENT, (e) => {
        const p = e.payload;
        const row = findInterview(qc, p.interview_id);
        upsert({
          id: `asr:${p.interview_id}`,
          kind: "asr",
          interviewId: p.interview_id,
          cycleId: row?.cycle_id,
          label: row?.title,
          status:
            p.status === "transcribed"
              ? "done"
              : p.status === "error"
                ? "error"
                : "running",
          progressPct: p.progress >= 0 ? p.progress : undefined,
          detail: p.error ?? undefined,
        });
      }),

      // asr://diar-progress — diarization per interview (no error message in payload).
      w.listen<DiarProgress>(DIAR_PROGRESS_EVENT, (e) => {
        const p = e.payload;
        const row = findInterview(qc, p.interview_id);
        upsert({
          id: `diarize:${p.interview_id}`,
          kind: "diarize",
          interviewId: p.interview_id,
          cycleId: row?.cycle_id,
          label: row?.title,
          status:
            p.status === "done"
              ? "done"
              : p.status === "error"
                ? "error"
                : "running",
          progressPct: p.progress >= 0 ? p.progress : undefined,
        });
      }),

      // asr://model-progress — Whisper model download (byte-level).
      w.listen<ModelProgress>(MODEL_PROGRESS_EVENT, (e) => {
        const p = e.payload;
        upsert({
          id: `model:${p.model_id}`,
          kind: "model",
          label: p.model_id,
          status: p.error ? "error" : p.done ? "done" : "running",
          progressPct:
            p.total_bytes > 0
              ? Math.min(
                  100,
                  Math.round((p.downloaded_bytes / p.total_bytes) * 100),
                )
              : undefined,
          detail: p.error ?? undefined,
        });
      }),

      // interview://progress — file import/prep. No percent; 'importing' → running,
      // 'error' → error, anything else ('new' = ready) → done.
      w.listen<InterviewProgress>(INTERVIEW_PROGRESS_EVENT, (e) => {
        const p = e.payload;
        const row = findInterview(qc, p.interview_id);
        upsert({
          id: `import:${p.interview_id}`,
          kind: "import",
          interviewId: p.interview_id,
          cycleId: p.cycle_id,
          label: row?.title,
          status:
            p.status === "importing"
              ? "running"
              : p.status === "error"
                ? "error"
                : "done",
          detail: p.error ?? undefined,
        });
      }),

      // cleanup://progress — batch-level transcript cleanup.
      w.listen<CleanupProgress>(CLEANUP_PROGRESS_EVENT, (e) => {
        const p = e.payload;
        const row = findInterview(qc, p.interview_id);
        upsert({
          id: `cleanup:${p.interview_id}`,
          kind: "cleanup",
          interviewId: p.interview_id,
          cycleId: row?.cycle_id,
          label: row?.title,
          status:
            p.status === "cleaned"
              ? "done"
              : p.status === "error"
                ? "error"
                : "running",
          progressPct: p.progress >= 0 ? p.progress : undefined,
          detail:
            p.error ??
            (p.status === "cleaning" && p.total_batches > 0
              ? `${p.batch}/${p.total_batches}`
              : undefined),
        });
      }),

      // synthesis://progress — cycle map-reduce (stage-level).
      w.listen<SynthesisProgress>(SYNTHESIS_PROGRESS_EVENT, (e) => {
        const p = e.payload;
        upsert({
          id: `synthesis:${p.cycle_id}`,
          kind: "synthesis",
          cycleId: p.cycle_id,
          status:
            p.stage === "done"
              ? "done"
              : p.stage === "error"
                ? "error"
                : "running",
          progressPct: p.progress >= 0 ? p.progress : undefined,
          detail:
            p.error ??
            (p.stage === "extract" && p.total > 0
              ? `${p.done}/${p.total}`
              : undefined),
        });
      }),

      // coverage://progress — guide coverage per interview (v3 B1; defensive shape).
      w.listen<CoverageProgressLoose>(COVERAGE_PROGRESS_EVENT, (e) => {
        const p = e.payload ?? {};
        const stage = (p.status ?? p.stage ?? "").toLowerCase();
        const interviewId = p.interview_id ?? undefined;
        const row = interviewId ? findInterview(qc, interviewId) : undefined;
        upsert({
          id: `coverage:${interviewId ?? p.cycle_id ?? "run"}`,
          kind: "coverage",
          interviewId,
          cycleId: p.cycle_id ?? row?.cycle_id,
          label: row?.title,
          status:
            p.error || stage === "error"
              ? "error"
              : stage === "done"
                ? "done"
                : "running",
          progressPct:
            typeof p.progress === "number" && p.progress >= 0
              ? p.progress
              : undefined,
          detail: p.error ?? undefined,
        });
      }),
    ];

    return () => {
      subs.forEach((sub) => {
        sub.then((fn) => fn());
      });
    };
  }, [qc]);
}
