import { useEffect, useRef, useState } from "react";
import { Loader2, Square, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { Segment } from "@/lib/tauri";
import { formatTimecode } from "@/lib/format";
import { cn } from "@/lib/utils";

// Read-only live view shown in the editor's right pane WHILE a transcription is running, so a
// slow (e.g. Mac CPU) run can be watched filling in instead of being a black box. Two phases:
//   • Transcribing — whisper's real 0..100 progress + the transcript accumulating line by line.
//   • Diarizing    — the post-whisper speaker pass. Its engine call is opaque (no inner %), so
//     we show an HONEST elapsed timer + a duration-based ESTIMATE bar, not a fake exact percent.
// When the run finishes the editor swaps this out for the stored, editable transcript.

// Re-render on a timer while a phase needs a live elapsed readout. 500ms is smooth enough for a
// seconds clock without churning. Returns the current epoch ms.
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(id);
  }, [active]);
  return now;
}

function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export function LiveTranscriptView({
  segments,
  progress,
  diarActive,
  diarStartedAt,
  speakers,
  durationMs,
  onStop,
}: {
  segments: Segment[];
  progress: number; // whisper 0..100
  diarActive: boolean;
  diarStartedAt: number | null;
  speakers: number | null;
  durationMs: number | null;
  onStop: () => void;
}) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  // Auto-follow the tail as new segments stream in, but only when the user is already near the
  // bottom — so scrolling up to re-read an earlier line isn't yanked back down.
  const stickToBottom = useRef(true);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !stickToBottom.current) return;
    el.scrollTop = el.scrollHeight;
  }, [segments.length]);

  function onScroll() {
    const el = scrollRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    stickToBottom.current = distanceFromBottom < 80;
  }

  // Diarization estimate. Diar runtime scales ~with audio length; ~0.35× real-time is a safe
  // over-estimate on CPU (the bar creeps toward — never past — 95% so it can't claim "done"
  // early), then snaps to complete when the run moves on. Clearly an estimate, not a true %.
  const now = useNow(diarActive);
  const diarElapsed = diarStartedAt ? now - diarStartedAt : 0;
  const diarEstimate = Math.max(8000, (durationMs ?? 0) * 0.35);
  const diarPct = diarActive
    ? Math.min(95, Math.round((diarElapsed / diarEstimate) * 100))
    : 0;

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Live status bar — phase, progress, and a Stop. */}
      <div className="flex flex-col gap-2 border-b border-border px-4 py-2.5">
        <div className="flex items-center gap-2">
          {diarActive ? (
            <Users className="size-3.5 shrink-0 text-status-processing" />
          ) : (
            <Loader2 className="size-3.5 shrink-0 animate-spin text-status-processing" />
          )}
          <span className="text-xs font-medium text-foreground">
            {diarActive ? "Diarizing — identifying speakers" : "Transcribing"}
          </span>
          <span className="font-numeric text-xs tabular-nums text-muted-foreground">
            {diarActive
              ? `~${diarPct}% · ${formatElapsed(diarElapsed)}`
              : `${Math.max(0, Math.min(100, progress))}%`}
          </span>
          <span className="ml-auto flex items-center gap-3">
            <span className="text-xs text-muted-foreground">
              <span className="font-numeric tabular-nums text-foreground/70">
                {segments.length}
              </span>{" "}
              segment{segments.length === 1 ? "" : "s"}
            </span>
            <Button
              variant="ghost"
              size="xs"
              className="text-status-error"
              onClick={onStop}
              aria-label="Stop transcription"
            >
              <Square className="size-3 fill-current" />
              Stop
            </Button>
          </span>
        </div>
        {/* Progress bar: whisper's real percent, or the diarization estimate. */}
        <div className="h-1 w-full overflow-hidden rounded-full bg-secondary">
          <div
            className={cn(
              "h-full rounded-full bg-primary transition-[width] duration-300",
              diarActive && "opacity-70",
            )}
            style={{
              width: `${diarActive ? diarPct : Math.max(0, Math.min(100, progress))}%`,
            }}
          />
        </div>
        {diarActive && (
          <p className="text-[11px] text-muted-foreground">
            Transcript is complete — assigning speakers now. This runs on the CPU and can take a
            while on long recordings.
          </p>
        )}
        {speakers != null && !diarActive && (
          <p className="text-[11px] text-muted-foreground">
            {speakers} speaker{speakers === 1 ? "" : "s"} detected.
          </p>
        )}
      </div>

      {/* The accumulating transcript (read-only). Speakers aren't known until diarization, so
          this is a plain timecode + text feed; the editable, speaker-grouped view loads once
          the run finishes. */}
      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="min-h-0 flex-1 overflow-y-auto px-4 py-3"
      >
        {segments.length === 0 ? (
          <div className="flex h-full items-center justify-center">
            <p className="text-sm text-muted-foreground">
              {diarActive
                ? "Wrapping up…"
                : "Waiting for the first words…"}
            </p>
          </div>
        ) : (
          <div className="flex max-w-3xl flex-col gap-1.5">
            {segments.map((seg, i) => (
              <div
                key={`${seg.start_ms}-${i}`}
                className="grid grid-cols-[auto_1fr] gap-x-3 rounded-md px-2 py-1 hover:bg-secondary/60"
              >
                <span className="pt-0.5 font-numeric text-[11px] tabular-nums text-muted-foreground/70">
                  {formatTimecode(seg.start_ms)}
                </span>
                <span className="text-[13.5px] leading-relaxed text-foreground/90">
                  {seg.text}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
