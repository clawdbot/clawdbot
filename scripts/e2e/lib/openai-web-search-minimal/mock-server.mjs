import fs from "node:fs";
import http from "node:http";

const port = Number(process.env.MOCK_PORT);
const requestLog = process.env.MOCK_REQUEST_LOG;
const successMarker = process.env.SUCCESS_MARKER;
const rawSchemaError = process.env.RAW_SCHEMA_ERROR;

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

function writeOpenAiReject(res) {
  writeJson(res, 400, {
    error: {
      message: rawSchemaError.replace(/^400\s+/, ""),
      type: "invalid_request_error",
      code: "invalid_request_error",
    },
  });
}

function hasWebSearchTool(tools) {
  return (
    Array.isArray(tools) &&
    tools.some((tool) => {
      if (!tool || typeof tool !== "object") {
        return false;
      }
      if (tool.type === "web_search") {
        return true;
      }
      if (tool.type === "function" && tool.name === "web_search") {
        return true;
      }
      if (tool.type === "function" && tool.function?.name === "web_search") {
        return true;
      }
      return false;
    })
  );
}

function bodyContainsForceReject(body) {
  return JSON.stringify(body).includes("FORCE_SCHEMA_REJECT");
}

function responseEvents(text) {
  return [
    {
      type: "response.output_item.added",
      item: {
        type: "message",
        id: "msg_schema_e2e_1",
        role: "assistant",
        content: [],
        status: "in_progress",
      },
    },
    {
      type: "response.output_item.done",
      item: {
        type: "message",
        id: "msg_schema_e2e_1",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text, annotations: [] }],
      },
    },
    {
      type: "response.completed",
      response: {
        id: "resp_schema_e2e_1",
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

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  if (req.method === "GET" && url.pathname === "/health") {
    writeJson(res, 200, { ok: true });
    return;
  }
  if (req.method === "GET" && url.pathname === "/v1/models") {
    writeJson(res, 200, {
      object: "list",
      data: [{ id: "gpt-5", object: "model", owned_by: "openclaw-e2e" }],
    });
    return;
  }

  const bodyText = await readBody(req);
  let body = {};
  try {
    body = bodyText ? JSON.parse(bodyText) : {};
  } catch {
    body = {};
  }
  fs.appendFileSync(
    requestLog,
    `${JSON.stringify({ method: req.method, path: url.pathname, body })}\n`,
  );

  if (req.method === "POST" && url.pathname === "/v1/responses") {
    if (bodyContainsForceReject(body)) {
      writeOpenAiReject(res);
      return;
    }
    if (body?.reasoning?.effort === "minimal" && hasWebSearchTool(body.tools)) {
      writeOpenAiReject(res);
      return;
    }
    writeSse(res, responseEvents(successMarker));
    return;
  }

  writeJson(res, 404, {
    error: { message: `unhandled mock route: ${req.method} ${url.pathname}` },
  });
});

server.listen(port, "127.0.0.1", () => {
  console.log(`mock-openai listening on ${port}`);
});
