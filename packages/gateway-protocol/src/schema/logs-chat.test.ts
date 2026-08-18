// Gateway Protocol tests cover typed chat stream events.
import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import {
  ChatEventSchema,
  ChatHistoryCursorResultSchema,
  ChatHistoryParamsSchema,
  ChatSendParamsSchema,
  ChatStatusEventSchema,
} from "./logs-chat.js";

const statusEvent = {
  runId: "run-1",
  sessionKey: "agent:main:main",
  seq: 1,
  state: "status",
  phase: "preparing_context",
} as const;

describe("ChatHistoryParamsSchema", () => {
  it("accepts the history boundary and rejects larger requests", () => {
    const request = { sessionKey: "agent:main:main" };

    expect(Value.Check(ChatHistoryParamsSchema, { ...request, limit: 1000 })).toBe(true);
    expect(Value.Check(ChatHistoryParamsSchema, { ...request, limit: 1001 })).toBe(false);
    expect(Value.Check(ChatHistoryParamsSchema, { ...request, cursor: "" })).toBe(true);
  });
});

describe("ChatHistoryCursorResultSchema", () => {
  const sessionInfo = { key: "agent:main:main" };

  it("accepts only the closed delta and reset outcomes", () => {
    const delta = {
      kind: "delta",
      messages: [],
      deltaCursor: "cursor-2",
      sessionInfo,
    };
    expect(Value.Check(ChatHistoryCursorResultSchema, delta)).toBe(true);
    expect(Value.Check(ChatHistoryCursorResultSchema, { kind: "reset" })).toBe(true);
    expect(Value.Check(ChatHistoryCursorResultSchema, { ...delta, extra: true })).toBe(false);
    expect(Value.Check(ChatHistoryCursorResultSchema, { kind: "reset", messages: [] })).toBe(false);
  });
});

describe("ChatStatusEventSchema", () => {
  it("accepts closed startup phases through the chat event union", () => {
    expect(Value.Check(ChatStatusEventSchema, statusEvent)).toBe(true);
    expect(Value.Check(ChatEventSchema, statusEvent)).toBe(true);
  });

  it("rejects unknown phases and extra fields", () => {
    expect(Value.Check(ChatStatusEventSchema, { ...statusEvent, phase: "thinking" })).toBe(false);
    expect(Value.Check(ChatStatusEventSchema, { ...statusEvent, detail: "Loading" })).toBe(false);
  });
});

describe("ChatSendParamsSchema", () => {
  const send = {
    sessionKey: "agent:main:main",
    message: "hello",
    idempotencyKey: "run-1",
  };

  it("accepts an expected active leaf while remaining closed", () => {
    expect(Value.Check(ChatSendParamsSchema, { ...send, expectedLeafEntryId: "leaf-1" })).toBe(
      true,
    );
    expect(Value.Check(ChatSendParamsSchema, { ...send, expectedLeafEntryId: null })).toBe(true);
    expect(
      Value.Check(ChatSendParamsSchema, {
        ...send,
        queueMode: "steer",
        expectedLeafEntryId: "leaf-1",
      }),
    ).toBe(true);
    expect(Value.Check(ChatSendParamsSchema, { ...send, expectedRunId: "run-1" })).toBe(true);
    expect(Value.Check(ChatSendParamsSchema, { ...send, unknown: true })).toBe(false);
  });
});
