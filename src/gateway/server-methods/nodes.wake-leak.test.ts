// Regression: maybeWakeNodeWithApns (nodes.ts:308-416) speculatively sets
// nodeWakeById at the top for in-flight coalescing, but on the no-registration
// early-return path (loadApnsRegistration returns null) the entry was never
// removed. The sole cleanup path (clearNodeWakeState, wired from
// ws-connection.ts:327 on WS close) only fires for registered nodes, so any
// operator-driven RPC against an unregistered/re-paired/typo nodeId leaked a
// permanent { lastWakeAtMs: 0 } entry.
//
// Fix: delete the nodeWakeById entry before returning no-registration.
//
// PR #63709 (merged 2026-04-09) introduced clearNodeWakeState for WS close —
// this change is a different leak path (unregistered early-return) and
// complements that PR.
//
// CAL-003 compliance: the null-registration branch is already exercised by
// existing nodes.invoke-wake.test.ts cases. The test just observes that the
// Map size returns to 0, using a minimal read-only __testing seam mirrored on
// agent-wait-dedupe.ts:223 and agents.ts:78.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  loadApnsRegistration: vi.fn(),
  resolveApnsAuthConfigFromEnv: vi.fn(),
  resolveApnsRelayConfigFromEnv: vi.fn(),
  sendApnsBackgroundWake: vi.fn(),
  sendApnsAlert: vi.fn(),
  clearApnsRegistrationIfCurrent: vi.fn(),
  shouldClearStoredApnsRegistration: vi.fn(() => false),
}));

vi.mock("../../infra/push-apns.js", () => ({
  clearApnsRegistrationIfCurrent: mocks.clearApnsRegistrationIfCurrent,
  loadApnsRegistration: mocks.loadApnsRegistration,
  resolveApnsAuthConfigFromEnv: mocks.resolveApnsAuthConfigFromEnv,
  resolveApnsRelayConfigFromEnv: mocks.resolveApnsRelayConfigFromEnv,
  sendApnsBackgroundWake: mocks.sendApnsBackgroundWake,
  sendApnsAlert: mocks.sendApnsAlert,
  shouldClearStoredApnsRegistration: mocks.shouldClearStoredApnsRegistration,
}));

import { __testing as wakeTesting } from "./nodes-wake-state.js";
import { maybeWakeNodeWithApns } from "./nodes.js";

describe("maybeWakeNodeWithApns — no-registration leak guard", () => {
  beforeEach(() => {
    wakeTesting.resetWakeState();
    vi.clearAllMocks();
    mocks.loadApnsRegistration.mockResolvedValue(null);
  });

  afterEach(() => {
    wakeTesting.resetWakeState();
  });

  it("does not retain nodeWakeById entries for unregistered nodeIds", async () => {
    expect(wakeTesting.getNodeWakeByIdSize()).toBe(0);

    for (let i = 0; i < 50; i++) {
      const result = await maybeWakeNodeWithApns(`unregistered-node-${i}`);
      expect(result.available).toBe(false);
      expect(result.throttled).toBe(false);
      expect(result.path).toBe("no-registration");
    }

    expect(wakeTesting.getNodeWakeByIdSize()).toBe(0);
    expect(wakeTesting.hasNodeWakeEntry("unregistered-node-0")).toBe(false);
    expect(wakeTesting.hasNodeWakeEntry("unregistered-node-49")).toBe(false);
  });

  it("clears the entry when a single call returns no-registration", async () => {
    await maybeWakeNodeWithApns("stale-nodeId");
    expect(wakeTesting.getNodeWakeByIdSize()).toBe(0);
    expect(wakeTesting.hasNodeWakeEntry("stale-nodeId")).toBe(false);
  });
});
