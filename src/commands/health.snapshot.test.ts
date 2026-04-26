import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelPlugin } from "../channels/plugins/types.js";
import { createPluginRecord } from "../plugins/status.test-helpers.js";
import type { HealthSummary } from "./health.js";

let testConfig: Record<string, unknown> = {};
let testStore: Record<string, { updatedAt?: number }> = {};

let setActivePluginRegistry: typeof import("../plugins/runtime.js").setActivePluginRegistry;
let createChannelTestPluginBase: typeof import("../test-utils/channel-plugins.js").createChannelTestPluginBase;
let createTestRegistry: typeof import("../test-utils/channel-plugins.js").createTestRegistry;
let getHealthSnapshot: typeof import("./health.js").getHealthSnapshot;

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

async function loadFreshHealthModulesForTest() {
  vi.doMock("../config/config.js", () => ({
    loadConfig: () => testConfig,
  }));
  vi.doMock("../config/sessions.js", () => ({
    resolveStorePath: () => "/tmp/sessions.json",
    resolveSessionFilePath: vi.fn(() => "/tmp/sessions.json"),
    loadSessionStore: () => testStore,
    saveSessionStore: vi.fn().mockResolvedValue(undefined),
    readSessionUpdatedAt: vi.fn(() => undefined),
    recordSessionMetaFromInbound: vi.fn().mockResolvedValue(undefined),
    updateLastRoute: vi.fn().mockResolvedValue(undefined),
  }));
  vi.doMock("../config/sessions/paths.js", () => ({
    resolveStorePath: () => "/tmp/sessions.json",
  }));
  vi.doMock("../config/sessions/store.js", () => ({
    loadSessionStore: () => testStore,
  }));
  vi.doMock("../plugins/runtime/runtime-web-channel-plugin.js", () => ({
    webAuthExists: vi.fn(async () => true),
    getWebAuthAgeMs: vi.fn(() => 1234),
    readWebSelfId: vi.fn(() => ({ e164: null, jid: null })),
    logWebSelfId: vi.fn(),
    logoutWeb: vi.fn(),
  }));
  vi.doMock("../channels/plugins/read-only.js", () => ({
    listReadOnlyChannelPluginsForConfig: () => [createTelegramHealthPlugin()],
  }));

  const [pluginsRuntime, channelTestUtils, health] = await Promise.all([
    import("../plugins/runtime.js"),
    import("../test-utils/channel-plugins.js"),
    import("./health.js"),
  ]);

  return {
    setActivePluginRegistry: pluginsRuntime.setActivePluginRegistry,
    createChannelTestPluginBase: channelTestUtils.createChannelTestPluginBase,
    createTestRegistry: channelTestUtils.createTestRegistry,
    getHealthSnapshot: health.getHealthSnapshot,
  };
}

function getTelegramChannelConfig(cfg: Record<string, unknown>) {
  const channels = cfg.channels as Record<string, unknown> | undefined;
  return (channels?.telegram as Record<string, unknown> | undefined) ?? {};
}

function listTelegramAccountIdsForTest(cfg: Record<string, unknown>): string[] {
  const telegram = getTelegramChannelConfig(cfg);
  const accounts = telegram.accounts as Record<string, unknown> | undefined;
  const ids = Object.keys(accounts ?? {}).filter(Boolean);
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

function createTelegramHealthPlugin(): Pick<
  ChannelPlugin,
  "id" | "meta" | "capabilities" | "config" | "status"
> {
  return {
    ...createChannelTestPluginBase({ id: "telegram", label: "Telegram" }),
    config: {
      listAccountIds: (cfg) => listTelegramAccountIdsForTest(cfg as Record<string, unknown>),
      resolveAccount: (cfg, accountId) =>
        resolveTelegramAccountForTest({ cfg: cfg as Record<string, unknown>, accountId }),
      isConfigured: (account) => Boolean((account as TelegramHealthAccount).token.trim()),
    },
    status: {
      buildChannelSummary: ({ snapshot }) => buildTelegramHealthSummary(snapshot),
      probeAccount: async ({ account, timeoutMs }) =>
        await probeTelegramAccountForTest(account as TelegramHealthAccount, timeoutMs),
    },
  };
}

describe("getHealthSnapshot", () => {
  beforeAll(async () => {
    ({
      setActivePluginRegistry,
      createChannelTestPluginBase,
      createTestRegistry,
      getHealthSnapshot,
    } = await loadFreshHealthModulesForTest());
  });

  beforeEach(() => {
    setActivePluginRegistry(
      createTestRegistry([
        { pluginId: "telegram", plugin: createTelegramHealthPlugin(), source: "test" },
      ]),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
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
          error: "failed to install bundled runtime deps: ENOSPC",
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
        error: "failed to install bundled runtime deps: ENOSPC",
      },
    ]);
  });

  it("skips telegram probe when not configured", async () => {
    testConfig = { session: { store: "/tmp/x" } };
    testStore = {
      global: { updatedAt: Date.now() },
      unknown: { updatedAt: Date.now() },
      main: { updatedAt: 1000 },
      foo: { updatedAt: 2000 },
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
    expect(snap.sessions.recent[0]?.key).toBe("foo");
  });

  it("probes telegram getMe + webhook info when configured", async () => {
    const { calls, telegram } = await runSuccessfulTelegramProbe({
      channels: { telegram: { botToken: "t-1" } },
    });
    expect(telegram.configured).toBe(true);
    expect(telegram.probe?.ok).toBe(true);
    expect(telegram.probe?.bot?.username).toBe("bot");
    expect(telegram.probe?.webhook?.url).toMatch(/^https:/);
    expect(calls.some((c) => c.includes("/getMe"))).toBe(true);
    expect(calls.some((c) => c.includes("/getWebhookInfo"))).toBe(true);

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
      expect(tokenFileProbe.calls.some((c) => c.includes("bott-file/getMe"))).toBe(true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
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
    expect(ops?.heartbeat.everyMs).toBeTruthy();
    expect(ops?.heartbeat.every).toBe("1h");
  });
});
