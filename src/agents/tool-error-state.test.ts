import { describe, expect, it } from "vitest";
import { createToolErrorState } from "./tool-error-state.js";

describe("unresolved tool mutation errors", () => {
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
    expect(bothFailed).toMatchObject({
      actionFingerprint: actionB.actionFingerprint,
    });
    expect(Object.getOwnPropertySymbols(bothFailed)).toHaveLength(0);
    expect(JSON.stringify(bothFailed)).not.toContain(actionA.error);

    const afterBRecovers = state.recordSuccess(actionB);
    expect(afterBRecovers).toMatchObject({
      actionFingerprint: actionA.actionFingerprint,
      error: actionA.error,
    });
    expect(state.recordSuccess(actionA)).toBeUndefined();
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
    expect(state.recordFailure(latest)).toEqual(latest);
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

    expect(latest.error).toBe("A failed again");
    expect(state.recordSuccess(actionA)?.error).toBe("B failed");
  });
});
