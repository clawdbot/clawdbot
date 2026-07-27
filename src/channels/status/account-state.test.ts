import { describe, expect, it } from "vitest";
import type { ChannelAccountSnapshot } from "../plugins/types.core.js";
import {
  applyChannelAccountState,
  projectChannelAccountDisplayState,
  resolveChannelAccountLinked,
  resolveChannelAccountState,
} from "./account-state.js";

// The projection is module-internal; exercise it through the public merge helper
// so the test does not force a wider export surface than production needs.
function projectChannelAccountState(state: Parameters<typeof applyChannelAccountState>[1]) {
  const snapshot: ChannelAccountSnapshot = { accountId: "default" };
  applyChannelAccountState(snapshot, state);
  const { accountId: _accountId, ...projected } = snapshot;
  return projected;
}

const baseInput = {
  enabled: true,
  configured: true,
  linked: true,
  runtime: {},
  disabledReason: "disabled reason",
  unconfiguredReason: "unconfigured reason",
  unlinkedReason: "unlinked reason",
} as const;

describe("resolveChannelAccountState", () => {
  it.each([
    [
      "disabled wins over later states",
      { enabled: false, configured: false, linked: false, runtime: { running: true } },
      {
        kind: "disabled",
        configured: false,
        linked: false,
        reason: "disabled reason",
        failure: null,
      },
    ],
    [
      "unconfigured wins over linkage and runtime",
      { configured: false, linked: false, runtime: { running: true } },
      { kind: "unconfigured", reason: "unconfigured reason", failure: null },
    ],
    [
      "explicitly unlinked wins over runtime",
      { linked: false, runtime: { running: true } },
      { kind: "unlinked", reason: "unlinked reason", failure: null },
    ],
    [
      "running owns linkage, connectivity, and failure",
      { runtime: { running: true, connected: true, lastError: "not linked" } },
      { kind: "running", linked: true, connected: true, failure: "not linked" },
    ],
    [
      "stopped owns linkage, connectivity, and failure",
      {},
      { kind: "stopped", linked: true, connected: undefined, failure: null },
    ],
  ] as const)("%s", (_name, input, expected) => {
    expect(resolveChannelAccountState({ ...baseInput, ...input })).toEqual(expected);
  });

  it.each([false, true])("keeps unknown linkage configured (running=%s)", (running) => {
    const state = resolveChannelAccountState({
      ...baseInput,
      linked: undefined,
      runtime: { running },
    });
    expect(state.kind).toBe(running ? "running" : "stopped");
    expect(projectChannelAccountState(state)).toMatchObject({ configured: true });
    expect(projectChannelAccountState(state)).not.toHaveProperty("linked");
  });

  it.each([
    ["linked", true],
    ["not-linked", false],
    ["unknown", undefined],
    [undefined, true],
  ] as const)("maps link state %s", (state, expected) => {
    expect(resolveChannelAccountLinked(state, true)).toBe(expected);
  });
});

describe("projectChannelAccountState", () => {
  it.each([
    [
      {
        kind: "disabled",
        configured: false,
        linked: false,
        reason: "disabled",
        failure: null,
      },
      {
        configured: false,
        linked: false,
        running: false,
        stateReason: "disabled",
        lastError: null,
      },
    ],
    [
      { kind: "unconfigured", reason: "not configured", failure: null },
      { configured: false, running: false, stateReason: "not configured", lastError: null },
    ],
    [
      { kind: "unlinked", reason: "not linked", failure: null },
      {
        configured: true,
        linked: false,
        running: false,
        stateReason: "not linked",
        lastError: null,
      },
    ],
    [
      { kind: "running", linked: true, connected: false, failure: null },
      { configured: true, linked: true, running: true, connected: false, lastError: null },
    ],
    [
      { kind: "stopped", connected: true, failure: "transport failed" },
      { configured: true, running: false, connected: true, lastError: "transport failed" },
    ],
  ] as const)("projects %s without stale fields", (state, expected) => {
    expect(projectChannelAccountState(state)).toEqual(expected);
  });

  it("replaces owner fields while preserving unrelated snapshot data", () => {
    const state = resolveChannelAccountState({ ...baseInput, linked: undefined });
    const snapshot = {
      accountId: "default",
      configured: false,
      linked: false,
      running: true,
      connected: true,
      stateReason: "not linked",
      lastError: "not linked",
      mode: "polling",
    };
    applyChannelAccountState(snapshot, state);
    expect(snapshot).toEqual({
      accountId: "default",
      configured: true,
      running: false,
      lastError: null,
      mode: "polling",
    });
    expect(projectChannelAccountDisplayState(state)).toBe("configured");
    expect(projectChannelAccountDisplayState(state, "enabled")).toBe("enabled");
  });
});
