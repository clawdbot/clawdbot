// Whatsapp tests cover self LID mention rendering through the auto-reply monitor to the agent context.
import "./test-helpers.js";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { MsgContext } from "openclaw/plugin-sdk/reply-runtime";
import { describe, expect, it, vi } from "vitest";
import { monitorWebChannelWithCapture } from "./auto-reply.broadcast-groups.test-harness.js";
import {
  installWebAutoReplyTestHomeHooks,
  installWebAutoReplyUnitTestHooks,
  resetLoadConfigMock,
  sendWebGroupInboundMessage,
  setLoadConfigMock,
} from "./auto-reply.test-harness.js";
import { extractMentionedJids, projectWhatsAppInboundMessage } from "./inbound/extract.js";

installWebAutoReplyTestHomeHooks();

const SELF_LID_ID = "900000000000001";
const SELF_LID = `${SELF_LID_ID}@lid`;
const SELF_JID = "15550003333@s.whatsapp.net";
const GROUP_JID = "123@g.us";

describe("WhatsApp self-LID mention through the agent context boundary", () => {
  installWebAutoReplyUnitTestHooks();

  it("renders the native self-LID token as the configured identity while preserving command text", async () => {
    setLoadConfigMock({
      channels: { whatsapp: { allowFrom: ["*"] } },
      agents: { list: [{ id: "main", identity: { name: "Kit" } }] },
      bindings: [{ agentId: "main", match: { channel: "whatsapp", accountId: "default" } }],
    } satisfies OpenClawConfig);

    try {
      // Native WhatsApp envelope: the visible text carries the opaque LID number and the
      // mention target only exists in contextInfo, so the mention list is extracted here
      // rather than hand-written.
      const rawBody = `@${SELF_LID_ID} what is the deploy status?`;
      const mentionedJids = extractMentionedJids(
        projectWhatsAppInboundMessage({
          extendedTextMessage: {
            text: rawBody,
            contextInfo: { mentionedJid: [SELF_LID] },
          },
        }),
      );
      expect(mentionedJids).toEqual([SELF_LID]);

      const contexts: MsgContext[] = [];
      const resolver = vi.fn(async (ctx: MsgContext) => {
        contexts.push(ctx);
        return { text: "ok" };
      });
      const { spies, onMessage } = await monitorWebChannelWithCapture(resolver);

      await sendWebGroupInboundMessage({
        onMessage,
        spies,
        body: rawBody,
        id: "self-lid-1",
        conversationId: GROUP_JID,
        senderE164: "+15550002222",
        senderName: "Alice",
        mentionedJids,
        selfE164: "+15550003333",
        selfJid: SELF_JID,
        selfLid: SELF_LID,
      });

      expect(resolver).toHaveBeenCalledTimes(1);
      const ctx = contexts[0];
      expect(ctx?.BodyForAgent).toBe("@Kit what is the deploy status?");
      expect(ctx?.BodyForAgent).not.toContain(SELF_LID_ID);
      expect(ctx?.RawBody).toBe(rawBody);
      expect(ctx?.CommandBody).toBe(rawBody);
    } finally {
      resetLoadConfigMock();
    }
  });
});
