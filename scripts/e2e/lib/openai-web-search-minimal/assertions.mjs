// Assertions for minimal OpenAI web-search E2E scenarios.
import fs from "node:fs";
import { readTextFileTail, tailText } from "../text-file-utils.mjs";

const command = process.argv[2];

const ERROR_DETAIL_TAIL_BYTES = 64 * 1024;
const REQUEST_LOG_SCAN_CHUNK_BYTES = 64 * 1024;
const RESPONSE_PREVIEW_BYTES = 8 * 1024;
const RESPONSE_PREVIEW_COUNT = 5;

function scanTextFileLines(file, onLine) {
  const fd = fs.openSync(file, "r");
  try {
    const buffer = Buffer.alloc(REQUEST_LOG_SCAN_CHUNK_BYTES);
    let carry = "";
    let lineNumber = 1;
    while (true) {
      const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (bytesRead <= 0) {
        break;
      }
      const text = carry + buffer.subarray(0, bytesRead).toString("utf8");
      const lines = text.split(/\r?\n/u);
      carry = lines.pop() ?? "";
      for (const line of lines) {
        onLine(line, lineNumber);
        lineNumber += 1;
      }
    }
    if (carry.length > 0) {
      onLine(carry, lineNumber);
    }
  } finally {
    fs.closeSync(fd);
  }
}

function scanSuccessRequest(logPath) {
  let responseCount = 0;
  let success;
  const recentResponses = [];
  scanTextFileLines(logPath, (line, lineNumber) => {
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }
    const entry = JSON.parse(trimmed);
    if (entry.method !== "POST" || entry.path !== "/v1/responses") {
      return;
    }
    responseCount += 1;
    const bodyText = JSON.stringify(entry.body);
    if (recentResponses.length >= RESPONSE_PREVIEW_COUNT) {
      recentResponses.shift();
    }
    recentResponses.push({
      line: lineNumber,
      bodyTail: tailText(bodyText, RESPONSE_PREVIEW_BYTES),
    });
    if (!success && bodyText.includes("OPENCLAW_SCHEMA_E2E_OK")) {
      success = entry;
    }
  });
  return { responseCount, success, recentResponses };
}

function assertPatchBehavior() {
  return import("../../../../dist/extensions/openai/native-web-search.js").then(
    ({ patchOpenAINativeWebSearchPayload }) => {
      const injectedPayload = {
        reasoning: { effort: "minimal", summary: "auto" },
      };
      const injectedResult = patchOpenAINativeWebSearchPayload(injectedPayload);
      if (injectedResult !== "injected") {
        throw new Error(`expected native web_search injection, got ${injectedResult}`);
      }
      if (injectedPayload.reasoning.effort !== "low") {
        throw new Error(
          `expected injected native web_search to raise minimal reasoning to low, got ${JSON.stringify(injectedPayload.reasoning)}`,
        );
      }
      if (!injectedPayload.tools?.some((tool) => tool?.type === "web_search")) {
        throw new Error(`native web_search was not injected: ${JSON.stringify(injectedPayload)}`);
      }

      const existingNativePayload = {
        tools: [{ type: "web_search" }],
        reasoning: { effort: "minimal" },
      };
      const existingResult = patchOpenAINativeWebSearchPayload(existingNativePayload);
      if (existingResult !== "native_tool_already_present") {
        throw new Error(`expected existing native web_search, got ${existingResult}`);
      }
      if (existingNativePayload.reasoning.effort !== "low") {
        throw new Error(
          `expected existing native web_search to raise minimal reasoning to low, got ${JSON.stringify(existingNativePayload.reasoning)}`,
        );
      }
    },
  );
}

function assertSuccessRequest() {
  const logPath = process.argv[3];
  const { responseCount, success, recentResponses } = scanSuccessRequest(logPath);
  if (responseCount < 1) {
    throw new Error(
      `mock OpenAI /v1/responses was not used. Request log tail: ${readTextFileTail(logPath, ERROR_DETAIL_TAIL_BYTES)}`,
    );
  }
  if (!success) {
    throw new Error(
      `missing success request. Recent /v1/responses: ${JSON.stringify(recentResponses)}`,
    );
  }
  const tools = Array.isArray(success.body.tools) ? success.body.tools : [];
  const hasNativeWebSearch = tools.some((tool) => tool?.type === "web_search");
  if (!hasNativeWebSearch) {
    throw new Error(
      `success request did not include native web_search. Body: ${JSON.stringify(success.body)}`,
    );
  }
  if (success.body.reasoning?.effort === "minimal") {
    throw new Error(
      `expected web_search request to avoid minimal reasoning, got ${JSON.stringify(success.body.reasoning)}`,
    );
  }
}

const commands = {
  "assert-patch-behavior": assertPatchBehavior,
  "assert-success-request": assertSuccessRequest,
};

const fn = commands[command];
if (!fn) {
  throw new Error(`unknown OpenAI web-search minimal assertion command: ${command}`);
}
await fn();
