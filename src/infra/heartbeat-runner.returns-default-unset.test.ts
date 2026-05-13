import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { HEARTBEAT_PROMPT } from "../auto-reply/heartbeat.js";
import type { ChannelOutboundAdapter } from "../channels/plugins/types.public.js";
import type { OpenClawConfig } from "../config/config.js";
import {
  resolveAgentIdFromSessionKey,
  resolveAgentMainSessionKey,
  resolveMainSessionKey,
  resolveStorePath,
} from "../config/sessions.js";
import { getActivePluginRegistry, setActivePluginRegistry } from "../plugins/runtime.js";
import { buildAgentPeerSessionKey } from "../routing/session-key.js";
import { createOutboundTestPlugin, createTestRegistry } from "../test-utils/channel-plugins.js";
import { typedCases } from "../test-utils/typed-cases.js";
import {
  type HeartbeatDeps,
  isHeartbeatEnabledForAgent,
  resolveHeartbeatIntervalMs,
  resolveHeartbeatPrompt,
  runHeartbeatOnce,
} from "./heartbeat-runner.js";
import {
  resolveHeartbeatDeliveryTarget,
  resolveHeartbeatSenderContext,
} from "./outbound/targets.js";
import { telegramMessagingForTest } from "./outbound/targets.test-helpers.js";
import { enqueueSystemEvent, resetSystemEventsForTest } from "./system-events.js";

let previousRegistry: ReturnType<typeof getActivePluginRegistry> | null = null;
let testRegistry: ReturnType<typeof getActivePluginRegistry> | null = null;

let fixtureRoot = "";
let fixtureCount = 0;

function normalizeWhatsAppTargetForTest(raw: string): string | null {
  const trimmed = raw
    .trim()
    .replace(/^whatsapp:/i, "")
    .trim();
  if (!trimmed) {
    return null;
  }
  const lowered = trimmed.toLowerCase().replace(/\s+/gu, "");
  if (/^\d+@g\.us$/u.test(lowered)) {
    return lowered;
  }
  const digits = trimmed.replace(/\D/gu, "");
  const normalized = digits ? `+${digits}` : "";
  return /^\+\d{7,15}$/u.test(normalized) ? normalized : null;
}

function isWhatsAppGroupJidForTest(raw: string): boolean {
  return /^\d+@g\.us$/u.test(raw.trim().toLowerCase());
}

const whatsappOutboundForTest: ChannelOutboundAdapter = {
  deliveryMode: "gateway",
  sendText: async ({ cfg, to, text, accountId, deps }) => {
    const sender = deps?.whatsapp as
      | ((
          to: string,
          text: string,
          options?: Record<string, unknown>,
        ) => Promise<{ messageId: string } & Record<string, unknown>>)
      | undefined;
    if (!sender) {
      throw new Error("missing whatsapp sender");
    }
    const result = await sender(to, text, {
      verbose: false,
      cfg,
      accountId: accountId ?? undefined,
    });
    return {
      channel: "whatsapp",
      ...result,
    };
  },
  sendMedia: async ({
    cfg,
    to,
    text,
    mediaUrl,
    mediaLocalRoots,
    mediaReadFile,
    accountId,
    deps,
  }) => {
    const sender = deps?.whatsapp as
      | ((
          to: string,
          text: string,
          options?: Record<string, unknown>,
        ) => Promise<{ messageId: string } & Record<string, unknown>>)
      | undefined;
    if (!sender) {
      throw new Error("missing whatsapp sender");
    }
    const result = await sender(to, text, {
      verbose: false,
      cfg,
      mediaUrl,
      mediaLocalRoots,
      mediaReadFile,
      accountId: accountId ?? undefined,
    });
    return {
      channel: "whatsapp",
      ...result,
    };
  },
};

function resolveWhatsAppTargetForTest(params: {
  to: string | null | undefined;
  allowFrom: Array<string | number> | null | undefined;
}) {
  const trimmed = params.to?.trim() ?? "";
  const allowList: string[] = [];
  let hasWildcard = false;
  for (const entry of params.allowFrom ?? []) {
    const raw = String(entry).trim();
    if (!raw) {
      continue;
    }
    if (raw === "*") {
      hasWildcard = true;
      continue;
    }
    const normalized = normalizeWhatsAppTargetForTest(raw);
    if (normalized) {
      allowList.push(normalized);
    }
  }
  const normalizedTarget = normalizeWhatsAppTargetForTest(trimmed);

  if (!normalizedTarget) {
    return {
      ok: false as const,
      error: new Error('Missing target for WhatsApp; expected "<E.164|group JID>".'),
    };
  }
  if (isWhatsAppGroupJidForTest(normalizedTarget)) {
    return { ok: true as const, to: normalizedTarget };
  }
  if (hasWildcard || allowList.length === 0 || allowList.includes(normalizedTarget)) {
    return { ok: true as const, to: normalizedTarget };
  }
  return {
    ok: false as const,
    error: new Error(
      `Target "${normalizedTarget}" is not listed in the configured WhatsApp allowFrom policy.`,
    ),
  };
}

const createCaseDir = async (prefix: string) => {
  const dir = path.join(fixtureRoot, `${prefix}-${fixtureCount++}`);
  await fs.mkdir(dir, { recursive: true });
  return dir;
};

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`expected ${label} to be a record`);
  }
  return value as Record<string, unknown>;
}

function expectRecordFields(record: Record<string, unknown>, fields: Record<string, unknown>) {
  for (const [key, value] of Object.entries(fields)) {
    expect(record[key]).toEqual(value);
  }
}

function expectWhatsAppSendCall(
  sendWhatsApp: ReturnType<typeof vi.fn>,
  index: number,
  fields: { to: string; text: string },
) {
  const call = sendWhatsApp.mock.calls[index];
  if (!call) {
    throw new Error(`expected WhatsApp send call ${index}`);
  }
  expect(call[0]).toBe(fields.to);
  expect(call[1]).toBe(fields.text);
  requireRecord(call[2], `WhatsApp send call ${index} options`);
}

function expectReplyCall(
  replySpy: ReturnType<typeof vi.fn>,
  index: number,
  bodyFields: Record<string, unknown>,
  optionsFields?: Record<string, unknown>,
  cfg?: OpenClawConfig,
) {
  const call = replySpy.mock.calls[index];
  if (!call) {
    throw new Error(`expected reply call ${index}`);
  }
  const body = requireRecord(call[0], `reply call ${index} body`);
  for (const [key, value] of Object.entries(bodyFields)) {
    if (value instanceof RegExp) {
      expect(String(body[key])).toMatch(value);
    } else {
      expect(body[key]).toEqual(value);
    }
  }
  if (optionsFields) {
    expectRecordFields(requireRecord(call[1], `reply call ${index} options`), optionsFields);
  }
  if (cfg) {
    expect(call[2]).toBe(cfg);
  }
}

function replyBody(
  replySpy: ReturnType<typeof vi.fn>,
  index = 0,
): { Body?: string; ForceSenderIsOwnerFalse?: boolean; Provider?: string } {
  const call = replySpy.mock.calls[index];
  return requireRecord(call?.[0], `reply call ${index} body`) as {
    Body?: string;
    ForceSenderIsOwnerFalse?: boolean;
    Provider?: string;
  };
}

