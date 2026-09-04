// Builds complete read-only Claw add plans without mutating local state.
import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { relative, resolve } from "node:path";
import { stableStringify } from "@openclaw/normalization-core";
import { resolvePathViaExistingAncestorSync } from "../infra/boundary-path.js";
import { assertNoSymlinkParents } from "../infra/fs-safe-advanced.js";
import { FsSafeError, root as fsSafeRoot, type Root } from "../infra/fs-safe.js";
import { resolveUserPath } from "../utils.js";
import { digestClawAddPlanIntegrity } from "./add-plan-integrity.js";
import { findClawExtensionPackageCollisions, planClawExtensions } from "./application-plan.js";
import {
  planWorkspaceAdoption,
  planWorkspaceAdoptionTargets,
  workspaceAdoptionCapabilityChange,
} from "./lifecycle-adopt-plan.js";
import { planClawAgent, type ExistingClawAgent } from "./lifecycle-agent-plan.js";
import { inspectAgentWorkspaceOwnership } from "./lifecycle-agent-workspace.js";
import { digestClawMcpServer } from "./mcp.js";
import { clawManifestWorkspaceConflictsWithPath } from "./schema.js";
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
  type ClawOpenClawProfile,
  type ClawPackagePreflight,
  type ClawPackagePreflightResult,
  type ClawSourceIdentity,
  type ClawWorkspaceSourceSnapshot,
} from "./types.js";

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

export type ClawAddPlanContext = {
  agentId?: string;
  workspace?: string;
  resumableWorkspace?: string;
  adoptExistingWorkspace?: boolean;
  adoptExistingAgent?: boolean;
  existingAgents?: Iterable<ExistingClawAgent>;
  existingAgentIds?: Iterable<string>;
  managedAgentIds?: Iterable<string>;
  existingWorkspacePaths?: Iterable<string>;
  existingMcpServerNames?: Iterable<string>;
  existingMcpServers?: Record<string, Record<string, unknown>>;
  packagePreflight?: ClawPackagePreflight;
  sourceReferenceRoot?: string;
};

