import { useEffect, useState } from "react";
import { Check, Loader2, Sparkles, Wand2 } from "lucide-react";
import { toast } from "sonner";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { glossaryKeys } from "@/lib/glossary-queries";
import {
  addGlossaryTerms,
  suggestGlossaryTerms,
  suggestGlossaryTermsFromEdits,
  type InterviewRow,
  type SuggestResult,
  type SuggestedTerm,
} from "@/lib/tauri";
import { useT } from "@/lib/i18n";

const STR = {
  ru: {
    couldntSuggest: (e: string) => `Не удалось подобрать термины. ${e}`,
    addedToast: (n: number, name: string) => `Добавлено ${n} ${plRu(n)} в ${name}`,
    glossaryFallback: "глоссарий",
    couldntSave: (e: string) => `Не удалось сохранить термины. ${e}`,
    title: "Подобрать термины глоссария",
    descBefore: "Найдите англицизмы, технические термины и названия продуктов в ",
    descThisInterview: "этом интервью",
    descAfter:
      " и добавьте их в глоссарий продукта, чтобы транскрипция и вычитка обрабатывали их правильно.",
    fromTranscript: "Из транскрипта",
    fromMyEdits: "Из моих правок",
    needsCleaned: "нужен вычитанный/отредактированный транскрипт",
    noProduct:
      "Цикл этого интервью не привязан к продукту, поэтому сохранять термины некуда. Сначала привяжите продукт к циклу (Обзор → Продукт).",
    noNewTerms: "Новых терминов не найдено — глоссарий уже покрывает то, что здесь есть.",
    adding: "Добавление…",
    addN: (n: number) => `Добавить ${n} ${plRu(n)}`,
  },
  en: {
    couldntSuggest: (e: string) => `Couldn't suggest terms. ${e}`,
    addedToast: (n: number, name: string) =>
      `Added ${n} term${n === 1 ? "" : "s"} to ${name}`,
    glossaryFallback: "the glossary",
    couldntSave: (e: string) => `Couldn't save the terms. ${e}`,
    title: "Suggest glossary terms",
    descBefore: "Mine anglicisms, technical terms, and product names from ",
    descThisInterview: "this interview",
    descAfter:
      " and add them to the product glossary so transcription and cleanup get them right.",
    fromTranscript: "From the transcript",
    fromMyEdits: "From my edits",
    needsCleaned: "needs a cleaned/edited transcript",
    noProduct:
      "This interview's cycle isn't linked to a product, so there's no glossary to save to. Link a product to the cycle first (Overview → Product).",
    noNewTerms: "No new terms found — the glossary already covers what's here.",
    adding: "Adding…",
    addN: (n: number) => `Add ${n} term${n === 1 ? "" : "s"}`,
  },
};

// Russian plural for "термин".
function plRu(n: number): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return "термин";
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return "термина";
  return "терминов";
}

type Mode = "transcript" | "edits";

