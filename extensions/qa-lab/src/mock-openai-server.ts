import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { setTimeout as sleep } from "node:timers/promises";
import { closeQaHttpServer } from "./bus-server.js";

type ResponsesInputItem = Record<string, unknown>;

type StreamEvent =
  | { type: "response.output_item.added"; item: Record<string, unknown> }
  | { type: "response.function_call_arguments.delta"; delta: string }
  | { type: "response.output_item.done"; item: Record<string, unknown> }
  | {
      type: "response.completed";
      response: {
        id: string;
        status: "completed";
        output: Array<Record<string, unknown>>;
        usage: {
          input_tokens: number;
          output_tokens: number;
          total_tokens: number;
        };
      };
    };

type MockOpenAiRequestSnapshot = {
  raw: string;
  body: Record<string, unknown>;
  prompt: string;
  allInputText: string;
  instructions?: string;
  toolOutput: string;
  model: string;
  imageInputCount: number;
  plannedToolName?: string;
};

const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO7Z0nQAAAAASUVORK5CYII=";
let subagentFanoutPhase = 0;

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function writeJson(res: ServerResponse, status: number, body: unknown) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text),
    "cache-control": "no-store",
  });
  res.end(text);
}

function writeSse(res: ServerResponse, events: StreamEvent[]) {
  const body = `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`;
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-store",
    connection: "keep-alive",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

function countApproxTokens(text: string) {
  const trimmed = text.trim();
  if (!trimmed) {
    return 0;
  }
  return Math.max(1, Math.ceil(trimmed.length / 4));
}

function extractEmbeddingInputTexts(input: unknown): string[] {
  if (typeof input === "string") {
    return [input];
  }
  if (Array.isArray(input)) {
    return input.flatMap((entry) => extractEmbeddingInputTexts(entry));
  }
  if (
    input &&
    typeof input === "object" &&
    typeof (input as { text?: unknown }).text === "string"
  ) {
    return [(input as { text: string }).text];
  }
  return [];
}

function buildDeterministicEmbedding(text: string, dimensions = 16) {
  const values = Array.from({ length: dimensions }, () => 0);
  for (let index = 0; index < text.length; index += 1) {
    values[index % dimensions] += text.charCodeAt(index) / 255;
  }
  const magnitude = Math.hypot(...values) || 1;
  return values.map((value) => Number((value / magnitude).toFixed(8)));
}

function extractLastUserText(input: ResponsesInputItem[]) {
  for (let index = input.length - 1; index >= 0; index -= 1) {
    const item = input[index];
    if (item.role !== "user" || !Array.isArray(item.content)) {
      continue;
    }
    const text = extractInputText(item.content);
    if (text) {
      return text;
    }
  }
  return "";
}

function findLastUserIndex(input: ResponsesInputItem[]) {
  for (let index = input.length - 1; index >= 0; index -= 1) {
    const item = input[index];
    if (item.role === "user" && Array.isArray(item.content)) {
      return index;
    }
  }
  return -1;
}

function extractToolOutput(input: ResponsesInputItem[]) {
  const lastUserIndex = findLastUserIndex(input);
  for (let index = input.length - 1; index > lastUserIndex; index -= 1) {
    const item = input[index];
    if (item.type === "function_call_output" && typeof item.output === "string" && item.output) {
      return item.output;
    }
  }
  return "";
}

function extractInputText(content: unknown[]): string {
  return content
    .filter(
      (entry): entry is { type: "input_text"; text: string } =>
        !!entry &&
        typeof entry === "object" &&
        (entry as { type?: unknown }).type === "input_text" &&
        typeof (entry as { text?: unknown }).text === "string",
    )
    .map((entry) => entry.text)
    .join("\n")
    .trim();
}

function extractAllUserTexts(input: ResponsesInputItem[]) {
  const texts: string[] = [];
  for (const item of input) {
    if (item.role !== "user" || !Array.isArray(item.content)) {
      continue;
    }
    const text = extractInputText(item.content);
    if (text) {
      texts.push(text);
    }
  }
  return texts;
}

function extractAllInputTexts(input: ResponsesInputItem[]) {
  const texts: string[] = [];
  for (const item of input) {
    if (typeof item.output === "string" && item.output.trim()) {
      texts.push(item.output.trim());
    }
    if (!Array.isArray(item.content)) {
      continue;
    }
    const text = extractInputText(item.content);
    if (text) {
      texts.push(text);
    }
  }
  return texts.join("\n");
}

function extractInstructionsText(body: Record<string, unknown>) {
  return typeof body.instructions === "string" ? body.instructions.trim() : "";
}

function extractAllRequestTexts(input: ResponsesInputItem[], body: Record<string, unknown>) {
  const texts: string[] = [];
  const instructions = extractInstructionsText(body);
  if (instructions) {
    texts.push(instructions);
  }
  const inputText = extractAllInputTexts(input);
  if (inputText) {
    texts.push(inputText);
  }
  return texts.join("\n");
}

function countImageInputs(input: ResponsesInputItem[]) {
  let count = 0;
  for (const item of input) {
    if (!Array.isArray(item.content)) {
      continue;
    }
    for (const entry of item.content) {
      if (
        entry &&
        typeof entry === "object" &&
        (entry as { type?: unknown }).type === "input_image"
      ) {
        count += 1;
      }
    }
  }
  return count;
}

function parseToolOutputJson(toolOutput: string): Record<string, unknown> | null {
  if (!toolOutput.trim()) {
    return null;
  }
  try {
    return JSON.parse(toolOutput) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function normalizePromptPathCandidate(candidate: string) {
  const trimmed = candidate.trim().replace(/^`+|`+$/g, "");
  if (!trimmed) {
    return null;
  }
  const normalized = trimmed.replace(/^\.\//, "");
  if (
    normalized.includes("/") ||
    /\.(?:md|json|ts|tsx|js|mjs|cjs|txt|yaml|yml)$/i.test(normalized)
  ) {
    return normalized;
  }
  return null;
}

function readTargetFromPrompt(prompt: string) {
  const backtickedMatches = Array.from(prompt.matchAll(/`([^`]+)`/g))
    .map((match) => normalizePromptPathCandidate(match[1] ?? ""))
    .filter((value): value is string => !!value);
  if (backtickedMatches.length > 0) {
    return backtickedMatches[0];
  }

  const quotedMatches = Array.from(prompt.matchAll(/"([^"]+)"/g))
    .map((match) => normalizePromptPathCandidate(match[1] ?? ""))
    .filter((value): value is string => !!value);
  if (quotedMatches.length > 0) {
    return quotedMatches[0];
  }

  const repoScoped = /\b(?:repo\/[^\s`",)]+|QA_[A-Z_]+\.md)\b/.exec(prompt)?.[0]?.trim();
  if (repoScoped) {
    return repoScoped;
  }

  if (/\bdocs?\b/i.test(prompt)) {
    return "repo/docs/help/testing.md";
  }
  if (/\bscenario|kickoff|qa\b/i.test(prompt)) {
    return "QA_KICKOFF_TASK.md";
  }
  return "repo/package.json";
}

function buildToolCallEventsWithArgs(name: string, args: Record<string, unknown>): StreamEvent[] {
  const callId = `call_mock_${name}_1`;
  const serialized = JSON.stringify(args);
  return [
    {
      type: "response.output_item.added",
      item: {
        type: "function_call",
        id: `fc_mock_${name}_1`,
        call_id: callId,
        name,
        arguments: "",
      },
    },
    { type: "response.function_call_arguments.delta", delta: serialized },
    {
      type: "response.output_item.done",
      item: {
        type: "function_call",
        id: `fc_mock_${name}_1`,
        call_id: callId,
        name,
        arguments: serialized,
      },
    },
    {
      type: "response.completed",
      response: {
        id: `resp_mock_${name}_1`,
        status: "completed",
        output: [
          {
            type: "function_call",
            id: `fc_mock_${name}_1`,
            call_id: callId,
            name,
            arguments: serialized,
          },
        ],
        usage: { input_tokens: 64, output_tokens: 16, total_tokens: 80 },
      },
    },
  ];
}

function extractRememberedFact(userTexts: string[]) {
  for (const text of userTexts) {
    const qaCanaryMatch = /\bqa canary code is\s+([A-Za-z0-9-]+)/i.exec(text);
    if (qaCanaryMatch?.[1]) {
      return qaCanaryMatch[1];
    }
  }
  for (const text of userTexts) {
    const match = /remember(?: this fact for later)?:\s*([A-Za-z0-9-]+)/i.exec(text);
    if (match?.[1]) {
      return match[1];
    }
  }
  return null;
}

function extractOrbitCode(text: string) {
  return /\bORBIT-\d+\b/i.exec(text)?.[0]?.toUpperCase() ?? null;
}

function decodeXmlEntities(text: string) {
  return text
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'");
}

function extractActiveMemorySummary(text: string) {
  const match = /<active_memory_plugin>\s*([\s\S]*?)\s*<\/active_memory_plugin>/i.exec(text);
  return match?.[1] ? decodeXmlEntities(match[1]).trim() : null;
}

function isActiveMemorySubagentPrompt(text: string) {
  return text.includes("You are a memory search agent.");
}

function extractSnackPreference(text: string) {
  const normalized = text.replace(/\s+/g, " ").trim();
  const match =
    /(lemon pepper wings(?:\s+with\s+blue cheese)?|blue cheese(?:\s+with\s+lemon pepper wings)?)/i.exec(
      normalized,
    );
  return match?.[0]?.trim() ?? null;
}

function extractLastCapture(text: string, pattern: RegExp) {
  let lastMatch: RegExpExecArray | null = null;
  const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
  const globalPattern = new RegExp(pattern.source, flags);
  for (let match = globalPattern.exec(text); match; match = globalPattern.exec(text)) {
    lastMatch = match;
  }
  return lastMatch?.[1]?.trim() || null;
}

function extractExactReplyDirective(text: string) {
  const colonMatch = extractLastCapture(text, /reply(?: with)? exactly:\s*([^\n]+)/i);
  if (colonMatch) {
    return colonMatch;
  }
  return extractLastCapture(text, /reply(?: with)? exactly\s+`([^`]+)`/i);
}

function extractExactMarkerDirective(text: string) {
  const backtickedMatch = extractLastCapture(text, /exact marker:\s*`([^`]+)`/i);
  if (backtickedMatch) {
    return backtickedMatch;
  }
  return extractLastCapture(text, /exact marker:\s*([^\s`.,;:!?]+(?:-[^\s`.,;:!?]+)*)/i);
}

function isHeartbeatPrompt(text: string) {
  return /Read HEARTBEAT\.md if it exists/i.test(text);
}

function buildAssistantText(input: ResponsesInputItem[], body: Record<string, unknown>) {
  const prompt = extractLastUserText(input);
  const toolOutput = extractToolOutput(input);
  const toolJson = parseToolOutputJson(toolOutput);
  const userTexts = extractAllUserTexts(input);
  const allInputText = extractAllRequestTexts(input, body);
  const rememberedFact = extractRememberedFact(userTexts);
  const model = typeof body.model === "string" ? body.model : "";
  const memorySnippet =
    typeof toolJson?.text === "string"
      ? toolJson.text
      : Array.isArray(toolJson?.results)
        ? JSON.stringify(toolJson.results)
        : toolOutput;
  const orbitCode = extractOrbitCode(memorySnippet);
  const mediaPath = /MEDIA:([^\n]+)/.exec(toolOutput)?.[1]?.trim();
  const exactReplyDirective = extractExactReplyDirective(allInputText);
  const exactMarkerDirective = extractExactMarkerDirective(allInputText);
  const imageInputCount = countImageInputs(input);
  const activeMemorySummary = extractActiveMemorySummary(allInputText);
  const snackPreference = extractSnackPreference(activeMemorySummary ?? memorySnippet);

  if (/what was the qa canary code/i.test(prompt) && rememberedFact) {
    return `Protocol note: the QA canary code was ${rememberedFact}.`;
  }
  if (/remember this fact/i.test(prompt) && exactReplyDirective) {
    return exactReplyDirective;
  }
  if (/remember this fact/i.test(prompt) && rememberedFact) {
    return `Protocol note: acknowledged. I will remember ${rememberedFact}.`;
  }
  if (/memory unavailable check/i.test(prompt)) {
    return "Protocol note: I checked the available runtime context but could not confirm the hidden memory-only fact, so I will not guess.";
  }
  if (isHeartbeatPrompt(prompt)) {
    return "HEARTBEAT_OK";
  }
  if (/\bmarker\b/i.test(prompt) && exactReplyDirective) {
    return exactReplyDirective;
  }
  if (/\bmarker\b/i.test(prompt) && exactMarkerDirective) {
    return exactMarkerDirective;
  }
  if (/visible skill marker/i.test(prompt)) {
    return "VISIBLE-SKILL-OK";
  }
  if (/hot install marker/i.test(prompt)) {
    return "HOT-INSTALL-OK";
  }
  if (/memory tools check/i.test(prompt) && orbitCode) {
    return `Protocol note: I checked memory and the project codename is ${orbitCode}.`;
  }
  if (/silent snack recall check/i.test(prompt) && snackPreference) {
    return `Protocol note: you usually want ${snackPreference} for QA movie night.`;
  }
  if (/silent snack recall check/i.test(prompt)) {
    return "Protocol note: I do not have enough context to say what you usually want for QA movie night.";
  }
  if (/tool continuity check/i.test(prompt) && toolOutput) {
    return `Protocol note: model switch handoff confirmed on ${model || "the requested model"}. QA mission from QA_KICKOFF_TASK.md still applies: understand this OpenClaw repo from source + docs before acting.`;
  }
  if (/session memory ranking check/i.test(prompt) && orbitCode) {
    return `Protocol note: I checked memory and the current Project Nebula codename is ${orbitCode}.`;
  }
  if (/thread memory check/i.test(prompt) && orbitCode) {
    return `Protocol note: I checked memory in-thread and the hidden thread codename is ${orbitCode}.`;
  }
  if (/switch(?:ing)? models?/i.test(prompt)) {
    return `Protocol note: model switch acknowledged. Continuing on ${model || "the requested model"}.`;
  }
  if (/(image generation check|capability flip image check)/i.test(prompt) && mediaPath) {
    return `Protocol note: generated the QA lighthouse image successfully.\nMEDIA:${mediaPath}`;
  }
  if (/roundtrip image inspection check/i.test(prompt) && imageInputCount > 0) {
    return "Protocol note: the generated attachment shows the same QA lighthouse scene from the previous step.";
  }
  if (/image understanding check/i.test(prompt) && imageInputCount > 0) {
    return "Protocol note: the attached image is split horizontally, with red on top and blue on the bottom.";
  }
  if (
    /interrupted by a gateway reload/i.test(prompt) &&
    /subagent recovery worker/i.test(allInputText)
  ) {
    return "RECOVERED-SUBAGENT-OK";
  }
  if (/subagent recovery worker/i.test(prompt)) {
    return "RECOVERED-SUBAGENT-OK";
  }
  if (/fanout worker alpha/i.test(prompt)) {
    return "ALPHA-OK";
  }
  if (/fanout worker beta/i.test(prompt)) {
    return "BETA-OK";
  }
  if (/subagent fanout synthesis check/i.test(prompt) && toolOutput && subagentFanoutPhase >= 2) {
    return "Protocol note: delegated fanout complete. Alpha=ALPHA-OK. Beta=BETA-OK.";
  }
  if (toolOutput && (/\bdelegate\b/i.test(prompt) || /subagent handoff/i.test(prompt))) {
    const compact = toolOutput.replace(/\s+/g, " ").trim() || "no delegated output";
    return `Delegated task:\n- Inspect the QA workspace via a bounded subagent.\nResult:\n- ${compact}\nEvidence:\n- The child result was folded back into the main thread exactly once.`;
  }
  if (toolOutput && /worked, failed, blocked|worked\/failed\/blocked|follow-up/i.test(prompt)) {
    return `Worked:\n- Read seeded QA material.\n- Expanded the report structure.\nFailed:\n- None observed in mock mode.\nBlocked:\n- No live provider evidence in this lane.\nFollow-up:\n- Re-run with a real model for qualitative coverage.`;
  }
  if (toolOutput && /lobster invaders/i.test(prompt)) {
    if (toolOutput.includes("QA mission") || toolOutput.includes("Testing")) {
      return "";
    }
    return `Protocol note: Lobster Invaders built at lobster-invaders.html.`;
  }
  if (toolOutput && /compaction retry mutating tool check/i.test(prompt)) {
    if (
      toolOutput.includes("Replay safety: unsafe after write.") ||
      /compaction-retry-summary\.txt/i.test(toolOutput) ||
      /successfully (?:wrote|replaced)/i.test(toolOutput) ||
      /\bwrote\b.*\bcompaction-retry-summary\.txt\b/i.test(toolOutput)
    ) {
      return "Protocol note: replay unsafe after write.";
    }
    return "";
  }
  if (toolOutput) {
    const snippet = toolOutput.replace(/\s+/g, " ").trim().slice(0, 220);
    return `Protocol note: I reviewed the requested material. Evidence snippet: ${snippet || "no content"}`;
  }
  if (prompt) {
    return `Protocol note: acknowledged. Continue with the QA scenario plan and report worked, failed, and blocked items.`;
  }
  return "Protocol note: mock OpenAI server ready.";
}

function buildToolCallEvents(prompt: string): StreamEvent[] {
  const targetPath = readTargetFromPrompt(prompt);
  return buildToolCallEventsWithArgs("read", { path: targetPath });
}

function extractPlannedToolName(events: StreamEvent[]) {
  for (const event of events) {
    if (event.type !== "response.output_item.done") {
      continue;
    }
    const item = event.item as { type?: unknown; name?: unknown };
    if (item.type === "function_call" && typeof item.name === "string") {
      return item.name;
    }
  }
  return undefined;
}

function buildAssistantEvents(text: string): StreamEvent[] {
  const outputItem = {
    type: "message",
    id: "msg_mock_1",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text, annotations: [] }],
  } as const;
  return [
    {
      type: "response.output_item.added",
      item: {
        type: "message",
        id: "msg_mock_1",
        role: "assistant",
        content: [],
        status: "in_progress",
      },
    },
    {
      type: "response.output_item.done",
      item: outputItem,
    },
    {
      type: "response.completed",
      response: {
        id: "resp_mock_msg_1",
        status: "completed",
        output: [outputItem],
        usage: { input_tokens: 64, output_tokens: 24, total_tokens: 88 },
      },
    },
  ];
}

async function buildResponsesPayload(body: Record<string, unknown>) {
  const input = Array.isArray(body.input) ? (body.input as ResponsesInputItem[]) : [];
  const prompt = extractLastUserText(input);
  const toolOutput = extractToolOutput(input);
  const toolJson = parseToolOutputJson(toolOutput);
  const allInputText = extractAllRequestTexts(input, body);
  const isGroupChat = allInputText.includes('"is_group_chat": true');
  const isBaselineUnmentionedChannelChatter = /\bno bot ping here\b/i.test(prompt);
  if (isHeartbeatPrompt(prompt)) {
    return buildAssistantEvents("HEARTBEAT_OK");
  }
  if (/lobster invaders/i.test(prompt)) {
    if (!toolOutput) {
      return buildToolCallEventsWithArgs("read", { path: "QA_KICKOFF_TASK.md" });
    }
    if (toolOutput.includes("QA mission") || toolOutput.includes("Testing")) {
      return buildToolCallEventsWithArgs("write", {
        path: "lobster-invaders.html",
        content: `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8" /><title>Lobster Invaders</title></head>
  <body><h1>Lobster Invaders</h1><p>Tiny playable stub.</p></body>
</html>`,
      });
    }
  }
  if (/compaction retry mutating tool check/i.test(prompt)) {
    if (!toolOutput) {
      return buildToolCallEventsWithArgs("read", { path: "COMPACTION_RETRY_CONTEXT.md" });
    }
    if (toolOutput.includes("compaction retry evidence")) {
      return buildToolCallEventsWithArgs("write", {
        path: "compaction-retry-summary.txt",
        content: "Replay safety: unsafe after write.\n",
      });
    }
  }
  if (/memory tools check/i.test(prompt)) {
    if (!toolOutput) {
      return buildToolCallEventsWithArgs("memory_search", {
        query: "project codename ORBIT-9",
        maxResults: 3,
      });
    }
    const results = Array.isArray(toolJson?.results)
      ? (toolJson.results as Array<Record<string, unknown>>)
      : [];
    const first = results[0];
    if (
      typeof first?.path === "string" &&
      (typeof first.startLine === "number" || typeof first.endLine === "number")
    ) {
      const from =
        typeof first.startLine === "number"
          ? Math.max(1, first.startLine)
          : typeof first.endLine === "number"
            ? Math.max(1, first.endLine)
            : 1;
      return buildToolCallEventsWithArgs("memory_get", {
        path: first.path,
        from,
        lines: 4,
      });
    }
  }
  if (
    isActiveMemorySubagentPrompt(allInputText) &&
    /silent snack recall check/i.test(allInputText)
  ) {
    if (!toolOutput) {
      return buildToolCallEventsWithArgs("memory_search", {
        query: "QA movie night snack lemon pepper wings blue cheese",
        maxResults: 3,
      });
    }
    const results = Array.isArray(toolJson?.results)
      ? (toolJson.results as Array<Record<string, unknown>>)
      : [];
    const first = results[0];
    if (
      typeof first?.path === "string" &&
      (typeof first.startLine === "number" || typeof first.endLine === "number")
    ) {
      const from =
        typeof first.startLine === "number"
          ? Math.max(1, first.startLine)
          : typeof first.endLine === "number"
            ? Math.max(1, first.endLine)
            : 1;
      return buildToolCallEventsWithArgs("memory_get", {
        path: first.path,
        from,
        lines: 4,
      });
    }
    const memorySnippet =
      typeof toolJson?.text === "string"
        ? toolJson.text
        : Array.isArray(toolJson?.results)
          ? JSON.stringify(toolJson.results)
          : toolOutput;
    const snackPreference = extractSnackPreference(memorySnippet);
    if (snackPreference) {
      return buildAssistantEvents(`User usually wants ${snackPreference} for QA movie night.`);
    }
    return buildAssistantEvents("NONE");
  }
  if (/session memory ranking check/i.test(prompt)) {
    if (!toolOutput) {
      return buildToolCallEventsWithArgs("memory_search", {
        query: "current Project Nebula codename ORBIT-10",
        maxResults: 3,
      });
    }
    const results = Array.isArray(toolJson?.results)
      ? (toolJson.results as Array<Record<string, unknown>>)
      : [];
    const first = results[0];
    const firstPath = typeof first?.path === "string" ? first.path : undefined;
    if (first?.source === "sessions" || firstPath?.startsWith("sessions/")) {
      return buildAssistantEvents(
        "Protocol note: I checked memory and the current Project Nebula codename is ORBIT-10.",
      );
    }
    if (
      typeof first?.path === "string" &&
      (typeof first.startLine === "number" || typeof first.endLine === "number")
    ) {
      const from =
        typeof first.startLine === "number"
          ? Math.max(1, first.startLine)
          : typeof first.endLine === "number"
            ? Math.max(1, first.endLine)
            : 1;
      return buildToolCallEventsWithArgs("memory_get", {
        path: first.path,
        from,
        lines: 4,
      });
    }
  }
  if (/thread memory check/i.test(prompt)) {
    if (!toolOutput) {
      return buildToolCallEventsWithArgs("memory_search", {
        query: "hidden thread codename ORBIT-22",
        maxResults: 3,
      });
    }
    const results = Array.isArray(toolJson?.results)
      ? (toolJson.results as Array<Record<string, unknown>>)
      : [];
    const first = results[0];
    if (
      typeof first?.path === "string" &&
      (typeof first.startLine === "number" || typeof first.endLine === "number")
    ) {
      const from =
        typeof first.startLine === "number"
          ? Math.max(1, first.startLine)
          : typeof first.endLine === "number"
            ? Math.max(1, first.endLine)
            : 1;
      return buildToolCallEventsWithArgs("memory_get", {
        path: first.path,
        from,
        lines: 4,
      });
    }
  }
  if (/(image generation check|capability flip image check)/i.test(prompt) && !toolOutput) {
    return buildToolCallEventsWithArgs("image_generate", {
      prompt: "A QA lighthouse on a dark sea with a tiny protocol droid silhouette.",
      filename: "qa-lighthouse.png",
      size: "1024x1024",
    });
  }
  if (/subagent fanout synthesis check/i.test(prompt)) {
    if (!toolOutput && subagentFanoutPhase === 0) {
      subagentFanoutPhase = 1;
      return buildToolCallEventsWithArgs("sessions_spawn", {
        task: "Fanout worker alpha: inspect the QA workspace and finish with exactly ALPHA-OK.",
        label: "qa-fanout-alpha",
        thread: false,
      });
    }
    if (toolOutput && subagentFanoutPhase === 1) {
      subagentFanoutPhase = 2;
      return buildToolCallEventsWithArgs("sessions_spawn", {
        task: "Fanout worker beta: inspect the QA workspace and finish with exactly BETA-OK.",
        label: "qa-fanout-beta",
        thread: false,
      });
    }
  }
  if (/tool continuity check/i.test(prompt) && !toolOutput) {
    return buildToolCallEventsWithArgs("read", { path: "QA_KICKOFF_TASK.md" });
  }
  if ((/\bdelegate\b/i.test(prompt) || /subagent handoff/i.test(prompt)) && !toolOutput) {
    return buildToolCallEventsWithArgs("sessions_spawn", {
      task: "Inspect the QA workspace and return one concise protocol note.",
      label: "qa-sidecar",
      thread: false,
    });
  }
  if (
    /(worked, failed, blocked|worked\/failed\/blocked|source and docs)/i.test(prompt) &&
    !toolOutput
  ) {
    return buildToolCallEventsWithArgs("read", { path: "QA_SCENARIO_PLAN.md" });
  }
  if (!toolOutput && /\b(read|inspect|repo|docs|scenario|kickoff)\b/i.test(prompt)) {
    return buildToolCallEvents(prompt);
  }
  if (/visible skill marker/i.test(prompt) && !toolOutput) {
    return buildAssistantEvents("VISIBLE-SKILL-OK");
  }
  if (/hot install marker/i.test(prompt) && !toolOutput) {
    return buildAssistantEvents("HOT-INSTALL-OK");
  }
  if (isGroupChat && isBaselineUnmentionedChannelChatter && !toolOutput) {
    return buildAssistantEvents("NO_REPLY");
  }
  if (
    /subagent recovery worker/i.test(prompt) &&
    !/interrupted by a gateway reload/i.test(prompt)
  ) {
    await sleep(60_000);
  }
  return buildAssistantEvents(buildAssistantText(input, body));
}

export async function startQaMockOpenAiServer(params?: { host?: string; port?: number }) {
  const host = params?.host ?? "127.0.0.1";
  subagentFanoutPhase = 0;
  let lastRequest: MockOpenAiRequestSnapshot | null = null;
  const requests: MockOpenAiRequestSnapshot[] = [];
  const imageGenerationRequests: Array<Record<string, unknown>> = [];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (req.method === "GET" && (url.pathname === "/healthz" || url.pathname === "/readyz")) {
      writeJson(res, 200, { ok: true, status: "live" });
      return;
    }
    if (req.method === "GET" && url.pathname === "/v1/models") {
      writeJson(res, 200, {
        data: [
          { id: "gpt-5.4", object: "model" },
          { id: "gpt-5.4-alt", object: "model" },
          { id: "gpt-image-1", object: "model" },
          { id: "text-embedding-3-small", object: "model" },
        ],
      });
      return;
    }
    if (req.method === "GET" && url.pathname === "/debug/last-request") {
      writeJson(res, 200, lastRequest ?? { ok: false, error: "no request recorded" });
      return;
    }
    if (req.method === "GET" && url.pathname === "/debug/requests") {
      writeJson(res, 200, requests);
      return;
    }
    if (req.method === "GET" && url.pathname === "/debug/image-generations") {
      writeJson(res, 200, imageGenerationRequests);
      return;
    }
    if (req.method === "POST" && url.pathname === "/v1/images/generations") {
      const raw = await readBody(req);
      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      imageGenerationRequests.push(body);
      if (imageGenerationRequests.length > 20) {
        imageGenerationRequests.splice(0, imageGenerationRequests.length - 20);
      }
      writeJson(res, 200, {
        data: [
          {
            b64_json: TINY_PNG_BASE64,
            revised_prompt: "A QA lighthouse with protocol droid silhouette.",
          },
        ],
      });
      return;
    }
    if (req.method === "POST" && url.pathname === "/v1/embeddings") {
      const raw = await readBody(req);
      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      const inputs = extractEmbeddingInputTexts(body.input);
      writeJson(res, 200, {
        object: "list",
        data: inputs.map((text, index) => ({
          object: "embedding",
          index,
          embedding: buildDeterministicEmbedding(text),
        })),
        model:
          typeof body.model === "string" && body.model.trim()
            ? body.model
            : "text-embedding-3-small",
        usage: {
          prompt_tokens: inputs.reduce((sum, text) => sum + countApproxTokens(text), 0),
          total_tokens: inputs.reduce((sum, text) => sum + countApproxTokens(text), 0),
        },
      });
      return;
    }
    if (req.method === "POST" && url.pathname === "/v1/responses") {
      const raw = await readBody(req);
      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      const input = Array.isArray(body.input) ? (body.input as ResponsesInputItem[]) : [];
      const events = await buildResponsesPayload(body);
      lastRequest = {
        raw,
        body,
        prompt: extractLastUserText(input),
        allInputText: extractAllRequestTexts(input, body),
        instructions: extractInstructionsText(body) || undefined,
        toolOutput: extractToolOutput(input),
        model: typeof body.model === "string" ? body.model : "",
        imageInputCount: countImageInputs(input),
        plannedToolName: extractPlannedToolName(events),
      };
      requests.push(lastRequest);
      if (requests.length > 50) {
        requests.splice(0, requests.length - 50);
      }
      if (body.stream === false) {
        const completion = events.at(-1);
        if (!completion || completion.type !== "response.completed") {
          writeJson(res, 500, { error: "mock completion failed" });
          return;
        }
        writeJson(res, 200, completion.response);
        return;
      }
      writeSse(res, events);
      return;
    }
    writeJson(res, 404, { error: "not found" });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(params?.port ?? 0, host, () => resolve());
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("qa mock openai failed to bind");
  }

  return {
    baseUrl: `http://${host}:${address.port}`,
    async stop() {
      await closeQaHttpServer(server);
    },
  };
}
