import { randomUUID } from "node:crypto";
import type { Context, Model, Tool } from "@openclaw/llm-core";
import OpenAI from "openai";
import { describe, expect, it } from "vitest";
import { cleanupSessionResources } from "../session-resources.js";
import { createOpenAIResponsesTransportStreamFn } from "./openai-responses-client.js";
import type { OpenAIResponsesOptions } from "./openai-responses-contracts.js";
import { captureOpenAIResponses } from "./openai-responses-live-capture.test-support.js";

const apiKey = process.env.OPENAI_API_KEY ?? "";
const describeLive = process.env.OPENCLAW_LIVE_TEST === "1" && apiKey ? describe : describe.skip;
const modelId = process.env.OPENCLAW_LIVE_RESPONSES_MODEL || "gpt-5.6-luna";
const model = {
  id: modelId,
  name: modelId,
  api: "openai-responses",
  provider: "openai",
  baseUrl: "https://api.openai.com/v1",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200_000,
  maxTokens: 1024,
} satisfies Model<"openai-responses">;

const remember: Tool = {
  name: "remember_code",
  description: "Record the supplied code.",
  parameters: {
    type: "object",
    properties: { code: { type: "string" } },
    required: ["code"],
    additionalProperties: false,
  },
};
const report: Tool = { ...remember, name: "report_code" };
const revisedReport: Tool = {
  ...report,
  parameters: {
    type: "object",
    properties: { code: { type: "string" }, revision: { type: "integer", const: 2 } },
    required: ["code", "revision"],
    additionalProperties: false,
  },
};

describeLive("native HTTP Responses continuation with current tools", () => {
  it.each([
    { name: "added", before: [remember], after: [remember, report], selected: report },
    { name: "removed", before: [remember, report], after: [report], selected: report },
    { name: "schema changed", before: [report], after: [revisedReport], selected: revisedReport },
    { name: "empty", before: [remember], after: [], selected: undefined },
    { name: "omitted", before: [remember], after: undefined, selected: undefined },
  ] satisfies Array<{
    name: string;
    before: [Tool, ...Tool[]];
    after: Tool[] | undefined;
    selected: Tool | undefined;
  }>)(
    "honors $name tools while recalling omitted history",
    async ({ name, before, after, selected }) => {
      const sessionId = `live-tools-${randomUUID()}`;
      const code = `CODE_${randomUUID()}`;
      const responseIds: string[] = [];
      const run = async (context: Context) => {
        const options = {
          apiKey,
          sessionId,
          transport: "sse",
          reasoningEffort: "low",
          onPayload: (payload) => ({
            ...(payload as Record<string, unknown>),
            store: true,
            tool_choice: "auto",
          }),
        } satisfies OpenAIResponsesOptions;
        const stream = await createOpenAIResponsesTransportStreamFn()(model, context, options);
        const result = await stream.result();
        if (result.responseId) {
          responseIds.push(result.responseId);
        }
        return result;
      };
      try {
        const captured = await captureOpenAIResponses(async () => {
          const firstUser = {
            role: "user" as const,
            content: `Remember ${code}. Call only ${before[0].name} with that exact code.`,
            timestamp: 1,
          };
          const first = await run({ messages: [firstUser], tools: before });
          expect(first.stopReason).toBe("toolUse");
          const calls = first.content.filter((block) => block.type === "toolCall");
          expect(calls).toHaveLength(1);
          const call = calls[0];
          if (!call) {
            throw new Error("Expected one completed tool call");
          }
          expect(call.name).toBe(before[0].name);
          expect(call.arguments).toEqual({ code });
          const prompt = selected
            ? name === "removed"
              ? "Call remember_code if available; otherwise call report_code with the remembered code."
              : `Call only ${selected.name} with the remembered code, using the current schema. If it asks for a revision, use 2.`
            : "Call remember_code if available; otherwise reply with only the remembered code.";
          const second = await run({
            messages: [
              firstUser,
              first,
              {
                role: "toolResult",
                toolCallId: call.id,
                toolName: call.name,
                content: [{ type: "text", text: "recorded" }],
                isError: false,
                timestamp: 2,
              },
              { role: "user", content: prompt, timestamp: 3 },
            ],
            tools: after,
          });
          return { first, second, call, prompt };
        });
        const { first, second, call, prompt } = captured.result;
        expect(captured.requests).toHaveLength(2);
        const current = captured.requests[1];
        expect(first.responseId).toEqual(expect.any(String));
        expect(current).toMatchObject({
          previous_response_id: first.responseId,
          tool_choice: "auto",
          input: [
            { type: "function_call_output", call_id: call.id.split("|")[0], output: "recorded" },
            { type: "message", role: "user", content: [{ type: "input_text", text: prompt }] },
          ],
        });
        expect(JSON.stringify(current)).not.toContain(code);
        if (after === undefined) {
          expect(current).not.toHaveProperty("tools");
        } else {
          expect(current?.tools).toEqual(
            after
              .toSorted((a, b) => a.name.localeCompare(b.name))
              .map((tool) =>
                expect.objectContaining({
                  type: "function",
                  name: tool.name,
                  parameters: tool.parameters,
                }),
              ),
          );
        }
        if (selected) {
          expect(second.stopReason).toBe("toolUse");
          expect(second.content.filter((block) => block.type === "toolCall")).toMatchObject([
            {
              name: selected.name,
              arguments: selected === revisedReport ? { code, revision: 2 } : { code },
            },
          ]);
        } else {
          expect(second.stopReason).toBe("stop");
          expect(second.content.filter((block) => block.type === "toolCall")).toEqual([]);
          expect(
            second.content
              .filter((block) => block.type === "text")
              .map((block) => block.text)
              .join("")
              .trim(),
          ).toBe(code);
        }
      } finally {
        cleanupSessionResources(sessionId);
        const client = new OpenAI({ apiKey, maxRetries: 0 });
        await Promise.all(responseIds.map((id) => client.responses.delete(id)));
      }
    },
    120_000,
  );
});
