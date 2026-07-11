// Qa Lab tests cover server plugin behavior.
import { afterEach, describe, expect, it } from "vitest";
import { resolveProviderVariant, startQaMockOpenAiServer } from "./server.js";

const cleanups: Array<() => Promise<void>> = [];
const QA_IMAGE_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAT0lEQVR42u3RQQkAMAzAwPg33Wnos+wgBo40dboAAAAAAAAAAAAAAAAAAAAAAAAAAAAAANYADwAAAAAAAAAAAAAAAAAAAAAAAAAAAAC+Azy47PDiI4pA2wAAAABJRU5ErkJggg==";
const QA_REASONING_ONLY_RECOVERY_PROMPT =
  "Reasoning-only continuation QA check: read QA_KICKOFF_TASK.md, then answer with exactly REASONING-RECOVERED-OK.";
const QA_REASONING_ONLY_SIDE_EFFECT_PROMPT =
  "Reasoning-only after write safety check: write reasoning-only-side-effect.txt, then answer with exactly SIDE-EFFECT-GUARD-OK.";
const QA_THINKING_VISIBILITY_OFF_PROMPT =
  "QA thinking visibility check off: answer exactly THINKING-OFF-OK.";
const QA_THINKING_VISIBILITY_MAX_PROMPT =
  "QA thinking visibility check max: verify 17+24=41 internally, then answer exactly THINKING-MAX-OK.";
const QA_EMPTY_RESPONSE_RECOVERY_PROMPT =
  "Empty response continuation QA check: read QA_KICKOFF_TASK.md, then answer with exactly EMPTY-RECOVERED-OK.";
const QA_EMPTY_RESPONSE_EXHAUSTION_PROMPT =
  "Empty response exhaustion QA check: read QA_KICKOFF_TASK.md, then answer with exactly EMPTY-EXHAUSTED-OK.";
const QA_REASONING_ONLY_RETRY_INSTRUCTION =
  "The previous assistant turn recorded reasoning but did not produce a user-visible answer. Continue from that partial turn and produce the visible answer now. Do not restate the reasoning or restart from scratch.";
const QA_EMPTY_RESPONSE_RETRY_INSTRUCTION =
  "The previous attempt did not produce a user-visible answer. Continue from the current state and produce the visible answer now. Do not restart from scratch.";

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()?.();
  }
});

async function startMockServer(params?: { finalOnlyMarkerPauseMs?: number }) {
  const server = await startQaMockOpenAiServer({
    host: "127.0.0.1",
    port: 0,
    ...params,
  });
  cleanups.push(async () => {
    await server.stop();
  });
  return server;
}

