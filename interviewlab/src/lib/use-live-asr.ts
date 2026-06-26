import { useEffect } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  ASR_PROGRESS_EVENT,
  CLEANUP_PROGRESS_EVENT,
  DIAR_PROGRESS_EVENT,
  IN_TAURI,
  type AsrProgress,
  type CleanupProgress,
  type DiarProgress,
} from "@/lib/tauri";
import { useLiveAsrStore } from "@/lib/live-asr-store";
// dev-mock: browser-only, never active under Tauri.
import { mockOnAsrProgress, mockOnCleanupProgress } from "@/lib/dev-mock";

// Mount ONCE, high in the tree (App), so live transcription / diarization / cleanup state is
// captured from a run's very first event no matter which screen is open. Feeds the live-asr
// store and, on terminal events, invalidates the relevant reads. Because the listener lives at
// the app shell (not a tab that unmounts), the run state — percent, diarization phase, cleanup
// percent — SURVIVES navigating between cycle tabs / into the editor and back: the Interviews
// tab and the editor both just read the store.
export function useLiveAsr() {
  const onAsr = useLiveAsrStore((s) => s.onAsr);
  const onDiar = useLiveAsrStore((s) => s.onDiar);
  const onCleanup = useLiveAsrStore((s) => s.onCleanup);
  const qc = useQueryClient();

  useEffect(() => {
    function handleAsr(p: AsrProgress) {
      onAsr(p);
      if (p.status === "transcribed" || p.status === "error") {
        // Terminal: refresh the interview list (its row status) and — on success — the
        // transcript reads, so an open editor leaves live mode with real, stored content.
        // Broad prefix invalidation is fine for these small reads.
        qc.invalidateQueries({ queryKey: ["interviews"] });
        // The checkpoint is cleared on success / (re)written on error — refresh either way
        // so the "resume from M:SS" banner appears or disappears.
        qc.invalidateQueries({ queryKey: ["transcribe-checkpoint"] });
        if (p.status === "transcribed") {
          qc.invalidateQueries({ queryKey: ["transcript"] });
          qc.invalidateQueries({ queryKey: ["participants"] });
        } else {
          toast.error(`Transcription failed: ${p.error ?? "unknown"}`);
        }
      }
    }
    function handleCleanup(p: CleanupProgress) {
      onCleanup(p);
      if (p.status === "cleaned" || p.status === "error") {
        qc.invalidateQueries({ queryKey: ["interviews"] });
        if (p.status === "error") {
          toast.error(`Cleanup failed: ${p.error ?? "unknown"}`);
        }
      }
    }

    if (!IN_TAURI) {
      // Browser preview: drive the store from the in-memory mocks (no real diarization there).
      const unAsr = mockOnAsrProgress(handleAsr);
      const unClean = mockOnCleanupProgress(handleCleanup);
      return () => {
        unAsr();
        unClean();
      };
    }
    const unAsr = getCurrentWebview().listen<AsrProgress>(
      ASR_PROGRESS_EVENT,
      (e) => handleAsr(e.payload),
    );
    const unDiar = getCurrentWebview().listen<DiarProgress>(
      DIAR_PROGRESS_EVENT,
      (e) => onDiar(e.payload),
    );
    const unClean = getCurrentWebview().listen<CleanupProgress>(
      CLEANUP_PROGRESS_EVENT,
      (e) => handleCleanup(e.payload),
    );
    return () => {
      unAsr.then((fn) => fn());
      unDiar.then((fn) => fn());
      unClean.then((fn) => fn());
    };
  }, [onAsr, onDiar, onCleanup, qc]);
}