beforeAll(async () => {
  previousRegistry = getActivePluginRegistry();

  const whatsappPlugin = createOutboundTestPlugin({
    id: "whatsapp",
    outbound: {
      ...whatsappOutboundForTest,
      resolveTarget: ({ to, allowFrom }) =>
        resolveWhatsAppTargetForTest({
          to,
          allowFrom,
        }),
    },
  });
  whatsappPlugin.config = {
    ...whatsappPlugin.config,
    resolveAllowFrom: ({ cfg }) => cfg.channels?.whatsapp?.allowFrom?.map((entry) => entry) ?? [],
  };

  const telegramPlugin = createOutboundTestPlugin({
    id: "telegram",
    outbound: {
      deliveryMode: "direct",
      sendText: async ({ to, text, deps, accountId }) => {
        if (!deps?.["telegram"]) {
          throw new Error("sendTelegram missing");
        }
        const res = await (deps["telegram"] as Function)(to, text, {
          verbose: false,
          accountId: accountId ?? undefined,
        });
        return { channel: "telegram", messageId: res.messageId, chatId: res.chatId };
      },
      sendMedia: async ({ to, text, mediaUrl, deps, accountId }) => {
        if (!deps?.["telegram"]) {
          throw new Error("sendTelegram missing");
        }
        const res = await (deps["telegram"] as Function)(to, text, {
          verbose: false,
          accountId: accountId ?? undefined,
          mediaUrl,
        });
        return { channel: "telegram", messageId: res.messageId, chatId: res.chatId };
      },
    },
    messaging: telegramMessagingForTest,
  });
  telegramPlugin.config = {
    ...telegramPlugin.config,
    listAccountIds: (cfg) => Object.keys(cfg.channels?.telegram?.accounts ?? {}),
    resolveAllowFrom: ({ cfg, accountId }) => {
      const channel = cfg.channels?.telegram;
      const normalized = accountId?.trim();
      if (normalized && channel?.accounts?.[normalized]?.allowFrom) {
        return channel.accounts[normalized].allowFrom?.map((entry) => String(entry)) ?? [];
      }
      return channel?.allowFrom?.map((entry) => String(entry)) ?? [];
    },
  };

  testRegistry = createTestRegistry([
    { pluginId: "whatsapp", plugin: whatsappPlugin, source: "test" },
    { pluginId: "telegram", plugin: telegramPlugin, source: "test" },
  ]);
  setActivePluginRegistry(testRegistry);

  fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-heartbeat-suite-"));
});

beforeEach(() => {
  resetSystemEventsForTest();
  if (testRegistry) {
    setActivePluginRegistry(testRegistry);
  }
});

afterAll(async () => {
  if (fixtureRoot) {
    await fs.rm(fixtureRoot, { recursive: true, force: true });
  }
  if (previousRegistry) {
    setActivePluginRegistry(previousRegistry);
  }
});

describe("resolveHeartbeatIntervalMs", () => {
  it("returns default when unset", () => {
    expect(resolveHeartbeatIntervalMs({})).toBe(30 * 60_000);
  });

  it("returns null when invalid or zero", () => {
    expect(
      resolveHeartbeatIntervalMs({
        agents: { defaults: { heartbeat: { every: "0m" } } },
      }),
    ).toBeNull();
    expect(
      resolveHeartbeatIntervalMs({
        agents: { defaults: { heartbeat: { every: "oops" } } },
      }),
    ).toBeNull();
  });

  it("parses duration strings with minute defaults", () => {
    expect(
      resolveHeartbeatIntervalMs({
        agents: { defaults: { heartbeat: { every: "5m" } } },
      }),
    ).toBe(5 * 60_000);
    expect(
      resolveHeartbeatIntervalMs({
        agents: { defaults: { heartbeat: { every: "5" } } },
      }),
    ).toBe(5 * 60_000);
    expect(
      resolveHeartbeatIntervalMs({
        agents: { defaults: { heartbeat: { every: "2h" } } },
      }),
    ).toBe(2 * 60 * 60_000);
  });

  it("uses explicit heartbeat overrides when provided", () => {
    expect(
      resolveHeartbeatIntervalMs(
        { agents: { defaults: { heartbeat: { every: "30m" } } } },
        undefined,
        { every: "5m" },
      ),
    ).toBe(5 * 60_000);
  });
});

describe("resolveHeartbeatPrompt", () => {
  it.each([
    { name: "default prompt", cfg: {} as OpenClawConfig, expected: HEARTBEAT_PROMPT },
    {
      name: "trimmed override prompt",
      cfg: {
        agents: { defaults: { heartbeat: { prompt: "  ping  " } } },
      } as OpenClawConfig,
      expected: "ping",
    },
  ])("uses $name", ({ cfg, expected }) => {
    expect(resolveHeartbeatPrompt(cfg)).toBe(expected);
  });
});

describe("isHeartbeatEnabledForAgent", () => {
  it("enables only explicit heartbeat agents when configured", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: { heartbeat: { every: "30m" } },
        list: [{ id: "main" }, { id: "ops", heartbeat: { every: "1h" } }],
      },
    };
    expect(isHeartbeatEnabledForAgent(cfg, "main")).toBe(false);
    expect(isHeartbeatEnabledForAgent(cfg, "ops")).toBe(true);
  });

  it("uses global heartbeat defaults for all agents when no explicit heartbeat entries exist", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: { heartbeat: { every: "30m" } },
        list: [{ id: "main" }, { id: "ops" }],
      },
    };
    expect(isHeartbeatEnabledForAgent(cfg, "main")).toBe(true);
    expect(isHeartbeatEnabledForAgent(cfg, "ops")).toBe(true);
  });

  it("falls back to default agent when no heartbeat config exists", () => {
    const cfg: OpenClawConfig = {
      agents: {
        list: [{ id: "main" }, { id: "ops" }],
      },
    };
    expect(isHeartbeatEnabledForAgent(cfg, "main")).toBe(true);
    expect(isHeartbeatEnabledForAgent(cfg, "ops")).toBe(false);
  });
});

