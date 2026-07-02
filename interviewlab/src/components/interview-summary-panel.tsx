import { useEffect, useMemo, useState } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import {
  Copy,
  Download,
  FileText,
  Info,
  LayoutList,
  Loader2,
  Save,
  Sparkles,
  Target,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { MarkdownEditor } from "@/components/markdown-editor";
import { CoveragePanel } from "@/components/coverage-panel";
import { cn } from "@/lib/utils";
import {
  useInterviewSummary,
  useRunInterviewSummary,
  useSaveInterviewSummary,
} from "@/lib/synthesis-queries";
import {
  IN_TAURI,
  INTERVIEW_SUMMARY_PROGRESS_EVENT,
  type InterviewQuote,
  type InterviewSummaryProgress,
  type InterviewSummaryRow,
} from "@/lib/tauri";
// dev-mock: browser-only, never active under Tauri.
import { mockOnInterviewSummaryProgress } from "@/lib/dev-mock";
import { tr, useT, useUiLang } from "@/lib/i18n";
import type { Lang } from "@/lib/i18n";

// Localized strings for this file (ru/en). Used via useT in components and tr in helpers.
const STR = {
  ru: {
    copiedToClipboard: "Скопировано в буфер обмена",
    copyFailed: (e: string) => `Не удалось скопировать. ${e}`,
    noPointsForGoal: "Нет ключевых пунктов по этой цели.",
    questionAnswers: "Ответы на вопросы",
    hypothesisSignals: "Сигналы по гипотезам",
    notableQuotes: "Заметные цитаты",
    interviewSummary: "Резюме интервью",
    summaryDescription:
      "Краткое резюме, структурированное по целям вашего гайда — ключевые пункты, подкрепляющие цитаты и неожиданные находки. Редактируется.",
    markdown: "Markdown",
    structure: "Структура",
    copyMd: "Копировать .md",
    copyAsMarkdown: "Скопировать как Markdown",
    exportMd: "Экспорт .md",
    downloadAsMd: "Скачать как .md",
    save: "Сохранить",
    saving: "Сохранение…",
    summarizing: "Подведение итогов…",
    regenerate: "Перегенерировать",
    runSummary: "Создать резюме",
    summaryFailedEvent: (e: string) => `Не удалось создать резюме: ${e}`,
    summaryReady: "Резюме интервью готово",
    summarizeFailed: (e: string) => `Не удалось подвести итоги. ${e}`,
    summarySaved: "Резюме сохранено",
    saveFailed: (e: string) => `Не удалось сохранить. ${e}`,
    unknown: "неизвестно",
    manualEditsCaveat:
      "Ручные правки этого текста не попадают в синтез цикла, Diff и Чат — там используется машинная версия (см. вкладку «Структура»).",
    markdownPlaceholder:
      "Создайте резюме, чтобы сгенерировать его, затем редактируйте здесь…",
    noSummaryYet: "Резюме пока нет",
    noSummaryDesc:
      "Создайте резюме по интервью, структурированное по целям цикла. Оно питает синтез цикла, и вы можете редактировать его здесь.",
  },
  en: {
    copiedToClipboard: "Copied to clipboard",
    copyFailed: (e: string) => `Couldn't copy. ${e}`,
    noPointsForGoal: "No key points for this goal.",
    questionAnswers: "Question answers",
    hypothesisSignals: "Hypothesis signals",
    notableQuotes: "Notable quotes",
    interviewSummary: "Interview summary",
    summaryDescription:
      "A concise summary structured by your guide's goals — key points, supporting quotes, and surprises. Editable.",
    markdown: "Markdown",
    structure: "Structure",
    copyMd: "Copy .md",
    copyAsMarkdown: "Copy as Markdown",
    exportMd: "Export .md",
    downloadAsMd: "Download as .md",
    save: "Save",
    saving: "Saving…",
    summarizing: "Summarizing…",
    regenerate: "Regenerate",
    runSummary: "Run summary",
    summaryFailedEvent: (e: string) => `Summary failed: ${e}`,
    summaryReady: "Interview summary ready",
    summarizeFailed: (e: string) => `Couldn't summarize. ${e}`,
    summarySaved: "Summary saved",
    saveFailed: (e: string) => `Couldn't save. ${e}`,
    unknown: "unknown",
    manualEditsCaveat:
      "Manual edits to this text don't flow into the cycle synthesis, Diff or Chat — those read the machine version (see the Structure tab).",
    markdownPlaceholder:
      "Run the summary to generate it, then edit here…",
    noSummaryYet: "No summary yet",
    noSummaryDesc:
      "Generate a per-interview summary structured by the cycle's goals. It feeds the cycle synthesis and you can edit it here.",
  },
};

// Stance/status signal labels (ru/en), keyed by the machine value.
const SIGNAL_LABELS: Record<string, Record<Lang, string>> = {
  supports: { ru: "Подтверждает", en: "Supports" },
  contradicts: { ru: "Опровергает", en: "Contradicts" },
  mixed: { ru: "Смешанно", en: "Mixed" },
  neutral: { ru: "Нейтрально", en: "Neutral" },
  direct: { ru: "Прямой ответ", en: "Direct answer" },
  indirect: { ru: "Косвенно", en: "Indirect" },
  not_answered: { ru: "Нет ответа", en: "Not answered" },
};

// ponytail: file-local copy/export helpers, mirroring synthesis-tab.tsx / diff-tab.tsx.
// Factoring the three copies into a shared util is deferred to the export layer.
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

// A small list of supporting quotes. ponytail: segment_id is the array index, not a stable id
// or a timecode — so we render it as a "#N" ref chip rather than a clickable deep-link or a
// real mm:ss timecode. Resolving segment_id → segment start time / a clickable jump needs the
// transcript + stable segment ids (both deferred), so this is the MIN structured render.
function QuoteList({ quotes }: { quotes: InterviewQuote[] }) {
  if (quotes.length === 0) return null;
  return (
    <ul className="flex flex-col gap-1.5">
      {quotes.map((q, i) => (
        <li
          key={i}
          className="flex gap-2 border-l-2 border-border pl-2 text-xs leading-relaxed text-foreground/80"
        >
          <span className="mt-px shrink-0 font-numeric text-[10px] text-muted-foreground/70">
            #{q.segment_id}
          </span>
          <span className="italic">“{q.quote}”</span>
        </li>
      ))}
    </ul>
  );
}

// Stance/status → small colored label, matching synthesis-tab's status-color family.
function SignalLabel({ kind }: { kind: string }) {
  const lang = useUiLang();
  const k = kind.toLowerCase();
  const styles: Record<string, { dot: string; text: string }> = {
    supports: { dot: "bg-status-ready", text: "text-status-ready" },
    contradicts: { dot: "bg-status-error", text: "text-status-error" },
    mixed: { dot: "bg-status-processing", text: "text-muted-foreground" },
    neutral: { dot: "bg-muted-foreground/60", text: "text-muted-foreground" },
    direct: { dot: "bg-status-ready", text: "text-status-ready" },
    indirect: { dot: "bg-status-processing", text: "text-muted-foreground" },
    not_answered: { dot: "bg-status-error", text: "text-status-error" },
  };
  const style = styles[k] ?? { dot: "bg-muted-foreground/60", text: "text-muted-foreground" };
  const m = { label: SIGNAL_LABELS[k]?.[lang] ?? kind, ...style };
  return (
    <span className={cn("inline-flex items-center gap-1.5 text-[11px]", m.text)}>
      <span className={cn("size-1.5 rounded-full", m.dot)} aria-hidden="true" />
      {m.label}
    </span>
  );
}

// MIN structured render of InterviewSummaryDoc: sections by goal (key points + quotes), then
// optional question-answers and hypothesis-signals, then notable quotes. Read-only — editing
// still happens in the markdown view.
function StructuredSummary({ doc }: { doc: InterviewSummaryRow["doc"] }) {
  const t = useT(STR);
  const goalText = useMemo(() => {
    const m = new Map(doc.goals.map((g) => [g.id, g.text]));
    return (id: string) => m.get(id) ?? id;
  }, [doc.goals]);
  const questionText = useMemo(() => {
    const m = new Map((doc.questions ?? []).map((q) => [q.id, q.text]));
    return (id: string) => m.get(id) ?? id;
  }, [doc.questions]);
  const hypothesisText = useMemo(() => {
    const m = new Map((doc.hypotheses ?? []).map((h) => [h.id, h.text]));
    return (id: string) => m.get(id) ?? id;
  }, [doc.hypotheses]);

  const answers = doc.question_answers ?? [];
  const signals = doc.hypothesis_signals ?? [];

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-8">
      {/* By-goal sections. */}
      {doc.by_goal.map((g) => (
        <section key={g.goal_id} className="flex flex-col gap-3">
          <div className="flex items-baseline gap-2">
            <span className="flex items-center gap-1.5 font-numeric text-xs font-medium text-primary">
              <Target className="size-3.5" aria-hidden="true" />
              {g.goal_id}
            </span>
            <h3 className="text-sm font-medium text-foreground">
              {goalText(g.goal_id)}
            </h3>
          </div>
          {g.points.length === 0 ? (
            <p className="pl-6 text-xs text-muted-foreground">
              {t.noPointsForGoal}
            </p>
          ) : (
            <ul className="flex flex-col gap-3 pl-6">
              {g.points.map((p, i) => (
                <li key={i} className="flex flex-col gap-1.5">
                  <span className="text-sm leading-relaxed text-foreground/90">
                    {p.point}
                  </span>
                  <QuoteList quotes={p.quotes} />
                </li>
              ))}
            </ul>
          )}
        </section>
      ))}

      {/* Question answers. */}
      {answers.length > 0 && (
        <section className="flex flex-col gap-3">
          <h3 className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground/70">
            {t.questionAnswers}
          </h3>
          <ul className="flex flex-col gap-3">
            {answers.map((a, i) => (
              <li key={i} className="flex flex-col gap-1.5">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="text-sm leading-relaxed text-foreground/90">
                    <span className="font-numeric text-xs text-muted-foreground">
                      {a.question_id}
                    </span>{" "}
                    {questionText(a.question_id)}
                  </span>
                  <SignalLabel kind={a.status} />
                </div>
                {a.summary && (
                  <p className="text-xs leading-relaxed text-foreground/80">
                    {a.summary}
                  </p>
                )}
                <QuoteList quotes={a.quotes ?? []} />
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* Hypothesis signals. */}
      {signals.length > 0 && (
        <section className="flex flex-col gap-3">
          <h3 className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground/70">
            {t.hypothesisSignals}
          </h3>
          <ul className="flex flex-col gap-3">
            {signals.map((s, i) => (
              <li key={i} className="flex flex-col gap-1.5">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="text-sm leading-relaxed text-foreground/90">
                    <span className="font-numeric text-xs text-muted-foreground">
                      {s.hypothesis_id}
                    </span>{" "}
                    {hypothesisText(s.hypothesis_id)}
                  </span>
                  <SignalLabel kind={s.stance} />
                </div>
                {s.note && (
                  <p className="text-xs leading-relaxed text-foreground/80">
                    {s.note}
                  </p>
                )}
                <QuoteList quotes={s.quotes ?? []} />
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* Notable quotes / surprises. */}
      {doc.notable.length > 0 && (
        <section className="flex flex-col gap-3">
          <h3 className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground/70">
            {t.notableQuotes}
          </h3>
          <ul className="flex flex-col gap-3">
            {doc.notable.map((n, i) => (
              <li
                key={i}
                className="flex flex-col gap-1 border-l-2 border-border pl-2"
              >
                <span className="flex gap-2 text-xs italic leading-relaxed text-foreground/80">
                  <span className="mt-px shrink-0 font-numeric text-[10px] text-muted-foreground/70">
                    #{n.segment_id}
                  </span>
                  “{n.quote}”
                </span>
                {n.note && (
                  <span className="pl-[1.625rem] text-[11px] text-muted-foreground">
                    {n.note}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

// The per-interview "Summary" section (Milestone 10b): the MAP-stage artifact, structured
// by the guide's goals, stored + editable. Run/Regenerate produces it; the user can edit
// the markdown and Save. Mirrors the synthesis-tab artifact UX, scoped to one interview.
export function InterviewSummaryPanel({
  interviewId,
}: {
  interviewId: string;
}) {
  const t = useT(STR);
  const { data: summary, isPending } = useInterviewSummary(interviewId);
  const runSummary = useRunInterviewSummary(interviewId);
  const saveSummary = useSaveInterviewSummary(interviewId);

  const [progress, setProgress] = useState<InterviewSummaryProgress | null>(
    null,
  );
  const [draft, setDraft] = useState("");
  const [dirty, setDirty] = useState(false);
  const [editorKey, setEditorKey] = useState(0);
  const [view, setView] = useState<"markdown" | "structured">("markdown");

  const storedMd = summary?.content_md ?? "";
  useEffect(() => {
    setDraft(storedMd);
    setDirty(false);
    setEditorKey((k) => k + 1);
  }, [storedMd]);

  // Guard the unsaved markdown draft: warn on window close/reload while dirty. (Router-level
  // navigation guard is deferred — it needs a shared blocker the whole app opts into; mirrors
  // synthesis-tab.tsx.)
  useEffect(() => {
    if (!dirty) return;
    function onBeforeUnload(e: BeforeUnloadEvent) {
      e.preventDefault();
      e.returnValue = "";
    }
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [dirty]);

  // Subscribe to per-interview summary progress.
  useEffect(() => {
    function onProgress(p: InterviewSummaryProgress) {
      if (p.interview_id !== interviewId) return;
      if (p.stage === "done" || p.stage === "error") {
        setProgress(null);
        if (p.stage === "error") {
          toast.error(t.summaryFailedEvent(p.error ?? t.unknown));
        }
      } else {
        setProgress(p);
      }
    }
    if (!IN_TAURI) {
      return mockOnInterviewSummaryProgress(onProgress);
    }
    const unlisten = getCurrentWebview().listen<InterviewSummaryProgress>(
      INTERVIEW_SUMMARY_PROGRESS_EVENT,
      (e) => onProgress(e.payload),
    );
    return () => {
      unlisten.then((fn) => fn());
    };
  }, [interviewId, t]);

  const running = runSummary.isPending || progress != null;
  const hasSummary = !!summary && storedMd.trim().length > 0;

  async function handleRun() {
    setProgress({
      interview_id: interviewId,
      stage: "running",
      progress: 10,
      error: null,
    });
    try {
      await runSummary.mutateAsync();
      toast.success(t.summaryReady);
    } catch (e) {
      setProgress(null);
      toast.error(t.summarizeFailed(String(e)));
    }
  }

  async function handleSave() {
    try {
      await saveSummary.mutateAsync(draft);
      setDirty(false);
      toast.success(t.summarySaved);
    } catch (e) {
      toast.error(t.saveFailed(String(e)));
    }
  }

  return (
    <div className="mx-auto flex h-full max-w-3xl flex-col gap-4 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-col gap-0.5">
          <h3 className="text-sm font-medium text-foreground">
            {t.interviewSummary}
          </h3>
          <p className="text-xs text-muted-foreground">
            {t.summaryDescription}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {hasSummary && (
            <>
              <div className="flex items-center rounded-md border border-border p-0.5">
                <button
                  type="button"
                  onClick={() => setView("markdown")}
                  className={cn(
                    "flex items-center gap-1.5 rounded px-2 py-1 text-xs transition-colors",
                    view === "markdown"
                      ? "bg-secondary text-foreground"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  <FileText className="size-3.5" />
                  {t.markdown}
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
                  {t.structure}
                </button>
              </div>
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
                onClick={() => exportMarkdown(draft || storedMd, "interview-summary.md")}
                title={t.downloadAsMd}
              >
                <Download className="size-3.5" />
                {t.exportMd}
              </Button>
              {view === "markdown" && (
                <Button
                  size="sm"
                  variant={dirty ? "default" : "outline"}
                  onClick={handleSave}
                  disabled={!dirty || saveSummary.isPending}
                >
                  <Save className="size-3.5" />
                  {saveSummary.isPending ? t.saving : t.save}
                </Button>
              )}
            </>
          )}
          <Button size="sm" variant={hasSummary ? "outline" : "default"} onClick={handleRun} disabled={running}>
            {running ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Sparkles className="size-4" />
            )}
            {running
              ? t.summarizing
              : hasSummary
                ? t.regenerate
                : t.runSummary}
          </Button>
        </div>
      </div>

      {running && (
        <div className="h-1 w-full overflow-hidden rounded-full bg-secondary/60">
          <div
            className="h-full rounded-full bg-primary transition-all duration-500"
            style={{ width: `${progress?.progress ?? 5}%` }}
          />
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto">
        {isPending ? (
          <div className="flex flex-col gap-3">
            <Skeleton className="h-6 w-48" />
            <Skeleton className="h-24 w-full" />
          </div>
        ) : hasSummary ? (
          view === "structured" ? (
            <StructuredSummary doc={summary!.doc} />
          ) : (
            <div className="flex flex-col gap-3">
              {/* MIN caveat (theme C): manual markdown edits never flow back into the structured
                  doc / findings_json, so the cycle synthesis, Diff and Chat keep reading the
                  machine version. No edit-timestamp field exists, so this is a static caveat.
                  Mirrors the synthesis-tab caveat. */}
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
                placeholder={t.markdownPlaceholder}
              />
            </div>
          )
        ) : (
          <div className="flex max-w-md flex-col items-start gap-3 rounded-lg border border-dashed border-border px-6 py-8">
            <div className="flex flex-col gap-1">
              <p className="text-sm font-medium text-foreground">
                {t.noSummaryYet}
              </p>
              <p className="text-xs text-muted-foreground">
                {t.noSummaryDesc}
              </p>
            </div>
          </div>
        )}

        {/* Guide coverage (v3 F2): "did we ask everything?" — collapsible, below the
            summary content so it's reachable whether or not a summary exists yet. */}
        <div className="mt-6 border-t border-border pt-4">
          <CoveragePanel interviewId={interviewId} />
        </div>
      </div>
    </div>
  );
}
