import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { listAgentEntries } from "../../../agents/agent-scope-config.js";
import { hasEnvVarRef } from "../../../config/env-preserve.js";
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

function valueContainsEnvVarRef(value: unknown): boolean {
  if (typeof value === "string") {
    return hasEnvVarRef(value);
  }
  if (Array.isArray(value)) {
    return value.some(valueContainsEnvVarRef);
  }
  if (isRecord(value)) {
    return Object.values(value).some(valueContainsEnvVarRef);
  }
  return false;
}

function bindingMatchesChannel(binding: AgentRouteBinding, channelId: string): boolean {
  const match = binding.match;
  if (!isRecord(match)) {
    return false;
  }
  return (
    normalizeRouteBindingChannelId(
      typeof match.channel === "string" ? match.channel : undefined,
    ) === channelId
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
  // Two reasons to leave a channel alone instead of appending a sibling
  // `agentId: defaultAgentId` channel-wide binding:
  // 1. Another binding already routes to the default agent — appending a
  //    literal "main" sibling collides on `agentId` identity and trips
  //    `EnvRefArrayMutationError` in `restoreEnvVarRefs`
  //    (`src/config/env-preserve.ts:472`). Once any `defaultAgentId`
  //    binding exists we refuse to materialize additional ones across any
  //    channel: the matcher would find multiple `incoming` entries that
  //    resolve the same identity and reject the write.
  // 2. Existing bindings carry `${VAR}` references — appending a literal
  //    sibling would let the env-preserve matcher align the literal entry
  //    with the env-bearing one and silently drop the user's authored ref.
  const defaultAgentAlreadyRouted = bindings.some((binding) => binding.agentId === defaultAgentId);
  const materializableChannelBindings: string[] = [];
  const defaultAgentSkippedChannels: string[] = [];
  const envRefSkippedChannels: string[] = [];
  if (canMaterializeBindings) {
    for (const channelId of listAmbientConfiguredChannelIds(cfg)) {
      const channelBindings = bindings.filter((binding) =>
        bindingMatchesChannel(binding, channelId),
      );
      if (channelBindings.some((binding) => isChannelWideBinding(binding, channelId))) {
        continue;
      }
      if (defaultAgentAlreadyRouted) {
        defaultAgentSkippedChannels.push(channelId);
        continue;
      }
      if (channelBindings.some(valueContainsEnvVarRef)) {
        envRefSkippedChannels.push(channelId);
        continue;
      }
      materializableChannelBindings.push(channelId);
    }
  }
  if (materializableChannelBindings.length > 0) {
    next = {
      ...next,
      bindings: [
        ...(Array.isArray(next.bindings) ? next.bindings : []),
        ...materializableChannelBindings.map((channel) => ({
          agentId: defaultAgentId,
          match: { channel, accountId: "*" },
        })),
      ],
    };
    changes.push(
      `Bound ${materializableChannelBindings.join(", ")} unbound account routing to agent "${defaultAgentId}".`,
    );
    if (defaultAgentSkippedChannels.length > 0) {
      changes.push(
        `Skipped ${defaultAgentSkippedChannels.join(", ")}: existing binding already routes to agent "${defaultAgentId}".`,
      );
    }
    if (envRefSkippedChannels.length > 0) {
      changes.push(
        `Skipped ${envRefSkippedChannels.join(", ")}: existing binding uses an environment reference.`,
      );
    }
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
