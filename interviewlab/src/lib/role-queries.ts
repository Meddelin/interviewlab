import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  createRole,
  deleteRole,
  listRoles,
  updateRole,
  type CreateRoleInput,
  type UpdateRoleInput,
} from "@/lib/tauri";

// Role-library query keys (Milestone 10a). One list everyone reads (Settings → Roles,
// the transcript editor's speaker picker), so a mutation invalidates a single key.
export const roleKeys = {
  all: ["roles"] as const,
};

export function useRoles() {
  return useQuery({ queryKey: roleKeys.all, queryFn: listRoles });
}

export function useCreateRole() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (req: CreateRoleInput) => createRole(req),
    onSuccess: () => qc.invalidateQueries({ queryKey: roleKeys.all }),
  });
}

export function useUpdateRole() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (req: UpdateRoleInput) => updateRole(req),
    onSuccess: () => qc.invalidateQueries({ queryKey: roleKeys.all }),
  });
}

export function useDeleteRole() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deleteRole(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: roleKeys.all }),
  });
}
