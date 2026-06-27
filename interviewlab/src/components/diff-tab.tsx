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

// ponytail: file-local copy/export helpers (same two as synthesis-tab.tsx — a shared util
// module is deferred to the dedicated export layer in the roadmap).
async function copyMarkdown(md: string) {
  try {
    await navigator.clipboard.writeText(md);
    toast.success("Скопировано в буфер обмена");
  } catch (e) {
    toast.error(`Не удалось скопировать. ${String(e)}`);
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
  const lines: string[] = ["# Что изменилось vs предыдущей волны", ""];
  if (doc.summary) lines.push(doc.summary, "");
  if (doc.hypotheses?.length) {
    lines.push("## Гипотезы", "");
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
      lines.push("_Нет findings для сравнения._", "");
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
  { label: string; dot: string; text: string; border: string; Icon: typeof Plus }
> = {
  new: {
    label: "New",
    dot: "bg-status-ready",
    text: "text-status-ready",
    border: "border-status-ready/40",
    Icon: Plus,
  },
  changed: {
    label: "Changed",
    dot: "bg-status-importing",
    text: "text-status-importing",
    border: "border-status-importing/40",
    Icon: PencilLine,
  },
  dropped: {
    label: "Dropped",
    dot: "bg-status-error",
    text: "text-status-error",
    border: "border-status-error/40",
    Icon: Minus,
  },
  unchanged: {
    label: "Unchanged",
    dot: "bg-muted-foreground/60",
    text: "text-muted-foreground",
    border: "border-border",
    Icon: ArrowRightLeft,
  },
};

const STATUS_ORDER: DiffStatus[] = ["new", "changed", "dropped", "unchanged"];

// Hypothesis verdict shift → label + color. strengthened reads green (firmed up), weakened
// red (eroded), new green, dropped/unchanged neutral.
const SHIFT_META: Record<string, { label: string; dot: string; text: string; border: string }> = {
  strengthened: { label: "Strengthened", dot: "bg-status-ready", text: "text-status-ready", border: "border-status-ready/40" },
  weakened: { label: "Weakened", dot: "bg-status-error", text: "text-status-error", border: "border-status-error/40" },
  new: { label: "New", dot: "bg-status-ready", text: "text-status-ready", border: "border-status-ready/40" },
  dropped: { label: "Dropped", dot: "bg-muted-foreground/60", text: "text-muted-foreground", border: "border-border" },
  unchanged: { label: "Unchanged", dot: "bg-muted-foreground/60", text: "text-muted-foreground", border: "border-border" },
};

function VerdictLabel({ v }: { v?: string | null }) {
  if (!v) return <span className="text-muted-foreground/50">—</span>;
  const map: Record<string, string> = {
    confirmed: "Confirmed",
    partially: "Partially",
    refuted: "Refuted",
    inconclusive: "Inconclusive",
  };
  return <span className="text-foreground/80">{map[v] ?? v}</span>;
}

// The hypotheses-diff section: how each hypothesis's verdict moved wave-over-wave.
function HypothesesDiffSection({ entries }: { entries: HypothesisDiffEntry[] }) {
  return (
    <section className="flex flex-col gap-3">
      <h3 className="text-sm font-medium text-foreground">Hypotheses</h3>
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
                  {m.label}
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
  const m = STATUS_META[status];
  return (
    <Badge variant="outline" className={cn("gap-1.5", m.border, m.text)}>
      <span className={cn("size-1.5 rounded-full", m.dot)} aria-hidden="true" />
      {m.label}
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
          No findings to compare for this goal.
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
            {counts[s]} {m.label.toLowerCase()}
          </span>
        );
      })}
    </div>
  );
}

export function DiffTab({ cycleId }: { cycleId: string }) {
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
          toast.error(`Diff failed: ${p.error ?? "unknown"}`);
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
      toast.success(
        `Diff complete — ${total} change${total === 1 ? "" : "s"} across ${
          row.doc.by_goal.length
        } goal${row.doc.by_goal.length === 1 ? "" : "s"}.`,
      );
    } catch (e) {
      setProgress(null);
      toast.error(`Couldn't diff. ${String(e)}`);
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
            What changed vs the previous wave
          </h2>
          <p className="text-xs text-muted-foreground">
            {hasDiff
              ? `Last compared ${absoluteDate(diff!.created_at)}${
                  status?.prev_cycle_name ? ` · vs ${status.prev_cycle_name}` : ""
                }.`
              : status?.prev_cycle_name
                ? `A findings-level diff against ${status.prev_cycle_name}, grouped by goal.`
                : "A findings-level diff of your conclusions, grouped by goal."}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {hasDiff && (
            <>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => copyMarkdown(renderDiffMarkdown(diff!.doc))}
                title="Скопировать как Markdown"
              >
                <Copy className="size-3.5" />
                Копировать .md
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() =>
                  exportMarkdown(renderDiffMarkdown(diff!.doc), "diff.md")
                }
                title="Скачать как .md"
              >
                <Download className="size-3.5" />
                Экспорт
              </Button>
            </>
          )}
          {canRun && (
            <Button size="sm" onClick={handleRun} disabled={running}>
              {running ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  Comparing…
                </>
              ) : (
                <>
                  <GitCompareArrows className="size-4" />
                  {hasDiff ? "Re-run diff" : "Run diff"}
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
  if (running) {
    return (
      <div className="flex max-w-md flex-col items-start gap-2 rounded-lg border border-dashed border-border px-6 py-10">
        <Loader2 className="size-4 animate-spin text-muted-foreground" />
        <p className="text-sm text-muted-foreground">
          Aligning findings by goal and classifying what changed…
        </p>
      </div>
    );
  }
  return (
    <div className="flex max-w-md flex-col items-start gap-3 rounded-lg border border-dashed border-border px-6 py-8">
      <div className="flex flex-col gap-1">
        <p className="text-sm font-medium text-foreground">No diff yet</p>
        <p className="text-xs text-muted-foreground">
          Run the diff to align this wave's findings with
          {prevName ? ` ${prevName}` : " the previous wave"} by goal and see what's
          new, changed, dropped, or unchanged — each with a short why.
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
  const copy: Record<
    Exclude<DiffReadiness, "ready">,
    { title: string; body: string }
  > = {
    "no-prev-cycle": {
      title: "No previous wave to compare",
      body: "Set a previous wave in the Overview tab to diff this cycle's findings against the prior one.",
    },
    "no-current-synthesis": {
      title: "This cycle has no synthesis yet",
      body: "Run synthesis on this cycle first (Synthesis tab), then come back to compare it against the previous wave.",
    },
    "no-prev-synthesis": {
      title: prevName
        ? `${prevName} has no synthesis yet`
        : "The previous wave has no synthesis yet",
      body: "The diff compares two syntheses. Open the previous wave and run its synthesis first, then return here.",
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
