// Qa Lab plugin module implements runtime tool fixture behavior.
import fs from "node:fs/promises";
import path from "node:path";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { readRuntimeToolCoverageMetadata } from "./runtime-tool-metadata.js";
import { liveTurnTimeoutMs } from "./suite-runtime-agent-common.js";
import { readRawQaSessionStore } from "./suite-runtime-agent-session.js";
import type { QaSuiteRuntimeEnv } from "./suite-runtime-types.js";

type QaRuntimeToolFixtureConfig = Record<string, unknown> & {
  toolName?: unknown;
  happyPrompt?: unknown;
  failurePrompt?: unknown;
  promptSnippet?: unknown;
  failurePromptSnippet?: unknown;
  ensureImageGeneration?: unknown;
  expectedAvailable?: unknown;
  toolCoverage?: unknown;
  knownBroken?: unknown;
  knownHarnessGap?: unknown;
};

type QaRuntimeToolFixtureRequest = {
  allInputText?: string;
  plannedToolCallId?: string;
  plannedToolName?: string;
  plannedToolArgs?: unknown;
  toolOutputCallId?: string;
  toolOutput?: string;
  toolOutputStructuredError?: unknown;
};

type QaRuntimeToolFixtureTranscriptToolCall = {
  id?: string;
  tool: string;
  args: unknown;
};

type QaRuntimeToolFixtureTranscriptToolResult = {
  id?: string;
  tool?: string;
  text: string;
  failure: boolean;
  structuredFailure: boolean;
};

type QaRuntimeToolFixtureDeps = {
  createSession: (
    env: Pick<QaSuiteRuntimeEnv, "gateway" | "primaryModel" | "alternateModel" | "providerMode">,
    label: string,
    key?: string,
  ) => Promise<string>;
  readEffectiveTools: (
    env: Pick<QaSuiteRuntimeEnv, "gateway" | "primaryModel" | "alternateModel" | "providerMode">,
    sessionKey: string,
  ) => Promise<Set<string>>;
  runAgentPrompt: (
    env: Pick<QaSuiteRuntimeEnv, "gateway" | "transport">,
    params: {
      sessionKey: string;
      message: string;
      timeoutMs?: number;
    },
  ) => Promise<unknown>;
  fetchJson: (url: string) => Promise<unknown>;
  ensureImageGenerationConfigured: (env: QaSuiteRuntimeEnv) => Promise<unknown>;
};

function readString(raw: unknown, fallback = "") {
  return typeof raw === "string" && raw.trim().length > 0 ? raw.trim() : fallback;
}

function readBoolean(raw: unknown, fallback: boolean) {
  return typeof raw === "boolean" ? raw : fallback;
}

function isKnownBroken(raw: unknown): raw is Record<string, unknown> {
  return isRecord(raw);
}

function isKnownHarnessGap(raw: unknown): raw is Record<string, unknown> {
  return isRecord(raw);
}

function isQaRuntimeToolFixtureRequest(raw: unknown): raw is QaRuntimeToolFixtureRequest {
  return isRecord(raw);
}

function readQaRuntimeToolFixtureRequests(raw: unknown): QaRuntimeToolFixtureRequest[] {
  return Array.isArray(raw) ? raw.filter(isQaRuntimeToolFixtureRequest) : [];
}

function formatPlannedToolArgs(rawArgs: unknown) {
  const encodedArgs = JSON.stringify(rawArgs ?? {});
  return encodedArgs ?? "undefined";
}

function requestMatchesPrompt(request: QaRuntimeToolFixtureRequest, promptSnippet: string) {
  return (request.allInputText ?? "").includes(promptSnippet);
}

function requestHasToolOutput(request: QaRuntimeToolFixtureRequest) {
  return typeof request.toolOutput === "string" && request.toolOutput.trim().length > 0;
}

function isHardFailureToolOutputText(text: string) {
  return (
    /\b(?:ENOENT|EACCES|EPERM)\b/u.test(text) ||
    /(?:^|\n)\s*(?:Error|Exception|Failed):/u.test(text) ||
    /\b(?:no such file|permission denied|forbidden)\b/iu.test(text)
  );
}

function requestHasHappyPathFailureToolOutput(request: QaRuntimeToolFixtureRequest) {
  return (
    request.toolOutputStructuredError === true ||
    (typeof request.toolOutput === "string" && isHardFailureToolOutputText(request.toolOutput))
  );
}

