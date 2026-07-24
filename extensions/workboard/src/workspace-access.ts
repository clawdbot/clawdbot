import type { WorkboardWorkspace, WorkboardWorkspaceAccess } from "@openclaw/workboard-contract";
// Workboard workspace access follows the caller's canonical filesystem boundary.
import {
  listAgentIds,
  resolveAgentConfig,
  resolveAgentWorkspaceDir,
  resolveDefaultAgentId,
} from "openclaw/plugin-sdk/agent-runtime";
import type {
  AnyAgentTool,
  OpenClawPluginApi,
  OpenClawPluginToolContext,
} from "openclaw/plugin-sdk/plugin-entry";
import {
  canonicalPathFromExistingAncestor,
  isPathInside,
} from "openclaw/plugin-sdk/security-runtime";

export type { WorkboardWorkspaceAccess } from "@openclaw/workboard-contract";

type WorkboardConfig = NonNullable<OpenClawPluginToolContext["config"]>;
type ResolveSandboxWorkspaceAuthority =
  OpenClawPluginApi["runtime"]["sandbox"]["resolveWorkspaceAuthority"];
type PrepareSandboxWorkspaceAuthority =
  OpenClawPluginApi["runtime"]["sandbox"]["prepareWorkspaceAuthority"];

export const WORKBOARD_TOOL_NAMES = [
  "workboard_list",
  "workboard_create",
  "workboard_link",
  "workboard_read",
  "workboard_claim",
  "workboard_heartbeat",
  "workboard_complete",
  "workboard_attachment_add",
  "workboard_attachment_read",
  "workboard_attachment_delete",
  "workboard_block",
  "workboard_boards",
  "workboard_board_create",
  "workboard_board_archive",
  "workboard_board_delete",
  "workboard_stats",
  "workboard_runs",
  "workboard_specify",
  "workboard_decompose",
  "workboard_notify_subscribe",
  "workboard_notify_list",
  "workboard_notify_events",
  "workboard_notify_advance",
  "workboard_notify_unsubscribe",
  "workboard_promote",
  "workboard_reassign",
  "workboard_reclaim",
  "workboard_dispatch",
  "workboard_release",
  "workboard_comment",
  "workboard_proof",
  "workboard_proof_list",
  "workboard_worker_log",
  "workboard_protocol_violation",
  "workboard_unblock",
  "workboard_move",
] as const;

export const WORKBOARD_REQUIRED_WORKER_TOOLS = [
  "workboard_heartbeat",
  "workboard_complete",
  "workboard_block",
] as const;

export function resolveWorkboardAgentWorkspace(config: WorkboardConfig, agentId?: string): string {
  return resolveAgentWorkspaceDir(config, agentId ?? resolveDefaultAgentId(config));
}

export function resolveConfiguredWorkboardWorkspaceAccess(params: {
  config: WorkboardConfig;
  unrestricted: boolean;
}): WorkboardWorkspaceAccess {
  if (params.unrestricted) {
    return { unrestricted: true };
  }
  return {
    unrestricted: false,
    writable: true,
    roots: listAgentIds(params.config).map((agentId) =>
      resolveAgentWorkspaceDir(params.config, agentId),
    ),
  };
}

export type WorkboardTargetWorkspaceRuntime = {
  sandboxed: boolean;
  workspaceAccess: WorkboardWorkspaceAccess;
  confinementError?: string;
};

export async function resolveAgentWorkboardWorkspaceRuntime(params: {
  config: WorkboardConfig;
  agentId?: string;
  sessionKey: string;
  workspaceDir: string;
  modelProvider?: string;
  modelId?: string;
  prepareSandboxWorkspaceAuthority: PrepareSandboxWorkspaceAuthority;
}): Promise<WorkboardTargetWorkspaceRuntime> {
  const agentId = params.agentId ?? resolveDefaultAgentId(params.config);
  const sandboxRuntime = await params.prepareSandboxWorkspaceAuthority({
    config: params.config,
    agentId,
    confinedToolNames: WORKBOARD_TOOL_NAMES,
    requiredToolNames: WORKBOARD_REQUIRED_WORKER_TOOLS,
    modelProvider: params.modelProvider,
    modelId: params.modelId,
    sessionKey: params.sessionKey,
    workspaceDir: params.workspaceDir,
  });
  return {
    sandboxed: sandboxRuntime.sandboxed,
    workspaceAccess: sandboxRuntime.sandboxed
      ? {
          unrestricted: false,
          roots: [resolveAgentWorkspaceDir(params.config, agentId)],
          writable: sandboxRuntime.workspaceAccess === "rw",
        }
      : { unrestricted: true },
    ...(sandboxRuntime.confinementError
      ? { confinementError: sandboxRuntime.confinementError }
      : {}),
  };
}

