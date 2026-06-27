// Small, dependency-free formatters for the domain's data: timecodes, durations,
// and relative dates. Numbers render mono/tabular at the call site (font-numeric).

import { tr } from "@/lib/i18n";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

const STR = {
  ru: {
    justNow: "только что",
    minAgo: (m: number) => `${m} мин назад`,
    hAgo: (h: number) => `${h} ч назад`,
    dAgo: (d: number) => `${d} дн назад`,
  },
  en: {
    justNow: "just now",
    minAgo: (m: number) => `${m}m ago`,
    hAgo: (h: number) => `${h}h ago`,
    dAgo: (d: number) => `${d}d ago`,
  },
} as const;

// "2 ч назад", "3 дн назад", "только что" — compact relative time for list metadata.
export function relativeTime(ms: number, now = Date.now()): string {
  const t = tr(STR);
  const diff = now - ms;
  if (diff < 45 * 1000) return t.justNow;
  if (diff < HOUR) {
    const m = Math.round(diff / MIN);
    return t.minAgo(m);
  }
  if (diff < DAY) {
    const h = Math.round(diff / HOUR);
    return t.hAgo(h);
  }
  if (diff < 30 * DAY) {
    const d = Math.round(diff / DAY);
    return t.dAgo(d);
  }
  // Older than a month: fall back to an absolute, unambiguous date.
  return new Date(ms).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

// Absolute date for tooltips / secondary metadata.
export function absoluteDate(ms: number): string {
  return new Date(ms).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

// Media duration as a timecode: "42:18" or "1:02:09". Null → an em dash.
export function formatDuration(ms: number | null): string {
  if (ms == null) return "—";
  const total = Math.round(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = m.toString().padStart(h > 0 ? 2 : 1, "0");
  const ss = s.toString().padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

// A playback/segment timecode: "0:00", "0:42", "1:02:09". Like formatDuration but a
// null/0 reads as "0:00" (the player/segment list always wants a concrete time).
export function formatTimecode(ms: number | null): string {
  return formatDuration(ms ?? 0);
}
