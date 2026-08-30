// Health snapshot tests cover channel, session, runtime, and gateway health snapshot construction.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelAccountSnapshot, ChannelPlugin } from "../channels/plugins/types.public.js";
import { isInternalSessionEffectsKey } from "../config/sessions/internal-session-key.js";
import type { HealthSummary } from "../gateway/health/types.js";
import { createPluginRecord } from "../plugins/status.test-fixtures.js";
import { parseAgentSessionKey } from "../routing/session-key.js";
import {
  createLegacyHealthSnapshotCollector,
  type LegacyHealthSnapshotParams,
} from "./health.snapshot.test-support.js";

let testConfig: Record<string, unknown> = {};
let testStore: Record<string, { updatedAt?: number }> = {};
let listHealthSessionEntriesCalls: Array<{ agentId?: string; storePath?: string }> = [];
let healthPluginsForTest: HealthTestPlugin[] = [];

let setActivePluginRegistry: typeof import("../plugins/runtime.js").setActivePluginRegistry;
let setActiveDegradedPlugins: typeof import("../plugins/runtime-degraded-state.js").setActiveDegradedPlugins;
let createChannelTestPluginBase: typeof import("../test-utils/channel-plugins.js").createChannelTestPluginBase;
let createTestRegistry: typeof import("../test-utils/channel-plugins.js").createTestRegistry;
let getHealthSnapshot: (params?: LegacyHealthSnapshotParams) => Promise<HealthSummary>;
let buildTelegramHealthSummaryForTest = buildTelegramHealthSummary;
let probeTelegramAccountForTestOverride:
  | ((account: TelegramHealthAccount, timeoutMs: number) => Promise<Record<string, unknown>>)
  | undefined;

type HealthTestPlugin = Pick<ChannelPlugin, "id" | "meta" | "capabilities" | "config" | "status">;

type TelegramHealthAccount = {
  accountId: string;
  token: string;
  configured: boolean;
  config: {
    proxy?: string;
    network?: Record<string, unknown>;
    apiRoot?: string;
  };
};

type DiscordHealthAccount = {
  accountId: string;
  token: string;
  tokenSource: string;
  tokenStatus?: "available" | "configured_unavailable" | "missing";
  enabled: boolean;
  configured: boolean;
};

type IMessageHealthAccount = {
  accountId: string;
  enabled: boolean;
  configured: boolean;
};

async function loadFreshHealthModulesForTest() {
  vi.doMock("../config/config.js", () => ({
    getRuntimeConfig: () => testConfig,
    loadConfig: () => testConfig,
  }));
  vi.doMock("../config/sessions.js", () => ({
    resolveSessionStorePathCore: () => "/tmp/sessions.json",
    resolveSessionFilePathCore: vi.fn(() => "/tmp/sessions.json"),
    loadSessionStore: () => testStore,
    saveSessionStore: vi.fn().mockResolvedValue(undefined),
    readSessionUpdatedAt: vi.fn(() => undefined),
    recordSessionMetaFromInbound: vi.fn().mockResolvedValue(undefined),
    updateLastRoute: vi.fn().mockResolvedValue(undefined),
  }));
  vi.doMock("../config/sessions/paths.js", () => ({
    resolveSessionStorePathCore: () => "/tmp/sessions.json",
  }));
  vi.doMock("../config/sessions/session-accessor.js", () => ({
    readSessionStoreSummaryReadOnly: (
      ...[scope, options]: Parameters<
        typeof import("../config/sessions/session-accessor.js").readSessionStoreSummaryReadOnly
      >
    ) => {
      listHealthSessionEntriesCalls.push(scope);
      const entries = Object.entries(testStore)
        .filter(
          ([sessionKey]) =>
            parseAgentSessionKey(sessionKey) !== null && !isInternalSessionEffectsKey(sessionKey),
        )
        .map(([sessionKey, entry]) => ({
          sessionKey,
          entry: { sessionId: sessionKey, updatedAt: 0, ...entry },
        }))
        .toSorted(
          (left, right) =>
            right.entry.updatedAt - left.entry.updatedAt ||
            (left.sessionKey < right.sessionKey ? -1 : 1),
        );
      return {
        count: entries.length,
        recent: entries.slice(0, options.recentLimit),
        byAgent: new Map(
          options.agentIds.map((agentId) => {
            const owned = entries.filter(
              ({ sessionKey }) => parseAgentSessionKey(sessionKey)?.agentId === agentId,
            );
            return [agentId, { count: owned.length, recent: owned.slice(0, options.recentLimit) }];
          }),
        ),
      };
    },
  }));
  vi.doMock("../plugins/runtime/runtime-web-channel-plugin.js", () => ({
    webAuthExists: vi.fn(async () => true),
    getWebAuthAgeMs: vi.fn(() => 1234),
    readWebSelfId: vi.fn(() => ({ e164: null, jid: null })),
    logWebSelfId: vi.fn(),
    logoutWeb: vi.fn(),
  }));
  vi.doMock("../channels/plugins/read-only.js", () => ({
    listReadOnlyChannelPluginsForConfig: () => healthPluginsForTest,
  }));

  const [pluginsRuntime, pluginDegradedState, channelTestUtils, health] = await Promise.all([
    import("../plugins/runtime.js"),
    import("../plugins/runtime-degraded-state.js"),
    import("../test-utils/channel-plugins.js"),
    import("../gateway/health/collector.js"),
  ]);
  const collectSnapshot = health.collectGatewayHealthSnapshot;

  return {
    setActivePluginRegistry: pluginsRuntime.setActivePluginRegistry,
    setActiveDegradedPlugins: pluginDegradedState.setActiveDegradedPlugins,
    createChannelTestPluginBase: channelTestUtils.createChannelTestPluginBase,
    createTestRegistry: channelTestUtils.createTestRegistry,
    getHealthSnapshot: createLegacyHealthSnapshotCollector(collectSnapshot),
  };
}

