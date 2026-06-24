import { useQuery } from "@tanstack/react-query";
import { asrDevice, listModels } from "@/lib/tauri";

// ASR query keys (Milestone 4). Device + model catalog are small, cacheable reads.
// diarPresent: whether the speaker-diarization model files are on disk (small bool read).
export const asrKeys = {
  device: ["asr", "device"] as const,
  models: ["asr", "models"] as const,
  diarPresent: ["asr", "diar-present"] as const,
};

export function useAsrDevice() {
  return useQuery({ queryKey: asrKeys.device, queryFn: asrDevice });
}

export function useModels() {
  return useQuery({ queryKey: asrKeys.models, queryFn: listModels });
}
