import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { isCommandEnabled } from "../commands-registry-list.js";
import { maybeResolveTextAlias } from "../commands-registry-normalize.js";
import { shouldHandleTextCommands } from "../commands-text-routing.js";
import type { FinalizedMsgContext } from "../templating.js";

function resolveFirstContextText(
  ctx: FinalizedMsgContext,
  keys: Array<"BodyForAgent" | "BodyForCommands" | "CommandBody" | "RawBody" | "Body">,
): string {
  for (const key of keys) {
    const value = ctx[key];
    if (typeof value === "string") {
      return value;
    }
  }
  return "";
}

function resolveCommandCandidateText(ctx: FinalizedMsgContext): string {
  return resolveFirstContextText(ctx, ["CommandBody", "BodyForCommands", "RawBody", "Body"]).trim();
}

function isResetCommandCandidate(text: string): boolean {
  return /^\/(?:new|reset)(?:\s|$)/i.test(text);
}

function isAcpCommandCandidate(text: string): boolean {
  return /^\/acp(?:\s|$)/i.test(text);
}

function isLocalCommandCandidate(text: string): boolean {
  return /^\/(?:status|unfocus)(?:\s|$)/i.test(text);
}

export function shouldBypassAcpDispatchForCommand(
  ctx: FinalizedMsgContext,
  cfg: OpenClawConfig,
): boolean {
  const candidate = resolveCommandCandidateText(ctx);
  if (!candidate) {
    return false;
  }
  const normalized = candidate.trim();
  const allowTextCommands = shouldHandleTextCommands({
    cfg,
    surface: ctx.Surface ?? ctx.Provider ?? "",
    commandSource: ctx.CommandSource,
  });
  if (!normalized.startsWith("/") && maybeResolveTextAlias(candidate, cfg) != null) {
    return allowTextCommands;
  }

  if (isResetCommandCandidate(normalized)) {
    return true;
  }

  if (isAcpCommandCandidate(normalized)) {
    return true;
  }

  if (isLocalCommandCandidate(normalized)) {
    return allowTextCommands;
  }

  if (!normalized.startsWith("!")) {
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
