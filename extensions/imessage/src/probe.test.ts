import { describe, expect, it } from "vitest";
import { imessageRpcSupportsMethod } from "./probe.js";

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
