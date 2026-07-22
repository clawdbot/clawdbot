// Builds complete read-only Claw add plans without mutating local state.
import { createHash } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { stableStringify } from "../agents/stable-stringify.js";
import { resolvePathViaExistingAncestorSync } from "../infra/boundary-path.js";
import { assertNoSymlinkParents } from "../infra/fs-safe-advanced.js";
import { FsSafeError, root as fsSafeRoot, type Root } from "../infra/fs-safe.js";
import { resolveUserPath } from "../utils.js";
import { MAX_MANAGED_FILE_BYTES, MAX_MANAGED_WORKSPACE_BYTES } from "./source-limits.js";
import {
  CLAW_ADD_PLAN_SCHEMA_VERSION,
  CLAW_BOOTSTRAP_FILE_NAMES,
  CLAW_OUTPUT_STABILITY,
  type ClawAddPlan,
  type ClawAddPlanAction,
  type ClawAddCapabilityChange,
  type ClawDiagnostic,
  type ClawManifest,
  type ClawLocalPrerequisite,
  type ClawSourceIdentity,
} from "./types.js";

const AGENT_ID_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;

function capabilityChange(
  change: Omit<ClawAddCapabilityChange, "classification" | "requiresDistinctConsent" | "digest">,
): ClawAddCapabilityChange {
  return {
    ...change,
    classification: "escalation",
    requiresDistinctConsent: true,
    digest: `sha256:${createHash("sha256").update(stableStringify(change.effect)).digest("hex")}`,
  };
}

type ClawAddPlanContext = {
  agentId?: string;
  workspace?: string;
  resumableWorkspace?: string;
  existingAgentIds?: Iterable<string>;
  existingWorkspacePaths?: Iterable<string>;
  existingMcpServerNames?: Iterable<string>;
  existingCronJobIds?: Iterable<string>;
};

function canonicalWorkspacePath(value: string): string {
  return resolvePathViaExistingAncestorSync(resolve(resolveUserPath(value)));
}

function blocker(code: string, path: string, message: string): ClawDiagnostic {
  return { level: "error", code, phase: "plan", path, message };
}

type PendingWorkspaceFileAction = {
  action: ClawAddPlanAction;
  sourcePath: string;
  manifestPath: string;
  byteLength: number;
};

function blockedWorkspaceFileAction(params: {
  id: string;
  source: string;
  target: string;
  reason: string;
}): ClawAddPlanAction {
  return {
    kind: "workspaceFile",
    id: params.id,
    action: "write",
    target: params.target,
    source: params.source,
    blocked: true,
    reason: params.reason,
  };
}

function workspaceSourceErrorCode(
  error: unknown,
): "workspace_source_invalid" | "workspace_source_unsafe" | "workspace_source_too_large" {
  if (error instanceof FsSafeError) {
    if (error.code === "too-large") {
      return "workspace_source_too_large";
    }
    if (error.code === "symlink" || error.code === "hardlink" || error.code === "path-mismatch") {
      return "workspace_source_unsafe";
    }
  }
  if (error instanceof Error && error.message.includes("symlinked directory")) {
    return "workspace_source_unsafe";
  }
  return "workspace_source_invalid";
}

function workspaceSourceMessage(code: string, sourcePath: string): string {
  if (code === "workspace_source_too_large") {
    return `Workspace source ${JSON.stringify(sourcePath)} exceeds ${MAX_MANAGED_FILE_BYTES} bytes.`;
  }
  if (code === "workspace_sources_too_large") {
    return `Workspace sources exceed ${MAX_MANAGED_WORKSPACE_BYTES} aggregate bytes.`;
  }
  if (code === "workspace_source_unsafe") {
    return `Workspace source ${JSON.stringify(sourcePath)} must be a regular, non-symlinked, non-hardlinked file.`;
  }
  return `Workspace source ${JSON.stringify(sourcePath)} must resolve to a file inside the Claw package.`;
}

