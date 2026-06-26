import { useEffect } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { useQueryClient } from "@tanstack/react-query";
import {
  IN_TAURI,
  INTERVIEW_SUMMARY_PROGRESS_EVENT,
  SYNTHESIS_PROGRESS_EVENT,
  type InterviewSummaryProgress,
  type SynthesisProgress,
} from "@/lib/tauri";
import { useSynthesisRunStore } from "@/lib/synthesis-run-store";
import { synthesisKeys } from "@/lib/synthesis-queries";
// dev-mock: browser-only, never active under Tauri.
import {
  mockOnInterviewSummaryProgress,
  mockOnSynthesisProgress,
} from "@/lib/dev-mock";

// Mount ONCE, high in the tree (App), so synthesis (cycle) + interview-summary run progress is
// captured no matter which screen is open. This is what lets the "running" indicator + progress
// bar SURVIVE navigating away from the Synthesis tab / interview summary and back: the state
// lives in the global synthesis-run store, not in the panel that started the run. On a terminal
// stage we also refresh the stored artifact so the result appears even if that panel unmounted.
export function useSynthesisRuns() {
  const onCycleProgress = useSynthesisRunStore((s) => s.onCycleProgress);
  const onSummaryProgress = useSynthesisRunStore((s) => s.onSummaryProgress);
  const qc = useQueryClient();

  useEffect(() => {
    function handleCycle(p: SynthesisProgress) {
      onCycleProgress(p);
      if (p.stage === "done" || p.stage === "error") {
        qc.invalidateQueries({ queryKey: synthesisKeys.detail(p.cycle_id) });
      }
    }
    function handleSummary(p: InterviewSummaryProgress) {
      onSummaryProgress(p);
      if (p.stage === "done" || p.stage === "error") {
        qc.invalidateQueries({
          queryKey: synthesisKeys.interviewSummary(p.interview_id),
        });
      }
    }

    if (!IN_TAURI) {
      const unSyn = mockOnSynthesisProgress(handleCycle);
      const unSum = mockOnInterviewSummaryProgress(handleSummary);
      return () => {
        unSyn();
        unSum();
      };
    }
    const unSyn = getCurrentWebview().listen<SynthesisProgress>(
      SYNTHESIS_PROGRESS_EVENT,
      (e) => handleCycle(e.payload),
    );
    const unSum = getCurrentWebview().listen<InterviewSummaryProgress>(
      INTERVIEW_SUMMARY_PROGRESS_EVENT,
      (e) => handleSummary(e.payload),
    );
    return () => {
      unSyn.then((fn) => fn());
      unSum.then((fn) => fn());
    };
  }, [onCycleProgress, onSummaryProgress, qc]);
}