function requestHasFailureLikeToolOutput(request: QaRuntimeToolFixtureRequest) {
  return (
    typeof request.toolOutput === "string" &&
    isFailureLikeToolResult({
      text: request.toolOutput,
      isError: request.toolOutputStructuredError,
    })
  );
}

function readNonEmptyString(value: unknown) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function normalizeToolCallId(value: unknown) {
  return readNonEmptyString(value);
}

function stringifyTranscriptToolResult(value: unknown): string {
  if (typeof value === "string") {
    return value.trim();
  }
  if (value === undefined || value === null) {
    return "";
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  try {
    return JSON.stringify(value);
  } catch {
    return "";
  }
}

function extractTranscriptText(value: unknown): string {
  if (typeof value === "string") {
    return value.trim();
  }
  if (!Array.isArray(value)) {
    return "";
  }
  const parts: string[] = [];
  for (const block of value) {
    if (typeof block === "string" && block.trim()) {
      parts.push(block.trim());
      continue;
    }
    if (!isRecord(block)) {
      continue;
    }
    const text =
      readNonEmptyString(block.text) ??
      readNonEmptyString(block.content) ??
      readNonEmptyString(block.message) ??
      readNonEmptyString(block.error);
    if (text) {
      parts.push(text);
    }
  }
  return parts.join("\n").trim();
}

function extractTranscriptToolCalls(
  message: Record<string, unknown>,
): QaRuntimeToolFixtureTranscriptToolCall[] {
  const calls: QaRuntimeToolFixtureTranscriptToolCall[] = [];
  const rawContent = message.content;
  if (Array.isArray(rawContent)) {
    for (const block of rawContent) {
      if (!isRecord(block)) {
        continue;
      }
      const type = readNonEmptyString(block.type)?.toLowerCase();
      if (type !== "tool_use" && type !== "toolcall" && type !== "tool_call") {
        continue;
      }
      const tool = readNonEmptyString(block.name);
      if (!tool) {
        continue;
      }
      calls.push({
        id:
          normalizeToolCallId(block.id) ??
          normalizeToolCallId(block.toolCallId) ??
          normalizeToolCallId(block.toolUseId),
        tool,
        args: block.input ?? block.arguments ?? block.args ?? block.payload ?? null,
      });
    }
  }

  const rawToolCalls =
    message.tool_calls ?? message.toolCalls ?? message.function_call ?? message.functionCall;
  const toolCalls = Array.isArray(rawToolCalls) ? rawToolCalls : rawToolCalls ? [rawToolCalls] : [];
  for (const call of toolCalls) {
    if (!isRecord(call)) {
      continue;
    }
    const functionRecord = isRecord(call.function) ? call.function : undefined;
    const tool = readNonEmptyString(call.name) ?? readNonEmptyString(functionRecord?.name);
    if (!tool) {
      continue;
    }
    calls.push({
      id:
        normalizeToolCallId(call.id) ??
        normalizeToolCallId(call.toolCallId) ??
        normalizeToolCallId(call.toolUseId),
      tool,
      args:
        call.arguments ?? functionRecord?.arguments ?? call.input ?? functionRecord?.input ?? null,
    });
  }
  return calls;
}

function readBooleanTrue(value: unknown) {
  return value === true;
}

function isFailureLikeToolResult(params: {
  type?: string;
  text: string;
  isError?: unknown;
  is_error?: unknown;
}) {
  return (
    isStructuredFailureToolResult(params) ||
    /\b(?:denied|enoent|error|exception|fail(?:ed|ure)?|forbidden|invalid|missing|not found|permission)\b/iu.test(
      params.text,
    )
  );
}

function isStructuredFailureToolResult(params: {
  type?: string;
  isError?: unknown;
  is_error?: unknown;
}) {
  return (
    params.type === "tool_result_error" ||
    readBooleanTrue(params.isError) ||
    readBooleanTrue(params.is_error)
  );
}

function extractTranscriptToolResults(
  message: Record<string, unknown>,
): QaRuntimeToolFixtureTranscriptToolResult[] {
  const results: QaRuntimeToolFixtureTranscriptToolResult[] = [];
  const tool =
    readNonEmptyString(message.toolName) ??
    readNonEmptyString(message.tool_name) ??
    readNonEmptyString(message.name) ??
    readNonEmptyString(message.tool);
  if ((message.role === "tool" || message.role === "toolResult") && message.content !== undefined) {
    const text = extractTranscriptText(message.content);
    const structuredFailure = isStructuredFailureToolResult({
      isError: message.isError,
      is_error: message.is_error,
    });
    results.push({
      id:
        normalizeToolCallId(message.tool_call_id) ??
        normalizeToolCallId(message.toolCallId) ??
        normalizeToolCallId(message.toolUseId) ??
        normalizeToolCallId(message.id),
      ...(tool ? { tool } : {}),
      text,
      structuredFailure,
      failure: isFailureLikeToolResult({
        text,
        isError: message.isError,
        is_error: message.is_error,
      }),
    });
  }

  const rawContent = message.content;
  if (!Array.isArray(rawContent)) {
    return results;
  }
  for (const block of rawContent) {
    if (!isRecord(block)) {
      continue;
    }
    const type = readNonEmptyString(block.type)?.toLowerCase();
    if (type !== "tool_result" && type !== "toolresult" && type !== "tool_result_error") {
      continue;
    }
    const text = stringifyTranscriptToolResult(
      block.content ?? block.text ?? block.result ?? block.error ?? block.message,
    );
    const structuredFailure = isStructuredFailureToolResult({
      type,
      isError: block.isError,
      is_error: block.is_error,
    });
    const blockTool =
      readNonEmptyString(block.toolName) ??
      readNonEmptyString(block.tool_name) ??
      readNonEmptyString(block.name) ??
      readNonEmptyString(block.tool);
    results.push({
      id:
        normalizeToolCallId(block.tool_use_id) ??
        normalizeToolCallId(block.toolUseId) ??
        normalizeToolCallId(block.tool_call_id) ??
        normalizeToolCallId(block.toolCallId) ??
        normalizeToolCallId(block.id),
      ...(blockTool ? { tool: blockTool } : {}),
      text,
      structuredFailure,
      failure: isFailureLikeToolResult({
        type,
        text,
        isError: block.isError,
        is_error: block.is_error,
      }),
    });
  }
  return results;
}

function transcriptToolResultLinksCall(params: {
  call: QaRuntimeToolFixtureTranscriptToolCall;
  result: QaRuntimeToolFixtureTranscriptToolResult;
  targetCallCount: number;
}) {
  if (params.call.id || params.result.id) {
    return Boolean(params.call.id && params.result.id && params.call.id === params.result.id);
  }
  if (params.result.tool) {
    return params.result.tool === params.call.tool;
  }
  return params.targetCallCount === 1;
}

function readTranscriptToolEvidence(transcriptBytes: string, toolName: string) {
  const calls: QaRuntimeToolFixtureTranscriptToolCall[] = [];
  const results: QaRuntimeToolFixtureTranscriptToolResult[] = [];
  for (const line of transcriptBytes.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      const message = isRecord(parsed) && isRecord(parsed.message) ? parsed.message : undefined;
      if (!message) {
        continue;
      }
      calls.push(...extractTranscriptToolCalls(message).filter((call) => call.tool === toolName));
      results.push(...extractTranscriptToolResults(message));
    } catch {
      // Ignore malformed transcript rows and keep live fixture evidence deterministic.
    }
  }
  const outputResult = calls
    .map((call) =>
      results.find((result) =>
        transcriptToolResultLinksCall({
          call,
          result,
          targetCallCount: calls.length,
        }),
      ),
    )
    .find((result) => result && result.text.trim().length > 0);
  return {
    plannedRequest: calls[0],
    outputRequest: outputResult,
    failureOutputRequest: outputResult?.failure ? outputResult : undefined,
  };
}

