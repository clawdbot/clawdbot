import { verifyChannelMessageAdapterCapabilityProofs } from "openclaw/plugin-sdk/channel-message";
import {
  createDirectoryTestRuntime,
  expectDirectorySurface,
} from "openclaw/plugin-sdk/channel-test-helpers";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../runtime-api.js";
import {
  googlechatDirectoryAdapter,
  googlechatMessageAdapter,
  googlechatOutboundAdapter,
  googlechatPairingTextAdapter,
  googlechatSecurityAdapter,
  googlechatThreadingAdapter,
} from "./channel.adapters.js";

const uploadGoogleChatAttachmentMock = vi.hoisted(() => vi.fn());
const sendGoogleChatMessageMock = vi.hoisted(() => vi.fn());
const resolveGoogleChatAccountMock = vi.hoisted(() => vi.fn());
const resolveGoogleChatOutboundSpaceMock = vi.hoisted(() => vi.fn());
const fetchRemoteMediaMock = vi.hoisted(() => vi.fn());
const loadOutboundMediaFromUrlMock = vi.hoisted(() => vi.fn());
const probeGoogleChatMock = vi.hoisted(() => vi.fn());
const startGoogleChatMonitorMock = vi.hoisted(() => vi.fn());

const DEFAULT_ACCOUNT_ID = "default";

function normalizeGoogleChatTarget(raw?: string | null): string | undefined {
  const trimmed = raw?.trim();
  if (!trimmed) {
    return undefined;
  }
  const withoutPrefix = trimmed.replace(/^(googlechat|google-chat|gchat):/i, "");
  const normalized = withoutPrefix
    .replace(/^user:(users\/)?/i, "users/")
    .replace(/^space:(spaces\/)?/i, "spaces/");
  if (normalized.toLowerCase().startsWith("users/")) {
    const suffix = normalized.slice("users/".length);
    return suffix.includes("@") ? `users/${suffix.toLowerCase()}` : normalized;
  }
  if (normalized.toLowerCase().startsWith("spaces/")) {
    return normalized;
  }
  if (normalized.includes("@")) {
    return `users/${normalized.toLowerCase()}`;
  }
  return normalized;
}

function resolveGoogleChatAccountImpl(params: { cfg: OpenClawConfig; accountId?: string | null }) {
  const accountId = params.accountId?.trim() || DEFAULT_ACCOUNT_ID;
  const channelConfig = (params.cfg.channels?.googlechat ?? {}) as Record<string, unknown>;
  const accounts =
    (channelConfig.accounts as Record<string, Record<string, unknown>> | undefined) ?? {};
  const scoped = accountId === DEFAULT_ACCOUNT_ID ? {} : (accounts[accountId] ?? {});
  const config = { ...channelConfig, ...scoped } as Record<string, unknown>;
  const serviceAccount = config.serviceAccount;
  return {
    accountId,
    name: typeof config.name === "string" ? config.name : undefined,
    enabled: channelConfig.enabled !== false && scoped.enabled !== false,
    config,
    credentialSource: serviceAccount ? ("inline" as const) : ("none" as const),
  };
}

function mockGoogleChatOutboundSpaceResolution() {
  resolveGoogleChatOutboundSpaceMock.mockImplementation(async ({ target }: { target: string }) => {
    const normalized = normalizeGoogleChatTarget(target);
    if (!normalized) {
      throw new Error("Missing Google Chat target.");
    }
    return normalized.toLowerCase().startsWith("users/")
      ? `spaces/DM-${normalized.slice("users/".length)}`
      : normalized.replace(/\/messages\/.+$/, "");
  });
}

function mockGoogleChatMediaLoaders() {
  loadOutboundMediaFromUrlMock.mockImplementation(async (mediaUrl: string) => ({
    buffer: Buffer.from("default-bytes"),
    fileName: mediaUrl.split("/").pop() || "attachment",
    contentType: "application/octet-stream",
  }));
  fetchRemoteMediaMock.mockImplementation(async () => ({
    buffer: Buffer.from("remote-bytes"),
    fileName: "remote.png",
    contentType: "image/png",
  }));
}

