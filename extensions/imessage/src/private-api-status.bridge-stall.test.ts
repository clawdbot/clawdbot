// Imessage plugin tests cover discarding a cached bridge verdict when the
// injected helper stops answering.
//
// The stall matcher itself is module-private to client.ts; its behavior is
// covered through request() in client.test.ts rather than by calling it here.
import { describe, expect, it } from "vitest";
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
