// Slack tests cover provider identity recovery from trusted Bolt event context.
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
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
  runSlackHandlerWithDispatch,
  startSlackMonitor as startSlackMonitorUntracked,
  stopSlackMonitor,
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

describe("auth.test event identity recovery", () => {
  it("does not adopt Enterprise identity from Bolt event context", async () => {
    resetSlackTestState({
      channels: {
        slack: {
          mode: "http",
          signingSecret: "test-signing-secret",
          dmPolicy: "disabled",
          groupPolicy: "open",
          channels: { C12345678: { allow: true, requireMention: true } },
        },
      },
    });
    const client = getSlackClient();
    client.auth.test.mockRejectedValue(new Error("request_timeout"));
    client.conversations.info.mockResolvedValueOnce({
      channel: { name: "general", is_channel: true },
    });
    const { replyMock, sendMock } = getSlackTestState();
    replyMock.mockResolvedValue({ text: "unexpected" });
    const setStatus = vi.fn();
    const monitor = startSlackMonitor(monitorSlackProvider, { setStatus });
    const handler = await getSlackHandlerOrThrow("message");

    await handler({
      event: {
        type: "message",
        user: "UOTHER123",
        text: "<@UCONTEXT> status",
        ts: "100.000",
        channel: "C12345678",
        channel_type: "channel",
      },
      context: {
        botUserId: "UCONTEXT",
        botId: "BCONTEXT",
        isEnterpriseInstall: true,
        enterpriseId: "E_ENTERPRISE",
        teamId: "TWORKSPACE",
      },
      body: { api_app_id: "A_ENTERPRISE" },
      client,
    });

    expect(setStatus).not.toHaveBeenCalledWith(expect.objectContaining({ lifecycle: "ready" }));
    expect(replyMock).not.toHaveBeenCalled();
    expect(sendMock).not.toHaveBeenCalled();
    await stopSlackMonitor(monitor);
  });

  it("adopts Bolt identity from the first HTTP event and restores mention detection", async () => {
    resetSlackTestState({
      channels: {
        slack: {
          mode: "http",
          signingSecret: "test-signing-secret",
          groupPolicy: "open",
          requireMention: true,
        },
      },
    });
    const client = getSlackClient();
    client.auth.test.mockRejectedValue(new Error("request_timeout"));
    client.conversations.info.mockResolvedValueOnce({
      channel: { name: "general", is_channel: true },
    });
    const { replyMock, sendMock } = getSlackTestState();
    replyMock.mockResolvedValue({ text: "identity restored" });
    const setStatus = vi.fn();
    const monitor = startSlackMonitor(monitorSlackProvider, { setStatus });
    const handler = await getSlackHandlerOrThrow("message");

    expect(setStatus).toHaveBeenCalledWith({
      connected: true,
      lastConnectedAt: expect.any(Number),
      terminalDisconnect: true,
      lifecycle: "blocked",
      lastError: "request_timeout",
    });
    expect(setStatus).not.toHaveBeenCalledWith(expect.objectContaining({ connected: false }));

    await runSlackHandlerWithDispatch(handler, {
      event: {
        type: "message",
        user: "U_OTHER",
        text: "<@URECOVERED> status",
        ts: "999999.123",
        channel: "C12345678",
        channel_type: "channel",
      },
      context: {
        botUserId: "URECOVERED",
        botId: "BRECOVERED",
        teamId: "T12345678",
        isEnterpriseInstall: false,
      },
      body: {},
    });

    expect(setStatus).toHaveBeenCalledWith({
      running: true,
      connected: true,
      lastConnectedAt: expect.any(Number),
      terminalDisconnect: undefined,
      lifecycle: "ready",
      lastError: null,
    });
    expect(getSlackHandlers().has("reaction_added")).toBe(true);
    expect(replyMock).toHaveBeenCalledTimes(1);
    expect(sendMock).toHaveBeenCalledWith(
      "channel:C12345678",
      "identity restored",
      expect.any(Object),
    );
    await stopSlackMonitor(monitor);
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

    await runSlackHandlerWithDispatch(handler, {
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

    const dispatchedContext = replyMock.mock.calls[0]?.[0];
    expect(dispatchedContext).toMatchObject({
      Body: expect.stringMatching(/<@U_SELF>.*status/u),
      ChatType: "channel",
      WasMentioned: true,
    });
    expect(sendMock).toHaveBeenCalledWith("channel:C1", "acknowledged", expect.any(Object));
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

    await runSlackHandlerWithDispatch(handler, {
      event: { ...baseEvent, user: "U_OTHER", ts: "100.000" },
      context: { botUserId: "U_SELF" },
      body: {},
    });
    const dispatchedContext = replyMock.mock.calls[0]?.[0];
    expect(dispatchedContext).toMatchObject({
      Body: expect.stringMatching(/Ada: hello\n\[slack message id: 100\.000 channel: D1\]$/u),
      ChatType: "direct",
      WasMentioned: false,
    });
    expect(sendMock).toHaveBeenCalledWith("channel:D1", "hello back", expect.any(Object));

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

    await runSlackHandlerWithDispatch(handler, {
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
    const dispatchedContext = replyMock.mock.calls[0]?.[0];
    expect(dispatchedContext).toMatchObject({
      Body: expect.stringMatching(/<@UENTERPRISE>.*status/u),
      ChatType: "channel",
      WasMentioned: true,
    });
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
