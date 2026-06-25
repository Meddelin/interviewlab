import { useEffect } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { useQueryClient } from "@tanstack/react-query";
import {
  ASR_PROGRESS_EVENT,
  DIAR_PROGRESS_EVENT,
  IN_TAURI,
  type AsrProgress,
  type DiarProgress,
} from "@/lib/tauri";
import { useLiveAsrStore } from "@/lib/live-asr-store";

// Mount ONCE, high in the tree (App), so live transcription/diarization state is captured
// from a run's very first event no matter which screen is open. Feeds the live-asr store and,
// on a terminal `transcribed`, invalidates the transcript reads so an open editor swaps from
// the live buffer to the authoritative stored transcript (now with real diarization).
//
// This is additive: the interview-list tab keeps its own listeners for its row badges/toasts.
// Tauri delivers app-emitted events to every listener, so running both is fine.
export function useLiveAsr() {
  const onAsr = useLiveAsrStore((s) => s.onAsr);
  const onDiar = useLiveAsrStore((s) => s.onDiar);
  const qc = useQueryClient();

  useEffect(() => {
    if (!IN_TAURI) return;
    const unAsr = getCurrentWebview().listen<AsrProgress>(
      ASR_PROGRESS_EVENT,
      (e) => {
        onAsr(e.payload);
        if (e.payload.status === "transcribed" || e.payload.status === "error") {
          // Terminal: refresh the interview list (its row status) and — on success — the
          // transcript reads, so an open editor leaves live mode with real, stored content.
          // The list tab keeps its own listener; this covers the case where the editor is the
          // only screen mounted. Broad prefix invalidation is fine for these small reads.
          qc.invalidateQueries({ queryKey: ["interviews"] });
          if (e.payload.status === "transcribed") {
            qc.invalidateQueries({ queryKey: ["transcript"] });
            qc.invalidateQueries({ queryKey: ["participants"] });
          }
        }
      },
    );
    const unDiar = getCurrentWebview().listen<DiarProgress>(
      DIAR_PROGRESS_EVENT,
      (e) => onDiar(e.payload),
    );
    return () => {
      unAsr.then((fn) => fn());
      unDiar.then((fn) => fn());
    };
  }, [onAsr, onDiar, qc]);
}
