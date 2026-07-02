import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Link,
  useBlocker,
  useLocation,
  useParams,
  useSearchParams,
} from "react-router-dom";
import { ArrowUpRight, Target } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useCycle, useCycles, useUpdateCycle } from "@/lib/cycle-queries";
import { useGuides } from "@/lib/guide-queries";
import { useProducts } from "@/lib/product-queries";
import { MarkdownEditor } from "@/components/markdown-editor";
import { GuideTemplatePreview } from "@/components/guide-template-editor";
import { templateIsEmpty } from "@/lib/tauri";
import { InterviewsTab } from "@/components/interviews-tab";
import { SynthesisTab } from "@/components/synthesis-tab";
import { DiffTab } from "@/components/diff-tab";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { absoluteDate } from "@/lib/format";
import { useT } from "@/lib/i18n";

const STR = {
  ru: {
    empty: "Здесь пусто.",
    unsavedTitle: "Несохранённые изменения",
    unsavedBody: "Есть несохранённые изменения — уйти без сохранения?",
    leaveAction: "Уйти без сохранения",
    untitledCycle: "Цикл без названия",
    cycleSaved: "Цикл сохранён",
    saveError: (e: string) => `Не удалось сохранить изменения. ${e}`,
    name: "Название",
    product: "Продукт",
    productHint:
      "Выберите готовый продукт из библиотеки — его контекст используется при транскрипции, очистке и синтезе.",
    selectProduct: "Выберите продукт",
    noProduct: "Без продукта",
    editProduct: "Изменить продукт",
    createProduct: "Создать продукт",
    productPlaceholder:
      "Продукт не привязан. Выберите его выше или напишите описание продукта прямо здесь (markdown):\n\n# Продукт\n…",
    guide: "Гайд интервью",
    guideHint:
      "Выберите готовый гайд из библиотеки — синтез связывает находки с его целями.",
    selectGuide: "Выберите гайд",
    noGuide: "Без гайда",
    editGuide: "Изменить гайд",
    createGuide: "Создать гайд",
    guidePlaceholder:
      "Гайд не привязан. Выберите его выше или напишите гайд прямо здесь:\n\nЦели:\n- G1 …\n- G2 …",
    goals: (n: number) => `${n} ${n === 1 ? "цель" : "целей"}`,
    previousWave: "Предыдущая волна",
    previousWaveHint:
      "Необязательно. Используется позже для сравнения находок с предыдущей волной.",
    noPreviousWave: "Без предыдущей волны",
    created: "Создан",
    lastUpdated: "Обновлён",
    saving: "Сохранение…",
    saveChanges: "Сохранить изменения",
    breadcrumb: "Хлебные крошки",
    cycles: "Циклы",
    tabOverview: "Обзор",
    tabInterviews: "Интервью",
    tabSynthesis: "Синтез",
    tabDiff: "Сравнение",
  },
  en: {
    empty: "This is empty.",
    unsavedTitle: "Unsaved changes",
    unsavedBody: "You have unsaved changes — leave without saving?",
    leaveAction: "Leave without saving",
    untitledCycle: "Untitled cycle",
    cycleSaved: "Cycle saved",
    saveError: (e: string) => `Couldn't save your changes. ${e}`,
    name: "Name",
    product: "Product",
    productHint:
      "Pick a reusable product from the library — its context feeds transcription, cleanup, and synthesis.",
    selectProduct: "Select a product",
    noProduct: "No product",
    editProduct: "Edit product",
    createProduct: "Create product",
    productPlaceholder:
      "No product linked. Either pick one above, or write an inline product description (markdown):\n\n# Product\n…",
    guide: "Interview guide",
    guideHint:
      "Pick a reusable guide from the library — synthesis ties findings back to its goals.",
    selectGuide: "Select a guide",
    noGuide: "No guide",
    editGuide: "Edit guide",
    createGuide: "Create guide",
    guidePlaceholder:
      "No guide linked. Either pick one above, or write an inline guide:\n\nGoals:\n- G1 …\n- G2 …",
    goals: (n: number) => `${n} goal${n === 1 ? "" : "s"}`,
    previousWave: "Previous wave",
    previousWaveHint:
      "Optional. Used later to diff findings against the prior wave.",
    noPreviousWave: "No previous wave",
    created: "Created",
    lastUpdated: "Last updated",
    saving: "Saving…",
    saveChanges: "Save changes",
    breadcrumb: "Breadcrumb",
    cycles: "Cycles",
    tabOverview: "Overview",
    tabInterviews: "Interviews",
    tabSynthesis: "Synthesis",
    tabDiff: "Diff",
  },
};

