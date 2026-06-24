import { useEffect, useMemo, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { useQueryClient } from "@tanstack/react-query";
import {
  FileText,
  LayoutList,
  Lightbulb,
  Loader2,
  Quote,
  Save,
  Sparkles,
  Target,
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
import {
  synthesisKeys,
  useCycleGoals,
  useRunSynthesis,
  useSaveCycleSynthesis,
  useSynthesis,
} from "@/lib/synthesis-queries";
import {
  IN_TAURI,
  SYNTHESIS_PROGRESS_EVENT,
  type Evidence,
  type Finding,
  type Goal,
  type RoleBreakdownGroup,
  type SynthesisProgress,
  type SynthesisRow,
} from "@/lib/tauri";
// dev-mock: browser-only, never active under Tauri.
import { mockOnSynthesisProgress } from "@/lib/dev-mock";
import { absoluteDate } from "@/lib/format";
import { cn } from "@/lib/utils";

// Confidence → badge styling. Muted palette to fit the Linear bar: high reads in the
// accent, medium neutral, low quiet.
function ConfidenceBadge({ confidence }: { confidence: string }) {
  const c = confidence.toLowerCase();
  const label = c.charAt(0).toUpperCase() + c.slice(1);
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
      {label} confidence
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
  return (
    <li className="flex gap-2.5">
      <Quote
        className="mt-0.5 size-3.5 shrink-0 text-muted-foreground/50"
        aria-hidden="true"
      />
      <div className="flex flex-col gap-1">
        <p className="text-sm leading-relaxed text-foreground/90">
          {evidence.quote ? `“${evidence.quote}”` : "(quote unavailable)"}
        </p>
        <button
          type="button"
          onClick={onOpen}
          className="w-fit text-left text-xs text-muted-foreground transition-colors hover:text-foreground"
        >
          {interviewTitle}
          <span className="text-muted-foreground/50">
            {" "}
            · segment {evidence.segment_id + 1}
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
            {finding.support_count} interview
            {finding.support_count === 1 ? "" : "s"}
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
          No findings surfaced for this goal in this wave.
        </p>
      ) : (
        <div className="flex flex-col gap-3 pl-6">
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
            By role
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

// Human-readable stage label for the live progress line.
function stageLabel(stage: string): string {
  if (stage === "extract") return "Reading interviews";
  if (stage === "reduce") return "Synthesizing findings";
  if (stage === "done") return "Done";
  return "Working";
}

// Which view of the cycle synthesis is shown: the editable markdown artifact (default) or
// the structured findings-by-goal view (read-only, the same data the diff reads).
type View = "artifact" | "structured";

export function SynthesisTab({ cycleId }: { cycleId: string }) {
  const navigate = useNavigate();
  const location = useLocation();
  const qc = useQueryClient();
  const { data: synthesis, isPending } = useSynthesis(cycleId);
  const { data: goals } = useCycleGoals(cycleId);
  const { data: interviews } = useInterviews(cycleId);
  const runSynthesis = useRunSynthesis(cycleId);
  const saveArtifact = useSaveCycleSynthesis(cycleId);

  // Live stage progress (null when idle).
  const [progress, setProgress] = useState<SynthesisProgress | null>(null);
  const [view, setView] = useState<View>("artifact");

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
    return (id: string) => map.get(id) ?? `Interview ${id.slice(0, 8)}`;
  }, [interviews]);

  // Seed the markdown draft from the stored artifact whenever it (re)loads.
  const storedMd = synthesis?.content_md ?? "";
  useEffect(() => {
    setDraft(storedMd);
    setDirty(false);
    setEditorKey((k) => k + 1);
  }, [storedMd]);

  // Subscribe to synthesis progress; clear on a terminal stage + refresh the synthesis.
  useEffect(() => {
    function onProgress(p: SynthesisProgress) {
      if (p.cycle_id !== cycleId) return;
      if (p.stage === "done" || p.stage === "error") {
        setProgress(null);
        qc.invalidateQueries({ queryKey: synthesisKeys.detail(cycleId) });
        if (p.stage === "error") {
          toast.error(`Synthesis failed: ${p.error ?? "unknown"}`);
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
  }, [cycleId, qc]);

  const running = runSynthesis.isPending || progress != null;

  async function handleRun() {
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
      toast.success(
        `Synthesis complete — ${row.doc.findings.length} finding${
          row.doc.findings.length === 1 ? "" : "s"
        } across ${row.doc.goals.length} goals.`,
      );
    } catch (e) {
      setProgress(null);
      toast.error(`Couldn't synthesize. ${String(e)}`);
    }
  }

  async function handleSave() {
    try {
      await saveArtifact.mutateAsync(draft);
      setDirty(false);
      toast.success("Synthesis saved");
    } catch (e) {
      toast.error(`Couldn't save. ${String(e)}`);
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
            Cycle synthesis
          </h2>
          <p className="text-xs text-muted-foreground">
            {hasSynthesis
              ? `Last synthesized ${absoluteDate(synthesis!.created_at)}.`
              : `An editable report across this wave's interviews, tied to your ${
                  groupGoals.length || ""
                } guide goal${groupGoals.length === 1 ? "" : "s"}.`}
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
                Artifact
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
                Findings
              </button>
            </div>
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
                {hasSynthesis ? "Re-run synthesis" : "Run synthesis"}
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

      {/* Body. */}
      {!hasSynthesis ? (
        <EmptyState goals={groupGoals} running={running} />
      ) : view === "artifact" ? (
        // The editable cycle markdown artifact (Plate). Edit + Save (the user owns it).
        <div className="flex max-w-3xl flex-col gap-3">
          <div className="flex items-center justify-between">
            <p className="text-xs text-muted-foreground">
              The editable report. Re-running regenerates it; your edits are saved.
            </p>
            <Button
              size="sm"
              variant={dirty ? "default" : "outline"}
              onClick={handleSave}
              disabled={!dirty || saveArtifact.isPending}
            >
              <Save className="size-3.5" />
              {saveArtifact.isPending ? "Saving…" : "Save"}
            </Button>
          </div>
          <MarkdownEditor
            key={editorKey}
            value={draft}
            onChange={(md) => {
              setDraft(md);
              setDirty(true);
            }}
            placeholder="Run synthesis to generate the report, then edit it here…"
          />
        </div>
      ) : (
        // The structured findings-by-goal view (read-only; the data the diff compares).
        <div className="flex max-w-2xl flex-col gap-8">
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
                Open questions
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
  if (running) {
    return (
      <div className="flex max-w-md flex-col items-start gap-2 rounded-lg border border-dashed border-border px-6 py-10">
        <Loader2 className="size-4 animate-spin text-muted-foreground" />
        <p className="text-sm text-muted-foreground">
          Synthesizing findings across this wave's interviews…
        </p>
      </div>
    );
  }
  return (
    <div className="flex max-w-md flex-col items-start gap-4 rounded-lg border border-dashed border-border px-6 py-8">
      <div className="flex flex-col gap-1">
        <p className="text-sm font-medium text-foreground">No synthesis yet</p>
        <p className="text-xs text-muted-foreground">
          Run synthesis to assemble an editable report across this wave's
          interviews — tied to your guide's goals, with evidence quotes you can
          trace and a by-role breakdown.
        </p>
      </div>
      {goals.length > 0 ? (
        <div className="flex w-full flex-col gap-2">
          <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground/70">
            Grounded on {goals.length} goal{goals.length === 1 ? "" : "s"}
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
          Add a <span className="text-foreground">Goals</span> section to the
          interview guide on the Overview tab first.
        </p>
      )}
    </div>
  );
}
