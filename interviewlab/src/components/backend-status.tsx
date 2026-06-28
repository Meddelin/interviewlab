import { useQuery } from "@tanstack/react-query";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { dbHealth } from "@/lib/tauri";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";

const STR = {
  ru: {
    connecting: "Подключение…",
    offline: "Бэкенд недоступен",
    ok: (v: number) => `Бэкенд в порядке · схема v${v}`,
  },
  en: {
    connecting: "Connecting…",
    offline: "Backend offline",
    ok: (v: number) => `Backend OK · schema v${v}`,
  },
} as const;

// A quiet status dot (not a big pill). Calls `db_health` on load; in the browser
// dev server there's no Tauri runtime so invoke rejects — expected, shown as offline.
export function BackendStatus() {
  const t = useT(STR);
  const { data, isPending, isError } = useQuery({
    queryKey: ["db_health"],
    queryFn: dbHealth,
    retry: false,
  });

  const state = isPending
    ? { dot: "bg-status-importing motion-safe:animate-pulse", label: t.connecting }
    : isError || !data
      ? { dot: "bg-muted-foreground/50", label: t.offline }
      : { dot: "bg-status-ready", label: t.ok(data.schema_version) };

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className="flex size-6 items-center justify-center rounded-md text-muted-foreground"
          aria-label={state.label}
        >
          <span
            className={cn("size-1.5 rounded-full", state.dot)}
            aria-hidden="true"
          />
        </span>
      </TooltipTrigger>
      <TooltipContent side="bottom">
        <span className="font-numeric text-xs">{state.label}</span>
        {data?.db_path && (
          <span className="mt-0.5 block max-w-xs truncate text-[10px] text-muted-foreground">
            {data.db_path}
          </span>
        )}
      </TooltipContent>
    </Tooltip>
  );
}
