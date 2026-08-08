import { createHash } from "node:crypto";
import { SessionManager } from "../../src/agents/sessions/session-manager.js";
import type { OpenClawConfig } from "../../src/config/config.js";
import { resolveAgentModelPrimaryValue } from "../../src/config/model-input.js";

export const OPENAI_LONG_CONTEXT_LIVE_ENV = "OPENCLAW_LIVE_OPENAI_LONG_CONTEXT";
export const OPENAI_LONG_CONTEXT_PROFILE_ENV = "OPENCLAW_LIVE_OPENAI_LONG_CONTEXT_PROFILE";
export const OPENAI_LONG_CONTEXT_METRICS_ENV = "OPENCLAW_LIVE_OPENAI_LONG_CONTEXT_METRICS";
export const OPENAI_LONG_OUTPUT_ENV = "OPENCLAW_LIVE_OPENAI_LONG_CONTEXT_OUTPUT";
const OPENAI_LONG_TOOL_OUTPUT_ENV = "OPENCLAW_LIVE_OPENAI_LONG_CONTEXT_TOOL_OUTPUT";
export const OPENAI_LONG_TOOL_BYTES_ENV = "OPENCLAW_LIVE_OPENAI_LONG_CONTEXT_TOOL_BYTES";

const OFFICIAL_OPENAI_BASE_URL = "https://api.openai.com/v1";
const OPENAI_RESPONSES_API = "openai-responses";
const OPENCLAW_RUNTIME = "openclaw";
const TOOL_BYTES_MIN = 300_000;
const TOOL_BYTES_MAX = 800_000;

export type OpenAILongContextProfile = {
  name: "reduced" | "full";
  provider: "openai";
  modelId: string;
  modelRef: string;
  api: typeof OPENAI_RESPONSES_API;
  baseUrl: typeof OFFICIAL_OPENAI_BASE_URL;
  runtime: typeof OPENCLAW_RUNTIME;
  contextWindow: number;
  contextTokens: number;
  maxTokens: number;
  compactThreshold: number;
  denseTurnChars: number;
  maxDenseTurns: number;
  defaultToolBytes: number;
  requestTimeoutMs: number;
  suiteTimeoutMs: number;
};

const PROFILES = {
  reduced: {
    name: "reduced",
    provider: "openai",
    modelId: "gpt-5.6-luna",
    modelRef: "openai/gpt-5.6-luna",
    api: OPENAI_RESPONSES_API,
    baseUrl: OFFICIAL_OPENAI_BASE_URL,
    runtime: OPENCLAW_RUNTIME,
    contextWindow: 48_000,
    contextTokens: 48_000,
    maxTokens: 8_192,
    compactThreshold: 32_000,
    denseTurnChars: 120_000,
    maxDenseTurns: 8,
    defaultToolBytes: 300_000,
    requestTimeoutMs: 2 * 60_000,
    suiteTimeoutMs: 10 * 60_000,
  },
  full: {
    name: "full",
    provider: "openai",
    modelId: "gpt-5.6-sol",
    modelRef: "openai/gpt-5.6-sol",
    api: OPENAI_RESPONSES_API,
    baseUrl: OFFICIAL_OPENAI_BASE_URL,
    runtime: OPENCLAW_RUNTIME,
    contextWindow: 1_050_000,
    contextTokens: 922_000,
    maxTokens: 128_000,
    compactThreshold: 700_000,
    denseTurnChars: 900_000,
    maxDenseTurns: 12,
    defaultToolBytes: 600_000,
    requestTimeoutMs: 10 * 60_000,
    suiteTimeoutMs: 60 * 60_000,
  },
} as const satisfies Record<string, OpenAILongContextProfile>;

type OpenAILongContextLiveSettings =
  | { enabled: false }
  | {
      enabled: true;
      apiKey: string;
      emitMetrics: boolean;
      runLongOutput: boolean;
      runToolOutput: boolean;
      toolOutputBytes: number;
      profile: OpenAILongContextProfile;
    };

function readStrictFlag(name: string, raw: string | undefined, fallback = false): boolean {
  if (raw === undefined || raw.trim() === "") {
    return fallback;
  }
  if (raw === "1") {
    return true;
  }
  if (raw === "0") {
    return false;
  }
  throw new Error(`${name} must be exactly 0 or 1`);
}