function getTelegramChannelConfig(cfg: Record<string, unknown>) {
  const channels = cfg.channels as Record<string, unknown> | undefined;
  return (channels?.telegram as Record<string, unknown> | undefined) ?? {};
}

function listTelegramAccountIdsForTest(cfg: Record<string, unknown>): string[] {
  const telegram = getTelegramChannelConfig(cfg);
  const accounts = telegram.accounts as Record<string, unknown> | undefined;
  const ids: string[] = [];
  for (const accountId of Object.keys(accounts ?? {})) {
    if (accountId) {
      ids.push(accountId);
    }
  }
  return ids.length > 0 ? ids : ["default"];
}

function readTokenFromFile(tokenFile: unknown): string {
  if (typeof tokenFile !== "string" || !tokenFile.trim()) {
    return "";
  }
  try {
    return fs.readFileSync(tokenFile, "utf8").trim();
  } catch {
    return "";
  }
}

function resolveTelegramAccountForTest(params: {
  cfg: Record<string, unknown>;
  accountId?: string | null;
}): TelegramHealthAccount {
  const telegram = getTelegramChannelConfig(params.cfg);
  const accounts = (telegram.accounts as Record<string, Record<string, unknown>> | undefined) ?? {};
  const accountId = params.accountId?.trim() || "default";
  const channelConfig = { ...telegram };
  delete (channelConfig as { accounts?: unknown }).accounts;
  const merged = {
    ...channelConfig,
    ...accounts[accountId],
  };
  const tokenFromConfig =
    typeof merged.botToken === "string" && merged.botToken.trim() ? merged.botToken.trim() : "";
  const token =
    tokenFromConfig ||
    readTokenFromFile(merged.tokenFile) ||
    (accountId === "default" ? (process.env.TELEGRAM_BOT_TOKEN?.trim() ?? "") : "");
  return {
    accountId,
    token,
    configured: token.length > 0,
    config: {
      ...(typeof merged.proxy === "string" && merged.proxy.trim()
        ? { proxy: merged.proxy.trim() }
        : {}),
      ...(merged.network && typeof merged.network === "object" && !Array.isArray(merged.network)
        ? { network: merged.network as Record<string, unknown> }
        : {}),
      ...(typeof merged.apiRoot === "string" && merged.apiRoot.trim()
        ? { apiRoot: merged.apiRoot.trim() }
        : {}),
    },
  };
}

function buildTelegramHealthSummary(snapshot: {
  accountId: string;
  configured?: boolean;
  probe?: unknown;
  lastProbeAt?: number | null;
}) {
  const probeRecord =
    snapshot.probe && typeof snapshot.probe === "object"
      ? (snapshot.probe as Record<string, unknown>)
      : null;
  return {
    accountId: snapshot.accountId,
    configured: Boolean(snapshot.configured),
    ...(probeRecord ? { probe: probeRecord } : {}),
    ...(snapshot.lastProbeAt ? { lastProbeAt: snapshot.lastProbeAt } : {}),
  };
}

