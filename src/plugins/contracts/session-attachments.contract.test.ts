import fs from "node:fs/promises";
import path from "node:path";
import {
  createPluginRegistryFixture,
  registerTestPlugin,
} from "openclaw/plugin-sdk/plugin-test-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { updateSessionStore, type SessionEntry } from "../../config/sessions.js";
import { withTempConfig } from "../../gateway/test-temp-config.js";
import { resolvePreferredOpenClawTmpDir } from "../../infra/tmp-openclaw-dir.js";
import { FILE_TYPE_SNIFF_MAX_BYTES } from "../../media/mime.js";
import { createOutboundTestPlugin, createTestRegistry } from "../../test-utils/channel-plugins.js";
import {
  resolveAttachmentDelivery,
  sendPluginSessionAttachment,
} from "../host-hook-attachments.js";
import { clearPluginLoaderCache } from "../loader.js";
import { createEmptyPluginRegistry } from "../registry-empty.js";
import { createPluginRegistry } from "../registry.js";
import { setActivePluginRegistry } from "../runtime.js";
import type { PluginRuntime } from "../runtime/types.js";
import { createPluginRecord } from "../status.test-helpers.js";
import type { OpenClawPluginApi } from "../types.js";

const workflowMocks = vi.hoisted(() => ({
  getChannelPlugin: vi.fn(),
  sendMessage: vi.fn(),
}));

const MAIN_SESSION_KEY = "agent:main:main";
const DEFAULT_TELEGRAM_ROUTE = {
  channel: "telegram",
  to: "12345",
} as const;

type SessionAttachmentRequest = Parameters<typeof sendPluginSessionAttachment>[0];
type TestSessionEntry = {
  sessionId?: string;
  updatedAt?: number;
  deliveryContext?: Record<string, unknown>;
};

vi.mock("../../channels/plugins/index.js", () => ({
  getChannelPlugin: workflowMocks.getChannelPlugin,
}));

vi.mock("../../infra/outbound/message.js", () => ({
  sendMessage: workflowMocks.sendMessage,
}));

function createSilentPluginLogger() {
  return {
    info() {},
    warn() {},
    error() {},
    debug() {},
  };
}

async function withSessionStore(
  run: (params: { stateDir: string; storePath: string; filePath: string }) => Promise<void>,
) {
  const stateDir = await fs.mkdtemp(
    path.join(resolvePreferredOpenClawTmpDir(), "openclaw-session-attachments-"),
  );
  const storePath = path.join(stateDir, "sessions.json");
  const filePath = path.join(stateDir, "x.txt");
  await fs.writeFile(filePath, "x", "utf8");
  const previousStateDir = process.env.OPENCLAW_STATE_DIR;
  process.env.OPENCLAW_STATE_DIR = stateDir;
  try {
    await withTempConfig({
      cfg: { session: { store: storePath } },
      run: async () => await run({ stateDir, storePath, filePath }),
    });
  } finally {
    if (previousStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = previousStateDir;
    }
    await fs.rm(stateDir, { recursive: true, force: true });
  }
}

async function writeSessionEntry(
  storePath: string,
  entry: TestSessionEntry = { deliveryContext: DEFAULT_TELEGRAM_ROUTE },
  key = MAIN_SESSION_KEY,
) {
  await updateSessionStore(storePath, (store) => {
    store[key] = {
      sessionId: "session-id",
      updatedAt: Date.now(),
      ...entry,
    } as unknown as SessionEntry;
    return undefined;
  });
}

function mockSuccessfulAttachmentDelivery(messageId = "attachment-1") {
  workflowMocks.sendMessage.mockImplementation(async (params: Record<string, unknown>) => ({
    channel: params.channel,
    to: params.to,
    via: "direct" as const,
    mediaUrl: null,
    result: { channel: params.channel, messageId },
  }));
}

