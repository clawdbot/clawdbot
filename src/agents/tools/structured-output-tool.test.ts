import { Value } from "typebox/value";
import { afterEach, describe, expect, it, vi } from "vitest";
import { validateStructuredOutputSchema } from "../subagents/swarm/swarm-output-schema.js";
import { isToolResultError } from "../tool-result-error.js";
import {
  consumeSwarmStructuredOutput,
  createStructuredOutputTool,
  peekSwarmStructuredOutput,
} from "./structured-output-tool.js";

const runId = "structured-output-tool-test";

describe("structured_output", () => {
  afterEach(() => {
    consumeSwarmStructuredOutput(runId);
  });

  it("records a valid structured result", async () => {
    const tool = createStructuredOutputTool({
      runId,
      schema: {
        type: "object",
        properties: { answer: { type: "string" } },
        required: ["answer"],
        additionalProperties: false,
      },
    });
    const result = await tool.execute("call-1", { result: { answer: "yes" } });
    expect(isToolResultError(result)).toBe(false);
    expect(peekSwarmStructuredOutput(runId)?.structured).toEqual({ answer: "yes" });
  });

  it("publishes a provider-valid schema while accepting any JSON result", () => {
    const tool = createStructuredOutputTool({
      runId,
      schema: {},
    });
    expect(tool.parameters).toEqual({
      type: "object",
      required: ["result"],
      properties: {
        result: {
          type: ["object", "array", "string", "number", "boolean", "null"],
        },
      },
      additionalProperties: false,
    });
    for (const result of [{ answer: "yes" }, ["yes"], "yes", 1, true, null]) {
      expect(Value.Check(tool.parameters, { result })).toBe(true);
    }
    expect(Value.Check(tool.parameters, { result: undefined })).toBe(false);
  });

  it("nudges once then freezes schemaError", async () => {
    const tool = createStructuredOutputTool({
      runId,
      schema: {
        type: "object",
        properties: { count: { type: "number" } },
        required: ["count"],
      },
    });
    expect(Value.Check(tool.parameters, { result: { count: "bad" } })).toBe(true);
    expect(tool.description).toContain('"count"');
    await expect(tool.execute("call-1", { result: { count: "bad" } })).rejects.toThrow(
      "Retry once",
    );
    const rejectedRetry = await tool.execute("call-2", { result: { count: "still bad" } });
    const rejectedLaterCall = await tool.execute("call-3", { result: { count: 3 } });
    expect(rejectedRetry.details).toMatchObject({ status: "rejected", success: false });
    expect(rejectedLaterCall.details).toMatchObject({ status: "rejected", success: false });
    expect(isToolResultError(rejectedRetry)).toBe(true);
    expect(isToolResultError(rejectedLaterCall)).toBe(true);
    expect(peekSwarmStructuredOutput(runId)).toMatchObject({
      structured: undefined,
      invalidAttempts: 2,
    });
    expect(peekSwarmStructuredOutput(runId)?.schemaError).toBeTruthy();
  });

  it("accepts general JSON Schemas and rejects malformed schemas before spawn", async () => {
    const arraySchema = { type: "array", items: { type: "string" } };
    expect(validateStructuredOutputSchema({})).toBeUndefined();
    expect(validateStructuredOutputSchema(arraySchema)).toBeUndefined();
    expect(validateStructuredOutputSchema({ type: "object", properties: "invalid" })).toContain(
      "Invalid sessions_spawn outputSchema",
    );
    const tool = createStructuredOutputTool({ runId, schema: arraySchema });
    await expect(tool.execute("call-array", { result: ["one", "two"] })).resolves.toBeDefined();
    expect(peekSwarmStructuredOutput(runId)?.structured).toEqual(["one", "two"]);
  });

  it("resumes the one-retry budget from durable state", async () => {
    let durableState: ReturnType<typeof peekSwarmStructuredOutput>;
    const schema = {
      type: "object",
      properties: { count: { type: "number" } },
      required: ["count"],
    };
    const first = createStructuredOutputTool({
      runId,
      schema,
      onStateChange: (state) => {
        durableState = state;
      },
    });
    await expect(first.execute("call-1", { result: { count: "bad" } })).rejects.toThrow(
      "Retry once",
    );

    consumeSwarmStructuredOutput(runId);
    const restored = createStructuredOutputTool({
      runId,
      schema,
      initialState: durableState,
    });
    const rejected = await restored.execute("call-2", { result: { count: "still bad" } });
    expect(rejected.details).toMatchObject({ status: "rejected", success: false });
    expect(isToolResultError(rejected)).toBe(true);
    expect(peekSwarmStructuredOutput(runId)?.invalidAttempts).toBe(2);
  });

  it.each(["first result", "invalid retry"] as const)(
    "preserves the retry budget when persisting the %s fails",
    async (failure) => {
      const persist = vi.fn();
      const tool = createStructuredOutputTool({
        runId,
        schema: {
          type: "object",
          properties: { count: { type: "number" } },
          required: ["count"],
        },
        onStateChange: persist,
      });
      if (failure === "invalid retry") {
        await expect(tool.execute("initial", { result: { count: "bad" } })).rejects.toThrow(
          "Retry once",
        );
      }
      const previous = peekSwarmStructuredOutput(runId);
      persist.mockImplementationOnce(() => {
        throw new Error("storage unavailable");
      });
      const attempted = failure === "first result" ? { count: 1 } : { count: "still bad" };
      await expect(tool.execute("failed-write", { result: attempted })).rejects.toThrow(
        "Failed to persist structured_output: storage unavailable",
      );
      expect(peekSwarmStructuredOutput(runId)).toEqual(previous);

      const corrected = { count: 2 };
      expect((await tool.execute("corrected", { result: corrected })).details).toEqual({
        status: "recorded",
      });
      expect(peekSwarmStructuredOutput(runId)).toEqual({
        structured: corrected,
        invalidAttempts: 0,
      });
      expect(persist).toHaveBeenLastCalledWith({ structured: corrected, invalidAttempts: 0 });
      await expect(tool.execute("duplicate", { result: { count: 3 } })).rejects.toThrow(
        "already recorded",
      );
      expect(consumeSwarmStructuredOutput(runId)?.structured).toEqual(corrected);
    },
  );
});
