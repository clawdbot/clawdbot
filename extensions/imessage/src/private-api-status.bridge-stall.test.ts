// Imessage plugin tests cover treating an observed RPC stall as first-hand
// evidence that outranks imsg's own status claim.
import { describe, expect, it, vi } from "vitest";
import { isIMessageBridgeStall } from "./client.js";
import {
  getCachedIMessagePrivateApiStatus,
  type IMessagePrivateApiStatus,
  isIMessageBridgeStalled,
  recordIMessageBridgeAlive,
  recordIMessageBridgeStall,
  setCachedIMessagePrivateApiStatus,
} from "./private-api-status.js";
import { probeIMessagePrivateApi } from "./probe.js";

const available: IMessagePrivateApiStatus = {
  available: true,
  v2Ready: true,
  selectors: {},
  rpcMethods: [],
};

describe("isIMessageBridgeStall", () => {
  it("matches imsg's own wait timeout, the shape a wedged bridge produces", () => {
    // Verbatim from a 2026-08-31 incident where a flight-arrival notification
    // was dropped: Messages.app was alive and the dylib was still mapped, but
    // the injected helper had stopped answering.
    expect(
      isIMessageBridgeStall(
        new Error("Internal error: code=-32603 Timed out waiting for response to 'send-message'"),
      ),
    ).toBe(true);
  });

  it("matches a client-side request timeout", () => {
    expect(isIMessageBridgeStall(new Error("imsg rpc timeout (send)"))).toBe(true);
  });

  it("ignores ordinary rejections, which say nothing about bridge health", () => {
    // Treating these as a stall would suppress the bridge for a minute over an
    // ordinary bad argument.
    expect(isIMessageBridgeStall(new Error('Unknown target "***" for iMessage.'))).toBe(false);
    expect(
      isIMessageBridgeStall(new Error("bridge transport requires an existing chat target")),
    ).toBe(false);
    expect(isIMessageBridgeStall(undefined)).toBe(false);
  });
});

describe("recordIMessageBridgeStall", () => {
  it("drops a positive verdict that would otherwise never expire", () => {
    // A successful probe is cached with expiresAt=0, so before this existed the
    // verdict outlived the bridge and every later action was dispatched into a
    // dead one.
    const cliPath = "/tmp/imsg-stall-fixture";
    setCachedIMessagePrivateApiStatus(cliPath, available);
    expect(getCachedIMessagePrivateApiStatus(cliPath)?.available).toBe(true);

    recordIMessageBridgeStall(cliPath);

    expect(getCachedIMessagePrivateApiStatus(cliPath)).toBeUndefined();
    recordIMessageBridgeAlive(cliPath);
  });

  it("normalizes the cli path the same way the cache does", () => {
    setCachedIMessagePrivateApiStatus("imsg", available);
    recordIMessageBridgeStall("  imsg  ");
    expect(getCachedIMessagePrivateApiStatus("imsg")).toBeUndefined();
    expect(isIMessageBridgeStalled("imsg")).toBe(true);
    recordIMessageBridgeAlive("imsg");
  });

  it("leaves other cli paths alone", () => {
    setCachedIMessagePrivateApiStatus("/tmp/imsg-a", available);
    setCachedIMessagePrivateApiStatus("/tmp/imsg-b", available);

    recordIMessageBridgeStall("/tmp/imsg-a");

    expect(getCachedIMessagePrivateApiStatus("/tmp/imsg-a")).toBeUndefined();
    expect(getCachedIMessagePrivateApiStatus("/tmp/imsg-b")?.available).toBe(true);
    expect(isIMessageBridgeStalled("/tmp/imsg-b")).toBe(false);
    recordIMessageBridgeAlive("/tmp/imsg-a");
  });

  it("is released by first-hand evidence that the bridge answered", () => {
    const cliPath = "/tmp/imsg-stall-release";
    recordIMessageBridgeStall(cliPath);
    expect(isIMessageBridgeStalled(cliPath)).toBe(true);

    recordIMessageBridgeAlive(cliPath);

    expect(isIMessageBridgeStalled(cliPath)).toBe(false);
  });

  it("lapses on its own so a repaired bridge is not suppressed forever", () => {
    const cliPath = "/tmp/imsg-stall-lapse";
    recordIMessageBridgeStall(cliPath);
    expect(isIMessageBridgeStalled(cliPath)).toBe(true);

    vi.useFakeTimers();
    try {
      vi.setSystemTime(Date.now() + 61 * 1000);
      expect(isIMessageBridgeStalled(cliPath)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("probeIMessagePrivateApi", () => {
  // The whole point: `imsg status --json` reports the bridge connected from a
  // stale handshake during this exact wedge, so a probe that trusts it re-caches
  // the false positive the eviction just cleared. A recorded stall has to win.
  // The short-circuit also means no `imsg` subprocess is spawned here.
  it("reports unavailable while a stall is recorded, without consulting imsg status", async () => {
    const cliPath = "/tmp/imsg-probe-stalled";
    recordIMessageBridgeStall(cliPath);
    try {
      const status = await probeIMessagePrivateApi(cliPath, 5_000);
      expect(status.available).toBe(false);
      expect(status.error).toContain("imsg launch");
      expect(status.error).toContain("stopped responding to RPC");
    } finally {
      recordIMessageBridgeAlive(cliPath);
    }
  });
});
