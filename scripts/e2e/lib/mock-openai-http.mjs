// Mock OpenAI-compatible HTTP server helpers for E2E scenarios.
import fs from "node:fs";
import { readPositiveIntEnv } from "./env-limits.mjs";

const DEFAULT_REQUEST_MAX_BYTES = 4 * 1024 * 1024;
const DEFAULT_REQUEST_LOG_BODY_MAX_BYTES = 256 * 1024;
const REQUEST_LOG_PREVIEW_CHARS = 4096;

export function readMockOpenAiHttpLimits(env = process.env) {
  return {
    requestMaxBytes: readPositiveIntEnv(
      "OPENCLAW_MOCK_OPENAI_REQUEST_MAX_BYTES",
      DEFAULT_REQUEST_MAX_BYTES,
      env,
    ),
    requestLogBodyMaxBytes: readPositiveIntEnv(
      "OPENCLAW_MOCK_OPENAI_REQUEST_LOG_BODY_MAX_BYTES",
      DEFAULT_REQUEST_LOG_BODY_MAX_BYTES,
      env,
    ),
  };
}

function requestBodyTooLargeError(limit) {
  return Object.assign(new Error(`mock OpenAI request body exceeded ${limit} bytes`), {
    code: "ETOOBIG",
  });
}

export function isRequestBodyTooLargeError(error) {
  return error instanceof Error && error.code === "ETOOBIG";
}

export function readBody(req, limits = readMockOpenAiHttpLimits()) {
  const { requestMaxBytes } = limits;
  return new Promise((resolve, reject) => {
    let body = "";
    let bytes = 0;
    let settled = false;
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      if (settled) {
        return;
      }
      bytes += Buffer.byteLength(chunk, "utf8");
      if (bytes > requestMaxBytes) {
        settled = true;
        body = "";
        req.resume();
        reject(requestBodyTooLargeError(requestMaxBytes));
        return;
      }
      body += chunk;
    });
    req.on("end", () => {
      if (!settled) {
        settled = true;
        resolve(body);
      }
    });
    req.on("error", (error) => {
      if (!settled) {
        settled = true;
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  });
}

export function boundedRequestLogBody(value, bodyText, limits = readMockOpenAiHttpLimits()) {
  const { requestLogBodyMaxBytes } = limits;
  const byteLength = Buffer.byteLength(bodyText, "utf8");
  if (byteLength <= requestLogBodyMaxBytes) {
    return value;
  }
  return {
    truncated: true,
    byteLength,
    preview: bodyText.slice(0, REQUEST_LOG_PREVIEW_CHARS),
  };
}

export function writeRequestLogEntryOrFail(
  res,
  { requestLog, entry, label = "mock-openai", required = false },
) {
  if (!requestLog) {
    if (!required) {
      return false;
    }
    const message = "MOCK_REQUEST_LOG is not configured";
    console.error(`${label} request log write failed: ${message}`);
    writeJson(res, 500, { error: { message: `mock OpenAI request log write failed: ${message}` } });
    return true;
  }

  try {
    fs.appendFileSync(requestLog, `${JSON.stringify(entry)}\n`);
    return false;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`${label} request log write failed: ${message}`);
    writeJson(res, 500, { error: { message: `mock OpenAI request log write failed: ${message}` } });
    return true;
  }
}

export function writeJson(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

export function writeSse(res, events) {
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
