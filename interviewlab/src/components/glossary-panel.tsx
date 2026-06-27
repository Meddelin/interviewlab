import { useState } from "react";
import { BookText, Check, Pencil, Plus, Trash2, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  useCreateGlossaryTerm,
  useDeleteGlossaryTerm,
  useGlossaryTerms,
  useUpdateGlossaryTerm,
} from "@/lib/glossary-queries";
import type { GlossaryTerm } from "@/lib/tauri";
import { useT } from "@/lib/i18n";

const STR = {
  ru: {
    canonicalPlaceholderFull: "Каноническое написание (например, API, Jira, дедлайн)",
    aliasesPlaceholderFull: "Варианты от ASR через запятую (например, эй-пи-ай, апишка)",
    notePlaceholder: "Заметка (необязательно)",
    cancel: "Отмена",
    save: "Сохранить",
    editTerm: "Редактировать термин",
    deleteTerm: "Удалить термин",
    couldntSave: (e: string) => `Не удалось сохранить термин. ${e}`,
    couldntDelete: (e: string) => `Не удалось удалить термин. ${e}`,
    couldntAdd: (e: string) => `Не удалось добавить термин. ${e}`,
    glossary: "Глоссарий",
    description:
      "Термин → каноническое написание, с искажёнными формами от ASR в качестве вариантов. Влияет на транскрипцию и сохраняет единообразие терминов при вычитке.",
    canonicalPlaceholder: "Канонический (например, Figma)",
    aliasesPlaceholder: "Варианты через запятую (например, фигма)",
    add: "Добавить",
    loading: "Загрузка…",
    empty:
      "Пока нет терминов. Добавьте англицизмы, аббревиатуры и названия продуктов, которые распознаются неверно — или сгенерируйте их из интервью на вкладке «Интервью».",
  },
  en: {
    canonicalPlaceholderFull: "Canonical spelling (e.g. API, Jira, дедлайн)",
    aliasesPlaceholderFull: "Aliases the ASR produces, comma-separated (e.g. эй-пи-ай, апишка)",
    notePlaceholder: "Note (optional)",
    cancel: "Cancel",
    save: "Save",
    editTerm: "Edit term",
    deleteTerm: "Delete term",
    couldntSave: (e: string) => `Couldn't save the term. ${e}`,
    couldntDelete: (e: string) => `Couldn't delete the term. ${e}`,
    couldntAdd: (e: string) => `Couldn't add the term. ${e}`,
    glossary: "Glossary",
    description:
      "Term → canonical spelling, with the garbled forms the ASR produces as aliases. Biases transcription and keeps terms consistent during cleanup.",
    canonicalPlaceholder: "Canonical (e.g. Figma)",
    aliasesPlaceholder: "Aliases, comma-separated (e.g. фигма)",
    add: "Add",
    loading: "Loading…",
    empty:
      "No terms yet. Add the anglicisms, acronyms, and product names that get mis-transcribed — or auto-suggest them from an interview on the Interviews tab.",
  },
};

