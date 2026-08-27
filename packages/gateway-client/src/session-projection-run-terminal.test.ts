import { describe, expect, it } from "vitest";
import {
  createSessionProjection,
  hasSessionProjectionAcceptedFinal,
  reduceSessionProjection,
  type SessionProjectionScope,
} from "./session-projection.js";

const primaryScope: SessionProjectionScope = {
  sessionKey: "agent:main:shared",
  sessionId: "session-1",
  agentId: "main",
  lifecycleRevision: 1,
  activeLeafEntryId: "leaf-1",
};

function createMessage(
  role: "user" | "assistant",
  text: string,
  metadata?: Record<string, unknown>,
) {
  return {
    role,
    content: [{ type: "text", text }],
    ...(metadata ? { __openclaw: metadata } : {}),
  };
}

/** Run-scoped terminal state: final acceptance, late diagnostics, and retention. */
describe("session run terminal bookkeeping", () => {
  it("does not reopen a completed run when a stale stream delta arrives", () => {
    const completed = reduceSessionProjection(createSessionProjection(primaryScope), {
      type: "runTerminal",
      runId: "run-1",
      status: "completed",
    });

    expect(
      reduceSessionProjection(completed, {
        type: "runDelta",
        runId: "run-1",
        message: createMessage("assistant", "late stream"),
      }),
    ).toBe(completed);
  });

  it("upgrades an empty completed final exactly once without reopening the run", () => {
    const emptyMessage = createMessage("assistant", "");
    const deliveredMessage = createMessage("assistant", "eventual final");
    let state = reduceSessionProjection(createSessionProjection(primaryScope), {
      type: "runTerminal",
      runId: "run-1",
      status: "completed",
      message: emptyMessage,
    });
    expect(hasSessionProjectionAcceptedFinal(state.runs["run-1"], emptyMessage)).toBe(false);
    state = reduceSessionProjection(state, {
      type: "runTerminal",
      runId: "run-1",
      status: "completed",
      message: deliveredMessage,
    });

    expect(state.runs["run-1"]).toMatchObject({
      status: "completed",
      message: deliveredMessage,
    });
    const laterFinal = createMessage("assistant", "later distinct final");
    const laterEvent = {
      type: "runTerminal",
      runId: "run-1",
      status: "completed",
      message: laterFinal,
    } as const;
    const acceptedLaterFinal = reduceSessionProjection(state, laterEvent);
    expect(acceptedLaterFinal.runs["run-1"]?.message).toBe(deliveredMessage);
    expect(hasSessionProjectionAcceptedFinal(acceptedLaterFinal.runs["run-1"], laterFinal)).toBe(
      true,
    );
    expect(reduceSessionProjection(acceptedLaterFinal, laterEvent)).toBe(acceptedLaterFinal);
  });

  it("accepts distinct same-run persisted finals and ignores the later final's replay", () => {
    const first = createMessage("assistant", "first final", { id: "assistant-a", seq: 4 });
    const second = createMessage("assistant", "second final", { id: "assistant-b", seq: 5 });
    let state = reduceSessionProjection(createSessionProjection(primaryScope), {
      type: "runTerminal",
      runId: "run-1",
      status: "completed",
      message: first,
    });
    expect(hasSessionProjectionAcceptedFinal(state.runs["run-1"], second)).toBe(false);

    const secondEvent = {
      type: "runTerminal",
      runId: "run-1",
      status: "completed",
      message: second,
    } as const;
    state = reduceSessionProjection(state, secondEvent);

    expect(state.runs["run-1"]?.message).toBe(first);
    expect(state.runs["run-1"]?.acceptedFinalMessageIdentities).toHaveLength(2);
    expect(hasSessionProjectionAcceptedFinal(state.runs["run-1"], first)).toBe(true);
    expect(hasSessionProjectionAcceptedFinal(state.runs["run-1"], second)).toBe(true);
    expect(reduceSessionProjection(state, secondEvent)).toBe(state);
  });

  it.each(["error", "aborted"] as const)(
    "accepts a displayable final after a message-less %s without replaying it",
    (initialStatus) => {
      const delivered = createMessage("assistant", "recovered final", {
        id: "recovered-assistant",
        seq: 7,
      });
      let state = reduceSessionProjection(createSessionProjection(primaryScope), {
        type: "runTerminal",
        runId: "run-1",
        status: initialStatus,
        ...(initialStatus === "error"
          ? { errorKind: "provider_error", errorMessage: "provider diagnostic" }
          : { stopReason: "aborted" }),
      });
      const finalEvent = {
        type: "runTerminal",
        runId: "run-1",
        status: "completed",
        message: delivered,
      } as const;
      state = reduceSessionProjection(state, finalEvent);

      expect(state.runs["run-1"]).toMatchObject({
        status: initialStatus,
        message: delivered,
      });
      expect(hasSessionProjectionAcceptedFinal(state.runs["run-1"], delivered)).toBe(true);
      expect(reduceSessionProjection(state, finalEvent)).toBe(state);
      if (initialStatus === "error") {
        expect(state.runs["run-1"]?.errorMessage).toBe("provider diagnostic");
      }
    },
  );

  it("remembers distinct recovered finals after an initial message-less error", () => {
    const first = createMessage("assistant", "first recovered final", {
      id: "recovered-a",
      seq: 7,
    });
    const second = createMessage("assistant", "second recovered final", {
      id: "recovered-b",
      seq: 8,
    });
    let state = reduceSessionProjection(createSessionProjection(primaryScope), {
      type: "runTerminal",
      runId: "run-1",
      status: "error",
      errorKind: "provider_error",
      errorMessage: "original diagnostic",
    });
    state = reduceSessionProjection(state, {
      type: "runTerminal",
      runId: "run-1",
      status: "completed",
      message: first,
    });
    const secondEvent = {
      type: "runTerminal",
      runId: "run-1",
      status: "completed",
      message: second,
    } as const;
    state = reduceSessionProjection(state, secondEvent);

    expect(state.runs["run-1"]).toMatchObject({
      status: "error",
      message: first,
      errorMessage: "original diagnostic",
    });
    expect(state.runs["run-1"]?.acceptedFinalMessageIdentities).toHaveLength(2);
    expect(hasSessionProjectionAcceptedFinal(state.runs["run-1"], second)).toBe(true);
    expect(reduceSessionProjection(state, secondEvent)).toBe(state);
  });

  it("does not replace a displayable error with a conflicting later final", () => {
    const errorMessage = createMessage("assistant", "displayable failure");
    const state = reduceSessionProjection(createSessionProjection(primaryScope), {
      type: "runTerminal",
      runId: "run-1",
      status: "error",
      errorKind: "provider_error",
      message: errorMessage,
    });

    expect(
      reduceSessionProjection(state, {
        type: "runTerminal",
        runId: "run-1",
        status: "completed",
        message: createMessage("assistant", "conflicting final"),
      }),
    ).toBe(state);
    expect(state.runs["run-1"]?.message).toBe(errorMessage);
  });

  it("distinguishes and deduplicates metadata-free finals by canonical visible content", () => {
    const first = createMessage("assistant", "first metadata-free final");
    const second = createMessage("assistant", "second metadata-free final");
    let state = reduceSessionProjection(createSessionProjection(primaryScope), {
      type: "runTerminal",
      runId: "run-1",
      status: "completed",
      message: first,
    });
    const secondEvent = {
      type: "runTerminal",
      runId: "run-1",
      status: "completed",
      message: second,
    } as const;
    state = reduceSessionProjection(state, secondEvent);

    expect(state.runs["run-1"]?.message).toBe(first);
    expect(state.runs["run-1"]?.acceptedFinalMessageIdentities).toHaveLength(2);
    expect(hasSessionProjectionAcceptedFinal(state.runs["run-1"], second)).toBe(true);
    expect(reduceSessionProjection(state, secondEvent)).toBe(state);
  });

  it("bounds accepted same-run final identities without losing the first delivered reply", () => {
    const first = createMessage("assistant", "final 0", { id: "assistant-0", seq: 1 });
    let state = reduceSessionProjection(createSessionProjection(primaryScope), {
      type: "runTerminal",
      runId: "run-1",
      status: "completed",
      message: first,
    });
    for (let index = 1; index < 48; index += 1) {
      state = reduceSessionProjection(state, {
        type: "runTerminal",
        runId: "run-1",
        status: "completed",
        message: createMessage("assistant", `final ${index}`, {
          id: `assistant-${index}`,
          seq: index + 1,
        }),
      });
    }

    expect(state.runs["run-1"]?.message).toBe(first);
    expect(state.runs["run-1"]?.acceptedFinalMessageIdentities).toHaveLength(32);
    expect(hasSessionProjectionAcceptedFinal(state.runs["run-1"], first)).toBe(true);
    expect(
      hasSessionProjectionAcceptedFinal(
        state.runs["run-1"],
        createMessage("assistant", "final 47", { id: "assistant-47", seq: 48 }),
      ),
    ).toBe(true);
  });

  it("ignores whitespace diagnostics and accepts one meaningful late provider error", () => {
    const emptyError = reduceSessionProjection(createSessionProjection(primaryScope), {
      type: "runTerminal",
      runId: "empty-error",
      status: "error",
      errorMessage: " \n\t ",
    });
    expect(emptyError.runs["empty-error"]?.errorMessage).toBeUndefined();
    const delivered = createMessage("assistant", "delivered final", {
      id: "delivered-assistant",
      seq: 7,
    });
    let state = reduceSessionProjection(createSessionProjection(primaryScope), {
      type: "runTerminal",
      runId: "run-1",
      status: "completed",
      message: delivered,
    });
    const completed = state;
    state = reduceSessionProjection(state, {
      type: "runTerminal",
      runId: "run-1",
      status: "error",
      errorKind: "provider_error",
      errorMessage: "  \n\t ",
    });
    expect(state).toBe(completed);

    const actionableError = {
      type: "runTerminal",
      runId: "run-1",
      status: "error",
      errorKind: "provider_error",
      errorMessage: "  provider rejected request  ",
    } as const;
    state = reduceSessionProjection(state, actionableError);

    expect(state.runs["run-1"]).toMatchObject({
      status: "completed",
      message: delivered,
      errorKind: "provider_error",
      errorMessage: "provider rejected request",
    });
    expect(reduceSessionProjection(state, actionableError)).toBe(state);
  });

  it("bounds long-session terminal history without evicting any active stream", () => {
    let state = createSessionProjection(primaryScope);
    for (const runId of ["active-first", "active-second"]) {
      state = reduceSessionProjection(state, {
        type: "runDelta",
        runId,
        message: createMessage("assistant", `stream ${runId}`),
      });
    }
    for (let index = 0; index < 1_000; index += 1) {
      state = reduceSessionProjection(state, {
        type: "runTerminal",
        runId: `completed-${index}`,
        status: "completed",
        stopReason: "stop",
      });
    }

    expect(Object.keys(state.runs).length).toBeLessThanOrEqual(200);
    expect(state.runs["active-first"]?.status).toBe("streaming");
    expect(state.runs["active-second"]?.status).toBe("streaming");
    expect(state.runs["completed-0"]).toBeUndefined();
    expect(state.runs["completed-999"]).toMatchObject({
      status: "completed",
      stopReason: "stop",
    });
  });

  it("retains a newly completed live stream ahead of older terminal diagnostics", () => {
    let state = reduceSessionProjection(createSessionProjection(primaryScope), {
      type: "runDelta",
      runId: "active-first",
      message: createMessage("assistant", "stream"),
    });
    for (let index = 0; index < 199; index += 1) {
      state = reduceSessionProjection(state, {
        type: "runTerminal",
        runId: `older-${index}`,
        status: "completed",
      });
    }
    state = reduceSessionProjection(state, {
      type: "runTerminal",
      runId: "active-first",
      status: "completed",
    });
    state = reduceSessionProjection(state, {
      type: "runTerminal",
      runId: "newest",
      status: "completed",
    });

    expect(Object.keys(state.runs)).toHaveLength(150);
    expect(state.runs["older-0"]).toBeUndefined();
    expect(state.runs["active-first"]?.status).toBe("completed");
    expect(state.runs.newest?.status).toBe("completed");
  });

  it("protects every concurrent active stream when terminal retention reaches its soft cap", () => {
    let state = createSessionProjection(primaryScope);
    for (let index = 0; index < 205; index += 1) {
      state = reduceSessionProjection(state, {
        type: "runDelta",
        runId: `active-${index}`,
      });
    }

    expect(Object.keys(state.runs)).toHaveLength(205);
    expect(state.runs["active-0"]?.status).toBe("streaming");
    expect(state.runs["active-204"]?.status).toBe("streaming");
  });
});
