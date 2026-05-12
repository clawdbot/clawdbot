import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../runtime-api.js";
import { createChannelMessageReplyPipeline } from "../runtime-api.js";

const { sendMessageMattermostMock, mockFetchGuard } = vi.hoisted(() => ({
  sendMessageMattermostMock: vi.fn(),
  mockFetchGuard: vi.fn(async (p: { url: string; init?: RequestInit }) => {
    const response = await globalThis.fetch(p.url, p.init);
    return { response, release: async () => {}, finalUrl: p.url };
  }),
}));

vi.mock("./mattermost/send.js", () => ({
  sendMessageMattermost: sendMessageMattermostMock,
}));

vi.mock("openclaw/plugin-sdk/ssrf-runtime", async () => {
  const original = (await vi.importActual("openclaw/plugin-sdk/ssrf-runtime")) as Record<
    string,
    unknown
  >;
  return { ...original, fetchWithSsrFGuard: mockFetchGuard };
});

import { mattermostPlugin } from "./channel.js";
import { resetMattermostReactionBotUserCacheForTests } from "./mattermost/reactions.js";
import {
  createMattermostReactionFetchMock,
  createMattermostTestConfig,
  withMockedGlobalFetch,
} from "./mattermost/reactions.test-helpers.js";

type MattermostHandleAction = NonNullable<
  NonNullable<typeof mattermostPlugin.actions>["handleAction"]
>;
type MattermostActionContext = Parameters<MattermostHandleAction>[0];
type MattermostSendText = NonNullable<NonNullable<typeof mattermostPlugin.outbound>["sendText"]>;
type MattermostSendTextParams = Parameters<MattermostSendText>[0];
type MattermostSendMedia = NonNullable<NonNullable<typeof mattermostPlugin.outbound>["sendMedia"]>;
type MattermostSendMediaParams = Parameters<MattermostSendMedia>[0];

function getDescribedActions(cfg: OpenClawConfig, accountId?: string): string[] {
  return [...(mattermostPlugin.actions?.describeMessageTool?.({ cfg, accountId })?.actions ?? [])];
}

function requireMattermostNormalizeTarget() {
  const normalize = mattermostPlugin.messaging?.normalizeTarget;
  if (!normalize) {
    throw new Error("mattermost messaging.normalizeTarget missing");
  }
  return normalize;
}

function requireMattermostPairingNormalizer() {
  const normalize = mattermostPlugin.pairing?.normalizeAllowEntry;
  if (!normalize) {
    throw new Error("mattermost pairing.normalizeAllowEntry missing");
  }
  return normalize;
}

function requireMattermostReplyToModeResolver() {
  const resolveReplyToMode = mattermostPlugin.threading?.resolveReplyToMode;
  if (!resolveReplyToMode) {
    throw new Error("mattermost threading.resolveReplyToMode missing");
  }
  return resolveReplyToMode;
}

function requireMattermostSendText() {
  const sendText = mattermostPlugin.outbound?.sendText;
  if (!sendText) {
    throw new Error("mattermost outbound.sendText missing");
  }
  return sendText;
}

function requireMattermostSendMedia() {
  const sendMedia = mattermostPlugin.outbound?.sendMedia;
  if (!sendMedia) {
    throw new Error("mattermost outbound.sendMedia missing");
  }
  return sendMedia;
}

function requireMattermostChunker() {
  const chunker = mattermostPlugin.outbound?.chunker;
  if (!chunker) {
    throw new Error("mattermost outbound.chunker missing");
  }
  return chunker;
}

function createMattermostActionContext(
  overrides: Partial<MattermostActionContext>,
): MattermostActionContext {
  return {
    channel: "mattermost",
    action: "send",
    params: {},
    cfg: createMattermostTestConfig(),
    ...overrides,
  };
}

function expectSingleMattermostSend(to: string, text: string): Record<string, unknown> {
  expect(sendMessageMattermostMock).toHaveBeenCalledTimes(1);
  const [call] = sendMessageMattermostMock.mock.calls;
  if (!call) {
    throw new Error("expected Mattermost send call");
  }
  const [actualTo, actualText, options] = call;
  expect(actualTo).toBe(to);
  expect(actualText).toBe(text);
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw new Error("expected Mattermost send options object");
  }
  return options as Record<string, unknown>;
}

