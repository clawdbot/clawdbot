import { afterEach, describe, expect, it } from "vitest";
import {
  beginIMessageApprovalControlBinding,
  clearIMessageApprovalControlBindingsForTest,
  waitForIMessageApprovalControlBinding,
} from "./approval-control-binding-window.js";

afterEach(() => {
  clearIMessageApprovalControlBindingsForTest();
});

describe("iMessage approval control binding windows", () => {
  it("matches an outbound handle against the richer inbound conversation", async () => {
    const window = beginIMessageApprovalControlBinding({
      accountId: "default",
      conversation: { handle: "+15551230000" },
    });
    const waited = waitForIMessageApprovalControlBinding({
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
      waitForIMessageApprovalControlBinding({
        accountId: "default",
        conversation: { handle: "+15551230000" },
      }),
    ).resolves.toBe(false);
  });

  it("does not wait on a different conversation", async () => {
    beginIMessageApprovalControlBinding({
      accountId: "default",
      conversation: { handle: "+15551230000" },
    });

    await expect(
      waitForIMessageApprovalControlBinding({
        accountId: "default",
        conversation: { handle: "+15551239999" },
      }),
    ).resolves.toBe(false);
  });
});
