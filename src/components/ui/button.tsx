"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

type Variant =
  | "primary"
  | "success"
  | "danger"
  | "danger-outline"
  | "neutral"
  | "ghost";
type Size = "default" | "mobile";

const VARIANT: Record<Variant, string> = {
  primary: "bg-primary text-white hover:opacity-90",
  success: "bg-success text-white hover:opacity-90",
  danger: "bg-danger text-white hover:opacity-90",
  "danger-outline":
    "border border-danger/30 bg-danger/5 text-danger hover:bg-danger/10",
  neutral:
    "bg-surface text-text border border-border hover:bg-border",
  ghost: "bg-transparent text-text hover:bg-surface",
};

const SIZE: Record<Size, string> = {
  default: "h-9 px-4 text-sm",
  mobile: "h-11 px-4 text-sm",
};

export type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: Variant;
  size?: Size;
};

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant = "primary", size = "default", ...props }, ref) => (
    <button
      ref={ref}
      className={cn(
        "inline-flex items-center justify-center rounded font-medium select-none",
        "disabled:opacity-50 disabled:cursor-not-allowed",
        "focus:outline-none focus-visible:ring-1 focus-visible:ring-primary",
        VARIANT[variant],
        SIZE[size],
        className,
      )}
      {...props}
    />
  ),
);
Button.displayName = "Button";
