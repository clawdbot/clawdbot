import { beforeEach, describe, expect, it, vi } from "vitest";

import type { PluginRuntime } from "clawdbot/plugin-sdk";
import { setMSTeamsRuntime } from "./runtime.js";

const detectMimeMock = vi.fn(async () => "image/png");
const saveMediaBufferMock = vi.fn(async () => ({
  path: "/tmp/saved.png",
  contentType: "image/png",
}));

const runtimeStub = {
  media: {
    detectMime: (...args: unknown[]) => detectMimeMock(...args),
  },
  channel: {
    media: {
      saveMediaBuffer: (...args: unknown[]) => saveMediaBufferMock(...args),
    },
  },
} as unknown as PluginRuntime;

describe("msteams attachments", () => {
  const load = async () => {
    return await import("./attachments.js");
  };

  beforeEach(() => {
    detectMimeMock.mockClear();
    saveMediaBufferMock.mockClear();
    setMSTeamsRuntime(runtimeStub);
  });

  describe("buildMSTeamsAttachmentPlaceholder", () => {
    it("returns empty string when no attachments", async () => {
      const { buildMSTeamsAttachmentPlaceholder } = await load();
      expect(buildMSTeamsAttachmentPlaceholder(undefined)).toBe("");
      expect(buildMSTeamsAttachmentPlaceholder([])).toBe("");
    });

    it("returns image placeholder for image attachments", async () => {
      const { buildMSTeamsAttachmentPlaceholder } = await load();
      expect(
        buildMSTeamsAttachmentPlaceholder([
          { contentType: "image/png", contentUrl: "https://x/img.png" },
        ]),
      ).toBe("<media:image>");
      expect(
        buildMSTeamsAttachmentPlaceholder([
          { contentType: "image/png", contentUrl: "https://x/1.png" },
          { contentType: "image/jpeg", contentUrl: "https://x/2.jpg" },
        ]),
      ).toBe("<media:image> (2 images)");
    });

    it("treats Teams file.download.info image attachments as images", async () => {
      const { buildMSTeamsAttachmentPlaceholder } = await load();
      expect(
        buildMSTeamsAttachmentPlaceholder([
          {
            contentType: "application/vnd.microsoft.teams.file.download.info",
            content: { downloadUrl: "https://x/dl", fileType: "png" },
          },
        ]),
      ).toBe("<media:image>");
    });

    it("returns document placeholder for non-image attachments", async () => {
      const { buildMSTeamsAttachmentPlaceholder } = await load();
      expect(
        buildMSTeamsAttachmentPlaceholder([
          { contentType: "application/pdf", contentUrl: "https://x/x.pdf" },
        ]),
      ).toBe("<media:document>");
      expect(
        buildMSTeamsAttachmentPlaceholder([
          { contentType: "application/pdf", contentUrl: "https://x/1.pdf" },
          { contentType: "application/pdf", contentUrl: "https://x/2.pdf" },
        ]),
      ).toBe("<media:document> (2 files)");
    });

    it("counts inline images in text/html attachments", async () => {
      const { buildMSTeamsAttachmentPlaceholder } = await load();
      expect(
        buildMSTeamsAttachmentPlaceholder([
          {
            contentType: "text/html",
            content: '<p>hi</p><img src="https://x/a.png" />',
          },
        ]),
      ).toBe("<media:image>");
      expect(
        buildMSTeamsAttachmentPlaceholder([
          {
            contentType: "text/html",
            content: '<img src="https://x/a.png" /><img src="https://x/b.png" />',
          },
        ]),
      ).toBe("<media:image> (2 images)");
    });
  });

  describe("downloadMSTeamsAttachments", () => {
    it("downloads and stores image contentUrl attachments", async () => {
      const { downloadMSTeamsAttachments } = await load();
      const fetchMock = vi.fn(async () => {
        return new Response(Buffer.from("png"), {
          status: 200,
          headers: { "content-type": "image/png" },
        });
      });

      const media = await downloadMSTeamsAttachments({
        attachments: [{ contentType: "image/png", contentUrl: "https://x/img" }],
        maxBytes: 1024 * 1024,
        allowHosts: ["x"],
        fetchFn: fetchMock as unknown as typeof fetch,
      });

      expect(fetchMock).toHaveBeenCalledWith("https://x/img");
      expect(saveMediaBufferMock).toHaveBeenCalled();
      expect(media).toHaveLength(1);
      expect(media[0]?.path).toBe("/tmp/saved.png");
    });

    it("supports Teams file.download.info downloadUrl attachments", async () => {
      const { downloadMSTeamsAttachments } = await load();
      const fetchMock = vi.fn(async () => {
        return new Response(Buffer.from("png"), {
          status: 200,
          headers: { "content-type": "image/png" },
        });
      });

      const media = await downloadMSTeamsAttachments({
        attachments: [
          {
            contentType: "application/vnd.microsoft.teams.file.download.info",
            content: { downloadUrl: "https://x/dl", fileType: "png" },
          },
        ],
        maxBytes: 1024 * 1024,
        allowHosts: ["x"],
        fetchFn: fetchMock as unknown as typeof fetch,
      });

      expect(fetchMock).toHaveBeenCalledWith("https://x/dl");
      expect(media).toHaveLength(1);
    });

    it("downloads non-image file attachments (PDF)", async () => {
      const { downloadMSTeamsAttachments } = await load();
      const fetchMock = vi.fn(async () => {
        return new Response(Buffer.from("pdf"), {
          status: 200,
          headers: { "content-type": "application/pdf" },
        });
      });
      detectMimeMock.mockResolvedValueOnce("application/pdf");
      saveMediaBufferMock.mockResolvedValueOnce({
        path: "/tmp/saved.pdf",
        contentType: "application/pdf",
      });

      const media = await downloadMSTeamsAttachments({
        attachments: [{ contentType: "application/pdf", contentUrl: "https://x/doc.pdf" }],
        maxBytes: 1024 * 1024,
        allowHosts: ["x"],
        fetchFn: fetchMock as unknown as typeof fetch,
      });

      expect(fetchMock).toHaveBeenCalledWith("https://x/doc.pdf");
      expect(media).toHaveLength(1);
      expect(media[0]?.path).toBe("/tmp/saved.pdf");
      expect(media[0]?.placeholder).toBe("<media:document>");
    });

    it("downloads inline image URLs from html attachments", async () => {
      const { downloadMSTeamsAttachments } = await load();
      const fetchMock = vi.fn(async () => {
        return new Response(Buffer.from("png"), {
          status: 200,
          headers: { "content-type": "image/png" },
        });
      });

      const media = await downloadMSTeamsAttachments({
        attachments: [
          {
            contentType: "text/html",
            content: '<img src="https://x/inline.png" />',
          },
        ],
        maxBytes: 1024 * 1024,
        allowHosts: ["x"],
        fetchFn: fetchMock as unknown as typeof fetch,
      });

      expect(media).toHaveLength(1);
      expect(fetchMock).toHaveBeenCalledWith("https://x/inline.png");
    });

    it("stores inline data:image base64 payloads", async () => {
      const { downloadMSTeamsAttachments } = await load();
      const base64 = Buffer.from("png").toString("base64");
      const media = await downloadMSTeamsAttachments({
        attachments: [
          {
            contentType: "text/html",
            content: `<img src="data:image/png;base64,${base64}" />`,
          },
        ],
        maxBytes: 1024 * 1024,
        allowHosts: ["x"],
      });

      expect(media).toHaveLength(1);
      expect(saveMediaBufferMock).toHaveBeenCalled();
    });

    it("retries with auth when the first request is unauthorized", async () => {
      const { downloadMSTeamsAttachments } = await load();
      const fetchMock = vi.fn(async (_url: string, opts?: RequestInit) => {
        const hasAuth = Boolean(
          opts &&
          typeof opts === "object" &&
          "headers" in opts &&
          (opts.headers as Record<string, string>)?.Authorization,
        );
        if (!hasAuth) {
          return new Response("unauthorized", { status: 401 });
        }
        return new Response(Buffer.from("png"), {
          status: 200,
          headers: { "content-type": "image/png" },
        });
      });

      const media = await downloadMSTeamsAttachments({
        attachments: [{ contentType: "image/png", contentUrl: "https://x/img" }],
        maxBytes: 1024 * 1024,
        tokenProvider: { getAccessToken: vi.fn(async () => "token") },
        allowHosts: ["x"],
        fetchFn: fetchMock as unknown as typeof fetch,
      });

      expect(fetchMock).toHaveBeenCalled();
      expect(media).toHaveLength(1);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("skips urls outside the allowlist", async () => {
      const { downloadMSTeamsAttachments } = await load();
      const fetchMock = vi.fn();
      const media = await downloadMSTeamsAttachments({
        attachments: [{ contentType: "image/png", contentUrl: "https://evil.test/img" }],
        maxBytes: 1024 * 1024,
        allowHosts: ["graph.microsoft.com"],
        fetchFn: fetchMock as unknown as typeof fetch,
      });

      expect(media).toHaveLength(0);
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe("buildMSTeamsGraphMessageUrls", () => {
    it("builds channel message urls", async () => {
      const { buildMSTeamsGraphMessageUrls } = await load();
      const urls = buildMSTeamsGraphMessageUrls({
        conversationType: "channel",
        conversationId: "19:thread@thread.tacv2",
        messageId: "123",
        channelData: { team: { id: "team-id" }, channel: { id: "chan-id" } },
      });
      expect(urls[0]).toContain("/teams/team-id/channels/chan-id/messages/123");
    });

    it("builds channel reply urls when replyToId is present", async () => {
      const { buildMSTeamsGraphMessageUrls } = await load();
      const urls = buildMSTeamsGraphMessageUrls({
        conversationType: "channel",
        messageId: "reply-id",
        replyToId: "root-id",
        channelData: { team: { id: "team-id" }, channel: { id: "chan-id" } },
      });
      expect(urls[0]).toContain(
        "/teams/team-id/channels/chan-id/messages/root-id/replies/reply-id",
      );
    });

    it("builds chat message urls", async () => {
      const { buildMSTeamsGraphMessageUrls } = await load();
      const urls = buildMSTeamsGraphMessageUrls({
        conversationType: "groupChat",
        conversationId: "19:chat@thread.v2",
        messageId: "456",
      });
      expect(urls[0]).toContain("/chats/19%3Achat%40thread.v2/messages/456");
    });
  });

  describe("downloadMSTeamsGraphMedia", () => {
    it("downloads hostedContents images", async () => {
      const { downloadMSTeamsGraphMedia } = await load();
      const base64 = Buffer.from("png").toString("base64");
      const fetchMock = vi.fn(async (url: string) => {
        if (url.endsWith("/hostedContents")) {
          return new Response(
            JSON.stringify({
              value: [
                {
                  id: "1",
                  contentType: "image/png",
                  contentBytes: base64,
                },
              ],
            }),
            { status: 200 },
          );
        }
        if (url.endsWith("/attachments")) {
          return new Response(JSON.stringify({ value: [] }), { status: 200 });
        }
        return new Response("not found", { status: 404 });
      });

      const media = await downloadMSTeamsGraphMedia({
        messageUrl: "https://graph.microsoft.com/v1.0/chats/19%3Achat/messages/123",
        tokenProvider: { getAccessToken: vi.fn(async () => "token") },
        maxBytes: 1024 * 1024,
        fetchFn: fetchMock as unknown as typeof fetch,
      });

      expect(media.media).toHaveLength(1);
      expect(fetchMock).toHaveBeenCalled();
      expect(saveMediaBufferMock).toHaveBeenCalled();
    });

    it("merges SharePoint reference attachments with hosted content", async () => {
      const { downloadMSTeamsGraphMedia } = await load();
      const hostedBase64 = Buffer.from("png").toString("base64");
      const shareUrl = "https://contoso.sharepoint.com/site/file";
      const fetchMock = vi.fn(async (url: string) => {
        if (url.endsWith("/hostedContents")) {
          return new Response(
            JSON.stringify({
              value: [
                {
                  id: "hosted-1",
                  contentType: "image/png",
                  contentBytes: hostedBase64,
                },
              ],
            }),
            { status: 200 },
          );
        }
        if (url.endsWith("/attachments")) {
          return new Response(
            JSON.stringify({
              value: [
                {
                  id: "ref-1",
                  contentType: "reference",
                  contentUrl: shareUrl,
                  name: "report.pdf",
                },
              ],
            }),
            { status: 200 },
          );
        }
        if (url.startsWith("https://graph.microsoft.com/v1.0/shares/")) {
          return new Response(Buffer.from("pdf"), {
            status: 200,
            headers: { "content-type": "application/pdf" },
          });
        }
        if (url.endsWith("/messages/123")) {
          return new Response(
            JSON.stringify({
              attachments: [
                {
                  id: "ref-1",
                  contentType: "reference",
                  contentUrl: shareUrl,
                  name: "report.pdf",
                },
              ],
            }),
            { status: 200 },
          );
        }
        return new Response("not found", { status: 404 });
      });

      const media = await downloadMSTeamsGraphMedia({
        messageUrl: "https://graph.microsoft.com/v1.0/chats/19%3Achat/messages/123",
        tokenProvider: { getAccessToken: vi.fn(async () => "token") },
        maxBytes: 1024 * 1024,
        fetchFn: fetchMock as unknown as typeof fetch,
      });

      expect(media.media).toHaveLength(2);
    });
  });

  describe("buildMSTeamsMediaPayload", () => {
    it("returns single and multi-file fields", async () => {
      const { buildMSTeamsMediaPayload } = await load();
      const payload = buildMSTeamsMediaPayload([
        { path: "/tmp/a.png", contentType: "image/png" },
        { path: "/tmp/b.png", contentType: "image/png" },
      ]);
      expect(payload.MediaPath).toBe("/tmp/a.png");
      expect(payload.MediaUrl).toBe("/tmp/a.png");
      expect(payload.MediaPaths).toEqual(["/tmp/a.png", "/tmp/b.png"]);
      expect(payload.MediaUrls).toEqual(["/tmp/a.png", "/tmp/b.png"]);
      expect(payload.MediaTypes).toEqual(["image/png", "image/png"]);
    });
  });
});
