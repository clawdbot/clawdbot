import { describe, expect, it } from "vitest";
import { startQaMockOpenAiServer } from "./server.js";

const prompt = "Reply exactly: QA-MESSAGE-CONTENT";

describe("mock Responses input text", () => {
  it.each([
    { name: "plain input", input: prompt },
    { name: "string message", input: [{ role: "user", content: prompt }] },
    {
      name: "text-block message",
      input: [{ role: "user", content: [{ type: "input_text", text: prompt }] }],
    },
  ])("reads $name", async ({ input }) => {
    const server = await startQaMockOpenAiServer({ host: "127.0.0.1", port: 0 });
    try {
      const response = await fetch(`${server.baseUrl}/v1/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "qa-model", stream: false, input }),
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        output: [
          {
            type: "message",
            content: [{ type: "output_text", text: "QA-MESSAGE-CONTENT" }],
          },
        ],
      });
    } finally {
      await server.stop();
    }
  });

  it.each([
    {
      name: "ignores a runtime carrier before continuation",
      laterInput: [
        {
          role: "user",
          content: [
            "OpenClaw runtime event.",
            "This context is runtime-generated, not user-authored. Keep internal details private.",
            "<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>",
            "Runtime: synthetic metadata.",
            "<<<END_OPENCLAW_INTERNAL_CONTEXT>>>",
          ].join("\n"),
        },
        { role: "user", content: [{ type: "input_text", text: "Continue." }] },
      ],
      requestKind: "tool-continuation",
    },
    {
      name: "fences completed tools with an empty user message after continuation",
      laterInput: [
        { role: "user", content: "Continue." },
        { role: "user", content: [] },
      ],
      requestKind: "agent-initial",
    },
    {
      name: "empty authored turn fences earlier QA",
      laterInput: [{ role: "user", content: [] }],
      requestKind: "agent-initial",
    },
  ])("$name", async ({ laterInput, requestKind }) => {
    const server = await startQaMockOpenAiServer({ host: "127.0.0.1", port: 0 });
    try {
      const response = await fetch(`${server.baseUrl}/v1/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "qa-model",
          stream: false,
          input: [
            {
              role: "user",
              content: [
                {
                  type: "input_text",
                  text: "Tool progress QA check: read `QA.md` before answering.",
                },
              ],
            },
            {
              type: "function_call",
              id: "fc_fixture",
              call_id: "fixture_call",
              name: "read",
              arguments: '{"path":"QA.md"}',
            },
            { type: "function_call_output", call_id: "fixture_call", output: "fixture result" },
            ...laterInput,
          ],
        }),
      });
      expect(response.status).toBe(200);
      await response.arrayBuffer();
      const snapshot = await fetch(`${server.baseUrl}/debug/last-request`).then((res) =>
        res.json(),
      );
      expect(snapshot).toMatchObject({ requestKind });
      if (requestKind === "agent-initial") {
        expect(snapshot).not.toHaveProperty("plannedToolName");
      }
    } finally {
      await server.stop();
    }
  });
});
