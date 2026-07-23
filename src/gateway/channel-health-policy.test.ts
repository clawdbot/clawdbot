/**
 * Channel health policy regression tests.
 */
import { describe, expect, it } from "vitest";
import { evaluateChannelHealth, resolveChannelRestartReason } from "./channel-health-policy.js";

function evaluateHealth(
  account: Record<string, unknown>,
  opts: { now?: number; channelId?: string } = {},
) {
  const { now = 100_000, channelId = "discord" } = opts;
  return evaluateChannelHealth(account, {
    channelId,
    now,
    channelConnectGraceMs: 10_000,
    staleEventThresholdMs: 30_000,
  });
}

function runningAccount(overrides: Record<string, unknown> = {}) {
  return {
    running: true,
    enabled: true,
    configured: true,
    ...overrides,
  };
}

function connectedAccount(overrides: Record<string, unknown> = {}) {
  return runningAccount({ connected: true, ...overrides });
}

function activeRunAccount(lastRunActivityAt: number, overrides: Record<string, unknown> = {}) {
  return runningAccount({
    connected: false,
    activeRuns: 1,
    lastRunActivityAt,
    ...overrides,
  });
}

function staleTransportAccount(overrides: Record<string, unknown> = {}) {
  return connectedAccount({
    lastStartAt: 0,
    lastTransportActivityAt: 0,
    ...overrides,
  });
}

function inheritedTransportAccount() {
  return connectedAccount({
    lastStartAt: 50_000,
    lastTransportActivityAt: 10_000,
  });
}

