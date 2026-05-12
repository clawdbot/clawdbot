import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { ChannelType } from "discord-api-types/v10";
import { createStartAccountContext } from "openclaw/plugin-sdk/channel-test-helpers";
import type { PluginRuntime } from "openclaw/plugin-sdk/core";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ResolvedDiscordAccount } from "./accounts.js";
import * as directoryLive from "./directory-live.js";
import type { OpenClawConfig } from "./runtime-api.js";
import * as sendModule from "./send.js";
import { createDiscordSendReceipt } from "./send.receipt.js";
import { EMPTY_DISCORD_TEST_CONFIG } from "./test-support/config.js";
let discordPlugin: typeof import("./channel.js").discordPlugin;
let setDiscordRuntime: typeof import("./runtime.js").setDiscordRuntime;

const probeDiscordMock = vi.hoisted(() => vi.fn());
const monitorDiscordProviderMock = vi.hoisted(() => vi.fn());
const auditDiscordChannelPermissionsMock = vi.hoisted(() => vi.fn());
const collectDiscordAuditChannelIdsMock = vi.hoisted(() =>
  vi.fn(() => ({ channelIds: [], unresolvedChannels: 0 })),
);
const sleepWithAbortMock = vi.hoisted(() => vi.fn(async () => undefined));

function discordTestSendResult(messageId: string, channelId = "channel:thread-123") {
  return {
    messageId,
    channelId,
    receipt: createDiscordSendReceipt({ platformMessageIds: [messageId], channelId, kind: "text" }),
  };
}

vi.mock("openclaw/plugin-sdk/runtime-env", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/runtime-env")>(
    "openclaw/plugin-sdk/runtime-env",
  );
  return {
    ...actual,
    sleepWithAbort: sleepWithAbortMock,
  };
});

vi.mock("./probe.js", () => {
  return {
    probeDiscord: probeDiscordMock,
  };
});

vi.mock("./monitor/provider.runtime.js", () => {
  return {
    monitorDiscordProvider: monitorDiscordProviderMock,
  };
});

vi.mock("./audit.js", () => {
  return {
    auditDiscordChannelPermissions: auditDiscordChannelPermissionsMock,
    collectDiscordAuditChannelIds: collectDiscordAuditChannelIdsMock,
  };
});

function createCfg(): OpenClawConfig {
  return {
    channels: {
      discord: {
        enabled: true,
        token: "discord-token",
      },
    },
  } as OpenClawConfig;
}

function resolveAccount(cfg: OpenClawConfig, accountId = "default"): ResolvedDiscordAccount {
  return discordPlugin.config.resolveAccount(cfg, accountId);
}

function startDiscordAccount(cfg: OpenClawConfig, accountId = "default") {
  return discordPlugin.gateway!.startAccount!(
    createStartAccountContext({
      account: resolveAccount(cfg, accountId),
      cfg,
    }),
  );
}

function installDiscordRuntime(discord: Record<string, unknown>) {
  setDiscordRuntime({
    channel: {
      discord,
    },
    logging: {
      shouldLogVerbose: () => false,
    },
  } as unknown as PluginRuntime);
}

type MockWithCalls = {
  mock: { calls: unknown[][] };
};

function objectArgAt(
  mock: MockWithCalls,
  callIndex: number,
  argIndex: number,
): Record<string, unknown> {
  const value = mock.mock.calls[callIndex]?.[argIndex];
  if (value === undefined || value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`expected call ${callIndex} argument ${argIndex} to be an object`);
  }
  return value as Record<string, unknown>;
}

function argAt(mock: MockWithCalls, callIndex: number, argIndex: number): unknown {
  const call = mock.mock.calls[callIndex];
  if (!call || !(argIndex in call)) {
    throw new Error(`expected call ${callIndex} argument ${argIndex}`);
  }
  return call[argIndex];
}

function recordField(value: unknown, field: string): Record<string, unknown> {
  if (value === undefined || value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`expected ${field} to be an object`);
  }
  return value as Record<string, unknown>;
}

afterEach(() => {
  probeDiscordMock.mockReset();
  monitorDiscordProviderMock.mockReset();
  auditDiscordChannelPermissionsMock.mockReset();
  collectDiscordAuditChannelIdsMock.mockReset();
  collectDiscordAuditChannelIdsMock.mockReturnValue({
    channelIds: [],
    unresolvedChannels: 0,
  });
  sleepWithAbortMock.mockReset();
  sleepWithAbortMock.mockResolvedValue(undefined);
});

