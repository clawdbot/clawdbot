import { describe, expect, it } from "vitest";
import {
  DiscordPresenceEmissionGate,
  resolveDiscordPresenceGateOptions,
} from "./presence-emission-gate.js";

const options = resolveDiscordPresenceGateOptions(undefined);
const guildId = "guild-1";

function reserveAndCommit(
  gate: DiscordPresenceEmissionGate,
  targetGuildId: string,
  nowMs: number,
  gateOptions: Parameters<DiscordPresenceEmissionGate["reserveBurst"]>[2],
) {
  const decision = gate.reserveBurst(targetGuildId, nowMs, gateOptions);
  if (decision.allowed) {
    gate.commitBurst(targetGuildId, decision.reservation, nowMs);
  }
  return decision;
}

describe("resolveDiscordPresenceGateOptions", () => {
  it("defaults to a five-minute reconnect window and bounded burst", () => {
    expect(options).toEqual({
      reconnectSuppressMs: 5 * 60 * 1000,
      burstLimit: 8,
      burstWindowMs: 60 * 1000,
    });
  });

  it("converts configured seconds and honors zero as disabled", () => {
    expect(
      resolveDiscordPresenceGateOptions({
        reconnectSuppressSeconds: 0,
        burstLimit: 3,
        burstWindowSeconds: 10,
      }),
    ).toEqual({ reconnectSuppressMs: 0, burstLimit: 3, burstWindowMs: 10_000 });
  });
});

describe("DiscordPresenceEmissionGate", () => {
  it("suppresses emission during the reconnect window and logs once", () => {
    const gate = new DiscordPresenceEmissionGate();
    gate.noteGatewaySessionReset(1_000);

    expect(gate.evaluateReconnectWindow(1_001, options)).toEqual({
      allowed: false,
      reason: "reconnect-window",
      shouldLog: true,
    });
    expect(gate.evaluateReconnectWindow(2_000, options)).toEqual({
      allowed: false,
      reason: "reconnect-window",
      shouldLog: false,
    });
    expect(gate.evaluateReconnectWindow(1_000 + options.reconnectSuppressMs, options)).toEqual({
      allowed: true,
    });
  });

  it("logs again for each new reconnect window", () => {
    const gate = new DiscordPresenceEmissionGate();
    gate.noteGatewaySessionReset(0);
    expect(gate.evaluateReconnectWindow(1, options)).toMatchObject({ shouldLog: true });
    gate.noteGatewaySessionReset(options.reconnectSuppressMs * 2);
    expect(
      gate.evaluateReconnectWindow(options.reconnectSuppressMs * 2 + 1, options),
    ).toMatchObject({
      shouldLog: true,
    });
  });

  it("does not suppress when the reconnect window is disabled", () => {
    const gate = new DiscordPresenceEmissionGate();
    gate.noteGatewaySessionReset(1_000);
    expect(gate.evaluateReconnectWindow(1_001, { ...options, reconnectSuppressMs: 0 })).toEqual({
      allowed: true,
    });
  });

  it("rate-limits emission bursts within the sliding window", () => {
    const gate = new DiscordPresenceEmissionGate();
    const burstOptions = { ...options, burstLimit: 2, burstWindowMs: 10_000 };

    expect(reserveAndCommit(gate, guildId, 1_000, burstOptions)).toMatchObject({ allowed: true });
    expect(reserveAndCommit(gate, guildId, 2_000, burstOptions)).toMatchObject({ allowed: true });
    expect(gate.reserveBurst(guildId, 3_000, burstOptions)).toEqual({
      allowed: false,
      reason: "burst",
      shouldLog: true,
    });
    expect(gate.reserveBurst(guildId, 4_000, burstOptions)).toEqual({
      allowed: false,
      reason: "burst",
      shouldLog: false,
    });
    // The window drains as old emissions age out; logging re-arms for the next burst.
    expect(reserveAndCommit(gate, guildId, 12_500, burstOptions)).toMatchObject({ allowed: true });
    expect(reserveAndCommit(gate, guildId, 12_600, burstOptions)).toMatchObject({ allowed: true });
    expect(gate.reserveBurst(guildId, 12_700, burstOptions)).toEqual({
      allowed: false,
      reason: "burst",
      shouldLog: true,
    });
  });

  it("releases failed attempts without spending burst capacity", () => {
    const gate = new DiscordPresenceEmissionGate();
    const burstOptions = { ...options, burstLimit: 1 };
    const first = gate.reserveBurst(guildId, 1_000, burstOptions);

    expect(first.allowed).toBe(true);
    if (!first.allowed) {
      throw new Error("expected burst reservation");
    }
    gate.releaseBurst(guildId, first.reservation);

    expect(gate.reserveBurst(guildId, 1_001, burstOptions)).toMatchObject({ allowed: true });
  });

  it("holds lookup admission and starts the burst window when emission commits", () => {
    const gate = new DiscordPresenceEmissionGate();
    const burstOptions = { ...options, burstLimit: 1, burstWindowMs: 10_000 };
    const first = gate.reserveBurst(guildId, 1_000, burstOptions);

    expect(first.allowed).toBe(true);
    if (!first.allowed) {
      throw new Error("expected burst reservation");
    }
    expect(gate.reserveBurst(guildId, 12_000, burstOptions)).toMatchObject({
      allowed: false,
      reason: "burst-pending",
    });

    gate.commitBurst(guildId, first.reservation, 12_000);
    expect(gate.reserveBurst(guildId, 12_001, burstOptions)).toMatchObject({
      allowed: false,
      reason: "burst",
    });
    expect(gate.reserveBurst(guildId, 22_000, burstOptions)).toMatchObject({ allowed: true });
  });

  it("keeps burst limits and logging independent per guild", () => {
    const gate = new DiscordPresenceEmissionGate();
    const strict = { ...options, burstLimit: 1, burstWindowMs: 10_000 };
    const loose = { ...options, burstLimit: 2, burstWindowMs: 60_000 };

    expect(reserveAndCommit(gate, "guild-a", 1_000, strict)).toMatchObject({ allowed: true });
    expect(reserveAndCommit(gate, "guild-b", 1_000, loose)).toMatchObject({ allowed: true });
    expect(gate.reserveBurst("guild-a", 2_000, strict)).toEqual({
      allowed: false,
      reason: "burst",
      shouldLog: true,
    });
    expect(reserveAndCommit(gate, "guild-b", 2_000, loose)).toMatchObject({ allowed: true });
    expect(gate.reserveBurst("guild-b", 3_000, loose)).toEqual({
      allowed: false,
      reason: "burst",
      shouldLog: true,
    });
  });

  it("preserves the sliding burst window across gateway resets", () => {
    const gate = new DiscordPresenceEmissionGate();
    const burstOptions = { ...options, reconnectSuppressMs: 0, burstLimit: 1 };

    expect(reserveAndCommit(gate, guildId, 1_000, burstOptions)).toMatchObject({ allowed: true });
    gate.noteGatewaySessionReset(1_001);

    expect(gate.reserveBurst(guildId, 1_002, burstOptions)).toEqual({
      allowed: false,
      reason: "burst",
      shouldLog: true,
    });
  });
});
