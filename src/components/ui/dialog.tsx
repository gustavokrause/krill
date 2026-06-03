"use client";

import * as React from "react";
import * as RadixDialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";

export const Dialog = RadixDialog.Root;
export const DialogTrigger = RadixDialog.Trigger;
export const DialogClose = RadixDialog.Close;

let openDialogCount = 0;
const BASE_OVERLAY_Z = 40;
const PER_LEVEL_Z = 20;

function useDialogStackLevel(): number {
  const [level, setLevel] = React.useState(1);
  React.useLayoutEffect(() => {
    openDialogCount += 1;
    setLevel(openDialogCount);
    return () => {
      openDialogCount -= 1;
    };
  }, []);
  return level;
}

export function DialogContent({
  className,
  children,
  title,
  description,
  size = "default",
  divider = true,
  ...props
}: React.ComponentPropsWithoutRef<typeof RadixDialog.Content> & {
  title: string;
  description?: string;
  size?: "default" | "large";
  divider?: boolean;
}) {
  const level = useDialogStackLevel();
  const overlayZ = BASE_OVERLAY_Z + (level - 1) * PER_LEVEL_Z;
  const contentZ = overlayZ + 10;
  return (
    <RadixDialog.Portal>
      <RadixDialog.Overlay
        style={{ zIndex: overlayZ }}
        className="fixed inset-0 bg-black/40 dark:bg-black/60 backdrop-blur-[2px]"
      />
      <RadixDialog.Content
        style={{ zIndex: contentZ }}
        // Explicit aria-describedby={undefined} when no Description is rendered
        // — silences Radix's dev warning. When `description` IS set, omit the
        // prop so Radix auto-links its generated Description element.
        {...(description ? {} : { "aria-describedby": undefined })}
        className={cn(
          "fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2",
          "bg-surface text-text border border-border rounded-sm",
          "outline-none w-[calc(100vw-2rem)]",
          "flex flex-col max-h-[calc(100vh-2rem)] sm:max-h-[85vh]",
          size === "large" ? "max-w-3xl" : "max-w-md",
          className,
        )}
        {...props}
      >
        <header
          className={cn(
            "flex items-start justify-between gap-3 shrink-0 px-6 pt-5 pb-4",
            divider && "border-b border-border",
          )}
        >
          <div className="min-w-0">
            <RadixDialog.Title className="text-lg font-bold leading-tight">
              {title}
            </RadixDialog.Title>
            {description ? (
              <RadixDialog.Description className="text-sm text-text-2 mt-1">
                {description}
              </RadixDialog.Description>
            ) : null}
          </div>
          <RadixDialog.Close
            aria-label="Close"
            className="-mt-1 -mr-2 h-9 w-9 shrink-0 inline-flex items-center justify-center rounded text-text-2 hover:text-text"
          >
            <X className="h-4 w-4" />
          </RadixDialog.Close>
        </header>
        {children}
      </RadixDialog.Content>
    </RadixDialog.Portal>
  );
}

export function DialogBody({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={cn("flex-1 min-h-0 overflow-y-auto px-6 pt-5 pb-7", className)}>
      {children}
    </div>
  );
}

export function DialogFooter({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        "shrink-0 px-6 py-5 border-t border-border flex items-center justify-end gap-2",
        className,
      )}
    >
      {children}
    </div>
  );
}
