import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PAGE_SHARE_GATEWAY_REQUIRED_ERROR,
  deliverPageShare,
  setPageShareSink,
} from "./page-share.js";

function createSink() {
  const enqueueSystemEvent = vi.fn();
  const requestHeartbeat = vi.fn();
  const sink = {
    enqueueSystemEvent,
    requestHeartbeat,
    resolveMainSessionKey: () => "agent:main:main",
  };
  return { enqueueSystemEvent, requestHeartbeat, sink };
}

afterEach(() => {
  setPageShareSink(null);
});

describe("page share delivery", () => {
  it("formats metadata, keeps the note trusted, and wraps selected page text", async () => {
    const { enqueueSystemEvent, requestHeartbeat, sink } = createSink();
    setPageShareSink(sink);

    await deliverPageShare({
      url: "https://example.com/article",
      title: "Example article",
      content: "ignored content",
      selection: "  selected page text  ",
      note: "  Summarize for me  ",
    });

    expect(enqueueSystemEvent).toHaveBeenCalledOnce();
    const [text, options] = enqueueSystemEvent.mock.calls[0] as [string, { sessionKey: string }];
    expect(options).toEqual({ sessionKey: "agent:main:main" });
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
    expect(requestHeartbeat).toHaveBeenCalledWith({
      source: "other",
      intent: "immediate",
      reason: "browser-page-share",
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
