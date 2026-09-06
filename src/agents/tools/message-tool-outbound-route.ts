import { normalizeOptionalStringifiedId } from "@openclaw/normalization-core/string-coerce";
import type { ChatType } from "../../channels/chat-type.js";
import { getChannelPlugin } from "../../channels/plugins/index.js";
import type { ChannelMessageActionName } from "../../channels/plugins/types.public.js";
import { resolveActionDeliveryTargetAlias } from "../../infra/outbound/message-action-spec.js";
import { normalizeMessageChannel } from "../../utils/message-channel.js";
import { buildTurnSendTargetKey } from "./turn-send-ledger.js";

// Canonical, stable route string for one outbound action: `${channel}\0${account}\0${target}`,
// with the current source resolved to its concrete target and multi-target sends bailing to
// undefined. Shared by the poll-vote-echo guard and the per-turn send ledger so both
// key on the same normalized destination as conversations_send does for the same peer.
// Returns undefined when the route cannot be resolved to a single destination.
export function resolveOutboundActionRoute(params: {
  action: ChannelMessageActionName;
  args: Record<string, unknown>;
  channel?: string | null;
  accountId?: string;
  currentChannelId?: string;
  currentChatType?: ChatType;
  currentMessagingTarget?: string;
}): string | undefined {
  const channel = normalizeMessageChannel(params.channel);
  if (!channel) {
    return undefined;
  }
  let deliveryAliasTarget: string | undefined;
  try {
    deliveryAliasTarget = resolveActionDeliveryTargetAlias(params.action, params.args, {
      channel,
      aliasSpec: getChannelPlugin(channel)?.actions?.messageActionTargetAliases?.[params.action],
    });
  } catch {
    return undefined;
  }
  const targets = ["target", "to", "channelId"]
    .map((key) => normalizeOptionalStringifiedId(params.args[key]))
    .concat(deliveryAliasTarget ?? [])
    .filter((value): value is string => Boolean(value));
  if (new Set(targets).size > 1) {
    return undefined;
  }
  const target = targets[0];
  const currentTargets = new Set(
    [params.currentMessagingTarget, params.currentChannelId].filter((value): value is string =>
      Boolean(value),
    ),
  );
  // Plugin-declared aliases keep owner-specific target fields out of core. A no-target
  // or current-source send resolves to the concrete current target so it shares one
  // ledger slot with conversations_send to the same peer; fail open when that target is
  // unknown, mirroring the multi-target bail. Provider/account keys prevent cross-send suppression.
  const currentSourceTarget = params.currentMessagingTarget ?? params.currentChannelId;
  const routeTarget = !target || currentTargets.has(target) ? currentSourceTarget : target;
  if (!routeTarget) {
    return undefined;
  }
  return buildTurnSendTargetKey({ channel, accountId: params.accountId, target: routeTarget });
}
