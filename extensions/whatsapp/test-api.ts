// WhatsApp test API exposes the self-LID Gateway proof harness without widening the runtime entrypoint.
export { monitorWebChannelWithCapture } from "./src/auto-reply.broadcast-groups.test-harness.js";
export {
  installWebAutoReplyTestHomeHooks,
  installWebAutoReplyUnitTestHooks,
  resetLoadConfigMock,
  sendWebGroupInboundMessage,
  setLoadConfigMock,
} from "./src/auto-reply.test-harness.js";
export { extractMentionedJids, projectWhatsAppInboundMessage } from "./src/inbound/extract.js";
