# UI Design Guide

Inspired by Ubuntu OS and Tailscale. Functional, utility-first, content-front. No decoration.


## Principles

1. **Content over chrome.** Borders and whitespace separate sections, not backgrounds or shadows.
2. **No decoration.** No box-shadow. No gradient. No glass / backdrop-blur. No hover lifts.
3. **Instant.** No animations or transitions. State changes happen immediately.
4. **Clarity beats density.** Don't pack the page; don't sprawl it either. Default to comfortable.
5. **Both modes equal.** Light and dark are first-class. No "dark is afterthought."
6. **Icons + labels.** Never icon-only. Every actionable element has a text label.


## Typography

- **Sans:** Ubuntu (Google Fonts).
- **Mono:** Ubuntu Mono (Google Fonts). Used for: code, ids (e.g. `AT-1`), paths, timestamps, raw JSON.
- **Weights allowed:** 400 (regular), 500 (medium), 700 (bold).
  - Body: 400. Labels / nav: 500. Headings + emphasis: 700.
- **Sizes (Tailwind scale):**
  - `text-xs` (12px) — meta, timestamps
  - `text-sm` (14px) — UI default
  - `text-base` (16px) — body / reading
  - `text-lg` (18px) — section headers
  - `text-xl` (20px) — page titles
  - `text-2xl` (24px) — rare, dashboard / hero
- **Line height:** `leading-normal` (1.5) for body; `leading-tight` (1.25) for headings.
- **Letter spacing:** default (no tracking adjustments).


## Color tokens (Tailwind CSS variables)

Use CSS variables so light/dark swap cleanly. Tailwind theme extension maps them.

### Neutrals

| Token       | Light            | Dark             | Use                                 |
|-------------|------------------|------------------|-------------------------------------|
| `--bg`      | `#ffffff`        | `#0a0a0a`        | Page background                     |
| `--surface` | `#ffffff`        | `#161616`        | Card / panel background             |
| `--text`    | `#171717`        | `#fafafa`        | Primary text                        |
| `--text-2`  | `#525252`        | `#a3a3a3`        | Secondary text                      |
| `--text-3`  | `#737373`        | `#737373`        | Tertiary / placeholder              |
| `--border`  | `#e5e5e5`        | `#262626`        | Section dividers, input borders     |
| `--border-strong` | `#d4d4d4`  | `#404040`        | Focus border, table outlines        |

### Accents (semantic — multi-color, no decorative use)

| Token         | Light hex   | Dark hex    | Use                              |
|---------------|-------------|-------------|----------------------------------|
| `--primary`   | `#E95420`   | `#F5733F`   | Primary actions (Ubuntu orange)  |
| `--success`   | `#16a34a`   | `#22c55e`   | Done / success state             |
| `--danger`    | `#dc2626`   | `#ef4444`   | Destructive, errors, cancel      |
| `--info`      | `#2563eb`   | `#3b82f6`   | Info, links, neutral status      |
| `--warning`   | `#d97706`   | `#f59e0b`   | Warnings, in-progress, stuck     |

Foreground on accents: `#ffffff` (light variant) or `#0a0a0a` (dark variant), pick by contrast per accent.


## Borders

- Width: **1px**, always solid.
- Color: `var(--border)` for default; `var(--border-strong)` for focus and tables.
- Radius: **2-4px max.** No full pills. No 8px+ rounding.
  - Inputs / buttons: `rounded` (4px)
  - Cards / panels: `rounded-sm` (2px) or no radius
  - Badges: `rounded` (4px)
- No double borders. No dashed unless conveying meaning (e.g., empty state).


## Spacing scale

Use Tailwind defaults sparingly:

- `gap-2` (8px), `gap-3` (12px), `gap-4` (16px), `gap-6` (24px) for layouts
- `p-2` to `p-6` for padding
- `space-y-2` to `space-y-6` for vertical rhythm
- Page outer padding: `p-4` (mobile) / `p-6` (desktop)
- Section header → content: `mb-3` (12px)


## Buttons

- **Solid filled** by default. No outline-only buttons except for "Cancel" in a dialog.
- Height: `h-9` (36px) default, `h-11` (44px) mobile / primary calls-to-action.
- Padding: `px-4` (16px horizontal).
- Border-radius: `rounded` (4px).
- No shadow. No transform on hover (just background-color shift).
- Hover: darken by ~10% (Tailwind `hover:bg-{accent}-700` from `bg-{accent}-600`).
- Disabled: 50% opacity, no interaction.

Variants:

