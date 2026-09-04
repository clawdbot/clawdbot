import type { ResponseOutputMessage } from "openai/resources/responses/responses.js";
import { afterEach, assert, describe, expect, it, vi } from "vitest";
import { cleanupSessionResources } from "../session-resources.js";
import {
  claimOpenAIResponsesHttpContinuation,
  resolveResponsesContinuationRequest,
  type ResponsesContinuationRequest,
  type ResponsesContinuationState,
} from "./openai-responses-continuation.js";

const user = (text: string) => ({
  type: "message" as const,
  role: "user" as const,
  content: [{ type: "input_text" as const, text }],
});
const answer: ResponseOutputMessage = {
  type: "message",
  role: "assistant",
  id: "msg_answer",
  status: "completed",
  content: [{ type: "output_text", text: "answer", annotations: [] }],
};
const update = (effort: string) => ({ type: "configuration_update", reasoning: { effort } });
const initial = (): ResponsesContinuationState => ({
  lastRequest: {
    model: "gpt-6-astra",
    reasoning: { effort: "low", summary: "auto" },
    input: [user("first")],
    store: true,
  },
  lastResponseId: "resp_1",
  lastResponseItems: [answer],
});
const next = (effort = "high") =>
  ({
    ...initial().lastRequest,
    reasoning: { effort, summary: "auto" },
    input: [user("first"), answer, user("second")],
  }) satisfies ResponsesContinuationRequest;

afterEach(() => {
  cleanupSessionResources();
  vi.useRealTimers();
});

describe("cache-preserving Responses reasoning changes", () => {
  it("keeps the request effort and original update positions through subsequent turns", () => {
    const first = initial();
    const second = next();
    const before = structuredClone({ first, second });
    const high = resolveResponsesContinuationRequest(first, second);
    expect(high.request).toMatchObject({
      previous_response_id: "resp_1",
      reasoning: { effort: "low" },
      input: [update("high"), user("second")],
    });
    assert(high.fullRequest);
    expect(high.fullRequest.input).toEqual([user("first"), answer, update("high"), user("second")]);
    expect({ first, second }).toEqual(before);
    const third = {
      ...next("medium"),
      input: [...second.input, answer, user("third")],
    };
    const medium = resolveResponsesContinuationRequest(
      { ...first, lastRequest: high.fullRequest, lastResponseId: "resp_2" },
      third,
    );
    expect(medium.request).toMatchObject({
      previous_response_id: "resp_2",
      reasoning: { effort: "low" },
      input: [update("medium"), user("third")],
    });
    assert(medium.fullRequest);
    expect(medium.fullRequest.input).toEqual([
      user("first"),
      answer,
      update("high"),
      user("second"),
      answer,
      update("medium"),
      user("third"),
    ]);
    const unchanged = resolveResponsesContinuationRequest(
      { ...first, lastRequest: medium.fullRequest, lastResponseId: "resp_3" },
      { ...third, input: [...third.input, answer, user("fourth")] },
    );
    expect(unchanged.request.input).toEqual([user("fourth")]);
    expect(unchanged.request.reasoning).toMatchObject({ effort: "low" });
  });

  it.each<{
    name: string;
    extra: Record<string, unknown>;
    mode?: "pro";
  }>([
    { name: "another model", extra: { model: "gpt-5.6-luna" } },
    { name: "pro mode", extra: {}, mode: "pro" },
    { name: "multi-agent", extra: { multi_agent: { enabled: true } } },
    { name: "automatic truncation", extra: { truncation: "auto" } },
    {
      name: "automatic compaction",
      extra: { context_management: [{ type: "compaction", compact_threshold: 1000 }] },
    },
  ])("leaves $name on request-level effort", ({ extra, mode }) => {
    const previous = initial();
    previous.lastRequest = {
      ...previous.lastRequest,
      ...extra,
      reasoning: { effort: "low", summary: "auto", mode },
    };
    const request = { ...next(), ...extra, reasoning: { effort: "high", summary: "auto", mode } };
    const result = resolveResponsesContinuationRequest(previous, request);
    expect(result.request).toBe(request);
    expect(result.fullRequest).toBeUndefined();
  });

  it("drops provisional updates when the original history changed or no new user exists", () => {
    for (const input of [
      [user("edited"), answer, user("second")],
      [user("first"), answer],
    ]) {
      const request = { ...next(), input };
      const result = resolveResponsesContinuationRequest(initial(), request);
      expect(result.request).toBe(request);
      expect(result.fullRequest).toBeUndefined();
      expect(result.request.reasoning).toMatchObject({ effort: "high" });
    }
  });

  it("replays unstored HTTP input and resets to the chosen effort after cache expiry", () => {
    vi.useFakeTimers();
    const claim = (request: ResponsesContinuationRequest) =>
      claimOpenAIResponsesHttpContinuation({
        sessionId: "reasoning-session",
        apiKey: "test-api-key",
        baseUrl: "https://api.openai.com/v1",
        headers: {},
        request: { ...request, store: false },
      });
    const first = claim(initial().lastRequest);
    assert(first);
    first.commit(first.fullRequest, { id: "resp_1", output: [answer] });
    const second = claim(next());
    assert(second);
    expect(second.request.previous_response_id).toBeUndefined();
    expect(second.request.reasoning).toMatchObject({ effort: "low" });
    expect(second.request.input).toEqual([user("first"), answer, update("high"), user("second")]);
    second.commit(second.fullRequest, { id: "resp_2", output: [answer] });
    vi.advanceTimersByTime(5 * 60 * 1000 + 1);
    const third = claim({ ...next("medium"), input: [...next().input, answer, user("third")] });
    assert(third);
    expect(third.request.previous_response_id).toBeUndefined();
    expect(third.request.reasoning).toMatchObject({ effort: "medium" });
    expect(third.request.input).not.toContainEqual(update("high"));
    third.release();
  });
});
