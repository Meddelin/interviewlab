import { useEffect, useState } from "react";
import { Link, useLocation, useParams } from "react-router-dom";
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
import { InterviewsTab } from "@/components/interviews-tab";
import { SynthesisTab } from "@/components/synthesis-tab";
import { DiffTab } from "@/components/diff-tab";
import { absoluteDate } from "@/lib/format";

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
  const trimmed = value.trim();
  if (!trimmed) {
    return <p className="text-xs text-muted-foreground">This is empty.</p>;
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
        name: name.trim() || "Untitled cycle",
        product_desc: productDesc,
        product_id: productId === NO_PRODUCT ? null : productId,
        guide,
        guide_id: guideId === NO_GUIDE ? null : guideId,
        prev_cycle_id: prevCycleId === NO_PREV ? null : prevCycleId,
      });
      toast.success("Cycle saved");
    } catch (e) {
      toast.error(`Couldn't save your changes. ${String(e)}`);
    }
  }

  return (
    <div className="flex max-w-2xl flex-col gap-7 pt-2">
      <Field label="Name">
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="text-base font-medium"
        />
      </Field>

      <Field
        label="Product"
        hint="Pick a reusable product from the library — its context feeds transcription, cleanup, and synthesis."
      >
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <Select value={productId} onValueChange={setProductId}>
              <SelectTrigger className="w-full max-w-xs">
                <SelectValue placeholder="Select a product" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NO_PRODUCT}>No product</SelectItem>
                {(products ?? []).map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button asChild variant="outline" size="sm">
              <Link to="/products">
                {selectedProduct ? "Edit product" : "Create product"}
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
              placeholder={"No product linked. Either pick one above, or write an inline product description (markdown):\n\n# Product\n…"}
              value={productDesc}
              onChange={(e) => setProductDesc(e.target.value)}
            />
          )}
        </div>
      </Field>

      <Field
        label="Interview guide"
        hint="Pick a reusable guide from the library — synthesis ties findings back to its goals."
      >
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <Select value={guideId} onValueChange={setGuideId}>
              <SelectTrigger className="w-full max-w-xs">
                <SelectValue placeholder="Select a guide" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NO_GUIDE}>No guide</SelectItem>
                {(guides ?? []).map((g) => (
                  <SelectItem key={g.id} value={g.id}>
                    {g.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button asChild variant="outline" size="sm">
              <Link to="/guides">
                {selectedGuide ? "Edit guide" : "Create guide"}
                <ArrowUpRight className="size-3.5" />
              </Link>
            </Button>
          </div>

          {selectedGuide ? (
            <div className="flex flex-col gap-3 rounded-lg border border-border bg-card/40 p-3">
              {/* Content preview — RENDERED markdown (fixes ui-backlog.md #2: raw ##/- shown). */}
              <MarkdownPreview value={selectedGuide.content_md} />
              {selectedGuide.goals.length > 0 && (
                <div className="flex flex-col gap-1.5 border-t border-border pt-3">
                  <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                    <Target className="size-3.5" />
                    {selectedGuide.goals.length} goal
                    {selectedGuide.goals.length === 1 ? "" : "s"}
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
            </div>
          ) : (
            // No linked library guide → keep the legacy inline guide text editable
            // (back-compat; synthesis falls back to it). ponytail: a plain textarea is
            // enough for the fallback — the rich Plate editor lives in the Guides library.
            <Textarea
              className="min-h-28 leading-relaxed"
              placeholder={"No guide linked. Either pick one above, or write an inline guide:\n\nGoals:\n- G1 …\n- G2 …"}
              value={guide}
              onChange={(e) => setGuide(e.target.value)}
            />
          )}
        </div>
      </Field>

      {/* Secondary metadata — prev wave + dates read quiet, below the document. */}
      <div className="flex flex-col gap-5 border-t border-border pt-6">
        <Field
          label="Previous wave"
          hint="Optional. Used later to diff findings against the prior wave."
        >
          <Select value={prevCycleId} onValueChange={setPrevCycleId}>
            <SelectTrigger className="w-full max-w-xs">
              <SelectValue placeholder="No previous wave" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NO_PREV}>No previous wave</SelectItem>
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
            <dt className="text-muted-foreground">Created</dt>
            <dd className="font-numeric text-foreground/80">
              {absoluteDate(cycle.created_at)}
            </dd>
          </div>
          <div className="flex flex-col gap-0.5">
            <dt className="text-muted-foreground">Last updated</dt>
            <dd className="font-numeric text-foreground/80">
              {absoluteDate(cycle.updated_at)}
            </dd>
          </div>
        </dl>
      </div>

      <div className="flex justify-end border-t border-border pt-5">
        <Button onClick={handleSave} disabled={updateCycle.isPending} size="sm">
          {updateCycle.isPending ? "Saving…" : "Save changes"}
        </Button>
      </div>
    </div>
  );
}

export function CycleDetailPage() {
  const { id } = useParams<{ id: string }>();
  const location = useLocation();

  // Controlled tab so a chat finding-citation (#finding-Fn) can switch to the Synthesis
  // tab — where the synthesis tab's own effect then scrolls the finding into view (M11).
  const [tab, setTab] = useState("overview");
  useEffect(() => {
    if (location.hash.startsWith("#finding-")) setTab("synthesis");
  }, [location.hash, location.key]);

  if (!id) return null;

  // ponytail: the Ask AI CTA + the chat panel were lifted to the shell (App.tsx) so they
  // persist on EVERY cycle screen incl. the transcript editor. This page is now just the
  // cycle's tabs; the shell docks the panel against the whole content area.
  return (
    <div className="flex h-full min-h-0 flex-col gap-5">
      <Tabs value={tab} onValueChange={setTab} className="min-h-0 flex-1 gap-5">
        <TabsList variant="line" className="border-b border-border pb-0">
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="interviews">Interviews</TabsTrigger>
          <TabsTrigger value="synthesis">Synthesis</TabsTrigger>
          <TabsTrigger value="diff">Diff</TabsTrigger>
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
