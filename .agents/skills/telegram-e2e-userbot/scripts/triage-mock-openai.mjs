#!/usr/bin/env node

import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";

const port = Number(process.env.MOCK_PORT || 19_882);
const requestLog = process.env.MOCK_REQUEST_LOG;
const scenario = process.env.E2E_TRIAGE_SCENARIO;

function writeJson(response, status, body) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

function writeEvents(response, events) {
  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-store",
    connection: "keep-alive",
  });
  for (const event of events) response.write(`data: ${JSON.stringify(event)}\n\n`);
  response.end("data: [DONE]\n\n");
}

function writeInterleavedMonologue(response) {
  writeEvents(response, [
    {
      id: "chatcmpl_interleaved_monologue",
      object: "chat.completion.chunk",
      choices: [
        {
          index: 0,
          delta: {
            role: "assistant",
            reasoning_details: [
              { type: "response.output_text", text: "PRIVATE_MONOLOGUE" },
              { type: "reasoning.text", text: "HIDDEN_REASONING" },
              { type: "response.text", text: "PUBLIC_FINAL" },
            ],
          },
          finish_reason: null,
        },
      ],
    },
    {
      id: "chatcmpl_interleaved_monologue",
      object: "chat.completion.chunk",
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    },
  ]);
}

function writeIncompleteToolUse(response) {
  writeEvents(response, [
    {
      id: "chatcmpl_incomplete_tool_use",
      object: "chat.completion.chunk",
      choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
    },
    {
      id: "chatcmpl_incomplete_tool_use",
      object: "chat.completion.chunk",
      choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
    },
  ]);
}

async function writeStreamingThrottle(response) {
  const itemId = "msg_streaming_throttle_107179";
  const finalText = "STREAM_FINAL_107179";
  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-store",
    connection: "keep-alive",
  });
  const previewEvents = [
    {
      type: "response.output_item.added",
      output_index: 0,
      item: {
        type: "message",
        id: itemId,
        role: "assistant",
        phase: "final_answer",
        status: "in_progress",
        content: [],
      },
    },
    ...["QA streaming ", "preview in ", "progress"].map((delta) => ({
      type: "response.output_text.delta",
      item_id: itemId,
      output_index: 0,
      content_index: 0,
      delta,
    })),
  ];
  for (const event of previewEvents) response.write(`data: ${JSON.stringify(event)}\n\n`);
  await new Promise((resolve) => setTimeout(resolve, 1_500));
  const item = {
    type: "message",
    id: itemId,
    role: "assistant",
    phase: "final_answer",
    status: "completed",
    content: [{ type: "output_text", text: finalText, annotations: [] }],
  };
  for (const event of [
    {
      type: "response.output_text.done",
      item_id: itemId,
      output_index: 0,
      content_index: 0,
      text: finalText,
    },
    { type: "response.output_item.done", output_index: 0, item },
    {
      type: "response.completed",
      response: {
        id: "resp_streaming_throttle_107179",
        status: "completed",
        output: [item],
        usage: { input_tokens: 32, output_tokens: 8, total_tokens: 40 },
      },
    },
  ]) {
    response.write(`data: ${JSON.stringify(event)}\n\n`);
  }
  response.end("data: [DONE]\n\n");
}

function responseEvents(text) {
  const item = {
    type: "message",
    id: "msg_telegram_triage_fixture",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text, annotations: [] }],
  };
  return [
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { ...item, status: "in_progress", content: [] },
    },
    {
      type: "response.output_text.delta",
      item_id: item.id,
      output_index: 0,
      content_index: 0,
      delta: text,
    },
    {
      type: "response.output_text.done",
      item_id: item.id,
      output_index: 0,
      content_index: 0,
      text,
    },
    { type: "response.output_item.done", output_index: 0, item },
    {
      type: "response.completed",
      response: {
        id: "resp_telegram_triage_fixture",
        status: "completed",
        output: [item],
        usage: { input_tokens: 32, output_tokens: 8, total_tokens: 40 },
      },
    },
  ];
}

function toolCallEvents(sequence) {
  const args = JSON.stringify({ args: { id: "session_status", args: {} } });
  const suffix = createHash("sha256").update(`${sequence}:${args}`).digest("hex").slice(0, 10);
  const item = {
    type: "function_call",
    id: `fc_tool_call_${suffix}`,
    call_id: `call_tool_call_${suffix}`,
    name: "tool_call",
    arguments: args,
  };
  return [
    { type: "response.output_item.added", output_index: 0, item: { ...item, arguments: "" } },
    {
      type: "response.function_call_arguments.delta",
      item_id: item.id,
      output_index: 0,
      delta: args,
    },
    { type: "response.output_item.done", output_index: 0, item },
    {
      type: "response.completed",
      response: {
        id: `resp_tool_call_${suffix}`,
        status: "completed",
        output: [item],
        usage: { input_tokens: 32, output_tokens: 8, total_tokens: 40 },
      },
    },
  ];
}

