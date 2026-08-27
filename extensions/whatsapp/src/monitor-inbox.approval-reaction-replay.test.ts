// WhatsApp durable-ingress replay proof: a transient Gateway failure during
// approval-reaction resolution must not consume the reaction. The upsert fast
// path falls through to durable admission, and the real SQLite-backed drain
// redelivers the operator's reaction once the Gateway recovers. Everything
// here is real (monitor, admission, queue, drain, approval-reaction
// resolution) except the socket and the one true external boundary: the
// Gateway approval-resolution call.
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearWhatsAppApprovalReactionTargetsForTest,
  registerWhatsAppApprovalReactionTarget,
} from "./approval-reactions.js";
import {
  installWebMonitorInboxUnitTestHooks,
  startInboxMonitor,
  waitForMessageCalls,
  type InboxOnMessage,
} from "./monitor-inbox.test-harness.js";

const resolverMocks = vi.hoisted(() => ({
  resolveWhatsAppApproval: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/approval-gateway-runtime", () => ({
  resolveApprovalOverGateway: resolverMocks.resolveWhatsAppApproval,
}));
// error-runtime stays real: the injected "gateway 503" Error is genuinely not
// an approval-not-found, so the real classifier drives the transient path.

installWebMonitorInboxUnitTestHooks();

function buildApprovalReactionUpsert() {
  return {
    type: "notify",
    messages: [
      {
        key: { id: "reaction-1", remoteJid: "15551230000@s.whatsapp.net", fromMe: false },
        message: {
          reactionMessage: {
            text: "👍",
            key: { remoteJid: "15551230000@s.whatsapp.net", id: "approval-message" },
          },
        },
        messageTimestamp: 1_700_000_000,
        pushName: "Tester",
      },
      // A sibling in the same batch: the transient failure must not abort the
      // upsert loop before this ordinary message is delivered.
      {
        key: { id: "batch-2", remoteJid: "15551230000@s.whatsapp.net", fromMe: false },
        message: { conversation: "batch survivor" },
        messageTimestamp: 1_700_000_001,
        pushName: "Tester",
      },
    ],
  };
}

describe("WhatsApp approval reaction durable replay", () => {
  beforeEach(() => {
    clearWhatsAppApprovalReactionTargetsForTest();
    resolverMocks.resolveWhatsAppApproval.mockReset();
  });

  it(
    "releases the claim and replays a reaction after a transient Gateway failure",
    { timeout: 30_000 },
    async () => {
      registerWhatsAppApprovalReactionTarget({
        accountId: "default",
        remoteJid: "15551230000@s.whatsapp.net",
        messageId: "approval-message",
        approvalId: "exec-replay",
        approvalKind: "exec",
        allowedDecisions: ["allow-once", "deny"],
      });
      // First resolution attempt (the upsert fast path) fails like a transient
      // Gateway 503; the redelivered drain attempt resolves the approval.
      resolverMocks.resolveWhatsAppApproval
        .mockRejectedValueOnce(new Error("gateway 503"))
        .mockResolvedValue({
          applied: true,
          approval: { status: "allowed", decision: "allow-once" },
        });
      const onMessage = vi.fn();
      const { listener, sock } = await startInboxMonitor(onMessage as InboxOnMessage);

      try {
        sock.ev.emit("messages.upsert", buildApprovalReactionUpsert());

        // A swallowed failure would resolve nothing and never produce this
        // second call: the reaction only reaches the resolver again when the
        // durable drain replays it.
        await vi.waitFor(
          () => expect(resolverMocks.resolveWhatsAppApproval).toHaveBeenCalledTimes(2),
          { timeout: 15_000 },
        );

        // Redelivery carried the identical resolution request.
        expect(resolverMocks.resolveWhatsAppApproval.mock.calls[1]?.[0]).toEqual(
          resolverMocks.resolveWhatsAppApproval.mock.calls[0]?.[0],
        );
        expect(resolverMocks.resolveWhatsAppApproval.mock.calls[1]?.[0]).toEqual(
          expect.objectContaining({
            approvalId: "exec-replay",
            approvalKind: "exec",
            decision: "allow-once",
            channel: "whatsapp",
            accountId: "default",
          }),
        );

        // The reaction never leaks into the chat pipeline; only the batch
        // sibling is delivered as an ordinary message.
        await waitForMessageCalls(onMessage, 1);
        const delivered = onMessage.mock.calls[0]?.[0] as { payload?: { body?: string } };
        expect(delivered.payload?.body).toBe("batch survivor");

        // The completion tombstone is durable: re-emitting the same reaction
        // resolves nothing and delivers nothing new. Give the upsert fast
        // path and the admission dedupe check time to settle, then assert.
        sock.ev.emit("messages.upsert", buildApprovalReactionUpsert());
        await new Promise((resolve) => {
          setTimeout(resolve, 1_500);
        });
        expect(resolverMocks.resolveWhatsAppApproval).toHaveBeenCalledTimes(2);
        expect(onMessage).toHaveBeenCalledTimes(1);
      } finally {
        await listener.close();
      }
    },
  );
});
