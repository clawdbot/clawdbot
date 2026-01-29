/**
 * Config-driven message handler matching.
 * Matches inbound messages against configured handlers based on channel, sender, content, etc.
 */

import safeRegex from "safe-regex";
import type { MessageHandlerConfig, MessageHandlerMatch } from "../config/types.hooks.js";
import { logWarn } from "../logger.js";
import type { MessageReceivedHookContext } from "./internal-hooks.js";

/**
 * Find the first matching handler for a message context.
 * Returns null if no handler matches.
 *
 * @param handlers - Array of configured message handlers
 * @param context - The message received context to match against
 * @returns The first matching handler, or null if none match
 */
export function matchMessageHandler(
  handlers: MessageHandlerConfig[],
  context: MessageReceivedHookContext,
): MessageHandlerConfig | null {
  for (const handler of handlers) {
    // Skip disabled handlers
    if (handler.enabled === false) {
      continue;
    }
    if (matchesConditions(handler.match, context)) {
      return handler;
    }
  }
  return null;
}

/**
 * Check if all conditions in the match config are satisfied by the context.
 * All specified conditions must match (AND logic).
 */
function matchesConditions(match: MessageHandlerMatch, ctx: MessageReceivedHookContext): boolean {
  // channelId match
  if (match.channelId !== undefined && !matchesValue(match.channelId, ctx.channelId)) {
    return false;
  }

  // conversationId match
  if (
    match.conversationId !== undefined &&
    !matchesValue(match.conversationId, ctx.conversationId)
  ) {
    return false;
  }

  // from match (sender)
  if (match.from !== undefined && !matchesValue(match.from, ctx.from)) {
    return false;
  }

  // contentPattern (regex) - with ReDoS protection
  if (match.contentPattern !== undefined) {
    // Validate regex safety before compilation to prevent catastrophic backtracking
    if (!safeRegex(match.contentPattern)) {
      logWarn(`message-handler-match: unsafe regex pattern rejected: ${match.contentPattern}`);
      return false;
    }
    try {
      const regex = new RegExp(match.contentPattern, "i");
      if (!regex.test(ctx.content)) {
        return false;
      }
    } catch {
      // Invalid regex - treat as no match
      return false;
    }
  }

  // contentContains (keyword matching)
  if (match.contentContains !== undefined) {
    const keywords = Array.isArray(match.contentContains)
      ? match.contentContains
      : [match.contentContains];
    const content = ctx.content.toLowerCase();
    const hasKeyword = keywords.some((kw) => content.includes(kw.toLowerCase()));
    if (!hasKeyword) {
      return false;
    }
  }

  return true;
}

/**
 * Check if a value matches a pattern (single value, array, or wildcard).
 *
 * @param pattern - The pattern to match against (string, string[], or "*" for wildcard)
 * @param value - The value to check
 * @returns true if the value matches the pattern
 */
function matchesValue(pattern: string | string[], value: string | undefined): boolean {
  if (value === undefined || value === null) {
    return false;
  }

  const patterns = Array.isArray(pattern) ? pattern : [pattern];
  return patterns.some((p) => p === "*" || p === value);
}