// A dialog that mines glossary candidates from an interview (B: from the transcript; C: from the
// user's raw→edited corrections), lets the user review/toggle them, and saves the accepted ones
// to the cycle's product glossary. docs/transcription-terminology.md.
export function GlossarySuggestDialog({
  interview,
  onOpenChange,
}: {
  interview: InterviewRow | null;
  onOpenChange: (open: boolean) => void;
}) {
  const qc = useQueryClient();
  const t = useT(STR);
  const open = interview != null;
  // C (from edits) only makes sense once there are corrections to learn from.
  const canFromEdits =
    interview?.status === "edited" || interview?.status === "cleaned";

  const [running, setRunning] = useState<Mode | null>(null);
  const [result, setResult] = useState<SuggestResult | null>(null);
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [saving, setSaving] = useState(false);

  // Reset everything whenever the dialog opens for a (new) interview.
  useEffect(() => {
    if (open) {
      setRunning(null);
      setResult(null);
      setSelected({});
      setSaving(false);
    }
  }, [open, interview?.id]);

  async function run(mode: Mode) {
    if (!interview) return;
    setRunning(mode);
    setResult(null);
    try {
      const res =
        mode === "edits"
          ? await suggestGlossaryTermsFromEdits(interview.id)
          : await suggestGlossaryTerms(interview.id);
      setResult(res);
      // Preselect every candidate — accepting all is the common case.
      const sel: Record<string, boolean> = {};
      res.terms.forEach((t) => (sel[t.canonical] = true));
      setSelected(sel);
    } catch (e) {
      toast.error(t.couldntSuggest(String(e)));
    } finally {
      setRunning(null);
    }
  }

  async function accept() {
    if (!result?.product_id) return;
    const chosen = (result.terms ?? []).filter((t) => selected[t.canonical]);
    if (chosen.length === 0) return;
    setSaving(true);
    try {
      const added = await addGlossaryTerms(
        result.product_id,
        chosen.map((t) => ({ canonical: t.canonical, aliases: t.aliases, notes: t.notes })),
      );
      qc.invalidateQueries({ queryKey: glossaryKeys.byProduct(result.product_id) });
      toast.success(
        t.addedToast(added.length, result.product_name ?? t.glossaryFallback),
      );
      onOpenChange(false);
    } catch (e) {
      toast.error(t.couldntSave(String(e)));
    } finally {
      setSaving(false);
    }
  }

  const chosenCount = result ? result.terms.filter((t) => selected[t.canonical]).length : 0;
  const noProduct = result != null && result.product_id == null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t.title}</DialogTitle>
          <DialogDescription>
            {t.descBefore}
            {interview ? `"${interview.title}"` : t.descThisInterview}
            {t.descAfter}
          </DialogDescription>
        </DialogHeader>

        {/* Mode picker — shown until a run returns. */}
        {!result && (
          <div className="flex flex-col gap-2">
            <Button
              variant="outline"
              onClick={() => run("transcript")}
              disabled={running != null}
              className="justify-start"
            >
              {running === "transcript" ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Sparkles className="size-4" />
              )}
              {t.fromTranscript}
            </Button>
            <Button
              variant="outline"
              onClick={() => run("edits")}
              disabled={running != null || !canFromEdits}
              className="justify-start"
            >
              {running === "edits" ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Wand2 className="size-4" />
              )}
              {t.fromMyEdits}
              {!canFromEdits && (
                <span className="ml-auto text-xs text-muted-foreground">{t.needsCleaned}</span>
              )}
            </Button>
          </div>
        )}

        {/* Results — a togglable checklist. */}
        {result && (
          <div className="flex max-h-80 flex-col gap-1 overflow-y-auto">
            {noProduct ? (
              <p className="px-1 py-4 text-sm text-muted-foreground">{t.noProduct}</p>
            ) : result.terms.length === 0 ? (
              <p className="px-1 py-4 text-sm text-muted-foreground">{t.noNewTerms}</p>
            ) : (
              result.terms.map((t: SuggestedTerm) => {
                const on = !!selected[t.canonical];
                return (
                  <button
                    key={t.canonical}
                    type="button"
                    onClick={() => setSelected((s) => ({ ...s, [t.canonical]: !on }))}
                    className={cn(
                      "flex items-start gap-2.5 rounded-md border px-2.5 py-2 text-left transition-colors",
                      on ? "border-primary/40 bg-primary/5" : "border-border hover:bg-secondary/40",
                    )}
                  >
                    <span
                      className={cn(
                        "mt-0.5 flex size-4 shrink-0 items-center justify-center rounded border",
                        on ? "border-primary bg-primary text-primary-foreground" : "border-border",
                      )}
                    >
                      {on && <Check className="size-3" />}
                    </span>
                    <span className="flex min-w-0 flex-1 flex-col gap-1">
                      <span className="flex flex-wrap items-center gap-1.5">
                        <span className="text-sm font-medium text-foreground">{t.canonical}</span>
                        {t.aliases.map((a) => (
                          <Badge key={a} variant="secondary" className="font-normal">
                            {a}
                          </Badge>
                        ))}
                      </span>
                      {t.reason && (
                        <span className="text-xs text-muted-foreground">{t.reason}</span>
                      )}
                    </span>
                  </button>
                );
              })
            )}
          </div>
        )}

        <DialogFooter>
          {result && !noProduct && result.terms.length > 0 && (
            <Button onClick={accept} disabled={chosenCount === 0 || saving}>
              {saving ? t.adding : t.addN(chosenCount)}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