function readBoundedInteger(params: {
  name: string;
  raw: string | undefined;
  fallback: number;
  min: number;
  max: number;
}): number {
  if (params.raw === undefined || params.raw.trim() === "") {
    return params.fallback;
  }
  if (!/^\d+$/u.test(params.raw)) {
    throw new Error(`${params.name} must be a base-10 integer`);
  }
  const value = Number(params.raw);
  if (!Number.isSafeInteger(value) || value < params.min || value > params.max) {
    throw new Error(`${params.name} must be between ${params.min} and ${params.max}`);
  }
  return value;
}

export function resolveOpenAILongContextLiveSettings(
  env: Record<string, string | undefined>,
  liveEnabled: boolean,
): OpenAILongContextLiveSettings {
  const explicitlyEnabled = readStrictFlag(
    OPENAI_LONG_CONTEXT_LIVE_ENV,
    env[OPENAI_LONG_CONTEXT_LIVE_ENV],
  );
  if (!explicitlyEnabled) {
    return { enabled: false };
  }
  if (!liveEnabled) {
    throw new Error(`${OPENAI_LONG_CONTEXT_LIVE_ENV}=1 also requires OPENCLAW_LIVE_TEST=1`);
  }
  const rawProfile = env[OPENAI_LONG_CONTEXT_PROFILE_ENV]?.trim();
  if (rawProfile !== "reduced" && rawProfile !== "full") {
    throw new Error(`${OPENAI_LONG_CONTEXT_PROFILE_ENV} must be reduced or full`);
  }
  const apiKey = env.OPENAI_API_KEY?.trim();
  if (!apiKey) {
    throw new Error(`${OPENAI_LONG_CONTEXT_LIVE_ENV}=1 requires OPENAI_API_KEY`);
  }
  const profile = PROFILES[rawProfile];
  return {
    enabled: true,
    apiKey,
    profile: { ...profile },
    emitMetrics: readStrictFlag(
      OPENAI_LONG_CONTEXT_METRICS_ENV,
      env[OPENAI_LONG_CONTEXT_METRICS_ENV],
    ),
    runLongOutput: readStrictFlag(OPENAI_LONG_OUTPUT_ENV, env[OPENAI_LONG_OUTPUT_ENV]),
    runToolOutput: readStrictFlag(OPENAI_LONG_TOOL_OUTPUT_ENV, env[OPENAI_LONG_TOOL_OUTPUT_ENV]),
    toolOutputBytes: readBoundedInteger({
      name: OPENAI_LONG_TOOL_BYTES_ENV,
      raw: env[OPENAI_LONG_TOOL_BYTES_ENV],
      fallback: profile.defaultToolBytes,
      min: TOOL_BYTES_MIN,
      max: TOOL_BYTES_MAX,
    }),
  };
}

export function buildOpenAILongContextConfig(params: {
  profile: OpenAILongContextProfile;
  workspace: string;
  agentId: string;
}): OpenClawConfig {
  const { profile } = params;
  return {
    secrets: { providers: { default: { source: "env" } } },
    models: {
      mode: "replace",
      providers: {
        openai: {
          baseUrl: profile.baseUrl,
          api: profile.api,
          apiKey: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
          models: [
            {
              id: profile.modelId,
              name: profile.modelId,
              api: profile.api,
              reasoning: true,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: profile.contextWindow,
              contextTokens: profile.contextTokens,
              maxTokens: profile.maxTokens,
            },
          ],
        },
      },
    },
    agents: {
      defaults: {
        workspace: params.workspace,
        skipBootstrap: true,
        thinkingDefault: "low",
        model: { primary: profile.modelRef },
        models: {
          [profile.modelRef]: {
            agentRuntime: { id: profile.runtime },
            params: {
              fastMode: true,
              responsesServerCompaction: true,
              responsesCompactThreshold: profile.compactThreshold,
            },
          },
        },
        sandbox: { mode: "off" },
        timeoutSeconds: Math.ceil(profile.requestTimeoutMs / 1000),
      },
      entries: {
        [params.agentId]: {
          default: true,
          workspace: params.workspace,
          sandbox: { mode: "off" },
        },
      },
    },
  };
}

