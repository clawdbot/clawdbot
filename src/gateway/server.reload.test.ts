import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getFreePort,
  installGatewayTestHooks,
  startGatewayServer,
} from "./test-helpers.js";

const hoisted = vi.hoisted(() => {
  const cronInstances: Array<{
    start: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
  }> = [];

  class CronServiceMock {
    start = vi.fn(async () => {});
    stop = vi.fn();
    constructor() {
      cronInstances.push(this);
    }
  }

  const browserStop = vi.fn(async () => {});
  const startBrowserControlServerIfEnabled = vi.fn(async () => ({
    stop: browserStop,
  }));

  const heartbeatStop = vi.fn();
  const startHeartbeatRunner = vi.fn(() => ({ stop: heartbeatStop }));

  const startGmailWatcher = vi.fn(async () => ({ started: true }));
  const stopGmailWatcher = vi.fn(async () => {});

  const providerManager = {
    getRuntimeSnapshot: vi.fn(() => ({
      whatsapp: {
        running: false,
        connected: false,
        reconnectAttempts: 0,
        lastConnectedAt: null,
        lastDisconnect: null,
        lastMessageAt: null,
        lastEventAt: null,
        lastError: null,
      },
      whatsappAccounts: {},
      telegram: {
        running: false,
        lastStartAt: null,
        lastStopAt: null,
        lastError: null,
        mode: null,
      },
      telegramAccounts: {},
      discord: {
        running: false,
        lastStartAt: null,
        lastStopAt: null,
        lastError: null,
      },
      discordAccounts: {},
      slack: {
        running: false,
        lastStartAt: null,
        lastStopAt: null,
        lastError: null,
      },
      slackAccounts: {},
      signal: {
        running: false,
        lastStartAt: null,
        lastStopAt: null,
        lastError: null,
        baseUrl: null,
      },
      signalAccounts: {},
      imessage: {
        running: false,
        lastStartAt: null,
        lastStopAt: null,
        lastError: null,
        cliPath: null,
        dbPath: null,
      },
      imessageAccounts: {},
      msteams: {
        running: false,
        lastStartAt: null,
        lastStopAt: null,
        lastError: null,
      },
    })),
    startProviders: vi.fn(async () => {}),
    startProvider: vi.fn(async () => {}),
    stopProvider: vi.fn(async () => {}),
    startWhatsAppProvider: vi.fn(async () => {}),
    stopWhatsAppProvider: vi.fn(async () => {}),
    startTelegramProvider: vi.fn(async () => {}),
    stopTelegramProvider: vi.fn(async () => {}),
    startDiscordProvider: vi.fn(async () => {}),
    stopDiscordProvider: vi.fn(async () => {}),
    startSlackProvider: vi.fn(async () => {}),
    stopSlackProvider: vi.fn(async () => {}),
    startSignalProvider: vi.fn(async () => {}),
    stopSignalProvider: vi.fn(async () => {}),
    startIMessageProvider: vi.fn(async () => {}),
    stopIMessageProvider: vi.fn(async () => {}),
    startMSTeamsProvider: vi.fn(async () => {}),
    stopMSTeamsProvider: vi.fn(async () => {}),
    markWhatsAppLoggedOut: vi.fn(),
  };

  const createProviderManager = vi.fn(() => providerManager);

  const reloaderStop = vi.fn(async () => {});
  let onHotReload:
    | ((plan: unknown, nextConfig: unknown) => Promise<void>)
    | null = null;
  let onRestart: ((plan: unknown, nextConfig: unknown) => void) | null = null;

  const startGatewayConfigReloader = vi.fn(
    (opts: {
      onHotReload: typeof onHotReload;
      onRestart: typeof onRestart;
    }) => {
      onHotReload = opts.onHotReload as typeof onHotReload;
      onRestart = opts.onRestart as typeof onRestart;
      return { stop: reloaderStop };
    },
  );

  return {
    CronService: CronServiceMock,
    cronInstances,
    browserStop,
    startBrowserControlServerIfEnabled,
    heartbeatStop,
    startHeartbeatRunner,
    startGmailWatcher,
    stopGmailWatcher,
    providerManager,
    createProviderManager,
    startGatewayConfigReloader,
    reloaderStop,
    getOnHotReload: () => onHotReload,
    getOnRestart: () => onRestart,
  };
});

vi.mock("../cron/service.js", () => ({
  CronService: hoisted.CronService,
}));

vi.mock("./server-browser.js", () => ({
  startBrowserControlServerIfEnabled:
    hoisted.startBrowserControlServerIfEnabled,
}));

vi.mock("../infra/heartbeat-runner.js", () => ({
  startHeartbeatRunner: hoisted.startHeartbeatRunner,
}));

vi.mock("../hooks/gmail-watcher.js", () => ({
  startGmailWatcher: hoisted.startGmailWatcher,
  stopGmailWatcher: hoisted.stopGmailWatcher,
}));

vi.mock("./server-providers.js", () => ({
  createProviderManager: hoisted.createProviderManager,
}));

vi.mock("./config-reload.js", () => ({
  startGatewayConfigReloader: hoisted.startGatewayConfigReloader,
}));

installGatewayTestHooks();

