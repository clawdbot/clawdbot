// Copilot tests cover replay shim plugin behavior.
import { describe, expect, it } from "vitest";
import {
  classifyResumeFailure,
  computeReplayMetadata,
  copilotToolMetasHavePotentialSideEffects,
  decideReplayAction,
} from "./replay-shim.js";

describe("decideReplayAction", () => {
  it("returns create when no input is supplied", () => {
    const decision = decideReplayAction();
    expect(decision).toEqual({
      action: "create",
      downgradedFromResume: false,
      downgradeReason: "no-replay-state",
    });
  });

  it("returns create when sdkSessionId is absent", () => {
    expect(decideReplayAction({})).toEqual({
      action: "create",
      downgradedFromResume: false,
      downgradeReason: "no-sdk-session-id",
    });
    expect(decideReplayAction({ replayInvalid: false })).toEqual({
      action: "create",
      downgradedFromResume: false,
      downgradeReason: "no-sdk-session-id",
    });
  });

  it("returns create for empty or whitespace-only sdkSessionId", () => {
    for (const sdkSessionId of ["", "   ", "\t\n"]) {
      expect(decideReplayAction({ sdkSessionId })).toMatchObject({
        action: "create",
        downgradeReason: "no-sdk-session-id",
      });
    }
  });

  it("returns resume when sdkSessionId is present and replayInvalid is not true", () => {
    expect(decideReplayAction({ sdkSessionId: "sess-1" })).toEqual({
      action: "resume",
      sdkSessionId: "sess-1",
      downgradedFromResume: false,
    });
    expect(decideReplayAction({ sdkSessionId: "sess-2", replayInvalid: false })).toEqual({
      action: "resume",
      sdkSessionId: "sess-2",
      downgradedFromResume: false,
    });
  });

  it("trims whitespace around sdkSessionId before resuming", () => {
    expect(decideReplayAction({ sdkSessionId: "  sess-3  " })).toEqual({
      action: "resume",
      sdkSessionId: "sess-3",
      downgradedFromResume: false,
    });
  });

  it("downgrades to create when replayInvalid is true even with sdkSessionId", () => {
    expect(decideReplayAction({ sdkSessionId: "sess-4", replayInvalid: true })).toEqual({
      action: "create",
      downgradedFromResume: true,
      downgradeReason: "replay-invalid",
    });
  });
});

describe("classifyResumeFailure", () => {
  it("treats undefined / null as unrecoverable", () => {
    expect(classifyResumeFailure(undefined)).toEqual({
      recoverable: false,
      kind: "unknown",
    });
    expect(classifyResumeFailure(null)).toEqual({
      recoverable: false,
      kind: "unknown",
    });
  });

  it("treats a generic Error as unrecoverable", () => {
    expect(classifyResumeFailure(new Error("boom"))).toEqual({
      recoverable: false,
      kind: "unknown",
    });
  });

  it("treats a non-Error throw value as unrecoverable", () => {
    expect(classifyResumeFailure("string-error")).toEqual({
      recoverable: false,
      kind: "unknown",
    });
    expect(classifyResumeFailure(42)).toEqual({
      recoverable: false,
      kind: "unknown",
    });
  });

  it("classifies status:404 errors as missing/recoverable", () => {
    const error = Object.assign(new Error("Not Found"), { status: 404 });
    expect(classifyResumeFailure(error)).toEqual({
      recoverable: true,
      kind: "missing",
    });
  });

  it("classifies statusCode:404 errors as missing/recoverable", () => {
    const error = Object.assign(new Error("Not Found"), { statusCode: 404 });
    expect(classifyResumeFailure(error)).toEqual({
      recoverable: true,
      kind: "missing",
    });
  });

  it("classifies recognised code strings as missing/recoverable", () => {
    for (const code of ["SESSION_NOT_FOUND", "session_not_found", "NotFound", "ENOENT"]) {
      const error = Object.assign(new Error("session gone"), { code });
      expect(classifyResumeFailure(error)).toEqual({
        recoverable: true,
        kind: "missing",
      });
    }
  });

  it("classifies recognised message patterns as missing/recoverable", () => {
    const messages = [
      "session not found",
      "Session sess-1 not found",
      "Unknown session id sess-1",
      "session id sess-1 does not exist",
      "no such session",
    ];
    for (const message of messages) {
      expect(classifyResumeFailure(new Error(message))).toEqual({
        recoverable: true,
        kind: "missing",
      });
    }
  });

  it("does not over-match unrelated errors", () => {
    expect(classifyResumeFailure(new Error("network ECONNRESET"))).toEqual({
      recoverable: false,
      kind: "unknown",
    });
    expect(classifyResumeFailure(new Error("Unauthorized"))).toEqual({
      recoverable: false,
      kind: "unknown",
    });
    expect(classifyResumeFailure(new Error("rate limit exceeded"))).toEqual({
      recoverable: false,
      kind: "unknown",
    });
  });

  it("reads message from plain objects with a message string", () => {
    const error = { message: "session not found" };
    expect(classifyResumeFailure(error)).toEqual({
      recoverable: true,
      kind: "missing",
    });
  });

  it("prefers structured signals over message heuristics", () => {
    // status:404 wins even when message is unrelated
    const error = Object.assign(new Error("Internal server error"), { status: 404 });
    expect(classifyResumeFailure(error)).toEqual({
      recoverable: true,
      kind: "missing",
    });
  });
});

