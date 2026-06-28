import { useNavigate } from "react-router-dom";
import { Waves } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { NewCycleDialog } from "@/components/new-cycle-dialog";
import { useCycles } from "@/lib/cycle-queries";
import { relativeTime, absoluteDate } from "@/lib/format";
import type { Cycle } from "@/lib/tauri";
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
  },
};

// ponytail: the old status dot derived processing/idle from record age (updated_at < 7d),
// which is a lie — it told nothing about real work. The honest interview-count metadata
// isn't on the Cycle type (would need a backend/list_cycles change, out of scope here), so
// the dot is removed rather than faked. The "wave N" index already carries quiet metadata.
function CycleRow({ cycle, index }: { cycle: Cycle; index: number }) {
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

      {/* Wave index — a quiet nod to "research waves", right-aligned metadata. */}
      <span className="hidden font-numeric text-xs text-muted-foreground/70 sm:inline">
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
              <Skeleton className="ml-auto h-3 w-16" />
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
            <CycleRow key={cycle.id} cycle={cycle} index={i} />
          ))}
        </div>
      )}
    </div>
  );
}
