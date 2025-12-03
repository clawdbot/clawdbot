import { describe, expect, it, vi } from "vitest";

import { monitorTwilio } from "./monitor.js";

describe("monitorTwilio", () => {
  it("processes inbound messages once with injected deps", async () => {
    const listRecentMessages = vi.fn().mockResolvedValue([
      {
        sid: "m1",
        direction: "inbound",
        dateCreated: new Date(),
        from: "+1",
        to: "+2",
        body: "hi",
        errorCode: null,
        errorMessage: null,
        status: null,
      },
    ]);
    const autoReplyIfConfigured = vi.fn().mockResolvedValue(undefined);
    const readEnv = vi.fn(() => ({
      accountSid: "AC",
      whatsappFrom: "whatsapp:+1",
      auth: { accountSid: "AC", authToken: "t" },
    }));
    const createClient = vi.fn(
      () => ({ messages: { create: vi.fn() } }) as never,
    );
    const sleep = vi.fn().mockResolvedValue(undefined);

    await monitorTwilio(0, 0, {
      deps: {
        autoReplyIfConfigured,
        listRecentMessages,
        readEnv,
        createClient,
        sleep,
      },
      maxIterations: 1,
    });

    expect(listRecentMessages).toHaveBeenCalledTimes(1);
    expect(autoReplyIfConfigured).toHaveBeenCalledTimes(1);
  });
});
