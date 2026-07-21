// Builds complete read-only Claw add plans without mutating local state.
import { createHash } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { stableStringify } from "../agents/stable-stringify.js";
import { resolveUserPath } from "../utils.js";
import { MAX_MANAGED_WORKSPACE_BYTES } from "./source-limits.js";
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
  type ClawSourceSnapshot,
  type ClawWorkspaceSourceSnapshot,
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
  existingAgentIds?: Iterable<string>;
  existingWorkspacePaths?: Iterable<string>;
  existingMcpServerNames?: Iterable<string>;
  existingCronJobIds?: Iterable<string>;
};

function blocker(code: string, path: string, message: string): ClawDiagnostic {
  return { level: "error", code, phase: "plan", path, message };
}

function isNotFoundError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

function inspectWorkspaceFileAction(params: {
  source: ClawSourceIdentity;
  workspace: string;
  sourcePath: string;
  targetPath: string;
  id: string;
  manifestPath: string;
  snapshot?: ClawWorkspaceSourceSnapshot;
}): {
  action: ClawAddPlanAction;
  blocker?: ClawDiagnostic;
} {
  const requestedSource = resolve(params.source.packageRoot, params.sourcePath);
  const requestedTarget = resolve(params.workspace, params.targetPath);
  if (params.snapshot) {
    return {
      action: {
        kind: "workspaceFile",
        id: params.id,
        action: "write",
        target: requestedTarget,
        source: params.snapshot.realPath,
        digest: params.snapshot.digest,
        details: { expectedState: "absent" },
        blocked: false,
      },
    };
  }
  const diagnostic = blocker(
    "workspace_source_invalid",
    params.manifestPath,
    `Workspace source ${JSON.stringify(params.sourcePath)} was not captured in the validated Claw snapshot.`,
  );
  return {
    action: {
      kind: "workspaceFile",
      id: params.id,
      action: "write",
      target: requestedTarget,
      source: requestedSource,
      blocked: true,
      reason: diagnostic.message,
    },
    blocker: diagnostic,
  };
}

export async function buildClawAddPlan(params: {
  manifest: ClawManifest;
  source: ClawSourceIdentity;
  snapshot: ClawSourceSnapshot;
  diagnostics?: ClawDiagnostic[];
  context?: ClawAddPlanContext;
}): Promise<ClawAddPlan> {
  const context = params.context ?? {};
  const finalId = context.agentId ?? params.manifest.agent.id;
  const workspace = resolve(
    resolveUserPath(context.workspace ?? resolve(homedir(), ".openclaw", `workspace-${finalId}`)),
  );
  const packageRoot = await realpath(params.source.packageRoot).catch(
    () => params.source.packageRoot,
  );
  const source = { ...params.source, packageRoot };
  const workspaceSnapshots = new Map(
    params.snapshot.workspaceSources.map((snapshot) => [snapshot.sourcePath, snapshot]),
  );
  const blockers: ClawDiagnostic[] = [];
  const actions: ClawAddPlanAction[] = [];
  const workspaceFileActions: ClawAddPlanAction[] = [];
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
    [...(context.existingWorkspacePaths ?? [])].map((path) => resolve(resolveUserPath(path))),
  );
  let workspaceExists = configuredWorkspacePaths.has(workspace);
  let workspaceProbeFailed = false;
  if (!workspaceExists) {
    try {
      await lstat(workspace);
      workspaceExists = true;
    } catch (error) {
      if (!isNotFoundError(error)) {
        workspaceProbeFailed = true;
        blockers.push(
          blocker(
            "workspace_probe_failed",
            "$.workspace",
            `Could not prove that workspace ${JSON.stringify(workspace)} is absent.`,
          ),
        );
      }
    }
  }
  if (workspaceExists) {
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
    details: { expectedState: workspaceProbeFailed ? "unknown" : "absent" },
    blocked: workspaceExists || workspaceProbeFailed,
    ...(workspaceExists
      ? { reason: `Workspace ${JSON.stringify(workspace)} already exists.` }
      : workspaceProbeFailed
        ? { reason: `Could not prove that workspace ${JSON.stringify(workspace)} is absent.` }
        : {}),
  });

  function addWorkspaceFileInspection(fileParams: {
    sourcePath: string;
    targetPath: string;
    id: string;
    manifestPath: string;
  }): void {
    const normalizedSourcePath = fileParams.sourcePath.replaceAll("\\", "/");
    const result = inspectWorkspaceFileAction({
      source,
      workspace,
      sourcePath: fileParams.sourcePath,
      targetPath: fileParams.targetPath,
      id: fileParams.id,
      manifestPath: fileParams.manifestPath,
      snapshot: workspaceSnapshots.get(normalizedSourcePath),
    });
    const action = result.action;
    action.blocked ||= workspaceExists || workspaceProbeFailed;
    if (workspaceExists) {
      action.reason = `Workspace ${JSON.stringify(workspace)} already exists.`;
    } else if (workspaceProbeFailed) {
      action.reason = `Could not prove that workspace ${JSON.stringify(workspace)} is absent.`;
    }
    actions.push(action);
    workspaceFileActions.push(action);
    if (result.blocker) {
      blockers.push(result.blocker);
    }
  }

  for (const name of CLAW_BOOTSTRAP_FILE_NAMES) {
    const declaration = params.manifest.workspace.bootstrapFiles[name];
    if (!declaration) {
      continue;
    }
    addWorkspaceFileInspection({
      sourcePath: declaration.source,
      targetPath: name,
      id: name,
      manifestPath: `$.workspace.bootstrapFiles.${name}`,
    });
  }
  for (const [index, file] of params.manifest.workspace.files.entries()) {
    addWorkspaceFileInspection({
      sourcePath: file.source,
      targetPath: file.path,
      id: file.path,
      manifestPath: `$.workspace.files[${index}]`,
    });
  }

  const workspaceByteLength = params.snapshot.workspaceSources.reduce(
    (total, snapshot) => total + snapshot.byteLength,
    0,
  );
  if (workspaceByteLength > MAX_MANAGED_WORKSPACE_BYTES) {
    const diagnostic = blocker(
      "workspace_sources_too_large",
      "$.workspace",
      `Workspace sources exceed ${MAX_MANAGED_WORKSPACE_BYTES} aggregate bytes.`,
    );
    blockers.push(diagnostic);
    for (const action of workspaceFileActions) {
      action.blocked = true;
      action.reason = diagnostic.message;
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
          ...("env" in server && server.env
            ? {
                env: Object.entries(server.env)
                  .map(([envName, value]) => ({
                    name: envName,
                    reference: value.slice(2, -1),
                  }))
                  .toSorted((left, right) => left.name.localeCompare(right.name)),
              }
            : {}),
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
