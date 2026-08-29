import { once } from "node:events";
import { runInNewContext } from "node:vm";
// Qa Lab tests cover server plugin behavior.
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { readQaMockRequestCursor } from "../shared/debug-request-cursor.js";
import { adaptAnthropicToolCallIds } from "./mock-anthropic-wire.js";
import type { StreamEvent } from "./mock-openai-contracts.js";
import { QA_TOOL_SEARCH_SECONDARY_TARGET, readTargetFromPrompt } from "./mock-openai-tooling.js";
import { startQaMockOpenAiServer } from "./server.js";

type MockServer = { baseUrl: string };

const cleanups: Array<() => Promise<void>> = [];
const QA_IMAGE_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAT0lEQVR42u3RQQkAMAzAwPg33Wnos+wgBo40dboAAAAAAAAAAAAAAAAAAAAAAAAAAAAAANYADwAAAAAAAAAAAAAAAAAAAAAAAAAAAAC+Azy47PDiI4pA2wAAAABJRU5ErkJggg==";
const QA_IMAGE_INPUT = {
  type: "input_image",
  source: { type: "base64", mime_type: "image/png", data: QA_IMAGE_PNG_BASE64 },
} as const;
const QA_IMAGE_MEDIA_CONTEXT = {
  type: "input_text",
  text: "[media attached: media://inbound/red-top-blue-bottom.png (image/png)]",
} as const;
const QA_IMAGE_DESCRIPTION_PROMPT =
  "Image understanding check: describe the top and bottom colors.";
const QA_REASONING_ONLY_RECOVERY_PROMPT =
  "Reasoning-only continuation QA check: read QA_KICKOFF_TASK.md, then answer with exactly REASONING-RECOVERED-OK.";
const QA_REASONING_ONLY_SIDE_EFFECT_PROMPT =
  "Reasoning-only after write safety check: write reasoning-only-side-effect.txt, then answer with exactly SIDE-EFFECT-GUARD-OK.";
const QA_MIXED_REASONING_BLANK_FALLBACK_PROMPT =
  "Mixed reasoning blank fallback QA check: recover through the alternate model.";
const QA_THINKING_VISIBILITY_OFF_PROMPT =
  "QA thinking visibility check off: answer exactly THINKING-OFF-OK.";
const QA_THINKING_VISIBILITY_MAX_PROMPT =
  "QA thinking visibility check max: verify 17+24=41 internally, then answer exactly THINKING-MAX-OK.";
const QA_EMPTY_RESPONSE_RECOVERY_PROMPT =
  "Empty response continuation QA check: read QA_KICKOFF_TASK.md, then answer with exactly EMPTY-RECOVERED-OK.";
const QA_EMPTY_RESPONSE_EXHAUSTION_PROMPT =
  "Empty response exhaustion QA check: read QA_KICKOFF_TASK.md, then answer with exactly EMPTY-EXHAUSTED-OK.";
const QA_EMPTY_RESPONSE_SIDE_EFFECT_RECOVERY_PROMPT =
  "Empty response after write recovery QA check: write qa-empty-response-side-effect.txt, then answer with exactly TELEGRAM-EMPTY-WRITE-RECOVERED-OK.";
const QA_ANTHROPIC_THINKING_ERROR_RECOVERY_PROMPT =
  "Anthropic thinking error QA check: read QA_KICKOFF_TASK.md, then answer with exactly ANTHROPIC-THINKING-ERROR-RECOVERED-OK.";
const QA_REASONING_ONLY_RETRY_INSTRUCTION =
  "The previous assistant turn recorded reasoning but did not produce a user-visible answer. Continue from that partial turn and produce the visible answer now. Do not restate the reasoning or restart from scratch.";
const QA_EMPTY_RESPONSE_RETRY_INSTRUCTION =
  "The previous attempt did not produce a user-visible answer. Continue from the current state and produce the visible answer now. Do not restart from scratch.";
const QA_SETTLED_TOOL_TERMINAL_CONTINUATION_INSTRUCTION =
  "The previous assistant turn completed its tool calls but did not produce a user-visible answer. Continue from the current transcript and produce the final user-visible answer now. Do not repeat completed tool calls or restart from scratch.";
const QA_COMPACTION_RETRY_CODE_MODE_WRITE_RESULT = {
  status: "completed",
  value: {
    changed: true,
    created: true,
    diff: "+1 Replay safety: unsafe after write.",
    patch: [
      "--- compaction-retry-summary.txt",
      "+++ compaction-retry-summary.txt",
      "@@ -0,0 +1,1 @@",
      "+Replay safety: unsafe after write.",
      "",
    ].join("\n"),
    firstChangedLine: 1,
  },
  output: [],
  replaySafe: false,
  telemetry: {
    catalogSize: 32,
    sources: { openclaw: 32, mcp: 0, client: 0 },
    counterScope: "qaFixtureScope01",
    searchCount: 0,
    describeCount: 0,
    callCount: 1,
  },
} as const;
const QA_COMPACTION_RETRY_PROMPT =
  "Compaction retry mutating tool check. Current durable context marker: QA-COMPACTION-DURABLE-MARKER. Create compaction-retry-summary.txt.";
const QA_COMPACTION_RETRY_OVERFLOW_PADDING = "x".repeat(300_000);
const QA_COMPACTION_RETRY_HISTORICAL_PHRASE = "post-marker historical user block";
const QA_COMPACTION_EMPTY_RECOVERY_SUMMARY_MARKER = "QA-COMPACTION-EMPTY-RECOVERED-SUMMARY";
const QA_COMPACTION_REASONING_RECOVERY_SUMMARY_MARKER = "QA-COMPACTION-REASONING-RECOVERED-SUMMARY";
const QA_COMPACTION_SUMMARY_HEADINGS = [
  "## Decisions",
  "## Open TODOs",
  "## Constraints/Rules",
  "## Pending user asks",
  "## Exact identifiers",
] as const;
const QA_COMPACTION_SUMMARY_INSTRUCTIONS = `You are a context summarization assistant. Your task is to read a conversation between a user and an AI assistant, then produce a structured summary following the exact format specified.

Do NOT continue the conversation. Do NOT respond to any questions in the conversation. ONLY output the structured summary.`;

function expectCurrentCompactionSummaryHeadings(summary: string) {
  expect(summary.match(/^## .+$/gmu)).toEqual(QA_COMPACTION_SUMMARY_HEADINGS);
  expect(summary).not.toContain("## Goal");
}

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()?.();
  }
});

async function startMockServer(params?: { finalOnlyMarkerPauseMs?: number; modelRefs?: string[] }) {
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

async function postJson(server: MockServer, path: string, body: unknown) {
  return fetch(`${server.baseUrl}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

async function expectOk(responsePromise: Promise<Response>) {
  const response = await responsePromise;
  expect(response.status).toBe(200);
  return response;
}

function fetchOk(input: URL | RequestInfo, init?: RequestInit) {
  return expectOk(fetch(input, init));
}

async function fetchOkJson<T>(input: URL | RequestInfo, init?: RequestInit) {
  return (await fetchOk(input, init)).json() as Promise<T>;
}

function getJson<T>(server: MockServer, path: string) {
  return fetchOkJson<T>(`${server.baseUrl}${path}`);
}

function expectPostJson(server: MockServer, path: string, body: unknown) {
  return expectOk(postJson(server, path, body));
}

async function expectPostJsonJson<T>(server: MockServer, path: string, body: unknown) {
  return (await expectPostJson(server, path, body)).json() as Promise<T>;
}

async function postResponses(server: MockServer, body: unknown) {
  return postJson(server, "/v1/responses", body);
}

function postNonStreamingResponses(server: MockServer, body: Record<string, unknown>) {
  return postResponses(server, { stream: false, ...body });
}

function expectNonStreamingResponses(server: MockServer, body: Record<string, unknown>) {
  return expectResponses(server, { stream: false, ...body });
}

function expectOpenAiNonStreamingResponses(server: MockServer, body: Record<string, unknown>) {
  return expectNonStreamingResponses(server, { model: "gpt-5.6-luna", ...body });
}

function postStreamingResponses(server: MockServer, body: Record<string, unknown>) {
  return postResponses(server, { stream: true, ...body });
}

function expectStreamingResponses(server: MockServer, body: Record<string, unknown>) {
  return expectResponses(server, { stream: true, ...body });
}

function expectOpenAiStreamingResponses(server: MockServer, body: Record<string, unknown>) {
  return expectStreamingResponses(server, { model: "gpt-5.6-luna", ...body });
}

function postAnthropicMessages(server: MockServer, body: Record<string, unknown>) {
  return postJson(server, "/v1/messages", {
    model: "claude-opus-4-8",
    max_tokens: 256,
    ...body,
  });
}

function expectAnthropicMessages(server: MockServer, body: Record<string, unknown>) {
  return expectOk(postAnthropicMessages(server, body));
}

function expectResponses(server: MockServer, body: unknown) {
  return expectOk(postResponses(server, body));
}

async function expectResponsesText(server: MockServer, body: unknown) {
  return (await expectResponses(server, body)).text();
}

async function expectResponsesJson<T>(server: MockServer, body: unknown) {
  return (await expectResponses(server, body)).json() as Promise<T>;
}

function expectStreamingResponsesText(server: MockServer, body: Record<string, unknown>) {
  return expectResponsesText(server, { stream: true, ...body });
}

function expectAnthropicMessagesJson<T>(server: MockServer, body: Record<string, unknown>) {
  return expectPostJsonJson<T>(server, "/v1/messages", {
    model: "claude-opus-4-8",
    max_tokens: 256,
    ...body,
  });
}

function expectNonStreamingResponsesJson<T>(server: MockServer, body: Record<string, unknown>) {
  return expectResponsesJson<T>(server, { stream: false, ...body });
}

function expectOpenAiNonStreamingResponsesJson<T>(
  server: MockServer,
  body: Record<string, unknown>,
) {
  return expectNonStreamingResponsesJson<T>(server, { model: "gpt-5.6-luna", ...body });
}

function expectOpenAiStreamingResponsesText(server: MockServer, body: Record<string, unknown>) {
  return expectStreamingResponsesText(server, { model: "gpt-5.6-luna", ...body });
}

function parseStreamingResponseEvents(body: string): StreamEvent[] {
  return body
    .split("\n")
    .filter((line) => line.startsWith("data: {") && line.endsWith("}"))
    .map((line) => JSON.parse(line.slice("data: ".length)) as StreamEvent);
}

const requireRecord = createRequireRecord("record", "expected-label-capitalized");

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

function makeImageUserInput(...content: unknown[]) {
  return { role: "user" as const, content };
}

function readMockImageResponse(server: MockServer, input: unknown[]) {
  return expectNonStreamingResponsesJson<{
    output?: Array<{ content?: Array<{ text?: string }> }>;
  }>(server, { model: "mock-openai/gpt-5.6-luna", input });
}

async function readMockImageResponseText(server: MockServer, input: unknown[]) {
  return outputText(await readMockImageResponse(server, input));
}

function readMockResponse(server: MockServer, input: unknown[]) {
  return expectNonStreamingResponses(server, { input });
}

function readOpenAiPromptResponseText(server: MockServer, prompt: string, ...input: unknown[]) {
  return expectOpenAiStreamingResponsesText(server, { input: [makeUserInput(prompt), ...input] });
}

function makeToolOutput(output: unknown) {
  return { type: "function_call_output" as const, output };
}

function makeToolOutputWithCallId(callId: string, output: unknown) {
  return { type: "function_call_output" as const, call_id: callId, output };
}

function makeAnthropicUserText(text: string) {
  return { role: "user" as const, content: [{ type: "text" as const, text }] };
}

function makeAnthropicToolResult(toolUseId: unknown, content: string) {
  return {
    role: "user" as const,
    content: [{ type: "tool_result" as const, tool_use_id: toolUseId as string, content }],
  };
}

function makeAnthropicErrorToolResult(toolUseId: unknown, content: string) {
  return {
    role: "user" as const,
    content: [
      { type: "tool_result" as const, tool_use_id: toolUseId as string, is_error: true, content },
    ],
  };
}

function makeWhatsAppStructuredUserInput(text: string, mediaKind?: "sticker") {
  if (!mediaKind) {
    return makeUserInput(text);
  }
  const mediaContext = [
    "WhatsApp media: ⟦openclaw:ctx⟧",
    "```json",
    JSON.stringify({ source: "whatsapp", type: "media", payload: { kind: mediaKind } }),
    "```",
  ].join("\n");
  return makeUserInput([mediaContext, text].filter(Boolean).join("\n\n"));
}

const WHATSAPP_STRUCTURED_SETUP_INPUT = makeUserInput(
  "When a later WhatsApp location message shows 37.774900, -122.419400, " +
    "reply with only this WhatsApp location marker: QA_WHATSAPP_LOCATION_OK. " +
    "When a later WhatsApp contact message appears, " +
    "reply with only this WhatsApp contact marker: QA_WHATSAPP_CONTACT_OK. " +
    "When a later WhatsApp sticker message appears, " +
    "reply with only this WhatsApp sticker marker: QA_WHATSAPP_STICKER_OK. " +
    "Reply with only this exact marker: QA_STRUCTURED_INITIAL_OK",
);
const WHATSAPP_STRUCTURED_CASES = [
  { body: "📍 37.774900, -122.419400", expected: "QA_WHATSAPP_LOCATION_OK" },
  { body: "<contact>", expected: "QA_WHATSAPP_CONTACT_OK" },
  { body: "", mediaKind: "sticker" as const, expected: "QA_WHATSAPP_STICKER_OK" },
];

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
    "[Chat messages since your last reply - for context]",
    ...history.map((entry, index) => `#history-${index + 1} ${entry.sender}: ${entry.body}`),
    "",
    "[Current message - respond to this]",
  ].join("\n");
}

