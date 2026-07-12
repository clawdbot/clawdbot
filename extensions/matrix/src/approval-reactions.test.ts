// Matrix tests cover approval reactions plugin behavior.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildMatrixApprovalReactionHint,
  clearMatrixApprovalReactionTargetsForTest,
  listMatrixApprovalReactionBindings,
  registerMatrixApprovalReactionTarget as registerMatrixApprovalReactionTargetRaw,
  resolveMatrixApprovalReactionTargetWithPersistence as resolveMatrixApprovalReactionTargetWithPersistenceRaw,
  unregisterMatrixApprovalReactionTarget as unregisterMatrixApprovalReactionTargetRaw,
} from "./approval-reactions.js";
import { clearMatrixRuntime, setMatrixRuntime } from "./runtime.js";

type RegisterTargetParams = Parameters<typeof registerMatrixApprovalReactionTargetRaw>[0];
type ResolveTargetParams = Parameters<
  typeof resolveMatrixApprovalReactionTargetWithPersistenceRaw
>[0];
type UnregisterTargetParams = Parameters<typeof unregisterMatrixApprovalReactionTargetRaw>[0];

function registerMatrixApprovalReactionTarget(
  params: Omit<RegisterTargetParams, "accountId"> & { accountId?: string },
): void {
  const { accountId = "default", ...target } = params;
  registerMatrixApprovalReactionTargetRaw({ ...target, accountId });
}

function resolveMatrixApprovalReactionTargetWithPersistence(
  params: Omit<ResolveTargetParams, "accountId"> & { accountId?: string },
) {
  const { accountId = "default", ...target } = params;
  return resolveMatrixApprovalReactionTargetWithPersistenceRaw({
    ...target,
    accountId,
  });
}

function unregisterMatrixApprovalReactionTarget(
  params: Omit<UnregisterTargetParams, "accountId"> & { accountId?: string },
): void {
  const { accountId = "default", ...target } = params;
  unregisterMatrixApprovalReactionTargetRaw({
    ...target,
    accountId,
  });
}

function createRuntimeLogger(overrides: { warn?: ReturnType<typeof vi.fn> } = {}) {
  // Runtime state survives no-isolate workers, so expose every logger method later files may call.
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: overrides.warn ?? vi.fn(),
    error: vi.fn(),
  };
}

beforeEach(() => {
  clearMatrixRuntime();
});

afterEach(() => {
  clearMatrixApprovalReactionTargetsForTest();
  clearMatrixRuntime();
  vi.restoreAllMocks();
});

