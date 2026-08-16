// Slack tests cover auth.test token handling during provider boot.
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { WebClient } from "@slack/web-api";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { OpenKeyedStoreOptions } from "openclaw/plugin-sdk/plugin-state-runtime";
import { createPluginStateSyncKeyedStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assertSlackDetachedTargetAllowed } from "../detached-target-admission.js";
import { getSlackInstallationKind } from "../installation-identity-state.js";
import {
  disposeSlackTestRuntime,
  flush,
  getSlackClient,
  getSlackHandlerOrThrow,
  getSlackHandlers,
  getSlackTestState,
  resetSlackTestState,
  startSlackMonitor as startSlackMonitorUntracked,
  stopSlackMonitor,
  useSlackStartupAuthClientOnce,
} from "../monitor.test-helpers.js";
import { getSlackRuntime } from "../runtime.js";

const { monitorSlackProvider } = await import("./provider.js");

type StartedSlackMonitor = ReturnType<typeof startSlackMonitorUntracked>;

const startedMonitors: StartedSlackMonitor[] = [];

function trackSlackMonitor<T extends StartedSlackMonitor>(monitor: T): T {
  startedMonitors.push(monitor);
  return monitor;
}

function startSlackMonitor(...args: Parameters<typeof startSlackMonitorUntracked>) {
  return trackSlackMonitor(startSlackMonitorUntracked(...args));
}

async function runTrackedSlackMessageOnce(
  provider: Parameters<typeof startSlackMonitorUntracked>[0],
  args: unknown,
  opts?: Parameters<typeof startSlackMonitorUntracked>[1],
) {
  const monitor = startSlackMonitor(provider, opts);
  try {
    const handler = await getSlackHandlerOrThrow("message");
    await handler(args);
  } finally {
    await stopSlackMonitor(monitor);
  }
}

const PROXY_ENV_KEYS = [
  "ALL_PROXY",
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "all_proxy",
  "https_proxy",
  "http_proxy",
  "NO_PROXY",
  "no_proxy",
] as const;
const SLACK_TEST_STARTUP_AUTH_TIMEOUT_MS = 100;

function useShortSlackStartupAuthClientOnce(): void {
  useSlackStartupAuthClientOnce(
    (token, options) =>
      new WebClient(token, {
        ...options,
        // Production timeout and retry policy are pinned in client owner tests. This provider
        // regression keeps the real SDK/transport while shortening only its test-owned clock.
        retryConfig: {
          retries: 2,
          factor: 1,
          minTimeout: 1,
          maxTimeout: 1,
          randomize: false,
        },
        timeout: SLACK_TEST_STARTUP_AUTH_TIMEOUT_MS,
      }),
  );
}