async function sendBundledSessionAttachment(
  params: Omit<SessionAttachmentRequest, "origin" | "sessionKey"> &
    Partial<Pick<SessionAttachmentRequest, "sessionKey">>,
) {
  return await sendPluginSessionAttachment({
    origin: "bundled",
    sessionKey: MAIN_SESSION_KEY,
    ...params,
  });
}

function expectTelegramAttachmentResult(result: unknown, count: number) {
  const response = result as { ok?: unknown; channel?: unknown; count?: unknown };
  expect(response.ok).toBe(true);
  expect(response.channel).toBe("telegram");
  expect(response.count).toBe(count);
}

function requireFirstSendMessageParams() {
  const params = workflowMocks.sendMessage.mock.calls.at(0)?.[0] as
    | Record<string, unknown>
    | undefined;
  if (!params) {
    throw new Error("expected sendMessage call");
  }
  return params;
}

describe("plugin session attachments", () => {
  afterEach(() => {
    workflowMocks.getChannelPlugin.mockReset();
    workflowMocks.sendMessage.mockReset();
    setActivePluginRegistry(createEmptyPluginRegistry());
    clearPluginLoaderCache();
    delete (globalThis as { __proofAttachmentApi?: OpenClawPluginApi }).__proofAttachmentApi;
    delete (globalThis as { __proofAttachmentLog?: unknown[] }).__proofAttachmentLog;
  });

  it("resolves channel hint precedence for attachment delivery", () => {
    expect(
      resolveAttachmentDelivery({
        channel: "telegram",
        captionFormat: "html",
        channelHints: { telegram: { parseMode: "HTML" } },
      }),
    ).toEqual({ parseMode: "HTML" });
    expect(resolveAttachmentDelivery({ channel: "telegram", captionFormat: "html" })).toEqual({
      parseMode: "HTML",
    });
    expect(resolveAttachmentDelivery({ channel: "telegram", captionFormat: "plain" })).toEqual({
      parseMode: "HTML",
      escapePlainHtmlCaption: true,
    });
    expect(
      resolveAttachmentDelivery({
        channel: "telegram",
        captionFormat: "plain",
        channelHints: { telegram: { parseMode: "HTML" } },
      }),
    ).toEqual({
      parseMode: "HTML",
      escapePlainHtmlCaption: true,
    });
    expect(
      resolveAttachmentDelivery({
        channel: "telegram",
        channelHints: {
          telegram: { disableNotification: true, forceDocumentMime: "application/pdf" },
        },
      }),
    ).toEqual({
      disableNotification: true,
      forceDocumentMime: "application/pdf",
    });
    expect(
      resolveAttachmentDelivery({
        channel: "slack",
        channelHints: { slack: { threadTs: "1700000000.000100" } },
      }),
    ).toEqual({ threadTs: "1700000000.000100" });
    expect(
      resolveAttachmentDelivery({
        channel: "slack",
        channelHints: { slack: { threadTs: " 1700000000.000100 " } },
      }),
    ).toEqual({ threadTs: "1700000000.000100" });
    expect(
      resolveAttachmentDelivery({
        channel: "slack",
        channelHints: { slack: { threadTs: "   " } },
      }),
    ).toEqual({});
    expect(resolveAttachmentDelivery({ channel: "discord", captionFormat: "markdown" })).toEqual(
      {},
    );
    expect(
      resolveAttachmentDelivery({
        channel: "unknown",
        channelHints: { telegram: { parseMode: "HTML" } },
      }),
    ).toEqual({});
  });

  it("sends validated files through the session delivery route with channel hints", async () => {
    await withSessionStore(async ({ storePath, filePath }) => {
      await writeSessionEntry(storePath, {
        deliveryContext: {
          ...DEFAULT_TELEGRAM_ROUTE,
          accountId: "default",
          threadId: 42,
        },
      });
      mockSuccessfulAttachmentDelivery();

      const result = await sendBundledSessionAttachment({
        files: [{ path: filePath }],
        channelHints: { telegram: { disableNotification: true, parseMode: "HTML" } },
      });

      expect(result).toEqual({
        ok: true,
        channel: "telegram",
        deliveredTo: "12345",
        count: 1,
      });
      expect(workflowMocks.sendMessage).toHaveBeenCalledTimes(1);
      const sendParams = requireFirstSendMessageParams();
      expect(sendParams.to).toBe("12345");
      expect(sendParams.channel).toBe("telegram");
      expect(sendParams.accountId).toBe("default");
      expect(sendParams.threadId).toBe(42);
      expect(sendParams.mediaUrls).toEqual([filePath]);
      expect(sendParams.bestEffort).toBe(false);
      expect(sendParams.silent).toBe(true);
      expect(sendParams.parseMode).toBe("HTML");
    });
  });

  it("does not use best-effort mode for attachment batches", async () => {
    await withSessionStore(async ({ storePath, stateDir }) => {
      const first = path.join(stateDir, "first.txt");
      const second = path.join(stateDir, "second.txt");
      await fs.writeFile(first, "1", "utf8");
      await fs.writeFile(second, "2", "utf8");
      await writeSessionEntry(storePath);
      mockSuccessfulAttachmentDelivery();

      const result = await sendBundledSessionAttachment({
        files: [{ path: first }, { path: second }],
      });
      expectTelegramAttachmentResult(result, 2);
      const sendParams = requireFirstSendMessageParams();
      expect(sendParams.mediaUrls).toEqual([first, second]);
      expect(sendParams.bestEffort).toBe(false);
    });
  });

  it("escapes plain Telegram attachment captions before HTML delivery", async () => {
    await withSessionStore(async ({ storePath, filePath }) => {
      await writeSessionEntry(storePath);
      mockSuccessfulAttachmentDelivery();

      const result = await sendBundledSessionAttachment({
        files: [{ path: filePath }],
        text: "1 < 2 & 3 > 2",
        captionFormat: "plain",
        channelHints: { telegram: { parseMode: "HTML" } },
      });
      expectTelegramAttachmentResult(result, 1);
      const sendParams = requireFirstSendMessageParams();
      expect(sendParams.content).toBe("1 &lt; 2 &amp; 3 &gt; 2");
      expect(sendParams.parseMode).toBe("HTML");
    });
  });

  it("resolves relative attachment paths against the session agent workspace", async () => {
    await withSessionStore(async ({ storePath, stateDir }) => {
      const workspaceDir = path.join(stateDir, "workspace");
      const relativeFilePath = "./report.txt";
      const absoluteFilePath = path.join(workspaceDir, "report.txt");
      await fs.mkdir(workspaceDir, { recursive: true });
      await fs.writeFile(absoluteFilePath, "workspace report", "utf8");
      await writeSessionEntry(storePath);
      mockSuccessfulAttachmentDelivery();

      const result = await sendBundledSessionAttachment({
        files: [{ path: relativeFilePath }],
        config: {
          session: { store: storePath },
          agents: {
            list: [{ id: "main", workspace: workspaceDir }],
          },
        },
      });
      expectTelegramAttachmentResult(result, 1);
      expect(requireFirstSendMessageParams().mediaUrls).toEqual([absoluteFilePath]);
    });
  });

  it("prefers the thread encoded in a threaded session key over stale stored routes", async () => {
    await withSessionStore(async ({ storePath, filePath }) => {
      const baseKey = "agent:main:telegram:group:12345";
      const threadKey = `${baseKey}:thread:99`;
      await writeSessionEntry(
        storePath,
        {
          deliveryContext: {
            channel: "telegram",
            to: "group:12345",
            threadId: 42,
          },
        },
        threadKey,
      );
      mockSuccessfulAttachmentDelivery();

      const result = await sendBundledSessionAttachment({
        sessionKey: threadKey,
        files: [{ path: filePath }],
      });
      expectTelegramAttachmentResult(result, 1);
      expect(requireFirstSendMessageParams().threadId).toBe("99");
    });
  });

  it("reports attachment delivery as failed when no delivery result is returned", async () => {
    await withSessionStore(async ({ storePath, filePath }) => {
      await writeSessionEntry(storePath);
      workflowMocks.sendMessage.mockResolvedValue({
        channel: "telegram",
        to: "12345",
        via: "direct",
        mediaUrl: null,
      });

      await expect(
        sendBundledSessionAttachment({
          files: [{ path: filePath }],
        }),
      ).resolves.toEqual({
        ok: false,
        error: "attachment delivery failed: no delivery result returned",
      });
    });
  });

  it("rejects external plugins and sessions without delivery routes", async () => {
    await withSessionStore(async ({ storePath, filePath }) => {
      await writeSessionEntry(storePath, {});

      await expect(
        sendPluginSessionAttachment({
          origin: "workspace",
          sessionKey: MAIN_SESSION_KEY,
          files: [{ path: filePath }],
        }),
      ).resolves.toEqual({
        ok: false,
        error: "session attachments are restricted to bundled plugins",
      });
      await expect(
        sendBundledSessionAttachment({
          files: [{ path: filePath }],
        }),
      ).resolves.toEqual({
        ok: false,
        error: "session has no active delivery route: agent:main:main",
      });
      expect(workflowMocks.sendMessage).not.toHaveBeenCalled();
    });
  });

  it("rejects malformed or oversized attachment inputs before delivery", async () => {
    await withSessionStore(async ({ storePath, stateDir, filePath }) => {
      await writeSessionEntry(storePath);

      await expect(
        sendBundledSessionAttachment({
          files: Array.from({ length: 11 }, () => ({ path: path.join(stateDir, "missing.txt") })),
        }),
      ).resolves.toEqual({
        ok: false,
        error: "at most 10 attachment files are allowed",
      });

      await expect(
        sendBundledSessionAttachment({
          files: [null as never],
        }),
      ).resolves.toEqual({
        ok: false,
        error: "attachment file entry must be an object",
      });

      const first = path.join(stateDir, "first.txt");
      const second = path.join(stateDir, "second.txt");
      await fs.writeFile(first, "123", "utf8");
      await fs.writeFile(second, "456", "utf8");
      await expect(
        sendBundledSessionAttachment({
          files: [{ path: first }, { path: second }],
          maxBytes: 5,
        }),
      ).resolves.toEqual({
        ok: false,
        error: "attachment files exceed 5 bytes total",
      });
      const symlinkPath = path.join(stateDir, "linked.txt");
      await fs.symlink(first, symlinkPath);
      await expect(
        sendBundledSessionAttachment({
          files: [{ path: symlinkPath }],
        }),
      ).resolves.toEqual({
        ok: false,
        error: `attachment file symlinks are not allowed: ${symlinkPath}`,
      });
      await expect(
        sendBundledSessionAttachment({
          files: [{ path: filePath }],
          channelHints: { telegram: { forceDocumentMime: "application/pdf" } },
        }),
      ).resolves.toEqual({
        ok: false,
        error: `attachment file MIME mismatch for ${filePath}: expected application/pdf, got unknown`,
      });
      const fakePdfPath = path.join(stateDir, "fake.pdf");
      await fs.writeFile(fakePdfPath, "not a pdf", "utf8");
      await expect(
        sendBundledSessionAttachment({
          files: [{ path: fakePdfPath }],
          channelHints: { telegram: { forceDocumentMime: "application/pdf" } },
        }),
      ).resolves.toEqual({
        ok: false,
        error: `attachment file MIME mismatch for ${fakePdfPath}: expected application/pdf, got unknown`,
      });
      expect(workflowMocks.sendMessage).not.toHaveBeenCalled();
    });
  });

  it("returns validation errors for unreadable attachment MIME probes", async () => {
    await withSessionStore(async ({ storePath, stateDir }) => {
      const unreadablePath = path.join(stateDir, "unreadable.pdf");
      await fs.writeFile(unreadablePath, "%PDF-1.7\n", "utf8");
      await fs.chmod(unreadablePath, 0o000);
      await writeSessionEntry(storePath);

      try {
        const result = await sendBundledSessionAttachment({
          files: [{ path: unreadablePath }],
          channelHints: { telegram: { forceDocumentMime: "application/pdf" } },
        });

        expect(result.ok).toBe(false);
        if (result.ok) {
          throw new Error("expected unreadable attachment MIME probe to fail");
        }
        expect(result.error).toContain(`attachment file MIME read failed for ${unreadablePath}`);
      } finally {
        await fs.chmod(unreadablePath, 0o600).catch(() => undefined);
      }
      expect(workflowMocks.sendMessage).not.toHaveBeenCalled();
    });
  });

  it("validates force-document MIME using only the configured sniff window", async () => {
    await withSessionStore(async ({ storePath, stateDir }) => {
      const pdfPath = path.join(stateDir, "large.pdf");
      await fs.writeFile(
        pdfPath,
        Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.alloc(FILE_TYPE_SNIFF_MAX_BYTES + 32)]),
      );
      await writeSessionEntry(storePath);
      mockSuccessfulAttachmentDelivery();

      const result = await sendBundledSessionAttachment({
        files: [{ path: pdfPath }],
        forceDocument: false,
        channelHints: { telegram: { forceDocumentMime: "application/pdf" } },
      });
      expectTelegramAttachmentResult(result, 1);
      const sendParams = requireFirstSendMessageParams();
      expect(sendParams.mediaUrls).toEqual([pdfPath]);
      expect(sendParams.forceDocument).toBe(true);
    });
  });

  it("rejects gateway-mode channels before attempting host-local attachment delivery", async () => {
    await withSessionStore(async ({ storePath, filePath }) => {
      await writeSessionEntry(storePath);
      workflowMocks.getChannelPlugin.mockReturnValue(
        createOutboundTestPlugin({
          id: "telegram",
          outbound: { deliveryMode: "gateway" },
        }),
      );
      setActivePluginRegistry(
        createTestRegistry([
          {
            pluginId: "telegram",
            source: "test",
            plugin: createOutboundTestPlugin({
              id: "telegram",
              outbound: { deliveryMode: "gateway" },
            }),
          },
        ]),
      );

      await expect(
        sendBundledSessionAttachment({
          files: [{ path: filePath }],
        }),
      ).resolves.toEqual({
        ok: false,
        error:
          "session attachments require direct outbound delivery for channel telegram; " +
          "channel uses gateway delivery",
      });
      expect(workflowMocks.sendMessage).not.toHaveBeenCalled();
    });
  });

  it("rejects unloaded bundled gateway-mode channels before attachment delivery", async () => {
    await withSessionStore(async ({ storePath, filePath }) => {
      await writeSessionEntry(storePath, {
        deliveryContext: {
          channel: "whatsapp",
          to: "+15551234567",
        },
      });
      setActivePluginRegistry(createEmptyPluginRegistry());
      workflowMocks.getChannelPlugin.mockReturnValue(
        createOutboundTestPlugin({
          id: "whatsapp",
          outbound: { deliveryMode: "gateway" },
        }),
      );

      await expect(
        sendBundledSessionAttachment({
          files: [{ path: filePath }],
        }),
      ).resolves.toEqual({
        ok: false,
        error:
          "session attachments require direct outbound delivery for channel whatsapp; " +
          "channel uses gateway delivery",
      });
      expect(workflowMocks.sendMessage).not.toHaveBeenCalled();
    });
  });

  it("returns structured errors when channel delivery lookup fails", async () => {
    await withSessionStore(async ({ storePath, filePath }) => {
      await writeSessionEntry(storePath);
      workflowMocks.getChannelPlugin.mockImplementation(() => {
        throw new Error("channel registry unavailable");
      });

      await expect(
        sendBundledSessionAttachment({
          files: [{ path: filePath }],
        }),
      ).resolves.toEqual({
        ok: false,
        error: "attachment delivery setup failed: channel registry unavailable",
      });
      expect(workflowMocks.sendMessage).not.toHaveBeenCalled();
    });
  });

  it("wires sendSessionAttachment through the plugin API with stale-registry protection", async () => {
    await withSessionStore(async ({ storePath, filePath }) => {
      await writeSessionEntry(storePath);
      mockSuccessfulAttachmentDelivery();

      const { config, registry } = createPluginRegistryFixture({ session: { store: storePath } });
      let capturedApi: OpenClawPluginApi | undefined;
      registerTestPlugin({
        registry,
        config,
        record: createPluginRecord({
          id: "attachment-plugin",
          name: "Attachment Plugin",
          origin: "bundled",
        }),
        register(api) {
          capturedApi = api;
        },
      });
      setActivePluginRegistry(registry.registry);

      const firstResult = await capturedApi?.sendSessionAttachment({
        sessionKey: MAIN_SESSION_KEY,
        files: [{ path: filePath }],
      });
      expectTelegramAttachmentResult(firstResult, 1);

      setActivePluginRegistry(createEmptyPluginRegistry());
      await expect(
        capturedApi?.sendSessionAttachment({
          sessionKey: MAIN_SESSION_KEY,
          files: [{ path: filePath }],
        }),
      ).resolves.toEqual({ ok: false, error: "plugin is not loaded" });
    });
  });

  it("uses the live runtime config when a captured API sends an attachment", async () => {
    await withSessionStore(async ({ stateDir, storePath, filePath }) => {
      await writeSessionEntry(storePath);
      mockSuccessfulAttachmentDelivery();

      const staleStorePath = path.join(stateDir, "stale-sessions.json");
      const registrationConfig = { session: { store: staleStorePath } };
      const liveConfig = { session: { store: storePath } };
      const registry = createPluginRegistry({
        logger: createSilentPluginLogger(),
        runtime: {
          config: {
            current: () => liveConfig,
          },
        } as unknown as PluginRuntime,
      });
      let capturedApi: OpenClawPluginApi | undefined;
      registerTestPlugin({
        registry,
        config: registrationConfig,
        record: createPluginRecord({
          id: "live-config-attachment-plugin",
          name: "Live Config Attachment Plugin",
          origin: "bundled",
        }),
        register(api) {
          capturedApi = api;
        },
      });
      setActivePluginRegistry(registry.registry);

      const result = await capturedApi?.sendSessionAttachment({
        sessionKey: MAIN_SESSION_KEY,
        files: [{ path: filePath }],
      });
      expectTelegramAttachmentResult(result, 1);
      expect(workflowMocks.sendMessage).toHaveBeenCalledTimes(1);
      expect(requireFirstSendMessageParams().cfg).toBe(liveConfig);
    });
  });

  it("returns structured errors when the captured API cannot read the live runtime config", async () => {
    await withSessionStore(async ({ stateDir, storePath, filePath }) => {
      await writeSessionEntry(storePath);

      const registrationConfig = { session: { store: path.join(stateDir, "stale-sessions.json") } };
      const registry = createPluginRegistry({
        logger: createSilentPluginLogger(),
        runtime: {
          config: {
            current: () => {
              throw new Error("config runtime unavailable");
            },
          },
        } as unknown as PluginRuntime,
      });
      let capturedApi: OpenClawPluginApi | undefined;
      registerTestPlugin({
        registry,
        config: registrationConfig,
        record: createPluginRecord({
          id: "attachment-runtime-error-plugin",
          name: "Attachment Runtime Error Plugin",
          origin: "bundled",
        }),
        register(api) {
          capturedApi = api;
        },
      });
      setActivePluginRegistry(registry.registry);

      await expect(
        capturedApi?.sendSessionAttachment({
          sessionKey: MAIN_SESSION_KEY,
          files: [{ path: filePath }],
        }),
      ).resolves.toEqual({
        ok: false,
        error: "attachment delivery setup failed: config runtime unavailable",
      });
      expect(workflowMocks.sendMessage).not.toHaveBeenCalled();
    });
  });
});
