import { describe, expect, it } from "vitest";
import {
  acceptPendingSubmit,
  beginPendingSubmit,
  clearPendingSubmit,
  clearPendingSubmitDraft,
  disconnectedTuiChatSubmitMessage,
  getPendingSubmitAcceptedRunId,
  getPendingSubmitDraft,
  reconcilePendingSubmitHistory,
  resolveTuiChatSubmitAdmission,
  type TuiPendingSubmit,
} from "./tui-submit-state.js";

type State = { pendingSubmit: TuiPendingSubmit | null };

describe("resolveTuiChatSubmitAdmission", () => {
  it.each([
    {
      name: "idle",
      isConnected: true,
      activeChatRunId: null,
      pendingSubmit: null,
      message: "hello",
      expected: "allowed",
    },
    {
      name: "active run",
      isConnected: true,
      activeChatRunId: "run-active",
      pendingSubmit: null,
      message: "follow up",
      expected: "allowed",
    },
    {
      name: "disconnected",
      isConnected: false,
      activeChatRunId: null,
      pendingSubmit: null,
      message: "send after reconnect",
      expected: "disconnected",
    },
    {
      name: "sending",
      isConnected: true,
      activeChatRunId: null,
      pendingSubmit: { phase: "sending", runId: "run-send", draftText: "hello" },
      message: "another",
      expected: "pending",
    },
    {
      name: "accepted",
      isConnected: true,
      activeChatRunId: null,
      pendingSubmit: { phase: "accepted", runId: "run-pending", draftText: "hello" },
      message: "another",
      expected: "pending",
    },
    {
      name: "stop active run",
      isConnected: true,
      activeChatRunId: "run-active",
      pendingSubmit: null,
      message: "please stop",
      expected: "allowed",
    },
    {
      name: "stop accepted run",
      isConnected: true,
      activeChatRunId: null,
      pendingSubmit: { phase: "accepted", runId: "run-pending", draftText: null },
      message: "please stop",
      expected: "allowed",
    },
  ] as const)("returns $expected while $name", ({ expected, ...params }) => {
    expect(resolveTuiChatSubmitAdmission(params)).toBe(expected);
  });
});

describe("pending submit transitions", () => {
  it("moves one submit through sending, accepted, registered, and reconciled states", () => {
    const state: State = { pendingSubmit: null };

    beginPendingSubmit(state, "run-local", "hello");
    expect(state.pendingSubmit).toEqual({
      phase: "sending",
      runId: "run-local",
      draftText: "hello",
    });
    expect(getPendingSubmitAcceptedRunId(state)).toBeNull();
    expect(getPendingSubmitDraft(state)).toEqual({ runId: "run-local", text: "hello" });

    expect(
      acceptPendingSubmit({
        state,
        provisionalRunId: "run-local",
        acceptedRunId: "run-accepted",
        preserveDraft: true,
      }),
    ).toBe(true);
    expect(state.pendingSubmit).toEqual({
      phase: "accepted",
      runId: "run-accepted",
      draftText: "hello",
    });
    expect(getPendingSubmitAcceptedRunId(state)).toBe("run-accepted");

    expect(clearPendingSubmitDraft(state, "run-accepted")).toBe(true);
    expect(state.pendingSubmit).toEqual({
      phase: "accepted",
      runId: "run-accepted",
      draftText: null,
    });
    expect(reconcilePendingSubmitHistory(state, ["other-run"])).toBe(false);
    expect(reconcilePendingSubmitHistory(state, ["run-accepted"])).toBe(true);
    expect(state.pendingSubmit).toBeNull();
  });

  it("does not re-arm a submit cleared by an event before its ACK", () => {
    const state: State = { pendingSubmit: null };
    beginPendingSubmit(state, "run-local", "hello");
    expect(clearPendingSubmit(state, "run-local")).toBe(true);

    expect(
      acceptPendingSubmit({
        state,
        provisionalRunId: "run-local",
        acceptedRunId: "run-accepted",
        preserveDraft: true,
      }),
    ).toBe(false);
    expect(state.pendingSubmit).toBeNull();
  });

  it("does not accept an already accepted submit again", () => {
    const state: State = {
      pendingSubmit: { phase: "accepted", runId: "run-accepted", draftText: null },
    };

    expect(
      acceptPendingSubmit({
        state,
        provisionalRunId: "run-accepted",
        acceptedRunId: "run-other",
        preserveDraft: false,
      }),
    ).toBe(false);
    expect(state.pendingSubmit?.runId).toBe("run-accepted");
  });

  it("keeps draft ownership while a submit is still sending", () => {
    const state: State = {
      pendingSubmit: { phase: "sending", runId: "run-sending", draftText: "hello" },
    };

    expect(clearPendingSubmitDraft(state, "run-sending")).toBe(false);
    expect(state.pendingSubmit?.draftText).toBe("hello");
  });

  it("clears only the run that owns the pending state", () => {
    const state: State = {
      pendingSubmit: { phase: "accepted", runId: "run-current", draftText: "hello" },
    };

    expect(clearPendingSubmit(state, "run-other")).toBe(false);
    expect(state.pendingSubmit?.runId).toBe("run-current");
  });
});

describe("disconnectedTuiChatSubmitMessage", () => {
  it("uses the connection message for the selected runtime", () => {
    expect(disconnectedTuiChatSubmitMessage(false)).toBe(
      "not connected to gateway — message not sent",
    );
    expect(disconnectedTuiChatSubmitMessage(true)).toBe(
      "local runtime not ready — message not sent",
    );
  });
});
