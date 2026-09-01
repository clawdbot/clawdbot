// Gateway Protocol tests cover typed chat stream events.
import type { Static } from "typebox";
import { Value } from "typebox/value";
import { describe, expect, expectTypeOf, it } from "vitest";
import {
  ChatEventSchema,
  ChatHistoryCursorResultSchema,
  ChatHistoryDeltaResultSchema,
  ChatHistoryParamsSchema,
  ChatHistoryResetResultSchema,
  ChatSendParamsSchema,
  ChatStatusEventSchema,
  type ChatHistoryCursorResult,
  type ChatHistoryDeltaResult,
  type ChatHistoryParams,
  type ChatHistoryResetResult,
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

  it("derives the public request and cursor result types from their schemas", () => {
    expectTypeOf<ChatHistoryParams>().toEqualTypeOf<Static<typeof ChatHistoryParamsSchema>>();
    expectTypeOf<ChatHistoryDeltaResult>().toEqualTypeOf<
      Static<typeof ChatHistoryDeltaResultSchema>
    >();
    expectTypeOf<ChatHistoryResetResult>().toEqualTypeOf<
      Static<typeof ChatHistoryResetResultSchema>
    >();
    expectTypeOf<ChatHistoryCursorResult>().toEqualTypeOf<
      Static<typeof ChatHistoryCursorResultSchema>
    >();
  });

  it("accepts only the closed delta and reset outcomes", () => {
    const delta = {
      kind: "delta",
      messages: [],
      deltaCursor: "cursor-2",
      sessionInfo,
    };
    expect(Value.Check(ChatHistoryCursorResultSchema, delta)).toBe(true);
    expect(
      Value.Check(ChatHistoryCursorResultSchema, {
        ...delta,
        inFlightRun: { runId: "run-live", text: "still working" },
        inputReceipts: [{ runId: "retained-run", state: "pending" }],
        inputConsumptions: [{ runId: "consumed-run", consumedByEventId: "event-1" }],
      }),
    ).toBe(true);
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
    expect(Value.Check(ChatSendParamsSchema, { ...send, unknown: true })).toBe(false);
  });
});
