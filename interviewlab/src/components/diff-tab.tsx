import { useEffect, useMemo, useState } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { useQueryClient } from "@tanstack/react-query";
import {
  ArrowRightLeft,
  Copy,
  Download,
  GitCompareArrows,
  Loader2,
  Minus,
  PencilLine,
  Plus,
  Target,
} from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { diffKeys, useDiff, useDiffStatus, useRunDiff } from "@/lib/diff-queries";
import {
  DIFF_PROGRESS_EVENT,
  IN_TAURI,
  type DiffDoc,
  type DiffEntry,
  type DiffGoalRef,
  type DiffProgress,
  type DiffReadiness,
  type DiffRow,
  type DiffStatus,
  type HypothesisDiffEntry,
} from "@/lib/tauri";
// dev-mock: browser-only, never active under Tauri.
import { mockOnDiffProgress } from "@/lib/dev-mock";
import { absoluteDate } from "@/lib/format";
import { cn } from "@/lib/utils";
import { tr, useT } from "@/lib/i18n";

const STR = {
  ru: {
    copied: "Скопировано в буфер обмена",
    copyFailed: (e: string) => `Не удалось скопировать. ${e}`,
    mdTitle: "Что изменилось vs предыдущей волны",
    mdHypotheses: "Гипотезы",
    mdNoFindings: "_Нет findings для сравнения._",
    statusNew: "Новое",
    statusChanged: "Изменено",
    statusDropped: "Убрано",
    statusUnchanged: "Без изменений",
    shiftStrengthened: "Усилилась",
    shiftWeakened: "Ослабла",
    shiftNew: "Новая",
    shiftDropped: "Убрана",
    shiftUnchanged: "Без изменений",
    verdictConfirmed: "Подтверждена",
    verdictPartially: "Частично",
    verdictRefuted: "Опровергнута",
    verdictInconclusive: "Неоднозначно",
    hypotheses: "Гипотезы",
    diffFailed: (e: string) => `Не удалось построить дифф: ${e}`,
    diffComplete: (changes: number, goals: number) =>
      `Дифф готов — ${changes} ${plural(changes, "изменение", "изменения", "изменений")} по ${goals} ${plural(goals, "задаче", "задачам", "задачам")}.`,
    diffCatch: (e: string) => `Не удалось построить дифф. ${e}`,
    headerTitle: "Что изменилось vs предыдущей волны",
    lastCompared: (date: string, prev: string | null) =>
      `Последнее сравнение ${date}${prev ? ` · с ${prev}` : ""}.`,
    diffVsPrev: (prev: string) =>
      `Дифф выводов на уровне findings против ${prev}, сгруппированный по задачам.`,
    diffGeneric: "Дифф ваших выводов на уровне findings, сгруппированный по задачам.",
    copyMd: "Копировать .md",
    copyMdTitle: "Скопировать как Markdown",
    exportLabel: "Экспорт",
    exportTitle: "Скачать как .md",
    comparing: "Сравниваем…",
    rerunDiff: "Пересчитать дифф",
    runDiff: "Построить дифф",
    noFindingsForGoal: "Нет findings для сравнения по этой задаче.",
    aligning: "Сопоставляем findings по задачам и классифицируем изменения…",
    noDiffYet: "Диффа ещё нет",
    runDiffPrompt: (prev: string | null) =>
      `Постройте дифф, чтобы сопоставить findings этой волны с ${prev ?? "предыдущей волной"} по задачам и увидеть, что нового, изменилось, убрано или осталось без изменений — каждое с кратким пояснением.`,
    preNoPrevTitle: "Нет предыдущей волны для сравнения",
    preNoPrevBody:
      "Задайте предыдущую волну во вкладке «Обзор», чтобы сравнить findings этого цикла с предыдущим.",
    preNoCurrentTitle: "У этого цикла ещё нет синтеза",
    preNoCurrentBody:
      "Сначала запустите синтез по этому циклу (вкладка «Синтез»), затем вернитесь, чтобы сравнить его с предыдущей волной.",
    preNoPrevSynthTitle: (prev: string | null) =>
      prev ? `У волны «${prev}» ещё нет синтеза` : "У предыдущей волны ещё нет синтеза",
    preNoPrevSynthBody:
      "Дифф сравнивает два синтеза. Откройте предыдущую волну и запустите её синтез, затем вернитесь сюда.",
  },
  en: {
    copied: "Copied to clipboard",
    copyFailed: (e: string) => `Couldn't copy. ${e}`,
    mdTitle: "What changed vs the previous wave",
    mdHypotheses: "Hypotheses",
    mdNoFindings: "_No findings to compare._",
    statusNew: "New",
    statusChanged: "Changed",
    statusDropped: "Dropped",
    statusUnchanged: "Unchanged",
    shiftStrengthened: "Strengthened",
    shiftWeakened: "Weakened",
    shiftNew: "New",
    shiftDropped: "Dropped",
    shiftUnchanged: "Unchanged",
    verdictConfirmed: "Confirmed",
    verdictPartially: "Partially",
    verdictRefuted: "Refuted",
    verdictInconclusive: "Inconclusive",
    hypotheses: "Hypotheses",
    diffFailed: (e: string) => `Diff failed: ${e}`,
    diffComplete: (changes: number, goals: number) =>
      `Diff complete — ${changes} change${changes === 1 ? "" : "s"} across ${goals} goal${goals === 1 ? "" : "s"}.`,
    diffCatch: (e: string) => `Couldn't diff. ${e}`,
    headerTitle: "What changed vs the previous wave",
    lastCompared: (date: string, prev: string | null) =>
      `Last compared ${date}${prev ? ` · vs ${prev}` : ""}.`,
    diffVsPrev: (prev: string) =>
      `A findings-level diff against ${prev}, grouped by goal.`,
    diffGeneric: "A findings-level diff of your conclusions, grouped by goal.",
    copyMd: "Copy .md",
    copyMdTitle: "Copy as Markdown",
    exportLabel: "Export",
    exportTitle: "Download as .md",
    comparing: "Comparing…",
    rerunDiff: "Re-run diff",
    runDiff: "Run diff",
    noFindingsForGoal: "No findings to compare for this goal.",
    aligning: "Aligning findings by goal and classifying what changed…",
    noDiffYet: "No diff yet",
    runDiffPrompt: (prev: string | null) =>
      `Run the diff to align this wave's findings with ${prev ?? "the previous wave"} by goal and see what's new, changed, dropped, or unchanged — each with a short why.`,
    preNoPrevTitle: "No previous wave to compare",
    preNoPrevBody:
      "Set a previous wave in the Overview tab to diff this cycle's findings against the prior one.",
    preNoCurrentTitle: "This cycle has no synthesis yet",
    preNoCurrentBody:
      "Run synthesis on this cycle first (Synthesis tab), then come back to compare it against the previous wave.",
    preNoPrevSynthTitle: (prev: string | null) =>
      prev ? `${prev} has no synthesis yet` : "The previous wave has no synthesis yet",
    preNoPrevSynthBody:
      "The diff compares two syntheses. Open the previous wave and run its synthesis first, then return here.",
  },
};

