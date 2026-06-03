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
        router.push("/projects");
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
      router.push("/projects");
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
          <Input value={name} onChange={(e) => setName(e.target.value)} required />
        </Field>

        <Field
          label="Slug"
          required
          helper="UPPERCASE, unique. Used in task ids (e.g., AT-1)."
        >
          <Input
            value={slug}
            onChange={(e) => setSlug(e.target.value.toUpperCase())}
            required
            disabled={props.kind === "edit"}
            className="font-mono"
            maxLength={16}
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

