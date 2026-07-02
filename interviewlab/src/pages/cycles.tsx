import { useNavigate } from "react-router-dom";
import { useQueries } from "@tanstack/react-query";
import { Check, GitCompare, Mic, Waves } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { NewCycleDialog } from "@/components/new-cycle-dialog";
import { useCycles } from "@/lib/cycle-queries";
import { relativeTime, absoluteDate } from "@/lib/format";
import { getDiff, getSynthesis, listInterviews, type Cycle } from "@/lib/tauri";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n";

const STR = {
  ru: {
    wave: (n: number) => `волна ${n}`,
    updatedTitle: (d: string) => `Обновлён ${d}`,
    heading: "Циклы",
    subtitle: "Каждый цикл — это волна интервью: загрузка, расшифровка, синтез.",
    loadError: "Не удалось загрузить циклы",
    loadErrorDetail: (e: string) => `Бэкенд не ответил. ${e}`,
    tryAgain: "Повторить",
    emptyTitle: "Пока нет циклов",
    emptyBody:
      "Создайте первый, чтобы начать волну исследования — загрузите записи, расшифруйте и синтезируйте выводы.",
    interviewsCount: (n: number) => `Интервью: ${n}`,
    synthesized: "Синтез готов",
    notSynthesized: "Синтеза ещё нет",
    diffDone: "Сравнение с прошлой волной готово",
    noDiff: "Сравнения ещё нет",
  },
  en: {
    wave: (n: number) => `wave ${n}`,
    updatedTitle: (d: string) => `Updated ${d}`,
    heading: "Cycles",
    subtitle: "Each cycle is a wave of interviews — ingest, transcribe, synthesize.",
    loadError: "Couldn't load cycles",
    loadErrorDetail: (e: string) => `The backend didn't respond. ${e}`,
    tryAgain: "Try again",
    emptyTitle: "No cycles yet",
    emptyBody:
      "Create your first to start a research wave — ingest recordings, transcribe, and synthesize findings.",
    interviewsCount: (n: number) => `Interviews: ${n}`,
    synthesized: "Synthesized",
    notSynthesized: "Not synthesized yet",
    diffDone: "Diff vs previous wave done",
    noDiff: "No diff yet",
  },
};

// Compact per-cycle status pulled alongside the list (v3 F1 "cycles polish"): the
// Cycle row itself carries no work-state, so each row fetches its interviews count +
// synthesized/diff flags in ONE grouped queryFn. // ponytail: 3 invokes per cycle is an
// accepted N+1 — local SQLite round-trips are ~free and a list_cycles schema change is
// out of this package's scope.
type CycleStatusSummary = {
  interviews: number;
  synthesized: boolean;
  hasDiff: boolean;
};

function useCycleStatuses(cycles: Cycle[] | undefined) {
  return useQueries({
    queries: (cycles ?? []).map((cycle) => ({
      queryKey: ["cycle-status", cycle.id] as const,
      queryFn: async (): Promise<CycleStatusSummary> => {
        const [interviews, synthesis, diff] = await Promise.all([
          listInterviews(cycle.id),
          getSynthesis(cycle.id),
          getDiff(cycle.id),
        ]);
        return {
          interviews: interviews.length,
          synthesized: synthesis != null,
          hasDiff: diff != null,
        };
      },
      staleTime: 30_000,
    })),
  });
}

// A quiet boolean slot: a small semantic check when true, a dim dash when false —
// fixed width so the columns align across rows (dot + icon vocabulary, low saturation).
function CheckSlot({
  ok,
  icon: Icon,
  titleOn,
  titleOff,
}: {
  ok: boolean | undefined;
  icon: typeof Check;
  titleOn: string;
  titleOff: string;
}) {
  return (
    <span
      className="hidden w-6 shrink-0 items-center justify-center md:flex"
      title={ok ? titleOn : titleOff}
    >
      {ok ? (
        <Icon className="size-3.5 text-status-ready" aria-hidden="true" />
      ) : (
        <span
          className={cn(
            "text-xs text-muted-foreground/40",
            ok === undefined && "opacity-0",
          )}
          aria-hidden="true"
        >
          –
        </span>
      )}
      <span className="sr-only">{ok ? titleOn : titleOff}</span>
    </span>
  );
}