function mismatch(path: string, actual: unknown, expected: unknown): never {
  throw new Error(
    `OpenAI long-context config mismatch at ${path}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
  );
}

function expectConfigValue(path: string, actual: unknown, expected: unknown): void {
  if (!Object.is(actual, expected) && JSON.stringify(actual) !== JSON.stringify(expected)) {
    mismatch(path, actual, expected);
  }
}

export function assertOpenAILongContextConfig(
  cfg: OpenClawConfig,
  profile: OpenAILongContextProfile,
): void {
  const providers = cfg.models?.providers ?? {};
  expectConfigValue("models.mode", cfg.models?.mode, "replace");
  expectConfigValue("models.providers", Object.keys(providers), ["openai"]);
  const provider = providers.openai;
  expectConfigValue("models.providers.openai.baseUrl", provider?.baseUrl, profile.baseUrl);
  expectConfigValue("models.providers.openai.api", provider?.api, profile.api);
  expectConfigValue("models.providers.openai.apiKey", provider?.apiKey, {
    source: "env",
    provider: "default",
    id: "OPENAI_API_KEY",
  });
  expectConfigValue(
    "secrets.providers.default.source",
    cfg.secrets?.providers?.default?.source,
    "env",
  );
  expectConfigValue("models.providers.openai.models.length", provider?.models.length, 1);
  const model = provider?.models[0];
  expectConfigValue("model.id", model?.id, profile.modelId);
  expectConfigValue("model.api", model?.api, profile.api);
  expectConfigValue("model.contextWindow", model?.contextWindow, profile.contextWindow);
  expectConfigValue("model.contextTokens", model?.contextTokens, profile.contextTokens);
  expectConfigValue("model.maxTokens", model?.maxTokens, profile.maxTokens);
  const configuredModels = cfg.agents?.defaults?.models ?? {};
  expectConfigValue(
    "agents.defaults.model.primary",
    resolveAgentModelPrimaryValue(cfg.agents?.defaults?.model),
    profile.modelRef,
  );
  expectConfigValue("agents.defaults.models", Object.keys(configuredModels), [profile.modelRef]);
  const route = configuredModels[profile.modelRef];
  expectConfigValue("agentRuntime.id", route?.agentRuntime?.id, profile.runtime);
  expectConfigValue("params.fastMode", route?.params?.fastMode, true);
  expectConfigValue(
    "params.responsesServerCompaction",
    route?.params?.responsesServerCompaction,
    true,
  );
  expectConfigValue(
    "params.responsesCompactThreshold",
    route?.params?.responsesCompactThreshold,
    profile.compactThreshold,
  );
  if (profile.contextTokens > profile.contextWindow) {
    mismatch("model.contextTokens", profile.contextTokens, `<= ${profile.contextWindow}`);
  }
}

export function buildDenseContext(params: { marker: string; chars: number }): string {
  const line = (index: number) =>
    `${params.marker}|record=${index}|the copper lighthouse tracks violet weather while durable state survives provider compaction.\n`;
  const parts: string[] = [];
  let length = 0;
  for (let index = 0; length < params.chars; index += 1) {
    const next = line(index);
    parts.push(next);
    length += next.length;
  }
  return parts.join("").slice(0, params.chars);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

type ReplayState = {
  type: "openai-responses-compaction";
  idHash?: string;
  payloadHash: string;
  replayIndex?: number;
  provider: string;
  api: string;
  model: string;
  baseUrlHash: string;
  sessionHash?: string;
  authProfileHash?: string;
};

export type OpenAICompactionStateObservation = {
  persistedCount: number;
  activeCount: number;
  latest?: ReplayState;
};

function readReplayState(message: unknown): ReplayState | undefined {
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    return undefined;
  }
  const replay = (message as { providerReplay?: unknown }).providerReplay;
  if (!replay || typeof replay !== "object" || Array.isArray(replay)) {
    return undefined;
  }
  const value = replay as Record<string, unknown>;
  if (
    value.type !== "openai-responses-compaction" ||
    typeof value.data !== "string" ||
    typeof value.provider !== "string" ||
    typeof value.api !== "string" ||
    typeof value.model !== "string" ||
    typeof value.baseUrlHash !== "string"
  ) {
    return undefined;
  }
  return {
    type: "openai-responses-compaction",
    ...(typeof value.id === "string" ? { idHash: sha256(value.id) } : {}),
    payloadHash: sha256(value.data),
    ...(Number.isSafeInteger(value.replayIndex) && (value.replayIndex as number) >= 0
      ? { replayIndex: value.replayIndex as number }
      : {}),
    provider: value.provider,
    api: value.api,
    model: value.model,
    baseUrlHash: value.baseUrlHash,
    ...(typeof value.sessionHash === "string" ? { sessionHash: value.sessionHash } : {}),
    ...(typeof value.authProfileHash === "string"
      ? { authProfileHash: value.authProfileHash }
      : {}),
  };
}

export function observeOpenAICompactionEntries(params: {
  persistedEntries: readonly unknown[];
  activeMessages: readonly unknown[];
}): OpenAICompactionStateObservation {
  const persisted = params.persistedEntries.flatMap((entry) => {
    if (!entry || typeof entry !== "object" || (entry as { type?: unknown }).type !== "message") {
      return [];
    }
    const replay = readReplayState((entry as { message?: unknown }).message);
    return replay ? [replay] : [];
  });
  const active = params.activeMessages.flatMap((message) => {
    const replay = readReplayState(message);
    return replay ? [replay] : [];
  });
  const latest = active.at(-1);
  return {
    persistedCount: persisted.length,
    activeCount: active.length,
    ...(latest ? { latest } : {}),
  };
}

export function observeOpenAICompactionState(params: {
  agentId: string;
  sessionId: string;
  sessionKey: string;
  storePath: string;
}): OpenAICompactionStateObservation {
  const manager = SessionManager.open(params);
  return observeOpenAICompactionEntries({
    persistedEntries: manager.getEntries(),
    activeMessages: manager.buildSessionContext().messages,
  });
}

export type OpenAILongContextAgentEvent = {
  runId?: string;
  sessionKey?: string;
  stream?: string;
  ts?: number;
  receivedAt?: number;
  data?: Record<string, unknown>;
};

export type OpenAITransportReplayEvidence = {
  serviceTier: string;
  inputItems: number;
  inputItemShape: string[];
  compactionItems: number;
  compactionIdHashes: string[];
  compactionPayloadHashes: string[];
  compactionInputIndexes: number[];
  contextManagement: boolean;
};

function readSummaryField(line: string, name: string): string | undefined {
  return line.match(new RegExp(`(?:^|\\s)${name}=([^\\s]+)`, "u"))?.[1];
}

function readCsv(value: string | undefined): string[] {
  return !value || value === "none" ? [] : value.split(",").filter(Boolean);
}

export function readOpenAITransportReplayEvidence(
  logs: string,
  modelId: string,
  requestId: string,
): OpenAITransportReplayEvidence {
  const requestIdHash = `sha256:${sha256(requestId)}`;
  const candidates = logs
    .split(/\r?\n/u)
    .filter(
      (candidate) =>
        candidate.includes("[responses] start") && candidate.includes(`model=${modelId}`),
    );
  const line = candidates.find(
    (candidate) => readSummaryField(candidate, "requestIdHash") === requestIdHash,
  );
  if (!line) {
    const observedHashes = candidates
      .map((candidate) => readSummaryField(candidate, "requestIdHash"))
      .filter((value): value is string => Boolean(value));
    throw new Error(
      `missing redacted OpenAI Responses request diagnostic for ${modelId} request ${requestId}; candidates=${candidates.length} observed=${observedHashes.join(",") || "none"}`,
    );
  }
  const count = Number(readSummaryField(line, "compactionItems"));
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new Error("OpenAI Responses request diagnostic omitted compactionItems");
  }
  const indexes = readCsv(readSummaryField(line, "compactionInputIndexes")).map(Number);
  if (indexes.some((value) => !Number.isSafeInteger(value) || value < 0)) {
    throw new Error("OpenAI Responses request diagnostic had invalid compactionInputIndexes");
  }
  const inputItems = Number(readSummaryField(line, "inputItems"));
  if (!Number.isSafeInteger(inputItems) || inputItems < 0) {
    throw new Error("OpenAI Responses request diagnostic omitted inputItems");
  }
  return {
    serviceTier: readSummaryField(line, "serviceTier") ?? "undefined",
    inputItems,
    inputItemShape: readCsv(readSummaryField(line, "inputItemShape")),
    compactionItems: count,
    compactionIdHashes: readCsv(readSummaryField(line, "compactionIdHashes")),
    compactionPayloadHashes: readCsv(readSummaryField(line, "compactionPayloadHashes")),
    compactionInputIndexes: indexes,
    contextManagement: (readSummaryField(line, "fields") ?? "")
      .split(",")
      .includes("context_management"),
  };
}

export type LongOutputMarkers = { begin: string; middle: string; end: string };

function expectedOutputLine(index: number, total: number, markers: LongOutputMarkers): string {
  const number = String(index).padStart(4, "0");
  if (index === 1) {
    return `${number}|BEGIN|${markers.begin}`;
  }
  if (index === Math.ceil(total / 2)) {
    return `${number}|MIDDLE|${markers.middle}`;
  }
  if (index === total) {
    return `${number}|END|${markers.end}`;
  }
  return `${number}|BODY|red orange yellow green blue indigo violet`;
}

export function buildLongOutputPrompt(markers: LongOutputMarkers, totalLines = 384): string {
  return [
    `Return exactly ${totalLines} plain-text lines with no Markdown fence and no commentary.`,
    `Line 1 must be: ${expectedOutputLine(1, totalLines, markers)}`,
    `Line ${Math.ceil(totalLines / 2)} must be: ${expectedOutputLine(Math.ceil(totalLines / 2), totalLines, markers)}`,
    `Line ${totalLines} must be: ${expectedOutputLine(totalLines, totalLines, markers)}`,
    "Every other line must use NNNN|BODY|red orange yellow green blue indigo violet with contiguous four-digit numbering.",
  ].join("\n");
}

export function validateLongOutput(params: {
  text: string;
  markers: LongOutputMarkers;
  totalLines?: number;
  outputTokens: number;
  stopReason: string | undefined;
}): { lineCount: number; chars: number } {
  const totalLines = params.totalLines ?? 384;
  const normalized = params.text.replaceAll("\r\n", "\n").replace(/\n$/u, "");
  const lines = normalized.split("\n");
  if (lines.length !== totalLines) {
    throw new Error(`long output must contain exactly ${totalLines} lines; got ${lines.length}`);
  }
  for (let index = 1; index <= totalLines; index += 1) {
    const expected = expectedOutputLine(index, totalLines, params.markers);
    if (lines[index - 1] !== expected) {
      throw new Error(`long output line ${index} did not match the mechanical contract`);
    }
  }
  if (params.stopReason !== "stop") {
    throw new Error(`long output stopReason must be stop; got ${String(params.stopReason)}`);
  }
  if (
    !Number.isSafeInteger(params.outputTokens) ||
    params.outputTokens < 4_096 ||
    params.outputTokens > 8_192
  ) {
    throw new Error(`long output tokens must be between 4096 and 8192; got ${params.outputTokens}`);
  }
  return { lineCount: lines.length, chars: normalized.length };
}

type ToolOutputFixture = {
  content: string;
  bytes: number;
  marker: string;
  sha256: string;
};

export function buildToolOutputFixture(params: {
  marker: string;
  bytes: number;
}): ToolOutputFixture {
  if (
    !Number.isSafeInteger(params.bytes) ||
    params.bytes < TOOL_BYTES_MIN ||
    params.bytes > TOOL_BYTES_MAX
  ) {
    throw new Error(`tool output bytes must be between ${TOOL_BYTES_MIN} and ${TOOL_BYTES_MAX}`);
  }
  const prefix = `${params.marker}|BEGIN|000000\n`;
  const record = `${params.marker}|DATA|0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ\n`;
  const repeats = Math.ceil((params.bytes - prefix.length) / record.length);
  const content = `${prefix}${record.repeat(Math.max(0, repeats))}`
    .padEnd(params.bytes, "X")
    .slice(0, params.bytes);
  return {
    content,
    bytes: Buffer.byteLength(content),
    marker: params.marker,
    sha256: sha256(content),
  };
}

function resultText(result: unknown): string {
  if (!result || typeof result !== "object") {
    return "";
  }
  const content = (result as { content?: unknown }).content;
  return Array.isArray(content)
    ? content
        .flatMap((part) =>
          part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string"
            ? [(part as { text: string }).text]
            : [],
        )
        .join("\n")
    : "";
}

export function readToolOutputEvidence(params: {
  events: readonly OpenAILongContextAgentEvent[];
  expectedPath: string;
  expectedMarker: string;
  expectedBytes: number;
  fixtureHash: string;
}): {
  path: string;
  marker: string;
  originalBytes: number;
  projectedChars: number;
  fixtureHash: string;
  toolCallIdHash: string;
} {
  const expectedPath = params.expectedPath.replaceAll("\\", "/");
  const start = params.events.find((event) => {
    if (event.stream !== "tool" || event.data?.phase !== "start" || event.data?.name !== "read") {
      return false;
    }
    const args = event.data.args as { file_path?: unknown; path?: unknown } | undefined;
    const rawPath = typeof args?.path === "string" ? args.path : args?.file_path;
    if (typeof rawPath !== "string") {
      return false;
    }
    const normalizedPath = rawPath.replaceAll("\\", "/");
    return normalizedPath === expectedPath || normalizedPath.endsWith(`/${expectedPath}`);
  });
  const toolCallId = start?.data?.toolCallId;
  if (typeof toolCallId !== "string") {
    const observed = params.events.flatMap((event) => {
      if (event.stream !== "tool") {
        return [];
      }
      const args =
        event.data?.args && typeof event.data.args === "object"
          ? Object.keys(event.data.args).toSorted()
          : [];
      return [
        {
          phase: event.data?.phase,
          name: event.data?.name,
          argKeys: args,
        },
      ];
    });
    throw new Error(
      `read tool did not start for ${params.expectedPath}; observed=${JSON.stringify(observed)}`,
    );
  }
  const end = params.events.find(
    (event) =>
      event.stream === "tool" &&
      event.data?.phase === "result" &&
      event.data?.name === "read" &&
      event.data?.toolCallId === toolCallId,
  );
  if (!end || end.data?.isError === true) {
    throw new Error(`read tool did not complete successfully for ${params.expectedPath}`);
  }
  const result = end.data?.result;
  const details =
    result && typeof result === "object" ? (result as { details?: unknown }).details : undefined;
  const truncation =
    details && typeof details === "object"
      ? (details as { truncation?: Record<string, unknown> }).truncation
      : undefined;
  if (truncation?.truncated !== true || truncation.totalBytes !== params.expectedBytes) {
    throw new Error(`read tool original-size evidence did not match ${params.expectedBytes}`);
  }
  const text = resultText(result);
  if (!text.includes(params.expectedMarker)) {
    throw new Error("read tool projected output omitted the fixture marker");
  }
  return {
    path: params.expectedPath,
    marker: params.expectedMarker,
    originalBytes: params.expectedBytes,
    projectedChars: text.length,
    fixtureHash: params.fixtureHash,
    toolCallIdHash: sha256(toolCallId),
  };
}

type UsageRecord = {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  total?: number;
  contextUsage?: { state?: string; promptTokens?: number; totalTokens?: number };
};

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

type OpenAILongContextTurnMetric = {
  runtime: string;
  model: string;
  phase: string;
  inputChars: number;
  elapsedMs: number;
  ttfaMs: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  totalTokens: number | null;
  promptTokens: number | null;
  contextTokens: number | null;
  effectiveWindow: number;
  serviceTier: string | null;
  compactionCount: number;
  compactionDurationMs: number | null;
  restartLatencyMs: number | null;
  markerStatus: Record<string, boolean>;
};

export function aggregateOpenAILongContextMetric(params: {
  profile: OpenAILongContextProfile;
  phase: string;
  inputChars: number;
  elapsedMs: number;
  ttfaMs?: number;
  agentMeta?: Record<string, unknown>;
  serviceTier?: string;
  compactionCount: number;
  compactionDurationMs?: number;
  restartLatencyMs?: number;
  markerStatus?: Record<string, boolean>;
}): OpenAILongContextTurnMetric {
  const lastCall = params.agentMeta?.lastCallUsage as UsageRecord | undefined;
  const aggregate = params.agentMeta?.usage as UsageRecord | undefined;
  const usage = lastCall ?? aggregate;
  const contextUsage = usage?.contextUsage;
  const promptTokens =
    finite(params.agentMeta?.promptTokens) ??
    (contextUsage?.state === "available" ? finite(contextUsage.promptTokens) : null);
  return {
    runtime: params.profile.runtime,
    model: params.profile.modelRef,
    phase: params.phase,
    inputChars: params.inputChars,
    elapsedMs: params.elapsedMs,
    ttfaMs: finite(params.ttfaMs),
    inputTokens: finite(usage?.input),
    outputTokens: finite(usage?.output),
    cacheReadTokens: finite(usage?.cacheRead),
    cacheWriteTokens: finite(usage?.cacheWrite),
    totalTokens: finite(usage?.total),
    promptTokens,
    contextTokens: finite(params.agentMeta?.contextTokens),
    effectiveWindow: params.profile.contextTokens,
    serviceTier: params.serviceTier ?? null,
    compactionCount: params.compactionCount,
    compactionDurationMs: finite(params.compactionDurationMs),
    restartLatencyMs: finite(params.restartLatencyMs),
    markerStatus: { ...params.markerStatus },
  };
}
