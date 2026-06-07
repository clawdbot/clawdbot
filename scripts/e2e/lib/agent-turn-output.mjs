// Helpers for extracting agent turn output from E2E protocol events.
import fs from "node:fs";
import { readTextFileTail, tailText } from "./text-file-utils.mjs";

const ERROR_DETAIL_TAIL_BYTES = 64 * 1024;
const OUTPUT_SCAN_TAIL_BYTES = 2 * 1024 * 1024;
const REPLY_TEXT_PREVIEW_BYTES = 8 * 1024;
const REPLY_TEXT_PREVIEW_COUNT = 5;
const REQUEST_LOG_SCAN_CHUNK_BYTES = 64 * 1024;
const REQUEST_LOG_SCAN_CARRY_CHARS = 256;
const OPENAI_REQUEST_PATH_PATTERN = /\/v1\/(responses|chat\/completions)/u;

function textByteLength(text) {
  return Buffer.byteLength(text, "utf8");
}

function summarizeReplyTexts(replyTexts) {
  const previewStart = Math.max(0, replyTexts.length - REPLY_TEXT_PREVIEW_COUNT);
  const recent = replyTexts.slice(previewStart).map((text, index) => ({
    index: previewStart + index,
    bytes: textByteLength(text),
    tail: tailText(text, REPLY_TEXT_PREVIEW_BYTES),
  }));
  return JSON.stringify({ count: replyTexts.length, recent });
}

function fileContainsPattern(file, pattern) {
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    return false;
  }
  if (!stat.isFile() || stat.size <= 0) {
    return false;
  }

  const fd = fs.openSync(file, "r");
  try {
    const buffer = Buffer.alloc(Math.min(REQUEST_LOG_SCAN_CHUNK_BYTES, stat.size));
    let carry = "";
    let offset = 0;
    while (offset < stat.size) {
      const bytesToRead = Math.min(buffer.length, stat.size - offset);
      const bytesRead = fs.readSync(fd, buffer, 0, bytesToRead, offset);
      if (bytesRead <= 0) {
        break;
      }
      offset += bytesRead;
      const text = carry + buffer.subarray(0, bytesRead).toString("utf8");
      if (pattern.test(text)) {
        return true;
      }
      carry = text.slice(-REQUEST_LOG_SCAN_CARRY_CHARS);
    }
    return false;
  } finally {
    fs.closeSync(fd);
  }
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function parseJsonObjectsFromText(text) {
  const payloads = [];
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (start === -1) {
      if (char === "{") {
        start = index;
        depth = 1;
        inString = false;
        escaped = false;
      }
      continue;
    }

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === "{") {
      depth += 1;
      continue;
    }
    if (char !== "}") {
      continue;
    }

    depth -= 1;
    if (depth === 0) {
      const parsed = parseJson(text.slice(start, index + 1));
      if (parsed !== undefined) {
        payloads.push(parsed);
      }
      start = -1;
    }
  }
  return payloads;
}

function parseJsonPayloads(text) {
  const trimmed = text.trim();
  if (!trimmed) {
    return [];
  }
  const parsed = parseJson(trimmed);
  if (parsed !== undefined) {
    return [parsed];
  }
  return parseJsonObjectsFromText(trimmed);
}

function textValues(values) {
  return values.filter((value) => typeof value === "string" && value.length > 0);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isFailureStatus(value) {
  return (
    typeof value === "string" &&
    ["blocked", "canceled", "cancelled", "error", "failed", "failure"].includes(value.toLowerCase())
  );
}

function hasFailureSignal(value) {
  if (!isRecord(value)) {
    return false;
  }
  return (
    value.isError === true ||
    value.ok === false ||
    isFailureStatus(value.status) ||
    isFailureStatus(value.livenessState) ||
    (Object.hasOwn(value, "error") && value.error !== null && value.error !== undefined)
  );
}

export function extractAgentReplyTexts(text) {
  return parseJsonPayloads(text).flatMap((payload) => {
    const envelopeFailed =
      hasFailureSignal(payload) ||
      hasFailureSignal(payload?.meta) ||
      hasFailureSignal(payload?.result) ||
      hasFailureSignal(payload?.result?.meta);
    if (envelopeFailed) {
      return [];
    }
    const payloadEntries = Array.isArray(payload?.payloads)
      ? payload.payloads
      : Array.isArray(payload?.result?.payloads)
        ? payload.result.payloads
        : [];
    const directTexts = textValues([
      payload?.finalAssistantVisibleText,
      payload?.finalAssistantRawText,
      payload?.meta?.finalAssistantVisibleText,
      payload?.meta?.finalAssistantRawText,
      payload?.result?.finalAssistantVisibleText,
      payload?.result?.finalAssistantRawText,
      payload?.result?.meta?.finalAssistantVisibleText,
      payload?.result?.meta?.finalAssistantRawText,
    ]);
    const payloadTexts = payloadEntries.flatMap((entry) =>
      entry?.isError !== true && typeof entry?.text === "string" && entry.text.length > 0
        ? [entry.text]
        : [],
    );
    return directTexts.concat(payloadTexts);
  });
}

export function assertAgentReplyContainsMarker(marker, outputPath) {
  const output = readTextFileTail(outputPath, OUTPUT_SCAN_TAIL_BYTES);
  const replyTexts = extractAgentReplyTexts(output);
  if (replyTexts.some((text) => text.includes(marker))) {
    return;
  }
  const outputTail = tailText(output, ERROR_DETAIL_TAIL_BYTES);
  throw new Error(
    `agent reply payload did not contain marker ${marker}. Reply payload summary: ${summarizeReplyTexts(replyTexts)}. Output tail: ${outputTail}`,
  );
}

export function assertOpenAiRequestLogUsed(requestLogPath, label = "mock OpenAI server") {
  if (fileContainsPattern(requestLogPath, OPENAI_REQUEST_PATH_PATTERN)) {
    return;
  }
  const requestLogTail = readTextFileTail(requestLogPath, ERROR_DETAIL_TAIL_BYTES);
  throw new Error(`${label} was not used. Request log tail: ${requestLogTail}`);
}
