// Detects ACP commands that should bypass normal agent dispatch.
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { hasControlCommand } from "../command-detection.js";
import { isCommandEnabled } from "../commands-registry-list.js";
import { shouldHandleTextCommands } from "../commands-text-routing.js";
import type { FinalizedRuntimeMsgContext } from "../templating.js";
import { resolveCommandContextText } from "./context-text.js";

function isResetCommandCandidate(text: string): boolean {
  return /^\/(?:new|reset)(?:\s|$)/i.test(text);
}

function isAcpCommandCandidate(text: string): boolean {
  return /^\/acp(?:\s|$)/i.test(text);
}

export function shouldBypassAcpDispatchForCommand(
  ctx: FinalizedRuntimeMsgContext,
  cfg: OpenClawConfig,
): boolean {
  const candidate = resolveCommandContextText(ctx);
  if (!candidate) {
    return false;
  }
  const allowTextCommands = shouldHandleTextCommands({
    cfg,
    surface: ctx.Surface ?? ctx.Provider ?? "",
    commandSource: ctx.CommandSource,
  });
  if (isResetCommandCandidate(candidate)) {
    return true;
  }

  if (isAcpCommandCandidate(candidate)) {
    return true;
  }

  if (hasControlCommand(candidate, cfg)) {
    return allowTextCommands;
  }

  if (!candidate.startsWith("!")) {
    return false;
  }

  if (!ctx.CommandAuthorized) {
    return false;
  }

  if (!isCommandEnabled(cfg, "bash")) {
    return false;
  }

  return allowTextCommands;
}
