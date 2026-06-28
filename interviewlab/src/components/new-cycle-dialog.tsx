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
import { useT } from "@/lib/i18n";

const STR = {
  ru: {
    newCycle: "Новый цикл",
    title: "Новый цикл",
    description:
      "Назовите эту волну исследования. Описание продукта и гайд интервью можно добавить дальше.",
    name: "Название",
    placeholder: "напр. Онбординг · Волна 3",
    creating: "Создаём…",
    create: "Создать цикл",
    created: (name: string) => `Создан «${name}»`,
    createError: (e: string) => `Не удалось создать цикл. ${e}`,
  },
  en: {
    newCycle: "New cycle",
    title: "New cycle",
    description:
      "Name this research wave. You can add the product description and interview guide next.",
    name: "Name",
    placeholder: "e.g. Onboarding · Wave 3",
    creating: "Creating…",
    create: "Create cycle",
    created: (name: string) => `Created "${name}"`,
    createError: (e: string) => `Couldn't create the cycle. ${e}`,
  },
};

// "New cycle" button + Dialog (spec §3.1: dialog asks for a name only).
// On create, navigates straight into the new cycle's Overview to fill in the rest.
// Also opens when the command palette requests it (useUiStore.requestNewCycle).
export function NewCycleDialog() {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const navigate = useNavigate();
  const createCycle = useCreateCycle();
  const newCycleRequest = useUiStore((s) => s.newCycleRequest);
  const t = useT(STR);

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
      toast.success(t.created(cycle.name));
      navigate(`/cycles/${cycle.id}`);
    } catch (e) {
      toast.error(t.createError(String(e)));
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm">
          <Plus className="size-4" />
          {t.newCycle}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t.title}</DialogTitle>
          <DialogDescription>{t.description}</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-2">
          <label
            htmlFor="new-cycle-name"
            className="text-xs font-medium text-muted-foreground"
          >
            {t.name}
          </label>
          <Input
            id="new-cycle-name"
            autoFocus
            placeholder={t.placeholder}
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
            {createCycle.isPending ? t.creating : t.create}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
