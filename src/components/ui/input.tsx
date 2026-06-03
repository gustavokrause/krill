"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

export const Input = React.forwardRef<
  HTMLInputElement,
  React.InputHTMLAttributes<HTMLInputElement>
>(({ className, ...props }, ref) => (
  <input
    ref={ref}
    className={cn(
      "h-9 w-full rounded border border-border bg-surface px-3 py-2 text-sm text-text",
      "focus:outline-none focus:border-border-strong focus:ring-1 focus:ring-primary",
      "disabled:opacity-50 placeholder:text-text-3",
      className,
    )}
    {...props}
  />
));
Input.displayName = "Input";

export const Textarea = React.forwardRef<
  HTMLTextAreaElement,
  React.TextareaHTMLAttributes<HTMLTextAreaElement>
>(({ className, ...props }, ref) => (
  <textarea
    ref={ref}
    className={cn(
      "min-h-[80px] w-full rounded border border-border bg-surface px-3 py-2 text-sm text-text",
      "focus:outline-none focus:border-border-strong focus:ring-1 focus:ring-primary",
      "disabled:opacity-50 placeholder:text-text-3 font-sans",
      className,
    )}
    {...props}
  />
));
Textarea.displayName = "Textarea";

export const Label = React.forwardRef<
  HTMLLabelElement,
  React.LabelHTMLAttributes<HTMLLabelElement>
>(({ className, ...props }, ref) => (
  <label
    ref={ref}
    className={cn("text-sm font-medium text-text", className)}
    {...props}
  />
));
Label.displayName = "Label";