async function inspectWorkspaceFileAction(params: {
  sourceRoot: Root;
  source: ClawSourceIdentity;
  workspace: string;
  sourcePath: string;
  targetPath: string;
  id: string;
  manifestPath: string;
}): Promise<{
  pending?: PendingWorkspaceFileAction;
  action?: ClawAddPlanAction;
  blocker?: ClawDiagnostic;
}> {
  const requestedSource = resolve(params.source.packageRoot, params.sourcePath);
  const requestedTarget = resolve(params.workspace, params.targetPath);
  try {
    await assertNoSymlinkParents({
      rootDir: params.source.packageRoot,
      targetPath: requestedSource,
      allowMissing: false,
      messagePrefix: "Workspace source",
    });
    const opened = await params.sourceRoot.open(params.sourcePath, {
      hardlinks: "reject",
      symlinks: "reject",
    });
    await opened[Symbol.asyncDispose]();
    if (opened.stat.size > MAX_MANAGED_FILE_BYTES) {
      throw new FsSafeError(
        "too-large",
        `file exceeds limit of ${MAX_MANAGED_FILE_BYTES} bytes (got ${opened.stat.size})`,
      );
    }
    return {
      pending: {
        sourcePath: params.sourcePath,
        manifestPath: params.manifestPath,
        byteLength: opened.stat.size,
        action: {
          kind: "workspaceFile",
          id: params.id,
          action: "write",
          target: requestedTarget,
          source: opened.realPath,
          details: { expectedState: "absent" },
          blocked: false,
        },
      },
    };
  } catch (error) {
    const code = workspaceSourceErrorCode(error);
    const message = workspaceSourceMessage(code, params.sourcePath);
    const diagnostic = blocker(code, params.manifestPath, message);
    return {
      action: blockedWorkspaceFileAction({
        id: params.id,
        target: requestedTarget,
        source: requestedSource,
        reason: diagnostic.message,
      }),
      blocker: diagnostic,
    };
  }
}

