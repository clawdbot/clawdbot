// Plans the agent entry for a Claw add without mutating configuration.
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

export function planClawAgent(params: {
  finalId: string;
  workspace: string;
  manifestAgent: ClawManifest["agent"];
  openClawProfile?: ClawOpenClawProfile;
  reconstructLegacyDynamicToolProfilePlan?: boolean;
  existingAgentIds?: Iterable<string>;
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
  const blocked = new Set(params.existingAgentIds ?? []).has(params.finalId);
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
  if (blocked) {
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
      action: "create",
      target: `agents.entries[${JSON.stringify(params.finalId)}]`,
      details: { ...config, expectedState: "absent" },
      blocked: blocked || !idValid,
    },
    ...(Object.keys(effect).length > 0
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
