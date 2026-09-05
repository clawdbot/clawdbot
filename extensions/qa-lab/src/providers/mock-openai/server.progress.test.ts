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
const INPUT_WAIT_OUTPUT =
  "Process exited with code 7.\n\nNo new output for 16s; this session may be waiting for input. Use process write, send-keys, submit, or paste to provide input.";
const TIMED_OUT_OUTPUT =
  "\n\nProcess exited with code 0.\n\nThe command was terminated, but external side effects may already have completed. Verify the resulting state before retrying. Do not automatically rerun non-idempotent commands. Use a higher timeout only when the command is known to be safe to retry.";

const APPROVAL_OUTPUT =
  "Approval required (id abc123, full abc12345).\nHost: gateway\nCWD: /workspace\nCommand:\n```sh\ntrue\n```\nMode: foreground (interactive approvals available).\nBackground mode requires pre-approved policy (allow-always or ask=off).\nReply with: /approve abc123 allow-once|allow-always|deny\nIf the short code is ambiguous, use the full id in /approve.";
const APPROVAL_RESTRICTED_OUTPUT = APPROVAL_OUTPUT.replace(
  "Background mode requires pre-approved policy (allow-always or ask=off).",
  "Background mode requires an effective policy that allows pre-approval (for example ask=off).",
).replace(
  "allow-once|allow-always|deny\n",
  "allow-once|deny\nAllow Always is unavailable for this command.\n",
);
const APPROVAL_UNAVAILABLE_OUTPUT =
  "Exec approval is required, but no interactive approval client is currently available.\n\nApprove it from the Web UI or terminal UI. Print the Control UI URL with `openclaw dashboard --no-open`, open it in a browser, then use the approval inbox. Then retry the command. You can usually leave execApprovals.approvers unset when owner config already identifies the approvers.";
const UNKNOWN_OUTPUT =
  "Node command outcome is unknown for node-1.\nThe command may have executed. Do not rerun it automatically.\n\nCommand:\ntrue\n\nDetails: node disconnected";

type ProgressResult = {
  tool: string;
  args: Record<string, unknown>;
  output: string | unknown[];
  isError?: boolean;
  callId?: string | null;
};

