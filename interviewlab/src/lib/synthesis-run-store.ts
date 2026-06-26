import { create } from "zustand";
import type { InterviewSummaryProgress, SynthesisProgress } from "@/lib/tauri";

// In-flight synthesis run state, captured GLOBALLY so the "running" indicator + progress bar
// survive navigating away from the Synthesis tab (or an interview summary) and back. A single
// listener (mounted once in App via useSynthesisRuns) feeds this store from the
// synthesis://progress + interview-summary://progress events, and the panel that kicks off a
// run seeds the entry optimistically (startCycle/startSummary) so the state exists from the
// very first click — before the first backend event lands.
//
// EPHEMERAL UI state (no persistence): the artifact the backend stores at the end is still the
// source of truth. Terminal stages ('done' | 'error') clear the entry; the global listener
// then refetches the stored artifact so it shows even if the originating panel has unmounted.

export type CycleRun = {
  stage: string; // 'extract' | 'reduce' | …
  done: number;
  total: number;
  progress: number; // 0..100
};

export type SummaryRun = {
  stage: string; // 'running' | …
  progress: number; // 0..100
};

type SynthesisRunState = {
  // cycle synthesis runs, keyed by cycle id; interview-summary runs, keyed by interview id.
  cycleByCycleId: Record<string, CycleRun | undefined>;
  summaryByInterview: Record<string, SummaryRun | undefined>;

  startCycle: (cycleId: string) => void;
  onCycleProgress: (p: SynthesisProgress) => void;
  endCycle: (cycleId: string) => void;

  startSummary: (interviewId: string) => void;
  onSummaryProgress: (p: InterviewSummaryProgress) => void;
  endSummary: (interviewId: string) => void;
};

const TERMINAL = (stage: string) => stage === "done" || stage === "error";

export const useSynthesisRunStore = create<SynthesisRunState>((set) => ({
  cycleByCycleId: {},
  summaryByInterview: {},

  startCycle: (cycleId) =>
    set((s) => ({
      cycleByCycleId: {
        ...s.cycleByCycleId,
        [cycleId]: { stage: "extract", done: 0, total: 0, progress: 0 },
      },
    })),

  onCycleProgress: (p) =>
    set((s) => {
      const next = { ...s.cycleByCycleId };
      if (TERMINAL(p.stage)) {
        delete next[p.cycle_id];
      } else {
        next[p.cycle_id] = {
          stage: p.stage,
          done: p.done,
          total: p.total,
          progress: p.progress,
        };
      }
      return { cycleByCycleId: next };
    }),

  endCycle: (cycleId) =>
    set((s) => {
      if (!s.cycleByCycleId[cycleId]) return s;
      const next = { ...s.cycleByCycleId };
      delete next[cycleId];
      return { cycleByCycleId: next };
    }),

  startSummary: (interviewId) =>
    set((s) => ({
      summaryByInterview: {
        ...s.summaryByInterview,
        [interviewId]: { stage: "running", progress: 10 },
      },
    })),

  onSummaryProgress: (p) =>
    set((s) => {
      const next = { ...s.summaryByInterview };
      if (TERMINAL(p.stage)) {
        delete next[p.interview_id];
      } else {
        next[p.interview_id] = { stage: p.stage, progress: p.progress };
      }
      return { summaryByInterview: next };
    }),

  endSummary: (interviewId) =>
    set((s) => {
      if (!s.summaryByInterview[interviewId]) return s;
      const next = { ...s.summaryByInterview };
      delete next[interviewId];
      return { summaryByInterview: next };
    }),
}));
