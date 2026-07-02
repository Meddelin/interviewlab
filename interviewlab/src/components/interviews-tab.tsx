import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { type ColumnDef } from "@tanstack/react-table";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  BookText,
  FileAudio,
  FileText,
  FileUp,
  Loader2,
  PencilLine,
  Sparkles,
  Square,
  Trash2,
  Upload,
  Users,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
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
} from "@/lib/interview-queries";
import { asrKeys, useModels } from "@/lib/asr-queries";
import { useUiStore } from "@/lib/ui-store";
import {
  ASR_PROGRESS_EVENT,
  cancelTranscription,
  CLEANUP_PROGRESS_EVENT,
  cleanTranscript,
  diarizationModelsPresent,
  DIAR_PROGRESS_EVENT,
  IN_TAURI,
  importTranscriptFile,
  INTERVIEW_PROGRESS_EVENT,
  rediarizeInterview,
  type AsrProgress,
  type CleanupProgress,
  type DiarProgress,
  type InterviewProgress,
  type InterviewRow,
  transcribeInterview,
} from "@/lib/tauri";
import { GlossarySuggestDialog } from "@/components/glossary-suggest-dialog";
import { useConfirm } from "@/components/confirm-dialog";
import { useT, tr } from "@/lib/i18n";
// dev-mock: browser-only, never active under Tauri.
import {
  mockOnAsrProgress,
  mockOnCleanupProgress,
  mockOnDragDrop,
  mockOnProgress,
} from "@/lib/dev-mock";

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

// Live per-interview transcription progress (interview_id → percent), driven by the
// `asr://progress` event. Drives the row's "Transcribing… N%" label.
type AsrState = Record<string, number>;

