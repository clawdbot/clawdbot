// Qqbot tests cover channel.message adapter plugin behavior.
import { verifyChannelMessageAdapterCapabilityProofs } from "openclaw/plugin-sdk/channel-outbound";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it, vi } from "vitest";
import { qqbotPlugin } from "./channel.js";

describe("qqbotPlugin metadata", () => {
  it("opts announce delivery into persisted session lookup", () => {
    expect(qqbotPlugin.meta.preferSessionLookupForAnnounceTarget).toBe(true);
  });
});

describe("qqbot outbound sanitizeText", () => {
  it("strips reasoning/thinking tags before delivery", () => {
    const sanitize = qqbotPlugin.outbound?.sanitizeText;
    expect(sanitize).toBeDefined();
    if (!sanitize) {
      return;
    }

    const input1 = "<thinking>internal reasoning</thinking>final answer";
    expect(sanitize({ text: input1, payload: { text: input1 } })).toBe("final answer");

    const input2 = "<think>step by step</think>result";
    expect(sanitize({ text: input2, payload: { text: input2 } })).toBe("result");

    const input3 = "plain text without tags";
    expect(sanitize({ text: input3, payload: { text: input3 } })).toBe("plain text without tags");
  });
});

describe("qqbot outbound session routing", () => {
  it.each([
    {
      target: "qqbot:c2c:user-openid",
      peerKind: "direct",
      chatType: "direct",
    },
    {
      target: "qqbot:group:group-openid",
      peerKind: "group",
      chatType: "group",
    },
    {
      target: "qqbot:channel:channel-id",
      peerKind: "group",
      chatType: "group",
    },
  ] as const)("routes $target as $chatType", async ({ target, peerKind, chatType }) => {
    const route = await qqbotPlugin.messaging?.resolveOutboundSessionRoute?.({
      cfg: {},
      agentId: "main",
      target,
    });

    expect(route).toMatchObject({
      peer: { kind: peerKind },
      chatType,
      from: target,
      to: target,
    });
  });
});

const sendTextMock = vi.hoisted(() => vi.fn());
const sendMediaMock = vi.hoisted(() => vi.fn());

type SentTextParams = {
  to?: string;
  text?: string;
  replyToId?: string | null;
  mediaAccess?: {
    localRoots?: readonly string[];
    workspaceDir?: string;
    readFile?: (filePath: string) => Promise<Buffer>;
  };
  mediaLocalRoots?: readonly string[];
  mediaReadFile?: (filePath: string) => Promise<Buffer>;
};

type SentMediaParams = {
  to?: string;
  text?: string;
  mediaUrl?: string;
  mediaAccess?: {
    localRoots?: readonly string[];
    workspaceDir?: string;
    readFile?: (filePath: string) => Promise<Buffer>;
  };
  mediaLocalRoots?: readonly string[];
  mediaReadFile?: (filePath: string) => Promise<Buffer>;
};

function latestMockArg(mock: ReturnType<typeof vi.fn>, label: string): unknown {
  const call = mock.mock.calls[mock.mock.calls.length - 1];
  if (!call) {
    throw new Error(`expected ${label} call`);
  }
  return call[0];
}

vi.mock("./bridge/gateway.js", () => ({}));
vi.mock("./engine/messaging/outbound.js", () => ({
  sendText: sendTextMock,
  sendMedia: sendMediaMock,
}));

const cfg = {
  channels: {
    qqbot: {
      appId: "app",
      clientSecret: "secret",
    },
  },
} as OpenClawConfig;