function sourceReferencePath(root: string, path: string): string {
  return `${root.replace(/\/+$/u, "")}/${path.replaceAll("\\", "/")}`;
}

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
  content?: Buffer;
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
  clawMarkdownBody?: Buffer;
  packageBootstrap?: ClawWorkspaceSourceSnapshot;
  includePackageBootstrap?: boolean;
  openClawProfile?: ClawOpenClawProfile;
  reconstructLegacyDynamicToolProfilePlan?: boolean;
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
  const manifestPath = resolvePathViaExistingAncestorSync(resolve(params.source.manifestPath));
  const source = { ...params.source, packageRoot, manifestPath };
  const planSource = context.sourceReferenceRoot
    ? {
        ...source,
        packageRoot: context.sourceReferenceRoot,
        manifestPath: sourceReferencePath(
          context.sourceReferenceRoot,
          relative(packageRoot, manifestPath),
        ),
      }
    : source;
  const planSourcePath = (path: string, fallback: string): string =>
    context.sourceReferenceRoot ? sourceReferencePath(context.sourceReferenceRoot, path) : fallback;
  const sourceRoot = await fsSafeRoot(packageRoot);
  const blockers: ClawDiagnostic[] = [];
  const actions: ClawAddPlanAction[] = [];
  const capabilityChanges: ClawAddCapabilityChange[] = [];
  const readinessRequirements: ClawLocalPrerequisite[] = [];

  const agentPlan = planClawAgent({
    finalId,
    workspace,
    manifestAgent: params.manifest.agent,
    openClawProfile: params.openClawProfile,
    reconstructLegacyDynamicToolProfilePlan: params.reconstructLegacyDynamicToolProfilePlan,
    existingAgents: context.existingAgents,
    existingAgentIds: context.existingAgentIds,
    managedAgentIds: context.managedAgentIds,
    adoptExistingAgent: context.adoptExistingAgent,
  });
  const agentConfig = agentPlan.config;
  blockers.push(...agentPlan.blockers);
  actions.push(agentPlan.action);
  if (agentPlan.capabilityChange) {
    capabilityChanges.push(capabilityChange(agentPlan.capabilityChange));
  }

  const { configuredWorkspaceConflict } = inspectAgentWorkspaceOwnership({
    existingAgents: context.existingAgents,
    existingWorkspacePaths: context.existingWorkspacePaths,
    finalId,
    workspace,
    adopting: context.adoptExistingAgent === true,
    canonicalize: canonicalWorkspacePath,
  });
  const resumableWorkspace = context.resumableWorkspace
    ? canonicalWorkspacePath(context.resumableWorkspace)
    : undefined;
  const workspacePlan = await planWorkspaceAdoption({
    agentId: finalId,
    workspace,
    requested: context.adoptExistingWorkspace === true || context.adoptExistingAgent === true,
    configuredWorkspaceConflict,
    configuredWorkspaceConflictCode:
      context.adoptExistingAgent === true ? "agent_workspace_conflict" : undefined,
    resumableWorkspace,
  });
  const workspaceAdoption = workspacePlan.adopted;
  const workspaceBlocked = workspacePlan.action.blocked;
  blockers.push(...workspacePlan.blockers);
  actions.push(workspacePlan.action);
  if (workspaceAdoption) {
    capabilityChanges.push(capabilityChange(workspaceAdoptionCapabilityChange(finalId, workspace)));
  }

  if (params.packageBootstrap && params.includePackageBootstrap !== false) {
    actions.push({
      kind: "bootstrap",
      id: "BOOTSTRAP.md",
      action: "write",
      target: resolve(workspace, "BOOTSTRAP.md"),
      source: planSourcePath(params.packageBootstrap.sourcePath, params.packageBootstrap.realPath),
      digest: params.packageBootstrap.digest,
      details: {
        sourcePath: params.packageBootstrap.sourcePath,
        byteLength: params.packageBootstrap.byteLength,
        expectedState: "absent-or-native-consumed",
        lifecycle: "native-seed-once",
      },
      blocked: workspaceBlocked,
      ...(workspaceBlocked
        ? { reason: `Workspace ${JSON.stringify(workspace)} already exists.` }
        : {}),
    });
  }

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
    if (action.source) {
      action.source = planSourcePath(fileParams.sourcePath, action.source);
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

  if (params.clawMarkdownBody && params.clawMarkdownBody.toString("utf8").trim().length > 0) {
    if (clawManifestWorkspaceConflictsWithPath(params.manifest, "SOUL.md")) {
      const diagnostic = blocker(
        "claw_body_soul_conflict",
        "$.workspace",
        "CLAW.md body content and an explicit SOUL.md workspace declaration cannot both be present.",
      );
      blockers.push(diagnostic);
      actions.push({
        kind: "workspaceFile",
        id: "SOUL.md",
        action: "write",
        target: resolve(workspace, "SOUL.md"),
        source: planSource.manifestPath,
        sourceKind: "clawMarkdownBody",
        blocked: true,
        reason: diagnostic.message,
      });
    } else {
      const pending: PendingWorkspaceFileAction = {
        sourcePath: source.manifestPath,
        manifestPath: "$body",
        byteLength: params.clawMarkdownBody.byteLength,
        content: params.clawMarkdownBody,
        action: {
          kind: "workspaceFile",
          id: "SOUL.md",
          action: "write",
          target: resolve(workspace, "SOUL.md"),
          source: planSource.manifestPath,
          sourceKind: "clawMarkdownBody",
          details: { expectedState: "absent" },
          blocked: false,
        },
      };
      pendingWorkspaceFiles.push(pending);
      actions.push(pending.action);
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
      if (pending.content) {
        pending.action.digest = `sha256:${createHash("sha256").update(pending.content).digest("hex")}`;
        continue;
      }
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
        pending.action.source = planSourcePath(pending.sourcePath, read.realPath);
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

  if (workspaceAdoption) {
    blockers.push(
      ...(await planWorkspaceAdoptionTargets({
        workspace,
        pendingFiles: pendingWorkspaceFiles,
        packageBootstrap: actions.find((action) => action.kind === "bootstrap"),
      })),
    );
  }

  for (const [index, pkg] of params.manifest.packages.entries()) {
    const preflight: ClawPackagePreflightResult = context.packagePreflight
      ? await context.packagePreflight(pkg, workspace)
      : {
          ok: false,
          code: "package_install_unavailable",
          message: "Package preflight is unavailable.",
        };
    const diagnostic = preflight.ok
      ? undefined
      : blocker(
          preflight.code ?? "package_install_unavailable",
          `$.packages[${index}]`,
          preflight.message ?? "Package preflight failed.",
        );
    if (diagnostic) {
      blockers.push(diagnostic);
    }
    if (preflight.ok && preflight.requirements) {
      readinessRequirements.push(...preflight.requirements);
    }
    actions.push({
      kind: "package",
      id: `${pkg.kind}:${pkg.ref}`,
      action: preflight.ok && preflight.action === "reuse" ? "reuse" : "install",
      target: `${pkg.source}:${pkg.ref}@${pkg.version}`,
      digest: preflight.integrity,
      details: {
        ...pkg,
        ...(preflight.integrity ? { integrity: preflight.integrity } : {}),
        ...(preflight.installId ? { installId: preflight.installId } : {}),
        ...(preflight.warning ? { riskWarning: preflight.warning } : {}),
        ...(preflight.requirements ? { prerequisites: preflight.requirements } : {}),
        expectedState: !preflight.ok
          ? "unresolved"
          : preflight.action === "reuse"
            ? "present-exact"
            : "absent",
        ownerAction: preflight.action,
        requirementState: !preflight.ok
          ? "conflicting"
          : preflight.action === "install"
            ? "missing-installable"
            : preflight.requirements && preflight.requirements.length > 0
              ? "setup-required"
              : "satisfied",
      },
      blocked: !preflight.ok,
      ...(diagnostic ? { reason: diagnostic.message } : {}),
    });
    capabilityChanges.push(
      capabilityChange({
        kind: "package",
        id: `${pkg.kind}:${pkg.ref}`,
        path: `packages.${pkg.kind}.${pkg.ref}`,
        action: preflight.ok && preflight.action === "reuse" ? "reuse" : "install",
        reason:
          preflight.ok && preflight.action === "reuse"
            ? "The Claw requires access to an existing package capability."
            : "The Claw requires downloadable package content or executable code.",
        effect: {
          kind: pkg.kind,
          source: pkg.source,
          ref: pkg.ref,
          version: pkg.version,
          integrity: preflight.integrity ?? "unresolved",
          ...(preflight.installId ? { installId: preflight.installId } : {}),
          ...(preflight.warning ? { riskWarning: preflight.warning } : {}),
        },
      }),
    );
  }

  const extensionPlan = await planClawExtensions({
    extensions: params.openClawProfile?.extensions ?? [],
    workspace,
    packagePreflight: context.packagePreflight,
  });
  const extensions = extensionPlan.extensions;
  const extensionCollisions = findClawExtensionPackageCollisions({
    packages: params.manifest.packages,
    extensions: params.openClawProfile?.extensions ?? [],
  });
  const collisionIndexes = new Set(extensionCollisions.map(({ index }) => index));
  blockers.push(...extensionCollisions.map(({ diagnostic }) => diagnostic));
  for (const [index, action] of extensionPlan.actions.entries()) {
    if (collisionIndexes.has(index)) {
      continue;
    }
    actions.push(action);
  }
  capabilityChanges.push(...extensionPlan.capabilityChanges);
  readinessRequirements.push(...extensionPlan.requirements);
  blockers.push(...extensionPlan.blockers);

  const existingMcpServerNames = new Set(context.existingMcpServerNames ?? []);
  for (const [name, server] of Object.entries(params.manifest.mcpServers)) {
    const existingServer = context.existingMcpServers?.[name];
    const exactExisting =
      existingServer !== undefined &&
      digestClawMcpServer(existingServer) === digestClawMcpServer(server);
    const blocked =
      !exactExisting && (existingMcpServerNames.has(name) || existingServer !== undefined);
    if (blocked) {
      blockers.push(
        blocker(
          "mcp_server_collision",
          `$.mcpServers.${name}`,
          `MCP server ${JSON.stringify(name)} already exists with different or unresolved configuration and will not be overwritten.`,
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
        expectedState: exactExisting ? "present-exact" : "absent",
        prerequisites: readinessRequirements.filter(
          (requirement) => requirement.kind !== "plugin-setup" && requirement.mcpServer === name,
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

  // Strict v1 validation permits only deterministic main or isolated targets.
  for (const job of params.manifest.cronJobs) {
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
      blocked: false,
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

  const planIntegrity = digestClawAddPlanIntegrity({
    manifestSchemaVersion: params.manifest.schemaVersion,
    claw: planSource,
    agent: {
      requestedId: params.manifest.agent.id,
      finalId,
      workspace,
      config: agentConfig,
    },
    actions,
    capabilityChanges,
    blockers,
    extensions,
  });

  return {
    schemaVersion: CLAW_ADD_PLAN_SCHEMA_VERSION,
    manifestSchemaVersion: params.manifest.schemaVersion,
    stability: CLAW_OUTPUT_STABILITY,
    dryRun: true,
    mutationAllowed: false,
    planIntegrity,
    claw: planSource,
    agent: {
      requestedId: params.manifest.agent.id,
      finalId,
      workspace,
      config: agentConfig,
    },
    summary: {
      totalActions: actions.length,
      agentActions: actions.filter((action) => action.kind === "agent").length,
      workspaceActions: actions.filter(
        (action) =>
          action.kind === "workspace" ||
          action.kind === "bootstrap" ||
          action.kind === "workspaceFile",
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
    extensions,
    blockers,
    diagnostics: params.diagnostics ?? [],
  };
}
