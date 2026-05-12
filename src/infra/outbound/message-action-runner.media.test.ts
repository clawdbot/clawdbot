import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { jsonResult } from "../../agents/tools/common.js";
import type { ChannelPlugin } from "../../channels/plugins/types.js";
import type { OpenClawConfig } from "../../config/config.js";
import { loadWebMedia } from "../../media/web-media.js";
import { getActivePluginRegistry, setActivePluginRegistry } from "../../plugins/runtime.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";
import { resolvePreferredOpenClawTmpDir } from "../tmp-openclaw-dir.js";
import { runMessageAction } from "./message-action-runner.js";

const onePixelPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO5m8gAAAABJRU5ErkJggg==",
  "base64",
);

const channelResolutionMocks = vi.hoisted(() => ({
  resolveOutboundChannelPlugin: vi.fn(),
  executeSendAction: vi.fn(),
  executePollAction: vi.fn(),
}));

vi.mock("./channel-resolution.js", () => ({
  resolveOutboundChannelPlugin: channelResolutionMocks.resolveOutboundChannelPlugin,
  resetOutboundChannelResolutionStateForTest: vi.fn(),
}));

vi.mock("./outbound-send-service.js", () => ({
  executeSendAction: channelResolutionMocks.executeSendAction,
  executePollAction: channelResolutionMocks.executePollAction,
}));

vi.mock("./outbound-session.js", () => ({
  ensureOutboundSessionEntry: vi.fn(async () => undefined),
  resolveOutboundSessionRoute: vi.fn(async () => null),
}));

vi.mock("./message-action-threading.js", async () => {
  const { createOutboundThreadingMock } =
    await import("./message-action-threading.test-helpers.js");
  return createOutboundThreadingMock();
});

vi.mock("../../media/web-media.js", async () => {
  const actual = await vi.importActual<typeof import("../../media/web-media.js")>(
    "../../media/web-media.js",
  );
  return {
    ...actual,
    loadWebMedia: vi.fn(actual.loadWebMedia),
  };
});

const workspaceConfig = {
  channels: {
    workspace: {
      botToken: "xoxb-test",
      appToken: "xapp-test",
    },
  },
} as OpenClawConfig;

function firstMockArg(
  mock: { mock: { calls: readonly unknown[][] } },
  label: string,
): Record<string, unknown> {
  const [call] = mock.mock.calls;
  if (!call) {
    throw new Error(`expected ${label} call`);
  }
  const [arg] = call;
  return requireRecord(arg);
}

async function withSandbox(test: (sandboxDir: string) => Promise<void>) {
  const sandboxDir = await fs.mkdtemp(path.join(os.tmpdir(), "msg-sandbox-"));
  try {
    await test(sandboxDir);
  } finally {
    await fs.rm(sandboxDir, { recursive: true, force: true });
  }
}

const runDrySend = (params: {
  cfg: OpenClawConfig;
  actionParams: Record<string, unknown>;
  sandboxRoot?: string;
}) =>
  runMessageAction({
    cfg: params.cfg,
    action: "send",
    params: params.actionParams as never,
    dryRun: true,
    sandboxRoot: params.sandboxRoot,
  });

function requireRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected a non-array record");
  }
  return value as Record<string, unknown>;
}

function requireActionPayload(
  result: Awaited<ReturnType<typeof runMessageAction>>,
): Record<string, unknown> {
  expect(result.kind).toBe("action");
  if (result.kind !== "action") {
    throw new Error("expected action result");
  }
  return requireRecord(result.payload);
}

function requireLoadWebMediaOptions(): Record<string, unknown> {
  const call = requireLoadWebMediaCall();
  return requireRecord(call[1]);
}

function requireLoadWebMediaCall(): readonly unknown[] {
  const call = vi.mocked(loadWebMedia).mock.calls.at(0);
  if (!call) {
    throw new Error("Expected loadWebMedia to be called");
  }
  return call;
}

