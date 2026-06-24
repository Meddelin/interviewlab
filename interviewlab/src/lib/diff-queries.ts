import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { diffStatus, getDiff, runDiff, type DiffRow } from "@/lib/tauri";

// Query keys for the cycle's stored diff + its precondition status.
export const diffKeys = {
  detail: (cycleId: string) => ["diff", cycleId] as const,
  status: (cycleId: string) => ["diff-status", cycleId] as const,
};

// The stored diff for a cycle (null before the first run).
export function useDiff(cycleId: string | undefined) {
  return useQuery({
    queryKey: diffKeys.detail(cycleId ?? ""),
    queryFn: () => getDiff(cycleId as string),
    enabled: !!cycleId,
  });
}

// The Diff tab's precondition status (prev wave set? both syntheses present?) — drives the
// empty states vs the run action.
export function useDiffStatus(cycleId: string | undefined) {
  return useQuery({
    queryKey: diffKeys.status(cycleId ?? ""),
    queryFn: () => diffStatus(cycleId as string),
    enabled: !!cycleId,
  });
}

// Run the diff; on success seed the diff cache so the tab renders entries immediately
// (progress events stream meanwhile via DIFF_PROGRESS_EVENT).
export function useRunDiff(cycleId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => runDiff(cycleId),
    onSuccess: (row: DiffRow) => {
      qc.setQueryData(diffKeys.detail(cycleId), row);
      qc.invalidateQueries({ queryKey: diffKeys.detail(cycleId) });
    },
  });
}