async function requestProgress(
  route: string,
  prompt: string,
  results: ProgressResult[],
  context?: string,
) {
  const server = await startQaMockOpenAiServer({ host: "127.0.0.1", port: 0 });
  const toolResults = results.map((result, index) => ({
    ...result,
    callId: result.callId === null ? undefined : (result.callId ?? `progress_${index}`),
  }));
  const input = [prompt, ...(context ? [context] : [])].map((text) => ({
    role: "user",
    content: route === "responses" ? [{ type: "input_text", text }] : text,
  }));
  const body =
    route === "responses"
      ? {
          input: [
            ...input,
            ...toolResults.flatMap((result) => [
              {
                type: "function_call",
                name: result.tool,
                call_id: result.callId,
                arguments: JSON.stringify(result.args),
              },
              {
                type: "function_call_output",
                call_id: result.callId,
                output: result.output,
                is_error: result.isError,
              },
            ]),
          ],
        }
      : {
          messages: [
            ...input,
            ...toolResults.flatMap((result) => [
              {
                role: "assistant",
                content: [
                  {
                    type: "tool_use",
                    name: result.tool,
                    id: result.callId,
                    input: result.args,
                  },
                ],
              },
              {
                role: "user",
                content: [
                  {
                    type: "tool_result",
                    tool_use_id: result.callId,
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
    { label: "warning-prefixed text", output: `Task warning\n\n${RUNNING_OUTPUT}` },
    { label: "unavailable PID", output: RUNNING_OUTPUT.replace("pid 3128", "pid n/a") },
    { label: "text blocks", output: [{ type: "text", text: RUNNING_OUTPUT }] },
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
      output: INPUT_WAIT_OUTPUT,
    });
    expectPoll(await requestProgress(route, EXEC_PROMPT, results));
    results.push({
      tool: "process",
      args: { action: "poll", sessionId },
      output: `${TIMED_OUT_OUTPUT}\n${RUNNING_OUTPUT.replace("lucky-slug", "other-session")}\n\nProcess exited with code 0.`,
    });
    expect(await requestProgress(route, EXEC_PROMPT, results)).toMatchObject(
      route === "responses"
        ? { output: [{ type: "message", content: [{ text: "PROGRESS_OK" }] }] }
        : { content: [{ type: "text", text: "PROGRESS_OK" }] },
    );
  });

  it.each([
    {
      label: "timeout after zero exit",
      args: { action: "poll", sessionId: "lucky-slug" },
      output: TIMED_OUT_OUTPUT,
      marker: "BUG-TOOL-FAILED",
    },
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
      label: "single-newline exit-like stdout",
      args: { action: "poll", sessionId: "lucky-slug" },
      output: "ordinary output\nProcess exited with code 0.",
      marker: "BUG-TOOL-DID-NOT-COMPLETE",
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

  it.each([
    { label: "untyped nonzero exit", output: "\n\nProcess exited with code 1." },
    { label: "typed nonzero exit", output: "\n\nProcess exited with code 1.", isError: true },
    {
      label: "typed unknown exit",
      output: "\n\nProcess exited with unknown exit code.",
      isError: true,
    },
  ])("allows terminal command failure for $label", async ({ output, isError }) => {
    const response = await requestProgress(
      route,
      EXEC_PROMPT.replace("command completes,", "command completes or fails,"),
      [
        { tool: "exec", args: { command: "true" }, output: RUNNING_OUTPUT },
        {
          tool: "process",
          args: { action: "poll", sessionId: "lucky-slug" },
          output,
          isError,
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
    { output: "Command aborted by signal SIGTERM", isError: true },
    { output: `${RUNNING_OUTPUT}\n\n(Command exited with code 7)`, isError: false },
    { output: "Node: node-1\n(Command exited with code 7)", isError: false },
  ])("reports foreground failure from $output", async ({ output, isError }) => {
    for (const allowsFailure of [false, true]) {
      const prompt = allowsFailure
        ? EXEC_PROMPT.replace("command completes,", "command completes or fails,")
        : EXEC_PROMPT;
      const response = await requestProgress(route, prompt, [
        {
          tool: "exec",
          args: { command: "true" },
          output,
          isError,
        },
      ]);
      const marker = allowsFailure ? "PROGRESS_OK" : "BUG-TOOL-FAILED";
      expect(response).toMatchObject(
        route === "responses"
          ? { output: [{ content: [{ text: marker }] }] }
          : { content: [{ text: marker }] },
      );
    }
  });

  it.each([
    {
      label: "typed error with a running exec handle",
      results: [{ tool: "exec", args: { command: "true" }, output: RUNNING_OUTPUT, isError: true }],
      marker: "BUG-TOOL-DID-NOT-COMPLETE",
    },
    {
      label: "typed error with an unknown outcome",
      results: [
        {
          tool: "exec",
          args: { command: "true" },
          output: `Task warning\n\n${UNKNOWN_OUTPUT}\n(Command exited with code 0)`,
          isError: true,
        },
      ],
      marker: "BUG-TOOL-DID-NOT-COMPLETE",
    },
    {
      label: "approval pending",
      results: [
        {
          tool: "exec",
          args: { command: "true" },
          output: `Task warning\n\n${APPROVAL_OUTPUT}`,
          isError: false,
        },
      ],
      marker: "BUG-TOOL-DID-NOT-COMPLETE",
    },
    ...[
      { label: "restricted approval decisions", output: APPROVAL_RESTRICTED_OUTPUT },
      {
        label: "foreign approval warning before actual pending notice",
        output: `${APPROVAL_OUTPUT.replace("\ntrue\n", "\nother command\n")}\n\n${APPROVAL_OUTPUT}`,
      },
      {
        label: "foreign unknown warning before actual unknown notice",
        output: `${UNKNOWN_OUTPUT.replace("\ntrue\n", "\nother command\n")}\n\n${UNKNOWN_OUTPUT}`,
      },
    ].map(({ label, output }) => ({
      label,
      results: [{ tool: "exec", args: { command: "true" }, output, isError: false }],
      marker: "BUG-TOOL-DID-NOT-COMPLETE",
    })),
    ...[null, ""].map((callId) => ({
      label: callId === null ? "missing call IDs" : "empty call IDs",
      results: [
        { tool: "exec", args: { command: "true" }, output: RUNNING_OUTPUT, callId },
        {
          tool: "process",
          args: { action: "poll", sessionId: "lucky-slug" },
          output: "\n\nProcess exited with code 0.",
          callId,
        },
      ],
      marker: "BUG-TOOL-PROGRESS-CALL-MISMATCH",
    })),
    {
      label: "foreign poll before exec",
      results: [
        {
          tool: "process",
          args: { action: "poll", sessionId: "foreign-session" },
          output: "\n\nProcess exited with code 0.",
        },
        { tool: "exec", args: { command: "true" }, output: "" },
      ],
      marker: "BUG-TOOL-PROGRESS-CALL-MISMATCH",
    },
    {
      label: "approval pending in approver DMs",
      results: [
        {
          tool: "exec",
          args: { command: "true" },
          output: "Approval required. I sent approval DMs to the approvers for this account.",
          isError: true,
        },
      ],
      marker: "BUG-TOOL-DID-NOT-COMPLETE",
    },
    {
      label: "approval unavailable",
      results: [
        {
          tool: "exec",
          args: { command: "true" },
          output: `Task warning\n\n${APPROVAL_UNAVAILABLE_OUTPUT}`,
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
          output: "No session found for lucky-slug",
          isError: true,
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
  args: Record<string, unknown>;
  output: string | unknown[];
  isError?: boolean;
  context?: string;
}) {
  const plan = await requestProgress(params.route, params.prompt, [], params.context);
  const call = params.route === "responses" ? plan.output[0] : plan.content[0];
  expect(call).toMatchObject(
    params.route === "responses"
      ? { type: "function_call", name: params.tool, arguments: JSON.stringify(params.args) }
      : { type: "tool_use", name: params.tool, input: params.args },
  );
  return requestProgress(
    params.route,
    params.prompt,
    [
      {
        tool: params.tool,
        args: params.args,
        output: params.output,
        isError: params.isError,
        callId: params.route === "responses" ? call.call_id : call.id,
      },
    ],
    params.context,
  );
}

describe.each(["responses", "messages"])("%s tool progress", (route) => {
  const target = "repo/資料🙂/missing.txt";
  const prompt = [
    "Conversation info:",
    "```json",
    '{"sender":{"id":"fixture-user"}}',
    "```",
    "",
    `Tool progress error QA check: read "${target}" before answering. After the read fails, reply exactly \`PROGRESS_OK\`.`,
  ].join("\n");
  const carrier = [
    "<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>",
    "Runtime: synthetic metadata.",
    "<<<END_OPENCLAW_INTERNAL_CONTEXT>>>",
  ].join("\n");
  it.each([
    {
      label: "fenced read with runtime context",
      tool: "read",
      prompt,
      args: { path: target },
      context: carrier,
      output: JSON.stringify({ status: "error", tool: "read", error: `File not found: ${target}` }),
      isError: true,
    },
    ...[
      { status: "failed" },
      { status: "running", sessionId: "other-session" },
      { status: "approval-pending" },
    ].flatMap((details) =>
      [details, { details }].map((value, index) => ({
        label: `${index === 0 ? "bare" : "nested"} JSON stdout with ${details.status}`,
        tool: "exec",
        prompt: EXEC_PROMPT,
        output: JSON.stringify(value),
      })),
    ),
    {
      label: "JSON stdout containing an exec running header",
      tool: "exec",
      prompt: EXEC_PROMPT,
      output: JSON.stringify({ text: RUNNING_OUTPUT }),
    },
    ...[
      "Command still running (session lucky-slug, pid 3128)",
      `${RUNNING_OUTPUT}\nlater stdout`,
    ].map((output) => ({
      label: `exec stdout containing a partial running notice: ${output}`,
      tool: "exec",
      prompt: EXEC_PROMPT,
      output,
    })),
    ...[
      ...[
        RUNNING_OUTPUT,
        APPROVAL_OUTPUT,
        "Approval required. I sent approval DMs to the approvers for this account.",
        APPROVAL_UNAVAILABLE_OUTPUT,
        UNKNOWN_OUTPUT,
        "(Command exited with code 7)",
      ].map((notice) => `log entry\n${notice}`),
      APPROVAL_OUTPUT.replace("Reply with: /approve abc123 ", "Reply with: /approve other "),
      APPROVAL_RESTRICTED_OUTPUT.replace("Allow Always is unavailable for this command.\n", ""),
      APPROVAL_OUTPUT.replace(
        "If the short code is ambiguous,",
        "Allow Always is unavailable for this command.\nIf the short code is ambiguous,",
      ),
      APPROVAL_OUTPUT.replaceAll("```", "````"),
      APPROVAL_UNAVAILABLE_OUTPUT.replace(
        "Print the Control UI URL with `openclaw dashboard --no-open`, open it in a browser, then use the approval inbox. ",
        "",
      ),
      "Approval required.\nordinary output",
      "Approval required (id demo, full demo).\nfinished",
      APPROVAL_OUTPUT.replace("\ntrue\n", "\nother command\n"),
      APPROVAL_OUTPUT.replace("\ntrue\n", "\n\n"),
      "Exec approval is required, but no interactive approval client is currently available.\nordinary output",
      UNKNOWN_OUTPUT.slice(0, UNKNOWN_OUTPUT.indexOf("\n\nCommand:")),
      UNKNOWN_OUTPUT.replace("\ntrue\n", "\nother command\n"),
      UNKNOWN_OUTPUT.slice(0, UNKNOWN_OUTPUT.indexOf("\n\nDetails:")),
    ].map((output) => ({
      label: `exec stdout containing an incomplete or foreign notice: ${output}`,
      tool: "exec",
      prompt: EXEC_PROMPT,
      output,
      isError: false,
    })),
    { label: "an empty read result", tool: "read", prompt: READ_PROMPT, output: "" },
    { label: "an empty exec result", tool: "exec", prompt: EXEC_PROMPT, output: [] },
    {
      label: "exec stdout matching a poll hint",
      tool: "exec",
      prompt: EXEC_PROMPT,
      output: INPUT_WAIT_OUTPUT,
    },
    {
      label: "exec stdout matching a poll exit footer",
      tool: "exec",
      prompt: EXEC_PROMPT,
      output: "Process exited with code 7.",
    },
  ])("finishes after $label", async (fixture) => {
    const response = await completeProgress({
      route,
      args: fixture.tool === "exec" ? { command: "true" } : { path: "empty.txt" },
      ...fixture,
    });
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
    args: { path: "denied.txt" },
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