describe("matrix approval reactions", () => {
  it("lists reactions in stable decision order", () => {
    expect(listMatrixApprovalReactionBindings(["allow-once", "deny", "allow-always"])).toEqual([
      { decision: "allow-once", emoji: "✅", label: "Allow once" },
      { decision: "allow-always", emoji: "♾️", label: "Allow always" },
      { decision: "deny", emoji: "❌", label: "Deny" },
    ]);
  });

  it("builds a compact reaction hint", () => {
    expect(buildMatrixApprovalReactionHint(["allow-once", "deny"])).toBe(
      "React here: ✅ Allow once, ❌ Deny",
    );
  });

  it("resolves a registered approval anchor event back to an approval decision", async () => {
    registerMatrixApprovalReactionTarget({
      roomId: "!ops:example.org",
      eventId: "$approval-msg",
      approvalId: "req-123",
      approvalKind: "exec",
      allowedDecisions: ["allow-once", "allow-always", "deny"],
    });

    expect(
      await resolveMatrixApprovalReactionTargetWithPersistence({
        roomId: "!ops:example.org",
        eventId: "$approval-msg",
        reactionKey: "✅",
      }),
    ).toEqual({
      approvalId: "req-123",
      approvalKind: "exec",
      decision: "allow-once",
    });
    expect(
      await resolveMatrixApprovalReactionTargetWithPersistence({
        roomId: "!ops:example.org",
        eventId: "$approval-msg",
        reactionKey: "♾️",
      }),
    ).toEqual({
      approvalId: "req-123",
      approvalKind: "exec",
      decision: "allow-always",
    });
    expect(
      await resolveMatrixApprovalReactionTargetWithPersistence({
        roomId: "!ops:example.org",
        eventId: "$approval-msg",
        reactionKey: "❌",
      }),
    ).toEqual({
      approvalId: "req-123",
      approvalKind: "exec",
      decision: "deny",
    });
  });

  it("ignores reactions that are not allowed on the registered approval anchor event", async () => {
    registerMatrixApprovalReactionTarget({
      roomId: "!ops:example.org",
      eventId: "$approval-msg",
      approvalId: "req-123",
      approvalKind: "exec",
      allowedDecisions: ["allow-once", "deny"],
    });

    expect(
      await resolveMatrixApprovalReactionTargetWithPersistence({
        roomId: "!ops:example.org",
        eventId: "$approval-msg",
        reactionKey: "♾️",
      }),
    ).toBeNull();
  });

  it("does not expose an approval reaction target to another Matrix account", async () => {
    registerMatrixApprovalReactionTarget({
      accountId: "account-a",
      roomId: "!shared:example.org",
      eventId: "$approval-msg",
      approvalId: "req-account-a",
      approvalKind: "exec",
      allowedDecisions: ["allow-once"],
    });

    await expect(
      resolveMatrixApprovalReactionTargetWithPersistence({
        accountId: "account-b",
        roomId: "!shared:example.org",
        eventId: "$approval-msg",
        reactionKey: "✅",
      }),
    ).resolves.toBeNull();
    await expect(
      resolveMatrixApprovalReactionTargetWithPersistence({
        accountId: "account-a",
        roomId: "!shared:example.org",
        eventId: "$approval-msg",
        reactionKey: "✅",
      }),
    ).resolves.toEqual({
      approvalId: "req-account-a",
      approvalKind: "exec",
      decision: "allow-once",
    });
  });

  it("rejects reaction targets without a valid approval kind", async () => {
    registerMatrixApprovalReactionTarget({
      roomId: "!ops:example.org",
      eventId: "$approval-msg",
      approvalId: "req-123",
      approvalKind: "invalid",
      allowedDecisions: ["allow-once"],
    } as never);

    expect(
      await resolveMatrixApprovalReactionTargetWithPersistence({
        roomId: "!ops:example.org",
        eventId: "$approval-msg",
        reactionKey: "✅",
      }),
    ).toBeNull();
  });

  it("stops resolving reactions after the approval anchor event is unregistered", async () => {
    registerMatrixApprovalReactionTarget({
      roomId: "!ops:example.org",
      eventId: "$approval-msg",
      approvalId: "req-123",
      approvalKind: "exec",
      allowedDecisions: ["allow-once", "allow-always", "deny"],
    });
    unregisterMatrixApprovalReactionTarget({
      roomId: "!ops:example.org",
      eventId: "$approval-msg",
    });

    expect(
      await resolveMatrixApprovalReactionTargetWithPersistence({
        roomId: "!ops:example.org",
        eventId: "$approval-msg",
        reactionKey: "✅",
      }),
    ).toBeNull();
  });

  it("persists approval reaction targets when runtime state is available", async () => {
    const register = vi.fn().mockResolvedValue(undefined);
    const lookup = vi.fn().mockResolvedValue({
      version: 1,
      target: {
        accountId: "default",
        approvalId: "req-persisted",
        approvalKind: "exec",
        roomId: "!ops:example.org",
        eventId: "$approval-msg-2",
        allowedDecisions: ["deny"],
      },
    });
    const openKeyedStore = vi.fn(() => ({
      register,
      lookup,
      consume: vi.fn(),
      delete: vi.fn(),
      entries: vi.fn(),
      clear: vi.fn(),
    }));
    setMatrixRuntime({
      state: { openKeyedStore },
      logging: { getChildLogger: () => createRuntimeLogger() },
    } as never);

    registerMatrixApprovalReactionTarget({
      roomId: "!ops:example.org",
      eventId: "$approval-msg-2",
      approvalId: "req-123",
      approvalKind: "exec",
      allowedDecisions: ["allow-once", "deny"],
      ttlMs: 1000,
    });

    await vi.waitFor(() => expect(register).toHaveBeenCalledTimes(1));
    expect(register).toHaveBeenCalledWith(
      '["default","!ops:example.org","$approval-msg-2"]',
      {
        version: 1,
        target: {
          accountId: "default",
          approvalId: "req-123",
          approvalKind: "exec",
          roomId: "!ops:example.org",
          eventId: "$approval-msg-2",
          allowedDecisions: ["allow-once", "deny"],
        },
      },
      { ttlMs: 1000 },
    );

    clearMatrixApprovalReactionTargetsForTest();
    await expect(
      resolveMatrixApprovalReactionTargetWithPersistence({
        roomId: "!ops:example.org",
        eventId: "$approval-msg-2",
        reactionKey: "❌",
      }),
    ).resolves.toEqual({ approvalId: "req-persisted", approvalKind: "exec", decision: "deny" });
    expect(openKeyedStore).toHaveBeenCalledTimes(2);
    expect(lookup).toHaveBeenCalledWith('["default","!ops:example.org","$approval-msg-2"]');
  });

  it("falls back to in-memory approval reaction targets when persistent state cannot open", async () => {
    const warn = vi.fn();
    setMatrixRuntime({
      state: {
        openKeyedStore: vi.fn(() => {
          throw new Error("sqlite unavailable");
        }),
      },
      logging: { getChildLogger: () => createRuntimeLogger({ warn }) },
    } as never);

    registerMatrixApprovalReactionTarget({
      roomId: "!ops:example.org",
      eventId: "$approval-msg-3",
      approvalId: "req-fallback",
      approvalKind: "exec",
      allowedDecisions: ["deny"],
    });

    expect(
      await resolveMatrixApprovalReactionTargetWithPersistence({
        roomId: "!ops:example.org",
        eventId: "$approval-msg-3",
        reactionKey: "❌",
      }),
    ).toEqual({ approvalId: "req-fallback", approvalKind: "exec", decision: "deny" });
    expect(warn).toHaveBeenCalled();
  });
});
