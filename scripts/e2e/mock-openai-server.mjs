// Mock OpenAI-compatible server for broader E2E scenarios.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import http from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { escapeRegExp } from "../lib/regexp.mjs";
import { readPositiveIntEnv, readTcpPortEnv } from "./lib/env-limits.mjs";
import {
  boundedRequestLogBody,
  isRequestBodyTooLargeError,
  readBody,
  writeRequestLogEntryOrFail,
  writeJson,
  writeSse,
} from "./lib/mock-openai-http.mjs";

const port =
  process.env.MOCK_PORT != null
    ? readTcpPortEnv("MOCK_PORT")
    : readTcpPortEnv("OPENCLAW_MOCK_OPENAI_PORT");
const successMarker = process.env.SUCCESS_MARKER ?? "OPENCLAW_E2E_OK";
const requestLog = process.env.MOCK_REQUEST_LOG;
const initialResponseChunkDelayMs = process.env.MOCK_RESPONSE_CHUNK_DELAY_MS
  ? readPositiveIntEnv("MOCK_RESPONSE_CHUNK_DELAY_MS", undefined)
  : 0;
const responseControl = process.env.MOCK_RESPONSE_CONTROL;

function readCurrentResponse() {
  if (!responseControl) {
    return { text: successMarker, chunkDelayMs: initialResponseChunkDelayMs, hold: false };
  }
  const value = JSON.parse(readFileSync(responseControl, "utf8"));
  if (typeof value.text !== "string" || value.text.length === 0 || value.text.length > 100_000) {
    throw new Error("mock response control text is invalid");
  }
  const chunkDelayMs = value.chunkDelayMs ?? 0;
  if (!Number.isInteger(chunkDelayMs) || chunkDelayMs < 0 || chunkDelayMs > 60_000) {
    throw new Error("mock response control chunkDelayMs is invalid");
  }
  if (value.hold !== undefined && typeof value.hold !== "boolean") {
    throw new Error("mock response control hold is invalid");
  }
  return { text: value.text, chunkDelayMs, hold: value.hold ?? false };
}

async function currentResponse() {
  let response = readCurrentResponse();
  while (response.hold) {
    await delay(25);
    response = readCurrentResponse();
  }
  return response;
}

function splitResponseText(text) {
  if (text.length < 2) {
    return [text];
  }
  const midpoint = Math.floor(text.length / 2);
  const whitespace = text.lastIndexOf(" ", midpoint);
  const splitAt = whitespace > 0 ? whitespace : Math.max(1, midpoint);
  return [text.slice(0, splitAt), text.slice(splitAt)];
}

function responseEvents(text, deltas = [text]) {
  const itemId = "msg_e2e_1";
  return [
    {
      type: "response.output_item.added",
      item: {
        type: "message",
        id: itemId,
        role: "assistant",
        content: [],
        status: "in_progress",
      },
    },
    ...deltas.map((delta) => ({
      type: "response.output_text.delta",
      item_id: itemId,
      output_index: 0,
      content_index: 0,
      delta,
    })),
    {
      type: "response.output_text.done",
      item_id: itemId,
      output_index: 0,
      content_index: 0,
      text,
    },
    {
      type: "response.output_item.done",
      item: {
        type: "message",
        id: itemId,
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text, annotations: [] }],
      },
    },
    {
      type: "response.completed",
      response: {
        id: "resp_e2e",
        status: "completed",
        output: [
          {
            type: "message",
            id: itemId,
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text, annotations: [] }],
          },
        ],
        usage: {
          input_tokens: 11,
          output_tokens: 7,
          total_tokens: 18,
          input_tokens_details: { cached_tokens: 0 },
        },
      },
    },
  ];
}

async function writeDefaultResponseEvents(res, text, chunkDelayMs) {
  if (chunkDelayMs === 0) {
    writeSse(res, responseEvents(text));
    return;
  }
  const events = responseEvents(text, splitResponseText(text));
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-store",
    connection: "keep-alive",
  });
  let deltaCount = 0;
  for (const event of events) {
    if (event.type === "response.output_text.delta" && deltaCount > 0) {
      await delay(chunkDelayMs);
    }
    res.write(`data: ${JSON.stringify(event)}\n\n`);
    if (event.type === "response.output_text.delta") {
      deltaCount += 1;
    }
  }
  res.write("data: [DONE]\n\n");
  res.end();
}

