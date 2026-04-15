import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import {
  createActionGate,
  jsonResult,
  readReactionParams,
  readStringParam,
} from "openclaw/plugin-sdk/channel-actions";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { resolveAuthorizedWhatsAppOutboundTarget } from "./action-runtime-target-auth.js";
import { resolveWhatsAppReactionLevel } from "./reaction-level.js";
import { sendReactionWhatsApp } from "./send.js";

export const whatsAppActionRuntime = {
  resolveAuthorizedWhatsAppOutboundTarget,
  sendReactionWhatsApp,
};

export async function handleWhatsAppAction(
  params: Record<string, unknown>,
  cfg: OpenClawConfig,
): Promise<AgentToolResult<unknown>> {
  const action = readStringParam(params, "action", { required: true });
  const whatsAppConfig = cfg.channels?.whatsapp;
  const isActionEnabled = createActionGate(whatsAppConfig?.actions);

  if (action === "react") {
    const accountId = readStringParam(params, "accountId");
    if (!whatsAppConfig) {
      throw new Error("WhatsApp reactions are disabled.");
    }
    if (!isActionEnabled("reactions")) {
      throw new Error("WhatsApp reactions are disabled.");
    }
    const reactionLevelInfo = resolveWhatsAppReactionLevel({
      cfg,
      accountId: accountId ?? undefined,
    });
    if (!reactionLevelInfo.agentReactionsEnabled) {
      throw new Error(
        `WhatsApp agent reactions disabled (reactionLevel="${reactionLevelInfo.level}"). ` +
          `Set channels.whatsapp.reactionLevel to "minimal" or "extensive" to enable.`,
      );
    }
    const chatJid = readStringParam(params, "chatJid", { required: true });
    const messageId = readStringParam(params, "messageId", { required: true });
    const { emoji, remove, isEmpty } = readReactionParams(params, {
      removeErrorMessage: "Emoji is required to remove a WhatsApp reaction.",
    });
    const participant = readStringParam(params, "participant");
    const fromMeRaw = params.fromMe;
    const fromMe = typeof fromMeRaw === "boolean" ? fromMeRaw : undefined;

    // Resolve account + allowFrom via shared account logic so auth and routing stay aligned.
    const resolved = whatsAppActionRuntime.resolveAuthorizedWhatsAppOutboundTarget({
      cfg,
      chatJid,
      accountId,
      actionLabel: "reaction",
    });

    const resolvedEmoji = remove ? "" : emoji;
    await whatsAppActionRuntime.sendReactionWhatsApp(resolved.to, messageId, resolvedEmoji, {
      verbose: false,
      fromMe,
      participant: participant ?? undefined,
      accountId: resolved.accountId,
    });
    if (!remove && !isEmpty) {
      return jsonResult({ ok: true, added: emoji });
    }
    return jsonResult({ ok: true, removed: true });
  }

  throw new Error(`Unsupported WhatsApp action: ${action}`);
}
