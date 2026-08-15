// Imessage plugin module normalizes equivalent provider conversation identifiers.
import { normalizeE164 } from "openclaw/plugin-sdk/account-resolution";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { IMessageService, IMessageTarget } from "./targets.js";

export type IMessageChatContext = {
  chatGuid?: string;
  chatIdentifier?: string;
  chatId?: number;
};

type IMessageDirectChatIdentity = {
  service?: "imessage" | "sms" | "any";
  identifier: string;
};

const EMAIL_HANDLE_PATTERN = /^[^\s@]+@[^\s@]+$/u;

function parseDirectChatIdentity(raw: string): IMessageDirectChatIdentity | undefined {
  const trimmed = raw.trim();
  const parts = trimmed.split(";");
  if (parts.length === 3 && parts[1] === "-" && parts[2]) {
    const service = parts[0]?.toLowerCase();
    if (service === "imessage" || service === "sms" || service === "any") {
      const identifier = parts[2];
      return {
        service,
        identifier: EMAIL_HANDLE_PATTERN.test(identifier) ? identifier.toLowerCase() : identifier,
      };
    }
  }
  if (parts.length !== 1) {
    return undefined;
  }
  if (trimmed.startsWith("+") || EMAIL_HANDLE_PATTERN.test(trimmed)) {
    return { identifier: trimmed.toLowerCase() };
  }
  return undefined;
}

export function isIMessageEmailChatIdentifier(raw: string): boolean {
  const identity = parseDirectChatIdentity(raw);
  return Boolean(identity && EMAIL_HANDLE_PATTERN.test(identity.identifier));
}

/**
 * Strip the `iMessage;-;` / `SMS;-;` / `any;-;` service prefix that Messages
 * uses for direct chats. Different layers report direct DMs in different
 * forms, so raw comparison would falsely treat one DM as different chats.
 */
export function normalizeDirectChatIdentifier(raw: string): string {
  const trimmed = raw.trim();
  return parseDirectChatIdentity(trimmed)?.identifier ?? trimmed;
}

export function chatContextFromIMessageTarget(
  target: IMessageTarget,
  effectiveService?: IMessageService,
): IMessageChatContext {
  if (target.kind === "chat_id") {
    return { chatId: target.chatId };
  }
  if (target.kind === "chat_guid") {
    return { chatGuid: target.chatGuid };
  }
  if (target.kind === "chat_identifier") {
    return { chatIdentifier: target.chatIdentifier };
  }
  const trimmedHandle = target.to.trim();
  const canonicalHandle = trimmedHandle.startsWith("+")
    ? normalizeE164(trimmedHandle)
    : /^[^\s@]+@[^\s@]+$/u.test(trimmedHandle)
      ? trimmedHandle.toLowerCase()
      : undefined;
  if (!canonicalHandle) {
    return {};
  }
  const service = target.service === "auto" ? effectiveService : target.service;
  if (service !== "imessage" && service !== "sms") {
    return {};
  }
  return {
    chatIdentifier: `${service === "sms" ? "SMS" : "iMessage"};-;${canonicalHandle}`,
  };
}

function compareOptional<T>(left: T | undefined, right: T | undefined): boolean | undefined {
  return left === undefined || right === undefined ? undefined : left === right;
}

function compareChatSelector(
  cachedRaw: string | undefined,
  currentRaw: string | undefined,
  crossKind = false,
): boolean | undefined {
  const cached = normalizeOptionalString(cachedRaw);
  const current = normalizeOptionalString(currentRaw);
  if (!cached || !current) {
    return undefined;
  }
  if (cached === current) {
    return true;
  }
  const cachedDirect = parseDirectChatIdentity(cached);
  const currentDirect = parseDirectChatIdentity(current);
  if (!cachedDirect || !currentDirect) {
    return crossKind ? undefined : false;
  }
  if (cachedDirect.identifier !== currentDirect.identifier) {
    return false;
  }
  if (cachedDirect.service === "any") {
    return true;
  }
  if (!cachedDirect.service || !currentDirect.service) {
    return undefined;
  }
  return cachedDirect.service === currentDirect.service;
}

export function resolveIMessageChatMatch(
  cached: IMessageChatContext,
  current: IMessageChatContext,
): "match" | "mismatch" | "unknown" {
  const cachedChatGuid = normalizeOptionalString(cached.chatGuid);
  const currentChatGuid = normalizeOptionalString(current.chatGuid);
  const cachedChatIdentifier = normalizeOptionalString(cached.chatIdentifier);
  const currentChatIdentifier = normalizeOptionalString(current.chatIdentifier);
  const comparisons = [
    compareChatSelector(cachedChatGuid, currentChatGuid),
    compareChatSelector(cachedChatIdentifier, currentChatIdentifier),
    compareOptional(cached.chatId, current.chatId),
    compareChatSelector(cachedChatGuid, currentChatIdentifier, true),
    compareChatSelector(cachedChatIdentifier, currentChatGuid, true),
  ].filter((comparison): comparison is boolean => comparison !== undefined);
  if (comparisons.length === 0) {
    return "unknown";
  }
  return comparisons.every(Boolean) ? "match" : "mismatch";
}

export function isPositiveIMessageChatMatch(
  cached: IMessageChatContext,
  current: IMessageChatContext,
): boolean {
  return resolveIMessageChatMatch(cached, current) === "match";
}
