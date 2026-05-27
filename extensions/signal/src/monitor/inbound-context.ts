import { filterChannelInboundQuoteContext } from "openclaw/plugin-sdk/channel-inbound";
import { resolveChannelContextVisibilityMode } from "openclaw/plugin-sdk/context-visibility-runtime";
import type { ContextVisibilityDecision } from "openclaw/plugin-sdk/security-runtime";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  formatSignalSenderDisplay,
  isSignalSenderAllowed,
  resolveSignalSender,
} from "../identity.js";
import type { SignalDataMessage } from "./event-handler.types.js";

type SignalQuoteContext = {
  contextVisibilityMode: ReturnType<typeof resolveChannelContextVisibilityMode>;
  decision: ContextVisibilityDecision;
  quoteSenderAllowed: boolean;
  visibleQuoteText: string;
  visibleQuoteSender?: string;
};

export function resolveSignalQuoteContext(params: {
  cfg: Parameters<typeof resolveChannelContextVisibilityMode>[0]["cfg"];
  accountId: string;
  isGroup: boolean;
  dataMessage?: SignalDataMessage | null;
  effectiveGroupAllow: string[];
}): SignalQuoteContext {
  const contextVisibilityMode = resolveChannelContextVisibilityMode({
    cfg: params.cfg,
    channel: "signal",
    accountId: params.accountId,
  });
  const quoteText = normalizeOptionalString(params.dataMessage?.quote?.text) ?? "";
  const quoteSender = resolveSignalSender({
    sourceNumber: params.dataMessage?.quote?.author ?? null,
    sourceUuid: params.dataMessage?.quote?.authorUuid ?? null,
  });
  const quoteSenderAllowed =
    !params.isGroup || params.effectiveGroupAllow.length === 0
      ? true
      : quoteSender
        ? isSignalSenderAllowed(quoteSender, params.effectiveGroupAllow)
        : false;
  const visibleQuote = filterChannelInboundQuoteContext(contextVisibilityMode, {
    body: quoteText,
    sender: quoteSender ? formatSignalSenderDisplay(quoteSender) : undefined,
    senderAllowed: quoteSenderAllowed,
    isQuote: true,
  });
  const decision: ContextVisibilityDecision = {
    include: Boolean(visibleQuote),
    reason: visibleQuote
      ? contextVisibilityMode === "all"
        ? "mode_all"
        : quoteSenderAllowed
          ? "sender_allowed"
          : "quote_override"
      : "blocked",
  };

  return {
    contextVisibilityMode,
    decision,
    quoteSenderAllowed,
    visibleQuoteText: visibleQuote?.body ?? "",
    visibleQuoteSender: visibleQuote?.sender,
  };
}
