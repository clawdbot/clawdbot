// Synology Chat tests cover channel plugin behavior.
import { verifyChannelMessageAdapterCapabilityProofs } from "openclaw/plugin-sdk/channel-outbound";
import { createPluginSetupWizardStatus } from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ResolvedSynologyChatAccount } from "./types.js";

const securityAccountDefaults: ResolvedSynologyChatAccount = {
  accountId: "default",
  enabled: true,
  token: "t",
  incomingUrl: "https://nas/incoming",
  webhookUrl: "https://gateway.example.com/w",
  nasHost: "h",
  webhookPath: "/w",
  webhookPathSource: "default" as const,
  dangerouslyAllowNameMatching: false,
  dangerouslyAllowInheritedWebhookPath: false,
  dmPolicy: "allowlist" as const,
  allowedUserIds: [],
  rateLimitPerMinute: 30,
  botName: "Bot",
  allowInsecureSsl: false,
};

const { preparedCapabilityUrl, prepareSynologyHostedMediaMock } = vi.hoisted(() => ({
  preparedCapabilityUrl:
    "https://gateway.example.com/w?__openclaw_synology_media_token_aaaaaaaaaaaaaaaaaaaaaaaa=secret",
  prepareSynologyHostedMediaMock: vi.fn(),
}));

vi.mock("./outbound-media.js", () => ({
  prepareSynologyHostedMedia: prepareSynologyHostedMediaMock,
  resolveSynologyHostedMediaRoute: vi.fn(() => ({
    localRoutePath: "/w/",
    publicBaseUrl: "https://gateway.example.com",
    publicRoutePath: "/w",
    publicSearch: "",
  })),
  tryHandleSynologyHostedMediaRequest: vi.fn(async () => false),
}));

function makeSecurityAccount(
  overrides: Partial<ResolvedSynologyChatAccount> = {},
): ResolvedSynologyChatAccount {
  return { ...securityAccountDefaults, ...overrides };
}

function expectIncludesSubstring(values: unknown[], text: string, severity?: string): void {
  expect(JSON.stringify(values)).toContain(text);
  if (severity) {
    expect(values).toContainEqual(expect.objectContaining({ severity }));
  }
}

function mockStringMessages(mock: { mock: { calls: unknown[][] } }): string[] {
  return mock.mock.calls.map((call) => {
    const message = call[0];
    return typeof message === "string" ? message : "";
  });
}

const clientModule = await import("./client.js");
const gatewayRuntimeModule = await import("./gateway-runtime.js");
const mockSendMessage = vi.spyOn(clientModule, "sendMessage").mockResolvedValue(true);
const mockSendHostedFileUrl = vi
  .spyOn(clientModule, "sendHostedFileUrl")
  .mockResolvedValue({ status: "accepted" });
const registerSynologyWebhookRouteMock = vi
  .spyOn(gatewayRuntimeModule, "registerSynologyWebhookRoute")
  .mockImplementation(async () => vi.fn(async () => undefined));

vi.mock("./webhook-handler.js", () => ({
  createWebhookHandler: vi.fn(() => vi.fn()),
}));

const { synologyChatPlugin } = await import("./channel.js");
const getSynologyChatSetupStatus = createPluginSetupWizardStatus(synologyChatPlugin);

describe("synology chat target classification", () => {
  it("accepts numeric chat user ids as direct", () => {
    expect(synologyChatPlugin.messaging?.inferTargetChatType?.({ to: "42" })).toBe("direct");
    expect(synologyChatPlugin.messaging?.inferTargetChatType?.({ to: "room" })).toBeUndefined();
  });
});