describe("gateway hot reload", () => {
  let prevSkipProviders: string | undefined;
  let prevSkipGmail: string | undefined;

  beforeEach(() => {
    prevSkipProviders = process.env.CLAWDBOT_SKIP_PROVIDERS;
    prevSkipGmail = process.env.CLAWDBOT_SKIP_GMAIL_WATCHER;
    process.env.CLAWDBOT_SKIP_PROVIDERS = "0";
    delete process.env.CLAWDBOT_SKIP_GMAIL_WATCHER;
  });

  afterEach(() => {
    if (prevSkipProviders === undefined) {
      delete process.env.CLAWDBOT_SKIP_PROVIDERS;
    } else {
      process.env.CLAWDBOT_SKIP_PROVIDERS = prevSkipProviders;
    }
    if (prevSkipGmail === undefined) {
      delete process.env.CLAWDBOT_SKIP_GMAIL_WATCHER;
    } else {
      process.env.CLAWDBOT_SKIP_GMAIL_WATCHER = prevSkipGmail;
    }
  });

  it("applies hot reload actions for providers + services", async () => {
    const port = await getFreePort();
    const server = await startGatewayServer(port);

    const onHotReload = hoisted.getOnHotReload();
    expect(onHotReload).toBeTypeOf("function");

    const nextConfig = {
      hooks: {
        enabled: true,
        token: "secret",
        gmail: { account: "me@example.com" },
      },
      cron: { enabled: true, store: "/tmp/cron.json" },
      agents: { defaults: { heartbeat: { every: "1m" }, maxConcurrent: 2 } },
      browser: { enabled: true, controlUrl: "http://127.0.0.1:18791" },
      web: { enabled: true },
      telegram: { botToken: "token" },
      discord: { token: "token" },
      signal: { account: "+15550000000" },
      imessage: { enabled: true },
    };

    await onHotReload?.(
      {
        changedPaths: [
          "hooks.gmail.account",
          "cron.enabled",
          "agents.defaults.heartbeat.every",
          "browser.enabled",
          "web.enabled",
          "telegram.botToken",
          "discord.token",
          "signal.account",
          "imessage.enabled",
        ],
        restartGateway: false,
        restartReasons: [],
        hotReasons: ["web.enabled"],
        reloadHooks: true,
        restartGmailWatcher: true,
        restartBrowserControl: true,
        restartCron: true,
        restartHeartbeat: true,
        restartProviders: new Set([
          "whatsapp",
          "telegram",
          "discord",
          "signal",
          "imessage",
        ]),
        noopPaths: [],
      },
      nextConfig,
    );

    expect(hoisted.stopGmailWatcher).toHaveBeenCalled();
    expect(hoisted.startGmailWatcher).toHaveBeenCalledWith(nextConfig);

    expect(hoisted.browserStop).toHaveBeenCalledTimes(1);
    expect(hoisted.startBrowserControlServerIfEnabled).toHaveBeenCalledTimes(2);

    expect(hoisted.startHeartbeatRunner).toHaveBeenCalledTimes(2);
    expect(hoisted.heartbeatStop).toHaveBeenCalledTimes(1);

    expect(hoisted.cronInstances.length).toBe(2);
    expect(hoisted.cronInstances[0].stop).toHaveBeenCalledTimes(1);
    expect(hoisted.cronInstances[1].start).toHaveBeenCalledTimes(1);

    expect(hoisted.providerManager.stopProvider).toHaveBeenCalledTimes(5);
    expect(hoisted.providerManager.startProvider).toHaveBeenCalledTimes(5);
    expect(hoisted.providerManager.stopProvider).toHaveBeenCalledWith(
      "whatsapp",
    );
    expect(hoisted.providerManager.startProvider).toHaveBeenCalledWith(
      "whatsapp",
    );
    expect(hoisted.providerManager.stopProvider).toHaveBeenCalledWith(
      "telegram",
    );
    expect(hoisted.providerManager.startProvider).toHaveBeenCalledWith(
      "telegram",
    );
    expect(hoisted.providerManager.stopProvider).toHaveBeenCalledWith(
      "discord",
    );
    expect(hoisted.providerManager.startProvider).toHaveBeenCalledWith(
      "discord",
    );
    expect(hoisted.providerManager.stopProvider).toHaveBeenCalledWith("signal");
    expect(hoisted.providerManager.startProvider).toHaveBeenCalledWith(
      "signal",
    );
    expect(hoisted.providerManager.stopProvider).toHaveBeenCalledWith(
      "imessage",
    );
    expect(hoisted.providerManager.startProvider).toHaveBeenCalledWith(
      "imessage",
    );

    await server.close();
  });

  it("emits SIGUSR1 on restart plan when listener exists", async () => {
    const port = await getFreePort();
    const server = await startGatewayServer(port);

    const onRestart = hoisted.getOnRestart();
    expect(onRestart).toBeTypeOf("function");

    const signalSpy = vi.fn();
    process.once("SIGUSR1", signalSpy);

    onRestart?.(
      {
        changedPaths: ["gateway.port"],
        restartGateway: true,
        restartReasons: ["gateway.port"],
        hotReasons: [],
        reloadHooks: false,
        restartGmailWatcher: false,
        restartBrowserControl: false,
        restartCron: false,
        restartHeartbeat: false,
        restartProviders: new Set(),
        noopPaths: [],
      },
      {},
    );

    expect(signalSpy).toHaveBeenCalledTimes(1);

    await server.close();
  });
});