function namedToolCallEvents(name, args, sequence) {
  const argumentsText = JSON.stringify(args);
  const suffix = createHash("sha256")
    .update(`${name}:${sequence}:${argumentsText}`)
    .digest("hex")
    .slice(0, 10);
  const item = {
    type: "function_call",
    id: `fc_${name}_${suffix}`,
    call_id: `call_${name}_${suffix}`,
    name,
    arguments: argumentsText,
  };
  return [
    { type: "response.output_item.added", output_index: 0, item: { ...item, arguments: "" } },
    {
      type: "response.function_call_arguments.delta",
      item_id: item.id,
      output_index: 0,
      delta: argumentsText,
    },
    { type: "response.output_item.done", output_index: 0, item },
    {
      type: "response.completed",
      response: {
        id: `resp_${name}_${suffix}`,
        status: "completed",
        output: [item],
        usage: { input_tokens: 32, output_tokens: 8, total_tokens: 40 },
      },
    },
  ];
}

function hasTool(body, name) {
  return Array.isArray(body.tools) && body.tools.some((tool) => tool?.name === name);
}

function draftThenExecEvents() {
  const message = {
    type: "message",
    id: "msg_good_draft_115041",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text: "GOOD_DRAFT_115041", annotations: [] }],
  };
  const argumentsText = JSON.stringify({ command: "printf tool-ok" });
  const call = {
    type: "function_call",
    id: "fc_exec_115041",
    call_id: "call_exec_115041",
    name: "exec",
    arguments: argumentsText,
  };
  return [
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { ...message, status: "in_progress", content: [] },
    },
    {
      type: "response.output_text.delta",
      item_id: message.id,
      output_index: 0,
      content_index: 0,
      delta: "GOOD_DRAFT_115041",
    },
    {
      type: "response.output_text.done",
      item_id: message.id,
      output_index: 0,
      content_index: 0,
      text: "GOOD_DRAFT_115041",
    },
    { type: "response.output_item.done", output_index: 0, item: message },
    {
      type: "response.output_item.added",
      output_index: 1,
      item: { ...call, arguments: "" },
    },
    {
      type: "response.function_call_arguments.delta",
      item_id: call.id,
      output_index: 1,
      delta: argumentsText,
    },
    { type: "response.output_item.done", output_index: 1, item: call },
    {
      type: "response.completed",
      response: {
        id: "resp_good_draft_115041",
        status: "completed",
        output: [message, call],
        usage: { input_tokens: 32, output_tokens: 8, total_tokens: 40 },
      },
    },
  ];
}

function countFunctionOutputs(value) {
  if (Array.isArray(value)) return value.reduce((total, item) => total + countFunctionOutputs(item), 0);
  if (!value || typeof value !== "object") return 0;
  return (value.type === "function_call_output" ? 1 : 0) +
    Object.values(value).reduce((total, item) => total + countFunctionOutputs(item), 0);
}

