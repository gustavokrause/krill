"use client";

import { ReactNode, useState } from "react";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogTrigger,
} from "./dialog";
import { Button, type ButtonProps } from "./button";

type Variant = NonNullable<ButtonProps["variant"]>;

export function ConfirmDialog({
  title,
  description,
  confirmLabel = "Confirm",
  busyLabel,
  confirmVariant = "primary",
  cancelLabel = "Cancel",
  trigger,
  open: controlledOpen,
  onOpenChange,
  onConfirm,
}: {
  title: string;
  description?: string;
  confirmLabel?: string;
  busyLabel?: string;
  confirmVariant?: Variant;
  cancelLabel?: string;
  trigger?: ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  onConfirm: () => Promise<void> | void;
}) {
  const [internalOpen, setInternalOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const isControlled = controlledOpen !== undefined;
  const open = isControlled ? controlledOpen : internalOpen;
  const setOpen = (v: boolean) => {
    if (!isControlled) setInternalOpen(v);
    onOpenChange?.(v);
  };

  const handle = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await onConfirm();
      setOpen(false);
    } catch {
      // caller surfaces error; keep dialog open for retry
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!busy) setOpen(v);
      }}
    >
      {trigger ? <DialogTrigger asChild>{trigger}</DialogTrigger> : null}
      <DialogContent title={title} description={description} divider={false}>
        <div className="flex justify-end gap-2 px-6 py-4">
          <DialogClose asChild>
            <Button variant="neutral" disabled={busy}>
              {cancelLabel}
            </Button>
          </DialogClose>
          <Button
            variant={confirmVariant}
            onClick={handle}
            disabled={busy}
          >
            {busy ? busyLabel ?? `${confirmLabel}…` : confirmLabel}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