const STR = {
  ru: {
    mediaPrepFailed: (err: string) => `Не удалось подготовить медиа: ${err}`,
    unknown: "неизвестно",
    noSupportedFiles: "В перетащенных файлах нет поддерживаемого аудио/видео",
    transcriptionFailed: (err: string) => `Не удалось транскрибировать: ${err}`,
    cleanupFailed: (err: string) => `Не удалось очистить: ${err}`,
    reTranscribeTitle: "Перетранскрибировать заново?",
    reTranscribeBody: (title: string) =>
      `«${title}» будет транскрибировано заново. Это сотрёт ручные правки транскрипта и разметку спикеров — существующий транскрипт будет перезаписан.`,
    reTranscribeAction: "Перетранскрибировать",
    modelNotDownloaded: (label: string) =>
      `Модель «${label}» ещё не скачана — скачайте её в Настройки → Транскрипция.`,
    diarNotDownloaded: "Модель диаризации не скачана — спикеры (S1/S2…) не будут размечены.",
    settings: "Настройки",
    couldntTranscribe: (err: string) => `Не удалось транскрибировать. ${err}`,
    importTxtDesktopOnly: "Импорт файла транскрипта работает в десктоп-приложении.",
    transcriptFilterName: "Транскрипт",
    importedTranscript: (title: string, segments: number, speakers: number) =>
      `Импортирован транскрипт для «${title}» — ${segments} ${
        segments === 1 ? "сегмент" : "сегм."
      }, ${speakers} ${speakers === 1 ? "спикер" : "спик."}`,
    couldntImport: (err: string) => `Не удалось импортировать транскрипт. ${err}`,
    stopping: (title: string) => `Останавливаю «${title}»…`,
    couldntStop: (err: string) => `Не удалось остановить. ${err}`,
    reDiarizeTitle: "Переразметить спикеров?",
    reDiarizeBody: (title: string) =>
      `Спикеры в «${title}» будут размечены заново. Это сотрёт ручные правки транскрипта и существующую разметку спикеров.`,
    reDiarizeAction: "Переразметить",
    reDiarized: (title: string, speakers: number) =>
      `Спикеры заново размечены в «${title}» — обнаружено ${speakers} ${
        speakers === 1 ? "спикер" : "спик."
      }`,
    couldntRediarize: (err: string) => `Не удалось переразметить спикеров. ${err}`,
    reCleanTitle: "Очистить заново?",
    reCleanBody: (title: string) =>
      `«${title}» будет очищено заново. Это сотрёт ручные правки транскрипта — очищенный текст будет перезаписан.`,
    reCleanAction: "Очистить заново",
    cleaned: (title: string) => `Очищено «${title}»`,
    couldntClean: (err: string) => `Не удалось очистить. ${err}`,
    importing: (n: number) => `Импортирую ${n} ${n === 1 ? "файл" : "файлов"}…`,
    couldntStartImport: (err: string) => `Не удалось начать импорт. ${err}`,
    audioVideoFilterName: "Аудио/Видео",
    colInterview: "Интервью",
    colDuration: "Длительность",
    colStatus: "Статус",
    diarizing: "Размечаю спикеров…",
    transcribing: (pct: number | null) =>
      `Транскрибирую${pct != null ? ` ${pct}%` : "…"}`,
    cleaning: (pct: number | null) =>
      `Очищаю${pct != null ? ` ${pct}%` : "…"}`,
    transcribed: "Транскрибировано",
    cleanedBadge: "Очищено",
    edited: "Отредактировано",
    stop: "Остановить",
    stopAria: (title: string) => `Остановить транскрибацию «${title}»`,
    openEditor: "Открыть редактор",
    openEditorAria: (title: string) => `Открыть редактор для «${title}»`,
    cleanAria: (title: string) => `Очистить транскрипт «${title}»`,
    reClean: "Очистить заново",
    clean: "Очистить",
    glossary: "Глоссарий",
    glossaryAria: (title: string) => `Предложить термины глоссария из «${title}»`,
    reDiarize: "Переразметить",
    reDiarizeAria: (title: string) => `Переразметить спикеров в «${title}»`,
    importTxt: "Импорт .txt",
    importTxtAria: (title: string) => `Импортировать файл транскрипта для «${title}»`,
    reTranscribe: "Перетранскрибировать",
    transcribe: "Транскрибировать",
    transcribeAria: (title: string) => `Транскрибировать «${title}»`,
    deleteAria: (title: string) => `Удалить «${title}»`,
    deleteTitle: "Удалить интервью?",
    deleteBody: (title: string) =>
      `Удалить «${title}» и все его данные — транскрипт, правки, саммари? Это действие необратимо.`,
    deleteAction: "Удалить",
    deleted: "Удалено",
    couldntDelete: (err: string) => `Не удалось удалить. ${err}`,
    dragHereOr: "Перетащите сюда аудио или видео, или",
    addFiles: "Добавить файлы",
    dragHere: "Перетащите сюда аудио или видео файлы",
    emptyHint: (
      <>
        Каждый файл становится интервью и нормализуется в аудио 16 кГц. Уже есть
        транскрипт с разметкой спикеров? Используйте <em>Импорт .txt</em> в строке,
        чтобы прикрепить его вместо транскрибации.
      </>
    ),
    preparing: (n: number) => `${n} ${n === 1 ? "файл" : "файлов"}`,
    preparingPrefix: "Подготавливаю",
    noInterviews: "Пока нет интервью",
    noInterviewsHint: "Перетащите записи выше, чтобы загрузить интервью этой волны.",
  },
  en: {
    mediaPrepFailed: (err: string) => `Media prep failed: ${err}`,
    unknown: "unknown",
    noSupportedFiles: "No supported audio/video files in the drop",
    transcriptionFailed: (err: string) => `Transcription failed: ${err}`,
    cleanupFailed: (err: string) => `Cleanup failed: ${err}`,
    reTranscribeTitle: "Re-transcribe from scratch?",
    reTranscribeBody: (title: string) =>
      `"${title}" will be transcribed again. This erases your manual transcript edits and speaker labels — the existing transcript is overwritten.`,
    reTranscribeAction: "Re-transcribe",
    modelNotDownloaded: (label: string) =>
      `The "${label}" model isn't downloaded yet — get it in Settings → Transcription.`,
    diarNotDownloaded: "Diarization model isn't downloaded — speakers (S1/S2…) won't be labeled.",
    settings: "Settings",
    couldntTranscribe: (err: string) => `Couldn't transcribe. ${err}`,
    importTxtDesktopOnly: "Importing a transcript file works in the desktop app.",
    transcriptFilterName: "Transcript",
    importedTranscript: (title: string, segments: number, speakers: number) =>
      `Imported transcript for "${title}" — ${segments} segment${
        segments === 1 ? "" : "s"
      }, ${speakers} speaker${speakers === 1 ? "" : "s"}`,
    couldntImport: (err: string) => `Couldn't import the transcript. ${err}`,
    stopping: (title: string) => `Stopping "${title}"…`,
    couldntStop: (err: string) => `Couldn't stop. ${err}`,
    reDiarizeTitle: "Re-diarize speakers?",
    reDiarizeBody: (title: string) =>
      `"${title}" will get fresh speaker labels. This erases your manual transcript edits and the existing speaker labels.`,
    reDiarizeAction: "Re-diarize",
    reDiarized: (title: string, speakers: number) =>
      `Re-diarized "${title}" — ${speakers} speaker${
        speakers === 1 ? "" : "s"
      } detected`,
    couldntRediarize: (err: string) => `Couldn't re-diarize. ${err}`,
    reCleanTitle: "Re-clean transcript?",
    reCleanBody: (title: string) =>
      `"${title}" will be cleaned again. This erases your manual transcript edits — the cleaned text is overwritten.`,
    reCleanAction: "Re-clean",
    cleaned: (title: string) => `Cleaned "${title}"`,
    couldntClean: (err: string) => `Couldn't clean. ${err}`,
    importing: (n: number) => `Importing ${n} file${n > 1 ? "s" : ""}…`,
    couldntStartImport: (err: string) => `Couldn't start the import. ${err}`,
    audioVideoFilterName: "Audio/Video",
    colInterview: "Interview",
    colDuration: "Duration",
    colStatus: "Status",
    diarizing: "Diarizing…",
    transcribing: (pct: number | null) =>
      `Transcribing${pct != null ? ` ${pct}%` : "…"}`,
    cleaning: (pct: number | null) =>
      `Cleaning${pct != null ? ` ${pct}%` : "…"}`,
    transcribed: "Transcribed",
    cleanedBadge: "Cleaned",
    edited: "Edited",
    stop: "Stop",
    stopAria: (title: string) => `Stop transcribing ${title}`,
    openEditor: "Open editor",
    openEditorAria: (title: string) => `Open editor for ${title}`,
    cleanAria: (title: string) => `Clean transcript for ${title}`,
    reClean: "Re-clean",
    clean: "Clean",
    glossary: "Glossary",
    glossaryAria: (title: string) => `Suggest glossary terms from ${title}`,
    reDiarize: "Re-diarize",
    reDiarizeAria: (title: string) => `Re-diarize ${title}`,
    importTxt: "Import .txt",
    importTxtAria: (title: string) => `Import a transcript file for ${title}`,
    reTranscribe: "Re-transcribe",
    transcribe: "Transcribe",
    transcribeAria: (title: string) => `Transcribe ${title}`,
    deleteAria: (title: string) => `Delete ${title}`,
    deleteTitle: "Delete interview?",
    deleteBody: (title: string) =>
      `Delete "${title}" and all its data — transcript, edits, summary? This can't be undone.`,
    deleteAction: "Delete",
    deleted: "Deleted",
    couldntDelete: (err: string) => `Couldn't delete. ${err}`,
    dragHereOr: "Drag audio or video files here, or",
    addFiles: "Add files",
    dragHere: "Drag audio or video files here",
    emptyHint: (
      <>
        Each file becomes an interview, normalized to 16 kHz audio. Already
        have a diarized transcript? Use a row's <em>Import .txt</em> to
        attach it instead of transcribing.
      </>
    ),
    preparing: (n: number) => `${n} file${n > 1 ? "s" : ""}`,
    preparingPrefix: "Preparing",
    noInterviews: "No interviews yet",
    noInterviewsHint: "Drop recordings above to ingest this wave's interviews.",
  },
};