async function probeTelegramAccountForTest(
  account: TelegramHealthAccount,
  timeoutMs: number,
): Promise<Record<string, unknown>> {
  const started = Date.now();
  const apiRoot = account.config.apiRoot?.trim()?.replace(/\/+$/, "") || "https://api.telegram.org";
  const base = `${apiRoot}/bot${account.token}`;

  try {
    const meRes = await fetch(`${base}/getMe`, { signal: AbortSignal.timeout(timeoutMs) });
    const meJson = (await meRes.json()) as {
      ok?: boolean;
      description?: string;
      result?: { id?: number; username?: string };
    };
    if (!meRes.ok || !meJson.ok) {
      return {
        ok: false,
        status: meRes.status,
        error: meJson.description ?? `getMe failed (${meRes.status})`,
        elapsedMs: Date.now() - started,
      };
    }

    let webhook: { url?: string | null; hasCustomCert?: boolean | null } | undefined;
    try {
      const webhookRes = await fetch(`${base}/getWebhookInfo`, {
        signal: AbortSignal.timeout(timeoutMs),
      });
      const webhookJson = (await webhookRes.json()) as {
        ok?: boolean;
        result?: { url?: string; has_custom_certificate?: boolean };
      };
      if (webhookRes.ok && webhookJson.ok) {
        webhook = {
          url: webhookJson.result?.url ?? null,
          hasCustomCert: webhookJson.result?.has_custom_certificate ?? null,
        };
      }
    } catch {
      // ignore webhook errors in probe flow
    }

    return {
      ok: true,
      status: null,
      error: null,
      elapsedMs: Date.now() - started,
      bot: {
        id: meJson.result?.id ?? null,
        username: meJson.result?.username ?? null,
      },
      ...(webhook ? { webhook } : {}),
    };
  } catch (error) {
    return {
      ok: false,
      status: null,
      error: error instanceof Error ? error.message : String(error),
      elapsedMs: Date.now() - started,
    };
  }
}

function stubTelegramFetchOk(calls: string[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      calls.push(url);
      if (url.includes("/getMe")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            ok: true,
            result: { id: 1, username: "bot" },
          }),
        } as unknown as Response;
      }
      if (url.includes("/getWebhookInfo")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            ok: true,
            result: {
              url: "https://example.com/h",
              has_custom_certificate: false,
            },
          }),
        } as unknown as Response;
      }
      return {
        ok: false,
        status: 404,
        json: async () => ({ ok: false, description: "nope" }),
      } as unknown as Response;
    }),
  );
}

async function runSuccessfulTelegramProbe(
  config: Record<string, unknown>,
  options?: { clearTokenEnv?: boolean },
) {
  testConfig = config;
  testStore = {};
  vi.stubEnv("DISCORD_BOT_TOKEN", "");
  if (options?.clearTokenEnv) {
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "");
  }

  const calls: string[] = [];
  stubTelegramFetchOk(calls);

  const snap = await getHealthSnapshot({ timeoutMs: 25 });
  const telegram = snap.channels.telegram as {
    configured?: boolean;
    probe?: {
      ok?: boolean;
      bot?: { username?: string };
      webhook?: { url?: string };
    };
  };

  return { calls, telegram };
}

function createTelegramHealthPlugin(): HealthTestPlugin {
  return {
    ...createChannelTestPluginBase({ id: "telegram", label: "Telegram" }),
    config: {
      listAccountIds: (cfg) => listTelegramAccountIdsForTest(cfg as Record<string, unknown>),
      resolveAccount: (cfg, accountId) =>
        resolveTelegramAccountForTest({ cfg: cfg as Record<string, unknown>, accountId }),
      inspectAccount: (cfg, accountId) =>
        resolveTelegramAccountForTest({ cfg: cfg as Record<string, unknown>, accountId }),
      isConfigured: (account) => Boolean((account as TelegramHealthAccount).token.trim()),
    },
    status: {
      buildChannelSummary: ({ snapshot }) => buildTelegramHealthSummaryForTest(snapshot),
      probeAccount: async ({ account, timeoutMs }) =>
        await (probeTelegramAccountForTestOverride ?? probeTelegramAccountForTest)(
          account as TelegramHealthAccount,
          timeoutMs,
        ),
    },
  };
}

