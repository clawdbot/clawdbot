import { afterEach, describe, expect, it } from "vitest";
import { iMessageApprovalControlBindings } from "./approval-control-binding-window.js";

afterEach(() => {
  iMessageApprovalControlBindings.clearForTest();
});

describe("iMessage approval control binding windows", () => {
  it("matches an outbound handle against the richer inbound conversation", async () => {
    const window = iMessageApprovalControlBindings.begin({
      accountId: "default",
      conversation: { handle: "+15551230000" },
    });
    const waited = iMessageApprovalControlBindings.wait({
      accountId: "default",
      conversation: {
        chatGuid: "iMessage;-;+15551230000",
        chatId: 42,
        handle: "+15551230000",
      },
    });

    window.close();

    await expect(waited).resolves.toBe(true);
    await expect(
      iMessageApprovalControlBindings.wait({
        accountId: "default",
        conversation: { handle: "+15551230000" },
      }),
    ).resolves.toBe(false);
  });

  it("does not wait on a different conversation", async () => {
    iMessageApprovalControlBindings.begin({
      accountId: "default",
      conversation: { handle: "+15551230000" },
    });

    await expect(
      iMessageApprovalControlBindings.wait({
        accountId: "default",
        conversation: { handle: "+15551239999" },
      }),
    ).resolves.toBe(false);
  });
});
