// Discord plugin module implements subagent hooks behavior.
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalStringifiedId,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  listThreadBindingsBySessionKey,
  type ThreadBindingTargetKind,
  unbindThreadBindingsBySessionKey,
} from "./monitor/thread-bindings.js";

type DiscordSubagentEndedEvent = {
  targetSessionKey: string;
  accountId?: string;
  targetKind?: ThreadBindingTargetKind;
  reason?: string;
  sendFarewell?: boolean;
};

type DiscordSubagentDeliveryTargetEvent = {
  expectsCompletionMessage?: boolean;
  childSessionKey: string;
  requesterOrigin?: {
    channel?: string;
    accountId?: string;
    threadId?: string | number;
  };
};

type DiscordSubagentDeliveryTargetResult =
  | {
      origin: {
        channel: "discord";
        accountId?: string;
        to: string;
        threadId?: string | number;
      };
    }
  | undefined;

function normalizeThreadBindingTargetKind(raw?: string): ThreadBindingTargetKind | undefined {
  const normalized = normalizeOptionalLowercaseString(raw);
  if (normalized === "subagent" || normalized === "acp") {
    return normalized;
  }
  return undefined;
}

export function handleDiscordSubagentEnded(event: DiscordSubagentEndedEvent) {
  unbindThreadBindingsBySessionKey({
    targetSessionKey: event.targetSessionKey,
    accountId: event.accountId,
    targetKind: normalizeThreadBindingTargetKind(event.targetKind),
    reason: event.reason,
    sendFarewell: event.sendFarewell,
  });
}

export function handleDiscordSubagentDeliveryTarget(
  event: DiscordSubagentDeliveryTargetEvent,
): DiscordSubagentDeliveryTargetResult {
  if (!event.expectsCompletionMessage) {
    return undefined;
  }
  const requesterChannel = normalizeOptionalLowercaseString(event.requesterOrigin?.channel);
  if (requesterChannel !== "discord") {
    return undefined;
  }
  const requesterAccountId = event.requesterOrigin?.accountId?.trim();
  const requesterThreadId =
    event.requesterOrigin?.threadId != null && event.requesterOrigin.threadId !== ""
      ? (normalizeOptionalStringifiedId(event.requesterOrigin.threadId) ?? "")
      : "";
  const bindings = listThreadBindingsBySessionKey({
    targetSessionKey: event.childSessionKey,
    ...(requesterAccountId ? { accountId: requesterAccountId } : {}),
    targetKind: "subagent",
  });
  if (bindings.length === 0) {
    return undefined;
  }

  let binding: (typeof bindings)[number] | undefined;
  if (requesterThreadId) {
    binding = bindings.find((entry) => {
      if (entry.threadId !== requesterThreadId) {
        return false;
      }
      if (requesterAccountId && entry.accountId !== requesterAccountId) {
        return false;
      }
      return true;
    });
  }
  if (!binding && bindings.length === 1) {
    binding = bindings[0];
  }
  if (!binding) {
    return undefined;
  }
  return {
    origin: {
      channel: "discord" as const,
      accountId: binding.accountId,
      to: `channel:${binding.threadId}`,
      threadId: binding.threadId,
    },
  };
}
