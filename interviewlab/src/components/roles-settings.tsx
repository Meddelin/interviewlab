import { useEffect, useState } from "react";
import { ChevronDown, ChevronUp, GripVertical, Plus, Trash2 } from "lucide-react";
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
  useCreateRole,
  useDeleteRole,
  useRoles,
  useUpdateRole,
} from "@/lib/role-queries";
import type { Role } from "@/lib/tauri";

// A small palette of muted, Linear-ish hues to seed new roles + offer in the color picker.
// Mirrors the --role-* / status token family (index.css) so chips stay coherent.
const ROLE_PALETTE = [
  "#7c86e3", // indigo (interviewer)
  "#3fb68b", // teal (respondent)
  "#d9a23b", // amber (observer)
  "#9a9ca3", // neutral (other)
  "#c08bd6", // violet
  "#e5614c", // red
  "#5ab0c4", // cyan
  "#cf7bb0", // pink
];

// ── Color picker popover ───────────────────────────────────────────────────────
function ColorPicker({
  color,
  onPick,
}: {
  color: string;
  onPick: (c: string) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label="Role color"
          className="size-5 shrink-0 rounded-full border border-border-strong transition-transform hover:scale-110 focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
          style={{ backgroundColor: color }}
        />
      </PopoverTrigger>
      <PopoverContent align="start" className="w-auto p-2">
        <div className="grid grid-cols-4 gap-1.5">
          {ROLE_PALETTE.map((c) => (
            <button
              key={c}
              type="button"
              aria-label={`Pick ${c}`}
              onClick={() => {
                onPick(c);
                setOpen(false);
              }}
              className="size-6 rounded-full border border-border-strong transition-transform hover:scale-110 focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
              style={{ backgroundColor: c }}
            />
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}

// ── One role row (rename + recolor + reorder + delete) ─────────────────────────
function RoleRow({
  role,
  index,
  total,
  onMove,
}: {
  role: Role;
  index: number;
  total: number;
  onMove: (dir: -1 | 1) => void;
}) {
  const updateRole = useUpdateRole();
  const deleteRole = useDeleteRole();
  const [name, setName] = useState(role.name);

  useEffect(() => setName(role.name), [role.name]);

  function commitName() {
    const trimmed = name.trim();
    if (!trimmed || trimmed === role.name) {
      setName(role.name);
      return;
    }
    updateRole.mutate({ id: role.id, name: trimmed, color: role.color, sort: role.sort });
  }

  function recolor(color: string) {
    updateRole.mutate({ id: role.id, name: role.name, color, sort: role.sort });
  }

  function remove() {
    deleteRole.mutate(role.id, {
      onError: (e) => toast.error(String(e)),
      onSuccess: () => toast.success("Role deleted"),
    });
  }

  return (
    <li className="group/role flex items-center gap-2 border-b border-border px-2 py-2 last:border-b-0">
      <GripVertical className="size-3.5 shrink-0 text-muted-foreground/40" aria-hidden />
      <ColorPicker color={role.color} onPick={recolor} />
      <Input
        value={name}
        onChange={(e) => setName(e.target.value)}
        onBlur={commitName}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        }}
        className="h-7 flex-1 border-transparent bg-transparent px-1.5 text-sm shadow-none focus-visible:border-input"
      />
      {/* Reorder */}
      <div className="flex items-center opacity-0 transition-opacity group-hover/role:opacity-100 focus-within:opacity-100">
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="Move up"
          className="text-muted-foreground"
          disabled={index === 0}
          onClick={() => onMove(-1)}
        >
          <ChevronUp className="size-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="Move down"
          className="text-muted-foreground"
          disabled={index === total - 1}
          onClick={() => onMove(1)}
        >
          <ChevronDown className="size-3.5" />
        </Button>
      </div>
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label="Delete role"
        className="text-muted-foreground opacity-0 transition-opacity group-hover/role:opacity-100 hover:text-destructive focus-visible:opacity-100"
        onClick={remove}
        disabled={deleteRole.isPending}
      >
        <Trash2 className="size-3.5" />
      </Button>
    </li>
  );
}

export function RolesSettings() {
  const { data: roles, isPending } = useRoles();
  const createRole = useCreateRole();
  const updateRole = useUpdateRole();
  const [newName, setNewName] = useState("");

  async function add() {
    const trimmed = newName.trim();
    if (!trimmed) return;
    // Cycle a palette color by current count so consecutive adds differ.
    const color = ROLE_PALETTE[(roles?.length ?? 0) % ROLE_PALETTE.length];
    try {
      await createRole.mutateAsync({ name: trimmed, color });
      setNewName("");
    } catch (e) {
      toast.error(`Couldn't add the role. ${String(e)}`);
    }
  }

  // Swap two adjacent roles' sort values (a minimal, dependency-free reorder).
  function move(index: number, dir: -1 | 1) {
    if (!roles) return;
    const target = index + dir;
    if (target < 0 || target >= roles.length) return;
    const a = roles[index];
    const b = roles[target];
    updateRole.mutate({ id: a.id, name: a.name, color: a.color, sort: b.sort });
    updateRole.mutate({ id: b.id, name: b.name, color: b.color, sort: a.sort });
  }

  return (
    <div className="flex w-full flex-col gap-4 pt-2">
      <div className="flex flex-col gap-0.5">
        <span className="text-sm font-medium text-foreground">Roles</span>
        <span className="text-xs text-muted-foreground">
          A reusable library of speaker roles for the transcript editor. The first role is
          the conventional interviewer — synthesis treats its turns as questions/context.
        </span>
      </div>

      {isPending || !roles ? (
        <Skeleton className="h-40 w-full" />
      ) : (
        <ul className="overflow-hidden rounded-lg border border-border bg-card/40">
          {roles.map((role, i) => (
            <RoleRow
              key={role.id}
              role={role}
              index={i}
              total={roles.length}
              onMove={(dir) => move(i, dir)}
            />
          ))}
        </ul>
      )}

      {/* Add a role */}
      <div className="flex items-center gap-2">
        <Input
          placeholder="Add a role (e.g. Дизайнер)…"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") add();
          }}
          className="h-8 max-w-xs"
        />
        <Button
          size="sm"
          variant="outline"
          onClick={add}
          disabled={!newName.trim() || createRole.isPending}
        >
          <Plus className="size-3.5" />
          Add role
        </Button>
      </div>
    </div>
  );
}