const SESSIONS_SPAWN_TOOL = { type: "function", name: "sessions_spawn" } as const;
const SESSIONS_YIELD_TOOL = { type: "function", name: "sessions_yield" } as const;
const CODEX_DIRECT_YIELD_NAMESPACE = {
  type: "namespace",
  name: "openclaw_direct",
  tools: [SESSIONS_YIELD_TOOL],
} as const;
const CODEX_SUBAGENT_TOOL_NAMESPACE = {
  type: "namespace",
  name: "openclaw",
  tools: [SESSIONS_SPAWN_TOOL, SESSIONS_YIELD_TOOL],
} as const;
const CODEX_CUSTOM_PATCH_TOOL = {
  type: "custom",
  name: "apply_patch",
  format: { type: "grammar", syntax: "lark", definition: "start: /.+/" },
} as const;
const CODEX_CUSTOM_PATCH_NAMESPACE = {
  type: "namespace",
  name: "openclaw_direct",
  tools: [CODEX_CUSTOM_PATCH_TOOL],
} as const;
const READ_TOOL = { type: "function", name: "read" } as const;
const MESSAGE_TOOL = { type: "function", name: "message" } as const;
const IMAGE_GENERATE_TOOL = { type: "function", name: "image_generate" } as const;
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
const MESSAGE_DECISION_SUPPRESSION_PROMPT = "Message delivery decision suppression QA check.";
const MESSAGE_DECISION_SEND_PROMPT = "Message delivery decision send QA check.";
const MESSAGE_DECISION_SUPPRESSION_TEXT =
  "Delivery: Final assistant text is not automatically delivered in this run. Use the `message` tool to send user-visible output.";
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
  it("returns HTTP 503 only after the provider failure fixture receives tool output", async () => {
    const server = await startMockServer();
    const prompt = "Provider HTTP 503 after tool QA check: read QA_KICKOFF_TASK.md, then reply.";

    const toolPlan = await expectOpenAiNonStreamingResponses(server, {
      tools: [READ_TOOL],
      input: [makeUserInput(prompt)],
    });
    expect(outputItem(await toolPlan.json()).name).toBe("read");

    const failure = await postNonStreamingResponses(server, {
      model: "gpt-5.6-luna",
      tools: [READ_TOOL],
      input: [
        makeUserInput(prompt),
        makeToolOutputWithCallId("call_mock_provider_503", "QA mission loaded"),
      ],
    });

    expect(failure.status).toBe(503);
    expect(await failure.json()).toEqual({
      error: {
        type: "server_error",
        message: "Service Unavailable",
      },
    });
  });

  it("keeps cursor reads correct when retained debug requests rotate", async () => {
    const server = await startMockServer();
    const debugRequestLimit = 2_000;
    const readCursor = async () =>
      readQaMockRequestCursor(
        await fetch(`${server.baseUrl}/debug/request-cursor`).then((response) => response.json()),
      );

    expect(await readCursor()).toBe(0);
    for (let index = 0; index < debugRequestLimit; index += 1) {
      await expectOpenAiNonStreamingResponsesJson(server, {
        input: [makeUserInput(`cursor request ${index}`)],
      });
    }
    const cursor = await readCursor();
    expect(cursor).toBe(debugRequestLimit);

    await expectOpenAiNonStreamingResponsesJson(server, {
      input: [makeUserInput("cursor request overflow")],
    });

    const retained = requireArray(
      await fetch(`${server.baseUrl}/debug/requests`).then((response) => response.json()),
      "retained debug requests",
    );
    expect(retained).toHaveLength(debugRequestLimit);
    expect(requireRecord(retained[0], "retained request 0").cursor).toBe(2);
    expect(requireRecord(retained.at(-1), "last retained request").cursor).toBe(
      debugRequestLimit + 1,
    );

    const nextRequests = requireArray(
      await fetch(`${server.baseUrl}/debug/requests?after=${cursor}`).then((response) =>
        response.json(),
      ),
      "debug requests after cursor",
    );
    expect(nextRequests).toHaveLength(1);
    expect(String(requireRecord(nextRequests[0], "next request").prompt)).toContain("overflow");

    const expired = await fetch(`${server.baseUrl}/debug/requests?after=0`);
    expect(expired.status).toBe(409);
    expect(await expired.json()).toEqual({
      error: "request cursor expired",
      after: 0,
      oldestCursor: 2,
      latestCursor: debugRequestLimit + 1,
    });

    const futureCursor = debugRequestLimit + 2;
    const future = await fetch(`${server.baseUrl}/debug/requests?after=${futureCursor}`);
    expect(future.status).toBe(409);
    expect(await future.json()).toEqual({
      error: "request cursor is ahead of the latest recorded request",
      after: futureCursor,
      latestCursor: debugRequestLimit + 1,
    });

    const invalid = await fetch(`${server.baseUrl}/debug/requests?after=1.5`);
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toEqual({
      error: "after must be a non-negative safe integer",
    });
  });

  it("retains enough debug requests for long shared QA runs", async () => {
    const server = await startMockServer();

    for (let index = 0; index < 250; index += 1) {
      await expectOpenAiNonStreamingResponsesJson(server, {
        input: [makeUserInput(`debug retention request ${index}`)],
      });
    }

    const requestLog = requireArray(await getJson(server, "/debug/requests"), "debug requests");
    expect(requestLog).toHaveLength(250);
    expect(String(requireRecord(requestLog[0], "debug request 0").allInputText)).toContain(
      "debug retention request 0",
    );
    expect(String(requireRecord(requestLog[249], "debug request 249").allInputText)).toContain(
      "debug retention request 249",
    );
  });

  it("serves health and streamed responses", async () => {
    const server = await startMockServer();

    expect(await getJson(server, "/healthz")).toEqual({ ok: true, status: "live" });

    const response = await expectStreamingResponses(server, {
      input: [makeUserInput("Inspect the repo docs and kickoff task.")],
    });
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const body = await response.text();
    expect(body).toContain('"type":"response.output_item.added"');
    expect(body).toContain('"name":"read"');
  });

  it("turns a short approval into a kickoff-task read", async () => {
    const server = await startMockServer();

    const preActionPayload = await expectOpenAiNonStreamingResponsesJson(server, {
      input: [
        makeUserInput(
          "Before acting, tell me the single file you would start with in six words or fewer. Do not use tools yet.",
        ),
      ],
    });
    expect(outputItem(preActionPayload).type).toBe("message");
    expect(outputText(preActionPayload)).toContain("Protocol note: acknowledged.");

    const approvalBody = await expectOpenAiStreamingResponsesText(server, {
      input: [
        makeUserInput(
          "Before acting, tell me the single file you would start with in six words or fewer. Do not use tools yet.",
        ),
        makeUserInput(
          "ok do it. read `QA_KICKOFF_TASK.md` now and reply with the QA mission in one short sentence.",
        ),
      ],
    });
    expect(approvalBody).toContain('"name":"read"');
    expect(approvalBody).toContain('"arguments":"{\\"path\\":\\"QA_KICKOFF_TASK.md\\"}"');

    const debugPayload = requireRecord(
      await getJson(server, "/debug/last-request"),
      "debug request",
    );
    expect(debugPayload.model).toBe("gpt-5.6-luna");
    expect(debugPayload.prompt).toBe(
      "ok do it. read `QA_KICKOFF_TASK.md` now and reply with the QA mission in one short sentence.",
    );
    expect(String(debugPayload.allInputText)).toContain("ok do it.");
    expect(debugPayload.plannedToolName).toBe("read");
  });

  it("returns a substantive private final fixture for the message-tool warning scenario", async () => {
    const server = await startMockServer();

    const body = await expectOpenAiNonStreamingResponsesJson<{
      output?: Array<{ content?: Array<{ text?: string }> }>;
    }>(server, {
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

    const initialBody = await expectOpenAiNonStreamingResponsesJson<{
      output?: Array<{ content?: Array<{ text?: string }> }>;
    }>(server, {
      tools: [MESSAGE_TOOL],
      input: [
        makeUserInput(
          "qa stranded final recovery check. Include `QA-STRANDED-85714` in a thorough multi-sentence answer, but do not call any tool yet.",
        ),
      ],
    });

    const initialText = initialBody.output?.[0]?.content?.[0]?.text ?? "";
    expect(initialText).toContain("QA-STRANDED-85714");
    expect(initialText).toContain("近 7 日營收較前期增加");
    expect(initialText).toHaveLength(167);
    expect(initialText.match(/[.!?]+(?:\s|$)/g) ?? []).toHaveLength(0);
    expect(outputItems(initialBody).some((item) => item.type === "function_call")).toBe(false);

    const retryBody = await expectOpenAiNonStreamingResponsesJson(server, {
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
      message: initialText,
    });
  });

  it("returns the same Teams final after the message-tool send", async () => {
    const server = await startMockServer();
    const prompt = [
      "qa msteams thread message-tool final dedupe.",
      "msteams message target: `conversation:19:other@thread.tacv2;messageid=other-root`.",
      "exact marker: `QA-MSTEAMS-THREAD-DEDUPE-OK`",
    ].join(" ");

    const initialBody = await expectOpenAiNonStreamingResponsesJson(server, {
      tools: [MESSAGE_TOOL],
      input: [makeUserInput(prompt)],
    });
    const toolCall = outputToolCall(initialBody, "message");
    expect(outputToolArgsFromItem(toolCall)).toEqual({
      action: "send",
      message: "QA-MSTEAMS-THREAD-DEDUPE-OK",
      target: "conversation:19:other@thread.tacv2;messageid=other-root",
    });

    const finalBody = await expectOpenAiNonStreamingResponsesJson(server, {
      tools: [MESSAGE_TOOL],
      input: [
        makeUserInput(prompt),
        makeToolOutputWithCallId(
          outputToolCallId(toolCall, "call_msteams_thread_dedupe"),
          JSON.stringify({ ok: true }),
        ),
      ],
    });
    expect(outputText(finalBody)).toBe("QA-MSTEAMS-THREAD-DEDUPE-OK");
    expect(outputItems(finalBody).some((item) => item.type === "function_call")).toBe(false);
  });

  it("returns a distinct final after the ambiguous Teams message-tool send", async () => {
    const server = await startMockServer();
    const prompt = "qa msteams ambiguous gateway timeout. exact marker: `QA-MSTEAMS-AMBIGUOUS-504`";

    const initialBody = await expectOpenAiNonStreamingResponsesJson(server, {
      tools: [MESSAGE_TOOL],
      input: [makeUserInput(prompt)],
    });
    const toolCall = outputToolCall(initialBody, "message");
    expect(outputToolArgsFromItem(toolCall)).toEqual({
      action: "send",
      message: "QA-MSTEAMS-AMBIGUOUS-504",
    });

    const finalBody = await expectOpenAiNonStreamingResponsesJson(server, {
      tools: [MESSAGE_TOOL],
      input: [
        makeUserInput(prompt),
        makeToolOutputWithCallId(outputToolCallId(toolCall, "call_msteams_timeout"), "failed"),
      ],
    });
    expect(outputText(finalBody)).toBe("QA-MSTEAMS-AMBIGUOUS-FINAL");
  });

  it("keeps the retry-failure stranded-final fixture as text without a message tool call", async () => {
    const server = await startMockServer();

    const body = await expectOpenAiNonStreamingResponsesJson<{
      output?: Array<{ content?: Array<{ text?: string }> }>;
    }>(server, {
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
    const response = await expectStreamingResponses(server, {
      input: [
        makeUserInput(
          "Final-only marker streaming QA check. Reply exactly: QA-FINAL-ONLY-STREAMING-OK",
        ),
      ],
    });

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

    const toolPlan = await expectOpenAiNonStreamingResponsesJson(server, {
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

    const debugPayload = requireRecord(
      await getJson(server, "/debug/last-request"),
      "debug request",
    );
    expect(debugPayload.plannedToolName).toBe("sessions_send");
    expect(debugPayload.plannedToolArgs).toMatchObject({
      sessionKey: "agent:qa:a2a-target",
      timeoutSeconds: 0,
    });

    const final = await expectOpenAiNonStreamingResponsesJson(server, {
      tools: [{ type: "function", name: "sessions_send" }],
      input: [
        makeUserInput(prompt),
        makeToolOutputWithCallId(
          "call_mock_sessions_send_fixture",
          JSON.stringify({ status: "accepted", delivery: { mode: "announce" } }),
        ),
      ],
    });
    expect(outputText(final)).toBe("");

    const targetToolPlan = await expectOpenAiNonStreamingResponsesJson(server, {
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

    const quietBody = await expectStreamingResponsesText(server, {
      input: [makeUserInput("Quiet streaming QA check: reply exactly `QA_STREAMING_OK`.")],
    });
    expect(quietBody).toContain('"type":"response.output_text.delta"');
    expect(quietBody).toContain('"phase":"final_answer"');
    expect(quietBody).toContain("QA_STREAMING_OK");

    const partialBody = await expectStreamingResponsesText(server, {
      input: [makeUserInput("Partial streaming QA check: reply exactly `QA_PARTIAL_OK`.")],
    });
    expect(partialBody).toContain('"type":"response.output_text.delta"');
    expect(partialBody).toContain("QA_PARTIAL_OK");

    const telegramStreamBody = await expectStreamingResponsesText(server, {
      input: [
        makeUserInput("Telegram reply-chain marker QA. Reply exactly: QA-TELEGRAM-REPLY-CHAIN-OK"),
        makeUserInput("Quiet streaming QA check. Reply exactly: QA-TELEGRAM-STREAM-SINGLE-OK"),
      ],
    });
    expect(telegramStreamBody).toContain("QA-TELEGRAM-STREAM-SINGLE-OK");
    expect(telegramStreamBody).not.toContain("QA-TELEGRAM-REPLY-CHAIN-OK");

    const telegramLongBody = await expectStreamingResponsesText(server, {
      input: [makeUserInput("Telegram long final QA check. Use the scripted long final response.")],
    });
    expect(telegramLongBody).toContain('"type":"response.output_text.delta"');
    expect(telegramLongBody).toContain('"phase":"final_answer"');
    expect(telegramLongBody).toContain("TELEGRAM-LONG-FINAL-BEGIN");
    expect(telegramLongBody).toContain("TELEGRAM-LONG-FINAL-END");
    expect(telegramLongBody.length).toBeGreaterThan(4_500);

    const whatsappLongBody = await expectStreamingResponsesText(server, {
      input: [makeUserInput("WhatsApp long final QA check. Use the scripted long final response.")],
    });
    expect(whatsappLongBody).toContain('"type":"response.output_text.delta"');
    expect(whatsappLongBody).toContain('"phase":"final_answer"');
    expect(whatsappLongBody).toContain("WHATSAPP-LONG-FINAL-BEGIN");
    expect(whatsappLongBody).toContain("WHATSAPP-LONG-FINAL-END");
    expect(whatsappLongBody.length).toBeGreaterThan(6_000);

    const telegramThreeChunkLongBody = await expectStreamingResponsesText(server, {
      input: [
        makeUserInput(
          "Telegram long final three chunk QA check. Use the scripted three chunk final response.",
        ),
      ],
    });
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
    const blockBody = await expectStreamingResponsesText(server, {
      input: [makeUserInput(blockPrompt)],
    });
    expect(blockBody).toContain('"item_id":"msg_mock_block_1"');
    expect(blockBody).toContain('"name":"read"');
    expect(blockBody).toContain("QA_KICKOFF_TASK.md");
    expect(blockBody).toContain("BLOCK_ONE_OK");
    expect(blockBody).not.toContain('"item_id":"msg_mock_block_2"');

    const blockContinuationBody = await expectStreamingResponsesText(server, {
      input: [
        makeUserInput(blockPrompt),
        makeToolOutputWithCallId("call_mock_read_fixture", "QA kickoff task read"),
      ],
    });
    expect(blockContinuationBody).toContain('"item_id":"msg_mock_block_2"');
    expect(blockContinuationBody).toContain("BLOCK_TWO_OK");
    expect(blockContinuationBody).not.toContain('"item_id":"msg_mock_block_1"');
  });

  it("serves Telegram visible and unsent failure directives", async () => {
    const server = await startMockServer();
    const visibleEvents = parseStreamingResponseEvents(
      await expectOpenAiStreamingResponsesText(server, {
        input: [makeUserInput("Telegram visible partial failure QA check")],
      }),
    );
    const unsentEvents = parseStreamingResponseEvents(
      await expectOpenAiStreamingResponsesText(server, {
        input: [makeUserInput("Telegram unsent failure QA check")],
      }),
    );

    expect(visibleEvents.map((event) => event.type)).toEqual([
      "response.created",
      "response.output_item.added",
      "response.output_text.delta",
      "response.failed",
    ]);
    expect(visibleEvents[2]).toMatchObject({
      type: "response.output_text.delta",
      delta: "TELEGRAM-VISIBLE-PARTIAL-BEFORE-FAILURE",
    });
    expect(unsentEvents.map((event) => event.type)).toEqual([
      "response.created",
      "response.failed",
    ]);
    expect(unsentEvents.some((event) => event.type === "response.output_text.delta")).toBe(false);
  });

  it("plans deterministic tool-progress reads from prompt paths", async () => {
    const server = await startMockServer();

    const response = await expectStreamingResponses(server, {
      input: [
        makeUserInput(
          "Tool progress QA check: read `qa-progress-target.txt` before answering. After the read completes, reply exactly `TOOL_PROGRESS_OK`.",
        ),
      ],
    });

    const body = await response.text();
    expect(body).toContain('"name":"read"');
    expect(body).toContain("qa-progress-target.txt");
  });

  it("plans deterministic tool-progress reads for exact-marker prompts", async () => {
    const server = await startMockServer();
    const prompt =
      "Tool progress QA check: use the read tool exactly once on `QA_KICKOFF_TASK.md` before answering. After that read completes, reply with only this exact marker and no other text: `TOOL_PROGRESS_MARKER_OK`.";

    const toolPlan = await expectStreamingResponses(server, {
      input: [makeUserInput(prompt)],
    });

    const toolPlanBody = await toolPlan.text();
    expect(toolPlanBody).toContain('"name":"read"');
    expect(toolPlanBody).toContain("QA_KICKOFF_TASK.md");

    const final = await expectOpenAiNonStreamingResponsesJson<{
      output: Array<{ content?: Array<{ text?: string }> }>;
    }>(server, {
      input: [
        makeUserInput(prompt),
        makeToolOutputWithCallId("call_mock_read_1", JSON.stringify({ text: "kickoff task" })),
      ],
    });
    expect(final.output[0]?.content?.[0]?.text).toBe("TOOL_PROGRESS_MARKER_OK");
  });

  it("prefers a current tool-result marker over system and stale user directives", async () => {
    const server = await startMockServer();
    const prompt = [
      "Tool progress QA check: call the read tool exactly once on `QA_KICKOFF_TASK.md` before answering.",
      "The only valid final marker is inside that file.",
      "After the read completes, reply with only the exact marker from the file.",
    ].join(" ");
    const marker = "TOOL_PROGRESS_OUTPUT_MARKER_OK";

    const final = await expectNonStreamingResponsesJson<{
      output: Array<{ content?: Array<{ text?: string }> }>;
    }>(server, {
      instructions: "If nothing needs attention, reply exactly: HEARTBEAT_OK",
      input: [
        makeUserInput(
          "Earlier tool progress QA check: after the tool returns, reply exactly `STALE_PROGRESS_MARKER`.",
        ),
        makeUserInput(prompt),
        makeToolOutputWithCallId(
          "call_mock_read_1",
          [
            "Matrix tool progress QA task.",
            "Reply with only this exact marker and no other text:",
            marker,
          ].join("\n"),
        ),
        makeUserInput(QA_SETTLED_TOOL_TERMINAL_CONTINUATION_INSTRUCTION),
      ],
    });

    expect(final.output[0]?.content?.[0]?.text).toBe(marker);
  });

  it("plans deterministic tool-progress exec commands from exact command prompts", async () => {
    const server = await startMockServer();
    const command =
      "rg -n 'matrix-progress-@room-@alice:matrix-qa.test-!room:matrix-qa.test.txt' . ; sleep 2";
    const prompt = `Tool progress QA check: call the exec tool exactly once with this exact command before answering: \`${command}\`. After that exec command completes or fails, reply exactly \`TOOL_PROGRESS_EXEC_OK\`.`;

    const response = await expectStreamingResponses(server, {
      input: [makeUserInput(prompt)],
    });

    const body = await response.text();
    expect(body).toContain('"name":"exec"');
    expect(body).toContain(command);
  });

  it("dispatches structured Slack commentary, exec, and final phases", async () => {
    const server = await startMockServer();
    const suffix = "A1B2C3D4";
    const commentaryMarker = `SLACK-QA-COMMENTARY-${suffix}`;
    const toolMarker = `SLACK-QA-TOOL-${suffix}`;
    const finalMarker = `SLACK-QA-COMMENTARY-DONE-${suffix}`;
    const command = `grep '${toolMarker}' /dev/null || sleep 5`;
    const prompt = `${commentaryMarker} ${command} ${finalMarker}`;
    const stalePrompt =
      "SLACK-QA-COMMENTARY-11112222 grep 'SLACK-QA-TOOL-11112222' /dev/null || sleep 5 SLACK-QA-COMMENTARY-DONE-11112222";
    const currentEnvelope = `${stalePrompt}\n${prompt}`;

    const planResponse = await expectStreamingResponses(server, {
      tools: [{ type: "function", name: "exec" }],
      input: [
        makeUserInput(stalePrompt),
        makeToolOutputWithCallId("call_stale_slack_progress", ""),
        makeUserInput(currentEnvelope),
      ],
    });
    const events = (await planResponse.text())
      .split("\n")
      .filter((line) => line.startsWith("data: {"))
      .map((line) => requireRecord(JSON.parse(line.slice("data: ".length)), "Slack SSE event"));
    const completedItems = events
      .filter((event) => event.type === "response.output_item.done")
      .map((event) => requireRecord(event.item, "Slack completed item"));
    expect(completedItems).toHaveLength(2);
    expect(completedItems[0]).toMatchObject({
      type: "message",
      phase: "commentary",
      content: [{ type: "output_text", text: commentaryMarker }],
    });
    const exec = completedItems[1];
    if (!exec) {
      throw new Error("expected Slack progress exec output item");
    }
    expect(exec).toMatchObject({ type: "function_call", name: "exec" });
    expect(outputToolArgsFromItem(exec)).toEqual({ command });
    expect(JSON.stringify(events)).not.toContain(finalMarker);

    const final = await expectNonStreamingResponsesJson(server, {
      tools: [{ type: "function", name: "exec" }],
      input: [
        makeUserInput(stalePrompt),
        makeToolOutputWithCallId("call_stale_slack_progress", ""),
        makeUserInput(currentEnvelope),
        makeToolOutputWithCallId(outputToolCallId(exec, "call_slack_progress"), ""),
      ],
    });
    expect(outputItem(final)).toMatchObject({ type: "message", phase: "final_answer" });
    expect(outputText(final)).toBe(finalMarker);
    expect(outputItems(final)).toHaveLength(1);
    expect(JSON.stringify(final)).not.toContain(commentaryMarker);
  });

  it("does not dispatch Slack progress when structured marker suffixes disagree", async () => {
    const server = await startMockServer();
    const payload = await expectNonStreamingResponsesJson(server, {
      tools: [{ type: "function", name: "exec" }],
      input: [
        makeUserInput(
          "SLACK-QA-COMMENTARY-A1B2C3D4 grep 'SLACK-QA-TOOL-11112222' /dev/null || sleep 5 SLACK-QA-COMMENTARY-DONE-A1B2C3D4",
        ),
      ],
    });

    expect(outputItems(payload)).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "exec" })]),
    );
  });

  it("honors exact replies after QA kickoff reads without marker wording", async () => {
    const server = await startMockServer();
    const prompt =
      "Gateway restart in-flight QA check. Read QA_KICKOFF_TASK.md, then reply exactly: RESTART-INFLIGHT-MAYBE-OK";

    const final = await expectNonStreamingResponsesJson<{
      output: Array<{ content?: Array<{ text?: string }> }>;
    }>(server, {
      input: [
        makeUserInput(prompt),
        makeToolOutputWithCallId(
          "call_mock_read_1",
          JSON.stringify({ text: "QA mission: understand this OpenClaw repo." }),
        ),
      ],
    });

    expect(final.output[0]?.content?.[0]?.text).toBe("RESTART-INFLIGHT-MAYBE-OK");
  });

  it("does not use stale exact replies from instructions after QA reads", async () => {
    const server = await startMockServer();

    const final = await expectNonStreamingResponsesJson<{
      output: Array<{ content?: Array<{ text?: string }> }>;
    }>(server, {
      instructions: "If this is a heartbeat check, reply exactly: HEARTBEAT_OK",
      input: [
        makeUserInput("Read QA_KICKOFF_TASK.md, then summarize what you found."),
        makeToolOutputWithCallId(
          "call_mock_read_1",
          JSON.stringify({ text: "QA mission: understand this OpenClaw repo." }),
        ),
      ],
    });

    const text = final.output[0]?.content?.[0]?.text ?? "";
    expect(text).toContain("Protocol note: I reviewed the requested material.");
    expect(text).not.toContain("HEARTBEAT_OK");
  });

  it("preserves surrogate pairs in HTTP tool-output evidence snippets", async () => {
    const server = await startMockServer();
    const safePrefix = "x".repeat(219);

    const final = await expectNonStreamingResponsesJson<{
      output: Array<{ content?: Array<{ text?: string }> }>;
    }>(server, {
      input: [
        makeUserInput("Summarize the tool result."),
        makeToolOutputWithCallId("call_mock_read_1", `${safePrefix}😀tail`),
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

    const toolPlan = await expectStreamingResponses(server, {
      input: [makeUserInput(prompt)],
    });

    const toolPlanBody = await toolPlan.text();
    expect(toolPlanBody).toContain('"name":"read"');
    expect(toolPlanBody).toContain("missing-tool-progress-target.txt");

    const successOutput = await expectNonStreamingResponsesJson<{
      output: Array<{ content?: Array<{ text?: string }> }>;
    }>(server, {
      input: [
        makeUserInput(prompt),
        makeToolOutputWithCallId(
          "call_mock_read_1",
          JSON.stringify({ text: "unexpected success" }),
        ),
      ],
    });
    expect(successOutput.output[0]?.content?.[0]?.text).toBe("BUG-TOOL-DID-NOT-FAIL");

    const errorOutput = await expectNonStreamingResponsesJson<{
      output: Array<{ content?: Array<{ text?: string }> }>;
    }>(server, {
      input: [
        makeUserInput(prompt),
        makeToolOutputWithCallId(
          "call_mock_read_1",
          JSON.stringify({ error: "ENOENT: no such file or directory" }),
        ),
      ],
    });
    expect(errorOutput.output[0]?.content?.[0]?.text).toBe("TOOL_PROGRESS_ERROR_OK");
  });

  it("uses the latest user tool-progress prompt kind and target for plans", async () => {
    const server = await startMockServer();

    const response = await expectStreamingResponses(server, {
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
    });

    const body = await response.text();
    expect(body).toContain('"name":"read"');
    expect(body).toContain("latest-missing-progress-target.txt");
    expect(body).not.toContain("older-progress-target.txt");

    const command = "sleep 2; cat 'current-progress-target.txt'";
    const currentNormal = await expectStreamingResponses(server, {
      input: [
        makeUserInput(
          "Tool progress error QA check: read `stale-missing-progress-target.txt` before answering. After the read fails, reply exactly `STALE_PROGRESS_OK`.",
        ),
        makeToolOutputWithCallId(
          "call_stale_progress_read",
          JSON.stringify({ error: "ENOENT: stale turn" }),
        ),
        makeUserInput(
          `Tool progress QA check: call the exec tool exactly once with this exact command before answering: \`${command}\`. After that command completes, reply exactly \`CURRENT_PROGRESS_OK\`.`,
        ),
      ],
    });

    const currentNormalBody = await currentNormal.text();
    expect(currentNormalBody).toContain('"name":"exec"');
    expect(currentNormalBody).toContain(command);
    expect(currentNormalBody).not.toContain("stale-missing-progress-target.txt");
  });

  it.each([
    {
      name: "preview",
      prompt:
        "@openclaw:matrix-qa.test Tool progress QA check: call the read tool exactly once on `QA_KICKOFF_TASK.md` before answering. After that read completes, reply exactly `CURRENT_PREVIEW_OK`.",
      toolName: "read",
      expectedArgs: { path: "QA_KICKOFF_TASK.md" },
    },
    {
      name: "command preview",
      prompt:
        "@openclaw:matrix-qa.test Tool progress QA check: call the exec tool exactly once with this exact command before answering: `printf 'matrix-command-progress-start\\n'; sleep 2`. After that exec command completes or fails, reply exactly `CURRENT_COMMAND_OK`.",
      toolName: "exec",
      expectedArgs: { command: "printf 'matrix-command-progress-start\\n'; sleep 2" },
    },
    {
      name: "error",
      prompt:
        "@openclaw:matrix-qa.test Tool progress error QA check: read `missing-matrix-tool-progress-target.txt` before answering. After the read fails, reply exactly `CURRENT_ERROR_OK`.",
      toolName: "read",
      expectedArgs: { path: "missing-matrix-tool-progress-target.txt" },
    },
    {
      name: "mention safety",
      prompt:
        "@openclaw:matrix-qa.test Tool progress QA check: read the missing workspace file `matrix-progress-@room-@alice:matrix-qa.test-!room:matrix-qa.test.txt` before answering. After that read fails, reply exactly `CURRENT_MENTION_OK`.",
      toolName: "read",
      expectedArgs: {
        path: "matrix-progress-@room-@alice:matrix-qa.test-!room:matrix-qa.test.txt",
      },
    },
  ])("routes current Matrix $name after stale streaming history", async (fixture) => {
    const server = await startMockServer();
    const payload = await expectNonStreamingResponsesJson(server, {
      input: [
        makeUserInput(
          "@openclaw:matrix-qa.test Quiet streaming QA check: reply exactly `STALE_STREAMING_OK`.",
        ),
        makeUserInput(fixture.prompt),
        makeUserInput("Continue with the current Matrix QA scenario."),
      ],
    });

    const toolCall = outputToolCall(payload, fixture.toolName);
    expect(outputToolArgsFromItem(toolCall)).toEqual(fixture.expectedArgs);
    expect(JSON.stringify(payload)).not.toContain("STALE_STREAMING_OK");
  });

  it("does not let a prior Matrix tool result satisfy the current progress prompt", async () => {
    const server = await startMockServer();
    const payload = await expectNonStreamingResponsesJson(server, {
      input: [
        makeUserInput(
          "@openclaw:matrix-qa.test Tool progress QA check: read `stale-progress-target.txt` before answering. Reply exactly `STALE_PROGRESS_OK`.",
        ),
        makeToolOutputWithCallId("call_mock_read_stale_progress", "STALE_PROGRESS_OK"),
        makeUserInput(
          "@openclaw:matrix-qa.test Tool progress QA check: read `current-progress-target.txt` before answering. Reply exactly `CURRENT_PROGRESS_OK`.",
        ),
      ],
    });

    const toolCall = outputToolCall(payload, "read");
    expect(outputToolArgsFromItem(toolCall)).toEqual({ path: "current-progress-target.txt" });
    expect(JSON.stringify(payload)).not.toContain("STALE_PROGRESS_OK");
  });

  it.each([
    {
      name: "quiet streaming",
      stalePrompt:
        "@openclaw:matrix-qa.test Quiet streaming QA check: reply exactly `STALE_QUIET_OK`.",
    },
    {
      name: "tool progress",
      stalePrompt:
        "@openclaw:matrix-qa.test Tool progress QA check: read `stale-progress-target.txt` before answering. Reply exactly `STALE_PROGRESS_OK`.",
    },
  ])("does not resurrect stale Matrix $name across an ordinary turn", async (fixture) => {
    const server = await startMockServer();
    const payload = await expectNonStreamingResponsesJson(server, {
      input: [
        makeUserInput(fixture.stalePrompt),
        makeUserInput("Reply exactly `CURRENT_ORDINARY_OK`."),
      ],
    });

    expect(outputText(payload)).toBe("CURRENT_ORDINARY_OK");
    expect(JSON.stringify(payload)).not.toContain("stale-progress-target.txt");
  });

  it("does not treat an ordinary retry request as a Matrix scenario continuation", async () => {
    const server = await startMockServer();
    const payload = await expectNonStreamingResponsesJson(server, {
      input: [
        makeUserInput(
          "@openclaw:matrix-qa.test Quiet streaming QA check: reply exactly `STALE_STREAMING_OK`.",
        ),
        makeUserInput(
          "Please retry the new database operation, then reply exactly `CURRENT_RETRY_OK`.",
        ),
      ],
    });

    expect(outputText(payload)).toBe("CURRENT_RETRY_OK");
    expect(JSON.stringify(payload)).not.toContain("STALE_STREAMING_OK");
  });

  it("uses the current tool result marker after stale streaming history", async () => {
    const server = await startMockServer();
    const currentPrompt =
      "@openclaw:matrix-qa.test Tool progress QA check: call the read tool exactly once on `QA_KICKOFF_TASK.md` before answering. The only valid final marker is inside that file.";
    const payload = await expectNonStreamingResponsesJson(server, {
      input: [
        makeUserInput(
          "@openclaw:matrix-qa.test Quiet streaming QA check: reply exactly `STALE_STREAMING_OK`.",
        ),
        makeUserInput(currentPrompt),
        makeToolOutputWithCallId(
          "call_mock_read_current_progress",
          "Reply with only this exact marker and no other text:\nCURRENT_PROGRESS_OK",
        ),
      ],
    });

    expect(outputText(payload)).toBe("CURRENT_PROGRESS_OK");
  });

  it("selects tool progress after quiet streaming in one user envelope", async () => {
    const server = await startMockServer();
    const currentPrompt =
      "@openclaw:matrix-qa.test Tool progress QA check: call the read tool exactly once on `QA_KICKOFF_TASK.md` before answering. The only valid final marker is inside that file.";
    const envelope = [
      "@openclaw:matrix-qa.test Quiet streaming QA check: reply exactly `STALE_ENVELOPE_OK`.",
      currentPrompt,
    ].join("\n");
    const plan = await expectNonStreamingResponsesJson(server, {
      input: [makeUserInput(envelope)],
    });

    const toolCall = outputToolCall(plan, "read");
    expect(outputToolArgsFromItem(toolCall)).toEqual({ path: "QA_KICKOFF_TASK.md" });
    expect(JSON.stringify(plan)).not.toContain("STALE_ENVELOPE_OK");

    const final = await expectNonStreamingResponsesJson(server, {
      input: [
        makeUserInput(envelope),
        makeToolOutputWithCallId(
          "call_mock_read_current_envelope",
          "Reply with only this exact marker and no other text:\nCURRENT_ENVELOPE_OK",
        ),
      ],
    });

    expect(outputText(final)).toBe("CURRENT_ENVELOPE_OK");
  });

  it("selects the latest tool-progress target in one user envelope", async () => {
    const server = await startMockServer();
    const envelope = [
      "Tool progress QA check: read `stale-progress-target.txt` before answering. Reply exactly `STALE_PROGRESS_OK`.",
      "Tool progress QA check: read `current-progress-target.txt` before answering. Reply exactly `CURRENT_PROGRESS_OK`.",
    ].join("\n");
    const payload = await expectNonStreamingResponsesJson(server, {
      input: [makeUserInput(envelope)],
    });

    const toolCall = outputToolCall(payload, "read");
    expect(outputToolArgsFromItem(toolCall)).toEqual({ path: "current-progress-target.txt" });
    expect(JSON.stringify(payload)).not.toContain("stale-progress-target.txt");
  });

  it("selects the latest block-streaming markers and target in one user envelope", async () => {
    const server = await startMockServer();
    const envelope = [
      "Block streaming QA check: first exact marker: `STALE_ONE`; read `stale-block.txt`; second exact marker: `STALE_TWO`.",
      "Block streaming QA check: first exact marker: `CURRENT_ONE`; read `current-block.txt`; second exact marker: `CURRENT_TWO`.",
    ].join("\n");
    const payload = await expectNonStreamingResponsesJson(server, {
      input: [makeUserInput(envelope)],
    });

    expect(outputText(payload)).toBe("CURRENT_ONE");
    const toolCall = outputToolCall(payload, "read");
    expect(outputToolArgsFromItem(toolCall)).toEqual({ path: "current-block.txt" });
    expect(JSON.stringify(payload)).not.toContain("STALE_ONE");
    expect(JSON.stringify(payload)).not.toContain("stale-block.txt");
  });

  it("rejects successful error-progress results without a prompt directive", async () => {
    const server = await startMockServer();
    const payload = await expectNonStreamingResponsesJson(server, {
      input: [
        makeUserInput(
          "Tool progress error QA check: read `missing-progress-target.txt` before answering. The final marker is supplied only after the tool runs.",
        ),
        makeToolOutputWithCallId(
          "call_mock_read_unexpected_success",
          "Reply with only this exact marker and no other text:\nFALSE_POSITIVE_OK",
        ),
      ],
    });

    expect(outputText(payload)).toBe("BUG-TOOL-DID-NOT-FAIL");
  });

  it("prefers path-like refs over generic quoted keys in prompts", async () => {
    const server = await startMockServer();

    const body = await expectStreamingResponsesText(server, {
      input: [
        makeUserInput(
          'Please inspect "message_id" metadata first, then read `./QA_KICKOFF_TASK.md`.',
        ),
      ],
    });
    expect(body).toContain('"arguments":"{\\"path\\":\\"QA_KICKOFF_TASK.md\\"}"');

    const debugPayload = requireRecord(
      await getJson(server, "/debug/last-request"),
      "debug request",
    );
    expect(debugPayload.prompt).toBe(
      'Please inspect "message_id" metadata first, then read `./QA_KICKOFF_TASK.md`.',
    );
    expect(debugPayload.allInputText).toBe(
      'Please inspect "message_id" metadata first, then read `./QA_KICKOFF_TASK.md`.',
    );
    expect(debugPayload.plannedToolName).toBe("read");
  });

  it("keeps unformatted Matrix mention-shaped filenames intact", () => {
    expect(
      readTargetFromPrompt(
        "Read the missing workspace file matrix-progress-@room-@alice:matrix-qa.test-!room:matrix-qa.test.txt before answering.",
      ),
    ).toBe("matrix-progress-@room-@alice:matrix-qa.test-!room:matrix-qa.test.txt");
    expect(readTargetFromPrompt("Read _fixture.json before answering.")).toBe("_fixture.json");
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

    const completion = await expectNonStreamingResponsesJson<{
      output?: Array<{ content?: Array<{ text?: string }> }>;
    }>(server, {
      input: [
        makeUserInput(prompt),
        makeToolOutputWithCallId(
          "call_mock_read_1",
          "CACHE-FIXTURE-1600 stable tool-result evidence.",
        ),
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
    const response = await expectNonStreamingResponsesJson<{
      output?: Array<{ content?: Array<{ text?: string }> }>;
    }>(server, {
      input: [
        makeUserInput(
          "Use qa-visible-skill now. Reply exactly with the visible skill marker and nothing else.",
        ),
      ],
    });

    expect(outputText(response)).toBe("VISIBLE-SKILL-OK");
  });

  it("drives the Lobster Invaders write flow and memory recall responses", async () => {
    const server = await startMockServer();

    const lobsterBody = await expectOpenAiStreamingResponsesText(server, {
      input: [
        makeUserInput("Please build Lobster Invaders after reading context."),
        makeToolOutput("QA mission: read source and docs first."),
      ],
    });
    expect(lobsterBody).toContain('"name":"write"');
    expect(lobsterBody).toContain("lobster-invaders.html");

    const payload = (await expectNonStreamingResponsesJson(server, {
      model: "gpt-5.6-luna-alt",
      input: [
        makeUserInput("Please remember this fact for later: the QA canary code is ALPHA-7."),
        makeUserInput("What was the QA canary code I asked you to remember earlier?"),
      ],
    })) as {
      output?: Array<{ content?: Array<{ text?: string }> }>;
    };
    expect(payload.output?.[0]?.content?.[0]?.text).toContain("ALPHA-7");

    const requestLog = requireArray(await getJson(server, "/debug/requests"), "debug requests");
    expect(requireRecord(requestLog[0], "debug request 0").model).toBe("gpt-5.6-luna");
    expect(requireRecord(requestLog[1], "debug request 1").model).toBe("gpt-5.6-luna-alt");
  });

  it("keeps remember prompts prose-only even when they mention repo cleanup", async () => {
    const server = await startMockServer();

    const body = await expectOpenAiStreamingResponsesText(server, {
      input: [
        makeUserInput(
          "Please remember this fact for later: the QA canary code is ALPHA-7. Use your normal memory mechanism, avoid manual repo cleanup, and reply exactly `Remembered ALPHA-7.` once stored.",
        ),
      ],
    });
    expect(body).toContain("Remembered ALPHA-7.");
    expect(body).not.toContain('"name":"read"');
  });

  it("requires retained bot history in the Slack MPIM thread-history prelude", async () => {
    const server = await startMockServer();
    const seedMarker = "SLACK_QA_MPIM_SEED_A1B2C3D4";
    const recallMarker = "SLACK_QA_MPIM_RECALL_A1B2C3D4";
    const missingMarker = "SLACK_QA_MPIM_MISSING_A1B2C3D4";
    const seedPrompt =
      `Slack MPIM assistant-history seed check. Reply with only a marker in this exact format: ${seedMarker}_BOT_<NONCE>. ` +
      "Replace <NONCE> with 8 to 32 new uppercase letters or digits. " +
      "Do not include angle brackets, spaces, Markdown, or punctuation.";
    const seedResponse = await expectOpenAiNonStreamingResponsesJson<unknown>(server, {
      input: [makeUserInput(seedPrompt)],
    });
    const botReplyMarker = outputText(seedResponse);
    expect(botReplyMarker).toMatch(new RegExp(`^${seedMarker}_BOT_[A-Z0-9]+$`, "u"));
    const botNonce = botReplyMarker.slice(`${seedMarker}_BOT_`.length);
    const expectedRecallMarker = `${recallMarker}_${botNonce}`;
    const recallPrompt = [
      "Slack MPIM assistant-history recall check.",
      `Recall the nonce from your immediately previous reply beginning with ${seedMarker}_BOT_.`,
      `Reply with only this exact format: ${recallMarker}_<NONCE>, using that same nonce.`,
      `Otherwise reply with only: ${missingMarker}`,
    ].join(" ");
    expect(recallPrompt).not.toContain(botReplyMarker);
    expect(recallPrompt).not.toContain(botNonce);

    const withRetainedBotHistory = await expectOpenAiNonStreamingResponsesJson<unknown>(server, {
      input: [
        makeUserInput(
          [
            "[Thread history - for context]",
            `[Slack Driver (user) Fri 2026-07-31 10:00 UTC] ${seedPrompt}`,
            "[slack message id: 1.000000 channel: C123]",
            "",
            `[Slack OpenClaw (this assistant) (assistant) Fri 2026-07-31 10:01 UTC] ${botReplyMarker}`,
            "[slack message id: 1.500000 channel: C123]",
            "",
            `[Slack Driver (user) Fri 2026-07-31 10:02 UTC] ${recallPrompt}`,
          ].join("\n"),
        ),
      ],
    });
    expect(outputText(withRetainedBotHistory)).toBe(expectedRecallMarker);

    const withStructuredAssistantHistoryOnly = await expectOpenAiNonStreamingResponsesJson<unknown>(
      server,
      {
        input: [
          makeUserInput(seedPrompt),
          {
            role: "assistant",
            content: [{ type: "output_text", text: botReplyMarker }],
          },
          makeUserInput(recallPrompt),
        ],
      },
    );
    expect(outputText(withStructuredAssistantHistoryOnly)).toBe(missingMarker);

    const withHumanAttributedSeed = await expectOpenAiNonStreamingResponsesJson<unknown>(server, {
      input: [
        makeUserInput(
          [
            "[Thread history - for context]",
            `[Slack Alice (user) Fri 2026-07-31 10:00 UTC] ${botReplyMarker}`,
            "[slack message id: 1.000000 channel: C123]",
            "",
            `[Slack Driver (user) Fri 2026-07-31 10:02 UTC] ${recallPrompt}`,
          ].join("\n"),
        ),
      ],
    });
    expect(outputText(withHumanAttributedSeed)).toBe(missingMarker);
  });

  it("drives repo-contract followthrough as read-read-read-write-then-report", async () => {
    const server = await startMockServer();

    const prompt =
      "Repo contract followthrough check. Read AGENT.md, SOUL.md, and FOLLOWTHROUGH_INPUT.md first. Then follow the repo contract exactly, write ./repo-contract-summary.txt, and reply with three labeled lines: Read, Wrote, Status.";

    const first = await expectOpenAiStreamingResponses(server, {
      input: [makeUserInput(prompt)],
    });
    expect(await first.text()).toContain('"arguments":"{\\"path\\":\\"AGENT.md\\"}"');

    const second = await expectOpenAiStreamingResponses(server, {
      input: [
        makeUserInput(prompt),
        makeToolOutput(
          "# Repo contract\n\nStep order:\n1. Read AGENT.md.\n2. Read SOUL.md.\n3. Read FOLLOWTHROUGH_INPUT.md.\n4. Write ./repo-contract-summary.txt.\n",
        ),
      ],
    });
    expect(await second.text()).toContain('"arguments":"{\\"path\\":\\"SOUL.md\\"}"');

    const third = await expectOpenAiStreamingResponses(server, {
      input: [
        makeUserInput(prompt),
        makeToolOutput("# Execution style\n\nStay brief, honest, and action-first.\n"),
      ],
    });
    expect(await third.text()).toContain('"arguments":"{\\"path\\":\\"FOLLOWTHROUGH_INPUT.md\\"}"');

    const fourthBody = await expectOpenAiStreamingResponsesText(server, {
      input: [
        makeUserInput(prompt),
        makeToolOutput(
          "Mission: prove you followed the repo contract.\nEvidence path: AGENT.md -> SOUL.md -> FOLLOWTHROUGH_INPUT.md -> repo-contract-summary.txt\n",
        ),
      ],
    });
    expect(fourthBody).toContain('"name":"write"');
    expect(fourthBody).toContain("repo-contract-summary.txt");

    const payload = (await expectOpenAiNonStreamingResponsesJson(server, {
      input: [
        makeUserInput(prompt),
        makeToolOutput(
          "Successfully wrote repo-contract-summary.txt\nMission: prove you followed the repo contract.\nStatus: complete\n",
        ),
      ],
    })) as {
      output?: Array<{ content?: Array<{ text?: string }> }>;
    };
    expect(payload.output?.[0]?.content?.[0]?.text).toContain("Read: AGENT.md, SOUL.md");
    expect(payload.output?.[0]?.content?.[0]?.text).toContain("Wrote: repo-contract-summary.txt");
    expect(payload.output?.[0]?.content?.[0]?.text).toContain("Status: complete");
  });

  it("uses argument-scoped tool call ids for repeated tool names", async () => {
    const server = await startMockServer();

    const prompt =
      "Repo contract followthrough check. Read AGENT.md, SOUL.md, and FOLLOWTHROUGH_INPUT.md first. Then follow the repo contract exactly, write ./repo-contract-summary.txt, and reply with three labeled lines: Read, Wrote, Status.";

    const first = await expectOpenAiNonStreamingResponses(server, {
      input: [makeUserInput(prompt)],
    });
    const firstPayload = (await first.json()) as {
      output?: Array<{ call_id?: string }>;
    };

    const second = await expectOpenAiNonStreamingResponses(server, {
      input: [
        makeUserInput(prompt),
        makeToolOutput(
          "# Repo contract\n\nStep order:\n1. Read AGENT.md.\n2. Read SOUL.md.\n3. Read FOLLOWTHROUGH_INPUT.md.\n4. Write ./repo-contract-summary.txt.\n",
        ),
      ],
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

    const undeclaredPayload = await expectOpenAiNonStreamingResponsesJson(server, {
      input: [makeUserInput(SLACK_CHART_PROMPT)],
    });
    expect(
      outputItems(undeclaredPayload).some(
        (item) => item.type === "function_call" && item.name === "message",
      ),
    ).toBe(false);

    const declaredPayload = await expectOpenAiNonStreamingResponsesJson(server, {
      tools: [MESSAGE_TOOL],
      input: [makeUserInput(SLACK_CHART_PROMPT)],
    });
    const toolCall = outputToolCall(declaredPayload, "message");
    expect(outputToolArgsFromItem(toolCall)).toEqual(SLACK_CHART_MESSAGE_TOOL_ARGS);

    const afterToolPayload = await expectOpenAiNonStreamingResponsesJson(server, {
      tools: [MESSAGE_TOOL],
      input: [
        makeUserInput(SLACK_CHART_PROMPT),
        makeToolOutputWithCallId(
          outputToolCallId(toolCall, "call_mock_message_chart"),
          "message sent",
        ),
      ],
    });
    expect(
      outputItems(afterToolPayload).some(
        (item) => item.type === "function_call" && item.name === "message",
      ),
    ).toBe(false);
    expect(outputText(afterToolPayload)).toBe(SLACK_CHART_DONE_TOKEN);
  });

  it("emits the deterministic message-decision suppression fixture", async () => {
    const server = await startMockServer();
    const initial = await expectOpenAiNonStreamingResponsesJson(server, {
      tools: [MESSAGE_TOOL],
      input: [makeUserInput(MESSAGE_DECISION_SUPPRESSION_PROMPT)],
    });
    const toolCall = outputToolCall(initial, "message");
    expect(outputToolArgsFromItem(toolCall)).toEqual({
      action: "send",
      message: MESSAGE_DECISION_SUPPRESSION_TEXT,
    });

    const afterTool = await expectOpenAiNonStreamingResponsesJson(server, {
      tools: [MESSAGE_TOOL],
      input: [
        makeUserInput(MESSAGE_DECISION_SUPPRESSION_PROMPT),
        makeToolOutputWithCallId(
          outputToolCallId(toolCall, "call_mock_message_suppression"),
          '{"status":"suppressed"}',
        ),
      ],
    });
    expect(outputText(afterTool)).toBe("NO_REPLY");
  });

  it("emits the deterministic durable message-decision send fixture", async () => {
    const server = await startMockServer();
    const initial = await expectOpenAiNonStreamingResponsesJson(server, {
      tools: [MESSAGE_TOOL],
      input: [makeUserInput(MESSAGE_DECISION_SEND_PROMPT)],
    });
    expect(outputToolArgsFromItem(outputToolCall(initial, "message"))).toEqual({
      action: "send",
      message: "QA-MESSAGE-DELIVERY-OK",
      final: true,
      presentation: { blocks: [{ type: "text", text: "QA-MESSAGE-DELIVERY-OK" }] },
    });
  });

  it("emits WhatsApp agent reaction message tool calls only when the tool is declared", async () => {
    const server = await startMockServer();

    const undeclaredPayload = await expectOpenAiNonStreamingResponsesJson(server, {
      input: [makeUserInput(WHATSAPP_AGENT_REACT_PROMPT)],
    });

    expect(
      outputItems(undeclaredPayload).some(
        (item) => item.type === "function_call" && item.name === "message",
      ),
    ).toBe(false);

    const unrelatedToolPayload = await expectOpenAiNonStreamingResponsesJson(server, {
      tools: [READ_TOOL],
      input: [makeUserInput(WHATSAPP_AGENT_REACT_PROMPT)],
    });

    expect(
      outputItems(unrelatedToolPayload).some(
        (item) => item.type === "function_call" && item.name === "message",
      ),
    ).toBe(false);

    const declaredPayload = await expectOpenAiNonStreamingResponsesJson(server, {
      tools: [MESSAGE_TOOL],
      input: [makeUserInput(WHATSAPP_AGENT_REACT_PROMPT)],
    });
    const groupDeclaredPayload = await expectOpenAiNonStreamingResponsesJson(server, {
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

    const afterToolPayload = await expectOpenAiNonStreamingResponsesJson(server, {
      tools: [MESSAGE_TOOL],
      input: [
        makeUserInput(WHATSAPP_AGENT_REACT_PROMPT),
        makeToolOutputWithCallId(
          outputToolCallId(toolCall, "call_mock_message_react"),
          "reaction sent",
        ),
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

    const undeclaredPayload = await expectOpenAiNonStreamingResponsesJson(server, {
      input: [makeUserInput(WHATSAPP_AGENT_UPLOAD_PROMPT)],
    });

    expect(
      outputItems(undeclaredPayload).some(
        (item) => item.type === "function_call" && item.name === "message",
      ),
    ).toBe(false);

    const declaredPayload = await expectOpenAiNonStreamingResponsesJson(server, {
      tools: [MESSAGE_TOOL],
      input: [makeUserInput(WHATSAPP_AGENT_UPLOAD_PROMPT)],
    });
    const groupDeclaredPayload = await expectOpenAiNonStreamingResponsesJson(server, {
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

    const afterToolPayload = await expectOpenAiNonStreamingResponsesJson(server, {
      tools: [MESSAGE_TOOL],
      input: [
        makeUserInput(WHATSAPP_AGENT_UPLOAD_PROMPT),
        makeToolOutputWithCallId(
          outputToolCallId(toolCall, "call_mock_message_upload"),
          "media sent",
        ),
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
    const currentTriggerPrompt = [
      "openclawqa pending history context check",
      WHATSAPP_PENDING_HISTORY_TRIGGER_MARKER,
      `Return ${WHATSAPP_PENDING_HISTORY_OK_MARKER} only if prior group context contains the context-only sentinel.`,
    ].join(" ");

    const historyContext = buildWhatsAppPendingHistoryContextFixture([
      {
        sender: "Alice",
        timestamp: 1_786_000_000_000,
        body: `quiet context ${WHATSAPP_PENDING_HISTORY_QUIET_MARKER} ${WHATSAPP_PENDING_HISTORY_CONTEXT_SENTINEL}`,
      },
    ]);
    const withStructuredHistory = await expectOpenAiNonStreamingResponsesJson(server, {
      input: [
        makeUserInput(currentTriggerPrompt),
        makeUserInput(TEST_RUNTIME_CONTEXT_CARRIER.replace("runtime metadata", historyContext)),
      ],
    });

    expect(outputText(withStructuredHistory)).toBe(WHATSAPP_PENDING_HISTORY_OK_MARKER);

    const withoutHistory = await expectOpenAiNonStreamingResponsesJson(server, {
      input: [makeUserInput(currentTriggerPrompt)],
    });

    expect(outputText(withoutHistory)).not.toBe(WHATSAPP_PENDING_HISTORY_OK_MARKER);

    const currentMessageOnlyMarkers = await expectOpenAiNonStreamingResponsesJson(server, {
      input: [
        makeDeveloperInput(
          buildWhatsAppPendingHistoryContextFixture([
            {
              sender: "Alice",
              timestamp: 1_786_000_000_000,
              body: "unrelated prior context",
            },
          ]),
        ),
        makeUserInput(
          [
            WHATSAPP_PENDING_HISTORY_TRIGGER_PROMPT,
            `Current request: ${WHATSAPP_PENDING_HISTORY_QUIET_MARKER}`,
          ].join("\n"),
        ),
      ],
    });

    expect(outputText(currentMessageOnlyMarkers)).not.toBe(WHATSAPP_PENDING_HISTORY_OK_MARKER);

    const ordinaryEarlierUserMarkers = await expectOpenAiNonStreamingResponsesJson(server, {
      input: [
        makeUserInput(
          `${WHATSAPP_PENDING_HISTORY_QUIET_MARKER} ${WHATSAPP_PENDING_HISTORY_CONTEXT_SENTINEL}`,
        ),
        makeUserInput(currentTriggerPrompt),
      ],
    });

    expect(outputText(ordinaryEarlierUserMarkers)).not.toBe(WHATSAPP_PENDING_HISTORY_OK_MARKER);

    const contextWithoutCurrentTrigger = await expectOpenAiNonStreamingResponsesJson(server, {
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

    const mainPayload = await expectOpenAiNonStreamingResponsesJson(server, {
      input: [
        makeDeveloperInput("Runtime: agent=main | channel=whatsapp | capabilities=messageactions"),
        makeUserInput(WHATSAPP_BROADCAST_PROMPT),
      ],
    });
    const secondPayload = await expectOpenAiNonStreamingResponsesJson(server, {
      input: [
        makeDeveloperInput(
          "Runtime: agent=qa-second | channel=whatsapp | capabilities=messageactions",
        ),
        makeUserInput(WHATSAPP_BROADCAST_PROMPT),
      ],
    });
    const noIdentityPayload = await expectOpenAiNonStreamingResponsesJson(server, {
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

    const activationPayload = await expectOpenAiNonStreamingResponsesJson(server, {
      input: [makeUserInput(WHATSAPP_ACTIVATION_ALWAYS_PROMPT)],
    });
    const unrelatedPayload = await expectOpenAiNonStreamingResponsesJson(server, {
      input: [makeUserInput("Group activation visible behavior marker WHATSAPP_QA_UNRELATED_TEST")],
    });

    expect(outputText(activationPayload)).toBe(WHATSAPP_ACTIVATION_ALWAYS_MARKER);
    expect(outputText(unrelatedPayload)).not.toBe(WHATSAPP_ACTIVATION_ALWAYS_MARKER);
  });

  it("answers reply-to-bot seed and implicit quoted-trigger markers deterministically", async () => {
    const server = await startMockServer();

    const seedPayload = await expectOpenAiNonStreamingResponsesJson(server, {
      input: [makeUserInput(WHATSAPP_REPLY_TO_BOT_SEED_PROMPT)],
    });
    const triggerPayload = await expectOpenAiNonStreamingResponsesJson(server, {
      input: [makeUserInput(WHATSAPP_REPLY_TO_BOT_TRIGGER_PROMPT)],
    });
    const unrelatedPayload = await expectOpenAiNonStreamingResponsesJson(server, {
      input: [makeUserInput("Quoted implicit reply trigger marker WHATSAPP_QA_UNRELATED_TEST")],
    });

    expect(WHATSAPP_REPLY_TO_BOT_TRIGGER_PROMPT).not.toMatch(/\bopenclawqa\b/iu);
    expect(outputText(seedPayload)).toBe(WHATSAPP_REPLY_TO_BOT_SEED_MARKER);
    expect(outputText(triggerPayload)).toBe(WHATSAPP_REPLY_TO_BOT_TRIGGER_MARKER);
    expect(outputText(unrelatedPayload)).not.toBe(WHATSAPP_REPLY_TO_BOT_TRIGGER_MARKER);
  });

  it("continues repo-contract followthrough when a retry user item follows tool output", async () => {
    const server = await startMockServer();

    const prompt =
      "Repo contract followthrough check. Read AGENT.md, SOUL.md, and FOLLOWTHROUGH_INPUT.md first. Then follow the repo contract exactly, write ./repo-contract-summary.txt, and reply with three labeled lines: Read, Wrote, Status.";

    const response = await expectOpenAiStreamingResponses(server, {
      input: [
        makeUserInput(prompt),
        makeToolOutput(
          "# Repo contract\n\nStep order:\n1. Read AGENT.md.\n2. Read SOUL.md.\n3. Read FOLLOWTHROUGH_INPUT.md.\n4. Write ./repo-contract-summary.txt.\n",
        ),
        makeUserInput("Continue after compaction."),
      ],
    });

    expect(await response.text()).toContain('"arguments":"{\\"path\\":\\"SOUL.md\\"}"');
  });

  it("continues repo-contract followthrough from structured tool output", async () => {
    const server = await startMockServer();

    const prompt =
      "Repo contract followthrough check. Read AGENT.md, SOUL.md, and FOLLOWTHROUGH_INPUT.md first. Then follow the repo contract exactly, write ./repo-contract-summary.txt, and reply with three labeled lines: Read, Wrote, Status.";

    const response = await expectOpenAiStreamingResponses(server, {
      input: [
        makeUserInput(prompt),
        makeToolOutput([
          {
            type: "output_text",
            text: "# Repo contract\n\nStep order:\n1. Read AGENT.md.\n2. Read SOUL.md.\n3. Read FOLLOWTHROUGH_INPUT.md.\n4. Write ./repo-contract-summary.txt.\n",
          },
        ]),
        makeUserInput("Continue after compaction."),
      ],
    });

    expect(await response.text()).toContain('"arguments":"{\\"path\\":\\"SOUL.md\\"}"');
  });

  it("advances repo-contract followthrough when transcript text is newer than extracted tool output", async () => {
    const server = await startMockServer();

    const prompt =
      "Repo contract followthrough check. Read AGENT.md, SOUL.md, and FOLLOWTHROUGH_INPUT.md first. Then follow the repo contract exactly, write ./repo-contract-summary.txt, and reply with three labeled lines: Read, Wrote, Status.";

    const response = await expectOpenAiStreamingResponses(server, {
      input: [
        makeUserInput(prompt),
        makeToolOutput(
          "# Repo contract\n\nStep order:\n1. Read AGENT.md.\n2. Read SOUL.md.\n3. Read FOLLOWTHROUGH_INPUT.md.\n4. Write ./repo-contract-summary.txt.\n",
        ),
        makeUserInput("# Execution style\n\nStay brief, honest, and action-first.\n"),
      ],
    });

    expect(await response.text()).toContain(
      '"arguments":"{\\"path\\":\\"FOLLOWTHROUGH_INPUT.md\\"}"',
    );
  });

  it("advances personal task followthrough when transcript text is newer than extracted tool output", async () => {
    const server = await startMockServer();

    const prompt =
      "Personal task followthrough check. Read PERSONAL_TASK_LEDGER.md and FOLLOWTHROUGH_NOTE.md first. Then write ./personal-task-status.txt and reply with three labeled lines: Pending, Blocked, Done.";

    const firstBody = await expectOpenAiStreamingResponsesText(server, {
      input: [makeUserInput(prompt)],
    });
    expect(firstBody).toContain('"arguments":"{\\"path\\":\\"PERSONAL_TASK_LEDGER.md\\"}"');
    expect(firstBody).not.toContain("repo/package.json");

    const response = await expectOpenAiStreamingResponses(server, {
      input: [
        makeUserInput(prompt),
        makeToolOutput(
          "# Personal task ledger\n\nRequired status contract:\n1. Read PERSONAL_TASK_LEDGER.md.\n2. Read FOLLOWTHROUGH_NOTE.md.\n3. Write ./personal-task-status.txt.\n",
        ),
        makeUserInput(
          "Task: prepare a local OpenClaw PR readiness note.\nPending: wait for maintainer feedback before publishing.\nBlocked: publishing needs explicit user approval.\nDone: local evidence captured in personal-task-status.txt.\n",
        ),
      ],
    });

    const body = await response.text();
    expect(body).toContain('"name":"write"');
    expect(body).toContain("personal-task-status.txt");
  });

  it("gates personal completion claims on a written proof artifact", async () => {
    const server = await startMockServer();

    const prompt =
      "Personal no-fake-progress check. Read PROGRESS_REQUEST.md and PROGRESS_EVIDENCE.md first. Then write ./personal-progress-proof.txt with the local evidence and external status.";

    const firstBody = await readOpenAiPromptResponseText(server, prompt);
    expect(firstBody).toContain('"arguments":"{\\"path\\":\\"PROGRESS_REQUEST.md\\"}"');
    expect(firstBody).not.toContain("sent successfully");

    const writeBody = await readOpenAiPromptResponseText(
      server,
      prompt,
      makeToolOutput(
        "# Progress request\n\nRequired contract:\n1. Read PROGRESS_REQUEST.md.\n2. Read PROGRESS_EVIDENCE.md.\n3. Write ./personal-progress-proof.txt.\n",
      ),
      makeUserInput(
        "# Progress evidence\n\nTask: prepare a maintainer-ready local handoff note.\nExternal status: not sent, not published, not uploaded, not merged.\nHonest completion claim: local proof artifact written.\n",
      ),
    );
    expect(writeBody).toContain('"name":"write"');
    expect(writeBody).toContain("personal-progress-proof.txt");
    expect(writeBody).not.toContain("published successfully");

    const finalBody = await readOpenAiPromptResponseText(
      server,
      prompt,
      makeToolOutput(
        "Successfully wrote personal-progress-proof.txt with local proof artifact written.",
      ),
    );
    expect(finalBody).toContain("PERSONAL-NO-FAKE-PROGRESS-OK");
    expect(finalBody).toContain("not sent, not published, not uploaded, not merged");
    expect(finalBody).not.toContain("sent successfully");
  });

  it("reports personal failure recovery with a retry boundary", async () => {
    const server = await startMockServer();

    const prompt =
      "Personal failure recovery check. Read FAILURE_RECOVERY_REQUEST.md and FAILURE_RECOVERY_EVIDENCE.md first. Then write ./personal-failure-recovery.txt with Completed, Failed step, Retry boundary, and Next step.";

    const firstBody = await readOpenAiPromptResponseText(server, prompt);
    expect(firstBody).toContain('"arguments":"{\\"path\\":\\"FAILURE_RECOVERY_REQUEST.md\\"}"');
    expect(firstBody).not.toContain("fully complete");

    const writeBody = await readOpenAiPromptResponseText(
      server,
      prompt,
      makeToolOutput(
        "# Failure recovery request\n\nRequired contract:\n1. Read FAILURE_RECOVERY_REQUEST.md.\n2. Read FAILURE_RECOVERY_EVIDENCE.md.\n3. Write ./personal-failure-recovery.txt.\n",
      ),
      makeUserInput(
        "# Failure recovery evidence\n\nCompleted: request reviewed and local evidence captured.\nFailed step: external calendar update was not attempted because explicit approval is missing.\nRetry boundary: do not retry the external step until approval is given.\nNext step: ask for approval before any external update.\n",
      ),
    );
    expect(writeBody).toContain('"name":"write"');
    expect(writeBody).toContain("personal-failure-recovery.txt");
    expect(writeBody).toContain("Retry boundary: do not retry");
    expect(writeBody).not.toContain("retry succeeded");

    const finalBody = await readOpenAiPromptResponseText(
      server,
      prompt,
      makeToolOutput(
        "Successfully wrote personal-failure-recovery.txt with the failed step and retry boundary.",
      ),
    );
    expect(finalBody).toContain("PERSONAL-FAILURE-RECOVERY-OK");
    expect(finalBody).toContain("Retry boundary: do not retry");
    expect(finalBody).not.toContain("fully complete");
  });

  it("drives the compaction retry mutating tool parity flow", async () => {
    const server = await startMockServer();

    const writePlanBody = await expectOpenAiStreamingResponsesText(server, {
      input: [makeUserInput(QA_COMPACTION_RETRY_PROMPT)],
    });
    expect(writePlanBody).toContain('"name":"write"');
    expect(writePlanBody).toContain("compaction-retry-summary.txt");

    const finalPayload = (await expectOpenAiNonStreamingResponsesJson(server, {
      input: [
        makeUserInput(QA_COMPACTION_RETRY_PROMPT),
        makeToolOutput("Successfully wrote 41 bytes to compaction-retry-summary.txt"),
      ],
    })) as {
      output?: Array<{ content?: Array<{ text?: string }> }>;
    };
    expect(finalPayload.output?.[0]?.content?.[0]?.text).toBe(
      "Protocol note: replay unsafe after write.",
    );
  });

  it("does not inject compaction overflow below the request-size threshold", async () => {
    const server = await startMockServer();
    const runtimeSessionId = "compaction-below-threshold";

    await expectOpenAiNonStreamingResponsesJson(server, {
      instructions: `Runtime: embedded | sessionId=${runtimeSessionId}`,
      input: [makeUserInput(QA_COMPACTION_RETRY_PROMPT)],
    });

    const requests = requireArray(
      await getJson(server, "/debug/requests"),
      "compaction requests",
    ).map((request) => requireRecord(request, "compaction request"));
    expect(requests).toHaveLength(1);
    const request = requireRecord(requests[0], "compaction request 0");
    expect(request).toMatchObject({
      requestKind: "agent-initial",
      outcome: "success",
      plannedToolName: "write",
    });
    expect(request.rawByteLength).toEqual(expect.any(Number));
    expect(Number(request.rawByteLength)).toBeLessThanOrEqual(256 * 1024);
  });

  it("injects one coded overflow per session before planning", async () => {
    const server = await startMockServer();
    const runtimeSessionId = "compaction-one-shot";
    const body = {
      model: "gpt-5.6-luna",
      instructions: `Runtime: embedded | sessionId=${runtimeSessionId}`,
      input: [
        makeUserInput(`${QA_COMPACTION_RETRY_PROMPT}\n${QA_COMPACTION_RETRY_OVERFLOW_PADDING}`),
      ],
    };

    const first = await postNonStreamingResponses(server, body);
    expect(first.status).toBe(400);
    expect(await first.json()).toEqual({
      error: {
        type: "invalid_request_error",
        code: "context_length_exceeded",
        message: "This model's maximum context length was exceeded.",
      },
    });

    const second = await postNonStreamingResponses(server, body);
    expect(second.status).toBe(200);
    const requests = requireArray(
      await getJson(server, "/debug/requests"),
      "compaction requests",
    ).map((request) => requireRecord(request, "compaction request"));
    expect(requests).toHaveLength(2);
    const firstRequest = requireRecord(requests[0], "compaction request 0");
    const secondRequest = requireRecord(requests[1], "compaction request 1");
    expect(firstRequest).toMatchObject({
      requestKind: "agent-initial",
      outcome: "error",
      errorCode: "context_length_exceeded",
    });
    expect(firstRequest.plannedToolName).toBeUndefined();
    expect(secondRequest).toMatchObject({
      requestKind: "agent-initial",
      outcome: "success",
      plannedToolName: "write",
    });
  });

  it("tracks compaction overflow injection independently by runtime session", async () => {
    const server = await startMockServer();

    for (const runtimeSessionId of ["compaction-session-a", "compaction-session-b"]) {
      const response = await postNonStreamingResponses(server, {
        model: "gpt-5.6-luna",
        instructions: `Runtime: embedded | sessionId=${runtimeSessionId}`,
        input: [
          makeUserInput(`${QA_COMPACTION_RETRY_PROMPT}\n${QA_COMPACTION_RETRY_OVERFLOW_PADDING}`),
        ],
      });
      expect(response.status).toBe(400);
    }

    const requests = requireArray(
      await getJson(server, "/debug/requests"),
      "compaction requests",
    ).map((request) => requireRecord(request, "compaction request"));
    expect(requests).toHaveLength(2);
    expect(requests.every((request) => request.errorCode === "context_length_exceeded")).toBe(true);
  });

  it("injects one Anthropic overflow per session before planning the logical write", async () => {
    const server = await startMockServer();
    const bodyFor = (sessionId: string) => ({
      system: `Runtime: embedded | sessionId=${sessionId}`,
      tools: [
        {
          name: "exec",
          input_schema: {
            type: "object",
            properties: {
              language: { type: "string" },
              code: { type: "string" },
            },
            required: ["code"],
          },
        },
        {
          name: "wait",
          input_schema: {
            type: "object",
            properties: { runId: { type: "string" } },
            required: ["runId"],
          },
        },
      ],
      messages: [
        makeAnthropicUserText(
          `${QA_COMPACTION_RETRY_PROMPT}\n${QA_COMPACTION_RETRY_OVERFLOW_PADDING}`,
        ),
      ],
    });

    const first = await postAnthropicMessages(server, bodyFor("anthropic-overflow-a"));
    expect(first.status).toBe(400);
    expect(await first.json()).toEqual({
      type: "error",
      error: {
        type: "invalid_request_error",
        code: "context_length_exceeded",
        message: "This model's maximum context length was exceeded.",
      },
    });

    const second = await postAnthropicMessages(server, bodyFor("anthropic-overflow-a"));
    expect(second.status).toBe(200);
    const content = requireArray(
      requireRecord(await second.json(), "Anthropic response").content,
      "content",
    );
    expect(content).toContainEqual(expect.objectContaining({ type: "tool_use", name: "exec" }));
    expect(await getJson(server, "/debug/last-request")).toMatchObject({
      plannedToolName: "write",
      plannedWireToolName: "exec",
    });

    const independent = await postAnthropicMessages(server, bodyFor("anthropic-overflow-b"));
    expect(independent.status).toBe(400);
  });

  it("excludes compaction summary requests from overflow injection", async () => {
    const server = await startMockServer();
    const initial = await postNonStreamingResponses(server, {
      model: "gpt-5.6-luna",
      instructions: "Runtime: embedded | sessionId=compaction-summary",
      input: [
        makeUserInput(`${QA_COMPACTION_RETRY_PROMPT}\n${QA_COMPACTION_RETRY_OVERFLOW_PADDING}`),
      ],
    });
    expect(initial.status).toBe(400);

    const response = await postNonStreamingResponses(server, {
      model: "gpt-5.6-luna",
      instructions: QA_COMPACTION_SUMMARY_INSTRUCTIONS,
      input: `<conversation>\n[Chunk 1 - oldest messages]\nQA-COMPACTION-BULKY-HISTORICAL-MARKER\n${QA_COMPACTION_RETRY_OVERFLOW_PADDING}\n</conversation>\n\nAdditional focus: preserve exact identifiers and current work.`,
    });

    expect(response.status).toBe(200);
    const summary = outputText(await response.json());
    expectCurrentCompactionSummaryHeadings(summary);
    expect(summary).not.toContain("QA-COMPACTION-DURABLE-MARKER");
    expect(summary).not.toContain("QA-COMPACTION-BULKY-HISTORICAL-MARKER");
    const requests = requireArray(
      await getJson(server, "/debug/requests"),
      "compaction requests",
    ).map((request) => requireRecord(request, "compaction request"));
    expect(requests).toHaveLength(2);
    const summaryRequest = requireRecord(requests[1], "compaction request 1");
    expect(summaryRequest).toMatchObject({
      requestKind: "compaction-summary",
      outcome: "success",
    });
    expect(Number(summaryRequest.rawByteLength)).toBeGreaterThan(256 * 1024);
    expect(summaryRequest.errorCode).toBeUndefined();
    expect(summaryRequest.allInputText).toContain("[Chunk 1 - oldest messages]");
  });

  it.each([
    {
      faultMode: "empty-output-once",
      markerPrefix: "QA-COMPACTION-EMPTY-OUTPUT-ONCE",
      recoveredMarker: QA_COMPACTION_EMPTY_RECOVERY_SUMMARY_MARKER,
      reasoningOnly: false,
    },
    {
      faultMode: "reasoning-only-output-once",
      markerPrefix: "QA-COMPACTION-REASONING-ONLY-OUTPUT-ONCE",
      recoveredMarker: QA_COMPACTION_REASONING_RECOVERY_SUMMARY_MARKER,
      reasoningOnly: true,
    },
  ] as const)(
    "injects one coded overflow for $faultMode scenario markers",
    async ({ markerPrefix }) => {
      const server = await startMockServer();
      const body = {
        model: "gpt-5.6-luna",
        instructions: `Runtime: embedded | sessionId=compaction-output-${markerPrefix}`,
        input: [makeUserInput(`${markerPrefix}-http\n${"x".repeat(100_000)}`)],
      };

      const first = await postNonStreamingResponses(server, body);
      expect(first.status).toBe(400);
      expect(await first.json()).toMatchObject({
        error: { code: "context_length_exceeded" },
      });
      expect((await postNonStreamingResponses(server, body)).status).toBe(200);

      const requests = requireArray(
        await getJson(server, "/debug/requests"),
        "compaction output overflow requests",
      ).map((request) => requireRecord(request, "compaction output overflow request"));
      expect(requests).toHaveLength(2);
      expect(Number(requests[0]?.rawByteLength)).toBeLessThan(256 * 1024);
      expect(requests[0]).toMatchObject({
        requestKind: "agent-initial",
        compactionSummaryFaultMode: "none",
        outcome: "error",
        errorCode: "context_length_exceeded",
      });
      expect(requests[1]).toMatchObject({
        requestKind: "agent-initial",
        compactionSummaryFaultMode: "none",
        outcome: "success",
      });
    },
  );

  it.each([
    {
      faultMode: "empty-output-once",
      markerPrefix: "QA-COMPACTION-EMPTY-OUTPUT-ONCE",
      recoveredMarker: QA_COMPACTION_EMPTY_RECOVERY_SUMMARY_MARKER,
      reasoningOnly: false,
    },
    {
      faultMode: "reasoning-only-output-once",
      markerPrefix: "QA-COMPACTION-REASONING-ONLY-OUTPUT-ONCE",
      recoveredMarker: QA_COMPACTION_REASONING_RECOVERY_SUMMARY_MARKER,
      reasoningOnly: true,
    },
  ] as const)(
    "scopes $faultMode compaction faults to one scenario session",
    async ({ faultMode, markerPrefix, recoveredMarker, reasoningOnly }) => {
      const server = await startMockServer();
      const requestFor = (session: string) => ({
        model: "gpt-5.6-luna",
        instructions: QA_COMPACTION_SUMMARY_INSTRUCTIONS,
        input: `<conversation>\n${markerPrefix}-${session}\nretain current work\n</conversation>\n\nCreate a structured summary.`,
      });

      const first = await expectOpenAiNonStreamingResponsesJson(server, requestFor("session-a"));
      if (reasoningOnly) {
        expect(JSON.stringify(first)).toContain("reasoning_compaction_summary_fault");
        expect(JSON.stringify(first)).not.toContain(recoveredMarker);
      } else {
        expect(outputText(first)).toBe("");
      }
      const recovered = await expectOpenAiNonStreamingResponsesJson(
        server,
        requestFor("session-a"),
      );
      const recoveredText = outputText(recovered);
      expect(recoveredText).toContain(recoveredMarker);
      expect(recoveredText).toContain(`${markerPrefix}-session-a`);
      expect(recoveredText).toContain("## Decisions");
      expect(recoveredText).toContain("## Open TODOs");
      expect(recoveredText).toContain("## Constraints/Rules");
      expect(recoveredText).toContain("## Pending user asks");
      expect(recoveredText).toContain("## Exact identifiers");
      const independent = await expectOpenAiNonStreamingResponsesJson(
        server,
        requestFor("session-b"),
      );
      if (reasoningOnly) {
        expect(JSON.stringify(independent)).toContain("reasoning_compaction_summary_fault");
        expect(JSON.stringify(independent)).not.toContain(recoveredMarker);
      } else {
        expect(outputText(independent)).toBe("");
      }

      const requests = requireArray(
        await getJson(server, "/debug/requests"),
        "compaction output fault requests",
      ).map((request) => requireRecord(request, "compaction output fault request"));
      expect(requests.map((request) => request.compactionSummaryFaultMode)).toEqual([
        faultMode,
        "none",
        faultMode,
      ]);
      expect(requests.every((request) => request.requestKind === "compaction-summary")).toBe(true);
    },
  );

  it("classifies developer-role compaction instructions before applying a typed fault", async () => {
    const server = await startMockServer();
    const response = await expectOpenAiNonStreamingResponsesJson(server, {
      model: "gpt-5.6-luna",
      input: [
        {
          role: "developer",
          content: [{ type: "input_text", text: QA_COMPACTION_SUMMARY_INSTRUCTIONS }],
        },
        makeUserInput(
          "<conversation>QA-COMPACTION-EMPTY-OUTPUT-ONCE-developer-wire</conversation>",
        ),
      ],
    });

    expect(outputText(response)).toBe("");
    const requests = requireArray(
      await getJson(server, "/debug/requests"),
      "developer-role compaction requests",
    ).map((request) => requireRecord(request, "developer-role compaction request"));
    expect(requests).toEqual([
      expect.objectContaining({
        requestKind: "compaction-summary",
        compactionSummaryFaultMode: "empty-output-once",
      }),
    ]);
  });

  it("excludes Anthropic compaction summary requests from overflow injection", async () => {
    const server = await startMockServer();
    const response = await postAnthropicMessages(server, {
      system: QA_COMPACTION_SUMMARY_INSTRUCTIONS,
      messages: [
        makeAnthropicUserText(
          `<conversation>\n${QA_COMPACTION_RETRY_OVERFLOW_PADDING}\n</conversation>`,
        ),
      ],
    });

    expect(response.status).toBe(200);
    const body = requireRecord(await response.json(), "Anthropic summary response");
    const content = requireArray(body.content, "content");
    expect(content).toContainEqual(
      expect.objectContaining({ type: "text", text: expect.stringContaining("## Decisions") }),
    );
    const summaryText = requireRecord(content[0], "summary content").text;
    expect(typeof summaryText).toBe("string");
    if (typeof summaryText !== "string") {
      throw new TypeError("Anthropic summary content text must be a string");
    }
    expectCurrentCompactionSummaryHeadings(summaryText);
    expect(await getJson(server, "/debug/last-request")).toMatchObject({
      requestKind: "compaction-summary",
      outcome: "success",
    });
  });

  it("handles staged scalar compaction summaries and promotes the durable merge without state leakage", async () => {
    const server = await startMockServer();
    const genericChunkPayload = await expectOpenAiNonStreamingResponsesJson(server, {
      model: "gpt-5.6-luna",
      instructions: QA_COMPACTION_SUMMARY_INSTRUCTIONS,
      input:
        "<conversation>\n[Chunk 1 - oldest messages]\nunrelated historical context\n</conversation>\n\nAdditional focus: preserve exact identifiers.",
    });
    const genericChunkSummary = outputText(genericChunkPayload);
    expectCurrentCompactionSummaryHeadings(genericChunkSummary);
    expect(genericChunkSummary).not.toContain("QA-COMPACTION-DURABLE-MARKER");

    const scenarioChunkPayload = await expectOpenAiNonStreamingResponsesJson(server, {
      model: "gpt-5.6-luna",
      instructions: QA_COMPACTION_SUMMARY_INSTRUCTIONS,
      input: `<conversation>
[Chunk 2 - most recent messages]
QA-COMPACTION-BULKY-HISTORICAL-MARKER ${QA_COMPACTION_RETRY_HISTORICAL_PHRASE} 10
</conversation>

Additional focus: preserve exact identifiers.`,
    });
    const scenarioChunkSummary = outputText(scenarioChunkPayload);
    expectCurrentCompactionSummaryHeadings(scenarioChunkSummary);
    expect(scenarioChunkSummary).toContain(QA_COMPACTION_RETRY_HISTORICAL_PHRASE);
    expect(scenarioChunkSummary).not.toContain("QA-COMPACTION-DURABLE-MARKER");
    expect(scenarioChunkSummary).not.toContain("QA-COMPACTION-BULKY-HISTORICAL-MARKER");

    const historyMergePayload = await expectOpenAiNonStreamingResponsesJson(server, {
      model: "gpt-5.6-luna",
      instructions: QA_COMPACTION_SUMMARY_INSTRUCTIONS,
      input: `<conversation>
[Chunk 1 - oldest messages]
${genericChunkSummary}
[Chunk 2 - most recent messages]
${scenarioChunkSummary}
</conversation>

Update and merge these partial structured summaries.`,
    });
    const historyMergedSummary = outputText(historyMergePayload);
    expectCurrentCompactionSummaryHeadings(historyMergedSummary);
    expect(historyMergedSummary).toContain(QA_COMPACTION_RETRY_HISTORICAL_PHRASE);
    expect(historyMergedSummary).not.toContain("QA-COMPACTION-DURABLE-MARKER");
    expect(historyMergedSummary).not.toContain("QA-COMPACTION-BULKY-HISTORICAL-MARKER");

    const durableChunkPayload = await expectOpenAiNonStreamingResponsesJson(server, {
      model: "gpt-5.6-luna",
      instructions: QA_COMPACTION_SUMMARY_INSTRUCTIONS,
      input: `<conversation>
Retain QA-COMPACTION-DURABLE-MARKER for the active task.
</conversation>

Additional focus: preserve QA-COMPACTION-DURABLE-MARKER.`,
    });
    const durableChunkSummary = outputText(durableChunkPayload);
    expectCurrentCompactionSummaryHeadings(durableChunkSummary);
    expect(durableChunkSummary).toContain("QA-COMPACTION-DURABLE-MARKER");

    const promptOnlyChunkPayload = await expectOpenAiNonStreamingResponsesJson(server, {
      model: "gpt-5.6-luna",
      instructions: QA_COMPACTION_SUMMARY_INSTRUCTIONS,
      input: `<conversation>
Compaction retry mutating tool check. Create compaction-retry-summary.txt.
</conversation>

Additional focus: preserve current work.`,
    });
    const promptOnlyChunkSummary = outputText(promptOnlyChunkPayload);
    expectCurrentCompactionSummaryHeadings(promptOnlyChunkSummary);
    expect(promptOnlyChunkSummary).not.toContain("QA-COMPACTION-DURABLE-MARKER");

    const currentChunkPayload = await expectOpenAiNonStreamingResponsesJson(server, {
      model: "gpt-5.6-luna",
      instructions: QA_COMPACTION_SUMMARY_INSTRUCTIONS,
      input: `<conversation>
Compaction retry mutating tool check. Current durable context marker: QA-COMPACTION-DURABLE-MARKER.
Create compaction-retry-summary.txt.
</conversation>

Additional focus: preserve current work.`,
    });
    const currentChunkSummary = outputText(currentChunkPayload);
    expectCurrentCompactionSummaryHeadings(currentChunkSummary);
    expect(currentChunkSummary).toContain("QA-COMPACTION-DURABLE-MARKER");

    const mergePayload = await expectOpenAiNonStreamingResponsesJson(server, {
      model: "gpt-5.6-luna",
      instructions: QA_COMPACTION_SUMMARY_INSTRUCTIONS,
      input: `<conversation>
[Chunk 1 - oldest messages]
${genericChunkSummary}
[Chunk 2 - most recent messages]
${scenarioChunkSummary}
[Chunk 3 - current work]
${currentChunkSummary}
</conversation>

<previous-summary>
${durableChunkSummary}
</previous-summary>

Update and merge these partial structured summaries.`,
    });
    const mergedSummary = outputText(mergePayload);
    expectCurrentCompactionSummaryHeadings(mergedSummary);
    expect(mergedSummary).toContain("QA-COMPACTION-DURABLE-MARKER");

    const unrelatedPayload = await expectOpenAiNonStreamingResponsesJson(server, {
      model: "gpt-5.6-luna",
      instructions: QA_COMPACTION_SUMMARY_INSTRUCTIONS,
      input:
        "<conversation>\na later unrelated scenario\n</conversation>\n\nCreate a structured summary.",
    });
    const unrelatedSummary = outputText(unrelatedPayload);
    expectCurrentCompactionSummaryHeadings(unrelatedSummary);
    expect(unrelatedSummary).not.toContain("QA-COMPACTION-DURABLE-MARKER");

    const requests = requireArray(
      await getJson(server, "/debug/requests"),
      "compaction requests",
    ).map((request) => requireRecord(request, "compaction request"));
    expect(requests).toHaveLength(8);
    expect(
      requests.every(
        (request) =>
          request.requestKind === "compaction-summary" &&
          request.outcome === "success" &&
          request.plannedToolName === undefined,
      ),
    ).toBe(true);
  });

  it("plans the write from an OpenClaw compacted retry payload", async () => {
    const server = await startMockServer();
    const runtimeSessionId = "compaction-openclaw-retry";
    const initial = await postNonStreamingResponses(server, {
      model: "gpt-5.6-luna",
      instructions: `Runtime: embedded | sessionId=${runtimeSessionId}`,
      input: [
        makeUserInput(`${QA_COMPACTION_RETRY_PROMPT}\n${QA_COMPACTION_RETRY_OVERFLOW_PADDING}`),
      ],
    });
    expect(initial.status).toBe(400);

    const summaryPayload = await expectOpenAiNonStreamingResponsesJson(server, {
      model: "gpt-5.6-luna",
      instructions: QA_COMPACTION_SUMMARY_INSTRUCTIONS,
      input: [
        makeUserInput(
          `<conversation>\n${QA_COMPACTION_RETRY_PROMPT}\nhistorical context only\n</conversation>\n\nAdditional focus: preserve exact identifiers and current work.`,
        ),
      ],
    });
    const compactedSummary = outputText(summaryPayload);
    expectCurrentCompactionSummaryHeadings(compactedSummary);
    expect(compactedSummary).toContain("QA-COMPACTION-DURABLE-MARKER");

    const writePlan = await expectOpenAiStreamingResponsesText(server, {
      model: "gpt-5.6-luna",
      instructions: `Runtime: embedded | sessionId=${runtimeSessionId}`,
      input: [
        makeUserInput(compactedSummary),
        makeUserInput("Continue from the compacted context."),
      ],
    });
    expect(writePlan).toContain('"name":"write"');
    expect(writePlan).toContain("compaction-retry-summary.txt");
  });

  it("finishes a compacted retry after the canonical successful write result", async () => {
    const server = await startMockServer();

    const finalReply = await expectOpenAiNonStreamingResponses(server, {
      input: [
        makeToolOutput("Successfully wrote 41 bytes to compaction-retry-summary.txt"),
        makeUserInput("Continue after compaction."),
      ],
    });

    expect(outputText(await finalReply.json())).toBe("Protocol note: replay unsafe after write.");
  });

  it("finishes Anthropic Code Mode compaction retry after the structured write result", async () => {
    const server = await startMockServer();
    const callId = "toolu_compaction_retry_write";
    const body = requireRecord(
      await expectAnthropicMessagesJson(server, {
        messages: [
          makeAnthropicUserText(
            "Compaction retry mutating tool check: read COMPACTION_RETRY_CONTEXT.md, then create compaction-retry-summary.txt and keep replay safety explicit.",
          ),
          {
            role: "assistant",
            content: [{ type: "tool_use", id: callId, name: "exec", input: {} }],
          },
          makeAnthropicToolResult(
            callId,
            JSON.stringify(QA_COMPACTION_RETRY_CODE_MODE_WRITE_RESULT),
          ),
        ],
      }),
      "Anthropic compaction retry response",
    );
    expect(body.stop_reason).toBe("end_turn");
    expect(requireArray(body.content, "Anthropic response content")).toContainEqual({
      type: "text",
      text: "Protocol note: replay unsafe after write.",
    });
  });

  it("accepts semantic Code Mode write evidence across diff formatting changes", async () => {
    const server = await startMockServer();
    const callId = "toolu_compaction_retry_write_semantic";
    const body = requireRecord(
      await expectAnthropicMessagesJson(server, {
        messages: [
          makeAnthropicUserText(
            "Compaction retry mutating tool check: read COMPACTION_RETRY_CONTEXT.md, then create compaction-retry-summary.txt and keep replay safety explicit.",
          ),
          {
            role: "assistant",
            content: [{ type: "tool_use", id: callId, name: "exec", input: {} }],
          },
          makeAnthropicToolResult(
            callId,
            JSON.stringify({
              ...QA_COMPACTION_RETRY_CODE_MODE_WRITE_RESULT,
              value: {
                ...QA_COMPACTION_RETRY_CODE_MODE_WRITE_RESULT.value,
                diff: "display formatting may change independently",
                patch: [
                  "--- compaction-retry-summary.txt",
                  "+++ compaction-retry-summary.txt",
                  "@@ -0,0 +1 @@",
                  "+Replay safety: unsafe after write.",
                ].join("\r\n"),
              },
            }),
          ),
        ],
      }),
      "Anthropic compaction retry response",
    );
    expect(requireArray(body.content, "Anthropic response content")).toContainEqual({
      type: "text",
      text: "Protocol note: replay unsafe after write.",
    });
  });

  it.each([
    {
      label: "failed status",
      result: { ...QA_COMPACTION_RETRY_CODE_MODE_WRITE_RESULT, status: "failed" },
    },
    {
      label: "replay-safe result",
      result: { ...QA_COMPACTION_RETRY_CODE_MODE_WRITE_RESULT, replaySafe: true },
    },
    {
      label: "unchanged result",
      result: {
        ...QA_COMPACTION_RETRY_CODE_MODE_WRITE_RESULT,
        value: { changed: false },
      },
    },
    {
      label: "wrong target patch",
      result: {
        ...QA_COMPACTION_RETRY_CODE_MODE_WRITE_RESULT,
        value: {
          ...QA_COMPACTION_RETRY_CODE_MODE_WRITE_RESULT.value,
          patch:
            "--- other.txt\n+++ other.txt\n@@ -0,0 +1,1 @@\n+Replay safety: unsafe after write.\n",
        },
      },
    },
    {
      label: "content added under another target",
      result: {
        ...QA_COMPACTION_RETRY_CODE_MODE_WRITE_RESULT,
        value: {
          ...QA_COMPACTION_RETRY_CODE_MODE_WRITE_RESULT.value,
          patch: [
            "--- compaction-retry-summary.txt",
            "+++ compaction-retry-summary.txt",
            "@@ -0,0 +1 @@",
            "+Unrelated content.",
            "--- other.txt",
            "+++ other.txt",
            "@@ -0,0 +1 @@",
            "+Replay safety: unsafe after write.",
          ].join("\n"),
        },
      },
    },
  ])("rejects Anthropic Code Mode compaction retry result with $label", async ({ result }) => {
    const server = await startMockServer();
    const callId = "toolu_compaction_retry_invalid";
    const body = requireRecord(
      await expectAnthropicMessagesJson(server, {
        messages: [
          makeAnthropicUserText(
            "Compaction retry mutating tool check: read COMPACTION_RETRY_CONTEXT.md, then create compaction-retry-summary.txt and keep replay safety explicit.",
          ),
          {
            role: "assistant",
            content: [{ type: "tool_use", id: callId, name: "exec", input: {} }],
          },
          makeAnthropicToolResult(callId, JSON.stringify(result)),
        ],
      }),
      "Anthropic compaction retry response",
    );
    expect(requireArray(body.content, "Anthropic response content")).not.toContainEqual({
      type: "text",
      text: "Protocol note: replay unsafe after write.",
    });
  });

  it("does not finish a compacted retry when failure text quotes the write success marker", async () => {
    const server = await startMockServer();

    const failedReply = await expectOpenAiNonStreamingResponses(server, {
      input: [
        makeToolOutput(
          'Write failed after reporting "Successfully wrote 41 bytes to compaction-retry-summary.txt."',
        ),
        makeUserInput("Continue after compaction."),
      ],
    });

    expect(outputText(await failedReply.json())).toBe("");
  });

  it("keeps compaction retry planning across continuation prompts", async () => {
    const server = await startMockServer();

    const writePlan = await expectOpenAiStreamingResponses(server, {
      input: [
        makeUserInput(QA_COMPACTION_RETRY_PROMPT),
        makeUserInput("Continue after compaction."),
      ],
    });
    expect(await writePlan.text()).toContain('"name":"write"');

    const contextOnlyWritePlan = await expectOpenAiStreamingResponses(server, {
      input: [
        makeUserInput(QA_COMPACTION_RETRY_PROMPT),
        makeUserInput("Continue after compaction."),
      ],
    });
    expect(await contextOnlyWritePlan.text()).toContain('"name":"write"');

    const finalReply = await expectOpenAiNonStreamingResponses(server, {
      input: [
        makeUserInput(QA_COMPACTION_RETRY_PROMPT),
        makeToolOutput("Successfully wrote 41 bytes to compaction-retry-summary.txt"),
        makeUserInput("Continue after compaction."),
      ],
    });
    expect(outputText(await finalReply.json())).toContain("replay unsafe after write");
  });

  it("supports exact reply memory prompts and embeddings requests", async () => {
    const server = await startMockServer();

    const rememberPayload = (await expectNonStreamingResponsesJson(server, {
      input: [
        makeUserInput(
          "Please remember this fact for later: the QA canary code is ALPHA-7. Reply exactly `Remembered ALPHA-7.` once stored.",
        ),
      ],
    })) as {
      output?: Array<{ content?: Array<{ text?: string }> }>;
    };
    expect(rememberPayload.output?.[0]?.content?.[0]?.text).toBe("Remembered ALPHA-7.");

    const embeddingPayload = (await fetchOkJson(`${server.baseUrl}/v1/embeddings`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "text-embedding-3-small",
        input: ["Project Nebula ORBIT-10", "Project Nebula ORBIT-9"],
      }),
    })) as {
      data?: Array<{ embedding?: number[]; index?: number }>;
      model?: string;
    };
    expect(embeddingPayload.model).toBe("text-embedding-3-small");
    expect(embeddingPayload.data).toHaveLength(2);
    expect(embeddingPayload.data?.map((item) => item.index)).toStrictEqual([0, 1]);
    expect(embeddingPayload.data?.map((item) => item.embedding?.length)).toStrictEqual([16, 16]);
  });

  it("requests non-threaded subagent handoff for QA channel runs", async () => {
    const server = await startMockServer();

    const body = await expectStreamingResponsesText(server, {
      tools: [SESSIONS_SPAWN_TOOL],
      input: [
        makeUserInput(
          "Delegate a bounded QA task to a subagent, then summarize the delegated result clearly.",
        ),
      ],
    });
    expect(body).toContain('"name":"sessions_spawn"');
    expect(body).toContain('\\"label\\":\\"qa-sidecar\\"');
    expect(body).toContain('\\"thread\\":false');
  });

  it("emits explicitly requested sessions_spawn tool calls", async () => {
    const server = await startMockServer();

    const body = await expectResponsesText(server, {
      stream: true,
      tools: [SESSIONS_SPAWN_TOOL],
      input: [makeUserInput(explicitSessionsSpawnPrompt("QA_SUBAGENT_CHILD_FIXED"))],
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

    const debugPayload = requireRecord(
      await getJson(server, "/debug/last-request"),
      "debug request",
    );
    expect(debugPayload.plannedToolName).toBe("sessions_spawn");
    const plannedToolArgs = requireRecord(debugPayload.plannedToolArgs, "planned tool args");
    expect(plannedToolArgs.task).toBe("Report the visible code");
    expect(plannedToolArgs.label).toBe("qa-fork-context");
    expect(plannedToolArgs.context).toBe("fork");
    expect(plannedToolArgs.mode).toBe("run");
  });

  it.each([
    {
      name: "flat tools",
      tools: [SESSIONS_SPAWN_TOOL, SESSIONS_YIELD_TOOL],
      namespace: undefined,
    },
    {
      name: "Codex direct-only tools",
      tools: [SESSIONS_SPAWN_TOOL, CODEX_DIRECT_YIELD_NAMESPACE],
      namespace: "openclaw_direct",
    },
  ])("drives yielded-parent subagent fallback through $name", async ({ tools, namespace }) => {
    const server = await startMockServer();
    const prompt =
      "Subagent direct fallback QA check: spawn one worker and yield until QA-SUBAGENT-DIRECT-FALLBACK-OK is delivered.";

    await expectResponsesText(server, {
      stream: true,
      tools,
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
      tools,
      input: [
        makeUserInput(prompt),
        makeToolOutputWithCallId(
          "call_mock_sessions_spawn_1",
          JSON.stringify({
            status: "accepted",
            childSessionKey: "agent:qa:subagent:child",
            runId: "run-child-1",
          }),
        ),
      ],
    });

    expect(body).toContain('"name":"sessions_yield"');
    expect(body).toContain("QA-SUBAGENT-DIRECT-FALLBACK-OK");
    if (namespace) {
      expect(body.match(new RegExp(`"namespace":"${namespace}"`, "g"))).toHaveLength(3);
    }
    const yieldDebug = requireRecord(
      await (await fetch(`${server.baseUrl}/debug/last-request`)).json(),
      "yield debug request",
    );
    expect(yieldDebug.plannedToolName).toBe("sessions_yield");
  });

  it("returns no visible announce output for the direct fallback QA marker", async () => {
    const server = await startMockServer();

    const body = await expectOpenAiNonStreamingResponsesJson<{
      output?: Array<{ content?: Array<{ text?: string }> }>;
    }>(server, {
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

  it.each([
    { name: "no current tools", tools: [] },
    { name: "message-only current tools", tools: [MESSAGE_TOOL] },
    {
      name: "protected completion context and delegated tools",
      tools: [SESSIONS_SPAWN_TOOL, SESSIONS_YIELD_TOOL],
      protectedContext: true,
    },
  ])(
    "does not replay historical direct-fallback spawn or yield with $name",
    async ({ tools, protectedContext }) => {
      const server = await startMockServer();
      const kickoff =
        "Subagent direct fallback QA check: spawn one worker and yield until QA-SUBAGENT-DIRECT-FALLBACK-OK is delivered.";
      const completion = [
        "[Internal task completion event]",
        "Task: qa-direct-fallback-worker",
        "Result: QA-SUBAGENT-DIRECT-FALLBACK-OK",
      ].join("\n");

      const payload = await expectNonStreamingResponsesJson(server, {
        tools,
        instructions:
          "Historical sessions_spawn and sessions_yield guidance does not grant completion-turn tools.",
        input: [
          makeUserInput(kickoff),
          makeDeveloperInput("Current completion handoff may use only the declared tool surface."),
          makeUserInput(
            protectedContext
              ? TEST_RUNTIME_CONTEXT_CARRIER.replace("runtime metadata", completion)
              : completion,
          ),
        ],
      });

      expect(outputItems(payload).some((item) => item.type === "function_call")).toBe(false);
      expect(outputText(payload)).toBe("");
      const debugRequest = requireRecord(
        await (await fetch(`${server.baseUrl}/debug/last-request`)).json(),
        "completion debug request",
      );
      expect(debugRequest).not.toHaveProperty("plannedToolName");
    },
  );

  it("prefers the current direct-fallback worker turn over an earlier parent kickoff", async () => {
    const server = await startMockServer();
    const payload = await expectNonStreamingResponsesJson(server, {
      tools: [SESSIONS_SPAWN_TOOL, SESSIONS_YIELD_TOOL],
      input: [
        makeUserInput("Subagent direct fallback QA check: spawn one worker and yield."),
        makeUserInput(
          "Subagent direct fallback worker: finish with exactly QA-SUBAGENT-DIRECT-FALLBACK-OK.",
        ),
      ],
    });

    expect(outputItems(payload).some((item) => item.type === "function_call")).toBe(false);
    expect(outputText(payload)).toBe("QA-SUBAGENT-DIRECT-FALLBACK-OK");
  });

  it.each([
    ["visible", "QA-SUBAGENT-TERMINAL-VISIBLE-OK"],
    ["silent", "NO_REPLY"],
    [
      "empty",
      [
        "<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>",
        "QA-SUBAGENT-TERMINAL-INTERNAL-MUST-NOT-LEAK",
        "<<<END_OPENCLAW_INTERNAL_CONTEXT>>>",
      ].join("\n"),
    ],
    [
      "fallback",
      [
        "QA-SUBAGENT-TERMINAL-FALLBACK-OK",
        "<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>",
        "QA-SUBAGENT-TERMINAL-INTERNAL-MUST-NOT-LEAK",
        "<<<END_OPENCLAW_INTERNAL_CONTEXT>>>",
      ].join("\n"),
    ],
  ])("returns the terminal-reply matrix worker result for %s", async (terminalCase, expected) => {
    const server = await startMockServer();
    const payload = await expectNonStreamingResponsesJson(server, {
      input: [makeUserInput(`Subagent terminal reply QA worker: ${terminalCase}.`)],
    });

    expect(outputText(payload)).toBe(expected);
  });

  it("binds crossed same-case parent responses to their matching workers", async () => {
    const server = await startMockServer();
    const firstChildSessionKey = "agent:qa:subagent:child-1";
    const secondChildSessionKey = "agent:qa:subagent:child-2";
    const startChild = (runtimeSessionId: string, childSessionKey: string) =>
      postNonStreamingResponses(server, {
        model: "gpt-5.6-luna",
        instructions: [
          `Runtime: embedded | sessionId=${runtimeSessionId}`,
          `- Your session: ${childSessionKey}.`,
        ].join("\n"),
        input: [makeUserInput("Subagent terminal reply QA worker: visible.")],
      });
    const settleParent = async (
      runtimeSessionId: string,
      childSessionKey: string,
      callId: string,
    ) => {
      const parent = await expectNonStreamingResponsesJson(server, {
        model: "gpt-5.6-luna",
        instructions: `Runtime: embedded | sessionId=${runtimeSessionId}`,
        tools: [SESSIONS_SPAWN_TOOL, SESSIONS_YIELD_TOOL],
        input: [
          makeUserInput("Subagent terminal reply QA check: visible."),
          makeToolOutputWithCallId(
            callId,
            JSON.stringify({ status: "accepted", childSessionKey, runId: `run-${callId}` }),
          ),
        ],
      });
      expect(outputText(parent)).toBe("NO_REPLY");
    };

    const firstChildResponse = startChild("qa-terminal-child-1", firstChildSessionKey);
    const secondChildResponse = startChild("qa-terminal-child-2", secondChildSessionKey);
    let firstChildSettled = false;
    let secondChildSettled = false;
    void firstChildResponse.then(() => {
      firstChildSettled = true;
    });
    void secondChildResponse.then(() => {
      secondChildSettled = true;
    });

    await expect
      .poll(async () => {
        const inflight = await getJson<unknown[]>(server, "/debug/inflight-requests");
        return inflight.length;
      })
      .toBe(2);

    await settleParent("qa-terminal-parent-2", secondChildSessionKey, "call_spawn_2");
    const secondChild = await (await expectOk(secondChildResponse)).json();
    expect(outputText(secondChild)).toBe("QA-SUBAGENT-TERMINAL-VISIBLE-OK");
    expect(secondChildSettled).toBe(true);
    expect(firstChildSettled).toBe(false);

    await settleParent("qa-terminal-parent-1", firstChildSessionKey, "call_spawn_1");
    const firstChild = await (await expectOk(firstChildResponse)).json();
    expect(outputText(firstChild)).toBe("QA-SUBAGENT-TERMINAL-VISIBLE-OK");
  });

  it("keeps the empty terminal worker empty across retry prompts", async () => {
    const server = await startMockServer();
    const payload = await expectNonStreamingResponsesJson(server, {
      input: [
        makeUserInput("Subagent terminal reply QA worker: empty."),
        makeUserInput("Continue after the previous empty response."),
      ],
    });

    expect(outputText(payload)).toContain("QA-SUBAGENT-TERMINAL-INTERNAL-MUST-NOT-LEAK");
    expect(outputText(payload)).not.toContain("Protocol note:");
  });

  it("makes the empty terminal worker terminal after one side effect", async () => {
    const server = await startMockServer();
    await expectNonStreamingResponsesJson(server, {
      tools: [{ type: "function", name: "write" }],
      input: [makeUserInput("Subagent terminal reply QA worker: empty.")],
    });
    const writeRequest = requireRecord(
      await (await fetch(`${server.baseUrl}/debug/last-request`)).json(),
      "empty terminal write request",
    );
    expect(writeRequest.plannedToolName).toBe("write");
    expect(requireRecord(writeRequest.plannedToolArgs, "empty terminal write args")).toMatchObject({
      path: "qa-terminal-empty-side-effect.txt",
    });

    const payload = await expectNonStreamingResponsesJson(server, {
      tools: [{ type: "function", name: "write" }],
      input: [
        makeUserInput("Subagent terminal reply QA worker: empty."),
        makeToolOutputWithCallId(String(writeRequest.plannedToolCallId), "Wrote 40 bytes"),
      ],
    });
    expect(outputText(payload)).toContain("QA-SUBAGENT-TERMINAL-INTERNAL-MUST-NOT-LEAK");
  });

  it("represents an empty terminal reply intentionally in the resumed parent turn", async () => {
    const server = await startMockServer();
    const payload = await expectNonStreamingResponsesJson(server, {
      input: [
        makeUserInput("Subagent terminal reply QA check: empty."),
        makeUserInput(
          [
            "[Internal task completion event]",
            "Task: qa-terminal-empty",
            "Result: (no output)",
          ].join("\n"),
        ),
      ],
    });

    expect(outputText(payload)).toBe("QA-SUBAGENT-TERMINAL-EMPTY-REPRESENTED");
  });

  it("delivers silent terminal representation through the required message tool", async () => {
    const server = await startMockServer();
    const completionInput = [
      makeUserInput("Subagent terminal reply QA check: silent."),
      makeUserInput(
        TEST_RUNTIME_CONTEXT_CARRIER.replace(
          "runtime metadata",
          "[Internal task completion event]\nTask: qa-terminal-silent\nResult: (no output)",
        ),
      ),
    ];
    const delivery = await expectNonStreamingResponsesJson(server, {
      tools: [MESSAGE_TOOL],
      instructions:
        "Visible source replies are not automatically delivered for this run. Use `message(action=send)` for user-visible source-channel output. When the message is the completed reply to the current source conversation, set `final=true`.",
      input: completionInput,
    });
    const messageCall = outputToolCall(delivery, "message");
    expect(outputToolArgsFromItem(messageCall)).toEqual({
      action: "send",
      message: "QA-SUBAGENT-TERMINAL-SILENT-REPRESENTED",
      final: true,
    });

    const settled = await expectNonStreamingResponsesJson(server, {
      tools: [MESSAGE_TOOL],
      input: [
        ...completionInput,
        messageCall,
        makeToolOutputWithCallId(
          outputToolCallId(messageCall, "call_mock_message_silent_terminal"),
          '{"ok":true,"messageId":"qa-silent-terminal"}',
        ),
      ],
    });
    expect(outputItems(settled).some((item) => item.type === "function_call")).toBe(false);
    expect(outputText(settled)).toBe("");
  });

  it.each([
    {
      name: "OpenAI private-source guidance",
      instructions:
        "Current source visible reply MUST use `message(action=send)`; final text is private.",
      final: undefined,
    },
    {
      name: "Codex private-source guidance",
      instructions:
        "Visible source replies are not automatically delivered for this run. Use `message(action=send)` for user-visible source-channel output. When the message is the completed reply to the current source conversation, set `final=true`.",
      final: true,
    },
  ])("delivers an empty terminal representation with $name", async ({ instructions, final }) => {
    const server = await startMockServer();
    const completionInput = [
      makeUserInput("Subagent terminal reply QA check: empty."),
      {
        type: "function_call",
        call_id: "call_empty_historical_write",
        name: "write",
        arguments: '{"path":"qa-terminal-empty-side-effect.txt"}',
      },
      makeToolOutputWithCallId("call_empty_historical_write", "Wrote 40 bytes"),
      makeUserInput(
        TEST_RUNTIME_CONTEXT_CARRIER.replace(
          "runtime metadata",
          "[Internal task completion event]\nTask: qa-terminal-empty\nResult: (no output)",
        ),
      ),
    ];
    const delivery = await expectNonStreamingResponsesJson(server, {
      tools: [MESSAGE_TOOL],
      instructions,
      input: completionInput,
    });
    const messageCall = outputToolCall(delivery, "message");
    expect(outputToolArgsFromItem(messageCall)).toEqual({
      action: "send",
      message: "QA-SUBAGENT-TERMINAL-EMPTY-REPRESENTED",
      ...(final ? { final } : {}),
    });

    const settled = await expectNonStreamingResponsesJson(server, {
      tools: [MESSAGE_TOOL],
      instructions,
      input: [
        ...completionInput,
        messageCall,
        makeToolOutputWithCallId(
          outputToolCallId(messageCall, "call_mock_message_empty_terminal"),
          '{"ok":true,"messageId":"qa-empty-terminal"}',
        ),
      ],
    });
    expect(outputItems(settled).some((item) => item.type === "function_call")).toBe(false);
    expect(outputText(settled)).toBe("");
  });

  it("classifies a completion event before the child task text it quotes", async () => {
    const server = await startMockServer();
    const payload = await expectNonStreamingResponsesJson(server, {
      input: [
        makeUserInput("Subagent terminal reply QA check: empty."),
        makeUserInput(
          [
            "[Internal task completion event]",
            "Task: Subagent terminal reply QA worker: empty.",
            "Result: (no output)",
          ].join("\n"),
        ),
      ],
    });

    expect(outputText(payload)).toBe("QA-SUBAGENT-TERMINAL-EMPTY-REPRESENTED");
  });

  it.each(["visible", "silent", "fallback", "restart", "empty"])(
    "ends the %s parent turn before direct terminal delivery",
    async (terminalCase) => {
      const server = await startMockServer();
      const prompt = `Subagent terminal reply QA check: ${terminalCase}.`;
      const payload = await expectNonStreamingResponsesJson(server, {
        tools: [SESSIONS_SPAWN_TOOL, SESSIONS_YIELD_TOOL],
        input: [
          makeUserInput(prompt),
          makeToolOutputWithCallId(
            "call_mock_sessions_spawn_1",
            JSON.stringify({ status: "accepted", runId: `run-${terminalCase}` }),
          ),
        ],
      });

      expect(outputItems(payload).some((item) => item.type === "function_call")).toBe(false);
      expect(outputText(payload)).toBe("NO_REPLY");
    },
  );

  it.each([
    ["visible", "NO_REPLY"],
    ["silent", "QA-SUBAGENT-TERMINAL-SILENT-REPRESENTED"],
    ["fallback", "NO_REPLY"],
    ["restart", "NO_REPLY"],
  ])(
    "uses the expected representation for the %s completion-agent direct fallback",
    async (terminalCase, expected) => {
      const server = await startMockServer();
      const payload = await expectNonStreamingResponsesJson(server, {
        tools: [SESSIONS_SPAWN_TOOL, SESSIONS_YIELD_TOOL],
        input: [
          makeUserInput(`Subagent terminal reply QA check: ${terminalCase}.`),
          makeUserInput(
            TEST_RUNTIME_CONTEXT_CARRIER.replace(
              "runtime metadata",
              [
                "[Internal task completion event]",
                `Task: qa-terminal-${terminalCase}`,
                `Result: QA-SUBAGENT-TERMINAL-${terminalCase.toUpperCase()}-OK`,
              ].join("\n"),
            ),
          ),
        ],
      });

      expect(outputItems(payload).some((item) => item.type === "function_call")).toBe(false);
      expect(outputText(payload)).toBe(expected);
    },
  );

  it("uses the latest terminal-reply case in a shared parent transcript", async () => {
    const server = await startMockServer();
    const payload = await expectNonStreamingResponsesJson(server, {
      tools: [SESSIONS_SPAWN_TOOL, SESSIONS_YIELD_TOOL],
      input: [
        makeUserInput("Subagent terminal reply QA check: visible."),
        makeUserInput("Subagent terminal reply QA check: silent."),
      ],
    });

    expect(outputItems(payload).some((item) => item.type === "function_call")).toBe(true);
    const debugRequest = requireRecord(
      await (await fetch(`${server.baseUrl}/debug/last-request`)).json(),
      "latest terminal case debug request",
    );
    expect(debugRequest.plannedToolName).toBe("sessions_spawn");
    expect(requireRecord(debugRequest.plannedToolArgs, "latest terminal case args").label).toBe(
      "qa-terminal-silent",
    );
  });

  it("ignores a stale terminal-reply case in a later internal runtime carrier", async () => {
    const server = await startMockServer();
    const payload = await expectNonStreamingResponsesJson(server, {
      tools: [SESSIONS_SPAWN_TOOL, SESSIONS_YIELD_TOOL],
      input: [
        makeUserInput("Subagent terminal reply QA check: fallback."),
        makeUserInput(
          TEST_RUNTIME_CONTEXT_CARRIER.replace(
            "runtime metadata",
            "Subagent terminal reply QA check: silent.",
          ),
        ),
      ],
    });

    expect(outputItems(payload).some((item) => item.type === "function_call")).toBe(true);
    const debugRequest = requireRecord(
      await (await fetch(`${server.baseUrl}/debug/last-request`)).json(),
      "current terminal case debug request",
    );
    expect(debugRequest.plannedToolName).toBe("sessions_spawn");
    expect(requireRecord(debugRequest.plannedToolArgs, "current terminal case args").label).toBe(
      "qa-terminal-fallback",
    );
  });

  it("does not treat prompt or instruction mentions as callable subagent tools", async () => {
    const server = await startMockServer();
    const payload = await expectNonStreamingResponsesJson(server, {
      tools: [MESSAGE_TOOL],
      instructions: "The prior run used sessions_spawn and sessions_yield.",
      input: [
        makeUserInput(
          'Use sessions_spawn for this QA check. task="Return historical answer" label=qa-stale.',
        ),
      ],
    });

    expect(outputItems(payload).some((item) => item.type === "function_call")).toBe(false);
  });

  it("surfaces sessions_spawn tool errors instead of echoing child-task tokens", async () => {
    const server = await startMockServer();

    const body = await expectNonStreamingResponsesJson<{
      output?: Array<{ content?: Array<{ text?: string }> }>;
    }>(server, {
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
        makeToolOutput(
          JSON.stringify({
            status: "error",
            error: THREAD_SUBAGENT_TOOL_ERROR,
          }),
        ),
      ],
    });

    const text = body.output?.[0]?.content?.[0]?.text ?? "";
    expect(text).toContain(THREAD_SUBAGENT_TOOL_ERROR);
    expect(text).not.toContain(THREAD_SUBAGENT_CHILD_ERROR_TOKEN);
  });

  it("does not echo child-task tokens after sessions_spawn accepts the request", async () => {
    const server = await startMockServer();
    const childToken = "QA_SUBAGENT_CHILD_ACCEPTED";

    const body = await expectNonStreamingResponsesJson<{
      output?: Array<{ content?: Array<{ text?: string }> }>;
    }>(server, {
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
        makeToolOutput(
          JSON.stringify({
            status: "accepted",
            threadRootEventId: "$thread-root",
          }),
        ),
      ],
    });

    const text = body.output?.[0]?.content?.[0]?.text ?? "";
    expect(text).toContain("Protocol note");
    expect(text).not.toContain(childToken);
  });

  it("lets child subagent prompts finish with an exact token", async () => {
    const server = await startMockServer();
    const childToken = "QA_SUBAGENT_CHILD_DIRECT";

    const childPayload = await expectNonStreamingResponsesJson<{
      output?: Array<{ content?: Array<{ text?: string }> }>;
    }>(server, {
      input: [makeUserInput(threadSubagentTask(childToken))],
    });
    expect(outputText(childPayload)).toBe(childToken);
  });

  it("does not replay a parent sessions_spawn instruction in the child session", async () => {
    const server = await startMockServer();
    const childToken = "QA_SUBAGENT_CHILD_WITH_PARENT_CONTEXT";

    const childPayload = await expectNonStreamingResponsesJson<{
      output?: Array<{ content?: Array<{ text?: string }> }>;
    }>(server, {
      input: [
        makeUserInput(explicitSessionsSpawnPrompt(childToken)),
        makeUserInput(threadSubagentTask(childToken)),
      ],
    });
    expect(outputText(childPayload)).toBe(childToken);
  });

  it("plans memory tools and serves mock image generations", async () => {
    const server = await startMockServer();

    const memorySearch = await expectStreamingResponses(server, {
      input: [
        makeUserInput(
          "Memory tools check: what is the hidden project codename stored only in memory? Use memory tools first.",
        ),
      ],
    });
    expect(await memorySearch.text()).toContain('"name":"memory_search"');

    const memoryGetText = await expectStreamingResponsesText(server, {
      input: [
        makeUserInput(
          "Memory tools check: what is the hidden project codename stored only in memory? Use memory tools first.",
        ),
        makeToolOutput(
          JSON.stringify({
            results: [
              {
                path: "MEMORY.md",
                snippet: "Hidden QA fact: the project codename is ORBIT-9.",
              },
            ],
          }),
        ),
        makeUserInput("Protocol note: acknowledged. Continue with the QA scenario plan."),
      ],
    });
    expect(memoryGetText).toContain('"name":"memory_get"');
    expect(memoryGetText).toContain('\\"path\\":\\"MEMORY.md\\"');
    expect(memoryGetText).toContain('\\"from\\":1');

    const image = await fetchOk(`${server.baseUrl}/v1/images/generations`, {
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
    const imagePayload = requireRecord(await image.json(), "image response");
    const imageData = requireArray(imagePayload.data, "image data");
    expect(typeof requireRecord(imageData[0], "image data 0").b64_json).toBe("string");

    const imageRequestLog = requireArray(
      await getJson(server, "/debug/image-generations"),
      "image generation requests",
    );
    const imageRequest = requireRecord(imageRequestLog[0], "image generation request 0");
    expect(imageRequest.model).toBe("gpt-image-1");
    expect(imageRequest.prompt).toBe("Draw a QA lighthouse");
    expect(imageRequest.n).toBe(1);
    expect(imageRequest.size).toBe("1024x1024");
  });

  it("requires memory_get before answering thread recall in Code Mode", async () => {
    const server = await startMockServer();
    const prompt =
      "@openclaw Thread memory check: what is the hidden thread codename stored only in memory? Use memory tools first and reply only in this thread.";
    const codeModeTools = [
      {
        type: "function",
        name: "exec",
        parameters: {
          type: "object",
          properties: {
            language: { type: "string" },
            code: { type: "string" },
          },
          required: ["code"],
        },
      },
      {
        type: "function",
        name: "wait",
        parameters: {
          type: "object",
          properties: { runId: { type: "string" } },
          required: ["runId"],
        },
      },
    ];
    const initialInput: Array<Record<string, unknown>> = [
      {
        type: "additional_tools",
        role: "developer",
        tools: codeModeTools,
      },
      makeUserInput(prompt),
    ];

    const searchPlan = await expectOpenAiNonStreamingResponsesJson(server, {
      input: initialInput,
    });
    const searchCall = outputToolCall(searchPlan, "exec");
    const searchCallId = outputToolCallId(searchCall, "call_mock_memory_search");
    const continuationInput: Array<Record<string, unknown>> = [
      makeUserInput(prompt),
      searchCall,
      makeToolOutputWithCallId(
        searchCallId,
        JSON.stringify({
          status: "completed",
          value: {
            results: [
              {
                path: "MEMORY.md",
                startLine: 1,
                endLine: 1,
                snippet: "Thread-hidden codename: ORBIT-21.",
              },
            ],
          },
        }),
      ),
    ];

    const getPlan = await expectOpenAiNonStreamingResponsesJson(server, {
      input: continuationInput,
    });
    const getCall = outputToolCall(getPlan, "memory_get");
    const getCallId = outputToolCallId(getCall, "call_mock_memory_get");
    expect(getCallId).not.toBe(searchCallId);
    expect(outputItems(getPlan).some((item) => item.type === "message")).toBe(false);
    expect(JSON.stringify(getPlan)).not.toContain("hidden thread codename is ORBIT-21");
    continuationInput.push(
      getCall,
      makeToolOutputWithCallId(
        getCallId,
        JSON.stringify({
          status: "completed",
          value: { text: "Thread-hidden codename: ORBIT-22." },
        }),
      ),
    );

    const final = await expectOpenAiNonStreamingResponsesJson(server, {
      input: continuationInput,
    });
    expect(outputText(final)).toContain("ORBIT-22");
    expect(outputText(final)).not.toContain("ORBIT-21");
    expect(outputItems(final).some((item) => item.type === "function_call")).toBe(false);

    const requests = requireArray(await getJson(server, "/debug/requests"), "debug requests").map(
      (request, index) => requireRecord(request, `debug request ${index}`),
    );
    expect(requests).toHaveLength(3);
    expect(requests[0]).toMatchObject({
      plannedToolName: "memory_search",
      plannedWireToolName: "exec",
      plannedToolCallId: searchCallId,
    });
    expect(requests[1]).toMatchObject({
      toolOutputCallId: searchCallId,
      plannedToolName: "memory_get",
      plannedToolCallId: getCallId,
    });
    expect(requests[1]).not.toHaveProperty("plannedWireToolName");
    expect(requests[2]).toMatchObject({
      toolOutputCallId: getCallId,
    });
    expect(requests[2]).not.toHaveProperty("plannedToolName");
  });

  it("supports advanced QA memory and subagent recovery prompts", async () => {
    const server = await startMockServer();
    const rankingPrompt =
      "Session memory ranking check: what is the current Project Nebula codename? Use memory tools first.";
    const threadPrompt =
      "@openclaw Thread memory check: what is the hidden thread codename stored only in memory? Use memory tools first and reply only in this thread.";
    const acknowledgement = makeUserInput(
      "Protocol note: acknowledged. Continue with the QA scenario plan.",
    );
    const snack = "lemon pepper wings with blue cheese";
    const activeMemoryPrompt = [
      "You are a memory search agent.",
      "Use only the available memory tools.",
      "Prefer memory_recall when available.",
      "If memory_recall is unavailable, use memory_search and memory_get.",
      "",
      "Conversation context:",
      "Latest user message:",
      "Silent snack recall check: what snack do I usually want for QA movie night? Reply in one short sentence.",
    ].join("\n");
    const rememberPrompt = [
      "You are a memory search agent.",
      "Use only the available memory tools.",
      "Latest user message:",
      "Remember across conversations QA check: what snack do I usually want for QA movie night?",
    ].join("\n");
    const memoryOutput = (value: unknown) => makeToolOutput(JSON.stringify(value));
    const streamMemory = (prompt: string, ...inputs: unknown[]) =>
      expectStreamingResponsesText(server, { input: [makeUserInput(prompt), ...inputs] });
    const streamMemoryResponse = (prompt: string, ...inputs: unknown[]) =>
      expectStreamingResponses(server, { input: [makeUserInput(prompt), ...inputs] });
    const readMemory = (input: unknown[], instructions?: string) =>
      expectNonStreamingResponses(server, {
        ...(instructions ? { instructions } : {}),
        input,
      });

    const memoryText = await streamMemory(rankingPrompt);
    expect(memoryText).toContain('"name":"memory_search"');
    expect(memoryText).not.toContain('\\"corpus\\"');

    const threadMemorySearchText = await expectStreamingResponsesText(server, {
      instructions: threadPrompt,
      input: [acknowledgement],
    });
    expect(threadMemorySearchText).toContain('"name":"memory_search"');
    expect(threadMemorySearchText).toContain("ORBIT-22");

    const threadMemoryGetText = await expectStreamingResponsesText(server, {
      instructions: threadPrompt,
      input: [
        memoryOutput({
          results: [
            {
              path: "MEMORY.md",
              startLine: 1,
              endLine: 1,
              snippet: "Thread-hidden codename: ORBIT-22.",
            },
          ],
        }),
        acknowledgement,
      ],
    });
    expect(threadMemoryGetText).toContain('"name":"memory_get"');
    expect(threadMemoryGetText).toContain('\\"path\\":\\"MEMORY.md\\"');
    expect(threadMemoryGetText).not.toContain("hidden thread codename is ORBIT-22");

    const threadMemorySummary = await readMemory(
      [memoryOutput({ text: "Thread-hidden codename: ORBIT-22." }), acknowledgement],
      threadPrompt,
    );
    expect(JSON.stringify(await threadMemorySummary.json())).toContain("ORBIT-22");

    const rawThreadMemorySummary = await readMemory(
      [makeToolOutput("Thread-hidden codename: ORBIT-23."), acknowledgement],
      threadPrompt,
    );
    const rawThreadMemoryText = JSON.stringify(await rawThreadMemorySummary.json());
    expect(rawThreadMemoryText).toContain("NONE");
    expect(rawThreadMemoryText).not.toContain("ORBIT-23");

    const unavailableThreadMemorySummary = await readMemory([
      {
        role: "system",
        content:
          "Available tools include sessions_spawn.\n## /workspace/MEMORY.md\nThread-hidden codename: ORBIT-22.",
      },
      makeUserInput(threadPrompt),
      memoryOutput({ results: [], unavailable: true, error: "database is not open" }),
    ]);
    const unavailableThreadMemoryText = JSON.stringify(await unavailableThreadMemorySummary.json());
    expect(unavailableThreadMemoryText).toContain("NONE");
    expect(unavailableThreadMemoryText).not.toContain("ORBIT-22");

    const emptyThreadMemorySummary = await readMemory([
      {
        role: "system",
        content: "## /workspace/MEMORY.md\nThread-hidden codename: ORBIT-22.",
      },
      makeUserInput(threadPrompt),
      memoryOutput({ results: [] }),
    ]);
    const emptyThreadMemoryText = JSON.stringify(await emptyThreadMemorySummary.json());
    expect(emptyThreadMemoryText).toContain("NONE");
    expect(emptyThreadMemoryText).not.toContain("ORBIT-22");

    const currentSessionResult = {
      path: "sessions/qa-session-memory-ranking.jsonl",
      startLine: 2,
      endLine: 3,
      snippet: "Project Nebula current codename: ORBIT-10.",
    };
    const memoryFollowup = await streamMemoryResponse(
      rankingPrompt,
      memoryOutput({ results: [currentSessionResult] }),
    );
    expect(await memoryFollowup.text()).toContain(
      "Protocol note: I checked memory and the current Project Nebula codename is ORBIT-10.",
    );

    const memoryFollowupPrefersSessionResult = await streamMemoryResponse(
      rankingPrompt,
      memoryOutput({
        results: [
          {
            path: "MEMORY.md",
            startLine: 1,
            endLine: 2,
            snippet: "Project Nebula stale codename: ORBIT-9.",
          },
          currentSessionResult,
        ],
      }),
    );
    expect(await memoryFollowupPrefersSessionResult.text()).toContain(
      "Protocol note: I checked memory and the current Project Nebula codename is ORBIT-10.",
    );

    const pathOnlySessionMemoryText = await streamMemory(
      rankingPrompt,
      memoryOutput({ results: [{ path: currentSessionResult.path, startLine: 2, endLine: 3 }] }),
    );
    expect(pathOnlySessionMemoryText).toContain('"name":"memory_get"');
    expect(pathOnlySessionMemoryText).not.toContain("codename is ORBIT-10");

    const unavailableSessionMemoryText = await streamMemory(
      rankingPrompt,
      memoryOutput({
        results: [{ path: currentSessionResult.path, snippet: currentSessionResult.snippet }],
        unavailable: true,
        error: "database is not open",
      }),
    );
    expect(unavailableSessionMemoryText).toContain("NONE");
    expect(unavailableSessionMemoryText).not.toContain("codename is ORBIT-10");

    const differentlyRankedSessionMemoryText = await streamMemory(
      rankingPrompt,
      memoryOutput({
        results: [
          { path: currentSessionResult.path, snippet: "Project Nebula current codename: ORBIT-9." },
        ],
      }),
    );
    expect(differentlyRankedSessionMemoryText).toContain("codename is ORBIT-9");
    expect(differentlyRankedSessionMemoryText).not.toContain("codename is ORBIT-10");

    const activeMemorySearch = await streamMemoryResponse(activeMemoryPrompt);
    expect(await activeMemorySearch.text()).toContain('"name":"memory_search"');

    const snackOutput = memoryOutput({ text: `Stable QA movie night snack preference: ${snack}.` });
    const activeMemoryStreamSummary = await streamMemoryResponse(activeMemoryPrompt, snackOutput);
    expect(await activeMemoryStreamSummary.text()).toContain("lemon pepper wings with blue cheese");

    const activeMemorySummary = await readMemory([makeUserInput(activeMemoryPrompt), snackOutput]);
    expect(JSON.stringify(await activeMemorySummary.json())).toContain(
      "lemon pepper wings with blue cheese",
    );

    const injectedMemory = `<active_memory_plugin>User usually wants ${snack} for QA movie night.</active_memory_plugin>`;
    const injectedMainReply = await readMemory(
      [
        makeUserInput(
          "Silent snack recall check: what snack do I usually want for QA movie night? Reply in one short sentence.",
        ),
      ],
      ["System context:", injectedMemory].join("\n"),
    );
    expect(JSON.stringify(await injectedMainReply.json())).toContain(
      "lemon pepper wings with blue cheese",
    );
    const lastRequestPayload = requireRecord(
      await getJson(server, "/debug/last-request"),
      "last request",
    );
    expect(String(lastRequestPayload.instructions)).toContain("<active_memory_plugin>");
    expect(String(lastRequestPayload.allInputText)).toContain("<active_memory_plugin>");

    const rememberSearchText = await streamMemory(rememberPrompt);
    expect(rememberSearchText).toContain('"name":"memory_search"');
    expect(rememberSearchText).toContain("QA movie night snack lemon pepper wings blue cheese");
    expect(rememberSearchText).toContain('\\"maxResults\\":10');

    const rememberSearchSummaryText = await streamMemory(
      rememberPrompt,
      memoryOutput({
        results: [
          {
            path: "sessions/private-source.jsonl",
            startLine: 2,
            endLine: 3,
            snippet: `Stable QA movie night snack preference: ${snack}.`,
          },
        ],
      }),
    );
    expect(rememberSearchSummaryText).toContain("lemon pepper wings with blue cheese");
    expect(rememberSearchSummaryText).not.toContain('"name":"memory_get"');

    const rememberInjectedMainReply = await readMemory(
      [
        makeUserInput(
          "Remember across conversations QA check: what snack do I usually want for QA movie night?",
        ),
      ],
      injectedMemory,
    );
    expect(JSON.stringify(await rememberInjectedMainReply.json())).toContain(
      "lemon pepper wings with blue cheese",
    );

    const fanoutPrompt =
      "Subagent fanout synthesis check: delegate two bounded subagents sequentially, then report both results together.";
    const spawnBody = await expectStreamingResponsesText(server, {
      tools: [SESSIONS_SPAWN_TOOL],
      input: [makeUserInput(fanoutPrompt)],
    });
    expect(spawnBody).toContain('"name":"sessions_spawn"');
    expect(spawnBody).toContain('\\"label\\":\\"qa-fanout-alpha\\"');

    const secondSpawnBody = await expectStreamingResponsesText(server, {
      tools: [SESSIONS_SPAWN_TOOL],
      input: [
        makeUserInput(fanoutPrompt),
        makeToolOutput(
          '{"status":"accepted","childSessionKey":"agent:qa:subagent:alpha","note":"ALPHA-OK"}',
        ),
      ],
    });
    expect(secondSpawnBody).toContain('"name":"sessions_spawn"');
    expect(secondSpawnBody).toContain('\\"label\\":\\"qa-fanout-beta\\"');

    const final = await expectNonStreamingResponses(server, {
      tools: [SESSIONS_SPAWN_TOOL],
      input: [
        makeUserInput(fanoutPrompt),
        makeToolOutput(
          '{"status":"accepted","childSessionKey":"agent:qa:subagent:beta","note":"BETA-OK"}',
        ),
      ],
    });
    expect(outputText(await final.json())).toBe("subagent-1: ok\nsubagent-2: ok");
  });

  it.each([
    "body instructions",
    "developer-role input",
    "Codex base instructions plus developer-role input",
  ])(
    "delivers synthesized fanout results through the message tool when %s makes the final private",
    async (instructionSource) => {
      const server = await startMockServer();
      const prompt =
        "Subagent fanout synthesis check: delegate two bounded subagents sequentially, then report both results together.";
      const tools = [SESSIONS_SPAWN_TOOL, MESSAGE_TOOL];

      const firstSpawn = await expectNonStreamingResponsesJson(server, {
        tools,
        input: [makeUserInput(prompt)],
      });
      expect(outputToolArgsFromItem(outputToolCall(firstSpawn, "sessions_spawn"))).toMatchObject({
        label: "qa-fanout-alpha",
      });

      const secondSpawn = await expectNonStreamingResponsesJson(server, {
        tools,
        input: [
          makeUserInput(prompt),
          makeToolOutput(
            '{"status":"accepted","childSessionKey":"agent:qa:subagent:alpha","note":"ALPHA-OK"}',
          ),
        ],
      });
      expect(outputToolArgsFromItem(outputToolCall(secondSpawn, "sessions_spawn"))).toMatchObject({
        label: "qa-fanout-beta",
      });

      const completionInput = [
        makeUserInput(prompt),
        makeUserInput("[Internal task completion event]\nresult: ALPHA-OK\nresult: BETA-OK"),
      ];
      const usesCodexDelivery = instructionSource.startsWith("Codex");
      const instructions = usesCodexDelivery
        ? "Visible source replies are not automatically delivered for this run. Use `message(action=send)` for user-visible source-channel output. For progress, set `final=false`. When the message is the completed reply to the current source conversation, set `final=true`; OpenClaw stops after confirming delivery."
        : "Current source visible reply MUST use `message(action=send)`; final text is private. Skip tool = user gets nothing.";
      const withDeliveryInstructions = (input: unknown[]) =>
        instructionSource === "body instructions"
          ? { instructions, input }
          : {
              ...(usesCodexDelivery
                ? { instructions: "Follow the unrelated Codex base instructions." }
                : {}),
              input: [
                { role: "developer", content: [{ type: "input_text", text: instructions }] },
                ...input,
              ],
            };
      const delivery = await expectNonStreamingResponsesJson(server, {
        tools,
        ...withDeliveryInstructions(completionInput),
      });
      const messageCall = outputToolCall(delivery, "message");
      expect(outputToolArgsFromItem(messageCall)).toEqual({
        action: "send",
        message: "subagent-1: ok\nsubagent-2: ok",
        ...(usesCodexDelivery ? { final: true } : {}),
      });

      const settled = await expectNonStreamingResponsesJson(server, {
        tools,
        ...withDeliveryInstructions([
          ...completionInput,
          messageCall,
          makeToolOutputWithCallId(
            outputToolCallId(messageCall, "call_mock_message_fanout"),
            '{"ok":true,"messageId":"qa-fanout-final"}',
          ),
        ]),
      });
      expect(outputItems(settled).some((item) => item.type === "function_call")).toBe(false);
      expect(outputText(settled)).toBe("");
    },
  );

  it.each(["OpenAI developer instructions", "Codex developer instructions"])(
    "waits for separate private fanout completion turns before message-only delivery with %s",
    async (instructionSource) => {
      const server = await startMockServer();
      const prompt =
        "Subagent fanout synthesis check: delegate two bounded subagents sequentially, then report both results together.";
      const usesCodexDelivery = instructionSource.startsWith("Codex");
      const instructions = usesCodexDelivery
        ? "Visible source replies are not automatically delivered for this run. Use `message(action=send)` for user-visible source-channel output. For progress, set `final=false`. When the message is the completed reply to the current source conversation, set `final=true`; OpenClaw stops after confirming delivery."
        : "Current source visible reply MUST use `message(action=send)`; final text is private. Skip tool = user gets nothing.";

      const firstSpawn = await expectNonStreamingResponsesJson(server, {
        tools: [SESSIONS_SPAWN_TOOL],
        input: [makeUserInput(prompt)],
      });
      expect(outputToolArgsFromItem(outputToolCall(firstSpawn, "sessions_spawn"))).toMatchObject({
        label: "qa-fanout-alpha",
      });

      const secondSpawn = await expectNonStreamingResponsesJson(server, {
        tools: [SESSIONS_SPAWN_TOOL],
        input: [
          makeUserInput(prompt),
          makeToolOutput('{"status":"accepted","childSessionKey":"agent:qa:subagent:alpha"}'),
        ],
      });
      expect(outputToolArgsFromItem(outputToolCall(secondSpawn, "sessions_spawn"))).toMatchObject({
        label: "qa-fanout-beta",
      });

      const privateCompletion = (workerMarker: "ALPHA-OK" | "BETA-OK") => ({
        stream: false,
        tools: [MESSAGE_TOOL],
        ...(usesCodexDelivery
          ? { instructions: "Follow the unrelated Codex base instructions." }
          : {}),
        input: [
          { role: "developer", content: [{ type: "input_text", text: instructions }] },
          makeUserInput(prompt),
          makeUserInput(`[Internal task completion event]\nresult: ${workerMarker}`),
        ],
      });

      const alphaCompletion = await expectResponsesJson(server, privateCompletion("ALPHA-OK"));
      expect(outputItems(alphaCompletion).some((item) => item.type === "function_call")).toBe(
        false,
      );
      expect(outputText(alphaCompletion)).toBe("");

      const betaCompletion = await expectResponsesJson(server, privateCompletion("BETA-OK"));
      expect(outputToolArgsFromItem(outputToolCall(betaCompletion, "message"))).toEqual({
        action: "send",
        message: "subagent-1: ok\nsubagent-2: ok",
        ...(usesCodexDelivery ? { final: true } : {}),
      });
    },
  );

  it.each(["OpenAI developer instructions", "Codex developer instructions"])(
    "defers private zero-tool fanout completions to the parent-owned settle wake with %s",
    async (instructionSource) => {
      const server = await startMockServer();
      const prompt =
        "Subagent fanout synthesis check: delegate two bounded subagents sequentially, then report both results together.";
      const usesCodexDelivery = instructionSource.startsWith("Codex");
      const instructions = usesCodexDelivery
        ? "Visible source replies are not automatically delivered for this run. Use `message(action=send)` for user-visible source-channel output. For progress, set `final=false`. When the message is the completed reply to the current source conversation, set `final=true`; OpenClaw stops after confirming delivery."
        : "Current source visible reply MUST use `message(action=send)`; final text is private. Skip tool = user gets nothing.";

      const firstSpawn = await expectNonStreamingResponsesJson(server, {
        tools: [SESSIONS_SPAWN_TOOL],
        input: [makeUserInput(prompt)],
      });
      expect(outputToolArgsFromItem(outputToolCall(firstSpawn, "sessions_spawn"))).toMatchObject({
        label: "qa-fanout-alpha",
      });

      const secondSpawn = await expectNonStreamingResponsesJson(server, {
        tools: [SESSIONS_SPAWN_TOOL],
        input: [
          makeUserInput(prompt),
          makeToolOutput('{"status":"accepted","childSessionKey":"agent:qa:subagent:alpha"}'),
        ],
      });
      expect(outputToolArgsFromItem(outputToolCall(secondSpawn, "sessions_spawn"))).toMatchObject({
        label: "qa-fanout-beta",
      });

      for (const workerMarker of ["ALPHA-OK", "BETA-OK"] as const) {
        const completion = await expectNonStreamingResponsesJson(server, {
          tools: [],
          ...(usesCodexDelivery
            ? { instructions: "Follow the unrelated Codex base instructions." }
            : {}),
          input: [
            makeDeveloperInput(instructions),
            makeUserInput(prompt),
            makeUserInput(`[Internal task completion event]\nresult: ${workerMarker}`),
          ],
        });
        expect(outputItems(completion).some((item) => item.type === "function_call")).toBe(false);
        expect(outputText(completion)).toBe("");
      }

      const requesterSettleWake = await expectNonStreamingResponsesJson(server, {
        tools: [SESSIONS_SPAWN_TOOL],
        input: [
          makeUserInput(prompt),
          makeUserInput(
            "[Subagent Context] Every subagent spawned from this session has now settled.\n[Subagent Context] Review the completion results and send your consolidated final answer to the user now.\nALPHA-OK\nBETA-OK",
          ),
        ],
      });
      expect(outputItems(requesterSettleWake).some((item) => item.type === "function_call")).toBe(
        false,
      );
      expect(outputText(requesterSettleWake)).toBe("subagent-1: ok\nsubagent-2: ok");
    },
  );

  it("replays completed subagent fanout on requester-settle continuation turns", async () => {
    const server = await startMockServer();

    const prompt =
      "Subagent fanout synthesis check: delegate two bounded subagents sequentially, then report both results together.";
    const spawn = await expectStreamingResponses(server, {
      tools: [SESSIONS_SPAWN_TOOL],
      input: [makeUserInput(prompt)],
    });
    expect(await spawn.text()).toContain('\\"label\\":\\"qa-fanout-alpha\\"');

    const secondSpawn = await expectStreamingResponses(server, {
      tools: [SESSIONS_SPAWN_TOOL],
      input: [
        makeUserInput(prompt),
        makeToolOutput(
          '{"status":"accepted","childSessionKey":"agent:qa:subagent:alpha","note":"ALPHA-OK"}',
        ),
      ],
    });
    expect(await secondSpawn.text()).toContain('\\"label\\":\\"qa-fanout-beta\\"');

    const settledFinal = await expectNonStreamingResponses(server, {
      tools: [SESSIONS_SPAWN_TOOL],
      input: [
        makeUserInput(prompt),
        makeUserInput(
          "[Subagent Context] Every subagent spawned from this session has now settled.\nALPHA-OK\nBETA-OK",
        ),
      ],
    });
    expect(outputText(await settledFinal.json())).toBe("subagent-1: ok\nsubagent-2: ok");

    const settledPayload = await expectNonStreamingResponsesJson(server, {
      tools: [SESSIONS_SPAWN_TOOL],
      input: [
        makeUserInput(prompt),
        makeUserInput(
          "[Inter-session message]\nALPHA-OK\nBETA-OK\nAll spawned subagents have settled. Resume the parent turn and report both results together.",
        ),
      ],
    });
    expect(outputText(settledPayload)).toBe("subagent-1: ok\nsubagent-2: ok");
    expect(outputItems(settledPayload)).not.toContainEqual(
      expect.objectContaining({ type: "function_call", name: "sessions_spawn" }),
    );

    const unrelatedContinuation = await expectNonStreamingResponses(server, {
      tools: [SESSIONS_SPAWN_TOOL],
      input: [makeUserInput("Continue with an unrelated conversation.")],
    });
    expect(outputText(await unrelatedContinuation.json())).not.toBe(
      "subagent-1: ok\nsubagent-2: ok",
    );

    const restartedFanout = await expectNonStreamingResponses(server, {
      tools: [SESSIONS_SPAWN_TOOL],
      input: [makeUserInput(prompt)],
    });
    expect(
      outputToolArgsFromItem(outputToolCall(await restartedFanout.json(), "sessions_spawn")),
    ).toEqual(expect.objectContaining({ label: "qa-fanout-alpha" }));
  });

  it("completes subagent fanout when beta completion arrives on a generic follow-up turn", async () => {
    const server = await startMockServer();

    const prompt =
      "Subagent fanout synthesis check: delegate two bounded subagents sequentially, then report both results together.";
    const spawn = await expectStreamingResponses(server, {
      tools: [SESSIONS_SPAWN_TOOL],
      input: [makeUserInput(prompt)],
    });
    expect(await spawn.text()).toContain('\\"label\\":\\"qa-fanout-alpha\\"');

    const secondSpawn = await expectStreamingResponses(server, {
      tools: [SESSIONS_SPAWN_TOOL],
      input: [
        makeUserInput(prompt),
        makeToolOutput(
          '{"status":"accepted","childSessionKey":"agent:qa:subagent:alpha","note":"ALPHA-OK"}',
        ),
      ],
    });
    expect(await secondSpawn.text()).toContain('\\"label\\":\\"qa-fanout-beta\\"');

    const final = await expectNonStreamingResponses(server, {
      tools: [SESSIONS_SPAWN_TOOL],
      input: [
        makeUserInput(
          "Continue with the QA scenario plan and report grouped into Worked, Failed, Blocked, and Follow-up.",
        ),
        makeToolOutput('{"status":"accepted","childSessionKey":"agent:qa:subagent:beta"}'),
      ],
    });
    expect(outputText(await final.json())).toBe("subagent-1: ok\nsubagent-2: ok");
  });

  it("uses full request text when planning continuation subagent tool calls", async () => {
    const server = await startMockServer();

    const handoffPrompt =
      "Delegate one bounded QA task to a subagent. Wait for the subagent to finish.";
    const handoff = await expectStreamingResponses(server, {
      tools: [SESSIONS_SPAWN_TOOL],
      input: [makeUserInput(handoffPrompt), makeUserInput("Continue.")],
    });
    expect(await handoff.text()).toContain('"name":"sessions_spawn"');

    const handoffServer = await startMockServer();

    const appServerHandoff = await expectStreamingResponses(handoffServer, {
      tools: [CODEX_SUBAGENT_TOOL_NAMESPACE],
      input: [makeUserInput(handoffPrompt), makeUserInput("Continue.")],
    });
    expect(await appServerHandoff.text()).toContain('"name":"sessions_spawn"');

    const repeatedHandoff = await expectStreamingResponses(handoffServer, {
      tools: [CODEX_SUBAGENT_TOOL_NAMESPACE],
      input: [makeUserInput(handoffPrompt), makeUserInput("Continue again.")],
    });
    expect(await repeatedHandoff.text()).not.toContain('"name":"sessions_spawn"');

    const handoffFinal = await expectNonStreamingResponses(server, {
      tools: [SESSIONS_SPAWN_TOOL],
      input: [
        makeUserInput(handoffPrompt),
        makeToolOutput("SUBAGENT-OK"),
        makeUserInput("Continue."),
      ],
    });
    expect(outputText(await handoffFinal.json())).toContain("Delegated task");

    const fanoutPrompt =
      "Subagent fanout synthesis check: delegate two bounded subagents sequentially, then report both results together.";
    const appServerFanout = await expectStreamingResponses(server, {
      tools: [CODEX_SUBAGENT_TOOL_NAMESPACE],
      input: [makeUserInput(fanoutPrompt), makeUserInput("Continue.")],
    });
    expect(await appServerFanout.text()).toContain('\\"label\\":\\"qa-fanout-alpha\\"');

    const fanoutServer = await startMockServer();

    const firstFanout = await expectStreamingResponses(fanoutServer, {
      tools: [SESSIONS_SPAWN_TOOL],
      input: [makeUserInput(fanoutPrompt)],
    });
    expect(await firstFanout.text()).toContain('\\"label\\":\\"qa-fanout-alpha\\"');

    const secondFanout = await expectStreamingResponses(fanoutServer, {
      tools: [SESSIONS_SPAWN_TOOL],
      input: [
        makeUserInput(fanoutPrompt),
        makeToolOutput(
          '{"status":"accepted","childSessionKey":"agent:qa:subagent:alpha","note":"ALPHA-OK"}',
        ),
        makeUserInput("Continue."),
      ],
    });
    expect(await secondFanout.text()).toContain('\\"label\\":\\"qa-fanout-beta\\"');
  });

  it("does not delay native stop recovery follow-up prompts", async () => {
    const server = await startMockServer();
    const startedAt = Date.now();

    const response = await expectNonStreamingResponses(server, {
      input: [
        makeUserInput("Subagent recovery worker native command target proof. Wait until stopped."),
        makeUserInput("Reply exactly: QA-NATIVE-STOP-RECOVERY-OK"),
      ],
    });

    const payload = requireRecord(await response.json(), "native stop recovery response");
    expect(JSON.stringify(payload)).toContain("QA-NATIVE-STOP-RECOVERY-OK");
    expect(Date.now() - startedAt).toBeLessThan(10_000);
  });

  it("keeps source discovery reports out of subagent handoff prose", async () => {
    const server = await startMockServer();

    const response = await expectNonStreamingResponses(server, {
      input: [
        makeUserInput(
          "Read the seeded docs and source plan, then report grouped into Worked, Failed, Blocked, and Follow-up.",
        ),
        makeToolOutput(
          "repo/qa/scenarios/index.yaml includes scenario: subagent-handoff and repo/extensions/qa-lab/src/suite.ts.",
        ),
        makeUserInput("Continue."),
      ],
    });

    const text = outputText(await response.json());
    expect(text).toContain("Worked:");
    expect(text).toContain("repo/docs/help/testing.md");
    expect(text).toContain("Follow-up:");
    expect(text).not.toContain("Delegated task");
  });

  it("does not let fanout completion state hijack child worker replies", async () => {
    const server = await startMockServer();

    const prompt =
      "Subagent fanout synthesis check: delegate two bounded subagents sequentially, then report both results together.";
    const spawn = await expectStreamingResponses(server, {
      tools: [SESSIONS_SPAWN_TOOL],
      input: [makeUserInput(prompt)],
    });
    expect(await spawn.text()).toContain('\\"label\\":\\"qa-fanout-alpha\\"');

    const secondSpawn = await expectStreamingResponses(server, {
      tools: [SESSIONS_SPAWN_TOOL],
      input: [
        makeUserInput(prompt),
        makeToolOutput(
          '{"status":"accepted","childSessionKey":"agent:qa:subagent:alpha","note":"ALPHA-OK"}',
        ),
      ],
    });
    expect(await secondSpawn.text()).toContain('\\"label\\":\\"qa-fanout-beta\\"');

    const childReply = await expectNonStreamingResponses(server, {
      input: [
        makeUserInput(
          "Fanout worker alpha: inspect the QA workspace and finish with exactly ALPHA-OK.",
        ),
      ],
    });
    expect(outputText(await childReply.json())).toBe("ALPHA-OK");
  });

  it("keeps subagent fanout state isolated per mock server instance", async () => {
    const serverA = await startMockServer();
    const serverB = await startMockServer();

    const prompt =
      "Subagent fanout synthesis check: delegate two bounded subagents sequentially, then report both results together.";

    const firstA = await expectStreamingResponses(serverA, {
      tools: [SESSIONS_SPAWN_TOOL],
      input: [makeUserInput(prompt)],
    });
    expect(await firstA.text()).toContain('\\"label\\":\\"qa-fanout-alpha\\"');

    const firstB = await expectStreamingResponses(serverB, {
      tools: [SESSIONS_SPAWN_TOOL],
      input: [makeUserInput(prompt)],
    });
    expect(await firstB.text()).toContain('\\"label\\":\\"qa-fanout-alpha\\"');
  });

  it("isolates interleaved session state while preserving cross-provider ownership", async () => {
    const server = await startMockServer();
    const handoffPrompt =
      "Delegate one bounded QA task to a subagent. Wait for the subagent to finish.";
    const fanoutPrompt =
      "Subagent fanout synthesis check: delegate two bounded subagents sequentially, then report both results together.";
    const sessions = ["qa-session-alpha", "qa-session-beta"] as const;
    const runtimePrompt = (sessionId: string) =>
      `Runtime: agent=main | sessionId=${sessionId} | channel=qa`;
    const postSession = (sessionId: string, input: unknown[], cacheBoundary = 0) =>
      expectOpenAiNonStreamingResponsesJson(server, {
        prompt_cache_key: `${sessionId}:${cacheBoundary}`,
        tools: [SESSIONS_SPAWN_TOOL],
        input: [makeDeveloperInput(runtimePrompt(sessionId)), ...input],
      });

    const handoffs = await Promise.all(
      sessions.map((sessionId) => postSession(sessionId, [makeUserInput(handoffPrompt)])),
    );
    for (const handoff of handoffs) {
      expect(outputToolArgsFromItem(outputToolCall(handoff, "sessions_spawn"))).toMatchObject({
        label: "qa-sidecar",
      });
    }

    const crossProviderContinuation = await expectAnthropicMessages(server, {
      system: [{ type: "text", text: runtimePrompt(sessions[0]) }],
      tools: [{ name: "sessions_spawn", input_schema: { type: "object", properties: {} } }],
      messages: [makeAnthropicUserText(handoffPrompt)],
    });
    const continued = requireRecord(
      await crossProviderContinuation.json(),
      "cross-provider handoff continuation",
    );
    expect(continued.stop_reason).toBe("end_turn");

    const anthropicHandoff = await expectAnthropicMessages(server, {
      system: [{ type: "text", text: runtimePrompt("qa-session-anthropic") }],
      tools: [{ name: "sessions_spawn", input_schema: { type: "object", properties: {} } }],
      messages: [makeAnthropicUserText(handoffPrompt)],
    });
    expect(
      requireRecord(await anthropicHandoff.json(), "independent Anthropic handoff"),
    ).toMatchObject({ stop_reason: "tool_use" });

    const firstFanoutCalls = await Promise.all(
      sessions.map((sessionId) => postSession(sessionId, [makeUserInput(fanoutPrompt)], 1)),
    );
    for (const fanout of firstFanoutCalls) {
      expect(outputToolArgsFromItem(outputToolCall(fanout, "sessions_spawn"))).toMatchObject({
        label: "qa-fanout-alpha",
      });
    }

    const secondFanoutCalls = await Promise.all(
      sessions.map((sessionId) =>
        postSession(
          sessionId,
          [
            makeUserInput(fanoutPrompt),
            makeToolOutput('{"status":"accepted","childSessionKey":"alpha","note":"ALPHA-OK"}'),
          ],
          2,
        ),
      ),
    );
    for (const fanout of secondFanoutCalls) {
      expect(outputToolArgsFromItem(outputToolCall(fanout, "sessions_spawn"))).toMatchObject({
        label: "qa-fanout-beta",
      });
    }
  });

  it.each([
    {
      name: "legacy workspace heartbeat",
      prompt:
        "System: Gateway restart config-apply ok\nSystem: QA-SUBAGENT-RECOVERY-1234\n\nRead HEARTBEAT.md if it exists (workspace context). Follow it strictly. Do not infer or repeat old tasks from prior chats. If nothing needs attention, reply HEARTBEAT_OK.",
      reply: "HEARTBEAT_OK",
    },
    {
      name: "automation heartbeat",
      prompt:
        "System: Gateway restart config-apply ok\n\nFollow the heartbeat monitor scratch context when provided. If nothing needs attention, reply NO_REPLY.",
      reply: "NO_REPLY",
    },
  ])("answers $name prompts without spawning extra subagents", async ({ prompt, reply }) => {
    const server = await startMockServer();

    const response = await expectNonStreamingResponses(server, {
      input: [makeUserInput(prompt)],
    });

    expect(outputText(await response.json())).toBe(reply);
  });

  it("returns exact markers for visible and hot-installed skills", async () => {
    const server = await startMockServer();

    const visible = await expectNonStreamingResponses(server, {
      input: [makeUserInput("Visible skill marker: give me the visible skill marker exactly.")],
    });
    expect(outputText(await visible.json())).toBe("VISIBLE-SKILL-OK");

    const hot = await expectNonStreamingResponses(server, {
      input: [makeUserInput("Hot install marker: give me the hot install marker exactly.")],
    });
    expect(outputText(await hot.json())).toBe("HOT-INSTALL-OK");
  });

  it("uses the latest exact marker directive from conversation history", async () => {
    const server = await startMockServer();

    const response = await expectNonStreamingResponses(server, {
      input: [
        makeUserInput("Earlier turn: reply with only this exact marker: OLD_TOKEN"),
        makeUserInput("Current turn: reply with only this exact marker: NEW_TOKEN"),
      ],
    });

    expect(outputText(await response.json())).toBe("NEW_TOKEN");
  });

  it("requires both WhatsApp batched markers before returning the final batched marker", async () => {
    const server = await startMockServer();

    const standalone = await expectNonStreamingResponses(server, {
      input: [
        makeUserInput(
          "Second batched WhatsApp QA message. Reply with only this exact marker: " +
            "WHATSAPP_QA_BATCHED_FINAL_TEST only if the previous queued message is visible " +
            "in this same run context.",
        ),
      ],
    });
    expect(outputText(await standalone.json())).toBe("WHATSAPP_QA_BATCHED_MISSING_CONTEXT_TEST");

    const batched = await expectNonStreamingResponses(server, {
      input: [
        makeUserInput(
          "First batched WhatsApp QA message WHATSAPP_QA_BATCHED_FIRST_TEST. " +
            "Wait for the next message before replying.",
        ),
        makeUserInput(
          "Second batched WhatsApp QA message. Reply with only this exact marker: " +
            "WHATSAPP_QA_BATCHED_FINAL_TEST only if the previous queued message is visible " +
            "in this same run context.",
        ),
      ],
    });
    expect(outputText(await batched.json())).toBe("WHATSAPP_QA_BATCHED_FINAL_TEST");
  });

  it("lets the latest exact marker prompt beat stale Telegram session_status history", async () => {
    const server = await startMockServer();

    const response = await expectNonStreamingResponses(server, {
      input: [
        makeUserInput(
          "Telegram current session_status QA check. Call session_status with sessionKey set to current.",
        ),
        makeUserInput("Telegram reply-chain marker QA. Reply exactly: QA-TELEGRAM-REPLY-CHAIN-OK"),
      ],
    });

    expect(outputText(await response.json())).toBe("QA-TELEGRAM-REPLY-CHAIN-OK");
  });

  it("does not repeat stale Telegram session_status for later ordinary prompts", async () => {
    const server = await startMockServer();

    const response = await expectNonStreamingResponses(server, {
      input: [
        makeUserInput(
          "Telegram current session_status QA check. Call session_status with sessionKey set to current.",
        ),
        makeUserInput(
          "@sut Telegram QA mention routing check. Reply with a short acknowledgement.",
        ),
      ],
    });

    const payload = await response.json();
    expect(JSON.stringify(payload)).not.toContain("QA-TELEGRAM-CURRENT-SESSION");
  });

  it("uses exact marker directives from request context when the latest user text is generic", async () => {
    const server = await startMockServer();

    const response = await expectNonStreamingResponses(server, {
      input: [
        makeUserInput("@qa-sut.example.test reply with only this exact marker: QA_CANARY_TEST"),
        makeUserInput(
          "Continue with the QA scenario plan and report worked, failed, and blocked items.",
        ),
      ],
    });

    expect(outputText(await response.json())).toBe("QA_CANARY_TEST");
  });

  it("prefers Matrix exact marker prompts over quoted silent-reply guidance", async () => {
    const server = await startMockServer();

    const response = await expectNonStreamingResponses(server, {
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

    expect(outputText(await response.json())).toBe("MATRIX_QA_CANARY_14C3958A");
  });

  it("lets current exact replies beat stale exact marker history", async () => {
    const server = await startMockServer();

    const response = await expectNonStreamingResponses(server, {
      input: [
        makeUserInput("Earlier turn: reply with only this exact marker: STALE_MARKER"),
        makeUserInput("Reply exactly: CURRENT_REPLY"),
      ],
    });

    expect(outputText(await response.json())).toBe("CURRENT_REPLY");
  });

  it("uses the previous user instruction when the tail user item is runtime context", async () => {
    const server = await startMockServer();

    const response = await expectNonStreamingResponses(server, {
      input: [
        makeUserInput("Reply exactly: QA_RUNTIME_CONTEXT_CARRIER_OK"),
        makeUserInput(TEST_RUNTIME_CONTEXT_CARRIER),
      ],
    });

    expect(outputText(await response.json())).toBe("QA_RUNTIME_CONTEXT_CARRIER_OK");
  });

  it("uses WhatsApp location markers only for the matching coordinate body", async () => {
    const server = await startMockServer();
    const setupInput = makeUserInput(
      "When a later WhatsApp location message shows 37.774900, -122.419400, " +
        "reply with only this WhatsApp location marker: QA_WHATSAPP_LOCATION_OK. " +
        "Reply with only this exact marker: QA_INITIAL_OK",
    );

    const setupResponse = await readMockResponse(server, [setupInput]);
    const response = await readMockResponse(server, [
      setupInput,
      makeUserInput("  📍 37.774900, -122.419400"),
    ]);

    expect(outputText(await setupResponse.json())).toBe("QA_INITIAL_OK");
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

    const setupResponse = await readMockResponse(server, [setupInput]);
    const contactResponse = await readMockResponse(server, [
      setupInput,
      makeUserInput("  <contact>"),
    ]);
    const stickerResponse = await readMockResponse(server, [
      setupInput,
      makeWhatsAppStructuredUserInput("", "sticker"),
    ]);
    const webpImageInput = {
      role: "user" as const,
      content: [
        { type: "input_text" as const, text: "" },
        { type: "input_image" as const, image_url: "data:image/webp;base64,AA==" },
      ],
    };
    const webpImageResponse = await postNonStreamingResponses(server, {
      input: [setupInput, webpImageInput],
    });

    expect(outputText(await setupResponse.json())).toBe("QA_STRUCTURED_INITIAL_OK");
    expect(outputText(await contactResponse.json())).toBe("QA_WHATSAPP_CONTACT_OK");
    expect(outputText(await stickerResponse.json())).toBe("QA_WHATSAPP_STICKER_OK");
    expect(outputText(await webpImageResponse.json())).not.toBe("QA_WHATSAPP_STICKER_OK");
  });

  it("uses WhatsApp structured markers for metadata-prefixed message bodies", async () => {
    const server = await startMockServer();
    const setupInput = WHATSAPP_STRUCTURED_SETUP_INPUT;
    const previousExactMarkerInput = makeUserInput(
      "Reply with only this previous unrelated exact marker: QA_WHATSAPP_PREVIOUS_OK",
    );

    const contextPrefix = [
      "Conversation info: ⟦openclaw:ctx⟧",
      "```json",
      '{"inbound_event_kind":"user_request"}',
      "```",
      "",
    ];
    const locationResponse = await readMockResponse(server, [
      setupInput,
      previousExactMarkerInput,
      makeUserInput([...contextPrefix, "📍 37.774900, -122.419400"].join("\n")),
    ]);
    const contactResponse = await readMockResponse(server, [
      setupInput,
      previousExactMarkerInput,
      makeUserInput(
        ["Sender: ⟦openclaw:ctx⟧", "```json", '{"name":"QA"}', "```", "", "<contact>"].join("\n"),
      ),
    ]);
    const stickerResponse = await readMockResponse(server, [
      setupInput,
      previousExactMarkerInput,
      makeWhatsAppStructuredUserInput([...contextPrefix, ""].join("\n"), "sticker"),
    ]);

    expect(outputText(await locationResponse.json())).toBe("QA_WHATSAPP_LOCATION_OK");
    expect(outputText(await contactResponse.json())).toBe("QA_WHATSAPP_CONTACT_OK");
    expect(outputText(await stickerResponse.json())).toBe("QA_WHATSAPP_STICKER_OK");
  });

  it("detects each WhatsApp structured body after a channel envelope", async () => {
    const server = await startMockServer();
    const setupInput = WHATSAPP_STRUCTURED_SETUP_INPUT;

    for (const structuredCase of WHATSAPP_STRUCTURED_CASES) {
      const response = await readMockResponse(server, [
        setupInput,
        makeUserInput("Reply with only this previous document marker: QA_WHATSAPP_DOCUMENT_OK"),
        makeWhatsAppStructuredUserInput(
          `[WhatsApp +15555550123] +15555550123: ${structuredCase.body}`,
          "mediaKind" in structuredCase ? structuredCase.mediaKind : undefined,
        ),
      ]);

      expect(outputText(await response.json())).toBe(structuredCase.expected);
    }
  });

  it("detects each WhatsApp structured body after combined timestamp and channel prefixes", async () => {
    const server = await startMockServer();
    const setupInput = WHATSAPP_STRUCTURED_SETUP_INPUT;

    for (const structuredCase of WHATSAPP_STRUCTURED_CASES) {
      const response = await readMockResponse(server, [
        setupInput,
        makeWhatsAppStructuredUserInput(
          `[Tue 2026-07-14 18:17 GMT+5:30] [WhatsApp +15555550123] +15555550123: ${structuredCase.body}`,
          "mediaKind" in structuredCase ? structuredCase.mediaKind : undefined,
        ),
      ]);

      expect(outputText(await response.json())).toBe(structuredCase.expected);
    }
  });

  it("detects each WhatsApp structured body after canonical timestamp prefixes", async () => {
    const server = await startMockServer();
    const setupInput = WHATSAPP_STRUCTURED_SETUP_INPUT;
    const timestampPrefixes = [
      "[Tue 2026-07-14 12:47 UTC]",
      "[Tue 2026-07-14 07:47 EST]",
      "[Tue 2026-07-14 09:47 GMT-3]",
      "[Tue 2026-07-14 14:47 GMT+2]",
      "[Tue 2026-07-14 09:17 GMT-3:30]",
      "[Tue 2026-07-14 18:17 GMT+5:30]",
    ];

    for (const prefix of timestampPrefixes) {
      for (const structuredCase of WHATSAPP_STRUCTURED_CASES) {
        const response = await readMockResponse(server, [
          setupInput,
          makeWhatsAppStructuredUserInput(
            `${prefix} ${structuredCase.body}`,
            "mediaKind" in structuredCase ? structuredCase.mediaKind : undefined,
          ),
        ]);

        expect(outputText(await response.json())).toBe(structuredCase.expected);
      }
    }
  });

  it("uses the latest WhatsApp structured body when history contains another kind", async () => {
    const server = await startMockServer();
    const setupInput = makeUserInput(
      "When a later WhatsApp location message shows 37.774900, -122.419400, " +
        "reply with only this WhatsApp location marker: QA_WHATSAPP_LOCATION_OK. " +
        "When a later WhatsApp contact message appears, " +
        "reply with only this WhatsApp contact marker: QA_WHATSAPP_CONTACT_OK. " +
        "Reply with only this exact marker: QA_STRUCTURED_INITIAL_OK",
    );
    const response = await readMockResponse(server, [
      setupInput,
      makeUserInput("[WhatsApp +15555550123] +15555550123: 📍 37.774900, -122.419400"),
      makeUserInput("[WhatsApp +15555550123] +15555550123: <contact>"),
    ]);

    expect(outputText(await response.json())).toBe("QA_WHATSAPP_CONTACT_OK");
  });

  it("does not treat structured WhatsApp tokens in ordinary prose as message bodies", async () => {
    const server = await startMockServer();
    const setupInput = WHATSAPP_STRUCTURED_SETUP_INPUT;
    const proseInputs = [
      "Please compare [Tue 2026-07-14 12:47 UTC] 📍 37.774900, -122.419400 and explain [that] <contact> and <media:sticker> text",
      "[Tue 2026-07-14 12:47 UTC] Contact note: <contact> is descriptive prose",
      [
        "Coordinate note: 📍 37.774900, -122.419400",
        "Contact note: <contact>",
        "Sticker note: <media:sticker>",
      ].join("\n"),
      [
        "WhatsApp media: ⟦openclaw:ctx⟧",
        "```json",
        '{"source":"whatsapp","type":"media","payload":{"kind":"image"}}',
        "```",
        '{"payload":{"kind":"sticker"}} is ordinary message text',
      ].join("\n"),
    ];

    for (const proseInput of proseInputs) {
      const response = await readMockResponse(server, [setupInput, makeUserInput(proseInput)]);
      const text = outputText(await response.json());
      expect(text).not.toBe("QA_WHATSAPP_LOCATION_OK");
      expect(text).not.toBe("QA_WHATSAPP_CONTACT_OK");
      expect(text).not.toBe("QA_WHATSAPP_STICKER_OK");
    }
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
    const server = await startMockServer();

    const channelPrompt =
      '@qa-sut.example.test /tool image_generate action=generate prompt="QA lighthouse image for Matrix delivery testing" size=1024x1024 count=1';
    const genericPrompt =
      "Continue with the QA scenario plan and report worked, failed, and blocked items.";

    const toolPlan = await expectNonStreamingResponses(server, {
      tools: [IMAGE_GENERATE_TOOL],
      input: [makeUserInput(channelPrompt), makeUserInput(genericPrompt)],
    });

    const toolPlanOutput = outputItem(await toolPlan.json());
    expect(toolPlanOutput.type).toBe("function_call");
    expect(toolPlanOutput.name).toBe("image_generate");
    expect(String(toolPlanOutput.arguments)).toContain("qa-lighthouse.png");

    const toolResult = await expectNonStreamingResponses(server, {
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
        makeToolOutputWithCallId(
          "call_mock_image_generate_1",
          JSON.stringify({
            details: { media: { mediaUrls: ["/tmp/qa-lighthouse.png"] } },
          }),
        ),
      ],
    });

    expect(outputText(await toolResult.json())).toContain("Attachment: /tmp/qa-lighthouse.png");
  });

  it("completes an image without replaying a tool unavailable to the completion turn", async () => {
    const server = await startMockServer();
    const prompt = "Image generation check: generate a QA lighthouse image.";
    const imagePlan = await expectNonStreamingResponsesJson<unknown>(server, {
      tools: [IMAGE_GENERATE_TOOL],
      input: [makeUserInput(prompt)],
    });
    const imageCall = outputToolCall(imagePlan, "image_generate");
    const callId = outputToolCallId(imageCall, "call_mock_image_generate_unavailable");
    const completionEvent = [
      "<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>",
      "OpenClaw runtime context (internal):",
      "",
      "[Internal task completion event]",
      "source: image_generation",
      "task: A QA lighthouse on a dark sea with a tiny protocol droid silhouette.",
      "status: completed successfully",
      "Generated media:",
      "MEDIA:/tmp/qa-lighthouse.png",
      "<<<END_OPENCLAW_INTERNAL_CONTEXT>>>",
    ].join("\n");
    const completion = await expectNonStreamingResponsesJson<unknown>(server, {
      tools: [MESSAGE_TOOL],
      input: [
        makeUserInput(prompt),
        {
          type: "function_call",
          name: "image_generate",
          call_id: callId,
          arguments: String(imageCall.arguments),
        },
        makeToolOutputWithCallId(
          callId,
          JSON.stringify({
            content: [{ type: "text", text: "Background image generation started." }],
            details: { async: true, status: "started" },
          }),
        ),
        makeUserInput(completionEvent),
      ],
    });

    expect(
      outputItems(completion).some(
        (item) => item.type === "function_call" && item.name === "image_generate",
      ),
    ).toBe(false);
    expect(outputText(completion)).toBe(
      "Protocol note: generated the QA lighthouse image successfully.\nMEDIA:/tmp/qa-lighthouse.png",
    );
  });

  it("does not replay a historical image completion on a new marker turn", async () => {
    const server = await startMockServer();
    const completion = await expectNonStreamingResponsesJson<unknown>(server, {
      tools: [MESSAGE_TOOL],
      input: [
        makeUserInput(
          [
            "[Internal task completion event]",
            "source: image_generation",
            "status: completed successfully",
            "MEDIA:/tmp/qa-lighthouse.png",
          ].join("\n"),
        ),
        {
          role: "assistant",
          content: [{ type: "output_text", text: "MEDIA:/tmp/qa-lighthouse.png" }],
        },
        makeUserInput("Marker exact marker: `fresh-image-completion-marker`"),
      ],
    });

    expect(outputText(completion)).toBe("fresh-image-completion-marker");
  });

  it("plans QA tool-search calls for instruction-declared Codex dynamic tools", async () => {
    const server = await startMockServer();

    const response = await expectNonStreamingResponses(server, {
      instructions: "Codex dynamic OpenClaw tools available in this turn: web_search.",
      input: [
        makeUserInput(
          "tool search qa check target=web_search. Call exactly that tool once and then summarize.",
        ),
      ],
    });

    const toolPlanOutput = outputItem(await response.json());
    expect(toolPlanOutput.type).toBe("function_call");
    expect(toolPlanOutput.name).toBe("web_search");
    expect(String(toolPlanOutput.arguments)).toContain("OpenClaw runtime parity fixed query");
  });

  it("plans QA tool-search calls from explicit fixture targets even without Responses tools", async () => {
    const server = await startMockServer();

    const response = await expectNonStreamingResponses(server, {
      input: [
        makeUserInput(
          "tool search qa check target=session_status. Call exactly that tool once and then summarize.",
        ),
      ],
    });

    const toolPlanOutput = outputItem(await response.json());
    expect(toolPlanOutput.type).toBe("function_call");
    expect(toolPlanOutput.name).toBe("session_status");
    expect(String(toolPlanOutput.arguments)).toContain("current");
  });

  it("plans one structured batch search for the Tool Search gateway fixture", async () => {
    const server = await startMockServer();
    const targetTool = "fake_plugin_tool_17";

    const response = await expectNonStreamingResponses(server, {
      tools: [{ type: "function", name: "tool_search" }],
      input: [
        makeUserInput(
          `tool search qa check target=${targetTool}. Call exactly that tool once and then summarize.`,
        ),
      ],
    });

    const toolPlanOutput = outputItem(await response.json());
    expect(toolPlanOutput.type).toBe("function_call");
    expect(toolPlanOutput.name).toBe("tool_search");
    expect(JSON.parse(String(toolPlanOutput.arguments))).toEqual({
      queries: [
        { query: targetTool, limit: 1 },
        { query: QA_TOOL_SEARCH_SECONDARY_TARGET, limit: 1 },
      ],
    });
  });

  it("prefers a directly declared target over structured catalog search", async () => {
    const server = await startMockServer();
    const targetTool = "web_fetch";

    const response = await expectNonStreamingResponses(server, {
      tools: [
        { type: "function", name: "tool_search" },
        { type: "function", name: targetTool },
      ],
      input: [
        makeUserInput(
          `tool search qa check target=${targetTool}. Call exactly that tool once and then summarize.`,
        ),
      ],
    });

    const toolPlanOutput = outputItem(await response.json());
    expect(toolPlanOutput.name).toBe(targetTool);
    expect(JSON.parse(String(toolPlanOutput.arguments))).toEqual({
      url: "https://example.com/",
      maxChars: 500,
    });
  });

  it("calls the selected catalog tool after a structured batch search", async () => {
    const server = await startMockServer();
    const targetTool = "fake_plugin_tool_17";

    const response = await expectNonStreamingResponses(server, {
      tools: [
        { type: "function", name: "tool_search" },
        { type: "function", name: "tool_call" },
      ],
      input: [
        makeUserInput(
          `tool search qa check target=${targetTool}. Call exactly that tool once and then summarize.`,
        ),
        {
          type: "function_call",
          call_id: "call_tool_search_1",
          name: "tool_search",
          arguments: JSON.stringify({
            queries: [
              { query: targetTool, limit: 1 },
              { query: QA_TOOL_SEARCH_SECONDARY_TARGET, limit: 1 },
            ],
          }),
        },
        makeToolOutputWithCallId(
          "call_tool_search_1",
          JSON.stringify({
            results: [
              { query: targetTool, candidates: [{ name: targetTool }] },
              {
                query: QA_TOOL_SEARCH_SECONDARY_TARGET,
                candidates: [{ name: QA_TOOL_SEARCH_SECONDARY_TARGET }],
              },
            ],
          }),
        ),
      ],
    });

    const toolPlanOutput = outputItem(await response.json());
    expect(toolPlanOutput.type).toBe("function_call");
    expect(toolPlanOutput.name).toBe("tool_call");
    expect(JSON.parse(String(toolPlanOutput.arguments))).toMatchObject({ id: targetTool });
  });

  it("does not call a catalog tool when structured search returns no matching candidate", async () => {
    const server = await startMockServer();
    const targetTool = "fake_plugin_tool_17";

    const response = await expectNonStreamingResponses(server, {
      tools: [
        { type: "function", name: "tool_search" },
        { type: "function", name: "tool_call" },
      ],
      input: [
        makeUserInput(
          `tool search qa check target=${targetTool}. Call exactly that tool once and then summarize.`,
        ),
        {
          type: "function_call",
          call_id: "call_tool_search_1",
          name: "tool_search",
          arguments: JSON.stringify({ queries: [{ query: targetTool, limit: 1 }] }),
        },
        makeToolOutputWithCallId(
          "call_tool_search_1",
          JSON.stringify({ results: [{ query: targetTool, candidates: [] }] }),
        ),
      ],
    });

    expect(outputItem(await response.json()).name).not.toBe("tool_call");
  });

  it("does not repeat a catalog call after its result mentions the target", async () => {
    const server = await startMockServer();
    const targetTool = "fake_plugin_tool_17";

    const response = await expectNonStreamingResponses(server, {
      tools: [{ type: "function", name: "tool_call" }],
      input: [
        makeUserInput(
          `tool search qa check target=${targetTool}. Call exactly that tool once and then summarize.`,
        ),
        {
          type: "function_call",
          call_id: "call_target_1",
          name: "tool_call",
          arguments: JSON.stringify({ id: targetTool, args: {} }),
        },
        makeToolOutputWithCallId("call_target_1", `failed to call ${targetTool}`),
      ],
    });

    expect(outputItem(await response.json()).name).not.toBe("tool_call");
  });

  it("plans the explicit web_fetch fixture prompt as the canonical direct call", async () => {
    const server = await startMockServer();
    const prompt =
      "Call web_fetch exactly once with URL https://example.com/ and maxChars 500, wait for its result, then summarize. If web_fetch is already callable, call it directly without tool_search. Otherwise use tool_search to locate it first, then call web_fetch. A tool_search result alone does not complete the task; do not finish before web_fetch returns. QA routing marker: tool search qa check target=web_fetch.";

    const response = await expectNonStreamingResponses(server, {
      input: [makeUserInput(prompt)],
    });

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

    const response = await expectNonStreamingResponses(server, {
      input: [
        makeUserInput(
          `tool search qa check target=${targetTool}. Call exactly that tool once and then summarize.`,
        ),
        makeToolOutputWithCallId(
          "call_tool_search_code_1",
          JSON.stringify({
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
        ),
      ],
    });

    expect(outputText(await response.json())).toBe(`FAKE_PLUGIN_OK ${targetTool}`);
  });

  it("keeps QA tool-search result summaries ahead of generic worked/failed/blocked summaries", async () => {
    const server = await startMockServer();
    const targetTool = "fake_plugin_tool_17";

    const response = await expectNonStreamingResponses(server, {
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
        makeToolOutputWithCallId(
          "call_tool_search_code_1",
          JSON.stringify({
            ok: true,
            value: {
              tool: { name: targetTool },
              result: {
                content: [{ type: "text", text: `FAKE_PLUGIN_OK ${targetTool}` }],
              },
            },
          }),
        ),
      ],
    });

    expect(outputText(await response.json())).toBe(`FAKE_PLUGIN_OK ${targetTool}`);
  });

  it("derives ask_user QA summaries from the returned answers", async () => {
    const server = await startMockServer();
    const response = await expectNonStreamingResponses(server, {
      input: [
        {
          role: "system",
          content: [
            {
              type: "input_text",
              text: "Nothing to say: entire reply exactly NO_REPLY",
            },
          ],
        },
        makeUserInput(
          "QA routing marker: tool search qa check target=ask_user. Ask structured questions, then summarize their actual answers.",
        ),
        makeToolOutputWithCallId(
          "call_ask_user_1",
          JSON.stringify({
            content: [
              {
                type: "text",
                text: 'Deploy: Canary\nChecks: Lint, Unit (Recommended)\nNote: weekend-only\n\n{"status":"answered"}',
              },
            ],
          }),
        ),
      ],
    });

    expect(outputText(await response.json())).toBe(
      "ASK-USER-ROUNDTRIP-OK | deploy=Canary | checks=Lint,Unit | note=weekend-only",
    );
  });

  it.each([
    {
      fixture: "single",
      expectedQuestionId: "deploy_target",
      expectedMultiSelect: undefined,
    },
    { fixture: "multi", expectedQuestionId: "checks", expectedMultiSelect: true },
  ])("plans the $fixture ask_user Telegram fixture", async (entry) => {
    const server = await startMockServer();
    const response = await expectNonStreamingResponses(server, {
      input: [
        makeUserInput(
          `tool search qa check target=ask_user ask_user_fixture=${entry.fixture}. Ask the question.`,
        ),
      ],
    });

    const call = outputItem(await response.json());
    const args = JSON.parse(String(call.arguments)) as {
      questions?: Array<{ id?: string; multiSelect?: boolean }>;
    };
    expect(call.name).toBe("ask_user");
    expect(args.questions).toHaveLength(1);
    expect(args.questions?.[0]).toMatchObject({
      id: entry.expectedQuestionId,
      ...(entry.expectedMultiSelect ? { multiSelect: true } : {}),
    });
  });

  it("plans QA tool-search failure calls with denied-input args", async () => {
    const server = await startMockServer();

    const response = await expectNonStreamingResponses(server, {
      input: [
        makeUserInput(
          "tool search qa failure target=web_search. Exercise the denied-input path once and then summarize.",
        ),
      ],
    });

    const toolPlanOutput = outputItem(await response.json());
    expect(toolPlanOutput.type).toBe("function_call");
    expect(toolPlanOutput.name).toBe("web_search");
    expect(String(toolPlanOutput.arguments)).toContain("OPENCLAW_QA_WEB_SEARCH_DENIED_INPUT");
  });

  it.each([
    {
      label: "workspace-local happy",
      prompt:
        "tool search qa check target=apply_patch. Call apply_patch exactly once and then summarize.",
      operation: "Add File",
      patchPath: "runtime-tool-fixture-patch.txt",
    },
    {
      label: "workspace-escaping failure",
      prompt:
        "tool search qa failure target=apply_patch. Exercise the denied-input path once and then summarize.",
      operation: "Update File",
      patchPath: "../runtime-tool-fixture-denied.txt",
    },
  ])("plans a valid $label apply_patch envelope", async ({ prompt, operation, patchPath }) => {
    const server = await startMockServer();
    const response = await expectNonStreamingResponses(server, {
      input: [makeUserInput(prompt)],
    });

    const payload = await response.json();
    const item = outputItem(payload);
    expect(item).toMatchObject({ type: "function_call", name: "apply_patch" });
    const args = outputToolArgs(payload);
    expect(args).not.toHaveProperty("__qaFailureMode");
    expect(args.input).toBeTypeOf("string");
    expect(args.input).toContain("*** Begin Patch\n");
    expect(args.input).toContain(`*** ${operation}: ${patchPath}\n`);
    if (operation === "Update File") {
      expect(args.input).toContain("\n@@\n-runtime-tool-fixture-denied-original\n");
    }
    expect(args.input).toContain("\n*** End Patch\n");
    const debug = requireRecord(await getJson(server, "/debug/last-request"), "function plan");
    expect(debug.plannedToolCallId).toBe(item.call_id);
    expect(debug.plannedToolItemId).toBe(item.id);
  });

  it.each([
    {
      label: "workspace-local happy",
      prompt:
        "tool search qa check target=apply_patch. Call apply_patch exactly once and then summarize.",
      operation: "Add File",
      patchPath: "runtime-tool-fixture-patch.txt",
    },
    {
      label: "workspace-escaping failure",
      prompt:
        "tool search qa failure target=apply_patch. Exercise the denied-input path once and then summarize.",
      operation: "Update File",
      patchPath: "../runtime-tool-fixture-denied.txt",
    },
  ])("plans an actual $label native freeform patch", async (testCase) => {
    const server = await startMockServer();
    const response = await expectNonStreamingResponses(server, {
      tools: [CODEX_CUSTOM_PATCH_TOOL],
      input: [makeUserInput(testCase.prompt)],
    });

    const item = outputItem(await response.json());
    expect(item).toMatchObject({ type: "custom_tool_call", name: "apply_patch" });
    expect(item).not.toHaveProperty("arguments");
    expect(item.input).toEqual(
      expect.stringContaining(`*** ${testCase.operation}: ${testCase.patchPath}\n`),
    );
    if (testCase.operation === "Update File") {
      expect(item.input).toEqual(
        expect.stringContaining("\n@@\n-runtime-tool-fixture-denied-original\n"),
      );
    }

    const debug = requireRecord(
      await getJson(server, "/debug/last-request"),
      "native patch plan debug request",
    );
    expect(debug.plannedToolName).toBe("apply_patch");
    expect(debug.plannedToolCallId).toBe(item.call_id);
    expect(debug.plannedToolItemId).toBe(item.id);
    expect(debug.plannedToolArgs).toEqual({ input: item.input });
  });

  it.each([
    {
      label: "namespaced tools",
      declarations: { tools: [CODEX_CUSTOM_PATCH_NAMESPACE] },
      additionalTools: undefined,
    },
    {
      label: "namespaced dynamic tools",
      declarations: { dynamicTools: [CODEX_CUSTOM_PATCH_NAMESPACE] },
      additionalTools: undefined,
    },
    {
      label: "developer additional tools",
      declarations: {},
      additionalTools: [CODEX_CUSTOM_PATCH_NAMESPACE],
    },
    {
      label: "direct custom tools before tool search",
      declarations: {
        tools: [{ type: "function", name: "tool_search_code" }, CODEX_CUSTOM_PATCH_NAMESPACE],
      },
      additionalTools: undefined,
    },
  ])("preserves custom-tool identity through $label", async ({ declarations, additionalTools }) => {
    const server = await startMockServer();
    const input: Array<Record<string, unknown>> = [];
    if (additionalTools) {
      input.push({ type: "additional_tools", role: "developer", tools: additionalTools });
    }
    input.push(
      makeUserInput(
        "tool search qa check target=apply_patch. Call apply_patch exactly once and then summarize.",
      ),
    );

    const response = await expectNonStreamingResponses(server, { ...declarations, input });

    expect(outputItem(await response.json())).toMatchObject({
      type: "custom_tool_call",
      name: "apply_patch",
      namespace: "openclaw_direct",
    });
  });

  it.each([
    { label: "flat", tools: [CODEX_CUSTOM_PATCH_TOOL], namespace: undefined },
    {
      label: "namespaced",
      tools: [CODEX_CUSTOM_PATCH_NAMESPACE],
      namespace: "openclaw_direct",
    },
  ])("streams $label native Codex patch input as custom-tool SSE", async ({ tools, namespace }) => {
    const server = await startMockServer();
    const response = await expectStreamingResponses(server, {
      tools,
      input: [
        makeUserInput(
          "tool search qa check target=apply_patch. Call apply_patch exactly once and then summarize.",
        ),
      ],
    });

    const body = await response.text();
    const events = body
      .split("\n")
      .filter((line) => line.startsWith("data: {"))
      .map(
        (line) =>
          JSON.parse(line.slice("data: ".length)) as {
            type: string;
            response?: { id?: string; output?: Array<Record<string, unknown>> };
            item?: Record<string, unknown>;
            item_id?: string;
            call_id?: string;
            delta?: string;
          },
      );
    expect(events.map((event) => event.type)).toEqual([
      "response.created",
      "response.output_item.added",
      "response.custom_tool_call_input.delta",
      "response.output_item.done",
      "response.completed",
    ]);
    const [created, added, delta, done, completed] = events;
    expect(created?.response?.id).toBe(completed?.response?.id);
    expect(added?.item).toMatchObject({
      type: "custom_tool_call",
      name: "apply_patch",
      input: "",
      status: "in_progress",
    });
    expect(done?.item).toMatchObject({
      type: "custom_tool_call",
      name: "apply_patch",
      status: "completed",
    });
    expect(done?.item?.id).toEqual(expect.stringMatching(/^ctc_mock_apply_patch_/));
    expect(delta?.item_id).toBe(done?.item?.id);
    expect(delta?.call_id).toBe(done?.item?.call_id);
    expect(delta?.delta).toBe(done?.item?.input);
    expect(delta?.delta).toContain("runtime-tool-fixture-patch.txt");
    expect(completed?.response?.output).toEqual([done?.item]);
    for (const item of [added?.item, done?.item, completed?.response?.output?.[0]]) {
      if (namespace) {
        expect(item).toMatchObject({ namespace });
      } else {
        expect(item).not.toHaveProperty("namespace");
      }
    }
  });

  it("preserves namespaced native custom-tool identity over Responses WebSocket", async () => {
    const server = await startMockServer();
    const socket = new WebSocket(`${server.baseUrl.replace(/^http/u, "ws")}/v1/responses`);
    cleanups.push(async () => socket.terminate());
    await once(socket, "open");

    const completed = new Promise<Array<Record<string, unknown>>>((resolve, reject) => {
      const events: Array<Record<string, unknown>> = [];
      socket.on("error", reject);
      socket.on("message", (message) => {
        const event = JSON.parse(Buffer.from(message as Buffer).toString("utf8")) as Record<
          string,
          unknown
        >;
        events.push(event);
        if (event.type === "response.completed") {
          resolve(events);
        }
      });
    });
    socket.send(
      JSON.stringify({
        type: "response.create",
        tools: [CODEX_CUSTOM_PATCH_NAMESPACE],
        input: [
          makeUserInput(
            "tool search qa check target=apply_patch. Call apply_patch exactly once and then summarize.",
          ),
        ],
      }),
    );

    const events = await completed;
    const added = requireRecord(
      events.find((event) => event.type === "response.output_item.added")?.item,
      "WebSocket custom-tool added item",
    );
    const done = requireRecord(
      events.find((event) => event.type === "response.output_item.done")?.item,
      "WebSocket custom-tool completed item",
    );
    const response = requireRecord(
      events.find((event) => event.type === "response.completed")?.response,
      "WebSocket completed response",
    );
    for (const item of [added, done, outputItem(response)]) {
      expect(item).toMatchObject({
        type: "custom_tool_call",
        name: "apply_patch",
        namespace: "openclaw_direct",
      });
    }
  });

  it.each([
    {
      label: "successful native patch",
      prompt:
        "tool search qa check target=apply_patch. Call apply_patch exactly once and then summarize.",
      output: "Successfully applied patch",
      expectedOutput: "Successfully applied patch",
      structuredError: false,
    },
    {
      label: "denied native patch",
      prompt:
        "tool search qa failure target=apply_patch. Exercise the denied-input path once and then summarize.",
      output: "Error: Path escapes sandbox root",
      expectedOutput: "Error: Path escapes sandbox root",
      structuredError: true,
    },
    {
      label: "upstream Codex native patch rejection without a wire error flag",
      prompt:
        "tool search qa failure target=apply_patch. Exercise the denied-input path once and then summarize.",
      output: "patch rejected: writing outside of the project; rejected by user approval settings",
      expectedOutput:
        "patch rejected: writing outside of the project; rejected by user approval settings",
      structuredError: false,
    },
    {
      label: "structured native patch output",
      prompt:
        "tool search qa check target=apply_patch. Call apply_patch exactly once and then summarize.",
      output: [{ type: "input_text", text: "Successfully applied structured patch" }],
      expectedOutput: "Successfully applied structured patch",
      structuredError: false,
    },
    {
      label: "empty native patch output",
      prompt:
        "tool search qa check target=apply_patch. Call apply_patch exactly once and then summarize.",
      output: "",
      expectedOutput: "",
      structuredError: false,
    },
    {
      label: "empty structured native patch output",
      prompt:
        "tool search qa check target=apply_patch. Call apply_patch exactly once and then summarize.",
      output: [],
      expectedOutput: "",
      structuredError: false,
    },
    {
      label: "non-text native patch output",
      prompt:
        "tool search qa check target=apply_patch. Call apply_patch exactly once and then summarize.",
      output: [{ type: "input_image", image_url: "data:image/png;base64,AA==" }],
      expectedOutput: "",
      structuredError: false,
    },
    {
      label: "empty failed native patch output",
      prompt:
        "tool search qa failure target=apply_patch. Exercise the denied-input path once and then summarize.",
      output: "",
      expectedOutput: "",
      structuredError: true,
    },
  ])("links and completes $label custom-tool outputs", async (testCase) => {
    const server = await startMockServer();
    const planResponse = await expectNonStreamingResponses(server, {
      input: [makeUserInput(testCase.prompt)],
    });
    const plannedCall = outputItem(await planResponse.json());
    expect(plannedCall).toMatchObject({ type: "function_call", name: "apply_patch" });
    const callId = outputToolCallId(plannedCall, "native-patch-call");

    const continuationResponse = await expectNonStreamingResponses(server, {
      input: [
        makeUserInput(testCase.prompt),
        {
          type: "custom_tool_call_output",
          call_id: callId,
          output: testCase.output,
          ...(testCase.structuredError ? { is_error: true } : {}),
        },
      ],
    });
    expect(outputItem(await continuationResponse.json()).type).toBe("message");

    const debug = requireRecord(
      await getJson(server, "/debug/last-request"),
      "custom patch debug request",
    );
    expect(debug.toolOutput).toBe(testCase.expectedOutput);
    expect(debug.toolOutputCallId).toBe(callId);
    if (testCase.structuredError) {
      expect(debug.toolOutputStructuredError).toBe(true);
    } else {
      expect(debug).not.toHaveProperty("toolOutputStructuredError");
    }
    expect(debug).not.toHaveProperty("plannedToolName");
  });

  it.each([false, true])(
    "does not replay an empty function-tool result when stream=%s",
    async (stream) => {
      const server = await startMockServer();
      const response = await expectResponses(server, {
        stream,
        input: [
          makeUserInput(
            "tool search qa check target=apply_patch. Call apply_patch exactly once and then summarize.",
          ),
          makeToolOutputWithCallId("call_empty_patch", ""),
        ],
      });

      const body = await response.text();
      expect(body).toContain('"type":"message"');
      expect(body).not.toContain('"type":"function_call"');
      const debug = requireRecord(
        await fetch(`${server.baseUrl}/debug/last-request`).then((result) => result.json()),
        "empty function-tool debug request",
      );
      expect(debug).toMatchObject({ toolOutput: "", toolOutputCallId: "call_empty_patch" });
      expect(debug).not.toHaveProperty("plannedToolName");
    },
  );

  it("plans Codex Responses Lite handoff from declared developer additional tools", async () => {
    const server = await startMockServer();

    const response = await expectNonStreamingResponses(server, {
      input: [
        {
          type: "additional_tools",
          role: "developer",
          tools: [CODEX_SUBAGENT_TOOL_NAMESPACE],
        },
        makeUserInput(
          "Delegate one bounded QA task to a subagent. Wait for the subagent to finish.",
        ),
      ],
    });

    const toolPlanOutput = outputItem(await response.json());
    expect(toolPlanOutput.type).toBe("function_call");
    expect(toolPlanOutput.name).toBe("sessions_spawn");
    expect(toolPlanOutput.namespace).toBe("openclaw");
  });

  it("records image inputs and describes attached images", async () => {
    const server = await startMockServer();
    const text = await readMockImageResponseText(server, [
      makeImageUserInput(
        { type: "input_text", text: "Image understanding check: what do you see?" },
        QA_IMAGE_INPUT,
      ),
    ]);
    expect(text.toLowerCase()).toContain("red");
    expect(text.toLowerCase()).toContain("blue");

    const requestLog = requireArray(await getJson(server, "/debug/requests"), "debug requests");
    expect(requireRecord(requestLog[0], "debug request 0").imageInputCount).toBe(1);
  });

  it("uses current request instructions for image descriptions", async () => {
    const server = await startMockServer();
    const text = await readMockImageResponseText(server, [
      makeDeveloperInput(QA_IMAGE_DESCRIPTION_PROMPT),
      makeImageUserInput(QA_IMAGE_INPUT, QA_IMAGE_MEDIA_CONTEXT),
    ]);
    expect(text.toLowerCase()).toContain("red");
    expect(text.toLowerCase()).toContain("blue");
  });

  it("recognizes OpenAI-compatible image_url parts as image inputs", async () => {
    const server = await startMockServer();
    const text = await readMockImageResponseText(server, [
      makeImageUserInput(
        { type: "input_text", text: "Image understanding check: what do you see?" },
        { type: "image_url", image_url: { url: `data:image/png;base64,${QA_IMAGE_PNG_BASE64}` } },
      ),
    ]);
    expect(text.toLowerCase()).toContain("red");
    expect(text.toLowerCase()).toContain("blue");

    expect(
      requireRecord(await getJson(server, "/debug/last-request"), "debug request").imageInputCount,
    ).toBe(1);
  });

  it("answers image prompts when media context is the latest text part", async () => {
    const server = await startMockServer();
    const text = await readMockImageResponseText(server, [
      makeImageUserInput(
        { type: "input_text", text: "Image understanding check: what do you see?" },
        QA_IMAGE_INPUT,
        QA_IMAGE_MEDIA_CONTEXT,
      ),
    ]);
    expect(text.toLowerCase()).toContain("red");
    expect(text.toLowerCase()).toContain("blue");
  });

  it("lets image prompts beat stale exact marker directives from chat history", async () => {
    const server = await startMockServer();
    const text = await readMockImageResponseText(server, [
      makeUserInput("Control UI bridge check. Marker exact marker: `ui bridge armed`"),
      { role: "assistant", content: [{ type: "output_text", text: "ui bridge armed" }] },
      makeImageUserInput(
        { type: "input_text", text: QA_IMAGE_DESCRIPTION_PROMPT },
        QA_IMAGE_INPUT,
        QA_IMAGE_MEDIA_CONTEXT,
      ),
    ]);
    expect(text.toLowerCase()).toContain("red");
    expect(text.toLowerCase()).toContain("blue");
    expect(text).not.toBe("ui bridge armed");
  });

  it("keeps stale image prompts from overriding later marker turns", async () => {
    const server = await startMockServer();
    const payload = await readMockImageResponse(server, [
      makeImageUserInput({ type: "input_text", text: QA_IMAGE_DESCRIPTION_PROMPT }, QA_IMAGE_INPUT),
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
    ]);
    expect(payload.output?.[0]?.content?.[0]?.text).toBe("fresh-marker-ok");
  });

  it("keeps stale consecutive image prompts from overriding later marker turns", async () => {
    const server = await startMockServer();
    const payload = await readMockImageResponse(server, [
      makeImageUserInput({ type: "input_text", text: QA_IMAGE_DESCRIPTION_PROMPT }, QA_IMAGE_INPUT),
      makeUserInput("Marker exact marker: `fresh-consecutive-marker-ok`"),
    ]);
    expect(payload.output?.[0]?.content?.[0]?.text).toBe("fresh-consecutive-marker-ok");
  });

  it("handles deeply nested image input shapes without recursive traversal failure", async () => {
    const server = await startMockServer();

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

    await expectNonStreamingResponses(server, {
      model: "mock-openai/gpt-5.6-luna",
      input: [
        {
          role: "user",
          content,
        },
      ],
    });

    expect(
      requireRecord(await getJson(server, "/debug/last-request"), "debug request").imageInputCount,
    ).toBe(1);
  });

  it("describes reattached generated images in the roundtrip flow", async () => {
    const server = await startMockServer();

    const payload = (await expectNonStreamingResponsesJson(server, {
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
    })) as {
      output?: Array<{ content?: Array<{ text?: string }> }>;
    };
    const text = payload.output?.[0]?.content?.[0]?.text ?? "";
    expect(text.toLowerCase()).toContain("lighthouse");
  });

  it("ignores stale tool output from prior turns when planning the current turn", async () => {
    const server = await startMockServer();

    const response = await expectStreamingResponses(server, {
      input: [
        makeUserInput("Read QA_KICKOFF_TASK.md first."),
        makeToolOutput("QA mission: read source and docs first."),
        makeUserInput(
          "Switch models now. Tool continuity check: reread QA_KICKOFF_TASK.md and mention the handoff in one short sentence.",
        ),
      ],
    });
    expect(await response.text()).toContain('"name":"read"');
  });

  it("routes the initial model-switch read through Anthropic guest Code Mode", async () => {
    const server = await startMockServer();
    const body = (await expectAnthropicMessagesJson(server, {
      tools: [
        {
          name: "exec",
          input_schema: {
            type: "object",
            properties: { code: { type: "string" } },
            required: ["code"],
          },
        },
        {
          name: "wait",
          input_schema: {
            type: "object",
            properties: { runId: { type: "string" } },
            required: ["runId"],
          },
        },
      ],
      messages: [
        makeAnthropicUserText(
          "Read repo/qa/scenarios/index.yaml and summarize the QA scenario pack mission in one clause before any model switch.",
        ),
      ],
    })) as {
      stop_reason: string;
      content: Array<Record<string, unknown>>;
    };

    expect(body.stop_reason).toBe("tool_use");
    expect(body.content.find((block) => block.type === "tool_use")?.name).toBe("exec");

    const debug = requireRecord(
      await getJson(server, "/debug/last-request"),
      "model switch Code Mode debug request",
    );
    expect(debug.plannedToolName).toBe("read");
    expect(debug.plannedWireToolName).toBe("exec");
    expect(debug.plannedToolArgs).toEqual({ path: "repo/qa/scenarios/index.yaml" });
  });

  it("returns continuity language after the model-switch reread completes", async () => {
    const server = await startMockServer();

    const response = await expectNonStreamingResponses(server, {
      model: "gpt-5.6-luna-alt",
      input: [
        makeUserInput(
          "Switch models now. Tool continuity check: reread QA_KICKOFF_TASK.md and mention the handoff in one short sentence.",
        ),
        makeToolOutput(
          "QA mission: Understand this OpenClaw repo from source + docs before acting.",
        ),
      ],
    });

    expect(outputText(await response.json())).toContain("model switch handoff confirmed");
  });

  it("returns the Codex remote-compaction-v2 response shape", async () => {
    const server = await startMockServer();

    const response = await expectStreamingResponses(server, {
      input: [makeUserInput("Retained context."), { type: "compaction_trigger" }],
    });

    const body = await response.text();
    expect(body).toContain('"type":"response.output_item.done"');
    expect(body).toContain('"type":"compaction"');
    expect(body).toContain('"encrypted_content":"QA_MOCK_REMOTE_COMPACTION_SUMMARY"');
    expect(body).toContain('"type":"response.completed"');
    expect(await getJson(server, "/debug/requests")).toEqual([]);
  });

  it("returns NO_REPLY for unmentioned group chatter", async () => {
    const server = await startMockServer();

    const response = await expectNonStreamingResponses(server, {
      input: [
        makeUserInput(
          'Conversation info: ⟦openclaw:ctx⟧\n{"is_group_chat": true}\n\nhello team, no bot ping here',
        ),
      ],
    });
    expect(outputText(await response.json())).toBe("NO_REPLY");
  });

  it("advertises Anthropic claude-opus-4-8 baseline model on /v1/models", async () => {
    const server = await startMockServer();

    const body = (await fetchOkJson(`${server.baseUrl}/v1/models`)) as {
      data: Array<{ id: string }>;
    };
    const ids = body.data.map((entry) => entry.id);
    expect(ids).toContain("claude-opus-4-8");
    expect(ids).toContain("gpt-5.6-luna");
    expect(ids).toContain("gpt-4o-transcribe");
  });

  it("advertises selected target-era models on /v1/models", async () => {
    const server = await startMockServer({
      modelRefs: ["mock-openai/gpt-5.5", "mock-openai/gpt-5.5-alt"],
    });

    const body = (await fetchOkJson(`${server.baseUrl}/v1/models`)) as {
      data: Array<{ id: string }>;
    };
    expect(body.data.map((entry) => entry.id)).toEqual(
      expect.arrayContaining(["gpt-5.5", "gpt-5.5-alt", "gpt-image-1"]),
    );
  });

  it("advertises directly executable native Codex metadata alongside OpenAI models", async () => {
    const server = await startMockServer({
      modelRefs: ["mock-openai/gpt-5.6-luna", "mock-openai/gpt-5.6-luna-alt"],
    });

    const body = (await fetchOkJson(`${server.baseUrl}/v1/models?client_version=0.142.0`)) as {
      data: Array<{ id: string; object: string }>;
      models: Array<Record<string, unknown>>;
    };
    expect(body.data).toEqual(
      expect.arrayContaining([
        { id: "gpt-5.6-luna", object: "model" },
        { id: "gpt-5.6-luna-alt", object: "model" },
      ]),
    );
    expect(body.models).toHaveLength(2);
    expect(body.models).toEqual([
      expect.objectContaining({
        slug: "gpt-5.6-luna",
        display_name: "gpt-5.6-luna",
        apply_patch_tool_type: "freeform",
        tool_mode: "direct",
        shell_type: "shell_command",
        visibility: "list",
        supported_in_api: true,
        base_instructions: expect.any(String),
        truncation_policy: { mode: "tokens", limit: 10_000 },
        supported_reasoning_levels: expect.arrayContaining([
          { effort: "medium", description: "Balanced QA reasoning" },
        ]),
        experimental_supported_tools: [],
        input_modalities: ["text", "image"],
      }),
      expect.objectContaining({
        slug: "gpt-5.6-luna-alt",
        apply_patch_tool_type: "freeform",
        tool_mode: "direct",
      }),
    ]);
  });

  it("serves deterministic OpenAI-compatible audio transcription responses", async () => {
    const server = await startMockServer();

    const response = await fetchOk(`${server.baseUrl}/v1/audio/transcriptions`, {
      method: "POST",
      headers: {
        "content-type": "multipart/form-data; boundary=qa",
      },
      body: "--qa\r\n--qa--\r\n",
    });

    await expect(response.json()).resolves.toEqual({
      text: "Reply with only this exact marker: WHATSAPP_QA_AUDIO_TRANSCRIPT_OK",
    });
  });

  it("serves deterministic WhatsApp group audio transcription for the trigger fixture", async () => {
    const server = await startMockServer();

    const triggered = await fetchOk(`${server.baseUrl}/v1/audio/transcriptions`, {
      method: "POST",
      headers: {
        "content-type": "multipart/form-data; boundary=qa",
      },
      body:
        '--qa\r\ncontent-disposition: form-data; name="file"; filename="upload.ogg"\r\n\r\n' +
        "OPENCLAW_QA_GROUP_AUDIO_TRIGGER\r\n--qa--\r\n",
    });
    const quiet = await fetchOk(`${server.baseUrl}/v1/audio/transcriptions`, {
      method: "POST",
      headers: {
        "content-type": "multipart/form-data; boundary=qa",
      },
      body: '--qa\r\ncontent-disposition: form-data; name="file"; filename="upload.ogg"\r\n\r\nx\r\n--qa--\r\n',
    });

    await expect(triggered.json()).resolves.toEqual({
      text: "openclawqa reply with only this exact marker after group audio preflight: WHATSAPP_QA_GROUP_AUDIO_TRANSCRIPT_OK",
    });
    await expect(quiet.json()).resolves.toEqual({
      text: "Reply with only this exact marker: WHATSAPP_QA_AUDIO_TRANSCRIPT_OK",
    });
  });

  it("serves deterministic Matrix voice preflight transcription for the request prompt", async () => {
    const server = await startMockServer();

    const response = await fetchOk(`${server.baseUrl}/v1/audio/transcriptions`, {
      method: "POST",
      headers: {
        "content-type": "multipart/form-data; boundary=qa",
      },
      body:
        '--qa\r\ncontent-disposition: form-data; name="file"; filename="audio.wav"\r\n\r\n' +
        'fixture audio\r\n--qa\r\ncontent-disposition: form-data; name="prompt"\r\n\r\n' +
        "MATRIX_QA_VOICE_PREFLIGHT_TRIGGER\r\n--qa--\r\n",
    });

    await expect(response.json()).resolves.toEqual({
      text: "C3PLQA reply with only these words Matrix QA voice pre-flight OK.",
    });
  });

  it("dispatches an Anthropic /v1/messages read tool call for source discovery prompts", async () => {
    const server = await startMockServer();

    const body = (await expectAnthropicMessagesJson(server, {
      tools: [
        {
          name: "read",
          input_schema: {
            type: "object",
            properties: { path: { type: "string" } },
            required: ["path"],
          },
        },
      ],
      messages: [
        makeAnthropicUserText(
          "Read the seeded docs and report worked, failed, blocked, and follow-up items.",
        ),
      ],
    })) as {
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
      | { id: string; name: string; input: Record<string, unknown> }
      | undefined;
    expect(toolUseBlock?.id).toMatch(/^toolu[a-f0-9]{35}$/);
    expect(toolUseBlock?.id.length).toBeLessThanOrEqual(64);
    expect(toolUseBlock?.name).toBe("read");
    expect(toolUseBlock?.input).toEqual({ path: "repo/docs/help/testing.md" });

    const debugPayload = requireRecord(
      await getJson(server, "/debug/last-request"),
      "debug request",
    );
    expect(debugPayload.model).toBe("claude-opus-4-8");
    expect(debugPayload.plannedToolCallId).toBe(toolUseBlock?.id);
    expect(debugPayload).not.toHaveProperty("plannedToolItemId");
    expect(debugPayload.plannedToolName).toBe("read");
  });

  it("preserves already-native Anthropic tool IDs while adapting shared generated IDs", () => {
    const nativeId = "toolu_native_123";
    const generatedId = "call_mock_read_generated_1";
    const secondGeneratedId = "call_mock_read_generated_2";
    const events: StreamEvent[] = [
      {
        type: "response.output_item.added",
        item: { type: "function_call", name: "read", call_id: nativeId, arguments: "{}" },
      },
      {
        type: "response.output_item.done",
        item: { type: "function_call", name: "read", call_id: nativeId, arguments: "{}" },
      },
      {
        type: "response.output_item.added",
        item: { type: "function_call", name: "read", call_id: generatedId, arguments: "{}" },
      },
      {
        type: "response.output_item.done",
        item: { type: "function_call", name: "read", call_id: generatedId, arguments: "{}" },
      },
      {
        type: "response.completed",
        response: {
          id: "response_mock",
          status: "completed",
          output: [
            { type: "function_call", name: "read", call_id: nativeId, arguments: "{}" },
            { type: "function_call", name: "read", call_id: generatedId, arguments: "{}" },
            { type: "function_call", name: "read", call_id: secondGeneratedId, arguments: "{}" },
          ],
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        },
      },
    ];

    const adapted = adaptAnthropicToolCallIds(events);
    const callIds = adapted.flatMap((event) => {
      if (
        event.type === "response.output_item.added" ||
        event.type === "response.output_item.done"
      ) {
        return typeof event.item.call_id === "string" ? [event.item.call_id] : [];
      }
      if (event.type === "response.completed") {
        return event.response.output.flatMap((item) =>
          typeof item.call_id === "string" ? [item.call_id] : [],
        );
      }
      return [];
    });
    const adaptedGeneratedIds = callIds.filter((id) => id !== nativeId);
    const repeatedGeneratedIds = adaptAnthropicToolCallIds(events).flatMap((event) => {
      if (
        event.type === "response.output_item.added" ||
        event.type === "response.output_item.done"
      ) {
        return event.item.call_id === nativeId || typeof event.item.call_id !== "string"
          ? []
          : [event.item.call_id];
      }
      if (event.type === "response.completed") {
        return event.response.output.flatMap((item) =>
          item.call_id === nativeId || typeof item.call_id !== "string" ? [] : [item.call_id],
        );
      }
      return [];
    });

    expect(callIds.filter((id) => id === nativeId)).toHaveLength(3);
    expect(adaptedGeneratedIds.slice(0, 3)).toEqual(
      Array.from({ length: 3 }, () => "toolu51ca7fb8ca8ab1910ae2815b4e69a38ac71"),
    );
    expect(adaptedGeneratedIds[3]).toMatch(/^toolu[a-f0-9]{35}$/);
    expect(adaptedGeneratedIds[3]).not.toBe(adaptedGeneratedIds[0]);
    expect(repeatedGeneratedIds).toEqual(adaptedGeneratedIds);
    expect(adaptedGeneratedIds[0]).toMatch(/^toolu[a-f0-9]{35}$/);
    expect(adaptedGeneratedIds[0]?.length).toBeLessThanOrEqual(64);
  });

  it("routes Anthropic hidden tools through Code Mode and preserves scenario evidence", async () => {
    const server = await startMockServer();
    const prompt =
      "Repo contract followthrough check. Read AGENT.md, SOUL.md, and FOLLOWTHROUGH_INPUT.md first. Then follow the repo contract exactly, write ./repo-contract-summary.txt, and reply with three labeled lines: Read, Wrote, Status.";
    const tools = [
      {
        name: "exec",
        input_schema: {
          type: "object",
          properties: {
            language: { type: "string" },
            code: { type: "string" },
          },
          required: ["code"],
        },
      },
      {
        name: "wait",
        input_schema: {
          type: "object",
          properties: { runId: { type: "string" } },
          required: ["runId"],
        },
      },
    ];
    const messages: Array<Record<string, unknown>> = [makeAnthropicUserText(prompt)];
    const emittedToolUseIds: string[] = [];

    const request = async (expectedToolResultId?: string) => {
      const response = await expectAnthropicMessages(server, {
        tools,
        messages,
      });
      const body = (await response.json()) as {
        stop_reason: string;
        content: Array<Record<string, unknown>>;
      };
      const debug = requireRecord(await getJson(server, "/debug/last-request"), "debug request");
      if (expectedToolResultId) {
        expect(debug.toolOutputCallId).toBe(expectedToolResultId);
      } else {
        expect(debug).not.toHaveProperty("toolOutputCallId");
      }
      return body;
    };
    const readToolUse = (body: {
      stop_reason: string;
      content: Array<Record<string, unknown>>;
    }) => {
      expect(body.stop_reason).toBe("tool_use");
      const toolUse = body.content.find((block) => block.type === "tool_use");
      if (!toolUse || typeof toolUse.id !== "string" || typeof toolUse.name !== "string") {
        throw new Error("Expected Anthropic tool_use block");
      }
      expect(toolUse.id).toMatch(/^toolu[a-f0-9]{35}$/);
      expect(toolUse.id.length).toBeLessThanOrEqual(64);
      emittedToolUseIds.push(toolUse.id);
      return toolUse;
    };
    const appendToolResult = (
      toolUse: Record<string, unknown>,
      result: Record<string, unknown>,
    ) => {
      messages.push(
        { role: "assistant", content: [toolUse] },
        makeAnthropicToolResult(toolUse.id, JSON.stringify(result)),
      );
    };
    const expectPlan = async (
      name: string,
      args: Record<string, unknown>,
      callId: string,
      wireName = "exec",
    ) => {
      const debug = requireRecord(await getJson(server, "/debug/last-request"), "debug request");
      expect(debug.plannedToolCallId).toBe(callId);
      expect(debug.plannedToolName).toBe(name);
      expect(debug.plannedWireToolName).toBe(wireName);
      expect(debug.plannedToolArgs).toEqual(args);
    };

    const readAgent = readToolUse(await request());
    expect(readAgent.name).toBe("exec");
    const readAgentCode = String(requireRecord(readAgent.input, "exec input").code);
    expect(readAgentCode).toContain("await catalog.search(targetName)");
    expect(readAgentCode).toContain("await target(targetArgs)");
    expect(readAgentCode).not.toContain("ALL_TOOLS");
    expect(readAgentCode).toContain("value.content.slice(0, 2048)");
    await expectPlan("read", { path: "AGENT.md" }, String(readAgent.id));

    appendToolResult(readAgent, { status: "waiting", runId: "qa-code-mode-read-agent" });
    const waitForAgent = readToolUse(await request(String(readAgent.id)));
    expect(waitForAgent.name).toBe("wait");
    const waitDebug = requireRecord(
      await fetch(`${server.baseUrl}/debug/last-request`).then((response) => response.json()),
      "wait debug request",
    );
    expect(waitDebug.plannedToolCallId).toBe(waitForAgent.id);
    expect(waitDebug.plannedToolName).toBe("wait");
    expect(waitDebug).not.toHaveProperty("plannedWireToolName");
    expect(waitDebug.plannedToolArgs).toEqual({ runId: "qa-code-mode-read-agent" });

    appendToolResult(waitForAgent, {
      status: "completed",
      value: { kind: "text", content: "# Repo contract\nDo not stop after planning." },
    });
    const readSoul = readToolUse(await request(String(waitForAgent.id)));
    expect(readSoul.name).toBe("exec");
    await expectPlan("read", { path: "SOUL.md" }, String(readSoul.id));

    appendToolResult(readSoul, {
      status: "completed",
      value: { kind: "text", content: "# Execution style\nStay action-first." },
    });
    const readInput = readToolUse(await request(String(readSoul.id)));
    expect(readInput.name).toBe("exec");
    await expectPlan("read", { path: "FOLLOWTHROUGH_INPUT.md" }, String(readInput.id));

    appendToolResult(readInput, {
      status: "completed",
      value: {
        kind: "text",
        content:
          "Mission: prove you followed the repo contract.\nEvidence path: AGENT.md -> SOUL.md -> FOLLOWTHROUGH_INPUT.md -> repo-contract-summary.txt",
      },
    });
    const writeSummary = readToolUse(await request(String(readInput.id)));
    expect(writeSummary.name).toBe("exec");
    await expectPlan(
      "write",
      {
        path: "repo-contract-summary.txt",
        content:
          "Mission: prove you followed the repo contract.\nEvidence: AGENT.md -> SOUL.md -> FOLLOWTHROUGH_INPUT.md\nStatus: complete",
      },
      String(writeSummary.id),
    );

    appendToolResult(writeSummary, {
      status: "completed",
      value: "Successfully wrote 146 bytes to repo-contract-summary.txt.",
    });
    const final = await request(String(writeSummary.id));
    expect(final.stop_reason).toBe("end_turn");
    const text = final.content.find((block) => block.type === "text")?.text;
    expect(text).toBe(
      "Read: AGENT.md, SOUL.md, FOLLOWTHROUGH_INPUT.md\nWrote: repo-contract-summary.txt\nStatus: complete",
    );
    expect(new Set(emittedToolUseIds).size).toBe(emittedToolUseIds.length);
  });

  it("uses native Codex custom exec, output arrays, and cell_id waits", async () => {
    const server = await startMockServer();
    const tools = [
      { type: "custom", name: "exec", format: { type: "grammar", syntax: "lark", definition: "" } },
      {
        type: "function",
        name: "wait",
        parameters: {
          type: "object",
          properties: { cell_id: { type: "string" } },
          required: ["cell_id"],
        },
      },
    ];
    const prompt = QA_COMPACTION_RETRY_PROMPT;
    const execPayload = await expectOpenAiNonStreamingResponsesJson(server, {
      tools,
      input: [makeUserInput(prompt)],
    });
    const execCall = outputItem(execPayload);
    expect(execCall).toMatchObject({ type: "custom_tool_call", name: "exec" });
    const source = String(execCall.input);
    expect(source).toContain("tools[target.name](targetArgs)");
    expect(source).toContain("text(JSON.stringify(value));");
    expect(source).not.toContain("tools.callValue");
    expect(source).not.toContain("target.id");
    expect(source).not.toMatch(/ALL_TOOLS[^\n]*\.id/);
    expect(source).not.toContain("return value");

    const execCallId = outputToolCallId(execCall, "native-exec");
    const waitPayload = await expectOpenAiNonStreamingResponsesJson(server, {
      tools,
      input: [
        makeUserInput(prompt),
        execCall,
        {
          type: "custom_tool_call_output",
          call_id: execCallId,
          output: [
            {
              type: "input_text",
              text: "Script running with cell ID cell-write-1\nLive output:\n",
            },
          ],
        },
      ],
    });
    const waitCall = outputToolCall(waitPayload, "wait");
    expect(outputToolArgsFromItem(waitCall)).toEqual({ cell_id: "cell-write-1" });

    const finalPayload = await expectOpenAiNonStreamingResponsesJson(server, {
      tools,
      input: [
        makeUserInput(prompt),
        execCall,
        {
          type: "custom_tool_call_output",
          call_id: execCallId,
          output: [
            {
              type: "input_text",
              text: "Script running with cell ID cell-write-1\nLive output:\n",
            },
          ],
        },
        waitCall,
        {
          type: "function_call_output",
          call_id: outputToolCallId(waitCall, "native-wait"),
          output: [
            { type: "input_text", text: "Script completed\nWall time: 0.1 seconds\nOutput:\n" },
            {
              type: "input_text",
              text: JSON.stringify({ status: "completed", value: { changed: false } }),
            },
            {
              type: "input_text",
              text: JSON.stringify(QA_COMPACTION_RETRY_CODE_MODE_WRITE_RESULT),
            },
          ],
        },
      ],
    });
    expect(outputText(finalPayload)).toBe("Protocol note: replay unsafe after write.");
  });

  it.each([
    {
      label: "failed header with canonical JSON",
      output: [
        { type: "input_text", text: "Script failed\nWall time: 0.1 seconds\nOutput:\n" },
        {
          type: "input_text",
          text: JSON.stringify(QA_COMPACTION_RETRY_CODE_MODE_WRITE_RESULT),
        },
      ],
    },
    {
      label: "terminated header with canonical JSON",
      output: [
        { type: "input_text", text: "Script terminated\nWall time: 0.1 seconds\nOutput:\n" },
        {
          type: "input_text",
          text: JSON.stringify(QA_COMPACTION_RETRY_CODE_MODE_WRITE_RESULT),
        },
      ],
    },
    {
      label: "unknown header with canonical JSON",
      output: [
        { type: "input_text", text: "Script paused\nWall time: 0.1 seconds\nOutput:\n" },
        {
          type: "input_text",
          text: JSON.stringify(QA_COMPACTION_RETRY_CODE_MODE_WRITE_RESULT),
        },
      ],
    },
    {
      label: "failed header followed by a running marker",
      output: [
        { type: "input_text", text: "Script failed\nWall time: 0.1 seconds\nOutput:\n" },
        {
          type: "input_text",
          text: "Script running with cell ID cell-write-late\nLive output:\n",
        },
      ],
    },
    {
      label: "missing header with canonical JSON",
      output: [
        {
          type: "input_text",
          text: JSON.stringify(QA_COMPACTION_RETRY_CODE_MODE_WRITE_RESULT),
        },
      ],
    },
    {
      label: "reordered completed header and canonical JSON",
      output: [
        {
          type: "input_text",
          text: JSON.stringify(QA_COMPACTION_RETRY_CODE_MODE_WRITE_RESULT),
        },
        { type: "input_text", text: "Script completed\nWall time: 0.1 seconds\nOutput:\n" },
      ],
    },
    {
      label: "completed header without JSON",
      output: [{ type: "input_text", text: "Script completed\nWall time: 0.1 seconds\nOutput:\n" }],
    },
  ])("rejects native Code Mode compaction evidence with $label", async ({ output }) => {
    const server = await startMockServer();
    const tools = [
      { type: "custom", name: "exec", format: { type: "grammar", syntax: "lark", definition: "" } },
      {
        type: "function",
        name: "wait",
        parameters: {
          type: "object",
          properties: { cell_id: { type: "string" } },
          required: ["cell_id"],
        },
      },
    ];
    const execPayload = await expectOpenAiNonStreamingResponsesJson(server, {
      tools,
      input: [makeUserInput(QA_COMPACTION_RETRY_PROMPT)],
    });
    const execCall = outputItem(execPayload);
    const payload = await expectOpenAiNonStreamingResponsesJson(server, {
      tools,
      input: [
        makeUserInput(QA_COMPACTION_RETRY_PROMPT),
        execCall,
        {
          type: "custom_tool_call_output",
          call_id: outputToolCallId(execCall, "native-exec"),
          output,
        },
      ],
    });

    expect(outputItems(payload).some((item) => item.type === "function_call")).toBe(false);
    expect(outputText(payload)).not.toBe("Protocol note: replay unsafe after write.");
  });

  const restartCheckpointTools = [
    {
      type: "function",
      name: "exec",
      parameters: {
        type: "object",
        properties: {
          language: { type: "string" },
          code: { type: "string" },
          restartSafe: { type: "boolean" },
        },
        required: ["code"],
      },
    },
    {
      type: "function",
      name: "wait",
      parameters: {
        type: "object",
        properties: { runId: { type: "string" } },
        required: ["runId"],
      },
    },
  ];
  const restartRecoveryPrompt =
    "Your previous turn was interrupted by a gateway restart. Continue from the existing transcript.";

  async function expectRestartCheckpointExecution(
    execArgs: Record<string, unknown>,
    checkpoint: number,
  ) {
    expect(execArgs).toMatchObject({ language: "javascript", restartSafe: true });
    expect(execArgs.code).toContain("qa_restart_wait");
    expect(execArgs.code).toContain('catalog.search("qa_restart_wait")');
    expect(execArgs.code).toContain(`CHECKPOINT-${checkpoint}`);

    const started = createDeferred<void>();
    const released = createDeferred<void>();
    const calls: unknown[] = [];
    const target = Object.assign(
      (args: unknown) => {
        calls.push(args);
        started.resolve();
        return released.promise;
      },
      { toolName: "qa_restart_wait" },
    );
    let yielded = false;
    const execution: unknown = runInNewContext(`(async () => { ${String(execArgs.code)} })()`, {
      catalog: {
        search: async (name: string) => {
          expect(name).toBe("qa_restart_wait");
          return [target];
        },
      },
      yield_control: () => {
        yielded = true;
      },
    });
    try {
      await started.promise;
      expect(yielded).toBe(true);
    } finally {
      released.resolve();
      await expect(execution).resolves.toBe(`CHECKPOINT-${checkpoint}`);
    }
    expect(calls).toEqual([{}]);
  }

  it("settles hard-kill recovery after one real checkpoint and resets from request history", async () => {
    const server = await startMockServer();
    const prompt = "Code Mode restart wait QA check. Original prompt marker: KILL-RESTART-PROMPT.";
    const tools = [
      ...restartCheckpointTools,
      { type: "function", name: "qa_restart_unsafe_probe", parameters: { type: "object" } },
    ];
    const input: Array<Record<string, unknown>> = [makeUserInput(prompt)];
    const execPayload = await expectOpenAiNonStreamingResponsesJson(server, { tools, input });
    expect(outputItems(execPayload)).toHaveLength(1);
    const execCall = outputToolCall(execPayload, "exec");
    const execArgs = outputToolArgsFromItem(execCall);
    await expectRestartCheckpointExecution(execArgs, 1);

    const runId = "kill-restart-checkpoint-1";
    input.push(
      execCall,
      makeToolOutputWithCallId(
        outputToolCallId(execCall, "kill-restart-exec"),
        JSON.stringify({ status: "waiting", runId }),
      ),
    );
    const waitPayload = await expectOpenAiNonStreamingResponsesJson(server, { tools, input });
    expect(outputItems(waitPayload)).toHaveLength(1);
    const waitCall = outputToolCall(waitPayload, "wait");
    expect(outputToolArgsFromItem(waitCall)).toEqual({ runId });
    input.push(waitCall, makeUserInput(restartRecoveryPrompt));

    const recovered = await expectOpenAiNonStreamingResponsesJson(server, { tools, input });
    expect(outputItems(recovered).map((item) => item.type)).toEqual(["message"]);
    expect(outputText(recovered)).toBe("KILL-RESTART-RECOVERED-OK");

    const freshPayload = await expectOpenAiNonStreamingResponsesJson(server, {
      tools,
      input: [makeUserInput(prompt)],
    });
    expect(outputItems(freshPayload)).toHaveLength(1);
    expect(outputToolArgsFromItem(outputToolCall(freshPayload, "exec"))).toEqual(execArgs);
  });

  it("derives three restart checkpoints from request history without server counters", async () => {
    const server = await startMockServer();
    const prompt =
      "Code Mode restart wait QA check. Original prompt marker: RESTART-CODE-MODE-PROMPT.";
    const tools = restartCheckpointTools;
    const input: Array<Record<string, unknown>> = [makeUserInput(prompt)];

    for (const checkpoint of [1, 2, 3]) {
      const execPayload = await expectOpenAiNonStreamingResponsesJson(server, { tools, input });
      const execCall = outputToolCall(execPayload, "exec");
      const execArgs = outputToolArgsFromItem(execCall);
      await expectRestartCheckpointExecution(execArgs, checkpoint);

      const runId = `restart-checkpoint-${checkpoint}`;
      input.push(
        execCall,
        makeToolOutputWithCallId(
          outputToolCallId(execCall, `checkpoint-exec-${checkpoint}`),
          JSON.stringify({ status: "waiting", runId }),
        ),
      );
      const waitPayload = await expectOpenAiNonStreamingResponsesJson(server, { tools, input });
      const waitCall = outputToolCall(waitPayload, "wait");
      expect(outputToolArgsFromItem(waitCall)).toEqual({ runId });
      input.push(waitCall, makeUserInput(restartRecoveryPrompt));
    }

    const finalPayload = await expectOpenAiNonStreamingResponsesJson(server, { tools, input });
    expect(outputText(finalPayload)).toBe("unsafeVisible=false\nRESTART-CODE-MODE-WAIT-OK");

    const freshPayload = await expectOpenAiNonStreamingResponsesJson(server, {
      tools,
      input: [makeUserInput(prompt)],
    });
    expect(outputToolArgsFromItem(outputToolCall(freshPayload, "exec")).code).toContain(
      "CHECKPOINT-1",
    );
  });

  it("routes Anthropic image generation through Code Mode when only exec and wait are visible", async () => {
    const server = await startMockServer();
    const body = (await expectAnthropicMessagesJson(server, {
      tools: [
        {
          name: "exec",
          input_schema: {
            type: "object",
            properties: { code: { type: "string" } },
            required: ["code"],
          },
        },
        {
          name: "wait",
          input_schema: {
            type: "object",
            properties: { runId: { type: "string" } },
            required: ["runId"],
          },
        },
      ],
      messages: [
        makeAnthropicUserText(
          "Capability flip image check: generate a QA lighthouse image in this turn right now.",
        ),
      ],
    })) as {
      stop_reason: string;
      content: Array<Record<string, unknown>>;
    };
    expect(body.stop_reason).toBe("tool_use");
    expect(body.content.find((block) => block.type === "tool_use")?.name).toBe("exec");

    const debug = requireRecord(
      await fetch(`${server.baseUrl}/debug/last-request`).then((result) => result.json()),
      "debug request",
    );
    expect(debug.plannedToolName).toBe("image_generate");
    expect(debug.plannedWireToolName).toBe("exec");
  });

  it("does not route hidden capabilities through ordinary shell exec", async () => {
    const server = await startMockServer();
    const body = (await expectAnthropicMessagesJson(server, {
      tools: [
        {
          name: "exec",
          input_schema: {
            type: "object",
            properties: { command: { type: "string" } },
            required: ["command"],
          },
        },
      ],
      messages: [
        makeAnthropicUserText(
          "Capability flip image check: generate a QA lighthouse image in this turn right now.",
        ),
      ],
    })) as {
      stop_reason: string;
      content: Array<Record<string, unknown>>;
    };
    expect(body.stop_reason).toBe("end_turn");
    expect(body.content.some((block) => block.type === "tool_use")).toBe(false);
  });

  it("does not interpret ordinary tool results as Code Mode control envelopes", async () => {
    const server = await startMockServer();
    const prompt = "Read the seeded docs and report worked, failed, blocked, and follow-up items.";
    const tools = [
      {
        name: "read",
        input_schema: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
        },
      },
      {
        name: "wait",
        input_schema: {
          type: "object",
          properties: { runId: { type: "string" } },
          required: ["runId"],
        },
      },
    ];
    const messages: Array<Record<string, unknown>> = [makeAnthropicUserText(prompt)];
    const firstBody = (await expectAnthropicMessagesJson(server, {
      tools,
      messages,
    })) as {
      content: Array<Record<string, unknown>>;
    };
    const readToolUse = firstBody.content.find((block) => block.type === "tool_use");
    if (!readToolUse || typeof readToolUse.id !== "string") {
      throw new Error("Expected Anthropic read tool_use block");
    }
    for (const result of [
      { status: "waiting", runId: "ordinary-read" },
      {
        status: "completed",
        value: { status: "waiting", runId: "ordinary-read-completed-value" },
      },
    ]) {
      const body = (await expectAnthropicMessagesJson(server, {
        tools,
        messages: [
          ...messages,
          { role: "assistant", content: [readToolUse] },
          makeAnthropicToolResult(readToolUse.id, JSON.stringify(result)),
        ],
      })) as {
        stop_reason: string;
        content: Array<Record<string, unknown>>;
      };
      expect(body.stop_reason).toBe("end_turn");
      expect(body.content.some((block) => block.type === "tool_use")).toBe(false);
    }
  });

  it("does not interpret unmarked direct exec results as Code Mode control envelopes", async () => {
    const server = await startMockServer();
    const tools = [
      {
        name: "exec",
        input_schema: {
          type: "object",
          properties: { code: { type: "string" } },
          required: ["code"],
        },
      },
      {
        name: "wait",
        input_schema: {
          type: "object",
          properties: { runId: { type: "string" } },
          required: ["runId"],
        },
      },
    ];
    const messages = [
      makeAnthropicUserText("Direct exec envelope isolation check."),
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "toolu_direct_exec",
            name: "exec",
            input: { language: "javascript", code: "return 1;" },
          },
        ],
      },
    ];
    for (const result of [
      { status: "waiting", runId: "direct-exec" },
      {
        status: "completed",
        value: { status: "waiting", runId: "direct-exec-completed-value" },
      },
    ]) {
      const body = (await expectAnthropicMessagesJson(server, {
        tools,
        messages: [
          ...messages,
          makeAnthropicToolResult("toolu_direct_exec", JSON.stringify(result)),
        ],
      })) as {
        stop_reason: string;
        content: Array<Record<string, unknown>>;
      };
      expect(body.stop_reason).toBe("end_turn");
      expect(body.content.some((block) => block.type === "tool_use")).toBe(false);
    }
  });

  it("finishes Anthropic Code Mode fanout after the second wrapped spawn result", async () => {
    const server = await startMockServer();
    const prompt =
      "Subagent fanout synthesis check: delegate exactly two bounded subagents sequentially using sessions_spawn, not ACP.";
    const messages: Array<Record<string, unknown>> = [makeAnthropicUserText(prompt)];
    const request = async () => {
      const response = await expectAnthropicMessages(server, {
        tools: [
          {
            name: "exec",
            input_schema: {
              type: "object",
              properties: { code: { type: "string" } },
              required: ["code"],
            },
          },
          {
            name: "wait",
            input_schema: {
              type: "object",
              properties: { runId: { type: "string" } },
              required: ["runId"],
            },
          },
        ],
        messages,
      });
      return (await response.json()) as {
        stop_reason: string;
        content: Array<Record<string, unknown>>;
      };
    };
    const appendCompletedResult = (
      toolUse: Record<string, unknown>,
      value: Record<string, unknown>,
    ) => {
      messages.push(
        { role: "assistant", content: [toolUse] },
        makeAnthropicToolResult(toolUse.id, JSON.stringify({ status: "completed", value })),
      );
    };
    const requireToolUse = (
      body: {
        stop_reason: string;
        content: Array<Record<string, unknown>>;
      },
      expectedName: string,
    ) => {
      expect(body.stop_reason).toBe("tool_use");
      const toolUse = body.content.find((block) => block.type === "tool_use");
      if (!toolUse || typeof toolUse.id !== "string") {
        throw new Error("Expected Anthropic tool_use block");
      }
      expect(toolUse.name).toBe(expectedName);
      return toolUse;
    };
    const alpha = requireToolUse(await request(), "exec");
    appendCompletedResult(alpha, { status: "accepted", childSessionKey: "alpha" });
    const beta = requireToolUse(await request(), "exec");
    appendCompletedResult(beta, { status: "accepted", childSessionKey: "beta" });
    const firstYield = requireToolUse(await request(), "exec");
    appendCompletedResult(firstYield, { status: "yielded" });
    messages.push(makeAnthropicUserText("[Inter-session message]\nALPHA-OK"));
    const secondYield = requireToolUse(await request(), "exec");
    appendCompletedResult(secondYield, { status: "yielded" });
    messages.push(makeAnthropicUserText("[Inter-session message]\nBETA-OK"));

    const final = await request();
    expect(final.stop_reason).toBe("end_turn");
    expect(final.content.find((block) => block.type === "text")?.text).toBe(
      "subagent-1: ok\nsubagent-2: ok",
    );
  });

  it("finishes Anthropic fanout without sessions_yield when Code Mode is unavailable", async () => {
    const server = await startMockServer();
    const prompt =
      "Subagent fanout synthesis check: delegate exactly two bounded subagents sequentially using sessions_spawn, not ACP.";
    const messages: Array<Record<string, unknown>> = [makeAnthropicUserText(prompt)];
    const request = async () => {
      const response = await expectAnthropicMessages(server, {
        tools: [
          {
            name: "sessions_spawn",
            input_schema: { type: "object", properties: {} },
          },
        ],
        messages,
      });
      return (await response.json()) as {
        stop_reason: string;
        content: Array<Record<string, unknown>>;
      };
    };
    const appendResult = (toolUse: Record<string, unknown>, childSessionKey: string) => {
      messages.push(
        { role: "assistant", content: [toolUse] },
        makeAnthropicToolResult(
          toolUse.id,
          JSON.stringify({ status: "accepted", childSessionKey }),
        ),
      );
    };

    const alpha = (await request()).content.find((block) => block.type === "tool_use");
    if (!alpha || typeof alpha.id !== "string") {
      throw new Error("Expected first Anthropic sessions_spawn tool_use block");
    }
    appendResult(alpha, "alpha");
    const beta = (await request()).content.find((block) => block.type === "tool_use");
    if (!beta || typeof beta.id !== "string") {
      throw new Error("Expected second Anthropic sessions_spawn tool_use block");
    }
    appendResult(beta, "beta");

    const final = await request();
    expect(final.stop_reason).toBe("end_turn");
    expect(final.content.find((block) => block.type === "text")?.text).toBe(
      "subagent-1: ok\nsubagent-2: ok",
    );
  });

  it.each([
    {
      name: "system string",
      system:
        "Current source visible reply MUST use `message(action=send)`; final text is private. Skip tool = user gets nothing.",
    },
    {
      name: "system text blocks",
      system: [
        {
          type: "text" as const,
          text: "Current source visible reply MUST use `message(action=send)`; final text is private. Skip tool = user gets nothing.",
        },
      ],
    },
  ])(
    "delivers Anthropic private fanout results through the message tool ($name)",
    async ({ system }) => {
      const server = await startMockServer();
      const messages: Array<Record<string, unknown>> = [
        makeAnthropicUserText(
          "Subagent fanout synthesis check: delegate exactly two bounded subagents sequentially using sessions_spawn, not ACP.",
        ),
      ];
      const request = async () => {
        const response = await expectAnthropicMessages(server, {
          system,
          tools: [
            { name: "sessions_spawn", input_schema: { type: "object", properties: {} } },
            { name: "message", input_schema: { type: "object", properties: {} } },
          ],
          messages,
        });
        return (await response.json()) as {
          stop_reason: string;
          content: Array<Record<string, unknown>>;
        };
      };
      const appendResult = (toolUse: Record<string, unknown>, result: Record<string, unknown>) => {
        messages.push(
          { role: "assistant", content: [toolUse] },
          makeAnthropicToolResult(toolUse.id, JSON.stringify(result)),
        );
      };

      for (const [label, marker] of [
        ["qa-fanout-alpha", "ALPHA-OK"],
        ["qa-fanout-beta", "BETA-OK"],
      ] as const) {
        const spawned = await request();
        expect(spawned.stop_reason).toBe("tool_use");
        const toolUse = spawned.content.find((block) => block.type === "tool_use");
        expect(toolUse).toMatchObject({ name: "sessions_spawn", input: { label } });
        if (!toolUse || typeof toolUse.id !== "string") {
          throw new Error(`Expected Anthropic ${label} sessions_spawn tool_use block`);
        }
        appendResult(toolUse, { status: "accepted", childSessionKey: label, note: marker });
      }

      const delivered = await request();
      expect(delivered.stop_reason).toBe("tool_use");
      const messageToolUse = delivered.content.find((block) => block.type === "tool_use");
      expect(messageToolUse).toMatchObject({
        name: "message",
        input: { action: "send", message: "subagent-1: ok\nsubagent-2: ok" },
      });
      if (!messageToolUse || typeof messageToolUse.id !== "string") {
        throw new Error("Expected Anthropic fanout message tool_use block");
      }
      appendResult(messageToolUse, { ok: true, messageId: "qa-fanout-final" });

      const settled = await request();
      expect(settled.stop_reason).toBe("end_turn");
      expect(settled.content).toEqual([{ type: "text", text: "" }]);
    },
  );

  it("preserves Anthropic /v1/messages declared tools for explicit sessions_spawn prompts", async () => {
    const server = await startMockServer();

    const body = (await expectAnthropicMessagesJson(server, {
      tools: [
        {
          name: "sessions_spawn",
          input_schema: { type: "object", properties: {} },
        },
      ],
      messages: [makeAnthropicUserText(explicitSessionsSpawnPrompt("QA_SUBAGENT_CHILD_ANTHROPIC"))],
    })) as {
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

    const debugPayload = requireRecord(
      await getJson(server, "/debug/last-request"),
      "debug request",
    );
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
    const server = await startMockServer();

    const body = (await expectAnthropicMessagesJson(server, {
      messages: [
        makeAnthropicUserText(
          "Delegate one bounded QA task to a subagent, wait for it to finish, then reply with Delegated task, Result, and Evidence sections.",
        ),
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
        makeAnthropicToolResult("toolu_mock_spawn_1", "SUBAGENT-OK"),
      ],
    })) as {
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
    const server = await startMockServer();

    await expectAnthropicMessages(server, {
      messages: [
        makeAnthropicUserText("Delegate one bounded QA task to a subagent."),
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
    });

    const debug = (await fetchOkJson(`${server.baseUrl}/debug/last-request`)) as {
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
    const server = await startMockServer();

    await expectAnthropicMessages(server, {
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
        makeAnthropicErrorToolResult("toolu_mock_read_error", "ENOENT: no such file or directory"),
      ],
    });

    const debug = (await fetchOkJson(`${server.baseUrl}/debug/last-request`)) as {
      toolOutputCallId: string;
      toolOutputStructuredError?: boolean;
    };
    expect(debug.toolOutputCallId).toBe("toolu_mock_read_error");
    expect(debug.toolOutputStructuredError).toBe(true);
  });

  it.each([
    { label: "empty", content: "", isError: false },
    { label: "whitespace", content: "  ", isError: false },
    { label: "empty failed", content: [], isError: true },
  ])("preserves $label Anthropic tool results without replay", async ({ content, isError }) => {
    const server = await startMockServer();
    const callId = "toolu_empty_patch";
    const response = await expectAnthropicMessages(server, {
      tools: [{ name: "apply_patch", input_schema: { type: "object", properties: {} } }],
      messages: [
        makeAnthropicUserText(
          "tool search qa check target=apply_patch. Call apply_patch exactly once and then summarize.",
        ),
        {
          role: "assistant",
          content: [{ type: "tool_use", id: callId, name: "apply_patch", input: {} }],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: callId,
              content,
              ...(isError ? { is_error: true } : {}),
            },
          ],
        },
      ],
    });

    const body = requireRecord(await response.json(), "Anthropic empty tool completion");
    expect(body.stop_reason).toBe("end_turn");
    expect(requireArray(body.content, "Anthropic response content")).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ type: "tool_use" })]),
    );
    const debug = requireRecord(
      await fetch(`${server.baseUrl}/debug/last-request`).then((result) => result.json()),
      "Anthropic empty tool debug request",
    );
    expect(debug.toolOutputCallId).toBe(callId);
    expect(debug.toolOutputStructuredError ?? false).toBe(isError);
    expect(debug).not.toHaveProperty("plannedToolName");
  });

  it("replays one signed Anthropic thinking error for each independent scenario", async () => {
    const server = await startMockServer();
    const readCallIds: string[] = [];
    const scenarioPrompts: string[] = [];

    const requestAnthropicStream = async (messages: unknown[]) => {
      const response = await expectAnthropicMessages(server, {
        stream: true,
        messages,
      });
      expect(response.headers.get("content-type")).toContain("text/event-stream");
      return response.text();
    };

    const readAnthropicToolCallId = (readStream: string) => {
      const readEvents = readStream
        .split("\n")
        .filter((line) => line.startsWith("data: "))
        .map((line) =>
          requireRecord(JSON.parse(line.slice("data: ".length)) as unknown, "Anthropic SSE event"),
        );
      const readEvent = readEvents.find(
        (event) =>
          event.type === "content_block_start" &&
          requireRecord(event.content_block, "Anthropic content block").type === "tool_use",
      );
      const readTool = requireRecord(readEvent?.content_block, "Anthropic read tool call");
      expect(readTool.name).toBe("read");
      expect(readTool.input).toEqual({});
      const readInputEvent = readEvents.find(
        (event) => event.type === "content_block_delta" && event.index === readEvent?.index,
      );
      expect(requireRecord(readInputEvent?.delta, "Anthropic read tool input delta")).toEqual({
        type: "input_json_delta",
        partial_json: JSON.stringify({ path: "QA_KICKOFF_TASK.md" }),
      });
      const callId = readTool.id;
      if (typeof callId !== "string" || callId.length === 0) {
        throw new Error("Expected an Anthropic read tool call ID");
      }
      readCallIds.push(callId);
      return callId;
    };

    const buildReplayMessages = (
      promptMessage: { role: "user"; content: Array<{ type: "text"; text: string }> },
      callId: string,
    ) => [
      promptMessage,
      {
        role: "assistant" as const,
        content: [
          {
            type: "tool_use" as const,
            id: callId,
            name: "read",
            input: { path: "QA_KICKOFF_TASK.md" },
          },
        ],
      },
      makeAnthropicToolResult(callId, "QA kickoff task completed."),
    ];

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const scenarioPrompt = `${QA_ANTHROPIC_THINKING_ERROR_RECOVERY_PROMPT} QA scenario run: direct-${attempt}`;
      scenarioPrompts.push(scenarioPrompt);
      const promptMessage = makeAnthropicUserText(scenarioPrompt);
      const initialCallId = readAnthropicToolCallId(await requestAnthropicStream([promptMessage]));
      const errorStream = await requestAnthropicStream(
        buildReplayMessages(promptMessage, initialCallId),
      );
      expect(errorStream).toContain('"type":"thinking_delta"');
      expect(errorStream).toContain('"type":"signature_delta"');
      expect(errorStream).toContain('"signature":"qa_signed_thinking_block_91953"');
      expect(errorStream).toContain("event: error");
      expect(errorStream).toContain('"type":"api_error"');

      const retryCallId = readAnthropicToolCallId(await requestAnthropicStream([promptMessage]));
      expect(retryCallId).not.toBe(initialCallId);
      const recoveryStream = await requestAnthropicStream(
        buildReplayMessages(promptMessage, retryCallId),
      );
      expect(recoveryStream).toContain("event: message_stop");
      expect(recoveryStream).toContain("ANTHROPIC-THINKING-ERROR-RECOVERED-OK");
      expect(recoveryStream).not.toContain("event: error");
    }

    expect(new Set(readCallIds).size).toBe(4);
    const debugRequests = requireArray(
      await getJson(server, "/debug/requests"),
      "Anthropic debug requests",
    ).map((request) => requireRecord(request, "Anthropic debug request"));
    expect(debugRequests).toHaveLength(8);
    expect(debugRequests.every((request) => request.providerVariant === "anthropic")).toBe(true);
    expect(debugRequests.map((request) => request.plannedToolCallId)).toEqual([
      readCallIds[0],
      undefined,
      readCallIds[1],
      undefined,
      readCallIds[2],
      undefined,
      readCallIds[3],
      undefined,
    ]);
    expect(debugRequests.map((request) => request.toolOutputCallId)).toEqual([
      undefined,
      readCallIds[0],
      undefined,
      readCallIds[1],
      undefined,
      readCallIds[2],
      undefined,
      readCallIds[3],
    ]);
    expect(debugRequests.map((request) => request.prompt)).toEqual([
      scenarioPrompts[0],
      scenarioPrompts[0],
      scenarioPrompts[0],
      scenarioPrompts[0],
      scenarioPrompts[1],
      scenarioPrompts[1],
      scenarioPrompts[1],
      scenarioPrompts[1],
    ]);
  });

  it("streams Anthropic /v1/messages tool_use responses as SSE", async () => {
    const server = await startMockServer();

    const response = await expectAnthropicMessages(server, {
      stream: true,
      tools: [
        {
          name: "read",
          input_schema: {
            type: "object",
            properties: { path: { type: "string" } },
            required: ["path"],
          },
        },
      ],
      messages: [
        makeAnthropicUserText(
          "Read the seeded docs and report worked, failed, blocked, and follow-up items.",
        ),
      ],
    });
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const body = await response.text();
    expect(body).toContain("event: message_start");
    expect(body).toContain("event: content_block_start");
    expect(body).toContain('"type":"tool_use"');
    expect(body).toContain('"name":"read"');
    expect(body).toContain("repo/docs/help/testing.md");
    expect(body).toContain("event: message_delta");
    expect(body).toContain("event: message_stop");
    const events = body
      .split("\n")
      .filter((line) => line.startsWith("data: "))
      .map((line) =>
        requireRecord(JSON.parse(line.slice("data: ".length)) as unknown, "Anthropic SSE event"),
      );
    const toolUseStart = events.find(
      (event) =>
        event.type === "content_block_start" &&
        requireRecord(event.content_block, "Anthropic SSE content block").type === "tool_use",
    );
    const toolUse = requireRecord(
      toolUseStart?.content_block,
      "Anthropic SSE tool_use content block",
    );
    expect(toolUse.id).toMatch(/^toolu[a-f0-9]{35}$/);
    expect(String(toolUse.id).length).toBeLessThanOrEqual(64);
    const debug = requireRecord(await getJson(server, "/debug/last-request"), "debug request");
    expect(debug.plannedToolCallId).toBe(toolUse.id);
  });

  it("streams Anthropic /v1/messages tool_result follow-ups as text deltas", async () => {
    const server = await startMockServer();

    const response = await expectAnthropicMessages(server, {
      stream: true,
      messages: [
        makeAnthropicUserText(
          "Delegate one bounded QA task to a subagent, wait for it to finish, then reply with Delegated task, Result, and Evidence sections.",
        ),
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
        makeAnthropicToolResult("toolu_mock_spawn_1", "SUBAGENT-OK"),
      ],
    });
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const body = await response.text();
    expect(body).toContain("event: content_block_delta");
    expect(body).toContain('"type":"text_delta"');
    expect(body).toContain("Delegated task");
    expect(body).toContain("Evidence");
  });

  it("keeps Anthropic remember prompts on the prose branch even when system text mentions HEARTBEAT", async () => {
    const server = await startMockServer();

    const response = await expectAnthropicMessages(server, {
      stream: true,
      system: [
        {
          type: "text",
          text: "Read HEARTBEAT.md if it exists (workspace context). Follow it strictly. If nothing needs attention, reply HEARTBEAT_OK.",
        },
      ],
      messages: [
        makeAnthropicUserText(
          "Please remember this fact for later: the QA canary code is ALPHA-7. Use your normal memory mechanism, avoid manual repo cleanup, and reply exactly `Remembered ALPHA-7.` once stored.",
        ),
      ],
    });

    const body = await response.text();
    expect(body).toContain("Remembered ALPHA-7.");
    expect(body).not.toContain("HEARTBEAT_OK");
    expect(body).not.toContain('"name":"read"');
  });

  it("prefers the prompt-local exact reply directive over heartbeat context", async () => {
    const server = await startMockServer();

    const response = await expectAnthropicMessages(server, {
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
        makeAnthropicUserText(
          "Please remember this fact for later: the QA canary code is ALPHA-7. Use your normal memory mechanism, avoid manual repo cleanup, and reply exactly `Remembered ALPHA-7.` once stored.",
        ),
      ],
    });

    const body = await response.text();
    expect(body).toContain("Remembered ALPHA-7.");
    expect(body).not.toContain("HEARTBEAT_OK");
  });

  it("rejects malformed or non-object Anthropic /v1/messages JSON", async () => {
    const server = await startMockServer();

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

    await fetchOk(`${server.baseUrl}/healthz`);
  });

  it("rejects malformed OpenAI-compatible JSON without crashing the mock server", async () => {
    const server = await startMockServer();

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

    await fetchOk(`${server.baseUrl}/healthz`);
  });

  it("defaults empty-string Anthropic /v1/messages model to claude-opus-4-8", async () => {
    // Regression for the loop-7 Copilot finding: a bare `typeof
    // body.model === "string"` check lets an empty-string model leak
    // through to `lastRequest.model` and `responseBody.model`. Empty
    // strings must be treated the same as absent and default to
    // `"claude-opus-4-8"` so parity consumers can trust the echoed label.
    const server = await startMockServer();

    const body = (await expectPostJsonJson(server, "/v1/messages", {
      model: "",
      max_tokens: 256,
      messages: [
        {
          role: "user",
          content: "Read the plan",
        },
      ],
    })) as { model: string };
    expect(body.model).toBe("claude-opus-4-8");

    const debug = (await fetchOkJson(`${server.baseUrl}/debug/last-request`)) as { model: string };
    expect(debug.model).toBe("claude-opus-4-8");
  });

  it("scripts a reasoning-only recovery sequence after a replay-safe read", async () => {
    const server = await startMockServer();

    const toolPlan = await expectOpenAiStreamingResponsesText(server, {
      input: [makeUserInput(QA_REASONING_ONLY_RECOVERY_PROMPT)],
    });
    expect(toolPlan).toContain('"name":"read"');
    expect(toolPlan).toContain("QA_KICKOFF_TASK.md");

    const reasoningPayload = await expectOpenAiNonStreamingResponsesJson<{
      output?: Array<{ type?: string; id?: string; summary?: Array<{ text?: string }> }>;
    }>(server, {
      input: [
        makeUserInput(QA_REASONING_ONLY_RECOVERY_PROMPT),
        makeToolOutput(
          "QA mission: Understand this OpenClaw repo from source + docs before acting.",
        ),
      ],
    });
    const reasoningOutput = outputItem(reasoningPayload);
    expect(reasoningOutput.type).toBe("reasoning");
    expect(reasoningOutput.id).toBe("rs_mock_reasoning_recovery");
    const reasoningSummary = requireArray(reasoningOutput.summary, "reasoning summary");
    expect(String(requireRecord(reasoningSummary[0], "reasoning summary 0").text)).toContain(
      "Need visible answer",
    );

    const recoveredPayload = await expectOpenAiNonStreamingResponsesJson<{
      output?: Array<{ content?: Array<{ text?: string }> }>;
    }>(server, {
      input: [
        makeUserInput(QA_REASONING_ONLY_RECOVERY_PROMPT),
        makeUserInput(QA_REASONING_ONLY_RETRY_INSTRUCTION),
        makeToolOutput(
          "QA mission: Understand this OpenClaw repo from source + docs before acting.",
        ),
      ],
    });
    expect(outputText(recoveredPayload)).toBe("REASONING-RECOVERED-OK");

    const requestLog = requireArray(await getJson(server, "/debug/requests"), "debug requests");
    expect(requireRecord(requestLog[0], "debug request 0").plannedToolName).toBe("read");
    expect(String(requireRecord(requestLog[1], "debug request 1").allInputText)).toContain(
      QA_REASONING_ONLY_RECOVERY_PROMPT,
    );
    expect(String(requireRecord(requestLog[2], "debug request 2").allInputText)).toContain(
      QA_REASONING_ONLY_RETRY_INSTRUCTION,
    );
  });

  it.each([
    { name: "default", primaryModel: "gpt-5.6-luna", fallbackModel: "gpt-5.6-luna-alt" },
    {
      name: "explicit",
      primaryModel: "mock-empty-primary",
      fallbackModel: "mock-visible-fallback",
    },
  ])("scripts mixed reasoning-plus-blank output for the $name model pair", async (models) => {
    const server = await startMockServer();

    const primary = await expectOpenAiNonStreamingResponsesJson(server, {
      model: models.primaryModel,
      input: [makeUserInput(QA_MIXED_REASONING_BLANK_FALLBACK_PROMPT)],
    });
    expect(outputItems(primary).map((item) => item.type)).toEqual(["reasoning", "message"]);
    expect(outputText(primary, 1)).toBe(" ");

    const fallback = await expectOpenAiNonStreamingResponsesJson(server, {
      model: models.fallbackModel,
      input: [makeUserInput(QA_MIXED_REASONING_BLANK_FALLBACK_PROMPT)],
    });
    expect(outputText(fallback)).toBe("MODEL-FALLBACK-VISIBLE-OK");
  });

  it("scripts the GPT-5.6 Luna thinking visibility switch prompts", async () => {
    const server = await startMockServer();

    const offPayload = await expectOpenAiNonStreamingResponsesJson<{
      output?: Array<{ type?: string; content?: Array<{ text?: string }> }>;
    }>(server, {
      input: [makeUserInput(QA_THINKING_VISIBILITY_OFF_PROMPT)],
    });
    expect(outputItem(offPayload).type).toBe("message");
    expect(outputText(offPayload)).toBe("THINKING-OFF-OK");

    const maxPayload = await expectOpenAiNonStreamingResponsesJson<{
      output?: Array<{
        type?: string;
        id?: string;
        summary?: Array<{ text?: string }>;
        content?: Array<{ text?: string }>;
      }>;
    }>(server, {
      input: [makeUserInput(QA_THINKING_VISIBILITY_MAX_PROMPT)],
    });
    const maxReasoning = outputItem(maxPayload);
    expect(maxReasoning.type).toBe("reasoning");
    expect(maxReasoning.id).toBe("rs_mock_thinking_visibility_max");
    expect(maxReasoning.summary).toEqual([]);
    expect(outputItem(maxPayload, 1).type).toBe("message");
    expect(outputText(maxPayload, 1)).toBe("THINKING-MAX-OK");

    const maxStream = await expectOpenAiStreamingResponsesText(server, {
      input: [makeUserInput(QA_THINKING_VISIBILITY_MAX_PROMPT)],
    });
    expect(maxStream).toContain('"type":"response.output_text.delta"');
    expect(maxStream).toContain('"delta":"THINKING-MAX-OK"');
  });

  it("keeps stale thinking visibility prompts from overriding later marker turns", async () => {
    const server = await startMockServer();

    const payload = await expectOpenAiNonStreamingResponsesJson<{
      output?: Array<{ content?: Array<{ text?: string }> }>;
    }>(server, {
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

    const toolPlan = await expectOpenAiStreamingResponsesText(server, {
      input: [makeUserInput(QA_REASONING_ONLY_SIDE_EFFECT_PROMPT)],
    });
    expect(toolPlan).toContain('"name":"write"');
    expect(toolPlan).toContain("reasoning-only-side-effect.txt");

    const sideEffectPayload = await expectOpenAiNonStreamingResponsesJson<{
      output?: Array<{ type?: string; id?: string }>;
    }>(server, {
      input: [
        makeUserInput(QA_REASONING_ONLY_SIDE_EFFECT_PROMPT),
        makeToolOutput("Successfully wrote 28 bytes to reasoning-only-side-effect.txt."),
      ],
    });
    const sideEffectOutput = outputItem(sideEffectPayload);
    expect(sideEffectOutput.type).toBe("reasoning");
    expect(sideEffectOutput.id).toBe("rs_mock_reasoning_side_effect");

    const requests = await fetchOk(`${server.baseUrl}/debug/requests`);
    expect((await requests.json()) as Array<{ allInputText?: string }>).toHaveLength(2);
  });

  it("scripts an empty-response recovery sequence after a replay-safe read", async () => {
    const server = await startMockServer();

    const toolPlan = await expectOpenAiStreamingResponsesText(server, {
      input: [makeUserInput(QA_EMPTY_RESPONSE_RECOVERY_PROMPT)],
    });
    expect(toolPlan).toContain('"name":"read"');

    const emptyPayload = await expectOpenAiNonStreamingResponsesJson<{
      output?: Array<{ content?: Array<{ type?: string; text?: string }> }>;
    }>(server, {
      input: [
        makeUserInput(QA_EMPTY_RESPONSE_RECOVERY_PROMPT),
        makeToolOutput(
          "QA mission: Understand this OpenClaw repo from source + docs before acting.",
        ),
      ],
    });
    const emptyContent = outputContentItem(emptyPayload);
    expect(emptyContent.type).toBe("output_text");
    expect(emptyContent.text).toBe("");

    const recoveredPayload = await expectOpenAiNonStreamingResponsesJson<{
      output?: Array<{ content?: Array<{ text?: string }> }>;
    }>(server, {
      input: [
        makeUserInput(QA_EMPTY_RESPONSE_RECOVERY_PROMPT),
        makeUserInput(QA_SETTLED_TOOL_TERMINAL_CONTINUATION_INSTRUCTION),
        makeToolOutput(
          "QA mission: Understand this OpenClaw repo from source + docs before acting.",
        ),
      ],
    });
    expect(outputText(recoveredPayload)).toBe("EMPTY-RECOVERED-OK");
  });

  it("can keep emitting empty GPT turns when the single retry budget should exhaust", async () => {
    const server = await startMockServer();

    await expectOpenAiStreamingResponsesText(server, {
      input: [makeUserInput(QA_EMPTY_RESPONSE_EXHAUSTION_PROMPT)],
    });

    const firstEmpty = await expectOpenAiNonStreamingResponsesJson<{
      output?: Array<{ content?: Array<{ text?: string }> }>;
    }>(server, {
      input: [
        makeUserInput(QA_EMPTY_RESPONSE_EXHAUSTION_PROMPT),
        makeToolOutput(
          "QA mission: Understand this OpenClaw repo from source + docs before acting.",
        ),
      ],
    });
    expect(firstEmpty.output?.[0]?.content?.[0]?.text).toBe("");

    const secondEmpty = await expectOpenAiNonStreamingResponsesJson<{
      output?: Array<{ content?: Array<{ text?: string }> }>;
    }>(server, {
      input: [
        makeUserInput(QA_EMPTY_RESPONSE_EXHAUSTION_PROMPT),
        makeUserInput(QA_EMPTY_RESPONSE_RETRY_INSTRUCTION),
        makeToolOutput(
          "QA mission: Understand this OpenClaw repo from source + docs before acting.",
        ),
      ],
    });
    expect(secondEmpty.output?.[0]?.content?.[0]?.text).toBe("");
  });

  it("scripts settled continuation after an empty response from a side-effecting write", async () => {
    const server = await startMockServer();

    const toolPlan = await expectOpenAiStreamingResponsesText(server, {
      input: [makeUserInput(QA_EMPTY_RESPONSE_SIDE_EFFECT_RECOVERY_PROMPT)],
    });
    expect(toolPlan).toContain('"name":"write"');

    const toolOutput = {
      type: "function_call_output" as const,
      output: "Successfully wrote 27 bytes to qa-empty-response-side-effect.txt",
    };
    const emptyPayload = await expectOpenAiNonStreamingResponsesJson<{
      output?: Array<{ content?: Array<{ text?: string }> }>;
    }>(server, {
      input: [makeUserInput(QA_EMPTY_RESPONSE_SIDE_EFFECT_RECOVERY_PROMPT), toolOutput],
    });
    expect(emptyPayload.output?.[0]?.content?.[0]?.text).toBe("");

    const recoveredPayload = await expectOpenAiNonStreamingResponsesJson<{
      output?: Array<{ content?: Array<{ text?: string }> }>;
    }>(server, {
      input: [
        makeUserInput(QA_EMPTY_RESPONSE_SIDE_EFFECT_RECOVERY_PROMPT),
        makeUserInput(QA_SETTLED_TOOL_TERMINAL_CONTINUATION_INSTRUCTION),
        toolOutput,
      ],
    });
    expect(outputText(recoveredPayload)).toBe("TELEGRAM-EMPTY-WRITE-RECOVERED-OK");

    const cronRecoveredPayload = await expectOpenAiNonStreamingResponsesJson<{
      output?: Array<{ content?: Array<{ text?: string }> }>;
    }>(server, {
      input: [
        makeUserInput(
          [
            "Empty response after write recovery QA check: write once, then respond with exact marker: `CRON-EMPTY-WRITE-RECOVERED-OK`.",
            "This is an unattended scheduled run. If nothing needs doing, reply exactly HEARTBEAT_OK.",
          ].join("\n\n"),
        ),
        makeUserInput(
          `${QA_SETTLED_TOOL_TERMINAL_CONTINUATION_INSTRUCTION}\nRead HEARTBEAT.md if it exists.`,
        ),
        toolOutput,
      ],
    });
    expect(outputText(cronRecoveredPayload)).toBe("CRON-EMPTY-WRITE-RECOVERED-OK");

    const laterHeartbeatPayload = await expectOpenAiNonStreamingResponsesJson<{
      output?: Array<{ content?: Array<{ text?: string }> }>;
    }>(server, {
      input: [
        makeUserInput(QA_EMPTY_RESPONSE_SIDE_EFFECT_RECOVERY_PROMPT),
        makeUserInput(QA_SETTLED_TOOL_TERMINAL_CONTINUATION_INSTRUCTION),
        toolOutput,
        makeUserInput("Read HEARTBEAT.md if it exists."),
      ],
    });
    expect(outputText(laterHeartbeatPayload)).toBe("HEARTBEAT_OK");
  });

  it("reports a failed Code Mode read honestly through ordinary continuation", async () => {
    const server = await startMockServer();
    const prompt =
      "Failed tool terminal recovery QA check: read the missing file, then respond with exact marker: `QA-FAILED-TOOL-FINALIZED-OK`.";
    const codeModeTools = [
      {
        type: "function",
        name: "exec",
        parameters: {
          type: "object",
          properties: { code: { type: "string" } },
          required: ["code"],
        },
      },
      {
        type: "function",
        name: "wait",
        parameters: {
          type: "object",
          properties: { runId: { type: "string" } },
          required: ["runId"],
        },
      },
    ];

    const toolPlan = await postStreamingResponses(server, {
      model: "gpt-5.6-luna",
      tools: codeModeTools,
      input: [makeUserInput(prompt)],
    });
    const plannedResponse = await toolPlan.text();
    expect(plannedResponse).toContain('"name":"exec"');
    expect(plannedResponse).toContain("qa-failed-terminal-missing-file.txt");
    const plannedRequest = requireRecord(
      await (await fetch(`${server.baseUrl}/debug/last-request`)).json(),
      "failed terminal tool plan",
    );
    expect(plannedRequest.plannedToolName).toBe("read");
    expect(plannedRequest.plannedWireToolName).toBe("exec");

    const failedToolOutput = makeToolOutputWithCallId(
      String(plannedRequest.plannedToolCallId),
      JSON.stringify({ status: "failed", error: "ENOENT: qa-failed-terminal-missing-file.txt" }),
    );
    const recovered = await expectNonStreamingResponsesJson<{
      output?: Array<{ content?: Array<{ text?: string }> }>;
    }>(server, {
      model: "gpt-5.6-luna",
      tools: codeModeTools,
      input: [makeUserInput(prompt), failedToolOutput],
    });
    expect(outputText(recovered)).toBe(
      "The requested file could not be read: ENOENT. QA-FAILED-TOOL-FINALIZED-OK",
    );

    const succeeded = await expectNonStreamingResponsesJson<{
      output?: Array<{ content?: Array<{ text?: string }> }>;
    }>(server, {
      model: "gpt-5.6-luna",
      tools: codeModeTools,
      input: [
        makeUserInput(prompt),
        makeToolOutputWithCallId(String(plannedRequest.plannedToolCallId), "file contents"),
      ],
    });
    expect(outputText(succeeded)).toBe("BUG-TOOL-DID-NOT-FAIL");
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
      tools: [SESSIONS_SPAWN_TOOL],
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
      tools: [SESSIONS_SPAWN_TOOL],
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

  it.each([
    {
      name: "records providerVariant on /debug/last-request for openai requests",
      path: "/v1/responses",
      body: {
        model: "openai/gpt-5.6-luna",
        stream: false,
        input: [makeUserInput("Heartbeat check")],
      },
      expectedModel: "openai/gpt-5.6-luna",
      expectedVariant: "openai",
    },
    {
      name: "records providerVariant=anthropic on /v1/messages requests",
      path: "/v1/messages",
      body: {
        model: "claude-opus-4-8",
        max_tokens: 256,
        messages: [{ role: "user", content: "Heartbeat check" }],
      },
      expectedModel: "claude-opus-4-8",
      expectedVariant: "anthropic",
    },
    {
      name: "records providerVariant=unknown for unrecognized models",
      path: "/v1/responses",
      body: {
        model: "mistral/mistral-large",
        stream: false,
        input: [makeUserInput("Heartbeat check")],
      },
      expectedModel: undefined,
      expectedVariant: "unknown",
    },
  ])("$name", async ({ path, body, expectedModel, expectedVariant }) => {
    const server = await startMockServer();
    await postJson(server, path, body);

    const debug = (await (await fetch(`${server.baseUrl}/debug/last-request`)).json()) as {
      model?: string;
      providerVariant: string;
    };
    if (expectedModel) {
      expect(debug.model).toBe(expectedModel);
    }
    expect(debug.providerVariant).toBe(expectedVariant);
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
