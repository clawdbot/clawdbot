// Imessage tests cover probe plugin behavior.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearCachedIMessagePrivateApiStatus,
  getCachedIMessagePrivateApiStatus,
  setCachedIMessagePrivateApiStatus,
} from "./private-api-status.js";
import { imessageRpcSupportsMethod } from "./probe.js";

afterEach(() => {
  vi.restoreAllMocks();
  clearCachedIMessagePrivateApiStatus();
});

describe("imessageRpcSupportsMethod", () => {
  it("returns false when the bridge is not available", () => {
    expect(
      imessageRpcSupportsMethod(
        {
          available: false,
          v2Ready: false,
          selectors: {},
          rpcMethods: ["typing", "read"],
        },
        "typing",
      ),
    ).toBe(false);
  });

  it("returns false when status is undefined", () => {
    expect(imessageRpcSupportsMethod(undefined, "typing")).toBe(false);
  });

  it("returns true when the requested method is in the explicit rpcMethods list", () => {
    expect(
      imessageRpcSupportsMethod(
        {
          available: true,
          v2Ready: true,
          selectors: {},
          rpcMethods: ["chats.list", "send", "typing", "read"],
        },
        "typing",
      ),
    ).toBe(true);
  });

  it("returns false for a method not in the explicit rpcMethods list", () => {
    expect(
      imessageRpcSupportsMethod(
        {
          available: true,
          v2Ready: true,
          selectors: {},
          rpcMethods: ["chats.list", "send"],
        },
        "typing",
      ),
    ).toBe(false);
  });

  it("falls back to the foundational set when rpcMethods is empty (older imsg builds)", () => {
    // Older imsg builds shipped chats.list/send/watch.*/messages.history
    // before the rpc_methods capability list existed. Without this fallback
    // we'd silently break send() on every gateway running an older imsg.
    const oldBuild = {
      available: true,
      v2Ready: true,
      selectors: {},
      rpcMethods: [],
    };
    for (const method of [
      "chats.list",
      "messages.history",
      "watch.subscribe",
      "watch.unsubscribe",
      "send",
    ]) {
      expect(imessageRpcSupportsMethod(oldBuild, method)).toBe(true);
    }
  });

  it("gates newer methods off when rpcMethods is empty (forces upgrade for typing/read/group)", () => {
    const oldBuild = {
      available: true,
      v2Ready: true,
      selectors: {},
      rpcMethods: [],
    };
    for (const method of [
      "typing",
      "read",
      "chats.create",
      "chats.delete",
      "chats.markUnread",
      "group.rename",
      "group.setIcon",
      "group.addParticipant",
      "group.removeParticipant",
      "group.leave",
    ]) {
      expect(imessageRpcSupportsMethod(oldBuild, method)).toBe(false);
    }
  });
});

describe("iMessage private API status cache", () => {
  const availableStatus = {
    available: true,
    v2Ready: true,
    selectors: {},
    rpcMethods: ["chats.list"],
  };

  it("drops expiring private API status when the current clock is not a valid date timestamp", () => {
    clearCachedIMessagePrivateApiStatus();
    setCachedIMessagePrivateApiStatus(
      "imsg-invalid-private-clock",
      availableStatus,
      1_700_000_030_000,
    );
    vi.spyOn(Date, "now").mockReturnValue(Number.NaN);

    expect(getCachedIMessagePrivateApiStatus("imsg-invalid-private-clock")).toBeUndefined();
  });

  it("does not cache private API status with an invalid expiry timestamp", () => {
    clearCachedIMessagePrivateApiStatus();
    setCachedIMessagePrivateApiStatus(
      "imsg-overflow-private-clock",
      availableStatus,
      Number.POSITIVE_INFINITY,
    );

    expect(getCachedIMessagePrivateApiStatus("imsg-overflow-private-clock")).toBeUndefined();
  });
});
