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

describe("ChatErrorEventSchema", () => {
  const event = { runId: "run-1", sessionKey: "agent:main:main", seq: 1, state: "error" };
  const detail = {
    provider: "openai",
    model: "gpt-5.6-luna",
    failoverReason: "server_error",
    providerRuntimeFailureKind: "timeout",
    providerErrorType: "server_error",
    httpStatus: 502,
    providerErrorMessagePreview: "Upstream unavailable",
  };

  it("round-trips optional closed provider error details", () => {
    for (const errorDetail of [
      undefined,
      {},
      ...Object.entries(detail).map(([key, value]) => ({ [key]: value })),
      detail,
    ]) {
      const serialized = JSON.stringify({ ...event, errorDetail });
      const wire = JSON.parse(serialized);
      expect(Value.Check(ChatEventSchema, wire)).toBe(true);
    }
    expect(
      Value.Check(ChatEventSchema, {
        ...event,
        errorDetail: { ...detail, rawErrorPreview: "raw" },
      }),
    ).toBe(false);
    expect(Value.Check(ChatEventSchema, { ...event, state: "final", errorDetail: detail })).toBe(
      false,
    );
  });

  it("enforces string and HTTP status bounds", () => {
    for (const key of Object.keys(detail).filter((field) => field !== "httpStatus")) {
      expect(
        Value.Check(ChatEventSchema, { ...event, errorDetail: { [key]: "x".repeat(300) } }),
      ).toBe(true);
      expect(
        Value.Check(ChatEventSchema, { ...event, errorDetail: { [key]: "x".repeat(301) } }),
      ).toBe(false);
    }
    for (const httpStatus of [100, 599]) {
      expect(Value.Check(ChatEventSchema, { ...event, errorDetail: { httpStatus } })).toBe(true);
    }
    for (const httpStatus of [99, 600, 502.5, "502"]) {
      expect(Value.Check(ChatEventSchema, { ...event, errorDetail: { httpStatus } })).toBe(false);
    }
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

  it("accepts session settings expectations", () => {
    expect(
      Value.Check(ChatSendParamsSchema, {
        ...send,
        expectedPermissionMode: "guarded",
        expectedToolOverrides: { webSearch: false },
      }),
    ).toBe(true);
  });
});