vi.mock("./channel.runtime.js", () => {
  return {
    googleChatChannelRuntime: {
      probeGoogleChat: (...args: unknown[]) => probeGoogleChatMock(...args),
      resolveGoogleChatWebhookPath: () => "/googlechat/webhook",
      sendGoogleChatMessage: (...args: unknown[]) => sendGoogleChatMessageMock(...args),
      startGoogleChatMonitor: (...args: unknown[]) => startGoogleChatMonitorMock(...args),
      uploadGoogleChatAttachment: (...args: unknown[]) => uploadGoogleChatAttachmentMock(...args),
    },
  };
});

vi.mock("./channel.deps.runtime.js", () => {
  return {
    DEFAULT_ACCOUNT_ID: "default",
    GoogleChatConfigSchema: {},
    buildChannelConfigSchema: () => ({}),
    chunkTextForOutbound: (text: string, maxChars: number) => {
      const chunks: string[] = [];
      let current = "";
      for (const word of text.split(/\s+/)) {
        if (!word) {
          continue;
        }
        const next = current ? `${current} ${word}` : word;
        if (current && next.length > maxChars) {
          chunks.push(current);
          current = word;
          continue;
        }
        current = next;
      }
      if (current) {
        chunks.push(current);
      }
      return chunks;
    },
    createAccountStatusSink: () => () => {},
    fetchRemoteMedia: (...args: unknown[]) => fetchRemoteMediaMock(...args),
    getChatChannelMeta: (id: string) => ({ id, name: id }),
    isGoogleChatSpaceTarget: (value: string) => value.toLowerCase().startsWith("spaces/"),
    isGoogleChatUserTarget: (value: string) => value.toLowerCase().startsWith("users/"),
    listGoogleChatAccountIds: (cfg: OpenClawConfig) => {
      const ids = Object.keys(cfg.channels?.googlechat?.accounts ?? {});
      return ids.length > 0 ? ids : ["default"];
    },
    loadOutboundMediaFromUrl: (...args: unknown[]) => loadOutboundMediaFromUrlMock(...args),
    missingTargetError: (channel: string, hint: string) =>
      new Error(`${channel} target is required (${hint})`),
    normalizeGoogleChatTarget,
    PAIRING_APPROVED_MESSAGE: "approved",
    resolveChannelMediaMaxBytes: (params: {
      cfg: OpenClawConfig;
      resolveChannelLimitMb: (args: {
        cfg: OpenClawConfig;
        accountId?: string;
      }) => number | undefined;
      accountId?: string;
    }) => {
      const limitMb = params.resolveChannelLimitMb({
        cfg: params.cfg,
        accountId: params.accountId,
      });
      return typeof limitMb === "number" ? limitMb * 1024 * 1024 : undefined;
    },
    resolveDefaultGoogleChatAccountId: () => "default",
    resolveGoogleChatAccount: (...args: Parameters<typeof resolveGoogleChatAccountImpl>) =>
      resolveGoogleChatAccountMock(...args),
    resolveGoogleChatOutboundSpace: (...args: unknown[]) =>
      resolveGoogleChatOutboundSpaceMock(...args),
    runPassiveAccountLifecycle: async (params: { start: () => Promise<unknown> }) =>
      await params.start(),
  };
});

resolveGoogleChatAccountMock.mockImplementation(resolveGoogleChatAccountImpl);
mockGoogleChatOutboundSpaceResolution();
mockGoogleChatMediaLoaders();

afterEach(() => {
  vi.clearAllMocks();
  resolveGoogleChatAccountMock.mockImplementation(resolveGoogleChatAccountImpl);
  mockGoogleChatOutboundSpaceResolution();
  mockGoogleChatMediaLoaders();
});

afterAll(() => {
  vi.doUnmock("./channel.runtime.js");
  vi.doUnmock("./channel.deps.runtime.js");
  vi.resetModules();
});

function createGoogleChatCfg(): OpenClawConfig {
  return {
    channels: {
      googlechat: {
        enabled: true,
        serviceAccount: {
          type: "service_account",
          client_email: "bot@example.com",
          private_key: "test-key", // pragma: allowlist secret
          token_uri: "https://oauth2.googleapis.com/token",
        },
      },
    },
  };
}

