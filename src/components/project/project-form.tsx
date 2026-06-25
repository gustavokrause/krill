"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import type { Project } from "@/db/schema";
import { api } from "@/lib/client/api";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Tooltip } from "@/components/ui/tooltip";
import { Info } from "lucide-react";
import { useToast } from "@/components/ui/toast";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { DialogBody, DialogFooter } from "@/components/ui/dialog";

type Mode =
  | { kind: "create"; presentation: "modal" | "page" }
  | { kind: "edit"; project: Project; presentation: "modal" | "page" };

export function ProjectForm(props: Mode) {
  const router = useRouter();
  const toast = useToast();
  const existing = props.kind === "edit" ? props.project : null;

  const [name, setName] = useState(existing?.name ?? "");
  const [slug, setSlug] = useState(existing?.slug ?? "");
  // Auto-fill slug from name until the user types one by hand (create only).
  const [slugTouched, setSlugTouched] = useState(props.kind === "edit");
  const [folder, setFolder] = useState(existing?.folder_path ?? "");
  // Empty on create → the server reads the branch from the repo (else "main").
  const [defaultBranch, setDefaultBranch] = useState(
    existing?.default_branch ?? "",
  );
  const [maxParallel, setMaxParallel] = useState(
    existing?.max_parallel_tasks ?? 1,
  );
  const [paused, setPaused] = useState(existing?.paused ?? false);
  // Publish policy (null = auto-detect from the repo remote; true/false override).
  const [createPr, setCreatePr] = useState<boolean | null>(
    existing?.create_pr ?? null,
  );
  const [pushRemote, setPushRemote] = useState<boolean | null>(
    existing?.push_remote ?? null,
  );
  const [mergeToMain, setMergeToMain] = useState<boolean | null>(
    existing?.merge_to_main ?? null,
  );
  const [allowAutoFinish, setAllowAutoFinish] = useState(
    existing?.allow_auto_finish ?? false,
  );
  const [deleteBranchOnDone, setDeleteBranchOnDone] = useState(
    existing?.delete_branch_on_done ?? true,
  );
  const [draftPr, setDraftPr] = useState(existing?.draft_pr ?? false);
  const [prDescriptionSource, setPrDescriptionSource] = useState<"plan" | "summary">(
    (existing?.pr_description_source as "plan" | "summary") ?? "plan",
  );
  const [showLegend, setShowLegend] = useState(false);
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
          max_parallel_tasks: maxParallel,
          paused,
        };
        // Omit when blank so the server auto-detects the repo's default branch.
        if (defaultBranch.trim()) body.default_branch = defaultBranch.trim();
        const p = await api.createProject(body);
        toast.push({
          variant: "success",
          title: `Created ${p.slug}`,
          description: p.has_repo ? "repo detected" : "no repo",
        });
        if (props.presentation === "modal") {
          router.back();
        } else {
          router.push("/projects");
        }
        router.refresh();
      } else {
        const body: Record<string, unknown> = {
          name,
          folder_path: folder,
          default_branch: defaultBranch,
          max_parallel_tasks: maxParallel,
          paused,
          create_pr: createPr,
          push_remote: pushRemote,
          merge_to_main: mergeToMain,
          allow_auto_finish: allowAutoFinish,
          delete_branch_on_done: deleteBranchOnDone,
          draft_pr: draftPr,
          pr_description_source: prDescriptionSource,
        };
        await api.patchProject(props.project.id, body);
        toast.push({ variant: "success", title: "Project updated" });
        if (props.presentation === "modal") {
          router.back();
        } else {
          router.push("/projects");
        }
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

  // Effective repo state + which policy dials are inert given the others.
  const isRepo = existing?.has_repo ?? false;
  const pushOff = pushRemote === false;
  const prOff = createPr === false;
  const mergeOff = mergeToMain === false;
  const draftEffective = draftPr && !prOff && !pushOff;
  // create_pr only read in the push flow; auto-finish/branch-delete need a merge.
  const createPrInert = pushOff;
  const autoFinishInert = mergeOff || draftEffective;
  const deleteBranchInert = mergeOff;

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

        {props.kind === "edit" && !isRepo ? null : (
          <Field
            label="Default branch"
            helper="Leave blank to read it from the repo (else main)."
          >
            <Input
              value={defaultBranch}
              onChange={(e) => setDefaultBranch(e.target.value)}
              className="font-mono"
              placeholder="auto-detect"
            />
          </Field>
        )}
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
          <p className="text-xs text-text-3">
            Git repo is auto-detected from <code>.git</code> at the folder path
            {isRepo ? " — this project is a repo." : "."}
          </p>
        </div>
      </div>

      {props.kind === "edit" ? (
        <div className="border-t border-border pt-4 space-y-3">
          <div>
            <Label>Publishing policy</Label>
            <p className="text-xs text-text-2">
              <code>auto</code> = detected from the repo&apos;s remote (remote → PR
              flow; none → local merge). Set <code>on</code>/<code>off</code> to
              override. <strong>Create PR off</strong> (with Push remote on) pushes
              the branch but opens no PR — the task stops at review with the branch
              ref to open a PR or merge by hand.
            </p>
          </div>
          {!isRepo ? (
          <>
            <p className="text-xs text-text-3">
              No git repo — the PR / push / merge dials apply to repos only. The
              deliverable is copied into the project folder.
            </p>
            <div className="flex items-center justify-between gap-3 rounded-sm border border-warning/40 bg-warning/5 px-3 py-2">
              <div>
                <Label>
                  Allow auto-finish
                  <span className="text-warning ml-1 text-xs">⚠ dangerous</span>
                </Label>
                <p className="text-xs text-text-2">
                  When on, tasks armed with <code>auto_publish</code> skip the
                  deliverable review and go straight to DONE once the file is
                  copied to the folder — no human gate. Double-gated by the task
                  flag; AI review stays on. (No merge here, so the repo dials
                  don&apos;t apply.)
                </p>
              </div>
              <Switch
                checked={allowAutoFinish}
                onCheckedChange={setAllowAutoFinish}
              />
            </div>
          </>
          ) : (
          <>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <PolicyRow
              label="Create PR"
              value={createPr}
              onChange={setCreatePr}
              disabled={createPrInert}
              hint="auto: open a PR only if the repo has a remote. on: always try (fails on a remote-less repo). off: no PR — push the branch only. Inert when Push remote is off (local flow has no PR)."
            />
            <PolicyRow
              label="Push remote"
              value={pushRemote}
              onChange={setPushRemote}
              hint="auto: push only if the repo has a remote. on: always push (fails with no origin). off: keep everything local."
            />
            <PolicyRow
              label="Merge to main"
              value={mergeToMain}
              onChange={setMergeToMain}
              hideOn
              hint="auto: merge into main on finish. off: never merge — leave the PR/branch for you to merge by hand. (on would behave identically to auto, so it's hidden.)"
            />
          </div>
          <div
            className={`flex items-center justify-between gap-3 rounded-sm border border-warning/40 bg-warning/5 px-3 py-2 ${autoFinishInert ? "opacity-50" : ""}`}
          >
            <div>
              <Label>
                Allow auto-finish
                <span className="text-warning ml-1 text-xs">⚠ dangerous</span>
              </Label>
              <p className="text-xs text-text-2">
                {autoFinishInert
                  ? draftEffective
                    ? "No effect — draft PRs are never auto-merged."
                    : "No effect — Merge to main is off, so nothing auto-finishes."
                  : "When on, tasks armed with auto_publish skip the deliverable review and merge to DONE unattended. Double-gated by the task flag; AI review stays on."}
              </p>
            </div>
            <Switch
              checked={allowAutoFinish && !autoFinishInert}
              onCheckedChange={setAllowAutoFinish}
              disabled={autoFinishInert}
            />
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 lg:gap-8">
            <div
              className={`flex items-center justify-between gap-3 ${deleteBranchInert ? "opacity-50" : ""}`}
            >
              <div>
                <Label>Delete branch on done</Label>
                <p className="text-xs text-text-2">
                  {deleteBranchInert
                    ? "No effect — Merge to main is off, so the branch is never merged and is always kept."
                    : "Remove the task branch (local + remote) when it reaches DONE — only when the work was actually merged. Off keeps every branch."}
                </p>
              </div>
              <Switch
                checked={deleteBranchOnDone && !deleteBranchInert}
                onCheckedChange={setDeleteBranchOnDone}
                disabled={deleteBranchInert}
              />
            </div>

            <div className="flex items-center justify-between gap-3">
              <div>
                <Label>Draft PRs</Label>
                <p className="text-xs text-text-2">
                  {createPr === false || pushRemote === false
                    ? "No effect — needs Create PR and Push remote on (PR flow)."
                    : "Open pull requests as drafts. Not auto-merged; Approve marks ready + squash-merges."}
                </p>
              </div>
              <Switch
                checked={draftPr && createPr !== false && pushRemote !== false}
                onCheckedChange={setDraftPr}
                disabled={createPr === false || pushRemote === false}
              />
            </div>
          </div>

          {createPr !== false ? (
            <Field
              label="PR description source"
              helper="Source for the PR body when one is opened. plan = the task plan as-is; summary = the LLM-written plan summary."
            >
              <Select
                value={prDescriptionSource}
                onValueChange={(v) => setPrDescriptionSource(v as "plan" | "summary")}
              >
                <SelectTrigger className="h-8 w-36 font-mono text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="plan">plan</SelectItem>
                  <SelectItem value="summary">summary</SelectItem>
                </SelectContent>
              </Select>
            </Field>
          ) : null}

          <div className="rounded-sm border border-info/40 bg-info/5 px-3 py-2 space-y-2">
            <div className="flex items-start justify-between gap-3">
              <p className="text-xs text-text leading-relaxed">
                <span className="font-semibold text-info">On finish: </span>
                {describeOutcome(createPr, pushRemote, mergeToMain, allowAutoFinish)}
              </p>
              <button
                type="button"
                onClick={() => setShowLegend((v) => !v)}
                className="shrink-0 text-xs font-medium text-info hover:underline underline-offset-2"
              >
                {showLegend ? "Hide legend" : "Show legend"}
              </button>
            </div>
            {showLegend ? <PolicyLegend /> : null}
          </div>
          </>
          )}
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
            onClick={() => {
              if (props.presentation === "modal") {
                router.back();
              } else {
                router.push("/projects");
              }
            }}
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

// Live, plain-language outcome for the current dial values. Mirrors the runtime
// policy: push_remote is the master switch; create_pr only matters when push is
// on; merge_to_main gates every merge; allow_auto_finish needs a task armed with
// auto_publish. null = auto (resolved from the repo's remote at run time).
function describeOutcome(
  createPr: boolean | null,
  pushRemote: boolean | null,
  mergeToMain: boolean | null,
  allowAutoFinish: boolean,
): string {
  const armed = allowAutoFinish
    ? " Tasks armed with auto_publish do this unattended to DONE; others wait for Approve."
    : " Approve to merge.";

  if (pushRemote === false) {
    if (mergeToMain === false)
      return "Local, no PR. Nothing is merged — work stays on the branch; Approve marks DONE without merging.";
    return (
      "Local, no PR — merge into local main only (origin is not pushed)." +
      (allowAutoFinish
        ? " Armed tasks auto-finish on remote-less repos; on repos that have a remote, auto-finish is held for review so origin isn't left behind."
        : " Approve to merge.")
    );
  }

  if (pushRemote === null)
    return "Push is auto — PR flow if the repo has a remote, else a local merge. Pin Push on/off to fix the behavior.";

  // push_remote on
  if (createPr === false) {
    if (mergeToMain === false)
      return "Direct mode: branch pushed to origin, no PR. Nothing merged — task stops at review.";
    return (
      "Direct to main: branch pushed, no PR, then merged into main and pushed to origin." +
      armed
    );
  }

  // PR flow (create_pr on or auto)
  if (mergeToMain === false)
    return "Pull request opened and pushed, but never auto-merged — merge it yourself on GitHub.";
  return "Pull request opened, then squash-merged to main." + armed;
}

const LEGEND_ROWS: [string, string, string, string, string][] = [
  ["on", "on", "on", "on", "open PR → auto squash-merge → DONE"],
  ["on", "on", "on", "off", "open PR → Approve → squash-merge"],
  ["on", "on", "off", "any", "PR opened + pushed, never merged — merge on GitHub"],
  ["on", "off", "on", "on", "branch pushed → merge main + push origin → DONE"],
  ["on", "off", "on", "off", "branch pushed → Approve → merge + push"],
  ["on", "off", "off", "any", "branch pushed, never merged — stops"],
  ["off", "—", "on", "on", "local merge, no push → DONE (remote-less) / human-gated (has remote)"],
  ["off", "—", "off", "any", "nothing merged — stops"],
];

function PolicyLegend() {
  return (
    <div className="overflow-x-auto rounded-sm border border-border">
      <table className="w-full text-[11px]">
        <thead>
          <tr className="bg-surface-2 text-text-2">
            <th className="px-2 py-1 text-left font-medium">Push</th>
            <th className="px-2 py-1 text-left font-medium">PR</th>
            <th className="px-2 py-1 text-left font-medium">Merge</th>
            <th className="px-2 py-1 text-left font-medium">Auto</th>
            <th className="px-2 py-1 text-left font-medium">Result</th>
          </tr>
        </thead>
        <tbody>
          {LEGEND_ROWS.map((r, i) => (
            <tr key={i} className="border-t border-border">
              <td className="px-2 py-1 font-mono text-text-2">{r[0]}</td>
              <td className="px-2 py-1 font-mono text-text-2">{r[1]}</td>
              <td className="px-2 py-1 font-mono text-text-2">{r[2]}</td>
              <td className="px-2 py-1 font-mono text-text-2">{r[3]}</td>
              <td className="px-2 py-1 text-text">{r[4]}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
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
  onChange,
  hint,
  hideOn = false,
  disabled = false,
}: {
  label: string;
  value: boolean | null;
  onChange: (v: boolean | null) => void;
  hint?: string;
  // Hide the "on" option where it's behaviorally identical to "auto" (merge_to_main).
  hideOn?: boolean;
  disabled?: boolean;
}) {
  // With "on" hidden, true and null both mean "auto" (same runtime behavior).
  const current = hideOn
    ? value === false
      ? "off"
      : "auto"
    : value == null
      ? "auto"
      : value
        ? "on"
        : "off";
  return (
    <div
      className={`flex items-center justify-between gap-2 rounded-sm border border-border bg-surface-2 px-2.5 py-1.5 ${disabled ? "opacity-50" : ""}`}
    >
      <span className="inline-flex items-center gap-1 text-xs text-text-2">
        {label}
        {hint ? (
          <Tooltip title={label} description={hint} side="top">
            <span className="inline-flex text-text-3 cursor-help">
              <Info className="h-3 w-3" />
            </span>
          </Tooltip>
        ) : null}
      </span>
      <Select
        value={current}
        onValueChange={(v) =>
          onChange(v === "auto" ? null : v === "on")
        }
        disabled={disabled}
      >
        <SelectTrigger className="h-7 w-24 font-mono text-xs">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="auto">auto</SelectItem>
          {hideOn ? null : <SelectItem value="on">on</SelectItem>}
          <SelectItem value="off">off</SelectItem>
        </SelectContent>
      </Select>
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

