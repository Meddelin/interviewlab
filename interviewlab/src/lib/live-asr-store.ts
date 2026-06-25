import { create } from "zustand";
import type { AsrProgress, DiarProgress, Segment } from "@/lib/tauri";

// Live, in-flight transcription/diarization state, keyed by interview id. This is what lets
// you OPEN the interview while a slow Mac run is still going and watch it fill in: a single
// global listener (mounted once in App) feeds this store from the asr://progress +
// asr://diar-progress events, and any screen — the interview list row, the transcript editor —
// reads it. Because the listener mounts at app start, segments accumulate from the run's very
// first decoded line regardless of which screen is open when it lands.
//
// This is EPHEMERAL UI state (no persistence): the authoritative transcript is still the one
// the backend stores at the end. When a run reaches `transcribed`, the editor refetches that
// stored version (with real diarization) and stops reading the live buffer.

export type LiveAsr = {
  // The whisper phase. 'idle' once a terminal event lands and the stored transcript takes over.
  status: "transcribing" | "transcribed" | "error" | "idle";
  // whisper progress 0..100 (real, from whisper.cpp). -1 ticks (segment-only) don't touch this.
  progress: number;
  // Segments accumulated live as whisper decodes them (placeholder speaker "S1" until diarize).
  segments: Segment[];
  // Diarization runs AFTER whisper as one opaque pass — we can't see inside it, so we surface a
  // distinct phase: when it started (for an elapsed/estimate readout) and the detected count.
  diarActive: boolean;
  diarStartedAt: number | null;
  speakers: number | null;
  error: string | null;
};

type LiveAsrState = {
  byInterview: Record<string, LiveAsr>;
  onAsr: (p: AsrProgress) => void;
  onDiar: (p: DiarProgress) => void;
  // Drop the live buffer for an interview (e.g. once its stored transcript has loaded).
  reset: (interviewId: string) => void;
};

const EMPTY: LiveAsr = {
  status: "idle",
  progress: 0,
  segments: [],
  diarActive: false,
  diarStartedAt: null,
  speakers: null,
  error: null,
};

export const useLiveAsrStore = create<LiveAsrState>((set) => ({
  byInterview: {},

  onAsr: (p) =>
    set((s) => {
      const prev = s.byInterview[p.interview_id] ?? EMPTY;
      let next: LiveAsr;
      if (p.status === "transcribing") {
        if (p.segment) {
          // A live segment tick (progress === -1): append it. If we weren't already in a run
          // (status was idle/error/transcribed), this segment STARTS a fresh one — clear stale
          // segments first. This matters for resume, whose first ticks REPLAY the saved prefix:
          // without the reset they'd pile on top of a previous failed run's leftover segments.
          const fresh = prev.status !== "transcribing";
          next = {
            ...prev,
            status: "transcribing",
            segments: fresh ? [p.segment] : [...prev.segments, p.segment],
            diarActive: fresh ? false : prev.diarActive,
            diarStartedAt: fresh ? null : prev.diarStartedAt,
            speakers: fresh ? null : prev.speakers,
            error: null,
          };
        } else if (p.progress >= 0) {
          // A percent tick. The FIRST one (progress 0) opens a fresh run — clear any stale
          // segments left from a previous run of the same interview (re-transcribe).
          const fresh = prev.status !== "transcribing";
          next = {
            ...prev,
            status: "transcribing",
            progress: p.progress,
            segments: fresh ? [] : prev.segments,
            diarActive: fresh ? false : prev.diarActive,
            diarStartedAt: fresh ? null : prev.diarStartedAt,
            speakers: fresh ? null : prev.speakers,
            error: null,
          };
        } else {
          next = { ...prev, status: "transcribing" };
        }
      } else if (p.status === "transcribed") {
        // Terminal: whisper + diarization are done. Keep segments so the editor doesn't flash
        // empty during the refetch; it calls reset() once the stored version loads.
        next = { ...prev, status: "transcribed", progress: 100, diarActive: false };
      } else if (p.status === "error") {
        next = { ...prev, status: "error", diarActive: false, error: p.error };
      } else {
        next = prev;
      }
      return { byInterview: { ...s.byInterview, [p.interview_id]: next } };
    }),

  onDiar: (p) =>
    set((s) => {
      const prev = s.byInterview[p.interview_id] ?? EMPTY;
      let next: LiveAsr;
      if (p.status === "diarizing") {
        next = {
          ...prev,
          diarActive: true,
          // Stamp the start once so an elapsed readout is stable across the many ticks.
          diarStartedAt: prev.diarStartedAt ?? Date.now(),
        };
      } else if (p.status === "done") {
        next = { ...prev, diarActive: false, speakers: p.speakers };
      } else {
        // 'error' — diarization is non-fatal; the run keeps the single-speaker transcript.
        next = { ...prev, diarActive: false };
      }
      return { byInterview: { ...s.byInterview, [p.interview_id]: next } };
    }),

  reset: (interviewId) =>
    set((s) => {
      if (!s.byInterview[interviewId]) return s;
      const next = { ...s.byInterview };
      delete next[interviewId];
      return { byInterview: next };
    }),
}));

// A stable empty value so selector consumers can read a missing interview without churn.
export const EMPTY_LIVE_ASR: LiveAsr = EMPTY;
