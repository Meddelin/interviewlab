import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useNavigate, useParams } from "react-router-dom";
import { convertFileSrc } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import {
  ArrowLeft,
  Check,
  ChevronDown,
  FileText,
  ListTree,
  Loader2,
  Pause,
  Play,
  Plus,
  Save,
  Sparkles,
  Trash2,
  Users,
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
import { useRoles } from "@/lib/role-queries";
import type { Role } from "@/lib/tauri";
import {
  WaveformPlayer,
  type WaveformHandle,
} from "@/components/waveform-player";
import { useInterviews } from "@/lib/interview-queries";
import {
  useCleanTranscript,
  useParticipants,
  useSaveEditedTranscript,
  useTranscriptVersion,
  useTranscriptVersions,
} from "@/lib/transcript-queries";
import type {
  CleanupProgress,
  InterviewRow,
  Participant,
  ParticipantInput,
  Segment,
} from "@/lib/tauri";
import { CLEANUP_PROGRESS_EVENT, IN_TAURI } from "@/lib/tauri";
import { mockAudioSrc, mockOnCleanupProgress } from "@/lib/dev-mock";
import { formatTimecode } from "@/lib/format";
import { cn } from "@/lib/utils";

// Version Select labels (raw arrives in M4, cleaned in M7, edited is what we write).
const KIND_LABEL: Record<string, string> = {
  raw: "Raw",
  cleaned: "Cleaned",
  edited: "Edited",
};

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
  const [open, setOpen] = useState(false);
  // Participants with a bound speaker label are the primary choices.
  const bound = participants.filter((p) => p.speaker_label);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent align="start" className="w-64 p-0">
        <Command>
          <CommandInput placeholder="Assign speaker…" className="h-9" />
          <CommandList>
            <CommandEmpty>No participants yet.</CommandEmpty>
            {bound.length > 0 && (
              <CommandGroup heading="Participants">
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
            <CommandGroup heading="Set role directly">
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
          <span>Participants &amp; speakers</span>
        </div>
        <Button variant="ghost" size="xs" onClick={add} className="text-muted-foreground">
          <Plus className="size-3" />
          Add
        </Button>
      </div>

      {participants.length === 0 ? (
        <p className="rounded-md border border-dashed border-border px-3 py-4 text-center text-xs text-muted-foreground">
          No participants yet. Add the interviewer and respondent, then bind each to a
          speaker.
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
                  placeholder="Name"
                  onChange={(e) => update(p.id, { display_name: e.target.value })}
                  className="h-7 flex-1 border-transparent bg-transparent px-1.5 text-sm shadow-none focus-visible:border-input"
                />
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label="Remove participant"
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
                    <SelectValue placeholder="Speaker" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NONE}>
                      <span className="text-muted-foreground">No speaker</span>
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
function SegmentLine({
  segment,
  index,
  active,
  playing,
  selected,
  onPlay,
  onText,
  onToggleSelect,
}: {
  segment: Segment;
  index: number;
  active: boolean;
  playing: boolean;
  selected: boolean;
  onPlay: () => void;
  onText: (text: string) => void;
  onToggleSelect: (e: React.MouseEvent) => void;
}) {
  const taRef = useRef<HTMLTextAreaElement | null>(null);

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
      className={cn(
        // ponytail: every row state must be unmistakable (founder bar: "the user must
        // always clearly see the interface react"). Selected = clear accent wash + ring;
        // playing/active = accent wash; plain hover = an obvious surface lift, not a whisper.
        "group/seg relative grid grid-cols-[auto_auto_1fr] gap-x-3 gap-y-1 rounded-lg px-2.5 py-1.5 transition-colors",
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
        aria-label={selected ? `Deselect segment ${index + 1}` : `Select segment ${index + 1}`}
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
          title={playing ? "Pause" : "Play from this timestamp"}
          aria-label={playing ? "Pause" : `Play from ${formatTimecode(segment.start_ms)}`}
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
          aria-label={`Edit segment ${index + 1} text`}
          className={cn(
            "block w-full cursor-text resize-none overflow-hidden rounded-md border bg-transparent px-2 py-1 -mx-2 -my-1 text-[13.5px] leading-relaxed text-foreground/90 outline-none transition-colors placeholder:text-muted-foreground",
            "border-transparent group-hover/seg:border-border group-hover/seg:bg-background/60",
            "focus:border-ring focus:bg-background/80 focus:text-foreground focus:ring-2 focus:ring-ring/40",
          )}
        />
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
  onAssignTurn,
  onPlay,
  onText,
  onToggleSelect,
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
  onAssignTurn: (label: string) => void;
  onPlay: (index: number) => void;
  onText: (index: number, text: string) => void;
  onToggleSelect: (index: number, e: React.MouseEvent) => void;
}) {
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
            title="Assign speaker for this turn"
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
            onPlay={() => onPlay(i)}
            onText={(t) => onText(i, t)}
            onToggleSelect={(e) => onToggleSelect(i, e)}
          />
        ))}
      </div>
    </div>
  );
}

// ─── The editor page ───────────────────────────────────────────────────────────
export function TranscriptEditorPage() {
  const { cycleId, interviewId } = useParams<{
    cycleId: string;
    interviewId: string;
  }>();
  const navigate = useNavigate();

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
  const { data: participantsData } = useParticipants(interviewId);
  const { data: rolesData } = useRoles();
  const roles = useMemo(() => rolesData ?? [], [rolesData]);
  const saveMutation = useSaveEditedTranscript(interviewId ?? "");
  const cleanMutation = useCleanTranscript(interviewId ?? "");

  // Live batch progress for the "Clean transcript" pass (cleanup://progress). null when
  // not running; a 0..100 percent while batches stream.
  const [cleanPct, setCleanPct] = useState<number | null>(null);
  useEffect(() => {
    if (!interviewId) return;
    function onCleanup(p: CleanupProgress) {
      if (p.interview_id !== interviewId) return;
      if (p.status === "cleaning") setCleanPct(p.progress);
      else setCleanPct(null); // cleaned | error → clear
    }
    if (!IN_TAURI) {
      return mockOnCleanupProgress(onCleanup);
    }
    const unlisten = getCurrentWebview().listen<CleanupProgress>(
      CLEANUP_PROGRESS_EVENT,
      (e) => onCleanup(e.payload),
    );
    return () => {
      unlisten.then((fn) => fn());
    };
  }, [interviewId]);

  // Run the cleanup pass: stores the `cleaned` version, then switches the Select to it.
  const cleaning = cleanMutation.isPending || cleanPct != null;
  const doClean = useCallback(async () => {
    if (!interviewId || cleaning) return;
    setCleanPct(0);
    try {
      await cleanMutation.mutateAsync();
      setActiveKind("cleaned");
      toast.success("Transcript cleaned");
    } catch (e) {
      toast.error(`Couldn't clean the transcript. ${String(e)}`);
    } finally {
      setCleanPct(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [interviewId, cleaning, cleanMutation]);

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
  // Which right-pane view is shown: the transcript segments or the per-interview Summary
  // artifact (Milestone 10b).
  const [pane, setPane] = useState<"transcript" | "summary">("transcript");
  const waveRef = useRef<WaveformHandle | null>(null);

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
      toast.success("Saved edited transcript");
    } catch (e) {
      toast.error(`Couldn't save. ${String(e)}`);
    }
  }, [interviewId, participants, segments, version?.language, saveMutation, roles]);

  // ⌘/Ctrl+S saves; Esc clears an active selection.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key.toLowerCase() === "s" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        if (dirty && !saveMutation.isPending) doSave();
      } else if (e.key === "Escape" && selected.size > 0) {
        // ponytail: Esc clears the selection (the bulk-assign bar's keyboard escape hatch).
        clearSelection();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [dirty, doSave, saveMutation.isPending, selected.size]);

  function goBack() {
    navigate(`/cycles/${cycleId}`);
  }

  const availableKinds = versions?.map((v) => v.kind) ?? [];

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
          aria-label="Back to cycle"
          className="text-muted-foreground"
        >
          <ArrowLeft className="size-4" />
        </Button>
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate text-sm font-medium text-foreground">
            {interview?.title ?? "Transcript"}
          </span>
          {dirty && (
            <span
              className="size-1.5 shrink-0 rounded-full bg-status-importing"
              title="Unsaved changes"
              aria-label="Unsaved changes"
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
              Transcript
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
              Summary
            </button>
          </div>

          {/* Clean transcript ("no grammar errors" pass, spec §6.7). Available once a
              raw transcript exists; stores the `cleaned` version + switches to it. */}
          {pane === "transcript" && availableKinds.includes("raw") && (
            <Button
              variant="outline"
              size="sm"
              onClick={doClean}
              disabled={cleaning}
              title="Fix grammar, punctuation and filler — timing and speakers are preserved"
            >
              {cleaning ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <Sparkles className="size-3.5" />
              )}
              {cleaning
                ? cleanPct != null
                  ? `Cleaning… ${cleanPct}%`
                  : "Cleaning…"
                : availableKinds.includes("cleaned")
                  ? "Re-clean"
                  : "Clean transcript"}
            </Button>
          )}

          {/* Version Select + Save are transcript-only; the Summary view owns its own
              Run/Save controls inside the panel (M10b). */}
          {pane === "transcript" && (
            <>
              {/* Version Select (raw / cleaned / edited). */}
              <Select value={activeKind} onValueChange={setActiveKind}>
                <SelectTrigger size="sm" className="h-7 min-w-24">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent align="end">
                  {(["raw", "cleaned", "edited"] as const).map((k) => (
                    <SelectItem
                      key={k}
                      value={k}
                      disabled={!availableKinds.includes(k)}
                    >
                      {KIND_LABEL[k]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>

              <Button
                size="sm"
                onClick={doSave}
                disabled={!dirty || saveMutation.isPending || !editable}
              >
                <Save className="size-3.5" />
                {saveMutation.isPending ? "Saving…" : "Save"}
                <kbd className="ml-1 hidden font-numeric text-[10px] text-primary-foreground/70 sm:inline">
                  ⌘S
                </kbd>
              </Button>
            </>
          )}
        </div>
      </header>

      {/* ── Two-pane resizable body ── */}
      <ResizablePanelGroup direction="horizontal" className="min-h-0 flex-1">
        {/* Left: media + participants. */}
        <ResizablePanel defaultSize={34} minSize={24} maxSize={48}>
          <div className="flex h-full min-h-0 flex-col gap-5 overflow-y-auto border-r border-border p-4">
            <section className="flex flex-col gap-3">
              <div className="flex items-baseline justify-between">
                <span className="text-xs font-medium text-muted-foreground">
                  Recording
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
                <p className="text-xs text-muted-foreground">
                  No prepared audio for this interview.
                </p>
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
                {unassignedCount} segment{unassignedCount > 1 ? "s" : ""} without an
                assigned role
              </p>
            )}
          </div>
        </ResizablePanel>

        <ResizableHandle withHandle />

        {/* Right: segment list, or the per-interview Summary artifact (M10b). */}
        <ResizablePanel defaultSize={66} minSize={40}>
          {pane === "summary" ? (
            <InterviewSummaryPanel interviewId={interviewId ?? ""} />
          ) : (
          <div className="relative flex h-full min-h-0 flex-col">
            {/* ponytail: dropped the cryptic "shift-click a row…" hint — the per-row
                selection checkbox + the bulk-assign bar make the interaction self-evident. */}
            <div className="flex items-center justify-between border-b border-border px-4 py-2">
              <span className="text-xs text-muted-foreground">
                <span className="font-numeric tabular-nums text-foreground/70">
                  {segments.length}
                </span>{" "}
                segments
              </span>
            </div>

            {/* ponytail: ONE clean scroll region for the whole segment list. pr-3 keeps the
                scrollbar tucked inside the pane with breathing room so it never renders under
                / collides with the chat split-panel handle on the right. The textareas no
                longer scroll (overflow-hidden + autosize), so this is the only scrollbar here. */}
            <div className="min-h-0 flex-1 overflow-y-auto pl-2 pr-3 py-3">
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
                    No segments in this version.
                  </p>
                </div>
              ) : (
                // ponytail: fill the pane (drop the mx-auto max-w-3xl empty-space cap) —
                // the editor is dense work; use the width. max-w-5xl still keeps a sane
                // line length on ultrawide so text doesn't run edge-to-edge.
                // Render TURNS (grouped same-speaker runs), not raw rows — the transcript
                // reads as an alternating dialogue while each segment stays editable.
                <div className="flex max-w-5xl flex-col gap-1">
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
                        onAssignTurn={(label) =>
                          assignTurn(turn.segmentIndices, label)
                        }
                        onPlay={(i) => playSegment(i, segments[i])}
                        onText={(i, t) => setText(i, t)}
                        onToggleSelect={(i, e) => toggleSelect(i, e)}
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
                    <span className="font-numeric tabular-nums font-medium">
                      {selected.size}
                    </span>{" "}
                    selected
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
                      Assign speaker
                      <ChevronDown className="size-3 opacity-70" />
                    </Button>
                  </SpeakerPicker>
                  <Button
                    size="xs"
                    variant="ghost"
                    onClick={clearSelection}
                    className="text-muted-foreground"
                  >
                    <X className="size-3" />
                    Clear
                  </Button>
                </div>
              </div>
            )}
          </div>
          )}
        </ResizablePanel>
      </ResizablePanelGroup>
    </div>
  );
}