export async function buildClawAddPlan(params: {
  manifest: ClawManifest;
  source: ClawSourceIdentity;
  diagnostics?: ClawDiagnostic[];
  context?: ClawAddPlanContext;
}): Promise<ClawAddPlan> {
  const context = params.context ?? {};
  const finalId = context.agentId ?? params.manifest.agent.id;
  const workspace = canonicalWorkspacePath(
    context.workspace ?? resolve(homedir(), ".openclaw", `workspace-${finalId}`),
  );
  const packageRoot = await realpath(params.source.packageRoot).catch(
    () => params.source.packageRoot,
  );
  const source = { ...params.source, packageRoot };
  const sourceRoot = await fsSafeRoot(packageRoot);
  const blockers: ClawDiagnostic[] = [];
  const actions: ClawAddPlanAction[] = [];
  const capabilityChanges: ClawAddCapabilityChange[] = [];
  const readinessRequirements: ClawLocalPrerequisite[] = [];

  if (!AGENT_ID_PATTERN.test(finalId)) {
    blockers.push(
      blocker(
        "invalid_agent_id",
        "$.agent.id",
        `Final agent id ${JSON.stringify(finalId)} is not a valid portable agent id.`,
      ),
    );
  }
  const existingAgentIds = new Set(context.existingAgentIds ?? []);
  const agentBlocked = existingAgentIds.has(finalId);
  if (agentBlocked) {
    blockers.push(
      blocker(
        "agent_id_collision",
        "$.agent.id",
        `Agent id ${JSON.stringify(finalId)} already exists; Claws never merge into existing agents.`,
      ),
    );
  }
  actions.push({
    kind: "agent",
    id: finalId,
    action: "create",
    target: `agents.list[${JSON.stringify(finalId)}]`,
    details: { ...params.manifest.agent, id: finalId, workspace, expectedState: "absent" },
    blocked: agentBlocked || !AGENT_ID_PATTERN.test(finalId),
  });
  const agentCapabilityEffect = {
    ...(params.manifest.agent.sandbox ? { sandbox: params.manifest.agent.sandbox } : {}),
    ...(params.manifest.agent.tools ? { tools: params.manifest.agent.tools } : {}),
    ...(params.manifest.agent.heartbeat ? { heartbeat: params.manifest.agent.heartbeat } : {}),
  };
  if (Object.keys(agentCapabilityEffect).length > 0) {
    capabilityChanges.push(
      capabilityChange({
        kind: "agent",
        id: finalId,
        path: "agent",
        action: "create",
        reason: "The new agent declares sandbox, tool, or recurring heartbeat capabilities.",
        effect: agentCapabilityEffect,
      }),
    );
  }

  const configuredWorkspacePaths = new Set(
    [...(context.existingWorkspacePaths ?? [])].map((path) => canonicalWorkspacePath(path)),
  );
  const configuredWorkspaceConflict = configuredWorkspacePaths.has(workspace);
  const workspaceExistsOnDisk = await lstat(workspace)
    .then(() => true)
    .catch(() => false);
  const resumableWorkspace = context.resumableWorkspace
    ? canonicalWorkspacePath(context.resumableWorkspace)
    : undefined;
  const workspaceBlocked =
    configuredWorkspaceConflict || (workspaceExistsOnDisk && resumableWorkspace !== workspace);
  if (workspaceBlocked) {
    blockers.push(
      blocker(
        "workspace_collision",
        "$.workspace",
        `Workspace ${JSON.stringify(workspace)} already exists; a Claw requires a new workspace.`,
      ),
    );
  }
  actions.push({
    kind: "workspace",
    id: finalId,
    action: "create",
    target: workspace,
    details: { expectedState: "absent" },
    blocked: workspaceBlocked,
    ...(workspaceBlocked
      ? { reason: `Workspace ${JSON.stringify(workspace)} already exists.` }
      : {}),
  });

  const pendingWorkspaceFiles: PendingWorkspaceFileAction[] = [];
  async function addWorkspaceFileInspection(fileParams: {
    sourcePath: string;
    targetPath: string;
    id: string;
    manifestPath: string;
  }): Promise<void> {
    const result = await inspectWorkspaceFileAction({
      sourceRoot,
      source,
      workspace,
      sourcePath: fileParams.sourcePath,
      targetPath: fileParams.targetPath,
      id: fileParams.id,
      manifestPath: fileParams.manifestPath,
    });
    const action = result.pending?.action ?? result.action;
    if (!action) {
      throw new Error("Claw workspace source inspection did not produce an action");
    }
    action.blocked ||= workspaceBlocked;
    if (workspaceBlocked) {
      action.reason = `Workspace ${JSON.stringify(workspace)} already exists.`;
    }
    actions.push(action);
    if (result.pending) {
      pendingWorkspaceFiles.push(result.pending);
    }
    if (result.blocker) {
      blockers.push(result.blocker);
    }
  }

  for (const name of CLAW_BOOTSTRAP_FILE_NAMES) {
    const declaration = params.manifest.workspace.bootstrapFiles[name];
    if (!declaration) {
      continue;
    }
    await addWorkspaceFileInspection({
      sourcePath: declaration.source,
      targetPath: name,
      id: name,
      manifestPath: `$.workspace.bootstrapFiles.${name}`,
    });
  }
  for (const [index, file] of params.manifest.workspace.files.entries()) {
    await addWorkspaceFileInspection({
      sourcePath: file.source,
      targetPath: file.path,
      id: file.path,
      manifestPath: `$.workspace.files[${index}]`,
    });
  }

  const workspaceByteLength = pendingWorkspaceFiles.reduce(
    (total, pending) => total + pending.byteLength,
    0,
  );
  if (workspaceByteLength > MAX_MANAGED_WORKSPACE_BYTES) {
    const diagnostic = blocker(
      "workspace_sources_too_large",
      "$.workspace",
      workspaceSourceMessage("workspace_sources_too_large", ""),
    );
    blockers.push(diagnostic);
    for (const pending of pendingWorkspaceFiles) {
      pending.action.blocked = true;
      pending.action.reason = diagnostic.message;
    }
  } else {
    for (const pending of pendingWorkspaceFiles) {
      try {
        await assertNoSymlinkParents({
          rootDir: source.packageRoot,
          targetPath: resolve(source.packageRoot, pending.sourcePath),
          allowMissing: false,
          messagePrefix: "Workspace source",
        });
        const read = await sourceRoot.read(pending.sourcePath, {
          hardlinks: "reject",
          maxBytes: MAX_MANAGED_FILE_BYTES,
          symlinks: "reject",
        });
        pending.action.source = read.realPath;
        pending.action.digest = `sha256:${createHash("sha256").update(read.buffer).digest("hex")}`;
      } catch (error) {
        const code = workspaceSourceErrorCode(error);
        const message = workspaceSourceMessage(code, pending.sourcePath);
        const diagnostic = blocker(code, pending.manifestPath, message);
        pending.action.blocked = true;
        pending.action.reason = diagnostic.message;
        blockers.push(diagnostic);
      }
    }
  }

  for (const pkg of params.manifest.packages) {
    const diagnostic = blocker(
      "package_install_unavailable",
      "$.packages",
      `Package ${JSON.stringify(`${pkg.kind}:${pkg.ref}@${pkg.version}`)} cannot be preflighted until the package-owner lifecycle slice is available.`,
    );
    blockers.push(diagnostic);
    actions.push({
      kind: "package",
      id: `${pkg.kind}:${pkg.ref}`,
      action: "install",
      target: `${pkg.source}:${pkg.ref}@${pkg.version}`,
      details: { ...pkg, expectedState: "unresolved" },
      blocked: true,
      reason: diagnostic.message,
    });
    capabilityChanges.push(
      capabilityChange({
        kind: "package",
        id: `${pkg.kind}:${pkg.ref}`,
        path: `packages.${pkg.kind}.${pkg.ref}`,
        action: "install",
        reason: "The Claw declares downloadable package content or executable code.",
        effect: {
          kind: pkg.kind,
          source: pkg.source,
          ref: pkg.ref,
          version: pkg.version,
          integrity: "unresolved",
        },
      }),
    );
  }

  const existingMcpServerNames = new Set(context.existingMcpServerNames ?? []);
  for (const [name, server] of Object.entries(params.manifest.mcpServers)) {
    const blocked = existingMcpServerNames.has(name);
    if (blocked) {
      blockers.push(
        blocker(
          "mcp_server_collision",
          `$.mcpServers.${name}`,
          `MCP server ${JSON.stringify(name)} already exists and will not be overwritten.`,
        ),
      );
    }
    if ("env" in server) {
      for (const value of Object.values(server.env ?? {})) {
        readinessRequirements.push({
          kind: "environment",
          mcpServer: name,
          name: value.slice(2, -1),
        });
      }
    }
    if ("auth" in server && server.auth === "oauth") {
      readinessRequirements.push({ kind: "oauth", mcpServer: name });
    }
    actions.push({
      kind: "mcpServer",
      id: name,
      action: "configure",
      target: `mcp.servers.${name}`,
      details: {
        ...server,
        expectedState: "absent",
        prerequisites: readinessRequirements.filter(
          (requirement) => requirement.mcpServer === name,
        ),
      },
      blocked,
    });
    capabilityChanges.push(
      capabilityChange({
        kind: "mcpServer",
        id: name,
        path: `mcpServers.${name}`,
        action: "configure",
        reason: "The Claw declares an MCP execution or network tool surface.",
        effect: {
          ...server,
          ...("env" in server && server.env ? { env: Object.keys(server.env).toSorted() } : {}),
        },
      }),
    );
  }

  const existingCronJobIds = new Set(context.existingCronJobIds ?? []);
  for (const job of params.manifest.cronJobs) {
    const blocked = existingCronJobIds.has(job.id);
    if (blocked) {
      blockers.push(
        blocker(
          "cron_job_collision",
          `$.cronJobs.${job.id}`,
          `Cron job ${JSON.stringify(job.id)} already exists and will not be overwritten.`,
        ),
      );
    }
    actions.push({
      kind: "cronJob",
      id: job.id,
      action: "schedule",
      target: `cron:${job.id}:agent=${finalId}`,
      details: {
        ...job,
        agentId: finalId,
        expectedState: "absent",
        ...(job.delivery?.channel === "last"
          ? { deliveryResolution: "local-channel-state:last" }
          : {}),
      },
      blocked,
    });
    capabilityChanges.push(
      capabilityChange({
        kind: "cronJob",
        id: job.id,
        path: `cronJobs.${job.id}`,
        action: "schedule",
        reason: "The Claw declares recurring scheduled work.",
        effect: { ...job, agentId: finalId },
      }),
    );
  }

  capabilityChanges.sort((left, right) =>
    `${left.kind}:${left.id}:${left.path}`.localeCompare(`${right.kind}:${right.id}:${right.path}`),
  );

  const planIntegrity = `sha256:${createHash("sha256")
    .update(
      stableStringify({
        manifestSchemaVersion: params.manifest.schemaVersion,
        clawIntegrity: source.integrity,
        finalId,
        workspace,
        actions,
        capabilityChanges,
        blockers,
      }),
    )
    .digest("hex")}`;

  return {
    schemaVersion: CLAW_ADD_PLAN_SCHEMA_VERSION,
    manifestSchemaVersion: params.manifest.schemaVersion,
    stability: CLAW_OUTPUT_STABILITY,
    dryRun: true,
    mutationAllowed: false,
    planIntegrity,
    claw: source,
    agent: {
      requestedId: params.manifest.agent.id,
      finalId,
      workspace,
      config: { ...params.manifest.agent, id: finalId, workspace },
    },
    summary: {
      totalActions: actions.length,
      agentActions: actions.filter((action) => action.kind === "agent").length,
      workspaceActions: actions.filter(
        (action) => action.kind === "workspace" || action.kind === "workspaceFile",
      ).length,
      packageActions: actions.filter((action) => action.kind === "package").length,
      mcpServerActions: actions.filter((action) => action.kind === "mcpServer").length,
      cronJobActions: actions.filter((action) => action.kind === "cronJob").length,
      blockedActions: actions.filter((action) => action.blocked).length,
      capabilityEscalations: capabilityChanges.length,
    },
    actions,
    capabilityChanges,
    readiness: {
      ready: readinessRequirements.length === 0,
      requirements: readinessRequirements,
    },
    blockers,
    diagnostics: params.diagnostics ?? [],
  };
}
