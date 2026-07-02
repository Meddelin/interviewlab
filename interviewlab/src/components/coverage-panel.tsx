// Guide-coverage panel (v3 F2 — "а всё ли мы спросили?"). A collapsible section rendered
// inside the interview Summary panel: run the LLM coverage check for one interview, then
// show the overall score, every guide goal/question as covered / partial / missed with
// evidence quotes, and the suggested follow-up questions. Re-runs overwrite (additive —
// no confirm needed). Progress streams via COVERAGE_PROGRESS_EVENT (also picked up by the
// global task center, so the local UI stays light: a thin bar + a running label).

import { useEffect, useMemo, useState } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ChevronRight,
  Copy,
  ListChecks,
  Loader2,
  RefreshCw,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import {
  getGuideCoverage,
  runGuideCoverage,
  COVERAGE_PROGRESS_EVENT,
  IN_TAURI,
  type CoverageDoc,
  type CoverageItem,
  type CoverageProgress,
  type CoverageRow,
  type CoverageStatus,
} from "@/lib/tauri";
// dev-mock: browser-only, never active under Tauri.
import { mockOnCoverageProgress } from "@/lib/dev-mock";
import { tr, useT } from "@/lib/i18n";

const STR = {
  ru: {
    title: "Покрытие гайда",
    emptyDesc:
      "Проверьте, все ли цели и вопросы гайда были раскрыты в этом интервью — со ссылками на цитаты и предложенными вопросами для добора.",
    check: "Проверить покрытие",
    rerun: "Проверить заново",
    checking: "Проверяем покрытие…",
    score: "Общий балл",
    goals: "Цели",
    sectionQualifying: "Квалифицирующие вопросы",
    sectionMain: "Основные вопросы",
    sectionHypothesis: "Вопросы по гипотезам",
    questions: "Вопросы",
    covered: "Раскрыто",
    partial: "Частично",
    missed: "Пропущено",
    followUps: "Предложенные вопросы",
    copyFollowUps: "Копировать вопросы",
    copied: "Скопировано в буфер обмена",
    copyFailed: (e: string) => `Не удалось скопировать. ${e}`,
    coverageReady: (score: number) => `Покрытие проверено — ${score}/100`,
    coverageFailed: (e: string) => `Не удалось проверить покрытие. ${e}`,
    coverageFailedEvent: (e: string) => `Проверка покрытия не удалась: ${e}`,
    checkedAt: (when: string) => `Проверено ${when}`,
    unknown: "неизвестно",
  },
  en: {
    title: "Guide coverage",
    emptyDesc:
      "Check whether every guide goal and question was actually covered in this interview — with evidence quotes and suggested follow-ups.",
    check: "Check coverage",
    rerun: "Re-check",
    checking: "Checking coverage…",
    score: "Overall score",
    goals: "Goals",
    sectionQualifying: "Qualifying questions",
    sectionMain: "Main questions",
    sectionHypothesis: "Hypothesis questions",
    questions: "Questions",
    covered: "Covered",
    partial: "Partial",
    missed: "Missed",
    followUps: "Suggested questions",
    copyFollowUps: "Copy questions",
    copied: "Copied to clipboard",
    copyFailed: (e: string) => `Couldn't copy. ${e}`,
    coverageReady: (score: number) => `Coverage checked — ${score}/100`,
    coverageFailed: (e: string) => `Couldn't check coverage. ${e}`,
    coverageFailedEvent: (e: string) => `Coverage check failed: ${e}`,
    checkedAt: (when: string) => `Checked ${when}`,
    unknown: "unknown",
  },
};

// Query key for the stored coverage row (kept file-local: the panel is the only reader).
export const coverageKeys = {
  detail: (interviewId: string) => ["guide-coverage", interviewId] as const,
};

// status → the muted semantic status-color vocabulary (index.css): covered=green,
// partial=amber, missed=red.
const STATUS_META: Record<CoverageStatus, { dot: string; text: string }> = {
  covered: { dot: "bg-status-ready", text: "text-status-ready" },
  partial: { dot: "bg-status-importing", text: "text-status-importing" },
  missed: { dot: "bg-status-error", text: "text-status-error" },
};

function statusLabel(t: (typeof STR)["ru"], s: CoverageStatus): string {
  return { covered: t.covered, partial: t.partial, missed: t.missed }[s];
}

// A small covered/partial/missed chip: dot + label, matching the app's status badges.
function StatusChip({ status }: { status: CoverageStatus }) {
  const t = useT(STR);
  const m = STATUS_META[status];
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 text-[11px]",
        m.text,
      )}
    >
      <span className={cn("size-1.5 rounded-full", m.dot)} aria-hidden="true" />
      {statusLabel(t, status)}
    </span>
  );
}

