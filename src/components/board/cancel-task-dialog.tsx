"use client";

import { useState } from "react";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";

export type CancelOptions = { close_pr: boolean; delete_branch: boolean };

export function CancelTaskDialog({
  open,
  onOpenChange,
  hasPrUrl,
  hasBranch,
  prUrl,
  branchName,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  hasPrUrl: boolean;
  hasBranch: boolean;
  prUrl?: string;
  branchName?: string;
  onConfirm: (opts: CancelOptions) => Promise<void> | void;
}) {
  const [closePr, setClosePr] = useState(true);
  const [deleteBranch, setDeleteBranch] = useState(false);
  const [busy, setBusy] = useState(false);

  const handle = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await onConfirm({ close_pr: closePr, delete_branch: deleteBranch });
      onOpenChange(false);
    } catch {
      // caller surfaces the error; keep dialog open for retry
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!busy) onOpenChange(v);
      }}
    >
      <DialogContent title="Cancel task" divider>
        <div className="px-6 py-4 space-y-4">
          {hasPrUrl ? (
            <label className="flex items-center justify-between gap-4 cursor-pointer">
              <div className="min-w-0">
                <p className="text-sm font-medium">Close PR</p>
                {prUrl ? (
                  <p className="text-xs text-text-2 font-mono truncate mt-0.5">
                    {prUrl}
                  </p>
                ) : null}
              </div>
              <Switch
                checked={closePr}
                onCheckedChange={setClosePr}
                disabled={busy}
              />
            </label>
          ) : null}
          {hasBranch ? (
            <label className="flex items-center justify-between gap-4 cursor-pointer">
              <div className="min-w-0">
                <p className="text-sm font-medium">Delete branch</p>
                {branchName ? (
                  <p className="text-xs text-text-2 font-mono truncate mt-0.5">
                    {branchName}
                  </p>
                ) : null}
              </div>
              <Switch
                checked={deleteBranch}
                onCheckedChange={setDeleteBranch}
                disabled={busy}
              />
            </label>
          ) : null}
        </div>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="neutral" disabled={busy}>
              Keep task
            </Button>
          </DialogClose>
          <Button
            variant="neutral"
            onClick={handle}
            disabled={busy}
            className="border-muted/30 bg-muted/5 text-muted hover:bg-muted/10"
          >
            {busy ? "Canceling…" : "Cancel task"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
