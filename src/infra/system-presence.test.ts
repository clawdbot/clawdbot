// Covers in-memory system presence merging and expiry behavior.
import { randomUUID } from "node:crypto";
import os from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  listSystemPresence,
  touchPresence,
  updateSystemPresence,
  upsertPresence,
} from "./system-presence.js";

function useFakePerformanceClock() {
  vi.useFakeTimers();
  vi.spyOn(os, "uptime").mockReturnValue(0);
}

function useFakeSuspendClock() {
  const clock = { monotonic: performance.now(), uptime: os.uptime() };
  vi.useFakeTimers();
  vi.spyOn(performance, "now").mockImplementation(() => clock.monotonic);
  vi.spyOn(os, "uptime").mockImplementation(() => clock.uptime);
  return clock;
}

describe("system-presence", () => {
  afterEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 5 * 60 * 1000 + 1);
    listSystemPresence();
    vi.useRealTimers();
    vi.restoreAllMocks();
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
    useFakePerformanceClock();
    vi.setSystemTime(new Date("2026-05-11T04:00:00.000Z"));
    const update = updateSystemPresence({
      text: "Node: Relay-Host (10.0.0.9) · app 2.1.0 · last input 7s ago · mode ui · reason beacon",
      instanceId: "  Mixed-Case-Node  ",
    });

    expect(update.key).toBe("mixed-case-node");
    expect(update.changedKeys).toEqual(["host", "ip", "version", "mode", "reason"]);
    expect({ key: update.key, changedKeys: update.changedKeys, next: update.next }).toEqual({
      key: "mixed-case-node",
      changedKeys: ["host", "ip", "version", "mode", "reason"],
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

    const refreshed = updateSystemPresence({
      text: update.next.text,
      instanceId: "mixed-case-node",
      lastInputSeconds: 11,
    });
    expect(refreshed.changedKeys).toEqual([]);
    expect(refreshed.next.lastInputSeconds).toBe(11);
    expect(update.next.lastInputSeconds).toBe(7);

    const moved = updateSystemPresence({
      text: update.next.text,
      instanceId: "mixed-case-node",
      ip: "10.0.0.10",
    });
    expect(moved.changedKeys).toEqual(["ip"]);
    expect(moved.next.ip).toBe("10.0.0.10");
    expect(refreshed.next.ip).toBe("10.0.0.9");
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
    useFakePerformanceClock();
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
    useFakePerformanceClock();
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
    useFakePerformanceClock();
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
    useFakePerformanceClock();
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
      useFakePerformanceClock();
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

  it("prunes stale non-self entries after a forward wall-clock jump", () => {
    useFakePerformanceClock();
    const initialTime = Date.now() + 48 * 60 * 60 * 1000;
    vi.setSystemTime(initialTime);

    const deviceId = randomUUID();
    upsertPresence(deviceId, {
      deviceId,
      host: "suspended-stale-host",
      mode: "ui",
      reason: "connect",
    });

    vi.setSystemTime(initialTime + 5 * 60 * 1000 + 1);

    expect(listSystemPresence().map((entry) => entry.deviceId)).not.toContain(deviceId);
  });

  it("preserves freshness across clock rollback without extending the TTL", () => {
    useFakePerformanceClock();
    const initialTime = Date.now();
    vi.setSystemTime(initialTime);

    const deviceId = randomUUID();
    upsertPresence(deviceId, {
      deviceId,
      host: "rollback-stale-host",
      mode: "ui",
      reason: "connect",
    });

    vi.setSystemTime(initialTime - 60 * 60 * 1000);

    expect(listSystemPresence().map((entry) => entry.deviceId)).toContain(deviceId);

    vi.advanceTimersByTime(5 * 60 * 1000 + 1);

    const entries = listSystemPresence();
    expect(entries.map((entry) => entry.deviceId)).not.toContain(deviceId);
    expect(entries.map((entry) => entry.reason)).toContain("self");
  });

  it.each(["created", "refreshed"] as const)(
    "keeps presence %s during rollback fresh when wall time recovers",
    (action) => {
      useFakePerformanceClock();
      const initialTime = Date.now();
      const forwardTime = initialTime + 24 * 60 * 60 * 1000;
      vi.setSystemTime(forwardTime);
      listSystemPresence();

      const deviceId = randomUUID();
      const rolledTime = initialTime - 60 * 60 * 1000;
      if (action === "refreshed") {
        upsertPresence(deviceId, {
          deviceId,
          host: "rollback-refresh-host",
          mode: "ui",
          reason: "connect",
        });
      }
      vi.setSystemTime(rolledTime);
      if (action === "created") {
        upsertPresence(deviceId, {
          deviceId,
          host: "rollback-created-host",
          mode: "ui",
          reason: "connect",
        });
      } else {
        expect(touchPresence(deviceId)).toBe(true);
      }

      vi.advanceTimersByTime(60 * 1000);
      vi.setSystemTime(forwardTime + 60 * 1000);

      const recovered = listSystemPresence().find((entry) => entry.deviceId === deviceId);
      expect(recovered?.ts).toBe(rolledTime);

      vi.advanceTimersByTime(4 * 60 * 1000 + 1);

      expect(listSystemPresence().map((entry) => entry.deviceId)).not.toContain(deviceId);
    },
  );

  it("expires presence suspended while the wall clock remains rolled back", () => {
    const clock = useFakeSuspendClock();
    const initialTime = Date.now();
    vi.setSystemTime(initialTime);
    listSystemPresence();

    const deviceId = randomUUID();
    const rolledTime = initialTime - 60 * 60 * 1000;
    vi.setSystemTime(rolledTime);
    upsertPresence(deviceId, {
      deviceId,
      host: "rollback-suspended-host",
      mode: "ui",
      reason: "connect",
    });

    clock.uptime += 5 * 60 + 1;

    expect(listSystemPresence().map((entry) => entry.deviceId)).not.toContain(deviceId);
  });

  it("evicts stale presence before a peer refreshed during suspend and rollback", () => {
    const clock = useFakeSuspendClock();
    const initialTime = Date.now() + 24 * 60 * 60 * 1000;
    vi.setSystemTime(initialTime);
    listSystemPresence();

    const refreshedDeviceId = `rollback-refreshed-${randomUUID()}`;
    upsertPresence(refreshedDeviceId, {
      deviceId: refreshedDeviceId,
      host: "rollback-refreshed-host",
      mode: "ui",
      reason: "connect",
    });
    const staleDeviceId = `rollback-stale-${randomUUID()}`;
    upsertPresence(staleDeviceId, {
      deviceId: staleDeviceId,
      host: "rollback-stale-host",
      mode: "ui",
      reason: "connect",
    });

    vi.setSystemTime(initialTime - 60 * 60 * 1000);
    clock.uptime += 1;
    expect(touchPresence(refreshedDeviceId)).toBe(true);

    const freshPrefix = `rollback-fresh-${randomUUID()}-`;
    for (let index = 0; index < 198; index += 1) {
      upsertPresence(`${freshPrefix}${index}`, {
        deviceId: `${freshPrefix}${index}`,
        host: `rollback-fresh-host-${index}`,
        mode: "ui",
        reason: "connect",
      });
    }

    const entries = listSystemPresence();
    expect(entries.map((entry) => entry.deviceId)).not.toContain(staleDeviceId);
    expect(entries.map((entry) => entry.deviceId)).toContain(refreshedDeviceId);
    expect(entries.filter((entry) => entry.deviceId?.startsWith(freshPrefix))).toHaveLength(198);
    expect(entries.map((entry) => entry.reason)).toContain("self");
  });
});