const server = http.createServer((request, response) => {
  void (async () => {
    const url = new URL(request.url || "/", "http://127.0.0.1");
    if (request.method === "GET" && url.pathname === "/health") {
      writeJson(response, 200, { ok: true });
      return;
    }
    if (request.method === "GET" && url.pathname === "/v1/models") {
      writeJson(response, 200, {
        object: "list",
        data: ["gpt-5.5", "primary", "fallback"].map((id) => ({
          id,
          object: "model",
          owned_by: "openclaw-e2e",
        })),
      });
      return;
    }
    let bodyText = "";
    for await (const chunk of request) bodyText += chunk;
    if (requestLog) fs.appendFileSync(requestLog, `${bodyText}\n`);
    const body = bodyText ? JSON.parse(bodyText) : {};
    if (
      scenario === "interleaved-monologue" &&
      request.method === "POST" &&
      url.pathname === "/v1/chat/completions"
    ) {
      writeInterleavedMonologue(response);
      return;
    }
    if (
      scenario === "incomplete-tool-use" &&
      request.method === "POST" &&
      url.pathname === "/v1/chat/completions"
    ) {
      writeIncompleteToolUse(response);
      return;
    }
    if (request.method !== "POST" || url.pathname !== "/v1/responses") {
      writeJson(response, 404, { error: { message: "unhandled fixture route" } });
      return;
    }
    if (scenario === "streaming-throttle") {
      await writeStreamingThrottle(response);
      return;
    }
    if (scenario === "tool-search-double-wrap") {
      const outputCount = countFunctionOutputs(body.input);
      writeEvents(response, outputCount < 2 ? toolCallEvents(outputCount) : responseEvents("NO_REPLY"));
      return;
    }
    if (scenario === "model-fallback-room") {
      if (body.model === "primary") {
        response.setHeader("retry-after-ms", "0");
        writeJson(response, 503, {
          error: { type: "server_error", code: "server_error", message: "PRIMARY_ROUTE_UNAVAILABLE" },
        });
        return;
      }
      writeEvents(response, responseEvents("FALLBACK_ROUTE_OK"));
      return;
    }
    if (scenario === "yield-message-drop") {
      const inputText = JSON.stringify(body.input ?? []);
      if (inputText.includes("CHILD_DELAY_107788") && !hasTool(body, "sessions_yield")) {
        await new Promise((resolve) => setTimeout(resolve, 20_000));
        writeEvents(response, responseEvents("CHILD_COMPLETE_107788"));
        return;
      }
      const outputCount = countFunctionOutputs(body.input);
      if (outputCount === 0) {
        writeEvents(
          response,
          namedToolCallEvents(
            "sessions_spawn",
            {
              task: "Wait, then reply exactly CHILD_COMPLETE_107788. CHILD_DELAY_107788",
              taskName: "telegram-yield-repro",
              cleanup: "keep",
              context: "isolated",
            },
            0,
          ),
        );
        return;
      }
      writeEvents(
        response,
        namedToolCallEvents("sessions_yield", { message: "RESEARCH_STARTED_107788" }, outputCount),
      );
      return;
    }
    if (scenario === "edit-failure-recovery") {
      const outputCount = countFunctionOutputs(body.input);
      if (outputCount === 0) {
        writeEvents(
          response,
          namedToolCallEvents("write", { path: "repro-46548.txt", content: "alpha\n" }, 0),
        );
        return;
      }
      if (outputCount === 1) {
        writeEvents(
          response,
          namedToolCallEvents(
            "edit",
            { path: "repro-46548.txt", edits: [{ oldText: "beta", newText: "omega" }] },
            1,
          ),
        );
        return;
      }
      if (outputCount === 2) {
        writeEvents(
          response,
          namedToolCallEvents(
            "edit",
            { path: "repro-46548.txt", edits: [{ oldText: "alpha", newText: "omega" }] },
            2,
          ),
        );
        return;
      }
      writeEvents(response, responseEvents("EDIT_RECOVERY_DONE_46548"));
      return;
    }
    if (scenario === "terminal-no-reply-drops-draft") {
      const outputCount = countFunctionOutputs(body.input);
      writeEvents(
        response,
        outputCount === 0 ? draftThenExecEvents() : responseEvents("NO_REPLY"),
      );
      return;
    }
    if (scenario === "terminal-failure-after-success") {
      const outputCount = countFunctionOutputs(body.input);
      if (outputCount === 0) {
        writeEvents(
          response,
          namedToolCallEvents("write", { path: "repro-118489.txt", content: "alpha\n" }, 0),
        );
        return;
      }
      if (outputCount === 1) {
        writeEvents(
          response,
          namedToolCallEvents(
            "edit",
            { path: "repro-118489.txt", edits: [{ oldText: "missing", newText: "omega" }] },
            1,
          ),
        );
        return;
      }
      writeEvents(response, responseEvents("NO_REPLY"));
      return;
    }
    if (scenario === "cron-self-narration") {
      const prompt = JSON.stringify(body.input ?? []);
      const hasRecipientOnlyGuidance = prompt.includes("exact user-facing message to send");
      writeEvents(
        response,
        responseEvents(
          hasRecipientOnlyGuidance
            ? "SCHEDULE_CONFIRMED_90836"
            : "I sent the user: SCHEDULE_CONFIRMED_90836",
        ),
      );
      return;
    }
    writeJson(response, 500, { error: { message: `unknown E2E_TRIAGE_SCENARIO: ${scenario}` } });
  })().catch((error) => {
    writeJson(response, 500, {
      error: { message: error instanceof Error ? error.message : String(error) },
    });
  });
});

server.listen(port, "127.0.0.1", () => console.log(`mock-openai listening on ${port}`));
