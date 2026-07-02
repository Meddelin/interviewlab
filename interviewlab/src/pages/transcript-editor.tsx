import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useBlocker, useNavigate, useParams } from "react-router-dom";
import { convertFileSrc } from "@tauri-apps/api/core";
import {
  ArrowLeft,
  Check,
  ChevronDown,
  ChevronUp,
  FileText,
  GitCompareArrows,
  ListTree,
  Loader2,
  Pause,
  Play,
  Plus,
  RotateCcw,
  Save,
  Search,
  Trash2,
  Undo2,
  Users,
  Wand2,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import { RoleChip } from "@/components/role-chip";
import { InterviewSummaryPanel } from "@/components/interview-summary-panel";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { useRoles } from "@/lib/role-queries";
import type { Role } from "@/lib/tauri";
import {
  WaveformPlayer,
  type WaveformHandle,
} from "@/components/waveform-player";
import { useInterviews } from "@/lib/interview-queries";
import { useCycle } from "@/lib/cycle-queries";
import {
  useParticipants,
  useSaveEditedTranscript,
  useTranscribeCheckpoint,
  useTranscriptVersion,
  useTranscriptVersions,
} from "@/lib/transcript-queries";
import { useUiStore } from "@/lib/ui-store";
import { useModels } from "@/lib/asr-queries";
import type {
  InterviewRow,
  Participant,
  ParticipantInput,
  Segment,
} from "@/lib/tauri";
import {
  cancelTranscription,
  IN_TAURI,
  resumeTranscription,
  retranscribeRange,
  rewriteSegment,
} from "@/lib/tauri";
import { EMPTY_LIVE_ASR, useLiveAsrStore } from "@/lib/live-asr-store";
import { LiveTranscriptView } from "@/components/live-transcript-view";
import { mockAudioSrc } from "@/lib/dev-mock";
import { formatTimecode } from "@/lib/format";
import { mod } from "@/lib/platform";
import { wordDiff, textChanged } from "@/lib/word-diff";
import { cn } from "@/lib/utils";
import { useT, tr, currentLang } from "@/lib/i18n";

// A local, editable participant (id may be a client temp id until saved). `role` is now a
// role-library id (M10a) rather than the old fixed enum; seeded ids equal the old enum
// text so legacy participants still resolve.
type DraftParticipant = {
  id: string;
  display_name: string;
  role: string; // role-library id
  speaker_label: string | null;
};

function toDraft(p: Participant): DraftParticipant {
  return {
    id: p.id,
    display_name: p.display_name,
    // Prefer the role-LIBRARY id (the FK the UI resolves against `roles`); fall back to the
    // legacy `role` string so old rows where `role` already held an id still resolve.
    role: p.role_id ?? p.role,
    speaker_label: p.speaker_label,
  };
}

// Resolve a role id → its library row (color + label). Returns undefined for an unknown id.
function lookupRole(roles: Role[], id: string | undefined): Role | undefined {
  if (!id) return undefined;
  return roles.find((r) => r.id === id);
}

// ponytail: tiny inline plural for "segment" — RU has three forms
// (1 сегмент / 2 сегмента / 5 сегментов), EN two (segment / segments).
// Reads the current UI language straight from the store (non-hook callers below).
function pluralSegments(n: number): string {
  if (currentLang() === "en") return n === 1 ? "segment" : "segments";
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return "сегмент";
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return "сегмента";
  return "сегментов";
}

// ─── Coalesce micro-segments into readable paragraphs ──────────────────────────
// Whisper emits very fine segments (2–5s); displayed raw, a diarized interview is a wall of
// tiny textareas. Merge a run of consecutive segments into ONE paragraph when they share the
// same speaker_label AND the inter-segment gap is small. A larger gap starts a new paragraph
// even for the same speaker, so a monologue splits into natural paragraphs instead of one
// giant box. Presentation/data layer for the EDITOR only — raw/cleaned stay untouched in the
// DB; saving the edited version persists these coalesced (paragraph-level) segments.
// ponytail: 1500ms is the tunable knob — the max same-speaker gap that still reads as one
// paragraph. Below it we glue; at/above it we break.
const COALESCE_GAP_MS = 1500;
function coalesceSegments(segs: Segment[]): Segment[] {
  const out: Segment[] = [];
  for (const seg of segs) {
    const cur = out[out.length - 1];
    if (
      cur &&
      cur.speaker_label === seg.speaker_label &&
      seg.start_ms - cur.end_ms < COALESCE_GAP_MS
    ) {
      cur.end_ms = seg.end_ms;
      cur.text = `${cur.text} ${seg.text.trim()}`.replace(/\s{2,}/g, " ").trim();
    } else {
      out.push({ ...seg, text: seg.text.trim() });
    }
  }
  return out;
}

// ─── Speaker assignment popover ────────────────────────────────────────────────
// Per-segment speaker reassignment via Popover + Command (spec §4.3). Lists the
// interview's participants (by their bound speaker_label) plus a quick "set role"
// fallback for segments whose label has no participant yet.
const SPEAKER_PICKER_STR = {
  ru: {
    assignPlaceholder: "Назначить спикера…",
    noParticipants: "Пока нет участников.",
    participants: "Участники",
    assignRoleDirectly: "Назначить роль напрямую",
  },
  en: {
    assignPlaceholder: "Assign speaker…",
    noParticipants: "No participants yet.",
    participants: "Participants",
    assignRoleDirectly: "Assign role directly",
  },
};
function SpeakerPicker({
  current,
  participants,
  roles,
  onPick,
  children,
}: {
  current: string;
  participants: DraftParticipant[];
  roles: Role[];
  onPick: (speakerLabel: string) => void;
  children: React.ReactNode;
}) {
  const t = useT(SPEAKER_PICKER_STR);
  const [open, setOpen] = useState(false);
  // Participants with a bound speaker label are the primary choices.
  const bound = participants.filter((p) => p.speaker_label);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent align="start" className="w-64 p-0">
        <Command>
          <CommandInput placeholder={t.assignPlaceholder} className="h-9" />
          <CommandList>
            <CommandEmpty>{t.noParticipants}</CommandEmpty>
            {bound.length > 0 && (
              <CommandGroup heading={t.participants}>
                {bound.map((p) => {
                  const role = lookupRole(roles, p.role);
                  return (
                    <CommandItem
                      key={p.id}
                      value={`${p.display_name} ${p.speaker_label}`}
                      onSelect={() => {
                        onPick(p.speaker_label as string);
                        setOpen(false);
                      }}
                    >
                      <RoleChip color={role?.color} label={p.display_name} />
                      {current === p.speaker_label && (
                        <Check className="ml-auto size-3.5 text-primary" />
                      )}
                    </CommandItem>
                  );
                })}
              </CommandGroup>
            )}
            <CommandGroup heading={t.assignRoleDirectly}>
              {roles.map((role) => (
                <CommandItem
                  key={role.id}
                  value={`role ${role.name}`}
                  onSelect={() => {
                    onPick(role.id);
                    setOpen(false);
                  }}
                >
                  <RoleChip color={role.color} label={role.name} />
                  {current === role.id && (
                    <Check className="ml-auto size-3.5 text-primary" />
                  )}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

// ─── Participants panel (left pane) ────────────────────────────────────────────
// Define participants (name + role) and bind each to a transcript speaker label
// (manual diarization, spec §4.5). The whole list is owned here and saved on Save.
const PARTICIPANTS_PANEL_STR = {
  ru: {
    title: "Участники и спикеры",
    add: "Добавить",
    emptyState:
      "Пока нет участников. Добавьте интервьюера и респондента, затем привяжите каждого к спикеру.",
    name: "Имя",
    removeParticipant: "Удалить участника",
    speaker: "Спикер",
    noSpeaker: "Без спикера",
  },
  en: {
    title: "Participants & speakers",
    add: "Add",
    emptyState:
      "No participants yet. Add an interviewer and a respondent, then bind each to a speaker.",
    name: "Name",
    removeParticipant: "Remove participant",
    speaker: "Speaker",
    noSpeaker: "No speaker",
  },
};
function ParticipantsPanel({
  participants,
  speakerLabels,
  roles,
  onChange,
}: {
  participants: DraftParticipant[];
  speakerLabels: string[];
  roles: Role[];
  onChange: (next: DraftParticipant[]) => void;
}) {
  const t = useT(PARTICIPANTS_PANEL_STR);
  function update(id: string, patch: Partial<DraftParticipant>) {
    onChange(participants.map((p) => (p.id === id ? { ...p, ...patch } : p)));
  }
  function add() {
    // Default a new participant to the second library role (typically a respondent)
    // when present, else the first — never blank.
    const defaultRole = roles[1]?.id ?? roles[0]?.id ?? "";
    onChange([
      ...participants,
      {
        id: `tmp-${crypto.randomUUID()}`,
        display_name: "",
        role: defaultRole,
        speaker_label: null,
      },
    ]);
  }
  function remove(id: string) {
    onChange(participants.filter((p) => p.id !== id));
  }

  const NONE = "__none__";

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
          <Users className="size-3.5" />
          <span>{t.title}</span>
        </div>
        <Button variant="ghost" size="xs" onClick={add} className="text-muted-foreground">
          <Plus className="size-3" />
          {t.add}
        </Button>
      </div>

      {participants.length === 0 ? (
        <p className="rounded-md border border-dashed border-border px-3 py-4 text-center text-xs text-muted-foreground">
          {t.emptyState}
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {participants.map((p) => (
            <li
              key={p.id}
              className="group/p flex flex-col gap-2 rounded-lg border border-border bg-card/40 p-2.5"
            >
              <div className="flex items-center gap-2">
                <span
                  className="size-2 shrink-0 rounded-full"
                  style={{
                    backgroundColor:
                      lookupRole(roles, p.role)?.color ?? "var(--muted-foreground)",
                  }}
                  aria-hidden
                />
                <Input
                  value={p.display_name}
                  placeholder={t.name}
                  onChange={(e) => update(p.id, { display_name: e.target.value })}
                  className="h-7 flex-1 border-transparent bg-transparent px-1.5 text-sm shadow-none focus-visible:border-input"
                />
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label={t.removeParticipant}
                  className="text-muted-foreground opacity-0 transition-opacity group-hover/p:opacity-100 focus-visible:opacity-100"
                  onClick={() => remove(p.id)}
                >
                  <Trash2 className="size-3" />
                </Button>
              </div>
              <div className="flex items-center gap-1.5 pl-4">
                {/* Role — picked from the library (M10a). */}
                <Select
                  value={p.role}
                  onValueChange={(v) => update(p.id, { role: v })}
                >
                  <SelectTrigger size="sm" className="h-7 flex-1">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {roles.map((role) => (
                      <SelectItem key={role.id} value={role.id}>
                        <RoleChip color={role.color} label={role.name} />
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {/* Speaker label binding */}
                <Select
                  value={p.speaker_label ?? NONE}
                  onValueChange={(v) =>
                    update(p.id, { speaker_label: v === NONE ? null : v })
                  }
                >
                  <SelectTrigger size="sm" className="h-7 flex-1">
                    <SelectValue placeholder={t.speaker} />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NONE}>
                      <span className="text-muted-foreground">{t.noSpeaker}</span>
                    </SelectItem>
                    {speakerLabels.map((label) => (
                      <SelectItem key={label} value={label}>
                        <span className="font-numeric text-xs">{label}</span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ─── Segment line (one row WITHIN a turn) ──────────────────────────────────────
// One editable segment inside a turn block: a play-from-here timecode + selection
// checkbox + its own auto-growing textarea. The speaker chip now lives at the TURN level
// (see TurnBlock), so a micro-segment no longer repeats it — the row just carries text +
// timing + per-segment controls. Multi-select (checkbox + bulk-assign bar) stays available.
const SEGMENT_LINE_STR = {
  ru: {
    deselectSegment: (n: number) => `Снять выделение сегмента ${n}`,
    selectSegment: (n: number) => `Выделить сегмент ${n}`,
    pause: "Пауза",
    playFromHere: "Воспроизвести с этого момента",
    playFrom: (tc: string) => `Воспроизвести с ${tc}`,
    editSegmentText: (n: number) => `Редактировать текст сегмента ${n}`,
    rewriteSegmentTitle: "Переписать этот сегмент через модель",
    rewriteSegmentAria: (n: number) => `Переписать сегмент ${n}`,
    rewriting: "Переписываю…",
    rewriteSegment: "Переписать сегмент",
    showChangesTitle: "Показать, что изменилось относительно оригинала",
    changed: "Изменено",
    revertTitle: "Вернуть исходный текст сегмента",
    revertAria: (n: number) => `Вернуть исходный текст сегмента ${n}`,
    revert: "Вернуть",
    changesVsOriginal: "Изменения относительно оригинала",
  },
  en: {
    deselectSegment: (n: number) => `Deselect segment ${n}`,
    selectSegment: (n: number) => `Select segment ${n}`,
    pause: "Pause",
    playFromHere: "Play from here",
    playFrom: (tc: string) => `Play from ${tc}`,
    editSegmentText: (n: number) => `Edit segment ${n} text`,
    rewriteSegmentTitle: "Rewrite this segment with the model",
    rewriteSegmentAria: (n: number) => `Rewrite segment ${n}`,
    rewriting: "Rewriting…",
    rewriteSegment: "Rewrite segment",
    showChangesTitle: "Show what changed from the original",
    changed: "Changed",
    revertTitle: "Restore the segment's original text",
    revertAria: (n: number) => `Restore segment ${n} original text`,
    revert: "Revert",
    changesVsOriginal: "Changes from the original",
  },
};
function SegmentLine({
  segment,
  index,
  active,
  playing,
  selected,
  focused,
  canRewrite,
  rewriting,
  baseline,
  showDiff,
  onPlay,
  onText,
  onToggleSelect,
  onRewrite,
  onRevert,
  onKeyDown,
  onFocus,
}: {
  segment: Segment;
  index: number;
  active: boolean;
  playing: boolean;
  selected: boolean;
  // Whether THIS row owns the roving tabindex (tabIndex=0); all others are -1.
  focused: boolean;
  // Whether the per-segment rewrite button is available (an editable version is shown).
  canRewrite: boolean;
  // This row's rewrite is in flight (the CLI is cleaning just this segment).
  rewriting: boolean;
  // The original (raw) text for this segment, or null if there's no baseline to compare to.
  baseline: string | null;
  // Global "show changes" toggle: when on, every changed row's diff is expanded.
  showDiff: boolean;
  onPlay: () => void;
  onText: (text: string) => void;
  onToggleSelect: (e: React.MouseEvent) => void;
  onRewrite: () => void;
  // Restore this segment's text to its baseline (original).
  onRevert: () => void;
  // Keyboard navigation/selection on the row wrapper (Up/Down/Shift/Space/Home/End).
  onKeyDown: (e: React.KeyboardEvent) => void;
  onFocus: () => void;
}) {
  const t = useT(SEGMENT_LINE_STR);
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  // Has this segment's text diverged from the original? Drives the "Changed" chip + diff.
  const changed = baseline != null && textChanged(baseline, segment.text);
  // Per-row diff expansion: the chip toggles just this row; the global toggle forces all open.
  const [diffOpen, setDiffOpen] = useState(false);
  const diffShown = changed && (showDiff || diffOpen);
  const diffParts = useMemo(
    () => (diffShown ? wordDiff((baseline ?? "").trim(), segment.text.trim()) : []),
    [diffShown, baseline, segment.text],
  );

  // ponytail: auto-grow the textarea to fit its content so it NEVER scrolls internally
  // (the field has overflow-hidden; we drive height from scrollHeight). We re-measure on
  // text change AND on width change (split-panel resize / first layout), because the
  // wrapped line count — and therefore the needed height — depends on the column width.
  const autosize = useCallback(() => {
    const el = taRef.current;
    if (!el) return;
    el.style.height = "auto";
    // scrollHeight is the content box; add the vertical borders so border-box sizing
    // doesn't clip the last line by ~1–2px (the field always has a 1px border now).
    const cs = getComputedStyle(el);
    const borders =
      parseFloat(cs.borderTopWidth) + parseFloat(cs.borderBottomWidth);
    el.style.height = `${el.scrollHeight + borders}px`;
  }, []);
  useEffect(autosize, [segment.text, autosize]);
  // Recompute when the row width changes (the earlier bug: height was measured at a
  // wider width than the final render, leaving a too-short box that scrolled).
  useEffect(() => {
    const el = taRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(autosize);
    ro.observe(el);
    return () => ro.disconnect();
  }, [autosize]);

  return (
    <div
      data-segment-index={index}
      // Roving tabindex: the focused row is the single tab stop; arrows move focus between
      // rows (handled by onKeyDown). role=option + aria-selected expose the selection to AT.
      role="option"
      aria-selected={selected}
      tabIndex={focused ? 0 : -1}
      onKeyDown={onKeyDown}
      onFocus={onFocus}
      className={cn(
        // ponytail: every row state must be unmistakable (founder bar: "the user must
        // always clearly see the interface react"). Selected = clear accent wash + ring;
        // playing/active = accent wash; plain hover = an obvious surface lift, not a whisper.
        "group/seg relative grid grid-cols-[auto_auto_1fr] gap-x-3 gap-y-1 rounded-lg px-2.5 py-1.5 transition-colors focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none",
        selected
          ? "bg-primary/15 ring-1 ring-inset ring-primary/30"
          : active
            ? "bg-primary/10"
            : "hover:bg-secondary",
      )}
    >
      {/* Accent rail — brighter when selected, dimmer for the active (playing) row. */}
      <span
        className={cn(
          "absolute top-2 bottom-2 left-0 w-0.5 rounded-full transition-opacity",
          selected
            ? "bg-primary opacity-100"
            : active
              ? "bg-primary opacity-60"
              : "opacity-0",
        )}
        aria-hidden
      />

      {/* ponytail: selection checkbox is now a CLEARLY VISIBLE affordance at rest (was
          opacity-0 → invisible, impossible to discover). Always-on outlined box that reads
          obviously as a checkbox; brightens on row hover; solid accent + check when selected.
          Shift-click extends a range; Cmd/Ctrl-click toggles one row. */}
      <button
        type="button"
        role="checkbox"
        aria-checked={selected}
        aria-label={selected ? t.deselectSegment(index + 1) : t.selectSegment(index + 1)}
        onClick={onToggleSelect}
        className={cn(
          "mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-[5px] border-2 transition-colors focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none",
          selected
            ? "border-primary bg-primary text-primary-foreground"
            : "border-muted-foreground/50 bg-card/40 text-transparent hover:border-primary hover:bg-primary/10 group-hover/seg:border-muted-foreground/70 focus-visible:border-primary",
        )}
      >
        <Check className="size-3" strokeWidth={3} />
      </button>

      {/* Gutter: play-from-here (seek + play). The whole timecode is the control; a
          Play/Pause glyph makes the affordance obvious and reflects whether THIS row is the
          one currently playing. The speaker chip moved up to the turn header. */}
      <div className="flex w-20 shrink-0 flex-col gap-1.5 pt-0.5">
        <button
          type="button"
          onClick={onPlay}
          className="group/play flex w-fit items-center gap-1.5 rounded-md px-1 py-0.5 -ml-1 font-numeric text-xs text-muted-foreground tabular-nums transition-colors hover:bg-secondary/60 hover:text-primary focus-visible:text-primary focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
          title={playing ? t.pause : t.playFromHere}
          aria-label={playing ? t.pause : t.playFrom(formatTimecode(segment.start_ms))}
        >
          {playing ? (
            <Pause className="size-3 shrink-0 text-primary" />
          ) : (
            // Quiet at rest; the glyph brightens on hover or when this row is active.
            <Play
              className={cn(
                "size-3 shrink-0 transition-opacity",
                active
                  ? "opacity-100 text-primary"
                  : "opacity-40 group-hover/seg:opacity-100 group-hover/play:text-primary",
              )}
            />
          )}
          {formatTimecode(segment.start_ms)}
        </button>
      </div>

      {/* Editable text. ponytail: pencil icon REMOVED — instead the field itself clearly
          reads as editable. On row hover it gains an obvious inset surface + a hairline
          border so it visibly looks like an input you can type in; on focus a clear accent
          ring + border. The text cursor reinforces it. Text-only — timing stays immutable.
          overflow-hidden + autosize means it grows to fit and NEVER shows a per-row scrollbar. */}
      <div className="relative min-w-0">
        <textarea
          ref={taRef}
          value={segment.text}
          onChange={(e) => {
            onText(e.target.value);
            autosize();
          }}
          rows={1}
          spellCheck={false}
          aria-label={t.editSegmentText(index + 1)}
          className={cn(
            "block w-full cursor-text resize-none overflow-hidden rounded-md border bg-transparent px-2 py-1 -mx-2 -my-1 text-[13.5px] leading-relaxed text-foreground/90 outline-none transition-colors placeholder:text-muted-foreground",
            "border-transparent group-hover/seg:border-border group-hover/seg:bg-background/60",
            "focus:border-ring focus:bg-background/80 focus:text-foreground focus:ring-2 focus:ring-ring/40",
          )}
        />

        {/* Per-row controls: rewrite, a "Changed" chip (when the text diverged from the
            original), and Revert. The chip toggles this row's inline diff; the global "Changes"
            header toggle forces every changed row's diff open. */}
        <div className="mt-1 flex flex-wrap items-center gap-1.5">
          {/* Per-segment rewrite — re-cleans JUST this segment via the CLI (plain text in,
              plain text out) and swaps the result into the field. This is the per-segment
              replacement for whole-transcript cleanup: one segment in isolation, so the model
              has nothing to drift across and hallucinates far less. A spinner while its own
              request runs. */}
          {canRewrite && (
            <button
              type="button"
              onClick={onRewrite}
              disabled={rewriting}
              title={t.rewriteSegmentTitle}
              aria-label={t.rewriteSegmentAria(index + 1)}
              className={cn(
                "flex items-center gap-1.5 rounded-md border px-1.5 py-0.5 text-[11px] font-medium transition-colors focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none disabled:opacity-100",
                rewriting
                  ? "border-primary/40 bg-primary/10 text-primary"
                  : "border-transparent text-muted-foreground/70 hover:border-border hover:bg-secondary/60 hover:text-primary focus-visible:border-border focus-visible:text-primary",
              )}
            >
              {rewriting ? (
                <Loader2 className="size-3 shrink-0 animate-spin" />
              ) : (
                <Wand2 className="size-3 shrink-0" />
              )}
              {rewriting ? t.rewriting : t.rewriteSegment}
            </button>
          )}

          {changed && (
            <button
              type="button"
              onClick={() => setDiffOpen((o) => !o)}
              aria-expanded={diffShown}
              title={t.showChangesTitle}
              className={cn(
                "flex items-center gap-1.5 rounded-md border px-1.5 py-0.5 text-[11px] font-medium transition-colors focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none",
                diffShown
                  ? "border-status-importing/40 bg-status-importing/10 text-status-importing"
                  : "border-transparent text-status-importing/80 hover:border-status-importing/40 hover:bg-status-importing/10",
              )}
            >
              <GitCompareArrows className="size-3 shrink-0" />
              {t.changed}
            </button>
          )}

          {changed && (
            <button
              type="button"
              onClick={onRevert}
              title={t.revertTitle}
              aria-label={t.revertAria(index + 1)}
              className="flex items-center gap-1.5 rounded-md border border-transparent px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground/70 transition-colors hover:border-border hover:bg-secondary/60 hover:text-foreground focus-visible:border-border focus-visible:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
            >
              <Undo2 className="size-3 shrink-0" />
              {t.revert}
            </button>
          )}
        </div>

        {/* Inline word diff (GitHub-style): deletions struck through in red, insertions in
            green. Read-only — editing happens in the textarea above; this just shows what moved
            relative to the original transcript. */}
        {diffShown && (
          <div className="mt-1.5 rounded-md border border-border bg-secondary/30 px-2.5 py-1.5">
            <div className="mb-1 flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
              <GitCompareArrows className="size-3 shrink-0" />
              {t.changesVsOriginal}
            </div>
            <p className="text-[13px] leading-relaxed break-words whitespace-pre-wrap">
              {diffParts.map((p, i) =>
                p.type === "eq" ? (
                  <span key={i} className="text-foreground/70">
                    {p.value}
                  </span>
                ) : p.type === "del" ? (
                  <del
                    key={i}
                    className="rounded-sm bg-status-error/15 text-status-error line-through decoration-status-error/60"
                  >
                    {p.value}
                  </del>
                ) : (
                  <ins
                    key={i}
                    className="rounded-sm bg-status-ready/15 text-status-ready no-underline"
                  >
                    {p.value}
                  </ins>
                ),
              )}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Turn block (right pane) ───────────────────────────────────────────────────
// One TURN = a maximal run of consecutive same-speaker segments, rendered as a paragraph
// block: ONE speaker chip header at the top (reassigning it reassigns ALL the turn's
// segments via the SpeakerPicker → onAssignTurn), with the turn's segments listed under it
// (each its own SegmentLine). This is what makes the transcript read as an alternating
// dialogue instead of a wall of tiny rows. Timing + segment count are untouched.
const TURN_BLOCK_STR = {
  ru: { assignSpeaker: "Назначить спикера для этой реплики" },
  en: { assignSpeaker: "Assign a speaker for this turn" },
};
function TurnBlock({
  turn,
  segments,
  roleColor,
  roleLabel,
  unassigned,
  participants,
  roles,
  activeIndex,
  isPlaying,
  selected,
  focusedIndex,
  canRewrite,
  rewritingIndex,
  baselines,
  showDiff,
  onAssignTurn,
  onPlay,
  onText,
  onToggleSelect,
  onRewrite,
  onRevert,
  onSegmentKeyDown,
  onSegmentFocus,
}: {
  turn: { speakerLabel: string; startMs: number; segmentIndices: number[] };
  segments: Segment[];
  roleColor?: string;
  roleLabel?: string;
  unassigned: boolean;
  participants: DraftParticipant[];
  roles: Role[];
  activeIndex: number;
  isPlaying: boolean;
  selected: Set<number>;
  // Which segment index currently owns the roving tabindex (null until a row is focused).
  focusedIndex: number | null;
  // Whether per-segment rewrite is available, and which segment index is currently rewriting.
  canRewrite: boolean;
  rewritingIndex: number | null;
  // Per-segment original text (indexed like `segments`) + the global show-changes toggle.
  baselines: (string | null)[];
  showDiff: boolean;
  onAssignTurn: (label: string) => void;
  onPlay: (index: number) => void;
  onText: (index: number, text: string) => void;
  onToggleSelect: (index: number, e: React.MouseEvent) => void;
  onRewrite: (index: number) => void;
  onRevert: (index: number) => void;
  onSegmentKeyDown: (index: number, e: React.KeyboardEvent) => void;
  onSegmentFocus: (index: number) => void;
}) {
  const t = useT(TURN_BLOCK_STR);
  return (
    <div className="flex flex-col gap-0.5 py-1.5">
      {/* Turn header: the single speaker chip for the whole run. Picking a new speaker
          reassigns every segment in the turn at once. */}
      <div className="flex items-center gap-2 pl-9">
        <SpeakerPicker
          current={turn.speakerLabel}
          participants={participants}
          roles={roles}
          onPick={onAssignTurn}
        >
          <button
            type="button"
            className="w-fit rounded-md focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
            title={t.assignSpeaker}
          >
            <RoleChip
              color={roleColor}
              label={roleLabel ?? (unassigned ? turn.speakerLabel : undefined)}
              unassigned={unassigned}
              tone="soft"
            />
          </button>
        </SpeakerPicker>
        <span className="font-numeric text-[11px] text-muted-foreground/60 tabular-nums">
          {formatTimecode(turn.startMs)}
        </span>
      </div>

      {/* The turn's segments — each still individually editable + playable + selectable. */}
      <div className="flex flex-col">
        {turn.segmentIndices.map((i) => (
          <SegmentLine
            key={i}
            segment={segments[i]}
            index={i}
            active={i === activeIndex}
            playing={isPlaying && i === activeIndex}
            selected={selected.has(i)}
            // The roving tab stop: the focused row, or segment 0 when nothing's focused yet
            // (so the list is reachable with a single Tab).
            focused={focusedIndex === null ? i === 0 : focusedIndex === i}
            canRewrite={canRewrite}
            rewriting={rewritingIndex === i}
            baseline={baselines[i] ?? null}
            showDiff={showDiff}
            onPlay={() => onPlay(i)}
            onText={(t) => onText(i, t)}
            onToggleSelect={(e) => onToggleSelect(i, e)}
            onRewrite={() => onRewrite(i)}
            onRevert={() => onRevert(i)}
            onKeyDown={(e) => onSegmentKeyDown(i, e)}
            onFocus={() => onSegmentFocus(i)}
          />
        ))}
      </div>
    </div>
  );
}

// ─── The editor page ───────────────────────────────────────────────────────────
const PAGE_STR = {
  ru: {
    // toasts / confirm (used in callbacks via tr)
    segmentRewritten: "Сегмент переписан",
    noChanges: "Без изменений",
    rewriteFailed: (e: string) => `Не удалось переписать. ${e}`,
    modelNotDownloaded: "Модель не скачана — Настройки → Транскрипция.",
    retranscribeFailed: (e: string) => `Не удалось перетранскрибировать фрагмент. ${e}`,
    resumeFailed: (e: string) => `Не удалось продолжить. ${e}`,
    saveSuccess: "Правки транскрипта сохранены",
    saveFailed: (e: string) => `Не удалось сохранить. ${e}`,
    unsavedTitle: "Несохранённые изменения",
    unsavedBody: "Есть несохранённые изменения — уйти без сохранения?",
    leaveAction: "Уйти без сохранения",
    // toolbar / body (used in JSX via t)
    backToCycle: "Назад к циклу",
    transcriptFallbackTitle: "Транскрипт",
    unsavedChanges: "Несохранённые изменения",
    transcript: "Транскрипт",
    summary: "Саммари",
    diarizing: "Диаризация…",
    transcribing: "Транскрибирование…",
    showAllDiffsTitle: "Показать изменения относительно оригинала по всем сегментам",
    hideChanges: "Скрыть изменения",
    changes: "Изменения",
    saving: "Сохранение…",
    save: "Сохранить",
    transcriptionStoppedAt: (tc: string) => `Транскрипция прервалась на ${tc}`,
    partialSavedHint: " — сохранён частичный результат. Можно продолжить с этого места.",
    resume: "Продолжить",
    recording: "Запись",
    noAudio: "Для этого интервью нет подготовленного аудио.",
    unassignedSuffix: "без назначенной роли",
    noSegmentsInVersion: "В этой версии нет сегментов.",
    transcriptSegments: "Сегменты транскрипта",
    selectedLabel: "Выделено",
    assignSpeaker: "Назначить спикера",
    retranscribeSelectionTitle: "Перетранскрибировать выделенный фрагмент аудио заново",
    retranscribe: "Перетранскрибировать",
    clear: "Сбросить",
    // transcript search (Ctrl/Cmd+F)
    searchPlaceholder: "Поиск по транскрипту…",
    searchMatches: (n: number, total: number) => `${n}/${total}`,
    prevMatch: "Предыдущее совпадение (Shift+Enter)",
    nextMatch: "Следующее совпадение (Enter)",
    closeSearch: "Закрыть поиск (Esc)",
  },
  en: {
    segmentRewritten: "Segment rewritten",
    noChanges: "No changes",
    rewriteFailed: (e: string) => `Couldn't rewrite. ${e}`,
    modelNotDownloaded: "Model not downloaded — Settings → Transcription.",
    retranscribeFailed: (e: string) => `Couldn't re-transcribe the fragment. ${e}`,
    resumeFailed: (e: string) => `Couldn't resume. ${e}`,
    saveSuccess: "Transcript edits saved",
    saveFailed: (e: string) => `Couldn't save. ${e}`,
    unsavedTitle: "Unsaved changes",
    unsavedBody: "You have unsaved changes — leave without saving?",
    leaveAction: "Leave without saving",
    backToCycle: "Back to cycle",
    transcriptFallbackTitle: "Transcript",
    unsavedChanges: "Unsaved changes",
    transcript: "Transcript",
    summary: "Summary",
    diarizing: "Diarizing…",
    transcribing: "Transcribing…",
    showAllDiffsTitle: "Show changes from the original across all segments",
    hideChanges: "Hide changes",
    changes: "Changes",
    saving: "Saving…",
    save: "Save",
    transcriptionStoppedAt: (tc: string) => `Transcription stopped at ${tc}`,
    partialSavedHint: " — a partial result was saved. You can continue from here.",
    resume: "Resume",
    recording: "Recording",
    noAudio: "No prepared audio for this interview.",
    unassignedSuffix: "with no assigned role",
    noSegmentsInVersion: "This version has no segments.",
    transcriptSegments: "Transcript segments",
    selectedLabel: "Selected",
    assignSpeaker: "Assign speaker",
    retranscribeSelectionTitle: "Re-transcribe the selected audio fragment from scratch",
    retranscribe: "Re-transcribe",
    clear: "Clear",
    searchPlaceholder: "Search transcript…",
    searchMatches: (n: number, total: number) => `${n}/${total}`,
    prevMatch: "Previous match (Shift+Enter)",
    nextMatch: "Next match (Enter)",
    closeSearch: "Close search (Esc)",
  },
};
export function TranscriptEditorPage() {
  const { cycleId, interviewId } = useParams<{
    cycleId: string;
    interviewId: string;
  }>();
  const navigate = useNavigate();
  const t = useT(PAGE_STR);

  // Cycle (for the breadcrumb context above the title — quiet wayfinding).
  const { data: cycle } = useCycle(cycleId);

  // Interview row (for title/audio/duration) — reuse the cycle's interview list.
  const { data: interviews } = useInterviews(cycleId);
  const interview: InterviewRow | undefined = interviews?.find(
    (i) => i.id === interviewId,
  );

  // Which version is shown. Default to 'edited' if it exists, else raw.
  const { data: versions } = useTranscriptVersions(interviewId);
  const [activeKind, setActiveKind] = useState<string>("raw");
  useEffect(() => {
    if (!versions || versions.length === 0) return;
    const kinds = versions.map((v) => v.kind);
    setActiveKind(
      kinds.includes("edited")
        ? "edited"
        : kinds.includes("cleaned")
          ? "cleaned"
          : "raw",
    );
  }, [versions]);

  const { data: version, isPending: versionPending } = useTranscriptVersion(
    interviewId,
    activeKind,
  );
  // The pristine ORIGINAL (raw) transcript — the baseline the per-segment diff compares
  // against. Loaded independently of the working version so we can show "what changed vs the
  // original" even after the edited version is what's being shown/edited. Returns null when
  // there's no raw version (then there's simply nothing to diff against).
  const { data: baselineVersion } = useTranscriptVersion(interviewId, "raw");
  const { data: participantsData } = useParticipants(interviewId);
  const { data: rolesData } = useRoles();
  const roles = useMemo(() => rolesData ?? [], [rolesData]);
  const saveMutation = useSaveEditedTranscript(interviewId ?? "");

  // ── Live transcription/diarization (watch a slow run fill in) ──
  // The global listener (App) feeds this store from a run's first event, so opening the
  // interview mid-run shows it streaming. `isLive` is true while a run is in flight; the
  // editor then renders the read-only live view instead of the (empty) stored transcript.
  const live = useLiveAsrStore(
    (s) => s.byInterview[interviewId ?? ""] ?? EMPTY_LIVE_ASR,
  );
  const resetLive = useLiveAsrStore((s) => s.reset);
  const isLive =
    live.status === "transcribing" ||
    (interview?.status === "transcribing" &&
      live.status !== "transcribed" &&
      live.status !== "error");

  // Once a run finishes AND the stored transcript + refreshed row have landed, drop the live
  // buffer — the editable, diarized version takes over. Gating on the row no longer being
  // `transcribing` avoids a flicker back into live mode from a momentarily-stale row status.
  useEffect(() => {
    if (!interviewId) return;
    if (
      live.status === "transcribed" &&
      version &&
      interview?.status !== "transcribing"
    ) {
      resetLive(interviewId);
    }
  }, [live.status, version, interview?.status, interviewId, resetLive]);

  // ── Re-transcribe a selection / resume a crashed run ──
  // These reuse the Settings-chosen model/language/expected-speakers (same source as the list).
  // The handlers that need the segment/selection state live further down, after it's declared.
  const asrModelId = useUiStore((s) => s.asrModelId);
  const asrLanguage = useUiStore((s) => s.asrLanguage);
  const asrExpectedSpeakers = useUiStore((s) => s.asrExpectedSpeakers);
  const { data: models } = useModels();
  const expectedSpeakers =
    asrExpectedSpeakers === "auto" ? null : Number(asrExpectedSpeakers);
  const { data: checkpoint } = useTranscribeCheckpoint(interviewId);

  // ── Local editable buffers (edits are local until Save, spec §4.5). ──
  const [segments, setSegments] = useState<Segment[]>([]);
  const [participants, setParticipants] = useState<DraftParticipant[]>([]);
  const [dirty, setDirty] = useState(false);
  const [activeMs, setActiveMs] = useState(0);
  // Mirror of the player's play/pause state, so the active segment row can show a Pause.
  const [isPlaying, setIsPlaying] = useState(false);
  // ── Multi-select model (ponytail: replaced the old invisible shift-anchor). A Set of
  // selected segment indices drives the visible highlight + the bulk-assign bar; `anchor`
  // is the last row clicked, so Shift-click can extend a contiguous range from it. ──
  const [selected, setSelected] = useState<Set<number>>(() => new Set());
  const [anchor, setAnchor] = useState<number | null>(null);
  // Roving-tabindex focus: which segment row currently owns Tab focus (so the whole list is
  // ONE tab stop and Up/Down arrows move between rows). null = nothing focused yet.
  const [focusedIndex, setFocusedIndex] = useState<number | null>(null);
  // Which segment index is currently being rewritten via the per-segment "Переписать сегмент"
  // button (null = none in flight). One at a time keeps it obvious + cheap on the CLI.
  const [rewritingIndex, setRewritingIndex] = useState<number | null>(null);
  // Which right-pane view is shown: the transcript segments or the per-interview Summary
  // artifact (Milestone 10b).
  const [pane, setPane] = useState<"transcript" | "summary">("transcript");
  // Global "show changes" toggle: expand every changed segment's diff vs the original at once.
  const [showDiff, setShowDiff] = useState(false);
  // ── Transcript search (Ctrl/Cmd+F intercepted): slim inline bar over the segment list.
  // Case-insensitive substring across segment text; Enter/Shift+Enter or ↑/↓ jump between
  // matches (wrap-around), Esc closes. No regex, no replace.
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  // Position within searchMatches (not a segment index).
  const [searchCurrent, setSearchCurrent] = useState(0);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const waveRef = useRef<WaveformHandle | null>(null);
  // The scroll region holding the turn/segment list — used to move DOM focus between rows
  // for keyboard navigation (query the row by its data-segment-index).
  const listRef = useRef<HTMLDivElement | null>(null);

  // Seed segments from the loaded version whenever the version changes. We coalesce the raw
  // whisper segmentation into readable paragraphs HERE, before turn-grouping/playback consume
  // them, so the editor renders ~paragraphs instead of ~one row per 2-second segment.
  useEffect(() => {
    if (version) {
      setSegments(coalesceSegments(version.segments));
      setDirty(false);
      // ponytail: drop any selection when the underlying segments change out from under it.
      setSelected(new Set());
      setAnchor(null);
      setFocusedIndex(null);
    }
  }, [version]);

  // Audio source: convertFileSrc under Tauri (asset protocol), mock data URI in browser.
  const audioUrl = useMemo(() => {
    if (!IN_TAURI) return mockAudioSrc(interviewId ?? "");
    return interview?.audio_path ? convertFileSrc(interview.audio_path) : "";
  }, [interview?.audio_path, interviewId]);

  // speaker_label → participant (role id + name), derived from the bindings. A segment's
  // speaker_label is matched to a participant by speaker_label; if none, and the label is
  // itself a known role id, fall back to that. Otherwise it's unassigned.
  const speakerMap = useMemo(() => {
    const map = new Map<string, { roleId: string; name: string }>();
    for (const p of participants) {
      if (p.speaker_label) {
        map.set(p.speaker_label, { roleId: p.role, name: p.display_name });
      }
    }
    return map;
  }, [participants]);

  // The distinct speaker labels present in the transcript (for the participant binding
  // Select), preserving first-seen order.
  const speakerLabels = useMemo(() => {
    const seen: string[] = [];
    for (const s of segments) {
      if (s.speaker_label && !seen.includes(s.speaker_label)) seen.push(s.speaker_label);
    }
    return seen;
  }, [segments]);

  // Seed participants once loaded. When none are saved yet but the transcript carries
  // diarization speaker labels (S1, S2, …), auto-seed one draft participant per label so the
  // speakers show up as bindable entities ready for a role — instead of an empty panel.
  // ponytail: seeding marks the form dirty (a Save persists the bindings); we don't bother
  // distinguishing seeded-vs-edited. Only seeds when there are NO saved participants, so it
  // never clobbers existing bindings.
  useEffect(() => {
    if (!participantsData) return;
    if (participantsData.length > 0) {
      setParticipants(participantsData.map(toDraft));
      return;
    }
    if (speakerLabels.length === 0) {
      setParticipants([]);
      return;
    }
    // Default each seeded participant to the second library role (typically a respondent)
    // when present, else the first — matching the "add participant" default.
    const defaultRole = roles[1]?.id ?? roles[0]?.id ?? "";
    setParticipants(
      speakerLabels.map((label) => ({
        id: `tmp-${crypto.randomUUID()}`,
        display_name: "",
        role: defaultRole,
        speaker_label: label,
      })),
    );
    setDirty(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [participantsData, speakerLabels, roles]);

  // ── Turn grouping (the core read-as-dialogue UX) ──
  // Fold the segments into TURNS: each maximal run of consecutive same-speaker segments
  // becomes one turn (speaker chip at the top, its segments listed under it). This is what
  // makes real diarization (alternating S1/S2/…) read as a back-and-forth instead of a wall
  // of 2-second rows. The turn carries its segments' ORIGINAL indices so per-segment editing,
  // play/seek and selection keep working unchanged, and a turn-level reassign maps over them.
  const turns = useMemo(() => {
    const out: { speakerLabel: string; startMs: number; segmentIndices: number[] }[] = [];
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      const last = out[out.length - 1];
      if (last && last.speakerLabel === seg.speaker_label) {
        last.segmentIndices.push(i);
      } else {
        out.push({
          speakerLabel: seg.speaker_label,
          startMs: seg.start_ms,
          segmentIndices: [i],
        });
      }
    }
    return out;
  }, [segments]);

  // ── Per-segment diff baseline ──
  // The original transcript, coalesced the same way the editor coalesces the working copy, so
  // its paragraph boundaries line up with the displayed segments for a clean 1:1 comparison.
  const baselineSegs = useMemo(
    () => (baselineVersion ? coalesceSegments(baselineVersion.segments) : []),
    [baselineVersion],
  );
  // Original text per displayed segment (indexed like `segments`). null when there's no
  // original to compare against.
  //
  // The working copy and the original are coalesced the SAME way from the same underlying
  // segments, so in the common case — no edits at all, or edits that didn't change the speaker
  // grouping — they have the same paragraph count and align 1:1 BY INDEX. We use that directly:
  // it's exact, and it avoids the false "changed" matches that fuzzy time-overlap produces when
  // segment boundaries touch (end==start) or imported timestamps overlap/tie, which would
  // otherwise pair a segment with a neighbour and diff it against the wrong original text.
  //
  // Only when the counts diverge (a turn was genuinely re-split or merged) do we fall back to
  // matching by maximum time-overlap — timing is immutable (spec §4.5), so overlap is a stable
  // anchor there.
  const baselines = useMemo<(string | null)[]>(() => {
    if (baselineSegs.length === 0) return segments.map(() => null);
    if (baselineSegs.length === segments.length) {
      return segments.map((_, i) => baselineSegs[i].text.trim());
    }
    return segments.map((seg) => {
      let bestText: string | null = null;
      let bestOverlap = -Infinity;
      for (const b of baselineSegs) {
        const overlap =
          Math.min(seg.end_ms, b.end_ms) - Math.max(seg.start_ms, b.start_ms);
        if (overlap > bestOverlap) {
          bestOverlap = overlap;
          bestText = b.text.trim();
        }
      }
      return bestText;
    });
  }, [segments, baselineSegs]);

  // How many displayed segments differ from their original (drives the header toggle + count).
  const changedCount = useMemo(
    () =>
      segments.reduce((acc, s, i) => {
        const base = baselines[i];
        return acc + (base != null && textChanged(base, s.text) ? 1 : 0);
      }, 0),
    [segments, baselines],
  );

  // Restore a segment's text to its original (the Revert action on a changed row).
  function revertSegment(index: number) {
    const base = baselines[index];
    if (base == null) return;
    setText(index, base);
  }

  // Resolve a segment's speaker_label → a role color + display label. A bound participant
  // wins; else a bare role id (e.g. legacy "interviewer") resolves directly against the
  // library; otherwise it's unassigned.
  function resolveRole(label: string): {
    color?: string;
    label?: string;
    unassigned: boolean;
  } {
    const bound = speakerMap.get(label);
    if (bound) {
      const role = lookupRole(roles, bound.roleId);
      return { color: role?.color, label: bound.name, unassigned: !role };
    }
    const direct = lookupRole(roles, label);
    if (direct) return { color: direct.color, label: direct.name, unassigned: false };
    return { unassigned: true };
  }

  // Count of segments whose speaker isn't resolvable to a role (the "unassigned" warning).
  const unassignedCount = useMemo(
    () => segments.filter((s) => resolveRole(s.speaker_label).unassigned).length,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [segments, speakerMap, roles],
  );

  const editable = activeKind === "edited" || activeKind === "raw" || activeKind === "cleaned";

  // ── Mutators (all local until Save) ──
  function setText(index: number, text: string) {
    setSegments((prev) => prev.map((s, i) => (i === index ? { ...s, text } : s)));
    setDirty(true);
  }

  // Per-segment rewrite ("Переписать сегмент"): re-clean JUST this one segment via the CLI and
  // swap in the plain-text result. This is the per-segment alternative to whole-transcript
  // cleanup — it sends only this segment's text, so the model has nothing to drift across and
  // hallucinates far less. One at a time; the result lands in the local buffer (Save persists it).
  const rewriteSegmentAt = useCallback(
    async (index: number) => {
      if (!interviewId || rewritingIndex !== null) return;
      const original = segments[index]?.text ?? "";
      if (!original.trim()) return;
      setRewritingIndex(index);
      try {
        const cleaned = await rewriteSegment(interviewId, original);
        const next = cleaned.trim();
        if (next && next !== original.trim()) {
          setText(index, next);
          toast.success(tr(PAGE_STR).segmentRewritten);
        } else {
          toast(tr(PAGE_STR).noChanges);
        }
      } catch (e) {
        toast.error(tr(PAGE_STR).rewriteFailed(String(e)));
      } finally {
        setRewritingIndex(null);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [interviewId, rewritingIndex, segments],
  );

  // ── Selection helpers (multi-select + bulk assign) ──
  // Toggle/extend the selection from a row's checkbox click, honoring modifiers:
  //   • plain click      → select just this row (new anchor),
  //   • Shift-click       → extend a contiguous range from the anchor,
  //   • Cmd/Ctrl-click    → toggle this one row in/out.
  function toggleSelect(index: number, e: React.MouseEvent) {
    const shift = e.shiftKey;
    const meta = e.metaKey || e.ctrlKey;
    setSelected((prev) => {
      const next = new Set(prev);
      if (shift && anchor != null) {
        const [a, b] = [Math.min(anchor, index), Math.max(anchor, index)];
        for (let i = a; i <= b; i++) next.add(i);
      } else if (meta) {
        if (next.has(index)) next.delete(index);
        else next.add(index);
      } else {
        // Plain click: select only this row (toggle off if it was the sole selection).
        if (next.size === 1 && next.has(index)) {
          next.clear();
        } else {
          next.clear();
          next.add(index);
        }
      }
      return next;
    });
    // Shift extends from the existing anchor; any other click sets a fresh one.
    if (!shift) setAnchor(index);
  }

  function clearSelection() {
    setSelected(new Set());
    setAnchor(null);
  }

  // Move keyboard focus to a segment row by index (roving tabindex). Focusing the row also
  // updates focusedIndex so the row's tabIndex flips to 0 and it scrolls into view.
  const focusSegment = useCallback((index: number) => {
    const el = listRef.current?.querySelector<HTMLElement>(
      `[data-segment-index="${index}"]`,
    );
    if (el) {
      el.focus();
      el.scrollIntoView({ block: "nearest" });
    }
  }, []);

  // ── Transcript search machinery ──
  // Segment indices whose text contains the query (case-insensitive substring).
  const searchMatches = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return [] as number[];
    const out: number[] = [];
    segments.forEach((s, i) => {
      if (s.text.toLowerCase().includes(q)) out.push(i);
    });
    return out;
  }, [searchQuery, segments]);

  // Scroll a match's row into view + flash a brief accent ring on it. Plain (non-smooth)
  // scrollIntoView — calm and respects prefers-reduced-motion by doing nothing animated.
  const flashSegment = useCallback((index: number) => {
    const el = listRef.current?.querySelector<HTMLElement>(
      `[data-segment-index="${index}"]`,
    );
    if (!el) return;
    el.scrollIntoView({ block: "center" });
    el.classList.add("ring-2", "ring-primary/60");
    window.setTimeout(() => el.classList.remove("ring-2", "ring-primary/60"), 900);
  }, []);

  // Jump to match #pos (wrap-around in both directions).
  const gotoMatch = useCallback(
    (pos: number) => {
      const n = searchMatches.length;
      if (n === 0) return;
      const wrapped = ((pos % n) + n) % n;
      setSearchCurrent(wrapped);
      flashSegment(searchMatches[wrapped]);
    },
    [searchMatches, flashSegment],
  );

  // A new query restarts from its first match (and shows it immediately, Ctrl+F-style).
  useEffect(() => {
    setSearchCurrent(0);
    if (searchOpen && searchMatches.length > 0) flashSegment(searchMatches[0]);
    // Only on query change — jumping on every keystroke of navigation would fight gotoMatch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchQuery]);

  function closeSearch() {
    setSearchOpen(false);
    setSearchQuery("");
    setSearchCurrent(0);
  }

  // Keyboard navigation between segment rows (roving tabindex):
  //   • ↑ / ↓            → move focus to the previous/next row,
  //   • Shift+↑ / Shift+↓ → extend the contiguous selection while moving (keyboard range),
  //   • Space / Enter     → toggle this row in/out of the selection,
  //   • Home / End        → jump to the first/last row.
  // Editing keys are untouched: the handler is bound on the row wrapper but React events
  // bubble, so we IGNORE keys when the event originates inside an editable field (the
  // textarea / inputs) — typing and caret movement stay with the field. The existing mouse
  // multi-select is unaffected.
  function onSegmentKeyDown(index: number, e: React.KeyboardEvent) {
    // Only act when the row wrapper itself is focused, not a control inside it (textarea,
    // play button, picker). That keeps text editing and inner controls fully usable.
    if (e.target !== e.currentTarget) return;
    const last = segments.length - 1;
    let target: number | null = null;
    if (e.key === "ArrowDown") target = Math.min(index + 1, last);
    else if (e.key === "ArrowUp") target = Math.max(index - 1, 0);
    else if (e.key === "Home") target = 0;
    else if (e.key === "End") target = last;
    else if (e.key === " " || e.key === "Enter") {
      e.preventDefault();
      setSelected((prev) => {
        const next = new Set(prev);
        if (next.has(index)) next.delete(index);
        else next.add(index);
        return next;
      });
      setAnchor(index);
      return;
    } else {
      return;
    }
    e.preventDefault();
    if (target === index && (e.key === "ArrowUp" || e.key === "ArrowDown")) return;
    // Shift+arrow extends a contiguous range from the anchor (set it on first shifted move).
    if (e.shiftKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
      const from = anchor ?? index;
      setAnchor(from);
      setSelected(() => {
        const [a, b] = [Math.min(from, target!), Math.max(from, target!)];
        const next = new Set<number>();
        for (let i = a; i <= b; i++) next.add(i);
        return next;
      });
    }
    setFocusedIndex(target);
    focusSegment(target);
  }

  // Bulk-assign a speaker/role to every selected segment at once, then clear the selection.
  function assignSelected(label: string) {
    if (selected.size === 0) return;
    setSegments((prev) =>
      prev.map((s, i) => (selected.has(i) ? { ...s, speaker_label: label } : s)),
    );
    setDirty(true);
    clearSelection();
  }

  // Reassign a whole TURN: maps the label over every segment index in the turn at once
  // (the turn-level speaker chip drives this — see TurnBlock). Like assignSelected, but the
  // set of indices comes from the turn instead of the multi-select. Timing stays immutable.
  function assignTurn(indices: number[], label: string) {
    if (indices.length === 0) return;
    const set = new Set(indices);
    setSegments((prev) =>
      prev.map((s, i) => (set.has(i) ? { ...s, speaker_label: label } : s)),
    );
    setDirty(true);
  }

  // Re-transcribe the selected segments' time span: the badly-cut part gets redone (whisper +
  // whole-audio re-diarization) and spliced back in. Range = [first selected start, last
  // selected end]; the backend drops the overlapping segments and inserts the fresh ones, then
  // the live store flips us into live mode as the new run streams.
  const retranscribeSelection = useCallback(async () => {
    if (!interviewId || selected.size === 0) return;
    const idxs = [...selected].sort((a, b) => a - b);
    const startMs = Math.min(...idxs.map((i) => segments[i]?.start_ms ?? 0));
    const endMs = Math.max(...idxs.map((i) => segments[i]?.end_ms ?? 0));
    if (endMs <= startMs) return;
    if (!models?.find((m) => m.id === asrModelId)?.downloaded) {
      toast.error(tr(PAGE_STR).modelNotDownloaded);
      return;
    }
    clearSelection();
    try {
      await retranscribeRange(
        interviewId,
        startMs,
        endMs,
        asrModelId,
        asrLanguage,
        expectedSpeakers,
      );
    } catch (e) {
      toast.error(tr(PAGE_STR).retranscribeFailed(String(e)));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [interviewId, selected, segments, models, asrModelId, asrLanguage, expectedSpeakers]);

  // Resume a failed/crashed run from its saved checkpoint (continue, don't restart).
  const doResume = useCallback(async () => {
    if (!interviewId) return;
    try {
      await resumeTranscription(interviewId, asrLanguage, expectedSpeakers);
    } catch (e) {
      toast.error(tr(PAGE_STR).resumeFailed(String(e)));
    }
  }, [interviewId, asrLanguage, expectedSpeakers]);

  // Play-from-here: seek to the segment's start AND start playback (one click). If this
  // row is already the one playing, toggle to pause instead. Highlight follows from
  // activeMs, which `onTime` keeps live during playback.
  function playSegment(index: number, seg: Segment) {
    if (isPlaying && index === activeIndex) {
      waveRef.current?.pause();
      return;
    }
    waveRef.current?.playFrom(seg.start_ms);
    setActiveMs(seg.start_ms);
  }

  // The active segment index from playback position.
  const activeIndex = useMemo(() => {
    for (let i = segments.length - 1; i >= 0; i--) {
      if (activeMs >= segments[i].start_ms) return i;
    }
    return -1;
  }, [activeMs, segments]);

  // Save → write the 'edited' version + participants (spec §9 M5).
  const doSave = useCallback(async () => {
    if (!interviewId) return;
    const payloadParticipants: ParticipantInput[] = participants
      .filter((p) => p.display_name.trim().length > 0)
      .map((p) => ({
        id: p.id.startsWith("tmp-") ? null : p.id,
        display_name: p.display_name.trim(),
        // draft.role IS the role-library id → send it as role_id (the FK the backend persists
        // and re-derives the name from). Also send a sensible human `role` name for back-compat.
        role: lookupRole(roles, p.role)?.name ?? p.role,
        role_id: p.role,
        speaker_label: p.speaker_label,
      }));
    try {
      await saveMutation.mutateAsync({
        interview_id: interviewId,
        segments,
        participants: payloadParticipants,
        language: version?.language ?? null,
      });
      setDirty(false);
      setActiveKind("edited");
      toast.success(tr(PAGE_STR).saveSuccess);
    } catch (e) {
      toast.error(tr(PAGE_STR).saveFailed(String(e)));
    }
  }, [interviewId, participants, segments, version?.language, saveMutation, roles]);

  // ⌘/Ctrl+S saves; ⌘/Ctrl+F opens the transcript search (instead of the webview's
  // find-in-page, which can't see the segment model); Esc clears an active selection.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key.toLowerCase() === "s" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        if (dirty && !saveMutation.isPending) doSave();
      } else if (e.key.toLowerCase() === "f" && (e.metaKey || e.ctrlKey)) {
        // Only when the segment list is the visible pane — Summary / live view keep
        // whatever the platform does by default.
        if (pane !== "transcript" || isLive) return;
        e.preventDefault();
        setSearchOpen(true);
        // Focus (and select, for quick retyping) after the bar renders.
        requestAnimationFrame(() => {
          searchInputRef.current?.focus();
          searchInputRef.current?.select();
        });
      } else if (e.key === "Escape" && selected.size > 0) {
        // ponytail: Esc clears the selection (the bulk-assign bar's keyboard escape hatch).
        clearSelection();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [dirty, doSave, saveMutation.isPending, selected.size, pane, isLive]);

  // Leaving with unsaved edits is guarded by the router blocker below (back button,
  // breadcrumbs, Cmd+K, citation links — ANY in-app navigation), so goBack just navigates.
  function goBack() {
    navigate(`/cycles/${cycleId}`);
  }

  // Unsaved-changes guard: block in-app navigation while dirty and ask via the shared
  // ConfirmDialog (rendered at the page root) — proceed leaves, cancel/Esc stays.
  const blocker = useBlocker(dirty);

  // Guard the window/tab close (and Tauri window close) while there are unsaved edits.
  // The browser shows its own generic prompt; we only need to set returnValue to trigger it.
  useEffect(() => {
    if (!dirty) return;
    function onBeforeUnload(e: BeforeUnloadEvent) {
      e.preventDefault();
      e.returnValue = "";
    }
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [dirty]);

  return (
    // Lives INSIDE the shell now (under the global header), so this fills its pane rather
    // than the viewport. The header below is a CONTEXTUAL SUB-TOOLBAR, not a shell replacement.
    <div className="flex h-full min-h-0 flex-col bg-background">
      {/* ── Sub-toolbar: back, title, version, save — sits under the global header. ── */}
      <header className="flex h-12 shrink-0 items-center gap-3 border-b border-border px-4">
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={goBack}
          aria-label={t.backToCycle}
          className="text-muted-foreground"
        >
          <ArrowLeft className="size-4" />
        </Button>
        <div className="flex min-w-0 items-center gap-2">
          {/* Quiet breadcrumb: cycle name → interview title, so the editor always shows which
              cycle/interview you're in (wayfinding). Cycle name is muted + non-interactive;
              hidden until the cycle query resolves so it never flashes a placeholder. */}
          {cycle?.name && (
            <span className="hidden min-w-0 shrink items-center gap-1.5 text-sm text-muted-foreground sm:flex">
              <span className="truncate">{cycle.name}</span>
              <span className="text-muted-foreground/50" aria-hidden>
                /
              </span>
            </span>
          )}
          <span className="truncate text-sm font-medium text-foreground">
            {interview?.title ?? t.transcriptFallbackTitle}
          </span>
          {dirty && (
            <span
              className="size-1.5 shrink-0 rounded-full bg-status-importing"
              title={t.unsavedChanges}
              aria-label={t.unsavedChanges}
            />
          )}
        </div>

        <div className="ml-auto flex items-center gap-2">
          {/* Transcript | Summary view toggle (M10b: the per-interview Summary artifact). */}
          <div className="flex items-center rounded-md border border-border p-0.5">
            <button
              type="button"
              onClick={() => setPane("transcript")}
              className={cn(
                "flex items-center gap-1.5 rounded px-2 py-1 text-xs transition-colors",
                pane === "transcript"
                  ? "bg-secondary text-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              <ListTree className="size-3.5" />
              {t.transcript}
            </button>
            <button
              type="button"
              onClick={() => setPane("summary")}
              className={cn(
                "flex items-center gap-1.5 rounded px-2 py-1 text-xs transition-colors",
                pane === "summary"
                  ? "bg-secondary text-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              <FileText className="size-3.5" />
              {t.summary}
            </button>
          </div>

          {/* Whole-transcript cleanup was removed: cleaning the entire interview in one
              JSON-echo pass is exactly where the hallucinations crept in. The fix now lives
              per-segment — each row's "Переписать сегмент" button re-cleans just that segment
              as plain text. The `cleaned` version + clean_transcript command still exist in the
              backend; they're simply no longer driven from the editor. */}

          {/* A run is in flight → the live view owns its own status + Stop; hide the
              version Select + Save until the stored transcript is ready. */}
          {pane === "transcript" && isLive && (
            <span className="inline-flex items-center gap-1.5 text-xs text-status-processing">
              <Loader2 className="size-3.5 animate-spin" />
              <span>{live.diarActive ? t.diarizing : t.transcribing}</span>
            </span>
          )}

          {/* Changes toggle + Save are transcript-only; the Summary view owns its own
              Run/Save controls inside the panel (M10b). The old raw/cleaned/edited version
              Select is gone — all editing happens in this one window, and "what changed vs the
              original" is now answered inline per segment instead of by switching versions. */}
          {pane === "transcript" && !isLive && (
            <>
              {/* Show/hide every changed segment's diff at once. Only shown when something
                  actually differs from the original (otherwise there's nothing to compare). */}
              {changedCount > 0 && (
                <button
                  type="button"
                  onClick={() => setShowDiff((s) => !s)}
                  aria-pressed={showDiff}
                  title={t.showAllDiffsTitle}
                  className={cn(
                    "flex h-7 items-center gap-1.5 rounded-md border px-2 text-xs font-medium transition-colors focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none",
                    showDiff
                      ? "border-status-importing/40 bg-status-importing/10 text-status-importing"
                      : "border-border text-muted-foreground hover:text-foreground",
                  )}
                >
                  <GitCompareArrows className="size-3.5" />
                  {showDiff ? t.hideChanges : t.changes}
                  <span className="font-numeric tabular-nums rounded bg-status-importing/20 px-1 text-[10px] text-status-importing">
                    {changedCount}
                  </span>
                </button>
              )}

              <Button
                size="sm"
                onClick={doSave}
                disabled={!dirty || saveMutation.isPending || !editable}
              >
                <Save className="size-3.5" />
                {saveMutation.isPending ? t.saving : t.save}
                <kbd className="ml-1 hidden font-numeric text-[10px] text-primary-foreground/70 sm:inline">
                  {mod("S")}
                </kbd>
              </Button>
            </>
          )}
        </div>
      </header>

      {/* ── Resume banner: a prior run failed/crashed with saved progress. Offer to continue
          from where it stopped instead of re-running the whole file. Hidden while a run is
          live (the live view owns that state). ── */}
      {checkpoint && !isLive && (
        <div className="flex items-center gap-3 border-b border-status-importing/30 bg-status-importing/10 px-4 py-2">
          <RotateCcw className="size-4 shrink-0 text-status-importing" />
          <div className="min-w-0 flex-1 text-xs">
            <span className="font-medium text-foreground">
              {t.transcriptionStoppedAt(formatTimecode(checkpoint.processed_ms))}
            </span>
            <span className="text-muted-foreground">{t.partialSavedHint}</span>
          </div>
          <Button size="sm" onClick={doResume}>
            <RotateCcw className="size-3.5" />
            {t.resume}
          </Button>
        </div>
      )}

      {/* ── Two-pane resizable body ── */}
      <ResizablePanelGroup direction="horizontal" className="min-h-0 flex-1">
        {/* Left: media + participants. */}
        <ResizablePanel defaultSize={34} minSize={24} maxSize={48}>
          <div className="flex h-full min-h-0 flex-col gap-5 overflow-y-auto border-r border-border p-4">
            <section className="flex flex-col gap-3">
              <div className="flex items-baseline justify-between">
                <span className="text-xs font-medium text-muted-foreground">
                  {t.recording}
                </span>
                {interview?.format && (
                  <span className="font-numeric text-[11px] text-muted-foreground/70 uppercase">
                    {interview.format}
                  </span>
                )}
              </div>
              {audioUrl ? (
                <WaveformPlayer
                  ref={waveRef}
                  url={audioUrl}
                  durationMs={interview?.duration_ms ?? null}
                  onTime={setActiveMs}
                  onPlayingChange={setIsPlaying}
                />
              ) : (
                <p className="text-xs text-muted-foreground">{t.noAudio}</p>
              )}
            </section>

            <div className="h-px shrink-0 bg-border" />

            <ParticipantsPanel
              participants={participants}
              speakerLabels={speakerLabels}
              roles={roles}
              onChange={(next) => {
                setParticipants(next);
                setDirty(true);
              }}
            />

            {unassignedCount > 0 && (
              <p className="flex items-center gap-1.5 rounded-md bg-status-importing/10 px-2.5 py-1.5 text-xs text-status-importing">
                <span className="size-1.5 rounded-full bg-status-importing" />
                {unassignedCount} {pluralSegments(unassignedCount)} {t.unassignedSuffix}
              </p>
            )}
          </div>
        </ResizablePanel>

        <ResizableHandle withHandle />

        {/* Right: segment list, or the per-interview Summary artifact (M10b). */}
        <ResizablePanel defaultSize={66} minSize={40}>
          {pane === "summary" ? (
            <InterviewSummaryPanel interviewId={interviewId ?? ""} />
          ) : isLive ? (
            <LiveTranscriptView
              segments={live.segments}
              progress={live.progress}
              diarActive={live.diarActive}
              diarStartedAt={live.diarStartedAt}
              speakers={live.speakers}
              durationMs={interview?.duration_ms ?? null}
              onStop={() => {
                if (interviewId) cancelTranscription(interviewId).catch(() => {});
              }}
            />
          ) : (
          <div className="relative flex h-full min-h-0 flex-col">
            {/* ponytail: dropped the cryptic "shift-click a row…" hint — the per-row
                selection checkbox + the bulk-assign bar make the interaction self-evident. */}
            <div className="flex min-h-10 items-center justify-between gap-3 border-b border-border px-4 py-1.5">
              <span className="shrink-0 text-xs text-muted-foreground">
                <span className="font-numeric tabular-nums text-foreground/70">
                  {segments.length}
                </span>{" "}
                {pluralSegments(segments.length)}
              </span>

              {/* ── Inline transcript search (Ctrl/Cmd+F). Slim, hairline, right-aligned:
                  query field + N/total counter (tabular) + prev/next + close. ── */}
              {searchOpen ? (
                <div className="flex min-w-0 items-center gap-1.5">
                  <div className="flex h-7 min-w-0 items-center gap-1.5 rounded-md border border-border bg-background px-2 focus-within:border-ring">
                    <Search className="size-3.5 shrink-0 text-muted-foreground" />
                    <input
                      ref={searchInputRef}
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          gotoMatch(searchCurrent + (e.shiftKey ? -1 : 1));
                        } else if (e.key === "ArrowDown") {
                          e.preventDefault();
                          gotoMatch(searchCurrent + 1);
                        } else if (e.key === "ArrowUp") {
                          e.preventDefault();
                          gotoMatch(searchCurrent - 1);
                        } else if (e.key === "Escape") {
                          e.preventDefault();
                          e.stopPropagation();
                          closeSearch();
                        }
                      }}
                      placeholder={t.searchPlaceholder}
                      aria-label={t.searchPlaceholder}
                      className="w-44 min-w-0 bg-transparent text-xs text-foreground outline-none placeholder:text-muted-foreground sm:w-56"
                    />
                    <span className="shrink-0 font-numeric text-[11px] text-muted-foreground tabular-nums">
                      {t.searchMatches(
                        searchMatches.length === 0
                          ? 0
                          : Math.min(searchCurrent + 1, searchMatches.length),
                        searchMatches.length,
                      )}
                    </span>
                  </div>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className="text-muted-foreground"
                    disabled={searchMatches.length === 0}
                    onClick={() => gotoMatch(searchCurrent - 1)}
                    aria-label={t.prevMatch}
                    title={t.prevMatch}
                  >
                    <ChevronUp className="size-3.5" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className="text-muted-foreground"
                    disabled={searchMatches.length === 0}
                    onClick={() => gotoMatch(searchCurrent + 1)}
                    aria-label={t.nextMatch}
                    title={t.nextMatch}
                  >
                    <ChevronDown className="size-3.5" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className="text-muted-foreground"
                    onClick={closeSearch}
                    aria-label={t.closeSearch}
                    title={t.closeSearch}
                  >
                    <X className="size-3.5" />
                  </Button>
                </div>
              ) : (
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-muted-foreground"
                  onClick={() => {
                    setSearchOpen(true);
                    requestAnimationFrame(() => searchInputRef.current?.focus());
                  }}
                  aria-label={t.searchPlaceholder}
                >
                  <Search className="size-3.5" />
                  <kbd className="hidden font-numeric text-[10px] text-muted-foreground/70 sm:inline">
                    {mod("F")}
                  </kbd>
                </Button>
              )}
            </div>

            {/* ponytail: ONE clean scroll region for the whole segment list. pr-3 keeps the
                scrollbar tucked inside the pane with breathing room so it never renders under
                / collides with the chat split-panel handle on the right. The textareas no
                longer scroll (overflow-hidden + autosize), so this is the only scrollbar here. */}
            <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto pl-2 pr-3 py-3">
              {versionPending && segments.length === 0 ? (
                <div className="flex flex-col gap-3 px-2">
                  {Array.from({ length: 8 }).map((_, i) => (
                    <div key={i} className="flex gap-3">
                      <Skeleton className="h-10 w-24 shrink-0" />
                      <Skeleton className="h-10 flex-1" />
                    </div>
                  ))}
                </div>
              ) : segments.length === 0 ? (
                <div className="flex h-full items-center justify-center">
                  <p className="text-sm text-muted-foreground">
                    {t.noSegmentsInVersion}
                  </p>
                </div>
              ) : (
                // ponytail: fill the pane (drop the mx-auto max-w-3xl empty-space cap) —
                // the editor is dense work; use the width. max-w-5xl still keeps a sane
                // line length on ultrawide so text doesn't run edge-to-edge.
                // Render TURNS (grouped same-speaker runs), not raw rows — the transcript
                // reads as an alternating dialogue while each segment stays editable.
                <div
                  role="listbox"
                  aria-multiselectable="true"
                  aria-label={t.transcriptSegments}
                  className="flex max-w-5xl flex-col gap-1"
                >
                  {turns.map((turn) => {
                    const resolved = resolveRole(turn.speakerLabel);
                    return (
                      <TurnBlock
                        key={turn.segmentIndices[0]}
                        turn={turn}
                        segments={segments}
                        roleColor={resolved.color}
                        roleLabel={resolved.label}
                        unassigned={resolved.unassigned}
                        participants={participants}
                        roles={roles}
                        activeIndex={activeIndex}
                        isPlaying={isPlaying}
                        selected={selected}
                        focusedIndex={focusedIndex}
                        canRewrite={editable}
                        rewritingIndex={rewritingIndex}
                        baselines={baselines}
                        showDiff={showDiff}
                        onAssignTurn={(label) =>
                          assignTurn(turn.segmentIndices, label)
                        }
                        onPlay={(i) => playSegment(i, segments[i])}
                        onText={(i, t) => setText(i, t)}
                        onToggleSelect={(i, e) => toggleSelect(i, e)}
                        onRewrite={(i) => rewriteSegmentAt(i)}
                        onRevert={(i) => revertSegment(i)}
                        onSegmentKeyDown={onSegmentKeyDown}
                        onSegmentFocus={setFocusedIndex}
                      />
                    );
                  })}
                </div>
              )}
            </div>

            {/* ── Bulk-assign action bar (multi-select). Floats over the segment list
                when ≥1 row is selected: "N selected" + an "Assign speaker ▾" picker (the
                same role library popover as the per-row control) + Clear. Picking assigns
                the speaker/role to every selected segment, then clears the selection. ── */}
            {selected.size > 0 && (
              <div className="pointer-events-none absolute inset-x-0 bottom-0 flex justify-center px-4 pb-4">
                <div className="pointer-events-auto flex items-center gap-2 rounded-lg border border-border bg-popover/95 px-2 py-1.5 shadow-lg shadow-black/20 backdrop-blur supports-[backdrop-filter]:bg-popover/80">
                  <span className="pl-1.5 text-xs text-foreground">
                    {t.selectedLabel}{" "}
                    <span className="font-numeric tabular-nums font-medium">
                      {selected.size}
                    </span>
                  </span>
                  <span className="h-4 w-px bg-border" aria-hidden />
                  <SpeakerPicker
                    current=""
                    participants={participants}
                    roles={roles}
                    onPick={assignSelected}
                  >
                    <Button size="xs" variant="secondary" disabled={!editable}>
                      <Users className="size-3" />
                      {t.assignSpeaker}
                      <ChevronDown className="size-3 opacity-70" />
                    </Button>
                  </SpeakerPicker>
                  {/* Re-transcribe just the selected span (redo a chunk that came out wrong):
                      whisper re-runs on [first start, last end] + the whole audio re-diarizes. */}
                  <Button
                    size="xs"
                    variant="secondary"
                    onClick={retranscribeSelection}
                    title={t.retranscribeSelectionTitle}
                  >
                    <RotateCcw className="size-3" />
                    {t.retranscribe}
                  </Button>
                  <Button
                    size="xs"
                    variant="ghost"
                    onClick={clearSelection}
                    className="text-muted-foreground"
                  >
                    <X className="size-3" />
                    {t.clear}
                  </Button>
                </div>
              </div>
            )}
          </div>
          )}
        </ResizablePanel>
      </ResizablePanelGroup>

      {/* Unsaved-changes guard for in-app navigation (paired with the beforeunload
          listener above for window close/reload). */}
      <ConfirmDialog
        open={blocker.state === "blocked"}
        onOpenChange={(o) => {
          if (!o && blocker.state === "blocked") blocker.reset();
        }}
        title={t.unsavedTitle}
        body={t.unsavedBody}
        confirmLabel={t.leaveAction}
        destructive
        onConfirm={() => {
          if (blocker.state === "blocked") blocker.proceed();
        }}
      />
    </div>
  );
}
