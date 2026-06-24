import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  cycleGoals,
  getInterviewSummary,
  getSynthesis,
  runInterviewSummary,
  runSynthesis,
  saveCycleSynthesis,
  saveInterviewSummary,
  type InterviewSummaryRow,
  type SynthesisRow,
} from "@/lib/tauri";

// Query keys for the cycle's synthesis + derived goals + per-interview summaries.
export const synthesisKeys = {
  detail: (cycleId: string) => ["synthesis", cycleId] as const,
  goals: (cycleId: string) => ["cycle-goals", cycleId] as const,
  interviewSummary: (interviewId: string) =>
    ["interview-summary", interviewId] as const,
};

// The stored synthesis for a cycle (null before the first run).
export function useSynthesis(cycleId: string | undefined) {
  return useQuery({
    queryKey: synthesisKeys.detail(cycleId ?? ""),
    queryFn: () => getSynthesis(cycleId as string),
    enabled: !!cycleId,
  });
}

// The goals derived from the cycle's current guide (drives the "N goals" hint + empty state).
export function useCycleGoals(cycleId: string | undefined) {
  return useQuery({
    queryKey: synthesisKeys.goals(cycleId ?? ""),
    queryFn: () => cycleGoals(cycleId as string),
    enabled: !!cycleId,
  });
}

// Run synthesis; on success seed the synthesis cache so the tab renders findings immediately
// (progress events stream meanwhile via SYNTHESIS_PROGRESS_EVENT).
export function useRunSynthesis(cycleId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => runSynthesis(cycleId),
    onSuccess: (row: SynthesisRow) => {
      qc.setQueryData(synthesisKeys.detail(cycleId), row);
      qc.invalidateQueries({ queryKey: synthesisKeys.detail(cycleId) });
    },
  });
}

// Save the user's edit of the cycle synthesis markdown artifact; seeds the cache (M10b).
export function useSaveCycleSynthesis(cycleId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (contentMd: string) => saveCycleSynthesis(cycleId, contentMd),
    onSuccess: (row: SynthesisRow) => {
      qc.setQueryData(synthesisKeys.detail(cycleId), row);
    },
  });
}

// --- Per-interview summary (Milestone 10b) ------------------------------------

// The stored per-interview summary (null before the first run).
export function useInterviewSummary(interviewId: string | undefined) {
  return useQuery({
    queryKey: synthesisKeys.interviewSummary(interviewId ?? ""),
    queryFn: () => getInterviewSummary(interviewId as string),
    enabled: !!interviewId,
  });
}

// Run/regenerate a per-interview summary; seeds the cache on success.
export function useRunInterviewSummary(interviewId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => runInterviewSummary(interviewId),
    onSuccess: (row: InterviewSummaryRow) => {
      qc.setQueryData(synthesisKeys.interviewSummary(interviewId), row);
    },
  });
}

// Save the user's edit of a per-interview summary markdown artifact; seeds the cache.
export function useSaveInterviewSummary(interviewId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (contentMd: string) =>
      saveInterviewSummary(interviewId, contentMd),
    onSuccess: (row: InterviewSummaryRow) => {
      qc.setQueryData(synthesisKeys.interviewSummary(interviewId), row);
    },
  });
}
