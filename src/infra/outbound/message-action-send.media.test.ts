import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
// Covers message-action media hydration, sandbox path normalization,
// attachments, and channel/plugin media source aliases.
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelPlugin } from "../../channels/plugins/types.public.js";
import type { OpenClawConfig } from "../../config/config.js";
import { MEDIA_MAX_BYTES } from "../../media/store.js";
import { loadWebMedia } from "../../media/web-media.js";
import { getActivePluginRegistry, setActivePluginRegistry } from "../../plugins/runtime.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { runMessageAction } from "./message-action-runner.js";

const channelResolutionMocks = vi.hoisted(() => ({
  resolveOutboundChannelPlugin: vi.fn(),
  executeSendAction: vi.fn(),
  executePollAction: vi.fn(),
}));

vi.mock("./channel-resolution.js", () => ({
  normalizeDeliverableOutboundChannel: (value?: string | null) =>
    typeof value === "string" ? value.trim().toLowerCase() || undefined : undefined,
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

function setTestPlugin(plugin: ChannelPlugin, pluginId: string) {
  setActivePluginRegistry(createTestRegistry([{ pluginId, source: "test", plugin }]));
}

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

async function withTempOpenClawStateDir<T>(test: (stateDir: string) => Promise<T>): Promise<T> {
  return await withOpenClawTestState(
    { layout: "state-only", prefix: "msg-runner-state-" },
    (state) => test(state.stateDir),
  );
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

const requireRecord = createRequireRecord("record", "expected-non-array-record");

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
    setTestPlugin(workspacePlugin, "workspace");

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

  it("copies the normalized idempotency key into send execution context", async () => {
    setTestPlugin(workspacePlugin, "workspace");

    await runDrySend({
      cfg: workspaceConfig,
      actionParams: {
        channel: "workspace",
        target: "12345678",
        message: "hello",
        idempotencyKey: " run-1:message-tool:send-1:fingerprint ",
      },
    });

    const sendArgs = firstMockArg(channelResolutionMocks.executeSendAction, "executeSendAction");
    expect(requireRecord(sendArgs.ctx).idempotencyKey).toBe(
      "run-1:message-tool:send-1:fingerprint",
    );
    expect(requireRecord(sendArgs.ctx).plugin).toBe(workspacePlugin);
    expect(channelResolutionMocks.resolveOutboundChannelPlugin).toHaveBeenCalledTimes(1);
  });

  it("materializes buffer-only send attachments into outbound media paths", async () => {
    setTestPlugin(workspacePlugin, "workspace");

    await withTempOpenClawStateDir(async () => {
      const result = await runMessageAction({
        cfg: workspaceConfig,
        action: "send",
        params: {
          channel: "workspace",
          target: "12345678",
          buffer: Buffer.from("artifact bytes").toString("base64"),
          filename: "artifact.txt",
          contentType: "text/plain",
        },
      });

      expect(result.kind).toBe("send");
      if (result.kind !== "send") {
        throw new Error("expected send result");
      }
      expect(result.sendResult?.mediaUrl).toBeTypeOf("string");
      await expect(fs.readFile(String(result.sendResult?.mediaUrl), "utf8")).resolves.toBe(
        "artifact bytes",
      );

      const sendArgs = firstMockArg(channelResolutionMocks.executeSendAction, "executeSendAction");
      const sendCtx = requireRecord(sendArgs.ctx);
      const sendParams = requireRecord(sendCtx.params);
      expect(sendParams.buffer).toBeUndefined();
      expect(sendArgs.mediaUrl).toBe(result.sendResult?.mediaUrl);
      expect(sendArgs.mediaUrls).toEqual([result.sendResult?.mediaUrl]);
    });
  });

  it("rejects oversized buffer-only send attachments before channel dispatch", async () => {
    setTestPlugin(workspacePlugin, "workspace");

    await withTempOpenClawStateDir(async () => {
      await expect(
        runMessageAction({
          cfg: workspaceConfig,
          action: "send",
          params: {
            channel: "workspace",
            target: "12345678",
            message: "too large",
            buffer: Buffer.alloc(MEDIA_MAX_BYTES + 1, 1).toString("base64"),
            contentType: "application/octet-stream",
          },
        }),
      ).rejects.toThrow(/too large|limit/i);

      expect(channelResolutionMocks.executeSendAction).not.toHaveBeenCalled();
    });
  });

  it("previews dry-run buffer-only sends without writing outbound media files", async () => {
    setTestPlugin(workspacePlugin, "workspace");

    await withTempOpenClawStateDir(async (stateDir) => {
      const result = await runDrySend({
        cfg: workspaceConfig,
        actionParams: {
          channel: "workspace",
          target: "12345678",
          buffer: Buffer.from("preview bytes").toString("base64"),
          filename: "preview.txt",
          contentType: "text/plain",
        },
      });

      expect(result.kind).toBe("send");
      const sendArgs = firstMockArg(channelResolutionMocks.executeSendAction, "executeSendAction");
      const sendCtx = requireRecord(sendArgs.ctx);
      const sendParams = requireRecord(sendCtx.params);
      expect(sendParams.buffer).toBeUndefined();
      expect(sendArgs.mediaUrl).toBe("buffer://message-send/attachment");
      expect(sendArgs.mediaUrls).toEqual(["buffer://message-send/attachment"]);
      await expect(fs.readdir(path.join(stateDir, "media", "outbound"))).rejects.toThrow();
    });
  });

  it("treats top-level image param as a send media source", async () => {
    setTestPlugin(workspacePlugin, "workspace");

    await withSandbox(async (sandboxDir) => {
      const result = await runDrySend({
        cfg: workspaceConfig,
        actionParams: {
          channel: "workspace",
          target: "12345678",
          message: "1/7",
          image: "/workspace/photo.jpg",
        },
        sandboxRoot: sandboxDir,
      });

      expect(result.kind).toBe("send");
      if (result.kind !== "send") {
        throw new Error("expected send result");
      }
      expect(result.sendResult?.mediaUrl).toBe(path.join(sandboxDir, "photo.jpg"));
      expect(result.sendResult?.mediaUrls).toEqual([path.join(sandboxDir, "photo.jpg")]);
    });
  });

  it("sends structured attachments as media urls", async () => {
    setTestPlugin(workspacePlugin, "workspace");

    await withSandbox(async (sandboxDir) => {
      const result = await runDrySend({
        cfg: workspaceConfig,
        actionParams: {
          channel: "workspace",
          target: "12345678",
          message: "track ready",
          attachments: [{ path: "./song.mp3" }, { filePath: "/workspace/cover.png" }],
        },
        sandboxRoot: sandboxDir,
      });

      expect(result.kind).toBe("send");
      if (result.kind !== "send") {
        throw new Error("expected send result");
      }
      expect(result.sendResult?.mediaUrl).toBe(path.join(sandboxDir, "song.mp3"));
      expect(result.sendResult?.mediaUrls).toEqual([
        path.join(sandboxDir, "song.mp3"),
        path.join(sandboxDir, "cover.png"),
      ]);
    });
  });

  it("sends structured mediaUrls arrays", async () => {
    setTestPlugin(workspacePlugin, "workspace");

    await withSandbox(async (sandboxDir) => {
      const result = await runDrySend({
        cfg: workspaceConfig,
        actionParams: {
          channel: "workspace",
          target: "12345678",
          mediaUrls: ["./one.png", "/workspace/two.png"],
        },
        sandboxRoot: sandboxDir,
      });

      expect(result.kind).toBe("send");
      if (result.kind !== "send") {
        throw new Error("expected send result");
      }
      expect(result.sendResult?.mediaUrl).toBe(path.join(sandboxDir, "one.png"));
      expect(result.sendResult?.mediaUrls).toEqual([
        path.join(sandboxDir, "one.png"),
        path.join(sandboxDir, "two.png"),
      ]);
      const sendArgs = firstMockArg(channelResolutionMocks.executeSendAction, "executeSendAction");
      const sendCtx = requireRecord(sendArgs.ctx);
      const sendParams = requireRecord(sendCtx.params);
      const sendMediaAccess = requireRecord(sendCtx.mediaAccess);
      expect(sendMediaAccess.localRoots).toEqual(expect.arrayContaining([sandboxDir]));
      expect(sendParams.mediaUrls).toEqual([
        path.join(sandboxDir, "one.png"),
        path.join(sandboxDir, "two.png"),
      ]);
    });
  });
});
