import { describe, expect, it } from "vitest";
import { startQaMockOpenAiServer } from "./server.js";

const READ_PROMPT =
  "Tool progress QA check: read `empty.txt` before answering. After the read completes, reply exactly `PROGRESS_OK`.";
const EXEC_PROMPT =
  "Tool progress QA check: call the exec tool exactly once with this exact command before answering: `true`. After that command completes, reply exactly `PROGRESS_OK`.";
const ERROR_PROMPT =
  "Tool progress error QA check: read `denied.txt` before answering. After the read fails, reply exactly `PROGRESS_OK`.";
const RUNNING_OUTPUT =
  "Command still running (session lucky-slug, pid 3128). Use process (list/poll/log/write/send-keys/submit/paste/kill/clear/remove) for follow-up.";

type ProgressResult = {
  tool: string;
  args: Record<string, unknown>;
  output: string | unknown[];
  isError?: boolean;
};

async function requestProgress(route: string, prompt: string, results: ProgressResult[]) {
  const server = await startQaMockOpenAiServer({ host: "127.0.0.1", port: 0 });
  const body =
    route === "responses"
      ? {
          input: [
            { role: "user", content: [{ type: "input_text", text: prompt }] },
            ...results.flatMap((result, index) => [
              {
                type: "function_call",
                name: result.tool,
                call_id: `progress_${index}`,
                arguments: JSON.stringify(result.args),
              },
              {
                type: "function_call_output",
                call_id: `progress_${index}`,
                output: result.output,
                is_error: result.isError,
              },
            ]),
          ],
        }
      : {
          messages: [
            { role: "user", content: prompt },
            ...results.flatMap((result, index) => [
              {
                role: "assistant",
                content: [
                  {
                    type: "tool_use",
                    name: result.tool,
                    id: `progress_${index}`,
                    input: result.args,
                  },
                ],
              },
              {
                role: "user",
                content: [
                  {
                    type: "tool_result",
                    tool_use_id: `progress_${index}`,
                    content: result.output,
                    is_error: result.isError,
                  },
                ],
              },
            ]),
          ],
        };
  try {
    const response = await fetch(`${server.baseUrl}/v1/${route}`, {
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

describe.each(["responses", "messages"])("%s background command progress", (route) => {
  it.each([
    { label: "plain text", output: RUNNING_OUTPUT },
    { label: "unavailable PID", output: RUNNING_OUTPUT.replace("pid 3128", "pid n/a") },
    { label: "text blocks", output: [{ type: "text", text: RUNNING_OUTPUT }] },
    {
      label: "structured details",
      output: JSON.stringify({ details: { status: "running", sessionId: "lucky-slug" } }),
    },
  ])("polls $label until terminal before emitting the marker", async ({ output }) => {
    const sessionId = "lucky-slug";
    const results: ProgressResult[] = [
      {
        tool: "exec",
        args: { command: "true" },
        output,
      },
    ];
    const expectPoll = (response: {
      output?: Record<string, unknown>[];
      content?: Record<string, unknown>[];
    }) => {
      const content = (route === "responses" ? response.output : response.content)!;
      expect(content).toMatchObject([{ name: "process" }]);
      const args =
        route === "responses" ? JSON.parse(String(content[0]?.arguments)) : content[0]?.input;
      expect(args).toMatchObject({ action: "poll", sessionId });
    };
    expectPoll(await requestProgress(route, EXEC_PROMPT, results));
    results.push({
      tool: "process",
      args: { action: "poll", sessionId },
      output: "Process exited with code 7.\n\nProcess still running.",
    });
    expectPoll(await requestProgress(route, EXEC_PROMPT, results));
    results.push({
      tool: "process",
      args: { action: "poll", sessionId },
      output: "done\n\nProcess exited with code 0.",
    });
    expect(await requestProgress(route, EXEC_PROMPT, results)).toMatchObject(
      route === "responses"
        ? { output: [{ type: "message", content: [{ text: "PROGRESS_OK" }] }] }
        : { content: [{ type: "text", text: "PROGRESS_OK" }] },
    );
  });

  it.each([
    {
      label: "failed process",
      args: { action: "poll", sessionId: "lucky-slug" },
      output: "\n\nProcess exited with code 7.",
      marker: "BUG-TOOL-FAILED",
    },
    {
      label: "killed process",
      args: { action: "poll", sessionId: "lucky-slug" },
      output: "\n\nProcess exited with signal SIGTERM.",
      marker: "BUG-TOOL-FAILED",
    },
    {
      label: "unsettled process",
      args: { action: "poll", sessionId: "lucky-slug" },
      output: "partial output",
      marker: "BUG-TOOL-DID-NOT-COMPLETE",
    },
    {
      label: "unrelated poll",
      args: { action: "poll", sessionId: "other-session" },
      output: "\n\nProcess exited with code 0.",
      marker: "BUG-TOOL-PROGRESS-CALL-MISMATCH",
    },
    {
      label: "unrelated terminal result",
      args: { action: "poll", sessionId: "lucky-slug" },
      output: JSON.stringify({
        details: { status: "completed", sessionId: "other-session", exitCode: 0 },
      }),
      marker: "BUG-TOOL-PROGRESS-CALL-MISMATCH",
    },
  ])("does not report success for $label", async ({ args, output, marker }) => {
    const response = await requestProgress(route, EXEC_PROMPT, [
      { tool: "exec", args: { command: "true" }, output: RUNNING_OUTPUT },
      { tool: "process", args, output },
    ]);
    expect(response).toMatchObject(
      route === "responses"
        ? { output: [{ content: [{ text: marker }] }] }
        : { content: [{ text: marker }] },
    );
  });

  it("preserves prompts that explicitly allow terminal command failure", async () => {
    const response = await requestProgress(
      route,
      EXEC_PROMPT.replace("command completes,", "command completes or fails,"),
      [
        { tool: "exec", args: { command: "true" }, output: RUNNING_OUTPUT },
        {
          tool: "process",
          args: { action: "poll", sessionId: "lucky-slug" },
          output: "\n\nProcess exited with code 1.",
        },
      ],
    );
    expect(response).toMatchObject(
      route === "responses"
        ? { output: [{ content: [{ text: "PROGRESS_OK" }] }] }
        : { content: [{ text: "PROGRESS_OK" }] },
    );
  });

  it.each([
    {
      label: "approval pending",
      results: [
        {
          tool: "exec",
          args: { command: "true" },
          output: JSON.stringify({ details: { status: "approval-pending" } }),
        },
      ],
      marker: "BUG-TOOL-DID-NOT-COMPLETE",
    },
    {
      label: "poll error",
      results: [
        { tool: "exec", args: { command: "true" }, output: RUNNING_OUTPUT },
        {
          tool: "process",
          args: { action: "poll", sessionId: "lucky-slug" },
          output: "transport failed",
          isError: true,
        },
      ],
      marker: "BUG-TOOL-DID-NOT-COMPLETE",
    },
    {
      label: "lost poll session",
      results: [
        { tool: "exec", args: { command: "true" }, output: RUNNING_OUTPUT },
        {
          tool: "process",
          args: { action: "poll", sessionId: "lucky-slug" },
          output: JSON.stringify({ details: { status: "failed" } }),
        },
      ],
      marker: "BUG-TOOL-DID-NOT-COMPLETE",
    },
    {
      label: "intermediate foreign poll",
      results: [
        { tool: "exec", args: { command: "true" }, output: RUNNING_OUTPUT },
        {
          tool: "process",
          args: { action: "poll", sessionId: "foreign-session" },
          output: "\n\nProcess still running.",
        },
        {
          tool: "process",
          args: { action: "poll", sessionId: "lucky-slug" },
          output: "\n\nProcess exited with code 0.",
        },
      ],
      marker: "BUG-TOOL-PROGRESS-CALL-MISMATCH",
    },
  ])("does not accept $label even when command failure is allowed", async ({ results, marker }) => {
    const response = await requestProgress(
      route,
      EXEC_PROMPT.replace("command completes,", "command completes or fails,"),
      results,
    );
    expect(response).toMatchObject(
      route === "responses"
        ? { output: [{ content: [{ text: marker }] }] }
        : { content: [{ text: marker }] },
    );
  });
});

it("keeps Slack commentary progress open while its exec is running", async () => {
  const command = "grep 'SLACK-QA-TOOL-A1B2C3D4' /dev/null || sleep 5";
  const prompt = `SLACK-QA-COMMENTARY-A1B2C3D4 ${command} SLACK-QA-COMMENTARY-DONE-A1B2C3D4`;
  const results: ProgressResult[] = [{ tool: "exec", args: { command }, output: RUNNING_OUTPUT }];
  expect(await requestProgress("responses", prompt, results)).toMatchObject({
    output: [
      {
        name: "process",
        arguments: JSON.stringify({ action: "poll", sessionId: "lucky-slug", timeout: 30_000 }),
      },
    ],
  });
  results.push({
    tool: "process",
    args: { action: "poll", sessionId: "lucky-slug" },
    output: "\n\nProcess exited with code 0.",
  });
  expect(await requestProgress("responses", prompt, results)).toMatchObject({
    output: [
      {
        type: "message",
        phase: "final_answer",
        content: [{ text: "SLACK-QA-COMMENTARY-DONE-A1B2C3D4" }],
      },
    ],
  });
});

async function completeProgress(params: {
  route: string;
  prompt: string;
  tool: string;
  output: string | unknown[];
  isError?: boolean;
}) {
  return requestProgress(params.route, params.prompt, [
    {
      tool: params.tool,
      args:
        params.tool === "exec"
          ? { command: "true" }
          : { path: params.prompt === ERROR_PROMPT ? "denied.txt" : "empty.txt" },
      output: params.output,
      isError: params.isError,
    },
  ]);
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