function setupRuntimeMediaMocks(params: { loadFileName: string; loadBytes: string }) {
  const loadOutboundMediaFromUrl = vi.fn(async () => ({
    buffer: Buffer.from(params.loadBytes),
    fileName: params.loadFileName,
    contentType: "image/png",
  }));
  const fetchRemoteMedia = vi.fn(async () => ({
    buffer: Buffer.from("remote-bytes"),
    fileName: "remote.png",
    contentType: "image/png",
  }));

  loadOutboundMediaFromUrlMock.mockImplementation(loadOutboundMediaFromUrl);
  fetchRemoteMediaMock.mockImplementation(fetchRemoteMedia);

  return { loadOutboundMediaFromUrl, fetchRemoteMedia };
}

describe("googlechatPlugin outbound sendMedia", () => {
  it("declares message adapter durable text, media, and thread with receipt proofs", async () => {
    sendGoogleChatMessageMock.mockResolvedValue({
      messageName: "spaces/AAA/messages/msg-1",
    });
    uploadGoogleChatAttachmentMock.mockResolvedValue({
      attachmentUploadToken: "token-1",
    });

    const cfg = createGoogleChatCfg();

    await expect(
      verifyChannelMessageAdapterCapabilityProofs({
        adapterName: "googlechat",
        adapter: googlechatMessageAdapter,
        proofs: {
          text: async () => {
            const result = await googlechatMessageAdapter.send?.text?.({
              cfg,
              to: "spaces/AAA",
              text: "hello",
            });
            expect(result?.receipt.parts[0]?.kind).toBe("text");
            expect(result?.receipt.platformMessageIds).toEqual(["spaces/AAA/messages/msg-1"]);
          },
          media: async () => {
            const result = await googlechatMessageAdapter.send?.media?.({
              cfg,
              to: "spaces/AAA",
              text: "image",
              mediaUrl: "https://example.com/img.png",
            });
            expect(result?.receipt.parts[0]?.kind).toBe("media");
            expect(result?.receipt.platformMessageIds).toEqual(["spaces/AAA/messages/msg-1"]);
          },
          thread: async () => {
            sendGoogleChatMessageMock.mockClear();
            await googlechatMessageAdapter.send?.text?.({
              cfg,
              to: "spaces/AAA",
              text: "threaded",
              threadId: "thread-1",
            });
            expect(sendGoogleChatMessageMock).toHaveBeenCalledWith(
              expect.objectContaining({
                space: "spaces/AAA",
                thread: "thread-1",
              }),
            );
          },
          messageSendingHooks: () => {
            expect(googlechatMessageAdapter.send?.text).toBeTypeOf("function");
          },
        },
      }),
    ).resolves.toEqual(
      expect.arrayContaining([
        { capability: "text", status: "verified" },
        { capability: "media", status: "verified" },
        { capability: "thread", status: "verified" },
        { capability: "messageSendingHooks", status: "verified" },
      ]),
    );
  });

  it("chunks outbound text without requiring Google Chat runtime initialization", () => {
    const chunker = googlechatOutboundAdapter.base.chunker;

    expect(chunker("alpha beta", 5)).toEqual(["alpha", "beta"]);
  });

  it("loads local media with mediaLocalRoots via runtime media loader", async () => {
    const { loadOutboundMediaFromUrl, fetchRemoteMedia } = setupRuntimeMediaMocks({
      loadFileName: "image.png",
      loadBytes: "image-bytes",
    });

    uploadGoogleChatAttachmentMock.mockResolvedValue({
      attachmentUploadToken: "token-1",
    });
    sendGoogleChatMessageMock.mockResolvedValue({
      messageName: "spaces/AAA/messages/msg-1",
    });

    const cfg = createGoogleChatCfg();

    const result = await googlechatOutboundAdapter.attachedResults.sendMedia({
      cfg,
      to: "spaces/AAA",
      text: "caption",
      mediaUrl: "/tmp/workspace/image.png",
      mediaLocalRoots: ["/tmp/workspace"],
      accountId: "default",
    });

    expect(loadOutboundMediaFromUrl).toHaveBeenCalledWith(
      "/tmp/workspace/image.png",
      expect.objectContaining({
        mediaLocalRoots: ["/tmp/workspace"],
      }),
    );
    expect(fetchRemoteMedia).not.toHaveBeenCalled();
    expect(uploadGoogleChatAttachmentMock).toHaveBeenCalledWith(
      expect.objectContaining({
        space: "spaces/AAA",
        filename: "image.png",
        contentType: "image/png",
      }),
    );
    expect(sendGoogleChatMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        space: "spaces/AAA",
        text: "caption",
      }),
    );
    expect(result).toMatchObject({
      messageId: "spaces/AAA/messages/msg-1",
      chatId: "spaces/AAA",
    });
    expect(result.receipt.primaryPlatformMessageId).toBe("spaces/AAA/messages/msg-1");
  });

  it("keeps remote URL media fetch on fetchRemoteMedia with maxBytes cap", async () => {
    const { loadOutboundMediaFromUrl, fetchRemoteMedia } = setupRuntimeMediaMocks({
      loadFileName: "unused.png",
      loadBytes: "should-not-be-used",
    });

    uploadGoogleChatAttachmentMock.mockResolvedValue({
      attachmentUploadToken: "token-2",
    });
    sendGoogleChatMessageMock.mockResolvedValue({
      messageName: "spaces/AAA/messages/msg-2",
    });

    const cfg = createGoogleChatCfg();

    const result = await googlechatOutboundAdapter.attachedResults.sendMedia({
      cfg,
      to: "spaces/AAA",
      text: "caption",
      mediaUrl: "https://example.com/image.png",
      accountId: "default",
    });

    expect(fetchRemoteMedia).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://example.com/image.png",
        maxBytes: 20 * 1024 * 1024,
      }),
    );
    expect(loadOutboundMediaFromUrl).not.toHaveBeenCalled();
    expect(uploadGoogleChatAttachmentMock).toHaveBeenCalledWith(
      expect.objectContaining({
        space: "spaces/AAA",
        filename: "remote.png",
        contentType: "image/png",
      }),
    );
    expect(sendGoogleChatMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        space: "spaces/AAA",
        text: "caption",
      }),
    );
    expect(result).toMatchObject({
      messageId: "spaces/AAA/messages/msg-2",
      chatId: "spaces/AAA",
    });
    expect(result.receipt.primaryPlatformMessageId).toBe("spaces/AAA/messages/msg-2");
  });
});

