import { describe, expect, it, vi } from "vitest";
import {
  buildPendingGuardianDeniedAction,
  consumePendingGuardianDeniedAction,
  isContextualGuardianApproval,
} from "./guardian-denial-approval.js";

const deniedNotification = {
  threadId: "thread-1",
  turnId: "turn-1",
  reviewId: "review-1",
  startedAtMs: 1_000,
  completedAtMs: 1_042,
  targetItemId: "item-1",
  decisionSource: "agent",
  review: {
    status: "denied",
    riskLevel: "medium",
    userAuthorization: "low",
    rationale: "The user has not approved this exact push.",
  },
  action: {
    type: "command",
    source: "unifiedExec",
    command: "git push origin subject:portable-v15-export",
    cwd: "/workspace",
  },
};

describe("buildPendingGuardianDeniedAction", () => {
  it("preserves the exact denied action in Codex core wire format", () => {
    expect(buildPendingGuardianDeniedAction(deniedNotification, 2_000)).toEqual({
      recordedAtMs: 2_000,
      event: {
        id: "review-1",
        target_item_id: "item-1",
        turn_id: "turn-1",
        started_at_ms: 1_000,
        completed_at_ms: 1_042,
        status: "denied",
        risk_level: "medium",
        user_authorization: "low",
        rationale: "The user has not approved this exact push.",
        decision_source: "agent",
        action: {
          type: "command",
          source: "unified_exec",
          command: "git push origin subject:portable-v15-export",
          cwd: "/workspace",
        },
      },
    });
  });

  it("ignores non-denial review notifications", () => {
    expect(
      buildPendingGuardianDeniedAction({
        ...deniedNotification,
        review: { ...deniedNotification.review, status: "approved" },
      }),
    ).toBeUndefined();
  });
});

describe("isContextualGuardianApproval", () => {
  it.each(["yes", "Approved", "go ahead", "yes & fix the connector issue"])(
    "accepts %s as an affirmative reply",
    (prompt) => expect(isContextualGuardianApproval(prompt)).toBe(true),
  );

  it.each(["no", "what does this do?", "continue the analysis", "not approved"])(
    "does not treat %s as approval",
    (prompt) => expect(isContextualGuardianApproval(prompt)).toBe(false),
  );
});

describe("consumePendingGuardianDeniedAction", () => {
  it("approves and consumes only the exact pending event", async () => {
    const pending = buildPendingGuardianDeniedAction(deniedNotification, 2_000);
    expect(pending).toBeDefined();
    const request = vi.fn(async () => ({}));
    const clear = vi.fn(async () => true);

    await expect(
      consumePendingGuardianDeniedAction({
        pending,
        prompt: "approved",
        threadId: "thread-1",
        nowMs: 2_100,
        request,
        clear,
      }),
    ).resolves.toBe("approved");

    expect(request).toHaveBeenCalledWith("thread/approveGuardianDeniedAction", {
      threadId: "thread-1",
      event: pending?.event,
    });
    expect(clear).toHaveBeenCalledOnce();
  });

  it("expires rather than approving stale context", async () => {
    const pending = buildPendingGuardianDeniedAction(deniedNotification, 2_000);
    const request = vi.fn(async () => ({}));
    const clear = vi.fn(async () => true);

    await expect(
      consumePendingGuardianDeniedAction({
        pending,
        prompt: "yes",
        threadId: "thread-1",
        nowMs: 2_000 + 10 * 60_000 + 1,
        request,
        clear,
      }),
    ).resolves.toBe("expired");

    expect(request).not.toHaveBeenCalled();
    expect(clear).toHaveBeenCalledOnce();
  });

  it("discards the pending event after an unrelated next reply", async () => {
    const pending = buildPendingGuardianDeniedAction(deniedNotification, 2_000);
    const request = vi.fn(async () => ({}));
    const clear = vi.fn(async () => true);

    await expect(
      consumePendingGuardianDeniedAction({
        pending,
        prompt: "what does this do?",
        threadId: "thread-1",
        nowMs: 2_100,
        request,
        clear,
      }),
    ).resolves.toBe("unrelated");

    expect(request).not.toHaveBeenCalled();
    expect(clear).toHaveBeenCalledOnce();
  });

  it("fails closed when stale context cannot be cleared", async () => {
    const pending = buildPendingGuardianDeniedAction(deniedNotification, 2_000);
    const request = vi.fn(async () => ({}));
    const clear = vi.fn(async () => false);

    await expect(
      consumePendingGuardianDeniedAction({
        pending,
        prompt: "yes",
        threadId: "thread-1",
        nowMs: 2_000 + 10 * 60_000 + 1,
        request,
        clear,
      }),
    ).rejects.toThrow("could not be cleared");

    expect(request).not.toHaveBeenCalled();
  });
});
