// Tests settled dispatcher outcome accounting for dispatch-from-config runs.
import { describe, expect, it } from "vitest";
import { createReplyDispatcher } from "./reply-dispatcher.js";

describe("settled dispatcher final outcomes", () => {
  it("keeps non-visible, pre-send, and post-send outcomes distinct", async () => {
    const dispatcher = createReplyDispatcher({
      deliver: async (_payload, info) => {
        if (info.kind === "tool") {
          return { visibleReplySent: false };
        }
        if (info.kind === "block") {
          throw Object.assign(new Error("connect failed"), {
            code: "ECONNREFUSED",
            syscall: "connect",
          });
        }
        throw new Error("send outcome unknown");
      },
    });

    dispatcher.sendToolResult({ text: "hidden" });
    dispatcher.sendBlockReply({ text: "never sent" });
    dispatcher.sendFinalReply({ text: "maybe sent" });
    dispatcher.markComplete();
    const receipt = await dispatcher.waitForIdle();

    expect(receipt).toMatchObject({
      counts: {
        tool: { deliveredNotVisible: 1 },
        block: { failedBeforeSend: 1 },
        final: { failedAfterSend: 1 },
      },
      anyVisibleDelivered: true,
    });
  });
});
