import { afterEach, describe, expect, it } from "vitest";
import {
  buildMatrixApprovalReactionHint,
  clearMatrixApprovalReactionTargetsForTest,
  listMatrixApprovalReactionBindings,
  registerMatrixApprovalReactionTarget,
  resolveMatrixApprovalReactionTarget,
  unregisterMatrixApprovalReactionTarget,
} from "./approval-reactions.js";

afterEach(() => {
  clearMatrixApprovalReactionTargetsForTest();
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
});
