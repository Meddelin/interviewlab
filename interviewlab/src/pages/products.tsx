import { useEffect, useState } from "react";
import { Package, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { MarkdownEditor } from "@/components/markdown-editor";
import { GlossaryPanel } from "@/components/glossary-panel";
import {
  useCreateProduct,
  useDeleteProduct,
  useProducts,
  useUpdateProduct,
} from "@/lib/product-queries";
import { relativeTime } from "@/lib/format";
import { mod } from "@/lib/platform";
import type { Product } from "@/lib/tauri";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n";

// Default scaffold for a new product so the markdown editor opens with a usable shape.
// The product context feeds ASR/cleanup/synthesis, so a short product + persona + terms
// blurb is what the pipeline wants.
const NEW_PRODUCT_TEMPLATE = {
  ru: "# Название продукта\n\nЧто это за продукт, для кого он и что значит «активирован».\n\n## Ключевые термины\n\n- \n",
  en: "# Product name\n\nWhat the product is, who it's for, and what 'activated' means.\n\n## Key terms\n\n- \n",
};

const STR = {
  ru: {
    newProduct: "Новый продукт",
    dialogTitle: "Новый продукт",
    dialogDescription:
      "Переиспользуемый контекст продукта в markdown. Циклы ссылаются на него; он питает расшифровку, очистку и синтез.",
    namePlaceholder: "напр. Acme Analytics",
    creating: "Создаём…",
    create: "Создать продукт",
    createError: (e: string) => `Не удалось создать продукт. ${e}`,
    deleteProduct: "Удалить продукт",
    saving: "Сохраняем…",
    save: "Сохранить",
    saved: "Продукт сохранён",
    saveError: (e: string) => `Не удалось сохранить продукт. ${e}`,
    untitled: "Без названия",
    confirmDelete: (name: string) =>
      `Удалить «${name}»? Циклы, использующие его, вернутся к встроенному описанию продукта.`,
    deleted: "Продукт удалён",
    deleteError: (e: string) => `Не удалось удалить продукт. ${e}`,
    editorPlaceholder:
      "Опишите продукт, персону, ключевые термины — начните с заголовка…",
    heading: "Продукты",
    subtitle:
      "Переиспользуемый контекст продукта. Каждый цикл ссылается на продукт; он питает расшифровку, очистку и синтез.",
    emptyTitle: "Пока нет продуктов",
    emptyBody:
      "Создайте переиспользуемое описание продукта — оно заземляет расшифровку, очистку и синтез в терминах вашего продукта.",
    updated: (when: string) => `Обновлён ${when}`,
    selectToEdit: "Выберите продукт для редактирования.",
  },
  en: {
    newProduct: "New product",
    dialogTitle: "New product",
    dialogDescription:
      "Reusable product context in markdown. Cycles reference it; it feeds transcription, cleanup, and synthesis.",
    namePlaceholder: "e.g. Acme Analytics",
    creating: "Creating…",
    create: "Create product",
    createError: (e: string) => `Couldn't create the product. ${e}`,
    deleteProduct: "Delete product",
    saving: "Saving…",
    save: "Save",
    saved: "Product saved",
    saveError: (e: string) => `Couldn't save the product. ${e}`,
    untitled: "Untitled product",
    confirmDelete: (name: string) =>
      `Delete "${name}"? Cycles using it will fall back to their inline product description.`,
    deleted: "Product deleted",
    deleteError: (e: string) => `Couldn't delete the product. ${e}`,
    editorPlaceholder:
      "Describe the product, the persona, key terms — start with a heading…",
    heading: "Products",
    subtitle:
      "Reusable product context. Each cycle references a product; it feeds transcription, cleanup, and synthesis.",
    emptyTitle: "No products yet",
    emptyBody:
      "Create a reusable product description — it grounds transcription, cleanup, and synthesis in your product's terms.",
    updated: (when: string) => `Updated ${when}`,
    selectToEdit: "Select a product to edit.",
  },
};

// ── Create-product dialog ───────────────────────────────────────────────────────
function CreateProductDialog({ onCreated }: { onCreated: (p: Product) => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const createProduct = useCreateProduct();
  const t = useT(STR);
  const template = useT(NEW_PRODUCT_TEMPLATE);

  async function submit() {
    const trimmed = name.trim();
    if (!trimmed) return;
    try {
      const p = await createProduct.mutateAsync({
        name: trimmed,
        content_md: template,
      });
      setName("");
      setOpen(false);
      onCreated(p);
    } catch (e) {
      toast.error(t.createError(String(e)));
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Button size="sm" onClick={() => setOpen(true)}>
        <Plus className="size-3.5" />
        {t.newProduct}
      </Button>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t.dialogTitle}</DialogTitle>
          <DialogDescription>{t.dialogDescription}</DialogDescription>
        </DialogHeader>
        <Input
          autoFocus
          placeholder={t.namePlaceholder}
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
          }}
        />
        <DialogFooter>
          <Button
            size="sm"
            onClick={submit}
            disabled={!name.trim() || createProduct.isPending}
          >
            {createProduct.isPending ? t.creating : t.create}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Product editor (right pane) ──────────────────────────────────────────────────
function ProductEditor({ product }: { product: Product }) {
  const updateProduct = useUpdateProduct();
  const deleteProduct = useDeleteProduct();
  const t = useT(STR);

  // Local editable buffers, re-seeded whenever a different product is selected.
  const [name, setName] = useState(product.name);
  const [contentMd, setContentMd] = useState(product.content_md);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    setName(product.name);
    setContentMd(product.content_md);
    setDirty(false);
  }, [product.id]); // eslint-disable-line react-hooks/exhaustive-deps

  async function save() {
    try {
      await updateProduct.mutateAsync({
        id: product.id,
        name: name.trim() || t.untitled,
        content_md: contentMd,
      });
      setDirty(false);
      toast.success(t.saved);
    } catch (e) {
      toast.error(t.saveError(String(e)));
    }
  }

  async function remove() {
    if (!confirm(t.confirmDelete(product.name))) return;
    try {
      await deleteProduct.mutateAsync(product.id);
      toast.success(t.deleted);
    } catch (e) {
      toast.error(t.deleteError(String(e)));
    }
  }

  // ⌘/Ctrl+S saves.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key.toLowerCase() === "s" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        if (dirty && !updateProduct.isPending) save();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }); // re-bind each render so `dirty`/buffers are current

  return (
    // Editing column keeps a comfortable reading width (the product list is fluid full-
    // width, but long-form prose isn't).
    <div className="flex min-h-0 flex-1 flex-col gap-4 lg:max-w-3xl">
      <div className="flex items-center gap-2">
        <Input
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            setDirty(true);
          }}
          className="h-9 flex-1 text-base font-medium"
        />
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={t.deleteProduct}
          className="text-muted-foreground hover:text-destructive"
          onClick={remove}
          disabled={deleteProduct.isPending}
        >
          <Trash2 className="size-4" />
        </Button>
        <Button size="sm" onClick={save} disabled={!dirty || updateProduct.isPending}>
          {updateProduct.isPending ? t.saving : t.save}
          <kbd className="ml-1 hidden font-numeric text-[10px] text-primary-foreground/70 sm:inline">
            {mod("S")}
          </kbd>
        </Button>
      </div>

      {/* The markdown editor (Plate) — same component the Guides library + synthesis use. */}
      <MarkdownEditor
        key={product.id}
        value={product.content_md}
        onChange={(md) => {
          setContentMd(md);
          setDirty(true);
        }}
        placeholder={t.editorPlaceholder}
      />

      {/* Glossary: the focused term→canonical list that anchors anglicisms / tech terms /
          product names across transcription + cleanup (docs/transcription-terminology.md). */}
      <GlossaryPanel productId={product.id} />
    </div>
  );
}

