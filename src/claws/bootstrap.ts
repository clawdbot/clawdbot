import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { MAX_WORKSPACE_BOOTSTRAP_FILE_BYTES } from "../agents/workspace-bootstrap-read.js";
import { DEFAULT_BOOTSTRAP_FILENAME, seedWorkspaceBootstrap } from "../agents/workspace.js";
import { root as fsSafeRoot } from "../infra/fs-safe.js";
import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db.js";
import type { ClawAddPlan } from "./types.js";

export class ClawBootstrapWriteError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ClawBootstrapWriteError";
  }
}

function contentDigest(content: Uint8Array): string {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

function containedRelativePath(root: string, path: string): string | undefined {
  const child = relative(root, path);
  if (child === ".." || child.startsWith(`..${sep}`) || isAbsolute(child)) {
    return undefined;
  }
  return child;
}

export async function seedClawPackageBootstrap(
  plan: ClawAddPlan,
  options: {
    nowMs?: number;
    seedBootstrap?: typeof seedWorkspaceBootstrap;
  } & OpenClawStateDatabaseOptions = {},
): Promise<"seeded" | "already-seeded" | "consumed" | undefined> {
  const actions = plan.actions.filter((action) => action.kind === "bootstrap");
  if (actions.length === 0) {
    return undefined;
  }
  if (actions.length !== 1) {
    throw new ClawBootstrapWriteError(
      "bootstrap_plan_invalid",
      "A Claw add plan may contain only one package bootstrap action.",
    );
  }
  const action = actions[0];
  if (!action) {
    throw new ClawBootstrapWriteError(
      "bootstrap_plan_invalid",
      "The package bootstrap action is missing.",
    );
  }
  if (!action.source || !action.digest) {
    throw new ClawBootstrapWriteError(
      "bootstrap_plan_invalid",
      "The package bootstrap action lacks source integrity.",
    );
  }

  const packageRoot = await realpath(resolve(plan.claw.packageRoot));
  const sourcePath = resolve(action.source);
  const sourceRelative = containedRelativePath(packageRoot, sourcePath);
  if (!sourceRelative) {
    throw new ClawBootstrapWriteError(
      "bootstrap_source_escape",
      "BOOTSTRAP.md must remain inside the Claw package.",
    );
  }
  const sourceRoot = await fsSafeRoot(packageRoot);
  const read = await sourceRoot.read(sourceRelative, {
    hardlinks: "reject",
    maxBytes: MAX_WORKSPACE_BOOTSTRAP_FILE_BYTES,
    symlinks: "reject",
  });
  if (resolve(read.realPath) !== sourcePath || contentDigest(read.buffer) !== action.digest) {
    throw new ClawBootstrapWriteError(
      "bootstrap_source_changed",
      "BOOTSTRAP.md changed after consent; run add --dry-run again.",
    );
  }

  const expectedTarget = resolve(plan.agent.workspace, DEFAULT_BOOTSTRAP_FILENAME);
  if (resolve(action.target) !== expectedTarget) {
    throw new ClawBootstrapWriteError(
      "bootstrap_target_changed",
      "The package bootstrap target is not the new agent workspace root.",
    );
  }

  return (options.seedBootstrap ?? seedWorkspaceBootstrap)({
    dir: plan.agent.workspace,
    content: read.buffer,
    ...(options.nowMs !== undefined ? { nowMs: options.nowMs } : {}),
    stateOptions: options,
  });
}