describe("qqbot message adapter", () => {
  it("declares durable text, media, and reply target capabilities with receipt proofs", async () => {
    sendTextMock.mockResolvedValue({ messageId: "qq-text-1" });
    sendMediaMock.mockResolvedValue({ messageId: "qq-media-1" });

    const proofResults = await verifyChannelMessageAdapterCapabilityProofs({
      adapterName: "qqbot",
      adapter: qqbotPlugin.message!,
      proofs: {
        text: async () => {
          const result = await qqbotPlugin.message?.send?.text?.({
            cfg,
            to: "qqbot:c2c:user-1",
            text: "hello",
          });
          const sent = latestMockArg(sendTextMock, "sendText") as SentTextParams;
          expect(sent.to).toBe("qqbot:c2c:user-1");
          expect(sent.text).toBe("hello");
          expect(result?.receipt.platformMessageIds).toEqual(["qq-text-1"]);
        },
        media: async () => {
          const mediaAccess = {
            localRoots: ["/tmp/openclaw-sandbox"],
            workspaceDir: "/tmp/workspace",
          };
          const result = await qqbotPlugin.message?.send?.media?.({
            cfg,
            to: "qqbot:c2c:user-1",
            text: "image",
            mediaUrl: "https://example.com/image.png",
            mediaAccess,
            mediaLocalRoots: ["/tmp/openclaw-sandbox"],
          });
          const sent = latestMockArg(sendMediaMock, "sendMedia") as SentMediaParams;
          expect(sent.to).toBe("qqbot:c2c:user-1");
          expect(sent.text).toBe("image");
          expect(sent.mediaUrl).toBe("https://example.com/image.png");
          expect(sent.mediaAccess).toBe(mediaAccess);
          expect(sent.mediaLocalRoots).toEqual(["/tmp/openclaw-sandbox"]);
          expect(result?.receipt.platformMessageIds).toEqual(["qq-media-1"]);
        },
        replyTo: async () => {
          const result = await qqbotPlugin.message?.send?.text?.({
            cfg,
            to: "qqbot:group:group-1",
            text: "reply",
            replyToId: "msg-1",
          });
          const sent = latestMockArg(sendTextMock, "sendText") as SentTextParams;
          expect(sent.to).toBe("qqbot:group:group-1");
          expect(sent.text).toBe("reply");
          expect(sent.replyToId).toBe("msg-1");
          expect(result?.receipt.platformMessageIds).toEqual(["qq-text-1"]);
        },
      },
    });

    expect(proofResults.find((result) => result.capability === "text")?.status).toBe("verified");
    expect(proofResults.find((result) => result.capability === "media")?.status).toBe("verified");
    expect(proofResults.find((result) => result.capability === "replyTo")?.status).toBe("verified");
  });

  it("rejects media sends when QQBot reports an outbound error", async () => {
    sendMediaMock.mockResolvedValue({ error: "QQ API returned 400 Bad Request" });

    await expect(
      qqbotPlugin.message?.send?.media?.({
        cfg,
        to: "qqbot:c2c:user-1",
        text: "image",
        mediaUrl: "https://example.com/image.png",
      }),
    ).rejects.toThrow("QQ API returned 400 Bad Request");
  });

  it("rejects text sends when QQBot reports an outbound error", async () => {
    sendTextMock.mockResolvedValue({ error: "QQ API returned 400 Bad Request" });

    await expect(
      qqbotPlugin.message?.send?.text?.({
        cfg,
        to: "qqbot:c2c:user-1",
        text: "hello",
      }),
    ).rejects.toThrow("QQ API returned 400 Bad Request");
  });

  it("rejects media sends without a QQ platform message id", async () => {
    sendMediaMock.mockResolvedValue({});

    await expect(
      qqbotPlugin.message?.send?.media?.({
        cfg,
        to: "qqbot:c2c:user-1",
        text: "image",
        mediaUrl: "https://example.com/image.png",
      }),
    ).rejects.toThrow("QQBot message adapter send did not return a platform message id");
  });

  it("rejects text sends without a QQ platform message id", async () => {
    sendTextMock.mockResolvedValue({});

    await expect(
      qqbotPlugin.message?.send?.text?.({
        cfg,
        to: "qqbot:c2c:user-1",
        text: "hello",
      }),
    ).rejects.toThrow("QQBot message adapter send did not return a platform message id");
  });

  it("forwards scoped media access through outbound text and media sends", async () => {
    const mediaReadFile = vi.fn(async () => Buffer.from("report"));
    const mediaAccess = {
      localRoots: ["/tmp/openclaw-sandbox"],
      workspaceDir: "/tmp/workspace",
      readFile: mediaReadFile,
    };
    const mediaLocalRoots = ["/tmp/openclaw-sandbox"];

    sendTextMock.mockResolvedValueOnce({ messageId: "qq-text-media-1" });
    await qqbotPlugin.outbound?.sendText?.({
      cfg,
      to: "qqbot:c2c:user-1",
      text: "<qqmedia>/tmp/openclaw-sandbox/report.docx</qqmedia>",
      mediaAccess,
      mediaLocalRoots,
      mediaReadFile,
    });
    const sentText = latestMockArg(sendTextMock, "sendText") as SentTextParams;
    expect(sentText.mediaAccess).toBe(mediaAccess);
    expect(sentText.mediaLocalRoots).toBe(mediaLocalRoots);
    expect(sentText.mediaReadFile).toBe(mediaReadFile);

    sendMediaMock.mockResolvedValueOnce({ messageId: "qq-media-local-1" });
    await qqbotPlugin.outbound?.sendMedia?.({
      cfg,
      to: "qqbot:c2c:user-1",
      text: "report",
      mediaUrl: "/tmp/openclaw-sandbox/report.docx",
      mediaAccess,
      mediaLocalRoots,
      mediaReadFile,
    });
    const sentMedia = latestMockArg(sendMediaMock, "sendMedia") as SentMediaParams;
    expect(sentMedia.mediaUrl).toBe("/tmp/openclaw-sandbox/report.docx");
    expect(sentMedia.mediaAccess).toBe(mediaAccess);
    expect(sentMedia.mediaLocalRoots).toBe(mediaLocalRoots);
    expect(sentMedia.mediaReadFile).toBe(mediaReadFile);
  });
});
