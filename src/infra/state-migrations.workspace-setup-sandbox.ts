import { listAgentIds, resolveAgentWorkspaceDir } from "../agents/agent-scope.js";
import { resolveSandboxConfigForAgent } from "../agents/sandbox/config.js";
import { readRegisteredSandboxScopeKeys } from "../agents/sandbox/registry.js";
import { resolveSandboxRuntimeStatus } from "../agents/sandbox/runtime-status.js";
import { resolveSandboxWorkspaceLayoutPaths } from "../agents/sandbox/shared.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveUserPath } from "./home-dir.js";

export function listSandboxWorkspaceDirs(params: {
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  homedir: () => string;
}): string[] {
  const dirs = new Set<string>();
  let registeredScopeKeys: string[] | undefined;

  for (const agentId of listAgentIds(params.cfg)) {
    const sandbox = resolveSandboxConfigForAgent(params.cfg, agentId);
    if (sandbox.mode === "off" || sandbox.workspaceAccess === "rw") {
      continue;
    }
    const workspaceRoot = resolveUserPath(sandbox.workspaceRoot, params.env, params.homedir);
    if (sandbox.scope === "shared") {
      dirs.add(workspaceRoot);
      continue;
    }
    if (sandbox.scope === "agent") {
      const layout = resolveSandboxWorkspaceLayoutPaths({
        cfg: { ...sandbox, workspaceRoot },
        rawSessionKey: `agent:${agentId}:main`,
        workspaceDir: resolveAgentWorkspaceDir(params.cfg, agentId, params.env),
      });
      dirs.add(layout.sandboxWorkspaceDir);
      continue;
    }

    // Directory slugs erase agent/session boundaries; only the SQLite runtime
    // registry can prove that a session copy belongs to an active sandbox.
    registeredScopeKeys ??= readRegisteredSandboxScopeKeys();
    for (const sessionKey of registeredScopeKeys) {
      const runtime = resolveSandboxRuntimeStatus({ cfg: params.cfg, sessionKey });
      if (!runtime.sandboxed || runtime.agentId !== agentId) {
        continue;
      }
      const layout = resolveSandboxWorkspaceLayoutPaths({
        cfg: { ...sandbox, workspaceRoot },
        rawSessionKey: sessionKey,
        workspaceDir: resolveAgentWorkspaceDir(params.cfg, agentId, params.env),
      });
      dirs.add(layout.sandboxWorkspaceDir);
    }
  }

  return [...dirs];
}
