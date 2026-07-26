import { Value } from "typebox/value";
import { beforeEach, describe, expect, it } from "vitest";
import { validateStructuredOutputSchema } from "../swarm-output-schema.js";
import { createStructuredOutputTool } from "./structured-output-tool.js";
import { testing } from "./structured-output-tool.test-support.js";

describe("structured_output", () => {
  beforeEach(() => testing.reset());

  it("records a valid structured result", async () => {
    const tool = createStructuredOutputTool({
      runId: "run-1",
      schema: {
        type: "object",
        properties: { answer: { type: "string" } },
        required: ["answer"],
        additionalProperties: false,
      },
    });
    await expect(tool.execute("call-1", { result: { answer: "yes" } })).resolves.toBeDefined();
    expect(testing.readSwarmStructuredOutput("run-1")?.structured).toEqual({ answer: "yes" });
  });

  it("publishes a provider-valid schema while accepting any JSON result", () => {
    const tool = createStructuredOutputTool({
      runId: "run-json-value",
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
      runId: "run-2",
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
    await expect(tool.execute("call-2", { result: { count: "still bad" } })).resolves.toBeDefined();
    await expect(tool.execute("call-3", { result: { count: 3 } })).resolves.toBeDefined();
    expect(testing.readSwarmStructuredOutput("run-2")).toMatchObject({
      structured: undefined,
      invalidAttempts: 2,
    });
    expect(testing.readSwarmStructuredOutput("run-2")?.schemaError).toBeTruthy();
  });

  it("accepts general JSON Schemas and rejects malformed schemas before spawn", async () => {
    const arraySchema = { type: "array", items: { type: "string" } };
    expect(validateStructuredOutputSchema({})).toBeUndefined();
    expect(validateStructuredOutputSchema(arraySchema)).toBeUndefined();
    expect(validateStructuredOutputSchema({ type: "object", properties: "invalid" })).toContain(
      "Invalid sessions_spawn outputSchema",
    );
    const tool = createStructuredOutputTool({ runId: "run-array", schema: arraySchema });
    await expect(tool.execute("call-array", { result: ["one", "two"] })).resolves.toBeDefined();
    expect(testing.readSwarmStructuredOutput("run-array")?.structured).toEqual(["one", "two"]);
  });

  it("resumes the one-retry budget from durable state", async () => {
    let durableState: ReturnType<typeof testing.readSwarmStructuredOutput>;
    const schema = {
      type: "object",
      properties: { count: { type: "number" } },
      required: ["count"],
    };
    const first = createStructuredOutputTool({
      runId: "run-restart",
      schema,
      onStateChange: (state) => {
        durableState = state;
      },
    });
    await expect(first.execute("call-1", { result: { count: "bad" } })).rejects.toThrow(
      "Retry once",
    );

    testing.reset();
    const restored = createStructuredOutputTool({
      runId: "run-restart",
      schema,
      initialState: durableState,
    });
    await expect(
      restored.execute("call-2", { result: { count: "still bad" } }),
    ).resolves.toBeDefined();
    expect(testing.readSwarmStructuredOutput("run-restart")?.invalidAttempts).toBe(2);
  });
});
