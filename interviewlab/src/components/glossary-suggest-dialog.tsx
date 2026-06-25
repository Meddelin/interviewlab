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
      toast.error(`Couldn't suggest terms. ${String(e)}`);
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
        `Added ${added.length} term${added.length === 1 ? "" : "s"} to ${result.product_name ?? "the glossary"}`,
      );
      onOpenChange(false);
    } catch (e) {
      toast.error(`Couldn't save the terms. ${String(e)}`);
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
          <DialogTitle>Suggest glossary terms</DialogTitle>
          <DialogDescription>
            Mine anglicisms, technical terms, and product names from
            {interview ? ` "${interview.title}"` : " this interview"} and add them to the product
            glossary so transcription and cleanup get them right.
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
              From the transcript
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
              From my edits
              {!canFromEdits && (
                <span className="ml-auto text-xs text-muted-foreground">needs a cleaned/edited transcript</span>
              )}
            </Button>
          </div>
        )}

        {/* Results — a togglable checklist. */}
        {result && (
          <div className="flex max-h-80 flex-col gap-1 overflow-y-auto">
            {noProduct ? (
              <p className="px-1 py-4 text-sm text-muted-foreground">
                This interview's cycle isn't linked to a product, so there's no glossary to save to.
                Link a product to the cycle first (Overview → Product).
              </p>
            ) : result.terms.length === 0 ? (
              <p className="px-1 py-4 text-sm text-muted-foreground">
                No new terms found — the glossary already covers what's here.
              </p>
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
              {saving ? "Adding…" : `Add ${chosenCount} term${chosenCount === 1 ? "" : "s"}`}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
