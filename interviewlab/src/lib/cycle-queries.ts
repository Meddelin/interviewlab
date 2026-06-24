import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  createCycle,
  deleteCycle,
  getCycle,
  listCycles,
  updateCycle,
  type UpdateCycleInput,
} from "@/lib/tauri";

// Centralized query keys so mutations can invalidate consistently.
export const cycleKeys = {
  all: ["cycles"] as const,
  detail: (id: string) => ["cycle", id] as const,
};

export function useCycles() {
  return useQuery({ queryKey: cycleKeys.all, queryFn: listCycles });
}

export function useCycle(id: string | undefined) {
  return useQuery({
    queryKey: cycleKeys.detail(id ?? ""),
    queryFn: () => getCycle(id as string),
    enabled: !!id,
  });
}

export function useCreateCycle() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => createCycle(name),
    onSuccess: () => qc.invalidateQueries({ queryKey: cycleKeys.all }),
  });
}

export function useUpdateCycle() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateCycleInput) => updateCycle(input),
    onSuccess: (cycle) => {
      // Refresh both the list and this cycle's detail.
      qc.invalidateQueries({ queryKey: cycleKeys.all });
      qc.invalidateQueries({ queryKey: cycleKeys.detail(cycle.id) });
    },
  });
}

export function useDeleteCycle() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deleteCycle(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: cycleKeys.all }),
  });
}
