import fs from "node:fs";
import http from "node:http";

const port = Number(process.env.MOCK_PORT ?? process.env.OPENCLAW_MOCK_OPENAI_PORT);
const successMarker = process.env.SUCCESS_MARKER ?? "OPENCLAW_E2E_OK";
const requestLog = process.env.MOCK_REQUEST_LOG;

if (!Number.isInteger(port) || port <= 0) {
  throw new Error("missing valid MOCK_PORT or OPENCLAW_MOCK_OPENAI_PORT");
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function writeJson(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function responseEvents(text) {
  return [
    {
      type: "response.output_item.added",
      item: {
        type: "message",
        id: "msg_e2e_1",
        role: "assistant",
        content: [],
        status: "in_progress",
      },
    },
    {
      type: "response.output_item.done",
      item: {
        type: "message",
        id: "msg_e2e_1",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text, annotations: [] }],
      },
    },
    {
      type: "response.completed",
      response: {
        status: "completed",
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

function writeSse(res, events) {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-store",
    connection: "keep-alive",
  });
  for (const event of events) {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  }
  res.write("data: [DONE]\n\n");
  res.end();
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

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  if (req.method === "GET" && url.pathname === "/health") {
    writeJson(res, 200, { ok: true });
    return;
  }
  if (req.method === "GET" && url.pathname === "/v1/models") {
    writeJson(res, 200, {
      object: "list",
      data: [{ id: "gpt-5.5", object: "model", owned_by: "openclaw-e2e" }],
    });
    return;
  }

  const bodyText = await readBody(req);
  if (requestLog) {
    fs.appendFileSync(
      requestLog,
      `${JSON.stringify({ method: req.method, path: url.pathname, body: bodyText })}\n`,
    );
  }
  let body = {};
  try {
    body = bodyText ? JSON.parse(bodyText) : {};
  } catch {
    body = {};
  }

  if (req.method === "POST" && url.pathname === "/v1/responses") {
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
});

server.listen(port, "127.0.0.1", () => {
  console.log(`mock-openai listening on ${port}`);
});
