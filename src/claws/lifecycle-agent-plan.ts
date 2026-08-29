// Plans the agent entry for a Claw add without mutating configuration.
import { stableStringify } from "@openclaw/normalization-core";
import { collectChangedPaths } from "../config/config-change-paths.js";
import type { AgentConfig } from "../config/types.agents.js";
import { materializeClawToolProfile } from "./tool-profile-consent.js";
import type {
  ClawAddCapabilityChange,
  ClawAddPlan,
  ClawAddPlanAction,
  ClawDiagnostic,
  ClawManifest,
  ClawOpenClawProfile,
} from "./types.js";

const AGENT_ID_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;
const MAX_CONFLICT_PATHS = 16;

export type ExistingClawAgent = AgentConfig & { id: string; resolvedWorkspace?: string };

function configuredAgent(existing: ExistingClawAgent): AgentConfig & { id: string } {
  const { resolvedWorkspace: _resolvedWorkspace, ...config } = existing;
  return config;
}

function configConflictMessage(existing: AgentConfig, target: AgentConfig): string {
  const paths = new Set<string>();
  collectChangedPaths(existing, target, "", paths);
  const sorted = [...paths].toSorted();
  const shown = sorted.slice(0, MAX_CONFLICT_PATHS);
  const remainder = sorted.length - shown.length;
  return `Existing agent configuration differs at ${shown.join(", ")}${remainder > 0 ? `, and ${remainder} more path${remainder === 1 ? "" : "s"}` : ""}; adoption never reports or overwrites either value.`;
}

export function planClawAgent(params: {
  finalId: string;
  workspace: string;
  manifestAgent: ClawManifest["agent"];
  openClawProfile?: ClawOpenClawProfile;
  reconstructLegacyDynamicToolProfilePlan?: boolean;
  existingAgents?: Iterable<ExistingClawAgent>;
  existingAgentIds?: Iterable<string>;
  managedAgentIds?: Iterable<string>;
  adoptExistingAgent?: boolean;
}): {
  config: ClawAddPlan["agent"]["config"];
  action: ClawAddPlanAction;
  blockers: ClawDiagnostic[];
  capabilityChange?: Omit<
    ClawAddCapabilityChange,
    "classification" | "requiresDistinctConsent" | "digest"
  >;
} {
  const idValid = AGENT_ID_PATTERN.test(params.finalId);
  const existing = [...(params.existingAgents ?? [])].find((agent) => agent.id === params.finalId);
  const existingId =
    existing !== undefined || new Set(params.existingAgentIds ?? []).has(params.finalId);
  const adoptionRequested = params.adoptExistingAgent === true;
  const alreadyManaged = new Set(params.managedAgentIds ?? []).has(params.finalId);
  const existingConfig = existing ? configuredAgent(existing) : undefined;
  const blockers: ClawDiagnostic[] = [];
  if (!idValid) {
    blockers.push({
      level: "error",
      code: "invalid_agent_id",
      phase: "plan",
      path: "$.agent.id",
      message: `Final agent id ${JSON.stringify(params.finalId)} is not a valid portable agent id.`,
    });
  }
  if (existingId && !adoptionRequested) {
    blockers.push({
      level: "error",
      code: "agent_id_collision",
      phase: "plan",
      path: "$.agent.id",
      message: `Agent id ${JSON.stringify(params.finalId)} already exists; Claws never merge into existing agents.`,
    });
  }
  const settings = params.openClawProfile?.agent ?? {};
  const persistedSettings = params.reconstructLegacyDynamicToolProfilePlan
    ? settings
    : materializeClawToolProfile(settings);
  const config: ClawAddPlan["agent"]["config"] = {
    ...params.manifestAgent,
    ...persistedSettings,
    id: params.finalId,
    workspace: params.workspace,
  };
  if (existingConfig && Object.hasOwn(existingConfig, "default")) {
    config.default = existingConfig.default;
  }
  if (adoptionRequested && alreadyManaged) {
    blockers.push({
      level: "error",
      code: "agent_already_managed",
      phase: "plan",
      path: "$.agent.id",
      message: `Agent id ${JSON.stringify(params.finalId)} already has a Claw install record.`,
    });
  } else if (adoptionRequested && !existingConfig) {
    blockers.push({
      level: "error",
      code: "agent_adoption_missing",
      phase: "plan",
      path: "$.agent.id",
      message: `Agent id ${JSON.stringify(params.finalId)} does not exist; adoption requires an existing unmanaged agent.`,
    });
  } else if (
    adoptionRequested &&
    existingConfig &&
    stableStringify(existingConfig) !== stableStringify(config)
  ) {
    blockers.push({
      level: "error",
      code: "agent_config_conflict",
      phase: "plan",
      path: "$.agent",
      message: configConflictMessage(existingConfig, config),
    });
  }
  const effect = {
    ...(settings.sandbox ? { sandbox: settings.sandbox } : {}),
    ...(settings.tools ? { tools: settings.tools } : {}),
    ...(settings.memory ? { memory: settings.memory } : {}),
    ...(settings.heartbeat ? { heartbeat: settings.heartbeat } : {}),
  };
  return {
    config,
    blockers,
    action: {
      kind: "agent",
      id: params.finalId,
      action: adoptionRequested ? "adopt" : "create",
      target: `agents.entries[${JSON.stringify(params.finalId)}]`,
      details: { ...config, expectedState: adoptionRequested ? "present-exact" : "absent" },
      blocked: blockers.length > 0,
    },
    ...(adoptionRequested
      ? {
          capabilityChange: {
            kind: "agent",
            id: params.finalId,
            path: "agent",
            action: "configure",
            reason:
              "The Claw adopts ownership of an exact existing agent configuration without rewriting it.",
            effect: { ...effect, adoptExistingAgent: true },
          },
        }
      : Object.keys(effect).length > 0
        ? {
            capabilityChange: {
              kind: "agent",
              id: params.finalId,
              path: "agent",
              action: "create",
              reason:
                "The new agent declares sandbox, tool, memory-search, or recurring heartbeat capabilities.",
              effect,
            },
          }
        : {}),
  };
}
