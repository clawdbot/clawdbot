import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { resolveAgentWorkspaceDir } from "../../agents/agent-scope.js";
import { ensureAgentWorkspace } from "../../agents/workspace.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { ensureSessionDiffBaseline } from "../../sessions/session-diff-baseline.js";
import { sessionLog } from "./sessions-shared.js";

async function prepareSessionDiffBaseline(params: {
  agentId: string;
  cfg: OpenClawConfig;
  entry: SessionEntry;
  sessionKey: string;
  storePath: string;
}): Promise<SessionEntry> {
  const workspace = await ensureAgentWorkspace({
    dir: resolveAgentWorkspaceDir(params.cfg, params.agentId),
    ensureBootstrapFiles: !params.cfg.agents?.defaults?.skipBootstrap,
    skipOptionalBootstrapFiles: params.cfg.agents?.defaults?.skipOptionalBootstrapFiles,
  });
  return await ensureSessionDiffBaseline({
    cwd:
      normalizeOptionalString(params.entry.spawnedCwd) ??
      normalizeOptionalString(params.entry.spawnedWorkspaceDir) ??
      workspace.dir,
    entry: params.entry,
    force: true,
    isNewSession: true,
    sessionKey: params.sessionKey,
    storePath: params.storePath,
  });
}

export async function captureCreatedSessionDiffBaseline(params: {
  agentId: string;
  cfg: OpenClawConfig;
  entry: SessionEntry;
  key: string;
  storePath: string;
}): Promise<void> {
  try {
    Object.assign(
      params.entry,
      await prepareSessionDiffBaseline({
        agentId: params.agentId,
        cfg: params.cfg,
        entry: params.entry,
        sessionKey: params.key,
        storePath: params.storePath,
      }),
    );
  } catch (error) {
    sessionLog.warn(
      `session diff baseline capture failed for ${params.key}: ${formatErrorMessage(error)}`,
    );
  }
}