// One guide item row: status chip + text (+ note), then its evidence quotes. Coverage
// evidence carries only a segment index (no stable ids / timestamps yet — see the
// interview-summary QuoteList note), so quotes render with a "#N" segment ref chip.
function ItemRow({ item }: { item: CoverageItem }) {
  return (
    <li className="flex flex-col gap-1.5">
      <div className="flex items-start justify-between gap-3">
        <p className="text-sm leading-snug text-foreground/90">
          <span className="mr-1.5 font-numeric text-[11px] text-muted-foreground/70">
            {item.id}
          </span>
          {item.text}
        </p>
        <StatusChip status={item.status} />
      </div>
      {item.note && (
        <p className="text-xs leading-relaxed text-muted-foreground">
          {item.note}
        </p>
      )}
      {item.evidence.length > 0 && (
        <ul className="flex flex-col gap-1.5">
          {item.evidence.map((e, i) => (
            <li
              key={i}
              className="flex gap-2 border-l-2 border-border pl-2 text-xs leading-relaxed text-foreground/80"
            >
              <span className="mt-px shrink-0 font-numeric text-[10px] text-muted-foreground/70">
                #{e.segment_id}
              </span>
              <span className="italic">“{e.quote}”</span>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

// One group of guide items under a quiet uppercase label (goals, then each question section).
function ItemGroup({ label, items }: { label: string; items: CoverageItem[] }) {
  if (items.length === 0) return null;
  return (
    <div className="flex flex-col gap-2.5">
      <h4 className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground/70">
        {label}
      </h4>
      <ul className="flex flex-col gap-3">
        {items.map((it) => (
          <ItemRow key={it.id} item={it} />
        ))}
      </ul>
    </div>
  );
}

// The result view: overall score (big tabular number + thin accent bar), items grouped by
// goals / question sections, then the suggested follow-up questions with a copy action.
function CoverageResult({ doc }: { doc: CoverageDoc }) {
  const t = useT(STR);

  const groups = useMemo(() => {
    const goals = doc.items.filter((i) => i.kind === "goal");
    const bySection = (s: string) =>
      doc.items.filter((i) => i.kind === "question" && (i.section ?? "") === s);
    const other = doc.items.filter(
      (i) =>
        i.kind === "question" &&
        !["qualifying", "main", "hypothesis"].includes(i.section ?? ""),
    );
    return [
      { label: t.goals, items: goals },
      { label: t.sectionQualifying, items: bySection("qualifying") },
      { label: t.sectionMain, items: bySection("main") },
      { label: t.sectionHypothesis, items: bySection("hypothesis") },
      { label: t.questions, items: other },
    ];
  }, [doc.items, t]);

  const score = Math.max(0, Math.min(100, Math.round(doc.score)));

  async function copyFollowUps() {
    const text = doc.follow_ups.map((f) => `- ${f.question}`).join("\n");
    try {
      await navigator.clipboard.writeText(text);
      toast.success(tr(STR).copied);
    } catch (e) {
      toast.error(tr(STR).copyFailed(String(e)));
    }
  }

  return (
    <div className="flex flex-col gap-5">
      {/* Overall score: big tabular number + a thin accent bar. */}
      <div className="flex flex-col gap-1.5">
        <div className="flex items-baseline gap-1.5">
          <span className="font-numeric text-2xl font-semibold tracking-tight text-foreground">
            {score}
          </span>
          <span className="font-numeric text-xs text-muted-foreground">
            /100
          </span>
          <span className="ml-2 text-[11px] uppercase tracking-wide text-muted-foreground/70">
            {t.score}
          </span>
        </div>
        <div className="h-1 w-full max-w-xs overflow-hidden rounded-full bg-secondary/60">
          <div
            className="h-full rounded-full bg-primary"
            style={{ width: `${score}%` }}
          />
        </div>
        {doc.summary && (
          <p className="text-xs leading-relaxed text-muted-foreground">
            {doc.summary}
          </p>
        )}
      </div>

      {groups.map((g) => (
        <ItemGroup key={g.label} label={g.label} items={g.items} />
      ))}

      {/* Suggested follow-up questions for the missed/partial items. */}
      {doc.follow_ups.length > 0 && (
        <div className="flex flex-col gap-2 rounded-md border border-border bg-secondary/30 px-3 py-2.5">
          <div className="flex items-center justify-between gap-2">
            <h4 className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground/70">
              {t.followUps}
            </h4>
            <Button
              size="sm"
              variant="ghost"
              className="h-6 px-2 text-xs"
              onClick={copyFollowUps}
              title={t.copyFollowUps}
            >
              <Copy className="size-3" />
              {t.copyFollowUps}
            </Button>
          </div>
          <ul className="flex flex-col gap-1.5">
            {doc.follow_ups.map((f, i) => (
              <li
                key={i}
                className="flex gap-2 text-xs leading-relaxed text-foreground/85"
              >
                <span className="text-muted-foreground/50">—</span>
                <span>
                  {f.question}
                  {f.related_id && (
                    <span className="ml-1.5 font-numeric text-[10px] text-muted-foreground/70">
                      {f.related_id}
                    </span>
                  )}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

// The collapsible "Guide coverage" section for one interview's Summary panel.
export function CoveragePanel({ interviewId }: { interviewId: string }) {
  const t = useT(STR);
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [progress, setProgress] = useState<CoverageProgress | null>(null);

  const { data: coverage, isPending } = useQuery({
    queryKey: coverageKeys.detail(interviewId),
    queryFn: () => getGuideCoverage(interviewId),
    enabled: !!interviewId,
  });

  const run = useMutation({
    mutationFn: () => runGuideCoverage(interviewId),
    onSuccess: (row: CoverageRow) => {
      qc.setQueryData(coverageKeys.detail(interviewId), row);
    },
  });

  // Subscribe to coverage progress for THIS interview (the task center handles the
  // global surface; here we only drive the inline thin bar).
  useEffect(() => {
    function onProgress(p: CoverageProgress) {
      if (p.interview_id !== interviewId) return;
      if (p.stage === "done" || p.stage === "error") {
        setProgress(null);
        qc.invalidateQueries({ queryKey: coverageKeys.detail(interviewId) });
        if (p.stage === "error") {
          toast.error(tr(STR).coverageFailedEvent(p.error ?? tr(STR).unknown));
        }
      } else {
        setProgress(p);
      }
    }
    if (!IN_TAURI) {
      return mockOnCoverageProgress(onProgress);
    }
    const unlisten = getCurrentWebview().listen<CoverageProgress>(
      COVERAGE_PROGRESS_EVENT,
      (e) => onProgress(e.payload),
    );
    return () => {
      unlisten.then((fn) => fn());
    };
  }, [interviewId, qc]);

  const running = run.isPending || progress != null;
  const doc = coverage?.doc ?? null;

  async function handleRun() {
    setOpen(true);
    setProgress({
      interview_id: interviewId,
      stage: "started",
      progress: 5,
      error: null,
    });
    try {
      const row = await run.mutateAsync();
      toast.success(t.coverageReady(Math.round(row.doc.score)));
    } catch (e) {
      setProgress(null);
      toast.error(t.coverageFailed(String(e)));
    }
  }

  return (
    <section className="flex flex-col gap-3">
      {/* Collapsible header: chevron + title + (when a doc exists) the score at a glance. */}
      <div className="flex items-center justify-between gap-2">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="flex min-w-0 items-center gap-1.5 text-left text-sm font-medium text-foreground transition-colors hover:text-foreground/80"
        >
          <ChevronRight
            className={cn(
              "size-3.5 shrink-0 text-muted-foreground transition-transform duration-150",
              open && "rotate-90",
            )}
            aria-hidden="true"
          />
          <ListChecks
            className="size-3.5 shrink-0 text-muted-foreground"
            aria-hidden="true"
          />
          {t.title}
          {doc && !running && (
            <span className="ml-1 font-numeric text-xs text-muted-foreground">
              {Math.round(doc.score)}/100
            </span>
          )}
        </button>
        {doc && !running && open && (
          <Button
            size="sm"
            variant="ghost"
            className="h-6 px-2 text-xs"
            onClick={handleRun}
            title={t.rerun}
          >
            <RefreshCw className="size-3" />
            {t.rerun}
          </Button>
        )}
      </div>

      {/* Inline progress: a thin bar (the global task center carries the heavy UI). */}
      {running && (
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Loader2 className="size-3 animate-spin" aria-hidden="true" />
            {t.checking}
          </div>
          <div className="h-1 w-full overflow-hidden rounded-full bg-secondary/60">
            <div
              className="h-full rounded-full bg-primary transition-all duration-500"
              style={{ width: `${progress?.progress ?? 5}%` }}
            />
          </div>
        </div>
      )}

      {open && !running && (
        isPending ? (
          <div className="flex flex-col gap-2">
            <Skeleton className="h-8 w-24" />
            <Skeleton className="h-16 w-full" />
          </div>
        ) : doc ? (
          <CoverageResult doc={doc} />
        ) : (
          // Empty state: one short line + the primary check action.
          <div className="flex flex-col items-start gap-3 rounded-lg border border-dashed border-border px-4 py-5">
            <p className="text-xs leading-relaxed text-muted-foreground">
              {t.emptyDesc}
            </p>
            <Button size="sm" onClick={handleRun}>
              <ListChecks className="size-3.5" />
              {t.check}
            </Button>
          </div>
        )
      )}
    </section>
  );
}
