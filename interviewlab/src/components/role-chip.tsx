import { cn } from "@/lib/utils";

// Quiet inline role chip (design-direction: "speaker/role tags as quiet inline chips").
//
// M10a: roles are now a user-managed LIBRARY (src-tauri/src/roles.rs), each with its own
// hex color, instead of the old fixed enum. So the chip is color-driven: it takes a hex
// `color` + a label and renders the dot/text from that color via inline styles (we can't
// use Tailwind utility classes for arbitrary runtime hexes). The legacy enum helpers
// below are kept for back-compat with any caller still importing them.

// A small color dot + label, tinted by the role's library color. `tone="soft"` adds a
// faint tinted fill (used on transcript segment rows so the speaker reads at a glance).
// `unassigned` renders the muted, dashed "Unassigned" state (spec §4.5).
export function RoleChip({
  color,
  label,
  unassigned,
  tone = "plain",
  className,
}: {
  /** The role's library color (hex). */
  color?: string;
  /** What to show — a participant name or the role label. */
  label?: string;
  unassigned?: boolean;
  tone?: "plain" | "soft";
  className?: string;
}) {
  if (unassigned || !color) {
    return (
      <span
        className={cn(
          "inline-flex items-center gap-1.5 rounded-md border border-dashed border-border px-1.5 py-0.5 text-xs text-muted-foreground",
          className,
        )}
      >
        <span
          className="size-1.5 shrink-0 rounded-full bg-muted-foreground/50"
          aria-hidden
        />
        {label ?? "Unassigned"}
      </span>
    );
  }
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-md px-1.5 py-0.5 text-xs font-medium",
        className,
      )}
      style={{
        color,
        // 12% tint via an 8-digit hex alpha; only when soft.
        backgroundColor: tone === "soft" ? `${color}1f` : undefined,
      }}
    >
      <span
        className="size-1.5 shrink-0 rounded-full"
        style={{ backgroundColor: color }}
        aria-hidden
      />
      <span className="truncate">{label}</span>
    </span>
  );
}

// ── Legacy enum helpers (pre-M10a) ────────────────────────────────────────────
// Retained for back-compat. New code reads the role library (useRoles) instead.
export type Role = "interviewer" | "respondent" | "observer" | "other";

export const ROLES: Role[] = ["interviewer", "respondent", "observer", "other"];

// The seeded library colors (migration 0002) mirrored here so legacy callers still tint.
export const LEGACY_ROLE_COLOR: Record<Role, string> = {
  interviewer: "#7c86e3",
  respondent: "#3fb68b",
  observer: "#d9a23b",
  other: "#9a9ca3",
};

export function isRole(value: string | null | undefined): value is Role {
  return (
    value === "interviewer" ||
    value === "respondent" ||
    value === "observer" ||
    value === "other"
  );
}
