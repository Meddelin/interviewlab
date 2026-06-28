import { useEffect, useState } from "react";
import { Code2, FileText, LayoutTemplate, Plus, Target, Trash2 } from "lucide-react";
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
import { GuideTemplateEditor } from "@/components/guide-template-editor";
import {
  useCreateGuide,
  useDeleteGuide,
  useGuides,
  useUpdateGuide,
} from "@/lib/guide-queries";
import { relativeTime } from "@/lib/format";
import { mod } from "@/lib/platform";
import {
  EMPTY_TEMPLATE,
  templateGoals,
  templateIsEmpty,
  type Guide,
  type GuideTemplate,
} from "@/lib/tauri";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n";

const STR = {
  ru: {
    newGuide: "Новый гайд",
    dialogTitle: "Новый гайд интервью",
    dialogDescription:
      "Переиспользуемый гайд в markdown. Циклы запускаются по нему; его цели выводятся из раздела «Цели».",
    namePlaceholder: "напр. Глубокое погружение в активацию",
    creating: "Создаём…",
    create: "Создать гайд",
    createError: (e: string) => `Не удалось создать гайд. ${e}`,
    deleteGuide: "Удалить гайд",
    saving: "Сохраняем…",
    save: "Сохранить",
    saved: "Гайд сохранён",
    saveError: (e: string) => `Не удалось сохранить гайд. ${e}`,
    untitled: "Гайд без названия",
    confirmDelete: (name: string) =>
      `Удалить «${name}»? Циклы, использующие его, вернутся к встроенному гайду.`,
    deleted: "Гайд удалён",
    deleteError: (e: string) => `Не удалось удалить гайд. ${e}`,
    template: "Шаблон",
    rawMarkdown: "Сырой markdown",
    editorPlaceholder: "Напишите гайд в markdown — начните с раздела «Цели»…",
    derivedGoals: "Выведенные цели",
    derivedGoalsHintStructured:
      "Добавьте задачи под «Задачи интервью» — они станут стабильными id целей (G1, G2…).",
    derivedGoalsHintRaw:
      "Добавьте пункты под заголовком «Цели» — они станут стабильными id целей (G1, G2…).",
    heading: "Гайды",
    subtitle:
      "Переиспользуемые дизайны интервью. Каждый цикл запускается по гайду; из него выводятся цели.",
    emptyTitle: "Пока нет гайдов",
    emptyBody:
      "Создайте переиспользуемый гайд интервью — его цели управляют синтезом и сохраняют диффы стабильными между волнами.",
    goals: (n: number) => `${n} ${n === 1 ? "цель" : n >= 2 && n <= 4 ? "цели" : "целей"}`,
    selectToEdit: "Выберите гайд для редактирования.",
  },
  en: {
    newGuide: "New guide",
    dialogTitle: "New interview guide",
    dialogDescription:
      "A reusable, markdown guide. Cycles run against it; its goals are derived from the Goals section.",
    namePlaceholder: "e.g. Activation deep-dive",
    creating: "Creating…",
    create: "Create guide",
    createError: (e: string) => `Couldn't create the guide. ${e}`,
    deleteGuide: "Delete guide",
    saving: "Saving…",
    save: "Save",
    saved: "Guide saved",
    saveError: (e: string) => `Couldn't save the guide. ${e}`,
    untitled: "Untitled guide",
    confirmDelete: (name: string) =>
      `Delete "${name}"? Cycles using it will fall back to their inline guide.`,
    deleted: "Guide deleted",
    deleteError: (e: string) => `Couldn't delete the guide. ${e}`,
    template: "Template",
    rawMarkdown: "Raw markdown",
    editorPlaceholder: "Write the guide in markdown — start with a Goals section…",
    derivedGoals: "Derived goals",
    derivedGoalsHintStructured:
      "Add tasks under “Задачи интервью” — they become stable goal ids (G1, G2…).",
    derivedGoalsHintRaw:
      "Add bullets under a “Goals” heading — they become stable goal ids (G1, G2…).",
    heading: "Guides",
    subtitle:
      "Reusable interview designs. Each cycle runs against a guide; goals are derived from it.",
    emptyTitle: "No guides yet",
    emptyBody:
      "Create a reusable interview guide — its goals drive synthesis and keep diffs stable across waves.",
    goals: (n: number) => `${n} goal${n === 1 ? "" : "s"}`,
    selectToEdit: "Select a guide to edit.",
  },
};

// Which editing surface is shown for a guide: the structured template (the 5 fixed blocks) or
// the raw markdown body (free-form, for guides that don't use the template).
type EditMode = "structured" | "raw";