beforeEach(async () => {
  vi.useRealTimers();
  installDiscordRuntime({});
});

beforeAll(async () => {
  ({ discordPlugin } = await import("./channel.js"));
  ({ setDiscordRuntime } = await import("./runtime.js"));
});

describe("discordPlugin outbound", () => {
  it("avoids local require calls for bundled-only sibling modules", async () => {
    const source = await readFile(
      resolve(process.cwd(), "extensions/discord/src/channel.ts"),
      "utf8",
    );
    expect(source).not.toContain('require("./ui.js")');
    expect(source).not.toContain('require("./channel-actions.js")');
  });

  it("prefers final assistant text for text-only cron announce delivery", () => {
    expect(discordPlugin.outbound?.preferFinalAssistantVisibleText).toBe(true);
  });

  it("routes read and search actions through the gateway", () => {
    expect(discordPlugin.actions?.resolveExecutionMode?.({ action: "read" as never })).toBe(
      "gateway",
    );
    expect(discordPlugin.actions?.resolveExecutionMode?.({ action: "search" as never })).toBe(
      "gateway",
    );
    expect(discordPlugin.actions?.resolveExecutionMode?.({ action: "send" as never })).toBe(
      "local",
    );
  });

  it("adds Discord mention formatting to agent prompt hints", () => {
    const hints = discordPlugin.agentPrompt?.messageToolHints?.({} as never) ?? [];

    expect(hints).toContain(
      "- Discord mentions: use canonical outbound syntax: users `<@USER_ID>`, channels `<#CHANNEL_ID>`, and roles `<@&ROLE_ID>`. Plain `@name` text only pings when a configured `mentionAliases` entry rewrites it; do not use the legacy `<@!USER_ID>` nickname form.",
    );
  });

  it("preserves normalized explicit Discord targets for delivery routing", () => {
    const parseExplicitTarget = discordPlugin.messaging?.parseExplicitTarget;
    if (!parseExplicitTarget) {
      throw new Error("Expected discordPlugin.messaging.parseExplicitTarget to be defined");
    }

    expect(parseExplicitTarget({ raw: "user:123" })).toEqual({
      to: "user:123",
      chatType: "direct",
    });
    expect(parseExplicitTarget({ raw: "<@!456>" })).toEqual({
      to: "user:456",
      chatType: "direct",
    });
    expect(parseExplicitTarget({ raw: "channel:789" })).toEqual({
      to: "channel:789",
      chatType: "channel",
    });
    expect(parseExplicitTarget({ raw: "1470130713209602050" })).toEqual({
      to: "channel:1470130713209602050",
      chatType: "channel",
    });
  });

  it("resolves Discord usernames through the messaging target resolver", async () => {
    vi.spyOn(directoryLive, "listDiscordDirectoryPeersLive").mockResolvedValueOnce([
      { kind: "user", id: "user:999", name: "Jane" } as const,
    ]);
    const resolveTarget = discordPlugin.messaging?.targetResolver?.resolveTarget;
    if (!resolveTarget) {
      throw new Error(
        "Expected discordPlugin.messaging.targetResolver.resolveTarget to be defined",
      );
    }

    await expect(
      resolveTarget({
        cfg: createCfg(),
        accountId: "default",
        input: "jane",
        normalized: "channel:jane",
        preferredKind: "user",
      }),
    ).resolves.toEqual({
      to: "user:999",
      kind: "user",
      display: "jane",
      source: "directory",
    });
  });

  it("honors per-account replyToMode overrides", () => {
    const resolveReplyToMode = discordPlugin.threading?.resolveReplyToMode;
    if (!resolveReplyToMode) {
      throw new Error("Expected discordPlugin.threading.resolveReplyToMode to be defined");
    }

    const cfg = {
      channels: {
        discord: {
          replyToMode: "all",
          token: "discord-token",
          accounts: {
            work: {
              token: "discord-token-work",
              replyToMode: "first",
            },
          },
        },
      },
    } as OpenClawConfig;

    expect(resolveReplyToMode({ cfg, accountId: "work" })).toBe("first");
    expect(resolveReplyToMode({ cfg, accountId: "default" })).toBe("all");
  });

  it("inherits Discord gateway READY timeout settings per account", () => {
    const cfg = {
      channels: {
        discord: {
          token: "discord-token",
          gatewayReadyTimeoutMs: 90_000,
          gatewayRuntimeReadyTimeoutMs: 120_000,
          accounts: {
            work: {
              token: "discord-token-work",
              gatewayReadyTimeoutMs: 60_000,
            },
          },
        },
      },
    } as OpenClawConfig;

    expect(resolveAccount(cfg).config.gatewayReadyTimeoutMs).toBe(90_000);
    expect(resolveAccount(cfg).config.gatewayRuntimeReadyTimeoutMs).toBe(120_000);
    expect(resolveAccount(cfg, "work").config.gatewayReadyTimeoutMs).toBe(60_000);
    expect(resolveAccount(cfg, "work").config.gatewayRuntimeReadyTimeoutMs).toBe(120_000);
  });

  it("forwards full media send context to sendMessageDiscord", async () => {
    const sendMessageDiscord = vi.fn(async () => ({ messageId: "m1" }));
    const mediaReadFile = vi.fn(async () => Buffer.from("media"));

    const result = await discordPlugin.outbound!.sendMedia!({
      cfg: EMPTY_DISCORD_TEST_CONFIG,
      to: "channel:123",
      text: "hi",
      mediaUrl: "/tmp/image.png",
      mediaLocalRoots: ["/tmp/agent-root"],
      mediaReadFile,
      accountId: "work",
      threadId: "thread-123",
      replyToId: "reply-123",
      deps: {
        discord: sendMessageDiscord,
      },
    });

    expect(argAt(sendMessageDiscord, 0, 0)).toBe("channel:thread-123");
    expect(argAt(sendMessageDiscord, 0, 1)).toBe("hi");
    const sendOptions = objectArgAt(sendMessageDiscord, 0, 2);
    expect(sendOptions.mediaUrl).toBe("/tmp/image.png");
    expect(sendOptions.mediaLocalRoots).toEqual(["/tmp/agent-root"]);
    expect(sendOptions.mediaReadFile).toBe(mediaReadFile);
    expect(sendOptions.replyTo).toBe("reply-123");
    expect(result.channel).toBe("discord");
    expect(result.messageId).toBe("m1");
  });

  it("splits text and video into separate sends for attached outbound delivery", async () => {
    const sendMessageDiscord = vi
      .fn()
      .mockResolvedValueOnce(discordTestSendResult("text-1"))
      .mockResolvedValueOnce(discordTestSendResult("video-1"));

    const result = await discordPlugin.outbound!.sendMedia!({
      cfg: EMPTY_DISCORD_TEST_CONFIG,
      to: "channel:123",
      text: "done - tiny cyber-lobster clip incoming",
      mediaUrl: "/tmp/molty.mp4",
      accountId: "work",
      replyToId: "reply-123",
      threadId: "thread-123",
      deps: {
        discord: sendMessageDiscord,
      },
    });

    expect(sendMessageDiscord).toHaveBeenCalledTimes(2);
    expect(argAt(sendMessageDiscord, 0, 0)).toBe("channel:thread-123");
    expect(argAt(sendMessageDiscord, 0, 1)).toBe("done - tiny cyber-lobster clip incoming");
    expect(objectArgAt(sendMessageDiscord, 0, 2).replyTo).toBe("reply-123");
    expect(argAt(sendMessageDiscord, 1, 0)).toBe("channel:thread-123");
    expect(argAt(sendMessageDiscord, 1, 1)).toBe("");
    expect(objectArgAt(sendMessageDiscord, 1, 2).mediaUrl).toBe("/tmp/molty.mp4");
    expect(result.channel).toBe("discord");
    expect(result.messageId).toBe("video-1");
  });

  it("threads poll sends through the thread target", async () => {
    const sendPollDiscord = vi.fn(async () => discordTestSendResult("poll-1"));
    const sendPollSpy = vi.spyOn(sendModule, "sendPollDiscord").mockImplementation(sendPollDiscord);
    try {
      const result = await discordPlugin.outbound!.sendPoll!({
        cfg: EMPTY_DISCORD_TEST_CONFIG,
        to: "channel:123",
        poll: {
          question: "Best shell?",
          options: ["molty", "molter"],
        },
        accountId: "work",
        threadId: "thread-123",
      });

      expect(argAt(sendPollDiscord, 0, 0)).toBe("channel:thread-123");
      expect(argAt(sendPollDiscord, 0, 1)).toEqual({
        question: "Best shell?",
        options: ["molty", "molter"],
      });
      expect(objectArgAt(sendPollDiscord, 0, 2).accountId).toBe("work");
      const pollResult = result as { channel?: string; messageId?: string };
      expect(pollResult.channel).toBe("discord");
      expect(pollResult.messageId).toBe("poll-1");
    } finally {
      sendPollSpy.mockRestore();
    }
  });

  it("forwards heartbeat typing through the run config and attached target", async () => {
    const sendTypingDiscord = vi.fn(async () => ({ ok: true, channelId: "thread-123" }));
    const sendTypingSpy = vi
      .spyOn(sendModule, "sendTypingDiscord")
      .mockImplementation(sendTypingDiscord);
    try {
      const cfg = createCfg();

      await discordPlugin.heartbeat!.sendTyping!({
        cfg,
        to: "channel:123",
        accountId: "work",
        threadId: "thread-123",
      });

      expect(sendTypingDiscord).toHaveBeenCalledWith("thread-123", {
        cfg,
        accountId: "work",
      });
    } finally {
      sendTypingSpy.mockRestore();
    }
  });

  it("uses direct Discord probe helpers for status probes", async () => {
    const runtimeProbeDiscord = vi.fn(async () => {
      throw new Error("runtime Discord probe should not be used");
    });
    installDiscordRuntime({
      probeDiscord: runtimeProbeDiscord,
    });
    probeDiscordMock.mockResolvedValue({
      ok: true,
      bot: { username: "Bob" },
      application: {
        intents: {
          messageContent: "limited",
          guildMembers: "disabled",
          presence: "disabled",
        },
      },
      elapsedMs: 1,
    });

    const cfg = createCfg();
    const account = resolveAccount(cfg);

    await discordPlugin.status!.probeAccount!({
      account,
      timeoutMs: 5000,
      cfg,
    });

    expect(probeDiscordMock).toHaveBeenCalledWith("discord-token", 5000, {
      includeApplication: true,
    });
    expect(runtimeProbeDiscord).not.toHaveBeenCalled();
  });

  it("reports missing voice permissions in targeted capabilities diagnostics", async () => {
    const fetchPermissionsSpy = vi
      .spyOn(sendModule, "fetchChannelPermissionsDiscord")
      .mockResolvedValueOnce({
        channelId: "222",
        guildId: "123",
        permissions: ["ViewChannel", "SendMessages"],
        raw: "0",
        isDm: false,
        channelType: ChannelType.GuildVoice,
      });
    try {
      const cfg = createCfg();
      const diagnostics = await discordPlugin.status!.buildCapabilitiesDiagnostics!({
        account: resolveAccount(cfg),
        timeoutMs: 5000,
        cfg,
        target: "channel:222",
      });

      expect(argAt(fetchPermissionsSpy, 0, 0)).toBe("222");
      expect(objectArgAt(fetchPermissionsSpy, 0, 1).token).toBe("discord-token");
      const permissions = recordField(diagnostics?.details?.permissions, "permissions");
      expect(permissions.channelId).toBe("222");
      expect(permissions.missingRequired).toEqual(["Connect", "Speak", "ReadMessageHistory"]);
      expect(diagnostics?.lines?.map((line) => line.text).join("\n")).toContain(
        "Missing required: Connect, Speak, ReadMessageHistory",
      );
    } finally {
      fetchPermissionsSpy.mockRestore();
    }
  });

  it("uses direct Discord startup helpers for async startup enrichment", async () => {
    const runtimeProbeDiscord = vi.fn(async () => {
      throw new Error("runtime Discord probe should not be used");
    });
    const runtimeMonitorDiscordProvider = vi.fn(async () => {
      throw new Error("runtime Discord monitor should not be used");
    });
    installDiscordRuntime({
      probeDiscord: runtimeProbeDiscord,
      monitorDiscordProvider: runtimeMonitorDiscordProvider,
    });
    probeDiscordMock.mockResolvedValue({
      ok: true,
      bot: { username: "Bob" },
      application: {
        intents: {
          messageContent: "limited",
          guildMembers: "disabled",
          presence: "disabled",
        },
      },
      elapsedMs: 1,
    });
    monitorDiscordProviderMock.mockResolvedValue(undefined);

    const cfg = createCfg();
    await startDiscordAccount(cfg);

    await vi.waitFor(() =>
      expect(probeDiscordMock).toHaveBeenCalledWith("discord-token", 2500, {
        includeApplication: true,
      }),
    );
    const monitorParams = objectArgAt(monitorDiscordProviderMock, 0, 0);
    expect(monitorParams.token).toBe("discord-token");
    expect(monitorParams.accountId).toBe("default");
    expect(sleepWithAbortMock).not.toHaveBeenCalled();
    expect(runtimeProbeDiscord).not.toHaveBeenCalled();
    expect(runtimeMonitorDiscordProvider).not.toHaveBeenCalled();
  });

  it("does not block Discord monitor startup on the startup probe", async () => {
    let resolveProbe:
      | ((value: {
          ok: true;
          bot: { username: string };
          application: { intents: { messageContent: "limited" } };
          elapsedMs: number;
        }) => void)
      | undefined;
    probeDiscordMock.mockReturnValue(
      new Promise((resolve) => {
        resolveProbe = resolve;
      }),
    );
    monitorDiscordProviderMock.mockResolvedValue(undefined);

    const cfg = createCfg();
    const statusPatches: Array<Record<string, unknown>> = [];
    const ctx = createStartAccountContext({
      account: resolveAccount(cfg),
      cfg,
      statusPatchSink: (next) => statusPatches.push({ ...next }),
    });

    await discordPlugin.gateway!.startAccount!(ctx);

    const monitorParams = objectArgAt(monitorDiscordProviderMock, 0, 0);
    expect(monitorParams.token).toBe("discord-token");
    expect(monitorParams.accountId).toBe("default");
    await vi.waitFor(() =>
      expect(probeDiscordMock).toHaveBeenCalledWith("discord-token", 2500, {
        includeApplication: true,
      }),
    );
    expect(statusPatches.some((patch) => "bot" in patch || "application" in patch)).toBe(false);

    if (!resolveProbe) {
      throw new Error("Expected Discord startup probe resolver to be initialized");
    }
    resolveProbe({
      ok: true,
      bot: { username: "AsyncBob" },
      application: { intents: { messageContent: "limited" } },
      elapsedMs: 1,
    });

    await vi.waitFor(() =>
      expect(
        statusPatches.some(
          (patch) =>
            (patch.bot as { username?: string } | undefined)?.username === "AsyncBob" &&
            Boolean(patch.application),
        ),
      ).toBe(true),
    );
  });

  it("clears stale Discord probe metadata when the async startup probe degrades", async () => {
    probeDiscordMock.mockResolvedValue({
      ok: false,
      status: 401,
      error: "getMe failed (401)",
      elapsedMs: 1,
    });
    monitorDiscordProviderMock.mockResolvedValue(undefined);

    const cfg = createCfg();
    const statusPatches: Array<Record<string, unknown>> = [];
    const ctx = createStartAccountContext({
      account: resolveAccount(cfg),
      cfg,
      statusPatchSink: (next) => statusPatches.push({ ...next }),
    });
    ctx.setStatus({
      accountId: "default",
      bot: { username: "OldBot" },
      application: { intents: { messageContent: "enabled" } },
    });

    await discordPlugin.gateway!.startAccount!(ctx);

    await vi.waitFor(() =>
      expect(
        statusPatches.some(
          (patch) =>
            "bot" in patch &&
            "application" in patch &&
            patch.bot === undefined &&
            patch.application === undefined,
        ),
      ).toBe(true),
    );
  });

  it("clears stale Discord probe metadata when the async startup probe throws", async () => {
    probeDiscordMock.mockRejectedValue(new Error("probe timed out"));
    monitorDiscordProviderMock.mockResolvedValue(undefined);

    const cfg = createCfg();
    const statusPatches: Array<Record<string, unknown>> = [];
    const ctx = createStartAccountContext({
      account: resolveAccount(cfg),
      cfg,
      statusPatchSink: (next) => statusPatches.push({ ...next }),
    });
    ctx.setStatus({
      accountId: "default",
      bot: { username: "OldBot" },
      application: { intents: { messageContent: "enabled" } },
    });

    await discordPlugin.gateway!.startAccount!(ctx);

    await vi.waitFor(() =>
      expect(
        statusPatches.some(
          (patch) =>
            "bot" in patch &&
            "application" in patch &&
            patch.bot === undefined &&
            patch.application === undefined,
        ),
      ).toBe(true),
    );
  });

  it("stagger starts later accounts in multi-bot setups", async () => {
    probeDiscordMock.mockResolvedValue({
      ok: true,
      bot: { username: "Cherry" },
      application: {
        intents: {
          messageContent: "limited",
          guildMembers: "disabled",
          presence: "disabled",
        },
      },
      elapsedMs: 1,
    });
    monitorDiscordProviderMock.mockResolvedValue(undefined);

    const cfg = {
      channels: {
        discord: {
          accounts: {
            // "alpha" sorts before "zeta" so alpha is index 0, zeta is index 1
            alpha: { token: "Bot alpha-token", enabled: true },
            zeta: { token: "Bot zeta-token", enabled: true },
          },
        },
      },
    } as OpenClawConfig;

    // First account (index 0) — no delay
    await startDiscordAccount(cfg, "alpha");
    expect(sleepWithAbortMock).not.toHaveBeenCalled();

    // Second account (index 1) — 10s delay
    const zetaContext = createStartAccountContext({
      account: resolveAccount(cfg, "zeta"),
      cfg,
    });
    await discordPlugin.gateway!.startAccount!(zetaContext);
    expect(sleepWithAbortMock).toHaveBeenCalledWith(10_000, zetaContext.abortSignal);
  });
});

