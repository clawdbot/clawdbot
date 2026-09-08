import fs from "node:fs/promises";
import { resolveUserPath } from "../utils.js";
import { resolveSessionAgentIds } from "./agent-scope.js";
import type { EmbeddedRunAttemptParams } from "./embedded-agent-runner/run/types.js";
import { resolveSandboxContext } from "./sandbox.js";
import { resolveEffectiveToolFsWorkspaceOnly } from "./tool-fs-policy.js";

export type WorkspaceSandboxParams = Pick<
  EmbeddedRunAttemptParams,
  | "agentId"
  | "config"
  | "cwd"
  | "execOverrides"
  | "permissionMode"
  | "sandboxSessionKey"
  | "sandboxAgentId"
  | "sessionId"
  | "sessionKey"
  | "sessionRoot"
  | "skillsSnapshot"
  | "requireWritableSandbox"
  | "requireWorkspaceOnly"
  | "workspaceDir"
>;

/** Resolves the shared workspace and sandbox policy used by native and plugin harnesses. */
export async function resolveAttemptWorkspaceSandbox(params: WorkspaceSandboxParams) {
  const { sessionAgentId } = resolveSessionAgentIds({
    sessionKey: params.sessionKey,
    config: params.config,
    agentId: params.agentId,
  });
  const resolvedWorkspace = resolveUserPath(params.workspaceDir);
  await fs.mkdir(resolvedWorkspace, { recursive: true });
  const sessionKey = params.sessionKey?.trim() || params.sessionId;
  const sandboxSessionKey = params.sandboxSessionKey?.trim() || sessionKey;
  const sandbox = await resolveSandboxContext({
    config: params.config,
    // Independent policy sessions keep their own owner; unscoped execution retains its prepared one.
    agentId:
      params.sandboxAgentId ?? (sandboxSessionKey === sessionKey ? sessionAgentId : undefined),
    execOverrides: params.execOverrides,
    sessionKey: sandboxSessionKey,
    skillsSnapshot: params.skillsSnapshot,
    workspaceDir: resolvedWorkspace,
  });
  const effectiveWorkspace =
    sandbox?.enabled && sandbox.workspaceAccess !== "rw" ? sandbox.workspaceDir : resolvedWorkspace;
  if (params.requireWritableSandbox && sandbox?.enabled && sandbox.workspaceAccess !== "rw") {
    throw new Error("sandbox workspace is not read-write; collection review skipped");
  }
  const requestedCwd = params.cwd ? resolveUserPath(params.cwd) : undefined;
  // Recorded roots pin worktree/explicit-cwd boundaries; rootless sessions use
  // the agent's canonical workspace as their permission boundary.
  const sessionPermissionRoot = params.sessionRoot ?? (await fs.realpath(resolvedWorkspace));
  const sessionPermissionPolicy = params.permissionMode
    ? {
        root: sessionPermissionRoot,
        mode: params.permissionMode,
      }
    : undefined;
  if (sandbox?.enabled && requestedCwd && requestedCwd !== resolvedWorkspace) {
    throw new Error(
      "cwd override is not supported for sandboxed embedded agent runs; omit cwd or use the agent workspace as cwd",
    );
  }
  await fs.mkdir(effectiveWorkspace, { recursive: true });
  return {
    effectiveCwd: sandbox?.enabled ? effectiveWorkspace : (requestedCwd ?? effectiveWorkspace),
    effectiveFsWorkspaceOnly:
      params.requireWorkspaceOnly === true ||
      resolveEffectiveToolFsWorkspaceOnly({
        cfg: params.config,
        agentId: sessionAgentId,
      }),
    effectiveWorkspace,
    resolvedWorkspace,
    sessionPermissionRoot,
    sessionPermissionPolicy,
    sandbox,
    sandboxSessionKey,
    sessionAgentId,
  };
}
