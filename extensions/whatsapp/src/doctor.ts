// Whatsapp plugin module implements doctor behavior.
import type {
  ChannelDoctorAdapter,
  ChannelDoctorConfigMutation,
} from "openclaw/plugin-sdk/channel-contract";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  asObjectRecord,
  collectChannelAccountScopes,
} from "openclaw/plugin-sdk/runtime-doctor-migrations";

type AckScope = NonNullable<NonNullable<OpenClawConfig["messages"]>["ackReactionScope"]>;

type LegacyAckSource = {
  path: string;
  account: Record<string, unknown>;
  emoji?: string;
  scope?: AckScope;
  unrepresentableScope: boolean;
};

function resolveLegacyAckScope(ack: Record<string, unknown>): AckScope | undefined {
  const direct = ack.direct !== false;
  const group = ack.group ?? "mentions";
  if (direct) {
    return group === "always" ? "all" : group === "never" ? "direct" : undefined;
  }
  return group === "always"
    ? "group-all"
    : group === "mentions"
      ? "group-mentions"
      : group === "never"
        ? "off"
        : undefined;
}

function resolveDefaultAgentEmoji(cfg: OpenClawConfig): string | undefined {
  const entries = asObjectRecord(asObjectRecord(cfg.agents)?.entries);
  const agents = entries
    ? Object.values(entries).flatMap((value) => {
        const entry = asObjectRecord(value);
        return entry ? [entry] : [];
      })
    : [];
  const agent = agents.find((entry) => entry.default === true) ?? agents[0];
  const emoji = asObjectRecord(agent?.identity)?.emoji;
  return typeof emoji === "string" ? emoji : undefined;
}

export function normalizeCompatibilityConfig({
  cfg,
}: {
  cfg: OpenClawConfig;
}): ChannelDoctorConfigMutation {
  const changes: string[] = [];
  const sources: LegacyAckSource[] = [];
  for (const scope of collectChannelAccountScopes({ cfg, channelId: "whatsapp" })) {
    const ack = asObjectRecord(scope.account.ackReaction);
    if (!ack) {
      continue;
    }
    sources.push({
      path: `${scope.prefix}.ackReaction`,
      account: scope.account,
      ...(typeof ack.emoji === "string" ? { emoji: ack.emoji } : {}),
      scope: resolveLegacyAckScope(ack),
      unrepresentableScope: ack.direct !== false && (ack.group ?? "mentions") === "mentions",
    });
  }
  if (sources.length === 0) {
    return { config: cfg, changes };
  }

  const messages = (cfg.messages ??= {});
  const identityEmoji = resolveDefaultAgentEmoji(cfg) ?? "👀";
  for (const source of sources) {
    messages.ackReaction ??= source.emoji ?? identityEmoji;
    messages.ackReactionScope ??= source.scope;
    delete source.account.ackReaction;
    changes.push(`Moved translatable ${source.path} settings to messages ack settings.`);
  }

  const finalEmoji = messages.ackReaction!.trim();
  const finalScope = messages.ackReactionScope ?? "group-mentions";
  const comparableFinalScope = finalScope === "none" ? "off" : finalScope;
  for (const source of sources) {
    // The v2026.7.1 resolver returned explicit emoji.trim(), including "".
    // Only an omitted emoji used the routed agent identity fallback.
    const sourceEmoji = source.emoji?.trim();
    if (source.emoji === undefined) {
      changes.push(
        `${source.path} used a route-dependent agent identity acknowledgement emoji before migration; the final messages.ackReaction is ${JSON.stringify(finalEmoji)}. Review messages.ackReaction.`,
      );
    } else if (sourceEmoji !== finalEmoji) {
      changes.push(
        `${source.path} requested acknowledgement emoji ${JSON.stringify(sourceEmoji)}, but the final messages.ackReaction is ${JSON.stringify(finalEmoji)}. Review messages.ackReaction.`,
      );
    }
    if (source.unrepresentableScope) {
      changes.push(
        `${source.path} migration cannot preserve both direct-message and mentioned-group acknowledgements; the final messages.ackReactionScope is ${JSON.stringify(finalScope)}. Review messages.ackReactionScope.`,
      );
    } else if (source.scope && source.scope !== comparableFinalScope) {
      changes.push(
        `${source.path} requested acknowledgement scope ${JSON.stringify(source.scope)}, but the final messages.ackReactionScope is ${JSON.stringify(finalScope)}. Review messages.ackReactionScope.`,
      );
    }
  }
  return { config: cfg, changes };
}

export const whatsappDoctor: ChannelDoctorAdapter = {
  normalizeCompatibilityConfig,
};
