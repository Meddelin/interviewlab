import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Plus } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useCreateCycle } from "@/lib/cycle-queries";
import { useUiStore } from "@/lib/ui-store";

// "New cycle" button + Dialog (spec §3.1: dialog asks for a name only).
// On create, navigates straight into the new cycle's Overview to fill in the rest.
// Also opens when the command palette requests it (useUiStore.requestNewCycle).
export function NewCycleDialog() {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const navigate = useNavigate();
  const createCycle = useCreateCycle();
  const newCycleRequest = useUiStore((s) => s.newCycleRequest);

  // The palette bumps this counter to ask us to open. Ignore the initial 0.
  useEffect(() => {
    if (newCycleRequest > 0) setOpen(true);
  }, [newCycleRequest]);

  async function handleCreate() {
    const trimmed = name.trim();
    if (!trimmed) return;
    try {
      const cycle = await createCycle.mutateAsync(trimmed);
      setOpen(false);
      setName("");
      toast.success(`Created "${cycle.name}"`);
      navigate(`/cycles/${cycle.id}`);
    } catch (e) {
      toast.error(`Couldn't create the cycle. ${String(e)}`);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm">
          <Plus className="size-4" />
          New cycle
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New cycle</DialogTitle>
          <DialogDescription>
            Name this research wave. You can add the product description and
            interview guide next.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-2">
          <label
            htmlFor="new-cycle-name"
            className="text-xs font-medium text-muted-foreground"
          >
            Name
          </label>
          <Input
            id="new-cycle-name"
            autoFocus
            placeholder="e.g. Onboarding · Wave 3"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleCreate();
            }}
          />
        </div>
        <DialogFooter>
          <Button
            onClick={handleCreate}
            disabled={!name.trim() || createCycle.isPending}
          >
            {createCycle.isPending ? "Creating…" : "Create cycle"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
