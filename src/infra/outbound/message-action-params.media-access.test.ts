import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
// Covers message-action media hydration, sandbox path normalization,
// attachments, and channel/plugin media source aliases.
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { jsonResult } from "../../agents/tools/common.js";
import type { ChannelPlugin } from "../../channels/plugins/types.public.js";
import type { OpenClawConfig } from "../../config/config.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";
import { resolvePreferredOpenClawTmpDir } from "../tmp-openclaw-dir.js";
import {
  resetMessageActionMediaMocks,
  runMessageAction,
  setMessageActionTestPlugin as setTestPlugin,
} from "./message-action-runner.test-helpers.js";

const onePixelPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO5m8gAAAABJRU5ErkJggg==",
  "base64",
);

const workspaceConfig = {
  channels: {
    workspace: {
      botToken: "xoxb-test",
      appToken: "xapp-test",
    },
  },
} as OpenClawConfig;

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

const requireRecord = createRequireRecord("record", "expected-non-array-record");

function requireActionPayload(
  result: Awaited<ReturnType<typeof runMessageAction>>,
): Record<string, unknown> {
  expect(result.kind).toBe("action");
  if (result.kind !== "action") {
    throw new Error("expected action result");
  }
  return requireRecord(result.payload);
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
      setTestPlugin(profilePlugin, "profile-demo");
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
      setTestPlugin(workspacePlugin, "workspace");
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
