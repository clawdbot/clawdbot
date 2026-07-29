// Conversation id helpers derive stable outbound conversation keys from
// explicit thread ids or safe channel/group target shapes.
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { stringifyRouteThreadId } from "../../plugin-sdk/channel-route.js";

function resolveExplicitConversationTargetId(target: string): string | undefined {
  for (const prefix of ["channel:", "conversation:", "group:", "room:", "dm:"]) {
    if (normalizeLowercaseStringOrEmpty(target).startsWith(prefix)) {
      return normalizeOptionalString(target.slice(prefix.length));
    }
  }
  return undefined;
}

/**
 * Chooses the best conversation id from an explicit thread id or outbound targets.
 */
export function resolveConversationIdFromTargets(params: {
  threadId?: string | number;
  targets: Array<string | undefined | null>;
}): string | undefined {
  const threadId = stringifyRouteThreadId(params.threadId);
  if (threadId) {
    return threadId;
  }

  for (const rawTarget of params.targets) {
    const target = normalizeOptionalString(rawTarget);
    if (!target) {
      continue;
    }
    const explicitConversationId = resolveExplicitConversationTargetId(target);
    if (explicitConversationId) {
      return explicitConversationId;
    }
    if (target.includes(":") && explicitConversationId === undefined) {
      // Colon targets are usually provider-native ids. Only explicit target
      // prefixes above are safe to collapse into a portable conversation id.
      continue;
    }
    const mentionMatch = target.match(/^<#(\d+)>$/);
    if (mentionMatch?.[1]) {
      return mentionMatch[1];
    }
    if (/^\d{6,}$/.test(target)) {
      return target;
    }
  }

  return undefined;
}
