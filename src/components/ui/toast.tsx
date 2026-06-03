"use client";

import * as React from "react";
import * as RadixToast from "@radix-ui/react-toast";
import { cn } from "@/lib/utils";

type Variant = "info" | "success" | "danger" | "warning";

type ToastItem = {
  id: number;
  title: string;
  description?: string;
  variant: Variant;
};

type Ctx = {
  push: (t: Omit<ToastItem, "id">) => void;
};

const ToastCtx = React.createContext<Ctx | null>(null);

let nextId = 1;

const VARIANT_CLASS: Record<Variant, string> = {
  info: "bg-info text-white",
  success: "bg-success text-white",
  danger: "bg-danger text-white",
  warning: "bg-warning text-white",
};

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [items, setItems] = React.useState<ToastItem[]>([]);

  const push = React.useCallback((t: Omit<ToastItem, "id">) => {
    setItems((prev) => [...prev, { ...t, id: nextId++ }]);
  }, []);

  return (
    <ToastCtx.Provider value={{ push }}>
      <RadixToast.Provider swipeDirection="right" duration={4000}>
        {children}
        {items.map((t) => (
          <RadixToast.Root
            key={t.id}
            className={cn(
              "px-4 py-3 rounded text-sm font-medium",
              VARIANT_CLASS[t.variant],
            )}
            onOpenChange={(open) => {
              if (!open) {
                setItems((prev) => prev.filter((x) => x.id !== t.id));
              }
            }}
          >
            <RadixToast.Title className="font-medium">
              {t.title}
            </RadixToast.Title>
            {t.description ? (
              <RadixToast.Description className="text-xs opacity-90 mt-0.5">
                {t.description}
              </RadixToast.Description>
            ) : null}
          </RadixToast.Root>
        ))}
        <RadixToast.Viewport className="fixed bottom-4 right-4 sm:bottom-4 sm:right-4 flex flex-col gap-2 w-[calc(100vw-2rem)] sm:w-96 z-50 outline-none" />
      </RadixToast.Provider>
    </ToastCtx.Provider>
  );
}

export function useToast() {
  const ctx = React.useContext(ToastCtx);
  if (!ctx) throw new Error("useToast must be inside <ToastProvider>");
  return ctx;
}