async function expectSandboxMediaRewrite(params: {
  sandboxDir: string;
  media?: string;
  mediaField?: "media" | "mediaUrl" | "fileUrl";
  message?: string;
  expectedRelativePath: string;
}) {
  const result = await runDrySend({
    cfg: workspaceConfig,
    actionParams: {
      channel: "workspace",
      target: "12345678",
      ...(params.media
        ? {
            [params.mediaField ?? "media"]: params.media,
          }
        : {}),
      ...(params.message ? { message: params.message } : {}),
    },
    sandboxRoot: params.sandboxDir,
  });

  expect(result.kind).toBe("send");
  if (result.kind !== "send") {
    throw new Error("expected send result");
  }
  expect(result.sendResult?.mediaUrl).toBe(
    path.join(params.sandboxDir, params.expectedRelativePath),
  );
}

async function runAttachmentRemoteMediaAction(params: {
  cfg: OpenClawConfig;
  action: "sendAttachment" | "upload-file";
}) {
  return runMessageAction({
    cfg: params.cfg,
    action: params.action,
    params: {
      channel: "attachmentchat",
      target: "+15551234567",
      media: "https://example.com/pic.png",
      message: "caption",
    },
  });
}

function expectAttachmentRemoteMediaPayload(result: Awaited<ReturnType<typeof runMessageAction>>) {
  const payload = requireActionPayload(result);
  expect(payload.ok).toBe(true);
  expect(payload.filename).toBe("pic.png");
  expect(payload.caption).toBe("caption");
  expect(payload.contentType).toBe("image/png");
  expect(payload.buffer).toBe(Buffer.from("hello").toString("base64"));
}

let actualLoadWebMedia: typeof loadWebMedia;

const workspacePlugin: ChannelPlugin = {
  ...createChannelTestPluginBase({
    id: "workspace",
    label: "Workspace",
    config: {
      listAccountIds: () => ["default"],
      resolveAccount: (cfg) => cfg.channels?.workspace ?? {},
      isConfigured: async (account) =>
        typeof (account as { botToken?: unknown }).botToken === "string" &&
        (account as { botToken?: string }).botToken!.trim() !== "" &&
        typeof (account as { appToken?: unknown }).appToken === "string" &&
        (account as { appToken?: string }).appToken!.trim() !== "",
    },
  }),
  outbound: {
    deliveryMode: "direct",
    resolveTarget: ({ to }) => {
      const trimmed = to?.trim() ?? "";
      if (!trimmed) {
        return {
          ok: false,
          error: new Error("missing target for workspace"),
        };
      }
      return { ok: true, to: trimmed };
    },
    sendText: async () => ({ channel: "workspace", messageId: "msg-test" }),
    sendMedia: async () => ({ channel: "workspace", messageId: "msg-test" }),
  },
};

