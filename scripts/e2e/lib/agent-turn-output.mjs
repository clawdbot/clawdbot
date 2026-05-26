import fs from "node:fs";

function readTextFile(file) {
  return fs.readFileSync(file, "utf8");
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
  throw new Error(
    `agent reply payload did not contain marker ${marker}. Reply payloads: ${JSON.stringify(replyTexts)}. Output: ${output}`,
  );
}

export function assertOpenAiRequestLogUsed(requestLogPath, label = "mock OpenAI server") {
  const requestLog = fs.existsSync(requestLogPath) ? readTextFile(requestLogPath) : "";
  if (/\/v1\/(responses|chat\/completions)/u.test(requestLog)) {
    return;
  }
  throw new Error(`${label} was not used. Requests: ${requestLog}`);
}