async function readSessionTranscriptBytes(
  env: Pick<QaSuiteRuntimeEnv, "gateway">,
  sessionKey: string,
) {
  const store = await readRawQaSessionStore(env);
  const entry = store[sessionKey];
  const sessionId = readNonEmptyString(entry?.sessionId);
  if (!sessionId) {
    throw new Error(`session transcript entry not found for ${sessionKey}`);
  }
  const sessionsDir = path.join(env.gateway.tempRoot, "state", "agents", "qa", "sessions");
  const sessionFile = readNonEmptyString(entry?.sessionFile);
  const transcriptPath = sessionFile
    ? path.isAbsolute(sessionFile)
      ? sessionFile
      : path.join(sessionsDir, sessionFile)
    : path.join(sessionsDir, `${sessionId}.jsonl`);
  const transcriptBytes = await fs.readFile(transcriptPath, "utf8");
  if (!transcriptBytes.trim()) {
    throw new Error(`session transcript is empty for ${sessionKey}`);
  }
  return transcriptBytes;
}

async function readLiveToolEvidence(params: {
  env: Pick<QaSuiteRuntimeEnv, "gateway">;
  sessionKey: string;
  toolName: string;
}) {
  return readTranscriptToolEvidence(
    await readSessionTranscriptBytes(params.env, params.sessionKey),
    params.toolName,
  );
}