describe("evaluateChannelHealth", () => {
  it("treats disabled accounts as healthy unmanaged", () => {
    const evaluation = evaluateHealth({
      running: false,
      enabled: false,
      configured: true,
    });
    expect(evaluation).toEqual({ healthy: true, reason: "unmanaged" });
  });

  it("uses channel connect grace before flagging disconnected", () => {
    const evaluation = evaluateHealth(
      runningAccount({
        connected: false,
        lastStartAt: 95_000,
      }),
    );
    expect(evaluation).toEqual({ healthy: true, reason: "startup-connect-grace" });
  });

  it("treats active runs as busy even when disconnected", () => {
    const now = 100_000;
    const evaluation = evaluateHealth(activeRunAccount(now - 30_000), { now });
    expect(evaluation).toEqual({ healthy: true, reason: "busy" });
  });

  it("flags stale busy channels as stuck when run activity is too old", () => {
    const now = 100_000;
    const evaluation = evaluateHealth(activeRunAccount(now - 26 * 60_000), { now });
    expect(evaluation).toEqual({ healthy: false, reason: "stuck" });
  });

  it("flags a hung run masking a disconnected transport as stuck despite a fresh heartbeat", () => {
    const now = 30 * 60_000;
    const evaluation = evaluateHealth(
      activeRunAccount(now - 1_000, {
        connected: false,
        activeRunStartedAt: now - 26 * 60_000,
      }),
      { now },
    );
    expect(evaluation).toEqual({ healthy: false, reason: "stuck" });
  });

  it("keeps a connected run healthy past the threshold while its heartbeat stays fresh", () => {
    const now = 30 * 60_000;
    const evaluation = evaluateHealth(
      activeRunAccount(now - 1_000, {
        connected: true,
        activeRunStartedAt: now - 26 * 60_000,
      }),
      { now },
    );
    expect(evaluation).toEqual({ healthy: true, reason: "busy" });
  });

  it("keeps a run without transport reporting healthy past the threshold while its heartbeat stays fresh", () => {
    const now = 30 * 60_000;
    const evaluation = evaluateHealth(
      activeRunAccount(now - 1_000, {
        connected: undefined,
        activeRunStartedAt: now - 26 * 60_000,
      }),
      { now },
    );
    expect(evaluation).toEqual({ healthy: true, reason: "busy" });
  });

  it("keeps a short-lived run healthy when both start and activity are recent", () => {
    const now = 30 * 60_000;
    const evaluation = evaluateHealth(
      activeRunAccount(now - 1_000, {
        activeRunStartedAt: now - 5_000,
      }),
      { now },
    );
    expect(evaluation).toEqual({ healthy: true, reason: "busy" });
  });

  it("ignores inherited busy flags until current lifecycle reports run activity", () => {
    const now = 100_000;
    const evaluation = evaluateHealth(
      runningAccount({
        connected: false,
        lastStartAt: now - 30_000,
        busy: true,
        activeRuns: 1,
        lastRunActivityAt: now - 31_000,
      }),
      { now },
    );
    expect(evaluation).toEqual({ healthy: false, reason: "disconnected" });
  });

  it("flags stale sockets when transport activity ages beyond threshold", () => {
    const evaluation = evaluateHealth(staleTransportAccount());
    expect(evaluation).toEqual({ healthy: false, reason: "stale-socket" });
  });

  it("ignores stale app events without transport activity", () => {
    const evaluation = evaluateHealth(
      connectedAccount({
        lastStartAt: 0,
        lastEventAt: 0,
      }),
    );
    expect(evaluation).toEqual({ healthy: true, reason: "healthy" });
  });

  it("keeps slack healthy when transport keepalive is fresh even if app events are stale", () => {
    const now = 100_000;
    const evaluation = evaluateHealth(
      connectedAccount({
        lastStartAt: 0,
        lastEventAt: 0,
        lastInboundAt: 0,
        lastTransportActivityAt: now - 5_000,
      }),
      { now, channelId: "slack" },
    );
    expect(evaluation).toEqual({ healthy: true, reason: "healthy" });
  });

  it("flags slack stale-socket when transport activity ages past threshold", () => {
    const evaluation = evaluateHealth(staleTransportAccount(), {
      channelId: "slack",
    });
    expect(evaluation).toEqual({ healthy: false, reason: "stale-socket" });
  });

  it("does not treat null slack transport stamps as stale-socket", () => {
    const evaluation = evaluateHealth(
      connectedAccount({
        lastStartAt: 0,
        lastEventAt: 0,
        lastTransportActivityAt: null,
      }),
      { channelId: "slack" },
    );
    expect(evaluation).toEqual({ healthy: true, reason: "healthy" });
  });

  it("flags stale sockets for telegram polling channels with transport activity", () => {
    const evaluation = evaluateHealth(staleTransportAccount({ mode: "polling" }), {
      channelId: "example",
    });
    expect(evaluation).toEqual({ healthy: false, reason: "stale-socket" });
  });

  it("does not special-case malformed channel mode when transport activity is explicit", () => {
    const evaluation = evaluateHealth(
      staleTransportAccount({ mode: { polling: true } as unknown as string }),
      { channelId: "example" },
    );
    expect(evaluation).toEqual({ healthy: false, reason: "stale-socket" });
  });

  it("trusts explicit transport activity instead of webhook mode heuristics", () => {
    const evaluation = evaluateHealth(staleTransportAccount({ mode: "webhook" }));
    expect(evaluation).toEqual({ healthy: false, reason: "stale-socket" });
  });

  it("does not flag stale sockets for channels without transport tracking", () => {
    const evaluation = evaluateHealth(
      connectedAccount({
        lastStartAt: 0,
        lastTransportActivityAt: null,
      }),
    );
    expect(evaluation).toEqual({ healthy: true, reason: "healthy" });
  });

  it("keeps quiet telegram webhooks healthy when they do not publish transport tracking", () => {
    const evaluation = evaluateHealth(
      connectedAccount({
        mode: "webhook",
        lastStartAt: 0,
        lastEventAt: 0,
      }),
      { channelId: "telegram" },
    );
    expect(evaluation).toEqual({ healthy: true, reason: "healthy" });
  });

  it("does not flag stale sockets without an active connected socket", () => {
    const evaluation = evaluateHealth(
      runningAccount({
        lastStartAt: 0,
        lastTransportActivityAt: 0,
      }),
      { now: 75_000, channelId: "slack" },
    );
    expect(evaluation).toEqual({ healthy: true, reason: "healthy" });
  });

  it("ignores inherited transport timestamps from a previous lifecycle", () => {
    const evaluation = evaluateHealth(inheritedTransportAccount(), {
      now: 75_000,
      channelId: "slack",
    });
    expect(evaluation).toEqual({ healthy: true, reason: "healthy" });
  });

  it("flags inherited transport timestamps after the lifecycle exceeds the stale threshold", () => {
    const evaluation = evaluateHealth(inheritedTransportAccount(), {
      now: 140_000,
      channelId: "slack",
    });
    expect(evaluation).toEqual({ healthy: false, reason: "stale-socket" });
  });

  it.each([
    {
      name: "distinguishes a stopped terminal channel",
      snapshot: { running: false, terminalDisconnect: true },
      expected: { healthy: false, reason: "terminal-disconnect" },
    },
    {
      name: "keeps ordinary stopped channels restartable",
      snapshot: { running: false, terminalDisconnect: false },
      expected: { healthy: false, reason: "not-running" },
    },
    {
      name: "ignores stale terminal state while running",
      snapshot: { running: true, connected: true, terminalDisconnect: true },
      expected: { healthy: true, reason: "healthy" },
    },
  ] as const)("$name", ({ snapshot, expected }) => {
    expect(
      evaluateHealth({ enabled: true, configured: true, ...snapshot }, { channelId: "whatsapp" }),
    ).toEqual(expected);
  });
});

describe("resolveChannelRestartReason", () => {
  it("maps not-running + high reconnect attempts to gave-up", () => {
    const reason = resolveChannelRestartReason(
      {
        running: false,
        reconnectAttempts: 10,
      },
      { healthy: false, reason: "not-running" },
    );
    expect(reason).toBe("gave-up");
  });

  it("maps disconnected to disconnected instead of stuck", () => {
    const reason = resolveChannelRestartReason(
      runningAccount({
        connected: false,
      }),
      { healthy: false, reason: "disconnected" },
    );
    expect(reason).toBe("disconnected");
  });
});
