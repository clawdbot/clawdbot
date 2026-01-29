import { describe, expect, it, vi } from "vitest";

import { slackPlugin } from "./channel.js";
import { setSlackRuntime } from "./runtime.js";

import type { MoltbotConfig } from "../../../src/config/config.js";
import { createPluginRuntime } from "../../../src/plugins/runtime/index.js";

describe("slack plugin read action", () => {
  it("forwards threadId to readMessages", async () => {
    const runtime = createPluginRuntime();

    const handleSlackAction = vi.fn(async () => ({ ok: true }));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (runtime.channel.slack as any).handleSlackAction = handleSlackAction;

    setSlackRuntime(runtime);

    const cfg = {
      channels: {
        slack: {
          botToken: "xoxb-test",
          appToken: "xapp-test",
        },
      },
    } as MoltbotConfig;

    await slackPlugin.actions.handleAction({
      action: "read",
      params: {
        channelId: "C123",
        threadId: "1712345678.000100",
        limit: 3,
      },
      cfg,
      accountId: undefined,
      toolContext: undefined,
    });

    expect(handleSlackAction).toHaveBeenCalledTimes(1);
    expect(handleSlackAction.mock.calls[0]?.[0]).toMatchObject({
      action: "readMessages",
      channelId: "C123",
      limit: 3,
      threadId: "1712345678.000100",
    });
  });
});
