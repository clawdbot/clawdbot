/**
 * Fresh, prompt-only inference with an exact zero-tool execution contract.
 *
 * This operation deliberately bypasses the ordinary agent attempt, retry,
 * transcript, hook, and delivery lifecycle. Execution owners either prove a
 * literal empty native tool surface or fail before inference starts.
 */
import path from "node:path";
import type { ThinkLevel } from "../auto-reply/thinking.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { withTempWorkspace } from "../infra/private-temp-workspace.js";
import { resolvePreferredOpenClawTmpDir } from "../infra/tmp-openclaw-dir.js";
import type { AssistantMessage } from "../llm/types.js";
import { resolveAgentDir, resolveAgentWorkspaceDir, resolveDefaultAgentId } from "./agent-scope.js";
import { resolveCliBackendConfig, resolveCliRuntimeCanonicalProvider } from "./cli-backends.js";
import { normalizeCliModel } from "./cli-runner/helpers.js";
import { resolveEmbeddedCliBackendDispatchEligibility } from "./embedded-agent-runner/cli-backend-dispatch-eligibility.js";
import { getRegisteredAgentHarness } from "./harness/registry.js";
import { ensureSelectedAgentHarnessPlugin } from "./harness/runtime-plugin.js";
import type { AgentHarness } from "./harness/types.js";
import {
  isCliRuntimeAliasForProvider,
  resolveCliRuntimeExecutionProvider,
} from "./model-runtime-aliases.js";
import {
  unwrapModelHeaderSentinelsForProviderEgress,
  unwrapSecretSentinelsForProviderEgress,
} from "./provider-secret-egress.js";
import { prepareSimpleCompletionModel } from "./simple-completion-runtime.js";
import { resolveEffectiveAgentRuntime } from "./thinking-runtime.js";

type RunIsolatedCompletionParams = {
  config?: OpenClawConfig;
  provider: string;
  model: string;
  /** Explicit credential owner. CLI and harness paths must not replace it with another profile. */
  authProfileId?: string;
  agentId?: string;
  workspaceDir?: string;
  /** Concrete owner already resolved by the caller, when available. */
  agentHarnessRuntimeOverride?: string;
  systemPrompt: string;
  prompt: string;
  timeoutMs: number;
  abortSignal?: AbortSignal;
  thinkLevel?: ThinkLevel;
  streamParams?: {
    maxTokens?: number;
    temperature?: number;
  };
};

export type IsolatedCompletionResult = {
  text: string;
  provider: string;
  model: string;
  owner: { kind: "cli" | "harness"; id: string };
  /** CLI runtimes may not report token usage; absence must not be projected as zero. */
  usage?: AssistantMessage["usage"];
};

type IsolatedCompletionErrorCode =
  | "unsupported"
  | "runtime-unavailable"
  | "input-rejected"
  | "output-rejected";

class IsolatedCompletionError extends Error {
  readonly code: IsolatedCompletionErrorCode;

  constructor(code: IsolatedCompletionErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "IsolatedCompletionError";
    this.code = code;
  }
}

type AgentHarnessIsolatedCompletionParams = Parameters<
  NonNullable<AgentHarness["runIsolatedCompletion"]>
>[0];

function requireIsolatedAssistantText(assistant: AssistantMessage): string {
  if (assistant.stopReason !== "stop" && assistant.stopReason !== "length") {
    throw new IsolatedCompletionError(
      "output-rejected",
      `Isolated completion failed with stop reason ${assistant.stopReason}.`,
    );
  }
  const textParts: string[] = [];
  for (const block of assistant.content) {
    if (block.type === "text") {
      textParts.push(block.text);
      continue;
    }
    if (block.type === "thinking") {
      continue;
    }
    throw new IsolatedCompletionError(
      "output-rejected",
      "Isolated completion returned a tool call; the result was rejected.",
    );
  }
  const text = textParts.join("").trim();
  if (!text) {
    throw new IsolatedCompletionError(
      "output-rejected",
      "Isolated completion returned empty output.",
    );
  }
  return text;
}

function hasCliSideEffectEvidence(result: {
  didSendViaMessagingTool?: boolean;
  didDeliverSourceReplyViaMessageTool?: boolean;
  messagingToolSentTexts?: unknown[];
  messagingToolSentMediaUrls?: unknown[];
  messagingToolSentTargets?: unknown[];
  messagingToolSourceReplyPayloads?: unknown[];
  acceptedSessionSpawns?: unknown[];
  successfulCronAdds?: number;
}): boolean {
  return Boolean(
    result.didSendViaMessagingTool ||
    result.didDeliverSourceReplyViaMessageTool ||
    result.messagingToolSentTexts?.length ||
    result.messagingToolSentMediaUrls?.length ||
    result.messagingToolSentTargets?.length ||
    result.messagingToolSourceReplyPayloads?.length ||
    result.acceptedSessionSpawns?.length ||
    result.successfulCronAdds,
  );
}

