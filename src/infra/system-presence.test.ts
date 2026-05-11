import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { listSystemPresence, updateSystemPresence, upsertPresence } from "./system-presence.js";

describe("system-presence", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("dedupes entries across sources by case-insensitive instanceId key", () => {
    const instanceIdUpper = `AaBb-${randomUUID()}`.toUpperCase();
    const instanceIdLower = instanceIdUpper.toLowerCase();

    upsertPresence(instanceIdUpper, {
      host: "openclaw",
      mode: "ui",
      instanceId: instanceIdUpper,
      reason: "connect",
    });

    updateSystemPresence({
      text: "Node: Peter-Mac-Studio (10.0.0.1) · ui 2.0.0 · last input 5s ago · mode ui · reason beacon",
      instanceId: instanceIdLower,
      host: "Peter-Mac-Studio",
      ip: "10.0.0.1",
      mode: "ui",
      version: "2.0.0",
      lastInputSeconds: 5,
      reason: "beacon",
    });

    const matches = listSystemPresence().filter(
      (e) => (e.instanceId ?? "").toLowerCase() === instanceIdLower,
    );
    expect(matches).toHaveLength(1);
    expect(matches[0]?.host).toBe("Peter-Mac-Studio");
    expect(matches[0]?.ip).toBe("10.0.0.1");
    expect(matches[0]?.lastInputSeconds).toBe(5);
  });

  it("merges roles and scopes for the same device", () => {
    const deviceId = randomUUID();

    upsertPresence(deviceId, {
      deviceId,
      host: "openclaw",
      roles: ["operator"],
      scopes: ["operator.admin"],
      reason: "connect",
    });

    upsertPresence(deviceId, {
      deviceId,
      roles: ["node"],
      scopes: ["system.run"],
      reason: "connect",
    });

    const entry = listSystemPresence().find((e) => e.deviceId === deviceId);
    expect(entry?.roles).toEqual(["operator", "node"]);
    expect(entry?.scopes).toEqual(["operator.admin", "system.run"]);
  });

  it("parses node presence text and normalizes the update key", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-11T04:00:00.000Z"));
    const update = updateSystemPresence({
      text: "Node: Relay-Host (10.0.0.9) · app 2.1.0 · last input 7s ago · mode ui · reason beacon",
      instanceId: "  Mixed-Case-Node  ",
    });

    expect(update.key).toBe("mixed-case-node");
    expect(update.changedKeys).toEqual(["host", "ip", "version", "mode", "reason"]);
    expect(update).toEqual({
      key: "mixed-case-node",
      previous: undefined,
      changedKeys: ["host", "ip", "version", "mode", "reason"],
      changes: {
        host: "Relay-Host",
        ip: "10.0.0.9",
        version: "2.1.0",
        mode: "ui",
        reason: "beacon",
      },
      next: {
        instanceId: "  Mixed-Case-Node  ",
        lastInputSeconds: 7,
        text: "Node: Relay-Host (10.0.0.9) · app 2.1.0 · last input 7s ago · mode ui · reason beacon",
        ts: 1_778_472_000_000,
        host: "Relay-Host",
        ip: "10.0.0.9",
        version: "2.1.0",
        mode: "ui",
        reason: "beacon",
      },
    });
  });

  it("drops blank role and scope entries while keeping fallback text", () => {
    const deviceId = randomUUID();

    upsertPresence(deviceId, {
      deviceId,
      host: "relay-host",
      mode: "operator",
      roles: [" operator ", "", "  "],
      scopes: ["operator.admin", "", "  "],
    });

    const entry = listSystemPresence().find((candidate) => candidate.deviceId === deviceId);
    expect(entry?.roles).toEqual(["operator"]);
    expect(entry?.scopes).toEqual(["operator.admin"]);
    expect(entry?.text).toBe("Node: relay-host · mode operator");
  });

  it("prunes stale non-self entries after TTL", () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.now());

    const deviceId = randomUUID();
    upsertPresence(deviceId, {
      deviceId,
      host: "stale-host",
      mode: "ui",
      reason: "connect",
    });

    expect(listSystemPresence().map((entry) => entry.deviceId)).toContain(deviceId);

    vi.advanceTimersByTime(5 * 60 * 1000 + 1);

    const entries = listSystemPresence();
    expect(entries.map((entry) => entry.deviceId)).not.toContain(deviceId);
    expect(entries.map((entry) => entry.reason)).toContain("self");
  });
});
