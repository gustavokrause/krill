"use client";

import * as React from "react";
import * as RadixSwitch from "@radix-ui/react-switch";
import { cn } from "@/lib/utils";

export const Switch = React.forwardRef<
  React.ElementRef<typeof RadixSwitch.Root>,
  React.ComponentPropsWithoutRef<typeof RadixSwitch.Root>
>(({ className, ...props }, ref) => (
  <RadixSwitch.Root
    ref={ref}
    className={cn(
      "relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded border border-border",
      "bg-surface data-[state=checked]:bg-primary data-[state=checked]:border-primary",
      "focus:outline-none focus-visible:ring-1 focus-visible:ring-primary",
      "disabled:opacity-50",
      className,
    )}
    {...props}
  >
    <RadixSwitch.Thumb className="pointer-events-none block h-4 w-4 mt-[2px] ml-[2px] rounded bg-text data-[state=checked]:bg-white data-[state=checked]:translate-x-5" />
  </RadixSwitch.Root>
));
Switch.displayName = "Switch";