describe("createSynologyChatPlugin", () => {
  beforeEach(() => {
    vi.stubEnv("SYNOLOGY_CHAT_TOKEN", "");
    vi.stubEnv("SYNOLOGY_CHAT_INCOMING_URL", "");
    mockSendMessage.mockClear();
    mockSendHostedFileUrl.mockClear();
    prepareSynologyHostedMediaMock.mockReset();
    registerSynologyWebhookRouteMock.mockClear();
    mockSendMessage.mockResolvedValue(true);
    mockSendHostedFileUrl.mockResolvedValue({ status: "accepted" });
    prepareSynologyHostedMediaMock.mockImplementation(async ({ account }) => {
      if (!account.webhookUrl) {
        throw new Error("Synology Chat attachments require webhookUrl");
      }
      return { url: preparedCapabilityUrl, cleanup: vi.fn(async () => undefined) };
    });
    registerSynologyWebhookRouteMock.mockImplementation(async () => vi.fn(async () => undefined));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe("meta", () => {
    it("has correct id and label", () => {
      const plugin = synologyChatPlugin;
      expect(plugin.meta.id).toBe("synology-chat");
      expect(plugin.meta.label).toBe("Synology Chat");
      expect(plugin.meta.docsPath).toBe("/channels/synology-chat");
    });
  });

  describe("messaging", () => {
    it("isolates stable Chat API recipients from inbound webhook identities", async () => {
      const plugin = synologyChatPlugin;
      const route = await plugin.messaging?.resolveOutboundSessionRoute?.({
        cfg: {},
        agentId: "ops",
        accountId: "work",
        target: "synology-chat:42",
      });

      expect(route).toEqual({
        sessionKey: "agent:ops:synology-chat:work:direct:chat-api-42",
        baseSessionKey: "agent:ops:synology-chat:work:direct:chat-api-42",
        recipientSessionExact: "delivery-identity",
        peer: { kind: "direct", id: "chat-api-42" },
        chatType: "direct",
        from: "synology-chat:chat-api:42",
        to: "42",
      });
    });

    it("rejects non-numeric Chat API recipients for session routing", async () => {
      const plugin = synologyChatPlugin;
      const route = await plugin.messaging?.resolveOutboundSessionRoute?.({
        cfg: {},
        agentId: "ops",
        target: "synology-chat:alice",
      });

      expect(route).toBeNull();
    });

    it("canonicalizes safe Chat API recipient IDs", async () => {
      const plugin = synologyChatPlugin;
      const route = await plugin.messaging?.resolveOutboundSessionRoute?.({
        cfg: {},
        agentId: "ops",
        target: "synology_chat:+00042",
      });

      expect(route).toMatchObject({
        sessionKey: "agent:ops:synology-chat:default:direct:chat-api-42",
        peer: { kind: "direct", id: "chat-api-42" },
        to: "42",
      });
    });

    it("rejects Chat API recipient IDs beyond the safe integer range", async () => {
      const plugin = synologyChatPlugin;
      const route = await plugin.messaging?.resolveOutboundSessionRoute?.({
        cfg: {},
        agentId: "ops",
        target: "9007199254740992",
      });

      expect(route).toBeNull();
    });
  });

  describe("capabilities", () => {
    it("supports direct chat with media", () => {
      const plugin = synologyChatPlugin;
      expect(plugin.capabilities.chatTypes).toEqual(["direct"]);
      expect(plugin.capabilities.media).toBe(true);
      expect(plugin.capabilities.threads).toBe(false);
    });
  });

  it("projects lifecycle through the computed status adapter", async () => {
    const cfg = {
      channels: {
        "synology-chat": {
          token: "test-token",
          incomingUrl: "https://nas/incoming",
          webhookUrl: "https://gateway.example.com/webhook/synology?proxy-token=redacted",
        },
      },
    };
    const account = synologyChatPlugin.config.resolveAccount(cfg, "default");

    const snapshot = await synologyChatPlugin.status?.buildAccountSnapshot?.({
      account,
      cfg,
      runtime: { accountId: "default", lifecycle: "ready" },
    });

    expect(snapshot).toMatchObject({
      accountId: "default",
      configured: true,
      lifecycle: "ready",
      webhookPath: "/webhook/synology",
      attachmentsReady: true,
    });
    expect(snapshot).not.toHaveProperty("webhookUrl");
  });

  it.each([
    "http://gateway.example.com/webhook/synology",
    "https://gateway.example.com/webhook/synology#fragment",
    "https://gateway.example.com/webhook/synology?__openclaw_synology_media_token_fixture=value",
  ])("reports attachments unready when webhookUrl is invalid: %s", async (webhookUrl) => {
    const cfg = {
      channels: {
        "synology-chat": {
          token: "test-token",
          incomingUrl: "https://nas/incoming",
          webhookUrl,
        },
      },
    };
    const account = synologyChatPlugin.config.resolveAccount(cfg, "default");

    const snapshot = await synologyChatPlugin.status?.buildAccountSnapshot?.({
      account,
      cfg,
      runtime: { accountId: "default", lifecycle: "ready" },
    });

    expect(snapshot).toMatchObject({ configured: true, attachmentsReady: false });
  });

  describe("config", () => {
    it("listAccountIds includes default and named accounts when configured", () => {
      const plugin = synologyChatPlugin;
      const result = plugin.config.listAccountIds({
        channels: {
          "synology-chat": {
            token: "base-token",
            accounts: {
              office: { token: "office-token" },
            },
          },
        },
      });
      expect(result).toEqual(["default", "office"]);
    });

    it("resolveAccount merges account overrides with base config defaults", () => {
      const cfg = {
        channels: {
          "synology-chat": {
            token: "base-token",
            incomingUrl: "https://nas/base",
            nasHost: "nas-base",
            allowedUserIds: ["base-user"],
            rateLimitPerMinute: 45,
            botName: "Base Bot",
            accounts: {
              office: {
                token: "office-token",
                allowInsecureSsl: true,
              },
            },
          },
        },
      };
      const plugin = synologyChatPlugin;
      const account = plugin.config.resolveAccount(cfg, "office");
      expect(account.accountId).toBe("office");
      expect(account.token).toBe("office-token");
      expect(account.incomingUrl).toBe("https://nas/base");
      expect(account.nasHost).toBe("nas-base");
      expect(account.allowedUserIds).toEqual(["base-user"]);
      expect(account.rateLimitPerMinute).toBe(45);
      expect(account.botName).toBe("Base Bot");
      expect(account.allowInsecureSsl).toBe(true);
    });

    it("defaultAccountId returns 'default'", () => {
      const plugin = synologyChatPlugin;
      expect(plugin.config.defaultAccountId?.({})).toBe("default");
    });

    it("setup status honors the selected named account", async () => {
      const status = await getSynologyChatSetupStatus({
        cfg: {
          channels: {
            "synology-chat": {
              accounts: {
                ops: {
                  token: "ops-token",
                  incomingUrl: "https://nas/ops",
                },
                work: {
                  token: "work-token",
                },
              },
            },
          },
        },
        accountOverrides: {
          "synology-chat": "work",
        },
      });

      expect(status.configured).toBe(false);
      expect(status.statusLines).toEqual([
        "Synology Chat: needs token + incoming webhook",
        "Accounts: 2",
      ]);
    });

    it("formats allowFrom entries through the shared adapter", () => {
      const plugin = synologyChatPlugin;
      expect(
        plugin.config.formatAllowFrom?.({
          cfg: {},
          allowFrom: ["  USER1  ", 42],
        }),
      ).toEqual(["user1", "42"]);
    });
  });

  describe("security", () => {
    it("resolveDmPolicy returns policy, allowFrom, normalizeEntry", () => {
      const plugin = synologyChatPlugin;
      const account = {
        accountId: "default",
        enabled: true,
        token: "t",
        incomingUrl: "u",
        webhookUrl: "https://gateway.example.com/w",
        nasHost: "h",
        webhookPath: "/w",
        webhookPathSource: "default" as const,
        dangerouslyAllowNameMatching: false,
        dangerouslyAllowInheritedWebhookPath: false,
        dmPolicy: "allowlist" as const,
        allowedUserIds: ["user1"],
        rateLimitPerMinute: 30,
        botName: "Bot",
        allowInsecureSsl: true,
      };
      const result = plugin.security.resolveDmPolicy({ cfg: {}, account });
      if (!result) {
        throw new Error("resolveDmPolicy returned null");
      }
      expect(result.policy).toBe("allowlist");
      expect(result.allowFrom).toEqual(["user1"]);
      expect(result.normalizeEntry?.("  USER1  ")).toBe("user1");
    });
  });

  describe("pairing", () => {
    it("normalizes entries and notifies approved users", async () => {
      const plugin = synologyChatPlugin;
      expect(plugin.pairing.idLabel).toBe("synologyChatUserId");
      const normalize = plugin.pairing.normalizeAllowEntry;
      const notifyApproval = plugin.pairing.notifyApproval;
      if (!normalize || !notifyApproval) {
        throw new Error("synology-chat pairing helpers unavailable");
      }
      expect(normalize("  USER1  ")).toBe("user1");

      await notifyApproval({
        cfg: {
          channels: {
            "synology-chat": {
              token: "t",
              incomingUrl: "https://nas/incoming",
              webhookUrl: "https://gateway.example.com/w",
              allowInsecureSsl: true,
            },
          },
        },
        id: "USER1",
      });

      expect(mockSendMessage).toHaveBeenCalledWith(
        "https://nas/incoming",
        "OpenClaw: your access has been approved.",
        "USER1",
        true,
      );
    });
  });

  describe("security.collectWarnings", () => {
    function makeSharedWebhookConfig(alertsOverrides: Record<string, unknown> = {}) {
      return {
        channels: {
          "synology-chat": {
            token: "base-token",
            webhookPath: "/webhook/shared",
            webhookUrl: "https://gateway.example.com/webhook/shared",
            accounts: {
              alerts: {
                token: "alerts-token",
                incomingUrl: "https://nas/alerts",
                dmPolicy: "allowlist",
                allowedUserIds: ["123"],
                ...alertsOverrides,
              },
            },
          },
        },
      };
    }

    it("warns when token is missing", () => {
      const plugin = synologyChatPlugin;
      const account = makeSecurityAccount({ token: "" });
      const warnings = plugin.security.collectWarnings({ cfg: {}, account });
      expectIncludesSubstring(warnings, "token");
    });

    it("warns when allowInsecureSsl is true", () => {
      const plugin = synologyChatPlugin;
      const account = makeSecurityAccount({ allowInsecureSsl: true });
      const warnings = plugin.security.collectWarnings({ cfg: {}, account });
      expectIncludesSubstring(warnings, "SSL");
    });

    it("warns when dangerous name matching is enabled", () => {
      const plugin = synologyChatPlugin;
      const account = makeSecurityAccount({ dangerouslyAllowNameMatching: true });
      const warnings = plugin.security.collectWarnings({ cfg: {}, account });
      expectIncludesSubstring(warnings, "dangerouslyAllowNameMatching");
    });

    it("warns when inherited shared webhookPath is dangerously re-enabled", () => {
      const plugin = synologyChatPlugin;
      const account = makeSecurityAccount({
        accountId: "alerts",
        webhookPathSource: "inherited-base",
        dangerouslyAllowInheritedWebhookPath: true,
      });
      const warnings = plugin.security.collectWarnings({ cfg: {}, account });
      expectIncludesSubstring(warnings, "dangerouslyAllowInheritedWebhookPath=true");
    });

    it("warns when dmPolicy is open", () => {
      const plugin = synologyChatPlugin;
      const account = makeSecurityAccount({ dmPolicy: "open", allowedUserIds: ["*"] });
      const warnings = plugin.security.collectWarnings({ cfg: {}, account });
      expectIncludesSubstring(warnings, "open", "critical");
    });

    it("warns when dmPolicy is open and allowedUserIds is empty", () => {
      const plugin = synologyChatPlugin;
      const account = makeSecurityAccount({ dmPolicy: "open", allowedUserIds: [] });
      const warnings = plugin.security.collectWarnings({ cfg: {}, account });
      expectIncludesSubstring(warnings, "empty allowedUserIds", "critical");
    });

    it("warns when dmPolicy is allowlist and allowedUserIds is empty", () => {
      const plugin = synologyChatPlugin;
      const account = makeSecurityAccount();
      const warnings = plugin.security.collectWarnings({ cfg: {}, account });
      expectIncludesSubstring(warnings, "empty allowedUserIds", "critical");
    });

    it("warns when named multi-account routes inherit a shared webhookPath", () => {
      const plugin = synologyChatPlugin;
      const cfg = makeSharedWebhookConfig();
      const account = plugin.config.resolveAccount(cfg, "alerts");
      const warnings = plugin.security.collectWarnings({ cfg, account });
      expectIncludesSubstring(warnings, "must set an explicit webhookPath");
    });

    it("warns when enabled accounts share the same exact webhookPath", () => {
      const plugin = synologyChatPlugin;
      const base = makeSharedWebhookConfig({ webhookPath: "/webhook/shared" }).channels[
        "synology-chat"
      ];
      const cfg = {
        channels: {
          "synology-chat": {
            ...base,
            incomingUrl: "https://nas/default",
            dmPolicy: "allowlist",
            allowedUserIds: ["123"],
          },
        },
      };
      const account = plugin.config.resolveAccount(cfg, "alerts");
      const warnings = plugin.security.collectWarnings({ cfg, account });
      expectIncludesSubstring(warnings, "conflicts on webhookPath");
    });

    it("warns when enabled accounts share the same public webhookUrl", () => {
      const plugin = synologyChatPlugin;
      const cfg = makeSharedWebhookConfig({
        webhookPath: "/webhook/alerts",
        webhookUrl: "https://gateway.example.com/synology?a=1&b=2",
      });
      cfg.channels["synology-chat"].webhookUrl = "https://gateway.example.com/synology?b=2&a=1";
      const account = plugin.config.resolveAccount(cfg, "alerts");
      const warnings = plugin.security.collectWarnings({ cfg, account });
      expectIncludesSubstring(warnings, "conflicts on webhookUrl", "critical");
    });

    it("returns no warnings for fully configured account", () => {
      const plugin = synologyChatPlugin;
      const account = makeSecurityAccount({ allowedUserIds: ["user1"] });
      const warnings = plugin.security.collectWarnings({ cfg: {}, account });
      expect(warnings).toHaveLength(0);
    });
  });

  describe("messaging", () => {
    it("normalizeTarget strips prefix and trims", () => {
      const plugin = synologyChatPlugin;
      expect(plugin.messaging.normalizeTarget("synology-chat:123")).toBe("123");
      expect(plugin.messaging.normalizeTarget("synology_chat:123")).toBe("123");
      expect(plugin.messaging.normalizeTarget("synology:123")).toBe("123");
      expect(plugin.messaging.normalizeTarget("  456  ")).toBe("456");
      expect(plugin.messaging.normalizeTarget("")).toBeUndefined();
    });

    it("targetResolver.looksLikeId matches numeric IDs", () => {
      const plugin = synologyChatPlugin;
      expect(plugin.messaging.targetResolver.looksLikeId("12345")).toBe(true);
      expect(plugin.messaging.targetResolver.looksLikeId("synology-chat:99")).toBe(true);
      expect(plugin.messaging.targetResolver.looksLikeId("synology_chat:99")).toBe(true);
      expect(plugin.messaging.targetResolver.looksLikeId("synology:99")).toBe(true);
      expect(plugin.messaging.targetResolver.looksLikeId("notanumber")).toBe(false);
      expect(plugin.messaging.targetResolver.looksLikeId("")).toBe(false);
    });
  });

  describe("directory", () => {
    it("returns empty stubs", async () => {
      const plugin = synologyChatPlugin;
      const params = { cfg: {}, runtime: {} as never };
      expect(await plugin.directory.self?.(params)).toBeNull();
      expect(await plugin.directory.listPeers?.(params)).toStrictEqual([]);
      expect(await plugin.directory.listGroups?.(params)).toStrictEqual([]);
    });
  });

  describe("agentPrompt", () => {
    it("returns formatting hints", () => {
      const plugin = synologyChatPlugin;
      const hints = plugin.agentPrompt.messageToolHints();
      expect(hints).toContain("### Synology Chat Formatting");
      expect(hints).toContain("**Links**: Use `<URL|display text>` to create clickable links.");
      expect(hints).toContain("- No buttons, cards, or interactive elements");
    });
  });

  describe("outbound", () => {
    it("declares bounded Markdown chunking for gateway text delivery", () => {
      const plugin = synologyChatPlugin;
      expect(plugin.outbound.chunkerMode).toBe("markdown");
      expect(plugin.outbound.textChunkLimit).toBe(2_000);
      expect(plugin.outbound.chunker("x".repeat(2_001), 2_000)).toEqual(["x".repeat(2_000), "x"]);
    });

    it("declares message adapter durable text and media with receipt proofs", async () => {
      const plugin = synologyChatPlugin;
      const cfg = {
        channels: {
          "synology-chat": {
            enabled: true,
            token: "t",
            incomingUrl: "https://nas/incoming",
            webhookUrl: "https://gateway.example.com/w",
            allowInsecureSsl: true,
          },
        },
      };

      const results = await verifyChannelMessageAdapterCapabilityProofs({
        adapterName: "synology-chat",
        adapter: plugin.message,
        proofs: {
          text: async () => {
            const result = await plugin.message.send?.text?.({
              cfg,
              text: "hello",
              to: "user1",
            });
            expect(result?.messageId).toBe("");
            expect(result?.receipt.platformMessageIds).toHaveLength(0);
            expect(result?.receipt.parts).toHaveLength(0);
          },
          media: async () => {
            const result = await plugin.message.send?.media?.({
              cfg,
              text: "image",
              mediaUrl: "https://example.com/img.png",
              to: "user1",
            });
            expect(result?.messageId).toBe("");
            expect(result?.receipt.platformMessageIds).toHaveLength(0);
            expect(result?.receipt.parts).toHaveLength(0);
          },
          messageSendingHooks: () => {
            expect(plugin.message.durableFinal?.capabilities?.messageSendingHooks).toBe(true);
          },
        },
      });

      const statusByCapability = new Map(
        results.map(({ capability, status }) => [capability, status]),
      );
      expect(statusByCapability.get("text")).toBe("verified");
      expect(statusByCapability.get("media")).toBe("verified");
      expect(statusByCapability.get("messageSendingHooks")).toBe("verified");
    });

    it("sendText throws when no incomingUrl", async () => {
      const plugin = synologyChatPlugin;
      await expect(
        plugin.outbound.sendText({
          cfg: {
            channels: {
              "synology-chat": { enabled: true, token: "t", incomingUrl: "" },
            },
          },
          text: "hello",
          to: "user1",
        }),
      ).rejects.toThrow("not configured");
    });

    it("sendText returns an honest empty-id result on success", async () => {
      const plugin = synologyChatPlugin;
      const malformedLink = `[${"\\".repeat(32)}`;
      const result = await plugin.outbound.sendText({
        cfg: {
          channels: {
            "synology-chat": {
              enabled: true,
              token: "t",
              incomingUrl: "https://nas/incoming",
              allowInsecureSsl: true,
            },
          },
        },
        text: `**Read** [the docs](https://example.com/a_(b)) [titled](https://example.com "Documentation") \`[literal](https://example.com)\` \\[escaped](https://example.com) [x > y](https://example.com) [bad](<https://example.com) [bad title](https://example.com "oops') ![logo](https://example.com/logo.png) ${malformedLink}`,
        to: "user1",
      });
      expect(result.channel).toBe("synology-chat");
      expect(result.target).toEqual({ kind: "chat", id: "user1" });
      expect(result.messageId).toBe("");
      expect(result.receipt.primaryPlatformMessageId).toBeUndefined();
      expect(result.receipt.platformMessageIds).toHaveLength(0);
      expect(result.receipt.parts).toHaveLength(0);
      expect(result.receipt.threadId).toBe("user1");
      expect(mockSendMessage).toHaveBeenLastCalledWith(
        "https://nas/incoming",
        `**Read** <https://example.com/a_(b)|the docs> <https://example.com|titled> \`[literal](https://example.com)\` \\[escaped](https://example.com) [x > y](https://example.com) [bad](<https://example.com) [bad title](https://example.com "oops') ![logo](https://example.com/logo.png) ${malformedLink}`,
        "user1",
        true,
      );
    });

    it("sendMedia returns an honest empty-id result on success", async () => {
      const plugin = synologyChatPlugin;
      const result = await plugin.outbound.sendMedia({
        cfg: {
          channels: {
            "synology-chat": {
              enabled: true,
              token: "t",
              incomingUrl: "https://nas/incoming",
              webhookUrl: "https://gateway.example.com/w",
              allowInsecureSsl: true,
            },
          },
        },
        mediaUrl: "https://example.com/img.png",
        to: "user1",
      });

      expect(result.channel).toBe("synology-chat");
      expect(result.target).toEqual({ kind: "chat", id: "user1" });
      expect(result.messageId).toBe("");
      expect(result.receipt.primaryPlatformMessageId).toBeUndefined();
      expect(result.receipt.platformMessageIds).toHaveLength(0);
      expect(result.receipt.parts).toHaveLength(0);
      expect(result.receipt.threadId).toBe("user1");
      expect(mockSendHostedFileUrl).toHaveBeenLastCalledWith(
        "https://nas/incoming",
        preparedCapabilityUrl,
        "user1",
        true,
      );
      expect(prepareSynologyHostedMediaMock).toHaveBeenCalledWith(
        expect.objectContaining({ mediaUrl: "https://example.com/img.png" }),
      );
    });

    it("sendMedia throws when missing incomingUrl", async () => {
      const plugin = synologyChatPlugin;
      await expect(
        plugin.outbound.sendMedia({
          cfg: {
            channels: {
              "synology-chat": { enabled: true, token: "t", incomingUrl: "" },
            },
          },
          mediaUrl: "https://example.com/img.png",
          to: "user1",
        }),
      ).rejects.toThrow("not configured");
    });

    it("sendMedia reports an actionable attachment-only setup failure without webhookUrl", async () => {
      await expect(
        synologyChatPlugin.outbound.sendMedia({
          cfg: {
            channels: {
              "synology-chat": {
                enabled: true,
                token: "t",
                incomingUrl: "https://nas/incoming",
              },
            },
          },
          mediaUrl: "https://example.com/img.png",
          to: "user1",
        }),
      ).rejects.toThrow("attachments require webhookUrl");
      expect(mockSendHostedFileUrl).not.toHaveBeenCalled();
    });

    it("sendMedia retains staged bytes when webhook acceptance is indeterminate", async () => {
      const cleanup = vi.fn(async () => undefined);
      prepareSynologyHostedMediaMock.mockResolvedValueOnce({
        url: preparedCapabilityUrl,
        cleanup,
      });
      mockSendHostedFileUrl.mockResolvedValueOnce({ status: "indeterminate" });
      await expect(
        synologyChatPlugin.outbound.sendMedia({
          cfg: {
            channels: {
              "synology-chat": {
                enabled: true,
                token: "t",
                incomingUrl: "https://nas/incoming",
                webhookUrl: "https://gateway.example.com/w",
              },
            },
          },
          mediaUrl: "https://example.com/img.png",
          to: "user1",
        }),
      ).rejects.toThrow("acceptance could not be confirmed");
      expect(cleanup).not.toHaveBeenCalled();
    });

    it("sendMedia cleans up staged bytes when the webhook request never starts", async () => {
      const cleanup = vi.fn(async () => undefined);
      prepareSynologyHostedMediaMock.mockResolvedValueOnce({
        url: preparedCapabilityUrl,
        cleanup,
      });
      mockSendHostedFileUrl.mockResolvedValueOnce({ status: "not-dispatched" });

      await expect(
        synologyChatPlugin.outbound.sendMedia({
          cfg: {
            channels: {
              "synology-chat": {
                enabled: true,
                token: "t",
                incomingUrl: "https://nas/incoming",
                webhookUrl: "https://gateway.example.com/w",
              },
            },
          },
          mediaUrl: "https://example.com/img.png",
          to: "user1",
        }),
      ).rejects.toThrow("request did not start");
      expect(cleanup).toHaveBeenCalledOnce();
    });

    it("sendMedia cleans up staged bytes after a definitive webhook rejection", async () => {
      const cleanup = vi.fn(async () => undefined);
      prepareSynologyHostedMediaMock.mockResolvedValueOnce({
        url: preparedCapabilityUrl,
        cleanup,
      });
      mockSendHostedFileUrl.mockResolvedValueOnce({ status: "rejected" });

      await expect(
        synologyChatPlugin.outbound.sendMedia({
          cfg: {
            channels: {
              "synology-chat": {
                enabled: true,
                token: "t",
                incomingUrl: "https://nas/incoming",
                webhookUrl: "https://gateway.example.com/w",
              },
            },
          },
          mediaUrl: "https://example.com/img.png",
          to: "user1",
        }),
      ).rejects.toThrow("rejected the attachment request");
      expect(cleanup).toHaveBeenCalledOnce();
    });

    it("sanitizeText strips internal tool-trace banners from outbound text", () => {
      const text = "Done.\n⚠️ 🛠️ `search repos (agent)` failed";
      const sanitizeText = synologyChatPlugin.outbound.sanitizeText;
      expect(sanitizeText({ text, payload: { text } })).toBe("Done.");

      const prose = "The pipeline has 3 open deals.";
      expect(sanitizeText({ text: prose, payload: { text: prose } })).toBe(prose);
    });

    it("sanitizeText returns empty string for trace-only replies", () => {
      const traceOnly = "⚠️ 🛠️ `search repos (agent)` failed";
      expect(
        synologyChatPlugin.outbound.sanitizeText({
          text: traceOnly,
          payload: { text: traceOnly },
        }),
      ).toBe("");
    });
  });

  describe("gateway", () => {
    function makeStartAccountCtx(
      accountConfig: Record<string, unknown>,
      abortController = new AbortController(),
    ) {
      return {
        abortController,
        ctx: {
          cfg: {
            channels: { "synology-chat": accountConfig },
          },
          accountId: "default",
          log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
          abortSignal: abortController.signal,
          setStatus: vi.fn(),
        },
      };
    }

    function makeNamedStartAccountCtx(
      accountOverrides: Record<string, unknown>,
      abortController = new AbortController(),
    ) {
      return {
        abortController,
        ctx: {
          cfg: {
            channels: {
              "synology-chat": {
                enabled: true,
                token: "default-token",
                incomingUrl: "https://nas/default",
                webhookPath: "/webhook/synology-shared",
                webhookUrl: "https://gateway.example.com/webhook/synology-default",
                dmPolicy: "allowlist",
                allowedUserIds: ["123"],
                accounts: {
                  alerts: {
                    enabled: true,
                    token: "alerts-token",
                    incomingUrl: "https://nas/alerts",
                    ...accountOverrides,
                  },
                },
              },
            },
          },
          accountId: "alerts",
          log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
          abortSignal: abortController.signal,
          setStatus: vi.fn(),
        },
      };
    }

    async function expectPendingStartAccountPromise(
      result: Promise<unknown>,
      abortController: AbortController,
    ) {
      expect(result).toBeInstanceOf(Promise);
      let settled = false;
      void result.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      await Promise.resolve();
      expect(settled).toBe(false);
      abortController.abort();
      await result;
    }

    async function expectPendingStartAccount(accountConfig: Record<string, unknown>) {
      const plugin = synologyChatPlugin;
      const { ctx, abortController } = makeStartAccountCtx(accountConfig);
      const result = plugin.gateway.startAccount(ctx);
      await expectPendingStartAccountPromise(result, abortController);
    }

    it("startAccount returns pending promise for disabled account", async () => {
      const { ctx, abortController } = makeStartAccountCtx({ enabled: false });
      const result = synologyChatPlugin.gateway.startAccount(ctx);
      await Promise.resolve();
      expect(ctx.setStatus).toHaveBeenCalledWith({
        accountId: "default",
        running: true,
        lifecycle: "blocked",
        terminalDisconnect: true,
        lastError: "Synology Chat account failed startup validation",
      });
      await expectPendingStartAccountPromise(result, abortController);
    });

    it("publishes ready after route registration and stopped after abort cleanup", async () => {
      const cleanup = vi.fn(async () => undefined);
      registerSynologyWebhookRouteMock.mockResolvedValueOnce(cleanup);
      const { ctx, abortController } = makeStartAccountCtx({
        enabled: true,
        token: "t",
        incomingUrl: "https://nas/incoming",
        dmPolicy: "allowlist",
        allowedUserIds: ["123"],
      });

      const result = synologyChatPlugin.gateway.startAccount(ctx);
      await vi.waitFor(() => expect(registerSynologyWebhookRouteMock).toHaveBeenCalledOnce());
      expect(ctx.setStatus).toHaveBeenCalledWith({
        accountId: "default",
        running: true,
        connected: true,
        lifecycle: "ready",
        lastConnectedAt: expect.any(Number),
        lastError: null,
        terminalDisconnect: undefined,
      });

      abortController.abort();
      await result;
      expect(cleanup).toHaveBeenCalledOnce();
      expect(ctx.setStatus).toHaveBeenLastCalledWith({
        accountId: "default",
        running: false,
        connected: false,
        lifecycle: "stopped",
      });
    });

    it("startAccount returns pending promise for account without token", async () => {
      await expectPendingStartAccount({ enabled: true });
    });

    it("startAccount refuses allowlist accounts with empty allowedUserIds", async () => {
      const registerMock = registerSynologyWebhookRouteMock;
      registerMock.mockClear();
      const plugin = synologyChatPlugin;
      const { ctx, abortController } = makeStartAccountCtx({
        enabled: true,
        token: "t",
        incomingUrl: "https://nas/incoming",
        dmPolicy: "allowlist",
        allowedUserIds: [],
      });

      const result = plugin.gateway.startAccount(ctx);
      await expectPendingStartAccountPromise(result, abortController);
      expectIncludesSubstring(mockStringMessages(ctx.log.warn), "empty allowedUserIds");
      expect(registerMock).not.toHaveBeenCalled();
    });

    it("startAccount refuses open accounts with empty allowedUserIds", async () => {
      const registerMock = registerSynologyWebhookRouteMock;
      registerMock.mockClear();
      const plugin = synologyChatPlugin;
      const { ctx, abortController } = makeStartAccountCtx({
        enabled: true,
        token: "t",
        incomingUrl: "https://nas/incoming",
        dmPolicy: "open",
        allowedUserIds: [],
      });

      const result = plugin.gateway.startAccount(ctx);
      await expectPendingStartAccountPromise(result, abortController);
      expectIncludesSubstring(
        mockStringMessages(ctx.log.warn),
        "dmPolicy=open but empty allowedUserIds",
      );
      expect(registerMock).not.toHaveBeenCalled();
    });

    it("startAccount refuses named accounts without explicit webhookPath in multi-account setups", async () => {
      const registerMock = registerSynologyWebhookRouteMock;
      const plugin = synologyChatPlugin;
      const { ctx, abortController } = makeNamedStartAccountCtx({
        dmPolicy: "allowlist",
        allowedUserIds: ["123"],
      });

      const result = plugin.gateway.startAccount(ctx);
      await expectPendingStartAccountPromise(result, abortController);
      expectIncludesSubstring(mockStringMessages(ctx.log.warn), "must set an explicit webhookPath");
      expect(registerMock).not.toHaveBeenCalled();
    });

    it("startAccount refuses duplicate exact webhook paths across accounts", async () => {
      const registerMock = registerSynologyWebhookRouteMock;
      const plugin = synologyChatPlugin;
      const { ctx, abortController } = makeNamedStartAccountCtx({
        webhookPath: "/webhook/synology-shared",
        dmPolicy: "open",
        allowedUserIds: ["*"],
      });

      const result = plugin.gateway.startAccount(ctx);
      await expectPendingStartAccountPromise(result, abortController);
      expectIncludesSubstring(mockStringMessages(ctx.log.warn), "conflicts on webhookPath");
      expect(registerMock).not.toHaveBeenCalled();
    });

    it("startAccount refuses duplicate public webhook URLs across accounts", async () => {
      const registerMock = registerSynologyWebhookRouteMock;
      const plugin = synologyChatPlugin;
      const { ctx, abortController } = makeNamedStartAccountCtx({
        webhookPath: "/webhook/synology-alerts",
        webhookUrl: "https://gateway.example.com/synology",
        dmPolicy: "open",
        allowedUserIds: ["*"],
      });
      ctx.cfg.channels["synology-chat"].webhookUrl = "https://gateway.example.com/synology";

      const result = plugin.gateway.startAccount(ctx);
      await expectPendingStartAccountPromise(result, abortController);
      expectIncludesSubstring(mockStringMessages(ctx.log.warn), "conflicts on webhookUrl");
      expect(registerMock).not.toHaveBeenCalled();
    });

    it("re-registers same account/path through the route registrar", async () => {
      const unregisterFirst = vi.fn(async () => undefined);
      const unregisterSecond = vi.fn(async () => undefined);
      const registerMock = registerSynologyWebhookRouteMock;
      registerMock.mockResolvedValueOnce(unregisterFirst).mockResolvedValueOnce(unregisterSecond);

      const plugin = synologyChatPlugin;
      const abortFirst = new AbortController();
      const abortSecond = new AbortController();
      const makeCtx = (abortCtrl: AbortController) => ({
        cfg: {
          channels: {
            "synology-chat": {
              enabled: true,
              token: "t",
              incomingUrl: "https://nas/incoming",
              webhookPath: "/webhook/synology",
              dmPolicy: "allowlist",
              allowedUserIds: ["123"],
            },
          },
        },
        accountId: "default",
        log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        abortSignal: abortCtrl.signal,
      });

      const firstPromise = plugin.gateway.startAccount(makeCtx(abortFirst));
      const secondPromise = plugin.gateway.startAccount(makeCtx(abortSecond));

      expect(registerMock).toHaveBeenCalledTimes(2);
      expect(unregisterFirst).not.toHaveBeenCalled();
      expect(unregisterSecond).not.toHaveBeenCalled();

      abortFirst.abort();
      abortSecond.abort();
      await Promise.allSettled([firstPromise, secondPromise]);
    });
  });
});