describe("resolveHeartbeatDeliveryTarget", () => {
  const baseEntry = {
    sessionId: "sid",
    updatedAt: Date.now(),
  };

  it("resolves target variants across route and allowlist rules", () => {
    const cases: Array<{
      name: string;
      cfg: OpenClawConfig;
      entry: typeof baseEntry & {
        lastChannel?: "whatsapp" | "telegram" | "webchat";
        lastTo?: string;
      };
      expected: ReturnType<typeof resolveHeartbeatDeliveryTarget>;
    }> = [
      {
        name: "target none",
        cfg: { agents: { defaults: { heartbeat: { target: "none" } } } },
        entry: baseEntry,
        expected: {
          channel: "none",
          reason: "target-none",
          accountId: undefined,
          lastChannel: undefined,
          lastAccountId: undefined,
        },
      },
      {
        name: "target defaults to none when unset",
        cfg: {},
        entry: { ...baseEntry, lastChannel: "whatsapp", lastTo: "120363401234567890@g.us" },
        expected: {
          channel: "none",
          reason: "target-none",
          accountId: undefined,
          lastChannel: "whatsapp",
          lastAccountId: undefined,
        },
      },
      {
        name: "normalize explicit whatsapp target when allowFrom wildcard",
        cfg: {
          agents: {
            defaults: { heartbeat: { target: "whatsapp", to: "whatsapp:120363401234567890@G.US" } },
          },
          channels: { whatsapp: { allowFrom: ["*"] } },
        },
        entry: baseEntry,
        expected: {
          channel: "whatsapp",
          to: "120363401234567890@g.us",
          accountId: undefined,
          lastChannel: undefined,
          lastAccountId: undefined,
        },
      },
      {
        name: "skip webchat last route",
        cfg: {},
        entry: { ...baseEntry, lastChannel: "webchat", lastTo: "web" },
        expected: {
          channel: "none",
          reason: "target-none",
          accountId: undefined,
          lastChannel: undefined,
          lastAccountId: undefined,
        },
      },
      {
        name: "reject explicit whatsapp target outside allowFrom",
        cfg: {
          agents: { defaults: { heartbeat: { target: "whatsapp", to: "+1999" } } },
          channels: { whatsapp: { allowFrom: ["120363401234567890@g.us", "+1666"] } },
        },
        entry: { ...baseEntry, lastChannel: "whatsapp", lastTo: "+1222" },
        expected: {
          channel: "none",
          reason: "no-target",
          accountId: undefined,
          lastChannel: "whatsapp",
          lastAccountId: undefined,
        },
      },
      {
        name: "normalize prefixed whatsapp group targets",
        cfg: {
          agents: { defaults: { heartbeat: { target: "last" } } },
          channels: { whatsapp: { allowFrom: ["120363401234567890@g.us"] } },
        },
        entry: {
          ...baseEntry,
          lastChannel: "whatsapp",
          lastTo: "whatsapp:120363401234567890@G.US",
        },
        expected: {
          channel: "whatsapp",
          to: "120363401234567890@g.us",
          accountId: undefined,
          lastChannel: "whatsapp",
          lastAccountId: undefined,
        },
      },
      {
        name: "keep explicit telegram target",
        cfg: { agents: { defaults: { heartbeat: { target: "telegram", to: "-100123" } } } },
        entry: baseEntry,
        expected: {
          channel: "telegram",
          to: "-100123",
          accountId: undefined,
          lastChannel: undefined,
          lastAccountId: undefined,
        },
      },
      {
        name: "allow direct target by default",
        cfg: { agents: { defaults: { heartbeat: { target: "last" } } } },
        entry: { ...baseEntry, lastChannel: "telegram", lastTo: "5232990709" },
        expected: {
          channel: "telegram",
          to: "5232990709",
          accountId: undefined,
          lastChannel: "telegram",
          lastAccountId: undefined,
        },
      },
      {
        name: "block direct target when directPolicy is block",
        cfg: { agents: { defaults: { heartbeat: { target: "last", directPolicy: "block" } } } },
        entry: { ...baseEntry, lastChannel: "telegram", lastTo: "5232990709" },
        expected: {
          channel: "none",
          reason: "dm-blocked",
          accountId: undefined,
          lastChannel: "telegram",
          lastAccountId: undefined,
        },
      },
    ];
    for (const { cfg, entry, name, expected } of cases) {
      expect(resolveHeartbeatDeliveryTarget({ cfg, entry }), name).toEqual(expected);
    }
  });

  it.each([
    { name: "topic suffix", to: "-100111:topic:42", expectedTo: "-100111", expectedThreadId: 42 },
    { name: "plain chat id", to: "-100111", expectedTo: "-100111", expectedThreadId: undefined },
  ])(
    "parses optional telegram :topic: threadId suffix: $name",
    ({ to, expectedTo, expectedThreadId }) => {
      const cfg: OpenClawConfig = {
        agents: {
          defaults: {
            heartbeat: { target: "telegram", to },
          },
        },
      };
      const result = resolveHeartbeatDeliveryTarget({ cfg, entry: baseEntry });
      expect(result.channel).toBe("telegram");
      expect(result.to).toBe(expectedTo);
      expect(result.threadId).toBe(expectedThreadId);
    },
  );

  it.each([
    {
      name: "known account",
      accountId: "work",
      expected: {
        channel: "telegram",
        to: "-100123",
        accountId: "work",
        lastChannel: undefined,
        lastAccountId: undefined,
      },
    },
    {
      name: "missing account",
      accountId: "missing",
      expected: {
        channel: "none",
        reason: "unknown-account",
        accountId: "missing",
        lastChannel: undefined,
        lastAccountId: undefined,
      },
    },
  ] as const)(
    "handles explicit heartbeat accountId allow/deny: $name",
    ({ accountId, expected }) => {
      const cfg: OpenClawConfig = {
        agents: {
          defaults: {
            heartbeat: { target: "telegram", to: "-100123", accountId },
          },
        },
        channels: { telegram: { accounts: { work: { botToken: "token" } } } },
      };
      expect(resolveHeartbeatDeliveryTarget({ cfg, entry: baseEntry })).toEqual(expected);
    },
  );

  it("prefers per-agent heartbeat overrides when provided", () => {
    const cfg: OpenClawConfig = {
      agents: { defaults: { heartbeat: { target: "telegram", to: "-100123" } } },
    };
    const heartbeat = { target: "whatsapp", to: "120363401234567890@g.us" } as const;
    expect(
      resolveHeartbeatDeliveryTarget({
        cfg,
        entry: { ...baseEntry, lastChannel: "whatsapp", lastTo: "+1999" },
        heartbeat,
      }),
    ).toEqual({
      channel: "whatsapp",
      to: "120363401234567890@g.us",
      accountId: undefined,
      lastChannel: "whatsapp",
      lastAccountId: undefined,
    });
  });
});

describe("resolveHeartbeatSenderContext", () => {
  it("prefers delivery accountId for allowFrom resolution", () => {
    const cfg: OpenClawConfig = {
      channels: {
        telegram: {
          allowFrom: ["111"],
          accounts: {
            work: { allowFrom: ["222"], botToken: "token" },
          },
        },
      },
    };
    const entry = {
      sessionId: "sid",
      updatedAt: Date.now(),
      lastChannel: "telegram" as const,
      lastTo: "111",
      lastAccountId: "default",
    };
    const delivery = {
      channel: "telegram" as const,
      to: "999",
      accountId: "work",
      lastChannel: "telegram" as const,
      lastAccountId: "default",
    };

    const ctx = resolveHeartbeatSenderContext({ cfg, entry, delivery });

    expect(ctx.allowFrom).toEqual(["222"]);
  });
});