function buildMockFunctionCall(name, args) {
  const serialized = JSON.stringify(args);
  const suffix = createHash("sha256")
    .update(name)
    .update("\0")
    .update(serialized)
    .digest("hex")
    .slice(0, 10);
  const callId = `call_mock_${name}_${suffix}`;
  const itemId = `fc_mock_${name}_${suffix}`;
  const item = {
    type: "function_call",
    id: itemId,
    call_id: callId,
    name,
    arguments: serialized,
  };
  return {
    item,
    itemId,
    responseId: `resp_mock_${name}_${suffix}`,
    serialized,
  };
}

// Progress-draft proof: assistant text emitted BEFORE a tool call is tagged as
// commentary, which channels render as the draft's status headline. Streaming
// text and then a call in one response is the only way to exercise
// headline-plus-tool-line composition without a live model.
// The Responses API carries that tag as `phase` on the message item, and the
// transport reads it straight off the item, so an untagged item produces no
// preamble at all and the scenario silently proves nothing.
function preambleThenToolCallEvents(preamble, name, args) {
  const messageItemId = "msg_e2e_preamble";
  const call = buildMockFunctionCall(name, args);
  return [
    {
      type: "response.output_item.added",
      item: {
        type: "message",
        id: messageItemId,
        role: "assistant",
        content: [],
        status: "in_progress",
      },
    },
    ...splitResponseText(preamble).map((delta) => ({
      type: "response.output_text.delta",
      item_id: messageItemId,
      output_index: 0,
      content_index: 0,
      delta,
    })),
    {
      type: "response.output_text.done",
      item_id: messageItemId,
      output_index: 0,
      content_index: 0,
      text: preamble,
    },
    {
      type: "response.output_item.done",
      item: {
        type: "message",
        id: messageItemId,
        role: "assistant",
        status: "completed",
        phase: "commentary",
        content: [{ type: "output_text", text: preamble, annotations: [] }],
      },
    },
    {
      type: "response.output_item.added",
      item: {
        type: "function_call",
        id: call.itemId,
        call_id: call.item.call_id,
        name,
        arguments: "",
      },
    },
    { type: "response.function_call_arguments.delta", delta: call.serialized },
    { type: "response.output_item.done", item: call.item },
    {
      type: "response.completed",
      response: {
        id: call.responseId,
        status: "completed",
        output: [
          {
            type: "message",
            id: messageItemId,
            role: "assistant",
            status: "completed",
            phase: "commentary",
            content: [{ type: "output_text", text: preamble, annotations: [] }],
          },
          call.item,
        ],
        usage: {
          input_tokens: 64,
          output_tokens: 24,
          total_tokens: 88,
          input_tokens_details: { cached_tokens: 0 },
        },
      },
    },
  ];
}

/** Two-turn draft scenario: preamble + shell call, then a final answer. */
function progressDraftEvents(body, bodyText) {
  const allText = collectText(body).join("\n");
  if (!allText.includes("OPENCLAW_E2E_DRAFTPROOF")) {
    return null;
  }
  if (!collectFunctionCallOutputText(body)) {
    if (!hasDeclaredTool(bodyText, "exec")) {
      return null;
    }
    return preambleThenToolCallEvents("Checking the workspace before answering.", "exec", {
      command: ["bash", "-lc", "sleep 3 && echo openclaw-draft-proof"],
    });
  }
  return responseEvents("OPENCLAW_E2E_DRAFTPROOF");
}

function toolCallEvents(name, args) {
  const call = buildMockFunctionCall(name, args);
  return [
    {
      type: "response.output_item.added",
      item: {
        type: "function_call",
        id: call.itemId,
        call_id: call.item.call_id,
        name,
        arguments: "",
      },
    },
    { type: "response.function_call_arguments.delta", delta: call.serialized },
    { type: "response.output_item.done", item: call.item },
    {
      type: "response.completed",
      response: {
        id: call.responseId,
        status: "completed",
        output: [call.item],
        usage: {
          input_tokens: 64,
          output_tokens: 16,
          total_tokens: 80,
          input_tokens_details: { cached_tokens: 0 },
        },
      },
    },
  ];
}

