import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
// Covers message-action media hydration, sandbox path normalization,
// attachments, and channel/plugin media source aliases.
import { canonicalizeBase64 } from "@openclaw/media-core/base64";
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { jsonResult } from "../../agents/tools/common.js";
import type { ChannelPlugin } from "../../channels/plugins/types.public.js";
import type { OpenClawConfig } from "../../config/config.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { createTestRegistry } from "../../test-utils/channel-plugins.js";
import {
  messageActionRunnerMocks,
  resetMessageActionMediaMocks,
  runMessageAction,
  setMessageActionTestPlugin as setTestPlugin,
} from "./message-action-runner.test-helpers.js";

const { hydrateAttachmentParamsForAction, normalizeSandboxMediaParams } =
  await import("./message-action-params.js");
const loadWebMedia = messageActionRunnerMocks.loadWebMedia;

const onePixelPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO5m8gAAAABJRU5ErkJggg==",
  "base64",
);
const onePixelPngBase64 = onePixelPng.toString("base64");
const wrappedOnePixelPngBase64 = onePixelPngBase64.match(/.{1,24}/g)?.join("\r\n") ?? "";
const parameterizedPngDataUrl = `data:image/png;charset=utf-8;name=../../ignored.svg;base64,${wrappedOnePixelPngBase64}`;

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

function requireLoadWebMediaOptions(): Record<string, unknown> {
  const call = requireLoadWebMediaCall();
  return requireRecord(call[1]);
}

