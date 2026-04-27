import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { setTimeout as sleep } from "node:timers/promises";
import { closeQaHttpServer } from "../../bus-server.js";

type ResponsesInputItem = Record<string, unknown>;

type StreamEvent =
  | { type: "response.output_item.added"; item: Record<string, unknown> }
  | {
      type: "response.output_text.delta";
      item_id: string;
      output_index: number;
      content_index: number;
      delta: string;
    }
  | {
      type: "response.output_text.done";
      item_id: string;
      output_index: number;
      content_index: number;
      text: string;
    }
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

/**
 * Provider variant tag for `body.model`. The mock previously ignored
 * `body.model` for dispatch and only echoed it in the prose output, which
 * made the parity gate tautological when run against the mock alone
 * (both providers produced identical scenario plans by construction).
 * Tagging requests with a normalized variant lets individual scenario
 * branches opt into provider-specific behavior while the rest of the
 * dispatcher stays shared, and lets `/debug/requests` consumers verify
 * which provider lane a given request came from without re-parsing the
 * raw model string.
 *
 * Policy:
 * - `openai/*`, `gpt-*`, `o1-*`, anything starting with `gpt-` → `"openai"`
 * - `anthropic/*`, `claude-*` → `"anthropic"`
 * - Everything else (including empty strings) → `"unknown"`
 *
 * The `/v1/messages` route always feeds `body.model` straight through,
 * so an Anthropic request with an `openai/gpt-5.5` model string is still
 * classified as `"openai"`. That matches the parity program's convention
 * where the provider label is the source of truth, not the HTTP route.
 */
export type MockOpenAiProviderVariant = "openai" | "anthropic" | "unknown";

export function resolveProviderVariant(model: string | undefined): MockOpenAiProviderVariant {
  if (typeof model !== "string") {
    return "unknown";
  }
  const trimmed = model.trim().toLowerCase();
  if (trimmed.length === 0) {
    return "unknown";
  }
  // Prefer the explicit `provider/model` or `provider:model` prefix when
  // the caller supplied one — that's the most reliable signal.
  const separatorMatch = /^([^/:]+)[/:]/.exec(trimmed);
  const provider = separatorMatch?.[1] ?? trimmed;
  if (provider === "openai" || provider === "openai-codex") {
    return "openai";
  }
  if (provider === "anthropic" || provider === "claude-cli") {
    return "anthropic";
  }
  // Fall back to model-name prefix matching for bare model strings like
  // `gpt-5.5` or `claude-opus-4-6`.
  if (/^(?:gpt-|o1-|openai-)/.test(trimmed)) {
    return "openai";
  }
  if (/^(?:claude-|anthropic-)/.test(trimmed)) {
    return "anthropic";
  }
  return "unknown";
}

type MockOpenAiRequestSnapshot = {
  raw: string;
  body: Record<string, unknown>;
  prompt: string;
  allInputText: string;
  instructions?: string;
  toolOutput: string;
  model: string;
  providerVariant: MockOpenAiProviderVariant;
  imageInputCount: number;
  plannedToolName?: string;
  plannedToolArgs?: Record<string, unknown>;
};

// Anthropic /v1/messages request/response shapes the mock actually needs.
// This is a subset of the real Anthropic Messages API — just enough so the
// QA suite can run its parity pack against a "baseline" Anthropic provider
// without needing real API keys. The scenarios drive their dispatch through
// the shared mock scenario logic (buildResponsesPayload), so whatever
// behavior the OpenAI mock exposes is automatically mirrored on this route.
type AnthropicMessageContentBlock =
  | { type: "text"; text: string }
  | {
      type: "tool_use";
      id: string;
      name: string;
      input: Record<string, unknown>;
    }
  | {
      type: "tool_result";
      tool_use_id: string;
      content: string | Array<{ type: "text"; text: string }>;
    }
  | { type: "image"; source: Record<string, unknown> };

type AnthropicMessage = {
  role: "user" | "assistant";
  content: string | AnthropicMessageContentBlock[];
};

type AnthropicMessagesRequest = {
  model?: string;
  max_tokens?: number;
  system?: string | Array<{ type: "text"; text: string }>;
  messages?: AnthropicMessage[];
  tools?: Array<Record<string, unknown>>;
  stream?: boolean;
};

const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO7Z0nQAAAAASUVORK5CYII=";
const QA_REASONING_ONLY_RECOVERY_PROMPT_RE = /reasoning-only continuation qa check/i;
const QA_REASONING_ONLY_SIDE_EFFECT_PROMPT_RE = /reasoning-only after write safety check/i;
const QA_THINKING_VISIBILITY_OFF_PROMPT_RE = /qa thinking visibility check off/i;
const QA_THINKING_VISIBILITY_MAX_PROMPT_RE = /qa thinking visibility check max/i;
const QA_EMPTY_RESPONSE_RECOVERY_PROMPT_RE = /empty response continuation qa check/i;
const QA_EMPTY_RESPONSE_EXHAUSTION_PROMPT_RE = /empty response exhaustion qa check/i;
const QA_QUIET_STREAMING_PROMPT_RE = /quiet streaming qa check/i;
const QA_BLOCK_STREAMING_PROMPT_RE = /block streaming qa check/i;
const QA_SUBAGENT_DIRECT_FALLBACK_PROMPT_RE = /subagent direct fallback qa check/i;
const QA_SUBAGENT_DIRECT_FALLBACK_WORKER_RE = /subagent direct fallback worker/i;
const QA_SUBAGENT_DIRECT_FALLBACK_MARKER = "QA-SUBAGENT-DIRECT-FALLBACK-OK";
const QA_IMAGE_GENERATION_PROMPT_RE = /image generation check|capability flip image check/i;
const QA_REASONING_ONLY_RETRY_NEEDLE =
  "recorded reasoning but did not produce a user-visible answer";
const QA_EMPTY_RESPONSE_RETRY_NEEDLE =
  "The previous attempt did not produce a user-visible answer.";
const QA_SKILL_WORKSHOP_GIF_PROMPT_RE =
  /externally sourced animated GIF asset|animated GIF asset in a product UI/i;
