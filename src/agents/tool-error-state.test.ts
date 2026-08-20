import { describe, expect, it } from "vitest";
import { createToolErrorState } from "./tool-error-state.js";

describe("unresolved tool mutation errors", () => {
  it("preserves recovery across unrelated failures until the same action fails again", () => {
    const recoveredAction = {
      toolName: "write",
      error: "write failed",
      mutatingAction: true,
      actionFingerprint: "tool=write|path=/tmp/a",
    } as const;
    const unrelatedAction = {
      toolName: "message",
      error: "send failed",
      mutatingAction: true,
      actionFingerprint: "tool=message|action=send|to=channel:b",
    } as const;
    const state = createToolErrorState();

    state.recordFailure(recoveredAction);
    expect(state.recordSuccess(recoveredAction)).toEqual({
      lastToolRecovery: { toolName: "write" },
    });
    expect(state.recordFailure(unrelatedAction)).toEqual({
      lastToolError: unrelatedAction,
      lastToolRecovery: { toolName: "write" },
    });
    expect(state.recordFailure(recoveredAction)).toEqual({
      lastToolError: recoveredAction,
    });
  });

  it("keeps a multi-target recovery until every recovered target fails again", () => {
    const targetA = {
      toolName: "apply_patch",
      error: "A failed",
      mutatingAction: true,
      actionFingerprint: "tool=apply_patch|patch=one",
      fileTarget: { path: "/tmp/a" },
    } as const;
    const targetB = {
      ...targetA,
      error: "B failed",
      fileTarget: { path: "/tmp/b" },
    } as const;
    const state = createToolErrorState();

    state.recordFailure(targetA);
    state.recordFailure(targetB);
    expect(state.recordSuccess(targetA, [targetA.fileTarget, targetB.fileTarget])).toMatchObject({
      lastToolRecovery: { toolName: "apply_patch" },
    });
    expect(state.recordFailure(targetA)).toMatchObject({
      lastToolRecovery: { toolName: "apply_patch" },
    });
    expect(state.recordFailure(targetB).lastToolRecovery).toBeUndefined();
  });

  it("replaces an older receipt when a later tool call recovers", () => {
    const actionA = {
      toolName: "write",
      error: "A failed",
      mutatingAction: true,
      actionFingerprint: "tool=write|path=/tmp/a",
    } as const;
    const actionB = {
      ...actionA,
      error: "B failed",
      actionFingerprint: "tool=write|path=/tmp/b",
    } as const;
    const state = createToolErrorState();

    state.recordFailure(actionA);
    state.recordSuccess(actionA);
    state.recordFailure(actionB);
    expect(state.recordSuccess(actionB)).toMatchObject({
      lastToolRecovery: { toolName: "write" },
    });
    expect(state.recordFailure(actionB).lastToolRecovery).toBeUndefined();
  });

  it("retains action A after action B fails and then succeeds", () => {
    const actionA = {
      toolName: "message",
      error: "send A failed",
      mutatingAction: true,
      actionFingerprint: "tool=message|action=send|to=channel:a",
    } as const;
    const actionB = {
      toolName: "message",
      error: "send B failed",
      mutatingAction: true,
      actionFingerprint: "tool=message|action=send|to=channel:b",
    } as const;

    const state = createToolErrorState();
    state.recordFailure(actionA);
    const bothFailed = state.recordFailure(actionB);
    expect(bothFailed.lastToolError).toMatchObject({
      actionFingerprint: actionB.actionFingerprint,
    });
    expect(Object.getOwnPropertySymbols(bothFailed)).toHaveLength(0);
    expect(JSON.stringify(bothFailed)).not.toContain(actionA.error);

    const afterBRecovers = state.recordSuccess(actionB);
    expect(afterBRecovers).toMatchObject({
      lastToolError: actionA,
      lastToolRecovery: { toolName: "message" },
    });
    expect(state.recordSuccess(actionA)).toEqual({
      lastToolRecovery: { toolName: "message" },
    });
  });

  it("updates repeated failures for the same action without duplicating state", () => {
    const first = {
      toolName: "write",
      error: "first failure",
      mutatingAction: true,
      actionFingerprint: "tool=write|path=/tmp/a",
    } as const;
    const latest = { ...first, error: "latest failure" };

    const state = createToolErrorState();
    state.recordFailure(first);
    expect(state.recordFailure(latest)).toEqual({ lastToolError: latest });
  });

  it("moves a repeated action failure to the latest public position", () => {
    const actionA = {
      toolName: "message",
      error: "A failed again",
      mutatingAction: true,
      actionFingerprint: "tool=message|action=send|to=channel:a",
    } as const;
    const actionB = {
      toolName: "message",
      error: "B failed",
      mutatingAction: true,
      actionFingerprint: "tool=message|action=send|to=channel:b",
    } as const;
    const state = createToolErrorState();
    state.recordFailure(actionA);
    state.recordFailure(actionB);
    const latest = state.recordFailure(actionA);

    expect(latest.lastToolError?.error).toBe("A failed again");
    expect(state.recordSuccess(actionA)).toMatchObject({
      lastToolError: { error: "B failed" },
      lastToolRecovery: { toolName: "message" },
    });
  });
});