export function resolveCommandWorkboardWorkspaceAccess(params: {
  config: WorkboardConfig;
  agentId?: string;
  sessionKey?: string;
  gatewayClientScopes?: readonly string[];
  resolveSandboxWorkspaceAuthority?: ResolveSandboxWorkspaceAuthority;
}): WorkboardWorkspaceAccess {
  if (params.gatewayClientScopes) {
    return resolveConfiguredWorkboardWorkspaceAccess({
      config: params.config,
      unrestricted: params.gatewayClientScopes.includes("operator.admin"),
    });
  }
  const agentId = params.agentId ?? resolveDefaultAgentId(params.config);
  const sandboxRuntime =
    params.sessionKey && params.resolveSandboxWorkspaceAuthority
      ? params.resolveSandboxWorkspaceAuthority({
          config: params.config,
          agentId,
          sessionKey: params.sessionKey,
        })
      : undefined;
  if (sandboxRuntime?.sandboxed) {
    return {
      unrestricted: false,
      roots: [resolveAgentWorkspaceDir(params.config, agentId)],
      writable: sandboxRuntime.workspaceAccess === "rw",
    };
  }
  const workspaceOnly =
    resolveAgentConfig(params.config, agentId)?.tools?.fs?.workspaceOnly ??
    params.config.tools?.fs?.workspaceOnly;
  return workspaceOnly === true
    ? {
        unrestricted: false,
        roots: [resolveAgentWorkspaceDir(params.config, agentId)],
        writable: true,
      }
    : { unrestricted: true };
}

function resolveToolWorkboardWorkspaceAccess(
  context: OpenClawPluginToolContext | undefined,
  resolveSandboxWorkspaceAuthority?: ResolveSandboxWorkspaceAuthority,
): WorkboardWorkspaceAccess {
  if (!context?.sandboxed && context?.fsPolicy?.workspaceOnly !== true) {
    return { unrestricted: true };
  }
  const config = context.runtimeConfig ?? context.getRuntimeConfig?.() ?? context.config;
  const sandboxRuntime =
    context.sandboxed && config && context.sessionKey && resolveSandboxWorkspaceAuthority
      ? resolveSandboxWorkspaceAuthority({
          config,
          agentId: context.agentId,
          sessionKey: context.sessionKey,
        })
      : undefined;
  return {
    unrestricted: false,
    roots: context.workspaceDir ? [context.workspaceDir] : [],
    writable: sandboxRuntime ? sandboxRuntime.workspaceAccess === "rw" : !context.sandboxed,
  };
}

export async function canonicalizeWorkboardWorkspaceAccess(
  access: WorkboardWorkspaceAccess,
): Promise<WorkboardWorkspaceAccess> {
  if (access.unrestricted) {
    return access;
  }
  const roots = Array.from(
    new Set(
      await Promise.all(
        access.roots.map(async (root) => await canonicalPathFromExistingAncestor(root)),
      ),
    ),
  );
  if (roots.length === 0) {
    throw new Error("restricted workspace access has no allowed roots.");
  }
  return { unrestricted: false, roots, writable: access.writable };
}

export function intersectWorkboardWorkspaceAccess(
  left: WorkboardWorkspaceAccess,
  right: WorkboardWorkspaceAccess,
): WorkboardWorkspaceAccess {
  if (left.unrestricted) {
    return right;
  }
  if (right.unrestricted) {
    return left;
  }
  const roots = new Set<string>();
  for (const leftRoot of left.roots) {
    for (const rightRoot of right.roots) {
      if (leftRoot === rightRoot || isPathInside(leftRoot, rightRoot)) {
        roots.add(rightRoot);
      } else if (isPathInside(rightRoot, leftRoot)) {
        roots.add(leftRoot);
      }
    }
  }
  if (roots.size === 0) {
    throw new Error("workspace access does not overlap the card's persisted authority.");
  }
  return {
    unrestricted: false,
    roots: Array.from(roots),
    writable: left.writable && right.writable,
  };
}

async function assertCanonicalWorkboardPathAccess(
  candidate: string,
  access: WorkboardWorkspaceAccess,
): Promise<string> {
  if (access.unrestricted) {
    return candidate;
  }
  for (const root of access.roots) {
    const canonicalRoot = await canonicalPathFromExistingAncestor(root);
    if (isPathInside(canonicalRoot, candidate)) {
      return candidate;
    }
  }
  throw new Error("workspace path is outside the caller's allowed workspaces.");
}

export async function assertCanonicalWorkboardRootAccess(
  candidate: string,
  access: WorkboardWorkspaceAccess,
): Promise<string> {
  if (access.unrestricted) {
    return candidate;
  }
  for (const root of access.roots) {
    const canonicalRoot = await canonicalPathFromExistingAncestor(root);
    if (canonicalRoot === candidate) {
      return candidate;
    }
  }
  throw new Error("workspace path must equal one of the caller's allowed workspace roots.");
}