// ponytail: the old status dot derived processing/idle from record age (updated_at < 7d),
// which is a lie — it told nothing about real work. v3: the row now shows HONEST work
// state (interview count + synthesized/diff checks) fetched per cycle.
function CycleRow({
  cycle,
  index,
  summary,
}: {
  cycle: Cycle;
  index: number;
  summary: CycleStatusSummary | undefined;
}) {
  const navigate = useNavigate();
  const open = () => navigate(`/cycles/${cycle.id}`);
  const t = useT(STR);

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={open}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          open();
        }
      }}
      className="group flex h-12 cursor-pointer items-center gap-3 border-b border-border px-3 transition-colors last:border-b-0 hover:bg-secondary/40 focus-visible:bg-secondary/40 focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
    >
      <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
        {cycle.name}
      </span>

      {/* Status summary — interviews count, synthesized ✓, diff ✓; muted + tabular. */}
      <span
        className="hidden w-12 shrink-0 items-center justify-end gap-1 font-numeric text-xs text-muted-foreground sm:flex"
        title={t.interviewsCount(summary?.interviews ?? 0)}
      >
        <Mic className="size-3 opacity-60" aria-hidden="true" />
        {summary ? summary.interviews : "·"}
      </span>
      <CheckSlot
        ok={summary?.synthesized}
        icon={Check}
        titleOn={t.synthesized}
        titleOff={t.notSynthesized}
      />
      <CheckSlot
        ok={summary?.hasDiff}
        icon={GitCompare}
        titleOn={t.diffDone}
        titleOff={t.noDiff}
      />

      {/* Wave index — a quiet nod to "research waves", right-aligned metadata. */}
      <span className="hidden w-16 shrink-0 text-right font-numeric text-xs text-muted-foreground/70 sm:inline">
        {t.wave(index + 1)}
      </span>

      <span
        className="w-28 shrink-0 text-right font-numeric text-xs text-muted-foreground"
        title={t.updatedTitle(absoluteDate(cycle.updated_at))}
      >
        {relativeTime(cycle.updated_at)}
      </span>
    </div>
  );
}

export function CyclesPage() {
  const { data: cycles, isPending, isError, error, refetch } = useCycles();
  const statuses = useCycleStatuses(cycles);
  const t = useT(STR);

  return (
    // Wide: cap the list so rows don't stretch into a dead gap between the name (left) and
    // the timestamp (right) on ultrawide; centered with mx-auto, a touch wider at 2xl.
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-5 2xl:max-w-4xl">
      <header className="flex items-center justify-between gap-4">
        <div className="flex flex-col gap-0.5">
          <h1 className="text-lg font-semibold tracking-[-0.02em] text-foreground">
            {t.heading}
          </h1>
          <p className="text-xs text-muted-foreground">{t.subtitle}</p>
        </div>
        <NewCycleDialog />
      </header>

      {isPending ? (
        // Skeleton rows, not a spinner — mirrors the real list shape.
        <div className="overflow-hidden rounded-lg border border-border">
          {Array.from({ length: 4 }).map((_, i) => (
            <div
              key={i}
              className="flex h-12 items-center gap-3 border-b border-border px-3 last:border-b-0"
            >
              <Skeleton className="h-4 w-48" />
              <Skeleton className="ml-auto h-3 w-10" />
              <Skeleton className="h-3 w-16" />
            </div>
          ))}
        </div>
      ) : isError ? (
        <div className="flex flex-col items-start gap-3 rounded-lg border border-border bg-card p-8">
          <div className="flex flex-col gap-1">
            <p className="text-sm font-medium text-foreground">
              {t.loadError}
            </p>
            <p className="text-xs text-muted-foreground">
              {t.loadErrorDetail(String(error))}
            </p>
          </div>
          <button
            type="button"
            onClick={() => refetch()}
            className="rounded-md border border-border px-2.5 py-1 text-xs font-medium transition-colors hover:bg-secondary/60 focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
          >
            {t.tryAgain}
          </button>
        </div>
      ) : cycles.length === 0 ? (
        // Editorial empty state — one short line + one primary action.
        <div className="flex flex-col items-center gap-4 rounded-lg border border-dashed border-border px-6 py-16 text-center">
          <span className="flex size-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <Waves className="size-5" />
          </span>
          <div className="flex max-w-sm flex-col gap-1">
            <p className="text-sm font-medium text-foreground">{t.emptyTitle}</p>
            <p className="text-xs text-muted-foreground">{t.emptyBody}</p>
          </div>
          <NewCycleDialog />
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border border-border bg-card/40">
          {cycles.map((cycle, i) => (
            <CycleRow
              key={cycle.id}
              cycle={cycle}
              index={i}
              summary={statuses[i]?.data}
            />
          ))}
        </div>
      )}
    </div>
  );
}
