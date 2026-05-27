import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";
import { isControlCommandMessage } from "./command-detection.js";
import {
  isExplicitCommandTurn,
  resolveCommandTurnContext,
  type CommandTurnContextInput,
} from "./command-turn-context.js";

function resolveCommandBody(input: CommandTurnContextInput): string | undefined {
  return (
    normalizeOptionalString(input.CommandBody) ??
    normalizeOptionalString(input.BodyForCommands) ??
    normalizeOptionalString(input.RawBody) ??
    normalizeOptionalString(input.Body)
  );
}

function resolveVisibleMessageBody(input: CommandTurnContextInput): string | undefined {
  return normalizeOptionalString(input.RawBody) ?? normalizeOptionalString(input.Body);
}

function resolveStructuredNormalFallbackBody(input: CommandTurnContextInput): string | undefined {
  const visibleBody = resolveVisibleMessageBody(input);
  if (!/^[!/]/.test(visibleBody ?? "")) {
    return undefined;
  }
  return resolveCommandBody(input) ?? visibleBody;
}

function hasCommandSourceMetadata(input: CommandTurnContextInput): boolean {
  return (
    input.CommandSource === "native" ||
    input.CommandSource === "text" ||
    input.CommandSource === "message"
  );
}

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
