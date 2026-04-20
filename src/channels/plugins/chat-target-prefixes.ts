import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "../../shared/string-coerce.js";
import { normalizeStringEntries } from "../../shared/string-normalization.js";

export type ServicePrefix<TService extends string> = { prefix: string; service: TService };

export type ChatTargetPrefixesParams = {
  trimmed: string;
  lower: string;
  chatIdPrefixes: string[];
  chatGuidPrefixes: string[];
  chatIdentifierPrefixes: string[];
};

export type ParsedChatTarget =
  | { kind: "chat_id"; chatId: number }
  | { kind: "chat_guid"; chatGuid: string }
  | { kind: "chat_identifier"; chatIdentifier: string };

export type ParsedChatAllowTarget = ParsedChatTarget | { kind: "handle"; handle: string };

export type ChatSenderAllowParams = {
  allowFrom: Array<string | number>;
  sender: string;
  chatId?: number | null;
  chatGuid?: string | null;
  chatIdentifier?: string | null;
};

export function isAllowedParsedChatSender(params: {
  allowFrom: Array<string | number>;
  sender: string;
  chatId?: number | null;
  chatGuid?: string | null;
  chatIdentifier?: string | null;
  normalizeSender: (sender: string) => string;
  parseAllowTarget: (entry: string) => ParsedChatAllowTarget;
}): boolean {
  const allowFrom = normalizeStringEntries(params.allowFrom);
  if (allowFrom.length === 0) {
    return false;
  }
  if (allowFrom.includes("*")) {
    return true;
  }

  const senderNormalized = params.normalizeSender(params.sender);
  const chatId = params.chatId ?? undefined;
  const chatGuid = normalizeOptionalString(params.chatGuid);
  const chatIdentifier = normalizeOptionalString(params.chatIdentifier);

  for (const entry of allowFrom) {
    if (!entry) {
      continue;
    }
    const parsed = params.parseAllowTarget(entry);
    if (parsed.kind === "chat_id" && chatId !== undefined) {
      if (parsed.chatId === chatId) {
        return true;
      }
    } else if (parsed.kind === "chat_guid" && chatGuid) {
      if (parsed.chatGuid === chatGuid) {
        return true;
      }
    } else if (parsed.kind === "chat_identifier" && chatIdentifier) {
      if (parsed.chatIdentifier === chatIdentifier) {
        return true;
      }
    } else if (parsed.kind === "handle" && senderNormalized) {
      if (parsed.handle === senderNormalized) {
        return true;
      }
    }
  }
  return false;
}

function stripPrefix(value: string, prefix: string): string {
  return value.slice(prefix.length).trim();
}

function startsWithAnyPrefix(value: string, prefixes: readonly string[]): boolean {
  return prefixes.some((prefix) => value.startsWith(prefix));
}

export function resolveServicePrefixedTarget<TService extends string, TTarget>(params: {
  trimmed: string;
  lower: string;
  servicePrefixes: Array<ServicePrefix<TService>>;
  isChatTarget: (remainderLower: string) => boolean;
  parseTarget: (remainder: string) => TTarget;
}): ({ kind: "handle"; to: string; service: TService } | TTarget) | null {
  for (const { prefix, service } of params.servicePrefixes) {
    if (!params.lower.startsWith(prefix)) {
      continue;
    }
    const remainder = stripPrefix(params.trimmed, prefix);
    if (!remainder) {
      throw new Error(`${prefix} target is required`);
    }
    const remainderLower = normalizeLowercaseStringOrEmpty(remainder);
    if (params.isChatTarget(remainderLower)) {
      return params.parseTarget(remainder);
    }
    return { kind: "handle", to: remainder, service };
  }
  return null;
}

export function resolveServicePrefixedChatTarget<TService extends string, TTarget>(params: {
  trimmed: string;
  lower: string;
  servicePrefixes: Array<ServicePrefix<TService>>;
  chatIdPrefixes: string[];
  chatGuidPrefixes: string[];
  chatIdentifierPrefixes: string[];
  extraChatPrefixes?: string[];
  parseTarget: (remainder: string) => TTarget;
}): ({ kind: "handle"; to: string; service: TService } | TTarget) | null {
  const chatPrefixes = [
    ...params.chatIdPrefixes,
    ...params.chatGuidPrefixes,
    ...params.chatIdentifierPrefixes,
    ...(params.extraChatPrefixes ?? []),
  ];
  return resolveServicePrefixedTarget({
    trimmed: params.trimmed,
    lower: params.lower,
    servicePrefixes: params.servicePrefixes,
    isChatTarget: (remainderLower) => startsWithAnyPrefix(remainderLower, chatPrefixes),
    parseTarget: params.parseTarget,
  });
}

