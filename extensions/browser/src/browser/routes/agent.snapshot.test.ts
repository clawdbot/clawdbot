// Browser tests cover operation-owned target continuity.
import { describe, expect, it } from "vitest";
import type { BrowserRouteContext } from "../server-context.js";
import {
  captureBrowserOperationTarget,
  resolveOperationTargetOutcome,
} from "./agent.snapshot-target.js";

describe("resolveOperationTargetOutcome", () => {
  it("keeps the acted-on target when the backend cannot prove its successor", () => {
    expect(resolveOperationTargetOutcome({ actedOnTargetId: "old-123" })).toBe("old-123");
  });

  it("accepts the replacement reported by the exact acted-on Playwright page", () => {
    expect(
      resolveOperationTargetOutcome({
        actedOnTargetId: "old-123",
        operationTargetId: "replacement-456",
      }),
    ).toBe("replacement-456");
  });

  it("prefers the exact relay-owned tab over a stale detached Playwright page", () => {
    expect(
      resolveOperationTargetOutcome({
        actedOnTargetId: "old-123",
        operationTargetId: "old-123",
        resolveRelayTarget: () => "replacement-456",
      }),
    ).toBe("replacement-456");
  });

  it("never adopts a newcomer when the captured relay owner was revoked or replaced", () => {
    expect(
      resolveOperationTargetOutcome({
        actedOnTargetId: "old-123",
        operationTargetId: "unrelated-999",
        resolveRelayTarget: () => undefined,
      }),
    ).toBe("old-123");
  });
});

describe("captureBrowserOperationTarget", () => {
  it("fails closed when a registered relay cannot capture the acted-on target", () => {
    const relays = new Map([["chrome", { bridge: { captureOperationTarget: () => undefined } }]]);
    const ctx = {
      state: () => ({ extensionRelays: relays }),
    } as unknown as BrowserRouteContext;
    const resolveRelayTarget = captureBrowserOperationTarget({
      ctx,
      profileName: "chrome",
      targetId: "old-123",
    });

    expect(typeof resolveRelayTarget).toBe("function");
    expect(
      resolveOperationTargetOutcome({
        actedOnTargetId: "old-123",
        operationTargetId: "unrelated-999",
        resolveRelayTarget,
      }),
    ).toBe("old-123");
  });

  it("rejects a replacement relay even when it reports the same profile and target", () => {
    const original = {
      bridge: { captureOperationTarget: () => () => "replacement-456" },
    };
    const relays = new Map([["chrome", original]]);
    const ctx = {
      state: () => ({ extensionRelays: relays }),
    } as unknown as BrowserRouteContext;
    const resolveRelayTarget = captureBrowserOperationTarget({
      ctx,
      profileName: "chrome",
      targetId: "old-123",
    });

    expect(resolveRelayTarget?.()).toBe("replacement-456");
    relays.set("chrome", {
      bridge: { captureOperationTarget: () => () => "unrelated-999" },
    });
    expect(resolveRelayTarget?.()).toBeUndefined();
    expect(
      resolveOperationTargetOutcome({
        actedOnTargetId: "old-123",
        operationTargetId: "unrelated-999",
        resolveRelayTarget,
      }),
    ).toBe("old-123");
  });
});
