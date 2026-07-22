// First-run main-agent creation through the canonical agent service.
import { createAgent } from "../agents/agent-create.js";
import { readConfigFileSnapshot } from "../config/config.js";
import { createMergePatch } from "../config/io.write-prepare.js";
import { applyMergePatch } from "../config/merge-patch.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";

function isInjectedMainRoster(config: OpenClawConfig): boolean {
  const roster = config.agents?.list ?? [];
  return (
    roster.length === 1 &&
    roster[0]?.id === "main" &&
    roster[0]?.default === true &&
    Object.keys(roster[0]).every((key) => key === "id" || key === "default")
  );
}

function mergeOnboardingCandidate(params: {
  base: OpenClawConfig;
  candidate: OpenClawConfig;
  persisted: OpenClawConfig;
}): OpenClawConfig {
  const proposalPatch = createMergePatch(params.base, params.candidate);
  const merged = applyMergePatch(params.persisted, proposalPatch) as OpenClawConfig;
  return {
    ...merged,
    agents: {
      ...merged.agents,
      list: params.persisted.agents?.list,
    },
  };
}

export async function ensureOnboardingAgent(params: {
  config: OpenClawConfig;
  workspace: string;
  preserveCandidateRoster?: boolean;
  baseConfig?: OpenClawConfig;
}): Promise<{ config: OpenClawConfig; agentId: string; bootstrapPending: boolean }> {
  if (
    (params.config.agents?.list?.length ?? 0) > 0 &&
    (params.preserveCandidateRoster || !isInjectedMainRoster(params.config))
  ) {
    const defaultAgent = params.config.agents?.list?.find((entry) => entry.default === true);
    if (!defaultAgent) {
      throw new Error("Onboarding candidate roster has no default agent.");
    }
    return { config: params.config, agentId: defaultAgent.id, bootstrapPending: false };
  }
  const before = await readConfigFileSnapshot();
  if (before.exists && !before.valid) {
    throw new Error("Cannot create the first agent from an invalid OpenClaw config.");
  }
  const base = before.sourceConfig ?? before.config;
  const candidateBase = params.baseConfig ?? base;
  const effective = before.config;
  const existing = effective.agents?.list?.find((entry) => entry.default === true);
  if (before.exists && existing) {
    return {
      config: mergeOnboardingCandidate({
        base: candidateBase,
        candidate: params.config,
        persisted: base,
      }),
      agentId: existing.id,
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
  const persisted = after.sourceConfig ?? after.config;
  return {
    config: mergeOnboardingCandidate({ base: candidateBase, candidate: params.config, persisted }),
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
