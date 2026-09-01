import fs from "node:fs/promises";
import path from "node:path";
// Covers message-action media hydration, sandbox path normalization,
// attachments, and channel/plugin media source aliases.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { jsonResult } from "../../agents/tools/common.js";
import type { ChannelPlugin } from "../../channels/plugins/types.public.js";
import type { OpenClawConfig } from "../../config/config.js";
import { createChannelTestPluginBase } from "../../test-utils/channel-plugins.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  messageActionRunnerMocks as channelResolutionMocks,
  resetMessageActionMediaMocks,
  runMessageAction,
  setMessageActionTestPlugin as setTestPlugin,
} from "./message-action-runner.test-helpers.js";

const loadWebMedia = channelResolutionMocks.loadWebMedia;

const workspaceConfig = {
  channels: {
    workspace: {
      botToken: "xoxb-test",
      appToken: "xapp-test",
    },
  },
} as OpenClawConfig;

async function withTempOpenClawStateDir<T>(test: (stateDir: string) => Promise<T>): Promise<T> {
  return await withOpenClawTestState(
    { layout: "state-only", prefix: "msg-runner-state-" },
    (state) => test(state.stateDir),
  );
}

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
    await resetMessageActionMediaMocks();
  });
  it("rejects plugin-declined attachment actions before loading media", async () => {
    const handleAction = vi.fn(async () => jsonResult({ ok: true }));
    const textOnlyPlugin: ChannelPlugin = {
      ...createChannelTestPluginBase({
        id: "textonly",
        label: "TextOnly",
        config: {
          listAccountIds: () => ["default"],
          resolveAccount: () => ({ enabled: true }),
          isConfigured: () => true,
        },
      }),
      outbound: {
        deliveryMode: "direct",
        resolveTarget: ({ to }) => ({ ok: true, to: to?.trim() ?? "" }),
        sendText: async () => ({ channel: "textonly", messageId: "msg-test" }),
        sendMedia: async () => ({ channel: "textonly", messageId: "msg-test" }),
      },
      actions: {
        describeMessageTool: () => ({ actions: ["send"] }),
        supportsAction: ({ action }) => action === "send",
        handleAction,
      },
    };
    setTestPlugin(textOnlyPlugin, "textonly");
    vi.mocked(loadWebMedia).mockResolvedValue({
      buffer: Buffer.from("should not load"),
      contentType: "image/png",
      kind: "image",
      fileName: "pic.png",
    });

    await expect(
      runMessageAction({
        cfg: { channels: { textonly: { enabled: true } } } as OpenClawConfig,
        action: "upload-file",
        params: {
          channel: "textonly",
          target: "room-1",
          media: "https://example.com/pic.png",
        },
      }),
    ).rejects.toThrow("Message action upload-file not supported for channel textonly.");

    expect(loadWebMedia).not.toHaveBeenCalled();
    expect(handleAction).not.toHaveBeenCalled();
  });

  it("does not stage buffer-only send attachments before target validation passes", async () => {
    setTestPlugin(workspacePlugin, "workspace");

    await withTempOpenClawStateDir(async (stateDir) => {
      await expect(
        runMessageAction({
          cfg: workspaceConfig,
          action: "send",
          params: {
            channel: "workspace",
            target: "",
            buffer: Buffer.from("orphan bytes").toString("base64"),
            filename: "orphan.txt",
            contentType: "text/plain",
          },
        }),
      ).rejects.toThrow(/target/i);

      expect(channelResolutionMocks.executeSendAction).not.toHaveBeenCalled();
      await expect(fs.readdir(path.join(stateDir, "media", "outbound"))).rejects.toThrow();
    });
  });

  it("keeps sandbox attachment hydration off the host reader without workspace access", async () => {
    const handleAction = vi.fn(async () => jsonResult({ ok: true }));
    const uploadPlugin: ChannelPlugin = {
      ...workspacePlugin,
      messaging: {
        normalizeTarget: (raw) => raw.trim() || undefined,
        targetResolver: { looksLikeId: (raw) => raw.trim().length > 0 },
      },
      actions: {
        describeMessageTool: () => ({ actions: ["upload-file"] }),
        supportsAction: ({ action }) => action === "upload-file",
        handleAction,
      },
    };
    setTestPlugin(uploadPlugin, "workspace");
    const hostReadFile = vi.fn(async () => Buffer.from("host workspace"));
    vi.mocked(loadWebMedia).mockImplementation(async (_mediaUrl, maxBytesOrOptions) => {
      const options =
        typeof maxBytesOrOptions === "object" && maxBytesOrOptions !== null
          ? maxBytesOrOptions
          : undefined;
      expect(options?.readFile).not.toBe(hostReadFile);
      return {
        buffer: Buffer.from("sandbox mirror"),
        contentType: "text/plain",
        fileName: "chart.txt",
        kind: "document",
      };
    });

    await runMessageAction({
      cfg: workspaceConfig,
      action: "upload-file",
      params: {
        channel: "workspace",
        target: "room-1",
        media: "/sandbox/chart.txt",
      },
      sandboxRoot: "/host-mirror",
      sandboxContainerWorkdir: "/sandbox",
      mediaAccess: { localRoots: ["/host-mirror"], readFile: hostReadFile },
    });

    expect(loadWebMedia).toHaveBeenCalled();
    expect(hostReadFile).not.toHaveBeenCalled();
    expect(handleAction).toHaveBeenCalled();
  });
});
