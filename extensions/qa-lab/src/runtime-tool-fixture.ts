import fs from "node:fs/promises";
import path from "node:path";
import { readRuntimeToolCoverageMetadata } from "./runtime-tool-metadata.js";
import { liveTurnTimeoutMs } from "./suite-runtime-agent-common.js";
import type { QaSuiteRuntimeEnv } from "./suite-runtime-types.js";

type QaRuntimeToolFixtureConfig = {
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
  plannedToolName?: string;
  plannedToolArgs?: unknown;
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

function readString(value: unknown, fallback = "") {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : fallback;
}

function readBoolean(value: unknown, fallback: boolean) {
  return typeof value === "boolean" ? value : fallback;
}

function isKnownBroken(value: unknown) {
  return Boolean(value && typeof value === "object");
}

function isKnownHarnessGap(value: unknown) {
  return Boolean(value && typeof value === "object");
}

function isQaRuntimeToolFixtureRequest(value: unknown): value is QaRuntimeToolFixtureRequest {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function readQaRuntimeToolFixtureRequests(value: unknown): QaRuntimeToolFixtureRequest[] {
  return Array.isArray(value) ? value.filter(isQaRuntimeToolFixtureRequest) : [];
}

function requestMatchesPrompt(request: QaRuntimeToolFixtureRequest, promptSnippet: string) {
  return (request.allInputText ?? "").includes(promptSnippet);
}

function findPlannedRequest(params: {
  requests: readonly QaRuntimeToolFixtureRequest[];
  requestCountBefore: number;
  promptSnippet: string;
  toolName: string;
}) {
  return params.requests
    .slice(params.requestCountBefore)
    .find(
      (request) =>
        requestMatchesPrompt(request, params.promptSnippet) &&
        request.plannedToolName === params.toolName,
    );
}

function formatKnownBrokenDetails(
  toolName: string,
  tools: Set<string>,
  config: QaRuntimeToolFixtureConfig,
) {
  const knownBroken = isKnownBroken(config.knownBroken)
    ? (config.knownBroken as Record<string, unknown>)
    : {};
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
      ? `${params.toolName} mock provider happy planned args (diagnostic only): ${JSON.stringify(params.happyRequest.plannedToolArgs ?? {})}`
      : undefined,
    params.failureRequest
      ? `${params.toolName} mock provider failure planned args (diagnostic only): ${JSON.stringify(params.failureRequest.plannedToolArgs ?? {})}`
      : undefined,
  ]
    .filter(Boolean)
    .join("\n");
}

function formatKnownHarnessGapDetails(toolName: string, config: QaRuntimeToolFixtureConfig) {
  const knownHarnessGap = isKnownHarnessGap(config.knownHarnessGap)
    ? (config.knownHarnessGap as Record<string, unknown>)
    : {};
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
    config: config as Record<string, unknown>,
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
    return `${toolName} fixture completed in live provider mode`;
  }

  const requests = readQaRuntimeToolFixtureRequests(
    await deps.fetchJson(`${env.mock.baseUrl}/debug/requests`),
  );
  const happyRequest = findPlannedRequest({
    requests,
    requestCountBefore,
    promptSnippet,
    toolName,
  });
  if (!happyRequest) {
    if (dynamicExposureIntentionallyExcluded) {
      return formatCodexNativeWorkspaceDetails({
        toolName,
        tools,
        reason: metadata.reason,
      });
    }
    if (isKnownHarnessGap(config.knownHarnessGap)) {
      return formatKnownHarnessGapDetails(toolName, config);
    }
    throw new Error(`expected mock happy-path request for ${toolName}`);
  }
  const failureRequest = findPlannedRequest({
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
        happyRequest,
      });
    }
    if (isKnownHarnessGap(config.knownHarnessGap)) {
      return formatKnownHarnessGapDetails(toolName, config);
    }
    throw new Error(`expected mock failure-path request for ${toolName}`);
  }

  if (dynamicExposureIntentionallyExcluded) {
    return formatCodexNativeWorkspaceDetails({
      toolName,
      tools,
      reason: metadata.reason,
      happyRequest,
      failureRequest,
    });
  }

  return [
    `${toolName} mock provider happy planned args (diagnostic only): ${JSON.stringify(happyRequest.plannedToolArgs ?? {})}`,
    `${toolName} mock provider failure planned args (diagnostic only): ${JSON.stringify(failureRequest.plannedToolArgs ?? {})}`,
  ].join("\n");
}
