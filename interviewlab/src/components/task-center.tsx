import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { ListChecks } from "lucide-react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  useTaskStore,
  taskTarget,
  type BackgroundTask,
  type TaskKind,
  type TaskStatus,
} from "@/lib/task-store";
import { formatDuration } from "@/lib/format";
import { isMac } from "@/lib/platform";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n";

// Header task center (v3 F1): a quiet button — accent dot + running count — opening a
// Popover with every background task (transcription, import, cleanup, synthesis,
// diarization, coverage, model downloads). Progress survives navigation because the
// list is fed by the global task-store subscription, not page-local state.

// Shift-modified combo label: "⌘⇧B" on mac, "Ctrl+Shift+B" elsewhere (mod() from
// lib/platform only covers the plain modifier). Shared with the palette cheatsheet.
export function modShift(key: string): string {
  return isMac ? `⌘⇧${key}` : `Ctrl+Shift+${key}`;
}

const STR = {
  ru: {
    title: "Фоновые задачи",
    empty: "Нет фоновых задач",
    open: "Фоновые задачи",
    runningCount: (n: number) => `${n} задач(и) выполняется`,
    status: {
      running: "выполняется",
      done: "готово",
      error: "ошибка",
    },
    kind: {
      asr: "Транскрипция",
      import: "Импорт",
      cleanup: "Чистка",
      synthesis: "Синтез",
      diarize: "Диаризация",
      coverage: "Покрытие гайда",
      model: "Загрузка модели",
    },
  },
  en: {
    title: "Background tasks",
    empty: "No background tasks",
    open: "Background tasks",
    runningCount: (n: number) => `${n} task(s) running`,
    status: {
      running: "running",
      done: "done",
      error: "error",
    },
    kind: {
      asr: "Transcription",
      import: "Import",
      cleanup: "Cleanup",
      synthesis: "Synthesis",
      diarize: "Diarization",
      coverage: "Guide coverage",
      model: "Model download",
    },
  },
};

// Status dot — the app's muted semantic vocabulary (dot + label, low saturation).
function statusDotClass(status: TaskStatus): string {
  switch (status) {
    case "running":
      return "bg-primary motion-safe:animate-pulse";
    case "done":
      return "bg-status-ready";
    case "error":
      return "bg-status-error";
  }
}

// One task row: dot + kind label + entity hint, elapsed time (tabular), a thin accent
// progress bar while running. Click navigates to the task's cycle/interview (and
// dismisses a finished task).
function TaskRow({
  task,
  now,
  kindLabel,
  statusLabel,
  onOpen,
}: {
  task: BackgroundTask;
  now: number;
  kindLabel: string;
  statusLabel: string;
  onOpen: (task: BackgroundTask) => void;
}) {
  const elapsed = formatDuration(
    Math.max(0, (task.finishedAt ?? now) - task.startedAt),
  );
  const hint = task.label ?? task.detail;

  return (
    <button
      type="button"
      onClick={() => onOpen(task)}
      className="flex w-full flex-col gap-1.5 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-secondary/60 focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
    >
      <span className="flex w-full items-center gap-2">
        <span
          className={cn(
            "size-1.5 shrink-0 rounded-full",
            statusDotClass(task.status),
          )}
          aria-hidden="true"
        />
        <span
          className="min-w-0 flex-1 truncate text-xs text-foreground"
          title={hint ? `${kindLabel} · ${hint}` : kindLabel}
        >
          {kindLabel}
          {hint && (
            <span className="text-muted-foreground"> · {hint}</span>
          )}
        </span>
        <span
          className={cn(
            "shrink-0 text-[10px]",
            task.status === "error"
              ? "text-status-error"
              : "text-muted-foreground",
          )}
        >
          {statusLabel}
        </span>
        <span className="w-12 shrink-0 text-right font-numeric text-[11px] text-muted-foreground">
          {elapsed}
        </span>
      </span>

      {task.status === "running" && (
        <span className="block h-0.5 w-full overflow-hidden rounded-full bg-secondary">
          {task.progressPct != null ? (
            <span
              className="block h-full rounded-full bg-primary transition-[width] duration-150 ease-out"
              style={{
                width: `${Math.max(0, Math.min(100, task.progressPct))}%`,
              }}
            />
          ) : (
            // Indeterminate: a sliding accent segment (static under reduced motion).
            <span className="progress-indeterminate block h-full w-1/3 rounded-full bg-primary/70" />
          )}
        </span>
      )}

      {task.status === "error" && task.detail && (
        <span
          className="block w-full truncate pl-3.5 text-[11px] text-status-error/90"
          title={task.detail}
        >
          {task.detail}
        </span>
      )}
    </button>
  );
}

export function TaskCenter() {
  const t = useT(STR);
  const navigate = useNavigate();
  const qc = useQueryClient();
  const open = useTaskStore((s) => s.open);
  const setOpen = useTaskStore((s) => s.setOpen);
  const tasks = useTaskStore((s) => s.tasks);
  const dismiss = useTaskStore((s) => s.dismiss);

  const list = Object.values(tasks).sort((a, b) => b.startedAt - a.startedAt);
  const runningCount = list.filter((x) => x.status === "running").length;
  const errorCount = list.filter((x) => x.status === "error").length;

  // ⌘/Ctrl+Shift+B toggles the popover from anywhere (listed in the "?" cheatsheet).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (
        e.key.toLowerCase() === "b" &&
        (e.metaKey || e.ctrlKey) &&
        e.shiftKey
      ) {
        e.preventDefault();
        useTaskStore.getState().toggleOpen();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Elapsed readouts tick once a second, but only while the popover is open.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!open || runningCount === 0) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [open, runningCount]);

  function onOpenTask(task: BackgroundTask) {
    const target = taskTarget(task, qc);
    // A finished task dismisses on click; a running one just navigates.
    if (task.status !== "running") dismiss(task.id);
    if (target) {
      setOpen(false);
      navigate(target);
    }
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={
            runningCount > 0 ? t.runningCount(runningCount) : t.open
          }
          title={`${t.open} (${modShift("B")})`}
          className={cn(
            "flex h-7 items-center gap-1.5 rounded-md px-2 text-muted-foreground transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none",
            open && "bg-secondary/60 text-foreground",
          )}
        >
          {runningCount > 0 ? (
            <>
              {/* Subtle activity signal: a pulsing accent dot + the running count. */}
              <span
                className="size-1.5 rounded-full bg-primary motion-safe:animate-pulse"
                aria-hidden="true"
              />
              <span className="font-numeric text-[11px] text-foreground">
                {runningCount}
              </span>
            </>
          ) : (
            <>
              <ListChecks className="size-3.5" aria-hidden="true" />
              {errorCount > 0 && (
                <span
                  className="size-1.5 rounded-full bg-status-error"
                  aria-hidden="true"
                />
              )}
            </>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" sideOffset={8} className="w-80 p-1.5">
        <p className="px-2 pt-1 pb-1.5 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
          {t.title}
        </p>
        {list.length === 0 ? (
          <p className="px-2 pt-1 pb-3 text-xs text-muted-foreground">
            {t.empty}
          </p>
        ) : (
          <div className="flex max-h-80 flex-col gap-0.5 overflow-y-auto">
            {list.map((task) => (
              <TaskRow
                key={task.id}
                task={task}
                now={now}
                kindLabel={t.kind[task.kind as TaskKind]}
                statusLabel={t.status[task.status]}
                onOpen={onOpenTask}
              />
            ))}
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