describe("googlechatPlugin threading", () => {
  it("honors per-account replyToMode overrides", () => {
    const cfg = {
      channels: {
        googlechat: {
          replyToMode: "all",
          accounts: {
            work: {
              replyToMode: "first",
            },
          },
        },
      },
    } as OpenClawConfig;

    const workAccount = googlechatThreadingAdapter.scopedAccountReplyToMode.resolveAccount(
      cfg,
      "work",
    );
    const defaultAccount = googlechatThreadingAdapter.scopedAccountReplyToMode.resolveAccount(
      cfg,
      "default",
    );

    expect(
      googlechatThreadingAdapter.scopedAccountReplyToMode.resolveReplyToMode(workAccount),
    ).toBe("first");
    expect(
      googlechatThreadingAdapter.scopedAccountReplyToMode.resolveReplyToMode(defaultAccount),
    ).toBe("all");
  });
});

const resolveTarget = googlechatOutboundAdapter.base.resolveTarget;

describe("googlechatPlugin outbound resolveTarget", () => {
  it("resolves valid chat targets", () => {
    const result = resolveTarget({
      to: "spaces/AAA",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw result.error;
    }
    expect(result.to).toBe("spaces/AAA");
  });

  it("resolves email targets", () => {
    const result = resolveTarget({
      to: "user@example.com",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw result.error;
    }
    expect(result.to).toBe("users/user@example.com");
  });

  it("errors on invalid targets", () => {
    const result = resolveTarget({
      to: "   ",
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("Expected invalid target to fail");
    }
    expect(result.error.message).toBe(
      "Google Chat target is required (<spaces/{space}|users/{user}>)",
    );
  });

  it("errors when no target is provided", () => {
    const result = resolveTarget({
      to: undefined,
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("Expected missing target to fail");
    }
    expect(result.error.message).toBe(
      "Google Chat target is required (<spaces/{space}|users/{user}>)",
    );
  });
});

describe("googlechatPlugin outbound cfg threading", () => {
  it("preserves accountId when sending pairing approvals", async () => {
    const cfg = {
      channels: {
        googlechat: {
          enabled: true,
          accounts: {
            work: {
              serviceAccount: {
                type: "service_account",
              },
            },
          },
        },
      },
    };
    const account = {
      accountId: "work",
      config: {},
      credentialSource: "inline" as const,
    };
    resolveGoogleChatAccountMock.mockReturnValue(account);
    resolveGoogleChatOutboundSpaceMock.mockResolvedValue("spaces/WORK");
    sendGoogleChatMessageMock.mockResolvedValue({
      messageName: "spaces/WORK/messages/msg-1",
    });

    await googlechatPairingTextAdapter.notify({
      cfg: cfg as never,
      id: "user@example.com",
      message: googlechatPairingTextAdapter.message,
      accountId: "work",
    } as never);

    expect(resolveGoogleChatAccountMock).toHaveBeenCalledWith({
      cfg,
      accountId: "work",
    });
    expect(sendGoogleChatMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        account,
        space: "spaces/WORK",
        text: expect.any(String),
      }),
    );
  });

  it("threads resolved cfg into sendText account resolution", async () => {
    const cfg = {
      channels: {
        googlechat: {
          serviceAccount: {
            type: "service_account",
          },
        },
      },
    };
    const account = {
      accountId: "default",
      config: {},
      credentialSource: "inline" as const,
    };
    resolveGoogleChatAccountMock.mockReturnValue(account);
    resolveGoogleChatOutboundSpaceMock.mockResolvedValue("spaces/AAA");
    sendGoogleChatMessageMock.mockResolvedValue({
      messageName: "spaces/AAA/messages/msg-1",
    });

    await googlechatOutboundAdapter.attachedResults.sendText({
      cfg: cfg as never,
      to: "users/123",
      text: "hello",
      accountId: "default",
    });

    expect(resolveGoogleChatAccountMock).toHaveBeenCalledWith({
      cfg,
      accountId: "default",
    });
    expect(sendGoogleChatMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        account,
        space: "spaces/AAA",
        text: "hello",
      }),
    );
  });

  it("threads resolved cfg into sendMedia account and media loading path", async () => {
    const cfg = {
      channels: {
        googlechat: {
          serviceAccount: {
            type: "service_account",
          },
          mediaMaxMb: 8,
        },
      },
    };
    const account = {
      accountId: "default",
      config: { mediaMaxMb: 20 },
      credentialSource: "inline" as const,
    };
    const { fetchRemoteMedia } = setupRuntimeMediaMocks({
      loadFileName: "unused.png",
      loadBytes: "should-not-be-used",
    });

    resolveGoogleChatAccountMock.mockReturnValue(account);
    resolveGoogleChatOutboundSpaceMock.mockResolvedValue("spaces/AAA");
    uploadGoogleChatAttachmentMock.mockResolvedValue({
      attachmentUploadToken: "token-1",
    });
    sendGoogleChatMessageMock.mockResolvedValue({
      messageName: "spaces/AAA/messages/msg-2",
    });

    await googlechatOutboundAdapter.attachedResults.sendMedia({
      cfg: cfg as never,
      to: "users/123",
      text: "photo",
      mediaUrl: "https://example.com/file.png",
      accountId: "default",
    });

    expect(resolveGoogleChatAccountMock).toHaveBeenCalledWith({
      cfg,
      accountId: "default",
    });
    expect(fetchRemoteMedia).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://example.com/file.png",
        maxBytes: 8 * 1024 * 1024,
      }),
    );
    expect(uploadGoogleChatAttachmentMock).toHaveBeenCalledWith(
      expect.objectContaining({
        account,
        space: "spaces/AAA",
        filename: "remote.png",
      }),
    );
    expect(sendGoogleChatMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        account,
        attachments: [{ attachmentUploadToken: "token-1", contentName: "remote.png" }],
      }),
    );
  });

  it("sends media without requiring Google Chat runtime initialization", async () => {
    const { loadOutboundMediaFromUrl } = setupRuntimeMediaMocks({
      loadFileName: "image.png",
      loadBytes: "image-bytes",
    });

    uploadGoogleChatAttachmentMock.mockResolvedValue({
      attachmentUploadToken: "token-cold",
    });
    sendGoogleChatMessageMock.mockResolvedValue({
      messageName: "spaces/AAA/messages/msg-cold",
    });

    const cfg = createGoogleChatCfg();

    await expect(
      googlechatOutboundAdapter.attachedResults.sendMedia({
        cfg,
        to: "spaces/AAA",
        text: "caption",
        mediaUrl: "/tmp/workspace/image.png",
        mediaLocalRoots: ["/tmp/workspace"],
        accountId: "default",
      }),
    ).resolves.toMatchObject({
      messageId: "spaces/AAA/messages/msg-cold",
      chatId: "spaces/AAA",
    });

    expect(loadOutboundMediaFromUrl).toHaveBeenCalledWith(
      "/tmp/workspace/image.png",
      expect.objectContaining({
        mediaLocalRoots: ["/tmp/workspace"],
      }),
    );
  });
});

