// Slack tests cover provider identity recovery from trusted Bolt event context.
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  disposeSlackTestRuntime,
  getSlackClient,
  getSlackHandlerOrThrow,
  getSlackHandlers,
  getSlackTestState,
  resetSlackTestState,
  runSlackHandlerWithDispatch,
  startSlackMonitor as startSlackMonitorUntracked,
  stopSlackMonitor,
} from "../monitor.test-helpers.js";
import { getSlackRuntime, setSlackRuntime } from "../runtime.js";

const { monitorSlackProvider } = await import("./provider.js");

type StartedSlackMonitor = ReturnType<typeof startSlackMonitorUntracked>;

const startedMonitors: StartedSlackMonitor[] = [];

function startSlackMonitor(...args: Parameters<typeof startSlackMonitorUntracked>) {
  const monitor = startSlackMonitorUntracked(...args);
  startedMonitors.push(monitor);
  return monitor;
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
});

afterAll(() => {
  disposeSlackTestRuntime();
});

describe("auth.test event identity recovery", () => {
  it("learns the app id from the first signed HTTP event and keeps it process-stable", async () => {
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
    const register = vi.fn(async () => undefined);
    const lookup = vi.fn(async () => undefined);
    const runtime = getSlackRuntime();
    setSlackRuntime({
      ...runtime,
      state: { ...runtime.state, openKeyedStore: vi.fn(() => ({ register, lookup })) },
    } as never);
    const client = getSlackClient();
    client.auth.test.mockResolvedValue({
      user_id: "bot-user",
      bot_id: "bot-id",
      team_id: "T_TEST",
      is_enterprise_install: false,
    });
    client.conversations.info.mockResolvedValueOnce({
      channel: { name: "general", is_channel: true },
    });
    const { replyMock, sendMock } = getSlackTestState();
    replyMock.mockResolvedValue({ text: "app identity learned" });
    const monitor = startSlackMonitor(monitorSlackProvider);
    const handler = await getSlackHandlerOrThrow("message");
    const context = {
      botUserId: "bot-user",
      botId: "bot-id",
      teamId: "T_TEST",
      isEnterpriseInstall: false,
    };
    const event = {
      type: "message",
      user: "U_OTHER",
      text: "<@bot-user> status",
      ts: "1700000100.000001",
      channel: "C12345678",
      channel_type: "channel",
    };

    await handler({ event, context, body: { api_app_id: "A_HTTP", team_id: "T_TEST" } });
    await vi.waitFor(() => expect(sendMock).toHaveBeenCalledTimes(1));

    await runSlackHandlerWithDispatch(handler, {
      event: { ...event, ts: "1700000100.000002" },
      context,
      body: { api_app_id: "A_OTHER", team_id: "T_TEST" },
    });
    expect.soft(sendMock).toHaveBeenCalledTimes(1);

    const agentHandler = await getSlackHandlerOrThrow("app_context_changed");
    await agentHandler({
      event: { type: "app_context_changed", user: "U_OTHER", context: { entities: [] } },
      context,
      body: { api_app_id: "A_HTTP", team_id: "T_TEST" },
    });
    expect(register).toHaveBeenCalledWith(
      JSON.stringify(["workspace", "default", "T_TEST", "A_HTTP"]),
      { experience: "agent", observedAt: expect.any(Number) },
    );
    await stopSlackMonitor(monitor);
  });

  it("keeps the app-token app id when a signed event carries another", async () => {
    const appToken = "xapp-1-A0TOKEN-1-secret";
    resetSlackTestState({
      channels: {
        slack: { mode: "socket", appToken, groupPolicy: "open", requireMention: true },
      },
    });
    const client = getSlackClient();
    client.auth.test.mockResolvedValue({
      user_id: "bot-user",
      bot_id: "bot-id",
      team_id: "T_TEST",
      is_enterprise_install: false,
    });
    client.conversations.info.mockResolvedValueOnce({
      channel: { name: "general", is_channel: true },
    });
    const { replyMock, sendMock, appStartMock } = getSlackTestState();
    replyMock.mockResolvedValue({ text: "app token identity preserved" });
    const started = new Promise<void>((resolve) => {
      appStartMock.mockImplementationOnce(async () => resolve());
    });
    const monitor = startSlackMonitor(monitorSlackProvider, { appToken });
    await started;
    const handler = await getSlackHandlerOrThrow("message");
    const context = {
      botUserId: "bot-user",
      botId: "bot-id",
      teamId: "T_TEST",
      isEnterpriseInstall: false,
    };
    const event = {
      type: "message",
      user: "U_OTHER",
      text: "<@bot-user> status",
      ts: "1700000300.000001",
      channel: "C12345678",
      channel_type: "channel",
    };

    await runSlackHandlerWithDispatch(handler, {
      event,
      context,
      body: { api_app_id: "A_OTHER", team_id: "T_TEST" },
    });
    expect(sendMock).not.toHaveBeenCalled();

    await runSlackHandlerWithDispatch(handler, {
      event: { ...event, ts: "1700000300.000002" },
      context,
      body: { api_app_id: "A0TOKEN", team_id: "T_TEST" },
    });
    await vi.waitFor(() => expect(sendMock).toHaveBeenCalledTimes(1));
    await stopSlackMonitor(monitor);
  });

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

    await handler({
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
      body: { api_app_id: "A_RECOVERED" },
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
    await vi.waitFor(() => expect(sendMock).toHaveBeenCalledTimes(1));

    await runSlackHandlerWithDispatch(handler, {
      event: {
        type: "message",
        user: "U_OTHER",
        text: "<@URECOVERED> status",
        ts: "999999.124",
        channel: "C12345678",
        channel_type: "channel",
      },
      context: {
        botUserId: "URECOVERED",
        botId: "BRECOVERED",
        teamId: "T12345678",
        isEnterpriseInstall: false,
      },
      body: { api_app_id: "A_OTHER" },
    });
    expect(sendMock).toHaveBeenCalledTimes(1);
    await stopSlackMonitor(monitor);
  });
});