export function parseChatTargetPrefixesOrThrow(
  params: ChatTargetPrefixesParams,
): ParsedChatTarget | null {
  for (const prefix of params.chatIdPrefixes) {
    if (params.lower.startsWith(prefix)) {
      const value = stripPrefix(params.trimmed, prefix);
      const chatId = Number.parseInt(value, 10);
      if (!Number.isFinite(chatId)) {
        throw new Error(`Invalid chat_id: ${value}`);
      }
      return { kind: "chat_id", chatId };
    }
  }

  for (const prefix of params.chatGuidPrefixes) {
    if (params.lower.startsWith(prefix)) {
      const value = stripPrefix(params.trimmed, prefix);
      if (!value) {
        throw new Error("chat_guid is required");
      }
      return { kind: "chat_guid", chatGuid: value };
    }
  }

  for (const prefix of params.chatIdentifierPrefixes) {
    if (params.lower.startsWith(prefix)) {
      const value = stripPrefix(params.trimmed, prefix);
      if (!value) {
        throw new Error("chat_identifier is required");
      }
      return { kind: "chat_identifier", chatIdentifier: value };
    }
  }

  return null;
}

export function resolveServicePrefixedAllowTarget<TAllowTarget>(params: {
  trimmed: string;
  lower: string;
  servicePrefixes: Array<{ prefix: string }>;
  parseAllowTarget: (remainder: string) => TAllowTarget;
}): (TAllowTarget | { kind: "handle"; handle: string }) | null {
  for (const { prefix } of params.servicePrefixes) {
    if (!params.lower.startsWith(prefix)) {
      continue;
    }
    const remainder = stripPrefix(params.trimmed, prefix);
    if (!remainder) {
      return { kind: "handle", handle: "" };
    }
    return params.parseAllowTarget(remainder);
  }
  return null;
}

export function resolveServicePrefixedOrChatAllowTarget<
  TAllowTarget extends ParsedChatAllowTarget,
>(params: {
  trimmed: string;
  lower: string;
  servicePrefixes: Array<{ prefix: string }>;
  parseAllowTarget: (remainder: string) => TAllowTarget;
  chatIdPrefixes: string[];
  chatGuidPrefixes: string[];
  chatIdentifierPrefixes: string[];
}): TAllowTarget | null {
  const servicePrefixed = resolveServicePrefixedAllowTarget({
    trimmed: params.trimmed,
    lower: params.lower,
    servicePrefixes: params.servicePrefixes,
    parseAllowTarget: params.parseAllowTarget,
  });
  if (servicePrefixed) {
    return servicePrefixed as TAllowTarget;
  }

  const chatTarget = parseChatAllowTargetPrefixes({
    trimmed: params.trimmed,
    lower: params.lower,
    chatIdPrefixes: params.chatIdPrefixes,
    chatGuidPrefixes: params.chatGuidPrefixes,
    chatIdentifierPrefixes: params.chatIdentifierPrefixes,
  });
  if (chatTarget) {
    return chatTarget as TAllowTarget;
  }
  return null;
}

export function createAllowedChatSenderMatcher(params: {
  normalizeSender: (sender: string) => string;
  parseAllowTarget: (entry: string) => ParsedChatAllowTarget;
}): (input: ChatSenderAllowParams) => boolean {
  return (input) =>
    isAllowedParsedChatSender({
      allowFrom: input.allowFrom,
      sender: input.sender,
      chatId: input.chatId,
      chatGuid: input.chatGuid,
      chatIdentifier: input.chatIdentifier,
      normalizeSender: params.normalizeSender,
      parseAllowTarget: params.parseAllowTarget,
    });
}

export function parseChatAllowTargetPrefixes(
  params: ChatTargetPrefixesParams,
): ParsedChatTarget | null {
  for (const prefix of params.chatIdPrefixes) {
    if (params.lower.startsWith(prefix)) {
      const value = stripPrefix(params.trimmed, prefix);
      const chatId = Number.parseInt(value, 10);
      if (Number.isFinite(chatId)) {
        return { kind: "chat_id", chatId };
      }
    }
  }

  for (const prefix of params.chatGuidPrefixes) {
    if (params.lower.startsWith(prefix)) {
      const value = stripPrefix(params.trimmed, prefix);
      if (value) {
        return { kind: "chat_guid", chatGuid: value };
      }
    }
  }

  for (const prefix of params.chatIdentifierPrefixes) {
    if (params.lower.startsWith(prefix)) {
      const value = stripPrefix(params.trimmed, prefix);
      if (value) {
        return { kind: "chat_identifier", chatIdentifier: value };
      }
    }
  }

  return null;
}