describe("mattermostPlugin", () => {
  beforeEach(() => {
    sendMessageMattermostMock.mockReset();
    sendMessageMattermostMock.mockResolvedValue({
      messageId: "post-1",
      channelId: "channel-1",
    });
  });

  describe("messaging", () => {
    it("keeps @username targets", () => {
      const normalize = requireMattermostNormalizeTarget();

      expect(normalize("@Alice")).toBe("@Alice");
      expect(normalize("@alice")).toBe("@alice");
    });

    it("normalizes spaced mattermost prefixes to user targets", () => {
      const normalize = requireMattermostNormalizeTarget();

      expect(normalize("mattermost:USER123")).toBe("user:USER123");
      expect(normalize("  mattermost:USER123  ")).toBe("user:USER123");
    });
  });

  describe("pairing", () => {
    it("normalizes allowlist entries", () => {
      const normalize = requireMattermostPairingNormalizer();

      expect(normalize("@Alice")).toBe("alice");
      expect(normalize("user:USER123")).toBe("user123");
      expect(normalize("  @Alice  ")).toBe("alice");
      expect(normalize("  mattermost:USER123  ")).toBe("user123");
    });
  });

  describe("threading", () => {
    it("uses replyToMode for channel messages and keeps direct messages off", () => {
      const resolveReplyToMode = requireMattermostReplyToModeResolver();

      const cfg: OpenClawConfig = {
        channels: {
          mattermost: {
            replyToMode: "all",
          },
        },
      };

      expect(
        resolveReplyToMode({
          cfg,
          accountId: "default",
          chatType: "channel",
        }),
      ).toBe("all");
      expect(
        resolveReplyToMode({
          cfg,
          accountId: "default",
          chatType: "direct",
        }),
      ).toBe("off");
    });

    it("uses configured defaultAccount when accountId is omitted", () => {
      const resolveReplyToMode = requireMattermostReplyToModeResolver();

      const cfg: OpenClawConfig = {
        channels: {
          mattermost: {
            defaultAccount: "alerts",
            replyToMode: "off",
            accounts: {
              alerts: {
                replyToMode: "all",
                botToken: "alerts-token",
                baseUrl: "https://alerts.example.com",
              },
            },
          },
        },
      };

      expect(
        resolveReplyToMode({
          cfg,
          chatType: "channel",
        }),
      ).toBe("all");
    });
  });

  describe("messageActions", () => {
    beforeEach(() => {
      resetMattermostReactionBotUserCacheForTests();
    });

    const runReactAction = async (params: Record<string, unknown>, fetchMode: "add" | "remove") => {
      const cfg = createMattermostTestConfig();
      const fetchImpl = createMattermostReactionFetchMock({
        mode: fetchMode,
        postId: "POST1",
        emojiName: "thumbsup",
      });

      return await withMockedGlobalFetch(fetchImpl, async () => {
        return await mattermostPlugin.actions?.handleAction?.(
          createMattermostActionContext({
            action: "react",
            params,
            cfg,
            accountId: "default",
          }),
        );
      });
    };

    it("exposes react when mattermost is configured", () => {
      const cfg: OpenClawConfig = {
        channels: {
          mattermost: {
            enabled: true,
            botToken: "test-token",
            baseUrl: "https://chat.example.com",
          },
        },
      };

      const actions = getDescribedActions(cfg);
      expect(actions).toContain("react");
      expect(actions).toContain("send");
      expect(mattermostPlugin.actions?.supportsAction?.({ action: "react" })).toBe(true);
      expect(mattermostPlugin.actions?.supportsAction?.({ action: "send" })).toBe(true);
    });

    it("hides react when mattermost is not configured", () => {
      const cfg: OpenClawConfig = {
        channels: {
          mattermost: {
            enabled: true,
          },
        },
      };

      const actions = getDescribedActions(cfg);
      expect(actions).toStrictEqual([]);
    });

    it("declares presentation capability for message sends", () => {
      const cfg: OpenClawConfig = {
        channels: {
          mattermost: {
            enabled: true,
            botToken: "test-token",
            baseUrl: "https://chat.example.com",
          },
        },
      };

      const discovery = mattermostPlugin.actions?.describeMessageTool?.({ cfg });
      expect(discovery?.capabilities).toContain("presentation");
      expect(discovery?.schema).toBeUndefined();
    });

    it("hides react when actions.reactions is false", () => {
      const cfg: OpenClawConfig = {
        channels: {
          mattermost: {
            enabled: true,
            botToken: "test-token",
            baseUrl: "https://chat.example.com",
            actions: { reactions: false },
          },
        },
      };

      const actions = getDescribedActions(cfg);
      expect(actions).not.toContain("react");
      expect(actions).toContain("send");
    });

    it("respects per-account actions.reactions in message discovery", () => {
      const cfg: OpenClawConfig = {
        channels: {
          mattermost: {
            enabled: true,
            actions: { reactions: false },
            accounts: {
              default: {
                enabled: true,
                botToken: "test-token",
                baseUrl: "https://chat.example.com",
                actions: { reactions: true },
              },
            },
          },
        },
      };

      const actions = getDescribedActions(cfg);
      expect(actions).toContain("react");
    });

    it("honors the selected Mattermost account during discovery", () => {
      const cfg: OpenClawConfig = {
        channels: {
          mattermost: {
            enabled: true,
            actions: { reactions: false },
            accounts: {
              default: {
                enabled: true,
                botToken: "test-token",
                baseUrl: "https://chat.example.com",
                actions: { reactions: false },
              },
              work: {
                enabled: true,
                botToken: "work-token",
                baseUrl: "https://chat.example.com",
                actions: { reactions: true },
              },
            },
          },
        },
      };

      expect(getDescribedActions(cfg, "default")).toEqual(["send"]);
      expect(getDescribedActions(cfg, "work")).toEqual(["send", "react"]);
    });

    it("blocks react when default account disables reactions and accountId is omitted", async () => {
      const cfg: OpenClawConfig = {
        channels: {
          mattermost: {
            enabled: true,
            actions: { reactions: true },
            accounts: {
              default: {
                enabled: true,
                botToken: "test-token",
                baseUrl: "https://chat.example.com",
                actions: { reactions: false },
              },
            },
          },
        },
      };

      await expect(
        mattermostPlugin.actions?.handleAction?.(
          createMattermostActionContext({
            action: "react",
            params: { messageId: "POST1", emoji: "thumbsup" },
            cfg,
          }),
        ),
      ).rejects.toThrow("Mattermost reactions are disabled in config");
    });

    it("handles react by calling Mattermost reactions API", async () => {
      const result = await runReactAction({ messageId: "POST1", emoji: "thumbsup" }, "add");

      expect(result?.content).toEqual([{ type: "text", text: "Reacted with :thumbsup: on POST1" }]);
      expect(result?.details).toStrictEqual({});
    });

    it("only treats boolean remove flag as removal", async () => {
      const result = await runReactAction(
        { messageId: "POST1", emoji: "thumbsup", remove: "true" },
        "add",
      );

      expect(result?.content).toEqual([{ type: "text", text: "Reacted with :thumbsup: on POST1" }]);
    });

    it("removes reaction when remove flag is boolean true", async () => {
      const result = await runReactAction(
        { messageId: "POST1", emoji: "thumbsup", remove: true },
        "remove",
      );

      expect(result?.content).toEqual([
        { type: "text", text: "Removed reaction :thumbsup: from POST1" },
      ]);
      expect(result?.details).toStrictEqual({});
    });

    it("maps replyTo to replyToId for send actions", async () => {
      const cfg = createMattermostTestConfig();

      await mattermostPlugin.actions?.handleAction?.(
        createMattermostActionContext({
          action: "send",
          params: {
            to: "channel:CHAN1",
            message: "hello",
            replyTo: "post-root",
          },
          cfg,
          accountId: "default",
        }),
      );

      const options = expectSingleMattermostSend("channel:CHAN1", "hello");
      expect(options.accountId).toBe("default");
      expect(options.replyToId).toBe("post-root");
    });

    it("falls back to trimmed replyTo when replyToId is blank", async () => {
      const cfg = createMattermostTestConfig();

      await mattermostPlugin.actions?.handleAction?.(
        createMattermostActionContext({
          action: "send",
          params: {
            to: "channel:CHAN1",
            message: "hello",
            replyToId: "   ",
            replyTo: " post-root ",
          },
          cfg,
          accountId: "default",
        }),
      );

      const options = expectSingleMattermostSend("channel:CHAN1", "hello");
      expect(options.accountId).toBe("default");
      expect(options.replyToId).toBe("post-root");
    });
  });

  describe("outbound", () => {
    it("chunks outbound text without requiring Mattermost runtime initialization", () => {
      const chunker = requireMattermostChunker();

      expect(chunker("hello world", 5)).toEqual(["hello", "world"]);
    });

    it("forwards mediaLocalRoots on sendMedia", async () => {
      const sendMedia = requireMattermostSendMedia();
      const cfg = createMattermostTestConfig();

      const params: MattermostSendMediaParams = {
        cfg,
        to: "channel:CHAN1",
        text: "hello",
        mediaUrl: "/tmp/workspace/image.png",
        mediaLocalRoots: ["/tmp/workspace"],
        accountId: "default",
        replyToId: "post-root",
      };

      await sendMedia(params);

      const options = expectSingleMattermostSend("channel:CHAN1", "hello");
      expect(options.mediaUrl).toBe("/tmp/workspace/image.png");
      expect(options.mediaLocalRoots).toStrictEqual(["/tmp/workspace"]);
    });

    it("threads resolved cfg on sendText", async () => {
      const sendText = requireMattermostSendText();
      const cfg = {
        channels: {
          mattermost: {
            botToken: "resolved-bot-token",
            baseUrl: "https://chat.example.com",
          },
        },
      } as OpenClawConfig;

      const params: MattermostSendTextParams = {
        cfg,
        to: "channel:CHAN1",
        text: "hello",
        accountId: "default",
      };

      await sendText(params);

      const options = expectSingleMattermostSend("channel:CHAN1", "hello");
      expect(options.cfg).toBe(cfg);
      expect(options.accountId).toBe("default");
    });

    it("uses threadId as fallback when replyToId is absent (sendText)", async () => {
      const sendText = requireMattermostSendText();
      const cfg = createMattermostTestConfig();

      const params: MattermostSendTextParams = {
        cfg,
        to: "channel:CHAN1",
        text: "hello",
        accountId: "default",
        threadId: "post-root",
      };

      await sendText(params);

      const options = expectSingleMattermostSend("channel:CHAN1", "hello");
      expect(options.accountId).toBe("default");
      expect(options.replyToId).toBe("post-root");
    });

    it("uses threadId as fallback when replyToId is absent (sendMedia)", async () => {
      const sendMedia = requireMattermostSendMedia();
      const cfg = createMattermostTestConfig();

      const params: MattermostSendMediaParams = {
        cfg,
        to: "channel:CHAN1",
        text: "caption",
        mediaUrl: "https://example.com/image.png",
        accountId: "default",
        threadId: "post-root",
      };

      await sendMedia(params);

      const options = expectSingleMattermostSend("channel:CHAN1", "caption");
      expect(options.accountId).toBe("default");
      expect(options.replyToId).toBe("post-root");
    });
  });

  describe("config", () => {
    it("formats allowFrom entries", () => {
      const formatAllowFrom = mattermostPlugin.config.formatAllowFrom!;

      const formatted = formatAllowFrom({
        cfg: {} as OpenClawConfig,
        allowFrom: [" @Alice ", " user:USER123 ", " mattermost:BOT999 "],
      });
      expect(formatted).toEqual(["@alice", "user123", "bot999"]);
    });

    it("uses account responsePrefix overrides", () => {
      const cfg: OpenClawConfig = {
        channels: {
          mattermost: {
            responsePrefix: "[Channel]",
            accounts: {
              default: { responsePrefix: "[Account]" },
            },
          },
        },
      };

      const prefixContext = createChannelMessageReplyPipeline({
        cfg,
        agentId: "main",
        channel: "mattermost",
        accountId: "default",
      });

      expect(prefixContext.responsePrefix).toBe("[Account]");
    });
  });
});