function requireLoadWebMediaCall(): readonly unknown[] {
  const call = vi.mocked(loadWebMedia).mock.calls[0];
  if (!call) {
    throw new Error("Expected loadWebMedia to be called");
  }
  return call;
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

describe("runMessageAction media behavior", () => {
  beforeEach(async () => {
    await resetMessageActionMediaMocks();
  });

  it.each(["send", "sendAttachment", "reply", "upload-file", "setGroupIcon"] as const)(
    "normalizes parameterized, line-wrapped image data URLs for %s",
    async (action) => {
      const args: Record<string, unknown> = { buffer: parameterizedPngDataUrl };

      await hydrateAttachmentParamsForAction({
        cfg: {},
        channel: "imessage",
        args,
        action,
        dryRun: true,
        mediaPolicy: { mode: "host" },
      });

      expect(args.contentType).toBe("image/png");
      if (action === "send") {
        expect(args.media).toBe("buffer://message-send/attachment");
        expect(args.filename).toBe("attachment.png");
      } else {
        expect(canonicalizeBase64(String(args.buffer))).toBe(onePixelPngBase64);
      }
      expect(args.filename).not.toBe("../../ignored.svg");
    },
  );

  it.each(["send", "sendAttachment", "reply", "upload-file", "setGroupIcon"] as const)(
    "keeps explicit content type authoritative for %s data URLs",
    async (action) => {
      const args: Record<string, unknown> = {
        buffer: parameterizedPngDataUrl,
        contentType: "image/jpeg",
      };

      await hydrateAttachmentParamsForAction({
        cfg: {},
        channel: "imessage",
        args,
        action,
        dryRun: true,
        mediaPolicy: { mode: "host" },
      });

      expect(args.contentType).toBe("image/jpeg");
      expect(args.filename).toBe("attachment.jpg");
    },
  );

  it.each([
    ["duplicate marker", "image/png;base64;base64"],
    ["marker before another parameter", "image/png;base64;charset=utf-8"],
    ["missing MIME type", ";base64"],
    ["metadata newline", "image/png;name=bad\r\nvalue;base64"],
  ])("rejects a data URL with a %s", async (_label, metadata) => {
    await expect(
      hydrateAttachmentParamsForAction({
        cfg: {},
        channel: "imessage",
        args: { buffer: `data:${metadata},${onePixelPngBase64}` },
        action: "send",
        dryRun: true,
        mediaPolicy: { mode: "host" },
      }),
    ).rejects.toThrow(/invalid base64/i);
  });

  it("rejects an oversized parameterized data URL before decoding its payload", async () => {
    const fromSpy = vi.spyOn(Buffer, "from");
    try {
      await expect(
        hydrateAttachmentParamsForAction({
          cfg: { agents: { defaults: { mediaMaxMb: 0.00001 } } },
          channel: "imessage",
          args: { buffer: parameterizedPngDataUrl },
          action: "send",
          dryRun: true,
          mediaPolicy: { mode: "host" },
        }),
      ).rejects.toThrow(/too large|limit/i);
      const base64Calls = (fromSpy.mock.calls as ReadonlyArray<readonly unknown[]>).filter(
        (call) => call[1] === "base64",
      );
      expect(base64Calls).toHaveLength(0);
    } finally {
      fromSpy.mockRestore();
    }
  });

  it.each(["media", "mediaUrl", "path", "filePath"])(
    "keeps data URLs forbidden in the %s source field",
    async (field) => {
      await expect(
        normalizeSandboxMediaParams({
          args: { [field]: parameterizedPngDataUrl },
          mediaPolicy: { mode: "host" },
        }),
      ).rejects.toThrow(/data: URLs are not supported for media/i);
    },
  );

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
      setTestPlugin(attachmentPlugin, "attachmentchat");
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

    it.each(["sendAttachment", "upload-file"] as const)(
      "delivers parameterized wrapped image data URLs through the %s handler",
      async (action) => {
        const result = await runMessageAction({
          cfg,
          action,
          params: {
            channel: "attachmentchat",
            target: "+15551234567",
            buffer: parameterizedPngDataUrl,
          },
        });

        const payload = requireActionPayload(result);
        expect(payload.contentType).toBe("image/png");
        expect(canonicalizeBase64(String(payload.buffer))).toBe(onePixelPngBase64);
      },
    );

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

    it("hydrates validated host-local text attachments when fs root expansion is enabled", async () => {
      await restoreRealMediaLoader();

      const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "msg-attachment-text-"));
      try {
        const outsidePath = path.join(tempDir, "secret.txt");
        await fs.writeFile(outsidePath, "secret", "utf8");

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

        expect(result.kind).toBe("action");
        expect(result.payload).toMatchObject({
          ok: true,
          filename: "secret.txt",
          caption: "caption",
          contentType: "text/plain",
        });
        expect((result.payload as { buffer?: string }).buffer).toBe(
          Buffer.from("secret").toString("base64"),
        );
      } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
      }
    });

    it("hydrates buffer and filename from media for attachment upload-file", async () => {
      const result = await runAttachmentRemoteMediaAction({ cfg, action: "upload-file" });

      expectAttachmentRemoteMediaPayload(result);
    });

    it("keeps original upload-file bytes when forced to send as a document", async () => {
      await runMessageAction({
        cfg,
        action: "upload-file",
        params: {
          channel: "attachmentchat",
          target: "+15551234567",
          media: "https://example.com/pic.png",
          message: "caption",
          forceDocument: true,
        },
      });

      expect(requireLoadWebMediaOptions().optimizeImages).toBe(false);
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
      setTestPlugin(replyPlugin, "replychat");
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

    it("delivers parameterized wrapped image data URLs through the reply handler", async () => {
      await runMessageAction({
        cfg,
        action: "reply",
        params: {
          channel: "replychat",
          target: "+15551234567",
          messageId: "parent-id",
          buffer: parameterizedPngDataUrl,
        },
      });

      const handlerParams = firstMockArg(handleActionMock, "handleAction");
      expect(handlerParams.contentType).toBe("image/png");
      expect(canonicalizeBase64(String(handlerParams.buffer))).toBe(onePixelPngBase64);
    });

    it("hydrates buffer and metadata from attachments[] before the reply handler runs", async () => {
      const result = await runMessageAction({
        cfg,
        action: "reply",
        params: {
          channel: "replychat",
          target: "+15551234567",
          messageId: "parent-id",
          text: "look at this",
          attachments: [
            {
              url: "https://example.com/pic.png",
              name: "reply.png",
              mimeType: "image/png",
            },
          ],
        },
      });

      expect(result.kind).toBe("action");
      expect(loadWebMedia).toHaveBeenCalledWith("https://example.com/pic.png", expect.any(Object));
      expect(handleActionMock).toHaveBeenCalledTimes(1);
      const handlerParams = firstMockArg(handleActionMock, "handleAction");
      expect(handlerParams.buffer).toBe(Buffer.from("hello").toString("base64"));
      expect(handlerParams.filename).toBe("reply.png");
      expect(handlerParams.contentType).toBe("image/png");
    });

    it("does not copy metadata from attachments[] when top-level media wins", async () => {
      await runMessageAction({
        cfg,
        action: "reply",
        params: {
          channel: "replychat",
          target: "+15551234567",
          messageId: "parent-id",
          text: "look at this",
          media: "https://example.com/pic.png",
          attachments: [
            {
              url: "https://example.com/ignored.pdf",
              name: "ignored.pdf",
              mimeType: "application/pdf",
            },
          ],
        },
      });

      expect(loadWebMedia).toHaveBeenCalledWith("https://example.com/pic.png", expect.any(Object));
      const handlerParams = firstMockArg(handleActionMock, "handleAction");
      expect(handlerParams.filename).toBe("pic.png");
      expect(handlerParams.contentType).toBe("image/png");
    });

    it("routes attachments[] host paths into local-root expansion", async () => {
      const actual = await vi.importActual<typeof import("../../media/web-media.js")>(
        "../../media/web-media.js",
      );
      vi.mocked(loadWebMedia).mockImplementation(actual.loadWebMedia);

      const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "msg-reply-attachment-path-"));
      try {
        const attachmentPath = path.join(tempDir, "photo.png");
        await fs.writeFile(attachmentPath, onePixelPng);

        const result = await runMessageAction({
          cfg: {
            ...cfg,
            tools: { fs: { workspaceOnly: false } },
          },
          action: "reply",
          params: {
            channel: "replychat",
            target: "+15551234567",
            messageId: "parent-id",
            text: "look at this",
            attachments: [
              {
                path: attachmentPath,
                name: "photo.png",
                mimeType: "image/png",
              },
            ],
          },
        });

        expect(result.kind).toBe("action");
        const handlerParams = firstMockArg(handleActionMock, "handleAction");
        expect(handlerParams.filename).toBe("photo.png");
        expect(handlerParams.contentType).toBe("image/png");
        expect(typeof handlerParams.buffer).toBe("string");
      } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
      }
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
});