function resolveDiscordHealthAccountForTest(params: {
  cfg: Record<string, unknown>;
  accountId?: string | null;
}): DiscordHealthAccount {
  const channels = params.cfg.channels as Record<string, unknown> | undefined;
  const discord = (channels?.discord as Record<string, unknown> | undefined) ?? {};
  const accountId = params.accountId?.trim() || "default";
  const token = typeof discord.token === "string" ? discord.token.trim() : "";
  return {
    accountId,
    token,
    tokenSource: token ? "config" : "none",
    ...(token ? { tokenStatus: "available" as const } : {}),
    enabled: discord.enabled !== false,
    configured: Boolean(token),
  };
}

function inspectDiscordHealthAccountForTest(params: {
  cfg: Record<string, unknown>;
  accountId?: string | null;
}): DiscordHealthAccount {
  const channels = params.cfg.channels as Record<string, unknown> | undefined;
  const discord = (channels?.discord as Record<string, unknown> | undefined) ?? {};
  const accountId = params.accountId?.trim() || "default";
  const token = typeof discord.token === "string" ? discord.token.trim() : "";
  const tokenStatus =
    token.length > 0
      ? "available"
      : discord.token && typeof discord.token === "object"
        ? "configured_unavailable"
        : "missing";
  return {
    accountId,
    token,
    tokenSource: tokenStatus === "missing" ? "none" : "config",
    tokenStatus,
    enabled: discord.enabled !== false,
    configured: tokenStatus !== "missing",
  };
}

function createDiscordHealthPlugin(): HealthTestPlugin {
  return {
    ...createChannelTestPluginBase({ id: "discord", label: "Discord" }),
    config: {
      listAccountIds: () => ["default"],
      resolveAccount: (cfg, accountId) =>
        resolveDiscordHealthAccountForTest({
          cfg: cfg as Record<string, unknown>,
          accountId,
        }),
      inspectAccount: (cfg, accountId) =>
        inspectDiscordHealthAccountForTest({
          cfg: cfg as Record<string, unknown>,
          accountId,
        }),
      isEnabled: (account) => (account as DiscordHealthAccount).enabled,
      isConfigured: (account) => (account as DiscordHealthAccount).configured,
    },
    status: {
      buildAccountSnapshot: ({ account, runtime }) => {
        const resolved = account as DiscordHealthAccount;
        return {
          accountId: resolved.accountId,
          enabled: resolved.enabled,
          configured: resolved.configured,
          tokenSource: resolved.tokenSource,
          tokenStatus: resolved.tokenStatus,
          running: runtime?.running ?? false,
          connected: runtime?.connected ?? false,
          lastConnectedAt: runtime?.lastConnectedAt ?? null,
        } satisfies ChannelAccountSnapshot;
      },
      buildChannelSummary: ({ snapshot }) => ({
        configured: snapshot.configured ?? false,
        tokenSource: snapshot.tokenSource ?? "none",
        tokenStatus: snapshot.tokenStatus,
        running: snapshot.running ?? false,
        connected: snapshot.connected ?? false,
      }),
    },
  };
}

function createIMessageHealthPlugin(): HealthTestPlugin {
  return {
    ...createChannelTestPluginBase({ id: "imessage", label: "iMessage" }),
    config: {
      listAccountIds: () => ["default"],
      resolveAccount: (_cfg, accountId) => ({
        accountId: accountId?.trim() || "default",
        enabled: true,
        configured: true,
      }),
      inspectAccount: (_cfg, accountId) => ({
        accountId: accountId?.trim() || "default",
        enabled: true,
        configured: true,
      }),
      isEnabled: (account) => (account as IMessageHealthAccount).enabled,
      isConfigured: (account) => (account as IMessageHealthAccount).configured,
    },
    status: {
      buildChannelSummary: ({ snapshot }) => ({
        accountId: snapshot.accountId,
        configured: Boolean(snapshot.configured),
        ...(snapshot.probe && typeof snapshot.probe === "object" ? { probe: snapshot.probe } : {}),
      }),
      probeAccount: async () => ({
        ok: false,
        error:
          "imsg cannot access /Users/alice/Library/Messages/chat.db. Grant Full Disk Access to the Gateway/launcher process and restart Gateway. privateApi=/tmp/openclaw/private.sock",
        privateApi: {
          rpcCommand: "imsg rpc --json",
          diagnostics: "sensitive transport details",
        },
      }),
    },
  };
}

