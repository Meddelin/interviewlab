import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  addGlossaryTerms,
  createGlobalGlossaryTerm,
  createGlossaryTerm,
  deleteGlossaryTerm,
  listGlobalGlossaryTerms,
  listGlossaryTerms,
  updateGlossaryTerm,
  type NewGlossaryTerm,
  type UpdateGlossaryTermInput,
} from "@/lib/tauri";

// A glossary lives at one of two scopes: a single product, or the GLOBAL (app-wide) list
// shared across all products (docs/transcription-terminology.md). Both feed the same
// pipeline; the global one is merged into every interview by the backend.
export type GlossaryScope =
  | { kind: "product"; productId: string }
  | { kind: "global" };

// Query keys — per-product lists keyed by id, the global list under its own constant key.
export const glossaryKeys = {
  byProduct: (productId: string) => ["glossary", productId] as const,
  global: () => ["glossary", "__global__"] as const,
};

function scopeKey(scope: GlossaryScope) {
  return scope.kind === "global"
    ? glossaryKeys.global()
    : glossaryKeys.byProduct(scope.productId);
}

// --- per-product hooks (used by the Products page glossary panel) --------------

export function useGlossaryTerms(productId: string | undefined) {
  return useQuery({
    queryKey: glossaryKeys.byProduct(productId ?? ""),
    queryFn: () => listGlossaryTerms(productId as string),
    enabled: !!productId,
  });
}

// --- scope-aware hooks (the panel works for both a product and the global list) -

export function useGlossaryScopeTerms(scope: GlossaryScope) {
  return useQuery({
    queryKey: scopeKey(scope),
    queryFn: () =>
      scope.kind === "global"
        ? listGlobalGlossaryTerms()
        : listGlossaryTerms(scope.productId),
  });
}

export function useCreateGlossaryScopeTerm(scope: GlossaryScope) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (term: NewGlossaryTerm) =>
      scope.kind === "global"
        ? createGlobalGlossaryTerm(term)
        : createGlossaryTerm({ product_id: scope.productId, ...term }),
    onSuccess: () => qc.invalidateQueries({ queryKey: scopeKey(scope) }),
  });
}

// Update/delete are id-based on the backend (scope-agnostic); the scope only drives which
// cached list we invalidate afterwards.
export function useUpdateGlossaryScopeTerm(scope: GlossaryScope) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (req: UpdateGlossaryTermInput) => updateGlossaryTerm(req),
    onSuccess: () => qc.invalidateQueries({ queryKey: scopeKey(scope) }),
  });
}

export function useDeleteGlossaryScopeTerm(scope: GlossaryScope) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deleteGlossaryTerm(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: scopeKey(scope) }),
  });
}

// Bulk-accept suggested (or imported) terms into a product's glossary.
export function useAddGlossaryTerms(productId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (terms: NewGlossaryTerm[]) => addGlossaryTerms(productId, terms),
    onSuccess: () => qc.invalidateQueries({ queryKey: glossaryKeys.byProduct(productId) }),
  });
}
