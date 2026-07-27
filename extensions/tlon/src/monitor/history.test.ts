// Tlon history tests cover monitor-owned cache lifecycle and per-channel bounds.
import { describe, expect, it, vi } from "vitest";
import { createChannelHistoryCache } from "./history.js";

function historyResponse(content: string) {
  return [
    {
      essay: {
        author: "~fresh",
        content: [{ inline: [content] }],
        sent: 2,
      },
    },
  ];
}

describe("createChannelHistoryCache", () => {
  it("does not reuse cached messages across monitor lifecycles", async () => {
    const stoppedMonitor = createChannelHistoryCache();
    stoppedMonitor.cacheMessage("chat/~host/channel", {
      author: "~stale",
      content: "stale",
      timestamp: 1,
    });

    const activeMonitor = createChannelHistoryCache();
    const scry = vi.fn(async () => historyResponse("fresh"));

    await expect(
      activeMonitor.getChannelHistory({ scry }, "chat/~host/channel", 1),
    ).resolves.toEqual([
      {
        author: "~fresh",
        content: "fresh",
        timestamp: 2,
        id: undefined,
      },
    ]);
    expect(scry).toHaveBeenCalledOnce();
  });

  it("keeps only the newest messages for each channel", async () => {
    const history = createChannelHistoryCache();
    for (let index = 0; index <= 100; index += 1) {
      history.cacheMessage("chat/~host/channel", {
        author: "~zod",
        content: `message-${index}`,
        timestamp: index,
      });
    }
    const scry = vi.fn();

    const messages = await history.getChannelHistory({ scry }, "chat/~host/channel", 100);

    expect(messages).toHaveLength(100);
    expect(messages.at(0)?.content).toBe("message-100");
    expect(messages.at(-1)?.content).toBe("message-1");
    expect(scry).not.toHaveBeenCalled();
  });
});
