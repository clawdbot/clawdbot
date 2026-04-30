import { describe, expect, it } from "vitest";
import { evaluateChannelHealth, resolveChannelRestartReason } from "./channel-health-policy.js";

function evaluateDiscordHealth(
  account: Record<string, unknown>,
  now = 100_000,
  channelId = "discord",
) {
  return evaluateChannelHealth(account, {
    channelId,
    now,
    channelConnectGraceMs: 10_000,
    staleEventThresholdMs: 30_000,
  });
}

describe("evaluateChannelHealth", () => {
  it("treats disabled accounts as healthy unmanaged", () => {
    const evaluation = evaluateChannelHealth(
      {
        running: false,
        enabled: false,
        configured: true,
      },
      {
        channelId: "discord",
        now: 100_000,
        channelConnectGraceMs: 10_000,
        staleEventThresholdMs: 30_000,
      },
    );
    expect(evaluation).toEqual({ healthy: true, reason: "unmanaged" });
  });

  it("uses channel connect grace before flagging disconnected", () => {
    const evaluation = evaluateChannelHealth(
      {
        running: true,
        connected: false,
        enabled: true,
        configured: true,
        lastStartAt: 95_000,
      },
      {
        channelId: "discord",
        now: 100_000,
        channelConnectGraceMs: 10_000,
        staleEventThresholdMs: 30_000,
      },
    );
    expect(evaluation).toEqual({ healthy: true, reason: "startup-connect-grace" });
  });

  it("treats active runs as busy even when disconnected", () => {
    const now = 100_000;
    const evaluation = evaluateChannelHealth(
      {
        running: true,
        connected: false,
        enabled: true,
        configured: true,
        activeRuns: 1,
        lastRunActivityAt: now - 30_000,
      },
      {
        channelId: "discord",
        now,
        channelConnectGraceMs: 10_000,
        staleEventThresholdMs: 30_000,
      },
    );
    expect(evaluation).toEqual({ healthy: true, reason: "busy" });
  });

  it("flags stale busy channels as stuck when run activity is too old", () => {
    const now = 100_000;
    const evaluation = evaluateChannelHealth(
      {
        running: true,
        connected: false,
        enabled: true,
        configured: true,
        activeRuns: 1,
        lastRunActivityAt: now - 26 * 60_000,
      },
      {
        channelId: "discord",
        now,
        channelConnectGraceMs: 10_000,
        staleEventThresholdMs: 30_000,
      },
    );
    expect(evaluation).toEqual({ healthy: false, reason: "stuck" });
  });

  it("ignores inherited busy flags until current lifecycle reports run activity", () => {
    const now = 100_000;
    const evaluation = evaluateChannelHealth(
      {
        running: true,
        connected: false,
        enabled: true,
        configured: true,
        lastStartAt: now - 30_000,
        busy: true,
        activeRuns: 1,
        lastRunActivityAt: now - 31_000,
      },
      {
        channelId: "discord",
        now,
        channelConnectGraceMs: 10_000,
        staleEventThresholdMs: 30_000,
      },
    );
    expect(evaluation).toEqual({ healthy: false, reason: "disconnected" });
  });

  it("flags stale sockets when transport activity ages beyond threshold", () => {
    const evaluation = evaluateChannelHealth(
      {
        running: true,
        connected: true,
        enabled: true,
        configured: true,
        lastStartAt: 0,
        lastTransportActivityAt: 0,
      },
      {
        channelId: "discord",
        now: 100_000,
        channelConnectGraceMs: 10_000,
        staleEventThresholdMs: 30_000,
      },
    );
    expect(evaluation).toEqual({ healthy: false, reason: "stale-socket" });
  });

  it("ignores stale app events without transport activity", () => {
    const evaluation = evaluateChannelHealth(
      {
        running: true,
        connected: true,
        enabled: true,
        configured: true,
        lastStartAt: 0,
        lastEventAt: 0,
      },
      {
        channelId: "discord",
        now: 100_000,
        channelConnectGraceMs: 10_000,
        staleEventThresholdMs: 30_000,
      },
    );
    expect(evaluation).toEqual({ healthy: true, reason: "healthy" });
  });

  it("flags stale sockets for telegram polling channels with transport activity", () => {
    const evaluation = evaluateChannelHealth(
      {
        running: true,
        connected: true,
        enabled: true,
        configured: true,
        lastStartAt: 0,
        lastTransportActivityAt: 0,
        mode: "polling",
      },
      {
        channelId: "example",
        now: 100_000,
        channelConnectGraceMs: 10_000,
        staleEventThresholdMs: 30_000,
      },
    );
    expect(evaluation).toEqual({ healthy: false, reason: "stale-socket" });
  });

  it("does not special-case malformed channel mode when transport activity is explicit", () => {
    const evaluation = evaluateChannelHealth(
      {
        running: true,
        connected: true,
        enabled: true,
        configured: true,
        lastStartAt: 0,
        lastTransportActivityAt: 0,
        mode: { polling: true } as unknown as string,
      },
      {
        channelId: "example",
        now: 100_000,
        channelConnectGraceMs: 10_000,
        staleEventThresholdMs: 30_000,
      },
    );
    expect(evaluation).toEqual({ healthy: false, reason: "stale-socket" });
  });

  it("trusts explicit transport activity instead of webhook mode heuristics", () => {
    const evaluation = evaluateDiscordHealth({
      running: true,
      connected: true,
      enabled: true,
      configured: true,
      lastStartAt: 0,
      lastTransportActivityAt: 0,
      mode: "webhook",
    });
    expect(evaluation).toEqual({ healthy: false, reason: "stale-socket" });
  });

  it("does not flag stale sockets for channels without transport tracking", () => {
    const evaluation = evaluateDiscordHealth({
      running: true,
      connected: true,
      enabled: true,
      configured: true,
      lastStartAt: 0,
      lastTransportActivityAt: null,
    });
    expect(evaluation).toEqual({ healthy: true, reason: "healthy" });
  });

  it("keeps quiet telegram webhooks healthy when they do not publish transport tracking", () => {
    const evaluation = evaluateChannelHealth(
      {
        running: true,
        connected: true,
        enabled: true,
        configured: true,
        mode: "webhook",
        lastStartAt: 0,
        lastEventAt: 0,
      },
      {
        channelId: "telegram",
        now: 100_000,
        channelConnectGraceMs: 10_000,
        staleEventThresholdMs: 30_000,
      },
    );
    expect(evaluation).toEqual({ healthy: true, reason: "healthy" });
  });

  it("does not flag stale sockets without an active connected socket", () => {
    const evaluation = evaluateDiscordHealth(
      {
        running: true,
        enabled: true,
        configured: true,
        lastStartAt: 0,
        lastTransportActivityAt: 0,
      },
      75_000,
      "slack",
    );
    expect(evaluation).toEqual({ healthy: true, reason: "healthy" });
  });

  it("ignores inherited transport timestamps from a previous lifecycle", () => {
    const evaluation = evaluateDiscordHealth(
      {
        running: true,
        connected: true,
        enabled: true,
        configured: true,
        lastStartAt: 50_000,
        lastTransportActivityAt: 10_000,
      },
      75_000,
      "slack",
    );
    expect(evaluation).toEqual({ healthy: true, reason: "healthy" });
  });

  it("flags inherited transport timestamps after the lifecycle exceeds the stale threshold", () => {
    const evaluation = evaluateChannelHealth(
      {
        running: true,
        connected: true,
        enabled: true,
        configured: true,
        lastStartAt: 50_000,
        lastTransportActivityAt: 10_000,
      },
      {
        channelId: "slack",
        now: 140_000,
        channelConnectGraceMs: 10_000,
        staleEventThresholdMs: 30_000,
      },
    );
    expect(evaluation).toEqual({ healthy: false, reason: "stale-socket" });
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
      {
        running: true,
        connected: false,
        enabled: true,
        configured: true,
      },
      { healthy: false, reason: "disconnected" },
    );
    expect(reason).toBe("disconnected");
  });
});
