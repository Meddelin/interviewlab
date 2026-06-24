import { cn } from "@/lib/utils";

// The domain status vocabulary, used everywhere: interview ingest now, speaker/role
// tags later. One muted, semantic palette — a small dot + optional label.
export type StatusKind = "ready" | "importing" | "error" | "processing" | "idle";

const STATUS: Record<StatusKind, { label: string; dot: string; text: string }> = {
  ready: {
    label: "Ready",
    dot: "bg-status-ready",
    text: "text-status-ready",
  },
  importing: {
    // A soft pulse signals live work without a spinner.
    label: "Importing",
    dot: "bg-status-importing motion-safe:animate-pulse",
    text: "text-status-importing",
  },
  processing: {
    label: "Processing",
    dot: "bg-status-processing motion-safe:animate-pulse",
    text: "text-status-processing",
  },
  error: {
    label: "Error",
    dot: "bg-status-error",
    text: "text-status-error",
  },
  idle: {
    label: "Idle",
    dot: "bg-muted-foreground/60",
    text: "text-muted-foreground",
  },
};

// Map the backend's raw interview.status string into our vocabulary.
// 'new' (media prepared) reads as Ready; 'transcribing' is live work; 'transcribed'
// reads as Ready (done). Unknown states stay idle.
export function interviewStatus(status: string): StatusKind {
  if (status === "importing") return "importing";
  if (status === "transcribing") return "processing";
  if (status === "error") return "error";
  if (status === "new" || status === "ready" || status === "transcribed")
    return "ready";
  return "idle";
}

export function StatusDot({
  kind,
  label,
  className,
}: {
  kind: StatusKind;
  /** Show the text label beside the dot. Defaults to true. */
  label?: boolean;
  className?: string;
}) {
  const s = STATUS[kind];
  const showLabel = label ?? true;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 text-xs",
        showLabel && s.text,
        className,
      )}
    >
      <span
        className={cn("size-1.5 shrink-0 rounded-full", s.dot)}
        aria-hidden="true"
      />
      {showLabel && <span>{s.label}</span>}
    </span>
  );
}
