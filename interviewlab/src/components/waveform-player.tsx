import {
  forwardRef,
  type KeyboardEvent,
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
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";

const STR = {
  ru: {
    position: "Позиция воспроизведения",
    valueText: (cur: string, total: string) => `${cur} из ${total}`,
    pause: "Пауза",
    play: "Воспроизвести",
    restart: "В начало",
  },
  en: {
    position: "Playback position",
    valueText: (cur: string, total: string) => `${cur} of ${total}`,
    pause: "Pause",
    play: "Play",
    restart: "Restart",
  },
} as const;

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
  const t = useT(STR);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [currentMs, setCurrentMs] = useState(0);

  // Colors resolved once per mount from the active theme.
  const colors = useMemo(
    () => ({
      wave: themeColor("--muted-foreground", "#6b6e76"),
      progress: themeColor("--accent", "#5e6ad2"),
      cursor: themeColor("--foreground", "#e6e7ea"),
    }),
    [],
  );

  const { wavesurfer, isPlaying, isReady } = useWavesurfer({
    container: containerRef,
    url,
    height: 72,
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

  // Seek to an absolute ms position (clamped), keeping the label in sync. Used by the
  // keyboard slider handler below.
  const seekToMs = useCallback(
    (ms: number) => {
      if (!wavesurfer) return;
      const dur = wavesurfer.getDuration();
      if (dur <= 0) return;
      const clamped = Math.min(dur * 1000, Math.max(0, ms));
      wavesurfer.seekTo(clamped / 1000 / dur);
      setCurrentMs(Math.round(clamped));
    },
    [wavesurfer],
  );

  // Keyboard control for the waveform as an ARIA slider over playback position.
  // ←/→ nudge by 5s, ↑/↓ by 1s, PageUp/Down by 30s, Home/End to ends, Space toggles play.
  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLDivElement>) => {
      if (!isReady || !wavesurfer) return;
      switch (e.key) {
        case "ArrowRight":
          seekToMs(currentMs + 5000);
          break;
        case "ArrowLeft":
          seekToMs(currentMs - 5000);
          break;
        case "ArrowUp":
          seekToMs(currentMs + 1000);
          break;
        case "ArrowDown":
          seekToMs(currentMs - 1000);
          break;
        case "PageUp":
          seekToMs(currentMs + 30000);
          break;
        case "PageDown":
          seekToMs(currentMs - 30000);
          break;
        case "Home":
          seekToMs(0);
          break;
        case "End":
          seekToMs(totalMs);
          break;
        case " ":
        case "Enter":
          wavesurfer.playPause();
          break;
        default:
          return; // let other keys (Tab etc.) through
      }
      e.preventDefault();
    },
    [isReady, wavesurfer, currentMs, totalMs, seekToMs],
  );

  return (
    <div className="flex flex-col gap-3">
      <div className="relative">
        <div
          ref={containerRef}
          role="slider"
          tabIndex={isReady ? 0 : -1}
          aria-label={t.position}
          aria-valuemin={0}
          aria-valuemax={Math.round(totalMs / 1000)}
          aria-valuenow={Math.round(currentMs / 1000)}
          aria-valuetext={t.valueText(formatTimecode(currentMs), formatTimecode(totalMs))}
          onKeyDown={handleKeyDown}
          className="w-full rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
        />
        {!isReady && (
          <div className="pointer-events-none absolute inset-0 flex items-center">
            {/* Quiet skeleton bars while the audio decodes — no spinner. */}
            <div className="flex h-[72px] w-full items-end gap-[2px] opacity-40">
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
          aria-label={isPlaying ? t.pause : t.play}
          disabled={!isReady}
          onClick={() => wavesurfer?.playPause()}
        >
          {isPlaying ? <Pause className="size-3.5" /> : <Play className="size-3.5" />}
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={t.restart}
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