describe("discordPlugin bindings", () => {
  it("derives DM current conversation ids from direct sender context", () => {
    const result = discordPlugin.bindings?.resolveCommandConversation?.({
      accountId: "default",
      chatType: "direct",
      from: "discord:123456789012345678",
      originatingTo: "channel:dm-channel-1",
      fallbackTo: "channel:dm-channel-1",
    });

    expect(result).toEqual({
      conversationId: "user:123456789012345678",
    });
  });

  it("preserves user-prefixed current conversation ids for DM binds", () => {
    const result = discordPlugin.bindings?.resolveCommandConversation?.({
      accountId: "default",
      originatingTo: "user:123456789012345678",
    });

    expect(result).toEqual({
      conversationId: "user:123456789012345678",
    });
  });

  it("preserves channel-prefixed current conversation ids for channel binds", () => {
    const result = discordPlugin.bindings?.resolveCommandConversation?.({
      accountId: "default",
      originatingTo: "channel:987654321098765432",
    });

    expect(result).toEqual({
      conversationId: "channel:987654321098765432",
    });
  });

  it("preserves channel-prefixed parent ids for thread binds", () => {
    const result = discordPlugin.bindings?.resolveCommandConversation?.({
      accountId: "default",
      originatingTo: "channel:thread-42",
      threadId: "thread-42",
      threadParentId: "parent-9",
    });

    expect(result).toEqual({
      conversationId: "thread-42",
      parentConversationId: "channel:parent-9",
    });
  });
});

