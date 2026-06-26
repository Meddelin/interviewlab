import { useEffect, useState } from "react";
import { Loader2, Save, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { MarkdownEditor } from "@/components/markdown-editor";
import {
  useInterviewSummary,
  useRunInterviewSummary,
  useSaveInterviewSummary,
} from "@/lib/synthesis-queries";
import { useSynthesisRunStore } from "@/lib/synthesis-run-store";

// The per-interview "Summary" section (Milestone 10b): the MAP-stage artifact, structured
// by the guide's goals, stored + editable. Run/Regenerate produces it; the user can edit
// the markdown and Save. Mirrors the synthesis-tab artifact UX, scoped to one interview.
export function InterviewSummaryPanel({
  interviewId,
}: {
  interviewId: string;
}) {
  const { data: summary, isPending } = useInterviewSummary(interviewId);
  const runSummary = useRunInterviewSummary(interviewId);
  const saveSummary = useSaveInterviewSummary(interviewId);

  // Run progress lives in the GLOBAL synthesis-run store so it survives navigation: the
  // app-level useSynthesisRuns listener feeds it, and the panel seeds/clears it on start/fail.
  const progress =
    useSynthesisRunStore((s) => s.summaryByInterview[interviewId]) ?? null;
  const startSummary = useSynthesisRunStore((s) => s.startSummary);
  const endSummary = useSynthesisRunStore((s) => s.endSummary);
  const [draft, setDraft] = useState("");
  const [dirty, setDirty] = useState(false);
  const [editorKey, setEditorKey] = useState(0);

  const storedMd = summary?.content_md ?? "";
  useEffect(() => {
    setDraft(storedMd);
    setDirty(false);
    setEditorKey((k) => k + 1);
  }, [storedMd]);

  // Terminal handling (clear progress + refresh the summary) lives in the app-level
  // useSynthesisRuns listener, so it works even if this panel is unmounted mid-run.
  const running = progress != null;
  const hasSummary = !!summary && storedMd.trim().length > 0;

  async function handleRun() {
    // Seed the global run state so the "running" UI persists across navigation.
    startSummary(interviewId);
    try {
      await runSummary.mutateAsync();
      toast.success("Interview summary ready");
    } catch (e) {
      endSummary(interviewId);
      toast.error(`Couldn't summarize. ${String(e)}`);
    }
  }

  async function handleSave() {
    try {
      await saveSummary.mutateAsync(draft);
      setDirty(false);
      toast.success("Summary saved");
    } catch (e) {
      toast.error(`Couldn't save. ${String(e)}`);
    }
  }

  return (
    <div className="mx-auto flex h-full max-w-3xl flex-col gap-4 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-col gap-0.5">
          <h3 className="text-sm font-medium text-foreground">
            Interview summary
          </h3>
          <p className="text-xs text-muted-foreground">
            A concise summary structured by your guide's goals — key points,
            supporting quotes, and surprises. Editable.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {hasSummary && (
            <Button
              size="sm"
              variant={dirty ? "default" : "outline"}
              onClick={handleSave}
              disabled={!dirty || saveSummary.isPending}
            >
              <Save className="size-3.5" />
              {saveSummary.isPending ? "Saving…" : "Save"}
            </Button>
          )}
          <Button size="sm" variant={hasSummary ? "outline" : "default"} onClick={handleRun} disabled={running}>
            {running ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Sparkles className="size-4" />
            )}
            {running
              ? "Summarizing…"
              : hasSummary
                ? "Regenerate"
                : "Run summary"}
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
          <MarkdownEditor
            key={editorKey}
            value={draft}
            onChange={(md) => {
              setDraft(md);
              setDirty(true);
            }}
            placeholder="Run the summary to generate it, then edit here…"
          />
        ) : (
          <div className="flex max-w-md flex-col items-start gap-3 rounded-lg border border-dashed border-border px-6 py-8">
            <div className="flex flex-col gap-1">
              <p className="text-sm font-medium text-foreground">
                No summary yet
              </p>
              <p className="text-xs text-muted-foreground">
                Generate a per-interview summary structured by the cycle's
                goals. It feeds the cycle synthesis and you can edit it here.
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