describe("collectGatewayHealthSnapshot", () => {
  beforeAll(async () => {
    ({
      setActivePluginRegistry,
      setActiveDegradedPlugins,
      createChannelTestPluginBase,
      createTestRegistry,
      getHealthSnapshot,
    } = await loadFreshHealthModulesForTest());
  });

  beforeEach(() => {
    // Freeze payload time; collector.deadline.test.ts owns deadline advancement.
    vi.useFakeTimers({ toFake: ["Date"] });
    setActiveDegradedPlugins([]);
    buildTelegramHealthSummaryForTest = buildTelegramHealthSummary;
    probeTelegramAccountForTestOverride = undefined;
    listHealthSessionEntriesCalls = [];
    healthPluginsForTest = [createTelegramHealthPlugin()];
    setActivePluginRegistry(
      createTestRegistry([
        { pluginId: "telegram", plugin: createTelegramHealthPlugin(), source: "test" },
      ]),
    );
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("does not let callers widen the gateway probe deadline", async () => {
    testConfig = {
      session: { store: "/tmp/x" },
      channels: { telegram: { botToken: "123:test" } },
    };
    testStore = {};
    const timeouts: number[] = [];
    probeTelegramAccountForTestOverride = async (_account, timeoutMs) => {
      timeouts.push(timeoutMs);
      return { ok: true };
    };

    await getHealthSnapshot({ timeoutMs: Number.MAX_SAFE_INTEGER });

    expect(timeouts).toHaveLength(1);
    expect(timeouts[0]).toBeGreaterThan(0);
    expect(timeouts[0]).toBeLessThanOrEqual(7_000);
  });

  it("includes active plugin load errors in the health snapshot", async () => {
    testConfig = { session: { store: "/tmp/x" } };
    testStore = {};
    setActivePluginRegistry({
      ...createTestRegistry([]),
      plugins: [
        createPluginRecord({ id: "telegram", origin: "bundled", status: "loaded" }),
        createPluginRecord({
          id: "whatsapp",
          origin: "bundled",
          status: "error",
          activated: true,
          activationSource: "explicit",
          activationReason: "bundled-channel-enabled-in-config",
          failurePhase: "load",
          error: "failed to load plugin dependency: ENOSPC",
        }),
        createPluginRecord({
          id: "optional-broken",
          origin: "workspace",
          enabled: false,
          activated: false,
          status: "error",
          error: "disabled plugin ignored",
        }),
      ],
    });

    const snap = await getHealthSnapshot({ timeoutMs: 10, probe: false });

    expect(snap.plugins?.loaded).toEqual(["telegram"]);
    expect(snap.plugins?.errors).toEqual([
      {
        id: "optional-broken",
        origin: "workspace",
        activated: false,
        activationSource: "disabled",
        error: "disabled plugin ignored",
      },
      {
        id: "whatsapp",
        origin: "bundled",
        activated: true,
        activationSource: "explicit",
        activationReason: "bundled-channel-enabled-in-config",
        failurePhase: "load",
        error: "failed to load plugin dependency: ENOSPC",
      },
    ]);
  });

  it("omits configReload when no config reloader status is supplied", async () => {
    testConfig = { session: { store: "/tmp/x" } };
    testStore = {};

    const snap = await getHealthSnapshot({ timeoutMs: 10, probe: false });

    expect(snap.configReload).toBeUndefined();
  });

  it("surfaces a disabled config hot-reload watcher in the health snapshot", async () => {
    testConfig = { session: { store: "/tmp/x" } };
    testStore = {};

    const snap = await getHealthSnapshot({
      timeoutMs: 10,
      probe: false,
      configReloadHotReloadStatus: "disabled",
    });

    expect(snap.configReload).toEqual({ hotReloadStatus: "disabled" });
  });

  it("skips telegram probe when not configured", async () => {
    testConfig = { session: { store: "/tmp/x" } };
    testStore = {
      global: { updatedAt: Date.now() },
      unknown: { updatedAt: Date.now() },
      "agent:main:main": { updatedAt: 1000 },
      "agent:main:foo": { updatedAt: 2000 },
    };
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "");
    vi.stubEnv("DISCORD_BOT_TOKEN", "");
    const snap = (await getHealthSnapshot({
      timeoutMs: 10,
    })) satisfies HealthSummary;
    expect(snap.ok).toBe(true);
    const telegram = snap.channels.telegram as {
      configured?: boolean;
      probe?: unknown;
    };
    expect(telegram.configured).toBe(false);
    expect(telegram.probe).toBeUndefined();
    expect(snap.sessions.count).toBe(2);
    expect(snap.sessions.recent[0]?.key).toBe("agent:main:foo");
  });

  it("probes telegram getMe + webhook info when configured", async () => {
    const { calls, telegram } = await runSuccessfulTelegramProbe({
      channels: { telegram: { botToken: "t-1" } },
    });
    expect(telegram.configured).toBe(true);
    expect(telegram.probe?.ok).toBe(true);
    expect(telegram.probe?.bot?.username).toBe("bot");
    expect(telegram.probe?.webhook?.url).toMatch(/^https:/);
    expect(calls.join("\n")).toContain("/getMe");
    expect(calls.join("\n")).toContain("/getWebhookInfo");

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-health-"));
    const tokenFile = path.join(tmpDir, "telegram-token");
    try {
      fs.writeFileSync(tokenFile, "t-file\n", "utf-8");
      const tokenFileProbe = await runSuccessfulTelegramProbe(
        { channels: { telegram: { tokenFile } } },
        { clearTokenEnv: true },
      );
      expect(tokenFileProbe.telegram.configured).toBe(true);
      expect(tokenFileProbe.telegram.probe?.ok).toBe(true);
      expect(tokenFileProbe.calls.join("\n")).toContain("bott-file/getMe");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("preserves runtime state and probe payloads when plugin summaries omit them", async () => {
    testConfig = { channels: { telegram: { botToken: "t-1" } } };
    testStore = {};
    vi.stubEnv("DISCORD_BOT_TOKEN", "");
    buildTelegramHealthSummaryForTest = (snapshot) => ({
      accountId: snapshot.accountId,
      configured: Boolean(snapshot.configured),
    });
    probeTelegramAccountForTestOverride = async () => ({
      ok: true,
      bot: { username: "runtime_bot" },
    });

    const snap = await getHealthSnapshot({
      timeoutMs: 25,
      runtimeSnapshot: {
        channels: {
          telegram: {
            accountId: "default",
            running: true,
            connected: true,
            lastConnectedAt: 123,
            healthState: "reconnecting",
          },
        },
        channelAccounts: {},
      },
    });
    type RuntimeStateFields = {
      running?: boolean;
      connected?: boolean;
      lastConnectedAt?: number;
      healthState?: string;
      probe?: { ok?: boolean; bot?: { username?: string } };
    };
    const telegram = snap.channels.telegram as RuntimeStateFields & {
      accounts?: Record<string, RuntimeStateFields>;
    };

    expect(telegram.running).toBe(true);
    expect(telegram.connected).toBe(true);
    expect(telegram.lastConnectedAt).toBe(123);
    expect(telegram.healthState).toBe("reconnecting");
    expect(telegram.probe?.bot?.username).toBe("runtime_bot");
    expect(telegram.accounts?.default?.running).toBe(true);
    expect(telegram.accounts?.default?.connected).toBe(true);
    expect(telegram.accounts?.default?.healthState).toBe("reconnecting");
    expect(telegram.accounts?.default?.probe?.ok).toBe(true);
  });

  it("merges inspected account metadata with runtime state before building health summaries", async () => {
    testConfig = { channels: { discord: { token: "discord-token" } } };
    testStore = {};
    healthPluginsForTest = [createDiscordHealthPlugin()];

    const snap = await getHealthSnapshot({
      probe: false,
      includeSensitive: false,
      runtimeSnapshot: {
        channels: {
          discord: {
            accountId: "default",
            running: true,
            connected: true,
            lastConnectedAt: 123,
          },
        },
        channelAccounts: {},
      },
    });
    const discord = snap.channels.discord as {
      configured?: boolean;
      running?: boolean;
      connected?: boolean;
      tokenSource?: string;
      tokenStatus?: string;
      accounts?: Record<
        string,
        {
          configured?: boolean;
          running?: boolean;
          connected?: boolean;
          tokenSource?: string;
          tokenStatus?: string;
        }
      >;
    };

    expect(discord.configured).toBe(true);
    expect(discord.running).toBe(true);
    expect(discord.connected).toBe(true);
    expect(discord.tokenSource).toBe("config");
    expect(discord.tokenStatus).toBe("available");
    expect(discord.accounts?.default?.configured).toBe(true);
    expect(discord.accounts?.default?.running).toBe(true);
    expect(discord.accounts?.default?.connected).toBe(true);
    expect(discord.accounts?.default?.tokenSource).toBe("config");
    expect(discord.accounts?.default?.tokenStatus).toBe("available");
  });

  it("redacts base URL credentials returned by channel summary hooks", async () => {
    testConfig = { channels: { discord: { token: "test" } } };
    testStore = {};
    const plugin = createDiscordHealthPlugin();
    plugin.status = {
      ...plugin.status,
      buildChannelSummary: () => ({
        configured: true,
        baseUrl: [
          "https://summary-user",
          ":",
          "summary-pass",
          "@chat.example.test/?to",
          "ken=test",
        ].join(""),
      }),
    };
    healthPluginsForTest = [plugin];

    const snap = await getHealthSnapshot({ probe: false, includeSensitive: false });
    const discord = snap.channels.discord as {
      baseUrl?: string;
      accounts?: Record<string, { baseUrl?: string }>;
    };

    expect(discord.baseUrl).toBe("https://chat.example.test/?token=***");
    expect(discord.accounts?.default?.baseUrl).toBe("https://chat.example.test/?token=***");
  });

  it("preserves plugin-derived configured state for unavailable SecretRef credentials", async () => {
    testConfig = {
      channels: {
        discord: {
          token: {
            source: "env",
            provider: "default",
            id: "MISSING_DISCORD_BOT_TOKEN",
          },
        },
      },
    };
    testStore = {};
    healthPluginsForTest = [createDiscordHealthPlugin()];

    const snap = await getHealthSnapshot({
      probe: false,
      includeSensitive: false,
      runtimeSnapshot: {
        channels: {
          discord: {
            accountId: "default",
            running: true,
            connected: true,
          },
        },
        channelAccounts: {},
      },
    });
    const discord = snap.channels.discord as {
      configured?: boolean;
      tokenSource?: string;
      tokenStatus?: string;
      accounts?: Record<
        string,
        {
          configured?: boolean;
          tokenSource?: string;
          tokenStatus?: string;
        }
      >;
    };

    expect(discord.configured).toBe(true);
    expect(discord.tokenSource).toBe("config");
    expect(discord.tokenStatus).toBe("configured_unavailable");
    expect(discord.accounts?.default?.configured).toBe(true);
    expect(discord.accounts?.default?.tokenSource).toBe("config");
    expect(discord.accounts?.default?.tokenStatus).toBe("configured_unavailable");
  });

  it("omits secret runtime fields and raw probe payloads from non-sensitive health snapshots", async () => {
    testConfig = { channels: { telegram: { botToken: "t-1" } } };
    testStore = {};
    vi.stubEnv("DISCORD_BOT_TOKEN", "");
    buildTelegramHealthSummaryForTest = (snapshot) => ({
      accountId: snapshot.accountId,
      configured: Boolean(snapshot.configured),
      probe: { ok: true, token: "test-token" },
    });
    probeTelegramAccountForTestOverride = async () => ({
      ok: true,
      bot: { username: "runtime_bot" },
      token: "test-token",
    });

    const snap = await getHealthSnapshot({
      timeoutMs: 25,
      includeSensitive: false,
      runtimeSnapshot: {
        channels: {
          telegram: {
            accountId: "default",
            connected: true,
            lastConnectedAt: 123,
            channelAccessToken: "line-token",
            channelSecret: "line-secret", // pragma: allowlist secret
            webhookUrl: "https://example.test/hook?secret=1",
          },
        },
        channelAccounts: {},
      },
    });
    const telegram = snap.channels.telegram as {
      connected?: boolean;
      lastConnectedAt?: number;
      probe?: unknown;
      channelAccessToken?: string;
      channelSecret?: string;
      webhookUrl?: string;
      accounts?: Record<
        string,
        {
          connected?: boolean;
          lastConnectedAt?: number;
          probe?: unknown;
          channelAccessToken?: string;
          channelSecret?: string;
          webhookUrl?: string;
        }
      >;
    };

    expect(telegram.connected).toBe(true);
    expect(telegram.lastConnectedAt).toBe(123);
    expect(telegram.probe).toBeUndefined();
    expect(telegram.channelAccessToken).toBeUndefined();
    expect(telegram.channelSecret).toBeUndefined();
    expect(telegram.webhookUrl).toBeUndefined();
    expect(telegram.accounts?.default?.connected).toBe(true);
    expect(telegram.accounts?.default?.probe).toBeUndefined();
    expect(telegram.accounts?.default?.channelAccessToken).toBeUndefined();
  });

  it("keeps redacted failed probes in non-sensitive health snapshots", async () => {
    healthPluginsForTest = [createIMessageHealthPlugin()];
    testConfig = { channels: { imessage: { enabled: true } } };
    testStore = {};

    const snap = await getHealthSnapshot({
      timeoutMs: 25,
      includeSensitive: false,
    });
    const imessage = snap.channels.imessage as {
      configured?: boolean;
      probe?: {
        ok?: boolean;
        error?: string;
        privateApi?: unknown;
      };
      accounts?: Record<
        string,
        {
          probe?: {
            ok?: boolean;
            error?: string;
            privateApi?: unknown;
          };
        }
      >;
    };

    expect(imessage.configured).toBe(true);
    expect(imessage.probe).toEqual({
      ok: false,
      error:
        "imsg cannot access ~/Library/Messages/chat.db. Grant Full Disk Access to the Gateway/launcher process and restart Gateway.",
    });
    expect(imessage.probe?.privateApi).toBeUndefined();
    expect(imessage.accounts?.default?.probe).toEqual({
      ok: false,
      error:
        "imsg cannot access ~/Library/Messages/chat.db. Grant Full Disk Access to the Gateway/launcher process and restart Gateway.",
    });
    expect(imessage.accounts?.default?.probe?.privateApi).toBeUndefined();
  });

  it("omits generic failed probe errors from non-sensitive health snapshots", async () => {
    testConfig = { channels: { telegram: { botToken: "bad-token" } } };
    testStore = {};
    vi.stubEnv("DISCORD_BOT_TOKEN", "");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down with private diagnostic");
      }),
    );

    const snap = await getHealthSnapshot({
      timeoutMs: 25,
      includeSensitive: false,
    });
    const telegram = snap.channels.telegram as {
      configured?: boolean;
      probe?: unknown;
      accounts?: Record<string, { probe?: unknown }>;
    };

    expect(telegram.configured).toBe(true);
    expect(telegram.probe).toBeUndefined();
    expect(telegram.accounts?.default?.probe).toBeUndefined();
  });

  it("returns structured telegram probe errors", async () => {
    testConfig = { channels: { telegram: { botToken: "bad-token" } } };
    testStore = {};
    vi.stubEnv("DISCORD_BOT_TOKEN", "");

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("/getMe")) {
          return {
            ok: false,
            status: 401,
            json: async () => ({ ok: false, description: "unauthorized" }),
          } as unknown as Response;
        }
        throw new Error("unexpected");
      }),
    );

    const snap = await getHealthSnapshot({ timeoutMs: 25 });
    const telegram = snap.channels.telegram as {
      configured?: boolean;
      probe?: { ok?: boolean; status?: number; error?: string };
    };
    expect(telegram.configured).toBe(true);
    expect(telegram.probe?.ok).toBe(false);
    expect(telegram.probe?.status).toBe(401);
    expect(telegram.probe?.error).toMatch(/unauthorized/i);

    testConfig = { channels: { telegram: { botToken: "t-err" } } };
    testStore = {};
    vi.stubEnv("DISCORD_BOT_TOKEN", "");

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      }),
    );

    const exceptionSnap = await getHealthSnapshot({ timeoutMs: 25 });
    const exceptionTelegram = exceptionSnap.channels.telegram as {
      configured?: boolean;
      probe?: { ok?: boolean; error?: string };
    };
    expect(exceptionTelegram.configured).toBe(true);
    expect(exceptionTelegram.probe?.ok).toBe(false);
    expect(exceptionTelegram.probe?.error).toMatch(/network down/i);
  });

  it("disables heartbeat for agents without heartbeat blocks", async () => {
    testConfig = {
      agents: {
        defaults: {
          heartbeat: {
            every: "30m",
            target: "last",
          },
        },
        list: [
          { id: "main", default: true },
          { id: "ops", heartbeat: { every: "1h", target: "whatsapp" } },
        ],
      },
    };
    testStore = {};

    const snap = await getHealthSnapshot({ timeoutMs: 10, probe: false });
    const byAgent = new Map(snap.agents.map((agent) => [agent.agentId, agent] as const));
    const main = byAgent.get("main");
    const ops = byAgent.get("ops");

    expect(main?.heartbeat.everyMs).toBeNull();
    expect(main?.heartbeat.every).toBe("disabled");
    expect(ops?.heartbeat.everyMs).toBe(60 * 60 * 1000);
    expect(ops?.heartbeat.every).toBe("1h");
  });

  it("passes agent scope when summarizing configured agent sessions", async () => {
    testConfig = {
      agents: {
        list: [{ id: "main", default: true }, { id: "ops" }],
      },
    };
    testStore = {};

    await getHealthSnapshot({ timeoutMs: 10, probe: false });

    expect(listHealthSessionEntriesCalls).toEqual([
      { agentId: "main", storePath: "/tmp/sessions.json" },
      { agentId: "ops", storePath: "/tmp/sessions.json" },
    ]);
  });
});
