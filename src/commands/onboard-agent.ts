// First-run main-agent creation through the canonical agent service.
import { createAgent } from "../agents/agent-create.js";
import {
  listAgentEntries,
  resolveDefaultAgentId,
  toAgentEntriesRecord,
} from "../agents/agent-scope-config.js";
import { readConfigFileSnapshot } from "../config/config.js";
import { createMergePatch } from "../config/io.write-prepare.js";
import { applyMergePatch } from "../config/merge-patch.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";

function isInjectedMainRoster(config: OpenClawConfig): boolean {
  const roster = listAgentEntries(config);
  const entry = roster[0];
  return (
    roster.length === 1 &&
    entry?.id === "main" &&
    entry?.default === true &&
    Object.keys(entry).every((key) => key === "id" || key === "default")
  );
}

function mergeOnboardingCandidate(params: {
  base: OpenClawConfig;
  candidate: OpenClawConfig;
  currentRuntime: OpenClawConfig;
}): OpenClawConfig {
  const proposalPatch = createMergePatch(params.base, params.candidate);
  // Keep this runtime-shaped. The canonical config writer projects only this
  // patch onto snapshot.parsed, preserving include ownership and env refs.
  const merged = applyMergePatch(params.currentRuntime, proposalPatch) as OpenClawConfig;
  const { list: _legacyList, ...agents } = merged.agents ?? {};
  return {
    ...merged,
    agents: {
      ...agents,
      entries: toAgentEntriesRecord(listAgentEntries(params.currentRuntime)),
    },
  };
}

export async function ensureOnboardingAgent(params: {
  config: OpenClawConfig;
  workspace: string;
  preserveCandidateRoster?: boolean;
  baseConfig?: OpenClawConfig;
}): Promise<{ config: OpenClawConfig; agentId: string; bootstrapPending: boolean }> {
  const candidateRoster = listAgentEntries(params.config);
  if (
    candidateRoster.length > 0 &&
    (params.preserveCandidateRoster || !isInjectedMainRoster(params.config))
  ) {
    return {
      config: params.config,
      agentId: resolveDefaultAgentId(params.config),
      bootstrapPending: false,
    };
  }
  const before = await readConfigFileSnapshot();
  if (before.exists && !before.valid) {
    throw new Error("Cannot create the first agent from an invalid OpenClaw config.");
  }
  const effective = before.config;
  const candidateBase = params.baseConfig ?? effective;
  if (before.exists && listAgentEntries(effective).length > 0) {
    return {
      config: mergeOnboardingCandidate({
        base: candidateBase,
        candidate: params.config,
        currentRuntime: effective,
      }),
      agentId: resolveDefaultAgentId(effective),
      bootstrapPending: false,
    };
  }
  const created = await createAgent({
    entry: {
      id: "main",
      name: "main",
      default: true,
      workspace: params.workspace,
    },
    skipBootstrap: params.config.agents?.defaults?.skipBootstrap,
    skipOptionalBootstrapFiles: params.config.agents?.defaults?.skipOptionalBootstrapFiles,
  });
  if (created.status === "error") {
    throw new Error(created.message);
  }
  const after = await readConfigFileSnapshot();
  if (!after.valid) {
    throw new Error("Agent creation wrote an invalid OpenClaw config.");
  }
  return {
    config: mergeOnboardingCandidate({
      base: candidateBase,
      candidate: params.config,
      currentRuntime: after.config,
    }),
    agentId: created.agentId,
    bootstrapPending: created.bootstrapPending,
  };
}

export function ensureOnboardingConfig(
  config: OpenClawConfig,
  workspace: string,
  preserveCandidateRoster = false,
  baseConfig?: OpenClawConfig,
) {
  return ensureOnboardingAgent({ config, workspace, preserveCandidateRoster, baseConfig });
}
