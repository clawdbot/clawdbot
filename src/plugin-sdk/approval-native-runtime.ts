import { normalizeAccountId } from "../routing/session-key.js";

export function resolveApprovalRequestChannelAccountId(params: {
  request: { request?: { turnSourceChannel?: string | null; turnSourceAccountId?: string | null } };
  channel: string;
  cfg?: unknown;
}): string | undefined {
  const request = params.request?.request;
  if (!request) {
    return undefined;
  }
  const sourceChannel = request.turnSourceChannel?.trim().toLowerCase();
  if (sourceChannel && sourceChannel !== params.channel.toLowerCase()) {
    return undefined;
  }
  return request.turnSourceAccountId?.trim() || undefined;
}

export function doesApprovalRequestMatchChannelAccount(params: {
  request: { request?: { turnSourceChannel?: string | null; turnSourceAccountId?: string | null } };
  channel: string;
  accountId?: string | null;
  cfg?: unknown;
}): boolean {
  const boundAccountId = resolveApprovalRequestChannelAccountId(params);
  if (!boundAccountId || !params.accountId) {
    return true;
  }
  return normalizeAccountId(boundAccountId) === normalizeAccountId(params.accountId);
}
