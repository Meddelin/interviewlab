import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  createProduct,
  deleteProduct,
  getProduct,
  listProducts,
  updateProduct,
  type CreateProductInput,
  type UpdateProductInput,
} from "@/lib/tauri";

// Products-library query keys (mirrors guide-queries). The list drives the Products
// library page + the Overview product picker; a detail key backs the product editor.
export const productKeys = {
  all: ["products"] as const,
  detail: (id: string) => ["product", id] as const,
};

export function useProducts() {
  return useQuery({ queryKey: productKeys.all, queryFn: listProducts });
}

export function useProduct(id: string | undefined) {
  return useQuery({
    queryKey: productKeys.detail(id ?? ""),
    queryFn: () => getProduct(id as string),
    enabled: !!id,
  });
}

export function useCreateProduct() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (req: CreateProductInput) => createProduct(req),
    onSuccess: () => qc.invalidateQueries({ queryKey: productKeys.all }),
  });
}

export function useUpdateProduct() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (req: UpdateProductInput) => updateProduct(req),
    onSuccess: (product) => {
      qc.invalidateQueries({ queryKey: productKeys.all });
      qc.invalidateQueries({ queryKey: productKeys.detail(product.id) });
    },
  });
}

export function useDeleteProduct() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deleteProduct(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: productKeys.all }),
  });
}