describe("discordPlugin security", () => {
  it("normalizes dm allowlist entries with trimmed prefixes and mentions", () => {
    const resolveDmPolicy = discordPlugin.security?.resolveDmPolicy;
    if (!resolveDmPolicy) {
      throw new Error("resolveDmPolicy unavailable");
    }

    const cfg = {
      channels: {
        discord: {
          token: "discord-token",
          dm: { policy: "allowlist", allowFrom: ["  discord:<@!123456789>  "] },
        },
      },
    } as OpenClawConfig;

    const result = resolveDmPolicy({
      cfg,
      account: discordPlugin.config.resolveAccount(cfg, "default"),
    });
    if (!result) {
      throw new Error("discord resolveDmPolicy returned null");
    }

    expect(result.policy).toBe("allowlist");
    expect(result.allowFrom).toEqual(["  discord:<@!123456789>  "]);
    expect(result.policyPath).toBe("channels.discord.dmPolicy");
    expect(result.allowFromPath).toBe("channels.discord.");
    expect(result.normalizeEntry?.("  discord:<@!123456789>  ")).toBe("123456789");
    expect(result.normalizeEntry?.("  user:987654321  ")).toBe("987654321");
  });
});

describe("discordPlugin groups", () => {
  it("uses plugin-owned group policy resolvers", () => {
    const cfg = {
      channels: {
        discord: {
          token: "discord-test",
          guilds: {
            guild1: {
              requireMention: false,
              tools: { allow: ["message.guild"] },
              channels: {
                "123": {
                  requireMention: true,
                  tools: { allow: ["message.channel"] },
                },
              },
            },
          },
        },
      },
    } as OpenClawConfig;

    expect(
      discordPlugin.groups?.resolveRequireMention?.({
        cfg,
        groupSpace: "guild1",
        groupId: "123",
      }),
    ).toBe(true);
    expect(
      discordPlugin.groups?.resolveToolPolicy?.({
        cfg,
        groupSpace: "guild1",
        groupId: "123",
      }),
    ).toEqual({ allow: ["message.channel"] });
  });
});
