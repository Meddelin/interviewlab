import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import { useWavesurfer } from "@wavesurfer/react";
import { Pause, Play, SkipBack } from "lucide-react";
import { Button } from "@/components/ui/button";
import { formatTimecode } from "@/lib/format";
import { cn } from "@/lib/utils";

// Imperative handle so the segment list can drive the player (seek on segment click).
export type WaveformHandle = {
  seekTo: (ms: number) => void;
  playFrom: (ms: number) => void;
  pause: () => void;
};

// Read the accent/muted colors off CSS vars so the waveform matches the theme exactly
// (wavesurfer needs concrete color strings, not CSS variables).
function themeColor(varName: string, fallback: string): string {
  if (typeof window === "undefined") return fallback;
  const v = getComputedStyle(document.documentElement)
    .getPropertyValue(varName)
    .trim();
  return v || fallback;
}

// The media player: a wavesurfer waveform + transport. `url` is the audio source
// (convertFileSrc under Tauri; a data URI in the browser mock). `onTime` streams the
// current playback position in ms so the parent can highlight the active segment.
export const WaveformPlayer = forwardRef<
  WaveformHandle,
  {
    url: string;
    durationMs: number | null;
    onTime?: (ms: number) => void;
    // Streams play/pause state so the segment list can flip its per-row play affordance
    // to a Pause icon for the row that's currently playing.
    onPlayingChange?: (playing: boolean) => void;
  }
>(function WaveformPlayer({ url, durationMs, onTime, onPlayingChange }, ref) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [currentMs, setCurrentMs] = useState(0);

  // Colors resolved once per mount from the active theme.
  const colors = useMemo(
    () => ({
      wave: themeColor("--text-muted", "#6b6e76"),
      progress: themeColor("--accent", "#5e6ad2"),
      cursor: themeColor("--foreground", "#e6e7ea"),
    }),
    [],
  );

  const { wavesurfer, isPlaying, isReady } = useWavesurfer({
    container: containerRef,
    url,
    height: 56,
    waveColor: colors.wave,
    progressColor: colors.progress,
    cursorColor: colors.cursor,
    cursorWidth: 1,
    barWidth: 2,
    barGap: 2,
    barRadius: 2,
    normalize: true,
    interact: true,
  });

  // Stream playback position (ms) to the parent for active-segment highlighting.
  const handleTimeupdate = useCallback(
    (s: number) => {
      const ms = Math.round(s * 1000);
      setCurrentMs(ms);
      onTime?.(ms);
    },
    [onTime],
  );

  // Wire wavesurfer's timeupdate once it's available.
  useEffect(() => {
    if (!wavesurfer) return;
    const un = wavesurfer.on("timeupdate", handleTimeupdate);
    return un;
  }, [wavesurfer, handleTimeupdate]);

  // Mirror play/pause state up so the segment list can show a Pause icon on the
  // currently-playing row (wavesurfer is the source of truth — don't fight it).
  useEffect(() => {
    onPlayingChange?.(isPlaying);
  }, [isPlaying, onPlayingChange]);

  useImperativeHandle(
    ref,
    () => ({
      seekTo: (ms: number) => {
        if (!wavesurfer) return;
        const dur = wavesurfer.getDuration();
        if (dur > 0) wavesurfer.seekTo(Math.min(1, Math.max(0, ms / 1000 / dur)));
        setCurrentMs(ms);
      },
      playFrom: (ms: number) => {
        if (!wavesurfer) return;
        const dur = wavesurfer.getDuration();
        if (dur > 0) wavesurfer.seekTo(Math.min(1, Math.max(0, ms / 1000 / dur)));
        setCurrentMs(ms);
        wavesurfer.play();
      },
      pause: () => {
        wavesurfer?.pause();
      },
    }),
    [wavesurfer],
  );

  // Prefer wavesurfer's decoded duration; fall back to the DB duration for the label.
  const totalMs =
    isReady && wavesurfer ? Math.round(wavesurfer.getDuration() * 1000) : durationMs ?? 0;

  return (
    <div className="flex flex-col gap-3">
      <div className="relative">
        <div ref={containerRef} className="w-full" />
        {!isReady && (
          <div className="pointer-events-none absolute inset-0 flex items-center">
            {/* Quiet skeleton bars while the audio decodes — no spinner. */}
            <div className="flex h-[56px] w-full items-end gap-[2px] opacity-40">
              {Array.from({ length: 64 }).map((_, i) => (
                <span
                  key={i}
                  className="flex-1 rounded-sm bg-muted-foreground/30"
                  style={{ height: `${20 + ((i * 37) % 70)}%` }}
                />
              ))}
            </div>
          </div>
        )}
      </div>

      <div className="flex items-center gap-2">
        <Button
          variant="secondary"
          size="icon-sm"
          aria-label={isPlaying ? "Pause" : "Play"}
          disabled={!isReady}
          onClick={() => wavesurfer?.playPause()}
        >
          {isPlaying ? <Pause className="size-3.5" /> : <Play className="size-3.5" />}
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Restart"
          disabled={!isReady}
          className="text-muted-foreground"
          onClick={() => {
            wavesurfer?.seekTo(0);
            setCurrentMs(0);
          }}
        >
          <SkipBack className="size-3.5" />
        </Button>
        <span className="ml-auto font-numeric text-xs text-muted-foreground tabular-nums">
          <span className={cn(currentMs > 0 && "text-foreground/80")}>
            {formatTimecode(currentMs)}
          </span>
          <span className="px-1 text-muted-foreground/50">/</span>
          {formatTimecode(totalMs)}
        </span>
      </div>
    </div>
  );
});
