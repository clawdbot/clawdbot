import { resolveAgentDir, resolveAgentWorkspaceDir } from "../agents/agent-scope.js";
import { writeConfigFile } from "../config/config.js";
import { logConfigUpdated } from "../config/logging.js";
import { resolveSessionTranscriptsDirForAgent } from "../config/sessions.js";
import { DEFAULT_AGENT_ID, normalizeAgentId } from "../routing/session-key.js";
import type { RuntimeEnv } from "../runtime.js";
import { defaultRuntime } from "../runtime.js";
import { createClackPrompter } from "../wizard/clack-prompter.js";

import { createQuietRuntime, requireValidConfig } from "./agents.command-shared.js";
import { findAgentEntryIndex, listAgentEntries, pruneAgentConfig } from "./agents.config.js";
import { moveToTrash } from "./onboard-helpers.js";

type AgentsDeleteOptions = {
  id: string;
  force?: boolean;
  json?: boolean;
};

export async function agentsDeleteCommand(
  opts: AgentsDeleteOptions,
  runtime: RuntimeEnv = defaultRuntime,
) {
  const cfg = await requireValidConfig(runtime);
  if (!cfg) return;

  const input = opts.id?.trim();
  if (!input) {
    runtime.error("Agent id is required.");
    runtime.exit(1);
    return;
  }

  const agentId = normalizeAgentId(input);
  if (agentId !== input) {
    runtime.log(`Normalized agent id to "${agentId}".`);
  }
  if (agentId === DEFAULT_AGENT_ID) {
    runtime.error(`"${DEFAULT_AGENT_ID}" cannot be deleted.`);
    runtime.exit(1);
    return;
  }

  if (findAgentEntryIndex(listAgentEntries(cfg), agentId) < 0) {
    runtime.error(`Agent "${agentId}" not found.`);
    runtime.exit(1);
    return;
  }

  if (!opts.force) {
    if (!process.stdin.isTTY) {
      runtime.error("Non-interactive session. Re-run with --force.");
      runtime.exit(1);
      return;
    }
    const prompter = createClackPrompter();
    const confirmed = await prompter.confirm({
      message: `Delete agent "${agentId}" and prune workspace/state?`,
      initialValue: false,
    });
    if (!confirmed) {
      runtime.log("Cancelled.");
      return;
    }
  }

  const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);
  const agentDir = resolveAgentDir(cfg, agentId);
  const sessionsDir = resolveSessionTranscriptsDirForAgent(agentId);

  const result = pruneAgentConfig(cfg, agentId);
  await writeConfigFile(result.config);
  if (!opts.json) logConfigUpdated(runtime);

  const quietRuntime = opts.json ? createQuietRuntime(runtime) : runtime;
  await moveToTrash(workspaceDir, quietRuntime);
  await moveToTrash(agentDir, quietRuntime);
  await moveToTrash(sessionsDir, quietRuntime);

  if (opts.json) {
    runtime.log(
      JSON.stringify(
        {
          agentId,
          workspace: workspaceDir,
          agentDir,
          sessionsDir,
          removedBindings: result.removedBindings,
          removedAllow: result.removedAllow,
        },
        null,
        2,
      ),
    );
  } else {
    runtime.log(`Deleted agent: ${agentId}`);
  }
}