describe("runMessageAction media behavior", () => {
  beforeEach(async () => {
    actualLoadWebMedia ??= (
      await vi.importActual<typeof import("../../media/web-media.js")>("../../media/web-media.js")
    ).loadWebMedia;
    vi.restoreAllMocks();
    vi.clearAllMocks();
    channelResolutionMocks.resolveOutboundChannelPlugin.mockReset();
    channelResolutionMocks.resolveOutboundChannelPlugin.mockImplementation(
      ({ channel }: { channel: string }) =>
        getActivePluginRegistry()?.channels.find((entry) => entry?.plugin?.id === channel)?.plugin,
    );
    channelResolutionMocks.executeSendAction.mockReset();
    channelResolutionMocks.executeSendAction.mockImplementation(
      async ({
        ctx,
        to,
        message,
        mediaUrl,
        mediaUrls,
      }: {
        ctx: { channel: string; dryRun: boolean };
        to: string;
        message: string;
        mediaUrl?: string;
        mediaUrls?: string[];
      }) => ({
        handledBy: "core" as const,
        payload: {
          channel: ctx.channel,
          to,
          message,
          mediaUrl,
          mediaUrls,
          dryRun: ctx.dryRun,
        },
        sendResult: {
          channel: ctx.channel,
          messageId: "msg-test",
          ...(mediaUrl ? { mediaUrl } : {}),
          ...(mediaUrls ? { mediaUrls } : {}),
        },
      }),
    );
    channelResolutionMocks.executePollAction.mockReset();
    channelResolutionMocks.executePollAction.mockImplementation(async () => {
      throw new Error("executePollAction should not run in media tests");
    });
    vi.mocked(loadWebMedia).mockReset();
    vi.mocked(loadWebMedia).mockImplementation(actualLoadWebMedia);
  });

  it("forwards asVoice from send actions into core delivery", async () => {
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "workspace",
          source: "test",
          plugin: workspacePlugin,
        },
      ]),
    );

    const result = await runDrySend({
      cfg: workspaceConfig,
      actionParams: {
        channel: "workspace",
        target: "12345678",
        message: "voice note",
        media: "https://example.com/voice.ogg",
        asVoice: true,
      },
    });

    expect(result.kind).toBe("send");
    const sendArgs = firstMockArg(channelResolutionMocks.executeSendAction, "executeSendAction");
    expect(sendArgs.asVoice).toBe(true);
  });

  describe("sendAttachment hydration", () => {
    const cfg = {
      channels: {
        attachmentchat: {
          enabled: true,
          serverUrl: "http://localhost:1234",
          password: "test-password",
        },
      },
    } as OpenClawConfig;
    const attachmentPlugin: ChannelPlugin = {
      id: "attachmentchat",
      meta: {
        id: "attachmentchat",
        label: "AttachmentChat",
        selectionLabel: "AttachmentChat",
        docsPath: "/channels/attachmentchat",
        blurb: "AttachmentChat test plugin.",
      },
      capabilities: { chatTypes: ["direct", "group"], media: true },
      config: {
        listAccountIds: () => ["default"],
        resolveAccount: () => ({ enabled: true }),
        isConfigured: () => true,
      },
      actions: {
        describeMessageTool: () => ({ actions: ["sendAttachment", "upload-file", "setGroupIcon"] }),
        supportsAction: ({ action }) =>
          action === "sendAttachment" || action === "upload-file" || action === "setGroupIcon",
        handleAction: async ({ params }) =>
          jsonResult({
            ok: true,
            buffer: params.buffer,
            filename: params.filename,
            caption: params.caption,
            contentType: params.contentType,
          }),
      },
    };

    beforeEach(() => {
      setActivePluginRegistry(
        createTestRegistry([
          {
            pluginId: "attachmentchat",
            source: "test",
            plugin: attachmentPlugin,
          },
        ]),
      );
      vi.mocked(loadWebMedia).mockResolvedValue({
        buffer: Buffer.from("hello"),
        contentType: "image/png",
        kind: "image",
        fileName: "pic.png",
      });
    });

    afterEach(() => {
      setActivePluginRegistry(createTestRegistry([]));
      vi.clearAllMocks();
    });

    async function restoreRealMediaLoader() {
      const actual = await vi.importActual<typeof import("../../media/web-media.js")>(
        "../../media/web-media.js",
      );
      vi.mocked(loadWebMedia).mockImplementation(actual.loadWebMedia);
    }

    async function expectRejectsLocalAbsolutePathWithoutSandbox(params: {
      cfg?: OpenClawConfig;
      action: "sendAttachment" | "setGroupIcon";
      target: string;
      mediaField?: "media" | "mediaUrl" | "fileUrl";
      message?: string;
      tempPrefix: string;
    }) {
      await restoreRealMediaLoader();

      const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), params.tempPrefix));
      try {
        const outsidePath = path.join(tempDir, "secret.txt");
        await fs.writeFile(outsidePath, "secret", "utf8");

        const actionParams: Record<string, unknown> = {
          channel: "attachmentchat",
          target: params.target,
          [params.mediaField ?? "media"]: outsidePath,
        };
        if (params.message) {
          actionParams.message = params.message;
        }

        await expect(
          runMessageAction({
            cfg: params.cfg ?? cfg,
            action: params.action,
            params: actionParams,
          }),
        ).rejects.toThrow(/allowed directory|path-not-allowed/i);
      } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
      }
    }

    it("hydrates buffer and filename from media for sendAttachment", async () => {
      const result = await runAttachmentRemoteMediaAction({ cfg, action: "sendAttachment" });

      expectAttachmentRemoteMediaPayload(result);
      const options = requireLoadWebMediaOptions();
      expect(Array.isArray(options.localRoots)).toBe(true);
      expect(typeof options.readFile).toBe("function");
      expect(options.hostReadCapability).toBe(true);
      expect(options.sandboxValidated).not.toBe(true);
    });

    it("allows host-local image attachment paths when fs root expansion is enabled", async () => {
      await restoreRealMediaLoader();

      const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "msg-attachment-image-"));
      try {
        const outsidePath = path.join(tempDir, "photo.png");
        await fs.writeFile(outsidePath, onePixelPng);

        const result = await runMessageAction({
          cfg: {
            ...cfg,
            tools: { fs: { workspaceOnly: false } },
          },
          action: "sendAttachment",
          params: {
            channel: "attachmentchat",
            target: "+15551234567",
            media: outsidePath,
            message: "caption",
          },
        });

        const payload = requireActionPayload(result);
        expect(payload.ok).toBe(true);
        expect(payload.filename).toBe("photo.png");
        expect(payload.contentType).toBe("image/png");
      } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
      }
    });

    it("rejects host-local text attachments even when fs root expansion is enabled", async () => {
      await restoreRealMediaLoader();

      const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "msg-attachment-text-"));
      try {
        const outsidePath = path.join(tempDir, "secret.txt");
        await fs.writeFile(outsidePath, "secret", "utf8");

        await expect(
          runMessageAction({
            cfg: {
              ...cfg,
              tools: { fs: { workspaceOnly: false } },
            },
            action: "sendAttachment",
            params: {
              channel: "attachmentchat",
              target: "+15551234567",
              media: outsidePath,
              message: "caption",
            },
          }),
        ).rejects.toThrow(/Host-local media sends only allow/i);
      } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
      }
    });

    it("hydrates buffer and filename from media for attachment upload-file", async () => {
      const result = await runAttachmentRemoteMediaAction({ cfg, action: "upload-file" });

      expectAttachmentRemoteMediaPayload(result);
    });

    it("enforces sandboxed attachment paths for attachment actions", async () => {
      for (const testCase of [
        {
          name: "sendAttachment rewrite",
          action: "sendAttachment" as const,
          target: "+15551234567",
          media: "./data/pic.png",
          message: "caption",
          expectedPath: path.join("data", "pic.png"),
        },
        {
          name: "sendAttachment mediaUrl rewrite",
          action: "sendAttachment" as const,
          target: "+15551234567",
          mediaField: "mediaUrl" as const,
          media: "./data/pic.png",
          message: "caption",
          expectedPath: path.join("data", "pic.png"),
        },
        {
          name: "sendAttachment fileUrl rewrite",
          action: "sendAttachment" as const,
          target: "+15551234567",
          mediaField: "fileUrl" as const,
          media: "/workspace/files/report.pdf",
          message: "caption",
          expectedPath: path.join("files", "report.pdf"),
        },
        {
          name: "setGroupIcon rewrite",
          action: "setGroupIcon" as const,
          target: "group:123",
          media: "./icons/group.png",
          expectedPath: path.join("icons", "group.png"),
        },
      ]) {
        vi.mocked(loadWebMedia).mockClear();
        await withSandbox(async (sandboxDir) => {
          await runMessageAction({
            cfg,
            action: testCase.action,
            params: {
              channel: "attachmentchat",
              target: testCase.target,
              [testCase.mediaField ?? "media"]: testCase.media,
              ...(testCase.message ? { message: testCase.message } : {}),
            },
            sandboxRoot: sandboxDir,
          });

          const call = requireLoadWebMediaCall();
          expect(call[0], testCase.name).toBe(path.join(sandboxDir, testCase.expectedPath));
          expect(requireRecord(call[1]).sandboxValidated, testCase.name).toBe(true);
        });
      }

      for (const testCase of [
        {
          action: "sendAttachment" as const,
          target: "+15551234567",
          message: "caption",
          tempPrefix: "msg-attachment-",
        },
        {
          action: "sendAttachment" as const,
          target: "+15551234567",
          mediaField: "mediaUrl" as const,
          message: "caption",
          tempPrefix: "msg-attachment-media-url-",
        },
        {
          action: "sendAttachment" as const,
          target: "+15551234567",
          mediaField: "fileUrl" as const,
          message: "caption",
          tempPrefix: "msg-attachment-file-url-",
        },
        {
          action: "setGroupIcon" as const,
          target: "group:123",
          tempPrefix: "msg-group-icon-",
        },
      ]) {
        await expectRejectsLocalAbsolutePathWithoutSandbox({
          ...testCase,
          cfg: { tools: { fs: { workspaceOnly: true } } },
        });
      }
    });
  });

  describe("reply hydration", () => {
    // The reply action accepts attachments via the same media/path/filePath
    // params as send. Before openclaw#79864 the runner only hydrated
    // sendAttachment/setGroupIcon/upload-file, so a channel plugin's reply
    // handler saw the raw path and could forward it directly to its CLI —
    // bypassing localRoots, sandbox, and size checks. These tests pin the
    // wiring at the runner level: paths must arrive at the plugin handler
    // as a hydrated buffer, paths outside the resolver's policy must
    // reject before the handler runs, and reply must not inherit the
    // sendAttachment caption-fallback that would synthesize a bogus
    // caption from the agent's reply text.
    const cfg = {
      channels: {
        replychat: {
          enabled: true,
        },
      },
    } as OpenClawConfig;
    const handleActionMock = vi.fn();
    const replyPlugin: ChannelPlugin = {
      id: "replychat",
      meta: {
        id: "replychat",
        label: "ReplyChat",
        selectionLabel: "ReplyChat",
        docsPath: "/channels/replychat",
        blurb: "ReplyChat test plugin.",
      },
      capabilities: { chatTypes: ["direct", "group"], media: true },
      config: {
        listAccountIds: () => ["default"],
        resolveAccount: () => ({ enabled: true }),
        isConfigured: () => true,
      },
      actions: {
        describeMessageTool: () => ({ actions: ["reply"] }),
        supportsAction: ({ action }) => action === "reply",
        handleAction: async ({ params }) => {
          handleActionMock(params);
          return jsonResult({
            ok: true,
            buffer: params.buffer,
            filename: params.filename,
            caption: params.caption,
            contentType: params.contentType,
            text: params.text,
            message: params.message,
          });
        },
      },
    };

    beforeEach(() => {
      handleActionMock.mockReset();
      setActivePluginRegistry(
        createTestRegistry([
          {
            pluginId: "replychat",
            source: "test",
            plugin: replyPlugin,
          },
        ]),
      );
      vi.mocked(loadWebMedia).mockResolvedValue({
        buffer: Buffer.from("hello"),
        contentType: "image/png",
        kind: "image",
        fileName: "pic.png",
      });
    });

    afterEach(() => {
      setActivePluginRegistry(createTestRegistry([]));
      vi.clearAllMocks();
    });

    it("hydrates buffer and filename from a remote URL before the reply handler runs", async () => {
      const result = await runMessageAction({
        cfg,
        action: "reply",
        params: {
          channel: "replychat",
          target: "+15551234567",
          messageId: "parent-id",
          text: "look at this",
          media: "https://example.com/pic.png",
        },
      });

      expect(result.kind).toBe("action");
      expect(handleActionMock).toHaveBeenCalledTimes(1);
      const handlerParams = firstMockArg(handleActionMock, "handleAction");
      expect(handlerParams.buffer).toBe(Buffer.from("hello").toString("base64"));
      expect(handlerParams.filename).toBe("pic.png");
      expect(handlerParams.contentType).toBe("image/png");
    });

    it("rejects host paths outside mediaLocalRoots before invoking the reply handler", async () => {
      // Use the real loader so its localRoots/workspaceOnly enforcement runs.
      const actual = await vi.importActual<typeof import("../../media/web-media.js")>(
        "../../media/web-media.js",
      );
      vi.mocked(loadWebMedia).mockImplementation(actual.loadWebMedia);

      const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "msg-reply-bypass-"));
      try {
        const outsidePath = path.join(tempDir, "secret.txt");
        await fs.writeFile(outsidePath, "secret", "utf8");

        await expect(
          runMessageAction({
            cfg: {
              ...cfg,
              tools: { fs: { workspaceOnly: true } },
            },
            action: "reply",
            params: {
              channel: "replychat",
              target: "+15551234567",
              messageId: "parent-id",
              text: "look at this",
              path: outsidePath,
            },
          }),
        ).rejects.toThrow(/allowed directory|path-not-allowed|workspace/i);
        expect(handleActionMock).not.toHaveBeenCalled();
      } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
      }
    });

    it("does not synthesize a caption from message on reply", async () => {
      // sendAttachment falls back caption -> message when caption is missing.
      // Reply has its own text/message body, so caption fallback would
      // invent a bogus caption param the channel handler shouldn't see.
      await runMessageAction({
        cfg,
        action: "reply",
        params: {
          channel: "replychat",
          target: "+15551234567",
          messageId: "parent-id",
          message: "look at this",
          media: "https://example.com/pic.png",
        },
      });

      expect(handleActionMock).toHaveBeenCalledTimes(1);
      const handlerParams = firstMockArg(handleActionMock, "handleAction");
      expect(handlerParams.caption).toBeUndefined();
      expect(handlerParams.message).toBe("look at this");
    });
  });

  describe("plugin-owned media-source discovery routing", () => {
    const profilePlugin: ChannelPlugin = {
      ...createChannelTestPluginBase({
        id: "profile-demo",
        label: "Profile Demo",
        capabilities: { chatTypes: ["direct"] },
        config: {
          listAccountIds: () => ["default"],
          isConfigured: () => true,
        },
      }),
      outbound: {
        deliveryMode: "direct",
        resolveTarget: ({ to }) => ({ ok: true, to: to?.trim() ?? "profile-demo-target" }),
        sendText: async () => ({ channel: "profile-demo", messageId: "msg-test" }),
        sendMedia: async () => ({ channel: "profile-demo", messageId: "msg-test" }),
      },
      actions: {
        describeMessageTool: () => ({
          actions: ["send", "set-profile"],
          mediaSourceParams: {
            "set-profile": ["avatarPath", "avatarUrl"],
          },
          schema: {
            properties: {
              avatarPath: Type.Optional(Type.String({ description: "Local avatar path" })),
              avatarUrl: Type.Optional(Type.String({ description: "Remote avatar URL" })),
              displayName: Type.Optional(Type.String()),
            },
          },
        }),
        supportsAction: ({ action }) => action === "set-profile" || action === "send",
        handleAction: async ({ params, mediaLocalRoots }) =>
          jsonResult({
            ok: true,
            avatarPath: params.avatarPath,
            avatarUrl: params.avatarUrl,
            mediaLocalRoots,
          }),
      },
    };

    beforeEach(() => {
      setActivePluginRegistry(
        createTestRegistry([
          {
            pluginId: "profile-demo",
            source: "test",
            plugin: profilePlugin,
          },
        ]),
      );
    });

    afterEach(() => {
      setActivePluginRegistry(createTestRegistry([]));
    });

    it("rewrites plugin-owned sandbox media params and preserves mxc URLs", async () => {
      await withSandbox(async (sandboxDir) => {
        const result = await runMessageAction({
          cfg: {} as OpenClawConfig,
          action: "set-profile",
          params: {
            channel: "profile-demo",
            avatarPath: "/workspace/avatars/profile.png",
            avatarUrl: "mxc://matrix.org/abc123def456",
          },
          sandboxRoot: sandboxDir,
        });

        const payload = requireActionPayload(result);
        expect(payload.ok).toBe(true);
        expect(payload.avatarPath).toBe(path.join(sandboxDir, "avatars", "profile.png"));
        expect(payload.avatarUrl).toBe("mxc://matrix.org/abc123def456");
      });
    });

    it("routes plugin-owned host media hints into local-root expansion", async () => {
      const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "msg-profile-media-"));
      try {
        const avatarPath = path.join(tempDir, "profile.png");
        await fs.writeFile(avatarPath, onePixelPng);

        const result = await runMessageAction({
          cfg: {
            tools: { fs: { workspaceOnly: false } },
          } as OpenClawConfig,
          action: "set-profile",
          params: {
            channel: "profile-demo",
            avatarPath,
          },
        });

        expect(result.kind).toBe("action");
        const mediaLocalRoots = requireActionPayload(result).mediaLocalRoots;
        expect(Array.isArray(mediaLocalRoots)).toBe(true);
        expect(mediaLocalRoots).toContain(tempDir);
      } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
      }
    });

    it("does not apply set-profile media params to send actions", async () => {
      await withSandbox(async (sandboxDir) => {
        const avatarUrl = "data:text/plain;base64,SGVsbG8=";
        const result = await runMessageAction({
          cfg: {} as OpenClawConfig,
          action: "send",
          dryRun: true,
          params: {
            channel: "profile-demo",
            target: "@profile-demo",
            message: "hi",
            avatarUrl,
          },
          sandboxRoot: sandboxDir,
        });

        expect(result.kind).toBe("send");
        if (result.kind !== "send") {
          throw new Error("expected send result");
        }
        if (!result.sendResult) {
          throw new Error("Expected send result payload");
        }
        expect(result.sendResult.channel).toBe("profile-demo");
      });
    });
  });

  describe("sandboxed media validation", () => {
    beforeEach(() => {
      setActivePluginRegistry(
        createTestRegistry([
          {
            pluginId: "workspace",
            source: "test",
            plugin: workspacePlugin,
          },
        ]),
      );
    });

    afterEach(() => {
      setActivePluginRegistry(createTestRegistry([]));
    });

    it.each([
      {
        name: "media absolute path",
        mediaField: "media" as const,
        media: "/etc/passwd",
      },
      {
        name: "mediaUrl absolute path",
        mediaField: "mediaUrl" as const,
        media: "/etc/passwd",
      },
      {
        name: "mediaUrl file URL",
        mediaField: "mediaUrl" as const,
        media: "file:///etc/passwd",
      },
      {
        name: "fileUrl file URL",
        mediaField: "fileUrl" as const,
        media: "file:///etc/passwd",
      },
    ])("rejects out-of-sandbox media reference: $name", async ({ mediaField, media }) => {
      await withSandbox(async (sandboxDir) => {
        await expect(
          runDrySend({
            cfg: workspaceConfig,
            actionParams: {
              channel: "workspace",
              target: "12345678",
              [mediaField]: media,
              message: "",
            },
            sandboxRoot: sandboxDir,
          }),
        ).rejects.toThrow(/sandbox/i);
      });
    });

    it("rejects data URLs in media params", async () => {
      await expect(
        runDrySend({
          cfg: workspaceConfig,
          actionParams: {
            channel: "workspace",
            target: "12345678",
            media: "data:image/png;base64,abcd",
            message: "",
          },
        }),
      ).rejects.toThrow(/data:/i);
    });

    it("rewrites in-sandbox media references before dry send", async () => {
      for (const testCase of [
        {
          name: "relative media path",
          media: "./data/file.txt",
          message: "",
          expectedRelativePath: path.join("data", "file.txt"),
        },
        {
          name: "relative mediaUrl path",
          mediaField: "mediaUrl" as const,
          media: "./data/file.txt",
          message: "",
          expectedRelativePath: path.join("data", "file.txt"),
        },
        {
          name: "/workspace fileUrl path",
          mediaField: "fileUrl" as const,
          media: "/workspace/data/file.txt",
          message: "",
          expectedRelativePath: path.join("data", "file.txt"),
        },
        {
          name: "/workspace media path",
          media: "/workspace/data/file.txt",
          message: "",
          expectedRelativePath: path.join("data", "file.txt"),
        },
        {
          name: "MEDIA directive",
          message: "Hello\nMEDIA: ./data/note.ogg",
          expectedRelativePath: path.join("data", "note.ogg"),
        },
      ] as const) {
        await withSandbox(async (sandboxDir) => {
          await expectSandboxMediaRewrite({
            sandboxDir,
            media: testCase.media,
            mediaField: testCase.mediaField,
            message: testCase.message,
            expectedRelativePath: testCase.expectedRelativePath,
          });
        });
      }
    });

    it("prefers media over mediaUrl when both aliases are present", async () => {
      await withSandbox(async (sandboxDir) => {
        const result = await runDrySend({
          cfg: workspaceConfig,
          actionParams: {
            channel: "workspace",
            target: "12345678",
            media: "./data/primary.txt",
            mediaUrl: "./data/secondary.txt",
            message: "",
          },
          sandboxRoot: sandboxDir,
        });

        expect(result.kind).toBe("send");
        if (result.kind !== "send") {
          throw new Error("expected send result");
        }
        expect(result.sendResult?.mediaUrl).toBe(path.join(sandboxDir, "data", "primary.txt"));
      });
    });

    it.each([
      {
        name: "mediaUrl",
        mediaField: "mediaUrl" as const,
      },
      {
        name: "fileUrl",
        mediaField: "fileUrl" as const,
      },
    ])(
      "keeps remote HTTP $name aliases unchanged under sandbox validation",
      async ({ mediaField }) => {
        await withSandbox(async (sandboxDir) => {
          const remoteUrl = "https://example.com/files/report.pdf?sig=1";
          const result = await runDrySend({
            cfg: workspaceConfig,
            actionParams: {
              channel: "workspace",
              target: "12345678",
              [mediaField]: remoteUrl,
              message: "",
            },
            sandboxRoot: sandboxDir,
          });

          expect(result.kind).toBe("send");
          if (result.kind !== "send") {
            throw new Error("expected send result");
          }
          expect(result.sendResult?.mediaUrl).toBe(remoteUrl);
        });
      },
    );

    it("allows media paths under preferred OpenClaw tmp root", async () => {
      const tmpRoot = resolvePreferredOpenClawTmpDir();
      await fs.mkdir(tmpRoot, { recursive: true });
      const sandboxDir = await fs.mkdtemp(path.join(os.tmpdir(), "msg-sandbox-"));
      try {
        const tmpFile = path.join(tmpRoot, "test-media-image.png");
        const result = await runMessageAction({
          cfg: workspaceConfig,
          action: "send",
          params: {
            channel: "workspace",
            target: "12345678",
            media: tmpFile,
            message: "",
          },
          sandboxRoot: sandboxDir,
          dryRun: true,
        });

        expect(result.kind).toBe("send");
        if (result.kind !== "send") {
          throw new Error("expected send result");
        }
        expect(result.sendResult?.mediaUrl).toBe(path.resolve(tmpFile));
        const hostTmpOutsideOpenClaw = path.join(os.tmpdir(), "outside-openclaw", "test-media.png");
        await expect(
          runMessageAction({
            cfg: workspaceConfig,
            action: "send",
            params: {
              channel: "workspace",
              target: "12345678",
              media: hostTmpOutsideOpenClaw,
              message: "",
            },
            sandboxRoot: sandboxDir,
            dryRun: true,
          }),
        ).rejects.toThrow(/sandbox/i);
      } finally {
        await fs.rm(sandboxDir, { recursive: true, force: true });
      }
    });
  });
});