async function assertPathAllowed(
  value: unknown,
  access: WorkboardWorkspaceAccess,
): Promise<string | undefined> {
  if (typeof value !== "string" || !value.trim()) {
    return undefined;
  }
  const candidate = await canonicalPathFromExistingAncestor(value.trim());
  return await assertCanonicalWorkboardPathAccess(candidate, access);
}

async function assertWorkspaceAllowed(
  value: unknown,
  access: WorkboardWorkspaceAccess,
  options?: { sourceOnly?: boolean },
): Promise<string | undefined> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const workspace = value as Record<string, unknown>;
  if (options?.sourceOnly) {
    return await assertPathAllowed(workspace.sourcePath ?? workspace.path, access);
  }
  await assertPathAllowed(workspace.path, access);
  await assertPathAllowed(workspace.sourcePath, access);
  return undefined;
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function containsWorkboardWorkspaceMutation(value: unknown): boolean {
  const record = readRecord(value);
  if (!record) {
    return false;
  }
  if (Object.hasOwn(record, "workspace") || Object.hasOwn(record, "defaultWorkspace")) {
    return true;
  }
  return (
    containsWorkboardWorkspaceMutation(record.patch) ||
    containsWorkboardWorkspaceMutation(readRecord(record.metadata)?.automation) ||
    (Array.isArray(record.children) &&
      record.children.some((child) => containsWorkboardWorkspaceMutation(child)))
  );
}

export function withWorkboardWorkspaceAccess(
  value: unknown,
  access: WorkboardWorkspaceAccess,
): Record<string, unknown> {
  return { ...withoutWorkboardWorkspaceAccess(value), workspaceAccess: access };
}

export function withoutWorkboardWorkspaceAccess(value: unknown): Record<string, unknown> {
  const record = readRecord(value) ?? {};
  const { workspaceAccess: _untrustedWorkspaceAccess, ...rest } = record;
  return rest;
}

export function withWorkboardDecomposeWorkspaceAccess(
  value: unknown,
  access: WorkboardWorkspaceAccess,
): Record<string, unknown> {
  const record = withoutWorkboardWorkspaceAccess(value);
  return {
    ...record,
    ...(Array.isArray(record.children)
      ? {
          children: record.children.map((child) => withWorkboardWorkspaceAccess(child, access)),
        }
      : {}),
  };
}

export async function assertWorkboardWorkspaceMutationAccess(
  value: unknown,
  access: WorkboardWorkspaceAccess,
): Promise<void> {
  if (access.unrestricted) {
    return;
  }
  const record = readRecord(value);
  if (!record) {
    return;
  }
  // Card creation and decomposition persist only explicit workspace fields;
  // board defaults and parent workspaces are metadata, not inherited inputs.
  await assertWorkspaceAllowed(record.workspace, access);
  await assertWorkspaceAllowed(record.defaultWorkspace, access);

  const patch = readRecord(record.patch);
  if (patch) {
    await assertWorkboardWorkspaceMutationAccess(patch, access);
  }
  const metadata = readRecord(record.metadata);
  const automation = readRecord(metadata?.automation);
  if (automation) {
    await assertWorkboardWorkspaceMutationAccess(automation, access);
  }
  if (Array.isArray(record.children)) {
    for (const child of record.children) {
      await assertWorkboardWorkspaceMutationAccess(child, access);
    }
  }
}

export async function assertWorkboardWorkspaceSourceAccess(
  workspace: WorkboardWorkspace | undefined,
  access: WorkboardWorkspaceAccess,
): Promise<string | undefined> {
  return await assertWorkspaceAllowed(workspace, access, { sourceOnly: true });
}

export function guardWorkboardToolsForWorkspaceAccess(
  tools: AnyAgentTool[],
  context: OpenClawPluginToolContext | undefined,
  resolveSandboxWorkspaceAuthority?: ResolveSandboxWorkspaceAuthority,
): AnyAgentTool[] {
  const workspaceAccess = resolveToolWorkboardWorkspaceAccess(
    context,
    resolveSandboxWorkspaceAuthority,
  );
  return tools.map((tool) => ({
    ...tool,
    execute: async (toolCallId, rawParams, signal, onUpdate) => {
      const canonicalAccess = await canonicalizeWorkboardWorkspaceAccess(workspaceAccess);
      await assertWorkboardWorkspaceMutationAccess(rawParams, canonicalAccess);
      const sanitizedParams = withoutWorkboardWorkspaceAccess(rawParams);
      const constrainedParams =
        tool.name === "workboard_create"
          ? withWorkboardWorkspaceAccess(sanitizedParams, canonicalAccess)
          : tool.name === "workboard_decompose"
            ? withWorkboardDecomposeWorkspaceAccess(sanitizedParams, canonicalAccess)
            : tool.name === "workboard_specify" &&
                containsWorkboardWorkspaceMutation(sanitizedParams)
              ? withWorkboardWorkspaceAccess(sanitizedParams, canonicalAccess)
              : sanitizedParams;
      return await tool.execute(toolCallId, constrainedParams, signal, onUpdate);
    },
  }));
}