const QA_SKILL_WORKSHOP_REVIEW_PROMPT_RE = /Review transcript for durable skill updates/i;
const QA_RELEASE_AUDIT_PROMPT_RE = /release readiness audit for the small project/i;

type MockScenarioState = {
  subagentFanoutPhase: number;
};

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

type AnthropicStreamEvent = Record<string, unknown> & {
  type: string;
};

function writeAnthropicSse(res: ServerResponse, events: AnthropicStreamEvent[]) {
  const body = events
    .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
    .join("");
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

function countImageInputs(value: unknown): number {
  const seen = new WeakSet<object>();
  const stack = [value];
  let count = 0;
  let visited = 0;
  while (stack.length > 0 && visited < 50_000) {
    visited += 1;
    const current = stack.pop();
    if (Array.isArray(current)) {
      for (const entry of current) {
        stack.push(entry);
      }
      continue;
    }
    if (!current || typeof current !== "object") {
      continue;
    }
    if (seen.has(current)) {
      continue;
    }
    seen.add(current);
    const record = current as Record<string, unknown>;
    const type = typeof record.type === "string" ? record.type : "";
    if (type === "input_image" || type === "image" || type === "image_url" || type === "media") {
      count += 1;
    }
    stack.push(record.content, record.image_url, record.source);
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
  const backtickedMatch = extractLastCapture(text, /reply(?: with)? exactly\s+`([^`]+)`/i);
  if (backtickedMatch) {
    return backtickedMatch;
  }
  return extractLastCapture(text, /reply(?: with)? exactly:\s*([^\n]+)/i);
}

function extractFinishExactlyDirective(text: string) {
  const backtickedMatch = extractLastCapture(text, /finish with exactly\s+`([^`]+)`/i);
  if (backtickedMatch) {
    return backtickedMatch;
  }
  return extractLastCapture(text, /finish with exactly\s+([^\s`.,;:!?]+)/i);
}

function extractExactMarkerDirective(text: string) {
  const backtickedMatch = extractLastCapture(text, /exact marker:\s*`([^`]+)`/i);
  if (backtickedMatch) {
    return backtickedMatch;
  }
  return extractLastCapture(text, /exact marker:\s*([^\s`.,;:!?]+(?:-[^\s`.,;:!?]+)*)/i);
}

function extractLabeledMarkerDirective(text: string, label: string) {
  const escapedLabel = label.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const backtickedMatch = extractLastCapture(
    text,
    new RegExp(`${escapedLabel}:\\s*\`([^\\\`]+)\``, "i"),
  );
  if (backtickedMatch) {
    return backtickedMatch;
  }
  return extractLastCapture(
    text,
    new RegExp(`${escapedLabel}:\\s*([^\\s\\\`.,;:!?]+(?:-[^\\s\\\`.,;:!?]+)*)`, "i"),
  );
}

function extractQuotedToolArg(text: string, name: string) {
  const escapedName = name.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return extractLastCapture(text, new RegExp(`\\b${escapedName}\\s*=\\s*"([^"]+)"`, "i"));
}

function extractBareToolArg(text: string, name: string) {
  const escapedName = name.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return extractLastCapture(text, new RegExp(`\\b${escapedName}\\s*=\\s*([^\\s\\\`.,;:!?]+)`, "i"));
}

function hasDeclaredTool(body: Record<string, unknown>, name: string) {
  const tools = Array.isArray(body.tools) ? body.tools : [];
  return tools.some((tool) => {
    if (!tool || typeof tool !== "object") {
      return false;
    }
    const record = tool as Record<string, unknown>;
    if (record.name === name) {
      return true;
    }
    const nested = record.function;
    return Boolean(
      nested && typeof nested === "object" && (nested as { name?: unknown }).name === name,
    );
  });
}

function buildExplicitSessionsSpawnArgs(text: string): Record<string, unknown> | null {
  if (!/\bsessions_spawn\b/i.test(text)) {
    return null;
  }
  const task = extractQuotedToolArg(text, "task");
  if (!task) {
    return null;
  }
  const label = extractQuotedToolArg(text, "label") ?? extractBareToolArg(text, "label");
  const mode = extractBareToolArg(text, "mode")?.toLowerCase();
  const context = extractBareToolArg(text, "context")?.toLowerCase();
  const runTimeoutSecondsRaw = extractBareToolArg(text, "runTimeoutSeconds");
  const runTimeoutSeconds =
    runTimeoutSecondsRaw && /^\d+$/.test(runTimeoutSecondsRaw)
      ? Number(runTimeoutSecondsRaw)
      : undefined;
  return {
    task,
    ...(label ? { label } : {}),
    ...(extractBareToolArg(text, "thread")?.toLowerCase() === "true" ? { thread: true } : {}),
    ...(mode === "session" || mode === "run" ? { mode } : {}),
    ...(context === "fork" || context === "isolated" ? { context } : {}),
    ...(runTimeoutSeconds !== undefined ? { runTimeoutSeconds } : {}),
  };
}

function extractToolErrorForNamedCall(params: {
  allInputText: string;
  input: ResponsesInputItem[];
  name: string;
  toolJson: Record<string, unknown> | null;
}) {
  const error = typeof params.toolJson?.error === "string" ? params.toolJson.error.trim() : "";
  if (!error) {
    return undefined;
  }
  const namedFunctionCall = params.input.some(
    (item) => item.type === "function_call" && item.name === params.name,
  );
  const namedPromptReference = new RegExp(`\\b${params.name}\\b`, "i").test(params.allInputText);
  if (namedFunctionCall || namedPromptReference) {
    return error;
  }
  return undefined;
}

function isHeartbeatPrompt(text: string) {
  const trimmed = text.trim();
  if (!trimmed || /remember this fact/i.test(trimmed)) {
    return false;
  }
  return /(?:^|\n)Read HEARTBEAT\.md if it exists\b/i.test(trimmed);
}

function buildAssistantText(
  input: ResponsesInputItem[],
  body: Record<string, unknown>,
  scenarioState: MockScenarioState,
) {
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
  const exactReplyDirective =
    extractExactReplyDirective(prompt) ?? extractExactReplyDirective(allInputText);
  const exactMarkerDirective =
    extractExactMarkerDirective(prompt) ?? extractExactMarkerDirective(allInputText);
  const finishExactlyDirective =
    extractFinishExactlyDirective(prompt) ?? extractFinishExactlyDirective(allInputText);
  const imageInputCount = countImageInputs(input);
  const activeMemorySummary = extractActiveMemorySummary(allInputText);
  const snackPreference = extractSnackPreference(activeMemorySummary ?? memorySnippet);
  const sessionsSpawnError = extractToolErrorForNamedCall({
    allInputText,
    input,
    name: "sessions_spawn",
    toolJson,
  });

  if (/what was the qa canary code/i.test(prompt) && rememberedFact) {
    return `Protocol note: the QA canary code was ${rememberedFact}.`;
  }
  if (sessionsSpawnError) {
    return `Protocol note: sessions_spawn failed: ${sessionsSpawnError}`;
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
  if (/\bmarker\b/i.test(allInputText) && exactReplyDirective) {
    return exactReplyDirective;
  }
  if (/\bmarker\b/i.test(allInputText) && exactMarkerDirective) {
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
  if (toolOutput && /repo contract followthrough check/i.test(prompt)) {
    if (
      /successfully (?:wrote|created|updated|replaced)/i.test(toolOutput) ||
      /status:\s*complete/i.test(toolOutput)
    ) {
      return [
        "Read: AGENT.md, SOUL.md, FOLLOWTHROUGH_INPUT.md",
        "Wrote: repo-contract-summary.txt",
        "Status: complete",
      ].join("\n");
    }
    return [
      "Read: AGENT.md, SOUL.md, FOLLOWTHROUGH_INPUT.md",
      "Wrote: repo-contract-summary.txt",
      "Status: blocked",
    ].join("\n");
  }
  if (/session memory ranking check/i.test(prompt) && orbitCode) {
    return `Protocol note: I checked memory and the current Project Nebula codename is ${orbitCode}.`;
  }
  if (/thread memory check/i.test(allInputText) && orbitCode) {
    return `Protocol note: I checked memory in-thread and the hidden thread codename is ${orbitCode}.`;
  }
  if (/switch(?:ing)? models?/i.test(prompt)) {
    return `Protocol note: model switch acknowledged. Continuing on ${model || "the requested model"}.`;
  }
  if (QA_IMAGE_GENERATION_PROMPT_RE.test(allInputText) && mediaPath) {
    return `Protocol note: generated the QA lighthouse image successfully.\nMEDIA:${mediaPath}`;
  }
  if (QA_SKILL_WORKSHOP_GIF_PROMPT_RE.test(prompt) && toolOutput) {
    return [
      "Animated GIF QA checklist ready.",
      "- Confirm true animation, not a static preview.",
      "- Verify dimensions and product UI fit.",
      "- Record attribution and license.",
      "- Keep a local copy before using the asset.",
      "- Re-open the copied file for final verification.",
    ].join("\n");
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
  if (QA_SUBAGENT_DIRECT_FALLBACK_WORKER_RE.test(prompt)) {
    return QA_SUBAGENT_DIRECT_FALLBACK_MARKER;
  }
  if (/report the visible code/i.test(prompt) && /FORKED-CONTEXT-ALPHA/i.test(allInputText)) {
    return "FORKED-CONTEXT-ALPHA";
  }
  const fanoutCompleteReply = "subagent-1: ok\nsubagent-2: ok";
  if (scenarioState.subagentFanoutPhase === 2 && prompt) {
    scenarioState.subagentFanoutPhase = 3;
    return fanoutCompleteReply;
  }
  if (
    /forked subagent context qa check/i.test(prompt) &&
    /FORKED-CONTEXT-ALPHA/i.test(allInputText)
  ) {
    return [
      "Worked",
      "- FORKED-CONTEXT-ALPHA",
      "Evidence",
      "- The forked child recovered the visible code from requester transcript context.",
      "Blocked",
      "- None.",
    ].join("\n");
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
  if (finishExactlyDirective) {
    return finishExactlyDirective;
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

function buildReleaseAuditJson() {
  return `${JSON.stringify(
    {
      verified: true,
      findings: [
        {
          id: "REL-GATEWAY-417",
          source: "src/gateway/reconnect.ts",
          status: "retry jitter verified, resume token fallback still needs manual spot check",
        },
        {
          id: "REL-CHANNEL-238",
          source: "src/channels/delivery.ts",
          status: "thread replies preserve ordering, root-channel fallback needs handoff note",
        },
        {
          id: "REL-CRON-904",
          source: "src/scheduling/cron.ts",
          status: "single-run lock verified for restart wakeups",
        },
        {
          id: "REL-MEMORY-552",
          source: "src/memory/recall.ts",
          status:
            "fallback summary survives empty memory search; ranking sample needs second reviewer",
        },
        {
          id: "REL-PLUGIN-319",
          source: "src/plugins/runtime.ts",
          status: "bundled runtime manifest loads cleanly after restart",
        },
        {
          id: "REL-INSTALL-846",
          source: "install/update.ts",
          status: "update smoke passed from previous stable tag",
        },
        {
          id: "REL-DOCS-611",
          source: "docs/operator-notes.md",
          status:
            "docs mention reconnect, cron, memory, plugin, and installer checks; channel ordering and UI notes need maintainer handoff",
        },
        {
          id: "REL-UI-BLOCKED",
          source: "ui/control-panel.ts",
          status: "blocked: source file was referenced by checklist but missing from the fixture",
        },
      ],
    },
    null,
    2,
  )}\n`;
}

function buildReleaseHandoffMarkdown() {
  return [
    "# Release Handoff",
    "",
    "Ready:",
    "- REL-GATEWAY-417: gateway reconnect handling checked in `src/gateway/reconnect.ts`.",
    "- REL-CRON-904: cron duplicate prevention checked in `src/scheduling/cron.ts`.",
    "- REL-PLUGIN-319: plugin runtime loading checked in `src/plugins/runtime.ts`.",
    "- REL-INSTALL-846: installer update path checked in `install/update.ts`.",
    "",
    "Follow-up:",
    "- REL-CHANNEL-238: channel delivery ordering needs maintainer handoff.",
    "- REL-MEMORY-552: memory recall fallback ranking sample needs a second reviewer.",
    "- REL-DOCS-611: docs update status needs channel ordering and UI notes.",
    "- `ui/control-panel.ts` is blocked/not found in the fixture.",
    "",
  ].join("\n");
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

function extractPlannedToolArgs(events: StreamEvent[]) {
  for (const event of events) {
    if (event.type !== "response.output_item.done") {
      continue;
    }
    const item = event.item as { type?: unknown; arguments?: unknown };
    if (item.type !== "function_call" || typeof item.arguments !== "string") {
      continue;
    }
    try {
      const parsed = JSON.parse(item.arguments);
      return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

type MockAssistantMessageSpec = {
  id: string;
  phase?: "commentary" | "final_answer";
  streamDeltas?: string[];
  text: string;
};

function splitMockStreamingText(text: string, parts = 3) {
  if (text.length <= 1) {
    return [text];
  }
  const chunkSize = Math.max(1, Math.ceil(text.length / parts));
  const chunks: string[] = [];
  for (let index = 0; index < text.length; index += chunkSize) {
    chunks.push(text.slice(index, index + chunkSize));
  }
  return chunks.length > 1 ? chunks : [text.slice(0, 1), text.slice(1)];
}

function buildAssistantOutputItem(spec: MockAssistantMessageSpec) {
  return {
    type: "message",
    id: spec.id,
    role: "assistant",
    status: "completed",
    ...(spec.phase ? { phase: spec.phase } : {}),
    content: [{ type: "output_text", text: spec.text, annotations: [] }],
  } as const;
}

function buildAssistantEvents(specsOrText: MockAssistantMessageSpec[] | string): StreamEvent[] {
  const specs =
    typeof specsOrText === "string"
      ? [
          {
            id: "msg_mock_1",
            text: specsOrText,
          },
        ]
      : specsOrText;
  const output = specs.map((spec) => buildAssistantOutputItem(spec));
  const events: StreamEvent[] = [];

  for (const [outputIndex, spec] of specs.entries()) {
    events.push({
      type: "response.output_item.added",
      item: {
        type: "message",
        id: spec.id,
        role: "assistant",
        ...(spec.phase ? { phase: spec.phase } : {}),
        content: [],
        status: "in_progress",
      },
    });
    for (const delta of spec.streamDeltas ?? []) {
      events.push({
        type: "response.output_text.delta",
        item_id: spec.id,
        output_index: outputIndex,
        content_index: 0,
        delta,
      });
    }
    if ((spec.streamDeltas ?? []).length > 0) {
      events.push({
        type: "response.output_text.done",
        item_id: spec.id,
        output_index: outputIndex,
        content_index: 0,
        text: spec.text,
      });
    }
    events.push({
      type: "response.output_item.done",
      item: output[outputIndex],
    });
  }

  events.push({
    type: "response.completed",
    response: {
      id: "resp_mock_msg_1",
      status: "completed",
      output,
      usage: { input_tokens: 64, output_tokens: 24, total_tokens: 88 },
    },
  });
  return events;
}

function buildReasoningOnlyEvents(summaryText: string, id: string): StreamEvent[] {
  const reasoningItem = {
    type: "reasoning",
    id,
    summary: [{ text: summaryText }],
  } as const;
  return [
    {
      type: "response.output_item.added",
      item: {
        type: "reasoning",
        id,
        summary: [],
      },
    },
    {
      type: "response.output_item.done",
      item: reasoningItem,
    },
    {
      type: "response.completed",
      response: {
        id: `resp_${id}`,
        status: "completed",
        output: [reasoningItem],
        usage: { input_tokens: 64, output_tokens: 8, total_tokens: 72 },
      },
    },
  ];
}

function buildReasoningAndAssistantEvents(params: {
  reasoningId: string;
  answerText: string;
  answerId?: string;
}): StreamEvent[] {
  const reasoningItem = {
    type: "reasoning",
    id: params.reasoningId,
    summary: [],
  } as const;
  const answerItem = buildAssistantOutputItem({
    id: params.answerId ?? "msg_mock_reasoned_answer",
    phase: "final_answer",
    text: params.answerText,
  });
  return [
    {
      type: "response.output_item.added",
      item: {
        type: "reasoning",
        id: params.reasoningId,
        summary: [],
      },
    },
    {
      type: "response.output_item.done",
      item: reasoningItem,
    },
    {
      type: "response.output_item.added",
      item: {
        type: "message",
        id: answerItem.id,
        role: "assistant",
        phase: "final_answer",
        content: [],
        status: "in_progress",
      },
    },
    {
      type: "response.output_item.done",
      item: answerItem,
    },
    {
      type: "response.completed",
      response: {
        id: `resp_${params.reasoningId}`,
        status: "completed",
        output: [reasoningItem, answerItem],
        usage: { input_tokens: 64, output_tokens: 16, total_tokens: 80 },
      },
    },
  ];
}

async function buildResponsesPayload(
  body: Record<string, unknown>,
  scenarioState: MockScenarioState,
) {
  const input = Array.isArray(body.input) ? (body.input as ResponsesInputItem[]) : [];
  const prompt = extractLastUserText(input);
  const toolOutput = extractToolOutput(input);
  const toolJson = parseToolOutputJson(toolOutput);
  const allInputText = extractAllRequestTexts(input, body);
  const exactReplyDirective =
    extractExactReplyDirective(prompt) ?? extractExactReplyDirective(allInputText);
  const exactMarkerDirective =
    extractExactMarkerDirective(prompt) ?? extractExactMarkerDirective(allInputText);
  const firstExactMarkerDirective = extractLabeledMarkerDirective(
    allInputText,
    "first exact marker",
  );
  const secondExactMarkerDirective = extractLabeledMarkerDirective(
    allInputText,
    "second exact marker",
  );
  const isGroupChat = allInputText.includes('"is_group_chat": true');
  const isBaselineUnmentionedChannelChatter = /\bno bot ping here\b/i.test(prompt);
  const hasReasoningOnlyRetryInstruction = allInputText.includes(QA_REASONING_ONLY_RETRY_NEEDLE);
  const hasEmptyResponseRetryInstruction = allInputText.includes(QA_EMPTY_RESPONSE_RETRY_NEEDLE);
  const canCallSessionsSpawn = hasDeclaredTool(body, "sessions_spawn");
  const canCallSessionsYield = hasDeclaredTool(body, "sessions_yield");
  if (
    allInputText.includes(QA_SUBAGENT_DIRECT_FALLBACK_MARKER) &&
    /Internal task completion event/i.test(allInputText)
  ) {
    return buildAssistantEvents("");
  }
  if (QA_SUBAGENT_DIRECT_FALLBACK_PROMPT_RE.test(allInputText)) {
    if (!toolOutput && canCallSessionsSpawn) {
      return buildToolCallEventsWithArgs("sessions_spawn", {
        task: `Subagent direct fallback worker: finish with exactly ${QA_SUBAGENT_DIRECT_FALLBACK_MARKER}.`,
        label: "qa-direct-fallback-worker",
        thread: false,
        mode: "run",
        runTimeoutSeconds: 30,
      });
    }
    if (toolOutput && canCallSessionsYield && !/\byielded\b/i.test(toolOutput)) {
      return buildToolCallEventsWithArgs("sessions_yield", {
        message: `Waiting for ${QA_SUBAGENT_DIRECT_FALLBACK_MARKER}.`,
      });
    }
  }
  if (/remember this fact/i.test(prompt)) {
    return buildAssistantEvents(buildAssistantText(input, body, scenarioState));
  }
  if (isHeartbeatPrompt(prompt)) {
    return buildAssistantEvents("HEARTBEAT_OK");
  }
  if (QA_REASONING_ONLY_RECOVERY_PROMPT_RE.test(allInputText)) {
    if (!toolOutput) {
      return buildToolCallEventsWithArgs("read", { path: "QA_KICKOFF_TASK.md" });
    }
    if (!hasReasoningOnlyRetryInstruction) {
      return buildReasoningOnlyEvents(
        "Need visible answer after reading the QA kickoff task.",
        "rs_mock_reasoning_recovery",
      );
    }
    return buildAssistantEvents("REASONING-RECOVERED-OK");
  }
  if (QA_REASONING_ONLY_SIDE_EFFECT_PROMPT_RE.test(allInputText)) {
    if (!toolOutput) {
      return buildToolCallEventsWithArgs("write", {
        path: "reasoning-only-side-effect.txt",
        content: "side effects already happened\n",
      });
    }
    if (!hasReasoningOnlyRetryInstruction) {
      return buildReasoningOnlyEvents(
        "Need visible answer after the write, but the write already happened.",
        "rs_mock_reasoning_side_effect",
      );
    }
    return buildAssistantEvents("BUG-SHOULD-NOT-AUTO-RETRY");
  }
  if (QA_THINKING_VISIBILITY_MAX_PROMPT_RE.test(prompt)) {
    return buildReasoningAndAssistantEvents({
      reasoningId: "rs_mock_thinking_visibility_max",
      answerText: "THINKING-MAX-OK",
    });
  }
  if (QA_THINKING_VISIBILITY_OFF_PROMPT_RE.test(prompt)) {
    return buildAssistantEvents("THINKING-OFF-OK");
  }
  if (QA_EMPTY_RESPONSE_RECOVERY_PROMPT_RE.test(allInputText)) {
    if (!toolOutput) {
      return buildToolCallEventsWithArgs("read", { path: "QA_KICKOFF_TASK.md" });
    }
    if (!hasEmptyResponseRetryInstruction) {
      return buildAssistantEvents("");
    }
    return buildAssistantEvents("EMPTY-RECOVERED-OK");
  }
  if (QA_EMPTY_RESPONSE_EXHAUSTION_PROMPT_RE.test(allInputText)) {
    if (!toolOutput) {
      return buildToolCallEventsWithArgs("read", { path: "QA_KICKOFF_TASK.md" });
    }
    return buildAssistantEvents("");
  }
  if (QA_QUIET_STREAMING_PROMPT_RE.test(allInputText) && exactReplyDirective) {
    return buildAssistantEvents([
      {
        id: "msg_mock_quiet_stream",
        phase: "final_answer",
        streamDeltas: splitMockStreamingText(exactReplyDirective),
        text: exactReplyDirective,
      },
    ]);
  }
  if (
    QA_BLOCK_STREAMING_PROMPT_RE.test(allInputText) &&
    firstExactMarkerDirective &&
    secondExactMarkerDirective
  ) {
    return buildAssistantEvents([
      {
        id: "msg_mock_block_1",
        phase: "final_answer",
        streamDeltas: splitMockStreamingText(firstExactMarkerDirective),
        text: firstExactMarkerDirective,
      },
      {
        id: "msg_mock_block_2",
        phase: "final_answer",
        streamDeltas: splitMockStreamingText(secondExactMarkerDirective),
        text: secondExactMarkerDirective,
      },
    ]);
  }
  if (/\bmarker\b/i.test(allInputText) && exactReplyDirective) {
    return buildAssistantEvents(exactReplyDirective);
  }
  if (/\bmarker\b/i.test(allInputText) && exactMarkerDirective) {
    return buildAssistantEvents(exactMarkerDirective);
  }
  if (QA_SKILL_WORKSHOP_REVIEW_PROMPT_RE.test(allInputText)) {
    return buildAssistantEvents(
      JSON.stringify({
        action: "create",
        skillName: "animated-gif-workflow",
        title: "Animated GIF Workflow",
        reason: "Transcript captured a reusable animated media QA checklist.",
        description: "Reusable workflow notes for animated GIF QA tasks.",
        body: [
          "- Confirm the asset has true animation, not a static preview.",
          "- Check dimensions against the target product UI slot.",
          "- Record attribution and license before using the file.",
          "- Keep a local copy under the workspace before integration.",
          "- Re-open the local copy for final verification.",
        ].join("\n"),
      }),
    );
  }
  if (QA_SKILL_WORKSHOP_GIF_PROMPT_RE.test(prompt) && !toolOutput) {
    return buildToolCallEventsWithArgs("write", {
      path: "animated-gif-qa-checklist.md",
      content: [
        "# Animated GIF QA Checklist",
        "",
        "- Confirm true animation.",
        "- Verify dimensions.",
        "- Record attribution.",
        "- Keep a local copy.",
        "- Perform final verification.",
      ].join("\n"),
    });
  }
  if (QA_RELEASE_AUDIT_PROMPT_RE.test(prompt)) {
    if (!toolOutput) {
      return buildToolCallEventsWithArgs("read", { path: "audit-fixture/README.md" });
    }
    if (/Release readiness task|current checklist/i.test(toolOutput)) {
      return buildToolCallEventsWithArgs("read", {
        path: "audit-fixture/docs/current-readiness-checklist.md",
      });
    }
    if (/Current release readiness requires checking eight areas/i.test(toolOutput)) {
      return buildToolCallEventsWithArgs("write", {
        path: "audit-fixture/release-audit.json",
        content: buildReleaseAuditJson(),
      });
    }
    if (/release-audit\.json/i.test(toolOutput)) {
      return buildToolCallEventsWithArgs("write", {
        path: "audit-fixture/release-handoff.md",
        content: buildReleaseHandoffMarkdown(),
      });
    }
    if (/release-handoff\.md/i.test(toolOutput)) {
      return buildAssistantEvents("RELEASE-AUDIT-COMPLETE");
    }
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
        corpus: "sessions",
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
  if (/thread memory check/i.test(allInputText)) {
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
  if (QA_IMAGE_GENERATION_PROMPT_RE.test(allInputText) && !toolOutput) {
    return buildToolCallEventsWithArgs("image_generate", {
      prompt: "A QA lighthouse on a dark sea with a tiny protocol droid silhouette.",
      filename: "qa-lighthouse.png",
      size: "1024x1024",
    });
  }
  if (canCallSessionsSpawn && /subagent fanout synthesis check/i.test(prompt)) {
    if (!toolOutput && scenarioState.subagentFanoutPhase === 0) {
      scenarioState.subagentFanoutPhase = 1;
      return buildToolCallEventsWithArgs("sessions_spawn", {
        task: "Fanout worker alpha: inspect the QA workspace and finish with exactly ALPHA-OK.",
        label: "qa-fanout-alpha",
        thread: false,
      });
    }
    if (toolOutput && scenarioState.subagentFanoutPhase === 1) {
      scenarioState.subagentFanoutPhase = 2;
      return buildToolCallEventsWithArgs("sessions_spawn", {
        task: "Fanout worker beta: inspect the QA workspace and finish with exactly BETA-OK.",
        label: "qa-fanout-beta",
        thread: false,
      });
    }
  }
  const explicitSessionsSpawnArgs = buildExplicitSessionsSpawnArgs(allInputText);
  if (canCallSessionsSpawn && explicitSessionsSpawnArgs && !toolOutput) {
    return buildToolCallEventsWithArgs("sessions_spawn", explicitSessionsSpawnArgs);
  }
  if (canCallSessionsSpawn && /forked subagent context qa check/i.test(prompt) && !toolOutput) {
    return buildToolCallEventsWithArgs("sessions_spawn", {
      task: "Report the visible code from the requester transcript.",
      label: "qa-fork-context",
      mode: "run",
      context: "fork",
    });
  }
  if (/tool continuity check/i.test(prompt) && !toolOutput) {
    return buildToolCallEventsWithArgs("read", { path: "QA_KICKOFF_TASK.md" });
  }
  if (/repo contract followthrough check/i.test(prompt)) {
    if (!toolOutput) {
      return buildToolCallEventsWithArgs("read", { path: "AGENT.md" });
    }
    if (toolOutput.includes("# Repo contract")) {
      return buildToolCallEventsWithArgs("read", { path: "SOUL.md" });
    }
    if (toolOutput.includes("# Execution style")) {
      return buildToolCallEventsWithArgs("read", { path: "FOLLOWTHROUGH_INPUT.md" });
    }
    if (
      toolOutput.includes("Mission: prove you followed the repo contract.") &&
      toolOutput.includes("Evidence path: AGENT.md -> SOUL.md -> FOLLOWTHROUGH_INPUT.md")
    ) {
      return buildToolCallEventsWithArgs("write", {
        path: "repo-contract-summary.txt",
        content: [
          "Mission: prove you followed the repo contract.",
          "Evidence: AGENT.md -> SOUL.md -> FOLLOWTHROUGH_INPUT.md",
          "Status: complete",
        ].join("\n"),
      });
    }
  }
  if (
    canCallSessionsSpawn &&
    (/\bdelegate\b/i.test(prompt) || /subagent handoff/i.test(prompt)) &&
    !toolOutput
  ) {
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
  return buildAssistantEvents(buildAssistantText(input, body, scenarioState));
}

// ---------------------------------------------------------------------------
// Anthropic /v1/messages adapter
// ---------------------------------------------------------------------------
//
// The QA parity gate needs two comparable scenario runs: one against the
// "candidate" (openai/gpt-5.5) and one against the "baseline"
// (anthropic/claude-opus-4-6). The OpenAI mock above already dispatches all
// the scenario prompt branches we care about. Rather than duplicating that
// machinery, the /v1/messages route below translates Anthropic request
// shapes into the shared ResponsesInputItem[] format, calls the same
// buildResponsesPayload() dispatcher, and then re-serializes the resulting
// events into an Anthropic response. This gives the parity harness a
// baseline lane that exercises the same scenario logic without requiring
// real Anthropic API keys.
//
// Scope: handles Anthropic Messages requests with text and tool_result
// content blocks, supporting both non-streaming JSON responses and the
// streaming SSE path used by the parity harness.

function normalizeAnthropicSystemToString(
  system: AnthropicMessagesRequest["system"],
): string | undefined {
  if (typeof system === "string") {
    return system.trim() || undefined;
  }
  if (Array.isArray(system)) {
    const joined = system
      .map((block) => (block?.type === "text" ? block.text : ""))
      .filter(Boolean)
      .join("\n")
      .trim();
    return joined || undefined;
  }
  return undefined;
}

function stringifyToolResultContent(
  content: Extract<AnthropicMessageContentBlock, { type: "tool_result" }>["content"],
): string {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((block) => (block?.type === "text" ? block.text : ""))
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

function convertAnthropicMessagesToResponsesInput(params: {
  system?: AnthropicMessagesRequest["system"];
  messages: AnthropicMessage[];
}): ResponsesInputItem[] {
  const items: ResponsesInputItem[] = [];
  const systemText = normalizeAnthropicSystemToString(params.system);
  if (systemText) {
    items.push({
      role: "system",
      content: [{ type: "input_text", text: systemText }],
    });
  }
  for (const message of params.messages) {
    const content = message.content;
    if (typeof content === "string") {
      items.push({
        role: message.role,
        content: [
          message.role === "assistant"
            ? { type: "output_text", text: content }
            : { type: "input_text", text: content },
        ],
      });
      continue;
    }
    if (!Array.isArray(content)) {
      continue;
    }
    // Buffer each block type so we can push in OpenAI-Responses order instead
    // of the order they appear in the Anthropic content array. The parent
    // role message must precede any function_call_output items from the same
    // turn, otherwise extractToolOutput() (which scans for
    // function_call_output AFTER the last user-role index) will not see the
    // output and the downstream scenario dispatcher will behave as if no
    // tool output was returned. Similarly, assistant tool_use blocks become
    // function_call items that must follow the assistant text message they
    // narrate.
    const textPieces: Array<{ type: "input_text" | "output_text"; text: string }> = [];
    const imagePieces: Array<{ type: "input_image"; image_url: string }> = [];
    const toolResultItems: ResponsesInputItem[] = [];
    const toolUseItems: ResponsesInputItem[] = [];
    for (const block of content) {
      if (!block || typeof block !== "object") {
        continue;
      }
      if (block.type === "text") {
        textPieces.push({
          type: message.role === "assistant" ? "output_text" : "input_text",
          text: block.text ?? "",
        });
        continue;
      }
      if (block.type === "image") {
        // Mock only needs to count image inputs; a placeholder URL is fine.
        imagePieces.push({ type: "input_image", image_url: "anthropic-mock:image" });
        continue;
      }
      if (block.type === "tool_result") {
        const output = stringifyToolResultContent(block.content);
        if (output.trim()) {
          toolResultItems.push({ type: "function_call_output", output });
        }
        continue;
      }
      if (block.type === "tool_use") {
        // Mirror OpenAI's function_call output_item shape so downstream
        // prompt extraction still sees "the assistant just emitted a tool
        // call". The scenario dispatcher looks for tool_output on the next
        // user turn, not the assistant's prior tool_use, so a minimal
        // placeholder is enough.
        toolUseItems.push({
          type: "function_call",
          name: block.name,
          arguments: JSON.stringify(block.input ?? {}),
          call_id: block.id,
        });
        continue;
      }
    }
    if (textPieces.length > 0 || imagePieces.length > 0) {
      const combinedContent: Array<Record<string, unknown>> = [...textPieces, ...imagePieces];
      items.push({ role: message.role, content: combinedContent });
    }
    // Emit tool_use (assistant prior calls) and tool_result (user-side
    // returns) AFTER the parent role message so extractLastUserText and
    // extractToolOutput walk the array in the order they expect. For a
    // tool_result-only user turn with no text/image blocks, the parent
    // message is intentionally omitted — the function_call_output itself
    // represents the user's "return the tool output" turn.
    for (const toolUse of toolUseItems) {
      items.push(toolUse);
    }
    for (const toolResult of toolResultItems) {
      items.push(toolResult);
    }
  }
  return items;
}

type ExtractedAssistantOutput = {
  text: string;
  toolCalls: Array<{ id: string; name: string; input: Record<string, unknown> }>;
};

function extractFinalAssistantOutputFromEvents(events: StreamEvent[]): ExtractedAssistantOutput {
  const toolCalls: ExtractedAssistantOutput["toolCalls"] = [];
  let text = "";
  for (const event of events) {
    if (event.type !== "response.output_item.done") {
      continue;
    }
    const item = event.item as {
      type?: unknown;
      name?: unknown;
      call_id?: unknown;
      id?: unknown;
      arguments?: unknown;
      content?: unknown;
    };
    if (item.type === "function_call" && typeof item.name === "string") {
      let input: Record<string, unknown> = {};
      if (typeof item.arguments === "string" && item.arguments.trim()) {
        try {
          const parsed = JSON.parse(item.arguments) as unknown;
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            input = parsed as Record<string, unknown>;
          }
        } catch {
          // keep empty input on malformed args — mock dispatcher owns arg shape
        }
      }
      toolCalls.push({
        id: typeof item.call_id === "string" ? item.call_id : `toolu_mock_${toolCalls.length + 1}`,
        name: item.name,
        input,
      });
      continue;
    }
    if (item.type === "message" && Array.isArray(item.content)) {
      for (const piece of item.content as Array<{ type?: unknown; text?: unknown }>) {
        if (piece?.type === "output_text" && typeof piece.text === "string") {
          text = piece.text;
        }
      }
    }
  }
  return { text, toolCalls };
}

function buildAnthropicMessageResponse(params: {
  model: string;
  extracted: ExtractedAssistantOutput;
}): Record<string, unknown> {
  const content: Array<Record<string, unknown>> = [];
  if (params.extracted.text) {
    content.push({ type: "text", text: params.extracted.text });
  }
  for (const call of params.extracted.toolCalls) {
    content.push({
      type: "tool_use",
      id: call.id,
      name: call.name,
      input: call.input,
    });
  }
  if (content.length === 0) {
    content.push({ type: "text", text: "" });
  }
  const stopReason = params.extracted.toolCalls.length > 0 ? "tool_use" : "end_turn";
  const approxInputTokens = 64;
  const approxOutputTokens = Math.max(
    16,
    countApproxTokens(params.extracted.text) + params.extracted.toolCalls.length * 16,
  );
  return {
    id: `msg_mock_${Math.floor(Math.random() * 1_000_000).toString(16)}`,
    type: "message",
    role: "assistant",
    model: params.model || "claude-opus-4-6",
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: approxInputTokens,
      output_tokens: approxOutputTokens,
    },
  };
}

function buildAnthropicMessageStreamEvents(params: {
  model: string;
  extracted: ExtractedAssistantOutput;
}): AnthropicStreamEvent[] {
  const approxInputTokens = 64;
  const approxOutputTokens = Math.max(
    16,
    countApproxTokens(params.extracted.text) + params.extracted.toolCalls.length * 16,
  );
  const messageId = `msg_mock_${Math.floor(Math.random() * 1_000_000).toString(16)}`;
  const events: AnthropicStreamEvent[] = [
    {
      type: "message_start",
      message: {
        id: messageId,
        type: "message",
        role: "assistant",
        model: params.model || "claude-opus-4-6",
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: {
          input_tokens: approxInputTokens,
          output_tokens: 0,
        },
      },
    },
  ];
  let index = 0;
  if (params.extracted.text || params.extracted.toolCalls.length === 0) {
    events.push({
      type: "content_block_start",
      index,
      content_block: {
        type: "text",
        text: "",
      },
    });
    if (params.extracted.text) {
      events.push({
        type: "content_block_delta",
        index,
        delta: {
          type: "text_delta",
          text: params.extracted.text,
        },
      });
    }
    events.push({
      type: "content_block_stop",
      index,
    });
    index += 1;
  }
  for (const call of params.extracted.toolCalls) {
    events.push({
      type: "content_block_start",
      index,
      content_block: {
        type: "tool_use",
        id: call.id,
        name: call.name,
        input: {},
      },
    });
    events.push({
      type: "content_block_delta",
      index,
      delta: {
        type: "input_json_delta",
        partial_json: JSON.stringify(call.input ?? {}),
      },
    });
    events.push({
      type: "content_block_stop",
      index,
    });
    index += 1;
  }
  events.push({
    type: "message_delta",
    delta: {
      stop_reason: params.extracted.toolCalls.length > 0 ? "tool_use" : "end_turn",
    },
    usage: {
      input_tokens: approxInputTokens,
      output_tokens: approxOutputTokens,
    },
  });
  events.push({
    type: "message_stop",
  });
  return events;
}

async function buildMessagesPayload(
  body: AnthropicMessagesRequest,
  scenarioState: MockScenarioState,
): Promise<{
  events: StreamEvent[];
  input: ResponsesInputItem[];
  extracted: ExtractedAssistantOutput;
  responseBody: Record<string, unknown>;
  streamEvents: AnthropicStreamEvent[];
  model: string;
}> {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const input = convertAnthropicMessagesToResponsesInput({
    system: body.system,
    messages,
  });
  // Treat empty-string model the same as absent. A bare typeof check lets
  // `""` leak through to `responseBody.model` and `lastRequest.model`,
  // which then confuses parity consumers that assume the mock always
  // echoes the real provider label. Normalize once and reuse everywhere.
  const normalizedModel =
    typeof body.model === "string" && body.model.trim() !== "" ? body.model : "claude-opus-4-6";
  // Dispatch through the same scenario logic the /v1/responses route uses.
  // Preserve declared tools so route-specific adapters mirror what the
  // real provider request made available to the model.
  const dispatchBody: Record<string, unknown> = {
    input,
    model: normalizedModel,
    stream: false,
    ...(Array.isArray(body.tools) ? { tools: body.tools } : {}),
  };
  const events = await buildResponsesPayload(dispatchBody, scenarioState);
  const extracted = extractFinalAssistantOutputFromEvents(events);
  const responseBody = buildAnthropicMessageResponse({
    model: normalizedModel,
    extracted,
  });
  const streamEvents = buildAnthropicMessageStreamEvents({
    model: normalizedModel,
    extracted,
  });
  return { events, input, extracted, responseBody, streamEvents, model: normalizedModel };
}

export async function startQaMockOpenAiServer(params?: { host?: string; port?: number }) {
  const host = params?.host ?? "127.0.0.1";
  const scenarioState: MockScenarioState = { subagentFanoutPhase: 0 };
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
          { id: "gpt-5.5", object: "model" },
          { id: "gpt-5.5-alt", object: "model" },
          { id: "gpt-image-1", object: "model" },
          { id: "text-embedding-3-small", object: "model" },
          { id: "claude-opus-4-6", object: "model" },
          { id: "claude-sonnet-4-6", object: "model" },
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
      const events = await buildResponsesPayload(body, scenarioState);
      const resolvedModel = typeof body.model === "string" ? body.model : "";
      lastRequest = {
        raw,
        body,
        prompt: extractLastUserText(input),
        allInputText: extractAllRequestTexts(input, body),
        instructions: extractInstructionsText(body) || undefined,
        toolOutput: extractToolOutput(input),
        model: resolvedModel,
        providerVariant: resolveProviderVariant(resolvedModel),
        imageInputCount: countImageInputs(input),
        plannedToolName: extractPlannedToolName(events),
        plannedToolArgs: extractPlannedToolArgs(events),
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
    if (req.method === "POST" && url.pathname === "/v1/messages") {
      const raw = await readBody(req);
      let body: AnthropicMessagesRequest = {};
      try {
        body = raw ? (JSON.parse(raw) as AnthropicMessagesRequest) : {};
      } catch {
        writeJson(res, 400, {
          type: "error",
          error: {
            type: "invalid_request_error",
            message: "Malformed JSON body for Anthropic Messages request.",
          },
        });
        return;
      }
      const {
        events,
        input,
        responseBody,
        streamEvents,
        model: normalizedModel,
      } = await buildMessagesPayload(body, scenarioState);
      // Record the adapted request snapshot so /debug/requests gives the QA
      // suite the same plannedToolName / allInputText / toolOutput signals
      // on the Anthropic route that the OpenAI route already exposes. This
      // is what lets a single parity run diff assertions across both lanes.
      // Reuse the normalized model so an empty-string body.model no longer
      // leaks through to `lastRequest.model`.
      lastRequest = {
        raw,
        body: body as Record<string, unknown>,
        prompt: extractLastUserText(input),
        allInputText: extractAllInputTexts(input),
        toolOutput: extractToolOutput(input),
        model: normalizedModel,
        providerVariant: resolveProviderVariant(normalizedModel),
        imageInputCount: countImageInputs(input),
        plannedToolName: extractPlannedToolName(events),
        plannedToolArgs: extractPlannedToolArgs(events),
      };
      requests.push(lastRequest);
      if (requests.length > 50) {
        requests.splice(0, requests.length - 50);
      }
      if (body.stream === true) {
        writeAnthropicSse(res, streamEvents);
        return;
      }
      writeJson(res, 200, responseBody);
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
