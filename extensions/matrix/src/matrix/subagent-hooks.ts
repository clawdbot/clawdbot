// Matrix plugin module implements subagent hooks behavior.
import { getSessionBindingService } from "openclaw/plugin-sdk/conversation-binding-runtime";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  getMatrixThreadBindingManager,
  listAllBindings,
  listBindingsForAccount,
  removeBindingRecord,
  resolveBindingKey,
} from "./thread-bindings-shared.js";

type MatrixSubagentEndedEvent = {
  targetSessionKey: string;
  targetKind: string;
  accountId?: string;
  reason?: string;
  sendFarewell?: boolean;
};

type MatrixSubagentDeliveryTargetEvent = {
  childSessionKey: string;
  requesterOrigin?: {
    channel?: string;
    accountId?: string;
    to?: string;
    threadId?: string | number;
  };
  expectsCompletionMessage: boolean;
};

type MatrixDeliveryOrigin = {
  channel: "matrix";
  accountId: string;
  to: string;
  threadId?: string;
};

type DeliveryTargetResult = {
  origin: MatrixDeliveryOrigin;
};

export async function handleMatrixSubagentEnded(event: MatrixSubagentEndedEvent): Promise<void> {
  const accountId = normalizeOptionalString(event.accountId) || undefined;
  // Use the targeted account list when available; fall back to a full scan
  // so bindings are cleaned up even when accountId is absent.
  const candidates = accountId ? listBindingsForAccount(accountId) : listAllBindings();
  const matching = candidates.filter(
    (entry) => entry.targetSessionKey === event.targetSessionKey && entry.targetKind === "subagent",
  );
  const removedBindingKeys = new Set<string>();
  if (event.sendFarewell) {
    const bindingService = getSessionBindingService();
    const reason = normalizeOptionalString(event.reason) || "subagent-ended";
    for (const binding of matching) {
      const bindingId = resolveBindingKey(binding);
      const removed = await bindingService.unbind({
        bindingId,
        reason,
        scope: { channel: "matrix", accountId: binding.accountId },
      });
      if (removed.some((entry) => entry.bindingId === bindingId)) {
        removedBindingKeys.add(bindingId);
      }
    }
  }

  const affectedAccountIds = new Set<string>();
  for (const binding of matching) {
    if (removedBindingKeys.has(resolveBindingKey(binding))) {
      continue;
    }
    if (removeBindingRecord(binding)) {
      affectedAccountIds.add(binding.accountId);
    }
  }
  // Flush each affected account's manager so removals are persisted to disk.
  for (const acctId of affectedAccountIds) {
    const manager = getMatrixThreadBindingManager(acctId);
    await manager?.persist();
  }
}

export function handleMatrixSubagentDeliveryTarget(
  event: MatrixSubagentDeliveryTargetEvent,
): DeliveryTargetResult | undefined {
  if (!event.expectsCompletionMessage) {
    return undefined;
  }
  const requesterChannel = event.requesterOrigin?.channel?.trim().toLowerCase();
  if (requesterChannel !== "matrix") {
    return undefined;
  }

  const requesterAccountId = normalizeOptionalString(event.requesterOrigin?.accountId);
  const requesterThreadId =
    event.requesterOrigin?.threadId != null && event.requesterOrigin.threadId !== ""
      ? String(event.requesterOrigin.threadId).trim()
      : "";

  // Search the targeted account when available; otherwise scan all accounts.
  const candidates = requesterAccountId
    ? listBindingsForAccount(requesterAccountId)
    : listAllBindings();
  const bindings = candidates.filter(
    (entry) => entry.targetSessionKey === event.childSessionKey && entry.targetKind === "subagent",
  );
  if (bindings.length === 0) {
    return undefined;
  }

  let binding: (typeof bindings)[number] | undefined;
  if (requesterThreadId) {
    binding = bindings.find(
      (entry) =>
        entry.conversationId === requesterThreadId &&
        (!requesterAccountId || entry.accountId === requesterAccountId),
    );
  }
  if (!binding && bindings.length === 1) {
    binding = bindings[0];
  }
  if (!binding) {
    return undefined;
  }

  const roomId = binding.parentConversationId ?? binding.conversationId;
  const threadId =
    binding.parentConversationId && binding.parentConversationId !== binding.conversationId
      ? binding.conversationId
      : undefined;

  return {
    origin: {
      channel: "matrix",
      accountId: binding.accountId,
      to: `room:${roomId}`,
      ...(threadId ? { threadId } : {}),
    },
  };
}