// Sentinel for "no previous cycle" — radix Select forbids an empty-string item value.
const NO_PREV = "none";
// Sentinel for "no linked guide" in the guide picker.
const NO_GUIDE = "none";
// Sentinel for "no linked product" in the product picker.
const NO_PRODUCT = "none";

// Quiet section label + optional helper, document-style (not a boxed form field).
function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-col gap-0.5">
        <span className="text-sm font-medium text-foreground">{label}</span>
        {hint && <span className="text-xs text-muted-foreground">{hint}</span>}
      </div>
      {children}
    </div>
  );
}

// Rendered markdown preview (fixes the Overview "raw ##/- shown" bug, ui-backlog.md #2):
// reuse the Plate MarkdownEditor in READ-ONLY mode so the guide/product preview RENDERS
// markdown (headings, bullets, bold) instead of showing raw `##`/`-` text. `key` forces a
// re-seed when the content changes (the editor seeds once on mount).
function MarkdownPreview({ value }: { value: string }) {
  const t = useT(STR);
  const trimmed = value.trim();
  if (!trimmed) {
    return <p className="text-xs text-muted-foreground">{t.empty}</p>;
  }
  return (
    <MarkdownEditor
      key={trimmed}
      value={value}
      readOnly
      className="max-h-56 overflow-auto border-0 bg-transparent"
    />
  );
}