function writeResponsesEvents(res, stream, events) {
  if (stream === false) {
    const completed = events.find((event) => event.type === "response.completed");
    writeJson(res, 200, {
      id: completed?.response?.id ?? "resp_e2e",
      object: "response",
      status: "completed",
      output: completed?.response?.output ?? [],
      usage: completed?.response?.usage ?? {
        input_tokens: 64,
        output_tokens: 16,
        total_tokens: 80,
      },
    });
    return;
  }
  writeSse(res, events);
}

function writeChatCompletion(res, stream, text = successMarker) {
  if (stream) {
    writeSse(res, [
      {
        id: "chatcmpl_e2e",
        object: "chat.completion.chunk",
        choices: [{ index: 0, delta: { role: "assistant", content: text } }],
      },
      {
        id: "chatcmpl_e2e",
        object: "chat.completion.chunk",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      },
    ]);
    return;
  }
  writeJson(res, 200, {
    id: "chatcmpl_e2e",
    object: "chat.completion",
    choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
    usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
  });
}

/** Streams assistant content, then a tool call, in one chat-completions turn. */
function writeChatCompletionPreambleToolCall(res, stream, preamble, name, args) {
  const serialized = JSON.stringify(args);
  const callId = `call_mock_${name}_${createHash("sha256").update(name).update(serialized).digest("hex").slice(0, 10)}`;
  if (!stream) {
    writeJson(res, 200, {
      id: "chatcmpl_e2e",
      object: "chat.completion",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: preamble,
            tool_calls: [
              { id: callId, type: "function", function: { name, arguments: serialized } },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
      usage: { prompt_tokens: 24, completion_tokens: 18, total_tokens: 42 },
    });
    return;
  }
  writeSse(res, [
    {
      id: "chatcmpl_e2e",
      object: "chat.completion.chunk",
      choices: [{ index: 0, delta: { role: "assistant", content: "" } }],
    },
    ...splitResponseText(preamble).map((delta) => ({
      id: "chatcmpl_e2e",
      object: "chat.completion.chunk",
      choices: [{ index: 0, delta: { content: delta } }],
    })),
    {
      id: "chatcmpl_e2e",
      object: "chat.completion.chunk",
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              { index: 0, id: callId, type: "function", function: { name, arguments: serialized } },
            ],
          },
        },
      ],
    },
    {
      id: "chatcmpl_e2e",
      object: "chat.completion.chunk",
      choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
    },
  ]);
}

function writeImageGeneration(res) {
  writeJson(res, 200, {
    created: Math.floor(Date.now() / 1000),
    data: [
      {
        b64_json:
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+yf7kAAAAASUVORK5CYII=",
        mime_type: "image/png",
        revised_prompt: "openclaw mock image",
      },
    ],
  });
}

function resolveResponseText(bodyText) {
  const matches = Array.from(bodyText.matchAll(/\bOPENCLAW_E2E_[A-Z0-9]+(?:_[A-Z0-9]+)*\b/gu));
  return matches.at(-1)?.[0] ?? successMarker;
}

function collectText(value) {
  if (typeof value === "string") {
    return [value];
  }
  if (Array.isArray(value)) {
    return value.flatMap((entry) => collectText(entry));
  }
  if (!value || typeof value !== "object") {
    return [];
  }
  const texts = [];
  for (const key of ["text", "content", "output"]) {
    if (typeof value[key] === "string") {
      texts.push(value[key]);
    }
  }
  for (const nested of Object.values(value)) {
    if (nested && typeof nested === "object") {
      texts.push(...collectText(nested));
    }
  }
  return texts;
}

function stringifyFunctionCallOutput(output) {
  if (typeof output === "string") {
    return output;
  }
  try {
    return JSON.stringify(output);
  } catch {
    return "";
  }
}

function collectFunctionCallOutputText(body) {
  const input = Array.isArray(body?.input) ? body.input : [];
  return input
    .filter((item) => item?.type === "function_call_output")
    .map((item) => stringifyFunctionCallOutput(item.output))
    .filter(Boolean)
    .join("\n");
}