async function startStalledSlackApiServer(events: string[]) {
  let requestCount = 0;
  let requestUrl: string | undefined;
  const server = createServer((request) => {
    requestCount += 1;
    requestUrl = request.url;
    events.push("request");
    request.resume();
    request.socket.once("close", () => {
      events.push("socket-closed");
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  return {
    apiUrl: `http://127.0.0.1:${address.port}/api/`,
    get requestCount() {
      return requestCount;
    },
    get requestUrl() {
      return requestUrl;
    },
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

beforeEach(() => {
  resetSlackTestState();
});

afterEach(async () => {
  const monitors = startedMonitors.splice(0);
  for (const monitor of monitors) {
    monitor.controller.abort();
  }
  await Promise.allSettled(monitors.map((monitor) => monitor.run));
  getSlackClient().auth.test.mockReset();
  resetSlackTestState();
  vi.unstubAllEnvs();
});

afterAll(() => {
  disposeSlackTestRuntime();
});

describe("auth.test boot call", () => {
  it("does not pass the bot token in the call arguments", async () => {
    const monitor = startSlackMonitor(monitorSlackProvider);
    await stopSlackMonitor(monitor);

    const client = getSlackClient();
    expect(client.auth.test).toHaveBeenCalledTimes(1);
    // The SDK serializes every property from the call argument into the POST
    // body.  Passing { token } would leak the bot token into the request
    // payload alongside the Authorization header.
    const firstArg = client.auth.test.mock.calls[0]?.[0] as Record<string, unknown> | undefined;
    if (firstArg != null) {
      expect(firstArg).not.toHaveProperty("token");
    }
  });

  it("warns when auth.test returns a user id without bot_id", async () => {
    const runtimeLog = vi.fn();
    const client = getSlackClient();
    client.auth.test.mockResolvedValue({
      app_id: "A1",
      user_id: "UUSER",
      user: "human-installer",
      team_id: "T1",
      team: "OpenClaw",
      is_enterprise_install: false,
    });

    const monitor = startSlackMonitor(monitorSlackProvider, {
      botToken: "xoxp-user-token",
      runtime: {
        log: runtimeLog,
        error: vi.fn(),
        exit: vi.fn(),
      },
    });
    await stopSlackMonitor(monitor);

    expect(runtimeLog).toHaveBeenCalledWith(
      expect.stringContaining("channels.slack.accounts.default.botToken"),
    );
    expect(runtimeLog).toHaveBeenCalledWith(
      expect.stringContaining("replace it with a Bot User OAuth Token"),
    );
    expect(runtimeLog).toHaveBeenCalledWith(
      expect.stringContaining("required-mention channels fail closed"),
    );
  });

  it("does not use a user-token identity as the bot mention target", async () => {
    resetSlackTestState({
      channels: {
        slack: {
          groupPolicy: "open",
          channels: { C1: { allow: true, requireMention: true } },
        },
      },
    });
    const client = getSlackClient();
    client.auth.test.mockResolvedValue({
      app_id: "A1",
      user_id: "UUSER",
      user: "human-installer",
      team_id: "T1",
      team: "OpenClaw",
      is_enterprise_install: false,
    });
    client.conversations.info.mockResolvedValueOnce({
      channel: { name: "general", is_channel: true },
    });
    const { replyMock } = getSlackTestState();
    replyMock.mockResolvedValue({ text: "unexpected" });

    await runTrackedSlackMessageOnce(
      monitorSlackProvider,
      {
        event: {
          type: "message",
          user: "USENDER",
          text: "<@UUSER> status",
          ts: "100.000",
          channel: "C1",
          channel_type: "channel",
        },
      },
      { botToken: "xoxp-user-token" },
    );

    expect(replyMock).not.toHaveBeenCalled();
  });

  it("warns that required-mention channels fail closed when auth.test fails", async () => {
    const runtimeLog = vi.fn();
    getSlackClient().auth.test.mockRejectedValueOnce(new Error("request_timeout"));

    const monitor = startSlackMonitor(monitorSlackProvider, {
      runtime: {
        log: runtimeLog,
        error: vi.fn(),
        exit: vi.fn(),
      },
    });
    await stopSlackMonitor(monitor);

    expect(runtimeLog).toHaveBeenCalledWith(
      expect.stringContaining(
        "required-mention channels will fail closed without another trusted activation signal",
      ),
    );
    expect(runtimeLog).toHaveBeenCalledWith(
      expect.stringContaining("while the bot identity is unresolved"),
    );
    expect(runtimeLog).not.toHaveBeenCalledWith(expect.stringContaining("until restart"));
  });

  it("continues startup after the startup auth client times out", async () => {
    const runtimeLog = vi.fn();
    const { appStartMock, createSlackStartupAuthClientMock } = getSlackTestState();
    vi.stubEnv("SLACK_API_URL", "https://slack.test/api/");
    vi.stubEnv("https_proxy", "http://proxy.test:3128");
    vi.stubEnv("no_proxy", "");
    getSlackClient().auth.test.mockRejectedValueOnce(
      new Error("A request error occurred: timeout of 10000ms exceeded"),
    );

    const monitor = startSlackMonitor(monitorSlackProvider, {
      runtime: {
        log: runtimeLog,
        error: vi.fn(),
        exit: vi.fn(),
      },
    });
    await stopSlackMonitor(monitor);

    expect(createSlackStartupAuthClientMock).toHaveBeenCalledWith(
      "bot-token",
      expect.objectContaining({
        fetch: expect.any(Function),
        slackApiUrl: "https://slack.test/api/",
      }),
    );
    expect(getSlackClient().auth.test).toHaveBeenCalledTimes(2);
    expect(appStartMock).toHaveBeenCalledTimes(1);
    expect(runtimeLog).toHaveBeenCalledWith(expect.stringContaining("timeout of 10000ms exceeded"));
  });

  it("settles and closes a real stalled startup auth request before degraded startup", async () => {
    const events: string[] = [];
    for (const key of PROXY_ENV_KEYS) {
      vi.stubEnv(key, "");
    }
    const server = await startStalledSlackApiServer(events);
    vi.stubEnv("SLACK_API_URL", server.apiUrl);
    useShortSlackStartupAuthClientOnce();

    const runtimeLog = vi.fn((...args: unknown[]) => {
      const message = args[0];
      if (typeof message === "string" && message.includes("slack auth.test failed at boot")) {
        events.push("auth-settled");
      }
    });
    const { appStartMock } = getSlackTestState();
    appStartMock.mockImplementationOnce(async () => {
      events.push("app-start");
    });
    const monitor = startSlackMonitor(monitorSlackProvider, {
      runtime: { log: runtimeLog, error: vi.fn(), exit: vi.fn() },
    });
    try {
      await vi.waitFor(() => expect(appStartMock).toHaveBeenCalledTimes(1), { timeout: 2_000 });
      await vi.waitFor(() => expect(events).toContain("socket-closed"), { timeout: 1_000 });

      expect(server.requestCount).toBe(3);
      expect(server.requestUrl).toBe("/api/auth.test");
      expect(events).toContain("auth-settled");
      expect(events.indexOf("auth-settled")).toBeLessThan(events.indexOf("app-start"));
      expect(runtimeLog).toHaveBeenCalledWith(
        expect.stringMatching(/slack auth\.test failed at boot .*timeout/i),
      );
    } finally {
      monitor.controller.abort();
      await monitor.run;
      await server.close();
    }
  }, 5_000);

  it("preserves workspace startup when auth.test omits app_id", async () => {
    getSlackClient().auth.test.mockResolvedValueOnce({
      user_id: "UBOT",
      bot_id: "BBOT",
      team_id: "T1",
      is_enterprise_install: false,
    });

    const monitor = startSlackMonitor(monitorSlackProvider);
    await vi.waitFor(() => expect(getSlackTestState().appStartMock).toHaveBeenCalledTimes(1));
    expect(getSlackInstallationKind("default")).toBe("workspace");
    await expect(stopSlackMonitor(monitor)).resolves.toBeUndefined();
    expect(getSlackInstallationKind("default")).toBeUndefined();
  });

  it("starts an org-wide Socket Mode account with its bot identity when auth.test omits app_id", async () => {
    resetSlackTestState({
      channels: {
        slack: {
          dmPolicy: "disabled",
          groupPolicy: "open",
          slashCommand: { enabled: true, name: "openclaw" },
          channels: {
            "team:TWORKSPACE:channel:C12345678": { allow: true, requireMention: true },
          },
        },
      },
    });
    const client = getSlackClient();
    client.auth.test.mockResolvedValueOnce({
      user_id: "UENTERPRISE",
      bot_id: "BENTERPRISE",
      enterprise_id: "E1",
      is_enterprise_install: true,
    });
    client.conversations.info.mockResolvedValueOnce({
      channel: { name: "general", is_channel: true },
    });
    const { replyMock, sendMock } = getSlackTestState();
    replyMock.mockResolvedValue({ text: "identity preserved" });

    const monitor = startSlackMonitor(monitorSlackProvider, {
      appToken: "xapp-1-A1-opaque",
    });
    await vi.waitFor(() => expect(getSlackTestState().appStartMock).toHaveBeenCalledTimes(1));
    expect([...getSlackTestState().interactionRegistrations].toSorted()).toEqual([
      "action",
      "command",
      "shortcut",
      "view",
      "view",
    ]);
    expect(getSlackInstallationKind("default")).toBe("enterprise");

    const handler = await getSlackHandlerOrThrow("message");
    await handler({
      event: {
        type: "message",
        user: "UOTHER123",
        text: "<@UENTERPRISE> status",
        ts: "100.000",
        channel: "C12345678",
        channel_type: "channel",
      },
      context: {
        isEnterpriseInstall: true,
        enterpriseId: "E1",
        teamId: "TWORKSPACE",
      },
      body: { api_app_id: "A1" },
      client,
    });

    expect(replyMock).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(sendMock).toHaveBeenCalledTimes(1));
    await expect(stopSlackMonitor(monitor)).resolves.toBeUndefined();
    expect(getSlackInstallationKind("default")).toBeUndefined();
  });

  it("starts Enterprise Grid with the default pairing DM policy", async () => {
    resetSlackTestState({
      channels: {
        slack: {},
      },
    });
    getSlackClient().auth.test.mockResolvedValueOnce({
      user_id: "UENTERPRISE",
      bot_id: "BENTERPRISE",
      enterprise_id: "E1",
      is_enterprise_install: true,
    });

    const monitor = startSlackMonitor(monitorSlackProvider);
    await vi.waitFor(() => expect(getSlackTestState().appStartMock).toHaveBeenCalledTimes(1));
    expect(getSlackInstallationKind("default")).toBe("enterprise");
    await expect(stopSlackMonitor(monitor)).resolves.toBeUndefined();
  });
});

describe("presence polling transport", () => {
  it("starts workspace-scoped presence polling for an Enterprise Grid org install", async () => {
    resetSlackTestState({
      channels: {
        slack: {
          groupPolicy: "open",
          presenceEvents: { mode: "on" },
        },
      },
    });
    getSlackClient().auth.test.mockResolvedValueOnce({
      user_id: "UENTERPRISE",
      bot_id: "BENTERPRISE",
      enterprise_id: "E1",
      is_enterprise_install: true,
    });
    getSlackRuntime().state.openSyncKeyedStore = <T>(options: OpenKeyedStoreOptions) =>
      createPluginStateSyncKeyedStoreForTests<T>("slack", {
        ...options,
        env: options.env ?? process.env,
      });
    const runtimeLog = vi.fn();

    const monitor = startSlackMonitor(monitorSlackProvider, {
      runtime: { log: runtimeLog, error: vi.fn(), exit: vi.fn() },
    });
    await vi.waitFor(() => expect(getSlackTestState().appStartMock).toHaveBeenCalledTimes(1));

    expect(runtimeLog).toHaveBeenCalledWith("slack presence polling enabled for account default");
    expect(runtimeLog).not.toHaveBeenCalledWith(
      expect.stringContaining("presence events are unavailable"),
    );
    await stopSlackMonitor(monitor);
  });

  it("aborts a stalled presence request when the provider stops", async () => {
    const events: string[] = [];
    for (const key of PROXY_ENV_KEYS) {
      vi.stubEnv(key, "");
    }
    const server = await startStalledSlackApiServer(events);
    vi.stubEnv("SLACK_API_URL", server.apiUrl);
    resetSlackTestState({
      channels: {
        slack: {
          dm: { enabled: true },
          dmPolicy: "open",
          allowFrom: ["*"],
          groupPolicy: "open",
          presenceEvents: { mode: "on" },
        },
      },
    });
    getSlackRuntime().state.openSyncKeyedStore = <T>(options: OpenKeyedStoreOptions) =>
      createPluginStateSyncKeyedStoreForTests<T>("slack", {
        ...options,
        env: options.env ?? process.env,
      });
    getSlackTestState().replyMock.mockResolvedValue({ text: "ok" });

    const nativeSetInterval = globalThis.setInterval;
    let triggerPresencePoll: (() => void) | undefined;
    const intervalSpy = vi.spyOn(globalThis, "setInterval").mockImplementation(((
      handler: (...args: unknown[]) => void,
      timeout?: number,
      ...args: unknown[]
    ) => {
      if (timeout === 60_000 && !triggerPresencePoll) {
        triggerPresencePoll = () => handler(...args);
        return nativeSetInterval(() => undefined, 60 * 60 * 1_000);
      }
      return nativeSetInterval(handler, timeout, ...args);
    }) as typeof setInterval);

    const monitor = startSlackMonitor(monitorSlackProvider);
    try {
      const handler = await getSlackHandlerOrThrow("message");
      await handler({
        event: {
          type: "message",
          user: "U_STALLED",
          text: "hello",
          ts: "100.000",
          channel: "D_STALLED",
          channel_type: "im",
        },
        context: { botUserId: "bot-user" },
        body: {},
      });
      expect(triggerPresencePoll).toBeTypeOf("function");
      triggerPresencePoll?.();
      await vi.waitFor(() => expect(server.requestCount).toBe(1), { timeout: 1_000 });

      const startedAt = Date.now();
      monitor.controller.abort();
      const outcome = await Promise.race([
        monitor.run.then(() => "settled" as const),
        new Promise<"timed-out">((resolve) => {
          setTimeout(() => resolve("timed-out"), 2_000);
        }),
      ]);

      expect(outcome).toBe("settled");
      expect(Date.now() - startedAt).toBeLessThan(2_000);
      await vi.waitFor(() => expect(events).toContain("socket-closed"), { timeout: 1_000 });
      expect(server.requestUrl).toBe("/api/users.getPresence");
    } finally {
      intervalSpy.mockRestore();
      monitor.controller.abort();
      await server.close();
      await monitor.run;
    }
  });
});

describe("user identity provider transport", () => {
  const userSocketConfig = () => ({
    channels: {
      slack: {
        postAs: "user",
        userToken: "test-user-token",
        appToken: "test-app-token",
        dm: { enabled: true },
        dmPolicy: "open",
        allowFrom: ["*"],
        groupPolicy: "open",
      },
    },
  });

  async function startWithoutBotToken(config: Record<string, unknown>) {
    const controller = new AbortController();
    const run = monitorSlackProvider({
      config: config as never,
      abortSignal: controller.signal,
    });
    const monitor = trackSlackMonitor({ controller, run });
    await vi.waitFor(() => expect(getSlackTestState().appConstructorArgs).toBeDefined());
    return monitor;
  }

  it("starts socket transport with the user token and no bot token", async () => {
    const config = userSocketConfig();
    const client = getSlackClient();
    const runtimeLog = vi.fn();
    resetSlackTestState(config);
    client.auth.test.mockResolvedValueOnce({
      app_id: "A_TEST",
      user_id: "U_SELF",
      team_id: "T_TEST",
      is_enterprise_install: false,
    });
    const controller = new AbortController();
    const run = monitorSlackProvider({
      config: config as never,
      abortSignal: controller.signal,
      runtime: { log: runtimeLog, error: vi.fn(), exit: vi.fn() },
    });
    const monitor = trackSlackMonitor({ controller, run });
    await vi.waitFor(() => expect(getSlackTestState().appConstructorArgs).toBeDefined());

    expect(getSlackTestState().appConstructorArgs).toMatchObject({
      token: "test-user-token",
      tokenVerificationEnabled: false,
    });
    expect(getSlackTestState().createSlackStartupAuthClientMock).toHaveBeenCalledWith(
      "test-user-token",
      expect.any(Object),
    );
    expect(client.auth.test).toHaveBeenCalledTimes(1);
    expect(runtimeLog).not.toHaveBeenCalledWith(
      expect.stringContaining("replace it with a Bot User OAuth Token"),
    );

    await stopSlackMonitor(monitor);
  });

  it("uses the authenticated human id as the mention target", async () => {
    const config = {
      channels: {
        slack: {
          ...userSocketConfig().channels.slack,
          channels: { C1: { allow: true, requireMention: true } },
        },
      },
    };
    resetSlackTestState(config);
    const client = getSlackClient();
    client.auth.test.mockResolvedValueOnce({
      app_id: "A_TEST",
      user_id: "U_SELF",
      team_id: "T_TEST",
      is_enterprise_install: false,
    });
    client.conversations.info.mockResolvedValueOnce({
      channel: { name: "general", is_channel: true },
    });
    const { replyMock, sendMock } = getSlackTestState();
    replyMock.mockResolvedValue({ text: "acknowledged" });
    const monitor = await startWithoutBotToken(config);
    const handler = await getSlackHandlerOrThrow("message");

    await handler({
      event: {
        type: "message",
        user: "U_OTHER",
        text: "<@U_SELF> status",
        ts: "100.000",
        channel: "C1",
        channel_type: "channel",
      },
      context: { botUserId: "U_SELF" },
      body: {},
    });

    await vi.waitFor(() => expect(sendMock).toHaveBeenCalledTimes(1));
    await stopSlackMonitor(monitor);
  });

  it("delivers another user's DM and drops a self-authored DM", async () => {
    const config = userSocketConfig();
    resetSlackTestState(config);
    getSlackClient().auth.test.mockResolvedValueOnce({
      app_id: "A_TEST",
      user_id: "U_SELF",
      team_id: "T_TEST",
      is_enterprise_install: false,
    });
    const { replyMock, sendMock } = getSlackTestState();
    replyMock.mockResolvedValue({ text: "hello back" });
    const monitor = await startWithoutBotToken(config);
    const handler = await getSlackHandlerOrThrow("message");
    const baseEvent = {
      type: "message",
      channel: "D1",
      channel_type: "im",
      text: "hello",
    };

    await handler({
      event: { ...baseEvent, user: "U_OTHER", ts: "100.000" },
      context: { botUserId: "U_SELF" },
      body: {},
    });
    await vi.waitFor(() => expect(sendMock).toHaveBeenCalledTimes(1));

    await handler({
      event: { ...baseEvent, user: "U_SELF", ts: "101.000" },
      context: { botUserId: "U_SELF" },
      body: {},
    });
    await flush();

    expect(sendMock).toHaveBeenCalledTimes(1);
    await stopSlackMonitor(monitor);
  });

  it("starts HTTP transport with a user token and signing secret", async () => {
    const config = {
      channels: {
        slack: {
          postAs: "user",
          mode: "http",
          userToken: "test-user-token",
          signingSecret: "test-signing-secret",
          dm: { enabled: true },
          dmPolicy: "open",
          allowFrom: ["*"],
          groupPolicy: "open",
        },
      },
    };
    resetSlackTestState(config);
    const monitor = await startWithoutBotToken(config);

    expect(getSlackTestState().appConstructorArgs).toMatchObject({
      token: "test-user-token",
      tokenVerificationEnabled: false,
    });
    expect(getSlackTestState().createSlackStartupAuthClientMock).toHaveBeenCalledWith(
      "test-user-token",
      expect.any(Object),
    );

    await stopSlackMonitor(monitor);
  });

  it("rejects user identity without a user token", async () => {
    vi.stubEnv("SLACK_USER_TOKEN", "");
    const config = {
      channels: {
        slack: {
          postAs: "user",
          appToken: "test-app-token",
        },
      },
    };

    await expect(monitorSlackProvider({ config: config as never })).rejects.toThrow(
      'Slack user token missing for account "default"',
    );
  });

  it("rejects socket transport without an app token", async () => {
    vi.stubEnv("SLACK_APP_TOKEN", "");
    const config = {
      channels: {
        slack: {
          postAs: "user",
          userToken: "test-user-token",
        },
      },
    };

    await expect(monitorSlackProvider({ config: config as never })).rejects.toThrow(
      'Slack app token missing for user-identity socket mode account "default"',
    );
  });

  it("rejects HTTP transport without a signing secret", async () => {
    const config = {
      channels: {
        slack: {
          postAs: "user",
          mode: "http",
          userToken: "test-user-token",
        },
      },
    };

    await expect(monitorSlackProvider({ config: config as never })).rejects.toThrow(
      'Slack signing secret missing for user-identity HTTP mode account "default"',
    );
  });
});

describe("connected identity health", () => {
  it.each([
    {
      name: "bot identity",
      auth: {
        user_id: "UBOT",
        bot_id: "BBOT",
        team_id: "T1",
        is_enterprise_install: false,
      },
      config: undefined,
      expected: { lifecycle: "ready", lastError: null },
    },
    {
      name: "user-token identity",
      auth: {
        user_id: "UUSER",
        team_id: "T1",
        is_enterprise_install: false,
      },
      config: undefined,
      expected: {
        lifecycle: "blocked",
        lastError: expect.stringContaining("without bot_id"),
      },
    },
    {
      name: "enterprise identity",
      auth: {
        user_id: "UENTERPRISE",
        bot_id: "BENTERPRISE",
        enterprise_id: "E1",
        is_enterprise_install: true,
      },
      config: {
        channels: {
          slack: {
            dmPolicy: "disabled",
            groupPolicy: "open",
          },
        },
      },
      expected: { lifecycle: "ready", lastError: null },
    },
    {
      name: "enterprise identity without a bot user",
      auth: {
        enterprise_id: "E1",
        is_enterprise_install: true,
      },
      config: {
        channels: {
          slack: {
            dmPolicy: "disabled",
            groupPolicy: "open",
          },
        },
      },
      expected: {
        lifecycle: "blocked",
        lastError: "auth.test returned no user_id",
      },
    },
    {
      name: "enterprise user-token identity",
      auth: {
        user_id: "UUSER",
        enterprise_id: "E1",
        is_enterprise_install: true,
      },
      config: {
        channels: {
          slack: {
            dmPolicy: "disabled",
            groupPolicy: "open",
          },
        },
      },
      expected: {
        lifecycle: "blocked",
        lastError: expect.stringContaining("without bot_id"),
      },
    },
  ])("publishes $name through the provider status callback", async ({ auth, config, expected }) => {
    if (config) {
      resetSlackTestState(config);
    }
    getSlackClient().auth.test.mockResolvedValue(auth);
    const setStatus = vi.fn();

    const monitor = startSlackMonitor(monitorSlackProvider, { setStatus });
    await stopSlackMonitor(monitor);

    expect(setStatus).toHaveBeenCalledWith({
      connected: true,
      lastConnectedAt: expect.any(Number),
      ...(expected.lifecycle === "ready"
        ? { running: true, terminalDisconnect: undefined }
        : { terminalDisconnect: true }),
      ...expected,
    });
  });

  it("fails closed until auth.test recovery establishes a workspace install", async () => {
    const client = getSlackClient();
    const recoveredAuth = createDeferred<{
      app_id: string;
      user_id: string;
      bot_id: string;
      team_id: string;
      is_enterprise_install: false;
    }>();
    client.auth.test
      .mockRejectedValueOnce(new Error("request_timeout"))
      .mockReturnValueOnce(recoveredAuth.promise);
    const setStatus = vi.fn();

    const monitor = startSlackMonitor(monitorSlackProvider, { setStatus });
    await vi.waitFor(() => expect(getSlackInstallationKind("default")).toBe("degraded"));
    expect(() => assertSlackDetachedTargetAllowed("default")).toThrow(
      "unsupported_enterprise_slack_delivery",
    );
    expect(() => assertSlackDetachedTargetAllowed("default", "T_RECOVERED")).not.toThrow();

    recoveredAuth.resolve({
      app_id: "A_WORKSPACE",
      user_id: "UWORKSPACE",
      bot_id: "BWORKSPACE",
      team_id: "T_WORKSPACE",
      is_enterprise_install: false,
    });
    await vi.waitFor(() => expect(getSlackInstallationKind("default")).toBe("workspace"));
    expect(client.auth.test).toHaveBeenCalledTimes(2);
    expect(() => assertSlackDetachedTargetAllowed("default")).not.toThrow();
    await stopSlackMonitor(monitor);

    expect(setStatus).toHaveBeenCalledWith({
      running: true,
      connected: true,
      lastConnectedAt: expect.any(Number),
      terminalDisconnect: undefined,
      lifecycle: "ready",
      lastError: null,
    });
    expect(getSlackInstallationKind("default")).toBeUndefined();
    expect(() => assertSlackDetachedTargetAllowed("default")).not.toThrow();
  });

  it("promotes recovered Enterprise identity before dispatching its first event", async () => {
    resetSlackTestState({
      channels: {
        slack: {
          dmPolicy: "disabled",
          groupPolicy: "open",
          channels: {
            "team:TWORKSPACE:channel:C12345678": { allow: true, requireMention: true },
          },
        },
      },
    });
    const client = getSlackClient();
    client.auth.test.mockRejectedValueOnce(new Error("request_timeout")).mockResolvedValue({
      app_id: "A_ENTERPRISE",
      user_id: "UENTERPRISE",
      bot_id: "BENTERPRISE",
      enterprise_id: "E_ENTERPRISE",
      is_enterprise_install: true,
    });
    client.conversations.info.mockResolvedValueOnce({
      channel: { name: "general", is_channel: true },
    });
    const { replyMock, sendMock } = getSlackTestState();
    replyMock.mockResolvedValue({ text: "identity restored" });
    const setStatus = vi.fn();
    const monitor = startSlackMonitor(monitorSlackProvider, { setStatus });
    const handler = await getSlackHandlerOrThrow("message");

    await vi.waitFor(() => expect(getSlackInstallationKind("default")).toBe("enterprise"));
    expect(client.auth.test).toHaveBeenCalledTimes(2);
    expect(() => assertSlackDetachedTargetAllowed("default")).toThrow(
      "unsupported_enterprise_slack_delivery",
    );
    expect(() => assertSlackDetachedTargetAllowed("default", "TWORKSPACE")).not.toThrow();
    expect(setStatus).toHaveBeenCalledWith({
      running: true,
      connected: true,
      lastConnectedAt: expect.any(Number),
      terminalDisconnect: undefined,
      lifecycle: "ready",
      lastError: null,
    });
    expect(getSlackHandlers().has("reaction_added")).toBe(true);

    await handler({
      event: {
        type: "message",
        user: "UOTHER123",
        text: "<@UENTERPRISE> status",
        ts: "999999.123",
        channel: "C12345678",
        channel_type: "channel",
      },
      context: {
        isEnterpriseInstall: true,
        enterpriseId: "E_ENTERPRISE",
        teamId: "TWORKSPACE",
      },
      body: { api_app_id: "A_ENTERPRISE" },
      client,
    });

    expect(client.conversations.info).toHaveBeenCalledWith(
      expect.objectContaining({ channel: "C12345678" }),
    );
    expect(replyMock).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(sendMock).toHaveBeenCalledTimes(1));
    expect(sendMock).toHaveBeenCalledWith(
      "channel:C12345678",
      "identity restored",
      expect.objectContaining({
        eventScope: expect.objectContaining({ teamId: "TWORKSPACE", client }),
      }),
    );
    await stopSlackMonitor(monitor);
  });

  it("validates Enterprise policy before promoting recovered identity", async () => {
    resetSlackTestState({ channels: { slack: { dangerouslyAllowNameMatching: true } } });
    const client = getSlackClient();
    client.auth.test.mockRejectedValueOnce(new Error("request_timeout")).mockResolvedValue({
      user_id: "UENTERPRISE",
      bot_id: "BENTERPRISE",
      enterprise_id: "E_ENTERPRISE",
      is_enterprise_install: true,
    });
    const setStatus = vi.fn();
    const monitor = startSlackMonitor(monitorSlackProvider, { setStatus });

    await vi.waitFor(() => expect(client.auth.test).toHaveBeenCalledTimes(2));
    expect(setStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        connected: true,
        lifecycle: "blocked",
        lastError: expect.stringMatching(/cannot use dangerouslyAllowNameMatching/),
      }),
    );
    expect(getSlackHandlers().has("reaction_added")).toBe(true);
    await stopSlackMonitor(monitor);
  });
});