describe("googlechat directory", () => {
  const runtimeEnv = createDirectoryTestRuntime() as never;

  it("lists peers and groups from config", async () => {
    const cfg = {
      channels: {
        googlechat: {
          serviceAccount: { client_email: "bot@example.com" },
          dm: { allowFrom: ["users/alice", "googlechat:bob"] },
          groups: {
            "spaces/AAA": {},
            "spaces/BBB": {},
          },
        },
      },
    } as unknown as OpenClawConfig;

    const directory = expectDirectorySurface(googlechatDirectoryAdapter);

    await expect(
      directory.listPeers({
        cfg,
        accountId: undefined,
        query: undefined,
        limit: undefined,
        runtime: runtimeEnv,
      }),
    ).resolves.toEqual(
      expect.arrayContaining([
        { kind: "user", id: "users/alice" },
        { kind: "user", id: "bob" },
      ]),
    );

    await expect(
      directory.listGroups({
        cfg,
        accountId: undefined,
        query: undefined,
        limit: undefined,
        runtime: runtimeEnv,
      }),
    ).resolves.toEqual(
      expect.arrayContaining([
        { kind: "group", id: "spaces/AAA" },
        { kind: "group", id: "spaces/BBB" },
      ]),
    );
  });

  it("normalizes spaced provider-prefixed dm allowlist entries", async () => {
    const cfg = {
      channels: {
        googlechat: {
          serviceAccount: { client_email: "bot@example.com" },
          dm: { allowFrom: [" users/alice ", " googlechat:user:Bob@Example.com "] },
        },
      },
    } as unknown as OpenClawConfig;

    const directory = expectDirectorySurface(googlechatDirectoryAdapter);

    await expect(
      directory.listPeers({
        cfg,
        accountId: undefined,
        query: undefined,
        limit: undefined,
        runtime: runtimeEnv,
      }),
    ).resolves.toEqual(
      expect.arrayContaining([
        { kind: "user", id: "users/alice" },
        { kind: "user", id: "users/bob@example.com" },
      ]),
    );
  });
});

describe("googlechatPlugin security", () => {
  it("normalizes prefixed DM allowlist entries to lowercase user ids", () => {
    const cfg = {
      channels: {
        googlechat: {
          serviceAccount: { client_email: "bot@example.com" },
          dm: {
            policy: "allowlist",
            allowFrom: ["  googlechat:user:Bob@Example.com  "],
          },
        },
      },
    } as OpenClawConfig;

    const account = resolveGoogleChatAccountImpl({ cfg, accountId: "default" });

    expect(googlechatSecurityAdapter.dm.resolvePolicy(account)).toBe("allowlist");
    expect(googlechatSecurityAdapter.dm.resolveAllowFrom(account)).toEqual([
      "  googlechat:user:Bob@Example.com  ",
    ]);
    expect(googlechatSecurityAdapter.dm.normalizeEntry("  googlechat:user:Bob@Example.com  ")).toBe(
      "bob@example.com",
    );
    expect(googlechatPairingTextAdapter.normalizeAllowEntry("  users/Alice@Example.com  ")).toBe(
      "alice@example.com",
    );
  });
});
