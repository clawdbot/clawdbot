import path from "node:path";
import {
  listAgentIds,
  resolveAgentConfig,
  resolveAgentWorkspaceDir,
} from "../agents/agent-scope.js";
import { resolveSandboxConfigForAgent } from "../agents/sandbox/config.js";
import { resolveSandboxRuntimeStatus } from "../agents/sandbox/runtime-status.js";
import { resolveSandboxWorkspaceLayoutPaths } from "../agents/sandbox/shared.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import { listSessionEntryKeysReadOnly } from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { parseAgentSessionKey } from "../routing/session-key.js";
import { resolveUserPath } from "./home-dir.js";

export function listSandboxWorkspaceDirs(params: {
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  homedir: () => string;
  stateDir: string;
}): string[] {
  const dirs = new Set<string>();

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