function requestLinksPlannedToolOutput(
  plannedRequest: QaRuntimeToolFixtureRequest,
  outputRequest: QaRuntimeToolFixtureRequest,
) {
  if (plannedRequest.plannedToolCallId || outputRequest.toolOutputCallId) {
    return Boolean(
      plannedRequest.plannedToolCallId &&
      outputRequest.toolOutputCallId &&
      plannedRequest.plannedToolCallId === outputRequest.toolOutputCallId,
    );
  }
  return Boolean(
    plannedRequest === outputRequest &&
    plannedRequest.plannedToolName &&
    requestHasToolOutput(outputRequest),
  );
}

function findPlannedRequest(params: {
  requests: readonly QaRuntimeToolFixtureRequest[];
  requestCountBefore: number;
  promptSnippet: string;
  excludedPromptSnippet?: string;
  toolName: string;
}) {
  return params.requests
    .slice(params.requestCountBefore)
    .find(
      (request) =>
        requestMatchesPrompt(request, params.promptSnippet) &&
        (!params.excludedPromptSnippet ||
          !requestMatchesPrompt(request, params.excludedPromptSnippet)) &&
        request.plannedToolName === params.toolName,
    );
}

function findExecutedRequest(params: {
  requests: readonly QaRuntimeToolFixtureRequest[];
  requestCountBefore: number;
  promptSnippet: string;
  excludedPromptSnippet?: string;
  toolName: string;
}) {
  let plannedRequest: QaRuntimeToolFixtureRequest | undefined;
  for (const request of params.requests.slice(params.requestCountBefore)) {
    if (!requestMatchesPrompt(request, params.promptSnippet)) {
      continue;
    }
    if (
      params.excludedPromptSnippet &&
      requestMatchesPrompt(request, params.excludedPromptSnippet)
    ) {
      continue;
    }
    if (request.plannedToolName === params.toolName) {
      plannedRequest ??= request;
      if (requestHasToolOutput(request) && requestLinksPlannedToolOutput(request, request)) {
        return { plannedRequest, outputRequest: request };
      }
      continue;
    }
    if (
      plannedRequest &&
      requestHasToolOutput(request) &&
      requestLinksPlannedToolOutput(plannedRequest, request)
    ) {
      return { plannedRequest, outputRequest: request };
    }
  }
  return null;
}

function formatKnownBrokenDetails(
  toolName: string,
  tools: Set<string>,
  config: QaRuntimeToolFixtureConfig,
) {
  const knownBroken = isKnownBroken(config.knownBroken) ? config.knownBroken : {};
  const issue = readString(knownBroken.issue);
  const reason = readString(knownBroken.reason, "known broken runtime tool fixture");
  return [
    `known-broken ${toolName}: ${reason}`,
    issue ? `tracking: ${issue}` : undefined,
    `available tools: ${[...tools].toSorted().join(", ")}`,
  ]
    .filter(Boolean)
    .join("\n");
}

function formatExpectedUnavailableDetails(toolName: string, tools: Set<string>) {
  return [
    `expected-unavailable ${toolName}: this fixture is report-only for the current profile`,
    `available tools: ${[...tools].toSorted().join(", ")}`,
  ].join("\n");
}

function formatCodexNativeWorkspaceDetails(params: {
  toolName: string;
  tools: Set<string>;
  reason?: string;
  happyRequest?: QaRuntimeToolFixtureRequest;
  failureRequest?: QaRuntimeToolFixtureRequest;
}) {
  return [
    `codex-native-workspace ${params.toolName}: OpenClaw dynamic exposure is intentionally omitted because Codex owns this workspace operation natively`,
    params.reason ? `reason: ${params.reason}` : undefined,
    `available OpenClaw dynamic tools: ${[...params.tools].toSorted().join(", ")}`,
    params.happyRequest
      ? `${params.toolName} mock provider happy planned args (diagnostic only): ${formatPlannedToolArgs(params.happyRequest.plannedToolArgs)}`
      : undefined,
    params.failureRequest
      ? `${params.toolName} mock provider failure planned args (diagnostic only): ${formatPlannedToolArgs(params.failureRequest.plannedToolArgs)}`
      : undefined,
  ]
    .filter(Boolean)
    .join("\n");
}

