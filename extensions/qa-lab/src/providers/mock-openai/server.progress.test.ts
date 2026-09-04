import { describe, expect, it } from "vitest";
import { startQaMockOpenAiServer } from "./server.js";

const READ_PROMPT =
  "Tool progress QA check: read `empty.txt` before answering. After the read completes, reply exactly `PROGRESS_OK`.";
const EXEC_PROMPT =
  "Tool progress QA check: call the exec tool exactly once with this exact command before answering: `true`. After that command completes, reply exactly `PROGRESS_OK`.";
const ERROR_PROMPT =
  "Tool progress error QA check: read `denied.txt` before answering. After the read fails, reply exactly `PROGRESS_OK`.";

async function completeProgress(params: {
  route: string;
  prompt: string;
  tool: string;
  output: string | unknown[];
  isError?: boolean;
}) {
  const server = await startQaMockOpenAiServer({ host: "127.0.0.1", port: 0 });
  const callId = "toolu_progress";
  const args =
    params.tool === "exec"
      ? { command: "true" }
      : { path: params.prompt === ERROR_PROMPT ? "denied.txt" : "empty.txt" };
  const body =
    params.route === "responses"
      ? {
          input: [
            { role: "user", content: [{ type: "input_text", text: params.prompt }] },
            {
              type: "function_call",
              name: params.tool,
              call_id: callId,
              arguments: JSON.stringify(args),
            },
            { type: "function_call_output", call_id: callId, output: params.output },
          ],
        }
      : {
          messages: [
            { role: "user", content: params.prompt },
            {
              role: "assistant",
              content: [{ type: "tool_use", name: params.tool, id: callId, input: args }],
            },
            {
              role: "user",
              content: [
                {
                  type: "tool_result",
                  tool_use_id: callId,
                  content: params.output,
                  is_error: params.isError,
                },
              ],
            },
          ],
        };
  try {
    const response = await fetch(`${server.baseUrl}/v1/${params.route}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "qa-model", stream: false, max_tokens: 256, ...body }),
    });
    expect(response.status).toBe(200);
    return await response.json();
  } finally {
    await server.stop();
  }
}

describe.each(["responses", "messages"])("%s tool progress", (route) => {
  it.each([
    { tool: "read", prompt: READ_PROMPT, output: "" },
    { tool: "exec", prompt: EXEC_PROMPT, output: [] },
  ])("finishes after an empty $tool result", async (fixture) => {
    const response = await completeProgress({ route, ...fixture });
    expect(response).toMatchObject(
      route === "responses"
        ? { output: [{ type: "message", content: [{ type: "output_text", text: "PROGRESS_OK" }] }] }
        : { stop_reason: "end_turn", content: [{ type: "text", text: "PROGRESS_OK" }] },
    );
  });
});

it.each([
  { label: "typed failure", output: "Access denied", isError: true, expected: "PROGRESS_OK" },
  { label: "empty typed failure", output: [], isError: true, expected: "PROGRESS_OK" },
  {
    label: "explicit success with error-shaped content",
    output: '{"error":"Access denied"}',
    isError: false,
    expected: "BUG-TOOL-DID-NOT-FAIL",
  },
  {
    label: "untyped error-shaped content",
    output: '{"error":"Access denied"}',
    isError: undefined,
    expected: "PROGRESS_OK",
  },
  {
    label: "untyped content without failure evidence",
    output: "Access denied",
    isError: undefined,
    expected: "BUG-TOOL-DID-NOT-FAIL",
  },
])("uses $label for error-progress completion", async ({ expected, ...fixture }) => {
  const response = await completeProgress({
    route: "messages",
    prompt: ERROR_PROMPT,
    tool: "read",
    ...fixture,
  });
  expect(response).toMatchObject({
    stop_reason: "end_turn",
    content: [{ type: "text", text: expected }],
  });
});

it("distinguishes a successful CodeMode runner from its failed read", async () => {
  const server = await startQaMockOpenAiServer({ host: "127.0.0.1", port: 0 });
  const tools = [
    {
      name: "exec",
      input_schema: {
        type: "object",
        properties: { code: { type: "string" } },
        required: ["code"],
      },
    },
    { name: "wait", input_schema: { type: "object", properties: {} } },
  ];
  const request = async (messages: unknown[]) => {
    const response = await fetch(`${server.baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "qa-model", max_tokens: 256, tools, messages }),
    });
    expect(response.status).toBe(200);
    return response.json();
  };
  try {
    const input = [{ role: "user", content: ERROR_PROMPT }];
    const plan = await request(input);
    expect(plan.content).toMatchObject([{ type: "tool_use", name: "exec" }]);
    const result = await request([
      ...input,
      { role: "assistant", content: plan.content },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: plan.content[0].id,
            is_error: false,
            content: JSON.stringify({
              status: "completed",
              value: { status: "error", error: "Access denied" },
            }),
          },
        ],
      },
    ]);
    expect(result).toMatchObject({
      stop_reason: "end_turn",
      content: [{ type: "text", text: "PROGRESS_OK" }],
    });
  } finally {
    await server.stop();
  }
});
