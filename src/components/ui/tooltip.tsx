"use client";

import * as React from "react";
import * as RadixTooltip from "@radix-ui/react-tooltip";
import { cn } from "@/lib/utils";

export function TooltipProvider({
  children,
  delayDuration = 200,
}: {
  children: React.ReactNode;
  delayDuration?: number;
}) {
  return (
    <RadixTooltip.Provider delayDuration={delayDuration}>
      {children}
    </RadixTooltip.Provider>
  );
}

type Side = "top" | "right" | "bottom" | "left";
type Align = "start" | "center" | "end";

export function Tooltip({
  children,
  title,
  description,
  side = "bottom",
  align = "center",
  sideOffset = 6,
  contentClassName,
  open,
  defaultOpen,
  onOpenChange,
  disabled,
}: {
  children: React.ReactNode;
  title?: React.ReactNode;
  description?: React.ReactNode;
  side?: Side;
  align?: Align;
  sideOffset?: number;
  contentClassName?: string;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  disabled?: boolean;
}) {
  if (disabled || (!title && !description)) return <>{children}</>;
  return (
    <RadixTooltip.Root
      open={open}
      defaultOpen={defaultOpen}
      onOpenChange={onOpenChange}
    >
      <RadixTooltip.Trigger asChild>{children}</RadixTooltip.Trigger>
      <RadixTooltip.Portal>
        <RadixTooltip.Content
          side={side}
          align={align}
          sideOffset={sideOffset}
          className={cn(
            "z-50 max-w-[240px] rounded border border-border bg-surface px-2 py-1.5 text-xs text-text shadow-md",
            contentClassName,
          )}
        >
          {title ? <div className="font-medium">{title}</div> : null}
          {description ? (
            <p className={cn("text-text-2", title ? "mt-0.5" : undefined)}>
              {description}
            </p>
          ) : null}
          <RadixTooltip.Arrow className="fill-border" />
        </RadixTooltip.Content>
      </RadixTooltip.Portal>
    </RadixTooltip.Root>
  );
}
