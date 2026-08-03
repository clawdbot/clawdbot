import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PAGE_SHARE_GATEWAY_REQUIRED_ERROR,
  deliverPageShare,
  setPageShareSink,
} from "./page-share.js";

function createSink(sessionKey = "agent:main:main") {
  const enqueueSystemEvent = vi.fn();
  const requestHeartbeat = vi.fn();
  const resolveDefaultAgentId = vi.fn(() => "main");
  const resolveMainSessionKey = vi.fn(() => sessionKey);
  const sink = {
    enqueueSystemEvent,
    requestHeartbeat,
    resolveDefaultAgentId,
    resolveMainSessionKey,
  };
  return {
    enqueueSystemEvent,
    requestHeartbeat,
    resolveDefaultAgentId,
    resolveMainSessionKey,
    sink,
  };
}

afterEach(() => {
  setPageShareSink(null);
});

describe("page share delivery", () => {
  it("formats metadata, keeps the note trusted, and wakes a scoped session", async () => {
    const {
      enqueueSystemEvent,
      requestHeartbeat,
      resolveDefaultAgentId,
      resolveMainSessionKey,
      sink,
    } = createSink("agent:ops:main");
    setPageShareSink(sink);

    await deliverPageShare({
      url: "https://example.com/article",
      title: "Example article",
      content: "ignored content",
      selection: "  selected page text  ",
      note: "  Summarize for me  ",
    });

    expect(enqueueSystemEvent).toHaveBeenCalledOnce();
    expect(resolveDefaultAgentId).not.toHaveBeenCalled();
    expect(resolveMainSessionKey).toHaveBeenCalledOnce();
    const [text, options] = enqueueSystemEvent.mock.calls[0] as [string, { sessionKey: string }];
    expect(options).toEqual({ sessionKey: "agent:ops:main" });
    expect(text).toContain(
      "Page shared from the OpenClaw Chrome extension.\nNote: Summarize for me",
    );
    expect(text).toContain('<<<EXTERNAL_UNTRUSTED_CONTENT id="');
    expect(text).toContain("Source: Browser");
    expect(text).toContain("selected page text");
    expect(text).not.toContain("ignored content");
    expect(text.indexOf("Note: Summarize for me")).toBeLessThan(
      text.indexOf("<<<EXTERNAL_UNTRUSTED_CONTENT"),
    );
    // Page-controlled title/URL must sit inside the untrusted boundary.
    const boundaryStart = text.indexOf("<<<EXTERNAL_UNTRUSTED_CONTENT");
    expect(text.indexOf("Title: Example article")).toBeGreaterThan(boundaryStart);
    expect(text.indexOf("URL: https://example.com/article")).toBeGreaterThan(boundaryStart);
    expect(requestHeartbeat).toHaveBeenCalledExactlyOnceWith({
      source: "notifications-event",
      intent: "immediate",
      reason: "wake",
      sessionKey: "agent:ops:main",
      heartbeat: { target: "last" },
    });
  });

  it("supplies the default agent for the global session", async () => {
    const { requestHeartbeat, resolveDefaultAgentId, sink } = createSink("global");
    setPageShareSink(sink);

    await deliverPageShare({
      url: "https://example.com",
      title: "Example",
      content: "full page content",
    });

    expect(resolveDefaultAgentId).toHaveBeenCalledOnce();
    expect(requestHeartbeat).toHaveBeenCalledExactlyOnceWith({
      source: "notifications-event",
      intent: "immediate",
      reason: "wake",
      agentId: "main",
      sessionKey: "global",
      heartbeat: { target: "last" },
    });
  });

  it("omits an empty note and falls back to page content", async () => {
    const { enqueueSystemEvent, sink } = createSink();
    setPageShareSink(sink);

    await deliverPageShare({
      url: "https://example.com",
      title: "Example",
      content: "full page content",
      note: "   ",
    });

    const text = enqueueSystemEvent.mock.calls[0]?.[0] as string;
    expect(text).not.toContain("Note:");
    expect(text).toContain("full page content");
  });

  it("rejects delivery outside the gateway process", async () => {
    await expect(
      deliverPageShare({
        url: "https://example.com",
        title: "Example",
        content: "body",
      }),
    ).rejects.toThrow(PAGE_SHARE_GATEWAY_REQUIRED_ERROR);
  });
});
