// Slack tests cover provider identity recovery from trusted Bolt event context.
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  disposeSlackTestRuntime,
  getSlackClient,
  getSlackHandlerOrThrow,
  getSlackHandlers,
  getSlackTestState,
  resetSlackTestState,
  startSlackMonitor as startSlackMonitorUntracked,
  stopSlackMonitor,
} from "../monitor.test-helpers.js";

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
    await vi.waitFor(() => expect(sendMock).toHaveBeenCalledTimes(1));
    await stopSlackMonitor(monitor);
  });
});