export function InterviewsTab({ cycleId }: { cycleId: string }) {
  const navigate = useNavigate();
  const t = useT(STR);
  const { data: interviews, isPending } = useInterviews(cycleId);
  const { data: models } = useModels();
  // Whether the speaker-diarization model files are on disk — same small bool read
  // Settings uses (settings.tsx:127). Lets us warn before a Transcribe run that would
  // skip diarization because the model isn't downloaded yet.
  const { data: diarPresent } = useQuery({
    queryKey: asrKeys.diarPresent,
    queryFn: diarizationModelsPresent,
  });
  const addFiles = useAddInterviewFiles(cycleId);
  const deleteInterview = useDeleteInterview(cycleId);
  const qc = useQueryClient();
  const [isDragOver, setIsDragOver] = useState(false);
  // Shared confirm dialog for the destructive row actions (delete / re-transcribe /
  // re-clean / re-diarize) — replaces the old native confirm() guards (v3 F3 P0).
  const { confirm: confirmAction, dialog: confirmDialog } = useConfirm();

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

  // Live transcription progress per interview (cleared on terminal status).
  const [asrProgress, setAsrProgress] = useState<AsrState>({});
  // Live cleanup progress per interview (interview_id → percent, cleared when done).
  const [cleanProgress, setCleanProgress] = useState<AsrState>({});
  // The interview whose glossary-suggest dialog is open (null = closed).
  const [glossaryFor, setGlossaryFor] = useState<InterviewRow | null>(null);
  // Interviews currently in the DIARIZATION phase (after whisper hits 100%, before the row
  // flips to `transcribed`). Without this the badge sat frozen at "Transcribing 100%" for the
  // whole CPU diarization tail — now it shows a distinct "Diarizing…" phase.
  const [diarizing, setDiarizing] = useState<Record<string, boolean>>({});

  // Live row updates: each finished file emits `interview://progress`; just
  // invalidate this cycle's list so the table re-renders with new status/duration.
  useEffect(() => {
    // dev-mock: browser-only, never active under Tauri.
    if (!IN_TAURI) {
      const unlisten = mockOnProgress((payload) => {
        if (payload.cycle_id !== cycleId) return;
        qc.invalidateQueries({ queryKey: interviewKeys.list(cycleId) });
        if (payload.status === "error") {
          const s = tr(STR);
          toast.error(s.mediaPrepFailed(payload.error ?? s.unknown));
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
          const s = tr(STR);
          toast.error(s.mediaPrepFailed(event.payload.error ?? s.unknown));
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
          toast.error(tr(STR).noSupportedFiles);
      } else {
        setIsDragOver(false);
      }
    });
    return () => {
      unlisten.then((fn) => fn());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cycleId]);

  // Live transcription updates: `asr://progress` carries status + percent per
  // interview. Track the percent for the row label and invalidate the list on any
  // status change so the badge flips (new → transcribing → transcribed | error).
  useEffect(() => {
    function onAsr(p: AsrProgress) {
      setAsrProgress((prev) => {
        const next = { ...prev };
        if (p.status === "transcribing" && p.progress >= 0) {
          next[p.interview_id] = p.progress;
        } else if (p.status === "transcribed" || p.status === "error") {
          delete next[p.interview_id];
        }
        return next;
      });
      if (p.status === "transcribed" || p.status === "error") {
        // Whisper terminal → the diarization phase is over too; drop any diarizing flag.
        setDiarizing((prev) => {
          if (!prev[p.interview_id]) return prev;
          const next = { ...prev };
          delete next[p.interview_id];
          return next;
        });
        qc.invalidateQueries({ queryKey: interviewKeys.list(cycleId) });
        if (p.status === "error") {
          const s = tr(STR);
          toast.error(s.transcriptionFailed(p.error ?? s.unknown));
        }
      }
    }

    if (!IN_TAURI) {
      return mockOnAsrProgress(onAsr);
    }
    const unlisten = getCurrentWebview().listen<AsrProgress>(
      ASR_PROGRESS_EVENT,
      (e) => onAsr(e.payload),
    );
    return () => {
      unlisten.then((fn) => fn());
    };
  }, [cycleId, qc]);

  // Live diarization updates: `asr://diar-progress` fires AFTER whisper finishes, while the row
  // is still `transcribing`. Track which interviews are in the diarization phase so the badge
  // shows "Diarizing…" instead of a frozen "Transcribing 100%". Cleared on done/error (and on
  // the whisper terminal event above, as a backstop). Tauri-only — the browser mock doesn't diarize.
  useEffect(() => {
    if (!IN_TAURI) return;
    const unlisten = getCurrentWebview().listen<DiarProgress>(
      DIAR_PROGRESS_EVENT,
      (e) => {
        const p = e.payload;
        setDiarizing((prev) => {
          const next = { ...prev };
          if (p.status === "diarizing") next[p.interview_id] = true;
          else delete next[p.interview_id]; // 'done' | 'error'
          return next;
        });
      },
    );
    return () => {
      unlisten.then((fn) => fn());
    };
  }, [cycleId]);

  // Live cleanup updates: `cleanup://progress` carries batch status + percent per
  // interview. Track the percent for the row label and invalidate the list on a
  // terminal status so the badge flips (cleaning → cleaned | error).
  useEffect(() => {
    function onCleanup(p: CleanupProgress) {
      setCleanProgress((prev) => {
        const next = { ...prev };
        if (p.status === "cleaning") {
          next[p.interview_id] = p.progress;
        } else {
          delete next[p.interview_id];
        }
        return next;
      });
      if (p.status === "cleaned" || p.status === "error") {
        qc.invalidateQueries({ queryKey: interviewKeys.list(cycleId) });
        if (p.status === "error") {
          const s = tr(STR);
          toast.error(s.cleanupFailed(p.error ?? s.unknown));
        }
      }
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
  }, [cycleId, qc]);

  function filterMedia(paths: string[]): string[] {
    return paths.filter((p) => {
      const ext = p.split(".").pop()?.toLowerCase() ?? "";
      return MEDIA_EXTS.includes(ext);
    });
  }

  // Transcribe one interview with the Settings-chosen model + language. Optimistically
  // flips the row to 'transcribing'; the asr://progress stream + invalidation do the rest.
  async function transcribe(row: InterviewRow) {
    // Re-running on an already-processed interview overwrites the transcript and any
    // manual edits / speaker labels — confirm it explicitly (destructive).
    const s = tr(STR);
    if (row.status !== "new") {
      const ok = await confirmAction({
        title: s.reTranscribeTitle,
        body: s.reTranscribeBody(row.title),
        confirmLabel: s.reTranscribeAction,
        destructive: true,
      });
      if (!ok) return;
    }
    if (!selectedModel?.downloaded) {
      toast.error(s.modelNotDownloaded(selectedModel?.label ?? asrModelId));
      return;
    }
    // Diarization is best-effort: if its model isn't on disk the transcript still runs,
    // just without speaker labels. Hint (non-blocking) with a jump to Settings so the
    // user can grab it. diarPresent === undefined → status not loaded yet, don't nag.
    if (diarPresent === false) {
      toast.warning(s.diarNotDownloaded, {
        action: {
          label: s.settings,
          onClick: () => navigate("/settings"),
        },
      });
    }
    setAsrProgress((prev) => ({ ...prev, [row.id]: 0 }));
    try {
      await transcribeInterview(row.id, asrModelId, asrLanguage, expectedSpeakers);
    } catch (e) {
      setAsrProgress((prev) => {
        const next = { ...prev };
        delete next[row.id];
        return next;
      });
      toast.error(s.couldntTranscribe(String(e)));
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
    const s = tr(STR);
    if (!IN_TAURI) {
      toast.error(s.importTxtDesktopOnly);
      return;
    }
    const selected = await openFileDialog({
      multiple: false,
      filters: [{ name: s.transcriptFilterName, extensions: ["txt"] }],
    });
    if (!selected) return;
    const path = Array.isArray(selected) ? selected[0] : selected;
    try {
      const res = await importTranscriptFile(row.id, path);
      toast.success(s.importedTranscript(row.title, res.segments, res.speakers));
    } catch (e) {
      toast.error(s.couldntImport(String(e)));
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
      setAsrProgress((prev) => {
        const next = { ...prev };
        delete next[row.id];
        return next;
      });
      toast.message(tr(STR).stopping(row.title));
    } catch (e) {
      toast.error(tr(STR).couldntStop(String(e)));
    } finally {
      qc.invalidateQueries({ queryKey: interviewKeys.list(cycleId) });
    }
  }

  // Re-diarize an existing transcript with the Settings-chosen expected-speaker count.
  // Resolves with the detected speaker count, which we toast; the stored segments get the
  // fresh S1/S2/… labels (the editor re-reads them on open). ponytail: no optimistic row
  // badge — re-diarize is quick and doesn't change the interview's status.
  async function rediarize(row: InterviewRow) {
    const s = tr(STR);
    const ok = await confirmAction({
      title: s.reDiarizeTitle,
      body: s.reDiarizeBody(row.title),
      confirmLabel: s.reDiarizeAction,
      destructive: true,
    });
    if (!ok) return;
    try {
      const speakers = await rediarizeInterview(row.id, expectedSpeakers);
      toast.success(s.reDiarized(row.title, speakers));
      qc.invalidateQueries({ queryKey: interviewKeys.list(cycleId) });
    } catch (e) {
      toast.error(s.couldntRediarize(String(e)));
    }
  }

  // Run the "no grammar errors" cleanup pass (spec §6.7). Optimistically flips the row
  // to 'cleaning'; the cleanup://progress stream + invalidation do the rest.
  async function clean(row: InterviewRow) {
    // First Clean on a raw transcript is non-destructive enough; but Re-clean over a
    // cleaned/edited version overwrites manual edits — confirm those (destructive).
    const s = tr(STR);
    if (row.status === "cleaned" || row.status === "edited") {
      const ok = await confirmAction({
        title: s.reCleanTitle,
        body: s.reCleanBody(row.title),
        confirmLabel: s.reCleanAction,
        destructive: true,
      });
      if (!ok) return;
    }
    setCleanProgress((prev) => ({ ...prev, [row.id]: 0 }));
    try {
      await cleanTranscript(row.id);
      toast.success(s.cleaned(row.title));
    } catch (e) {
      setCleanProgress((prev) => {
        const next = { ...prev };
        delete next[row.id];
        return next;
      });
      toast.error(s.couldntClean(String(e)));
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

  // Hard delete: interview + transcript + edits + summary. Confirmed via the shared
  // ConfirmDialog («…и все его данные? Это действие необратимо»); undo is out of scope.
  async function handleDelete(row: InterviewRow) {
    const s = tr(STR);
    const ok = await confirmAction({
      title: s.deleteTitle,
      body: s.deleteBody(row.title),
      confirmLabel: s.deleteAction,
      destructive: true,
    });
    if (!ok) return;
    deleteInterview.mutate(row.id, {
      onSuccess: () => toast.success(tr(STR).deleted),
      onError: (e) => toast.error(tr(STR).couldntDelete(String(e))),
    });
  }

  async function ingest(paths: string[]) {
    try {
      await addFiles.mutateAsync(paths);
      toast.success(tr(STR).importing(paths.length));
    } catch (e) {
      toast.error(tr(STR).couldntStartImport(String(e)));
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
      filters: [{ name: tr(STR).audioVideoFilterName, extensions: MEDIA_EXTS }],
    });
    if (!selected) return;
    const paths = Array.isArray(selected) ? selected : [selected];
    if (paths.length) ingest(paths);
  }

  const columns = useMemo<ColumnDef<InterviewRow>[]>(
    () => [
      {
        accessorKey: "title",
        header: t.colInterview,
        cell: ({ row }) => (
          <span className="flex items-center gap-2 font-medium">
            <FileAudio className="size-4 shrink-0 text-muted-foreground" />
            <span className="truncate">{row.original.title}</span>
          </span>
        ),
      },
      {
        accessorKey: "duration_ms",
        header: () => <span className="block text-right">{t.colDuration}</span>,
        cell: ({ row }) => (
          <span className="block text-right font-numeric text-xs text-muted-foreground">
            {formatDuration(row.original.duration_ms)}
          </span>
        ),
      },
      {
        accessorKey: "status",
        header: t.colStatus,
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
                <span>{t.diarizing}</span>
              </span>
            );
          }
          // Live percent overrides the static badge while a run streams.
          if (s === "transcribing" || live != null) {
            return (
              <span className="inline-flex items-center gap-1.5 text-xs text-status-processing">
                <Loader2 className="size-3 animate-spin" />
                <span className="font-numeric">
                  {t.transcribing(live != null ? live : null)}
                </span>
              </span>
            );
          }
          if (s === "cleaning" || cleanLive != null) {
            return (
              <span className="inline-flex items-center gap-1.5 text-xs text-status-processing">
                <Loader2 className="size-3 animate-spin" />
                <span className="font-numeric">
                  {t.cleaning(cleanLive != null ? cleanLive : null)}
                </span>
              </span>
            );
          }
          if (s === "transcribed") {
            return (
              <span className="inline-flex items-center gap-1.5 text-xs text-status-ready">
                <span className="size-1.5 shrink-0 rounded-full bg-status-ready" />
                <span>{t.transcribed}</span>
              </span>
            );
          }
          if (s === "cleaned") {
            return (
              <span className="inline-flex items-center gap-1.5 text-xs text-status-ready">
                <span className="size-1.5 shrink-0 rounded-full bg-status-ready" />
                <span>{t.cleanedBadge}</span>
              </span>
            );
          }
          if (s === "edited") {
            return (
              <span className="inline-flex items-center gap-1.5 text-xs text-primary">
                <span className="size-1.5 shrink-0 rounded-full bg-primary" />
                <span>{t.edited}</span>
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
                  aria-label={t.stopAria(row.original.title)}
                  className="text-status-error opacity-100 transition-opacity"
                  onClick={(e) => {
                    e.stopPropagation();
                    stopTranscription(row.original);
                  }}
                >
                  <Square className="size-3.5 fill-current" />
                  {t.stop}
                </Button>
              )}
              {canEdit(row.original) && (
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label={t.openEditorAria(row.original.title)}
                  className="text-muted-foreground opacity-0 transition-opacity group-hover/row:opacity-100 focus-visible:opacity-100"
                  onClick={(e) => {
                    e.stopPropagation();
                    openEditor(row.original);
                  }}
                >
                  <PencilLine className="size-3.5" />
                  {t.openEditor}
                </Button>
              )}
              {canClean && (
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  aria-label={t.cleanAria(row.original.title)}
                  className="text-muted-foreground opacity-0 transition-opacity group-hover/row:opacity-100 focus-visible:opacity-100"
                  onClick={(e) => {
                    e.stopPropagation();
                    clean(row.original);
                  }}
                >
                  <Sparkles className="size-3.5" />
                  {s === "cleaned" ? t.reClean : t.clean}
                </Button>
              )}
              {canClean && (
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  aria-label={t.glossaryAria(row.original.title)}
                  className="text-muted-foreground opacity-0 transition-opacity group-hover/row:opacity-100 focus-visible:opacity-100"
                  onClick={(e) => {
                    e.stopPropagation();
                    setGlossaryFor(row.original);
                  }}
                >
                  <BookText className="size-3.5" />
                  {t.glossary}
                </Button>
              )}
              {canRediarize && (
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  aria-label={t.reDiarizeAria(row.original.title)}
                  className="text-muted-foreground opacity-0 transition-opacity group-hover/row:opacity-100 focus-visible:opacity-100"
                  onClick={(e) => {
                    e.stopPropagation();
                    rediarize(row.original);
                  }}
                >
                  <Users className="size-3.5" />
                  {t.reDiarize}
                </Button>
              )}
              {canImport && (
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  aria-label={t.importTxtAria(row.original.title)}
                  className="text-muted-foreground opacity-0 transition-opacity group-hover/row:opacity-100 focus-visible:opacity-100"
                  onClick={(e) => {
                    e.stopPropagation();
                    importTxt(row.original);
                  }}
                >
                  <FileUp className="size-3.5" />
                  {t.importTxt}
                </Button>
              )}
              {canTranscribe && (
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  aria-label={t.transcribeAria(row.original.title)}
                  className="text-muted-foreground opacity-0 transition-opacity group-hover/row:opacity-100 focus-visible:opacity-100"
                  onClick={(e) => {
                    e.stopPropagation();
                    transcribe(row.original);
                  }}
                >
                  <FileText className="size-3.5" />
                  {s === "transcribed" ? t.reTranscribe : t.transcribe}
                </Button>
              )}
              <Button
                variant="ghost"
                size="icon-sm"
                disabled={busy}
                aria-label={t.deleteAria(row.original.title)}
                className="text-muted-foreground opacity-0 transition-opacity group-hover/row:opacity-100 focus-visible:opacity-100"
                onClick={(e) => {
                  e.stopPropagation();
                  handleDelete(row.original);
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
      asrProgress,
      cleanProgress,
      selectedModel,
      asrModelId,
      asrLanguage,
      expectedSpeakers,
      t,
    ],
  );

  const importing =
    interviews?.filter((i) => i.status === "importing").length ?? 0;
  // Once the list has interviews, collapse the big dropzone into a slim strip so it
  // doesn't eat vertical space (ui-backlog #4). Full zone only on the empty list.
  const hasInterviews = !!interviews && interviews.length > 0;

  return (
    <div className="flex flex-col gap-4 pt-2">
      {/* Calm dashed dropzone — obvious target, unobtrusive chrome. The native
          drag-drop listener above covers the whole window; this is the affordance. */}
      {hasInterviews ? (
        <div
          className={cn(
            "flex items-center justify-between gap-3 rounded-lg border border-dashed px-3 py-2 text-left transition-colors",
            isDragOver
              ? "border-primary bg-primary/5"
              : "border-border hover:border-border-strong",
          )}
        >
          <span className="flex items-center gap-2 text-xs text-muted-foreground">
            <Upload className="size-3.5 shrink-0" />
            {t.dragHereOr}
          </span>
          <Button
            variant="outline"
            size="sm"
            onClick={handlePick}
            disabled={addFiles.isPending}
          >
            <Upload className="size-4" />
            {t.addFiles}
          </Button>
        </div>
      ) : (
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
              {t.dragHere}
            </p>
            <p className="text-xs text-muted-foreground">{t.emptyHint}</p>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={handlePick}
            disabled={addFiles.isPending}
          >
            <Upload className="size-4" />
            {t.addFiles}
          </Button>
        </div>
      )}

      {/* Live ingest progress while files are being prepared (no spinner). */}
      {importing > 0 && (
        <div className="flex items-center gap-2 px-1 text-xs text-muted-foreground">
          <StatusDot kind="importing" label={false} />
          <span>
            {t.preparingPrefix}{" "}
            <span className="font-numeric text-foreground/80">
              {t.preparing(importing)}
            </span>
            …
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
            {t.noInterviews}
          </p>
          <p className="text-xs text-muted-foreground">{t.noInterviewsHint}</p>
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

      {/* Shared confirm for the destructive row actions (delete / re-run overwrites). */}
      {confirmDialog}
    </div>
  );
}