// Russian plural helper (1 / 2-4 / 5+), used in diff-complete toast.
function plural(n: number, one: string, few: string, many: string): string {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

// ponytail: file-local copy/export helpers (same two as synthesis-tab.tsx — a shared util
// module is deferred to the dedicated export layer in the roadmap).
async function copyMarkdown(md: string) {
  try {
    await navigator.clipboard.writeText(md);
    toast.success(tr(STR).copied);
  } catch (e) {
    toast.error(tr(STR).copyFailed(String(e)));
  }
}

function exportMarkdown(md: string, filename: string) {
  const blob = new Blob([md], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// Diff has no stored content_md (only the structured doc), so render a plain-markdown
// projection of the doc for copy/export. Mirrors the on-screen structure.
function renderDiffMarkdown(doc: DiffDoc): string {
  const s = tr(STR);
  const lines: string[] = [`# ${s.mdTitle}`, ""];
  if (doc.summary) lines.push(doc.summary, "");
  if (doc.hypotheses?.length) {
    lines.push(`## ${s.mdHypotheses}`, "");
    for (const h of doc.hypotheses) {
      lines.push(
        `- **${h.hypothesis_id}** ${h.text} — ${h.shift}` +
          (h.prev_verdict || h.verdict
            ? ` (${h.prev_verdict ?? "—"} → ${h.verdict ?? "—"})`
            : ""),
      );
      if (h.why) lines.push(`  - ${h.why}`);
    }
    lines.push("");
  }
  for (const goal of doc.goals) {
    const group = doc.by_goal.find((g) => g.goal_id === goal.id);
    lines.push(`## ${goal.id} ${goal.text}`, "");
    const entries = group?.entries ?? [];
    if (entries.length === 0) {
      lines.push(s.mdNoFindings, "");
      continue;
    }
    for (const e of entries) {
      lines.push(`- [${e.status}] ${e.statement}`);
      if (e.why) lines.push(`  - ${e.why}`);
    }
    lines.push("");
  }
  return lines.join("\n").trimEnd() + "\n";
}

// status → label + the status-color vocabulary (index.css). Reuses the same family the
// rest of the app uses: new=ready/green (fresh conclusion), changed=importing/amber
// (shifted), dropped=error/red (gone), unchanged=neutral (stable).
const STATUS_META: Record<
  DiffStatus,
  { dot: string; text: string; border: string; Icon: typeof Plus }
> = {
  new: {
    dot: "bg-status-ready",
    text: "text-status-ready",
    border: "border-status-ready/40",
    Icon: Plus,
  },
  changed: {
    dot: "bg-status-importing",
    text: "text-status-importing",
    border: "border-status-importing/40",
    Icon: PencilLine,
  },
  dropped: {
    dot: "bg-status-error",
    text: "text-status-error",
    border: "border-status-error/40",
    Icon: Minus,
  },
  unchanged: {
    dot: "bg-muted-foreground/60",
    text: "text-muted-foreground",
    border: "border-border",
    Icon: ArrowRightLeft,
  },
};

const STATUS_ORDER: DiffStatus[] = ["new", "changed", "dropped", "unchanged"];

// Hypothesis verdict shift → label + color. strengthened reads green (firmed up), weakened
// red (eroded), new green, dropped/unchanged neutral.
const SHIFT_META: Record<string, { dot: string; text: string; border: string }> = {
  strengthened: { dot: "bg-status-ready", text: "text-status-ready", border: "border-status-ready/40" },
  weakened: { dot: "bg-status-error", text: "text-status-error", border: "border-status-error/40" },
  new: { dot: "bg-status-ready", text: "text-status-ready", border: "border-status-ready/40" },
  dropped: { dot: "bg-muted-foreground/60", text: "text-muted-foreground", border: "border-border" },
  unchanged: { dot: "bg-muted-foreground/60", text: "text-muted-foreground", border: "border-border" },
};

// status / shift / verdict → localized labels, resolved at render time from the STR table.
function statusLabel(t: (typeof STR)["ru"], s: DiffStatus): string {
  return {
    new: t.statusNew,
    changed: t.statusChanged,
    dropped: t.statusDropped,
    unchanged: t.statusUnchanged,
  }[s];
}
function shiftLabel(t: (typeof STR)["ru"], s: string): string {
  const map: Record<string, string> = {
    strengthened: t.shiftStrengthened,
    weakened: t.shiftWeakened,
    new: t.shiftNew,
    dropped: t.shiftDropped,
    unchanged: t.shiftUnchanged,
  };
  return map[s] ?? t.shiftUnchanged;
}

function VerdictLabel({ v }: { v?: string | null }) {
  const t = useT(STR);
  if (!v) return <span className="text-muted-foreground/50">—</span>;
  const map: Record<string, string> = {
    confirmed: t.verdictConfirmed,
    partially: t.verdictPartially,
    refuted: t.verdictRefuted,
    inconclusive: t.verdictInconclusive,
  };
  return <span className="text-foreground/80">{map[v] ?? v}</span>;
}

// The hypotheses-diff section: how each hypothesis's verdict moved wave-over-wave.
function HypothesesDiffSection({ entries }: { entries: HypothesisDiffEntry[] }) {
  const t = useT(STR);
  return (
    <section className="flex flex-col gap-3">
      <h3 className="text-sm font-medium text-foreground">{t.hypotheses}</h3>
      <div className="flex flex-col gap-3">
        {entries.map((h) => {
          const m = SHIFT_META[h.shift] ?? SHIFT_META.unchanged;
          return (
            <div key={h.hypothesis_id} className="flex flex-col gap-1.5 border-l border-border pl-3">
              <div className="flex items-start justify-between gap-3">
                <p className="text-sm leading-snug text-foreground/90">
                  <span className="mr-1.5 font-numeric text-[11px] text-muted-foreground/70">
                    {h.hypothesis_id}
                  </span>
                  {h.text}
                </p>
                <Badge variant="outline" className={cn("shrink-0 gap-1.5", m.border, m.text)}>
                  <span className={cn("size-1.5 rounded-full", m.dot)} aria-hidden="true" />
                  {shiftLabel(t, h.shift)}
                </Badge>
              </div>
              <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <VerdictLabel v={h.prev_verdict} />
                <ArrowRightLeft className="size-3 text-muted-foreground/50" aria-hidden="true" />
                <VerdictLabel v={h.verdict} />
              </p>
              {h.why && (
                <p className="text-xs leading-relaxed text-muted-foreground">{h.why}</p>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}

// A compact status badge — colored dot + label, matching the synthesis-tab badge feel.
function StatusBadge({ status }: { status: DiffStatus }) {
  const t = useT(STR);
  const m = STATUS_META[status];
  return (
    <Badge variant="outline" className={cn("gap-1.5", m.border, m.text)}>
      <span className={cn("size-1.5 rounded-full", m.dot)} aria-hidden="true" />
      {statusLabel(t, status)}
    </Badge>
  );
}

// One diff entry row: status badge + statement + the `why` rationale beneath.
function DiffEntryRow({ entry }: { entry: DiffEntry }) {
  return (
    <div className="flex flex-col gap-1.5 border-l border-border pl-3">
      <div className="flex items-start justify-between gap-3">
        <p className="text-sm leading-snug text-foreground/90">
          {entry.statement}
        </p>
        <div className="shrink-0">
          <StatusBadge status={entry.status} />
        </div>
      </div>
      {entry.why && (
        <p className="text-xs leading-relaxed text-muted-foreground">
          {entry.why}
        </p>
      )}
    </div>
  );
}

// One goal section: the goal heading, then its diff entries ordered by status
// (new → changed → dropped → unchanged) so the meaningful changes read first.
function GoalDiffSection({
  goal,
  entries,
}: {
  goal: DiffGoalRef;
  entries: DiffEntry[];
}) {
  const t = useT(STR);
  const ordered = useMemo(
    () =>
      [...entries].sort(
        (a, b) =>
          STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status),
      ),
    [entries],
  );
  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-baseline gap-2.5">
        <span className="flex items-center gap-1.5 font-numeric text-xs font-medium text-primary">
          <Target className="size-3.5" aria-hidden="true" />
          {goal.id}
        </span>
        <h3 className="text-sm font-medium text-foreground">{goal.text}</h3>
      </div>
      {ordered.length === 0 ? (
        <p className="pl-6 text-xs text-muted-foreground">
          {t.noFindingsForGoal}
        </p>
      ) : (
        // Wide: lay diff entries out as a multi-column grid (one column on narrow).
        <div className="grid grid-cols-1 gap-3 pl-6 xl:grid-cols-2 2xl:grid-cols-3">
          {ordered.map((e, i) => (
            <DiffEntryRow
              key={`${e.status}-${e.finding_id ?? ""}-${e.prev_finding_id ?? ""}-${i}`}
              entry={e}
            />
          ))}
        </div>
      )}
    </section>
  );
}

// A small count chip per status for the at-a-glance header (e.g. "2 new · 1 changed").
function StatusTally({ entries }: { entries: DiffEntry[] }) {
  const t = useT(STR);
  const counts = useMemo(() => {
    const c: Record<DiffStatus, number> = {
      new: 0,
      changed: 0,
      dropped: 0,
      unchanged: 0,
    };
    for (const e of entries) c[e.status] += 1;
    return c;
  }, [entries]);

  const shown = STATUS_ORDER.filter((s) => counts[s] > 0);
  if (shown.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
      {shown.map((s) => {
        const m = STATUS_META[s];
        return (
          <span
            key={s}
            className={cn("inline-flex items-center gap-1.5 text-xs", m.text)}
          >
            <span
              className={cn("size-1.5 rounded-full", m.dot)}
              aria-hidden="true"
            />
            {counts[s]} {statusLabel(t, s).toLowerCase()}
          </span>
        );
      })}
    </div>
  );
}

export function DiffTab({ cycleId }: { cycleId: string }) {
  const t = useT(STR);
  const qc = useQueryClient();
  const { data: diff, isPending } = useDiff(cycleId);
  const { data: status, isPending: statusPending } = useDiffStatus(cycleId);
  const runDiff = useRunDiff(cycleId);

  // Live progress (null when idle).
  const [progress, setProgress] = useState<DiffProgress | null>(null);

  // Subscribe to diff progress; clear on a terminal stage + refresh the diff + status.
  useEffect(() => {
    function onProgress(p: DiffProgress) {
      if (p.cycle_id !== cycleId) return;
      if (p.stage === "done" || p.stage === "error") {
        setProgress(null);
        qc.invalidateQueries({ queryKey: diffKeys.detail(cycleId) });
        qc.invalidateQueries({ queryKey: diffKeys.status(cycleId) });
        if (p.stage === "error") {
          toast.error(tr(STR).diffFailed(p.error ?? "unknown"));
        }
      } else {
        setProgress(p);
      }
    }

    if (!IN_TAURI) {
      return mockOnDiffProgress(onProgress);
    }
    const unlisten = getCurrentWebview().listen<DiffProgress>(
      DIFF_PROGRESS_EVENT,
      (e) => onProgress(e.payload),
    );
    return () => {
      unlisten.then((fn) => fn());
    };
  }, [cycleId, qc]);

  const running = runDiff.isPending || progress != null;

  async function handleRun() {
    setProgress({ cycle_id: cycleId, stage: "diffing", progress: 5, error: null });
    try {
      const row: DiffRow = await runDiff.mutateAsync();
      const total = row.doc.by_goal.reduce((n, g) => n + g.entries.length, 0);
      toast.success(tr(STR).diffComplete(total, row.doc.by_goal.length));
    } catch (e) {
      setProgress(null);
      toast.error(tr(STR).diffCatch(String(e)));
    }
  }

  if (isPending || statusPending) {
    return (
      <div className="flex flex-col gap-5 pt-2">
        <Skeleton className="h-9 w-44" />
        <Skeleton className="h-24 w-full max-w-2xl" />
        <Skeleton className="h-24 w-full max-w-2xl" />
      </div>
    );
  }

  const readiness: DiffReadiness = status?.readiness ?? "no-prev-cycle";
  const hasDiff = !!diff && diff.doc.by_goal.length > 0;
  const canRun = readiness === "ready";
  const allEntries = (diff?.doc.by_goal ?? []).flatMap((g) => g.entries);

  return (
    <div className="flex flex-col gap-6 pt-2">
      {/* Action bar: run / re-run + which wave we compare against. */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-col gap-0.5">
          <h2 className="text-sm font-medium text-foreground">
            {t.headerTitle}
          </h2>
          <p className="text-xs text-muted-foreground">
            {hasDiff
              ? t.lastCompared(absoluteDate(diff!.created_at), status?.prev_cycle_name ?? null)
              : status?.prev_cycle_name
                ? t.diffVsPrev(status.prev_cycle_name)
                : t.diffGeneric}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {hasDiff && (
            <>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => copyMarkdown(renderDiffMarkdown(diff!.doc))}
                title={t.copyMdTitle}
              >
                <Copy className="size-3.5" />
                {t.copyMd}
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() =>
                  exportMarkdown(renderDiffMarkdown(diff!.doc), "diff.md")
                }
                title={t.exportTitle}
              >
                <Download className="size-3.5" />
                {t.exportLabel}
              </Button>
            </>
          )}
          {canRun && (
            <Button size="sm" onClick={handleRun} disabled={running}>
              {running ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  {t.comparing}
                </>
              ) : (
                <>
                  <GitCompareArrows className="size-4" />
                  {hasDiff ? t.rerunDiff : t.runDiff}
                </>
              )}
            </Button>
          )}
        </div>
      </div>

      {/* Live progress line during a run. */}
      {running && (
        <div className="h-1 w-full overflow-hidden rounded-full bg-secondary/60">
          <div
            className="h-full rounded-full bg-primary transition-all duration-500"
            style={{ width: `${progress?.progress ?? 5}%` }}
          />
        </div>
      )}

      {/* Body: a precondition empty state, or the per-goal diff. */}
      {!canRun ? (
        <PreconditionState
          readiness={readiness}
          prevName={status?.prev_cycle_name ?? null}
        />
      ) : hasDiff ? (
        <div className="mx-auto flex w-full max-w-2xl flex-col gap-7 xl:max-w-6xl">
          {/* One-line summary + a status tally of the whole wave. */}
          <div className="flex flex-col gap-3 rounded-lg border border-border bg-secondary/30 px-4 py-3">
            {diff!.doc.summary && (
              <p className="text-sm leading-relaxed text-foreground/90">
                {diff!.doc.summary}
              </p>
            )}
            <StatusTally entries={allEntries} />
          </div>

          {(diff!.doc.hypotheses?.length ?? 0) > 0 && (
            <HypothesesDiffSection entries={diff!.doc.hypotheses!} />
          )}

          {diff!.doc.goals.map((goal) => {
            const group = diff!.doc.by_goal.find((g) => g.goal_id === goal.id);
            return (
              <GoalDiffSection
                key={goal.id}
                goal={goal}
                entries={group?.entries ?? []}
              />
            );
          })}
        </div>
      ) : (
        <ReadyEmptyState running={running} prevName={status?.prev_cycle_name ?? null} />
      )}
    </div>
  );
}

// Ready-but-not-yet-run: prompt to run the diff, naming the wave we compare against.
function ReadyEmptyState({
  running,
  prevName,
}: {
  running: boolean;
  prevName: string | null;
}) {
  const t = useT(STR);
  if (running) {
    return (
      <div className="flex max-w-md flex-col items-start gap-2 rounded-lg border border-dashed border-border px-6 py-10">
        <Loader2 className="size-4 animate-spin text-muted-foreground" />
        <p className="text-sm text-muted-foreground">
          {t.aligning}
        </p>
      </div>
    );
  }
  return (
    <div className="flex max-w-md flex-col items-start gap-3 rounded-lg border border-dashed border-border px-6 py-8">
      <div className="flex flex-col gap-1">
        <p className="text-sm font-medium text-foreground">{t.noDiffYet}</p>
        <p className="text-xs text-muted-foreground">
          {t.runDiffPrompt(prevName)}
        </p>
      </div>
    </div>
  );
}

// The precondition empty states (spec §9 M9): no previous wave, or a missing synthesis on
// either side. Each explains the next step.
function PreconditionState({
  readiness,
  prevName,
}: {
  readiness: DiffReadiness;
  prevName: string | null;
}) {
  const t = useT(STR);
  const copy: Record<
    Exclude<DiffReadiness, "ready">,
    { title: string; body: string }
  > = {
    "no-prev-cycle": {
      title: t.preNoPrevTitle,
      body: t.preNoPrevBody,
    },
    "no-current-synthesis": {
      title: t.preNoCurrentTitle,
      body: t.preNoCurrentBody,
    },
    "no-prev-synthesis": {
      title: t.preNoPrevSynthTitle(prevName),
      body: t.preNoPrevSynthBody,
    },
  };
  const c = copy[readiness as Exclude<DiffReadiness, "ready">] ?? copy["no-prev-cycle"];
  return (
    <div className="flex max-w-md flex-col items-start gap-3 rounded-lg border border-dashed border-border px-6 py-10">
      <GitCompareArrows
        className="size-4 text-muted-foreground/70"
        aria-hidden="true"
      />
      <div className="flex flex-col gap-1">
        <p className="text-sm font-medium text-foreground">{c.title}</p>
        <p className="text-xs text-muted-foreground">{c.body}</p>
      </div>
    </div>
  );
}
