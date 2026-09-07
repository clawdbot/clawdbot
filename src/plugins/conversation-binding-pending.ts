import { resolveGlobalMap } from "../shared/global-singleton.js";
import type { PluginConversationBindingResolvedEvent } from "./conversation-binding.types.js";

export type PendingPluginBindingRequest = PluginConversationBindingResolvedEvent["request"] & {
  id: string;
  pluginId: string;
  pluginName?: string;
  pluginRoot: string;
};

type PendingPluginBindingRequestEntry = {
  request: PendingPluginBindingRequest;
  expiresAtMs: number;
  timeoutId: ReturnType<typeof setTimeout>;
};

// Chat approvals get the exec-style 30-minute decision window, with abandoned payloads capped.
const PENDING_PLUGIN_BINDING_REQUEST_TTL_MS = 30 * 60_000;
const MAX_PENDING_PLUGIN_BINDING_REQUESTS = 512;
const pendingRequests = resolveGlobalMap<string, PendingPluginBindingRequestEntry>(
  Symbol.for("openclaw.pluginBindingPendingRequests"),
  (requests) => {
    for (const entry of requests.values()) {
      clearTimeout(entry.timeoutId);
    }
    requests.clear();
  },
);

function removePendingPluginBindingRequest(
  approvalId: string,
  expected?: PendingPluginBindingRequestEntry,
): void {
  const entry = pendingRequests.get(approvalId);
  if (!entry || (expected && entry !== expected)) {
    return;
  }
  pendingRequests.delete(approvalId);
  clearTimeout(entry.timeoutId);
}

export function addPendingPluginBindingRequest(request: PendingPluginBindingRequest): void {
  const expiresAtMs = Date.now() + PENDING_PLUGIN_BINDING_REQUEST_TTL_MS;
  const entry: PendingPluginBindingRequestEntry = {
    request,
    expiresAtMs,
    timeoutId: setTimeout(() => {
      removePendingPluginBindingRequest(request.id, entry);
    }, PENDING_PLUGIN_BINDING_REQUEST_TTL_MS),
  };
  entry.timeoutId.unref?.();
  pendingRequests.set(request.id, entry);

  // Oldest-first eviction keeps abandoned approval payloads bounded and fail-closed.
  while (pendingRequests.size > MAX_PENDING_PLUGIN_BINDING_REQUESTS) {
    const oldestId = pendingRequests.keys().next().value;
    if (oldestId === undefined) {
      break;
    }
    removePendingPluginBindingRequest(oldestId);
  }
}

export function takePluginBindingRequestForApproval(params: {
  approvalId: string;
  senderId?: string;
}): PendingPluginBindingRequest | undefined {
  const entry = pendingRequests.get(params.approvalId);
  if (!entry || Date.now() >= entry.expiresAtMs) {
    if (entry) {
      removePendingPluginBindingRequest(params.approvalId, entry);
    }
    return undefined;
  }
  const request = entry.request;
  if (
    request.requestedBySenderId &&
    params.senderId?.trim() &&
    request.requestedBySenderId !== params.senderId.trim()
  ) {
    return undefined;
  }
  removePendingPluginBindingRequest(params.approvalId, entry);
  return request;
}
