// First-run main-agent creation through the canonical agent service.
import { createAgent, validateAgentIdInput } from "../agents/agent-create.js";
import {
  listAgentEntries,
  resolveDefaultAgentId,
  toAgentEntriesRecord,
  tryResolveLegacyCompatibilityAgentId,
} from "../agents/agent-scope-config.js";
import { hasResolvedRosterBeforeMigrations } from "../config/agent-roster-provenance.js";
import { readConfigFileSnapshot } from "../config/config.js";
import { createMergePatch } from "../config/merge-patch.js";
import { applyMergePatch } from "../config/merge-patch.js";
import { migrateLegacyMainSessionKeys } from "../config/sessions/legacy-main-session-migration.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeAgentId } from "../routing/session-key.js";

export type FirstOnboardingAgent = { name: string };

export function validateFirstOnboardingAgentName(value: string | undefined): string | undefined {
  const name = value?.trim();
  if (!name) {
    return "Agent name is required.";
  }
  const validation = validateAgentIdInput(name, { allowBootstrapMain: true });
  return validation.ok ? undefined : `${validation.message}. Choose another name.`;
}

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
  firstAgent?: FirstOnboardingAgent;
  preserveCandidateRoster?: boolean;
  baseConfig?: OpenClawConfig;
}): Promise<{
  config: OpenClawConfig;
  agentId: string;
  bootstrapPending: boolean;
  /**
   * Config hash observed after this helper created the first roster agent.
   * Callers that captured a hash before calling must adopt it for their own
   * commit: the create wrote the file, so their baseline is stale but not
   * foreign, and the optimistic guard would otherwise reject their write.
   */
  configHash?: string;
}> {
  const candidateRoster = listAgentEntries(params.config);
  if (
    candidateRoster.length > 0 &&
    (params.preserveCandidateRoster || !isInjectedMainRoster(params.config))
  ) {
    return {
      config: params.config,
      agentId:
        tryResolveLegacyCompatibilityAgentId(params.config) ?? resolveDefaultAgentId(params.config),
      bootstrapPending: false,
    };
  }
  const before = await readConfigFileSnapshot();
  if (before.exists && !before.valid) {
    throw new Error("Cannot create the first agent from an invalid OpenClaw config.");
  }
  const effective = before.config;
  const candidateBase = params.baseConfig ?? effective;
  if (before.exists && hasResolvedRosterBeforeMigrations(before)) {
    return {
      config: mergeOnboardingCandidate({
        base: candidateBase,
        candidate: params.config,
        currentRuntime: effective,
      }),
      agentId: tryResolveLegacyCompatibilityAgentId(effective) ?? resolveDefaultAgentId(effective),
      bootstrapPending: false,
    };
  }
  const firstAgentName = params.firstAgent?.name.trim() || "main";
  const created = await createAgent({
    entry: {
      id: normalizeAgentId(firstAgentName),
      name: firstAgentName,
      workspace: params.workspace,
    },
    bootstrapMain: normalizeAgentId(firstAgentName) === "main",
    bootstrapFirstAgent: true,
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
  const config = mergeOnboardingCandidate({
    base: candidateBase,
    candidate: params.config,
    currentRuntime: after.config,
  });
  await migrateLegacyMainSessionKeys({ cfg: after.config, mode: "automatic" });
  return {
    config,
    agentId: created.agentId,
    bootstrapPending: created.bootstrapPending,
    ...(after.hash !== undefined ? { configHash: after.hash } : {}),
  };
}
