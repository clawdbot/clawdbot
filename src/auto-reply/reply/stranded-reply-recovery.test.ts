import { describe, expect, it, vi } from "vitest";
import { completeFollowupRunLifecycle, markFollowupRunEnqueued } from "./queue/types.js";
import { buildStrandedReplyRetryFollowupRun } from "./stranded-reply-recovery.js";
import { createMockFollowupRun } from "./test-helpers.js";

const STRANDED_REPLY_RETRY_MARKER = "stranded-reply-retry";

describe("buildStrandedReplyRetryFollowupRun lifecycle ownership", () => {
  it("does not share the client turn's queuedLifecycle with the system retry", () => {
    const onComplete = vi.fn();
    const onEnqueued = vi.fn(() => true);
    const parent = createMockFollowupRun({
      prompt: "user question",
      transcriptPrompt: "user question",
      queuedLifecycle: { onComplete, onEnqueued },
      admissionSessionId: "sess-rotated",
      onReplyAdmissionWaitChange: vi.fn(),
    });

    const retry = buildStrandedReplyRetryFollowupRun(parent, {
      finalText: "A substantive stranded final that must be re-delivered via message(action=send).",
      sourceReplyDeliveryMode: "message_tool_only",
    });

    expect(retry.queuedLifecycle).toBeUndefined();
    expect(retry.strandedReplyRetry).toBe(true);
    expect(retry.summaryLine).toBe(STRANDED_REPLY_RETRY_MARKER);
    // Session routing stays; only the client-turn lifecycle identity is detached.
    expect(retry.admissionSessionId).toBe("sess-rotated");
    expect(retry.onReplyAdmissionWaitChange).toBe(parent.onReplyAdmissionWaitChange);
    expect(retry.run.sessionKey).toBe(parent.run.sessionKey);

    // mark/complete no-op when lifecycle is absent (drop-policy onDrop path too).
    expect(markFollowupRunEnqueued(retry)).toBe(true);
    expect(onEnqueued).not.toHaveBeenCalled();
    completeFollowupRunLifecycle(retry);
    expect(onComplete).not.toHaveBeenCalled();

    // Parent still owns the one-shot lifecycle; retry completion must not steal it.
    expect(markFollowupRunEnqueued(parent)).toBe(true);
    expect(onEnqueued).toHaveBeenCalledTimes(1);
    completeFollowupRunLifecycle(parent);
    expect(onComplete).toHaveBeenCalledTimes(1);
    completeFollowupRunLifecycle(parent);
    expect(onComplete).toHaveBeenCalledTimes(1);
  });
});
