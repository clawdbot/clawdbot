#!/usr/bin/env node

import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";

const port = Number(process.env.MOCK_PORT || 19_882);
const requestLog = process.env.MOCK_REQUEST_LOG;

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

function responseEvents(text) {
  const item = {
    type: "message",
    id: "msg_telegram_heartbeat_fixture",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text, annotations: [] }],
  };
  return [
    { type: "response.output_item.added", item: { ...item, status: "in_progress", content: [] } },
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
    { type: "response.output_item.done", item },
    {
      type: "response.completed",
      response: {
        id: "resp_telegram_heartbeat_fixture",
        status: "completed",
        output: [item],
        usage: { input_tokens: 32, output_tokens: 8, total_tokens: 40 },
      },
    },
  ];
}

function messageToolEvents() {
  const args = JSON.stringify({
    language: "javascript",
    code: [
      'const hit = ALL_TOOLS.find((entry) => entry.description.includes("Send/manage channel messages"));',
      'return await tools.callValue(hit.id, { action: "send", message: "HEARTBEAT_OK" });',
    ].join("\n"),
  });
  const suffix = createHash("sha256").update(args).digest("hex").slice(0, 10);
  const item = {
    type: "function_call",
    id: `fc_exec_${suffix}`,
    call_id: `call_exec_${suffix}`,
    name: "exec",
    arguments: args,
  };
  return [
    {
      type: "response.output_item.added",
      item: { ...item, arguments: "" },
    },
    { type: "response.function_call_arguments.delta", delta: args },
    { type: "response.output_item.done", item },
    {
      type: "response.completed",
      response: {
        id: `resp_exec_${suffix}`,
        status: "completed",
        output: [item],
        usage: { input_tokens: 32, output_tokens: 8, total_tokens: 40 },
      },
    },
  ];
}

function hasFunctionOutput(value) {
  if (Array.isArray(value)) return value.some(hasFunctionOutput);
  if (!value || typeof value !== "object") return false;
  if (value.type === "function_call_output") return true;
  return Object.values(value).some(hasFunctionOutput);
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
        data: [{ id: "gpt-5.5", object: "model", owned_by: "openclaw-e2e" }],
      });
      return;
    }
    let bodyText = "";
    for await (const chunk of request) bodyText += chunk;
    if (requestLog) fs.appendFileSync(requestLog, `${bodyText}\n`);
    const body = bodyText ? JSON.parse(bodyText) : {};
    if (request.method !== "POST" || url.pathname !== "/v1/responses") {
      writeJson(response, 404, { error: { message: "unhandled fixture route" } });
      return;
    }
    const heartbeat = /heartbeat proof/iu.test(bodyText);
    const execDeclared = /"name"\s*:\s*"exec"/u.test(bodyText);
    if (heartbeat && execDeclared && !hasFunctionOutput(body.input)) {
      writeEvents(response, messageToolEvents());
      return;
    }
    writeEvents(response, responseEvents(heartbeat ? "HEARTBEAT_FIXTURE_DONE" : "ROUTE_READY"));
  })().catch((error) => {
    writeJson(response, 500, {
      error: { message: error instanceof Error ? error.message : String(error) },
    });
  });
});

server.listen(port, "127.0.0.1", () => console.log(`mock-openai listening on ${port}`));
