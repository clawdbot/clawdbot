import { deliveryContextFromConversation } from "../../../channels/route-projection.js";
import {
  resolveThreadBindingIntroText,
  resolveThreadBindingThreadName,
} from "../../../channels/thread-bindings-messages.js";
import {
  resolveThreadBindingIdleTimeoutMsForChannel,
  resolveThreadBindingMaxAgeMsForChannel,
} from "../../../channels/thread-bindings-policy.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import type { DeliveryContext } from "../../../utils/delivery-context.types.js";
import { summarizeSpawnError } from "../../spawn-pipeline.js";
import { prepareSpawnThreadBinding } from "../../spawn-plan.js";
import { getSessionBindingService } from "./subagent-spawn.runtime.js";
import type { SpawnSubagentMode } from "./subagent-spawn.types.js";

export async function bindThreadForSubagentSpawn(params: {
  cfg: OpenClawConfig;
  childSessionKey: string;
  agentId: string;
  label?: string;
  mode: SpawnSubagentMode;
  requesterSessionKey?: string;
  requester: {
    channel?: string;
    accountId?: string;
    to?: string;
    threadId?: string | number;
  };
}): Promise<
  | { status: "ok"; deliveryOrigin?: DeliveryContext }
  | {
      status: "error";
      error: string;
    }
> {
  const prepared = prepareSpawnThreadBinding({
    cfg: params.cfg,
    kind: "subagent",
    mode: params.mode,
    bindingService: getSessionBindingService(),
    requesterSessionKey: params.requesterSessionKey,
    channel: params.requester.channel,
    accountId: params.requester.accountId,
    to: params.requester.to,
    threadId: params.requester.threadId,
  });
  if (!prepared.ok) {
    return {
      status: "error",
      error: prepared.error,
    };
  }

  try {
    const binding = await getSessionBindingService().bind({
      targetSessionKey: params.childSessionKey,
      targetKind: "subagent",
      conversation: {
        channel: prepared.binding.channel,
        accountId: prepared.binding.accountId,
        conversationId: prepared.binding.conversationId,
        ...(prepared.binding.parentConversationId
          ? { parentConversationId: prepared.binding.parentConversationId }
          : {}),
      },
      placement: prepared.binding.placement,
      metadata: {
        threadName: resolveThreadBindingThreadName({
          agentId: params.agentId,
          label: params.label || params.agentId,
        }),
        agentId: params.agentId,
        label: params.label || undefined,
        boundBy: "system",
        introText: resolveThreadBindingIntroText({
          agentId: params.agentId,
          label: params.label || undefined,
          idleTimeoutMs: resolveThreadBindingIdleTimeoutMsForChannel({
            cfg: params.cfg,
            channel: prepared.binding.channel,
            accountId: prepared.binding.accountId,
          }),
          maxAgeMs: resolveThreadBindingMaxAgeMsForChannel({
            cfg: params.cfg,
            channel: prepared.binding.channel,
            accountId: prepared.binding.accountId,
          }),
        }),
      },
    });
    if (!binding.conversation.conversationId) {
      return {
        status: "error",
        error:
          "Unable to create or bind a thread for this subagent session. Session mode is unavailable for this target.",
      };
    }
    const deliveryOrigin = deliveryContextFromConversation(binding.conversation);
    return {
      status: "ok",
      ...(deliveryOrigin ? { deliveryOrigin } : {}),
    };
  } catch (err) {
    return {
      status: "error",
      error: `Thread bind failed: ${summarizeSpawnError(err)}`,
    };
  }
}

export function hasRoutableDeliveryOrigin(
  origin?: DeliveryContext,
): origin is DeliveryContext & { channel: string; to: string } {
  return Boolean(origin?.channel && origin.to);
}
