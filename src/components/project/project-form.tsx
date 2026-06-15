"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import type { Project } from "@/db/schema";
import { api } from "@/lib/client/api";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/components/ui/toast";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { DialogBody, DialogFooter } from "@/components/ui/dialog";

type Mode =
  | { kind: "create" }
  | { kind: "edit"; project: Project };

export function ProjectForm(props: Mode) {
  const router = useRouter();
  const toast = useToast();
  const existing = props.kind === "edit" ? props.project : null;

  const [name, setName] = useState(existing?.name ?? "");
  const [slug, setSlug] = useState(existing?.slug ?? "");
  // Auto-fill slug from name until the user types one by hand (create only).
  const [slugTouched, setSlugTouched] = useState(props.kind === "edit");
  const [folder, setFolder] = useState(existing?.folder_path ?? "");
  const [hasRepoOverride, setHasRepoOverride] = useState<boolean | undefined>(
    existing?.has_repo,
  );
  const [defaultBranch, setDefaultBranch] = useState(
    existing?.default_branch ?? "main",
  );
  const [maxParallel, setMaxParallel] = useState(
    existing?.max_parallel_tasks ?? 1,
  );
  const [paused, setPaused] = useState(existing?.paused ?? false);
  const [busy, setBusy] = useState(false);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      if (props.kind === "create") {
        const body: Record<string, unknown> = {
          name,
          slug,
          folder_path: folder,
          default_branch: defaultBranch,
          max_parallel_tasks: maxParallel,
          paused,
        };
        if (hasRepoOverride !== undefined) body.has_repo = hasRepoOverride;
        const p = await api.createProject(body);
        toast.push({
          variant: "success",
          title: `Created ${p.slug}`,
          description: p.has_repo ? "repo detected" : "no repo",
        });
        router.back();
        router.refresh();
      } else {
        const body: Record<string, unknown> = {
          name,
          folder_path: folder,
          default_branch: defaultBranch,
          max_parallel_tasks: maxParallel,
          paused,
        };
        if (hasRepoOverride !== undefined) body.has_repo = hasRepoOverride;
        await api.patchProject(props.project.id, body);
        toast.push({ variant: "success", title: "Project updated" });
        // push lands on /projects; refresh re-resolves the @modal slot against
        // the new URL (→ default.tsx) so the intercepted modal actually closes,
        // and refetches the now-stale server list.
        router.push("/projects");
        router.refresh();
      }
    } catch (err) {
      toast.push({
        variant: "danger",
        title: "Save failed",
        description: (err as Error).message,
      });
    } finally {
      setBusy(false);
    }
  };

  const onDelete = async () => {
    if (props.kind !== "edit") return;
    setBusy(true);
    try {
      await api.deleteProject(props.project.id);
      toast.push({ variant: "warning", title: "Project deleted" });
      // Same as edit: push for a deterministic destination, refresh to dismiss
      // the intercepted modal (slot → default.tsx) and drop the deleted row.
      router.push("/projects");
      router.refresh();
    } catch (err) {
      toast.push({
        variant: "danger",
        title: "Delete failed",
        description: (err as Error).message,
      });
      setBusy(false);
      throw err;
    }
  };

  return (
    <form onSubmit={onSubmit} className="flex flex-col flex-1 min-h-0 max-w-4xl">
      <DialogBody className="space-y-5">
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Field label="Name" required>
          <Input
            value={name}
            onChange={(e) => {
              const v = e.target.value;
              setName(v);
              if (!slugTouched) setSlug(suggestSlug(v));
            }}
            required
          />
        </Field>

        <Field
          label="Slug"
          required
          helper="2 chars, UPPERCASE, unique. Used in task ids (e.g., AT-1)."
        >
          <Input
            value={slug}
            onChange={(e) => {
              setSlugTouched(true);
              setSlug(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 2));
            }}
            required
            disabled={props.kind === "edit"}
            className="font-mono"
            maxLength={2}
          />
        </Field>

        <Field
          label="Default branch"
          helper="Used only when the folder is a git repo."
        >
          <Input
            value={defaultBranch}
            onChange={(e) => setDefaultBranch(e.target.value)}
            className="font-mono"
          />
        </Field>
      </div>

      <Field
        label="Folder path"
        required
        helper="Absolute path on this machine. Deliverables land here."
      >
        <Input
          value={folder}
          onChange={(e) => setFolder(e.target.value)}
          required
          className="font-mono"
        />
      </Field>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 lg:gap-8 border-t border-border pt-4">
        <Field
          label="Max parallel tasks"
          helper="1-5. Active states cap per project."
        >
          <Input
            type="number"
            min={1}
            max={5}
            value={maxParallel}
            onChange={(e) => setMaxParallel(Number(e.target.value))}
          />
        </Field>

        <div className="space-y-3">
          <div className="flex items-center justify-between gap-3">
            <div>
              <Label>Paused</Label>
              <p className="text-xs text-text-2">
                When paused, no tasks from this project are picked.
              </p>
            </div>
            <Switch checked={paused} onCheckedChange={setPaused} />
          </div>

          <div className="flex items-center justify-between gap-3">
            <div>
              <Label>has_repo override</Label>
              <p className="text-xs text-text-2">
                Leave unchanged to auto-detect `.git` at the folder path.
              </p>
            </div>
            <Switch
              checked={hasRepoOverride ?? existing?.has_repo ?? false}
              onCheckedChange={(v) => setHasRepoOverride(v)}
            />
          </div>
        </div>
      </div>

      {props.kind === "edit" ? (
        <div className="border-t border-border pt-4 space-y-3">
          <div>
            <Label>Publishing policy</Label>
            <p className="text-xs text-text-2">
              Read-only here. <code>null</code> = auto-detected from the repo&apos;s
              remote. Editing these (and the autonomy toggle below) is a behavior
              change, gated to a follow-up — see session 06.
            </p>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <PolicyRow label="Create PR" value={existing?.create_pr} />
            <PolicyRow label="Push remote" value={existing?.push_remote} />
            <PolicyRow label="Merge to main" value={existing?.merge_to_main} />
          </div>
          <div className="flex items-center justify-between gap-3 rounded-sm border border-warning/40 bg-warning/5 px-3 py-2">
            <div>
              <Label>
                Allow auto-finish
                <span className="text-warning ml-1 text-xs">⚠ dangerous</span>
              </Label>
              <p className="text-xs text-text-2">
                When on, tasks armed with <code>auto_publish</code> skip the
                deliverable review and merge to DONE unattended. Double-gated by the
                task flag; AI review stays on.
              </p>
            </div>
            <span className="font-mono text-xs shrink-0">
              {existing?.allow_auto_finish ? "ON" : "off"}
            </span>
          </div>
        </div>
      ) : null}

      </DialogBody>
      <DialogFooter className="justify-between">
        <div className="flex items-center gap-2">
          {props.kind === "edit" ? (
            <ConfirmDialog
              title="Delete project?"
              description={`Permanently delete project ${props.project.slug}. All its tasks and comments will cascade. This action cannot be undone.`}
              confirmLabel="Delete"
              busyLabel="Deleting…"
              confirmVariant="danger"
              trigger={
                <Button type="button" variant="danger" disabled={busy}>
                  Delete
                </Button>
              }
              onConfirm={onDelete}
            />
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="neutral"
            disabled={busy}
            onClick={() => router.back()}
          >
            Cancel
          </Button>
          <Button type="submit" disabled={busy}>
            {props.kind === "create" ? "Create" : "Save"}
          </Button>
        </div>
      </DialogFooter>
    </form>
  );
}