function OverviewTab({ cycleId }: { cycleId: string }) {
  const t = useT(STR);
  const { data: cycle, isPending } = useCycle(cycleId);
  const { data: allCycles } = useCycles();
  const { data: guides } = useGuides();
  const { data: products } = useProducts();
  const updateCycle = useUpdateCycle();

  // Local editable buffer seeded from the loaded cycle.
  const [name, setName] = useState("");
  const [productDesc, setProductDesc] = useState("");
  const [productId, setProductId] = useState<string>(NO_PRODUCT);
  const [guide, setGuide] = useState("");
  const [guideId, setGuideId] = useState<string>(NO_GUIDE);
  const [prevCycleId, setPrevCycleId] = useState<string>(NO_PREV);

  useEffect(() => {
    if (!cycle) return;
    setName(cycle.name);
    setProductDesc(cycle.product_desc);
    setProductId(cycle.product_id ?? NO_PRODUCT);
    setGuide(cycle.guide);
    setGuideId(cycle.guide_id ?? NO_GUIDE);
    setPrevCycleId(cycle.prev_cycle_id ?? NO_PREV);
  }, [cycle]);

  // Dirty = a local buffer diverges from the loaded cycle. Compared field-by-field so a
  // re-seed (after Save invalidates the query) clears it without extra bookkeeping.
  const dirty = useMemo(() => {
    if (!cycle) return false;
    return (
      name !== cycle.name ||
      productDesc !== cycle.product_desc ||
      productId !== (cycle.product_id ?? NO_PRODUCT) ||
      guide !== cycle.guide ||
      guideId !== (cycle.guide_id ?? NO_GUIDE) ||
      prevCycleId !== (cycle.prev_cycle_id ?? NO_PREV)
    );
  }, [cycle, name, productDesc, productId, guide, guideId, prevCycleId]);

  // Warn on window close/reload while there are unsaved Overview edits.
  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [dirty]);

  // Guard in-app navigation away from a dirty Overview (back, breadcrumb, Cmd+K, links,
  // tab switches — those write ?tab= via the router, so they're navigations too). The
  // shared ConfirmDialog renders below; proceed leaves, cancel/Esc stays.
  const blocker = useBlocker(dirty);

  if (isPending || !cycle) {
    return (
      <div className="flex flex-col gap-6 pt-2">
        <Skeleton className="h-9 w-full max-w-md" />
        <Skeleton className="h-28 w-full" />
        <Skeleton className="h-28 w-full" />
      </div>
    );
  }

  // Other cycles only — a cycle can't point at itself for diffing.
  const otherCycles = (allCycles ?? []).filter((c) => c.id !== cycleId);

  // The currently-selected library guide (for the preview + goals + "Edit guide" link).
  const selectedGuide = (guides ?? []).find((g) => g.id === guideId) ?? null;
  // The currently-selected library product (for the preview + "Edit/Create product" link).
  const selectedProduct = (products ?? []).find((p) => p.id === productId) ?? null;

  async function handleSave() {
    try {
      await updateCycle.mutateAsync({
        id: cycleId,
        name: name.trim() || t.untitledCycle,
        product_desc: productDesc,
        product_id: productId === NO_PRODUCT ? null : productId,
        guide,
        guide_id: guideId === NO_GUIDE ? null : guideId,
        prev_cycle_id: prevCycleId === NO_PREV ? null : prevCycleId,
      });
      toast.success(t.cycleSaved);
    } catch (e) {
      toast.error(t.saveError(String(e)));
    }
  }

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-7 pt-2 2xl:max-w-3xl">
      <Field label={t.name}>
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="text-base font-medium"
        />
      </Field>

      <Field label={t.product} hint={t.productHint}>
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <Select value={productId} onValueChange={setProductId}>
              <SelectTrigger className="w-full max-w-xs">
                <SelectValue placeholder={t.selectProduct} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NO_PRODUCT}>{t.noProduct}</SelectItem>
                {(products ?? []).map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button asChild variant="outline" size="sm">
              <Link to="/products">
                {selectedProduct ? t.editProduct : t.createProduct}
                <ArrowUpRight className="size-3.5" />
              </Link>
            </Button>
          </div>

          {selectedProduct ? (
            // Rendered markdown preview (NOT raw text) — fixes ui-backlog.md #2.
            <div className="flex flex-col gap-3 rounded-lg border border-border bg-card/40 p-3">
              <MarkdownPreview value={selectedProduct.content_md} />
            </div>
          ) : (
            // No linked library product → keep the legacy inline product_desc editable
            // (back-compat; the pipeline falls back to it). ponytail: a plain textarea is
            // enough for the fallback — the rich Plate editor lives in the Products library.
            <Textarea
              className="min-h-28 leading-relaxed"
              placeholder={t.productPlaceholder}
              value={productDesc}
              onChange={(e) => setProductDesc(e.target.value)}
            />
          )}
        </div>
      </Field>

      <Field label={t.guide} hint={t.guideHint}>
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <Select value={guideId} onValueChange={setGuideId}>
              <SelectTrigger className="w-full max-w-xs">
                <SelectValue placeholder={t.selectGuide} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NO_GUIDE}>{t.noGuide}</SelectItem>
                {(guides ?? []).map((g) => (
                  <SelectItem key={g.id} value={g.id}>
                    {g.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button asChild variant="outline" size="sm">
              <Link to="/guides">
                {selectedGuide ? t.editGuide : t.createGuide}
                <ArrowUpRight className="size-3.5" />
              </Link>
            </Button>
          </div>

          {selectedGuide ? (
            <div className="flex flex-col gap-3 rounded-lg border border-border bg-card/40 p-3">
              {/* A STRUCTURED guide shows its template (the 5 blocks, with the H/G/Q ids the
                  synthesis/diff reference) so the cycle Overview reflects the actual template —
                  not just a flat markdown blob. A free-markdown guide falls back to the rendered
                  markdown preview (fixes ui-backlog.md #2: raw ##/- shown). */}
              {!templateIsEmpty(selectedGuide.template) ? (
                <GuideTemplatePreview template={selectedGuide.template} />
              ) : (
                <>
                  <MarkdownPreview value={selectedGuide.content_md} />
                  {selectedGuide.goals.length > 0 && (
                    <div className="flex flex-col gap-1.5 border-t border-border pt-3">
                      <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                        <Target className="size-3.5" />
                        {t.goals(selectedGuide.goals.length)}
                      </div>
                      <ul className="flex flex-col gap-1">
                        {selectedGuide.goals.map((g) => (
                          <li key={g.id} className="flex items-start gap-2 text-xs">
                            <span className="mt-0.5 shrink-0 rounded bg-secondary px-1.5 py-0.5 font-numeric text-[10px] text-muted-foreground">
                              {g.id}
                            </span>
                            <span className="text-foreground/80">{g.text}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </>
              )}
            </div>
          ) : (
            // No linked library guide → keep the legacy inline guide text editable
            // (back-compat; synthesis falls back to it). ponytail: a plain textarea is
            // enough for the fallback — the rich Plate editor lives in the Guides library.
            <Textarea
              className="min-h-28 leading-relaxed"
              placeholder={t.guidePlaceholder}
              value={guide}
              onChange={(e) => setGuide(e.target.value)}
            />
          )}
        </div>
      </Field>

      {/* Secondary metadata — prev wave + dates read quiet, below the document. */}
      <div className="flex flex-col gap-5 border-t border-border pt-6">
        <Field label={t.previousWave} hint={t.previousWaveHint}>
          <Select value={prevCycleId} onValueChange={setPrevCycleId}>
            <SelectTrigger className="w-full max-w-xs">
              <SelectValue placeholder={t.noPreviousWave} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NO_PREV}>{t.noPreviousWave}</SelectItem>
              {otherCycles.map((c) => (
                <SelectItem key={c.id} value={c.id}>
                  {c.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>

        <dl className="flex flex-wrap gap-x-10 gap-y-2 text-xs">
          <div className="flex flex-col gap-0.5">
            <dt className="text-muted-foreground">{t.created}</dt>
            <dd className="font-numeric text-foreground/80">
              {absoluteDate(cycle.created_at)}
            </dd>
          </div>
          <div className="flex flex-col gap-0.5">
            <dt className="text-muted-foreground">{t.lastUpdated}</dt>
            <dd className="font-numeric text-foreground/80">
              {absoluteDate(cycle.updated_at)}
            </dd>
          </div>
        </dl>
      </div>

      <div className="flex justify-end border-t border-border pt-5">
        <Button onClick={handleSave} disabled={updateCycle.isPending} size="sm">
          {updateCycle.isPending ? t.saving : t.saveChanges}
        </Button>
      </div>

      {/* Unsaved-changes guard for in-app navigation (paired with the beforeunload
          listener above for window close/reload). */}
      <ConfirmDialog
        open={blocker.state === "blocked"}
        onOpenChange={(o) => {
          if (!o && blocker.state === "blocked") blocker.reset();
        }}
        title={t.unsavedTitle}
        body={t.unsavedBody}
        confirmLabel={t.leaveAction}
        destructive
        onConfirm={() => {
          if (blocker.state === "blocked") blocker.proceed();
        }}
      />
    </div>
  );
}

const TABS = ["overview", "interviews", "synthesis", "diff"] as const;

export function CycleDetailPage() {
  const t = useT(STR);
  const { id } = useParams<{ id: string }>();
  const location = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();
  const { data: cycle } = useCycle(id);

  // Active tab is mirrored in ?tab= for deep-linking. The query param is the source of
  // truth; an unknown/missing value falls back to overview.
  const tabParam = searchParams.get("tab") ?? "";
  const tab = (TABS as readonly string[]).includes(tabParam)
    ? tabParam
    : "overview";

  // Switching tabs writes ?tab= via the router; this IS a navigation, so leaving a dirty
  // Overview is caught by that tab's own useBlocker (no separate confirm needed here).
  const setTab = useCallback(
    (next: string) => {
      setSearchParams(
        (prev) => {
          const sp = new URLSearchParams(prev);
          if (next === "overview") sp.delete("tab");
          else sp.set("tab", next);
          return sp;
        },
        { replace: true },
      );
    },
    [setSearchParams],
  );

  // A chat finding-citation (#finding-Fn) deep-links into the Synthesis tab — where the
  // synthesis tab's own effect then scrolls the finding into view (M11).
  useEffect(() => {
    if (location.hash.startsWith("#finding-")) setTab("synthesis");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.hash, location.key]);

  if (!id) return null;

  // ponytail: the Ask AI CTA + the chat panel were lifted to the shell (App.tsx) so they
  // persist on EVERY cycle screen incl. the transcript editor. This page is now just the
  // cycle's tabs; the shell docks the panel against the whole content area.
  //
  // Width: the shell (App.tsx) already centers content in a capped column — no inner
  // max-w here, so the tabs fill the shell's width instead of pinning left with dead
  // space on wide monitors (v3 audit, дизайнер #1). The Overview form keeps its own
  // readable prose column; data tabs (Interviews/Synthesis/Diff) go full width.
  return (
    <div className="flex h-full min-h-0 w-full flex-col gap-5">
      {/* Wayfinding lives in the App header breadcrumbs (v3); the page keeps only its H1. */}
      <h1 className="truncate text-sm font-medium tracking-[-0.01em] text-foreground">
        {cycle?.name ?? " "}
      </h1>

      <Tabs value={tab} onValueChange={setTab} className="min-h-0 flex-1 gap-5">
        <TabsList variant="line" className="border-b border-border pb-0">
          <TabsTrigger value="overview">{t.tabOverview}</TabsTrigger>
          <TabsTrigger value="interviews">{t.tabInterviews}</TabsTrigger>
          <TabsTrigger value="synthesis">{t.tabSynthesis}</TabsTrigger>
          <TabsTrigger value="diff">{t.tabDiff}</TabsTrigger>
        </TabsList>
        <TabsContent value="overview">
          <OverviewTab cycleId={id} />
        </TabsContent>
        <TabsContent value="interviews">
          <InterviewsTab cycleId={id} />
        </TabsContent>
        <TabsContent value="synthesis">
          <SynthesisTab cycleId={id} />
        </TabsContent>
        <TabsContent value="diff">
          <DiffTab cycleId={id} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
