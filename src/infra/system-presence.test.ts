// Covers in-memory system presence merging and expiry behavior.
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  listSystemPresence,
  touchPresence,
  updateSystemPresence,
  upsertPresence,
} from "./system-presence.js";

describe("system-presence", () => {
  afterEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 5 * 60 * 1000 + 1);
    listSystemPresence();
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

  it("clears retained input activity on explicit null", () => {
    const instanceId = `presence-clear-${randomUUID()}`;
    updateSystemPresence({
      text: "Node: desk · mode ui",
      instanceId,
      host: "desk",
      mode: "ui",
      lastInputSeconds: 4,
    });

    updateSystemPresence({
      text: "Node: desk · mode ui",
      instanceId,
      host: "desk",
      mode: "ui",
      lastInputSeconds: null,
    });

    const entry = listSystemPresence().find((candidate) => candidate.instanceId === instanceId);
    expect(entry?.host).toBe("desk");
    expect(entry?.lastInputSeconds).toBeUndefined();
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

  it("keeps fallback text keys UTF-16 safe", () => {
    const keyPrefix = `presence-${randomUUID()}`.padEnd(63, "x");
    const update = updateSystemPresence({ text: `${keyPrefix}🚀tail` });

    expect(update.key).toBe(keyPrefix);
  });

  it("keeps connection-owned presence alive when its heartbeat is acknowledged", () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.now());

    const connectionId = randomUUID();
    upsertPresence(connectionId, {
      host: "control-ui",
      instanceId: connectionId,
      mode: "webchat",
      reason: "connect",
    });

    vi.advanceTimersByTime(4 * 60 * 1000);
    expect(touchPresence(connectionId)).toBe(true);
    vi.advanceTimersByTime(4 * 60 * 1000);

    expect(listSystemPresence().map((entry) => entry.instanceId)).toContain(connectionId);
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

  it("keeps the gateway when the clock jumps forward during expiry pruning", () => {
    vi.useFakeTimers();
    const now = Date.now();
    const self = listSystemPresence().find((entry) => entry.reason === "self");
    expect(self?.instanceId).toBeDefined();
    const clock = vi
      .spyOn(Date, "now")
      .mockReturnValueOnce(now)
      .mockReturnValue(now + 5 * 60 * 1000 + 1);
    try {
      expect(
        listSystemPresence().filter((entry) => entry.instanceId === self?.instanceId),
      ).toHaveLength(1);
    } finally {
      clock.mockRestore();
    }
  });

  function addCapacityPeers(prefix: string) {
    for (let index = 0; index < 205; index += 1) {
      const deviceId = `${prefix}${index}`;
      upsertPresence(deviceId, { deviceId, host: deviceId, mode: "ui" });
    }
  }

  it("counts the gateway within the capacity limit when peers have tied timestamps", () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 24 * 60 * 60 * 1000);
    const self = listSystemPresence().find((entry) => entry.reason === "self");
    expect(self?.instanceId).toBeDefined();
    const prefix = `bounded-${randomUUID()}-`;
    addCapacityPeers(prefix);

    const snapshot = listSystemPresence();
    expect(snapshot).toHaveLength(200);
    expect(snapshot.filter((entry) => entry.instanceId === self?.instanceId)).toHaveLength(1);
    expect(snapshot.some((entry) => entry.deviceId === `${prefix}0`)).toBe(false);
    expect(snapshot.some((entry) => entry.deviceId === `${prefix}204`)).toBe(true);
  });

  it.each(["connection", "beacon"] as const)(
    "keeps the genuine gateway row when a %s uses its hostname key",
    (source) => {
      vi.useFakeTimers();
      vi.setSystemTime(Date.now() + 24 * 60 * 60 * 1000);
      const self = listSystemPresence().find((entry) => entry.reason === "self");
      if (!self?.host || !self.instanceId) {
        throw new Error("gateway presence was not initialized");
      }
      const forged = {
        deviceId: self.host,
        instanceId: self.instanceId,
        host: self.host,
        mode: "gateway",
        reason: "self",
        text: "caller-controlled gateway row",
      };
      if (source === "connection") {
        upsertPresence(self.host, forged);
      } else {
        updateSystemPresence(forged);
      }
      const snapshot = listSystemPresence();
      expect(snapshot.filter((entry) => entry.text === self.text)).toHaveLength(1);
      expect(snapshot.filter((entry) => entry.text === forged.text)).toHaveLength(1);
      expect(snapshot.find((entry) => entry.text === self.text)?.deviceId).toBeUndefined();
      addCapacityPeers(`collision-${randomUUID()}-`);
      const bounded = listSystemPresence();
      expect(bounded).toHaveLength(200);
      expect(bounded.filter((entry) => entry.text === self.text)).toHaveLength(1);
      expect(bounded.some((entry) => entry.text === forged.text)).toBe(false);
    },
  );
});
