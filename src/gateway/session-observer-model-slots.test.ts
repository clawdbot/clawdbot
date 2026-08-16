import { describe, expect, it, vi } from "vitest";
import { createSessionActivityNoteState } from "../agents/session-activity-notes.js";
import { createSessionObserverModelSlots } from "./session-observer-model-slots.js";
import type { SessionObserverState } from "./session-observer-model.js";

function modelState(index: number, terminalHealth?: "done" | "failed"): SessionObserverState {
  return {
    ...createSessionActivityNoteState(),
    sessionKey: `agent:main:session-${index}`,
    runId: `run-${index}`,
    agentId: "main",
    utilityModelRef: "openai/gpt-test",
    startedAt: index,
    lastActivityAt: index,
    lastRunAt: index,
    revision: 0,
    digestCount: 0,
    consecutiveFailures: 0,
    lastDigestNoteSequence: 0,
    inFlight: terminalHealth !== undefined,
    finalPending: terminalHealth !== undefined,
    ...(terminalHealth ? { terminalHealth } : {}),
  };
}

describe("session observer model slots", () => {
  it("demotes the oldest nonterminal model state", () => {
    const states = new Map<string, SessionObserverState>();
    const terminal = modelState(0, "done");
    states.set(terminal.sessionKey, terminal);
    for (let index = 1; index < 6; index += 1) {
      const state = modelState(index);
      states.set(state.sessionKey, state);
    }
    const demote = vi.fn();
    const slots = createSessionObserverModelSlots({
      states,
      maxSessions: 6,
      resolve: () => "openai/gpt-test",
      demote,
    });

    expect(slots.claim("main")).toBe("openai/gpt-test");
    expect(demote).toHaveBeenCalledWith(states.get("agent:main:session-1"));
    expect(demote).not.toHaveBeenCalledWith(terminal);
  });

  it("does not evict terminal finalizations when every slot is protected", () => {
    const states = new Map<string, SessionObserverState>();
    for (let index = 0; index < 6; index += 1) {
      const state = modelState(index, "done");
      states.set(state.sessionKey, state);
    }
    const demote = vi.fn();
    const slots = createSessionObserverModelSlots({
      states,
      maxSessions: 6,
      resolve: () => "openai/gpt-test",
      demote,
    });

    expect(slots.claim("main")).toBeUndefined();
    expect(demote).not.toHaveBeenCalled();
  });
});