// ── Create-guide dialog ────────────────────────────────────────────────────────
function CreateGuideDialog({ onCreated }: { onCreated: (g: Guide) => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const createGuide = useCreateGuide();
  const t = useT(STR);

  async function submit() {
    const trimmed = name.trim();
    if (!trimmed) return;
    try {
      // New guides start as an empty STRUCTURED template — the editor opens on the 5 blocks
      // ready to fill (a power user can switch to Raw markdown).
      const g = await createGuide.mutateAsync({
        name: trimmed,
        template: EMPTY_TEMPLATE,
      });
      setName("");
      setOpen(false);
      onCreated(g);
    } catch (e) {
      toast.error(t.createError(String(e)));
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Button size="sm" onClick={() => setOpen(true)}>
        <Plus className="size-3.5" />
        {t.newGuide}
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
            disabled={!name.trim() || createGuide.isPending}
          >
            {createGuide.isPending ? t.creating : t.create}
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
  const t = useT(STR);

  // A guide is structured (uses the template) unless it's a legacy free-markdown guide with no
  // template but existing content — then we open on Raw so we don't hide its body.
  const startStructured = !templateIsEmpty(guide.template) || !guide.content_md.trim();

  // Local editable buffers, re-seeded whenever a different guide is selected.
  const [name, setName] = useState(guide.name);
  const [contentMd, setContentMd] = useState(guide.content_md);
  const [template, setTemplate] = useState<GuideTemplate>(guide.template);
  const [mode, setMode] = useState<EditMode>(startStructured ? "structured" : "raw");
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    setName(guide.name);
    setContentMd(guide.content_md);
    setTemplate(guide.template);
    setMode(!templateIsEmpty(guide.template) || !guide.content_md.trim() ? "structured" : "raw");
    setDirty(false);
  }, [guide.id]); // eslint-disable-line react-hooks/exhaustive-deps

  async function save() {
    try {
      // The active tab decides the stored representation: structured → send the template (the
      // backend renders content_md from it); raw → send markdown + clear the template.
      await updateGuide.mutateAsync(
        mode === "structured"
          ? { id: guide.id, name: name.trim() || t.untitled, content_md: "", template }
          : {
              id: guide.id,
              name: name.trim() || t.untitled,
              content_md: contentMd,
              template: EMPTY_TEMPLATE,
            },
      );
      setDirty(false);
      toast.success(t.saved);
    } catch (e) {
      toast.error(t.saveError(String(e)));
    }
  }

  // Goals shown in the derived-goals panel: from the live template (structured) or the
  // last-saved derived goals (raw).
  const derivedGoals = mode === "structured" ? templateGoals(template) : guide.goals;

  async function remove() {
    if (!confirm(t.confirmDelete(guide.name))) return;
    try {
      await deleteGuide.mutateAsync(guide.id);
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
          aria-label={t.deleteGuide}
          className="text-muted-foreground hover:text-destructive"
          onClick={remove}
          disabled={deleteGuide.isPending}
        >
          <Trash2 className="size-4" />
        </Button>
        <Button size="sm" onClick={save} disabled={!dirty || updateGuide.isPending}>
          {updateGuide.isPending ? t.saving : t.save}
          <kbd className="ml-1 hidden font-numeric text-[10px] text-primary-foreground/70 sm:inline">
            {mod("S")}
          </kbd>
        </Button>
      </div>

      {/* Mode toggle: structured template vs raw markdown. */}
      <div className="flex w-fit items-center rounded-md border border-border p-0.5">
        <button
          type="button"
          onClick={() => setMode("structured")}
          className={cn(
            "flex items-center gap-1.5 rounded px-2.5 py-1 text-xs transition-colors",
            mode === "structured"
              ? "bg-secondary text-foreground"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          <LayoutTemplate className="size-3.5" />
          {t.template}
        </button>
        <button
          type="button"
          onClick={() => setMode("raw")}
          className={cn(
            "flex items-center gap-1.5 rounded px-2.5 py-1 text-xs transition-colors",
            mode === "raw"
              ? "bg-secondary text-foreground"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          <Code2 className="size-3.5" />
          {t.rawMarkdown}
        </button>
      </div>

      {mode === "structured" ? (
        <GuideTemplateEditor
          key={guide.id}
          template={template}
          onChange={(t) => {
            setTemplate(t);
            setDirty(true);
          }}
        />
      ) : (
        // The markdown editor (Plate). Long-form prose: the editing column above is
        // capped to a comfortable reading width, so the editor simply fills that column.
        <MarkdownEditor
          key={guide.id}
          value={guide.content_md}
          onChange={(md) => {
            setContentMd(md);
            setDirty(true);
          }}
          placeholder={t.editorPlaceholder}
        />
      )}

      {/* Derived goals — what synthesis ties findings back to (the template's tasks, or the
          Goals bullets of a raw-markdown guide). */}
      <div className="flex flex-col gap-2 rounded-lg border border-border bg-card/40 p-3">
        <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
          <Target className="size-3.5" />
          {t.derivedGoals}
          <span className="font-numeric text-foreground/70">{derivedGoals.length}</span>
        </div>
        {derivedGoals.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            {mode === "structured"
              ? t.derivedGoalsHintStructured
              : t.derivedGoalsHintRaw}
          </p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {derivedGoals.map((g) => (
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
  const t = useT(STR);

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
            {t.heading}
          </h1>
          <p className="text-xs text-muted-foreground">{t.subtitle}</p>
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
            <p className="text-sm font-medium text-foreground">{t.emptyTitle}</p>
            <p className="text-xs text-muted-foreground">{t.emptyBody}</p>
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
                  <span>{t.goals(g.goals.length)}</span>
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
              {t.selectToEdit}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
