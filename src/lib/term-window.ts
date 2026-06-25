export type TermWindow = "today" | "week" | "lastweek" | "month" | "all";

export const TERM_WINDOW_VALUES = [
  "today",
  "week",
  "lastweek",
  "month",
  "all",
] as const satisfies [TermWindow, ...TermWindow[]];

export const TERM_WINDOWS: { value: TermWindow; label: string }[] = [
  { value: "today", label: "Today" },
  { value: "week", label: "This week" },
  { value: "lastweek", label: "Last week" },
  { value: "month", label: "This month" },
  { value: "all", label: "All time" },
];

// [start, end) in unix seconds for a window; weeks start Monday.
export function termRange(w: TermWindow): { start: number; end: number } {
  if (w === "all") return { start: -Infinity, end: Infinity };
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  if (w === "today") return { start: d.getTime() / 1000, end: Infinity };
  const mondayOffset = (d.getDay() + 6) % 7; // Mon=0 … Sun=6
  const startOfWeek = new Date(d);
  startOfWeek.setDate(d.getDate() - mondayOffset);
  const sow = startOfWeek.getTime() / 1000;
  if (w === "week") return { start: sow, end: Infinity };
  if (w === "lastweek") {
    const prev = new Date(startOfWeek);
    prev.setDate(startOfWeek.getDate() - 7);
    return { start: prev.getTime() / 1000, end: sow };
  }
  // month
  const som = new Date(d.getFullYear(), d.getMonth(), 1).getTime() / 1000;
  return { start: som, end: Infinity };
}
