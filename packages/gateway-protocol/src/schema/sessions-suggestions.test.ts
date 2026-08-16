import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import {
  SessionSuggestionEventSchema,
  SessionSuggestionsAddParamsSchema,
  SessionSuggestionsListResultSchema,
  SessionSuggestionsResolveParamsSchema,
  SessionTypingEventSchema,
  SessionTypingParamsSchema,
} from "./sessions-suggestions.js";

const suggestion = {
  id: "suggestion-1",
  sessionKey: "agent:main:main",
  agentId: "main",
  author: { type: "human", id: "alice", label: "Alice" },
  text: "Try the smaller refactor",
  createdAt: 1,
  state: "pending",
};

describe("session suggestions protocol", () => {
  it("accepts suggestion RPC and event payloads", () => {
    expect(
      Value.Check(SessionSuggestionsAddParamsSchema, {
        sessionKey: "agent:main:main",
        text: "Try the smaller refactor",
      }),
    ).toBe(true);
    expect(
      Value.Check(SessionSuggestionsResolveParamsSchema, {
        sessionKey: "agent:main:main",
        id: "suggestion-1",
        resolution: "queue",
      }),
    ).toBe(true);
    expect(
      Value.Check(SessionSuggestionsListResultSchema, {
        suggestions: [suggestion],
        role: "owner",
      }),
    ).toBe(true);
    expect(Value.Check(SessionSuggestionEventSchema, { action: "added", suggestion })).toBe(true);
    expect(
      Value.Check(SessionTypingParamsSchema, {
        sessionKey: "agent:main:main",
        sessionId: "session-main",
        typing: true,
      }),
    ).toBe(true);
    expect(
      Value.Check(SessionTypingEventSchema, {
        sessionKey: "agent:main:main",
        sessionId: "session-main",
        agentId: "main",
        actor: { type: "human", id: "alice", label: "Alice" },
        typing: true,
        ts: 1,
      }),
    ).toBe(true);
  });

  it("rejects empty suggestions and unknown resolutions", () => {
    expect(
      Value.Check(SessionSuggestionsAddParamsSchema, {
        sessionKey: "agent:main:main",
        text: "",
      }),
    ).toBe(false);
    expect(
      Value.Check(SessionSuggestionsResolveParamsSchema, {
        sessionKey: "agent:main:main",
        id: "suggestion-1",
        resolution: "accept",
      }),
    ).toBe(false);
  });
});
