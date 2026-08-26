import { describe, expect, it } from "vitest";
import { AGENT_INTERNAL_EVENT_TYPE_TASK_COMPLETION } from "../../internal-event-contract.js";
import type { AgentInternalEvent } from "../../internal-events.js";
import {
  isSubagentAnnounceCompletionHandoff,
  isTrustedSubagentCompletionHandoffForRun,
} from "./subagent-announce-handoff.js";

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
  childSessionId: "child-session",
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

  it("keeps malformed completion announces in the broad deny class", () => {
    expect(
      isSubagentAnnounceCompletionHandoff({
        inputProvenance: announceProvenance,
        internalEvents: [
          { ...subagentCompletionEvent, childSessionKey: "agent:openclaw:subagent:forged" },
        ],
      }),
    ).toBe(true);
    expect(
      isSubagentAnnounceCompletionHandoff({
        inputProvenance: announceProvenance,
        internalEvents: [subagentCompletionEvent, subagentCompletionEvent],
      }),
    ).toBe(true);
  });
});

describe("isTrustedSubagentCompletionHandoffForRun", () => {
  const exact = {
    handoff: {
      kind: "subagent-completion",
      sourceSessionKey: announceProvenance.sourceSessionKey,
      sourceSessionId: subagentCompletionEvent.childSessionId,
      targetSessionKey: "agent:main:main",
      targetSessionId: "requester-session",
      provider: "openai",
      model: "glm-4.5",
    } as const,
    inputProvenance: announceProvenance,
    internalEvents: [subagentCompletionEvent],
    sessionKey: "agent:main:main",
    sessionId: "requester-session",
    provider: "openai",
    model: "glm-4.5",
  };

  it("accepts only the exact completion attempt", () => {
    expect(isTrustedSubagentCompletionHandoffForRun(exact)).toBe(true);
  });

  it.each([
    ["source", { inputProvenance: { ...announceProvenance, sourceSessionKey: "forged" } }],
    [
      "source event",
      {
        internalEvents: [
          { ...subagentCompletionEvent, childSessionKey: "agent:openclaw:subagent:forged" },
        ],
      },
    ],
    ["source run", { internalEvents: [{ ...subagentCompletionEvent, childSessionId: "forged" }] }],
    ["duplicate event", { internalEvents: [subagentCompletionEvent, subagentCompletionEvent] }],
    ["target", { sessionKey: "agent:main:other" }],
    ["target run", { sessionId: "replacement-session" }],
    ["provider", { provider: "anthropic" }],
    ["model", { model: "claude-opus-4-1" }],
  ])("rejects a cross-%s handoff", (_name, overrides) => {
    expect(isTrustedSubagentCompletionHandoffForRun({ ...exact, ...overrides })).toBe(false);
  });
});
