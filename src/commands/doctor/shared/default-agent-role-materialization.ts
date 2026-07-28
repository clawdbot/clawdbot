import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { listAgentEntries } from "../../../agents/agent-scope-config.js";
import type { AgentRouteBinding } from "../../../config/types.agents.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { normalizeRouteBindingChannelId } from "../../../routing/binding-scope.js";
import { normalizeAgentId } from "../../../routing/session-key.js";
import { isRecord } from "../../../utils.js";

type DefaultAgentRoleMaterialization = {
  config: OpenClawConfig;
  changes: string[];
};

function resolveLegacyMultiAgentDefault(cfg: OpenClawConfig): string | undefined {
  const entries = listAgentEntries(cfg);
  if (entries.length < 2) {
    return undefined;
  }
  const defaults = entries.filter((entry) => entry.default === true);
  return defaults.length === 1 ? normalizeAgentId(defaults[0]!.id) : undefined;
}

function listAmbientConfiguredChannelIds(cfg: OpenClawConfig): string[] {
  if (!isRecord(cfg.channels)) {
    return [];
  }
  return Object.entries(cfg.channels)
    .flatMap(([channelId, value]) => {
      if (channelId === "defaults" || (isRecord(value) && value.enabled === false)) {
        return [];
      }
      const normalized = normalizeRouteBindingChannelId(channelId);
      return normalized ? [normalized] : [];
    })
    .toSorted((left, right) => left.localeCompare(right));
}

function isChannelWideBinding(binding: AgentRouteBinding, channelId: string): boolean {
  const match = binding.match;
  if (!isRecord(match)) {
    return false;
  }
  return (
    normalizeRouteBindingChannelId(
      typeof match.channel === "string" ? match.channel : undefined,
    ) === channelId &&
    (typeof match.accountId === "string" ? match.accountId.trim() : undefined) === "*" &&
    match.peer === undefined &&
    !normalizeOptionalString(typeof match.guildId === "string" ? match.guildId : undefined) &&
    !normalizeOptionalString(typeof match.teamId === "string" ? match.teamId : undefined) &&
    (!Array.isArray(match.roles) || match.roles.length === 0)
  );
}

/**
 * Materialize only ambient roles that currently fall through to a multi-agent default.
 * The marker remains authoritative in H2-0; these explicit targets are preparation for H2-1.
 */
export function materializeDefaultAgentRoles(cfg: OpenClawConfig): DefaultAgentRoleMaterialization {
  const defaultAgentId = resolveLegacyMultiAgentDefault(cfg);
  if (!defaultAgentId) {
    return { config: cfg, changes: [] };
  }

  let next = cfg;
  const changes: string[] = [];
  const canMaterializeBindings = cfg.bindings === undefined || Array.isArray(cfg.bindings);
  const bindings = Array.isArray(cfg.bindings)
    ? cfg.bindings.filter(
        (binding): binding is AgentRouteBinding => isRecord(binding) && binding.type !== "acp",
      )
    : [];
  const missingChannelBindings = canMaterializeBindings
    ? listAmbientConfiguredChannelIds(cfg).filter(
        (channelId) => !bindings.some((binding) => isChannelWideBinding(binding, channelId)),
      )
    : [];
  if (missingChannelBindings.length > 0) {
    next = {
      ...next,
      bindings: [
        ...(Array.isArray(next.bindings) ? next.bindings : []),
        ...missingChannelBindings.map((channel) => ({
          agentId: defaultAgentId,
          match: { channel, accountId: "*" },
        })),
      ],
    };
    changes.push(
      `Bound ${missingChannelBindings.join(", ")} unbound account routing to agent "${defaultAgentId}".`,
    );
  }

  const rawDefaults = (cfg.agents as { defaults?: unknown } | undefined)?.defaults;
  const defaultsConfig = isRecord(rawDefaults) ? rawDefaults : undefined;
  const canMaterializeDefaults = rawDefaults === undefined || defaultsConfig !== undefined;
  const hasPerAgentHeartbeat = listAgentEntries(cfg).some((entry) => Boolean(entry.heartbeat));
  // A shared defaults heartbeat already fans out to every agent. Pinning it here
  // would silently narrow existing multi-agent enrollment to the legacy default.
  if (canMaterializeDefaults && !hasPerAgentHeartbeat && defaultsConfig?.heartbeat === undefined) {
    next = {
      ...next,
      agents: {
        ...next.agents,
        defaults: {
          ...next.agents?.defaults,
          heartbeat: { agentId: defaultAgentId },
        },
      },
    };
    changes.push(`Assigned ambient heartbeat runs to agent "${defaultAgentId}".`);
  }

  const rawSystemAgent = defaultsConfig?.systemAgent;
  const systemAgentConfig = isRecord(rawSystemAgent) ? rawSystemAgent : undefined;
  if (
    canMaterializeDefaults &&
    (rawSystemAgent === undefined || systemAgentConfig !== undefined) &&
    (!systemAgentConfig || !Object.hasOwn(systemAgentConfig, "agentId"))
  ) {
    next = {
      ...next,
      agents: {
        ...next.agents,
        defaults: {
          ...next.agents?.defaults,
          systemAgent: {
            ...next.agents?.defaults?.systemAgent,
            agentId: defaultAgentId,
          },
        },
      },
    };
    changes.push(`Assigned ambient system-agent consults to agent "${defaultAgentId}".`);
  }

  const talkConfig = isRecord(cfg.talk) ? cfg.talk : undefined;
  if (
    (cfg.talk === undefined || talkConfig !== undefined) &&
    (!talkConfig || !Object.hasOwn(talkConfig, "agentId"))
  ) {
    next = {
      ...next,
      talk: { ...talkConfig, agentId: defaultAgentId },
    };
    changes.push(`Assigned ambient Talk sessions to agent "${defaultAgentId}".`);
  }

  return { config: next, changes };
}
