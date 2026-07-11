// Mock OpenAI-compatible server for broader E2E scenarios.
import { createHash } from "node:crypto";
import http from "node:http";
import { escapeRegExp } from "../lib/regexp.mjs";
import { readTcpPortEnv } from "./lib/env-limits.mjs";
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

function responseEvents(text) {
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
    {
      type: "response.output_text.delta",
      item_id: itemId,
      output_index: 0,
      content_index: 0,
      delta: text,
    },
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
  const matches = Array.from(bodyText.matchAll(/\bOPENCLAW_E2E_OK(?:_\d+)?\b/gu));
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
        "  allHasMcp: ALL_TOOLS.some((tool) => tool.source === 'mcp'),",
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
      const codeModeEvents = mcpCodeModeApiFileEvents(body, bodyText);
      if (codeModeEvents) {
        writeResponsesEvents(res, body.stream, codeModeEvents);
        return;
      }
      const responseText = resolveResponseText(bodyText);
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
      writeSse(res, responseEvents(responseText));
      return;
    }

    if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
      const responseText = resolveResponseText(bodyText);
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
