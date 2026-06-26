import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { type ColumnDef } from "@tanstack/react-table";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { useQueryClient } from "@tanstack/react-query";
import {
  BookText,
  Check,
  FileAudio,
  FileText,
  FileUp,
  Loader2,
  Pencil,
  PencilLine,
  Sparkles,
  Square,
  Trash2,
  Upload,
  Users,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { DataTable } from "@/components/data-table";
import { StatusDot, interviewStatus } from "@/components/status-dot";
import { formatDuration } from "@/lib/format";
import { cn } from "@/lib/utils";
import {
  interviewKeys,
  useAddInterviewFiles,
  useDeleteInterview,
  useInterviews,
  useRenameInterview,
} from "@/lib/interview-queries";
import { useModels } from "@/lib/asr-queries";
import { useUiStore } from "@/lib/ui-store";
import { useLiveAsrStore } from "@/lib/live-asr-store";
import {
  cancelTranscription,
  cleanTranscript,
  IN_TAURI,
  importTranscriptFile,
  INTERVIEW_PROGRESS_EVENT,
  rediarizeInterview,
  type InterviewProgress,
  type InterviewRow,
  transcribeInterview,
} from "@/lib/tauri";
import { GlossarySuggestDialog } from "@/components/glossary-suggest-dialog";
// dev-mock: browser-only, never active under Tauri.
import { mockOnDragDrop, mockOnProgress } from "@/lib/dev-mock";

// Audio/video extensions we accept for ingest (spec §3.2 batch ingest).
const MEDIA_EXTS = [
  "mp3",
  "wav",
  "m4a",
  "aac",
  "ogg",
  "flac",
  "mp4",
  "mov",
  "mkv",
  "webm",
  "avi",
];


export function InterviewsTab({ cycleId }: { cycleId: string }) {
  const navigate = useNavigate();
  const { data: interviews, isPending } = useInterviews(cycleId);
  const { data: models } = useModels();
  const addFiles = useAddInterviewFiles(cycleId);
  const deleteInterview = useDeleteInterview(cycleId);
  const renameInterview = useRenameInterview(cycleId);
  const qc = useQueryClient();
  const [isDragOver, setIsDragOver] = useState(false);
  // Inline title rename: the row being edited (null = none) + its working value.
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");

  // The model + language + expected-speaker count chosen in Settings → Transcription drive
  // every Transcribe / Re-diarize.
  const asrModelId = useUiStore((s) => s.asrModelId);
  const asrLanguage = useUiStore((s) => s.asrLanguage);
  const asrExpectedSpeakers = useUiStore((s) => s.asrExpectedSpeakers);
  const selectedModel = models?.find((m) => m.id === asrModelId);
  // Map the persisted "auto" | "2" | "3" | "4" pref → the backend's expectedSpeakers arg
  // (null = auto-detect, else the forced count).
  const expectedSpeakers =
    asrExpectedSpeakers === "auto" ? null : Number(asrExpectedSpeakers);

  // The interview whose glossary-suggest dialog is open (null = closed).
  const [glossaryFor, setGlossaryFor] = useState<InterviewRow | null>(null);

  // Live run progress comes from the GLOBAL live-asr store (fed by the app-level useLiveAsr
  // listener), NOT local state — so the "Transcribing… / Diarizing… / Cleaning… N%" badges
  // survive switching cycle tabs and the editor round-trip (the store outlives this tab).
  const liveAsr = useLiveAsrStore((s) => s.byInterview);
  const cleanProgress = useLiveAsrStore((s) => s.cleanByInterview);
  const markTranscribing = useLiveAsrStore((s) => s.markTranscribing);
  const markCleaning = useLiveAsrStore((s) => s.markCleaning);
  const clearCleaning = useLiveAsrStore((s) => s.clearCleaning);
  const resetLive = useLiveAsrStore((s) => s.reset);
  // Per-row maps the columns read: transcription percent (while whisper runs) and the
  // diarization phase (after whisper hits 100%, before the row flips to `transcribed` — so the
  // badge shows a distinct "Diarizing…" instead of a frozen "Transcribing 100%").
  const asrProgress = useMemo(() => {
    const m: Record<string, number> = {};
    for (const [id, a] of Object.entries(liveAsr)) {
      if (a.status === "transcribing") m[id] = a.progress;
    }
    return m;
  }, [liveAsr]);
  const diarizing = useMemo(() => {
    const m: Record<string, boolean> = {};
    for (const [id, a] of Object.entries(liveAsr)) {
      if (a.diarActive) m[id] = true;
    }
    return m;
  }, [liveAsr]);

  // Live row updates: each finished file emits `interview://progress`; just
  // invalidate this cycle's list so the table re-renders with new status/duration.
  useEffect(() => {
    // dev-mock: browser-only, never active under Tauri.
    if (!IN_TAURI) {
      const unlisten = mockOnProgress((payload) => {
        if (payload.cycle_id !== cycleId) return;
        qc.invalidateQueries({ queryKey: interviewKeys.list(cycleId) });
        if (payload.status === "error") {
          toast.error(`Media prep failed: ${payload.error ?? "unknown"}`);
        }
      });
      return unlisten;
    }
    const unlisten = getCurrentWebview().listen<InterviewProgress>(
      INTERVIEW_PROGRESS_EVENT,
      (event) => {
        if (event.payload.cycle_id !== cycleId) return;
        qc.invalidateQueries({ queryKey: interviewKeys.list(cycleId) });
        if (event.payload.status === "error") {
          toast.error(`Media prep failed: ${event.payload.error ?? "unknown"}`);
        }
      },
    );
    return () => {
      unlisten.then((fn) => fn());
    };
  }, [cycleId, qc]);

  // Tauri window drag-drop: browser File objects don't carry real fs paths, so we
  // use the webview's native drag-drop event to get absolute paths (spec M3 note).
  useEffect(() => {
    // dev-mock: browser-only, never active under Tauri. No real OS drag-drop in a
    // browser, so this is a no-op subscription (the visible drop zone stays inert).
    if (!IN_TAURI) {
      return mockOnDragDrop();
    }
    const unlisten = getCurrentWebview().onDragDropEvent((event) => {
      if (event.payload.type === "over" || event.payload.type === "enter") {
        setIsDragOver(true);
      } else if (event.payload.type === "drop") {
        setIsDragOver(false);
        const paths = filterMedia(event.payload.paths);
        if (paths.length) ingest(paths);
        else if (event.payload.paths.length)
          toast.error("No supported audio/video files in the drop");
      } else {
        setIsDragOver(false);
      }
    });
    return () => {
      unlisten.then((fn) => fn());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cycleId]);

  // NOTE: transcription / diarization / cleanup progress is captured GLOBALLY by the app-level
  // useLiveAsr listener into the live-asr store (it also invalidates the list + toasts on a
  // terminal event), so those listeners no longer live here — that's what makes the running
  // badges survive a tab switch / editor round-trip.

  function filterMedia(paths: string[]): string[] {
    return paths.filter((p) => {
      const ext = p.split(".").pop()?.toLowerCase() ?? "";
      return MEDIA_EXTS.includes(ext);
    });
  }

  // Transcribe one interview with the Settings-chosen model + language. Optimistically
  // flips the row to 'transcribing'; the asr://progress stream + invalidation do the rest.
  async function transcribe(row: InterviewRow) {
    if (!selectedModel?.downloaded) {
      toast.error(
        `The "${selectedModel?.label ?? asrModelId}" model isn't downloaded yet — get it in Settings → Transcription.`,
      );
      return;
    }
    markTranscribing(row.id);
    try {
      await transcribeInterview(row.id, asrModelId, asrLanguage, expectedSpeakers);
    } catch (e) {
      resetLive(row.id);
      toast.error(`Couldn't transcribe. ${String(e)}`);
    } finally {
      qc.invalidateQueries({ queryKey: interviewKeys.list(cycleId) });
    }
  }

  // Attach an already-diarized transcript (.txt) instead of running local ASR. Picks the
  // file, hands the path to the backend (which parses → stores it as the raw transcript →
  // seeds participants from the speaker names → flips status to 'transcribed'), then
  // refreshes so Edit/Clean/Re-diarize unlock. The audio stays attached, so media seek,
  // clearing a segment and re-transcribing a range keep working.
  async function importTxt(row: InterviewRow) {
    if (!IN_TAURI) {
      toast.error("Importing a transcript file works in the desktop app.");
      return;
    }
    const selected = await openFileDialog({
      multiple: false,
      filters: [{ name: "Transcript", extensions: ["txt"] }],
    });
    if (!selected) return;
    const path = Array.isArray(selected) ? selected[0] : selected;
    try {
      const res = await importTranscriptFile(row.id, path);
      toast.success(
        `Imported transcript for "${row.title}" — ${res.segments} segment${res.segments === 1 ? "" : "s"}, ${res.speakers} speaker${res.speakers === 1 ? "" : "s"}`,
      );
    } catch (e) {
      toast.error(`Couldn't import the transcript. ${String(e)}`);
    } finally {
      qc.invalidateQueries({ queryKey: interviewKeys.list(cycleId) });
    }
  }

  // Stop a running transcription (bug #5). Signals the backend cancel flag; whisper aborts
  // mid-run, the interview lands on `error`, and the queue frees. Clear the local percent
  // optimistically so the row drops out of the "Transcribing…" state immediately.
  async function stopTranscription(row: InterviewRow) {
    try {
      await cancelTranscription(row.id);
      resetLive(row.id);
      toast.message(`Stopping "${row.title}"…`);
    } catch (e) {
      toast.error(`Couldn't stop. ${String(e)}`);
    } finally {
      qc.invalidateQueries({ queryKey: interviewKeys.list(cycleId) });
    }
  }

  // Re-diarize an existing transcript with the Settings-chosen expected-speaker count.
  // Resolves with the detected speaker count, which we toast; the stored segments get the
  // fresh S1/S2/… labels (the editor re-reads them on open). ponytail: no optimistic row
  // badge — re-diarize is quick and doesn't change the interview's status.
  async function rediarize(row: InterviewRow) {
    try {
      const speakers = await rediarizeInterview(row.id, expectedSpeakers);
      toast.success(
        `Re-diarized "${row.title}" — ${speakers} speaker${speakers === 1 ? "" : "s"} detected`,
      );
      qc.invalidateQueries({ queryKey: interviewKeys.list(cycleId) });
    } catch (e) {
      toast.error(`Couldn't re-diarize. ${String(e)}`);
    }
  }

  // Run the "no grammar errors" cleanup pass (spec §6.7). Optimistically flips the row
  // to 'cleaning'; the cleanup://progress stream + invalidation do the rest.
  async function clean(row: InterviewRow) {
    markCleaning(row.id);
    try {
      await cleanTranscript(row.id);
      toast.success(`Cleaned "${row.title}"`);
    } catch (e) {
      clearCleaning(row.id);
      toast.error(`Couldn't clean. ${String(e)}`);
    } finally {
      qc.invalidateQueries({ queryKey: interviewKeys.list(cycleId) });
    }
  }

  // A transcript exists once an interview is transcribed/cleaned/edited → the editor opens.
  function canEdit(row: InterviewRow): boolean {
    return (
      row.status === "transcribed" ||
      row.status === "cleaned" ||
      row.status === "edited" ||
      // Open WHILE transcribing too: a slow (e.g. Mac CPU) run is exactly when you want to
      // get into the window and watch the transcript + diarization fill in live. The editor
      // detects the in-flight run and shows its live view instead of an empty transcript.
      row.status === "transcribing" ||
      asrProgress[row.id] != null ||
      // Also open `error` rows: a failed cleanup (or other post-transcription step) must never
      // lock the user out of a good transcript. The editor loads whatever versions exist and
      // shows a graceful empty state if there genuinely is none, so this is always safe.
      row.status === "error"
    );
  }

  function openEditor(row: InterviewRow) {
    navigate(`/cycles/${cycleId}/interviews/${row.id}`);
  }

  function startRename(row: InterviewRow) {
    setRenamingId(row.id);
    setRenameValue(row.title);
  }

  function cancelRename() {
    setRenamingId(null);
    setRenameValue("");
  }

  async function commitRename(row: InterviewRow) {
    const title = renameValue.trim();
    if (!title || title === row.title) {
      cancelRename();
      return;
    }
    try {
      await renameInterview.mutateAsync({ id: row.id, title });
      cancelRename();
    } catch (e) {
      toast.error(`Couldn't rename the interview. ${String(e)}`);
    }
  }

  async function ingest(paths: string[]) {
    try {
      await addFiles.mutateAsync(paths);
      toast.success(
        `Importing ${paths.length} file${paths.length > 1 ? "s" : ""}…`,
      );
    } catch (e) {
      toast.error(`Couldn't start the import. ${String(e)}`);
    }
  }

  // "Add files" button: dialog plugin file-picker → absolute paths (reliable
  // fallback to drag-drop, which the spec requires).
  async function handlePick() {
    // dev-mock: browser-only, never active under Tauri. The native file dialog
    // doesn't exist in a browser, so feed the mock a couple of fake paths instead
    // so the importing→ready flow is demonstrable for design review.
    if (!IN_TAURI) {
      ingest([
        "C:/Users/stas/Recordings/new-session-a.mp3",
        "C:/Users/stas/Recordings/new-session-b.m4a",
      ]);
      return;
    }
    const selected = await openFileDialog({
      multiple: true,
      filters: [{ name: "Audio/Video", extensions: MEDIA_EXTS }],
    });
    if (!selected) return;
    const paths = Array.isArray(selected) ? selected : [selected];
    if (paths.length) ingest(paths);
  }

  const columns = useMemo<ColumnDef<InterviewRow>[]>(
    () => [
      {
        accessorKey: "title",
        header: "Interview",
        cell: ({ row }) => {
          if (renamingId === row.original.id) {
            return (
              <span className="flex items-center gap-1.5">
                <FileAudio className="size-4 shrink-0 text-muted-foreground" />
                <Input
                  autoFocus
                  value={renameValue}
                  onChange={(e) => setRenameValue(e.target.value)}
                  onClick={(e) => e.stopPropagation()}
                  onKeyDown={(e) => {
                    e.stopPropagation();
                    if (e.key === "Enter") commitRename(row.original);
                    if (e.key === "Escape") cancelRename();
                  }}
                  className="h-7"
                />
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Save title"
                  disabled={renameInterview.isPending}
                  onClick={(e) => {
                    e.stopPropagation();
                    commitRename(row.original);
                  }}
                >
                  <Check className="size-3.5" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Cancel rename"
                  onClick={(e) => {
                    e.stopPropagation();
                    cancelRename();
                  }}
                >
                  <X className="size-3.5" />
                </Button>
              </span>
            );
          }
          return (
            <span className="group/title flex items-center gap-2 font-medium">
              <FileAudio className="size-4 shrink-0 text-muted-foreground" />
              <span className="truncate">{row.original.title}</span>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={`Rename ${row.original.title}`}
                className="shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover/row:opacity-100 focus-visible:opacity-100"
                onClick={(e) => {
                  e.stopPropagation();
                  startRename(row.original);
                }}
              >
                <Pencil className="size-3.5" />
              </Button>
            </span>
          );
        },
      },
      {
        accessorKey: "duration_ms",
        header: () => <span className="block text-right">Duration</span>,
        cell: ({ row }) => (
          <span className="block text-right font-numeric text-xs text-muted-foreground">
            {formatDuration(row.original.duration_ms)}
          </span>
        ),
      },
      {
        accessorKey: "status",
        header: "Status",
        cell: ({ row }) => {
          const s = row.original.status;
          const live = asrProgress[row.original.id];
          const cleanLive = cleanProgress[row.original.id];
          // Diarization runs after whisper hits 100% while the row is still `transcribing` —
          // show it as its own phase so the badge isn't stuck at "Transcribing 100%". Checked
          // first because it overrides the transcribing label during that window.
          if (diarizing[row.original.id]) {
            return (
              <span className="inline-flex items-center gap-1.5 text-xs text-status-processing">
                <Loader2 className="size-3 animate-spin" />
                <span>Diarizing…</span>
              </span>
            );
          }
          // Live percent overrides the static badge while a run streams.
          if (s === "transcribing" || live != null) {
            return (
              <span className="inline-flex items-center gap-1.5 text-xs text-status-processing">
                <Loader2 className="size-3 animate-spin" />
                <span className="font-numeric">
                  Transcribing{live != null ? ` ${live}%` : "…"}
                </span>
              </span>
            );
          }
          if (s === "cleaning" || cleanLive != null) {
            return (
              <span className="inline-flex items-center gap-1.5 text-xs text-status-processing">
                <Loader2 className="size-3 animate-spin" />
                <span className="font-numeric">
                  Cleaning{cleanLive != null ? ` ${cleanLive}%` : "…"}
                </span>
              </span>
            );
          }
          if (s === "transcribed") {
            return (
              <span className="inline-flex items-center gap-1.5 text-xs text-status-ready">
                <span className="size-1.5 shrink-0 rounded-full bg-status-ready" />
                <span>Transcribed</span>
              </span>
            );
          }
          if (s === "cleaned") {
            return (
              <span className="inline-flex items-center gap-1.5 text-xs text-status-ready">
                <span className="size-1.5 shrink-0 rounded-full bg-status-ready" />
                <span>Cleaned</span>
              </span>
            );
          }
          if (s === "edited") {
            return (
              <span className="inline-flex items-center gap-1.5 text-xs text-primary">
                <span className="size-1.5 shrink-0 rounded-full bg-primary" />
                <span>Edited</span>
              </span>
            );
          }
          return <StatusDot kind={interviewStatus(s)} />;
        },
      },
      {
        id: "actions",
        header: "",
        cell: ({ row }) => {
          const s = row.original.status;
          const busy =
            s === "transcribing" ||
            s === "cleaning" ||
            asrProgress[row.original.id] != null ||
            cleanProgress[row.original.id] != null;
          // A transcription specifically is in progress → offer Stop (bug #5).
          const transcribing =
            s === "transcribing" || asrProgress[row.original.id] != null;
          // Transcribe is offered once media is prepared (status 'new'); re-runnable
          // after a transcript or an error. Disabled (with media) while a run is live.
          const canTranscribe =
            !!row.original.audio_path &&
            (s === "new" ||
              s === "transcribed" ||
              s === "cleaned" ||
              s === "edited" ||
              s === "error");
          // Clean ("no grammar errors" pass) is offered once a raw transcript exists;
          // re-runnable after a clean/edit.
          const canClean =
            s === "transcribed" || s === "cleaned" || s === "edited";
          // Re-diarize re-labels speakers on an existing transcript (same precondition as
          // Clean: a transcript must exist).
          const canRediarize = canClean;
          // Import a ready-made .txt transcript — offered once media is prepared (same
          // states as Transcribe), and re-runnable to swap in a corrected file.
          const canImport = canTranscribe;
          return (
            <div className="flex items-center justify-end gap-1">
              {transcribing && (
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label={`Stop transcribing ${row.original.title}`}
                  className="text-status-error opacity-100 transition-opacity"
                  onClick={(e) => {
                    e.stopPropagation();
                    stopTranscription(row.original);
                  }}
                >
                  <Square className="size-3.5 fill-current" />
                  Stop
                </Button>
              )}
              {canEdit(row.original) && (
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label={`Open editor for ${row.original.title}`}
                  className="text-muted-foreground opacity-0 transition-opacity group-hover/row:opacity-100 focus-visible:opacity-100"
                  onClick={(e) => {
                    e.stopPropagation();
                    openEditor(row.original);
                  }}
                >
                  <PencilLine className="size-3.5" />
                  Open editor
                </Button>
              )}
              {canClean && (
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  aria-label={`Clean transcript for ${row.original.title}`}
                  className="text-muted-foreground opacity-0 transition-opacity group-hover/row:opacity-100 focus-visible:opacity-100"
                  onClick={(e) => {
                    e.stopPropagation();
                    clean(row.original);
                  }}
                >
                  <Sparkles className="size-3.5" />
                  {s === "cleaned" ? "Re-clean" : "Clean"}
                </Button>
              )}
              {canClean && (
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  aria-label={`Suggest glossary terms from ${row.original.title}`}
                  className="text-muted-foreground opacity-0 transition-opacity group-hover/row:opacity-100 focus-visible:opacity-100"
                  onClick={(e) => {
                    e.stopPropagation();
                    setGlossaryFor(row.original);
                  }}
                >
                  <BookText className="size-3.5" />
                  Glossary
                </Button>
              )}
              {canRediarize && (
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  aria-label={`Re-diarize ${row.original.title}`}
                  className="text-muted-foreground opacity-0 transition-opacity group-hover/row:opacity-100 focus-visible:opacity-100"
                  onClick={(e) => {
                    e.stopPropagation();
                    rediarize(row.original);
                  }}
                >
                  <Users className="size-3.5" />
                  Re-diarize
                </Button>
              )}
              {canImport && (
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  aria-label={`Import a transcript file for ${row.original.title}`}
                  className="text-muted-foreground opacity-0 transition-opacity group-hover/row:opacity-100 focus-visible:opacity-100"
                  onClick={(e) => {
                    e.stopPropagation();
                    importTxt(row.original);
                  }}
                >
                  <FileUp className="size-3.5" />
                  Import .txt
                </Button>
              )}
              {canTranscribe && (
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  aria-label={`Transcribe ${row.original.title}`}
                  className="text-muted-foreground opacity-0 transition-opacity group-hover/row:opacity-100 focus-visible:opacity-100"
                  onClick={(e) => {
                    e.stopPropagation();
                    transcribe(row.original);
                  }}
                >
                  <FileText className="size-3.5" />
                  {s === "transcribed" ? "Re-transcribe" : "Transcribe"}
                </Button>
              )}
              <Button
                variant="ghost"
                size="icon-sm"
                disabled={busy}
                aria-label={`Delete ${row.original.title}`}
                className="text-muted-foreground opacity-0 transition-opacity group-hover/row:opacity-100 focus-visible:opacity-100"
                onClick={(e) => {
                  e.stopPropagation();
                  deleteInterview.mutate(row.original.id);
                }}
              >
                <Trash2 className="size-4" />
              </Button>
            </div>
          );
        },
      },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      deleteInterview,
      renameInterview,
      renamingId,
      renameValue,
      asrProgress,
      cleanProgress,
      diarizing,
      selectedModel,
      asrModelId,
      asrLanguage,
      expectedSpeakers,
    ],
  );

  const importing =
    interviews?.filter((i) => i.status === "importing").length ?? 0;

  return (
    <div className="flex flex-col gap-4 pt-2">
      {/* Calm dashed dropzone — obvious target, unobtrusive chrome. The native
          drag-drop listener above covers the whole window; this is the affordance. */}
      <div
        className={cn(
          "flex flex-col items-center gap-2.5 rounded-lg border border-dashed px-6 py-8 text-center transition-colors",
          isDragOver
            ? "border-primary bg-primary/5"
            : "border-border hover:border-border-strong",
        )}
      >
        <span className="flex size-9 items-center justify-center rounded-lg bg-secondary/60 text-muted-foreground">
          <Upload className="size-4" />
        </span>
        <div className="flex flex-col gap-0.5">
          <p className="text-sm font-medium text-foreground">
            Drag audio or video files here
          </p>
          <p className="text-xs text-muted-foreground">
            Each file becomes an interview, normalized to 16 kHz audio. Already
            have a diarized transcript? Use a row's <em>Import .txt</em> to attach
            it instead of transcribing.
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={handlePick}
          disabled={addFiles.isPending}
        >
          <Upload className="size-4" />
          Add files
        </Button>
      </div>

      {/* Live ingest progress while files are being prepared (no spinner). */}
      {importing > 0 && (
        <div className="flex items-center gap-2 px-1 text-xs text-muted-foreground">
          <StatusDot kind="importing" label={false} />
          <span>
            Preparing{" "}
            <span className="font-numeric text-foreground/80">{importing}</span>{" "}
            file{importing > 1 ? "s" : ""}…
          </span>
        </div>
      )}

      {isPending ? (
        <div className="overflow-hidden rounded-lg border border-border">
          {Array.from({ length: 3 }).map((_, i) => (
            <div
              key={i}
              className="flex h-11 items-center gap-3 border-b border-border px-3 last:border-b-0"
            >
              <Skeleton className="size-4 rounded" />
              <Skeleton className="h-4 w-56" />
              <Skeleton className="ml-auto h-3 w-12" />
            </div>
          ))}
        </div>
      ) : !interviews || interviews.length === 0 ? (
        <div className="flex flex-col items-center gap-1 rounded-lg border border-border px-6 py-10 text-center">
          <p className="text-sm font-medium text-foreground">
            No interviews yet
          </p>
          <p className="text-xs text-muted-foreground">
            Drop recordings above to ingest this wave's interviews.
          </p>
        </div>
      ) : (
        <DataTable
          columns={columns}
          data={interviews}
          // Clicking a transcribed/edited row opens the transcript editor.
          onRowClick={(row) => {
            if (canEdit(row)) openEditor(row);
          }}
        />
      )}

      {/* Glossary suggestion (B/C): mine terms from an interview's transcript or the user's
          edits and add them to the cycle's product glossary. */}
      <GlossarySuggestDialog
        interview={glossaryFor}
        onOpenChange={(open) => {
          if (!open) setGlossaryFor(null);
        }}
      />
    </div>
  );
}
