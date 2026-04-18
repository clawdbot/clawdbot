import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk/account-id";
import {
  getSessionBindingService,
  type SessionBindingRecord,
} from "openclaw/plugin-sdk/conversation-binding-runtime";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { findMatrixAccountConfig, resolveMatrixBaseConfig } from "./account-config.js";
import { resolveMatrixTargetIdentity } from "./target-ids.js";
import {
  getMatrixThreadBindingManager,
  listAllBindings,
  listBindingsForAccount,
  removeBindingRecord,
  resolveBindingKey,
} from "./thread-bindings-shared.js";

type MatrixSubagentSpawningEvent = {
  threadRequested: boolean;
  requester?: {
    channel?: string;
    accountId?: string;
    to?: string;
    threadId?: string | number;
  };
  childSessionKey: string;
  agentId: string;
  label?: string;
};

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

type SpawningResult =
  | {
      status: "ok";
      threadBindingReady?: boolean;
      deliveryOrigin?: MatrixDeliveryOrigin;
    }
  | { status: "error"; error: string };

type DeliveryTargetResult = {
  origin: MatrixDeliveryOrigin;
};

function summarizeError(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  if (typeof err === "string") {
    return err;
  }
  return "error";
}

function resolveThreadBindingFlags(
  api: OpenClawPluginApi,
  accountId?: string,
): { enabled: boolean; spawnSubagentSessions: boolean } {
  const matrix = resolveMatrixBaseConfig(api.config);
  const baseThreadBindings = matrix.threadBindings;
  const accountThreadBindings = accountId
    ? findMatrixAccountConfig(api.config, accountId)?.threadBindings
    : undefined;
  return {
    enabled:
      accountThreadBindings?.enabled ??
      baseThreadBindings?.enabled ??
      api.config.session?.threadBindings?.enabled ??
      true,
    spawnSubagentSessions:
      accountThreadBindings?.spawnSubagentSessions ??
      baseThreadBindings?.spawnSubagentSessions ??
      false,
  };
}

function resolveMatrixBindingThreadId(binding: SessionBindingRecord): string | undefined {
  const { conversationId, parentConversationId } = binding.conversation;
  return parentConversationId && parentConversationId !== conversationId
    ? conversationId
    : undefined;
}

function resolveMatrixBindingDeliveryOrigin(
  binding: SessionBindingRecord,
  fallbackAccountId: string,
): MatrixDeliveryOrigin {
  const boundRoomId =
    binding.conversation.parentConversationId ?? binding.conversation.conversationId;
  const threadId = resolveMatrixBindingThreadId(binding);
  return {
    channel: "matrix",
    accountId: binding.conversation.accountId ?? fallbackAccountId,
    to: `room:${boundRoomId}`,
    ...(threadId ? { threadId } : {}),
  };
}

export async function handleMatrixSubagentSpawning(
  api: OpenClawPluginApi,
  event: MatrixSubagentSpawningEvent,
): Promise<SpawningResult | undefined> {
  if (!event.threadRequested) {
    return undefined;
  }
  const channel = event.requester?.channel?.trim().toLowerCase();
  if (channel !== "matrix") {
    return undefined;
  }

  // Normalize early so per-account config and manager lookup use the same id.
  // Falls back to DEFAULT_ACCOUNT_ID so accounts.default.threadBindings.* is
  // respected even when the requester omits accountId.
  const accountId = normalizeOptionalString(event.requester?.accountId) || DEFAULT_ACCOUNT_ID;
  const flags = resolveThreadBindingFlags(api, accountId);

  if (!flags.enabled) {
    return {
      status: "error",
      error:
        "Matrix thread bindings are disabled (set channels.matrix.threadBindings.enabled=true to override for this account, or session.threadBindings.enabled=true globally).",
    } satisfies SpawningResult;
  }
  if (!flags.spawnSubagentSessions) {
    return {
      status: "error",
      error:
        "Matrix thread-bound subagent spawns are disabled for this account (set channels.matrix.threadBindings.spawnSubagentSessions=true to enable).",
    };
  }

  // Resolve the raw Matrix room ID from the requester's `to` field
  // (e.g. "room:!abc123:example.org" → "!abc123:example.org").
  const rawTo = normalizeOptionalString(event.requester?.to) ?? "";
  const matrixTarget = rawTo ? resolveMatrixTargetIdentity(rawTo) : null;
  const roomId = matrixTarget?.kind === "room" ? matrixTarget.id : "";

  if (!roomId) {
    return {
      status: "error",
      error:
        "Cannot create Matrix thread binding: no room target in spawn request (requester.to must be a Matrix room ID).",
    };
  }

  // Verify the thread binding manager is running for this account. The manager
  // holds the captured Matrix client the SessionBindingAdapter needs to send
  // the intro message that bootstraps the thread.
  const manager = getMatrixThreadBindingManager(accountId);
  if (!manager) {
    return {
      status: "error",
      error: `No Matrix thread binding manager available for account "${accountId}". Is the Matrix channel running?`,
    };
  }

  try {
    // placement="child" tells the Matrix SessionBindingAdapter to:
    // 1. Send an intro message to the room, creating a new thread root event
    // 2. Use the returned event ID as boundConversationId (the thread ID)
    // 3. Register the binding record in the in-memory store and persist it
    //
    // We do NOT call setBindingRecord here — the adapter's bind() handles
    // record creation, thread creation, and persistence atomically.
    const binding = await getSessionBindingService().bind({
      targetSessionKey: event.childSessionKey,
      targetKind: "subagent",
      conversation: {
        channel: "matrix",
        accountId,
        conversationId: roomId,
      },
      placement: "child",
      metadata: {
        agentId: event.agentId?.trim() || undefined,
        label: normalizeOptionalString(event.label) || undefined,
        boundBy: "system",
      },
    });
    return {
      status: "ok",
      threadBindingReady: true,
      deliveryOrigin: resolveMatrixBindingDeliveryOrigin(binding, accountId),
    } satisfies SpawningResult;
  } catch (err) {
    return {
      status: "error",
      error: `Matrix thread bind failed: ${summarizeError(err)}`,
    };
  }
}

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
      const removed = await bindingService.unbind({ bindingId, reason });
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
