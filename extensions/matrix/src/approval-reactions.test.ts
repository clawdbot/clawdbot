import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildMatrixApprovalReactionHint,
  clearMatrixApprovalReactionTargetsForTest,
  listMatrixApprovalReactionBindings,
  registerMatrixApprovalReactionTarget,
  resolveMatrixApprovalReactionTarget,
  resolveMatrixApprovalReactionTargetWithPersistence,
  unregisterMatrixApprovalReactionTarget,
} from "./approval-reactions.js";
import { setMatrixRuntime } from "./runtime.js";

afterEach(() => {
  clearMatrixApprovalReactionTargetsForTest();
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

  it("resolves a registered approval anchor event back to an approval decision", () => {
    registerMatrixApprovalReactionTarget({
      roomId: "!ops:example.org",
      eventId: "$approval-msg",
      approvalId: "req-123",
      allowedDecisions: ["allow-once", "allow-always", "deny"],
    });

    expect(
      resolveMatrixApprovalReactionTarget({
        roomId: "!ops:example.org",
        eventId: "$approval-msg",
        reactionKey: "✅",
      }),
    ).toEqual({
      approvalId: "req-123",
      decision: "allow-once",
    });
    expect(
      resolveMatrixApprovalReactionTarget({
        roomId: "!ops:example.org",
        eventId: "$approval-msg",
        reactionKey: "♾️",
      }),
    ).toEqual({
      approvalId: "req-123",
      decision: "allow-always",
    });
    expect(
      resolveMatrixApprovalReactionTarget({
        roomId: "!ops:example.org",
        eventId: "$approval-msg",
        reactionKey: "❌",
      }),
    ).toEqual({
      approvalId: "req-123",
      decision: "deny",
    });
  });

  it("ignores reactions that are not allowed on the registered approval anchor event", () => {
    registerMatrixApprovalReactionTarget({
      roomId: "!ops:example.org",
      eventId: "$approval-msg",
      approvalId: "req-123",
      allowedDecisions: ["allow-once", "deny"],
    });

    expect(
      resolveMatrixApprovalReactionTarget({
        roomId: "!ops:example.org",
        eventId: "$approval-msg",
        reactionKey: "♾️",
      }),
    ).toBeNull();
  });

  it("stops resolving reactions after the approval anchor event is unregistered", () => {
    registerMatrixApprovalReactionTarget({
      roomId: "!ops:example.org",
      eventId: "$approval-msg",
      approvalId: "req-123",
      allowedDecisions: ["allow-once", "allow-always", "deny"],
    });
    unregisterMatrixApprovalReactionTarget({
      roomId: "!ops:example.org",
      eventId: "$approval-msg",
    });

    expect(
      resolveMatrixApprovalReactionTarget({
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
      target: { approvalId: "req-persisted", allowedDecisions: ["deny"] },
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
      logging: { getChildLogger: () => ({ warn: vi.fn() }) },
    } as never);

    registerMatrixApprovalReactionTarget({
      roomId: "!ops:example.org",
      eventId: "$approval-msg-2",
      approvalId: "req-123",
      allowedDecisions: ["allow-once", "deny"],
      ttlMs: 1000,
    });

    await vi.waitFor(() => expect(register).toHaveBeenCalledTimes(1));
    expect(register).toHaveBeenCalledWith(
      "!ops:example.org:$approval-msg-2",
      {
        version: 1,
        target: { approvalId: "req-123", allowedDecisions: ["allow-once", "deny"] },
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
    ).resolves.toEqual({ approvalId: "req-persisted", decision: "deny" });
    expect(openKeyedStore).toHaveBeenCalledTimes(2);
    expect(lookup).toHaveBeenCalledWith("!ops:example.org:$approval-msg-2");
  });

  it("falls back to in-memory approval reaction targets when persistent state cannot open", () => {
    const warn = vi.fn();
    setMatrixRuntime({
      state: {
        openKeyedStore: vi.fn(() => {
          throw new Error("sqlite unavailable");
        }),
      },
      logging: { getChildLogger: () => ({ warn }) },
    } as never);

    registerMatrixApprovalReactionTarget({
      roomId: "!ops:example.org",
      eventId: "$approval-msg-3",
      approvalId: "req-fallback",
      allowedDecisions: ["deny"],
    });

    expect(
      resolveMatrixApprovalReactionTarget({
        roomId: "!ops:example.org",
        eventId: "$approval-msg-3",
        reactionKey: "❌",
      }),
    ).toEqual({ approvalId: "req-fallback", decision: "deny" });
    expect(warn).toHaveBeenCalled();
  });
});