// Parse a comma/newline-separated aliases field into a clean list.
function parseAliases(raw: string): string[] {
  return raw
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

// One term row — toggles between a read view (canonical + alias chips + notes) and an inline
// editor. Aliases are the garbled/variant forms the ASR produces; canonical is the fix.
function TermRow({ productId, term }: { productId: string; term: GlossaryTerm }) {
  const update = useUpdateGlossaryTerm(productId);
  const del = useDeleteGlossaryTerm(productId);
  const t = useT(STR);
  const [editing, setEditing] = useState(false);
  const [canonical, setCanonical] = useState(term.canonical);
  const [aliases, setAliases] = useState(term.aliases.join(", "));
  const [notes, setNotes] = useState(term.notes);

  async function save() {
    if (!canonical.trim()) return;
    try {
      await update.mutateAsync({
        id: term.id,
        canonical: canonical.trim(),
        aliases: parseAliases(aliases),
        notes: notes.trim(),
      });
      setEditing(false);
    } catch (e) {
      toast.error(t.couldntSave(String(e)));
    }
  }

  async function remove() {
    try {
      await del.mutateAsync(term.id);
    } catch (e) {
      toast.error(t.couldntDelete(String(e)));
    }
  }

  if (editing) {
    return (
      <div className="flex flex-col gap-2 border-b border-border px-3 py-2.5 last:border-b-0">
        <Input
          value={canonical}
          onChange={(e) => setCanonical(e.target.value)}
          placeholder={t.canonicalPlaceholderFull}
          className="h-8"
        />
        <Input
          value={aliases}
          onChange={(e) => setAliases(e.target.value)}
          placeholder={t.aliasesPlaceholderFull}
          className="h-8"
        />
        <Input
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder={t.notePlaceholder}
          className="h-8"
        />
        <div className="flex justify-end gap-1.5">
          <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
            <X className="size-3.5" />
            {t.cancel}
          </Button>
          <Button size="sm" onClick={save} disabled={!canonical.trim() || update.isPending}>
            <Check className="size-3.5" />
            {t.save}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="group flex items-start gap-2 border-b border-border px-3 py-2.5 last:border-b-0">
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="text-sm font-medium text-foreground">{term.canonical}</span>
        {term.aliases.length > 0 && (
          <span className="flex flex-wrap gap-1">
            {term.aliases.map((a) => (
              <Badge key={a} variant="secondary" className="font-normal">
                {a}
              </Badge>
            ))}
          </span>
        )}
        {term.notes && <span className="text-xs text-muted-foreground">{term.notes}</span>}
      </div>
      <div className="flex shrink-0 gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={t.editTerm}
          onClick={() => setEditing(true)}
        >
          <Pencil className="size-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={t.deleteTerm}
          className="text-muted-foreground hover:text-destructive"
          onClick={remove}
          disabled={del.isPending}
        >
          <Trash2 className="size-3.5" />
        </Button>
      </div>
    </div>
  );
}

// The glossary panel for a product: a focused term→canonical list that anchors anglicisms /
// technical terms / product names across transcription + cleanup (docs/transcription-
// terminology.md). Lives under the product's markdown editor.
export function GlossaryPanel({ productId }: { productId: string }) {
  const { data: terms, isPending } = useGlossaryTerms(productId);
  const create = useCreateGlossaryTerm(productId);
  const t = useT(STR);
  const [canonical, setCanonical] = useState("");
  const [aliases, setAliases] = useState("");

  async function add() {
    const c = canonical.trim();
    if (!c) return;
    try {
      await create.mutateAsync({ product_id: productId, canonical: c, aliases: parseAliases(aliases) });
      setCanonical("");
      setAliases("");
    } catch (e) {
      toast.error(t.couldntAdd(String(e)));
    }
  }

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border bg-card/40 p-3">
      <div className="flex flex-col gap-0.5">
        <span className="flex items-center gap-2 text-sm font-medium text-foreground">
          <BookText className="size-4 text-muted-foreground" />
          {t.glossary}
          {terms && terms.length > 0 && (
            <span className="font-numeric text-xs text-muted-foreground">({terms.length})</span>
          )}
        </span>
        <p className="text-xs text-muted-foreground">{t.description}</p>
      </div>

      {/* Add a term */}
      <div className="flex flex-col gap-2 sm:flex-row">
        <Input
          value={canonical}
          onChange={(e) => setCanonical(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") add();
          }}
          placeholder={t.canonicalPlaceholder}
          className="h-8 sm:w-44"
        />
        <Input
          value={aliases}
          onChange={(e) => setAliases(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") add();
          }}
          placeholder={t.aliasesPlaceholder}
          className="h-8 flex-1"
        />
        <Button size="sm" onClick={add} disabled={!canonical.trim() || create.isPending}>
          <Plus className="size-3.5" />
          {t.add}
        </Button>
      </div>

      {/* List */}
      {isPending ? (
        <p className="px-1 py-2 text-xs text-muted-foreground">{t.loading}</p>
      ) : !terms || terms.length === 0 ? (
        <p className="px-1 py-2 text-xs text-muted-foreground">{t.empty}</p>
      ) : (
        <div className="overflow-hidden rounded-md border border-border bg-background">
          {terms.map((t) => (
            <TermRow key={t.id} productId={productId} term={t} />
          ))}
        </div>
      )}
    </div>
  );
}
