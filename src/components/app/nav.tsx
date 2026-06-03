"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import {
  FolderKanban,
  LayoutGrid,
  Menu,
  Moon,
  Settings as SettingsIcon,
  Sun,
  X,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { KrillIcon } from "./krill-icon";

const LINKS: ReadonlyArray<{ href: string; label: string; icon: LucideIcon }> = [
  { href: "/", label: "Board", icon: LayoutGrid },
  { href: "/projects", label: "Projects", icon: FolderKanban },
  { href: "/settings", label: "Settings", icon: SettingsIcon },
] as const;

function useTheme() {
  const [theme, setTheme] = useState<"light" | "dark">("light");

  useEffect(() => {
    const stored = (typeof window !== "undefined" &&
      (localStorage.getItem("theme") as "light" | "dark" | null)) ||
      (window.matchMedia?.("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light");
    setTheme(stored);
    document.documentElement.dataset.theme = stored;
  }, []);

  const toggle = () => {
    const next = theme === "dark" ? "light" : "dark";
    setTheme(next);
    document.documentElement.dataset.theme = next;
    localStorage.setItem("theme", next);
  };

  return { theme, toggle };
}

function ThemeToggleButton({
  theme,
  toggle,
  className,
}: {
  theme: "light" | "dark";
  toggle: () => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={toggle}
      aria-label="Toggle theme"
      className={cn(
        "h-9 w-9 inline-flex items-center justify-center rounded text-text-2 hover:text-text",
        className,
      )}
    >
      {theme === "dark" ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
    </button>
  );
}

function Avatar() {
  return (
    <Link
      href="/"
      aria-label="krill home"
      className="mr-4 sm:mr-6 inline-flex h-8 w-8 items-center justify-center rounded-full bg-primary text-white hover:opacity-90"
    >
      <KrillIcon className="h-5 w-5" />
</Link>
  );
}

export function Nav() {
  const pathname = usePathname();
  const { theme, toggle } = useTheme();
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);

  const isActive = (href: string) =>
    href === "/" ? pathname === "/" : pathname.startsWith(href);

  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <header className="relative h-12 border-b border-border flex items-center px-4 sm:px-6 lg:px-8">
      <Avatar />

      <nav className="hidden sm:flex items-center gap-1 flex-1">
        {LINKS.map((l) => {
          const active = isActive(l.href);
          const Icon = l.icon;
          return (
            <Link
              key={l.href}
              href={l.href}
              aria-current={active ? "page" : undefined}
              className={cn(
                "h-9 px-3 inline-flex items-center gap-2 rounded text-sm font-medium transition-colors",
                active
                  ? "text-primary bg-primary/10"
                  : "text-text-2 hover:text-text hover:bg-bg",
              )}
            >
              <Icon className="h-4 w-4 shrink-0" />
              <span>{l.label}</span>
            </Link>
          );
        })}
      </nav>

      <div className="hidden sm:flex items-center">
        <ThemeToggleButton theme={theme} toggle={toggle} />
      </div>

      <div ref={menuRef} className="sm:hidden ml-auto flex items-center">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-label={open ? "Close menu" : "Open menu"}
          aria-expanded={open}
          className="h-9 w-9 inline-flex items-center justify-center rounded text-text-2 hover:text-text"
        >
          {open ? <X className="h-4 w-4" /> : <Menu className="h-4 w-4" />}
        </button>

        {open && (
          <div
            role="menu"
            className="absolute right-4 top-[calc(100%-4px)] mt-1 w-56 rounded-md border border-border bg-surface shadow-lg z-50 p-1.5"
          >
            {LINKS.map((l) => {
              const active = isActive(l.href);
              const Icon = l.icon;
              return (
                <Link
                  key={l.href}
                  href={l.href}
                  role="menuitem"
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "relative flex items-center gap-3 h-10 pl-3 pr-3 rounded text-sm font-medium transition-colors",
                    active
                      ? "text-primary bg-primary/10"
                      : "text-text-2 hover:text-text hover:bg-bg",
                  )}
                >
                  <span
                    aria-hidden
                    className={cn(
                      "absolute left-0 top-1/2 -translate-y-1/2 h-5 w-0.5 rounded-r",
                      active ? "bg-primary" : "bg-transparent",
                    )}
                  />
                  <Icon className="h-4 w-4 shrink-0" />
                  <span className="flex-1">{l.label}</span>
                </Link>
              );
            })}
            <div className="my-1.5 border-t border-border" />
            <button
              type="button"
              onClick={toggle}
              role="menuitem"
              className="w-full flex items-center gap-3 px-3 h-10 rounded text-sm font-medium text-text-2 hover:text-text hover:bg-bg transition-colors"
            >
              {theme === "dark" ? (
                <Sun className="h-4 w-4 shrink-0" />
              ) : (
                <Moon className="h-4 w-4 shrink-0" />
              )}
              <span className="flex-1 text-left">
                {theme === "dark" ? "Light mode" : "Dark mode"}
              </span>
            </button>
          </div>
        )}
      </div>
    </header>
  );
}
