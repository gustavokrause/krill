"use client";

import { useEffect, useRef, useState } from "react";
import { Trash2 } from "lucide-react";
import { Tooltip } from "@/components/ui/tooltip";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogBody,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { useToast } from "@/components/ui/toast";
import { api } from "@/lib/client/api";
import { type TermWindow, TERM_WINDOWS } from "@/lib/term-window";

export function BoardCleanupDialog() {
  const [open, setOpen] = useState(false);
  const [window, setWindow] = useState<TermWindow>("week");
  const [count, setCount] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const { push } = useToast();
  const seqRef = useRef(0);

  useEffect(() => {
    if (!open) return;
    const seq = ++seqRef.current;
    setLoading(true);
    setCount(null);
    api.cleanupPreview(window).then((r) => {
      if (seq !== seqRef.current) return;
      setCount(r.count);
      setLoading(false);
    }).catch(() => {
      if (seq !== seqRef.current) return;
      setLoading(false);
    });
  }, [open, window]);

  const handleConfirm = async () => {
    const result = await api.cleanupTerminals(window);
    setOpen(false);
    push({ title: `Deleted ${result.deleted} task${result.deleted === 1 ? "" : "s"}`, variant: "success" });
  };

  const countLabel = loading ? "…" : count === null ? "…" : String(count);
  const canDelete = !loading && count !== null && count > 0;

  const trigger = (
    <Tooltip title="Clean up terminal tasks" side="bottom">
      <button
        type="button"
        aria-label="Clean up Done / Canceled tasks"
        className="inline-flex items-center justify-center h-9 w-9 rounded text-text hover:bg-surface focus:outline-none focus-visible:ring-1 focus-visible:ring-primary"
        onClick={() => setOpen(true)}
      >
        <Trash2 className="h-4 w-4" />
      </button>
    </Tooltip>
  );

  return (
    <>
      {trigger}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent title="Clean up terminal tasks" description="Permanently delete Done and Canceled tasks in the chosen time window.">
          <DialogBody>
            <div className="space-y-4">
              <div>
                <label className="text-sm font-medium text-text-2 block mb-1.5">
                  Time window
                </label>
                <Select value={window} onValueChange={(v) => setWindow(v as TermWindow)}>
                  <SelectTrigger className="h-9 w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {TERM_WINDOWS.map((w) => (
                      <SelectItem key={w.value} value={w.value}>
                        {w.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <p className={count === 0 ? "text-sm text-text-3" : "text-sm text-warning"}>
                {countLabel} task{count === 1 ? "" : "s"} will be permanently deleted.
              </p>
            </div>
          </DialogBody>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="neutral">Cancel</Button>
            </DialogClose>
            <Button
              variant="danger"
              disabled={!canDelete}
              onClick={() => setConfirmOpen(true)}
            >
              Delete {countLabel}…
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        title={`Permanently delete ${countLabel} task${count === 1 ? "" : "s"}?`}
        description="This cannot be undone. Deleted tasks will be removed from the board immediately."
        confirmLabel={`Delete ${countLabel} task${count === 1 ? "" : "s"}`}
        busyLabel="Deleting…"
        confirmVariant="danger"
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        onConfirm={handleConfirm}
      />
    </>
  );
}