describe("runHeartbeatOnce", () => {
  const createHeartbeatDeps = (
    sendWhatsApp: (
      to: string,
      text: string,
      opts?: unknown,
    ) => Promise<{ messageId: string; toJid: string }>,
    options?: {
      nowMs?: number;
      getReplyFromConfig?: HeartbeatDeps["getReplyFromConfig"];
    },
  ): HeartbeatDeps => ({
    whatsapp: sendWhatsApp,
    getQueueSize: () => 0,
    nowMs: () => options?.nowMs ?? 0,
    webAuthExists: async () => true,
    hasActiveWebListener: () => true,
    ...(options?.getReplyFromConfig ? { getReplyFromConfig: options.getReplyFromConfig } : null),
  });

  it("skips when agent heartbeat is not enabled", async () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: { heartbeat: { every: "30m" } },
        list: [{ id: "main" }, { id: "ops", heartbeat: { every: "1h" } }],
      },
    };

    const res = await runHeartbeatOnce({ cfg, agentId: "main" });
    expect(res.status).toBe("skipped");
    if (res.status === "skipped") {
      expect(res.reason).toBe("disabled");
    }
  });

  it("skips outside active hours", async () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          userTimezone: "UTC",
          heartbeat: {
            every: "30m",
            activeHours: { start: "08:00", end: "24:00", timezone: "user" },
          },
        },
      },
    };

    const res = await runHeartbeatOnce({
      cfg,
      deps: { nowMs: () => Date.UTC(2025, 0, 1, 7, 0, 0) },
    });

    expect(res.status).toBe("skipped");
    if (res.status === "skipped") {
      expect(res.reason).toBe("quiet-hours");
    }
  });

  it("uses the last non-empty payload for delivery", async () => {
    const tmpDir = await createCaseDir("hb-last-payload");
    const storePath = path.join(tmpDir, "sessions.json");
    const replySpy = vi.fn();
    try {
      const cfg: OpenClawConfig = {
        agents: {
          defaults: {
            workspace: tmpDir,
            heartbeat: { every: "5m", target: "whatsapp" },
          },
        },
        channels: { whatsapp: { allowFrom: ["*"] } },
        session: { store: storePath },
      };
      const sessionKey = resolveMainSessionKey(cfg);

      await fs.writeFile(
        storePath,
        JSON.stringify({
          [sessionKey]: {
            sessionId: "sid",
            updatedAt: Date.now(),
            lastChannel: "whatsapp",
            lastTo: "120363401234567890@g.us",
          },
        }),
      );

      replySpy.mockResolvedValue([{ text: "Let me check..." }, { text: "Final alert" }]);
      const sendWhatsApp = vi
        .fn<
          (
            to: string,
            text: string,
            opts?: unknown,
          ) => Promise<{ messageId: string; toJid: string }>
        >()
        .mockResolvedValue({
          messageId: "m1",
          toJid: "jid",
        });

      await runHeartbeatOnce({
        cfg,
        deps: createHeartbeatDeps(sendWhatsApp, { getReplyFromConfig: replySpy }),
      });

      expect(sendWhatsApp).toHaveBeenCalledTimes(1);
      expectWhatsAppSendCall(sendWhatsApp, 0, {
        to: "120363401234567890@g.us",
        text: "Final alert",
      });
    } finally {
      replySpy.mockReset();
    }
  });

  it("uses per-agent heartbeat overrides and session keys", async () => {
    const tmpDir = await createCaseDir("hb-agent-overrides");
    const storePath = path.join(tmpDir, "sessions.json");
    const replySpy = vi.fn();
    try {
      const cfg: OpenClawConfig = {
        agents: {
          defaults: {
            heartbeat: { every: "30m", prompt: "Default prompt" },
          },
          list: [
            { id: "main", default: true },
            {
              id: "ops",
              workspace: tmpDir,
              heartbeat: { every: "5m", target: "whatsapp", prompt: "Ops check" },
            },
          ],
        },
        channels: { whatsapp: { allowFrom: ["*"] } },
        session: { store: storePath },
      };
      const sessionKey = resolveAgentMainSessionKey({ cfg, agentId: "ops" });

      await fs.writeFile(
        storePath,
        JSON.stringify({
          [sessionKey]: {
            sessionId: "sid",
            updatedAt: Date.now(),
            lastChannel: "whatsapp",
            lastTo: "120363401234567890@g.us",
          },
        }),
      );
      replySpy.mockResolvedValue([{ text: "Final alert" }]);
      const sendWhatsApp = vi
        .fn<
          (
            to: string,
            text: string,
            opts?: unknown,
          ) => Promise<{ messageId: string; toJid: string }>
        >()
        .mockResolvedValue({
          messageId: "m1",
          toJid: "jid",
        });
      await runHeartbeatOnce({
        cfg,
        agentId: "ops",
        deps: createHeartbeatDeps(sendWhatsApp, { getReplyFromConfig: replySpy }),
      });
      expect(sendWhatsApp).toHaveBeenCalledTimes(1);
      expectWhatsAppSendCall(sendWhatsApp, 0, {
        to: "120363401234567890@g.us",
        text: "Final alert",
      });
      expectReplyCall(
        replySpy,
        0,
        {
          Body: /Ops check[\s\S]*Current time: /,
          SessionKey: sessionKey,
          From: "120363401234567890@g.us",
          To: "120363401234567890@g.us",
          OriginatingChannel: "whatsapp",
          OriginatingTo: "120363401234567890@g.us",
          Provider: "heartbeat",
        },
        { isHeartbeat: true, suppressToolErrorWarnings: false },
        cfg,
      );
    } finally {
      replySpy.mockReset();
    }
  });

  it("reuses non-default agent sessionFile from templated stores", async () => {
    const tmpDir = await createCaseDir("hb-templated-store");
    const storeTemplate = path.join(tmpDir, "agents", "{agentId}", "sessions", "sessions.json");
    const replySpy = vi.fn();
    const agentId = "ops";
    try {
      const cfg: OpenClawConfig = {
        agents: {
          defaults: {
            heartbeat: { every: "30m", prompt: "Default prompt" },
          },
          list: [
            { id: "main", default: true },
            {
              id: agentId,
              workspace: tmpDir,
              heartbeat: { every: "5m", target: "whatsapp", prompt: "Ops check" },
            },
          ],
        },
        channels: { whatsapp: { allowFrom: ["*"] } },
        session: { store: storeTemplate },
      };
      const sessionKey = resolveAgentMainSessionKey({ cfg, agentId });
      const storePath = resolveStorePath(storeTemplate, { agentId });
      const sessionsDir = path.dirname(storePath);
      const sessionId = "sid-ops";
      const sessionFile = path.join(sessionsDir, `${sessionId}.jsonl`);

      await fs.mkdir(sessionsDir, { recursive: true });
      await fs.writeFile(sessionFile, "", "utf-8");
      await fs.writeFile(
        storePath,
        JSON.stringify({
          [sessionKey]: {
            sessionId,
            sessionFile,
            updatedAt: Date.now(),
            lastChannel: "whatsapp",
            lastTo: "120363401234567890@g.us",
          },
        }),
      );

      replySpy.mockResolvedValue([{ text: "Final alert" }]);
      const sendWhatsApp = vi
        .fn<
          (
            to: string,
            text: string,
            opts?: unknown,
          ) => Promise<{ messageId: string; toJid: string }>
        >()
        .mockResolvedValue({
          messageId: "m1",
          toJid: "jid",
        });
      const result = await runHeartbeatOnce({
        cfg,
        agentId,
        deps: createHeartbeatDeps(sendWhatsApp, { getReplyFromConfig: replySpy }),
      });

      expect(result.status).toBe("ran");
      expect(sendWhatsApp).toHaveBeenCalledTimes(1);
      expectWhatsAppSendCall(sendWhatsApp, 0, {
        to: "120363401234567890@g.us",
        text: "Final alert",
      });
      expectReplyCall(
        replySpy,
        0,
        {
          SessionKey: sessionKey,
          From: "120363401234567890@g.us",
          To: "120363401234567890@g.us",
          Provider: "heartbeat",
        },
        { isHeartbeat: true, suppressToolErrorWarnings: false },
        cfg,
      );
    } finally {
      replySpy.mockReset();
    }
  });

  it.each([
    {
      name: "heartbeat.session",
      caseDir: "hb-explicit-session",
      peerKind: "group" as const,
      peerId: "120363401234567890@g.us",
      message: "Group alert",
      applyOverride: ({ cfg, sessionKey }: { cfg: OpenClawConfig; sessionKey: string }) => {
        if (cfg.agents?.defaults?.heartbeat) {
          cfg.agents.defaults.heartbeat.session = sessionKey;
        }
      },
      runOptions: ({ sessionKey: _sessionKey }: { sessionKey: string }) => ({
        sessionKey: undefined as string | undefined,
      }),
    },
    {
      name: "runHeartbeatOnce sessionKey arg",
      caseDir: "hb-forced-session-override",
      peerKind: "group" as const,
      peerId: "120363401234567891@g.us",
      message: "Forced alert",
      applyOverride: () => {},
      runOptions: ({ sessionKey }: { sessionKey: string }) => ({ sessionKey }),
    },
  ])(
    "resolves configured and forced session key overrides: $name",
    async ({ name, caseDir, peerKind, peerId, message, applyOverride, runOptions }) => {
      const replySpy = vi.fn();
      try {
        const tmpDir = await createCaseDir(caseDir);
        const storePath = path.join(tmpDir, "sessions.json");
        const cfg: OpenClawConfig = {
          agents: {
            defaults: {
              workspace: tmpDir,
              heartbeat: {
                every: "5m",
                target: "last",
              },
            },
          },
          channels: { whatsapp: { allowFrom: ["*"] } },
          session: { store: storePath },
        };
        const mainSessionKey = resolveMainSessionKey(cfg);
        const agentId = resolveAgentIdFromSessionKey(mainSessionKey);
        const overrideSessionKey = buildAgentPeerSessionKey({
          agentId,
          channel: "whatsapp",
          peerKind,
          peerId,
        });
        applyOverride({ cfg, sessionKey: overrideSessionKey });

        await fs.writeFile(
          storePath,
          JSON.stringify({
            [mainSessionKey]: {
              sessionId: "sid-main",
              updatedAt: Date.now(),
              lastChannel: "whatsapp",
              lastTo: "120363401234567890@g.us",
            },
            [overrideSessionKey]: {
              sessionId: `sid-${peerKind}`,
              updatedAt: Date.now() + 10_000,
              lastChannel: "whatsapp",
              lastTo: peerId,
            },
          }),
        );

        replySpy.mockClear();
        replySpy.mockResolvedValue([{ text: message }]);
        const sendWhatsApp = vi
          .fn<
            (
              to: string,
              text: string,
              opts?: unknown,
            ) => Promise<{ messageId: string; toJid: string }>
          >()
          .mockResolvedValue({ messageId: "m1", toJid: "jid" });

        await runHeartbeatOnce({
          cfg,
          ...runOptions({ sessionKey: overrideSessionKey }),
          deps: createHeartbeatDeps(sendWhatsApp, { getReplyFromConfig: replySpy }),
        });

        expect(sendWhatsApp, name).toHaveBeenCalledTimes(1);
        expectWhatsAppSendCall(sendWhatsApp, 0, { to: peerId, text: message });
        expectReplyCall(
          replySpy,
          0,
          {
            SessionKey: overrideSessionKey,
            From: peerId,
            To: peerId,
            Provider: "heartbeat",
          },
          { isHeartbeat: true, suppressToolErrorWarnings: false },
          cfg,
        );
      } finally {
        replySpy.mockReset();
      }
    },
  );

  it.each([
    {
      name: "subagent key via forcedSessionKey (opts.sessionKey)",
      injectVia: "opts" as const,
    },
    {
      name: "subagent key via heartbeat.session config",
      injectVia: "config" as const,
    },
  ])("falls back to main session when subagent key enters via $name", async ({ injectVia }) => {
    const replySpy = vi.fn();
    try {
      const tmpDir = await createCaseDir("hb-subagent-guard");
      const storePath = path.join(tmpDir, "sessions.json");
      const cfg: OpenClawConfig = {
        agents: {
          defaults: {
            workspace: tmpDir,
            heartbeat: {
              every: "5m",
              target: "last",
            },
          },
        },
        channels: { whatsapp: { allowFrom: ["*"] } },
        session: { store: storePath },
      };
      const mainSessionKey = resolveMainSessionKey(cfg);
      const agentId = resolveAgentIdFromSessionKey(mainSessionKey);
      const subagentKey = `agent:${agentId}:subagent:task-abc`;

      if (injectVia === "config" && cfg.agents?.defaults?.heartbeat) {
        cfg.agents.defaults.heartbeat.session = subagentKey;
      }

      await fs.writeFile(
        storePath,
        JSON.stringify({
          [mainSessionKey]: {
            sessionId: "sid-main",
            updatedAt: Date.now(),
            lastChannel: "whatsapp",
            lastTo: "120363401234567890@g.us",
          },
          [subagentKey]: {
            sessionId: "sid-subagent",
            updatedAt: Date.now() + 10_000,
            lastChannel: "whatsapp",
            lastTo: "99999@g.us",
          },
        }),
      );

      replySpy.mockClear();
      replySpy.mockResolvedValue([{ text: "Main session heartbeat" }]);
      const sendWhatsApp = vi
        .fn<
          (
            to: string,
            text: string,
            opts?: unknown,
          ) => Promise<{ messageId: string; toJid: string }>
        >()
        .mockResolvedValue({ messageId: "m1", toJid: "jid" });

      await runHeartbeatOnce({
        cfg,
        ...(injectVia === "opts" ? { sessionKey: subagentKey } : {}),
        deps: createHeartbeatDeps(sendWhatsApp, { getReplyFromConfig: replySpy }),
      });

      // The heartbeat must use the main session, not the subagent session.
      expectReplyCall(replySpy, 0, { SessionKey: mainSessionKey });
      // Must NOT use the subagent session key.
      expect(
        replySpy.mock.calls.some(
          ([body]) => requireRecord(body, "reply body").SessionKey === subagentKey,
        ),
      ).toBe(false);
    } finally {
      replySpy.mockReset();
    }
  });

  it("suppresses duplicate heartbeat payloads within 24h", async () => {
    const tmpDir = await createCaseDir("hb-dup-suppress");
    const storePath = path.join(tmpDir, "sessions.json");
    const replySpy = vi.fn();
    try {
      const cfg: OpenClawConfig = {
        agents: {
          defaults: {
            workspace: tmpDir,
            heartbeat: { every: "5m", target: "whatsapp" },
          },
        },
        channels: { whatsapp: { allowFrom: ["*"] } },
        session: { store: storePath },
      };
      const sessionKey = resolveMainSessionKey(cfg);

      await fs.writeFile(
        storePath,
        JSON.stringify({
          [sessionKey]: {
            sessionId: "sid",
            updatedAt: Date.now(),
            lastChannel: "whatsapp",
            lastTo: "120363401234567890@g.us",
            lastHeartbeatText: "Final alert",
            lastHeartbeatSentAt: 0,
          },
        }),
      );

      replySpy.mockResolvedValue([{ text: "Final alert" }]);
      const sendWhatsApp = vi
        .fn<
          (
            to: string,
            text: string,
            opts?: unknown,
          ) => Promise<{ messageId: string; toJid: string }>
        >()
        .mockResolvedValue({ messageId: "m1", toJid: "jid" });

      await runHeartbeatOnce({
        cfg,
        deps: createHeartbeatDeps(sendWhatsApp, {
          nowMs: 60_000,
          getReplyFromConfig: replySpy,
        }),
      });

      expect(sendWhatsApp).toHaveBeenCalledTimes(0);
    } finally {
      replySpy.mockReset();
    }
  });

  it.each(
    typedCases<{
      name: string;
      caseDir: string;
      replies: Array<{ text: string; isReasoning?: boolean }>;
      expectedTexts: string[];
    }>([
      {
        name: "legacy-prefixed reasoning + final payload",
        caseDir: "hb-reasoning",
        replies: [{ text: "Reasoning:\n_Because it helps_" }, { text: "Final alert" }],
        expectedTexts: ["Reasoning:\n_Because it helps_", "Final alert"],
      },
      {
        name: "raw flagged reasoning + final payload",
        caseDir: "hb-reasoning-raw",
        replies: [{ text: "Because it helps", isReasoning: true }, { text: "Final alert" }],
        expectedTexts: ["Reasoning:\n_Because it helps_", "Final alert"],
      },
      {
        name: "raw flagged reasoning + HEARTBEAT_OK",
        caseDir: "hb-reasoning-heartbeat-ok",
        replies: [{ text: "Because it helps", isReasoning: true }, { text: "HEARTBEAT_OK" }],
        expectedTexts: ["Reasoning:\n_Because it helps_"],
      },
    ]),
  )(
    "handles reasoning payload delivery variants: $name",
    async ({ name, caseDir, replies, expectedTexts }) => {
      const replySpy = vi.fn();
      try {
        const tmpDir = await createCaseDir(caseDir);
        const storePath = path.join(tmpDir, "sessions.json");
        const cfg: OpenClawConfig = {
          agents: {
            defaults: {
              workspace: tmpDir,
              heartbeat: {
                every: "5m",
                target: "whatsapp",
                includeReasoning: true,
              },
            },
          },
          channels: { whatsapp: { allowFrom: ["*"] } },
          session: { store: storePath },
        };
        const sessionKey = resolveMainSessionKey(cfg);

        await fs.writeFile(
          storePath,
          JSON.stringify({
            [sessionKey]: {
              sessionId: "sid",
              updatedAt: Date.now(),
              lastChannel: "whatsapp",
              lastProvider: "whatsapp",
              lastTo: "120363401234567890@g.us",
            },
          }),
        );

        replySpy.mockClear();
        replySpy.mockResolvedValue(replies);
        const sendWhatsApp = vi
          .fn<
            (
              to: string,
              text: string,
              opts?: unknown,
            ) => Promise<{ messageId: string; toJid: string }>
          >()
          .mockResolvedValue({ messageId: "m1", toJid: "jid" });

        await runHeartbeatOnce({
          cfg,
          deps: createHeartbeatDeps(sendWhatsApp, { getReplyFromConfig: replySpy }),
        });

        expect(sendWhatsApp, name).toHaveBeenCalledTimes(expectedTexts.length);
        for (const [index, text] of expectedTexts.entries()) {
          expectWhatsAppSendCall(sendWhatsApp, index, {
            to: "120363401234567890@g.us",
            text,
          });
        }
      } finally {
        replySpy.mockReset();
      }
    },
  );

  it("loads the default agent session from templated stores", async () => {
    const tmpDir = await createCaseDir("openclaw-hb");
    const storeTemplate = path.join(tmpDir, "agents", "{agentId}", "sessions.json");
    const replySpy = vi.fn();
    try {
      const cfg: OpenClawConfig = {
        agents: {
          defaults: { workspace: tmpDir, heartbeat: { every: "5m", target: "whatsapp" } },
          list: [{ id: "work", default: true }],
        },
        channels: { whatsapp: { allowFrom: ["*"] } },
        session: { store: storeTemplate },
      };
      const sessionKey = resolveMainSessionKey(cfg);
      const agentId = resolveAgentIdFromSessionKey(sessionKey);
      const storePath = resolveStorePath(storeTemplate, { agentId });

      await fs.mkdir(path.dirname(storePath), { recursive: true });
      await fs.writeFile(
        storePath,
        JSON.stringify({
          [sessionKey]: {
            sessionId: "sid",
            updatedAt: Date.now(),
            lastChannel: "whatsapp",
            lastProvider: "whatsapp",
            lastTo: "120363401234567890@g.us",
          },
        }),
      );

      replySpy.mockResolvedValue({ text: "Hello from heartbeat" });
      const sendWhatsApp = vi
        .fn<
          (
            to: string,
            text: string,
            opts?: unknown,
          ) => Promise<{ messageId: string; toJid: string }>
        >()
        .mockResolvedValue({
          messageId: "m1",
          toJid: "jid",
        });

      await runHeartbeatOnce({
        cfg,
        deps: createHeartbeatDeps(sendWhatsApp, { getReplyFromConfig: replySpy }),
      });

      expect(sendWhatsApp).toHaveBeenCalledTimes(1);
      expectWhatsAppSendCall(sendWhatsApp, 0, {
        to: "120363401234567890@g.us",
        text: "Hello from heartbeat",
      });
    } finally {
      replySpy.mockReset();
    }
  });

  type HeartbeatFileState =
    | "empty"
    | "actionable"
    | "legacy-comment-only"
    | "fenced-empty"
    | "fenced-actionable"
    | "missing"
    | "read-error";

  async function runHeartbeatFileScenario(params: {
    fileState: HeartbeatFileState;
    reason?: "interval" | "wake";
    queueCronEvent?: boolean;
    replyText?: string;
  }) {
    const tmpDir = await createCaseDir("openclaw-hb");
    const storePath = path.join(tmpDir, "sessions.json");
    const workspaceDir = path.join(tmpDir, "workspace");
    await fs.mkdir(workspaceDir, { recursive: true });

    if (params.fileState === "empty") {
      await fs.writeFile(
        path.join(workspaceDir, "HEARTBEAT.md"),
        "# HEARTBEAT.md\n\n## Tasks\n\n",
        "utf-8",
      );
    } else if (params.fileState === "legacy-comment-only") {
      // Compatibility case for the pre-198de10523 template shape, before the
      // docs template started wrapping the scaffold in a fenced ```markdown block.
      await fs.writeFile(
        path.join(workspaceDir, "HEARTBEAT.md"),
        `# Keep this file empty (or with only comments) to skip heartbeat API calls.

# Add tasks below when you want the agent to check something periodically.
`,
        "utf-8",
      );
    } else if (params.fileState === "fenced-empty") {
      await fs.writeFile(
        path.join(workspaceDir, "HEARTBEAT.md"),
        `# HEARTBEAT.md Template

\`\`\`markdown
# Keep this file empty (or with only comments) to skip heartbeat API calls.

# Add tasks below when you want the agent to check something periodically.
\`\`\`
`,
        "utf-8",
      );
    } else if (params.fileState === "actionable") {
      await fs.writeFile(
        path.join(workspaceDir, "HEARTBEAT.md"),
        "# HEARTBEAT.md\n\n- Check server logs\n- Review pending PRs\n",
        "utf-8",
      );
    } else if (params.fileState === "fenced-actionable") {
      await fs.writeFile(
        path.join(workspaceDir, "HEARTBEAT.md"),
        `\`\`\`markdown
# Keep this file empty when you want to skip.

- Check server logs
\`\`\`
`,
        "utf-8",
      );
    } else if (params.fileState === "read-error") {
      // readFile on a directory triggers EISDIR.
      await fs.mkdir(path.join(workspaceDir, "HEARTBEAT.md"), { recursive: true });
    }

    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          workspace: workspaceDir,
          heartbeat: { every: "5m", target: "whatsapp" },
        },
      },
      channels: { whatsapp: { allowFrom: ["*"] } },
      session: { store: storePath },
    };
    const sessionKey = resolveMainSessionKey(cfg);
    await fs.writeFile(
      storePath,
      JSON.stringify({
        [sessionKey]: {
          sessionId: "sid",
          updatedAt: Date.now(),
          lastChannel: "whatsapp",
          lastTo: "120363401234567890@g.us",
        },
      }),
    );
    if (params.queueCronEvent) {
      enqueueSystemEvent("Cron: QMD maintenance completed", {
        sessionKey,
        contextKey: "cron:qmd-maintenance",
      });
    }

    const replySpy = vi.fn();
    replySpy.mockResolvedValue({ text: params.replyText ?? "Checked logs and PRs" });
    const sendWhatsApp = vi
      .fn<
        (to: string, text: string, opts?: unknown) => Promise<{ messageId: string; toJid: string }>
      >()
      .mockResolvedValue({ messageId: "m1", toJid: "jid" });
    const res = await runHeartbeatOnce({
      cfg,
      ...(params.reason === "wake"
        ? { source: "hook" as const, intent: "immediate" as const }
        : params.reason === "interval"
          ? { source: "interval" as const, intent: "scheduled" as const }
          : {}),
      reason: params.reason,
      deps: createHeartbeatDeps(sendWhatsApp, { getReplyFromConfig: replySpy }),
    });
    return { res, replySpy, sendWhatsApp, workspaceDir };
  }

  it("adds explicit workspace HEARTBEAT.md path guidance to heartbeat prompts", async () => {
    const { res, replySpy, sendWhatsApp, workspaceDir } = await runHeartbeatFileScenario({
      fileState: "actionable",
      reason: "interval",
      replyText: "Checked logs and PRs",
    });
    try {
      expect(res.status).toBe("ran");
      expect(sendWhatsApp).toHaveBeenCalledTimes(1);
      expect(replySpy).toHaveBeenCalledTimes(1);
      const calledCtx = replyBody(replySpy);
      const expectedPath = path.join(workspaceDir, "HEARTBEAT.md").replace(/\\/g, "/");
      expect(calledCtx.Body).toContain(`use workspace file ${expectedPath} (exact case)`);
      expect(calledCtx.Body).toContain("Do not read docs/heartbeat.md.");
    } finally {
      replySpy.mockRestore();
    }
  });

  it("keeps non-task HEARTBEAT.md context while stripping blank-line-separated task blocks", async () => {
    const tmpDir = await createCaseDir("openclaw-hb-tasks-context");
    const storePath = path.join(tmpDir, "sessions.json");
    const workspaceDir = path.join(tmpDir, "workspace");
    await fs.mkdir(workspaceDir, { recursive: true });
    await fs.writeFile(
      path.join(workspaceDir, "HEARTBEAT.md"),
      `# Keep this header

Remember escalation policy.

tasks:
  - name: inbox
    interval: 5m
    prompt: Check urgent inbox items

  - name: calendar
    interval: 5m
    prompt: Check calendar changes

Some global directive after tasks.

- Keep this top-level directive too.
`,
      "utf-8",
    );

    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          workspace: workspaceDir,
          heartbeat: { every: "5m", target: "whatsapp" },
        },
      },
      channels: { whatsapp: { allowFrom: ["*"] } },
      session: { store: storePath },
    };
    await fs.writeFile(
      storePath,
      JSON.stringify({
        [resolveMainSessionKey(cfg)]: {
          sessionId: "sid",
          updatedAt: Date.now(),
          lastChannel: "whatsapp",
          lastTo: "120363401234567890@g.us",
        },
      }),
    );
    const replySpy = vi.fn().mockResolvedValue({ text: "Handled due heartbeat tasks" });
    const sendWhatsApp = vi
      .fn<
        (to: string, text: string, opts?: unknown) => Promise<{ messageId: string; toJid: string }>
      >()
      .mockResolvedValue({ messageId: "m1", toJid: "jid" });

    const res = await runHeartbeatOnce({
      cfg,
      deps: createHeartbeatDeps(sendWhatsApp, { getReplyFromConfig: replySpy }),
    });

    expect(res.status).toBe("ran");
    expect(replySpy).toHaveBeenCalledTimes(1);
    const calledCtx = replyBody(replySpy);
    expect(calledCtx.Body).toContain("- inbox: Check urgent inbox items");
    expect(calledCtx.Body).toContain("- calendar: Check calendar changes");
    expect(calledCtx.Body).toContain("Additional context from HEARTBEAT.md");
    expect(calledCtx.Body).toContain("# Keep this header");
    expect(calledCtx.Body).toContain("Remember escalation policy.");
    expect(calledCtx.Body).toContain("Some global directive after tasks.");
    expect(calledCtx.Body).toContain("- Keep this top-level directive too.");
    expect(calledCtx.Body).not.toContain("name: inbox");
    expect(calledCtx.Body).not.toContain("name: calendar");
    replySpy.mockReset();
  });

  it("strips documented unindented task entries while keeping following top-level bullets", async () => {
    const tmpDir = await createCaseDir("openclaw-hb-unindented-tasks-context");
    const storePath = path.join(tmpDir, "sessions.json");
    const workspaceDir = path.join(tmpDir, "workspace");
    await fs.mkdir(workspaceDir, { recursive: true });
    await fs.writeFile(
      path.join(workspaceDir, "HEARTBEAT.md"),
      `# Keep this header

tasks:
- name: inbox
  interval: 5m
  prompt: Check urgent inbox items

- name: calendar
  interval: 5m
  prompt: Check calendar changes

- Keep this top-level directive after tasks.
`,
      "utf-8",
    );

    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          workspace: workspaceDir,
          heartbeat: { every: "5m", target: "whatsapp" },
        },
      },
      channels: { whatsapp: { allowFrom: ["*"] } },
      session: { store: storePath },
    };
    await fs.writeFile(
      storePath,
      JSON.stringify({
        [resolveMainSessionKey(cfg)]: {
          sessionId: "sid",
          updatedAt: Date.now(),
          lastChannel: "whatsapp",
          lastTo: "120363401234567890@g.us",
        },
      }),
    );
    const replySpy = vi.fn().mockResolvedValue({ text: "Handled due heartbeat tasks" });
    const sendWhatsApp = vi
      .fn<
        (to: string, text: string, opts?: unknown) => Promise<{ messageId: string; toJid: string }>
      >()
      .mockResolvedValue({ messageId: "m1", toJid: "jid" });

    const res = await runHeartbeatOnce({
      cfg,
      deps: createHeartbeatDeps(sendWhatsApp, { getReplyFromConfig: replySpy }),
    });

    expect(res.status).toBe("ran");
    expect(replySpy).toHaveBeenCalledTimes(1);
    const calledCtx = replyBody(replySpy);
    expect(calledCtx.Body).toContain("- inbox: Check urgent inbox items");
    expect(calledCtx.Body).toContain("- calendar: Check calendar changes");
    expect(calledCtx.Body).toContain("Additional context from HEARTBEAT.md");
    expect(calledCtx.Body).toContain("# Keep this header");
    expect(calledCtx.Body).toContain("- Keep this top-level directive after tasks.");
    expect(calledCtx.Body).not.toContain("name: inbox");
    expect(calledCtx.Body).not.toContain("name: calendar");
    expect(calledCtx.Body).not.toContain("interval: 5m");
    expect(calledCtx.Body).not.toContain("prompt: Check urgent");
    replySpy.mockReset();
  });

  it("applies HEARTBEAT.md gating rules across file states and triggers", async () => {
    const cases: Array<{
      name: string;
      fileState: HeartbeatFileState;
      reason?: "interval" | "wake";
      queueCronEvent?: boolean;
      expectedStatus: "ran" | "skipped";
      expectedSkipReason?: "empty-heartbeat-file";
      expectedSendCalls: number;
      expectedReplyCalls: number;
      expectCronContext?: boolean;
      replyText?: string;
    }> = [
      {
        name: "empty file + interval skips",
        fileState: "empty",
        expectedStatus: "skipped",
        expectedSkipReason: "empty-heartbeat-file",
        expectedSendCalls: 0,
        expectedReplyCalls: 0,
      },
      {
        name: "legacy comment-only template + interval skips",
        fileState: "legacy-comment-only",
        expectedStatus: "skipped",
        expectedSkipReason: "empty-heartbeat-file",
        expectedSendCalls: 0,
        expectedReplyCalls: 0,
      },
      {
        name: "fenced empty template + interval skips",
        fileState: "fenced-empty",
        expectedStatus: "skipped",
        expectedSkipReason: "empty-heartbeat-file",
        expectedSendCalls: 0,
        expectedReplyCalls: 0,
      },
      {
        name: "empty file + wake runs",
        fileState: "empty",
        reason: "wake",
        expectedStatus: "ran",
        expectedSendCalls: 1,
        expectedReplyCalls: 1,
        replyText: "wake event processed",
      },
      {
        name: "empty file + queued cron interval runs",
        fileState: "empty",
        reason: "interval",
        queueCronEvent: true,
        expectedStatus: "ran",
        expectedSendCalls: 1,
        expectedReplyCalls: 1,
        expectCronContext: true,
        replyText: "Relay this cron update now",
      },
      {
        name: "actionable file runs",
        fileState: "actionable",
        expectedStatus: "ran",
        expectedSendCalls: 1,
        expectedReplyCalls: 1,
      },
      {
        name: "fenced actionable template runs",
        fileState: "fenced-actionable",
        expectedStatus: "ran",
        expectedSendCalls: 1,
        expectedReplyCalls: 1,
      },
      {
        name: "missing file runs",
        fileState: "missing",
        expectedStatus: "ran",
        expectedSendCalls: 1,
        expectedReplyCalls: 1,
      },
      {
        name: "read error runs",
        fileState: "read-error",
        expectedStatus: "ran",
        expectedSendCalls: 1,
        expectedReplyCalls: 1,
      },
      {
        name: "missing file + wake runs",
        fileState: "missing",
        reason: "wake",
        expectedStatus: "ran",
        expectedSendCalls: 1,
        expectedReplyCalls: 1,
        replyText: "wake event processed",
      },
      {
        name: "missing file + queued cron interval runs",
        fileState: "missing",
        reason: "interval",
        queueCronEvent: true,
        expectedStatus: "ran",
        expectedSendCalls: 1,
        expectedReplyCalls: 1,
        expectCronContext: true,
        replyText: "Relay this cron update now",
      },
    ];

    for (const {
      name,
      expectedStatus,
      expectedSkipReason,
      expectedReplyCalls,
      expectedSendCalls,
      expectCronContext,
      ...scenario
    } of cases) {
      const { res, replySpy, sendWhatsApp } = await runHeartbeatFileScenario(scenario);
      try {
        expect(res.status, name).toBe(expectedStatus);
        if (res.status === "skipped") {
          expect(res.reason, name).toBe(expectedSkipReason);
        }
        expect(replySpy, name).toHaveBeenCalledTimes(expectedReplyCalls);
        expect(sendWhatsApp, name).toHaveBeenCalledTimes(expectedSendCalls);
        if (expectCronContext) {
          const calledCtx = replyBody(replySpy);
          expect(calledCtx.Provider, name).toBe("cron-event");
          expect(calledCtx.Body, name).toContain("scheduled reminder has been triggered");
        }
      } finally {
        replySpy.mockReset();
      }
    }
  });

  it("uses an internal-only cron prompt when heartbeat delivery target is none", async () => {
    const tmpDir = await createCaseDir("hb-cron-target-none");
    const storePath = path.join(tmpDir, "sessions.json");
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          workspace: tmpDir,
          heartbeat: { every: "5m", target: "none" },
        },
      },
      channels: { whatsapp: { allowFrom: ["*"] } },
      session: { store: storePath },
    };
    const sessionKey = resolveMainSessionKey(cfg);
    await fs.writeFile(
      storePath,
      JSON.stringify({
        [sessionKey]: {
          sessionId: "sid",
          updatedAt: Date.now(),
          lastChannel: "whatsapp",
          lastTo: "120363401234567890@g.us",
        },
      }),
    );
    enqueueSystemEvent("Cron: rotate logs", {
      sessionKey,
      contextKey: "cron:rotate-logs",
    });

    const replySpy = vi.fn();
    replySpy.mockResolvedValue({ text: "Handled internally" });
    const sendWhatsApp = vi
      .fn<
        (to: string, text: string, opts?: unknown) => Promise<{ messageId: string; toJid: string }>
      >()
      .mockResolvedValue({ messageId: "m1", toJid: "jid" });

    try {
      const res = await runHeartbeatOnce({
        cfg,
        source: "interval",
        intent: "scheduled",
        reason: "interval",
        deps: createHeartbeatDeps(sendWhatsApp, { getReplyFromConfig: replySpy }),
      });
      expect(res.status).toBe("ran");
      expect(sendWhatsApp).toHaveBeenCalledTimes(0);
      const calledCtx = replyBody(replySpy);
      expect(calledCtx.Provider).toBe("cron-event");
      expect(calledCtx.Body).toContain("Handle this reminder internally");
      expect(calledCtx.Body).not.toContain("Please relay this reminder to the user");
    } finally {
      replySpy.mockReset();
    }
  });

  it("uses an internal-only exec prompt when heartbeat delivery target is none", async () => {
    const tmpDir = await createCaseDir("hb-exec-target-none");
    const storePath = path.join(tmpDir, "sessions.json");
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          workspace: tmpDir,
          heartbeat: { every: "5m", target: "none" },
        },
      },
      channels: { whatsapp: { allowFrom: ["*"] } },
      session: { store: storePath },
    };
    const sessionKey = resolveMainSessionKey(cfg);
    await fs.writeFile(
      storePath,
      JSON.stringify({
        [sessionKey]: {
          sessionId: "sid",
          updatedAt: Date.now(),
          lastChannel: "whatsapp",
          lastTo: "120363401234567890@g.us",
        },
      }),
    );
    enqueueSystemEvent("exec finished: backup completed", {
      sessionKey,
      contextKey: "exec:backup",
    });

    const replySpy = vi.fn();
    replySpy.mockResolvedValue({ text: "Handled internally" });
    const sendWhatsApp = vi
      .fn<
        (to: string, text: string, opts?: unknown) => Promise<{ messageId: string; toJid: string }>
      >()
      .mockResolvedValue({ messageId: "m1", toJid: "jid" });

    try {
      const res = await runHeartbeatOnce({
        cfg,
        source: "exec-event",
        intent: "event",
        reason: "exec-event",
        deps: createHeartbeatDeps(sendWhatsApp, { getReplyFromConfig: replySpy }),
      });
      expect(res.status).toBe("ran");
      expect(sendWhatsApp).toHaveBeenCalledTimes(0);
      const calledCtx = replyBody(replySpy);
      expect(calledCtx.Provider).toBe("exec-event");
      expect(calledCtx.ForceSenderIsOwnerFalse).toBe(true);
      expect(calledCtx.Body).toContain("Handle the result internally");
      expect(calledCtx.Body).not.toContain("Please relay the command output to the user");
    } finally {
      replySpy.mockReset();
    }
  });
});
