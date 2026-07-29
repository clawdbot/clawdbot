// Googlechat tests cover channel plugin behavior.
import { verifyChannelMessageAdapterCapabilityProofs } from "openclaw/plugin-sdk/channel-outbound";
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

const sendGoogleChatMessageMock = vi.hoisted(() => vi.fn());
const resolveGoogleChatAccountMock = vi.hoisted(() => vi.fn());
const resolveGoogleChatOutboundSpaceMock = vi.hoisted(() => vi.fn());
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

vi.mock("./channel.runtime.js", () => {
  return {
    googleChatChannelRuntime: {
      probeGoogleChat: (...args: unknown[]) => probeGoogleChatMock(...args),
      resolveGoogleChatWebhookPath: () => "/googlechat/webhook",
      sendGoogleChatMessage: (...args: unknown[]) => sendGoogleChatMessageMock(...args),
      startGoogleChatMonitor: (...args: unknown[]) => startGoogleChatMonitorMock(...args),
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
    getChatChannelMeta: (id: string) => ({ id, name: id }),
    isGoogleChatSpaceTarget: (value: string) => value.toLowerCase().startsWith("spaces/"),
    isGoogleChatUserTarget: (value: string) => value.toLowerCase().startsWith("users/"),
    listGoogleChatAccountIds: (cfg: OpenClawConfig) => {
      const ids = Object.keys(cfg.channels?.googlechat?.accounts ?? {});
      return ids.length > 0 ? ids : ["default"];
    },
    missingTargetError: (channel: string, hint: string) =>
      new Error(`${channel} target is required (${hint})`),
    normalizeGoogleChatTarget,
    PAIRING_APPROVED_MESSAGE: "approved",
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

afterEach(() => {
  vi.clearAllMocks();
  resolveGoogleChatAccountMock.mockImplementation(resolveGoogleChatAccountImpl);
  mockGoogleChatOutboundSpaceResolution();
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

function requireMockArg(mock: ReturnType<typeof vi.fn>, callIndex = 0, argIndex = 0): unknown {
  const call = mock.mock.calls[callIndex];
  if (!call) {
    throw new Error(`expected mock call ${callIndex}`);
  }
  return call[argIndex];
}

describe("googlechatPlugin outbound", () => {
  it("declares durable text and thread delivery with receipt proofs", async () => {
    sendGoogleChatMessageMock.mockResolvedValue({
      messageName: "spaces/AAA/messages/msg-1",
    });

    const cfg = createGoogleChatCfg();

    const proofs = await verifyChannelMessageAdapterCapabilityProofs({
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
        thread: async () => {
          sendGoogleChatMessageMock.mockClear();
          await googlechatMessageAdapter.send?.text?.({
            cfg,
            to: "spaces/AAA",
            text: "threaded",
            threadId: "thread-1",
          });
          const request = requireMockArg(sendGoogleChatMessageMock) as {
            space?: string;
            thread?: string;
          };
          expect(request.space).toBe("spaces/AAA");
          expect(request.thread).toBe("thread-1");
        },
        messageSendingHooks: () => {
          expect(googlechatMessageAdapter.send?.text).toBeTypeOf("function");
        },
      },
    });
    expect(proofs).toStrictEqual([
      { capability: "text", status: "verified" },
      { capability: "media", status: "not_declared" },
      { capability: "poll", status: "not_declared" },
      { capability: "payload", status: "not_declared" },
      { capability: "silent", status: "not_declared" },
      { capability: "replyTo", status: "not_declared" },
      { capability: "thread", status: "verified" },
      { capability: "nativeQuote", status: "not_declared" },
      { capability: "messageSendingHooks", status: "verified" },
      { capability: "batch", status: "not_declared" },
      { capability: "reconcileUnknownSend", status: "not_declared" },
      { capability: "afterSendSuccess", status: "not_declared" },
      { capability: "afterCommit", status: "not_declared" },
    ]);
  });

  it("renders and chunks outbound text without requiring Google Chat runtime initialization", () => {
    const chunker = googlechatOutboundAdapter.base.chunker;

    expect(chunker("**alpha** [docs](https://example.com)", 32_000)).toEqual([
      "*alpha* <https://example.com|docs>",
    ]);
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

  it("uses the inbound thread resource as the current tool reply target", () => {
    const cfg = {
      channels: {
        googlechat: {
          replyToMode: "all",
        },
      },
    } as OpenClawConfig;
    const hasRepliedRef = { value: false };

    const context = googlechatThreadingAdapter.buildToolContext({
      cfg,
      accountId: "default",
      context: {
        To: "googlechat:spaces/AAA",
        CurrentMessageId: "spaces/AAA/messages/msg-1",
        ReplyToId: "spaces/AAA/threads/thread-1",
      },
      hasRepliedRef,
    });

    expect(context).toMatchObject({
      currentChannelId: "spaces/AAA",
      currentMessageId: "spaces/AAA/threads/thread-1",
      currentThreadTs: "spaces/AAA/threads/thread-1",
      replyToMode: "all",
      hasRepliedRef,
    });
  });

  it("does not use message resources as implicit Google Chat reply targets", () => {
    const cfg = {
      channels: {
        googlechat: {
          replyToMode: "all",
        },
      },
    } as OpenClawConfig;

    const context = googlechatThreadingAdapter.buildToolContext({
      cfg,
      accountId: "default",
      context: {
        To: "googlechat:spaces/AAA",
        CurrentMessageId: "spaces/AAA/messages/msg-1",
      },
    });

    expect(context).toMatchObject({
      currentChannelId: "spaces/AAA",
      replyToMode: "all",
    });
    expect(context.currentMessageId).toBeUndefined();
    expect(context.currentThreadTs).toBeUndefined();
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
    const request = requireMockArg(sendGoogleChatMessageMock) as {
      account?: unknown;
      space?: string;
      text?: string;
    };
    expect(request.account).toBe(account);
    expect(request.space).toBe("spaces/WORK");
    expect(request.text).toBe(googlechatPairingTextAdapter.message);
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
    const request = requireMockArg(sendGoogleChatMessageMock) as {
      account?: unknown;
      space?: string;
      text?: string;
    };
    expect(request.account).toBe(account);
    expect(request.space).toBe("spaces/AAA");
    expect(request.text).toBe("hello");
  });
});

describe("googlechat directory", () => {
  const runtimeEnv = createDirectoryTestRuntime() as never;

  it("lists peers and groups from config", async () => {
    const cfg = {
      channels: {
        googlechat: {
          serviceAccount: { client_email: "bot@example.com" },
          allowFrom: ["users/alice", "googlechat:bob"],
          groups: {
            "spaces/AAA": {},
            "spaces/BBB": {},
          },
        },
      },
    } as unknown as OpenClawConfig;

    const directory = expectDirectorySurface(googlechatDirectoryAdapter);

    const peers = await directory.listPeers({
      cfg,
      accountId: undefined,
      query: undefined,
      limit: undefined,
      runtime: runtimeEnv,
    });
    expect(peers).toStrictEqual([
      { kind: "user", id: "users/alice" },
      { kind: "user", id: "bob" },
    ]);

    const groups = await directory.listGroups({
      cfg,
      accountId: undefined,
      query: undefined,
      limit: undefined,
      runtime: runtimeEnv,
    });
    expect(groups).toStrictEqual([
      { kind: "group", id: "spaces/AAA" },
      { kind: "group", id: "spaces/BBB" },
    ]);
  });

  it("normalizes spaced provider-prefixed dm allowlist entries", async () => {
    const cfg = {
      channels: {
        googlechat: {
          serviceAccount: { client_email: "bot@example.com" },
          allowFrom: [" users/alice ", " googlechat:user:Bob@Example.com "],
        },
      },
    } as unknown as OpenClawConfig;

    const directory = expectDirectorySurface(googlechatDirectoryAdapter);

    const peers = await directory.listPeers({
      cfg,
      accountId: undefined,
      query: undefined,
      limit: undefined,
      runtime: runtimeEnv,
    });
    expect(peers).toStrictEqual([
      { kind: "user", id: "users/alice" },
      { kind: "user", id: "users/bob@example.com" },
    ]);
  });
});

describe("googlechatPlugin security", () => {
  it("normalizes prefixed DM allowlist entries to lowercase user ids", () => {
    const cfg = {
      channels: {
        googlechat: {
          serviceAccount: { client_email: "bot@example.com" },
          dmPolicy: "allowlist",
          allowFrom: ["  googlechat:user:Bob@Example.com  "],
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

describe("googlechatPlugin outbound sanitizeText", () => {
  const sanitizeText = googlechatOutboundAdapter.base.sanitizeText;

  it("strips internal tool-trace failure banners from outbound text (#90684)", () => {
    const text =
      "Visible answer.\n⚠️ 🛠️ `run openclaw definitely-not-a-real-subcommand (agent)` failed";
    const out = sanitizeText({ text });
    expect(out).toBe("Visible answer.");
    expect(out).not.toContain("failed");
    expect(out).not.toContain("🛠️");
  });

  it("preserves ordinary assistant prose untouched", () => {
    const text = "El pipeline tiene 3 deals abiertos por USD 12.000.";
    expect(sanitizeText({ text })).toBe(text);
  });

  it("keeps CommonMark intact until chunks reach the send boundary", () => {
    expect(sanitizeText({ text: "**bold** and ~~gone~~" })).toBe("**bold** and ~~gone~~");
  });
});
