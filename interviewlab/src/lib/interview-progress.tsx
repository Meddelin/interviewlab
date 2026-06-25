import {
  createContext,
  useContext,
  useEffect,
  useState,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { interviewKeys } from "@/lib/interview-queries";
import {
  ASR_PROGRESS_EVENT,
  CLEANUP_PROGRESS_EVENT,
  DIAR_PROGRESS_EVENT,
  IN_TAURI,
  INTERVIEW_PROGRESS_EVENT,
  type AsrProgress,
  type CleanupProgress,
  type DiarProgress,
  type InterviewProgress,
} from "@/lib/tauri";
// dev-mock: browser-only, never active under Tauri.
import {
  mockOnAsrProgress,
  mockOnCleanupProgress,
  mockOnProgress,
} from "@/lib/dev-mock";

type NumMap = Record<string, number>;
type BoolMap = Record<string, boolean>;

type InterviewProgressValue = {
  // interview_id → live transcription percent (cleared on terminal status).
  asrProgress: NumMap;
  // interview_id → true while in the diarization phase (after whisper 100%, before `transcribed`).
  diarizing: BoolMap;
  // interview_id → live cleanup percent (cleared on terminal status).
  cleanProgress: NumMap;
  // Exposed so callers can paint optimistic state before the first event lands (e.g. flip a
  // row to "Transcribing 0%" the instant Transcribe is clicked).
  setAsrProgress: Dispatch<SetStateAction<NumMap>>;
  setCleanProgress: Dispatch<SetStateAction<NumMap>>;
};

const InterviewProgressContext = createContext<InterviewProgressValue | null>(
  null,
);

/**
 * Owns the live ASR / diarization / cleanup progress subscriptions for a cycle.
 *
 * CRITICAL: this MUST be mounted ABOVE the cycle's tabs (in CycleDetailPage), not inside
 * the Interviews tab. Radix `TabsContent` unmounts inactive tabs, so if these listeners
 * lived in InterviewsTab they'd be torn down the moment the user switched to another tab —
 * the backend transcription/diarization keeps running (it's a detached Tauri task), but the
 * UI would miss every progress + terminal event while away. Hoisting the subscriptions here
 * keeps the percent ticking and the badges reconciling across tab switches; the work itself
 * was never interrupted (only the explicit Stop button / watchdog ever cancels a run).
 */
export function InterviewProgressProvider({
  cycleId,
  children,
}: {
  cycleId: string;
  children: ReactNode;
}) {
  const qc = useQueryClient();
  const [asrProgress, setAsrProgress] = useState<NumMap>({});
  const [diarizing, setDiarizing] = useState<BoolMap>({});
  const [cleanProgress, setCleanProgress] = useState<NumMap>({});

  // Media-prep (ingest) progress: each finished file emits `interview://progress`; just
  // invalidate this cycle's list so the table re-renders with new status/duration.
  useEffect(() => {
    if (!IN_TAURI) {
      return mockOnProgress((payload) => {
        if (payload.cycle_id !== cycleId) return;
        qc.invalidateQueries({ queryKey: interviewKeys.list(cycleId) });
        if (payload.status === "error") {
          toast.error(`Media prep failed: ${payload.error ?? "unknown"}`);
        }
      });
    }
    const unlisten = getCurrentWebview().listen<InterviewProgress>(
      INTERVIEW_PROGRESS_EVENT,
      (event) => {
        if (event.payload.cycle_id !== cycleId) return;
        qc.invalidateQueries({ queryKey: interviewKeys.list(cycleId) });
        if (event.payload.status === "error") {
          toast.error(`Media prep failed: ${event.payload.error ?? "unknown"}`);
        }
      },
    );
    return () => {
      unlisten.then((fn) => fn());
    };
  }, [cycleId, qc]);

  // Live transcription updates: `asr://progress` carries status + percent per interview.
  // Track the percent for the row label and invalidate the list on any terminal status so
  // the badge flips (new → transcribing → transcribed | error).
  useEffect(() => {
    function onAsr(p: AsrProgress) {
      setAsrProgress((prev) => {
        const next = { ...prev };
        if (p.status === "transcribing" && p.progress >= 0) {
          next[p.interview_id] = p.progress;
        } else if (p.status === "transcribed" || p.status === "error") {
          delete next[p.interview_id];
        }
        return next;
      });
      if (p.status === "transcribed" || p.status === "error") {
        // Whisper terminal → the diarization phase is over too; drop any diarizing flag.
        setDiarizing((prev) => {
          if (!prev[p.interview_id]) return prev;
          const next = { ...prev };
          delete next[p.interview_id];
          return next;
        });
        qc.invalidateQueries({ queryKey: interviewKeys.list(cycleId) });
        if (p.status === "error") {
          toast.error(`Transcription failed: ${p.error ?? "unknown"}`);
        }
      }
    }

    if (!IN_TAURI) {
      return mockOnAsrProgress(onAsr);
    }
    const unlisten = getCurrentWebview().listen<AsrProgress>(
      ASR_PROGRESS_EVENT,
      (e) => onAsr(e.payload),
    );
    return () => {
      unlisten.then((fn) => fn());
    };
  }, [cycleId, qc]);

  // Live diarization updates: `asr://diar-progress` fires AFTER whisper finishes, while the
  // row is still `transcribing`. Track which interviews are in the diarization phase so the
  // badge shows "Diarizing…" instead of a frozen "Transcribing 100%". Cleared on done/error
  // (and on the whisper terminal event above, as a backstop). Tauri-only — the browser mock
  // doesn't diarize.
  useEffect(() => {
    if (!IN_TAURI) return;
    const unlisten = getCurrentWebview().listen<DiarProgress>(
      DIAR_PROGRESS_EVENT,
      (e) => {
        const p = e.payload;
        setDiarizing((prev) => {
          const next = { ...prev };
          if (p.status === "diarizing") next[p.interview_id] = true;
          else delete next[p.interview_id]; // 'done' | 'error'
          return next;
        });
      },
    );
    return () => {
      unlisten.then((fn) => fn());
    };
  }, [cycleId]);

  // Live cleanup updates: `cleanup://progress` carries batch status + percent per interview.
  // Track the percent for the row label and invalidate the list on a terminal status so the
  // badge flips (cleaning → cleaned | error).
  useEffect(() => {
    function onCleanup(p: CleanupProgress) {
      setCleanProgress((prev) => {
        const next = { ...prev };
        if (p.status === "cleaning") {
          next[p.interview_id] = p.progress;
        } else {
          delete next[p.interview_id];
        }
        return next;
      });
      if (p.status === "cleaned" || p.status === "error") {
        qc.invalidateQueries({ queryKey: interviewKeys.list(cycleId) });
        if (p.status === "error") {
          toast.error(`Cleanup failed: ${p.error ?? "unknown"}`);
        }
      }
    }

    if (!IN_TAURI) {
      return mockOnCleanupProgress(onCleanup);
    }
    const unlisten = getCurrentWebview().listen<CleanupProgress>(
      CLEANUP_PROGRESS_EVENT,
      (e) => onCleanup(e.payload),
    );
    return () => {
      unlisten.then((fn) => fn());
    };
  }, [cycleId, qc]);

  return (
    <InterviewProgressContext.Provider
      value={{
        asrProgress,
        diarizing,
        cleanProgress,
        setAsrProgress,
        setCleanProgress,
      }}
    >
      {children}
    </InterviewProgressContext.Provider>
  );
}

export function useInterviewProgress(): InterviewProgressValue {
  const ctx = useContext(InterviewProgressContext);
  if (!ctx) {
    throw new Error(
      "useInterviewProgress must be used within an InterviewProgressProvider",
    );
  }
  return ctx;
}