// Suggest a 2-char slug from the name: initials of each word (camelCase counts),
// else the first two letters. e.g. "ArqTrack"→AT, "Meu Veleiro"→MV, "krill"→KR.
function suggestSlug(name: string): string {
  const words = name
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean);
  const initials = words.map((w) => w[0]).join("");
  const base = initials.length >= 2 ? initials : words.join("");
  let s = base.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (s && !/^[A-Z]/.test(s)) s = "X" + s.slice(1); // slug must start with a letter
  return s.slice(0, 2);
}

function PolicyRow({
  label,
  value,
}: {
  label: string;
  value: boolean | null | undefined;
}) {
  const text = value == null ? "auto" : value ? "on" : "off";
  const tone =
    value == null ? "text-text-2" : value ? "text-success" : "text-text-3";
  return (
    <div className="flex items-center justify-between gap-2 rounded-sm border border-border bg-surface-2 px-2.5 py-1.5">
      <span className="text-xs text-text-2">{label}</span>
      <span className={`font-mono text-xs ${tone}`}>{text}</span>
    </div>
  );
}

function Field({
  label,
  helper,
  required,
  children,
}: {
  label: string;
  helper?: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <Label>
        {label}
        {required ? (
          <span className="text-danger ml-0.5" aria-hidden>
            *
          </span>
        ) : null}
      </Label>
      {children}
      {helper ? <p className="text-xs text-text-2">{helper}</p> : null}
    </div>
  );
}

