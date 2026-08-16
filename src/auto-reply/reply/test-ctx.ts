// Builds minimal message contexts for reply unit tests.
import type { FinalizedRuntimeMsgContext, MsgContext } from "../templating.js";
import { finalizeInboundContext } from "./inbound-context.js";

export function buildTestCtx(overrides: Partial<MsgContext> = {}): FinalizedRuntimeMsgContext {
  return finalizeInboundContext({
    Body: "",
    CommandBody: "",
    CommandSource: "text",
    From: "whatsapp:+1000",
    To: "whatsapp:+2000",
    ChatType: "direct",
    Provider: "whatsapp",
    Surface: "whatsapp",
    CommandAuthorized: false,
    ...overrides,
  });
}