| Variant      | bg                | text     | Use                          |
|--------------|-------------------|----------|------------------------------|
| `primary`    | `var(--primary)`  | white    | Main CTA per screen          |
| `success`    | `var(--success)`  | white    | Approve, confirm positive    |
| `danger`     | `var(--danger)`   | white    | Destructive (delete, cancel) |
| `neutral`    | `var(--surface)`  | text     | Secondary actions; 1px border|
| `ghost`      | transparent       | text     | Tertiary; hover = `--surface`|


## Inputs / forms

- Border: 1px solid `var(--border)`.
- Background: `var(--surface)`.
- Padding: `px-3 py-2` (12px / 8px).
- Border-radius: `rounded` (4px).
- Focus: border → `var(--border-strong)`; outline ring 1px `var(--primary)`, offset 0.
- No floating labels. Labels sit above inputs, `text-sm font-medium`.
- Helper text below: `text-xs text-[var(--text-2)]`.
- Error: border → `var(--danger)`; helper text `text-[var(--danger)]`.


## Icons

- Library: `lucide-react` (already in deps).
- Sizes: 16px (inline with `text-sm`) or 20px (with `text-base`).
- Stroke width: 2 (default).
- Always paired with a text label or in a tooltip — never icon-only without context.
- Color: inherit from text. Status icons use accent token.


## Status indicators (badges, chips)

- Filled solid by status color, `text-xs font-medium`.
- Padding: `px-2 py-0.5`, `rounded` (4px).
- No borders. No glow.

Examples for task status:

| Task status     | Token        |
|-----------------|--------------|
| BACKLOG / TODO  | neutral (text + border) |
| PLANNING / IMPLEMENTING / PUBLISHING | `--info` |
| AI-REVIEW / NEEDS_REVIEW (plan / deliverable / conflict) | `--warning` |
| DONE            | `--success` |
| CANCELED        | `--danger`  |

Priority badges (P0-P3):

| Priority | Token       | Use                  |
|----------|-------------|----------------------|
| P0       | `--danger`  | Critical / blocker   |
| P1       | `--warning` | High                 |
| P2       | neutral     | Medium (default)     |
| P3       | `--text-2`  | Low / nice-to-have   |


## Layout

- **Full-width fluid.** No fixed max-width container.
- Edge padding scales with viewport: `px-4 sm:px-6 lg:px-8`.
- Top bar: 1px bottom border, `h-12` (48px), holds app name + nav.
- Sidebars optional and resizable; default off on mobile.
- Page sections separated by 1px borders, not background tints.


## Tables

- Border: 1px outer, 1px between rows (`border-y`).
- Row padding: `py-2 px-3`.
- Header row: `font-medium`, `bg-[var(--surface)]`, `text-sm`.
- Hover row: `bg-[var(--surface)]` (light) / brightness shift only — no row border thickening.
- Sticky header on long lists.
- Column alignment: text-left default; numeric / timestamps right-aligned.


## Tabs

- Underline indicator on active tab (2px line, `var(--primary)`).
- No pill background.
- Inactive: `text-[var(--text-2)]`. Active: `text-[var(--text)]`.
- Container has a single 1px bottom border across the strip.


## Dialogs / modals

- Background: `var(--surface)`.
- 1px border. No shadow. No backdrop blur.
- Backdrop: `bg-black/40` (light) / `bg-black/60` (dark) — flat dim, no blur.
- Close instantly. No fade.


## Toasts

- Bottom-right (desktop), bottom-full-width (mobile).
- Solid background by status color. White text.
- Padding `px-4 py-3`, `rounded` (4px).
- Auto-dismiss 4s. No slide animation — appears and disappears.


## Empty states

- Single centered block: icon (24px), one heading line, one paragraph, one primary action.
- Dashed 1px border around the block to signal "nothing here yet."


## What we DO NOT use

- Box shadow (any kind)
- Gradients
- Glass / backdrop-blur
- Hover lifts / translate / scale
- Rounded-full pills
- Smooth transitions / animations
- Skeleton shimmer loaders (use a plain "Loading…" or static placeholder rows)
- Multiple font families beyond Ubuntu + Ubuntu Mono
- Decorative illustrations
- Color-coded backgrounds (color stays on text, borders, badges)


## Implementation notes

- Define color tokens as CSS variables in `globals.css`, swap on `[data-theme="dark"]`.
- Extend Tailwind `theme.colors` to reference `var(--*)` so `bg-primary` / `text-danger` work.
- Use the `cn()` helper for class composition.
- Each Radix primitive gets a thin wrapper in `src/components/ui/` applying the styles above. No upstream defaults leak.