function formatKnownHarnessGapDetails(toolName: string, config: QaRuntimeToolFixtureConfig) {
  const knownHarnessGap = isKnownHarnessGap(config.knownHarnessGap) ? config.knownHarnessGap : {};
  const issue = readString(knownHarnessGap.issue);
  const reason = readString(knownHarnessGap.reason, "known QA harness gap");
  return [`known-harness-gap ${toolName}: ${reason}`, issue ? `tracking: ${issue}` : undefined]
    .filter(Boolean)
    .join("\n");
}

export async function runRuntimeToolFixture(
  env: QaSuiteRuntimeEnv,
  config: QaRuntimeToolFixtureConfig,
  deps: QaRuntimeToolFixtureDeps,
) {
  const toolName = readString(config.toolName);
  if (!toolName) {
    throw new Error("runtime tool fixture missing execution.config.toolName");
  }
  if (config.ensureImageGeneration === true) {
    await deps.ensureImageGenerationConfigured(env);
  }
  await fs.writeFile(
    path.join(env.gateway.workspaceDir, "runtime-tool-fixture-edit.txt"),
    "before edit\n",
    "utf8",
  );

  const happySessionKey = await deps.createSession(
    env,
    `Runtime tool fixture: ${toolName} happy`,
    `agent:qa:runtime-tool:${toolName}:happy`,
  );
  const failureSessionKey = await deps.createSession(
    env,
    `Runtime tool fixture: ${toolName} failure`,
    `agent:qa:runtime-tool:${toolName}:failure`,
  );
  const tools = await deps.readEffectiveTools(env, happySessionKey);
  const metadata = readRuntimeToolCoverageMetadata({
    config,
  });
  const dynamicExposureIntentionallyExcluded =
    env.gateway.runtimeEnv.OPENCLAW_QA_FORCE_RUNTIME === "codex" &&
    metadata.expectedLayer === "codex-native-workspace";
  const expectedAvailable = readBoolean(config.expectedAvailable, true);
  if (!tools.has(toolName) && !dynamicExposureIntentionallyExcluded) {
    if (!expectedAvailable) {
      return formatExpectedUnavailableDetails(toolName, tools);
    }
    if (isKnownBroken(config.knownBroken)) {
      return formatKnownBrokenDetails(toolName, tools, config);
    }
    if (isKnownHarnessGap(config.knownHarnessGap)) {
      return formatKnownHarnessGapDetails(toolName, config);
    }
    throw new Error(
      `${toolName} not present in effective tools. Available tools: ${[...tools].toSorted().join(", ")}`,
    );
  }

  const happyPrompt = readString(
    config.happyPrompt,
    `tool search qa check target=${toolName}. Call exactly that tool once and then summarize.`,
  );
  const failurePrompt = readString(
    config.failurePrompt,
    `tool search qa failure target=${toolName}. Exercise the denied-input path once and then summarize.`,
  );
  const promptSnippet = readString(config.promptSnippet, `target=${toolName}`);
  const failurePromptSnippet = readString(
    config.failurePromptSnippet,
    `failure target=${toolName}`,
  );
  const requestCountBefore = env.mock
    ? readQaRuntimeToolFixtureRequests(await deps.fetchJson(`${env.mock.baseUrl}/debug/requests`))
        .length
    : 0;

  await deps.runAgentPrompt(env, {
    sessionKey: happySessionKey,
    message: happyPrompt,
    timeoutMs: liveTurnTimeoutMs(env, 45_000),
  });
  await deps.runAgentPrompt(env, {
    sessionKey: failureSessionKey,
    message: failurePrompt,
    timeoutMs: liveTurnTimeoutMs(env, 45_000),
  });

  if (!env.mock) {
    const happyRequest = await readLiveToolEvidence({
      env,
      sessionKey: happySessionKey,
      toolName,
    });
    if (!happyRequest.outputRequest) {
      if (isKnownHarnessGap(config.knownHarnessGap)) {
        return formatKnownHarnessGapDetails(toolName, config);
      }
      throw new Error(
        happyRequest.plannedRequest
          ? `expected live happy-path tool output for ${toolName}`
          : `expected live happy-path tool call for ${toolName}`,
      );
    }
    if (happyRequest.outputRequest.structuredFailure) {
      if (isKnownHarnessGap(config.knownHarnessGap)) {
        return formatKnownHarnessGapDetails(toolName, config);
      }
      throw new Error(`expected live happy-path successful tool output for ${toolName}`);
    }
    const failureRequest = await readLiveToolEvidence({
      env,
      sessionKey: failureSessionKey,
      toolName,
    });
    if (!failureRequest.outputRequest) {
      if (isKnownHarnessGap(config.knownHarnessGap)) {
        return formatKnownHarnessGapDetails(toolName, config);
      }
      throw new Error(
        failureRequest.plannedRequest
          ? `expected live failure-path tool output for ${toolName}`
          : `expected live failure-path tool call for ${toolName}`,
      );
    }
    if (!failureRequest.failureOutputRequest) {
      if (isKnownHarnessGap(config.knownHarnessGap)) {
        return formatKnownHarnessGapDetails(toolName, config);
      }
      throw new Error(`expected live failure-path tool failure output for ${toolName}`);
    }
    return [
      `${toolName} live provider happy planned args (diagnostic only): ${JSON.stringify(happyRequest.plannedRequest?.args ?? {})}`,
      `${toolName} live provider failure planned args (diagnostic only): ${JSON.stringify(failureRequest.plannedRequest?.args ?? {})}`,
    ].join("\n");
  }

  const requests = readQaRuntimeToolFixtureRequests(
    await deps.fetchJson(`${env.mock.baseUrl}/debug/requests`),
  );
  const happyPlannedRequest = findPlannedRequest({
    requests,
    requestCountBefore,
    promptSnippet,
    excludedPromptSnippet: failurePromptSnippet,
    toolName,
  });
  const happyRequest = findExecutedRequest({
    requests,
    requestCountBefore,
    promptSnippet,
    excludedPromptSnippet: failurePromptSnippet,
    toolName,
  });
  if (!happyRequest) {
    if (dynamicExposureIntentionallyExcluded) {
      return formatCodexNativeWorkspaceDetails({
        toolName,
        tools,
        reason: metadata.reason,
        happyRequest: happyPlannedRequest,
      });
    }
    if (isKnownHarnessGap(config.knownHarnessGap)) {
      return formatKnownHarnessGapDetails(toolName, config);
    }
    throw new Error(
      happyPlannedRequest
        ? `expected mock happy-path tool output for ${toolName}`
        : `expected mock happy-path request for ${toolName}`,
    );
  }
  if (requestHasHappyPathFailureToolOutput(happyRequest.outputRequest)) {
    if (isKnownHarnessGap(config.knownHarnessGap)) {
      return formatKnownHarnessGapDetails(toolName, config);
    }
    throw new Error(`expected mock happy-path successful tool output for ${toolName}`);
  }
  const failurePlannedRequest = findPlannedRequest({
    requests,
    requestCountBefore,
    promptSnippet: failurePromptSnippet,
    toolName,
  });
  const failureRequest = findExecutedRequest({
    requests,
    requestCountBefore,
    promptSnippet: failurePromptSnippet,
    toolName,
  });
  if (!failureRequest) {
    if (dynamicExposureIntentionallyExcluded) {
      return formatCodexNativeWorkspaceDetails({
        toolName,
        tools,
        reason: metadata.reason,
        happyRequest: happyPlannedRequest,
        failureRequest: failurePlannedRequest,
      });
    }
    if (isKnownHarnessGap(config.knownHarnessGap)) {
      return formatKnownHarnessGapDetails(toolName, config);
    }
    throw new Error(
      failurePlannedRequest
        ? `expected mock failure-path tool output for ${toolName}`
        : `expected mock failure-path request for ${toolName}`,
    );
  }
  if (!requestHasFailureLikeToolOutput(failureRequest.outputRequest)) {
    if (isKnownHarnessGap(config.knownHarnessGap)) {
      return formatKnownHarnessGapDetails(toolName, config);
    }
    throw new Error(`expected mock failure-path tool failure output for ${toolName}`);
  }

  if (dynamicExposureIntentionallyExcluded) {
    return formatCodexNativeWorkspaceDetails({
      toolName,
      tools,
      reason: metadata.reason,
      happyRequest: happyRequest.plannedRequest,
      failureRequest: failureRequest.plannedRequest,
    });
  }

  return [
    `${toolName} mock provider happy planned args (diagnostic only): ${formatPlannedToolArgs(happyRequest.plannedRequest.plannedToolArgs)}`,
    `${toolName} mock provider failure planned args (diagnostic only): ${formatPlannedToolArgs(failureRequest.plannedRequest.plannedToolArgs)}`,
  ].join("\n");
}
