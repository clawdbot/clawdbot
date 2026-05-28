import fs from "node:fs";

const ERROR_DETAIL_TAIL_BYTES = 64 * 1024;
const REPLY_TEXT_PREVIEW_BYTES = 8 * 1024;
const REPLY_TEXT_PREVIEW_COUNT = 5;
const REQUEST_LOG_SCAN_CHUNK_BYTES = 64 * 1024;
const REQUEST_LOG_SCAN_CARRY_CHARS = 256;
const OPENAI_REQUEST_PATH_PATTERN = /\/v1\/(responses|chat\/completions)/u;

function readTextFile(file) {
  return fs.readFileSync(file, "utf8");
}

function textByteLength(text) {
  return Buffer.byteLength(text, "utf8");
}

function tailText(text, maxBytes = ERROR_DETAIL_TAIL_BYTES) {
  if (textByteLength(text) <= maxBytes) {
    return text;
  }
  return Buffer.from(text, "utf8").subarray(-maxBytes).toString("utf8");
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

function readTextFileTail(file, maxBytes = ERROR_DETAIL_TAIL_BYTES) {
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    return "";
  }
  if (!stat.isFile() || stat.size <= 0) {
    return "";
  }

  const length = Math.min(maxBytes, stat.size);
  const start = stat.size - length;
  const fd = fs.openSync(file, "r");
  try {
    const buffer = Buffer.alloc(length);
    const bytesRead = fs.readSync(fd, buffer, 0, length, start);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    fs.closeSync(fd);
  }
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

export function extractAgentReplyTexts(text) {
  return parseJsonPayloads(text).flatMap((payload) => {
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
    const payloadEntries = Array.isArray(payload?.payloads)
      ? payload.payloads
      : Array.isArray(payload?.result?.payloads)
        ? payload.result.payloads
        : [];
    const payloadTexts = payloadEntries.flatMap((entry) =>
      typeof entry?.text === "string" && entry.text.length > 0 ? [entry.text] : [],
    );
    return directTexts.concat(payloadTexts);
  });
}

export function assertAgentReplyContainsMarker(marker, outputPath) {
  const output = readTextFile(outputPath);
  const replyTexts = extractAgentReplyTexts(output);
  if (replyTexts.some((text) => text.includes(marker))) {
    return;
  }
  const outputTail = tailText(output);
  throw new Error(
    `agent reply payload did not contain marker ${marker}. Reply payload summary: ${summarizeReplyTexts(replyTexts)}. Output tail: ${outputTail}`,
  );
}

export function assertOpenAiRequestLogUsed(requestLogPath, label = "mock OpenAI server") {
  if (fileContainsPattern(requestLogPath, OPENAI_REQUEST_PATH_PATTERN)) {
    return;
  }
  const requestLogTail = readTextFileTail(requestLogPath);
  throw new Error(`${label} was not used. Request log tail: ${requestLogTail}`);
}