async function postResponses(server: { baseUrl: string }, body: unknown) {
  return fetch(`${server.baseUrl}/v1/responses`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

async function expectResponsesText(server: { baseUrl: string }, body: unknown) {
  const response = await postResponses(server, body);
  expect(response.status).toBe(200);
  return response.text();
}

async function expectResponsesJson<T>(server: { baseUrl: string }, body: unknown) {
  const response = await postResponses(server, body);
  expect(response.status).toBe(200);
  return (await response.json()) as T;
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Expected ${label}`);
  }
  return value as Record<string, unknown>;
}

function requireArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`Expected ${label}`);
  }
  return value;
}

function outputItem(payload: unknown, index = 0) {
  const output = requireArray(requireRecord(payload, "response payload").output, "response output");
  return requireRecord(output[index], `response output ${index}`);
}

function outputItems(payload: unknown) {
  return requireArray(requireRecord(payload, "response payload").output, "response output").map(
    (item, index) => requireRecord(item, `response output ${index}`),
  );
}

function outputToolArgs(payload: unknown, index = 0) {
  const item = outputItem(payload, index);
  return outputToolArgsFromItem(item);
}

function outputToolArgsFromItem(item: Record<string, unknown>) {
  if (typeof item.arguments !== "string") {
    throw new Error("Expected response output arguments");
  }
  return requireRecord(JSON.parse(item.arguments) as unknown, "response output arguments");
}

function outputToolCall(payload: unknown, name: string) {
  const toolCall = outputItems(payload).find(
    (item) => item.type === "function_call" && item.name === name,
  );
  if (!toolCall) {
    throw new Error(`Expected ${name} tool call`);
  }
  return toolCall;
}

function outputToolCallId(item: Record<string, unknown>, fallback: string) {
  return typeof item.call_id === "string" ? item.call_id : fallback;
}

function outputContentItem(payload: unknown, outputIndex = 0, contentIndex = 0) {
  const content = requireArray(outputItem(payload, outputIndex).content, "response output content");
  return requireRecord(content[contentIndex], `response content ${contentIndex}`);
}

function outputText(payload: unknown, outputIndex = 0, contentIndex = 0) {
  const text = outputContentItem(payload, outputIndex, contentIndex).text;
  if (typeof text !== "string") {
    throw new Error("Expected response output text");
  }
  return text;
}

function makeUserInput(text: string) {
  return {
    role: "user" as const,
    content: [{ type: "input_text" as const, text }],
  };
}

const TEST_RUNTIME_CONTEXT_CARRIER = [
  "OpenClaw runtime context for the immediately preceding user message.",
  "This context is runtime-generated, not user-authored. Keep internal details private.",
  "",
  "<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>",
  "runtime metadata",
  "<<<END_OPENCLAW_INTERNAL_CONTEXT>>>",
].join("\n");

function makeDeveloperInput(text: string) {
  return {
    role: "developer" as const,
    content: [{ type: "input_text" as const, text }],
  };
}

function buildWhatsAppPendingHistoryContextFixture(
  history: Array<{ body: string; sender: string; timestamp: number }>,
) {
  return [
    "Chat history since last reply (untrusted, for context):",
    ...history.map((entry, index) => `#history-${index + 1} ${entry.sender}: ${entry.body}`),
  ].join("\n");
}

const SESSIONS_SPAWN_TOOL = { type: "function", name: "sessions_spawn" } as const;
const SESSIONS_YIELD_TOOL = { type: "function", name: "sessions_yield" } as const;
const READ_TOOL = { type: "function", name: "read" } as const;
const MESSAGE_TOOL = { type: "function", name: "message" } as const;
const SLACK_CHART_SUMMARY_TOKEN = "SLACK_QA_CHART_SUMMARY_TEST";
const SLACK_CHART_DONE_TOKEN = "SLACK_QA_CHART_DONE_TEST";
const SLACK_CHART_MESSAGE_TOOL_ARGS = {
  action: "send",
  message: SLACK_CHART_SUMMARY_TOKEN,
  presentation: {
    blocks: [
      {
        type: "chart",
        chartType: "line",
        title: "QA latency trend",
        categories: ["P50", "P95"],
        series: [{ name: "Latency", values: [120, 240] }],
        xLabel: "Percentile",
        yLabel: "Milliseconds",
      },
    ],
  },
};
const SLACK_CHART_PROMPT = [
  `Slack native chart QA check ${SLACK_CHART_SUMMARY_TOKEN}.`,
  `Call the message tool exactly once with these exact arguments: ${JSON.stringify(SLACK_CHART_MESSAGE_TOOL_ARGS)}.`,
  `After the chart send succeeds, reply with only this exact marker: ${SLACK_CHART_DONE_TOKEN}`,
].join(" ");
const WHATSAPP_AGENT_REACT_PROMPT =
  "React to this WhatsApp message with thumbs up for QA action check WHATSAPP_QA_AGENT_REACT_TEST.";
const WHATSAPP_GROUP_AGENT_REACT_PROMPT =
  "openclawqa react to this WhatsApp group message with thumbs up for QA action check WHATSAPP_QA_GROUP_AGENT_REACT_TEST.";
const WHATSAPP_AGENT_UPLOAD_TOKEN = "WHATSAPP_QA_AGENT_UPLOAD_TEST";
const WHATSAPP_GROUP_AGENT_UPLOAD_TOKEN = "WHATSAPP_QA_GROUP_AGENT_UPLOAD_TEST";
const WHATSAPP_AGENT_UPLOAD_PROMPT =
  `Use the WhatsApp message tool upload-file action to send a PNG with caption ${WHATSAPP_AGENT_UPLOAD_TOKEN}. ` +
  "Do not send any visible text reply after the upload.";
const WHATSAPP_GROUP_AGENT_UPLOAD_PROMPT =
  `openclawqa use the WhatsApp message tool upload-file action to send a PNG with caption ${WHATSAPP_GROUP_AGENT_UPLOAD_TOKEN}. ` +
  "Do not send any visible text reply after the upload.";
const WHATSAPP_PENDING_HISTORY_QUIET_MARKER = "WHATSAPP_QA_PENDING_HISTORY_QUIET_TEST";
const WHATSAPP_PENDING_HISTORY_CONTEXT_SENTINEL = "WHATSAPP_QA_PENDING_HISTORY_CONTEXT_ONLY_TEST";
const WHATSAPP_PENDING_HISTORY_TRIGGER_MARKER = "WHATSAPP_QA_PENDING_HISTORY_TRIGGER_TEST";
const WHATSAPP_PENDING_HISTORY_OK_MARKER = "WHATSAPP_QA_PENDING_HISTORY_OK_TEST";
const WHATSAPP_PENDING_HISTORY_TRIGGER_PROMPT = [
  "openclawqa pending history context check",
  WHATSAPP_PENDING_HISTORY_TRIGGER_MARKER,
  `Return ${WHATSAPP_PENDING_HISTORY_OK_MARKER} only if prior group context contains ${WHATSAPP_PENDING_HISTORY_CONTEXT_SENTINEL}.`,
].join(" ");
const WHATSAPP_BROADCAST_TOKEN = "WHATSAPP_QA_BROADCAST_TOKEN_TEST";
const WHATSAPP_BROADCAST_PROMPT = `openclawqa broadcast fanout check ${WHATSAPP_BROADCAST_TOKEN}`;
const WHATSAPP_ACTIVATION_ALWAYS_MARKER = "WHATSAPP_QA_ACTIVATION_ALWAYS_TEST";
const WHATSAPP_ACTIVATION_ALWAYS_PROMPT = `Group activation visible behavior marker ${WHATSAPP_ACTIVATION_ALWAYS_MARKER}`;
const WHATSAPP_REPLY_TO_BOT_SEED_MARKER = "WHATSAPP_QA_REPLY_TO_BOT_SEED_TEST";
const WHATSAPP_REPLY_TO_BOT_SEED_PROMPT = `Mentioned group seed marker ${WHATSAPP_REPLY_TO_BOT_SEED_MARKER}`;
const WHATSAPP_REPLY_TO_BOT_TRIGGER_MARKER = "WHATSAPP_QA_REPLY_TO_BOT_TRIGGER_TEST";
const WHATSAPP_REPLY_TO_BOT_TRIGGER_PROMPT = `Quoted implicit reply trigger marker ${WHATSAPP_REPLY_TO_BOT_TRIGGER_MARKER}`;
const THREAD_SUBAGENT_CHILD_ERROR_TOKEN = "QA_SUBAGENT_CHILD_ERROR";
const THREAD_SUBAGENT_TOOL_ERROR =
  "thread=true requested but thread delivery is unavailable in this test harness.";

function threadSubagentTask(token: string) {
  return `Finish with exactly ${token}.`;
}

function explicitSessionsSpawnPrompt(token: string) {
  return [
    "Use sessions_spawn for this QA check.",
    `task="${threadSubagentTask(token)}"`,
    "label=qa-thread-subagent thread=true mode=session",
  ].join(" ");
}

describe("qa mock openai server", () => {
  it("retains enough debug requests for long shared QA runs", async () => {
    const server = await startMockServer();

    for (let index = 0; index < 250; index += 1) {
      await expectResponsesJson(server, {
        stream: false,
        model: "gpt-5.6-luna",
        input: [makeUserInput(`debug retention request ${index}`)],
      });
    }

    const requests = await fetch(`${server.baseUrl}/debug/requests`);
    expect(requests.status).toBe(200);
    const requestLog = requireArray(await requests.json(), "debug requests");
    expect(requestLog).toHaveLength(250);
    expect(String(requireRecord(requestLog[0], "debug request 0").allInputText)).toContain(
      "debug retention request 0",
    );
    expect(String(requireRecord(requestLog[249], "debug request 249").allInputText)).toContain(
      "debug retention request 249",
    );
  });

  it("serves health and streamed responses", async () => {
    const server = await startQaMockOpenAiServer({
      host: "127.0.0.1",
      port: 0,
    });
    cleanups.push(async () => {
      await server.stop();
    });

    const health = await fetch(`${server.baseUrl}/healthz`);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ ok: true, status: "live" });

    const response = await fetch(`${server.baseUrl}/v1/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        stream: true,
        input: [
          {
            role: "user",
            content: [{ type: "input_text", text: "Inspect the repo docs and kickoff task." }],
          },
        ],
      }),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const body = await response.text();
    expect(body).toContain('"type":"response.output_item.added"');
    expect(body).toContain('"name":"read"');
  });

  it("turns a short approval into a kickoff-task read", async () => {
    const server = await startMockServer();

    const preActionResponse = await fetch(`${server.baseUrl}/v1/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        stream: false,
        model: "gpt-5.6-luna",
        input: [
          makeUserInput(
            "Before acting, tell me the single file you would start with in six words or fewer. Do not use tools yet.",
          ),
        ],
      }),
    });
    expect(preActionResponse.status).toBe(200);
    const preActionPayload = await preActionResponse.json();
    expect(outputItem(preActionPayload).type).toBe("message");
    expect(outputText(preActionPayload)).toContain("Protocol note: acknowledged.");

    const approvalResponse = await fetch(`${server.baseUrl}/v1/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        stream: true,
        model: "gpt-5.6-luna",
        input: [
          makeUserInput(
            "Before acting, tell me the single file you would start with in six words or fewer. Do not use tools yet.",
          ),
          makeUserInput(
            "ok do it. read `QA_KICKOFF_TASK.md` now and reply with the QA mission in one short sentence.",
          ),
        ],
      }),
    });
    expect(approvalResponse.status).toBe(200);
    const approvalBody = await approvalResponse.text();
    expect(approvalBody).toContain('"name":"read"');
    expect(approvalBody).toContain('"arguments":"{\\"path\\":\\"QA_KICKOFF_TASK.md\\"}"');

    const debugResponse = await fetch(`${server.baseUrl}/debug/last-request`);
    expect(debugResponse.status).toBe(200);
    const debugPayload = requireRecord(await debugResponse.json(), "debug request");
    expect(debugPayload.model).toBe("gpt-5.6-luna");
    expect(debugPayload.prompt).toBe(
      "ok do it. read `QA_KICKOFF_TASK.md` now and reply with the QA mission in one short sentence.",
    );
    expect(String(debugPayload.allInputText)).toContain("ok do it.");
    expect(debugPayload.plannedToolName).toBe("read");
  });

  it("returns a substantive private final fixture for the message-tool warning scenario", async () => {
    const server = await startMockServer();

    const body = await expectResponsesJson<{
      output?: Array<{ content?: Array<{ text?: string }> }>;
    }>(server, {
      stream: false,
      model: "gpt-5.6-luna",
      input: [
        makeUserInput(
          "qa private final reply warning check. Reply to me directly in two complete sentences with `QA-STRANDED-85714` in the first sentence and a short explanation in the second sentence. Do NOT call any tool. Do NOT use the message tool.",
        ),
      ],
    });

    const text = body.output?.[0]?.content?.[0]?.text ?? "";
    expect(text).toContain("QA-STRANDED-85714");
    expect(text.length).toBeGreaterThanOrEqual(120);
    expect(text.match(/[.!?]+(?:\s|$)/g)).toHaveLength(2);
  });

  it("recovers the stranded-final fixture by calling the message tool on the retry prompt", async () => {
    const server = await startMockServer();

    const initialBody = await expectResponsesJson<{
      output?: Array<{ content?: Array<{ text?: string }> }>;
    }>(server, {
      stream: false,
      model: "gpt-5.6-luna",
      tools: [MESSAGE_TOOL],
      input: [
        makeUserInput(
          "qa stranded final recovery check. Include `QA-STRANDED-85714` in a thorough multi-sentence answer, but do not call any tool yet.",
        ),
      ],
    });

    const initialText = initialBody.output?.[0]?.content?.[0]?.text ?? "";
    expect(initialText).toContain("QA-STRANDED-85714");
    expect(initialText.length).toBeGreaterThanOrEqual(120);
    expect(outputItems(initialBody).some((item) => item.type === "function_call")).toBe(false);

    const retryBody = await expectResponsesJson(server, {
      stream: false,
      model: "gpt-5.6-luna",
      tools: [MESSAGE_TOOL],
      input: [
        makeUserInput(
          [
            "qa stranded final recovery check.",
            "Your previous reply was not delivered to the conversation because you did not call message(action=send).",
            initialText,
          ].join(" "),
        ),
      ],
    });

    const toolCall = outputToolCall(retryBody, "message");
    expect(outputToolArgsFromItem(toolCall)).toEqual({
      action: "send",
      message: "QA-STRANDED-85714",
    });
  });

  it("keeps the retry-failure stranded-final fixture as text without a message tool call", async () => {
    const server = await startMockServer();

    const body = await expectResponsesJson<{
      output?: Array<{ content?: Array<{ text?: string }> }>;
    }>(server, {
      stream: false,
      model: "gpt-5.6-luna",
      tools: [MESSAGE_TOOL],
      input: [
        makeUserInput(
          [
            "Your previous reply was not delivered to the conversation because you did not call message(action=send).",
            "Include `QA-STRANDED-RETRY-FAIL-RAW` in a thorough multi-sentence answer, but do not call any tool.",
          ].join(" "),
        ),
      ],
    });

    const text = body.output?.[0]?.content?.[0]?.text ?? "";
    expect(text).toContain("QA-STRANDED-RETRY-FAIL-RAW");
    expect(text.length).toBeGreaterThanOrEqual(120);
    expect(outputItems(body).some((item) => item.type === "function_call")).toBe(false);
  });

  it("keeps final-only marker preview deltas separate from the final answer", async () => {
    const server = await startMockServer({ finalOnlyMarkerPauseMs: 1 });
    const response = await fetch(`${server.baseUrl}/v1/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        stream: true,
        input: [
          makeUserInput(
            "Final-only marker streaming QA check. Reply exactly: QA-FINAL-ONLY-STREAMING-OK",
          ),
        ],
      }),
    });

    expect(response.status).toBe(200);
    const responseBody = await response.text();
    const deltaText = responseBody
      .split("\n")
      .filter((line) => line.startsWith("data: {"))
      .map((line) => JSON.parse(line.slice("data: ".length)) as { type?: string; delta?: string })
      .filter((event) => event.type === "response.output_text.delta")
      .map((event) => event.delta ?? "")
      .join("");
    expect(deltaText).toBe("QA streaming preview in progress");
    expect(deltaText).not.toContain("QA-FINAL-ONLY-STREAMING-OK");
    expect(responseBody).toContain('"text":"QA-FINAL-ONLY-STREAMING-OK"');
  });

  it("plans sessions_send for the A2A message-tool mirror proof scenario", async () => {
    const server = await startMockServer();
    const prompt =
      'qa a2a message-tool mirror check. sessionKey="agent:qa:a2a-target". exact marker: `QA-A2A-MIRROR-OK`';

    const toolPlan = await expectResponsesJson(server, {
      stream: false,
      model: "gpt-5.6-luna",
      tools: [{ type: "function", name: "sessions_send" }],
      input: [makeUserInput(prompt)],
    });

    const args = outputToolArgs(toolPlan);
    expect(outputItem(toolPlan).type).toBe("function_call");
    expect(outputItem(toolPlan).name).toBe("sessions_send");
    expect(args).toMatchObject({
      sessionKey: "agent:qa:a2a-target",
      timeoutSeconds: 0,
    });
    expect(String(args.message)).toContain("qa group visible reply tool check");
    expect(String(args.message)).toContain("QA-A2A-MIRROR-OK");

    const debugResponse = await fetch(`${server.baseUrl}/debug/last-request`);
    expect(debugResponse.status).toBe(200);
    const debugPayload = requireRecord(await debugResponse.json(), "debug request");
    expect(debugPayload.plannedToolName).toBe("sessions_send");
    expect(debugPayload.plannedToolArgs).toMatchObject({
      sessionKey: "agent:qa:a2a-target",
      timeoutSeconds: 0,
    });

    const final = await expectResponsesJson(server, {
      stream: false,
      model: "gpt-5.6-luna",
      tools: [{ type: "function", name: "sessions_send" }],
      input: [
        makeUserInput(prompt),
        {
          type: "function_call_output",
          call_id: "call_mock_sessions_send_fixture",
          output: JSON.stringify({ status: "accepted", delivery: { mode: "announce" } }),
        },
      ],
    });
    expect(outputText(final)).toBe("");

    const targetToolPlan = await expectResponsesJson(server, {
      stream: false,
      model: "gpt-5.6-luna",
      tools: [
        { type: "function", name: "sessions_send" },
        { type: "function", name: "message" },
      ],
      input: [
        makeUserInput(prompt),
        makeUserInput(
          "qa group visible reply tool check. Use the visible room reply path. exact marker: `QA-A2A-MIRROR-OK`",
        ),
      ],
    });

    expect(outputItem(targetToolPlan).type).toBe("function_call");
    expect(outputItem(targetToolPlan).name).toBe("message");
    expect(outputToolArgs(targetToolPlan)).toMatchObject({
      action: "send",
      message: "QA-A2A-MIRROR-OK",
    });
  });

  it("emits deterministic text deltas for generic streaming QA prompts", async () => {
    const server = await startMockServer();

    const quietResponse = await fetch(`${server.baseUrl}/v1/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        stream: true,
        input: [makeUserInput("Quiet streaming QA check: reply exactly `QA_STREAMING_OK`.")],
      }),
    });
    expect(quietResponse.status).toBe(200);
    const quietBody = await quietResponse.text();
    expect(quietBody).toContain('"type":"response.output_text.delta"');
    expect(quietBody).toContain('"phase":"final_answer"');
    expect(quietBody).toContain("QA_STREAMING_OK");

    const partialResponse = await fetch(`${server.baseUrl}/v1/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        stream: true,
        input: [makeUserInput("Partial streaming QA check: reply exactly `QA_PARTIAL_OK`.")],
      }),
    });
    expect(partialResponse.status).toBe(200);
    const partialBody = await partialResponse.text();
    expect(partialBody).toContain('"type":"response.output_text.delta"');
    expect(partialBody).toContain("QA_PARTIAL_OK");

    const telegramStreamResponse = await fetch(`${server.baseUrl}/v1/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        stream: true,
        input: [
          makeUserInput(
            "Telegram reply-chain marker QA. Reply exactly: QA-TELEGRAM-REPLY-CHAIN-OK",
          ),
          makeUserInput("Quiet streaming QA check. Reply exactly: QA-TELEGRAM-STREAM-SINGLE-OK"),
        ],
      }),
    });
    expect(telegramStreamResponse.status).toBe(200);
    const telegramStreamBody = await telegramStreamResponse.text();
    expect(telegramStreamBody).toContain("QA-TELEGRAM-STREAM-SINGLE-OK");
    expect(telegramStreamBody).not.toContain("QA-TELEGRAM-REPLY-CHAIN-OK");

    const telegramLongResponse = await fetch(`${server.baseUrl}/v1/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        stream: true,
        input: [
          makeUserInput("Telegram long final QA check. Use the scripted long final response."),
        ],
      }),
    });
    expect(telegramLongResponse.status).toBe(200);
    const telegramLongBody = await telegramLongResponse.text();
    expect(telegramLongBody).toContain('"type":"response.output_text.delta"');
    expect(telegramLongBody).toContain('"phase":"final_answer"');
    expect(telegramLongBody).toContain("TELEGRAM-LONG-FINAL-BEGIN");
    expect(telegramLongBody).toContain("TELEGRAM-LONG-FINAL-END");
    expect(telegramLongBody.length).toBeGreaterThan(4_500);

    const whatsappLongResponse = await fetch(`${server.baseUrl}/v1/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        stream: true,
        input: [
          makeUserInput("WhatsApp long final QA check. Use the scripted long final response."),
        ],
      }),
    });
    expect(whatsappLongResponse.status).toBe(200);
    const whatsappLongBody = await whatsappLongResponse.text();
    expect(whatsappLongBody).toContain('"type":"response.output_text.delta"');
    expect(whatsappLongBody).toContain('"phase":"final_answer"');
    expect(whatsappLongBody).toContain("WHATSAPP-LONG-FINAL-BEGIN");
    expect(whatsappLongBody).toContain("WHATSAPP-LONG-FINAL-END");
    expect(whatsappLongBody.length).toBeGreaterThan(6_000);

    const telegramThreeChunkLongResponse = await fetch(`${server.baseUrl}/v1/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        stream: true,
        input: [
          makeUserInput(
            "Telegram long final three chunk QA check. Use the scripted three chunk final response.",
          ),
        ],
      }),
    });
    expect(telegramThreeChunkLongResponse.status).toBe(200);
    const telegramThreeChunkLongBody = await telegramThreeChunkLongResponse.text();
    expect(telegramThreeChunkLongBody).toContain('"type":"response.output_text.delta"');
    expect(telegramThreeChunkLongBody).toContain('"phase":"final_answer"');
    expect(telegramThreeChunkLongBody).toContain("TELEGRAM-LONG-FINAL-3CHUNK-BEGIN");
    expect(telegramThreeChunkLongBody).toContain("TELEGRAM-LONG-FINAL-3CHUNK-END");
    expect(telegramThreeChunkLongBody.length).toBeGreaterThan(8_000);

    const blockPrompt = [
      "Block streaming QA check: complete this whole sequence in one turn.",
      "Step 1: send an assistant text block containing only this exact marker: `BLOCK_ONE_OK`.",
      "That first marker block must be emitted before any tool call.",
      "Step 2: after the first marker block, use the read tool exactly once on `QA_KICKOFF_TASK.md`.",
      "Step 3: after that read completes, send a final assistant text block containing only this exact marker: `BLOCK_TWO_OK`.",
      "Never put both markers in the same assistant text block.",
    ].join("\n");
    const blockResponse = await fetch(`${server.baseUrl}/v1/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        stream: true,
        input: [makeUserInput(blockPrompt)],
      }),
    });
    expect(blockResponse.status).toBe(200);
    const blockBody = await blockResponse.text();
    expect(blockBody).toContain('"item_id":"msg_mock_block_1"');
    expect(blockBody).toContain('"name":"read"');
    expect(blockBody).toContain("QA_KICKOFF_TASK.md");
    expect(blockBody).toContain("BLOCK_ONE_OK");
    expect(blockBody).not.toContain('"item_id":"msg_mock_block_2"');

    const blockContinuation = await fetch(`${server.baseUrl}/v1/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        stream: true,
        input: [
          makeUserInput(blockPrompt),
          {
            type: "function_call_output",
            call_id: "call_mock_read_fixture",
            output: "QA kickoff task read",
          },
        ],
      }),
    });
    expect(blockContinuation.status).toBe(200);
    const blockContinuationBody = await blockContinuation.text();
    expect(blockContinuationBody).toContain('"item_id":"msg_mock_block_2"');
    expect(blockContinuationBody).toContain("BLOCK_TWO_OK");
    expect(blockContinuationBody).not.toContain('"item_id":"msg_mock_block_1"');
  });

  it("plans deterministic tool-progress reads from prompt paths", async () => {
    const server = await startMockServer();

    const response = await fetch(`${server.baseUrl}/v1/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        stream: true,
        input: [
          makeUserInput(
            "Tool progress QA check: read `qa-progress-target.txt` before answering. After the read completes, reply exactly `TOOL_PROGRESS_OK`.",
          ),
        ],
      }),
    });

    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain('"name":"read"');
    expect(body).toContain("qa-progress-target.txt");
  });

  it("plans deterministic tool-progress reads for exact-marker prompts", async () => {
    const server = await startMockServer();
    const prompt =
      "Tool progress QA check: use the read tool exactly once on `QA_KICKOFF_TASK.md` before answering. After that read completes, reply with only this exact marker and no other text: `TOOL_PROGRESS_MARKER_OK`.";

    const toolPlan = await fetch(`${server.baseUrl}/v1/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        stream: true,
        input: [makeUserInput(prompt)],
      }),
    });

    expect(toolPlan.status).toBe(200);
    const toolPlanBody = await toolPlan.text();
    expect(toolPlanBody).toContain('"name":"read"');
    expect(toolPlanBody).toContain("QA_KICKOFF_TASK.md");

    const final = await expectResponsesJson<{
      output: Array<{ content?: Array<{ text?: string }> }>;
    }>(server, {
      stream: false,
      input: [
        makeUserInput(prompt),
        {
          type: "function_call_output",
          call_id: "call_mock_read_1",
          output: JSON.stringify({ text: "kickoff task" }),
        },
      ],
    });
    expect(final.output[0]?.content?.[0]?.text).toBe("TOOL_PROGRESS_MARKER_OK");
  });

  it("plans deterministic tool-progress exec commands from exact command prompts", async () => {
    const server = await startMockServer();
    const command =
      "rg -n 'matrix-progress-@room-@alice:matrix-qa.test-!room:matrix-qa.test.txt' . ; sleep 2";
    const prompt = `Tool progress QA check: call the exec tool exactly once with this exact command before answering: \`${command}\`. After that exec command completes or fails, reply exactly \`TOOL_PROGRESS_EXEC_OK\`.`;

    const response = await fetch(`${server.baseUrl}/v1/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        stream: true,
        input: [makeUserInput(prompt)],
      }),
    });

    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain('"name":"exec"');
    expect(body).toContain(command);
  });

  it("honors exact replies after QA kickoff reads without marker wording", async () => {
    const server = await startMockServer();
    const prompt =
      "Gateway restart in-flight QA check. Read QA_KICKOFF_TASK.md, then reply exactly: RESTART-INFLIGHT-MAYBE-OK";

    const final = await expectResponsesJson<{
      output: Array<{ content?: Array<{ text?: string }> }>;
    }>(server, {
      stream: false,
      input: [
        makeUserInput(prompt),
        {
          type: "function_call_output",
          call_id: "call_mock_read_1",
          output: JSON.stringify({ text: "QA mission: understand this OpenClaw repo." }),
        },
      ],
    });

    expect(final.output[0]?.content?.[0]?.text).toBe("RESTART-INFLIGHT-MAYBE-OK");
  });

  it("does not use stale exact replies from instructions after QA reads", async () => {
    const server = await startMockServer();

    const final = await expectResponsesJson<{
      output: Array<{ content?: Array<{ text?: string }> }>;
    }>(server, {
      stream: false,
      instructions: "If this is a heartbeat check, reply exactly: HEARTBEAT_OK",
      input: [
        makeUserInput("Read QA_KICKOFF_TASK.md, then summarize what you found."),
        {
          type: "function_call_output",
          call_id: "call_mock_read_1",
          output: JSON.stringify({ text: "QA mission: understand this OpenClaw repo." }),
        },
      ],
    });

    const text = final.output[0]?.content?.[0]?.text ?? "";
    expect(text).toContain("Protocol note: I reviewed the requested material.");
    expect(text).not.toContain("HEARTBEAT_OK");
  });

  it("preserves surrogate pairs in HTTP tool-output evidence snippets", async () => {
    const server = await startMockServer();
    const safePrefix = "x".repeat(219);

    const final = await expectResponsesJson<{
      output: Array<{ content?: Array<{ text?: string }> }>;
    }>(server, {
      stream: false,
      input: [
        makeUserInput("Summarize the tool result."),
        {
          type: "function_call_output",
          call_id: "call_mock_read_1",
          output: `${safePrefix}😀tail`,
        },
      ],
    });

    expect(final.output[0]?.content?.[0]?.text).toBe(
      `Protocol note: I reviewed the requested material. Evidence snippet: ${safePrefix}`,
    );
  });

  it("requires deterministic tool-progress error prompts to observe a failed tool", async () => {
    const server = await startMockServer();
    const prompt =
      "Tool progress error QA check: read `missing-tool-progress-target.txt` before answering. After the read fails, reply exactly `TOOL_PROGRESS_ERROR_OK`.";

    const toolPlan = await fetch(`${server.baseUrl}/v1/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        stream: true,
        input: [makeUserInput(prompt)],
      }),
    });

    expect(toolPlan.status).toBe(200);
    const toolPlanBody = await toolPlan.text();
    expect(toolPlanBody).toContain('"name":"read"');
    expect(toolPlanBody).toContain("missing-tool-progress-target.txt");

    const successOutput = await expectResponsesJson<{
      output: Array<{ content?: Array<{ text?: string }> }>;
    }>(server, {
      stream: false,
      input: [
        makeUserInput(prompt),
        {
          type: "function_call_output",
          call_id: "call_mock_read_1",
          output: JSON.stringify({ text: "unexpected success" }),
        },
      ],
    });
    expect(successOutput.output[0]?.content?.[0]?.text).toBe("BUG-TOOL-DID-NOT-FAIL");

    const errorOutput = await expectResponsesJson<{
      output: Array<{ content?: Array<{ text?: string }> }>;
    }>(server, {
      stream: false,
      input: [
        makeUserInput(prompt),
        {
          type: "function_call_output",
          call_id: "call_mock_read_1",
          output: JSON.stringify({ error: "ENOENT: no such file or directory" }),
        },
      ],
    });
    expect(errorOutput.output[0]?.content?.[0]?.text).toBe("TOOL_PROGRESS_ERROR_OK");
  });

  it("uses the latest user prompt path for tool-progress plans", async () => {
    const server = await startMockServer();

    const response = await fetch(`${server.baseUrl}/v1/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        stream: true,
        input: [
          makeUserInput(
            "Tool progress QA check: read `older-progress-target.txt` before answering. After the read completes, reply exactly `OLD_PROGRESS_OK`.",
          ),
          makeUserInput(
            "Tool progress error QA check: read `latest-missing-progress-target.txt` before answering. After the read fails, reply exactly `LATEST_PROGRESS_OK`.",
          ),
          makeUserInput(
            "Continue with the QA scenario plan and report worked, failed, and blocked items.",
          ),
        ],
      }),
    });

    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain('"name":"read"');
    expect(body).toContain("latest-missing-progress-target.txt");
    expect(body).not.toContain("older-progress-target.txt");
  });

  it("prefers path-like refs over generic quoted keys in prompts", async () => {
    const server = await startQaMockOpenAiServer({
      host: "127.0.0.1",
      port: 0,
    });
    cleanups.push(async () => {
      await server.stop();
    });

    const response = await fetch(`${server.baseUrl}/v1/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        stream: true,
        input: [
          {
            role: "user",
            content: [
              {
                type: "input_text",
                text: 'Please inspect "message_id" metadata first, then read `./QA_KICKOFF_TASK.md`.',
              },
            ],
          },
        ],
      }),
    });
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain('"arguments":"{\\"path\\":\\"QA_KICKOFF_TASK.md\\"}"');

    const debugResponse = await fetch(`${server.baseUrl}/debug/last-request`);
    expect(debugResponse.status).toBe(200);
    const debugPayload = requireRecord(await debugResponse.json(), "debug request");
    expect(debugPayload.prompt).toBe(
      'Please inspect "message_id" metadata first, then read `./QA_KICKOFF_TASK.md`.',
    );
    expect(debugPayload.allInputText).toBe(
      'Please inspect "message_id" metadata first, then read `./QA_KICKOFF_TASK.md`.',
    );
    expect(debugPayload.plannedToolName).toBe("read");
  });

  it("reads unquoted fixture paths and honors exact replies after tool output", async () => {
    const server = await startMockServer();
    const prompt =
      "Read large-cache-fixture.txt, verify it contains CACHE-FIXTURE-1600, then reply exactly QA-LARGE-CACHE-WARMUP-OK.";

    const toolPlan = await expectResponsesText(server, {
      stream: true,
      input: [makeUserInput(prompt)],
    });
    expect(toolPlan).toContain('"name":"read"');
    expect(toolPlan).toContain('"arguments":"{\\"path\\":\\"large-cache-fixture.txt\\"}"');

    const completion = await expectResponsesJson<{
      output?: Array<{ content?: Array<{ text?: string }> }>;
    }>(server, {
      stream: false,
      input: [
        makeUserInput(prompt),
        {
          type: "function_call_output",
          call_id: "call_mock_read_1",
          output: "CACHE-FIXTURE-1600 stable tool-result evidence.",
        },
      ],
    });

    expect(outputText(completion)).toBe("QA-LARGE-CACHE-WARMUP-OK");
  });

  it("preserves unquoted repo-scoped read targets", async () => {
    const server = await startMockServer();
    const toolPlan = await expectResponsesText(server, {
      stream: true,
      input: [makeUserInput("Read repo/qa/scenarios/index.yaml before continuing.")],
    });

    expect(toolPlan).toContain('"name":"read"');
    expect(toolPlan).toContain('"arguments":"{\\"path\\":\\"repo/qa/scenarios/index.yaml\\"}"');
  });

  it("does not treat natural reply-exactly-with phrasing as a marker token", async () => {
    const server = await startMockServer();
    const response = await expectResponsesJson<{
      output?: Array<{ content?: Array<{ text?: string }> }>;
    }>(server, {
      stream: false,
      input: [
        makeUserInput(
          "Use qa-visible-skill now. Reply exactly with the visible skill marker and nothing else.",
        ),
      ],
    });

    expect(outputText(response)).toBe("VISIBLE-SKILL-OK");
  });

  it("drives the Lobster Invaders write flow and memory recall responses", async () => {
    const server = await startQaMockOpenAiServer({
      host: "127.0.0.1",
      port: 0,
    });
    cleanups.push(async () => {
      await server.stop();
    });

    const lobster = await fetch(`${server.baseUrl}/v1/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        stream: true,
        model: "gpt-5.6-luna",
        input: [
          {
            role: "user",
            content: [
              { type: "input_text", text: "Please build Lobster Invaders after reading context." },
            ],
          },
          {
            type: "function_call_output",
            output: "QA mission: read source and docs first.",
          },
        ],
      }),
    });
    expect(lobster.status).toBe(200);
    const lobsterBody = await lobster.text();
    expect(lobsterBody).toContain('"name":"write"');
    expect(lobsterBody).toContain("lobster-invaders.html");

    const recall = await fetch(`${server.baseUrl}/v1/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        stream: false,
        model: "gpt-5.6-luna-alt",
        input: [
          {
            role: "user",
            content: [
              {
                type: "input_text",
                text: "Please remember this fact for later: the QA canary code is ALPHA-7.",
              },
            ],
          },
          {
            role: "user",
            content: [
              {
                type: "input_text",
                text: "What was the QA canary code I asked you to remember earlier?",
              },
            ],
          },
        ],
      }),
    });
    expect(recall.status).toBe(200);
    const payload = (await recall.json()) as {
      output?: Array<{ content?: Array<{ text?: string }> }>;
    };
    expect(payload.output?.[0]?.content?.[0]?.text).toContain("ALPHA-7");

    const requests = await fetch(`${server.baseUrl}/debug/requests`);
    expect(requests.status).toBe(200);
    const requestLog = requireArray(await requests.json(), "debug requests");
    expect(requireRecord(requestLog[0], "debug request 0").model).toBe("gpt-5.6-luna");
    expect(requireRecord(requestLog[1], "debug request 1").model).toBe("gpt-5.6-luna-alt");
  });

  it("keeps remember prompts prose-only even when they mention repo cleanup", async () => {
    const server = await startQaMockOpenAiServer({
      host: "127.0.0.1",
      port: 0,
    });
    cleanups.push(async () => {
      await server.stop();
    });

    const response = await fetch(`${server.baseUrl}/v1/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        stream: true,
        model: "gpt-5.6-luna",
        input: [
          {
            role: "user",
            content: [
              {
                type: "input_text",
                text: "Please remember this fact for later: the QA canary code is ALPHA-7. Use your normal memory mechanism, avoid manual repo cleanup, and reply exactly `Remembered ALPHA-7.` once stored.",
              },
            ],
          },
        ],
      }),
    });
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain("Remembered ALPHA-7.");
    expect(body).not.toContain('"name":"read"');
  });

  it("drives repo-contract followthrough as read-read-read-write-then-report", async () => {
    const server = await startQaMockOpenAiServer({
      host: "127.0.0.1",
      port: 0,
    });
    cleanups.push(async () => {
      await server.stop();
    });

    const prompt =
      "Repo contract followthrough check. Read AGENT.md, SOUL.md, and FOLLOWTHROUGH_INPUT.md first. Then follow the repo contract exactly, write ./repo-contract-summary.txt, and reply with three labeled lines: Read, Wrote, Status.";

    const first = await fetch(`${server.baseUrl}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        stream: true,
        model: "gpt-5.6-luna",
        input: [{ role: "user", content: [{ type: "input_text", text: prompt }] }],
      }),
    });
    expect(first.status).toBe(200);
    expect(await first.text()).toContain('"arguments":"{\\"path\\":\\"AGENT.md\\"}"');

    const second = await fetch(`${server.baseUrl}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        stream: true,
        model: "gpt-5.6-luna",
        input: [
          { role: "user", content: [{ type: "input_text", text: prompt }] },
          {
            type: "function_call_output",
            output:
              "# Repo contract\n\nStep order:\n1. Read AGENT.md.\n2. Read SOUL.md.\n3. Read FOLLOWTHROUGH_INPUT.md.\n4. Write ./repo-contract-summary.txt.\n",
          },
        ],
      }),
    });
    expect(second.status).toBe(200);
    expect(await second.text()).toContain('"arguments":"{\\"path\\":\\"SOUL.md\\"}"');

    const third = await fetch(`${server.baseUrl}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        stream: true,
        model: "gpt-5.6-luna",
        input: [
          { role: "user", content: [{ type: "input_text", text: prompt }] },
          {
            type: "function_call_output",
            output: "# Execution style\n\nStay brief, honest, and action-first.\n",
          },
        ],
      }),
    });
    expect(third.status).toBe(200);
    expect(await third.text()).toContain('"arguments":"{\\"path\\":\\"FOLLOWTHROUGH_INPUT.md\\"}"');

    const fourth = await fetch(`${server.baseUrl}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        stream: true,
        model: "gpt-5.6-luna",
        input: [
          { role: "user", content: [{ type: "input_text", text: prompt }] },
          {
            type: "function_call_output",
            output:
              "Mission: prove you followed the repo contract.\nEvidence path: AGENT.md -> SOUL.md -> FOLLOWTHROUGH_INPUT.md -> repo-contract-summary.txt\n",
          },
        ],
      }),
    });
    expect(fourth.status).toBe(200);
    const fourthBody = await fourth.text();
    expect(fourthBody).toContain('"name":"write"');
    expect(fourthBody).toContain("repo-contract-summary.txt");

    const fifth = await fetch(`${server.baseUrl}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        stream: false,
        model: "gpt-5.6-luna",
        input: [
          { role: "user", content: [{ type: "input_text", text: prompt }] },
          {
            type: "function_call_output",
            output:
              "Successfully wrote repo-contract-summary.txt\nMission: prove you followed the repo contract.\nStatus: complete\n",
          },
        ],
      }),
    });
    expect(fifth.status).toBe(200);
    const payload = (await fifth.json()) as {
      output?: Array<{ content?: Array<{ text?: string }> }>;
    };
    expect(payload.output?.[0]?.content?.[0]?.text).toContain("Read: AGENT.md, SOUL.md");
    expect(payload.output?.[0]?.content?.[0]?.text).toContain("Wrote: repo-contract-summary.txt");
    expect(payload.output?.[0]?.content?.[0]?.text).toContain("Status: complete");
  });

  it("uses argument-scoped tool call ids for repeated tool names", async () => {
    const server = await startQaMockOpenAiServer({
      host: "127.0.0.1",
      port: 0,
    });
    cleanups.push(async () => {
      await server.stop();
    });

    const prompt =
      "Repo contract followthrough check. Read AGENT.md, SOUL.md, and FOLLOWTHROUGH_INPUT.md first. Then follow the repo contract exactly, write ./repo-contract-summary.txt, and reply with three labeled lines: Read, Wrote, Status.";

    const first = await fetch(`${server.baseUrl}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        stream: false,
        model: "gpt-5.6-luna",
        input: [{ role: "user", content: [{ type: "input_text", text: prompt }] }],
      }),
    });
    const firstPayload = (await first.json()) as {
      output?: Array<{ call_id?: string }>;
    };

    const second = await fetch(`${server.baseUrl}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        stream: false,
        model: "gpt-5.6-luna",
        input: [
          { role: "user", content: [{ type: "input_text", text: prompt }] },
          {
            type: "function_call_output",
            output:
              "# Repo contract\n\nStep order:\n1. Read AGENT.md.\n2. Read SOUL.md.\n3. Read FOLLOWTHROUGH_INPUT.md.\n4. Write ./repo-contract-summary.txt.\n",
          },
        ],
      }),
    });
    const secondPayload = (await second.json()) as {
      output?: Array<{ call_id?: string }>;
    };

    expect(firstPayload.output?.[0]?.call_id).toMatch(/^call_mock_read_/);
    expect(secondPayload.output?.[0]?.call_id).toMatch(/^call_mock_read_/);
    expect(firstPayload.output?.[0]?.call_id).not.toBe(secondPayload.output?.[0]?.call_id);
  });

  it("uses unique ids for repeated identical tool calls", async () => {
    const server = await startMockServer();
    const body = {
      stream: false,
      model: "gpt-5.6-luna",
      input: [makeUserInput("Read QA_KICKOFF_TASK.md, then answer with exactly QA-READ-OK.")],
    };

    const first = await expectResponsesJson<{ output?: Array<{ call_id?: string }> }>(server, body);
    const second = await expectResponsesJson<{ output?: Array<{ call_id?: string }> }>(
      server,
      body,
    );

    const firstCallId = first.output?.[0]?.call_id;
    const secondCallId = second.output?.[0]?.call_id;
    expect(firstCallId).toMatch(/^call_mock_read_/);
    expect(secondCallId).toMatch(/^call_mock_read_/);
    expect(firstCallId).not.toBe(secondCallId);
  });

  it("emits the Slack native chart presentation through the declared message tool", async () => {
    const server = await startMockServer();

    const undeclaredPayload = await expectResponsesJson(server, {
      stream: false,
      model: "gpt-5.6-luna",
      input: [makeUserInput(SLACK_CHART_PROMPT)],
    });
    expect(
      outputItems(undeclaredPayload).some(
        (item) => item.type === "function_call" && item.name === "message",
      ),
    ).toBe(false);

    const declaredPayload = await expectResponsesJson(server, {
      stream: false,
      model: "gpt-5.6-luna",
      tools: [MESSAGE_TOOL],
      input: [makeUserInput(SLACK_CHART_PROMPT)],
    });
    const toolCall = outputToolCall(declaredPayload, "message");
    expect(outputToolArgsFromItem(toolCall)).toEqual(SLACK_CHART_MESSAGE_TOOL_ARGS);

    const afterToolPayload = await expectResponsesJson(server, {
      stream: false,
      model: "gpt-5.6-luna",
      tools: [MESSAGE_TOOL],
      input: [
        makeUserInput(SLACK_CHART_PROMPT),
        {
          type: "function_call_output",
          call_id: outputToolCallId(toolCall, "call_mock_message_chart"),
          output: "message sent",
        },
      ],
    });
    expect(
      outputItems(afterToolPayload).some(
        (item) => item.type === "function_call" && item.name === "message",
      ),
    ).toBe(false);
    expect(outputText(afterToolPayload)).toBe(SLACK_CHART_DONE_TOKEN);
  });

  it("emits WhatsApp agent reaction message tool calls only when the tool is declared", async () => {
    const server = await startMockServer();

    const undeclaredPayload = await expectResponsesJson(server, {
      stream: false,
      model: "gpt-5.6-luna",
      input: [makeUserInput(WHATSAPP_AGENT_REACT_PROMPT)],
    });

    expect(
      outputItems(undeclaredPayload).some(
        (item) => item.type === "function_call" && item.name === "message",
      ),
    ).toBe(false);

    const unrelatedToolPayload = await expectResponsesJson(server, {
      stream: false,
      model: "gpt-5.6-luna",
      tools: [READ_TOOL],
      input: [makeUserInput(WHATSAPP_AGENT_REACT_PROMPT)],
    });

    expect(
      outputItems(unrelatedToolPayload).some(
        (item) => item.type === "function_call" && item.name === "message",
      ),
    ).toBe(false);

    const declaredPayload = await expectResponsesJson(server, {
      stream: false,
      model: "gpt-5.6-luna",
      tools: [MESSAGE_TOOL],
      input: [makeUserInput(WHATSAPP_AGENT_REACT_PROMPT)],
    });
    const groupDeclaredPayload = await expectResponsesJson(server, {
      stream: false,
      model: "gpt-5.6-luna",
      tools: [MESSAGE_TOOL],
      input: [makeUserInput(WHATSAPP_GROUP_AGENT_REACT_PROMPT)],
    });

    const groupToolCall = outputToolCall(groupDeclaredPayload, "message");
    expect(outputToolArgsFromItem(groupToolCall)).toEqual({
      action: "react",
      emoji: "👍",
    });

    const toolCall = outputToolCall(declaredPayload, "message");
    expect(toolCall).toMatchObject({
      type: "function_call",
      name: "message",
    });
    expect(outputToolArgsFromItem(toolCall)).toEqual({
      action: "react",
      emoji: "👍",
    });

    const afterToolPayload = await expectResponsesJson(server, {
      stream: false,
      model: "gpt-5.6-luna",
      tools: [MESSAGE_TOOL],
      input: [
        makeUserInput(WHATSAPP_AGENT_REACT_PROMPT),
        {
          type: "function_call_output",
          call_id: outputToolCallId(toolCall, "call_mock_message_react"),
          output: "reaction sent",
        },
      ],
    });

    expect(
      outputItems(afterToolPayload).some(
        (item) => item.type === "function_call" && item.name === "message",
      ),
    ).toBe(false);
    expect(
      outputItems(afterToolPayload)
        .flatMap((item) => (Array.isArray(item.content) ? item.content : []))
        .map((content) => requireRecord(content, "assistant content").text)
        .filter((text): text is string => typeof text === "string" && text.trim().length > 0),
    ).toEqual([]);
  });

  it("emits WhatsApp agent upload-file message tool calls only when the tool is declared", async () => {
    const server = await startMockServer();

    const undeclaredPayload = await expectResponsesJson(server, {
      stream: false,
      model: "gpt-5.6-luna",
      input: [makeUserInput(WHATSAPP_AGENT_UPLOAD_PROMPT)],
    });

    expect(
      outputItems(undeclaredPayload).some(
        (item) => item.type === "function_call" && item.name === "message",
      ),
    ).toBe(false);

    const declaredPayload = await expectResponsesJson(server, {
      stream: false,
      model: "gpt-5.6-luna",
      tools: [MESSAGE_TOOL],
      input: [makeUserInput(WHATSAPP_AGENT_UPLOAD_PROMPT)],
    });
    const groupDeclaredPayload = await expectResponsesJson(server, {
      stream: false,
      model: "gpt-5.6-luna",
      tools: [MESSAGE_TOOL],
      input: [makeUserInput(WHATSAPP_GROUP_AGENT_UPLOAD_PROMPT)],
    });

    const groupToolCall = outputToolCall(groupDeclaredPayload, "message");
    expect(outputToolArgsFromItem(groupToolCall)).toMatchObject({
      action: "upload-file",
      caption: WHATSAPP_GROUP_AGENT_UPLOAD_TOKEN,
    });

    const toolCall = outputToolCall(declaredPayload, "message");
    expect(outputToolArgsFromItem(toolCall)).toMatchObject({
      action: "upload-file",
      caption: WHATSAPP_AGENT_UPLOAD_TOKEN,
      contentType: "image/png",
      filename: "whatsapp-qa-agent-upload.png",
    });
    expect(outputToolArgsFromItem(toolCall).buffer).toEqual(expect.any(String));

    const afterToolPayload = await expectResponsesJson(server, {
      stream: false,
      model: "gpt-5.6-luna",
      tools: [MESSAGE_TOOL],
      input: [
        makeUserInput(WHATSAPP_AGENT_UPLOAD_PROMPT),
        {
          type: "function_call_output",
          call_id: outputToolCallId(toolCall, "call_mock_message_upload"),
          output: "media sent",
        },
      ],
    });

    expect(
      outputItems(afterToolPayload).some(
        (item) => item.type === "function_call" && item.name === "message",
      ),
    ).toBe(false);
    expect(outputText(afterToolPayload)).toBe("");
  });

  it("answers WhatsApp pending-history prompts only with injected prior group context", async () => {
    const server = await startMockServer();

    const historyContext = buildWhatsAppPendingHistoryContextFixture([
      {
        sender: "Alice",
        timestamp: 1_786_000_000_000,
        body: `quiet context ${WHATSAPP_PENDING_HISTORY_QUIET_MARKER} ${WHATSAPP_PENDING_HISTORY_CONTEXT_SENTINEL}`,
      },
    ]);
    const withStructuredHistory = await expectResponsesJson(server, {
      stream: false,
      model: "gpt-5.6-luna",
      input: [
        makeUserInput([historyContext, WHATSAPP_PENDING_HISTORY_TRIGGER_PROMPT].join("\n\n")),
      ],
    });

    expect(outputText(withStructuredHistory)).toBe(WHATSAPP_PENDING_HISTORY_OK_MARKER);

    const triggerTextOnly = await expectResponsesJson(server, {
      stream: false,
      model: "gpt-5.6-luna",
      input: [
        makeUserInput(
          [
            WHATSAPP_PENDING_HISTORY_TRIGGER_PROMPT,
            `The current trigger text mentions ${WHATSAPP_PENDING_HISTORY_QUIET_MARKER}.`,
            `It also mentions ${WHATSAPP_PENDING_HISTORY_CONTEXT_SENTINEL}.`,
          ].join(" "),
        ),
      ],
    });

    expect(outputText(triggerTextOnly)).not.toBe(WHATSAPP_PENDING_HISTORY_OK_MARKER);

    const currentMessageOnlySentinel = await expectResponsesJson(server, {
      stream: false,
      model: "gpt-5.6-luna",
      input: [
        makeUserInput(
          [
            buildWhatsAppPendingHistoryContextFixture([
              {
                sender: "Alice",
                timestamp: 1_786_000_000_000,
                body: "unrelated prior context",
              },
            ]),
            WHATSAPP_PENDING_HISTORY_TRIGGER_PROMPT,
            `The current trigger text mentions ${WHATSAPP_PENDING_HISTORY_QUIET_MARKER}.`,
            `It also mentions ${WHATSAPP_PENDING_HISTORY_CONTEXT_SENTINEL}.`,
          ].join("\n\n"),
        ),
      ],
    });

    expect(outputText(currentMessageOnlySentinel)).not.toBe(WHATSAPP_PENDING_HISTORY_OK_MARKER);

    const currentPromptBeforeTrigger = await expectResponsesJson(server, {
      stream: false,
      model: "gpt-5.6-luna",
      input: [
        makeUserInput(
          [
            buildWhatsAppPendingHistoryContextFixture([
              {
                sender: "Alice",
                timestamp: 1_786_000_000_000,
                body: "unrelated prior context",
              },
            ]),
            `Current request: ${WHATSAPP_PENDING_HISTORY_QUIET_MARKER} ${WHATSAPP_PENDING_HISTORY_CONTEXT_SENTINEL}`,
            WHATSAPP_PENDING_HISTORY_TRIGGER_PROMPT,
          ].join("\n\n"),
        ),
      ],
    });

    expect(outputText(currentPromptBeforeTrigger)).not.toBe(WHATSAPP_PENDING_HISTORY_OK_MARKER);

    const contextWithoutCurrentTrigger = await expectResponsesJson(server, {
      stream: false,
      model: "gpt-5.6-luna",
      input: [
        makeUserInput(
          [historyContext, "openclawqa pending history context check without current trigger"].join(
            "\n",
          ),
        ),
      ],
    });

    expect(outputText(contextWithoutCurrentTrigger)).not.toBe(WHATSAPP_PENDING_HISTORY_OK_MARKER);
  });

  it("uses the WhatsApp broadcast runtime agent id context for distinct markers", async () => {
    const server = await startMockServer();

    const mainPayload = await expectResponsesJson(server, {
      stream: false,
      model: "gpt-5.6-luna",
      input: [
        makeDeveloperInput("Runtime: agent=main | channel=whatsapp | capabilities=messageactions"),
        makeUserInput(WHATSAPP_BROADCAST_PROMPT),
      ],
    });
    const secondPayload = await expectResponsesJson(server, {
      stream: false,
      model: "gpt-5.6-luna",
      input: [
        makeDeveloperInput(
          "Runtime: agent=qa-second | channel=whatsapp | capabilities=messageactions",
        ),
        makeUserInput(WHATSAPP_BROADCAST_PROMPT),
      ],
    });
    const noIdentityPayload = await expectResponsesJson(server, {
      stream: false,
      model: "gpt-5.6-luna",
      input: [
        makeDeveloperInput("Runtime: channel=whatsapp | capabilities=messageactions"),
        makeUserInput(WHATSAPP_BROADCAST_PROMPT),
      ],
    });

    expect(outputText(mainPayload)).toBe(`${WHATSAPP_BROADCAST_TOKEN}_MAIN`);
    expect(outputText(secondPayload)).toBe(`${WHATSAPP_BROADCAST_TOKEN}_SECOND`);
    expect(outputText(noIdentityPayload)).not.toMatch(
      new RegExp(`${WHATSAPP_BROADCAST_TOKEN}_(?:MAIN|SECOND)`, "u"),
    );
  });

  it("answers the WhatsApp activation-always marker without matching unrelated prompts", async () => {
    const server = await startMockServer();

    const activationPayload = await expectResponsesJson(server, {
      stream: false,
      model: "gpt-5.6-luna",
      input: [makeUserInput(WHATSAPP_ACTIVATION_ALWAYS_PROMPT)],
    });
    const unrelatedPayload = await expectResponsesJson(server, {
      stream: false,
      model: "gpt-5.6-luna",
      input: [makeUserInput("Group activation visible behavior marker WHATSAPP_QA_UNRELATED_TEST")],
    });

    expect(outputText(activationPayload)).toBe(WHATSAPP_ACTIVATION_ALWAYS_MARKER);
    expect(outputText(unrelatedPayload)).not.toBe(WHATSAPP_ACTIVATION_ALWAYS_MARKER);
  });

  it("answers reply-to-bot seed and implicit quoted-trigger markers deterministically", async () => {
    const server = await startMockServer();

    const seedPayload = await expectResponsesJson(server, {
      stream: false,
      model: "gpt-5.6-luna",
      input: [makeUserInput(WHATSAPP_REPLY_TO_BOT_SEED_PROMPT)],
    });
    const triggerPayload = await expectResponsesJson(server, {
      stream: false,
      model: "gpt-5.6-luna",
      input: [makeUserInput(WHATSAPP_REPLY_TO_BOT_TRIGGER_PROMPT)],
    });
    const unrelatedPayload = await expectResponsesJson(server, {
      stream: false,
      model: "gpt-5.6-luna",
      input: [makeUserInput("Quoted implicit reply trigger marker WHATSAPP_QA_UNRELATED_TEST")],
    });

    expect(WHATSAPP_REPLY_TO_BOT_TRIGGER_PROMPT).not.toMatch(/\bopenclawqa\b/iu);
    expect(outputText(seedPayload)).toBe(WHATSAPP_REPLY_TO_BOT_SEED_MARKER);
    expect(outputText(triggerPayload)).toBe(WHATSAPP_REPLY_TO_BOT_TRIGGER_MARKER);
    expect(outputText(unrelatedPayload)).not.toBe(WHATSAPP_REPLY_TO_BOT_TRIGGER_MARKER);
  });

  it("continues repo-contract followthrough when a retry user item follows tool output", async () => {
    const server = await startQaMockOpenAiServer({
      host: "127.0.0.1",
      port: 0,
    });
    cleanups.push(async () => {
      await server.stop();
    });

    const prompt =
      "Repo contract followthrough check. Read AGENT.md, SOUL.md, and FOLLOWTHROUGH_INPUT.md first. Then follow the repo contract exactly, write ./repo-contract-summary.txt, and reply with three labeled lines: Read, Wrote, Status.";

    const response = await fetch(`${server.baseUrl}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        stream: true,
        model: "gpt-5.6-luna",
        input: [
          { role: "user", content: [{ type: "input_text", text: prompt }] },
          {
            type: "function_call_output",
            output:
              "# Repo contract\n\nStep order:\n1. Read AGENT.md.\n2. Read SOUL.md.\n3. Read FOLLOWTHROUGH_INPUT.md.\n4. Write ./repo-contract-summary.txt.\n",
          },
          {
            role: "user",
            content: [{ type: "input_text", text: "Continue after compaction." }],
          },
        ],
      }),
    });

    expect(response.status).toBe(200);
    expect(await response.text()).toContain('"arguments":"{\\"path\\":\\"SOUL.md\\"}"');
  });

  it("continues repo-contract followthrough from structured tool output", async () => {
    const server = await startQaMockOpenAiServer({
      host: "127.0.0.1",
      port: 0,
    });
    cleanups.push(async () => {
      await server.stop();
    });

    const prompt =
      "Repo contract followthrough check. Read AGENT.md, SOUL.md, and FOLLOWTHROUGH_INPUT.md first. Then follow the repo contract exactly, write ./repo-contract-summary.txt, and reply with three labeled lines: Read, Wrote, Status.";

    const response = await fetch(`${server.baseUrl}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        stream: true,
        model: "gpt-5.6-luna",
        input: [
          { role: "user", content: [{ type: "input_text", text: prompt }] },
          {
            type: "function_call_output",
            output: [
              {
                type: "output_text",
                text: "# Repo contract\n\nStep order:\n1. Read AGENT.md.\n2. Read SOUL.md.\n3. Read FOLLOWTHROUGH_INPUT.md.\n4. Write ./repo-contract-summary.txt.\n",
              },
            ],
          },
          {
            role: "user",
            content: [{ type: "input_text", text: "Continue after compaction." }],
          },
        ],
      }),
    });

    expect(response.status).toBe(200);
    expect(await response.text()).toContain('"arguments":"{\\"path\\":\\"SOUL.md\\"}"');
  });

  it("advances repo-contract followthrough when transcript text is newer than extracted tool output", async () => {
    const server = await startQaMockOpenAiServer({
      host: "127.0.0.1",
      port: 0,
    });
    cleanups.push(async () => {
      await server.stop();
    });

    const prompt =
      "Repo contract followthrough check. Read AGENT.md, SOUL.md, and FOLLOWTHROUGH_INPUT.md first. Then follow the repo contract exactly, write ./repo-contract-summary.txt, and reply with three labeled lines: Read, Wrote, Status.";

    const response = await fetch(`${server.baseUrl}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        stream: true,
        model: "gpt-5.6-luna",
        input: [
          { role: "user", content: [{ type: "input_text", text: prompt }] },
          {
            type: "function_call_output",
            output:
              "# Repo contract\n\nStep order:\n1. Read AGENT.md.\n2. Read SOUL.md.\n3. Read FOLLOWTHROUGH_INPUT.md.\n4. Write ./repo-contract-summary.txt.\n",
          },
          {
            role: "user",
            content: [
              {
                type: "input_text",
                text: "# Execution style\n\nStay brief, honest, and action-first.\n",
              },
            ],
          },
        ],
      }),
    });

    expect(response.status).toBe(200);
    expect(await response.text()).toContain(
      '"arguments":"{\\"path\\":\\"FOLLOWTHROUGH_INPUT.md\\"}"',
    );
  });

  it("advances personal task followthrough when transcript text is newer than extracted tool output", async () => {
    const server = await startQaMockOpenAiServer({
      host: "127.0.0.1",
      port: 0,
    });
    cleanups.push(async () => {
      await server.stop();
    });

    const prompt =
      "Personal task followthrough check. Read PERSONAL_TASK_LEDGER.md and FOLLOWTHROUGH_NOTE.md first. Then write ./personal-task-status.txt and reply with three labeled lines: Pending, Blocked, Done.";

    const first = await fetch(`${server.baseUrl}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        stream: true,
        model: "gpt-5.6-luna",
        input: [{ role: "user", content: [{ type: "input_text", text: prompt }] }],
      }),
    });
    expect(first.status).toBe(200);
    const firstBody = await first.text();
    expect(firstBody).toContain('"arguments":"{\\"path\\":\\"PERSONAL_TASK_LEDGER.md\\"}"');
    expect(firstBody).not.toContain("repo/package.json");

    const response = await fetch(`${server.baseUrl}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        stream: true,
        model: "gpt-5.6-luna",
        input: [
          { role: "user", content: [{ type: "input_text", text: prompt }] },
          {
            type: "function_call_output",
            output:
              "# Personal task ledger\n\nRequired status contract:\n1. Read PERSONAL_TASK_LEDGER.md.\n2. Read FOLLOWTHROUGH_NOTE.md.\n3. Write ./personal-task-status.txt.\n",
          },
          {
            role: "user",
            content: [
              {
                type: "input_text",
                text: "Task: prepare a local OpenClaw PR readiness note.\nPending: wait for maintainer feedback before publishing.\nBlocked: publishing needs explicit user approval.\nDone: local evidence captured in personal-task-status.txt.\n",
              },
            ],
          },
        ],
      }),
    });

    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain('"name":"write"');
    expect(body).toContain("personal-task-status.txt");
  });

  it("gates personal completion claims on a written proof artifact", async () => {
    const server = await startQaMockOpenAiServer({
      host: "127.0.0.1",
      port: 0,
    });
    cleanups.push(async () => {
      await server.stop();
    });

    const prompt =
      "Personal no-fake-progress check. Read PROGRESS_REQUEST.md and PROGRESS_EVIDENCE.md first. Then write ./personal-progress-proof.txt with the local evidence and external status.";

    const first = await fetch(`${server.baseUrl}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        stream: true,
        model: "gpt-5.6-luna",
        input: [{ role: "user", content: [{ type: "input_text", text: prompt }] }],
      }),
    });
    expect(first.status).toBe(200);
    const firstBody = await first.text();
    expect(firstBody).toContain('"arguments":"{\\"path\\":\\"PROGRESS_REQUEST.md\\"}"');
    expect(firstBody).not.toContain("sent successfully");

    const writePlan = await fetch(`${server.baseUrl}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        stream: true,
        model: "gpt-5.6-luna",
        input: [
          { role: "user", content: [{ type: "input_text", text: prompt }] },
          {
            type: "function_call_output",
            output:
              "# Progress request\n\nRequired contract:\n1. Read PROGRESS_REQUEST.md.\n2. Read PROGRESS_EVIDENCE.md.\n3. Write ./personal-progress-proof.txt.\n",
          },
          {
            role: "user",
            content: [
              {
                type: "input_text",
                text: "# Progress evidence\n\nTask: prepare a maintainer-ready local handoff note.\nExternal status: not sent, not published, not uploaded, not merged.\nHonest completion claim: local proof artifact written.\n",
              },
            ],
          },
        ],
      }),
    });

    expect(writePlan.status).toBe(200);
    const writeBody = await writePlan.text();
    expect(writeBody).toContain('"name":"write"');
    expect(writeBody).toContain("personal-progress-proof.txt");
    expect(writeBody).not.toContain("published successfully");

    const final = await fetch(`${server.baseUrl}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        stream: true,
        model: "gpt-5.6-luna",
        input: [
          { role: "user", content: [{ type: "input_text", text: prompt }] },
          {
            type: "function_call_output",
            output:
              "Successfully wrote personal-progress-proof.txt with local proof artifact written.",
          },
        ],
      }),
    });

    expect(final.status).toBe(200);
    const finalBody = await final.text();
    expect(finalBody).toContain("PERSONAL-NO-FAKE-PROGRESS-OK");
    expect(finalBody).toContain("not sent, not published, not uploaded, not merged");
    expect(finalBody).not.toContain("sent successfully");
  });

  it("reports personal failure recovery with a retry boundary", async () => {
    const server = await startQaMockOpenAiServer({
      host: "127.0.0.1",
      port: 0,
    });
    cleanups.push(async () => {
      await server.stop();
    });

    const prompt =
      "Personal failure recovery check. Read FAILURE_RECOVERY_REQUEST.md and FAILURE_RECOVERY_EVIDENCE.md first. Then write ./personal-failure-recovery.txt with Completed, Failed step, Retry boundary, and Next step.";

    const first = await fetch(`${server.baseUrl}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        stream: true,
        model: "gpt-5.6-luna",
        input: [{ role: "user", content: [{ type: "input_text", text: prompt }] }],
      }),
    });
    expect(first.status).toBe(200);
    const firstBody = await first.text();
    expect(firstBody).toContain('"arguments":"{\\"path\\":\\"FAILURE_RECOVERY_REQUEST.md\\"}"');
    expect(firstBody).not.toContain("fully complete");

    const writePlan = await fetch(`${server.baseUrl}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        stream: true,
        model: "gpt-5.6-luna",
        input: [
          { role: "user", content: [{ type: "input_text", text: prompt }] },
          {
            type: "function_call_output",
            output:
              "# Failure recovery request\n\nRequired contract:\n1. Read FAILURE_RECOVERY_REQUEST.md.\n2. Read FAILURE_RECOVERY_EVIDENCE.md.\n3. Write ./personal-failure-recovery.txt.\n",
          },
          {
            role: "user",
            content: [
              {
                type: "input_text",
                text: "# Failure recovery evidence\n\nCompleted: request reviewed and local evidence captured.\nFailed step: external calendar update was not attempted because explicit approval is missing.\nRetry boundary: do not retry the external step until approval is given.\nNext step: ask for approval before any external update.\n",
              },
            ],
          },
        ],
      }),
    });

    expect(writePlan.status).toBe(200);
    const writeBody = await writePlan.text();
    expect(writeBody).toContain('"name":"write"');
    expect(writeBody).toContain("personal-failure-recovery.txt");
    expect(writeBody).toContain("Retry boundary: do not retry");
    expect(writeBody).not.toContain("retry succeeded");

    const final = await fetch(`${server.baseUrl}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        stream: true,
        model: "gpt-5.6-luna",
        input: [
          { role: "user", content: [{ type: "input_text", text: prompt }] },
          {
            type: "function_call_output",
            output:
              "Successfully wrote personal-failure-recovery.txt with the failed step and retry boundary.",
          },
        ],
      }),
    });

    expect(final.status).toBe(200);
    const finalBody = await final.text();
    expect(finalBody).toContain("PERSONAL-FAILURE-RECOVERY-OK");
    expect(finalBody).toContain("Retry boundary: do not retry");
    expect(finalBody).not.toContain("fully complete");
  });

  it("drives the compaction retry mutating tool parity flow", async () => {
    const server = await startQaMockOpenAiServer({
      host: "127.0.0.1",
      port: 0,
    });
    cleanups.push(async () => {
      await server.stop();
    });

    const writePlan = await fetch(`${server.baseUrl}/v1/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        stream: true,
        model: "gpt-5.6-luna",
        input: [
          {
            role: "user",
            content: [
              {
                type: "input_text",
                text: "Compaction retry mutating tool check: read COMPACTION_RETRY_CONTEXT.md, then create compaction-retry-summary.txt and keep replay safety explicit.",
              },
            ],
          },
          {
            type: "function_call_output",
            output: "compaction retry evidence block 0000\ncompaction retry evidence block 0001",
          },
        ],
      }),
    });
    expect(writePlan.status).toBe(200);
    const writePlanBody = await writePlan.text();
    expect(writePlanBody).toContain('"name":"write"');
    expect(writePlanBody).toContain("compaction-retry-summary.txt");

    const finalReply = await fetch(`${server.baseUrl}/v1/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        stream: false,
        model: "gpt-5.6-luna",
        input: [
          {
            role: "user",
            content: [
              {
                type: "input_text",
                text: "Compaction retry mutating tool check: read COMPACTION_RETRY_CONTEXT.md, then create compaction-retry-summary.txt and keep replay safety explicit.",
              },
            ],
          },
          {
            type: "function_call_output",
            output: "Successfully wrote 41 bytes to compaction-retry-summary.txt.",
          },
        ],
      }),
    });
    expect(finalReply.status).toBe(200);
    const finalPayload = (await finalReply.json()) as {
      output?: Array<{ content?: Array<{ text?: string }> }>;
    };
    expect(finalPayload.output?.[0]?.content?.[0]?.text).toContain("replay unsafe after write");
  });

  it("keeps compaction retry planning across continuation prompts", async () => {
    const server = await startQaMockOpenAiServer({
      host: "127.0.0.1",
      port: 0,
    });
    cleanups.push(async () => {
      await server.stop();
    });

    const prompt =
      "Compaction retry mutating tool check: read COMPACTION_RETRY_CONTEXT.md, then create compaction-retry-summary.txt and keep replay safety explicit.";
    const writePlan = await fetch(`${server.baseUrl}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        stream: true,
        model: "gpt-5.6-luna",
        input: [
          makeUserInput(prompt),
          {
            type: "function_call_output",
            output: "compaction retry evidence block 0000\ncompaction retry evidence block 0001",
          },
          makeUserInput("Continue after compaction."),
        ],
      }),
    });
    expect(writePlan.status).toBe(200);
    expect(await writePlan.text()).toContain('"name":"write"');

    const contextOnlyWritePlan = await fetch(`${server.baseUrl}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        stream: true,
        model: "gpt-5.6-luna",
        input: [
          {
            type: "function_call_output",
            output: "compaction retry evidence block 0000\ncompaction retry evidence block 0001",
          },
          makeUserInput("Continue after compaction."),
        ],
      }),
    });
    expect(contextOnlyWritePlan.status).toBe(200);
    expect(await contextOnlyWritePlan.text()).toContain('"name":"write"');

    const finalReply = await fetch(`${server.baseUrl}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        stream: false,
        model: "gpt-5.6-luna",
        input: [
          makeUserInput(prompt),
          {
            type: "function_call_output",
            output: "Successfully wrote 41 bytes to compaction-retry-summary.txt.",
          },
          makeUserInput("Continue after compaction."),
        ],
      }),
    });
    expect(finalReply.status).toBe(200);
    expect(outputText(await finalReply.json())).toContain("replay unsafe after write");
  });

  it("supports exact reply memory prompts and embeddings requests", async () => {
    const server = await startQaMockOpenAiServer({
      host: "127.0.0.1",
      port: 0,
    });
    cleanups.push(async () => {
      await server.stop();
    });

    const remember = await fetch(`${server.baseUrl}/v1/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        stream: false,
        input: [
          {
            role: "user",
            content: [
              {
                type: "input_text",
                text: "Please remember this fact for later: the QA canary code is ALPHA-7. Reply exactly `Remembered ALPHA-7.` once stored.",
              },
            ],
          },
        ],
      }),
    });
    expect(remember.status).toBe(200);
    const rememberPayload = (await remember.json()) as {
      output?: Array<{ content?: Array<{ text?: string }> }>;
    };
    expect(rememberPayload.output?.[0]?.content?.[0]?.text).toBe("Remembered ALPHA-7.");

    const embeddings = await fetch(`${server.baseUrl}/v1/embeddings`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "text-embedding-3-small",
        input: ["Project Nebula ORBIT-10", "Project Nebula ORBIT-9"],
      }),
    });
    expect(embeddings.status).toBe(200);
    const embeddingPayload = (await embeddings.json()) as {
      data?: Array<{ embedding?: number[]; index?: number }>;
      model?: string;
    };
    expect(embeddingPayload.model).toBe("text-embedding-3-small");
    expect(embeddingPayload.data).toHaveLength(2);
    expect(embeddingPayload.data?.map((item) => item.index)).toStrictEqual([0, 1]);
    expect(embeddingPayload.data?.map((item) => item.embedding?.length)).toStrictEqual([16, 16]);
  });

  it("requests non-threaded subagent handoff for QA channel runs", async () => {
    const server = await startQaMockOpenAiServer({
      host: "127.0.0.1",
      port: 0,
    });
    cleanups.push(async () => {
      await server.stop();
    });

    const response = await fetch(`${server.baseUrl}/v1/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        stream: true,
        tools: [SESSIONS_SPAWN_TOOL],
        input: [
          {
            role: "user",
            content: [
              {
                type: "input_text",
                text: "Delegate a bounded QA task to a subagent, then summarize the delegated result clearly.",
              },
            ],
          },
        ],
      }),
    });
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain('"name":"sessions_spawn"');
    expect(body).toContain('\\"label\\":\\"qa-sidecar\\"');
    expect(body).toContain('\\"thread\\":false');
  });

  it("emits explicitly requested sessions_spawn tool calls", async () => {
    const server = await startMockServer();

    const body = await expectResponsesText(server, {
      stream: true,
      tools: [SESSIONS_SPAWN_TOOL],
      input: [
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: explicitSessionsSpawnPrompt("QA_SUBAGENT_CHILD_FIXED"),
            },
          ],
        },
      ],
    });
    expect(body).toContain('"name":"sessions_spawn"');
    expect(body).toContain('\\"label\\":\\"qa-thread-subagent\\"');
    expect(body).toContain('\\"thread\\":true');
    expect(body).toContain('\\"mode\\":\\"session\\"');
    expect(body).toContain("QA_SUBAGENT_CHILD_FIXED");
  });

  it("records planned sessions_spawn arguments for forked-context QA assertions", async () => {
    const server = await startMockServer();

    await expectResponsesText(server, {
      stream: true,
      tools: [SESSIONS_SPAWN_TOOL],
      input: [
        makeUserInput(
          'Forked subagent context QA check. Use sessions_spawn task="Report the visible code" label=qa-fork-context context=fork mode=run.',
        ),
      ],
    });

    const debugResponse = await fetch(`${server.baseUrl}/debug/last-request`);
    expect(debugResponse.status).toBe(200);
    const debugPayload = requireRecord(await debugResponse.json(), "debug request");
    expect(debugPayload.plannedToolName).toBe("sessions_spawn");
    const plannedToolArgs = requireRecord(debugPayload.plannedToolArgs, "planned tool args");
    expect(plannedToolArgs.task).toBe("Report the visible code");
    expect(plannedToolArgs.label).toBe("qa-fork-context");
    expect(plannedToolArgs.context).toBe("fork");
    expect(plannedToolArgs.mode).toBe("run");
  });

  it("drives yielded-parent subagent fallback QA through sessions_spawn and sessions_yield", async () => {
    const server = await startMockServer();
    const prompt =
      "Subagent direct fallback QA check: spawn one worker and yield until QA-SUBAGENT-DIRECT-FALLBACK-OK is delivered.";

    await expectResponsesText(server, {
      stream: true,
      tools: [SESSIONS_SPAWN_TOOL, SESSIONS_YIELD_TOOL],
      input: [makeUserInput(prompt)],
    });

    const spawnDebug = requireRecord(
      await (await fetch(`${server.baseUrl}/debug/last-request`)).json(),
      "spawn debug request",
    );
    expect(spawnDebug.plannedToolName).toBe("sessions_spawn");
    const spawnArgs = requireRecord(spawnDebug.plannedToolArgs, "spawn planned tool args");
    expect(spawnArgs.label).toBe("qa-direct-fallback-worker");
    expect(spawnArgs.thread).toBe(false);
    expect(spawnArgs.mode).toBe("run");
    expect(spawnArgs).not.toHaveProperty("runTimeoutSeconds");

    const body = await expectResponsesText(server, {
      stream: true,
      tools: [SESSIONS_SPAWN_TOOL, SESSIONS_YIELD_TOOL],
      input: [
        makeUserInput(prompt),
        {
          type: "function_call_output",
          call_id: "call_mock_sessions_spawn_1",
          output: JSON.stringify({
            status: "accepted",
            childSessionKey: "agent:qa:subagent:child",
            runId: "run-child-1",
          }),
        },
      ],
    });

    expect(body).toContain('"name":"sessions_yield"');
    expect(body).toContain("QA-SUBAGENT-DIRECT-FALLBACK-OK");
    const yieldDebug = requireRecord(
      await (await fetch(`${server.baseUrl}/debug/last-request`)).json(),
      "yield debug request",
    );
    expect(yieldDebug.plannedToolName).toBe("sessions_yield");
  });

  it("returns no visible announce output for the direct fallback QA marker", async () => {
    const server = await startMockServer();

    const body = await expectResponsesJson<{
      output?: Array<{ content?: Array<{ text?: string }> }>;
    }>(server, {
      stream: false,
      input: [
        makeUserInput(
          [
            "[Internal task completion event]",
            "Task: qa-direct-fallback-worker",
            "Result: QA-SUBAGENT-DIRECT-FALLBACK-OK",
          ].join("\n"),
        ),
      ],
    });

    expect(body.output?.[0]?.content?.[0]?.text).toBe("");
  });

  it("surfaces sessions_spawn tool errors instead of echoing child-task tokens", async () => {
    const server = await startMockServer();

    const body = await expectResponsesJson<{
      output?: Array<{ content?: Array<{ text?: string }> }>;
    }>(server, {
      stream: false,
      tools: [SESSIONS_SPAWN_TOOL],
      input: [
        makeUserInput(explicitSessionsSpawnPrompt(THREAD_SUBAGENT_CHILD_ERROR_TOKEN)),
        {
          type: "function_call",
          name: "sessions_spawn",
          arguments: JSON.stringify({
            task: threadSubagentTask(THREAD_SUBAGENT_CHILD_ERROR_TOKEN),
            label: "qa-thread-subagent",
            thread: true,
            mode: "session",
          }),
        },
        {
          type: "function_call_output",
          output: JSON.stringify({
            status: "error",
            error: THREAD_SUBAGENT_TOOL_ERROR,
          }),
        },
      ],
    });

    const text = body.output?.[0]?.content?.[0]?.text ?? "";
    expect(text).toContain(THREAD_SUBAGENT_TOOL_ERROR);
    expect(text).not.toContain(THREAD_SUBAGENT_CHILD_ERROR_TOKEN);
  });

  it("does not echo child-task tokens after sessions_spawn accepts the request", async () => {
    const server = await startMockServer();
    const childToken = "QA_SUBAGENT_CHILD_ACCEPTED";

    const body = await expectResponsesJson<{
      output?: Array<{ content?: Array<{ text?: string }> }>;
    }>(server, {
      stream: false,
      tools: [SESSIONS_SPAWN_TOOL],
      input: [
        makeUserInput(explicitSessionsSpawnPrompt(childToken)),
        {
          type: "function_call",
          name: "sessions_spawn",
          arguments: JSON.stringify({
            task: threadSubagentTask(childToken),
            label: "qa-thread-subagent",
            thread: true,
            mode: "session",
          }),
        },
        {
          type: "function_call_output",
          output: JSON.stringify({
            status: "accepted",
            threadRootEventId: "$thread-root",
          }),
        },
      ],
    });

    const text = body.output?.[0]?.content?.[0]?.text ?? "";
    expect(text).toContain("Protocol note");
    expect(text).not.toContain(childToken);
  });

  it("lets child subagent prompts finish with an exact token", async () => {
    const server = await startMockServer();
    const childToken = "QA_SUBAGENT_CHILD_DIRECT";

    const childPayload = await expectResponsesJson<{
      output?: Array<{ content?: Array<{ text?: string }> }>;
    }>(server, {
      stream: false,
      input: [makeUserInput(threadSubagentTask(childToken))],
    });
    expect(outputText(childPayload)).toBe(childToken);
  });

  it("plans memory tools and serves mock image generations", async () => {
    const server = await startQaMockOpenAiServer({
      host: "127.0.0.1",
      port: 0,
    });
    cleanups.push(async () => {
      await server.stop();
    });

    const memorySearch = await fetch(`${server.baseUrl}/v1/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        stream: true,
        input: [
          {
            role: "user",
            content: [
              {
                type: "input_text",
                text: "Memory tools check: what is the hidden project codename stored only in memory? Use memory tools first.",
              },
            ],
          },
        ],
      }),
    });
    expect(memorySearch.status).toBe(200);
    expect(await memorySearch.text()).toContain('"name":"memory_search"');

    const memoryGetFromPathOnlySearchResult = await fetch(`${server.baseUrl}/v1/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        stream: true,
        input: [
          {
            role: "user",
            content: [
              {
                type: "input_text",
                text: "Memory tools check: what is the hidden project codename stored only in memory? Use memory tools first.",
              },
            ],
          },
          {
            type: "function_call_output",
            output: JSON.stringify({
              results: [
                {
                  path: "MEMORY.md",
                  snippet: "Hidden QA fact: the project codename is ORBIT-9.",
                },
              ],
            }),
          },
          {
            role: "user",
            content: [
              {
                type: "input_text",
                text: "Protocol note: acknowledged. Continue with the QA scenario plan.",
              },
            ],
          },
        ],
      }),
    });
    expect(memoryGetFromPathOnlySearchResult.status).toBe(200);
    const memoryGetText = await memoryGetFromPathOnlySearchResult.text();
    expect(memoryGetText).toContain('"name":"memory_get"');
    expect(memoryGetText).toContain('\\"path\\":\\"MEMORY.md\\"');
    expect(memoryGetText).toContain('\\"from\\":1');

    const image = await fetch(`${server.baseUrl}/v1/images/generations`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-image-1",
        prompt: "Draw a QA lighthouse",
        n: 1,
        size: "1024x1024",
      }),
    });
    expect(image.status).toBe(200);
    const imagePayload = requireRecord(await image.json(), "image response");
    const imageData = requireArray(imagePayload.data, "image data");
    expect(typeof requireRecord(imageData[0], "image data 0").b64_json).toBe("string");

    const imageRequests = await fetch(`${server.baseUrl}/debug/image-generations`);
    expect(imageRequests.status).toBe(200);
    const imageRequestLog = requireArray(await imageRequests.json(), "image generation requests");
    const imageRequest = requireRecord(imageRequestLog[0], "image generation request 0");
    expect(imageRequest.model).toBe("gpt-image-1");
    expect(imageRequest.prompt).toBe("Draw a QA lighthouse");
    expect(imageRequest.n).toBe(1);
    expect(imageRequest.size).toBe("1024x1024");
  });

  it("supports advanced QA memory and subagent recovery prompts", async () => {
    const server = await startQaMockOpenAiServer({
      host: "127.0.0.1",
      port: 0,
    });
    cleanups.push(async () => {
      await server.stop();
    });

    const memory = await fetch(`${server.baseUrl}/v1/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        stream: true,
        input: [
          {
            role: "user",
            content: [
              {
                type: "input_text",
                text: "Session memory ranking check: what is the current Project Nebula codename? Use memory tools first.",
              },
            ],
          },
        ],
      }),
    });
    expect(memory.status).toBe(200);
    const memoryText = await memory.text();
    expect(memoryText).toContain('"name":"memory_search"');
    expect(memoryText).toContain('\\"corpus\\":\\"sessions\\"');

    const threadMemorySearch = await fetch(`${server.baseUrl}/v1/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        stream: true,
        instructions:
          "@openclaw Thread memory check: what is the hidden thread codename stored only in memory? Use memory tools first and reply only in this thread.",
        input: [
          {
            role: "user",
            content: [
              {
                type: "input_text",
                text: "Protocol note: acknowledged. Continue with the QA scenario plan.",
              },
            ],
          },
        ],
      }),
    });
    expect(threadMemorySearch.status).toBe(200);
    const threadMemorySearchText = await threadMemorySearch.text();
    expect(threadMemorySearchText).toContain('"name":"memory_search"');
    expect(threadMemorySearchText).toContain("ORBIT-22");

    const threadMemorySummary = await fetch(`${server.baseUrl}/v1/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        stream: false,
        instructions:
          "@openclaw Thread memory check: what is the hidden thread codename stored only in memory? Use memory tools first and reply only in this thread.",
        input: [
          {
            type: "function_call_output",
            output: JSON.stringify({
              text: "Thread-hidden codename: ORBIT-22.",
            }),
          },
          {
            role: "user",
            content: [
              {
                type: "input_text",
                text: "Protocol note: acknowledged. Continue with the QA scenario plan.",
              },
            ],
          },
        ],
      }),
    });
    expect(threadMemorySummary.status).toBe(200);
    expect(JSON.stringify(await threadMemorySummary.json())).toContain("ORBIT-22");

    const structuredThreadMemorySummary = await fetch(`${server.baseUrl}/v1/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        stream: false,
        instructions:
          "@openclaw Thread memory check: what is the hidden thread codename stored only in memory? Use memory tools first and reply only in this thread.",
        input: [
          {
            type: "function_call_output",
            output: {
              text: "Thread-hidden codename: ORBIT-22.",
            },
          },
          {
            role: "user",
            content: [
              {
                type: "input_text",
                text: "Protocol note: acknowledged. Continue with the QA scenario plan.",
              },
            ],
          },
        ],
      }),
    });
    expect(structuredThreadMemorySummary.status).toBe(200);
    expect(JSON.stringify(await structuredThreadMemorySummary.json())).toContain("ORBIT-22");

    const systemFallbackThreadMemorySummary = await fetch(`${server.baseUrl}/v1/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        stream: false,
        input: [
          {
            role: "system",
            content:
              "Available tools include sessions_spawn.\n## /workspace/MEMORY.md\nThread-hidden codename: ORBIT-22.",
          },
          makeUserInput(
            "@openclaw Thread memory check: what is the hidden thread codename stored only in memory? Use memory tools first and reply only in this thread.",
          ),
          {
            type: "function_call_output",
            output: JSON.stringify({
              results: [],
              unavailable: true,
              error: "database is not open",
            }),
          },
        ],
      }),
    });
    expect(systemFallbackThreadMemorySummary.status).toBe(200);
    expect(JSON.stringify(await systemFallbackThreadMemorySummary.json())).toContain("ORBIT-22");

    const memoryFollowup = await fetch(`${server.baseUrl}/v1/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        stream: true,
        input: [
          {
            role: "user",
            content: [
              {
                type: "input_text",
                text: "Session memory ranking check: what is the current Project Nebula codename? Use memory tools first.",
              },
            ],
          },
          {
            type: "function_call_output",
            output: JSON.stringify({
              results: [
                {
                  path: "sessions/qa-session-memory-ranking.jsonl",
                  startLine: 2,
                  endLine: 3,
                },
              ],
            }),
          },
        ],
      }),
    });
    expect(memoryFollowup.status).toBe(200);
    expect(await memoryFollowup.text()).toContain(
      "Protocol note: I checked memory and the current Project Nebula codename is ORBIT-10.",
    );

    const memoryFollowupPrefersSessionResult = await fetch(`${server.baseUrl}/v1/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        stream: true,
        input: [
          {
            role: "user",
            content: [
              {
                type: "input_text",
                text: "Session memory ranking check: what is the current Project Nebula codename? Use memory tools first.",
              },
            ],
          },
          {
            type: "function_call_output",
            output: JSON.stringify({
              results: [
                {
                  path: "MEMORY.md",
                  startLine: 1,
                  endLine: 2,
                },
                {
                  path: "sessions/qa-session-memory-ranking.jsonl",
                  startLine: 2,
                  endLine: 3,
                },
              ],
            }),
          },
        ],
      }),
    });
    expect(memoryFollowupPrefersSessionResult.status).toBe(200);
    expect(await memoryFollowupPrefersSessionResult.text()).toContain(
      "Protocol note: I checked memory and the current Project Nebula codename is ORBIT-10.",
    );

    const activeMemorySearch = await fetch(`${server.baseUrl}/v1/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        stream: true,
        input: [
          {
            role: "user",
            content: [
              {
                type: "input_text",
                text: [
                  "You are a memory search agent.",
                  "Use only the available memory tools.",
                  "Prefer memory_recall when available.",
                  "If memory_recall is unavailable, use memory_search and memory_get.",
                  "",
                  "Conversation context:",
                  "Latest user message:",
                  "Silent snack recall check: what snack do I usually want for QA movie night? Reply in one short sentence.",
                ].join("\n"),
              },
            ],
          },
        ],
      }),
    });
    expect(activeMemorySearch.status).toBe(200);
    expect(await activeMemorySearch.text()).toContain('"name":"memory_search"');

    const activeMemoryStreamSummary = await fetch(`${server.baseUrl}/v1/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        stream: true,
        input: [
          {
            role: "user",
            content: [
              {
                type: "input_text",
                text: [
                  "You are a memory search agent.",
                  "Use only the available memory tools.",
                  "Prefer memory_recall when available.",
                  "If memory_recall is unavailable, use memory_search and memory_get.",
                  "",
                  "Conversation context:",
                  "Latest user message:",
                  "Silent snack recall check: what snack do I usually want for QA movie night? Reply in one short sentence.",
                ].join("\n"),
              },
            ],
          },
          {
            type: "function_call_output",
            output: JSON.stringify({
              text: "Stable QA movie night snack preference: lemon pepper wings with blue cheese.",
            }),
          },
        ],
      }),
    });
    expect(activeMemoryStreamSummary.status).toBe(200);
    expect(await activeMemoryStreamSummary.text()).toContain("lemon pepper wings with blue cheese");

    const activeMemorySummary = await fetch(`${server.baseUrl}/v1/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        stream: false,
        input: [
          {
            role: "user",
            content: [
              {
                type: "input_text",
                text: [
                  "You are a memory search agent.",
                  "Use only the available memory tools.",
                  "Prefer memory_recall when available.",
                  "If memory_recall is unavailable, use memory_search and memory_get.",
                  "",
                  "Conversation context:",
                  "Latest user message:",
                  "Silent snack recall check: what snack do I usually want for QA movie night? Reply in one short sentence.",
                ].join("\n"),
              },
            ],
          },
          {
            type: "function_call_output",
            output: JSON.stringify({
              text: "Stable QA movie night snack preference: lemon pepper wings with blue cheese.",
            }),
          },
        ],
      }),
    });
    expect(activeMemorySummary.status).toBe(200);
    expect(JSON.stringify(await activeMemorySummary.json())).toContain(
      "lemon pepper wings with blue cheese",
    );

    const injectedMainReply = await fetch(`${server.baseUrl}/v1/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        stream: false,
        instructions: [
          "System context:",
          "<active_memory_plugin>User usually wants lemon pepper wings with blue cheese for QA movie night.</active_memory_plugin>",
        ].join("\n"),
        input: [
          {
            role: "user",
            content: [
              {
                type: "input_text",
                text: "Silent snack recall check: what snack do I usually want for QA movie night? Reply in one short sentence.",
              },
            ],
          },
        ],
      }),
    });
    expect(injectedMainReply.status).toBe(200);
    expect(JSON.stringify(await injectedMainReply.json())).toContain(
      "lemon pepper wings with blue cheese",
    );
    const lastRequest = await fetch(`${server.baseUrl}/debug/last-request`);
    expect(lastRequest.status).toBe(200);
    const lastRequestPayload = requireRecord(await lastRequest.json(), "last request");
    expect(String(lastRequestPayload.instructions)).toContain("<active_memory_plugin>");
    expect(String(lastRequestPayload.allInputText)).toContain("<active_memory_plugin>");

    const spawn = await fetch(`${server.baseUrl}/v1/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        stream: true,
        tools: [SESSIONS_SPAWN_TOOL],
        input: [
          {
            role: "user",
            content: [
              {
                type: "input_text",
                text: "Subagent fanout synthesis check: delegate two bounded subagents sequentially, then report both results together.",
              },
            ],
          },
        ],
      }),
    });
    expect(spawn.status).toBe(200);
    const spawnBody = await spawn.text();
    expect(spawnBody).toContain('"name":"sessions_spawn"');
    expect(spawnBody).toContain('\\"label\\":\\"qa-fanout-alpha\\"');

    const secondSpawn = await fetch(`${server.baseUrl}/v1/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        stream: true,
        tools: [SESSIONS_SPAWN_TOOL],
        input: [
          {
            role: "user",
            content: [
              {
                type: "input_text",
                text: "Subagent fanout synthesis check: delegate two bounded subagents sequentially, then report both results together.",
              },
            ],
          },
          {
            type: "function_call_output",
            output:
              '{"status":"accepted","childSessionKey":"agent:qa:subagent:alpha","note":"ALPHA-OK"}',
          },
        ],
      }),
    });
    expect(secondSpawn.status).toBe(200);
    const secondSpawnBody = await secondSpawn.text();
    expect(secondSpawnBody).toContain('"name":"sessions_spawn"');
    expect(secondSpawnBody).toContain('\\"label\\":\\"qa-fanout-beta\\"');

    const final = await fetch(`${server.baseUrl}/v1/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        stream: false,
        tools: [SESSIONS_SPAWN_TOOL],
        input: [
          {
            role: "user",
            content: [
              {
                type: "input_text",
                text: "Subagent fanout synthesis check: delegate two bounded subagents sequentially, then report both results together.",
              },
            ],
          },
          {
            type: "function_call_output",
            output:
              '{"status":"accepted","childSessionKey":"agent:qa:subagent:beta","note":"BETA-OK"}',
          },
        ],
      }),
    });
    expect(final.status).toBe(200);
    expect(outputText(await final.json())).toBe("subagent-1: ok\nsubagent-2: ok");
  });

  it("completes subagent fanout from a continuation turn without tool output", async () => {
    const server = await startQaMockOpenAiServer({
      host: "127.0.0.1",
      port: 0,
    });
    cleanups.push(async () => {
      await server.stop();
    });

    const prompt =
      "Subagent fanout synthesis check: delegate two bounded subagents sequentially, then report both results together.";
    const spawn = await fetch(`${server.baseUrl}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        stream: true,
        tools: [SESSIONS_SPAWN_TOOL],
        input: [{ role: "user", content: [{ type: "input_text", text: prompt }] }],
      }),
    });
    expect(spawn.status).toBe(200);
    expect(await spawn.text()).toContain('\\"label\\":\\"qa-fanout-alpha\\"');

    const secondSpawn = await fetch(`${server.baseUrl}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        stream: true,
        tools: [SESSIONS_SPAWN_TOOL],
        input: [
          { role: "user", content: [{ type: "input_text", text: prompt }] },
          {
            type: "function_call_output",
            output:
              '{"status":"accepted","childSessionKey":"agent:qa:subagent:alpha","note":"ALPHA-OK"}',
          },
        ],
      }),
    });
    expect(secondSpawn.status).toBe(200);
    expect(await secondSpawn.text()).toContain('\\"label\\":\\"qa-fanout-beta\\"');

    const phaseOnlyFinal = await fetch(`${server.baseUrl}/v1/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        stream: false,
        tools: [SESSIONS_SPAWN_TOOL],
        input: [
          {
            role: "user",
            content: [
              {
                type: "input_text",
                text: "Continue.",
              },
            ],
          },
        ],
      }),
    });
    expect(phaseOnlyFinal.status).toBe(200);
    expect(outputText(await phaseOnlyFinal.json())).toBe("subagent-1: ok\nsubagent-2: ok");
  });

  it("completes subagent fanout when beta completion arrives on a generic follow-up turn", async () => {
    const server = await startQaMockOpenAiServer({
      host: "127.0.0.1",
      port: 0,
    });
    cleanups.push(async () => {
      await server.stop();
    });

    const prompt =
      "Subagent fanout synthesis check: delegate two bounded subagents sequentially, then report both results together.";
    const spawn = await fetch(`${server.baseUrl}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        stream: true,
        tools: [SESSIONS_SPAWN_TOOL],
        input: [makeUserInput(prompt)],
      }),
    });
    expect(spawn.status).toBe(200);
    expect(await spawn.text()).toContain('\\"label\\":\\"qa-fanout-alpha\\"');

    const secondSpawn = await fetch(`${server.baseUrl}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        stream: true,
        tools: [SESSIONS_SPAWN_TOOL],
        input: [
          makeUserInput(prompt),
          {
            type: "function_call_output",
            output:
              '{"status":"accepted","childSessionKey":"agent:qa:subagent:alpha","note":"ALPHA-OK"}',
          },
        ],
      }),
    });
    expect(secondSpawn.status).toBe(200);
    expect(await secondSpawn.text()).toContain('\\"label\\":\\"qa-fanout-beta\\"');

    const final = await fetch(`${server.baseUrl}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        stream: false,
        tools: [SESSIONS_SPAWN_TOOL],
        input: [
          makeUserInput(
            "Continue with the QA scenario plan and report grouped into Worked, Failed, Blocked, and Follow-up.",
          ),
          {
            type: "function_call_output",
            output: '{"status":"accepted","childSessionKey":"agent:qa:subagent:beta"}',
          },
        ],
      }),
    });
    expect(final.status).toBe(200);
    expect(outputText(await final.json())).toBe("subagent-1: ok\nsubagent-2: ok");
  });

  it("uses full request text when planning continuation subagent tool calls", async () => {
    const server = await startQaMockOpenAiServer({
      host: "127.0.0.1",
      port: 0,
    });
    cleanups.push(async () => {
      await server.stop();
    });

    const handoffPrompt =
      "Delegate one bounded QA task to a subagent. Wait for the subagent to finish.";
    const handoff = await fetch(`${server.baseUrl}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        stream: true,
        tools: [SESSIONS_SPAWN_TOOL],
        input: [makeUserInput(handoffPrompt), makeUserInput("Continue.")],
      }),
    });
    expect(handoff.status).toBe(200);
    expect(await handoff.text()).toContain('"name":"sessions_spawn"');

    const handoffServer = await startQaMockOpenAiServer({
      host: "127.0.0.1",
      port: 0,
    });
    cleanups.push(async () => {
      await handoffServer.stop();
    });

    const appServerHandoff = await fetch(`${handoffServer.baseUrl}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        stream: true,
        input: [makeUserInput(handoffPrompt), makeUserInput("Continue.")],
      }),
    });
    expect(appServerHandoff.status).toBe(200);
    expect(await appServerHandoff.text()).toContain('"name":"sessions_spawn"');

    const repeatedHandoff = await fetch(`${handoffServer.baseUrl}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        stream: true,
        input: [makeUserInput(handoffPrompt), makeUserInput("Continue again.")],
      }),
    });
    expect(repeatedHandoff.status).toBe(200);
    expect(await repeatedHandoff.text()).not.toContain('"name":"sessions_spawn"');

    const handoffFinal = await fetch(`${server.baseUrl}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        stream: false,
        tools: [SESSIONS_SPAWN_TOOL],
        input: [
          makeUserInput(handoffPrompt),
          { type: "function_call_output", output: "SUBAGENT-OK" },
          makeUserInput("Continue."),
        ],
      }),
    });
    expect(handoffFinal.status).toBe(200);
    expect(outputText(await handoffFinal.json())).toContain("Delegated task");

    const fanoutPrompt =
      "Subagent fanout synthesis check: delegate two bounded subagents sequentially, then report both results together.";
    const appServerFanout = await fetch(`${server.baseUrl}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        stream: true,
        input: [makeUserInput(fanoutPrompt), makeUserInput("Continue.")],
      }),
    });
    expect(appServerFanout.status).toBe(200);
    expect(await appServerFanout.text()).toContain('\\"label\\":\\"qa-fanout-alpha\\"');

    const fanoutServer = await startQaMockOpenAiServer({
      host: "127.0.0.1",
      port: 0,
    });
    cleanups.push(async () => {
      await fanoutServer.stop();
    });

    const firstFanout = await fetch(`${fanoutServer.baseUrl}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        stream: true,
        tools: [SESSIONS_SPAWN_TOOL],
        input: [makeUserInput(fanoutPrompt)],
      }),
    });
    expect(firstFanout.status).toBe(200);
    expect(await firstFanout.text()).toContain('\\"label\\":\\"qa-fanout-alpha\\"');

    const secondFanout = await fetch(`${fanoutServer.baseUrl}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        stream: true,
        tools: [SESSIONS_SPAWN_TOOL],
        input: [
          makeUserInput(fanoutPrompt),
          {
            type: "function_call_output",
            output:
              '{"status":"accepted","childSessionKey":"agent:qa:subagent:alpha","note":"ALPHA-OK"}',
          },
          makeUserInput("Continue."),
        ],
      }),
    });
    expect(secondFanout.status).toBe(200);
    expect(await secondFanout.text()).toContain('\\"label\\":\\"qa-fanout-beta\\"');
  });

  it("keeps source discovery reports out of subagent handoff prose", async () => {
    const server = await startQaMockOpenAiServer({
      host: "127.0.0.1",
      port: 0,
    });
    cleanups.push(async () => {
      await server.stop();
    });

    const response = await fetch(`${server.baseUrl}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        stream: false,
        input: [
          makeUserInput(
            "Read the seeded docs and source plan, then report grouped into Worked, Failed, Blocked, and Follow-up.",
          ),
          {
            type: "function_call_output",
            output:
              "repo/qa/scenarios/index.yaml includes scenario: subagent-handoff and repo/extensions/qa-lab/src/suite.ts.",
          },
          makeUserInput("Continue."),
        ],
      }),
    });

    expect(response.status).toBe(200);
    const text = outputText(await response.json());
    expect(text).toContain("Worked:");
    expect(text).toContain("repo/docs/help/testing.md");
    expect(text).toContain("Follow-up:");
    expect(text).not.toContain("Delegated task");
  });

  it("does not let fanout completion state hijack child worker replies", async () => {
    const server = await startQaMockOpenAiServer({
      host: "127.0.0.1",
      port: 0,
    });
    cleanups.push(async () => {
      await server.stop();
    });

    const prompt =
      "Subagent fanout synthesis check: delegate two bounded subagents sequentially, then report both results together.";
    const spawn = await fetch(`${server.baseUrl}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        stream: true,
        tools: [SESSIONS_SPAWN_TOOL],
        input: [{ role: "user", content: [{ type: "input_text", text: prompt }] }],
      }),
    });
    expect(spawn.status).toBe(200);
    expect(await spawn.text()).toContain('\\"label\\":\\"qa-fanout-alpha\\"');

    const secondSpawn = await fetch(`${server.baseUrl}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        stream: true,
        tools: [SESSIONS_SPAWN_TOOL],
        input: [
          { role: "user", content: [{ type: "input_text", text: prompt }] },
          {
            type: "function_call_output",
            output:
              '{"status":"accepted","childSessionKey":"agent:qa:subagent:alpha","note":"ALPHA-OK"}',
          },
        ],
      }),
    });
    expect(secondSpawn.status).toBe(200);
    expect(await secondSpawn.text()).toContain('\\"label\\":\\"qa-fanout-beta\\"');

    const childReply = await fetch(`${server.baseUrl}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        stream: false,
        input: [
          {
            role: "user",
            content: [
              {
                type: "input_text",
                text: "Fanout worker alpha: inspect the QA workspace and finish with exactly ALPHA-OK.",
              },
            ],
          },
        ],
      }),
    });
    expect(childReply.status).toBe(200);
    expect(outputText(await childReply.json())).toBe("ALPHA-OK");
  });

  it("keeps subagent fanout state isolated per mock server instance", async () => {
    const serverA = await startQaMockOpenAiServer({
      host: "127.0.0.1",
      port: 0,
    });
    cleanups.push(async () => {
      await serverA.stop();
    });
    const serverB = await startQaMockOpenAiServer({
      host: "127.0.0.1",
      port: 0,
    });
    cleanups.push(async () => {
      await serverB.stop();
    });

    const prompt =
      "Subagent fanout synthesis check: delegate two bounded subagents sequentially, then report both results together.";

    const firstA = await fetch(`${serverA.baseUrl}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        stream: true,
        tools: [SESSIONS_SPAWN_TOOL],
        input: [{ role: "user", content: [{ type: "input_text", text: prompt }] }],
      }),
    });
    expect(firstA.status).toBe(200);
    expect(await firstA.text()).toContain('\\"label\\":\\"qa-fanout-alpha\\"');

    const firstB = await fetch(`${serverB.baseUrl}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        stream: true,
        tools: [SESSIONS_SPAWN_TOOL],
        input: [{ role: "user", content: [{ type: "input_text", text: prompt }] }],
      }),
    });
    expect(firstB.status).toBe(200);
    expect(await firstB.text()).toContain('\\"label\\":\\"qa-fanout-alpha\\"');
  });

  it("answers heartbeat prompts without spawning extra subagents", async () => {
    const server = await startQaMockOpenAiServer({
      host: "127.0.0.1",
      port: 0,
    });
    cleanups.push(async () => {
      await server.stop();
    });

    const response = await fetch(`${server.baseUrl}/v1/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        stream: false,
        input: [
          {
            role: "user",
            content: [
              {
                type: "input_text",
                text: "System: Gateway restart config-apply ok\nSystem: QA-SUBAGENT-RECOVERY-1234\n\nRead HEARTBEAT.md if it exists (workspace context). Follow it strictly. Do not infer or repeat old tasks from prior chats. If nothing needs attention, reply HEARTBEAT_OK.",
              },
            ],
          },
        ],
      }),
    });

    expect(response.status).toBe(200);
    expect(outputText(await response.json())).toBe("HEARTBEAT_OK");
  });

  it("returns exact markers for visible and hot-installed skills", async () => {
    const server = await startQaMockOpenAiServer({
      host: "127.0.0.1",
      port: 0,
    });
    cleanups.push(async () => {
      await server.stop();
    });

    const visible = await fetch(`${server.baseUrl}/v1/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        stream: false,
        input: [
          {
            role: "user",
            content: [
              {
                type: "input_text",
                text: "Visible skill marker: give me the visible skill marker exactly.",
              },
            ],
          },
        ],
      }),
    });
    expect(visible.status).toBe(200);
    expect(outputText(await visible.json())).toBe("VISIBLE-SKILL-OK");

    const hot = await fetch(`${server.baseUrl}/v1/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        stream: false,
        input: [
          {
            role: "user",
            content: [
              {
                type: "input_text",
                text: "Hot install marker: give me the hot install marker exactly.",
              },
            ],
          },
        ],
      }),
    });
    expect(hot.status).toBe(200);
    expect(outputText(await hot.json())).toBe("HOT-INSTALL-OK");
  });

  it("uses the latest exact marker directive from conversation history", async () => {
    const server = await startQaMockOpenAiServer({
      host: "127.0.0.1",
      port: 0,
    });
    cleanups.push(async () => {
      await server.stop();
    });

    const response = await fetch(`${server.baseUrl}/v1/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        stream: false,
        input: [
          {
            role: "user",
            content: [
              {
                type: "input_text",
                text: "Earlier turn: reply with only this exact marker: OLD_TOKEN",
              },
            ],
          },
          {
            role: "user",
            content: [
              {
                type: "input_text",
                text: "Current turn: reply with only this exact marker: NEW_TOKEN",
              },
            ],
          },
        ],
      }),
    });

    expect(response.status).toBe(200);
    expect(outputText(await response.json())).toBe("NEW_TOKEN");
  });

  it("requires both WhatsApp batched markers before returning the final batched marker", async () => {
    const server = await startQaMockOpenAiServer({
      host: "127.0.0.1",
      port: 0,
    });
    cleanups.push(async () => {
      await server.stop();
    });

    const standalone = await fetch(`${server.baseUrl}/v1/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        stream: false,
        input: [
          {
            role: "user",
            content: [
              {
                type: "input_text",
                text:
                  "Second batched WhatsApp QA message. Reply with only this exact marker: " +
                  "WHATSAPP_QA_BATCHED_FINAL_TEST only if the previous queued message is visible " +
                  "in this same run context.",
              },
            ],
          },
        ],
      }),
    });
    expect(standalone.status).toBe(200);
    expect(outputText(await standalone.json())).toBe("WHATSAPP_QA_BATCHED_MISSING_CONTEXT_TEST");

    const batched = await fetch(`${server.baseUrl}/v1/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        stream: false,
        input: [
          {
            role: "user",
            content: [
              {
                type: "input_text",
                text:
                  "First batched WhatsApp QA message WHATSAPP_QA_BATCHED_FIRST_TEST. " +
                  "Wait for the next message before replying.",
              },
            ],
          },
          {
            role: "user",
            content: [
              {
                type: "input_text",
                text:
                  "Second batched WhatsApp QA message. Reply with only this exact marker: " +
                  "WHATSAPP_QA_BATCHED_FINAL_TEST only if the previous queued message is visible " +
                  "in this same run context.",
              },
            ],
          },
        ],
      }),
    });
    expect(batched.status).toBe(200);
    expect(outputText(await batched.json())).toBe("WHATSAPP_QA_BATCHED_FINAL_TEST");
  });

  it("lets the latest exact marker prompt beat stale Telegram session_status history", async () => {
    const server = await startQaMockOpenAiServer({
      host: "127.0.0.1",
      port: 0,
    });
    cleanups.push(async () => {
      await server.stop();
    });

    const response = await fetch(`${server.baseUrl}/v1/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        stream: false,
        input: [
          {
            role: "user",
            content: [
              {
                type: "input_text",
                text: "Telegram current session_status QA check. Call session_status with sessionKey set to current.",
              },
            ],
          },
          {
            role: "user",
            content: [
              {
                type: "input_text",
                text: "Telegram reply-chain marker QA. Reply exactly: QA-TELEGRAM-REPLY-CHAIN-OK",
              },
            ],
          },
        ],
      }),
    });

    expect(response.status).toBe(200);
    expect(outputText(await response.json())).toBe("QA-TELEGRAM-REPLY-CHAIN-OK");
  });

  it("does not repeat stale Telegram session_status for later ordinary prompts", async () => {
    const server = await startQaMockOpenAiServer({
      host: "127.0.0.1",
      port: 0,
    });
    cleanups.push(async () => {
      await server.stop();
    });

    const response = await fetch(`${server.baseUrl}/v1/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        stream: false,
        input: [
          {
            role: "user",
            content: [
              {
                type: "input_text",
                text: "Telegram current session_status QA check. Call session_status with sessionKey set to current.",
              },
            ],
          },
          {
            role: "user",
            content: [
              {
                type: "input_text",
                text: "@sut Telegram QA mention routing check. Reply with a short acknowledgement.",
              },
            ],
          },
        ],
      }),
    });

    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(JSON.stringify(payload)).not.toContain("QA-TELEGRAM-CURRENT-SESSION");
  });

  it("uses exact marker directives from request context when the latest user text is generic", async () => {
    const server = await startQaMockOpenAiServer({
      host: "127.0.0.1",
      port: 0,
    });
    cleanups.push(async () => {
      await server.stop();
    });

    const response = await fetch(`${server.baseUrl}/v1/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        stream: false,
        input: [
          {
            role: "user",
            content: [
              {
                type: "input_text",
                text: "@qa-sut.example.test reply with only this exact marker: QA_CANARY_TEST",
              },
            ],
          },
          {
            role: "user",
            content: [
              {
                type: "input_text",
                text: "Continue with the QA scenario plan and report worked, failed, and blocked items.",
              },
            ],
          },
        ],
      }),
    });

    expect(response.status).toBe(200);
    expect(outputText(await response.json())).toBe("QA_CANARY_TEST");
  });

  it("prefers Matrix exact marker prompts over quoted silent-reply guidance", async () => {
    const server = await startMockServer();

    const response = await postResponses(server, {
      stream: false,
      instructions: [
        "You are in a Matrix group chat.",
        'If no response is needed, reply with exactly "NO_REPLY" and nothing else.',
      ].join(" "),
      input: [
        makeUserInput(
          "@qa-sut-f28c143f:matrix-qa.test reply with only this exact marker: MATRIX_QA_CANARY_14C3958A",
        ),
      ],
    });

    expect(response.status).toBe(200);
    expect(outputText(await response.json())).toBe("MATRIX_QA_CANARY_14C3958A");
  });

  it("lets current exact replies beat stale exact marker history", async () => {
    const server = await startMockServer();

    const response = await postResponses(server, {
      stream: false,
      input: [
        makeUserInput("Earlier turn: reply with only this exact marker: STALE_MARKER"),
        makeUserInput("Reply exactly: CURRENT_REPLY"),
      ],
    });

    expect(response.status).toBe(200);
    expect(outputText(await response.json())).toBe("CURRENT_REPLY");
  });

  it("uses the previous user instruction when the tail user item is runtime context", async () => {
    const server = await startMockServer();

    const response = await postResponses(server, {
      stream: false,
      input: [
        makeUserInput("Reply exactly: QA_RUNTIME_CONTEXT_CARRIER_OK"),
        makeUserInput(TEST_RUNTIME_CONTEXT_CARRIER),
      ],
    });

    expect(response.status).toBe(200);
    expect(outputText(await response.json())).toBe("QA_RUNTIME_CONTEXT_CARRIER_OK");
  });

  it("uses WhatsApp location markers only for the matching coordinate body", async () => {
    const server = await startMockServer();
    const setupInput = makeUserInput(
      "When a later WhatsApp location message shows 37.774900, -122.419400, " +
        "reply with only this WhatsApp location marker: QA_WHATSAPP_LOCATION_OK. " +
        "Reply with only this exact marker: QA_INITIAL_OK",
    );

    const setupResponse = await postResponses(server, {
      stream: false,
      input: [setupInput],
    });

    const response = await postResponses(server, {
      stream: false,
      input: [setupInput, makeUserInput("📍 37.774900, -122.419400")],
    });

    expect(setupResponse.status).toBe(200);
    expect(outputText(await setupResponse.json())).toBe("QA_INITIAL_OK");
    expect(response.status).toBe(200);
    expect(outputText(await response.json())).toBe("QA_WHATSAPP_LOCATION_OK");
  });

  it("uses WhatsApp contact and sticker markers only for matching structured bodies", async () => {
    const server = await startMockServer();
    const setupInput = makeUserInput(
      "When a later WhatsApp contact message appears, " +
        "reply with only this WhatsApp contact marker: QA_WHATSAPP_CONTACT_OK. " +
        "When a later WhatsApp sticker message appears, " +
        "reply with only this WhatsApp sticker marker: QA_WHATSAPP_STICKER_OK. " +
        "Reply with only this exact marker: QA_STRUCTURED_INITIAL_OK",
    );

    const setupResponse = await postResponses(server, {
      stream: false,
      input: [setupInput],
    });
    const contactResponse = await postResponses(server, {
      stream: false,
      input: [setupInput, makeUserInput("<contact>")],
    });
    const stickerResponse = await postResponses(server, {
      stream: false,
      input: [setupInput, makeUserInput("<media:sticker>")],
    });

    expect(setupResponse.status).toBe(200);
    expect(outputText(await setupResponse.json())).toBe("QA_STRUCTURED_INITIAL_OK");
    expect(contactResponse.status).toBe(200);
    expect(outputText(await contactResponse.json())).toBe("QA_WHATSAPP_CONTACT_OK");
    expect(stickerResponse.status).toBe(200);
    expect(outputText(await stickerResponse.json())).toBe("QA_WHATSAPP_STICKER_OK");
  });

  it("uses WhatsApp structured markers for channel-prefixed message bodies", async () => {
    const server = await startMockServer();
    const setupInput = makeUserInput(
      "When a later WhatsApp location message shows 37.774900, -122.419400, " +
        "reply with only this WhatsApp location marker: QA_WHATSAPP_LOCATION_OK. " +
        "When a later WhatsApp contact message appears, " +
        "reply with only this WhatsApp contact marker: QA_WHATSAPP_CONTACT_OK. " +
        "When a later WhatsApp sticker message appears, " +
        "reply with only this WhatsApp sticker marker: QA_WHATSAPP_STICKER_OK. " +
        "Reply with only this exact marker: QA_STRUCTURED_INITIAL_OK",
    );
    const previousExactMarkerInput = makeUserInput(
      "Reply with only this previous unrelated exact marker: QA_WHATSAPP_PREVIOUS_OK",
    );

    const locationResponse = await postResponses(server, {
      stream: false,
      input: [
        setupInput,
        previousExactMarkerInput,
        makeUserInput(
          [
            "Conversation info (untrusted metadata):",
            "```json",
            '{"inbound_event_kind":"user_request"}',
            "```",
            "",
            "📍 37.774900, -122.419400",
          ].join("\n"),
        ),
      ],
    });
    const contactResponse = await postResponses(server, {
      stream: false,
      input: [
        setupInput,
        previousExactMarkerInput,
        makeUserInput(
          ["Sender (untrusted metadata):", "```json", '{"name":"QA"}', "```", "", "<contact>"].join(
            "\n",
          ),
        ),
      ],
    });
    const stickerResponse = await postResponses(server, {
      stream: false,
      input: [
        setupInput,
        previousExactMarkerInput,
        makeUserInput(
          [
            "Conversation info (untrusted metadata):",
            "```json",
            '{"inbound_event_kind":"user_request"}',
            "```",
            "",
            "<media:sticker>",
          ].join("\n"),
        ),
      ],
    });

    expect(locationResponse.status).toBe(200);
    expect(outputText(await locationResponse.json())).toBe("QA_WHATSAPP_LOCATION_OK");
    expect(contactResponse.status).toBe(200);
    expect(outputText(await contactResponse.json())).toBe("QA_WHATSAPP_CONTACT_OK");
    expect(stickerResponse.status).toBe(200);
    expect(outputText(await stickerResponse.json())).toBe("QA_WHATSAPP_STICKER_OK");
  });

  it("streams WhatsApp location markers for the matching coordinate body", async () => {
    const server = await startMockServer();

    const body = await expectResponsesText(server, {
      stream: true,
      input: [
        makeUserInput(
          "When a later WhatsApp location message shows 37.774900, -122.419400, " +
            "reply with only this WhatsApp location marker: QA_WHATSAPP_LOCATION_STREAM_OK. " +
            "Reply with only this exact marker: QA_INITIAL_STREAM_OK",
        ),
        makeUserInput("📍 37.774900, -122.419400"),
      ],
    });

    expect(body).toContain("QA_WHATSAPP_LOCATION_STREAM_OK");
    expect(body).not.toContain("QA_INITIAL_STREAM_OK");
  });

  it("streams WhatsApp structured markers ahead of previous exact markers", async () => {
    const server = await startMockServer();

    const body = await expectResponsesText(server, {
      stream: true,
      input: [
        makeUserInput(
          "When a later WhatsApp location message shows 37.774900, -122.419400, " +
            "reply with only this WhatsApp location marker: QA_WHATSAPP_LOCATION_STREAM_OK. " +
            "Reply with only this exact marker: QA_INITIAL_STREAM_OK",
        ),
        makeUserInput(
          "Reply with only this previous unrelated exact marker: QA_WHATSAPP_PREVIOUS_STREAM_OK",
        ),
        makeUserInput("📍 37.774900, -122.419400"),
      ],
    });

    expect(body).toContain("QA_WHATSAPP_LOCATION_STREAM_OK");
    expect(body).not.toContain("QA_WHATSAPP_PREVIOUS_STREAM_OK");
  });

  it("uses image generation directives from request context when the latest user text is generic", async () => {
    const server = await startQaMockOpenAiServer({
      host: "127.0.0.1",
      port: 0,
    });
    cleanups.push(async () => {
      await server.stop();
    });

    const channelPrompt =
      '@qa-sut.example.test /tool image_generate action=generate prompt="QA lighthouse image for Matrix delivery testing" size=1024x1024 count=1';
    const genericPrompt =
      "Continue with the QA scenario plan and report worked, failed, and blocked items.";

    const toolPlan = await fetch(`${server.baseUrl}/v1/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        stream: false,
        input: [makeUserInput(channelPrompt), makeUserInput(genericPrompt)],
      }),
    });

    expect(toolPlan.status).toBe(200);
    const toolPlanOutput = outputItem(await toolPlan.json());
    expect(toolPlanOutput.type).toBe("function_call");
    expect(toolPlanOutput.name).toBe("image_generate");
    expect(String(toolPlanOutput.arguments)).toContain("qa-lighthouse.png");

    const toolResult = await fetch(`${server.baseUrl}/v1/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        stream: false,
        input: [
          makeUserInput(channelPrompt),
          makeUserInput(genericPrompt),
          {
            type: "function_call",
            name: "image_generate",
            call_id: "call_mock_image_generate_1",
            arguments: JSON.stringify({
              prompt: "A QA lighthouse",
              filename: "qa-lighthouse.png",
            }),
          },
          {
            type: "function_call_output",
            call_id: "call_mock_image_generate_1",
            output: JSON.stringify({
              details: { media: { mediaUrls: ["/tmp/qa-lighthouse.png"] } },
            }),
          },
        ],
      }),
    });

    expect(toolResult.status).toBe(200);
    expect(outputText(await toolResult.json())).toContain("Attachment: /tmp/qa-lighthouse.png");
  });

  it("plans QA tool-search calls for instruction-declared Codex dynamic tools", async () => {
    const server = await startMockServer();

    const response = await postResponses(server, {
      stream: false,
      instructions: "Codex dynamic OpenClaw tools available in this turn: web_search.",
      input: [
        makeUserInput(
          "tool search qa check target=web_search. Call exactly that tool once and then summarize.",
        ),
      ],
    });

    expect(response.status).toBe(200);
    const toolPlanOutput = outputItem(await response.json());
    expect(toolPlanOutput.type).toBe("function_call");
    expect(toolPlanOutput.name).toBe("web_search");
    expect(String(toolPlanOutput.arguments)).toContain("OpenClaw runtime parity fixed query");
  });

  it("plans QA tool-search calls from explicit fixture targets even without Responses tools", async () => {
    const server = await startMockServer();

    const response = await postResponses(server, {
      stream: false,
      input: [
        makeUserInput(
          "tool search qa check target=session_status. Call exactly that tool once and then summarize.",
        ),
      ],
    });

    expect(response.status).toBe(200);
    const toolPlanOutput = outputItem(await response.json());
    expect(toolPlanOutput.type).toBe("function_call");
    expect(toolPlanOutput.name).toBe("session_status");
    expect(String(toolPlanOutput.arguments)).toContain("current");
  });

  it("plans the explicit web_fetch fixture prompt as the canonical direct call", async () => {
    const server = await startMockServer();
    const prompt =
      "Call web_fetch exactly once with URL https://example.com/ and maxChars 500, wait for its result, then summarize. If web_fetch is already callable, call it directly without tool_search. Otherwise use tool_search to locate it first, then call web_fetch. A tool_search result alone does not complete the task; do not finish before web_fetch returns. QA routing marker: tool search qa check target=web_fetch.";

    const response = await postResponses(server, {
      stream: false,
      input: [makeUserInput(prompt)],
    });

    expect(response.status).toBe(200);
    const toolPlanOutput = outputItem(await response.json());
    expect(toolPlanOutput.type).toBe("function_call");
    expect(toolPlanOutput.name).toBe("web_fetch");
    expect(JSON.parse(String(toolPlanOutput.arguments))).toEqual({
      url: "https://example.com/",
      maxChars: 500,
    });
  });

  it("summarizes QA tool-search bridge outputs with the nested plugin result marker", async () => {
    const server = await startMockServer();
    const targetTool = "fake_plugin_tool_17";

    const response = await postResponses(server, {
      stream: false,
      input: [
        makeUserInput(
          `tool search qa check target=${targetTool}. Call exactly that tool once and then summarize.`,
        ),
        {
          type: "function_call_output",
          call_id: "call_tool_search_code_1",
          output: JSON.stringify({
            ok: true,
            value: {
              tool: {
                id: `openclaw:tool-search-e2e-fixture:${targetTool}`,
                source: "openclaw",
                sourceName: "tool-search-e2e-fixture",
                name: targetTool,
                description: "x".repeat(260),
              },
              result: {
                content: [
                  {
                    type: "text",
                    text: `FAKE_PLUGIN_OK ${targetTool} {"marker":"code"}`,
                  },
                ],
              },
            },
          }),
        },
      ],
    });

    expect(response.status).toBe(200);
    expect(outputText(await response.json())).toBe(`FAKE_PLUGIN_OK ${targetTool}`);
  });

  it("keeps QA tool-search result summaries ahead of generic worked/failed/blocked summaries", async () => {
    const server = await startMockServer();
    const targetTool = "fake_plugin_tool_17";

    const response = await postResponses(server, {
      stream: false,
      input: [
        {
          role: "system",
          content: [
            {
              type: "input_text",
              text: "Answer in worked/failed/blocked format with source and docs notes.",
            },
          ],
        },
        makeUserInput(
          `tool search qa check target=${targetTool}. Call exactly that tool once and then summarize.`,
        ),
        {
          type: "function_call_output",
          call_id: "call_tool_search_code_1",
          output: JSON.stringify({
            ok: true,
            value: {
              tool: { name: targetTool },
              result: {
                content: [{ type: "text", text: `FAKE_PLUGIN_OK ${targetTool}` }],
              },
            },
          }),
        },
      ],
    });

    expect(response.status).toBe(200);
    expect(outputText(await response.json())).toBe(`FAKE_PLUGIN_OK ${targetTool}`);
  });

  it("plans QA tool-search failure calls with denied-input args", async () => {
    const server = await startMockServer();

    const response = await postResponses(server, {
      stream: false,
      input: [
        makeUserInput(
          "tool search qa failure target=web_search. Exercise the denied-input path once and then summarize.",
        ),
      ],
    });

    expect(response.status).toBe(200);
    const toolPlanOutput = outputItem(await response.json());
    expect(toolPlanOutput.type).toBe("function_call");
    expect(toolPlanOutput.name).toBe("web_search");
    expect(String(toolPlanOutput.arguments)).toContain("OPENCLAW_QA_WEB_SEARCH_DENIED_INPUT");
  });

  it("plans QA subagent handoff calls even when Codex dynamic tools are not in body.tools", async () => {
    const server = await startMockServer();

    const response = await postResponses(server, {
      stream: false,
      input: [
        makeUserInput(
          "Delegate one bounded QA task to a subagent. Wait for the subagent to finish.",
        ),
      ],
    });

    expect(response.status).toBe(200);
    const toolPlanOutput = outputItem(await response.json());
    expect(toolPlanOutput.type).toBe("function_call");
    expect(toolPlanOutput.name).toBe("sessions_spawn");
  });

  it("records image inputs and describes attached images", async () => {
    const server = await startQaMockOpenAiServer({
      host: "127.0.0.1",
      port: 0,
    });
    cleanups.push(async () => {
      await server.stop();
    });

    const response = await fetch(`${server.baseUrl}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        stream: false,
        model: "mock-openai/gpt-5.6-luna",
        input: [
          {
            role: "user",
            content: [
              { type: "input_text", text: "Image understanding check: what do you see?" },
              {
                type: "input_image",
                source: {
                  type: "base64",
                  mime_type: "image/png",
                  data: QA_IMAGE_PNG_BASE64,
                },
              },
            ],
          },
        ],
      }),
    });
    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      output?: Array<{ content?: Array<{ text?: string }> }>;
    };
    const text = payload.output?.[0]?.content?.[0]?.text ?? "";
    expect(text.toLowerCase()).toContain("red");
    expect(text.toLowerCase()).toContain("blue");

    const debug = await fetch(`${server.baseUrl}/debug/requests`);
    expect(debug.status).toBe(200);
    const requestLog = requireArray(await debug.json(), "debug requests");
    expect(requireRecord(requestLog[0], "debug request 0").imageInputCount).toBe(1);
  });

  it("recognizes OpenAI-compatible image_url parts as image inputs", async () => {
    const server = await startQaMockOpenAiServer({
      host: "127.0.0.1",
      port: 0,
    });
    cleanups.push(async () => {
      await server.stop();
    });

    const response = await fetch(`${server.baseUrl}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        stream: false,
        model: "mock-openai/gpt-5.6-luna",
        input: [
          {
            role: "user",
            content: [
              { type: "input_text", text: "Image understanding check: what do you see?" },
              {
                type: "image_url",
                image_url: {
                  url: `data:image/png;base64,${QA_IMAGE_PNG_BASE64}`,
                },
              },
            ],
          },
        ],
      }),
    });
    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      output?: Array<{ content?: Array<{ text?: string }> }>;
    };
    const text = payload.output?.[0]?.content?.[0]?.text ?? "";
    expect(text.toLowerCase()).toContain("red");
    expect(text.toLowerCase()).toContain("blue");

    const debug = await fetch(`${server.baseUrl}/debug/last-request`);
    expect(debug.status).toBe(200);
    expect(requireRecord(await debug.json(), "debug request").imageInputCount).toBe(1);
  });

  it("answers image prompts when media context is the latest text part", async () => {
    const server = await startQaMockOpenAiServer({
      host: "127.0.0.1",
      port: 0,
    });
    cleanups.push(async () => {
      await server.stop();
    });

    const response = await fetch(`${server.baseUrl}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        stream: false,
        model: "mock-openai/gpt-5.6-luna",
        input: [
          {
            role: "user",
            content: [
              { type: "input_text", text: "Image understanding check: what do you see?" },
              {
                type: "input_image",
                source: {
                  type: "base64",
                  mime_type: "image/png",
                  data: QA_IMAGE_PNG_BASE64,
                },
              },
              {
                type: "input_text",
                text: "[media attached: media://inbound/red-top-blue-bottom.png (image/png)]",
              },
            ],
          },
        ],
      }),
    });
    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      output?: Array<{ content?: Array<{ text?: string }> }>;
    };
    const text = payload.output?.[0]?.content?.[0]?.text ?? "";
    expect(text.toLowerCase()).toContain("red");
    expect(text.toLowerCase()).toContain("blue");
  });

  it("lets image prompts beat stale exact marker directives from chat history", async () => {
    const server = await startMockServer();

    const response = await fetch(`${server.baseUrl}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        stream: false,
        model: "mock-openai/gpt-5.6-luna",
        input: [
          makeUserInput("Control UI bridge check. Marker exact marker: `ui bridge armed`"),
          {
            role: "assistant",
            content: [{ type: "output_text", text: "ui bridge armed" }],
          },
          {
            role: "user",
            content: [
              {
                type: "input_text",
                text: "Image understanding check: describe the top and bottom colors.",
              },
              {
                type: "input_image",
                source: {
                  type: "base64",
                  mime_type: "image/png",
                  data: QA_IMAGE_PNG_BASE64,
                },
              },
              {
                type: "input_text",
                text: "[media attached: media://inbound/red-top-blue-bottom.png (image/png)]",
              },
            ],
          },
        ],
      }),
    });
    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      output?: Array<{ content?: Array<{ text?: string }> }>;
    };
    const text = payload.output?.[0]?.content?.[0]?.text ?? "";
    expect(text.toLowerCase()).toContain("red");
    expect(text.toLowerCase()).toContain("blue");
    expect(text).not.toBe("ui bridge armed");
  });

  it("keeps stale image prompts from overriding later marker turns", async () => {
    const server = await startMockServer();

    const response = await fetch(`${server.baseUrl}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        stream: false,
        model: "mock-openai/gpt-5.6-luna",
        input: [
          {
            role: "user",
            content: [
              {
                type: "input_text",
                text: "Image understanding check: describe the top and bottom colors.",
              },
              {
                type: "input_image",
                source: {
                  type: "base64",
                  mime_type: "image/png",
                  data: QA_IMAGE_PNG_BASE64,
                },
              },
            ],
          },
          {
            role: "assistant",
            content: [
              {
                type: "output_text",
                text: "Protocol note: the attached image is split horizontally, with red on top and blue on the bottom.",
              },
            ],
          },
          makeUserInput("Marker exact marker: `fresh-marker-ok`"),
        ],
      }),
    });
    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      output?: Array<{ content?: Array<{ text?: string }> }>;
    };
    expect(payload.output?.[0]?.content?.[0]?.text).toBe("fresh-marker-ok");
  });

  it("keeps stale consecutive image prompts from overriding later marker turns", async () => {
    const server = await startMockServer();

    const response = await fetch(`${server.baseUrl}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        stream: false,
        model: "mock-openai/gpt-5.6-luna",
        input: [
          {
            role: "user",
            content: [
              {
                type: "input_text",
                text: "Image understanding check: describe the top and bottom colors.",
              },
              {
                type: "input_image",
                source: {
                  type: "base64",
                  mime_type: "image/png",
                  data: QA_IMAGE_PNG_BASE64,
                },
              },
            ],
          },
          makeUserInput("Marker exact marker: `fresh-consecutive-marker-ok`"),
        ],
      }),
    });
    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      output?: Array<{ content?: Array<{ text?: string }> }>;
    };
    expect(payload.output?.[0]?.content?.[0]?.text).toBe("fresh-consecutive-marker-ok");
  });

  it("handles deeply nested image input shapes without recursive traversal failure", async () => {
    const server = await startQaMockOpenAiServer({
      host: "127.0.0.1",
      port: 0,
    });
    cleanups.push(async () => {
      await server.stop();
    });

    let content: unknown = {
      type: "input_image",
      source: {
        type: "base64",
        mime_type: "image/png",
        data: QA_IMAGE_PNG_BASE64,
      },
    };
    for (let index = 0; index < 4_000; index += 1) {
      content = [{ type: "input_text", text: "nested" }, content];
    }

    const response = await fetch(`${server.baseUrl}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        stream: false,
        model: "mock-openai/gpt-5.6-luna",
        input: [
          {
            role: "user",
            content,
          },
        ],
      }),
    });
    expect(response.status).toBe(200);

    const debug = await fetch(`${server.baseUrl}/debug/last-request`);
    expect(debug.status).toBe(200);
    expect(requireRecord(await debug.json(), "debug request").imageInputCount).toBe(1);
  });

  it("describes reattached generated images in the roundtrip flow", async () => {
    const server = await startQaMockOpenAiServer({
      host: "127.0.0.1",
      port: 0,
    });
    cleanups.push(async () => {
      await server.stop();
    });

    const response = await fetch(`${server.baseUrl}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        stream: false,
        model: "mock-openai/gpt-5.6-luna",
        input: [
          {
            role: "user",
            content: [
              {
                type: "input_text",
                text: "Roundtrip image inspection check: describe the generated lighthouse attachment in one short sentence.",
              },
              {
                type: "input_image",
                source: {
                  type: "base64",
                  mime_type: "image/png",
                  data: QA_IMAGE_PNG_BASE64,
                },
              },
            ],
          },
        ],
      }),
    });
    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      output?: Array<{ content?: Array<{ text?: string }> }>;
    };
    const text = payload.output?.[0]?.content?.[0]?.text ?? "";
    expect(text.toLowerCase()).toContain("lighthouse");
  });

  it("ignores stale tool output from prior turns when planning the current turn", async () => {
    const server = await startQaMockOpenAiServer({
      host: "127.0.0.1",
      port: 0,
    });
    cleanups.push(async () => {
      await server.stop();
    });

    const response = await fetch(`${server.baseUrl}/v1/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        stream: true,
        input: [
          {
            role: "user",
            content: [{ type: "input_text", text: "Read QA_KICKOFF_TASK.md first." }],
          },
          {
            type: "function_call_output",
            output: "QA mission: read source and docs first.",
          },
          {
            role: "user",
            content: [
              {
                type: "input_text",
                text: "Switch models now. Tool continuity check: reread QA_KICKOFF_TASK.md and mention the handoff in one short sentence.",
              },
            ],
          },
        ],
      }),
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('"name":"read"');
  });

  it("returns continuity language after the model-switch reread completes", async () => {
    const server = await startQaMockOpenAiServer({
      host: "127.0.0.1",
      port: 0,
    });
    cleanups.push(async () => {
      await server.stop();
    });

    const response = await fetch(`${server.baseUrl}/v1/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        stream: false,
        model: "gpt-5.6-luna-alt",
        input: [
          {
            role: "user",
            content: [
              {
                type: "input_text",
                text: "Switch models now. Tool continuity check: reread QA_KICKOFF_TASK.md and mention the handoff in one short sentence.",
              },
            ],
          },
          {
            type: "function_call_output",
            output: "QA mission: Understand this OpenClaw repo from source + docs before acting.",
          },
        ],
      }),
    });

    expect(response.status).toBe(200);
    expect(outputText(await response.json())).toContain("model switch handoff confirmed");
  });

  it("returns NO_REPLY for unmentioned group chatter", async () => {
    const server = await startQaMockOpenAiServer({
      host: "127.0.0.1",
      port: 0,
    });
    cleanups.push(async () => {
      await server.stop();
    });

    const response = await fetch(`${server.baseUrl}/v1/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        stream: false,
        input: [
          {
            role: "user",
            content: [
              {
                type: "input_text",
                text: 'Conversation info (untrusted metadata): {"is_group_chat": true}\n\nhello team, no bot ping here',
              },
            ],
          },
        ],
      }),
    });
    expect(response.status).toBe(200);
    expect(outputText(await response.json())).toBe("NO_REPLY");
  });

  it("advertises Anthropic claude-opus-4-8 baseline model on /v1/models", async () => {
    const server = await startQaMockOpenAiServer({
      host: "127.0.0.1",
      port: 0,
    });
    cleanups.push(async () => {
      await server.stop();
    });

    const response = await fetch(`${server.baseUrl}/v1/models`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { data: Array<{ id: string }> };
    const ids = body.data.map((entry) => entry.id);
    expect(ids).toContain("claude-opus-4-8");
    expect(ids).toContain("gpt-5.6-luna");
    expect(ids).toContain("gpt-4o-transcribe");
  });

  it("serves deterministic OpenAI-compatible audio transcription responses", async () => {
    const server = await startQaMockOpenAiServer({
      host: "127.0.0.1",
      port: 0,
    });
    cleanups.push(async () => {
      await server.stop();
    });

    const response = await fetch(`${server.baseUrl}/v1/audio/transcriptions`, {
      method: "POST",
      headers: {
        "content-type": "multipart/form-data; boundary=qa",
      },
      body: "--qa\r\n--qa--\r\n",
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      text: "Reply with only this exact marker: WHATSAPP_QA_AUDIO_TRANSCRIPT_OK",
    });
  });

  it("serves deterministic WhatsApp group audio transcription for the trigger fixture", async () => {
    const server = await startQaMockOpenAiServer({
      host: "127.0.0.1",
      port: 0,
    });
    cleanups.push(async () => {
      await server.stop();
    });

    const triggered = await fetch(`${server.baseUrl}/v1/audio/transcriptions`, {
      method: "POST",
      headers: {
        "content-type": "multipart/form-data; boundary=qa",
      },
      body:
        '--qa\r\ncontent-disposition: form-data; name="file"; filename="upload.ogg"\r\n\r\n' +
        "OPENCLAW_QA_GROUP_AUDIO_TRIGGER\r\n--qa--\r\n",
    });
    const quiet = await fetch(`${server.baseUrl}/v1/audio/transcriptions`, {
      method: "POST",
      headers: {
        "content-type": "multipart/form-data; boundary=qa",
      },
      body: '--qa\r\ncontent-disposition: form-data; name="file"; filename="upload.ogg"\r\n\r\nx\r\n--qa--\r\n',
    });

    expect(triggered.status).toBe(200);
    await expect(triggered.json()).resolves.toEqual({
      text: "openclawqa reply with only this exact marker after group audio preflight: WHATSAPP_QA_GROUP_AUDIO_TRANSCRIPT_OK",
    });
    expect(quiet.status).toBe(200);
    await expect(quiet.json()).resolves.toEqual({
      text: "Reply with only this exact marker: WHATSAPP_QA_AUDIO_TRANSCRIPT_OK",
    });
  });

  it("dispatches an Anthropic /v1/messages read tool call for source discovery prompts", async () => {
    const server = await startQaMockOpenAiServer({
      host: "127.0.0.1",
      port: 0,
    });
    cleanups.push(async () => {
      await server.stop();
    });

    const response = await fetch(`${server.baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-opus-4-8",
        max_tokens: 256,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: "Read the seeded docs and report worked, failed, blocked, and follow-up items.",
              },
            ],
          },
        ],
      }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      type: string;
      role: string;
      model: string;
      stop_reason: string;
      content: Array<Record<string, unknown>>;
    };
    expect(body.type).toBe("message");
    expect(body.role).toBe("assistant");
    expect(body.model).toBe("claude-opus-4-8");
    expect(body.stop_reason).toBe("tool_use");
    const toolUseBlock = body.content.find((block) => block.type === "tool_use") as
      | { name: string; input: Record<string, unknown> }
      | undefined;
    expect(toolUseBlock?.name).toBe("read");
    expect(toolUseBlock?.input).toEqual({ path: "repo/docs/help/testing.md" });

    const debugResponse = await fetch(`${server.baseUrl}/debug/last-request`);
    expect(debugResponse.status).toBe(200);
    const debugPayload = requireRecord(await debugResponse.json(), "debug request");
    expect(debugPayload.model).toBe("claude-opus-4-8");
    expect(debugPayload.plannedToolName).toBe("read");
  });

  it("preserves Anthropic /v1/messages declared tools for explicit sessions_spawn prompts", async () => {
    const server = await startMockServer();

    const response = await fetch(`${server.baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-opus-4-8",
        max_tokens: 256,
        tools: [
          {
            name: "sessions_spawn",
            input_schema: { type: "object", properties: {} },
          },
        ],
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: explicitSessionsSpawnPrompt("QA_SUBAGENT_CHILD_ANTHROPIC"),
              },
            ],
          },
        ],
      }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      stop_reason: string;
      content: Array<Record<string, unknown>>;
    };
    expect(body.stop_reason).toBe("tool_use");
    const toolUseBlock = body.content.find((block) => block.type === "tool_use") as
      | { name: string; input: Record<string, unknown> }
      | undefined;
    expect(toolUseBlock?.name).toBe("sessions_spawn");
    expect(toolUseBlock?.input.task).toBe(threadSubagentTask("QA_SUBAGENT_CHILD_ANTHROPIC"));
    expect(toolUseBlock?.input.label).toBe("qa-thread-subagent");
    expect(toolUseBlock?.input.thread).toBe(true);
    expect(toolUseBlock?.input.mode).toBe("session");
    expect(toolUseBlock?.input).not.toHaveProperty("runTimeoutSeconds");

    const debugResponse = await fetch(`${server.baseUrl}/debug/last-request`);
    expect(debugResponse.status).toBe(200);
    const debugPayload = requireRecord(await debugResponse.json(), "debug request");
    expect(debugPayload.model).toBe("claude-opus-4-8");
    expect(debugPayload.plannedToolName).toBe("sessions_spawn");
  });

  it("dispatches Anthropic /v1/messages tool_result follow-ups through the shared scenario logic", async () => {
    // This verifies the Anthropic adapter correctly feeds tool_result
    // content blocks into the shared scenario dispatcher so downstream
    // "has this scenario already called a tool?" logic fires the same way
    // it does on the OpenAI /v1/responses route. The subagent handoff
    // scenario is ideal because the mock has a two-stage flow: first
    // delegate prompt → sessions_spawn tool_use, then tool_result →
    // "Delegated task: ..." prose summary.
    const server = await startQaMockOpenAiServer({
      host: "127.0.0.1",
      port: 0,
    });
    cleanups.push(async () => {
      await server.stop();
    });

    const response = await fetch(`${server.baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-opus-4-8",
        max_tokens: 256,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: "Delegate one bounded QA task to a subagent, wait for it to finish, then reply with Delegated task, Result, and Evidence sections.",
              },
            ],
          },
          {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: "toolu_mock_spawn_1",
                name: "sessions_spawn",
                input: { task: "Inspect the QA workspace", label: "qa-sidecar", thread: false },
              },
            ],
          },
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "toolu_mock_spawn_1",
                content: "SUBAGENT-OK",
              },
            ],
          },
        ],
      }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      stop_reason: string;
      content: Array<{ type: string; text?: string }>;
    };
    expect(body.stop_reason).toBe("end_turn");
    const textBlock = body.content.find((block) => block.type === "text") as
      | { text: string }
      | undefined;
    // The mock's subagent-handoff branch echoes "Delegated task", a
    // tool-output evidence line, and a folded-back "Evidence" marker.
    expect(textBlock?.text).toContain("Delegated task");
    expect(textBlock?.text).toContain("Evidence");
  });

  it("places tool_result after the parent user message even in mixed-content turns", async () => {
    // Regression for the loop-6 Copilot / Greptile finding: a user message
    // that mixes a tool_result block with fresh text blocks must still land
    // the function_call_output AFTER the parent user message in the
    // converted ResponsesInputItem[], otherwise extractToolOutput (which
    // scans AFTER the last user-role index) fails to see the tool output
    // and the downstream scenario dispatcher behaves as if no tool output
    // was returned. We verify the conversion directly via the snapshot
    // that /debug/last-request exposes: the last-request `toolOutput`
    // field should be the stringified tool_result content, and `prompt`
    // should be the trailing fresh-text block.
    const server = await startQaMockOpenAiServer({
      host: "127.0.0.1",
      port: 0,
    });
    cleanups.push(async () => {
      await server.stop();
    });

    const response = await fetch(`${server.baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-opus-4-8",
        max_tokens: 256,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: "Delegate one bounded QA task to a subagent.",
              },
            ],
          },
          {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: "toolu_mock_spawn_mixed",
                name: "sessions_spawn",
                input: { task: "Inspect the QA workspace", label: "qa-sidecar", thread: false },
              },
            ],
          },
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "toolu_mock_spawn_mixed",
                content: "SUBAGENT-OK",
              },
              // A trailing fresh text block in the same user turn. Before
              // the loop-6 fix, the tool_result was pushed BEFORE the
              // parent user message, so extractToolOutput saw the text
              // turn as the last user-role item and found no
              // function_call_output after it → returned "". The
              // downstream dispatcher then behaved as if no tool output
              // was present at all.
              {
                type: "text",
                text: "Keep going with the fanout.",
              },
            ],
          },
        ],
      }),
    });
    expect(response.status).toBe(200);

    const debugResponse = await fetch(`${server.baseUrl}/debug/last-request`);
    expect(debugResponse.status).toBe(200);
    const debug = (await debugResponse.json()) as {
      prompt: string;
      allInputText: string;
      toolOutputCallId: string;
      toolOutput: string;
    };
    // extractToolOutput should surface the tool_result content because
    // the function_call_output item is placed AFTER the parent user
    // message in the converted input array.
    expect(debug.toolOutput).toBe("SUBAGENT-OK");
    expect(debug.toolOutputCallId).toBe("toolu_mock_spawn_mixed");
    // extractLastUserText should surface the fresh-text block (the parent
    // user message that was pushed BEFORE the function_call_output).
    expect(debug.prompt).toBe("Keep going with the fanout.");
    // The converted history still records both turns, including the
    // original delegate prompt from the first user turn.
    expect(debug.allInputText).toContain("Delegate one bounded QA task");
  });

  it("exposes structured Anthropic tool_result errors in debug snapshots", async () => {
    const server = await startQaMockOpenAiServer({
      host: "127.0.0.1",
      port: 0,
    });
    cleanups.push(async () => {
      await server.stop();
    });

    const response = await fetch(`${server.baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-opus-4-8",
        max_tokens: 256,
        messages: [
          {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: "toolu_mock_read_error",
                name: "read",
                input: { path: "/missing" },
              },
            ],
          },
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "toolu_mock_read_error",
                is_error: true,
                content: "ENOENT: no such file or directory",
              },
            ],
          },
        ],
      }),
    });
    expect(response.status).toBe(200);

    const debugResponse = await fetch(`${server.baseUrl}/debug/last-request`);
    expect(debugResponse.status).toBe(200);
    const debug = (await debugResponse.json()) as {
      toolOutputCallId: string;
      toolOutputStructuredError?: boolean;
    };
    expect(debug.toolOutputCallId).toBe("toolu_mock_read_error");
    expect(debug.toolOutputStructuredError).toBe(true);
  });

  it("streams Anthropic /v1/messages tool_use responses as SSE", async () => {
    const server = await startQaMockOpenAiServer({
      host: "127.0.0.1",
      port: 0,
    });
    cleanups.push(async () => {
      await server.stop();
    });

    const response = await fetch(`${server.baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-opus-4-8",
        max_tokens: 256,
        stream: true,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: "Read the seeded docs and report worked, failed, blocked, and follow-up items.",
              },
            ],
          },
        ],
      }),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const body = await response.text();
    expect(body).toContain("event: message_start");
    expect(body).toContain("event: content_block_start");
    expect(body).toContain('"type":"tool_use"');
    expect(body).toContain('"name":"read"');
    expect(body).toContain("repo/docs/help/testing.md");
    expect(body).toContain("event: message_delta");
    expect(body).toContain("event: message_stop");
  });

  it("streams Anthropic /v1/messages tool_result follow-ups as text deltas", async () => {
    const server = await startQaMockOpenAiServer({
      host: "127.0.0.1",
      port: 0,
    });
    cleanups.push(async () => {
      await server.stop();
    });

    const response = await fetch(`${server.baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-opus-4-8",
        max_tokens: 256,
        stream: true,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: "Delegate one bounded QA task to a subagent, wait for it to finish, then reply with Delegated task, Result, and Evidence sections.",
              },
            ],
          },
          {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: "toolu_mock_spawn_1",
                name: "sessions_spawn",
                input: { task: "Inspect the QA workspace", label: "qa-sidecar", thread: false },
              },
            ],
          },
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "toolu_mock_spawn_1",
                content: "SUBAGENT-OK",
              },
            ],
          },
        ],
      }),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const body = await response.text();
    expect(body).toContain("event: content_block_delta");
    expect(body).toContain('"type":"text_delta"');
    expect(body).toContain("Delegated task");
    expect(body).toContain("Evidence");
  });

  it("keeps Anthropic remember prompts on the prose branch even when system text mentions HEARTBEAT", async () => {
    const server = await startQaMockOpenAiServer({
      host: "127.0.0.1",
      port: 0,
    });
    cleanups.push(async () => {
      await server.stop();
    });

    const response = await fetch(`${server.baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-opus-4-8",
        max_tokens: 256,
        stream: true,
        system: [
          {
            type: "text",
            text: "Read HEARTBEAT.md if it exists (workspace context). Follow it strictly. If nothing needs attention, reply HEARTBEAT_OK.",
          },
        ],
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: "Please remember this fact for later: the QA canary code is ALPHA-7. Use your normal memory mechanism, avoid manual repo cleanup, and reply exactly `Remembered ALPHA-7.` once stored.",
              },
            ],
          },
        ],
      }),
    });

    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain("Remembered ALPHA-7.");
    expect(body).not.toContain("HEARTBEAT_OK");
    expect(body).not.toContain('"name":"read"');
  });

  it("prefers the prompt-local exact reply directive over heartbeat context", async () => {
    const server = await startQaMockOpenAiServer({
      host: "127.0.0.1",
      port: 0,
    });
    cleanups.push(async () => {
      await server.stop();
    });

    const response = await fetch(`${server.baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-opus-4-8",
        max_tokens: 256,
        stream: true,
        system: [
          {
            type: "text",
            text: [
              "Read HEARTBEAT.md if it exists (workspace context). Follow it strictly.",
              "If the current user message is a heartbeat poll and nothing needs attention, reply exactly:",
              "HEARTBEAT_OK",
            ].join("\n"),
          },
        ],
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: "Please remember this fact for later: the QA canary code is ALPHA-7. Use your normal memory mechanism, avoid manual repo cleanup, and reply exactly `Remembered ALPHA-7.` once stored.",
              },
            ],
          },
        ],
      }),
    });

    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain("Remembered ALPHA-7.");
    expect(body).not.toContain("HEARTBEAT_OK");
  });

  it("rejects malformed or non-object Anthropic /v1/messages JSON", async () => {
    const server = await startQaMockOpenAiServer({
      host: "127.0.0.1",
      port: 0,
    });
    cleanups.push(async () => {
      await server.stop();
    });

    for (const rawBody of ['{"model":"claude-opus-4-8","messages":[', "null", "[]", '"text"']) {
      const response = await fetch(`${server.baseUrl}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: rawBody,
      });

      expect(response.status).toBe(400);
      const body = (await response.json()) as {
        type: string;
        error: { type: string; message: string };
      };
      expect(body.type).toBe("error");
      expect(body.error.type).toBe("invalid_request_error");
      expect(body.error.message).toContain("Malformed JSON body");
    }

    const health = await fetch(`${server.baseUrl}/healthz`);
    expect(health.status).toBe(200);
  });

  it("rejects malformed OpenAI-compatible JSON without crashing the mock server", async () => {
    const server = await startQaMockOpenAiServer({
      host: "127.0.0.1",
      port: 0,
    });
    cleanups.push(async () => {
      await server.stop();
    });

    for (const path of ["/v1/responses", "/v1/embeddings", "/v1/images/generations"]) {
      for (const rawBody of ["{bad", "[]", '"text"']) {
        const response = await fetch(`${server.baseUrl}${path}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: rawBody,
        });

        expect(response.status).toBe(400);
        const body = (await response.json()) as {
          error: { type: string; message: string };
        };
        expect(body.error.type).toBe("invalid_request_error");
        expect(body.error.message).toContain("Malformed JSON body");
      }
    }

    const health = await fetch(`${server.baseUrl}/healthz`);
    expect(health.status).toBe(200);
  });

  it("defaults empty-string Anthropic /v1/messages model to claude-opus-4-8", async () => {
    // Regression for the loop-7 Copilot finding: a bare `typeof
    // body.model === "string"` check lets an empty-string model leak
    // through to `lastRequest.model` and `responseBody.model`. Empty
    // strings must be treated the same as absent and default to
    // `"claude-opus-4-8"` so parity consumers can trust the echoed label.
    const server = await startQaMockOpenAiServer({
      host: "127.0.0.1",
      port: 0,
    });
    cleanups.push(async () => {
      await server.stop();
    });

    const response = await fetch(`${server.baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "",
        max_tokens: 256,
        messages: [
          {
            role: "user",
            content: "Read the plan",
          },
        ],
      }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { model: string };
    expect(body.model).toBe("claude-opus-4-8");

    const debugResponse = await fetch(`${server.baseUrl}/debug/last-request`);
    expect(debugResponse.status).toBe(200);
    const debug = (await debugResponse.json()) as { model: string };
    expect(debug.model).toBe("claude-opus-4-8");
  });

  it("scripts a reasoning-only recovery sequence after a replay-safe read", async () => {
    const server = await startMockServer();

    const toolPlan = await expectResponsesText(server, {
      stream: true,
      model: "gpt-5.6-luna",
      input: [makeUserInput(QA_REASONING_ONLY_RECOVERY_PROMPT)],
    });
    expect(toolPlan).toContain('"name":"read"');
    expect(toolPlan).toContain("QA_KICKOFF_TASK.md");

    const reasoningPayload = await expectResponsesJson<{
      output?: Array<{ type?: string; id?: string; summary?: Array<{ text?: string }> }>;
    }>(server, {
      stream: false,
      model: "gpt-5.6-luna",
      input: [
        makeUserInput(QA_REASONING_ONLY_RECOVERY_PROMPT),
        {
          type: "function_call_output",
          output: "QA mission: Understand this OpenClaw repo from source + docs before acting.",
        },
      ],
    });
    const reasoningOutput = outputItem(reasoningPayload);
    expect(reasoningOutput.type).toBe("reasoning");
    expect(reasoningOutput.id).toBe("rs_mock_reasoning_recovery");
    const reasoningSummary = requireArray(reasoningOutput.summary, "reasoning summary");
    expect(String(requireRecord(reasoningSummary[0], "reasoning summary 0").text)).toContain(
      "Need visible answer",
    );

    const recoveredPayload = await expectResponsesJson<{
      output?: Array<{ content?: Array<{ text?: string }> }>;
    }>(server, {
      stream: false,
      model: "gpt-5.6-luna",
      input: [
        makeUserInput(QA_REASONING_ONLY_RECOVERY_PROMPT),
        makeUserInput(QA_REASONING_ONLY_RETRY_INSTRUCTION),
        {
          type: "function_call_output",
          output: "QA mission: Understand this OpenClaw repo from source + docs before acting.",
        },
      ],
    });
    expect(outputText(recoveredPayload)).toBe("REASONING-RECOVERED-OK");

    const requests = await fetch(`${server.baseUrl}/debug/requests`);
    expect(requests.status).toBe(200);
    const requestLog = requireArray(await requests.json(), "debug requests");
    expect(requireRecord(requestLog[0], "debug request 0").plannedToolName).toBe("read");
    expect(String(requireRecord(requestLog[1], "debug request 1").allInputText)).toContain(
      QA_REASONING_ONLY_RECOVERY_PROMPT,
    );
    expect(String(requireRecord(requestLog[2], "debug request 2").allInputText)).toContain(
      QA_REASONING_ONLY_RETRY_INSTRUCTION,
    );
  });

  it("scripts the GPT-5.6 Luna thinking visibility switch prompts", async () => {
    const server = await startMockServer();

    const offPayload = await expectResponsesJson<{
      output?: Array<{ type?: string; content?: Array<{ text?: string }> }>;
    }>(server, {
      stream: false,
      model: "gpt-5.6-luna",
      input: [makeUserInput(QA_THINKING_VISIBILITY_OFF_PROMPT)],
    });
    expect(outputItem(offPayload).type).toBe("message");
    expect(outputText(offPayload)).toBe("THINKING-OFF-OK");

    const maxPayload = await expectResponsesJson<{
      output?: Array<{
        type?: string;
        id?: string;
        summary?: Array<{ text?: string }>;
        content?: Array<{ text?: string }>;
      }>;
    }>(server, {
      stream: false,
      model: "gpt-5.6-luna",
      input: [makeUserInput(QA_THINKING_VISIBILITY_MAX_PROMPT)],
    });
    const maxReasoning = outputItem(maxPayload);
    expect(maxReasoning.type).toBe("reasoning");
    expect(maxReasoning.id).toBe("rs_mock_thinking_visibility_max");
    expect(maxReasoning.summary).toEqual([]);
    expect(outputItem(maxPayload, 1).type).toBe("message");
    expect(outputText(maxPayload, 1)).toBe("THINKING-MAX-OK");

    const maxStream = await expectResponsesText(server, {
      stream: true,
      model: "gpt-5.6-luna",
      input: [makeUserInput(QA_THINKING_VISIBILITY_MAX_PROMPT)],
    });
    expect(maxStream).toContain('"type":"response.output_text.delta"');
    expect(maxStream).toContain('"delta":"THINKING-MAX-OK"');
  });

  it("keeps stale thinking visibility prompts from overriding later marker turns", async () => {
    const server = await startMockServer();

    const payload = await expectResponsesJson<{
      output?: Array<{ content?: Array<{ text?: string }> }>;
    }>(server, {
      stream: false,
      model: "gpt-5.6-luna",
      input: [
        makeUserInput(QA_THINKING_VISIBILITY_MAX_PROMPT),
        {
          role: "assistant",
          content: [{ type: "output_text", text: "THINKING-MAX-OK" }],
        },
        makeUserInput("Marker exact marker: `fresh-thinking-marker`"),
      ],
    });
    expect(outputText(payload)).toBe("fresh-thinking-marker");
  });

  it("keeps the reasoning-only side-effect path ready for no-auto-retry QA coverage", async () => {
    const server = await startMockServer();

    const toolPlan = await expectResponsesText(server, {
      stream: true,
      model: "gpt-5.6-luna",
      input: [makeUserInput(QA_REASONING_ONLY_SIDE_EFFECT_PROMPT)],
    });
    expect(toolPlan).toContain('"name":"write"');
    expect(toolPlan).toContain("reasoning-only-side-effect.txt");

    const sideEffectPayload = await expectResponsesJson<{
      output?: Array<{ type?: string; id?: string }>;
    }>(server, {
      stream: false,
      model: "gpt-5.6-luna",
      input: [
        makeUserInput(QA_REASONING_ONLY_SIDE_EFFECT_PROMPT),
        {
          type: "function_call_output",
          output: "Successfully wrote 28 bytes to reasoning-only-side-effect.txt.",
        },
      ],
    });
    const sideEffectOutput = outputItem(sideEffectPayload);
    expect(sideEffectOutput.type).toBe("reasoning");
    expect(sideEffectOutput.id).toBe("rs_mock_reasoning_side_effect");

    const requests = await fetch(`${server.baseUrl}/debug/requests`);
    expect(requests.status).toBe(200);
    expect((await requests.json()) as Array<{ allInputText?: string }>).toHaveLength(2);
  });

  it("scripts an empty-response recovery sequence after a replay-safe read", async () => {
    const server = await startMockServer();

    const toolPlan = await expectResponsesText(server, {
      stream: true,
      model: "gpt-5.6-luna",
      input: [makeUserInput(QA_EMPTY_RESPONSE_RECOVERY_PROMPT)],
    });
    expect(toolPlan).toContain('"name":"read"');

    const emptyPayload = await expectResponsesJson<{
      output?: Array<{ content?: Array<{ type?: string; text?: string }> }>;
    }>(server, {
      stream: false,
      model: "gpt-5.6-luna",
      input: [
        makeUserInput(QA_EMPTY_RESPONSE_RECOVERY_PROMPT),
        {
          type: "function_call_output",
          output: "QA mission: Understand this OpenClaw repo from source + docs before acting.",
        },
      ],
    });
    const emptyContent = outputContentItem(emptyPayload);
    expect(emptyContent.type).toBe("output_text");
    expect(emptyContent.text).toBe("");

    const recoveredPayload = await expectResponsesJson<{
      output?: Array<{ content?: Array<{ text?: string }> }>;
    }>(server, {
      stream: false,
      model: "gpt-5.6-luna",
      input: [
        makeUserInput(QA_EMPTY_RESPONSE_RECOVERY_PROMPT),
        makeUserInput(QA_EMPTY_RESPONSE_RETRY_INSTRUCTION),
        {
          type: "function_call_output",
          output: "QA mission: Understand this OpenClaw repo from source + docs before acting.",
        },
      ],
    });
    expect(outputText(recoveredPayload)).toBe("EMPTY-RECOVERED-OK");
  });

  it("can keep emitting empty GPT turns when the single retry budget should exhaust", async () => {
    const server = await startMockServer();

    await expectResponsesText(server, {
      stream: true,
      model: "gpt-5.6-luna",
      input: [makeUserInput(QA_EMPTY_RESPONSE_EXHAUSTION_PROMPT)],
    });

    const firstEmpty = await expectResponsesJson<{
      output?: Array<{ content?: Array<{ text?: string }> }>;
    }>(server, {
      stream: false,
      model: "gpt-5.6-luna",
      input: [
        makeUserInput(QA_EMPTY_RESPONSE_EXHAUSTION_PROMPT),
        {
          type: "function_call_output",
          output: "QA mission: Understand this OpenClaw repo from source + docs before acting.",
        },
      ],
    });
    expect(firstEmpty.output?.[0]?.content?.[0]?.text).toBe("");

    const secondEmpty = await expectResponsesJson<{
      output?: Array<{ content?: Array<{ text?: string }> }>;
    }>(server, {
      stream: false,
      model: "gpt-5.6-luna",
      input: [
        makeUserInput(QA_EMPTY_RESPONSE_EXHAUSTION_PROMPT),
        makeUserInput(QA_EMPTY_RESPONSE_RETRY_INSTRUCTION),
        {
          type: "function_call_output",
          output: "QA mission: Understand this OpenClaw repo from source + docs before acting.",
        },
      ],
    });
    expect(secondEmpty.output?.[0]?.content?.[0]?.text).toBe("");
  });
});

describe("resolveProviderVariant", () => {
  it("tags prefix-qualified openai models", () => {
    expect(resolveProviderVariant("openai/gpt-5.6-luna")).toBe("openai");
    expect(resolveProviderVariant("openai:gpt-5.6-luna")).toBe("openai");
    expect(resolveProviderVariant("openai/gpt-5.6-luna")).toBe("openai");
  });

  it("tags prefix-qualified anthropic models", () => {
    expect(resolveProviderVariant("anthropic/claude-opus-4-8")).toBe("anthropic");
    expect(resolveProviderVariant("anthropic:claude-opus-4-8")).toBe("anthropic");
    expect(resolveProviderVariant("claude-cli/claude-opus-4-8")).toBe("anthropic");
  });

  it("tags bare model names by prefix", () => {
    expect(resolveProviderVariant("gpt-5.6-luna")).toBe("openai");
    expect(resolveProviderVariant("gpt-5.6-luna-alt")).toBe("openai");
    expect(resolveProviderVariant("gpt-4.5")).toBe("openai");
    expect(resolveProviderVariant("o1-preview")).toBe("openai");
    expect(resolveProviderVariant("claude-opus-4-8")).toBe("anthropic");
    expect(resolveProviderVariant("claude-sonnet-4-6")).toBe("anthropic");
  });

  it("handles case drift and whitespace", () => {
    expect(resolveProviderVariant("  OpenAI/GPT-5.6 Luna  ")).toBe("openai");
    expect(resolveProviderVariant("ANTHROPIC/CLAUDE-OPUS-4-6")).toBe("anthropic");
  });

  it("falls through to unknown for unrecognized providers", () => {
    expect(resolveProviderVariant("")).toBe("unknown");
    expect(resolveProviderVariant(undefined)).toBe("unknown");
    expect(resolveProviderVariant("mistral/mistral-large")).toBe("unknown");
    expect(resolveProviderVariant("some-random-model")).toBe("unknown");
  });
});

describe("qa mock openai server provider variant tagging", () => {
  it("pins provider-specific plans for parity scenarios", async () => {
    const sourcePrompt =
      "Read the seeded docs and source plan, then report grouped into Worked, Failed, Blocked, and Follow-up.";
    const handoffPrompt =
      "Delegate one bounded QA task to a subagent. Wait for the subagent to finish.";
    const fanoutPrompt =
      "Subagent fanout synthesis check: delegate two bounded subagents sequentially, then report both results together.";

    const openaiSourceServer = await startMockServer();
    const openaiSource = await expectResponsesJson(openaiSourceServer, {
      model: "openai/gpt-5.6-luna",
      stream: false,
      input: [makeUserInput(sourcePrompt)],
    });
    expect(outputToolArgs(openaiSource)).toEqual({ path: "repo/qa/scenarios/index.yaml" });

    const anthropicSourceServer = await startMockServer();
    const anthropicSource = await expectResponsesJson(anthropicSourceServer, {
      model: "anthropic/claude-opus-4-8",
      stream: false,
      input: [makeUserInput(sourcePrompt)],
    });
    expect(outputToolArgs(anthropicSource)).toEqual({ path: "repo/docs/help/testing.md" });

    const openaiHandoffServer = await startMockServer();
    const openaiHandoff = await expectResponsesJson(openaiHandoffServer, {
      model: "gpt-5.6-luna",
      stream: false,
      input: [makeUserInput(handoffPrompt)],
    });
    expect(outputToolArgs(openaiHandoff)).toMatchObject({
      label: "qa-sidecar",
      task: "Inspect the QA workspace and return one concise protocol note.",
    });

    const anthropicHandoffServer = await startMockServer();
    const anthropicHandoff = await expectResponsesJson(anthropicHandoffServer, {
      model: "claude-opus-4-8",
      stream: false,
      input: [makeUserInput(handoffPrompt)],
    });
    expect(outputToolArgs(anthropicHandoff)).toMatchObject({
      label: "qa-sidecar",
      task: "Inspect the QA docs fixture and return one concise protocol note.",
    });

    const openaiFanoutServer = await startMockServer();
    const openaiFanout = await expectResponsesJson(openaiFanoutServer, {
      model: "openai/gpt-5.6-luna",
      stream: false,
      tools: [SESSIONS_SPAWN_TOOL],
      input: [makeUserInput(fanoutPrompt)],
    });
    expect(outputToolArgs(openaiFanout)).toMatchObject({
      label: "qa-fanout-alpha",
      task: "Fanout worker alpha: inspect the QA workspace and finish with exactly ALPHA-OK.",
    });

    const anthropicFanoutServer = await startMockServer();
    const anthropicFanout = await expectResponsesJson(anthropicFanoutServer, {
      model: "anthropic/claude-opus-4-8",
      stream: false,
      tools: [SESSIONS_SPAWN_TOOL],
      input: [makeUserInput(fanoutPrompt)],
    });
    expect(outputToolArgs(anthropicFanout)).toMatchObject({
      label: "qa-fanout-alpha",
      task: "Fanout worker alpha: inspect the QA docs fixture and finish with exactly ALPHA-OK.",
    });
  });

  it("records providerVariant on /debug/last-request for openai requests", async () => {
    const server = await startQaMockOpenAiServer({
      host: "127.0.0.1",
      port: 0,
    });
    cleanups.push(async () => {
      await server.stop();
    });

    await fetch(`${server.baseUrl}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "openai/gpt-5.6-luna",
        stream: false,
        input: [{ role: "user", content: [{ type: "input_text", text: "Heartbeat check" }] }],
      }),
    });

    const debug = (await (await fetch(`${server.baseUrl}/debug/last-request`)).json()) as {
      model: string;
      providerVariant: string;
    };
    expect(debug.model).toBe("openai/gpt-5.6-luna");
    expect(debug.providerVariant).toBe("openai");
  });

  it("records providerVariant=anthropic on /v1/messages requests", async () => {
    const server = await startQaMockOpenAiServer({
      host: "127.0.0.1",
      port: 0,
    });
    cleanups.push(async () => {
      await server.stop();
    });

    await fetch(`${server.baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-opus-4-8",
        max_tokens: 256,
        messages: [{ role: "user", content: "Heartbeat check" }],
      }),
    });

    const debug = (await (await fetch(`${server.baseUrl}/debug/last-request`)).json()) as {
      model: string;
      providerVariant: string;
    };
    expect(debug.model).toBe("claude-opus-4-8");
    expect(debug.providerVariant).toBe("anthropic");
  });

  it("records providerVariant=unknown for unrecognized models", async () => {
    const server = await startQaMockOpenAiServer({
      host: "127.0.0.1",
      port: 0,
    });
    cleanups.push(async () => {
      await server.stop();
    });

    await fetch(`${server.baseUrl}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "mistral/mistral-large",
        stream: false,
        input: [{ role: "user", content: [{ type: "input_text", text: "Heartbeat check" }] }],
      }),
    });

    const debug = (await (await fetch(`${server.baseUrl}/debug/last-request`)).json()) as {
      providerVariant: string;
    };
    expect(debug.providerVariant).toBe("unknown");
  });
});