// ── The Products library page ────────────────────────────────────────────────────
export function ProductsPage() {
  const { data: products, isPending } = useProducts();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const t = useT(STR);

  // Keep a valid selection: default to the first product once loaded.
  useEffect(() => {
    if (!products) return;
    if (selectedId && products.some((p) => p.id === selectedId)) return;
    setSelectedId(products[0]?.id ?? null);
  }, [products, selectedId]);

  const selected = products?.find((p) => p.id === selectedId) ?? null;

  return (
    <div className="flex flex-col gap-5">
      <header className="flex items-center justify-between gap-4">
        <div className="flex flex-col gap-0.5">
          <h1 className="text-lg font-semibold tracking-[-0.02em] text-foreground">
            {t.heading}
          </h1>
          <p className="text-xs text-muted-foreground">{t.subtitle}</p>
        </div>
        <CreateProductDialog onCreated={(p) => setSelectedId(p.id)} />
      </header>

      {isPending ? (
        <div className="grid grid-cols-[260px_1fr] gap-6">
          <Skeleton className="h-64 w-full" />
          <Skeleton className="h-64 w-full" />
        </div>
      ) : !products || products.length === 0 ? (
        <div className="flex flex-col items-center gap-4 rounded-lg border border-dashed border-border px-6 py-16 text-center">
          <span className="flex size-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <Package className="size-5" />
          </span>
          <div className="flex max-w-sm flex-col gap-1">
            <p className="text-sm font-medium text-foreground">{t.emptyTitle}</p>
            <p className="text-xs text-muted-foreground">{t.emptyBody}</p>
          </div>
          <CreateProductDialog onCreated={(p) => setSelectedId(p.id)} />
        </div>
      ) : (
        <div className="grid grid-cols-[260px_1fr] gap-6">
          {/* List */}
          <div className="flex flex-col overflow-hidden rounded-lg border border-border bg-card/40">
            {products.map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => setSelectedId(p.id)}
                className={cn(
                  "flex flex-col gap-0.5 border-b border-border px-3 py-2.5 text-left transition-colors last:border-b-0 hover:bg-secondary/40 focus-visible:bg-secondary/40 focus-visible:outline-none",
                  p.id === selectedId && "bg-secondary/60",
                )}
              >
                <span className="flex items-center gap-2">
                  <span
                    className={cn(
                      "h-3.5 w-0.5 shrink-0 rounded-full",
                      p.id === selectedId ? "bg-primary" : "bg-transparent",
                    )}
                  />
                  <span className="truncate text-sm font-medium text-foreground">
                    {p.name}
                  </span>
                </span>
                <span className="flex items-center gap-2 pl-2.5 font-numeric text-[11px] text-muted-foreground">
                  <span>{t.updated(relativeTime(p.updated_at))}</span>
                </span>
              </button>
            ))}
          </div>

          {/* Editor */}
          {selected ? (
            <ProductEditor key={selected.id} product={selected} />
          ) : (
            <div className="flex items-center justify-center rounded-lg border border-dashed border-border p-8 text-sm text-muted-foreground">
              {t.selectToEdit}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
