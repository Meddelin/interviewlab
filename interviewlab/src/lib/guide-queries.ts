import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  createGuide,
  deleteGuide,
  getGuide,
  listGuides,
  updateGuide,
  type CreateGuideInput,
  type UpdateGuideInput,
} from "@/lib/tauri";

// Guide-library query keys (Milestone 10a). The list drives the Guides/Designs library
// and the Overview guide picker; a detail key backs the guide editor.
export const guideKeys = {
  all: ["guides"] as const,
  detail: (id: string) => ["guide", id] as const,
};

export function useGuides() {
  return useQuery({ queryKey: guideKeys.all, queryFn: listGuides });
}

export function useGuide(id: string | undefined) {
  return useQuery({
    queryKey: guideKeys.detail(id ?? ""),
    queryFn: () => getGuide(id as string),
    enabled: !!id,
  });
}

export function useCreateGuide() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (req: CreateGuideInput) => createGuide(req),
    onSuccess: () => qc.invalidateQueries({ queryKey: guideKeys.all }),
  });
}

export function useUpdateGuide() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (req: UpdateGuideInput) => updateGuide(req),
    onSuccess: (guide) => {
      qc.invalidateQueries({ queryKey: guideKeys.all });
      qc.invalidateQueries({ queryKey: guideKeys.detail(guide.id) });
    },
  });
}

export function useDeleteGuide() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deleteGuide(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: guideKeys.all }),
  });
}
