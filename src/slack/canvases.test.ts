import { describe, expect, it, vi } from "vitest";

import type { WebClient } from "@slack/web-api";

import {
  extractCanvasRefsFromEvent,
  fetchSlackCanvasContent,
  isSlackCanvasFile,
} from "./canvases.js";
import type { SlackMessageEvent } from "./types.js";

function createClient() {
  return {
    files: {
      info: vi.fn(async () => ({
        file: {
          id: "F123",
          title: "Canvas Title",
          url_private_download: "https://files.slack.com/canvas.json",
        },
      })),
    },
  } as unknown as WebClient;
}

describe("isSlackCanvasFile", () => {
  it("detects canvas mimetype", () => {
    expect(isSlackCanvasFile({ mimetype: "application/vnd.slack-docs" })).toBe(true);
  });

  it("detects canvas pretty_type", () => {
    expect(isSlackCanvasFile({ pretty_type: "Canvas" })).toBe(true);
  });

  it("detects quip filetype", () => {
    expect(isSlackCanvasFile({ filetype: "quip" })).toBe(true);
  });
});

describe("extractCanvasRefsFromEvent", () => {
  it("finds canvas files and URLs", () => {
    const event: SlackMessageEvent = {
      type: "message",
      channel: "C1",
      ts: "1.2",
      text: "See https://acme.slack.com/docs/T123/F12345678",
      files: [{ id: "F999", mimetype: "application/vnd.slack-docs" }],
    } as SlackMessageEvent;

    const refs = extractCanvasRefsFromEvent(event);
    const ids = refs.map((ref) => ref.fileId).filter(Boolean);
    expect(ids).toContain("F999");
    expect(ids).toContain("F12345678");
  });
});

describe("fetchSlackCanvasContent", () => {
  it("downloads and parses JSON canvas content", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ text: "hello canvas" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const client = createClient();
    const result = await fetchSlackCanvasContent({
      ref: { fileId: "F123" },
      client,
      token: "xoxb-test",
      maxBytes: 1024,
      maxChars: 1000,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.extractedText).toContain("hello canvas");
      expect(result.rawFormat).toBe("json");
    }
    vi.unstubAllGlobals();
  });

  it("returns missing_scope errors", async () => {
    const client = {
      files: {
        info: vi.fn(async () => {
          const err = new Error("missing_scope");
          (err as any).data = { error: "missing_scope", needed: "files:read" };
          throw err;
        }),
      },
    } as unknown as WebClient;

    const result = await fetchSlackCanvasContent({
      ref: { fileId: "F123" },
      client,
      token: "xoxb-test",
      maxBytes: 1024,
      maxChars: 1000,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("missing_scope");
    }
  });

  it("handles download HTTP failures", async () => {
    const fetchMock = vi.fn(async () => new Response("forbidden", { status: 403 }));
    vi.stubGlobal("fetch", fetchMock);

    const client = createClient();
    const result = await fetchSlackCanvasContent({
      ref: { fileId: "F123" },
      client,
      token: "xoxb-test",
      maxBytes: 1024,
      maxChars: 1000,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("download_http_403");
    }
    vi.unstubAllGlobals();
  });

  it("truncates large payloads", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ text: "1234567890" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const client = createClient();
    const result = await fetchSlackCanvasContent({
      ref: { fileId: "F123" },
      client,
      token: "xoxb-test",
      maxBytes: 1024,
      maxChars: 5,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.truncated).toBe(true);
      expect(result.extractedText.length).toBeLessThanOrEqual(5);
    }
    vi.unstubAllGlobals();
  });
});
