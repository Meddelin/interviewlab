import { useEffect, useMemo, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { useQueryClient } from "@tanstack/react-query";
import {
  Copy,
  Download,
  FileDown,
  FileText,
  Info,
  LayoutList,
  Lightbulb,
  Loader2,
  Quote,
  RotateCcw,
  Save,
  Sparkles,
  Target,
  TriangleAlert,
  Users,
} from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { MarkdownEditor } from "@/components/markdown-editor";
import { useInterviews } from "@/lib/interview-queries";
import { useCycle } from "@/lib/cycle-queries";
import {
  synthesisKeys,
  useCycleGoals,
  useRunSynthesis,
  useSaveCycleSynthesis,
  useSynthesis,
} from "@/lib/synthesis-queries";
import {
  buildCycleReportHtml,
  downloadHtmlReport,
  reportFileName,
} from "@/lib/report-export";
import {
  getDiff,
  getGuideCoverage,
  IN_TAURI,
  SYNTHESIS_PROGRESS_EVENT,
  type CoverageRow,
  type Evidence,
  type Finding,
  type Goal,
  type HypothesisVerdict,
  type QuestionAnswer,
  type RoleBreakdownGroup,
  type SynthesisProgress,
  type SynthesisRow,
} from "@/lib/tauri";
// dev-mock: browser-only, never active under Tauri.
import { mockOnSynthesisProgress } from "@/lib/dev-mock";
import { absoluteDate } from "@/lib/format";
import { cn } from "@/lib/utils";
import { tr, useT, useUiLang } from "@/lib/i18n";

// Localized strings for this file (ru/en). Used via useT in components and tr in helpers.
const STR = {
  ru: {
    copiedToClipboard: "Скопировано в буфер обмена",
    copyFailed: (e: string) => `Не удалось скопировать. ${e}`,
    quoteUnavailable: "(цитата недоступна)",
    segment: (n: number) => `сегмент ${n}`,
    confidence: (label: string) => `Уверенность: ${label}`,
    interviews: (n: number) => `${n} ${n === 1 ? "интервью" : "интервью"}`,
    byRole: "По ролям",
    noFindingsForGoal: "По этой цели в этой волне выводов не найдено.",
    hypotheses: "Гипотезы",
    confidenceShort: (label: string) => `Уверенность: ${label}`,
    questions: "Вопросы",
    stageReading: "Чтение интервью",
    stageSynthesizing: "Формирование выводов",
    stageDone: "Готово",
    stageWorking: "Обработка",
    cycleSynthesis: "Синтез цикла",
    lastSynthesized: (when: string) => `Последний синтез: ${when}.`,
    editableReport: (n: number, goalsLabel: string) =>
      `Редактируемый отчёт по интервью этой волны, привязанный к ${n || ""} ${goalsLabel} вашего гайда.`,
    goalWord: (n: number) => (n === 1 ? "цели" : "целям"),
    artifact: "Артефакт",
    findings: "Выводы",
    copyMd: "Копировать .md",
    copyAsMarkdown: "Скопировать как Markdown",
    export: "Экспорт",
    downloadAsMd: "Скачать как .md",
    reRunSynthesis: "Перезапустить синтез",
    runSynthesis: "Запустить синтез",
    synthesisComplete: (f: number, g: number) =>
      `Синтез завершён — ${f} ${f === 1 ? "вывод" : "выводов"} по ${g} целям.`,
    synthesisFailedRun: (e: string) => `Не удалось выполнить синтез. ${e}`,
    synthesisFailedEvent: (e: string) => `Синтез не удался: ${e}`,
    synthesisSaved: "Синтез сохранён",
    saveFailed: (e: string) => `Не удалось сохранить. ${e}`,
    editableReportNote:
      "Редактируемый отчёт. Перезапуск создаёт его заново; ваши правки сохраняются.",
    save: "Сохранить",
    saving: "Сохранение…",
    manualEditsCaveat:
      "Ручные правки этого текста не попадают в Diff и Чат — там используется машинная версия findings.",
    artifactPlaceholder:
      "Запустите синтез, чтобы сгенерировать отчёт, затем редактируйте его здесь…",
    openQuestions: "Открытые вопросы",
    synthesizingEmpty: "Формирование выводов по интервью этой волны…",
    noSynthesisYet: "Синтеза пока нет",
    noSynthesisDesc:
      "Запустите синтез, чтобы собрать редактируемый отчёт по интервью этой волны — привязанный к целям вашего гайда, с трассируемыми цитатами и разбивкой по ролям.",
    groundedOn: (n: number, goalsLabel: string) => `Опирается на ${n} ${goalsLabel}`,
    goalCountWord: (n: number) => (n === 1 ? "цель" : "целей"),
    addGoalsPrefix: "Сначала добавьте раздел ",
    addGoalsGoals: "Цели",
    addGoalsSuffix: " в гайд интервью на вкладке «Обзор».",
    unknown: "неизвестно",
    interviewFallback: (id: string) => `Интервью ${id}`,
    exportReportHtml: "Экспорт отчёта (HTML)",
    exportReportTitle:
      "Скачать standalone HTML-отчёт волны: резюме, выводы, дифф и покрытие",
    exportingReport: "Собираем отчёт…",
    reportExported: "HTML-отчёт скачан",
    reportFailed: (e: string) => `Не удалось собрать отчёт. ${e}`,
    divergedBanner:
      "Markdown-версия отредактирована вручную — diff и чат используют исходные findings",
    rebuild: "Пересобрать",
    retry: "Повторить",
    lastRunFailed: (e: string) => `Синтез не удался: ${e}`,
  },
  en: {
    copiedToClipboard: "Copied to clipboard",
    copyFailed: (e: string) => `Couldn't copy. ${e}`,
    quoteUnavailable: "(quote unavailable)",
    segment: (n: number) => `segment ${n}`,
    confidence: (label: string) => `${label} confidence`,
    interviews: (n: number) => `${n} interview${n === 1 ? "" : "s"}`,
    byRole: "By role",
    noFindingsForGoal: "No findings surfaced for this goal in this wave.",
    hypotheses: "Hypotheses",
    confidenceShort: (label: string) => `${label} confidence`,
    questions: "Questions",
    stageReading: "Reading interviews",
    stageSynthesizing: "Synthesizing findings",
    stageDone: "Done",
    stageWorking: "Working",
    cycleSynthesis: "Cycle synthesis",
    lastSynthesized: (when: string) => `Last synthesized ${when}.`,
    editableReport: (n: number, goalsLabel: string) =>
      `An editable report across this wave's interviews, tied to your ${n || ""} guide ${goalsLabel}.`,
    goalWord: (n: number) => (n === 1 ? "goal" : "goals"),
    artifact: "Artifact",
    findings: "Findings",
    copyMd: "Copy .md",
    copyAsMarkdown: "Copy as Markdown",
    export: "Export",
    downloadAsMd: "Download as .md",
    reRunSynthesis: "Re-run synthesis",
    runSynthesis: "Run synthesis",
    synthesisComplete: (f: number, g: number) =>
      `Synthesis complete — ${f} finding${f === 1 ? "" : "s"} across ${g} goals.`,
    synthesisFailedRun: (e: string) => `Couldn't synthesize. ${e}`,
    synthesisFailedEvent: (e: string) => `Synthesis failed: ${e}`,
    synthesisSaved: "Synthesis saved",
    saveFailed: (e: string) => `Couldn't save. ${e}`,
    editableReportNote:
      "The editable report. Re-running regenerates it; your edits are saved.",
    save: "Save",
    saving: "Saving…",
    manualEditsCaveat:
      "Manual edits to this text don't flow into Diff or Chat — those read the machine version of the findings.",
    artifactPlaceholder:
      "Run synthesis to generate the report, then edit it here…",
    openQuestions: "Open questions",
    synthesizingEmpty: "Synthesizing findings across this wave's interviews…",
    noSynthesisYet: "No synthesis yet",
    noSynthesisDesc:
      "Run synthesis to assemble an editable report across this wave's interviews — tied to your guide's goals, with evidence quotes you can trace and a by-role breakdown.",
    groundedOn: (n: number, goalsLabel: string) => `Grounded on ${n} ${goalsLabel}`,
    goalCountWord: (n: number) => (n === 1 ? "goal" : "goals"),
    addGoalsPrefix: "Add a ",
    addGoalsGoals: "Goals",
    addGoalsSuffix: " section to the interview guide on the Overview tab first.",
    unknown: "unknown",
    interviewFallback: (id: string) => `Interview ${id}`,
    exportReportHtml: "Export report (HTML)",
    exportReportTitle:
      "Download a standalone HTML report of this wave: summary, findings, diff and coverage",
    exportingReport: "Building the report…",
    reportExported: "HTML report downloaded",
    reportFailed: (e: string) => `Couldn't build the report. ${e}`,
    divergedBanner:
      "The markdown version was edited manually — Diff and Chat use the original findings",
    rebuild: "Re-run",
    retry: "Retry",
    lastRunFailed: (e: string) => `Synthesis failed: ${e}`,
  },
};

// ponytail: file-local copy/export helpers (no shared util module — same two helpers are
// duplicated in diff-tab.tsx; factoring out a common module is deferred to the export layer).
async function copyMarkdown(md: string) {
  try {
    await navigator.clipboard.writeText(md);
    toast.success(tr(STR).copiedToClipboard);
  } catch (e) {
    toast.error(tr(STR).copyFailed(String(e)));
  }
}

// Download a markdown string as a .md file via a Blob + transient anchor.
function exportMarkdown(md: string, filename: string) {
  const blob = new Blob([md], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// Confidence → badge styling. Muted palette to fit the Linear bar: high reads in the
// accent, medium neutral, low quiet.
const CONFIDENCE_LABELS: Record<string, { ru: string; en: string }> = {
  high: { ru: "высокая", en: "High" },
  medium: { ru: "средняя", en: "Medium" },
  low: { ru: "низкая", en: "Low" },
};

function ConfidenceBadge({ confidence }: { confidence: string }) {
  const t = useT(STR);
  const lang = useUiLang();
  const c = confidence.toLowerCase();
  const label =
    CONFIDENCE_LABELS[c]?.[lang] ?? c.charAt(0).toUpperCase() + c.slice(1);
  return (
    <Badge
      variant="outline"
      className={cn(
        "gap-1.5",
        c === "high" && "border-status-ready/40 text-status-ready",
        c === "low" && "text-muted-foreground",
      )}
    >
      <span
        className={cn(
          "size-1.5 rounded-full",
          c === "high" && "bg-status-ready",
          c === "medium" && "bg-status-processing",
          c === "low" && "bg-muted-foreground/60",
        )}
        aria-hidden="true"
      />
      {t.confidence(label)}
    </Badge>
  );
}

// One evidence quote, referencing (and linking to) its interview. Clicking opens that
// interview's editor — findings stay traceable back to the transcript (spec §8.1).
function EvidenceQuote({
  evidence,
  interviewTitle,
  onOpen,
}: {
  evidence: Evidence;
  interviewTitle: string;
  onOpen: () => void;
}) {
  const t = useT(STR);
  return (
    <li className="flex gap-2.5">
      <Quote
        className="mt-0.5 size-3.5 shrink-0 text-muted-foreground/50"
        aria-hidden="true"
      />
      <div className="flex flex-col gap-1">
        <p className="text-sm leading-relaxed text-foreground/90">
          {evidence.quote ? `“${evidence.quote}”` : t.quoteUnavailable}
        </p>
        <button
          type="button"
          onClick={onOpen}
          className="w-fit text-left text-xs text-muted-foreground transition-colors hover:text-foreground"
        >
          {interviewTitle}
          <span className="text-muted-foreground/50">
            {" "}
            · {t.segment(evidence.segment_id + 1)}
          </span>
        </button>
      </div>
    </li>
  );
}

// One finding card: statement, confidence + support, evidence quotes, recommendation.
function FindingCard({
  finding,
  titleFor,
  onOpenInterview,
}: {
  finding: Finding;
  titleFor: (interviewId: string) => string;
  onOpenInterview: (interviewId: string) => void;
}) {
  const t = useT(STR);
  return (
    // id anchor so a chat citation [[finding:Fn]] can route here (#finding-Fn) — M11.
    <Card id={`finding-${finding.id}`} size="sm" className="scroll-mt-20 gap-3">
      <CardHeader>
        <CardTitle className="text-sm leading-snug">
          {finding.statement}
        </CardTitle>
        <CardAction>
          <span className="font-numeric text-[11px] text-muted-foreground/70">
            {finding.id}
          </span>
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <ConfidenceBadge confidence={finding.confidence} />
          <Badge variant="ghost" className="text-muted-foreground">
            {t.interviews(finding.support_count)}
          </Badge>
        </div>

        {finding.evidence.length > 0 && (
          <ul className="flex flex-col gap-2.5 border-l border-border pl-3">
            {finding.evidence.map((e, i) => (
              <EvidenceQuote
                key={`${e.interview_id}-${e.segment_id}-${i}`}
                evidence={e}
                interviewTitle={titleFor(e.interview_id)}
                onOpen={() => onOpenInterview(e.interview_id)}
              />
            ))}
          </ul>
        )}

        {finding.recommendation && (
          <div className="flex items-start gap-2 rounded-md bg-secondary/40 px-3 py-2">
            <Lightbulb
              className="mt-0.5 size-3.5 shrink-0 text-primary/80"
              aria-hidden="true"
            />
            <p className="text-xs leading-relaxed text-foreground/80">
              {finding.recommendation}
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// One goal section: the goal text as a heading, then its findings (or a quiet "no
// findings" note when the wave surfaced nothing for this goal).
function GoalSection({
  goal,
  findings,
  roleNotes,
  titleFor,
  onOpenInterview,
}: {
  goal: Goal;
  findings: Finding[];
  roleNotes: RoleBreakdownGroup | undefined;
  titleFor: (interviewId: string) => string;
  onOpenInterview: (interviewId: string) => void;
}) {
  const t = useT(STR);
  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-baseline gap-2.5">
        <span className="flex items-center gap-1.5 font-numeric text-xs font-medium text-primary">
          <Target className="size-3.5" aria-hidden="true" />
          {goal.id}
        </span>
        <h3 className="text-sm font-medium text-foreground">{goal.text}</h3>
      </div>
      {findings.length === 0 ? (
        <p className="pl-6 text-xs text-muted-foreground">
          {t.noFindingsForGoal}
        </p>
      ) : (
        // Wide: lay findings out as a multi-column card grid (one column on narrow).
        <div className="grid grid-cols-1 gap-3 pl-6 xl:grid-cols-2 2xl:grid-cols-3">
          {findings.map((f) => (
            <FindingCard
              key={f.id}
              finding={f}
              titleFor={titleFor}
              onOpenInterview={onOpenInterview}
            />
          ))}
        </div>
      )}
      {/* M10b: optional by-role breakdown for this goal. */}
      {roleNotes && roleNotes.notes.length > 0 && (
        <div className="ml-6 flex flex-col gap-1.5 rounded-md border border-border bg-secondary/30 px-3 py-2">
          <div className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground/70">
            <Users className="size-3" aria-hidden="true" />
            {t.byRole}
          </div>
          <ul className="flex flex-col gap-1">
            {roleNotes.notes.map((n, i) => (
              <li key={i} className="text-xs leading-relaxed text-foreground/80">
                <span className="font-medium text-foreground/90">{n.role}:</span>{" "}
                {n.note}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

// Verdict → badge styling. confirmed reads green, refuted red, partial amber, inconclusive
// neutral — the same status-color family the rest of the app uses.
function VerdictBadge({ verdict }: { verdict: string }) {
  const lang = useUiLang();
  const v = verdict.toLowerCase();
  const labels: Record<string, { ru: string; en: string }> = {
    confirmed: { ru: "Подтверждена", en: "Confirmed" },
    partially: { ru: "Частично подтверждена", en: "Partially confirmed" },
    refuted: { ru: "Опровергнута", en: "Refuted" },
    inconclusive: { ru: "Неубедительно", en: "Inconclusive" },
  };
  const meta: Record<string, { label: string; dot: string; text: string; border: string }> = {
    confirmed: { label: labels.confirmed[lang], dot: "bg-status-ready", text: "text-status-ready", border: "border-status-ready/40" },
    partially: { label: labels.partially[lang], dot: "bg-status-processing", text: "", border: "" },
    refuted: { label: labels.refuted[lang], dot: "bg-status-error", text: "text-status-error", border: "border-status-error/40" },
    inconclusive: { label: labels.inconclusive[lang], dot: "bg-muted-foreground/60", text: "text-muted-foreground", border: "" },
  };
  const m = meta[v] ?? meta.inconclusive;
  return (
    <Badge variant="outline" className={cn("gap-1.5", m.border, m.text)}>
      <span className={cn("size-1.5 rounded-full", m.dot)} aria-hidden="true" />
      {m.label}
    </Badge>
  );
}

// Question-answer status → small label. answered=green, partially=amber, not_answered=red.
function QuestionStatusBadge({ status }: { status: string }) {
  const lang = useUiLang();
  const s = status.toLowerCase();
  const labels: Record<string, { ru: string; en: string }> = {
    answered: { ru: "Отвечено", en: "Answered" },
    partially: { ru: "Частично", en: "Partial" },
    not_answered: { ru: "Нет ответа", en: "Not answered" },
  };
  const meta: Record<string, { label: string; dot: string; text: string }> = {
    answered: { label: labels.answered[lang], dot: "bg-status-ready", text: "text-status-ready" },
    partially: { label: labels.partially[lang], dot: "bg-status-processing", text: "text-muted-foreground" },
    not_answered: { label: labels.not_answered[lang], dot: "bg-status-error", text: "text-status-error" },
  };
  const m = meta[s] ?? meta.not_answered;
  return (
    <span className={cn("inline-flex items-center gap-1.5 text-[11px]", m.text)}>
      <span className={cn("size-1.5 rounded-full", m.dot)} aria-hidden="true" />
      {m.label}
    </span>
  );
}

// The hypotheses section of the structured view: a verdict per hypothesis with rationale +
// evidence quotes.
function HypothesesSection({
  verdicts,
  titleFor,
  onOpenInterview,
}: {
  verdicts: HypothesisVerdict[];
  titleFor: (id: string) => string;
  onOpenInterview: (id: string) => void;
}) {
  const t = useT(STR);
  const lang = useUiLang();
  return (
    <section className="flex flex-col gap-4">
      <div className="flex items-baseline gap-2.5">
        <span className="flex items-center gap-1.5 font-numeric text-xs font-medium text-primary">
          <Lightbulb className="size-3.5" aria-hidden="true" />
          {t.hypotheses}
        </span>
      </div>
      <div className="flex flex-col gap-4">
        {verdicts.map((h) => (
          <Card key={h.id} size="sm" className="gap-3">
            <CardHeader>
              <CardTitle className="text-sm leading-snug">{h.text}</CardTitle>
              <CardAction>
                <span className="font-numeric text-[11px] text-muted-foreground/70">{h.id}</span>
              </CardAction>
            </CardHeader>
            <CardContent className="flex flex-col gap-2.5">
              <div className="flex flex-wrap items-center gap-2">
                <VerdictBadge verdict={h.verdict} />
                <Badge variant="ghost" className="text-muted-foreground">
                  {t.confidenceShort(
                    CONFIDENCE_LABELS[h.confidence.toLowerCase()]?.[lang] ??
                      h.confidence,
                  )}
                </Badge>
              </div>
              {h.rationale && (
                <p className="text-sm leading-relaxed text-foreground/85">{h.rationale}</p>
              )}
              {(h.evidence?.length ?? 0) > 0 && (
                <ul className="flex flex-col gap-2.5 border-l border-border pl-3">
                  {h.evidence!.map((e, i) => (
                    <EvidenceQuote
                      key={`${e.interview_id}-${e.segment_id}-${i}`}
                      evidence={e}
                      interviewTitle={titleFor(e.interview_id)}
                      onOpen={() => onOpenInterview(e.interview_id)}
                    />
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        ))}
      </div>
    </section>
  );
}

// The questions section: a consolidated answer per guide question, with its answered status.
function QuestionsSection({
  answers,
  titleFor,
  onOpenInterview,
}: {
  answers: QuestionAnswer[];
  titleFor: (id: string) => string;
  onOpenInterview: (id: string) => void;
}) {
  const t = useT(STR);
  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-baseline gap-2.5">
        <span className="flex items-center gap-1.5 font-numeric text-xs font-medium text-primary">
          <FileText className="size-3.5" aria-hidden="true" />
          {t.questions}
        </span>
      </div>
      <div className="flex flex-col gap-3">
        {answers.map((q) => (
          <div key={q.id} className="flex flex-col gap-1.5 border-l border-border pl-3">
            <div className="flex items-start justify-between gap-3">
              <p className="text-sm leading-snug text-foreground/90">
                <span className="mr-1.5 font-numeric text-[11px] text-muted-foreground/70">
                  {q.id}
                </span>
                {q.text}
              </p>
              <div className="shrink-0">
                <QuestionStatusBadge status={q.status} />
              </div>
            </div>
            {q.answer && (
              <p className="text-sm leading-relaxed text-muted-foreground">{q.answer}</p>
            )}
            {(q.evidence?.length ?? 0) > 0 && (
              <ul className="mt-0.5 flex flex-col gap-2 border-l border-border pl-3">
                {q.evidence!.map((e, i) => (
                  <EvidenceQuote
                    key={`${e.interview_id}-${e.segment_id}-${i}`}
                    evidence={e}
                    interviewTitle={titleFor(e.interview_id)}
                    onOpen={() => onOpenInterview(e.interview_id)}
                  />
                ))}
              </ul>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}

// Human-readable stage label for the live progress line.
function stageLabel(stage: string): string {
  const s = tr(STR);
  if (stage === "extract") return s.stageReading;
  if (stage === "reduce") return s.stageSynthesizing;
  if (stage === "done") return s.stageDone;
  return s.stageWorking;
}

// Which view of the cycle synthesis is shown: the editable markdown artifact (default) or
// the structured findings-by-goal view (read-only, the same data the diff reads).
type View = "artifact" | "structured";

export function SynthesisTab({ cycleId }: { cycleId: string }) {
  const t = useT(STR);
  const navigate = useNavigate();
  const location = useLocation();
  const qc = useQueryClient();
  const { data: synthesis, isPending } = useSynthesis(cycleId);
  const { data: goals } = useCycleGoals(cycleId);
  const { data: interviews } = useInterviews(cycleId);
  const { data: cycle } = useCycle(cycleId);
  const runSynthesis = useRunSynthesis(cycleId);
  const saveArtifact = useSaveCycleSynthesis(cycleId);

  // Live stage progress (null when idle).
  const [progress, setProgress] = useState<SynthesisProgress | null>(null);
  const [view, setView] = useState<View>("artifact");
  // The last run's error (null when the last run succeeded / nothing ran yet). Drives the
  // error banner with its Retry action; cleared when a new run starts.
  const [runError, setRunError] = useState<string | null>(null);
  // HTML-report assembly in flight (gathering diff + per-interview coverage).
  const [exportingReport, setExportingReport] = useState(false);

  // M11: a chat citation [[finding:Fn]] routes to #finding-Fn — switch to the structured
  // (findings) view and scroll the card into view when that hash is present. Re-runs on
  // hash/key changes (so re-clicking the same chip re-scrolls) + when synthesis loads. A
  // single string dep keeps the dep-array size constant across renders.
  const findingScrollKey = `${synthesis?.id ?? ""}|${location.hash}|${location.key}`;
  useEffect(() => {
    const hash = location.hash;
    if (!hash.startsWith("#finding-")) return;
    setView("structured");
    const t = setTimeout(() => {
      document
        .getElementById(hash.slice(1))
        ?.scrollIntoView({ behavior: "smooth", block: "center" });
    }, 150);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [findingScrollKey]);

  // The editable markdown buffer (seeded from the stored artifact; dirty until saved).
  const [draft, setDraft] = useState<string>("");
  const [dirty, setDirty] = useState(false);
  // Re-mount the editor (seeded once from `value`) whenever the underlying artifact
  // identity changes — a fresh run or a different cycle.
  const [editorKey, setEditorKey] = useState(0);

  // Interview id → title for evidence refs (fallback to a short id when not loaded).
  const titleFor = useMemo(() => {
    const map = new Map((interviews ?? []).map((i) => [i.id, i.title]));
    return (id: string) => map.get(id) ?? t.interviewFallback(id.slice(0, 8));
  }, [interviews, t]);

  // Seed the markdown draft from the stored artifact whenever it (re)loads.
  const storedMd = synthesis?.content_md ?? "";
  useEffect(() => {
    setDraft(storedMd);
    setDirty(false);
    setEditorKey((k) => k + 1);
  }, [storedMd]);

  // Guard the unsaved markdown draft: warn on window close/reload while dirty. (Router-level
  // navigation guard is deferred — it needs a shared blocker the whole app opts into.)
  useEffect(() => {
    if (!dirty) return;
    function onBeforeUnload(e: BeforeUnloadEvent) {
      e.preventDefault();
      e.returnValue = "";
    }
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [dirty]);

  // Subscribe to synthesis progress; clear on a terminal stage + refresh the synthesis.
  useEffect(() => {
    function onProgress(p: SynthesisProgress) {
      if (p.cycle_id !== cycleId) return;
      if (p.stage === "done" || p.stage === "error") {
        setProgress(null);
        qc.invalidateQueries({ queryKey: synthesisKeys.detail(cycleId) });
        if (p.stage === "error") {
          setRunError(p.error ?? t.unknown);
          toast.error(t.synthesisFailedEvent(p.error ?? t.unknown));
        }
      } else {
        setProgress(p);
      }
    }

    if (!IN_TAURI) {
      return mockOnSynthesisProgress(onProgress);
    }
    const unlisten = getCurrentWebview().listen<SynthesisProgress>(
      SYNTHESIS_PROGRESS_EVENT,
      (e) => onProgress(e.payload),
    );
    return () => {
      unlisten.then((fn) => fn());
    };
  }, [cycleId, qc, t]);

  const running = runSynthesis.isPending || progress != null;

  async function handleRun() {
    setRunError(null);
    setProgress({
      cycle_id: cycleId,
      stage: "extract",
      done: 0,
      total: 0,
      progress: 0,
      error: null,
    });
    try {
      const row: SynthesisRow = await runSynthesis.mutateAsync();
      setRunError(null);
      toast.success(
        t.synthesisComplete(row.doc.findings.length, row.doc.goals.length),
      );
    } catch (e) {
      setProgress(null);
      setRunError(String(e));
      toast.error(t.synthesisFailedRun(String(e)));
    }
  }

  // Assemble + download the standalone HTML wave report: the stored synthesis (with any
  // saved markdown edits), the diff and each interview's coverage row are gathered on
  // demand (Promise.all, nulls tolerated — the report simply omits missing sections).
  async function handleExportReport() {
    if (!synthesis || !cycle || exportingReport) return;
    setExportingReport(true);
    try {
      const list = interviews ?? [];
      const [diffRow, coverageRows] = await Promise.all([
        getDiff(cycleId).catch(() => null),
        Promise.all(
          list.map((i) => getGuideCoverage(i.id).catch(() => null)),
        ),
      ]);
      const coverageByInterview: Record<string, CoverageRow | null> = {};
      list.forEach((i, idx) => {
        coverageByInterview[i.id] = coverageRows[idx];
      });
      const html = buildCycleReportHtml({
        cycle,
        synthesis,
        goals: groupGoals,
        diff: diffRow,
        coverageByInterview,
        interviews: list,
      });
      downloadHtmlReport(html, reportFileName(cycle.name));
      toast.success(t.reportExported);
    } catch (e) {
      toast.error(t.reportFailed(String(e)));
    } finally {
      setExportingReport(false);
    }
  }

  async function handleSave() {
    try {
      await saveArtifact.mutateAsync(draft);
      setDirty(false);
      toast.success(t.synthesisSaved);
    } catch (e) {
      toast.error(t.saveFailed(String(e)));
    }
  }

  // Findings grouped by goal, in goal order (the doc's goals are authoritative; fall
  // back to the live-derived goals before the first run).
  const doc = synthesis?.doc;
  const groupGoals = doc?.goals ?? goals ?? [];
  const findingsByGoal = useMemo(() => {
    const map = new Map<string, Finding[]>();
    for (const f of doc?.findings ?? []) {
      const arr = map.get(f.goal_id) ?? [];
      arr.push(f);
      map.set(f.goal_id, arr);
    }
    return map;
  }, [doc]);
  const roleByGoal = useMemo(() => {
    const map = new Map<string, RoleBreakdownGroup>();
    for (const g of doc?.by_role ?? []) map.set(g.goal_id, g);
    return map;
  }, [doc]);

  function openInterview(interviewId: string) {
    navigate(`/cycles/${cycleId}/interviews/${interviewId}`);
  }

  if (isPending) {
    return (
      <div className="flex flex-col gap-5 pt-2">
        <Skeleton className="h-9 w-44" />
        <Skeleton className="h-28 w-full max-w-2xl" />
        <Skeleton className="h-28 w-full max-w-2xl" />
      </div>
    );
  }

  const hasSynthesis = !!doc && (doc.findings.length > 0 || storedMd.trim().length > 0);

  return (
    <div className="flex flex-col gap-6 pt-2">
      {/* Action bar: run / re-run + last-run meta + view toggle. */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-col gap-0.5">
          <h2 className="text-sm font-medium text-foreground">
            {t.cycleSynthesis}
          </h2>
          <p className="text-xs text-muted-foreground">
            {hasSynthesis
              ? t.lastSynthesized(absoluteDate(synthesis!.created_at))
              : t.editableReport(
                  groupGoals.length,
                  t.goalWord(groupGoals.length),
                )}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {hasSynthesis && (
            <div className="flex items-center rounded-md border border-border p-0.5">
              <button
                type="button"
                onClick={() => setView("artifact")}
                className={cn(
                  "flex items-center gap-1.5 rounded px-2 py-1 text-xs transition-colors",
                  view === "artifact"
                    ? "bg-secondary text-foreground"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                <FileText className="size-3.5" />
                {t.artifact}
              </button>
              <button
                type="button"
                onClick={() => setView("structured")}
                className={cn(
                  "flex items-center gap-1.5 rounded px-2 py-1 text-xs transition-colors",
                  view === "structured"
                    ? "bg-secondary text-foreground"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                <LayoutList className="size-3.5" />
                {t.findings}
              </button>
            </div>
          )}
          {hasSynthesis && (
            <>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => copyMarkdown(draft || storedMd)}
                title={t.copyAsMarkdown}
              >
                <Copy className="size-3.5" />
                {t.copyMd}
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() =>
                  exportMarkdown(draft || storedMd, "synthesis.md")
                }
                title={t.downloadAsMd}
              >
                <Download className="size-3.5" />
                {t.export}
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={handleExportReport}
                disabled={exportingReport || !cycle}
                title={t.exportReportTitle}
              >
                {exportingReport ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <FileDown className="size-3.5" />
                )}
                {exportingReport ? t.exportingReport : t.exportReportHtml}
              </Button>
            </>
          )}
          <Button size="sm" onClick={handleRun} disabled={running}>
            {running ? (
              <>
                <Loader2 className="size-4 animate-spin" />
                {stageLabel(progress?.stage ?? "extract")}
                {progress?.stage === "extract" && progress.total > 0
                  ? ` ${progress.done}/${progress.total}`
                  : "…"}
              </>
            ) : (
              <>
                <Sparkles className="size-4" />
                {hasSynthesis ? t.reRunSynthesis : t.runSynthesis}
              </>
            )}
          </Button>
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

      {/* The last run failed → a quiet red hairline banner with a Retry (same params). */}
      {runError && !running && (
        <div className="flex items-start justify-between gap-3 rounded-md border border-status-error/40 bg-status-error/10 px-3 py-2">
          <div className="flex items-start gap-2">
            <TriangleAlert
              className="mt-0.5 size-3.5 shrink-0 text-status-error"
              aria-hidden="true"
            />
            <p className="text-xs leading-relaxed text-foreground/80">
              {t.lastRunFailed(runError)}
            </p>
          </div>
          <Button
            size="sm"
            variant="ghost"
            className="h-6 shrink-0 px-2 text-xs"
            onClick={handleRun}
          >
            <RotateCcw className="size-3" />
            {t.retry}
          </Button>
        </div>
      )}

      {/* B3 hygiene: the markdown artifact diverged from the structured findings — an
          amber hairline banner naming what still reads the machine version, with a
          re-run action that regenerates both layers in sync. */}
      {synthesis?.edited_diverged && !running && (
        <div className="flex items-start justify-between gap-3 rounded-md border border-status-importing/40 bg-status-importing/10 px-3 py-2">
          <div className="flex items-start gap-2">
            <TriangleAlert
              className="mt-0.5 size-3.5 shrink-0 text-status-importing"
              aria-hidden="true"
            />
            <p className="text-xs leading-relaxed text-foreground/80">
              {t.divergedBanner}
            </p>
          </div>
          <Button
            size="sm"
            variant="ghost"
            className="h-6 shrink-0 px-2 text-xs"
            onClick={handleRun}
          >
            <RotateCcw className="size-3" />
            {t.rebuild}
          </Button>
        </div>
      )}

      {/* Body. */}
      {!hasSynthesis ? (
        <EmptyState goals={groupGoals} running={running} />
      ) : view === "artifact" ? (
        // The editable cycle markdown artifact (Plate). Edit + Save (the user owns it).
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-3">
          <div className="flex items-center justify-between">
            <p className="text-xs text-muted-foreground">
              {t.editableReportNote}
            </p>
            <Button
              size="sm"
              variant={dirty ? "default" : "outline"}
              onClick={handleSave}
              disabled={!dirty || saveArtifact.isPending}
            >
              <Save className="size-3.5" />
              {saveArtifact.isPending ? t.saving : t.save}
            </Button>
          </div>
          {/* MIN caveat (theme C): manual markdown edits never flow back into findings_json,
              so Diff/Chat keep reading the machine version. No edit-timestamp field exists, so
              this is a static caveat rather than a conditional one. */}
          <div className="flex items-start gap-2 rounded-md border border-border bg-secondary/30 px-3 py-2">
            <Info
              className="mt-0.5 size-3.5 shrink-0 text-muted-foreground/70"
              aria-hidden="true"
            />
            <p className="text-xs leading-relaxed text-muted-foreground">
              {t.manualEditsCaveat}
            </p>
          </div>
          <MarkdownEditor
            key={editorKey}
            value={draft}
            onChange={(md) => {
              setDraft(md);
              setDirty(true);
            }}
            placeholder={t.artifactPlaceholder}
          />
        </div>
      ) : (
        // The structured view (read-only): hypotheses verdicts → per-question answers →
        // findings-by-goal (the data the diff compares).
        <div className="mx-auto flex w-full max-w-2xl flex-col gap-8 xl:max-w-6xl">
          {(doc?.hypothesis_verdicts?.length ?? 0) > 0 && (
            <HypothesesSection
              verdicts={doc!.hypothesis_verdicts!}
              titleFor={titleFor}
              onOpenInterview={openInterview}
            />
          )}

          {(doc?.question_answers?.length ?? 0) > 0 && (
            <QuestionsSection
              answers={doc!.question_answers!}
              titleFor={titleFor}
              onOpenInterview={openInterview}
            />
          )}

          {groupGoals.map((goal) => (
            <GoalSection
              key={goal.id}
              goal={goal}
              findings={findingsByGoal.get(goal.id) ?? []}
              roleNotes={roleByGoal.get(goal.id)}
              titleFor={titleFor}
              onOpenInterview={openInterview}
            />
          ))}

          {(doc!.open_questions?.length ?? 0) > 0 && (
            <section className="flex flex-col gap-2 border-t border-border pt-5">
              <h3 className="text-sm font-medium text-foreground">
                {t.openQuestions}
              </h3>
              <ul className="flex flex-col gap-1.5">
                {doc!.open_questions.map((q, i) => (
                  <li
                    key={i}
                    className="flex gap-2 text-sm leading-relaxed text-muted-foreground"
                  >
                    <span className="text-muted-foreground/50">—</span>
                    {q}
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      )}
    </div>
  );
}

// Empty state before the first run: shows what synthesis will be grounded on (the goals)
// so the action feels concrete.
function EmptyState({ goals, running }: { goals: Goal[]; running: boolean }) {
  const t = useT(STR);
  if (running) {
    return (
      <div className="flex max-w-md flex-col items-start gap-2 rounded-lg border border-dashed border-border px-6 py-10">
        <Loader2 className="size-4 animate-spin text-muted-foreground" />
        <p className="text-sm text-muted-foreground">
          {t.synthesizingEmpty}
        </p>
      </div>
    );
  }
  return (
    <div className="flex max-w-md flex-col items-start gap-4 rounded-lg border border-dashed border-border px-6 py-8">
      <div className="flex flex-col gap-1">
        <p className="text-sm font-medium text-foreground">{t.noSynthesisYet}</p>
        <p className="text-xs text-muted-foreground">
          {t.noSynthesisDesc}
        </p>
      </div>
      {goals.length > 0 ? (
        <div className="flex w-full flex-col gap-2">
          <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground/70">
            {t.groundedOn(goals.length, t.goalCountWord(goals.length))}
          </span>
          <ul className="flex flex-col gap-1.5">
            {goals.map((g) => (
              <li key={g.id} className="flex gap-2 text-xs text-foreground/80">
                <span className="font-numeric text-primary">{g.id}</span>
                <span>{g.text}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">
          {t.addGoalsPrefix}
          <span className="text-foreground">{t.addGoalsGoals}</span>
          {t.addGoalsSuffix}
        </p>
      )}
    </div>
  );
}
