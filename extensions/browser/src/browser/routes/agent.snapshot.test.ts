// Browser tests cover operation-owned target continuity.
import { describe, expect, it } from "vitest";
import type { BrowserRouteContext } from "../server-context.js";
import {
  captureBrowserOperationTarget,
  resolveOperationTargetOutcome,
} from "./agent.snapshot-target.js";

describe("resolveOperationTargetOutcome", () => {
  it("keeps the acted-on target when the backend cannot prove its successor", async () => {
    expect(await resolveOperationTargetOutcome({ actedOnTargetId: "old-123" })).toBe("old-123");
  });

  it("accepts the replacement reported by the exact acted-on Playwright page", async () => {
    expect(
      await resolveOperationTargetOutcome({
        actedOnTargetId: "old-123",
        operationTargetId: "replacement-456",
      }),
    ).toBe("replacement-456");
  });

  it("prefers the exact relay-owned tab over a stale detached Playwright page", async () => {
    expect(
      await resolveOperationTargetOutcome({
        actedOnTargetId: "old-123",
        operationTargetId: "old-123",
        resolveRelayTarget: () => "replacement-456",
      }),
    ).toBe("replacement-456");
  });

  it("never adopts a newcomer when the captured relay owner was revoked or replaced", async () => {
    expect(
      await resolveOperationTargetOutcome({
        actedOnTargetId: "old-123",
        operationTargetId: "unrelated-999",
        resolveRelayTarget: () => undefined,
      }),
    ).toBe("old-123");
  });
});

describe("captureBrowserOperationTarget", () => {
  it("fails closed when a registered relay cannot capture the acted-on target", async () => {
    const relays = new Map([["chrome", { bridge: { captureOperationTarget: () => undefined } }]]);
    const state = { extensionRelays: relays, profiles: new Map([["chrome", {}]]) };
    const ctx = { state: () => state } as unknown as BrowserRouteContext;
    const resolveRelayTarget = await captureBrowserOperationTarget({
      ctx,
      profileName: "chrome",
      targetId: "old-123",
    });

    expect(typeof resolveRelayTarget).toBe("function");
    expect(
      await resolveOperationTargetOutcome({
        actedOnTargetId: "old-123",
        operationTargetId: "unrelated-999",
        resolveRelayTarget,
      }),
    ).toBe("old-123");
  });

  it("rejects a replacement relay even when it reports the same profile and target", async () => {
    const original = {
      bridge: { captureOperationTarget: () => () => "replacement-456" },
    };
    const relays = new Map([["chrome", original]]);
    const state = { extensionRelays: relays, profiles: new Map([["chrome", {}]]) };
    const ctx = { state: () => state } as unknown as BrowserRouteContext;
    const resolveRelayTarget = await captureBrowserOperationTarget({
      ctx,
      profileName: "chrome",
      targetId: "old-123",
    });

    expect(await resolveRelayTarget?.()).toBe("replacement-456");
    relays.set("chrome", {
      bridge: { captureOperationTarget: () => () => "unrelated-999" },
    });
    expect(await resolveRelayTarget?.()).toBeUndefined();
    expect(
      await resolveOperationTargetOutcome({
        actedOnTargetId: "old-123",
        operationTargetId: "unrelated-999",
        resolveRelayTarget,
      }),
    ).toBe("old-123");
  });
});
