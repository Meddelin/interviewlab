import { useQuery } from "@tanstack/react-query";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { dbHealth } from "@/lib/tauri";
import { cn } from "@/lib/utils";

// A quiet status dot (not a big pill). Calls `db_health` on load; in the browser
// dev server there's no Tauri runtime so invoke rejects — expected, shown as offline.
export function BackendStatus() {
  const { data, isPending, isError } = useQuery({
    queryKey: ["db_health"],
    queryFn: dbHealth,
    retry: false,
  });

  const state = isPending
    ? { dot: "bg-status-importing motion-safe:animate-pulse", label: "Connecting…" }
    : isError || !data
      ? { dot: "bg-muted-foreground/50", label: "Backend offline" }
      : { dot: "bg-status-ready", label: `Backend OK · schema v${data.schema_version}` };

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