describe("computeReplayMetadata", () => {
  it("clean attempt with no prior state → replaySafe true", () => {
    expect(computeReplayMetadata({})).toEqual({
      hadPotentialSideEffects: false,
      replaySafe: true,
    });
  });

  it("timeout flips both flags", () => {
    expect(computeReplayMetadata({ thisAttemptTimedOut: true })).toEqual({
      hadPotentialSideEffects: true,
      replaySafe: false,
    });
  });

  it("prior side effects propagate forward", () => {
    expect(computeReplayMetadata({ priorHadPotentialSideEffects: true })).toEqual({
      hadPotentialSideEffects: true,
      replaySafe: false,
    });
  });

  it("current attempt side effects make replay unsafe", () => {
    expect(computeReplayMetadata({ thisAttemptHadPotentialSideEffects: true })).toEqual({
      hadPotentialSideEffects: true,
      replaySafe: false,
    });
  });

  it("prior replayInvalid invalidates replay even without side effects", () => {
    expect(computeReplayMetadata({ priorReplayInvalid: true })).toEqual({
      hadPotentialSideEffects: false,
      replaySafe: false,
    });
  });

  it("downgradedFromResume invalidates replay even without side effects", () => {
    expect(computeReplayMetadata({ thisAttemptDowngradedFromResume: true })).toEqual({
      hadPotentialSideEffects: false,
      replaySafe: false,
    });
  });

  it("resumeFailureRecovered invalidates replay even without side effects", () => {
    expect(computeReplayMetadata({ thisAttemptResumeFailureRecovered: true })).toEqual({
      hadPotentialSideEffects: false,
      replaySafe: false,
    });
  });

  it("combinations: prior side effects + timeout still hadSideEffects:true (no double-count)", () => {
    expect(
      computeReplayMetadata({
        priorHadPotentialSideEffects: true,
        thisAttemptTimedOut: true,
      }),
    ).toEqual({
      hadPotentialSideEffects: true,
      replaySafe: false,
    });
  });

  it("combinations: clean attempt with prior replayInvalid+sideEffects propagates both invariants", () => {
    expect(
      computeReplayMetadata({
        priorReplayInvalid: true,
        priorHadPotentialSideEffects: true,
      }),
    ).toEqual({
      hadPotentialSideEffects: true,
      replaySafe: false,
    });
  });

  it("treats explicit false flags as if they were absent", () => {
    expect(
      computeReplayMetadata({
        priorReplayInvalid: false,
        priorHadPotentialSideEffects: false,
        thisAttemptTimedOut: false,
        thisAttemptDowngradedFromResume: false,
        thisAttemptResumeFailureRecovered: false,
      }),
    ).toEqual({
      hadPotentialSideEffects: false,
      replaySafe: true,
    });
  });
});

describe("copilotToolMetasHavePotentialSideEffects", () => {
  it("detects mutating tool names", () => {
    expect(copilotToolMetasHavePotentialSideEffects([{ toolName: "write" }])).toBe(true);
    expect(copilotToolMetasHavePotentialSideEffects([{ toolName: "message_send" }])).toBe(true);
    expect(copilotToolMetasHavePotentialSideEffects([{ toolName: "browser" }])).toBe(true);
    expect(copilotToolMetasHavePotentialSideEffects([{ toolName: "file_fetch" }])).toBe(true);
    expect(copilotToolMetasHavePotentialSideEffects([{ toolName: "file_write" }])).toBe(true);
    expect(copilotToolMetasHavePotentialSideEffects([{ toolName: "read_and_delete" }])).toBe(true);
    expect(copilotToolMetasHavePotentialSideEffects([{ toolName: "search_and_replace" }])).toBe(
      true,
    );
    expect(copilotToolMetasHavePotentialSideEffects([{ toolName: "session_status" }])).toBe(true);
  });

  it("treats read-only tool names as replay-safe", () => {
    expect(copilotToolMetasHavePotentialSideEffects([{ toolName: "read" }])).toBe(false);
    expect(copilotToolMetasHavePotentialSideEffects([{ toolName: "search" }])).toBe(false);
    expect(copilotToolMetasHavePotentialSideEffects([{ toolName: "status" }])).toBe(false);
    expect(copilotToolMetasHavePotentialSideEffects([{ toolName: "file_read" }])).toBe(false);
    expect(copilotToolMetasHavePotentialSideEffects([{ toolName: "memory_get" }])).toBe(false);
    expect(copilotToolMetasHavePotentialSideEffects([{ toolName: "sessions_history" }])).toBe(
      false,
    );
    expect(copilotToolMetasHavePotentialSideEffects([{ toolName: "sessions_list" }])).toBe(false);
    expect(copilotToolMetasHavePotentialSideEffects([{ toolName: "tool_search" }])).toBe(false);
    expect(copilotToolMetasHavePotentialSideEffects([{ toolName: "web_fetch" }])).toBe(false);
    expect(copilotToolMetasHavePotentialSideEffects([{ toolName: "web_search" }])).toBe(false);
  });

  it("treats memory_search recall tracking as a potential side effect", () => {
    expect(copilotToolMetasHavePotentialSideEffects([{ toolName: "memory_search" }])).toBe(true);
  });

  it("detects async-started tools even without a mutating name", () => {
    expect(
      copilotToolMetasHavePotentialSideEffects([{ asyncStarted: true, toolName: "read" }]),
    ).toBe(true);
  });
});
