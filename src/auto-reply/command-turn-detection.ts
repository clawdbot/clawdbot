/** Fallback command-turn detection for mixed native/text channel metadata. */
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isControlCommandMessage } from "./command-detection.js";
import {
  isExplicitCommandTurn,
  resolveCommandTurnContext,
  type CommandTurnContextInput,
} from "./command-turn-context.js";

function resolveCommandBody(input: CommandTurnContextInput): string | undefined {
  if (typeof input.commandText === "string") {
    return input.commandText;
  }
  return (
    normalizeOptionalString(input.CommandBody) ??
    normalizeOptionalString(input.BodyForCommands) ??
    normalizeOptionalString(input.RawBody) ??
    normalizeOptionalString(input.Body)
  );
}

function resolveVisibleMessageBody(input: CommandTurnContextInput): string | undefined {
  if (typeof input.rawText === "string") {
    return input.rawText;
  }
  return normalizeOptionalString(input.RawBody) ?? normalizeOptionalString(input.Body);
}

function resolveStructuredNormalFallbackBody(input: CommandTurnContextInput): string | undefined {
  const visibleBody = resolveVisibleMessageBody(input);
  if (!/^[!/]/.test(visibleBody ?? "")) {
    return undefined;
  }
  // Structured normal turns may carry a command-only body hidden from the visible message text.
  return resolveCommandBody(input) ?? visibleBody;
}

function hasCommandSourceMetadata(input: CommandTurnContextInput): boolean {
  return (
    input.CommandSource === "native" ||
    input.CommandSource === "text" ||
    input.CommandSource === "message"
  );
}

/** Returns true when inbound metadata or command text identifies an explicit command turn. */
export function isExplicitCommandTurnContext(
  input: CommandTurnContextInput,
  cfg: OpenClawConfig,
): boolean {
  if (isExplicitCommandTurn(resolveCommandTurnContext(input))) {
    return true;
  }
  if (input.CommandSource === "native" || input.CommandSource === "text") {
    return false;
  }
  const fallbackBody =
    input.CommandTurn !== undefined || hasCommandSourceMetadata(input)
      ? resolveStructuredNormalFallbackBody(input)
      : resolveCommandBody(input);
  return (
    input.CommandAuthorized === true &&
    isControlCommandMessage(fallbackBody, cfg, {
      botUsername: normalizeOptionalString(input.BotUsername),
    })
  );
}
