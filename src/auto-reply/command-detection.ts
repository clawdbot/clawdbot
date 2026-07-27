/** Command detectors used by inbound authorization and control-command routing. */
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalLowercaseString,
} from "@openclaw/normalization-core/string-coerce";
import type { OpenClawConfig } from "../config/types.js";
import { matchPluginCommand } from "../plugins/commands.js";
import { listChatCommands, listChatCommandsForConfig } from "./commands-registry-list.js";
import { normalizeCommandBody } from "./commands-registry-normalize.js";
import type { CommandNormalizeOptions } from "./commands-registry.types.js";
import { isAbortTrigger } from "./reply/abort-primitives.js";
import { stripInboundMetadata } from "./reply/strip-inbound-meta.js";

/** Returns true when text starts with a configured control command alias. */
export function hasControlCommand(
  text?: string,
  cfg?: OpenClawConfig,
  options?: CommandNormalizeOptions,
): boolean {
  if (!text) {
    return false;
  }
  const trimmed = text.trim();
  if (!trimmed) {
    return false;
  }
  const stripped = stripInboundMetadata(trimmed);
  if (!stripped) {
    return false;
  }
  const normalizedBody = normalizeCommandBody(stripped, options);
  if (!normalizedBody) {
    return false;
  }
  const lowered = normalizeLowercaseStringOrEmpty(normalizedBody);
  const commands = cfg ? listChatCommandsForConfig(cfg) : listChatCommands();
  for (const command of commands) {
    for (const alias of command.textAliases) {
      const normalized = normalizeOptionalLowercaseString(alias);
      if (!normalized) {
        continue;
      }
      if (lowered === normalized) {
        return true;
      }
      if (command.acceptsArgs && lowered.startsWith(normalized)) {
        const nextChar = normalizedBody.charAt(normalized.length);
        if (nextChar && /\s/.test(nextChar)) {
          return true;
        }
      }
    }
  }
  return false;
}

/** Returns true for exact control commands or abort triggers after metadata stripping. */
export function isControlCommandMessage(
  text?: string,
  cfg?: OpenClawConfig,
  options?: CommandNormalizeOptions,
): boolean {
  if (!text) {
    return false;
  }
  const trimmed = text.trim();
  if (!trimmed) {
    return false;
  }
  if (hasControlCommand(trimmed, cfg, options)) {
    return true;
  }
  const stripped = stripInboundMetadata(trimmed);
  const normalized =
    normalizeOptionalLowercaseString(normalizeCommandBody(stripped, options)) ?? "";
  return isAbortTrigger(normalized);
}

/** Returns true when a command starts a new transcript rather than resetting in place. */
export function isSessionBoundaryCommandText(
  text?: string,
  options?: CommandNormalizeOptions,
): boolean {
  const stripped = stripInboundMetadata(text?.trim() ?? "");
  const normalized = normalizeCommandBody(stripped, options);
  return (
    /^\/(?:new|reset)(?:\s|$)/i.test(normalized) && !/^\/reset\s+soft(?:\s|$)/i.test(normalized)
  );
}

/**
 * Coarse detection for inline directives/shortcuts (e.g. "hey /status") so channel monitors
 * can decide whether to compute CommandAuthorized for a message.
 *
 * This intentionally errs on the side of false positives; CommandAuthorized only gates
 * command/directive execution, not normal chat replies.
 */
export function hasInlineCommandTokens(text?: string): boolean {
  const body = text ?? "";
  if (!body.trim()) {
    return false;
  }
  return /(?:^|\s)[/!][a-z]/i.test(body);
}

function hasSpacedPluginCommand(text?: string): boolean {
  const commandBody = text?.match(/(?:^|\s)(\/\s+[a-z][\s\S]*)/i)?.[1];
  // Only active registered commands affect ingress authorization and mention gating.
  // This keeps spaced syntax aligned with canonical `/name` command ownership.
  return commandBody ? matchPluginCommand(commandBody) !== null : false;
}

/** Returns true when a message may need command authorization metadata. */
export function shouldComputeCommandAuthorized(
  text?: string,
  cfg?: OpenClawConfig,
  options?: CommandNormalizeOptions,
): boolean {
  return (
    isControlCommandMessage(text, cfg, options) ||
    hasInlineCommandTokens(text) ||
    hasSpacedPluginCommand(text)
  );
}