async function runCliIsolatedCompletion(params: {
  request: RunIsolatedCompletionParams;
  provider: string;
  modelProvider: string;
  agentId: string;
  agentDir: string;
  workspaceDir: string;
}): Promise<{ model: string; text: string }> {
  return await withTempWorkspace(
    { rootDir: resolvePreferredOpenClawTmpDir(), prefix: "openclaw-isolated-completion-" },
    async ({ dir }) => {
      const { runCliAgent } = await import("./cli-runner.runtime.js");
      const sessionId = `isolated-completion-${Date.now()}`;
      const result = await runCliAgent({
        sessionId,
        sessionFile: path.join(dir, "session.json"),
        workspaceDir: params.workspaceDir,
        cwd: dir,
        agentDir: params.agentDir,
        agentId: params.agentId,
        config: params.request.config,
        prompt: params.request.prompt,
        extraSystemPrompt: params.request.systemPrompt,
        timeoutMs: params.request.timeoutMs,
        runId: sessionId,
        provider: params.provider,
        modelProvider: params.modelProvider,
        model: params.request.model,
        // The CLI runner treats a supplied profile as exact; it auto-selects only
        // when this field is absent. This path has no embedded-run fallback loop.
        authProfileId: params.request.authProfileId,
        thinkLevel: params.request.thinkLevel,
        streamParams: params.request.streamParams,
        abortSignal: params.request.abortSignal,
        executionMode: "side-question",
        cliToolAvailability: { native: [], openClaw: [] },
        disableTools: true,
        disableCliLiveSession: true,
        cleanupCliLiveSessionOnRunEnd: true,
        cleanupBundleMcpOnRunEnd: true,
        requireExplicitMessageTarget: true,
        isolatedCompletion: true,
      });
      if (hasCliSideEffectEvidence(result)) {
        throw new IsolatedCompletionError(
          "output-rejected",
          "Isolated CLI completion returned side-effect evidence; result rejected.",
        );
      }
      const payloads = result.payloads ?? [];
      if (
        payloads.some(
          (payload) =>
            payload.isError ||
            payload.mediaUrl ||
            payload.mediaUrls?.length ||
            payload.audioAsVoice ||
            payload.channelData,
        )
      ) {
        throw new IsolatedCompletionError(
          "output-rejected",
          "Isolated CLI completion returned non-text output; result rejected.",
        );
      }
      const text = payloads
        .filter((payload) => !payload.isReasoning && typeof payload.text === "string")
        .map((payload) => payload.text ?? "")
        .join("\n")
        .trim();
      if (!text) {
        throw new IsolatedCompletionError(
          "output-rejected",
          "Isolated CLI completion returned empty output.",
        );
      }
      const backend = resolveCliBackendConfig(params.provider, params.request.config, {
        agentId: params.agentId,
      });
      if (!backend) {
        throw new IsolatedCompletionError(
          "runtime-unavailable",
          `CLI backend ${params.provider} became unavailable after execution.`,
        );
      }
      return { text, model: normalizeCliModel(params.request.model, backend.config) };
    },
  );
}

function resolveCliOwner(params: {
  request: RunIsolatedCompletionParams;
  provider: string;
  runtime: string;
  agentId: string;
  agentDir: string;
  workspaceDir: string;
}): string | undefined {
  if (
    isCliRuntimeAliasForProvider({
      runtime: params.runtime,
      provider: params.provider,
      cfg: params.request.config,
    })
  ) {
    return params.runtime;
  }
  if (params.request.agentHarnessRuntimeOverride) {
    // An explicit non-CLI owner is authoritative. Automatic CLI discovery must
    // not bypass that harness or turn its unsupported result into a fallback.
    return undefined;
  }
  return (
    resolveCliRuntimeExecutionProvider({
      provider: params.provider,
      cfg: params.request.config,
      agentId: params.agentId,
      modelId: params.request.model,
      authProfileId: params.request.authProfileId,
    }) ??
    resolveEmbeddedCliBackendDispatchEligibility({
      provider: params.provider,
      model: params.request.model,
      agentId: params.agentId,
      authProfileId: params.request.authProfileId,
      config: params.request.config,
      agentDir: params.agentDir,
      workspaceDir: params.workspaceDir,
    })?.provider
  );
}

