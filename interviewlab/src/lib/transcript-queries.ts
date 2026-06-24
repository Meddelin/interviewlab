import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  cleanTranscript,
  getTranscriptVersion,
  listParticipants,
  listTranscriptVersions,
  saveEditedTranscript,
  type SaveEditedInput,
} from "@/lib/tauri";

// Transcript-editor query keys (Milestone 5). Scoped per interview so a save
// invalidates just that interview's transcript/participant reads.
export const transcriptKeys = {
  versions: (interviewId: string) =>
    ["transcript", "versions", interviewId] as const,
  version: (interviewId: string, kind: string) =>
    ["transcript", "version", interviewId, kind] as const,
  participants: (interviewId: string) =>
    ["participants", interviewId] as const,
};

// The list of transcript versions that exist (drives the version Select).
export function useTranscriptVersions(interviewId: string | undefined) {
  return useQuery({
    queryKey: transcriptKeys.versions(interviewId ?? ""),
    queryFn: () => listTranscriptVersions(interviewId as string),
    enabled: !!interviewId,
  });
}

// One transcript version (raw | cleaned | edited) with parsed segments.
export function useTranscriptVersion(
  interviewId: string | undefined,
  kind: string,
) {
  return useQuery({
    queryKey: transcriptKeys.version(interviewId ?? "", kind),
    queryFn: () => getTranscriptVersion(interviewId as string, kind),
    enabled: !!interviewId,
  });
}

export function useParticipants(interviewId: string | undefined) {
  return useQuery({
    queryKey: transcriptKeys.participants(interviewId ?? ""),
    queryFn: () => listParticipants(interviewId as string),
    enabled: !!interviewId,
  });
}

// Save edited segments + participants → 'edited' version. Invalidates the version
// list, every cached version (raw/cleaned/edited timing may shift the active read),
// and the participant list so the editor re-reads the canonical saved state.
export function useSaveEditedTranscript(interviewId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: SaveEditedInput) => saveEditedTranscript(input),
    onSuccess: () => {
      qc.invalidateQueries({
        queryKey: transcriptKeys.versions(interviewId),
      });
      qc.invalidateQueries({
        queryKey: ["transcript", "version", interviewId],
      });
      qc.invalidateQueries({
        queryKey: transcriptKeys.participants(interviewId),
      });
    },
  });
}

// Run the "no grammar errors" cleanup pass (Milestone 7). Stores the `cleaned` version
// server-side (count/id/timing/label invariants enforced in Rust), then invalidates the
// version list + the cleaned version read so the editor's version Select enables
// "Cleaned" and shows it. Progress streams via CLEANUP_PROGRESS_EVENT (handled in the
// component for batch ticks); this mutation resolves with the cleaned transcript id.
export function useCleanTranscript(interviewId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => cleanTranscript(interviewId),
    onSuccess: () => {
      qc.invalidateQueries({
        queryKey: transcriptKeys.versions(interviewId),
      });
      qc.invalidateQueries({
        queryKey: ["transcript", "version", interviewId],
      });
    },
  });
}
