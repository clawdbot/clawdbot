import { describe, expect, it } from "vitest";
import {
  deriveGatewaySessionLifecycleSnapshot,
  derivePersistedSessionLifecyclePatch,
  isStaleLifecycleEventForSession,
} from "./session-lifecycle-state.js";

describe("session lifecycle state", () => {
  it("treats a pre-reset run's lifecycle event as stale once the row's sessionId rotated (#88538)", () => {
    expect(
      isStaleLifecycleEventForSession({ owningSessionId: "old-id", currentSessionId: "new-id" }),
    ).toBe(true);
  });

  it("applies lifecycle events whose owning sessionId matches the current row", () => {
    expect(
      isStaleLifecycleEventForSession({ owningSessionId: "same-id", currentSessionId: "same-id" }),
    ).toBe(false);
  });

  it("does not guard when the owning sessionId is unknown (preserves legacy behavior)", () => {
    expect(
      isStaleLifecycleEventForSession({ owningSessionId: undefined, currentSessionId: "new-id" }),
    ).toBe(false);
  });

  it("reactivates completed sessions on lifecycle start", () => {
    expect(
      deriveGatewaySessionLifecycleSnapshot({
        session: {
          updatedAt: 500,
          status: "done",
          startedAt: 100,
          endedAt: 400,
          runtimeMs: 300,
          abortedLastRun: true,
        },
        event: {
          ts: 1_000,
          data: {
            phase: "start",
            startedAt: 900,
          },
        },
      }),
    ).toEqual({
      updatedAt: 900,
      status: "running",
      startedAt: 900,
      endedAt: undefined,
      runtimeMs: undefined,
      abortedLastRun: false,
    });
  });

  it("marks completed lifecycle end events as done with terminal timing", () => {
    expect(
      deriveGatewaySessionLifecycleSnapshot({
        session: {
          updatedAt: 1_000,
          status: "running",
          startedAt: 1_200,
        },
        event: {
          ts: 2_000,
          data: {
            phase: "end",
            startedAt: 1_200,
            endedAt: 1_900,
          },
        },
      }),
    ).toEqual({
      updatedAt: 1_900,
      status: "done",
      startedAt: 1_200,
      endedAt: 1_900,
      runtimeMs: 700,
      abortedLastRun: false,
    });
  });

  it("maps aborted stop reasons to killed", () => {
    expect(
      derivePersistedSessionLifecyclePatch({
        entry: {
          updatedAt: 1_000,
          startedAt: 1_100,
        },
        event: {
          ts: 2_000,
          data: {
            phase: "end",
            endedAt: 1_800,
            stopReason: "aborted",
          },
        },
      }),
    ).toEqual({
      updatedAt: 1_800,
      status: "killed",
      startedAt: 1_100,
      endedAt: 1_800,
      runtimeMs: 700,
      abortedLastRun: true,
    });
  });

  it("maps aborted lifecycle end events without stopReason to timeout", () => {
    expect(
      derivePersistedSessionLifecyclePatch({
        entry: {
          updatedAt: 1_000,
          startedAt: 1_050,
        },
        event: {
          ts: 2_000,
          data: {
            phase: "end",
            endedAt: 1_550,
            aborted: true,
          },
        },
      }),
    ).toEqual({
      updatedAt: 1_550,
      status: "timeout",
      startedAt: 1_050,
      endedAt: 1_550,
      runtimeMs: 500,
      abortedLastRun: false,
    });
  });

  it("keeps provider hard timeouts stronger than rpc cancellation metadata", () => {
    expect(
      derivePersistedSessionLifecyclePatch({
        entry: {
          updatedAt: 1_000,
          startedAt: 1_050,
        },
        event: {
          ts: 2_000,
          data: {
            phase: "end",
            aborted: true,
            stopReason: "rpc",
            timeoutPhase: "provider",
            providerStarted: true,
            endedAt: 1_550,
          },
        },
      }),
    ).toEqual({
      updatedAt: 1_550,
      status: "timeout",
      startedAt: 1_050,
      endedAt: 1_550,
      runtimeMs: 500,
      abortedLastRun: false,
    });
  });

  it("maps non-hard rpc lifecycle aborts to killed sessions", () => {
    expect(
      derivePersistedSessionLifecyclePatch({
        entry: {
          updatedAt: 1_000,
          startedAt: 1_050,
        },
        event: {
          ts: 2_000,
          data: {
            phase: "end",
            aborted: true,
            stopReason: "rpc",
            timeoutPhase: "queue",
            providerStarted: false,
            endedAt: 1_550,
          },
        },
      }),
    ).toEqual({
      updatedAt: 1_550,
      status: "killed",
      startedAt: 1_050,
      endedAt: 1_550,
      runtimeMs: 500,
      abortedLastRun: true,
    });
  });

  it("maps provider timeout lifecycle errors to timed out sessions", () => {
    expect(
      derivePersistedSessionLifecyclePatch({
        entry: {
          updatedAt: 1_000,
          startedAt: 1_050,
        },
        event: {
          ts: 2_000,
          data: {
            phase: "error",
            error: "provider request timed out",
            livenessState: "blocked",
            timeoutPhase: "provider",
            providerStarted: true,
            endedAt: 1_550,
          },
        },
      }),
    ).toEqual({
      updatedAt: 1_550,
      status: "timeout",
      startedAt: 1_050,
      endedAt: 1_550,
      runtimeMs: 500,
      abortedLastRun: false,
    });
  });

  it("maps provider timeout lifecycle end metadata to timed out sessions", () => {
    expect(
      derivePersistedSessionLifecyclePatch({
        entry: {
          updatedAt: 1_000,
          startedAt: 1_050,
        },
        event: {
          ts: 2_000,
          data: {
            phase: "end",
            timeoutPhase: "provider",
            providerStarted: true,
            endedAt: 1_550,
          },
        },
      }),
    ).toEqual({
      updatedAt: 1_550,
      status: "timeout",
      startedAt: 1_050,
      endedAt: 1_550,
      runtimeMs: 500,
      abortedLastRun: false,
    });
  });
});
