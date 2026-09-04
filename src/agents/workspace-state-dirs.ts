import os from "node:os";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import { listSessionEntryKeysReadOnly } from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveUserPath } from "../infra/home-dir.js";
import { parseAgentSessionKey } from "../routing/session-key.js";
import { listAgentIds, resolveAgentConfig, resolveAgentWorkspaceDir } from "./agent-scope.js";
import { resolveSandboxConfigForAgent } from "./sandbox/config.js";
import { resolveSandboxRuntimeStatus } from "./sandbox/runtime-status.js";
import { resolveSandboxWorkspaceLayoutPaths } from "./sandbox/shared.js";
import { listAgentWorkspaceDirs } from "./workspace-dirs.js";
import { assertWorkspaceStateMigrationReady } from "./workspace-legacy-state.js";

/** Select configured workspaces and active sandbox copies for migration and readiness. */
export function listWorkspaceStateDirs(params: {
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  homedir: () => string;
  stateDir: string;
}): string[] {
  const dirs = new Set(listAgentWorkspaceDirs(params.cfg, params.env));

  for (const agentId of listAgentIds(params.cfg)) {
    const sandbox = resolveSandboxConfigForAgent(params.cfg, agentId);
    if (sandbox.mode === "off" || sandbox.workspaceAccess === "rw") {
      continue;
    }
    const configuredWorkspaceRoot =
      resolveAgentConfig(params.cfg, agentId)?.sandbox?.workspaceRoot ??
      params.cfg.agents?.defaults?.sandbox?.workspaceRoot;
    const workspaceRoot = resolveUserPath(
      configuredWorkspaceRoot ?? path.join(params.stateDir, "sandboxes"),
      params.env,
      params.homedir,
    );
    if (sandbox.scope === "shared") {
      dirs.add(workspaceRoot);
      continue;
    }
    if (sandbox.scope === "agent") {
      const layout = resolveSandboxWorkspaceLayoutPaths({
        cfg: { ...sandbox, workspaceRoot },
        agentId,
        rawSessionKey: `agent:${agentId}:main`,
        workspaceDir: resolveAgentWorkspaceDir(params.cfg, agentId, params.env),
      });
      dirs.add(layout.sandboxWorkspaceDir);
      continue;
    }

    // Sandbox containers may be pruned while their workspace survives. The
    // agent-owned session store remains the durable authority for that copy.
    const sessionKeys = listSessionEntryKeysReadOnly({
      agentId,
      env: params.env,
      storePath: resolveSessionStorePathCore(params.cfg.session?.store, {
        agentId,
        env: params.env,
      }),
    });
    for (const sessionKey of sessionKeys) {
      const sessionAgentId = parseAgentSessionKey(sessionKey)?.agentId;
      if (sessionAgentId && sessionAgentId !== agentId) {
        continue;
      }
      const runtime = resolveSandboxRuntimeStatus({ cfg: params.cfg, sessionKey, agentId });
      if (!runtime.sandboxed) {
        continue;
      }
      const layout = resolveSandboxWorkspaceLayoutPaths({
        cfg: { ...sandbox, workspaceRoot },
        agentId,
        rawSessionKey: sessionKey,
        workspaceDir: resolveAgentWorkspaceDir(params.cfg, agentId, params.env),
      });
      dirs.add(layout.sandboxWorkspaceDir);
    }
  }

  return [...dirs];
}

/** Refuse completion before channels accept work that a workspace cannot execute. */
export function assertConfiguredWorkspaceStateReady(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
}): void {
  const env = params.env ?? process.env;
  const homedir = os.homedir;
  const workspaceDirs = listWorkspaceStateDirs({
    cfg: params.cfg,
    env,
    homedir,
    stateDir: resolveStateDir(env, homedir),
  });
  assertWorkspaceStateMigrationReady({ workspaceDirs, env, homedir });
}
