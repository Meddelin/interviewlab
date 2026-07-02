import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  addInterviewFiles,
  deleteInterview,
  listInterviews,
  renameInterview,
} from "@/lib/tauri";

// Query keys scoped per cycle so progress events can invalidate just one list.
export const interviewKeys = {
  list: (cycleId: string) => ["interviews", cycleId] as const,
};

export function useInterviews(cycleId: string | undefined) {
  return useQuery({
    queryKey: interviewKeys.list(cycleId ?? ""),
    queryFn: () => listInterviews(cycleId as string),
    enabled: !!cycleId,
  });
}

export function useAddInterviewFiles(cycleId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (paths: string[]) => addInterviewFiles(cycleId, paths),
    // Show the 'importing' rows immediately; progress events refresh later.
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: interviewKeys.list(cycleId) }),
  });
}

export function useRenameInterview(cycleId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, title }: { id: string; title: string }) =>
      renameInterview(id, title),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: interviewKeys.list(cycleId) }),
  });
}

export function useDeleteInterview(cycleId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deleteInterview(id),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: interviewKeys.list(cycleId) }),
  });
}
