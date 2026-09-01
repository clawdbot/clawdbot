// First-run main-agent creation through the canonical agent service.
import { createAgent, validateAgentIdInput } from "../agents/agent-create.js";
import {
  listAgentEntries,
  resolveAmbientOwnerAgentId,
  toAgentEntriesRecord,
} from "../agents/agent-scope-config.js";
import { hasResolvedRosterBeforeMigrations } from "../config/agent-roster-provenance.js";
import { readConfigFileSnapshot, resolveConfigSnapshotHash } from "../config/config.js";
import { inheritLegacyDefaultAgentId } from "../config/legacy.default-agent-owner.js";
import { createMergePatch, applyMergePatch } from "../config/merge-patch.js";
import { migrateLegacyMainSessionKeys } from "../config/sessions/legacy-main-session-migration.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeAgentId } from "../routing/session-key.js";

export type FirstOnboardingAgent = { name: string };

export function validateFirstOnboardingAgentName(value: string | undefined): string | undefined {
  const name = value?.trim();
  if (!name) {
    return "Agent name is required.";
  }
  const validation = validateAgentIdInput(name);
  return validation.ok ? undefined : `${validation.message}. Choose another name.`;
}

function isInjectedMainRoster(config: OpenClawConfig): boolean {
  const roster = listAgentEntries(config);
  const entry = roster[0];
  // Authored bare main entries are distinguished by snapshot provenance below.
  return (
    roster.length === 1 && entry?.id === "main" && Object.keys(entry).every((key) => key === "id")
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
  return inheritLegacyDefaultAgentId(params.currentRuntime, {
    ...merged,
    agents: {
      ...agents,
      entries: toAgentEntriesRecord(listAgentEntries(params.currentRuntime)),
    },
  });
}

export async function ensureOnboardingAgent(params: {
  config: OpenClawConfig;
  workspace: string;
  firstAgent?: FirstOnboardingAgent;
  preserveCandidateRoster?: boolean;
  baseConfig?: OpenClawConfig;
  expectedConfigHash?: string | null;
}): Promise<{
  config: OpenClawConfig;
  agentId: string;
  bootstrapPending: boolean;
  createdAgent: boolean;
  sessionMigrationWarnings?: string[];
  /**
   * Config hash observed after this helper created the first roster agent.
   * Callers that captured a hash before calling must adopt it for their own
   * commit: the create wrote the file, so their baseline is stale but not
   * foreign, and the optimistic guard would otherwise reject their write.
   */
  configHash?: string;
}> {
  if (params.firstAgent) {
    const validationError = validateFirstOnboardingAgentName(params.firstAgent.name);
    if (validationError) {
      throw new Error(validationError);
    }
  }
  const hasExpectedConfigHash = Object.hasOwn(params, "expectedConfigHash");
  let before = hasExpectedConfigHash ? await readConfigFileSnapshot() : undefined;
  if (before?.exists && !before.valid) {
    throw new Error("Cannot create the first agent from an invalid OpenClaw config.");
  }
  if (before && (resolveConfigSnapshotHash(before) ?? null) !== params.expectedConfigHash) {
    throw new Error("OpenClaw config changed before first-agent creation. Retry setup.");
  }
  // Provider, gateway, and hook proposals can copy config. Restore the reader's
  // owner before returning an existing fleet to the remaining setup effects.
  inheritLegacyDefaultAgentId(params.baseConfig ?? params.config, params.config);
  const candidateRoster = listAgentEntries(params.config);
  if (
    candidateRoster.length > 0 &&
    (params.preserveCandidateRoster || !isInjectedMainRoster(params.config))
  ) {
    return {
      config: params.config,
      agentId: resolveAmbientOwnerAgentId(params.config),
      bootstrapPending: false,
      createdAgent: false,
    };
  }
  before ??= await readConfigFileSnapshot();
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
      agentId: resolveAmbientOwnerAgentId(effective),
      bootstrapPending: false,
      createdAgent: false,
    };
  }
  const firstAgentName = params.firstAgent ? params.firstAgent.name.trim() : "main";
  const created = await createAgent({
    entry: {
      id: normalizeAgentId(firstAgentName),
      name: firstAgentName,
      workspace: params.workspace,
    },
    bootstrapMain: normalizeAgentId(firstAgentName) === "main",
    bootstrapFirstAgent: true,
    ...(hasExpectedConfigHash ? { expectedConfigHash: params.expectedConfigHash } : {}),
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
  if (created.configHash && after.hash !== created.configHash) {
    throw new Error("OpenClaw config changed after first-agent creation. Retry setup.");
  }
  const config = mergeOnboardingCandidate({
    base: candidateBase,
    candidate: params.config,
    currentRuntime: after.config,
  });
  const sessionMigration = await migrateLegacyMainSessionKeys({
    cfg: after.config,
    mode: "automatic",
  });
  const sessionMigrationWarnings =
    sessionMigration.armed && !sessionMigration.complete
      ? [
          `Legacy main-agent session history migration is incomplete${sessionMigration.warnings.length > 0 ? `: ${sessionMigration.warnings.join("; ")}` : ""}. Run \`openclaw doctor --fix\`; OpenClaw will also retry at next startup.`,
        ]
      : [];
  return {
    config,
    agentId: created.agentId,
    bootstrapPending: created.bootstrapPending,
    createdAgent: created.status === "created",
    ...(created.configHash ? { configHash: created.configHash } : {}),
    ...(sessionMigrationWarnings.length > 0 ? { sessionMigrationWarnings } : {}),
  };
}
