import { describe, expect, it, vi } from "vitest";
import type { ClickClackDiscussionService } from "./service.js";
import { createClickClackDiscussionTool } from "./tool.js";

describe("ClickClack discussion tool", () => {
  it("returns a short unbound result without making a request", async () => {
    const readLatestMessages = vi.fn();
    const tool = createClickClackDiscussionTool({
      service: { readLatestMessages } as unknown as ClickClackDiscussionService,
      sessionKey: undefined,
    });

    const result = await tool.execute("call-1", {});

    expect(result.content).toEqual([
      { type: "text", text: "No discussion is bound to this session." },
    ]);
    expect(readLatestMessages).not.toHaveBeenCalled();
  });

  it("uses the default limit and returns formatted service output", async () => {
    const readLatestMessages = vi.fn(async () => ({
      binding: { channelId: "chn_1" },
      text: "2026-07-19T12:30:00.000Z [Alice] Status?",
    }));
    const tool = createClickClackDiscussionTool({
      service: { readLatestMessages } as unknown as ClickClackDiscussionService,
      sessionKey: "agent:main:main",
    });

    const result = await tool.execute("call-1", {});

    expect(readLatestMessages).toHaveBeenCalledWith("agent:main:main", 30);
    expect(result.content).toEqual([
      { type: "text", text: "2026-07-19T12:30:00.000Z [Alice] Status?" },
    ]);
    expect(result.details).toEqual({ bound: true, limit: 30, channelId: "chn_1" });
  });
});
