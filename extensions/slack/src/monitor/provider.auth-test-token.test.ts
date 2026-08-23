// Slack tests cover auth.test token handling during provider boot.
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { WebClient } from "@slack/web-api";
import type { OpenKeyedStoreOptions } from "openclaw/plugin-sdk/plugin-state-runtime";
import { createPluginStateSyncKeyedStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getSlackInstallationKind } from "../installation-identity-state.js";
import {
  disposeSlackTestRuntime,
  getSlackClient,
  getSlackHandlerOrThrow,
  getSlackTestState,
  resetSlackTestState,
  runSlackHandlerWithDispatch,
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
    await runSlackHandlerWithDispatch(handler, {
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
    const dispatchedContext = replyMock.mock.calls[0]?.[0];
    expect(dispatchedContext).toMatchObject({
      Body: expect.stringMatching(/<@UENTERPRISE>.*status/u),
      ChatType: "channel",
      WasMentioned: true,
    });
    expect(sendMock).toHaveBeenCalledWith(
      "channel:C12345678",
      "identity preserved",
      expect.any(Object),
    );
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
    const { replyMock, sendMock } = getSlackTestState();
    replyMock.mockResolvedValue({ text: "ok" });

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
      await runSlackHandlerWithDispatch(handler, {
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
      const dispatchedContext = replyMock.mock.calls[0]?.[0];
      expect(dispatchedContext).toMatchObject({
        Body: expect.stringMatching(
          /Ada: hello\n\[slack message id: 100\.000 channel: D_STALLED\]$/u,
        ),
        ChatType: "direct",
        WasMentioned: false,
      });
      expect(sendMock).toHaveBeenCalledWith("channel:D_STALLED", "ok", expect.any(Object));
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
