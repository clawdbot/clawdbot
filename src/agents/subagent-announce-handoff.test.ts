import { describe, expect, it } from "vitest";
import { AGENT_INTERNAL_EVENT_TYPE_TASK_COMPLETION } from "./internal-event-contract.js";
import type { AgentInternalEvent } from "./internal-events.js";
import { isSubagentAnnounceCompletionHandoff } from "./subagent-announce-handoff.js";

const announceProvenance = {
  kind: "inter_session",
  sourceSessionKey: "agent:openclaw:subagent:child",
  sourceChannel: "internal",
  sourceTool: "subagent_announce",
} as const;

const subagentCompletionEvent: AgentInternalEvent = {
  type: AGENT_INTERNAL_EVENT_TYPE_TASK_COMPLETION,
  source: "subagent",
  childSessionKey: "agent:openclaw:subagent:child",
  announceType: "subagent task",
  taskLabel: "review",
  status: "ok",
  statusLabel: "completed",
  result: "child finished",
  replyInstruction: "Relay this completion.",
};

describe("isSubagentAnnounceCompletionHandoff", () => {
  it("matches an inter-session subagent completion announce", () => {
    expect(
      isSubagentAnnounceCompletionHandoff({
        inputProvenance: announceProvenance,
        internalEvents: [subagentCompletionEvent],
      }),
    ).toBe(true);
  });

  it("rejects human and non-completion inter-session turns", () => {
    expect(isSubagentAnnounceCompletionHandoff({ internalEvents: [subagentCompletionEvent] })).toBe(
      false,
    );
    expect(
      isSubagentAnnounceCompletionHandoff({
        inputProvenance: { ...announceProvenance, sourceTool: "sessions_send" },
        internalEvents: [subagentCompletionEvent],
      }),
    ).toBe(false);
    expect(
      isSubagentAnnounceCompletionHandoff({
        inputProvenance: announceProvenance,
        internalEvents: [],
      }),
    ).toBe(false);
  });
});
