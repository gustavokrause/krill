"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import type { Project, Task } from "@/db/schema";
import { api } from "@/lib/client/api";
import { Button } from "@/components/ui/button";
import { Input, Label, Textarea } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/components/ui/toast";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { DialogBody, DialogFooter } from "@/components/ui/dialog";

type Mode =
  | { kind: "create"; projects: Project[]; defaultProjectId?: string }
  | { kind: "edit"; task: Task; projects: Project[] };

export function TaskForm(props: Mode) {
  const router = useRouter();
  const toast = useToast();
  const existing = props.kind === "edit" ? props.task : null;

  const defaultProjectId =
    props.kind === "create" ? props.defaultProjectId : undefined;
  const validDefault =
    defaultProjectId && props.projects.some((p) => p.id === defaultProjectId)
      ? defaultProjectId
      : undefined;

  const [projectId, setProjectId] = useState<string | undefined>(
    existing?.project_id ?? validDefault,
  );
  const [name, setName] = useState(existing?.name ?? "");
  const [description, setDescription] = useState(existing?.description ?? "");
  const [mode, setMode] = useState<"dev" | "non-dev">(
    existing?.mode ?? "dev",
  );
  const [priority, setPriority] = useState<"P0" | "P1" | "P2" | "P3">(
    existing?.priority ?? "P2",
  );
  const [dependsOn, setDependsOn] = useState(
    existing ? existing.depends_on.join(", ") : "",
  );
  const [conflictsWith, setConflictsWith] = useState(
    existing ? existing.conflicts_with.join(", ") : "",
  );
  const [affectedPaths, setAffectedPaths] = useState(
    existing ? existing.affected_paths.join("\n") : "",
  );
  const [skipPlan, setSkipPlan] = useState(existing?.skip_plan ?? false);
  const [skipPlanReview, setSkipPlanReview] = useState(
    existing?.skip_plan_review ?? false,
  );
  const [skipAiReview, setSkipAiReview] = useState(
    existing?.skip_ai_review ?? false,
  );
  const [busy, setBusy] = useState(false);

  const parseCsv = (s: string) =>
    s.split(",").map((t) => t.trim()).filter(Boolean);
  const parseLines = (s: string) =>
    s.split("\n").map((t) => t.trim()).filter(Boolean);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      if (props.kind === "create") {
        const task = await api.createTask({
          project_id: projectId,
          name,
          description,
          mode,
          priority,
          depends_on: parseCsv(dependsOn),
          conflicts_with: parseCsv(conflictsWith),
          affected_paths: parseLines(affectedPaths),
          skip_plan: skipPlan,
          skip_plan_review: skipPlanReview,
          skip_ai_review: skipAiReview,
        });
        toast.push({ variant: "success", title: `Created ${task.id}` });
        router.back();
        router.refresh();
      } else {
        await api.patchTask(props.task.id, {
          name,
          description,
          priority,
          depends_on: parseCsv(dependsOn),
          conflicts_with: parseCsv(conflictsWith),
          affected_paths: parseLines(affectedPaths),
          skip_plan: skipPlan,
          skip_plan_review: skipPlanReview,
          skip_ai_review: skipAiReview,
        });
        toast.push({ variant: "success", title: "Task updated" });
        router.push(`/tasks/${props.task.id}`);
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
      await api.deleteTask(props.task.id);
      toast.push({ variant: "warning", title: `Deleted ${props.task.id}` });
      router.push("/");
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
    <form onSubmit={onSubmit} className="flex flex-col flex-1 min-h-0 max-w-5xl">
      <DialogBody className="space-y-5">
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Field label="Project" required>
          <Select
            value={projectId}
            onValueChange={setProjectId}
            disabled={props.kind === "edit"}
          >
            <SelectTrigger>
              <SelectValue placeholder="Choose project…" />
            </SelectTrigger>
            <SelectContent>
              {props.projects.map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  <span className="font-mono mr-2">{p.slug}</span>
                  {p.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <Field label="Mode" helper="dev requires the project to be a git repo.">
          <Select
            value={mode}
            onValueChange={(v) => setMode(v as "dev" | "non-dev")}
            disabled={props.kind === "edit"}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="dev">dev</SelectItem>
              <SelectItem value="non-dev">non-dev</SelectItem>
            </SelectContent>
          </Select>
        </Field>
        <Field label="Priority">
          <Select
            value={priority}
            onValueChange={(v) =>
              setPriority(v as "P0" | "P1" | "P2" | "P3")
            }
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="P0">P0 — critical</SelectItem>
              <SelectItem value="P1">P1 — high</SelectItem>
              <SelectItem value="P2">P2 — medium</SelectItem>
              <SelectItem value="P3">P3 — low</SelectItem>
            </SelectContent>
          </Select>
        </Field>
      </div>

      <div className="space-y-5">
        <Field label="Name" required>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
          />
        </Field>

        <Field label="Description">
          <Textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={4}
          />
        </Field>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 lg:gap-8 border-t border-border pt-4">
        <div className="space-y-5">
          <Field
            label="Depends on"
            helper="Comma-separated task ids in the same project (e.g. AT-1, AT-2). Task waits in TODO until all are DONE."
          >
            <Input
              value={dependsOn}
              onChange={(e) => setDependsOn(e.target.value)}
              className="font-mono"
              placeholder="AT-1, AT-2"
            />
          </Field>

          <Field
            label="Conflicts with"
            helper="Comma-separated task ids that must not run in parallel."
          >
            <Input
              value={conflictsWith}
              onChange={(e) => setConflictsWith(e.target.value)}
              className="font-mono"
              placeholder="AT-3"
            />
          </Field>

          <Field
            label="Affected paths"
            helper="One path per line, relative to project folder. Usually set by PLANNING — leave blank to let Claude infer."
          >
            <Textarea
              value={affectedPaths}
              onChange={(e) => setAffectedPaths(e.target.value)}
              rows={3}
              className="font-mono"
              placeholder={"src/foo.ts\nsrc/bar.ts"}
            />
          </Field>
        </div>

        <div className="space-y-3">
          <SkipRow
            label="Skip plan writing"
            helper="TODO picker routes the task straight to IMPLEMENTING — no PLANNING tick, no plan/checklist, no plan review."
            checked={skipPlan}
            onChange={setSkipPlan}
          />
          <SkipRow
            label="Skip plan review"
            helper={
              skipPlan
                ? "No effect when Skip plan writing is on — no plan to review."
                : "NEEDS_REVIEW(plan) gate is auto-approved."
            }
            checked={skipPlanReview}
            onChange={setSkipPlanReview}
            disabled={skipPlan}
          />
          <SkipRow
            label="Skip AI review"
            helper="AI-REVIEW gate is bypassed; IMPLEMENTING jumps to PUBLISHING."
            checked={skipAiReview}
            onChange={setSkipAiReview}
          />
        </div>
      </div>

      </DialogBody>
      <DialogFooter className="justify-between">
        <div className="flex items-center gap-2">
          {props.kind === "edit" ? (
            <ConfirmDialog
              title="Delete task?"
              description={`This will permanently delete ${props.task.id} and all its comments. This action cannot be undone.`}
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
          <Button type="submit" disabled={busy || !projectId || !name}>
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

function SkipRow({
  label,
  helper,
  checked,
  onChange,
  disabled = false,
}: {
  label: string;
  helper: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <div
      className={`flex items-center justify-between gap-3 ${disabled ? "opacity-50" : ""}`}
    >
      <div>
        <Label>{label}</Label>
        <p className="text-xs text-text-2">{helper}</p>
      </div>
      <Switch
        checked={checked}
        onCheckedChange={onChange}
        disabled={disabled}
      />
    </div>
  );
}
