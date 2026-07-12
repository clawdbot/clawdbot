// Mattermost tests cover channel plugin behavior.
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
type MattermostRenderPresentation = NonNullable<
  NonNullable<typeof mattermostPlugin.outbound>["renderPresentation"]
>;
type MattermostSendPayload = NonNullable<
  NonNullable<typeof mattermostPlugin.outbound>["sendPayload"]
>;

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

function requireMattermostThreadTargetMatcher() {
  const matchesToolContextTarget = mattermostPlugin.threading?.matchesToolContextTarget;
  if (!matchesToolContextTarget) {
    throw new Error("mattermost threading.matchesToolContextTarget missing");
  }
  return matchesToolContextTarget;
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

function requireMattermostRenderPresentation(): MattermostRenderPresentation {
  const renderPresentation = mattermostPlugin.outbound?.renderPresentation;
  if (!renderPresentation) {
    throw new Error("mattermost outbound.renderPresentation missing");
  }
  return renderPresentation;
}

function requireMattermostSendPayload(): MattermostSendPayload {
  const sendPayload = mattermostPlugin.outbound?.sendPayload;
  if (!sendPayload) {
    throw new Error("mattermost outbound.sendPayload missing");
  }
  return sendPayload;
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
    it("builds tool context from the effective Mattermost thread root", () => {
      const buildToolContext = mattermostPlugin.threading?.buildToolContext;
      if (!buildToolContext) {
        throw new Error("mattermost threading.buildToolContext missing");
      }
      const hasRepliedRef = { value: false };

      expect(
        buildToolContext({
          cfg: createMattermostTestConfig(),
          accountId: "default",
          context: {
            To: "channel:C1",
            ChatType: "channel",
            CurrentMessageId: "child-1",
            MessageThreadId: "root-1",
          },
          hasRepliedRef,
        }),
      ).toEqual({
        currentChannelId: "channel:C1",
        currentThreadTs: "root-1",
        currentMessageId: "child-1",
        replyToMode: "all",
        hasRepliedRef,
        sameChannelThreadRequired: true,
      });
    });

    it.each(["first", "batched"] as const)(
      "preserves %s mode when the current post starts the thread",
      (replyToMode) => {
        const buildToolContext = mattermostPlugin.threading?.buildToolContext;
        if (!buildToolContext) {
          throw new Error("mattermost threading.buildToolContext missing");
        }

        const context = buildToolContext({
          cfg: {
            channels: {
              mattermost: {
                replyToMode,
              },
            },
          },
          accountId: "default",
          context: {
            To: "channel:C1",
            ChatType: "channel",
            CurrentMessageId: "post-1",
            MessageThreadId: "post-1",
          },
        });

        expect(context?.replyToMode).toBe(replyToMode);
      },
    );

    it("matches bare Mattermost channel ids against the active channel target", () => {
      const matchesToolContextTarget = requireMattermostThreadTargetMatcher();

      expect(
        matchesToolContextTarget({
          target: "tqfek9psh7fw8mpa5berwyytqw",
          toolContext: {
            currentChannelId: "channel:tqfek9psh7fw8mpa5berwyytqw",
          },
        }),
      ).toBe(true);
      expect(
        matchesToolContextTarget({
          target: "tqfek9psh7fw8mpa5berwyytqw",
          toolContext: {
            currentChannelId: "channel:kqfek9psh7fw8mpa5berwyytqw",
          },
        }),
      ).toBe(false);
    });

    it("exposes the effective reply root as the transport thread", () => {
      const resolveReplyTransport = mattermostPlugin.threading?.resolveReplyTransport;
      if (!resolveReplyTransport) {
        throw new Error("mattermost threading.resolveReplyTransport missing");
      }

      expect(
        resolveReplyTransport({
          cfg: {},
          replyToId: "post-parent",
          threadId: "other-thread",
        }),
      ).toEqual({
        replyToId: "other-thread",
        threadId: "other-thread",
      });
      expect(
        resolveReplyTransport({
          cfg: {},
          replyToId: "child-post",
          replyToIsExplicit: true,
          threadId: "root-post",
        }),
      ).toEqual({
        replyToId: "root-post",
        threadId: "root-post",
      });
      expect(
        resolveReplyTransport({
          cfg: {},
          replyToId: "child-post",
          replyToIsExplicit: false,
          threadId: "root-post",
        }),
      ).toEqual({
        replyToId: "root-post",
        threadId: "root-post",
      });
      expect(
        resolveReplyTransport({
          cfg: {},
          threadId: 42,
        }),
      ).toEqual({
        replyToId: "42",
        threadId: "42",
      });
    });

    it("matches final delivery routing for existing threads and direct messages", () => {
      const resolveReplyTransport = mattermostPlugin.threading?.resolveReplyTransport;
      if (!resolveReplyTransport) {
        throw new Error("mattermost threading.resolveReplyTransport missing");
      }

      expect(
        resolveReplyTransport({
          cfg: {},
          replyToId: "child-post",
          threadId: "root-post",
          replyDelivery: {
            chatType: "channel",
            replyToMode: "all",
          },
        }),
      ).toEqual({
        replyToId: "root-post",
        threadId: "root-post",
      });
      expect(
        resolveReplyTransport({
          cfg: {},
          replyToId: "other-root",
          replyToIsExplicit: true,
          threadId: "ambient-root",
          replyDelivery: {
            chatType: "channel",
            replyToMode: "all",
          },
        }),
      ).toEqual({
        replyToId: "other-root",
        threadId: "other-root",
      });
      for (const replyToMode of ["first", "all", "batched"] as const) {
        expect(
          resolveReplyTransport({
            cfg: {},
            replyToId: "dm-post",
            replyDelivery: {
              chatType: "direct",
              replyToMode,
            },
          }),
        ).toEqual({
          replyToId: "dm-post",
          threadId: "dm-post",
        });
      }
      expect(
        resolveReplyTransport({
          cfg: {},
          replyToId: "dm-post",
          replyDelivery: {
            chatType: "direct",
            replyToMode: "off",
          },
        }),
      ).toEqual({
        replyToId: null,
        threadId: null,
      });
    });

    it("extracts explicit and implicit send thread evidence", () => {
      const extractToolSend = mattermostPlugin.actions?.extractToolSend;
      if (!extractToolSend) {
        throw new Error("mattermost actions.extractToolSend missing");
      }

      expect(
        extractToolSend({
          args: { action: "send", to: "channel:C1", replyTo: "root-1" },
        }),
      ).toMatchObject({
        to: "channel:C1",
        threadId: "root-1",
      });
      expect(
        extractToolSend({
          args: { action: "send", to: "channel:C1" },
        }),
      ).toMatchObject({
        to: "channel:C1",
        threadImplicit: true,
      });

      const extractToolSendResult = mattermostPlugin.actions?.extractToolSendResult;
      if (!extractToolSendResult) {
        throw new Error("mattermost actions.extractToolSendResult missing");
      }
      expect(
        extractToolSendResult({
          send: { to: "channel:C1" },
          result: {
            details: {
              toolSend: {
                to: "channel:C1",
                threadId: "root-1",
              },
            },
          },
        }),
      ).toEqual({
        to: "channel:C1",
        threadId: "root-1",
      });
      expect(
        extractToolSendResult({
          send: { to: "user:U1" },
          result: {
            details: {
              toolSend: {
                to: "channel:DM1",
              },
            },
          },
        }),
      ).toEqual({
        to: "user:U1",
      });
    });

    it("resolves the active Mattermost root for same-channel sends", () => {
      const resolveAutoThreadId = mattermostPlugin.threading?.resolveAutoThreadId;
      if (!resolveAutoThreadId) {
        throw new Error("mattermost threading.resolveAutoThreadId missing");
      }

      expect(
        resolveAutoThreadId({
          cfg: {},
          to: "channel:C1",
          replyToId: "child-1",
          toolContext: {
            currentChannelId: "channel:C1",
            currentThreadTs: "root-1",
            currentMessageId: "child-1",
            replyToMode: "off",
          },
        }),
      ).toBe("root-1");
      expect(
        resolveAutoThreadId({
          cfg: {},
          to: "channel:C2",
          toolContext: {
            currentChannelId: "channel:C1",
            currentThreadTs: "root-1",
            replyToMode: "all",
          },
        }),
      ).toBeUndefined();
      expect(
        resolveAutoThreadId({
          cfg: {},
          to: "tqfek9psh7fw8mpa5berwyytqw",
          toolContext: {
            currentChannelId: "channel:tqfek9psh7fw8mpa5berwyytqw",
            currentThreadTs: "root-1",
            replyToMode: "all",
          },
        }),
      ).toBe("root-1");
      expect(
        resolveAutoThreadId({
          cfg: {},
          to: "channel:C1",
          replyToId: "other-root",
          toolContext: {
            currentChannelId: "channel:C1",
            currentThreadTs: "root-1",
            currentMessageId: "child-1",
            replyToMode: "all",
          },
        }),
      ).toBe("other-root");
      expect(
        resolveAutoThreadId({
          cfg: {},
          to: "channel:C1",
          toolContext: {
            currentChannelId: "channel:C1",
            currentThreadTs: "root-1",
            currentMessageId: "root-1",
            replyToMode: "first",
            hasRepliedRef: { value: true },
          },
        }),
      ).toBeUndefined();
      expect(
        resolveAutoThreadId({
          cfg: {},
          to: "channel:C1",
          toolContext: {
            currentChannelId: "channel:C1",
            currentThreadTs: "root-1",
            currentMessageId: "root-1",
            replyToMode: "batched",
          },
        }),
      ).toBeUndefined();
    });

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

    it("uses threadId as the Mattermost root when generic replyTo names a child post", async () => {
      const cfg = createMattermostTestConfig();

      await mattermostPlugin.actions?.handleAction?.(
        createMattermostActionContext({
          action: "send",
          params: {
            to: "channel:CHAN1",
            message: "hello",
            threadId: "post-root",
            replyTo: "child-post",
          },
          cfg,
          accountId: "default",
        }),
      );

      const options = expectSingleMattermostSend("channel:CHAN1", "hello");
      expect(options.replyToId).toBe("post-root");
    });

    it("keeps explicit replyToId precedence when threadId is also provided", async () => {
      const cfg = createMattermostTestConfig();

      await mattermostPlugin.actions?.handleAction?.(
        createMattermostActionContext({
          action: "send",
          params: {
            to: "channel:CHAN1",
            message: "hello",
            replyToId: "explicit-root",
            threadId: "post-root",
            replyTo: "child-post",
          },
          cfg,
          accountId: "default",
        }),
      );

      const options = expectSingleMattermostSend("channel:CHAN1", "hello");
      expect(options.replyToId).toBe("explicit-root");
    });

    it("routes filePath send actions through Mattermost media upload options", async () => {
      const cfg = createMattermostTestConfig();
      const mediaReadFile = vi.fn(async () => Buffer.from("report"));

      await mattermostPlugin.actions?.handleAction?.(
        createMattermostActionContext({
          action: "send",
          params: {
            to: "channel:CHAN1",
            message: "report",
            filePath: "/tmp/workspace/report.md",
          },
          cfg,
          accountId: "default",
          mediaLocalRoots: ["/tmp/workspace"],
          mediaReadFile,
        }),
      );

      const options = expectSingleMattermostSend("channel:CHAN1", "report");
      expect(options.mediaUrl).toBe("/tmp/workspace/report.md");
      expect(options.mediaLocalRoots).toStrictEqual(["/tmp/workspace"]);
      expect(options.mediaReadFile).toBe(mediaReadFile);
      expect(options.requireMediaUpload).toBe(true);
    });

    it("preserves workspaceDir for relative filePath send actions", async () => {
      const cfg = createMattermostTestConfig();
      const mediaReadFile = vi.fn(async () => Buffer.from("report"));

      await mattermostPlugin.actions?.handleAction?.(
        createMattermostActionContext({
          action: "send",
          params: {
            to: "channel:CHAN1",
            message: "report",
            filePath: "report.md",
          },
          cfg,
          accountId: "default",
          mediaAccess: {
            localRoots: ["/tmp/workspace"],
            readFile: mediaReadFile,
            workspaceDir: "/tmp/workspace",
          },
        }),
      );

      const options = expectSingleMattermostSend("channel:CHAN1", "report");
      expect(options.mediaUrl).toBe("report.md");
      expect(options.mediaLocalRoots).toStrictEqual(["/tmp/workspace"]);
      expect(options.mediaReadFile).toBe(mediaReadFile);
      expect(options.workspaceDir).toBe("/tmp/workspace");
      expect(options.requireMediaUpload).toBe(true);
    });

    it("routes structured attachment send actions through Mattermost media upload options", async () => {
      const cfg = createMattermostTestConfig();

      await mattermostPlugin.actions?.handleAction?.(
        createMattermostActionContext({
          action: "send",
          params: {
            to: "channel:CHAN1",
            message: "report",
            attachments: [{ filePath: "/tmp/workspace/report.md" }],
          },
          cfg,
          accountId: "default",
          mediaLocalRoots: ["/tmp/workspace"],
        }),
      );

      const options = expectSingleMattermostSend("channel:CHAN1", "report");
      expect(options.mediaUrl).toBe("/tmp/workspace/report.md");
      expect(options.mediaLocalRoots).toStrictEqual(["/tmp/workspace"]);
      expect(options.requireMediaUpload).toBe(true);
    });

    it("routes media_urls send actions through Mattermost media upload options", async () => {
      const cfg = createMattermostTestConfig();

      await mattermostPlugin.actions?.handleAction?.(
        createMattermostActionContext({
          action: "send",
          params: {
            to: "channel:CHAN1",
            message: "report",
            media_urls: ["/tmp/workspace/report.md"],
          },
          cfg,
          accountId: "default",
          mediaLocalRoots: ["/tmp/workspace"],
        }),
      );

      const options = expectSingleMattermostSend("channel:CHAN1", "report");
      expect(options.mediaUrl).toBe("/tmp/workspace/report.md");
      expect(options.mediaLocalRoots).toStrictEqual(["/tmp/workspace"]);
      expect(options.requireMediaUpload).toBe(true);
    });

    it("preserves HTTP media send fallback behavior", async () => {
      const cfg = createMattermostTestConfig();

      await mattermostPlugin.actions?.handleAction?.(
        createMattermostActionContext({
          action: "send",
          params: {
            to: "channel:CHAN1",
            message: "report",
            mediaUrl: "https://example.com/report.md",
          },
          cfg,
          accountId: "default",
        }),
      );

      const options = expectSingleMattermostSend("channel:CHAN1", "report");
      expect(options.mediaUrl).toBe("https://example.com/report.md");
      expect(options.requireMediaUpload).toBeUndefined();
    });

    it("rejects multiple Mattermost send attachments instead of dropping extras", async () => {
      const cfg = createMattermostTestConfig();

      await expect(
        mattermostPlugin.actions?.handleAction?.(
          createMattermostActionContext({
            action: "send",
            params: {
              to: "channel:CHAN1",
              message: "reports",
              media_urls: ["/tmp/workspace/one.md", "/tmp/workspace/two.md"],
            },
            cfg,
            accountId: "default",
            mediaLocalRoots: ["/tmp/workspace"],
          }),
        ),
      ).rejects.toThrow("supports one attachment per message");
      expect(sendMessageMattermostMock).not.toHaveBeenCalled();
    });

    it("rejects unsupported buffer-only Mattermost send attachments", async () => {
      const cfg = createMattermostTestConfig();

      await expect(
        mattermostPlugin.actions?.handleAction?.(
          createMattermostActionContext({
            action: "send",
            params: {
              to: "channel:CHAN1",
              message: "report",
              buffer: "cmVwb3J0",
              filename: "report.md",
            },
            cfg,
            accountId: "default",
          }),
        ),
      ).rejects.toThrow("buffer/base64 payloads are not supported");
      expect(sendMessageMattermostMock).not.toHaveBeenCalled();
    });

    it("rejects mixed supported and unsupported Mattermost send attachments", async () => {
      const cfg = createMattermostTestConfig();

      await expect(
        mattermostPlugin.actions?.handleAction?.(
          createMattermostActionContext({
            action: "send",
            params: {
              to: "channel:CHAN1",
              message: "report",
              attachments: [
                { filePath: "/tmp/workspace/report.md" },
                { buffer: "cmVwb3J0", filename: "report-copy.md" },
              ],
            },
            cfg,
            accountId: "default",
            mediaLocalRoots: ["/tmp/workspace"],
          }),
        ),
      ).rejects.toThrow("buffer/base64 payloads are not supported");
      expect(sendMessageMattermostMock).not.toHaveBeenCalled();
    });

    it("maps legacy presentation buttons without using interactive conversion", async () => {
      const cfg = createMattermostTestConfig();

      await mattermostPlugin.actions?.handleAction?.(
        createMattermostActionContext({
          action: "send",
          params: {
            to: "channel:CHAN1",
            message: "Deploy finished",
            presentation: {
              blocks: [
                {
                  type: "buttons",
                  buttons: [
                    {
                      label: "Open",
                      value: "open",
                      style: "primary",
                    },
                    { label: "Docs", url: "https://example.com/docs" },
                  ],
                },
              ],
            },
          },
          cfg,
          accountId: "default",
        }),
      );

      const options = expectSingleMattermostSend(
        "channel:CHAN1",
        "Deploy finished\n\n- Open\n- Docs: https://example.com/docs",
      );
      expect(options.buttons).toStrictEqual([
        [
          {
            id: "open",
            text: "Open",
            callback_data: "open",
            context: { callback_data: "open" },
            style: "primary",
          },
        ],
      ]);
    });

    it("does not render callback action buttons that Mattermost cannot round-trip", async () => {
      const cfg = createMattermostTestConfig();

      await mattermostPlugin.actions?.handleAction?.(
        createMattermostActionContext({
          action: "send",
          params: {
            to: "channel:CHAN1",
            message: "Pick",
            presentation: {
              blocks: [
                {
                  type: "buttons",
                  buttons: [{ label: "Inspect", action: { type: "callback", value: "inspect" } }],
                },
              ],
            },
          },
          cfg,
          accountId: "default",
        }),
      );

      const options = expectSingleMattermostSend("channel:CHAN1", "Pick\n\n- Inspect");
      expect(options.buttons).toBeUndefined();
    });

    it("does not render command action buttons that Mattermost cannot execute", async () => {
      const cfg = createMattermostTestConfig();

      await mattermostPlugin.actions?.handleAction?.(
        createMattermostActionContext({
          action: "send",
          params: {
            to: "channel:CHAN1",
            message: "Pick",
            presentation: {
              blocks: [
                {
                  type: "buttons",
                  buttons: [{ label: "Plugins", action: { type: "command", command: "/codex" } }],
                },
              ],
            },
          },
          cfg,
          accountId: "default",
        }),
      );

      const options = expectSingleMattermostSend("channel:CHAN1", "Pick\n\n- Plugins: `/codex`");
      expect(options.buttons).toBeUndefined();
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
    it("renders presentation buttons for normal reply payload delivery", async () => {
      const renderPresentation = requireMattermostRenderPresentation();
      const sendPayload = requireMattermostSendPayload();
      const cfg = createMattermostTestConfig();
      const presentation = {
        blocks: [
          { type: "text" as const, text: "Deploy finished" },
          {
            type: "buttons" as const,
            buttons: [
              { label: "Open", value: "open", style: "primary" as const },
              { label: "Docs", url: "https://example.com/docs" },
            ],
          },
        ],
      };
      const rendered = await renderPresentation({
        payload: { presentation },
        presentation,
        ctx: {
          cfg,
          to: "channel:CHAN1",
          text: "",
          payload: { presentation },
        },
      });

      expect(rendered).toMatchObject({
        text: "Deploy finished\n\n- Open\n- Docs: https://example.com/docs",
        channelData: {
          mattermost: {
            presentationButtons: [[{ text: "Open", callback_data: "open", style: "primary" }]],
          },
        },
      });

      await sendPayload({
        cfg,
        to: "channel:CHAN1",
        text: "",
        payload: rendered!,
      });

      const options = expectSingleMattermostSend(
        "channel:CHAN1",
        "Deploy finished\n\n- Open\n- Docs: https://example.com/docs",
      );
      expect(options.buttons).toStrictEqual([
        [
          {
            id: "open",
            text: "Open",
            callback_data: "open",
            context: { callback_data: "open" },
            style: "primary",
          },
        ],
      ]);
    });

    it("keeps typed URL actions on the normal Mattermost text delivery path", async () => {
      const renderPresentation = requireMattermostRenderPresentation();
      const sendPayload = requireMattermostSendPayload();
      const cfg = createMattermostTestConfig();
      const presentation = {
        blocks: [
          {
            type: "buttons" as const,
            buttons: [
              {
                label: "Review",
                action: {
                  type: "url" as const,
                  url: "https://example.com/review",
                },
              },
              {
                label: "Open app",
                action: {
                  type: "web-app" as const,
                  url: "https://example.com/app",
                },
              },
              {
                label: "Allow",
                action: {
                  type: "approval" as const,
                  approvalId: "approval-1",
                  approvalKind: "exec" as const,
                  decision: "allow-once" as const,
                },
                value: "/approve approval-1 allow-once",
              },
            ],
          },
        ],
      };
      const payload = { presentation };
      const rendered = await renderPresentation({
        payload,
        presentation,
        ctx: {
          cfg,
          to: "channel:CHAN1",
          text: "",
          payload,
        },
      });

      expect(rendered).toMatchObject({
        text: "- Review: https://example.com/review\n- Open app: https://example.com/app\n- Allow",
      });
      expect(rendered?.channelData?.mattermost).toBeUndefined();

      await sendPayload({
        cfg,
        to: "channel:CHAN1",
        text: rendered?.text ?? "",
        payload: rendered!,
      });

      const options = expectSingleMattermostSend(
        "channel:CHAN1",
        "- Review: https://example.com/review\n- Open app: https://example.com/app\n- Allow",
      );
      expect(options.buttons).toBeUndefined();
      expect(JSON.stringify(options)).not.toContain("approval-1");
      expect(JSON.stringify(options)).not.toContain("/approve");
    });

    it("requires upload success for local media on presentation button payloads", async () => {
      const renderPresentation = requireMattermostRenderPresentation();
      const sendPayload = requireMattermostSendPayload();
      const cfg = createMattermostTestConfig();
      const mediaReadFile = vi.fn(async () => Buffer.from("image"));
      const presentation = {
        blocks: [
          {
            type: "buttons" as const,
            buttons: [{ label: "Open", value: "open" }],
          },
        ],
      };
      const rendered = await renderPresentation({
        payload: { presentation, mediaUrl: "report.png" },
        presentation,
        ctx: {
          cfg,
          to: "channel:CHAN1",
          text: "",
          payload: { presentation, mediaUrl: "report.png" },
        },
      });

      await sendPayload({
        cfg,
        to: "channel:CHAN1",
        text: "",
        payload: rendered!,
        mediaAccess: {
          localRoots: ["/tmp/workspace"],
          readFile: mediaReadFile,
          workspaceDir: "/tmp/workspace",
        },
      });

      const options = expectSingleMattermostSend("channel:CHAN1", "- Open");
      expect(options.mediaUrl).toBe("report.png");
      expect(options.mediaLocalRoots).toStrictEqual(["/tmp/workspace"]);
      expect(options.mediaReadFile).toBe(mediaReadFile);
      expect(options.workspaceDir).toBe("/tmp/workspace");
      expect(options.requireMediaUpload).toBe(true);
    });

    it("keeps multi-media presentation payloads on the text/media fallback path", async () => {
      const renderPresentation = requireMattermostRenderPresentation();
      const presentation = {
        blocks: [
          {
            type: "buttons" as const,
            buttons: [{ label: "Open", value: "open" }],
          },
        ],
      };

      expect(
        await renderPresentation({
          payload: {
            presentation,
            mediaUrls: ["https://example.com/1.png", "https://example.com/2.png"],
          },
          presentation,
          ctx: {
            cfg: createMattermostTestConfig(),
            to: "channel:CHAN1",
            text: "",
            payload: { presentation },
          },
        }),
      ).toBeNull();
    });

    it("chunks outbound text without requiring Mattermost runtime initialization", () => {
      const chunker = requireMattermostChunker();

      expect(chunker("hello world", 5)).toEqual(["hello", "world"]);
    });

    it("forwards mediaLocalRoots on sendMedia", async () => {
      const sendMedia = requireMattermostSendMedia();
      const cfg = createMattermostTestConfig();
      const mediaReadFile = vi.fn(async () => Buffer.from("image"));

      const params: MattermostSendMediaParams = {
        cfg,
        to: "channel:CHAN1",
        text: "hello",
        mediaUrl: "/tmp/workspace/image.png",
        mediaLocalRoots: ["/tmp/workspace"],
        mediaReadFile,
        accountId: "default",
        replyToId: "post-root",
      };

      await sendMedia(params);

      const options = expectSingleMattermostSend("channel:CHAN1", "hello");
      expect(options.mediaUrl).toBe("/tmp/workspace/image.png");
      expect(options.mediaLocalRoots).toStrictEqual(["/tmp/workspace"]);
      expect(options.mediaReadFile).toBe(mediaReadFile);
      expect(options.requireMediaUpload).toBe(true);
    });

    it("falls back to structured mediaAccess on sendMedia", async () => {
      const sendMedia = requireMattermostSendMedia();
      const cfg = createMattermostTestConfig();
      const mediaReadFile = vi.fn(async () => Buffer.from("image"));

      await sendMedia({
        cfg,
        to: "channel:CHAN1",
        text: "hello",
        mediaUrl: "image.png",
        mediaAccess: {
          localRoots: ["/tmp/workspace"],
          readFile: mediaReadFile,
          workspaceDir: "/tmp/workspace",
        },
      });

      const options = expectSingleMattermostSend("channel:CHAN1", "hello");
      expect(options.mediaUrl).toBe("image.png");
      expect(options.mediaLocalRoots).toStrictEqual(["/tmp/workspace"]);
      expect(options.mediaReadFile).toBe(mediaReadFile);
      expect(options.workspaceDir).toBe("/tmp/workspace");
      expect(options.requireMediaUpload).toBe(true);
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
      expect(options.requireMediaUpload).toBeUndefined();
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