function hasDeclaredTool(bodyText, name) {
  return new RegExp(`"name"\\s*:\\s*"${escapeRegExp(name)}"`, "u").test(bodyText);
}

function mcpCodeModeApiFileEvents(body, bodyText) {
  const allText = collectText(body).join("\n");
  if (!/mcp code mode api file qa check/i.test(allText)) {
    return null;
  }
  const toolOutput = collectFunctionCallOutputText(body);
  if (!toolOutput) {
    if (!hasDeclaredTool(bodyText, "exec")) {
      return null;
    }
    return toolCallEvents("exec", {
      language: "javascript",
      code: [
        'const files = await API.list("mcp");',
        'const root = await API.read("mcp/index.d.ts");',
        'const api = await API.read("mcp/fixture.d.ts");',
        'const result = await MCP.fixture.lookupNote({ id: "alpha" });',
        "return {",
        '  marker: "MCP_CODE_MODE_FILE_TOOL_RESULT",',
        "  files: files.files.map((file) => file.path),",
        "  rootHasFixture: root.content.includes('fixture'),",
        "  headerHasLookup: api.content.includes('function lookupNote'),",
        "  resultText: result.content?.[0]?.text,",
        "  allHasMcp: catalog.all().some((tool) => tool.source === 'mcp'),",
        "};",
      ].join("\n"),
    });
  }
  if (
    !/MCP_CODE_MODE_FILE_TOOL_RESULT/.test(toolOutput) ||
    !/fixture-note-alpha/.test(toolOutput)
  ) {
    return responseEvents(
      "MCP_CODE_MODE_FILE_FAIL unclear=code-mode-exec-did-not-return-fixture-note",
    );
  }
  return responseEvents(
    "MCP_CODE_MODE_FILE_OK note=fixture-note-alpha unclear=none improvement=virtual-api-files-were-clear-and-needed-one-exec",
  );
}

function mcpAppConformanceEvents(body, bodyText) {
  const allText = collectText(body).join("\n");
  if (!/mcp app conformance qa check/i.test(allText)) {
    return null;
  }
  const toolOutput = collectFunctionCallOutputText(body);
  if (!toolOutput) {
    if (!hasDeclaredTool(bodyText, "fixture__show")) {
      return null;
    }
    return toolCallEvents("fixture__show", {});
  }
  return /initial-result/.test(toolOutput)
    ? responseEvents("MCP_APP_CONFORMANCE_READY")
    : responseEvents("MCP_APP_CONFORMANCE_FAIL");
}

function agentPluginBundleEvents(body, bodyText) {
  const allText = collectText(body).join("\n");
  if (!/agent plugin bundle qa check/i.test(allText)) {
    return null;
  }
  const toolOutput = collectFunctionCallOutputText(body);
  if (!toolOutput) {
    return hasDeclaredTool(bodyText, "weather-probe__weather_probe")
      ? toolCallEvents("weather-probe__weather_probe", {})
      : responseEvents("AGENT_BUNDLE_MCP_FAIL tool-not-declared");
  }
  return toolOutput.includes("probe ok") &&
    toolOutput.includes("PLUGIN_ROOT=") &&
    toolOutput.includes("PLUGIN_DATA=")
    ? responseEvents("AGENT_BUNDLE_MCP_OK")
    : responseEvents("AGENT_BUNDLE_MCP_FAIL unexpected-tool-output");
}

