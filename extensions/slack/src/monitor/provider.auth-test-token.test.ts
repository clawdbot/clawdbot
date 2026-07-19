// Slack tests cover auth.test token handling during provider boot.
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  disposeSlackTestRuntime,
  flush,
  getSlackClient,
  getSlackHandlerOrThrow,
  getSlackTestState,
  resetSlackTestState,
  startSlackMonitor as startSlackMonitorUntracked,
  stopSlackMonitor,
  useRealSlackStartupAuthClientOnce,
} from "../monitor.test-helpers.js";

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
    client.auth.test.mockResolvedValueOnce({
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
    client.auth.test.mockResolvedValueOnce({
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
        agent: expect.anything(),
        slackApiUrl: "https://slack.test/api/",
      }),
    );
    expect(getSlackClient().auth.test).toHaveBeenCalledTimes(1);
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
    useRealSlackStartupAuthClientOnce();

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
      await vi.waitFor(() => expect(appStartMock).toHaveBeenCalledTimes(1), { timeout: 12_000 });
      await vi.waitFor(() => expect(events).toContain("socket-closed"), { timeout: 1_000 });

      expect(server.requestCount).toBe(1);
      expect(server.requestUrl).toBe("/api/auth.test");
      expect(events).toContain("auth-settled");
      expect(events.indexOf("auth-settled")).toBeLessThan(events.indexOf("app-start"));
      expect(runtimeLog).toHaveBeenCalledWith(
        expect.stringContaining("timeout of 10000ms exceeded"),
      );
    } finally {
      monitor.controller.abort();
      await monitor.run;
      await server.close();
    }
  }, 20_000);

  it("preserves workspace startup when auth.test omits app_id", async () => {
    getSlackClient().auth.test.mockResolvedValueOnce({
      user_id: "UBOT",
      bot_id: "BBOT",
      team_id: "T1",
      is_enterprise_install: false,
    });

    const monitor = startSlackMonitor(monitorSlackProvider);
    await expect(stopSlackMonitor(monitor)).resolves.toBeUndefined();
  });

  it("starts an org-wide Socket Mode account when auth.test omits app_id", async () => {
    resetSlackTestState({
      channels: {
        slack: {
          enterpriseOrgInstall: true,
          dmPolicy: "disabled",
          groupPolicy: "open",
        },
      },
    });
    getSlackClient().auth.test.mockResolvedValueOnce({
      enterprise_id: "E1",
      is_enterprise_install: true,
    });

    const monitor = startSlackMonitor(monitorSlackProvider, {
      appToken: "xapp-1-A1-opaque",
    });
    await expect(stopSlackMonitor(monitor)).resolves.toBeUndefined();
  });

  it("rejects enterprise startup with the default pairing DM policy", async () => {
    resetSlackTestState({
      channels: {
        slack: {
          enterpriseOrgInstall: true,
        },
      },
    });

    const monitor = startSlackMonitor(monitorSlackProvider);
    await expect(monitor.run).rejects.toThrow(
      /supports DMs only with dm\.enabled=false.*dmPolicy="open"/,
    );
  });
});

describe("user identity provider transport", () => {
  const userSocketConfig = () => ({
    channels: {
      slack: {
        identity: "user",
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
          identity: "user",
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
          identity: "user",
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
          identity: "user",
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
          identity: "user",
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
      expected: { healthState: "healthy", lastError: null },
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
        healthState: "degraded",
        lastError: expect.stringContaining("without bot_id"),
      },
    },
    {
      name: "enterprise identity",
      auth: {
        enterprise_id: "E1",
        is_enterprise_install: true,
      },
      config: {
        channels: {
          slack: {
            enterpriseOrgInstall: true,
            dmPolicy: "disabled",
            groupPolicy: "open",
          },
        },
      },
      expected: { healthState: "healthy", lastError: null },
    },
  ])("publishes $name through the provider status callback", async ({ auth, config, expected }) => {
    if (config) {
      resetSlackTestState(config);
    }
    getSlackClient().auth.test.mockResolvedValueOnce(auth);
    const setStatus = vi.fn();

    const monitor = startSlackMonitor(monitorSlackProvider, { setStatus });
    await stopSlackMonitor(monitor);

    expect(setStatus).toHaveBeenCalledWith({
      connected: true,
      lastConnectedAt: expect.any(Number),
      ...expected,
    });
  });

  it("publishes auth.test failures as degraded", async () => {
    getSlackClient().auth.test.mockRejectedValueOnce(new Error("request_timeout"));
    const setStatus = vi.fn();

    const monitor = startSlackMonitor(monitorSlackProvider, { setStatus });
    await stopSlackMonitor(monitor);

    expect(setStatus).toHaveBeenCalledWith({
      connected: true,
      lastConnectedAt: expect.any(Number),
      healthState: "degraded",
      lastError: "request_timeout",
    });
  });
});
