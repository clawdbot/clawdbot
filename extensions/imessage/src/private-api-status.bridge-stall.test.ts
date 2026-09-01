// Imessage plugin tests cover discarding a cached bridge verdict when the
// injected helper stops answering.
import { describe, expect, it } from "vitest";
import { isIMessageBridgeStall } from "./client.js";
import {
  getCachedIMessagePrivateApiStatus,
  type IMessagePrivateApiStatus,
  invalidateCachedIMessagePrivateApiStatus,
  setCachedIMessagePrivateApiStatus,
} from "./private-api-status.js";

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
    // Discarding the capability cache on these would force a needless re-probe
    // on every bad argument the model supplies.
    expect(isIMessageBridgeStall(new Error('Unknown target "***" for iMessage.'))).toBe(false);
    expect(
      isIMessageBridgeStall(new Error("bridge transport requires an existing chat target")),
    ).toBe(false);
    expect(isIMessageBridgeStall(undefined)).toBe(false);
  });
});

describe("invalidateCachedIMessagePrivateApiStatus", () => {
  it("drops a positive verdict that would otherwise never expire", () => {
    // A successful probe is cached with expiresAt=0, so before this existed the
    // verdict outlived the bridge and every later send was dispatched into a
    // dead one, surfacing an opaque -32603 rather than "run imsg launch".
    const cliPath = "/tmp/imsg-stall-fixture";
    setCachedIMessagePrivateApiStatus(cliPath, available);
    expect(getCachedIMessagePrivateApiStatus(cliPath)?.available).toBe(true);

    invalidateCachedIMessagePrivateApiStatus(cliPath);

    expect(getCachedIMessagePrivateApiStatus(cliPath)).toBeUndefined();
  });

  it("normalizes the cli path the same way the setter does", () => {
    setCachedIMessagePrivateApiStatus("imsg", available);
    expect(getCachedIMessagePrivateApiStatus("  imsg  ")?.available).toBe(true);

    invalidateCachedIMessagePrivateApiStatus("  imsg  ");

    expect(getCachedIMessagePrivateApiStatus("imsg")).toBeUndefined();
  });

  it("leaves other cli paths alone", () => {
    setCachedIMessagePrivateApiStatus("/tmp/imsg-a", available);
    setCachedIMessagePrivateApiStatus("/tmp/imsg-b", available);

    invalidateCachedIMessagePrivateApiStatus("/tmp/imsg-a");

    expect(getCachedIMessagePrivateApiStatus("/tmp/imsg-a")).toBeUndefined();
    expect(getCachedIMessagePrivateApiStatus("/tmp/imsg-b")?.available).toBe(true);
  });
});
