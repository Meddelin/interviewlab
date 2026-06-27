import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  adapterMetaInstructions,
  deletePlugin,
  getActiveAdapter,
  getTaskModel,
  listAdapters,
  pluginManifestSchema,
  savePluginManifest,
  type TaskModelBucket,
} from "@/lib/tauri";

// CLI-plugin query keys (M6 + M11 plugin system, feature-cli-plugins.md). Small, cacheable
// reads for the Settings AI CLI tab. The "Test CLI" probe is a mutation (runs the CLI),
// kept in the component since it has UI-local pending/result state.
export const adapterKeys = {
  list: ["adapters", "list"] as const,
  active: ["adapters", "active"] as const,
  meta: ["adapters", "meta"] as const,
  schema: ["adapters", "schema"] as const,
  // The per-bucket task-model override (cleanup | synthesis | diff).
  taskModel: (bucket: TaskModelBucket) =>
    ["adapters", "task-model", bucket] as const,
};

export function useAdapters() {
  return useQuery({ queryKey: adapterKeys.list, queryFn: listAdapters });
}

export function useActiveAdapter() {
  return useQuery({ queryKey: adapterKeys.active, queryFn: getActiveAdapter });
}

// The user's saved model override for one task bucket ("" = the plugin's per-task default).
// The "Task models" picker seeds its Select from this.
export function useTaskModel(bucket: TaskModelBucket) {
  return useQuery({
    queryKey: adapterKeys.taskModel(bucket),
    queryFn: () => getTaskModel(bucket),
  });
}

export function useAdapterMeta() {
  return useQuery({
    queryKey: adapterKeys.meta,
    queryFn: adapterMetaInstructions,
  });
}

// The manifest JSON Schema (feature-cli-plugins.md §3.3) for the Add-plugin dialog.
export function usePluginManifestSchema() {
  return useQuery({
    queryKey: adapterKeys.schema,
    queryFn: pluginManifestSchema,
  });
}

// Invalidate the plugin list + active selection after a manual create/edit/delete so the
// cards grid + active Select re-read the freshly written/removed manifest.
function invalidateAdapters(qc: ReturnType<typeof useQueryClient>) {
  qc.invalidateQueries({ queryKey: adapterKeys.list });
  qc.invalidateQueries({ queryKey: adapterKeys.active });
}

// Save (create or overwrite) a user plugin manifest from the manual form / raw-JSON editor.
export function useSavePluginManifest() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, manifestJson }: { id: string; manifestJson: string }) =>
      savePluginManifest(id, manifestJson),
    onSuccess: () => invalidateAdapters(qc),
  });
}

// Delete a user plugin folder (builtin ids are refused server-side).
export function useDeletePlugin() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deletePlugin(id),
    onSuccess: () => invalidateAdapters(qc),
  });
}
