import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  addGlossaryTerms,
  createGlossaryTerm,
  deleteGlossaryTerm,
  listGlossaryTerms,
  updateGlossaryTerm,
  type CreateGlossaryTermInput,
  type NewGlossaryTerm,
  type UpdateGlossaryTermInput,
} from "@/lib/tauri";

// Glossary query keys — terms are scoped to a product (docs/transcription-terminology.md).
export const glossaryKeys = {
  byProduct: (productId: string) => ["glossary", productId] as const,
};

export function useGlossaryTerms(productId: string | undefined) {
  return useQuery({
    queryKey: glossaryKeys.byProduct(productId ?? ""),
    queryFn: () => listGlossaryTerms(productId as string),
    enabled: !!productId,
  });
}

export function useCreateGlossaryTerm(productId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (req: CreateGlossaryTermInput) => createGlossaryTerm(req),
    onSuccess: () => qc.invalidateQueries({ queryKey: glossaryKeys.byProduct(productId) }),
  });
}

export function useUpdateGlossaryTerm(productId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (req: UpdateGlossaryTermInput) => updateGlossaryTerm(req),
    onSuccess: () => qc.invalidateQueries({ queryKey: glossaryKeys.byProduct(productId) }),
  });
}

export function useDeleteGlossaryTerm(productId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deleteGlossaryTerm(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: glossaryKeys.byProduct(productId) }),
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
