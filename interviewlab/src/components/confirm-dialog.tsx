// Shared confirm primitive (v3 F3 — P0 "данные теряются в один клик").
//
// Replaces the scattered native window.confirm() guards with one Linear-styled dialog:
// flat surface, hairline ring, muted body, a single destructive (or primary) action.
//
// Two ways to use it:
//   • <ConfirmDialog> — controlled. Pass open/onOpenChange + title/body/labels/onConfirm.
//     Best when the open state already exists (e.g. a react-router useBlocker).
//   • useConfirm() — imperative, drop-in for `if (!confirm(...)) return`:
//       const { confirm, dialog } = useConfirm();
//       …render {dialog} once…
//       if (!(await confirm({ title, body, destructive: true }))) return;
import { useCallback, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useT } from "@/lib/i18n";

const STR = {
  ru: { cancel: "Отмена", confirm: "Подтвердить" },
  en: { cancel: "Cancel", confirm: "Confirm" },
} as const;

export type ConfirmOptions = {
  title: string;
  /** Secondary body line under the title (muted). */
  body?: string;
  /** Label of the confirming action; defaults to a generic "Confirm". */
  confirmLabel?: string;
  cancelLabel?: string;
  /** Destructive tint on the confirming action (deletes / overwrites). */
  destructive?: boolean;
};

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  body,
  confirmLabel,
  cancelLabel,
  destructive,
  onConfirm,
  onCancel,
}: ConfirmOptions & {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
  /** Fired on explicit Cancel AND on dismiss (Esc / overlay click). */
  onCancel?: () => void;
}) {
  const t = useT(STR);
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) onCancel?.();
        onOpenChange(o);
      }}
    >
      <DialogContent showCloseButton={false} className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {body ? <DialogDescription>{body}</DialogDescription> : null}
        </DialogHeader>
        <DialogFooter>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              onCancel?.();
              onOpenChange(false);
            }}
          >
            {cancelLabel ?? t.cancel}
          </Button>
          <Button
            variant={destructive ? "destructive" : "default"}
            size="sm"
            // onConfirm BEFORE onOpenChange: useConfirm resolves on the first signal it
            // gets, so the confirming click must win over the close-as-cancel path.
            onClick={() => {
              onConfirm();
              onOpenChange(false);
            }}
          >
            {confirmLabel ?? t.confirm}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

type Pending = { opts: ConfirmOptions; resolve: (ok: boolean) => void };

// Imperative confirm — async drop-in for the native `confirm()`. Render the returned
// `dialog` node once in the component; `confirm(opts)` resolves true on the confirming
// action, false on Cancel / Esc / overlay dismiss. A second confirm() while one is open
// replaces it (the first resolves false), which matches how the UI can actually be used.
export function useConfirm(): {
  confirm: (opts: ConfirmOptions) => Promise<boolean>;
  dialog: ReactNode;
} {
  const [pending, setPending] = useState<Pending | null>(null);

  const confirm = useCallback((opts: ConfirmOptions) => {
    return new Promise<boolean>((resolve) => {
      setPending((prev) => {
        prev?.resolve(false);
        return { opts, resolve };
      });
    });
  }, []);

  // Resolving twice is harmless (Promise settles once), so the confirm-then-close and
  // cancel-then-close call orders both do the right thing.
  const settle = (ok: boolean) => {
    pending?.resolve(ok);
    setPending(null);
  };

  const dialog = (
    <ConfirmDialog
      open={pending !== null}
      onOpenChange={(o) => {
        if (!o) settle(false);
      }}
      title={pending?.opts.title ?? ""}
      body={pending?.opts.body}
      confirmLabel={pending?.opts.confirmLabel}
      cancelLabel={pending?.opts.cancelLabel}
      destructive={pending?.opts.destructive}
      onConfirm={() => settle(true)}
    />
  );

  return { confirm, dialog };
}
