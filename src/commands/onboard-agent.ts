// First-run onboarding agent creation through the canonical agent service.
import {
  createAgent,
  type CreateAgentEntry,
  hasValidRawAgentIdCharacters,
} from "../agents/agent-create.js";
import { resolveAgentDir } from "../agents/agent-scope.js";
import { createAgentIdentityConfig, sanitizeAgentIdentityLine } from "../agents/identity-file.js";
import { readConfigFileSnapshot } from "../config/config.js";
import { createMergePatch } from "../config/io.write-prepare.js";
import { applyMergePatch } from "../config/merge-patch.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { isReservedSystemAgentId } from "../system-agent/agent-id.js";
import { resolveUserPath } from "../utils.js";
import { applyAgentConfig } from "./agents.config.js";

export type StagedOnboardingAgent = {
  agentId: string;
  name: string;
  workspace: string;
  agentDir: string;
};

/** Stage a first roster entry without mutating config or workspace state. */
export function stageOnboardingAgent(params: {
  config: OpenClawConfig;
  name: string;
  workspace: string;
  agentDir?: string;
}): { config: OpenClawConfig; agent?: StagedOnboardingAgent } {
  if ((params.config.agents?.list?.length ?? 0) > 0) {
    return { config: params.config };
  }
  const rawName = params.name.trim();
  if (!rawName) {
    throw new Error("agent name is required");
  }
  if (!hasValidRawAgentIdCharacters(rawName)) {
    throw new Error(`agent name "${rawName}" has no valid id characters`);
  }
  const agentId = normalizeAgentId(rawName);
  if (isReservedSystemAgentId(agentId)) {
    throw new Error(`"${agentId}" is reserved`);
  }
  const name = sanitizeAgentIdentityLine(rawName);
  const workspace = resolveUserPath(params.workspace);
  const agentDir = params.agentDir?.trim()
    ? resolveUserPath(params.agentDir)
    : resolveAgentDir(params.config, agentId);
  const identity = createAgentIdentityConfig({ name }) ?? { name };
  return {
    config: applyAgentConfig(params.config, {
      agentId,
      name,
      workspace,
      agentDir,
      identity,
    }),
    agent: { agentId, name, workspace, agentDir },
  };
}

export async function ensureOnboardingAgent(params: {
  config: OpenClawConfig;
  entry?: CreateAgentEntry;
  name: string;
  workspace: string;
}): Promise<{ config: OpenClawConfig; agentId?: string; bootstrapPending?: boolean }> {
  if ((params.config.agents?.list?.length ?? 0) > 0) {
    return { config: params.config };
  }
  const before = await readConfigFileSnapshot();
  if (before.exists && !before.valid) {
    throw new Error("Cannot create the first agent from an invalid OpenClaw config.");
  }
  const baseConfig = before.exists ? (before.sourceConfig ?? before.config) : {};
  const effectiveConfig = before.exists ? before.config : {};
  const requestedAgentId = normalizeAgentId(params.entry?.id ?? params.name);
  const freshRoster = effectiveConfig.agents?.list ?? [];
  if (freshRoster.length > 0) {
    const existing = freshRoster.find((entry) => normalizeAgentId(entry.id) === requestedAgentId);
    if (existing) {
      return { config: effectiveConfig, agentId: requestedAgentId, bootstrapPending: false };
    }
    throw new Error(
      `Cannot create first agent "${requestedAgentId}" because agent "${freshRoster[0]?.id}" was created concurrently. Retry onboarding with the current roster.`,
    );
  }
  const proposalPatch = createMergePatch(baseConfig, params.config);
  const staged = stageOnboardingAgent({
    config: params.config,
    name: params.name,
    workspace: params.workspace,
  });
  const stagedEntry =
    params.entry ??
    staged.config.agents?.list?.find(
      (entry) => normalizeAgentId(entry.id) === normalizeAgentId(params.name),
    );
  const result = await createAgent({
    ...(stagedEntry ? { entry: stagedEntry } : {}),
    name: params.name,
    workspace: params.workspace,
    skipBootstrap: params.config.agents?.defaults?.skipBootstrap,
    skipOptionalBootstrapFiles: params.config.agents?.defaults?.skipOptionalBootstrapFiles,
  });
  if (result.status === "error") {
    throw new Error(result.message);
  }
  const snapshot = await readConfigFileSnapshot();
  if (!snapshot.valid) {
    throw new Error("Agent creation wrote an invalid OpenClaw config.");
  }
  const persisted = snapshot.sourceConfig ?? snapshot.config;
  const merged = applyMergePatch(persisted, proposalPatch) as OpenClawConfig;
  return {
    config: {
      ...merged,
      agents: {
        ...merged.agents,
        list: persisted.agents?.list,
      },
    },
    agentId: result.agentId,
    bootstrapPending: result.bootstrapPending,
  };
}
