import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolvePreparedThreadBindingLifecycle } from "./thread-bindings.state.js";
import type { ThreadBindingRecord } from "./thread-bindings.types.js";

const sdk = vi.hoisted(() => ({ helperAvailable: true, calls: 0 }));
vi.mock("openclaw/plugin-sdk/thread-bindings-session-runtime", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("openclaw/plugin-sdk/thread-bindings-session-runtime")>();
  const resolve = (params: Parameters<typeof actual.resolveThreadBindingExpiry>[0]) => {
    sdk.calls += 1;
    return actual.resolveThreadBindingExpiry(params);
  };
  return {
    ...actual,
    get resolveThreadBindingExpiry() {
      return sdk.helperAvailable ? resolve : undefined;
    },
  };
});

describe.each([true, false])("prepared Discord expiry (SDK helper available=%s)", (available) => {
  beforeEach(() => {
    sdk.helperAvailable = available;
    sdk.calls = 0;
  });

  it.each([
    {
      boundAt: 100,
      lastActivityAt: 50,
      idle: 10,
      max: 10,
      expiry: { expiresAt: 60, reason: "idle-expired" },
    },
    {
      boundAt: 100,
      lastActivityAt: 100,
      idle: 10,
      max: 10,
      expiry: { expiresAt: 110, reason: "idle-expired" },
    },
    {
      boundAt: 100,
      lastActivityAt: 200,
      idle: 10,
      max: 10,
      expiry: { expiresAt: 110, reason: "max-age-expired" },
    },
    { boundAt: 100, lastActivityAt: 100, idle: 0, max: 0, expiry: {} },
    {
      boundAt: 100,
      lastActivityAt: Number.NaN,
      idle: 10,
      max: 10,
      expiry: { expiresAt: 110, reason: "max-age-expired" },
    },
    {
      boundAt: 0,
      lastActivityAt: 100,
      idle: 10,
      max: 10,
      expiry: { expiresAt: 110, reason: "idle-expired" },
    },
    { boundAt: Infinity, lastActivityAt: -1, idle: 10, max: 10, expiry: {} },
  ])("preserves prepared deadlines for %j", ({ boundAt, lastActivityAt, idle, max, expiry }) => {
    const record: ThreadBindingRecord = {
      accountId: "default",
      channelId: "channel",
      threadId: "thread",
      targetKind: "subagent",
      targetSessionKey: "agent:main:subagent:expiry",
      agentId: "main",
      boundBy: "test",
      boundAt,
      lastActivityAt,
    };
    expect(
      resolvePreparedThreadBindingLifecycle({ record, idleTimeoutMs: idle, maxAgeMs: max }),
    ).toEqual({ idleTimeoutMs: idle, maxAgeMs: max, ...expiry });
    expect(sdk.calls).toBe(available ? 1 : 0);
  });
});
