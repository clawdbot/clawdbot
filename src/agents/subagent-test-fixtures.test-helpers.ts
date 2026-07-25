import { expect, vi } from "vitest";
import type { InternalSessionEntry } from "../config/sessions.js";
import type { SessionOrigin } from "../config/sessions/types.js";
import { normalizeLegacySessionEntryDelivery } from "../infra/state-migrations.legacy-session-store.js";
import type { DeliveryContext } from "../utils/delivery-context.types.js";
import type { AgentInternalEvent } from "./internal-events.js";
import type { RegisterSubagentRunParams } from "./subagent-registry-run-manager.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

type GatewayRequest = { method?: string };
type GatewayResponse<TRequest, TResult> =
  | TResult
  | Promise<TResult>
  | Error
  | ((request: TRequest) => TResult | Promise<TResult>);

function createGatewayMethodMock<
  TRequest extends GatewayRequest,
  TResult = Record<string, unknown>,
>(
  responses: Record<string, GatewayResponse<TRequest, TResult>>,
  fallback: GatewayResponse<TRequest, TResult>,
) {
  return vi.fn(async (request: TRequest) => {
    const response =
      request.method === undefined ? fallback : (responses[request.method] ?? fallback);
    if (response instanceof Error) {
      throw response;
    }
    if (typeof response === "function") {
      const handler = response as (request: TRequest) => TResult | Promise<TResult>;
      return await handler(request);
    }
    return response;
  });
}

export function mockGatewayMethods<TRequest extends GatewayRequest, TResult>(
  mock: {
    mockImplementation(impl: (request: TRequest) => Promise<TResult>): unknown;
  },
  responses: Record<string, GatewayResponse<TRequest, TResult>>,
  fallback = {} as TResult,
): void {
  mock.mockImplementation(createGatewayMethodMock(responses, fallback));
}

export type SessionEntryFixture = Partial<InternalSessionEntry> & {
  channel?: string;
  deliveryContext?: DeliveryContext;
  origin?: SessionOrigin;
  lastChannel?: string;
  lastTo?: string;
  lastAccountId?: string;
  lastThreadId?: string | number;
};

export function createSessionStore(
  overrides: SessionEntryFixture = {},
  sessionKey = "agent:main:subagent:child",
): Record<string, InternalSessionEntry> {
  return {
    [sessionKey]: createSessionEntry(overrides),
  };
}

export function createSessionEntry(overrides: SessionEntryFixture = {}): InternalSessionEntry {
  return normalizeLegacySessionEntryDelivery({
    sessionId: "sess-child",
    updatedAt: 1,
    ...overrides,
  } as InternalSessionEntry);
}

export function createAssistantToolCallMessage(content: unknown[]) {
  return {
    role: "assistant",
    content,
    stopReason: "toolUse",
  };
}

export type SubagentRunParamsOverrides = Pick<RegisterSubagentRunParams, "runId"> &
  Partial<RegisterSubagentRunParams>;

export function createSubagentRunParams(
  overrides: SubagentRunParamsOverrides,
): RegisterSubagentRunParams {
  return {
    childSessionKey: "agent:main:subagent:child",
    requesterSessionKey: "agent:main:main",
    requesterDisplayKey: "main",
    task: overrides.runId,
    cleanup: "keep",
    ...overrides,
  };
}

export type SubagentRunRecordOverrides = Pick<SubagentRunRecord, "runId"> &
  Partial<Omit<SubagentRunRecord, "delivery">> & {
    delivery?: unknown;
  };

export function createSubagentRunRecord(overrides: SubagentRunRecordOverrides): SubagentRunRecord {
  return {
    childSessionKey: "agent:main:subagent:child",
    requesterSessionKey: "agent:main:main",
    requesterDisplayKey: "main",
    task: overrides.runId,
    cleanup: "keep",
    createdAt: Date.now(),
    ...overrides,
  } as SubagentRunRecord;
}

type TaskCompletionEvent = Extract<AgentInternalEvent, { type: "task_completion" }>;

export function createTaskCompletionEvent(
  overrides: Partial<TaskCompletionEvent> = {},
): TaskCompletionEvent {
  return {
    type: "task_completion",
    source: "subagent",
    childSessionKey: "agent:worker:subagent:child",
    announceType: "subagent task",
    taskLabel: "direct completion smoke",
    status: "ok",
    statusLabel: "completed successfully",
    result: "child completion output",
    replyInstruction: "Summarize the result.",
    ...overrides,
  };
}

export const taskCompletionEvents = (overrides: Partial<TaskCompletionEvent> = {}) => [
  createTaskCompletionEvent(overrides),
];

export const musicCompletionEvents = (overrides: Partial<TaskCompletionEvent> = {}) =>
  taskCompletionEvents({
    source: "music_generation",
    childSessionKey: "music_generate:task-123",
    childSessionId: "task-123",
    announceType: "music generation task",
    taskLabel: "night-drive synthwave",
    result: "Generated 1 track.\nMEDIA:/tmp/generated-night-drive.mp3",
    mediaUrls: ["/tmp/generated-night-drive.mp3"],
    replyInstruction: "Deliver the generated music.",
    ...overrides,
  });

export const imageCompletionEvents = (overrides: Partial<TaskCompletionEvent> = {}) =>
  taskCompletionEvents({
    source: "image_generation",
    childSessionKey: "image_generate:task-123",
    childSessionId: "task-123",
    announceType: "image generation task",
    taskLabel: "daily media",
    statusLabel: "completed successfully",
    result: "Generated 1 image.\nMEDIA:/tmp/generated-daily.png",
    mediaUrls: ["/tmp/generated-daily.png"],
    replyInstruction: "Deliver the generated image through the requester run.",
    ...overrides,
  });

export const waitForFast = <T>(callback: () => T | Promise<T>) =>
  vi.waitFor(callback, { timeout: 1_000, interval: 1 });

export function expectRecord(value: unknown, label = "record"): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`expected ${label} to be an object`);
  }
  return value as Record<string, unknown>;
}

export function expectRecordFields(
  value: unknown,
  expected: Record<string, unknown>,
  label = "record",
): Record<string, unknown> {
  const record = expectRecord(value, label);
  for (const [key, expectedValue] of Object.entries(expected)) {
    expect(record[key], `${label}.${key}`).toEqual(expectedValue);
  }
  return record;
}

export function expectDeliveryPath(
  value: unknown,
  path: "direct" | "none" | "queued" | "steered",
): Record<string, unknown> {
  return expectRecordFields(value, { delivered: true, path }, "delivery");
}

export function mockCallArg(
  mock: unknown,
  callIndex = 0,
  argIndex = 0,
  label = "mock",
): Record<string, unknown> {
  const calls = (mock as { mock: { calls: unknown[][] } }).mock.calls;
  const call = calls[callIndex];
  if (!call) {
    throw new Error(`expected ${label} call ${callIndex}`);
  }
  return call[argIndex] as Record<string, unknown>;
}
