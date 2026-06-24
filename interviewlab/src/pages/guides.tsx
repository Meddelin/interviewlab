import { useEffect, useState } from "react";
import { FileText, Plus, Target, Trash2 } from "lucide-react";
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
import {
  useCreateGuide,
  useDeleteGuide,
  useGuides,
  useUpdateGuide,
} from "@/lib/guide-queries";
import { relativeTime } from "@/lib/format";
import type { Guide } from "@/lib/tauri";
import { cn } from "@/lib/utils";

// Default scaffold for a new guide so the markdown editor opens with a usable shape
// (a Goals section is what synthesis derives goal_ids from).
const NEW_GUIDE_TEMPLATE =
  "## Goals\n\n- G1: \n- G2: \n\n## Target conclusions\n\n- \n";

// ── Create-guide dialog ────────────────────────────────────────────────────────
function CreateGuideDialog({ onCreated }: { onCreated: (g: Guide) => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const createGuide = useCreateGuide();

  async function submit() {
    const trimmed = name.trim();
    if (!trimmed) return;
    try {
      const g = await createGuide.mutateAsync({
        name: trimmed,
        content_md: NEW_GUIDE_TEMPLATE,
      });
      setName("");
      setOpen(false);
      onCreated(g);
    } catch (e) {
      toast.error(`Couldn't create the guide. ${String(e)}`);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Button size="sm" onClick={() => setOpen(true)}>
        <Plus className="size-3.5" />
        New guide
      </Button>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>New interview guide</DialogTitle>
          <DialogDescription>
            A reusable, markdown guide. Cycles run against it; its goals are derived from
            the Goals section.
          </DialogDescription>
        </DialogHeader>
        <Input
          autoFocus
          placeholder="e.g. Activation deep-dive"
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
            disabled={!name.trim() || createGuide.isPending}
          >
            {createGuide.isPending ? "Creating…" : "Create guide"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Guide editor (right pane) ──────────────────────────────────────────────────
function GuideEditor({ guide }: { guide: Guide }) {
  const updateGuide = useUpdateGuide();
  const deleteGuide = useDeleteGuide();

  // Local editable buffers, re-seeded whenever a different guide is selected.
  const [name, setName] = useState(guide.name);
  const [contentMd, setContentMd] = useState(guide.content_md);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    setName(guide.name);
    setContentMd(guide.content_md);
    setDirty(false);
  }, [guide.id]); // eslint-disable-line react-hooks/exhaustive-deps

  async function save() {
    try {
      await updateGuide.mutateAsync({
        id: guide.id,
        name: name.trim() || "Untitled guide",
        content_md: contentMd,
      });
      setDirty(false);
      toast.success("Guide saved");
    } catch (e) {
      toast.error(`Couldn't save the guide. ${String(e)}`);
    }
  }

  async function remove() {
    if (!confirm(`Delete "${guide.name}"? Cycles using it will fall back to their inline guide.`))
      return;
    try {
      await deleteGuide.mutateAsync(guide.id);
      toast.success("Guide deleted");
    } catch (e) {
      toast.error(`Couldn't delete the guide. ${String(e)}`);
    }
  }

  // ⌘/Ctrl+S saves.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key.toLowerCase() === "s" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        if (dirty && !updateGuide.isPending) save();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }); // re-bind each render so `dirty`/buffers are current

  return (
    // Editing column keeps a comfortable reading width (the surrounding page
    // chrome / guide list is fluid full-width, but long-form prose isn't).
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
          aria-label="Delete guide"
          className="text-muted-foreground hover:text-destructive"
          onClick={remove}
          disabled={deleteGuide.isPending}
        >
          <Trash2 className="size-4" />
        </Button>
        <Button size="sm" onClick={save} disabled={!dirty || updateGuide.isPending}>
          {updateGuide.isPending ? "Saving…" : "Save"}
          <kbd className="ml-1 hidden font-numeric text-[10px] text-primary-foreground/70 sm:inline">
            ⌘S
          </kbd>
        </Button>
      </div>

      {/* The markdown editor (Plate). Long-form prose: the editing column above is
          capped to a comfortable reading width (full ultra-wide prose is hard to
          read), so the editor simply fills that column. */}
      <MarkdownEditor
        key={guide.id}
        value={guide.content_md}
        onChange={(md) => {
          setContentMd(md);
          setDirty(true);
        }}
        placeholder="Write the guide in markdown — start with a Goals section…"
      />

      {/* Derived goals — what synthesis ties findings back to. */}
      <div className="flex flex-col gap-2 rounded-lg border border-border bg-card/40 p-3">
        <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
          <Target className="size-3.5" />
          Derived goals
          <span className="font-numeric text-foreground/70">
            {guide.goals.length}
          </span>
        </div>
        {guide.goals.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            Add bullets under a “Goals” heading — they become stable goal ids (G1, G2…)
            and are re-derived when you save.
          </p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {guide.goals.map((g) => (
              <li key={g.id} className="flex items-start gap-2 text-xs">
                <span className="mt-0.5 shrink-0 rounded bg-secondary px-1.5 py-0.5 font-numeric text-[10px] text-muted-foreground">
                  {g.id}
                </span>
                <span className="text-foreground/80">{g.text}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

// ── The Guides / Designs library page ──────────────────────────────────────────
export function GuidesPage() {
  const { data: guides, isPending } = useGuides();
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // Keep a valid selection: default to the first guide once loaded.
  useEffect(() => {
    if (!guides) return;
    if (selectedId && guides.some((g) => g.id === selectedId)) return;
    setSelectedId(guides[0]?.id ?? null);
  }, [guides, selectedId]);

  const selected = guides?.find((g) => g.id === selectedId) ?? null;

  return (
    <div className="flex flex-col gap-5">
      <header className="flex items-center justify-between gap-4">
        <div className="flex flex-col gap-0.5">
          <h1 className="text-lg font-semibold tracking-[-0.02em] text-foreground">
            Guides
          </h1>
          <p className="text-xs text-muted-foreground">
            Reusable interview designs. Each cycle runs against a guide; goals are derived
            from it.
          </p>
        </div>
        <CreateGuideDialog onCreated={(g) => setSelectedId(g.id)} />
      </header>

      {isPending ? (
        <div className="grid grid-cols-[260px_1fr] gap-6">
          <Skeleton className="h-64 w-full" />
          <Skeleton className="h-64 w-full" />
        </div>
      ) : !guides || guides.length === 0 ? (
        <div className="flex flex-col items-center gap-4 rounded-lg border border-dashed border-border px-6 py-16 text-center">
          <span className="flex size-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <FileText className="size-5" />
          </span>
          <div className="flex max-w-sm flex-col gap-1">
            <p className="text-sm font-medium text-foreground">No guides yet</p>
            <p className="text-xs text-muted-foreground">
              Create a reusable interview guide — its goals drive synthesis and keep diffs
              stable across waves.
            </p>
          </div>
          <CreateGuideDialog onCreated={(g) => setSelectedId(g.id)} />
        </div>
      ) : (
        <div className="grid grid-cols-[260px_1fr] gap-6">
          {/* List */}
          <div className="flex flex-col overflow-hidden rounded-lg border border-border bg-card/40">
            {guides.map((g) => (
              <button
                key={g.id}
                type="button"
                onClick={() => setSelectedId(g.id)}
                className={cn(
                  "flex flex-col gap-0.5 border-b border-border px-3 py-2.5 text-left transition-colors last:border-b-0 hover:bg-secondary/40 focus-visible:bg-secondary/40 focus-visible:outline-none",
                  g.id === selectedId && "bg-secondary/60",
                )}
              >
                <span className="flex items-center gap-2">
                  <span
                    className={cn(
                      "h-3.5 w-0.5 shrink-0 rounded-full",
                      g.id === selectedId ? "bg-primary" : "bg-transparent",
                    )}
                  />
                  <span className="truncate text-sm font-medium text-foreground">
                    {g.name}
                  </span>
                </span>
                <span className="flex items-center gap-2 pl-2.5 font-numeric text-[11px] text-muted-foreground">
                  <span>
                    {g.goals.length} goal{g.goals.length === 1 ? "" : "s"}
                  </span>
                  <span className="text-muted-foreground/50">·</span>
                  <span>{relativeTime(g.updated_at)}</span>
                </span>
              </button>
            ))}
          </div>

          {/* Editor */}
          {selected ? (
            <GuideEditor key={selected.id} guide={selected} />
          ) : (
            <div className="flex items-center justify-center rounded-lg border border-dashed border-border p-8 text-sm text-muted-foreground">
              Select a guide to edit.
            </div>
          )}
        </div>
      )}
    </div>
  );
}