async function resolveHarness(runtime: string): Promise<AgentHarness> {
  if (runtime === "openclaw") {
    const { createOpenClawAgentHarness } = await import("./harness/builtin-openclaw.js");
    return createOpenClawAgentHarness();
  }
  const harness = getRegisteredAgentHarness(runtime)?.harness;
  if (!harness) {
    throw new IsolatedCompletionError(
      "runtime-unavailable",
      `Agent harness ${runtime} is unavailable for isolated completion.`,
    );
  }
  return harness;
}

function prepareIsolatedHarnessParams(
  harness: AgentHarness,
  params: AgentHarnessIsolatedCompletionParams,
): AgentHarnessIsolatedCompletionParams {
  if (harness.id === "openclaw") {
    return params;
  }
  // External harnesses are the provider egress boundary. Keep credentials
  // sentinelized until this owner is selected, then hand it usable values.
  const boundary = "plugin harness isolated completion handoff";
  const apiKey = params.auth.apiKey
    ? unwrapSecretSentinelsForProviderEgress(params.auth.apiKey, boundary)
    : params.auth.apiKey;
  const model = unwrapModelHeaderSentinelsForProviderEgress(params.model, boundary);
  if (apiKey === params.auth.apiKey && model === params.model) {
    return params;
  }
  return {
    ...params,
    model,
    auth: { ...params.auth, apiKey },
  };
}

/** Run one fresh completion without any model-callable tool surface or fallback. */
export async function runIsolatedCompletion(
  request: RunIsolatedCompletionParams,
): Promise<IsolatedCompletionResult> {
  const config = request.config ?? {};
  const agentId = request.agentId ?? resolveDefaultAgentId(config);
  const agentDir = resolveAgentDir(config, agentId);
  const workspaceDir = request.workspaceDir ?? resolveAgentWorkspaceDir(config, agentId);
  const provider =
    resolveCliRuntimeCanonicalProvider({
      runtime: request.provider,
      config,
      includeSetupRegistry: true,
    }) ?? request.provider;

  await ensureSelectedAgentHarnessPlugin({
    provider,
    modelId: request.model,
    config,
    agentId,
    agentHarnessId: request.agentHarnessRuntimeOverride,
    agentHarnessRuntimeOverride: request.agentHarnessRuntimeOverride,
    workspaceDir,
  });
  const runtime =
    request.agentHarnessRuntimeOverride ??
    resolveEffectiveAgentRuntime({ cfg: config, provider, modelId: request.model, agentId });
  const cliOwner = resolveCliOwner({
    request,
    provider,
    runtime,
    agentId,
    agentDir,
    workspaceDir,
  });
  if (cliOwner) {
    const completion = await runCliIsolatedCompletion({
      request,
      provider: cliOwner,
      modelProvider: provider,
      agentId,
      agentDir,
      workspaceDir,
    });
    return {
      text: completion.text,
      provider,
      model: completion.model,
      owner: { kind: "cli", id: cliOwner },
    };
  }

  const harness = await resolveHarness(runtime);
  if (!harness.runIsolatedCompletion) {
    throw new IsolatedCompletionError(
      "unsupported",
      `Agent harness ${harness.id} does not support isolated completion.`,
    );
  }
  const prepared = await prepareSimpleCompletionModel({
    cfg: config,
    agentId,
    provider,
    modelId: request.model,
    agentDir,
    profileId: request.authProfileId,
    allowMissingApiKeyModes: ["aws-sdk"],
    allowBundledStaticCatalogFallback: true,
    skipAgentDiscovery: true,
    bindAuthOwner: true,
  });
  if ("error" in prepared) {
    throw new Error(`Isolated completion preparation failed: ${prepared.error}`);
  }
  const harnessParams: AgentHarnessIsolatedCompletionParams = {
    provider,
    modelId: request.model,
    model: prepared.model,
    auth: prepared.auth,
    ...(prepared.sourceAuthFingerprint
      ? { sourceAuthFingerprint: prepared.sourceAuthFingerprint }
      : {}),
    config,
    agentId,
    agentDir,
    workspaceDir,
    systemPrompt: request.systemPrompt,
    prompt: request.prompt,
    timeoutMs: request.timeoutMs,
    abortSignal: request.abortSignal,
    thinkLevel: request.thinkLevel,
    streamParams: request.streamParams,
  };
  const result = await harness.runIsolatedCompletion(
    prepareIsolatedHarnessParams(harness, harnessParams),
  );
  return {
    text: requireIsolatedAssistantText(result.assistant),
    provider: result.assistant.provider,
    model: result.assistant.model,
    owner: { kind: "harness", id: harness.id },
    usage: result.assistant.usage,
  };
}