const server = http.createServer((req, res) => {
  void (async () => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (req.method === "GET" && url.pathname === "/health") {
      writeJson(res, 200, { ok: true });
      return;
    }
    if (req.method === "GET" && url.pathname === "/v1/models") {
      writeJson(res, 200, {
        object: "list",
        data: [{ id: "gpt-5.6-luna", object: "model", owned_by: "openclaw-e2e" }],
      });
      return;
    }

    let bodyText;
    try {
      bodyText = await readBody(req);
    } catch (error) {
      if (isRequestBodyTooLargeError(error)) {
        writeJson(res, 413, { error: { message: error.message } });
        return;
      }
      throw error;
    }
    let body;
    try {
      body = bodyText ? JSON.parse(bodyText) : {};
    } catch {
      body = {};
    }
    if (
      writeRequestLogEntryOrFail(res, {
        requestLog,
        entry: {
          method: req.method,
          path: url.pathname,
          body: boundedRequestLogBody(bodyText, bodyText),
        },
      })
    ) {
      return;
    }

    if (req.method === "POST" && url.pathname === "/v1/responses") {
      if (!responseControl) {
        const agentBundleEvents = agentPluginBundleEvents(body, bodyText);
        if (agentBundleEvents) {
          writeResponsesEvents(res, body.stream, agentBundleEvents);
          return;
        }
        const appEvents = mcpAppConformanceEvents(body, bodyText);
        if (appEvents) {
          writeResponsesEvents(res, body.stream, appEvents);
          return;
        }
        const codeModeEvents = mcpCodeModeApiFileEvents(body, bodyText);
        if (codeModeEvents) {
          writeResponsesEvents(res, body.stream, codeModeEvents);
          return;
        }
        const draftEvents = progressDraftEvents(body, bodyText);
        if (draftEvents) {
          writeResponsesEvents(res, body.stream, draftEvents);
          return;
        }
      }
      const response = await currentResponse();
      const responseText = responseControl ? response.text : resolveResponseText(bodyText);
      if (body.stream === false) {
        writeJson(res, 200, {
          id: "resp_e2e",
          object: "response",
          status: "completed",
          output: [
            {
              type: "message",
              id: "msg_e2e_1",
              role: "assistant",
              status: "completed",
              content: [{ type: "output_text", text: responseText, annotations: [] }],
            },
          ],
          usage: { input_tokens: 11, output_tokens: 7, total_tokens: 18 },
        });
        return;
      }
      await writeDefaultResponseEvents(res, responseText, response.chunkDelayMs);
      return;
    }

    if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
      // Progress-draft proof needs assistant content followed by a tool call in
      // one streamed turn: the completions transport tags that leading text as
      // commentary, which channels render as the draft status headline.
      if (!responseControl && bodyText.includes("OPENCLAW_E2E_DRAFTPROOF")) {
        const messages = Array.isArray(body.messages) ? body.messages : [];
        const toolTurnDone = messages.some((message) => message?.role === "tool");
        if (!toolTurnDone) {
          writeChatCompletionPreambleToolCall(
            res,
            body.stream !== false,
            "Checking the workspace before answering.",
            "exec",
            { command: ["bash", "-lc", "sleep 3 && echo openclaw-draft-proof"] },
          );
          return;
        }
        // Hold the final answer so the turn outlives the progress-draft start
        // gate. Without this the whole turn finishes in well under a second and
        // no draft is created, which is correct behavior but proves nothing.
        await delay(readPositiveIntEnv("MOCK_DRAFTPROOF_FINAL_DELAY_MS", 6000));
        writeChatCompletion(res, body.stream !== false, "OPENCLAW_E2E_DRAFTPROOF");
        return;
      }
      const response = await currentResponse();
      const responseText = responseControl ? response.text : resolveResponseText(bodyText);
      writeChatCompletion(res, body.stream !== false, responseText);
      return;
    }

    if (req.method === "POST" && url.pathname === "/v1/embeddings") {
      const input = Array.isArray(body.input) ? body.input : [body.input ?? ""];
      writeJson(res, 200, {
        object: "list",
        data: input.map((_, index) => ({
          object: "embedding",
          index,
          embedding: [1, index / 100, 0, 0],
        })),
        model: body.model ?? "text-embedding-3-small",
        usage: { prompt_tokens: input.length, total_tokens: input.length },
      });
      return;
    }

    if (
      req.method === "POST" &&
      (url.pathname === "/v1/images/generations" || url.pathname === "/v1/images/edits")
    ) {
      writeImageGeneration(res);
      return;
    }

    writeJson(res, 404, {
      error: { message: `unhandled mock route: ${req.method} ${url.pathname}` },
    });
  })().catch((/** @type {unknown} */ error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`mock-openai request handler failed: ${message}`);
    if (!res.headersSent) {
      writeJson(res, 500, { error: { message: `mock OpenAI handler failed: ${message}` } });
      return;
    }
    res.destroy(error instanceof Error ? error : new Error(message));
  });
});

server.listen(port, "127.0.0.1", () => {
  console.log(`mock-openai listening on ${port}`);
});
