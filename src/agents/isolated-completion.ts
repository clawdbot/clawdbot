/**
 * Fresh, prompt-only inference with an exact zero-tool execution contract.
 *
 * This operation deliberately bypasses the ordinary agent attempt, retry,
 * transcript, hook, and delivery lifecycle. Execution owners either prove a
 * literal empty native tool surface or fail before inference starts.
 */
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { ThinkLevel } from "../auto-reply/thinking.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { withTempWorkspace } from "../infra/private-temp-workspace.js";
import { resolvePreferredOpenClawTmpDir } from "../infra/tmp-openclaw-dir.js";
import type { AssistantMessage, Model } from "../llm/types.js";
import { withPluginRuntimeGenerationScope } from "../plugins/runtime/generation-scope.js";
import { prepareSystemAgentRunAdmission } from "./admitted-run-context.js";
import { resolveAgentDir, resolveAgentWorkspaceDir, resolveDefaultAgentId } from "./agent-scope.js";
import { resolveCliBackendConfig, resolveCliRuntimeCanonicalProvider } from "./cli-backends.js";
import { normalizeCliModel } from "./cli-runner/helpers.js";
import { resolveEmbeddedCliBackendDispatchEligibility } from "./embedded-agent-runner/cli-backend-dispatch-eligibility.js";
import { resolveModelAsync } from "./embedded-agent-runner/model.js";
import { getRegisteredAgentHarness } from "./harness/registry.js";
import { ensureSelectedAgentHarnessPlugin } from "./harness/runtime-plugin.js";
import type {
  AgentHarness,
  AgentHarnessIsolatedCompletionAuthorization,
  AgentHarnessIsolatedCompletionParamsV2,
  AgentHarnessIsolatedCompletionResult,
} from "./harness/types.js";
import { ensureAuthProfileStore } from "./model-auth.js";
import {
  isCliRuntimeAliasForProvider,
  resolveCliRuntimeExecutionProvider,
} from "./model-runtime-aliases.js";
import {
  acquireAgentRunPreparedModelRuntime,
  type PreparedModelRuntimeSnapshot,
} from "./prepared-model-runtime.js";
import {
  unwrapModelHeaderSentinelsForProviderEgress,
  unwrapSecretSentinelsForProviderEgress,
} from "./provider-secret-egress.js";
import { materializePreparedRuntimeModel } from "./runtime-plan/materialize-model.js";
import {
  canRunPreparedAgentRuntimeAuthAttempt,
  prepareAgentRuntimeAuth,
  preparedAgentRuntimeProfileAttemptHasCandidate,
  type PreparedAgentRuntimeAuthAttempt,
} from "./runtime-plan/prepare-auth.js";
import { scopeAuthProfileStoreToPreparedPlan } from "./runtime-plan/resolve-auth.js";
import { prepareSimpleCompletionModel } from "./simple-completion-runtime.js";
import { resolveEffectiveAgentRuntime } from "./thinking-runtime.js";
import type { UsageLike } from "./usage.js";

type RunIsolatedCompletionParams = {
  config?: OpenClawConfig;
  provider: string;
  model: string;
  /** Explicit credential owner. CLI and harness paths must not replace it with another profile. */
  authProfileId?: string;
  agentId?: string;
  agentDir?: string;
  workspaceDir?: string;
  /** Concrete owner already resolved by the caller, when available. */
  agentHarnessRuntimeOverride?: string;
  systemPrompt: string;
  prompt: string;
  timeoutMs: number;
  abortSignal?: AbortSignal;
  /** Revalidate the caller's authority before credential handoff and dispatch. */
  assertCurrent?: () => void;
  thinkLevel?: ThinkLevel;
  outputTextPolicy?: AgentHarnessIsolatedCompletionParamsV2["outputTextPolicy"];
  streamParams?: AgentHarnessIsolatedCompletionParamsV2["streamParams"];
};

export type IsolatedCompletionResult = {
  text: string;
  provider: string;
  model: string;
  owner: { kind: "cli" | "harness"; id: string };
  /** CLI runtimes may not report token usage; absence must not be projected as zero. */
  usage?: UsageLike;
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

function clampIsolatedStreamParams(
  streamParams: RunIsolatedCompletionParams["streamParams"],
  modelMaxTokens: number | undefined,
): RunIsolatedCompletionParams["streamParams"] {
  if (streamParams?.maxTokens === undefined || modelMaxTokens === undefined) {
    return streamParams;
  }
  return { ...streamParams, maxTokens: Math.min(streamParams.maxTokens, modelMaxTokens) };
}

function selectIsolatedHarnessAuthPlan(attempt: PreparedAgentRuntimeAuthAttempt) {
  if (attempt.kind !== "profile") {
    return attempt.plan;
  }
  return {
    ...attempt.plan,
    forwardedAuthProfileId: attempt.profileId,
    // Core owns candidate order. A harness receives one selected credential
    // snapshot per call so it cannot inspect or reorder fallback profiles.
    forwardedAuthProfileCandidateIds: [attempt.profileId],
  };
}

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
  return textParts.join("").trim();
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
  request: RunIsolatedCompletionParams & { config: OpenClawConfig };
  provider: string;
  modelProvider: string;
  agentId: string;
  agentDir: string;
  workspaceDir: string;
}): Promise<{ model: string; text: string; usage?: UsageLike }> {
  return await withTempWorkspace(
    { rootDir: resolvePreferredOpenClawTmpDir(), prefix: "openclaw-isolated-completion-" },
    async ({ dir }) => {
      const { runCliAgent } = await import("./cli-runner.runtime.js");
      params.request.assertCurrent?.();
      const sessionId = `isolated-completion-${randomUUID()}`;
      const config = params.request.config;
      const preparedRunAdmission = prepareSystemAgentRunAdmission(
        config,
        sessionId,
        params.agentId,
        "isolated-completion",
      );
      try {
        params.request.assertCurrent?.();
        const result = await runCliAgent({
          preparedRunAdmission,
          sessionId,
          sessionFile: path.join(dir, "session.json"),
          workspaceDir: params.workspaceDir,
          cwd: dir,
          agentDir: params.agentDir,
          agentId: params.agentId,
          config,
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
          assertCurrent: params.request.assertCurrent,
          executionMode: "side-question",
          cliToolAvailability: { native: [], openClaw: [] },
          disableTools: true,
          disableCliLiveSession: true,
          cleanupCliLiveSessionOnRunEnd: true,
          cleanupBundleMcpOnRunEnd: true,
          requireExplicitMessageTarget: true,
          isolatedCompletion: true,
          outputTextPolicy: params.request.outputTextPolicy,
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
        const backend = resolveCliBackendConfig(params.provider, params.request.config, {
          agentId: params.agentId,
        });
        if (!backend) {
          throw new IsolatedCompletionError(
            "runtime-unavailable",
            `CLI backend ${params.provider} became unavailable after execution.`,
          );
        }
        const usage = result.meta?.agentMeta?.usage;
        return {
          text,
          model: normalizeCliModel(params.request.model, backend.config),
          ...(usage ? { usage } : {}),
        };
      } finally {
        preparedRunAdmission.close();
      }
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

function prepareIsolatedHostAuthorization<
  T extends Pick<AgentHarnessIsolatedCompletionParams, "model" | "auth">,
>(harness: AgentHarness, authorization: T): T {
  if (harness.id === "openclaw") {
    return authorization;
  }
  // External harnesses are the provider egress boundary. Keep credentials
  // sentinelized until this owner is selected, then hand it usable values.
  const boundary = "plugin harness isolated completion handoff";
  const apiKey = authorization.auth.apiKey
    ? unwrapSecretSentinelsForProviderEgress(authorization.auth.apiKey, boundary)
    : authorization.auth.apiKey;
  const model = unwrapModelHeaderSentinelsForProviderEgress(authorization.model, boundary);
  if (apiKey === authorization.auth.apiKey && model === authorization.model) {
    return authorization;
  }
  return {
    ...authorization,
    model,
    auth: { ...authorization.auth, apiKey },
  };
}

async function prepareHostAuthorization(params: {
  config: OpenClawConfig;
  agentId: string;
  agentDir: string;
  provider: string;
  modelId: string;
  authProfileId?: string;
  workspaceDir: string;
  preparedModelRuntime: PreparedModelRuntimeSnapshot;
}): Promise<Extract<AgentHarnessIsolatedCompletionAuthorization, { owner: "host" }>> {
  const prepared = await prepareSimpleCompletionModel({
    cfg: params.config,
    agentId: params.agentId,
    provider: params.provider,
    modelId: params.modelId,
    agentDir: params.agentDir,
    profileId: params.authProfileId,
    allowMissingApiKeyModes: ["aws-sdk"],
    allowBundledStaticCatalogFallback: true,
    skipAgentDiscovery: true,
    bindAuthOwner: true,
    workspaceDir: params.workspaceDir,
    preparedModelRuntime: params.preparedModelRuntime,
  });
  if ("error" in prepared) {
    throw new Error(`Isolated completion preparation failed: ${prepared.error}`);
  }
  return {
    owner: "host",
    model: prepared.model,
    auth: prepared.auth,
    ...(prepared.sourceAuthFingerprint
      ? { sourceAuthFingerprint: prepared.sourceAuthFingerprint }
      : {}),
  };
}

/** Run one fresh, zero-tool completion through its selected runtime. */
export async function runIsolatedCompletion(
  params: RunIsolatedCompletionParams,
): Promise<IsolatedCompletionResult> {
  // Snapshot caller choices and validators before admission yields; callbacks expire on close.
  const input = {
    ...params,
    streamParams: params.streamParams && { ...params.streamParams },
  };
  let closed = false;
  const assertCurrent = () => {
    if (closed) {
      throw new IsolatedCompletionError("runtime-unavailable", "Isolated completion has ended.");
    }
    input.assertCurrent?.();
    input.abortSignal?.throwIfAborted();
  };
  assertCurrent();
  const requestConfig = input.config ?? {};
  const agentId = input.agentId ?? resolveDefaultAgentId(requestConfig);
  const requestAgentDir = input.agentDir ?? resolveAgentDir(requestConfig, agentId);
  const requestedWorkspaceDir =
    input.workspaceDir ?? resolveAgentWorkspaceDir(requestConfig, agentId);
  const canonicalProvider = resolveCliRuntimeCanonicalProvider({
    runtime: input.provider,
    config: requestConfig,
    includeSetupRegistry: true,
  });
  const provider = canonicalProvider ?? input.provider;
  // Canonicalizing a CLI model ref must not discard its explicit execution owner.
  const runtimeOverride =
    input.agentHarnessRuntimeOverride ?? (canonicalProvider ? input.provider : undefined);
  const lease = await acquireAgentRunPreparedModelRuntime(
    {
      config: requestConfig,
      agentId,
      agentDir: requestAgentDir,
      workspaceDir: requestedWorkspaceDir,
      preserveWorkspaceDirOnRefresh: input.workspaceDir !== undefined,
    },
    {
      catalogMode: "static",
      abortSignal: input.abortSignal,
      deriveRuntimePluginSelections: () => [
        {
          provider,
          modelId: input.model,
          ...(runtimeOverride ? { runtime: runtimeOverride } : {}),
          agentId,
        },
      ],
    },
  );
  try {
    assertCurrent();
    const run = async (): Promise<IsolatedCompletionResult> => {
      // A new admission owns config and directories; the caller keeps its explicit route and profile.
      const context = {
        config: lease.snapshot.config,
        agentId,
        agentDir: lease.snapshot.agentDir,
        workspaceDir: lease.snapshot.workspaceDir ?? requestedWorkspaceDir,
      };
      const { config, agentDir, workspaceDir } = context;
      const request = { ...input, ...context, assertCurrent };
      await ensureSelectedAgentHarnessPlugin({
        provider,
        modelId: request.model,
        ...context,
        agentHarnessId: runtimeOverride,
        agentHarnessRuntimeOverride: runtimeOverride,
        pluginRegistry: lease.snapshot.pluginRegistry,
      });
      assertCurrent();
      const runtime =
        runtimeOverride ??
        resolveEffectiveAgentRuntime({ cfg: config, provider, modelId: request.model, agentId });
      const cliOwner = resolveCliOwner({
        request,
        provider,
        runtime,
        ...context,
      });
      if (cliOwner) {
        const completion = await runCliIsolatedCompletion({
          request,
          provider: cliOwner,
          modelProvider: provider,
          ...context,
        });
        return {
          text: completion.text,
          provider,
          model: completion.model,
          owner: { kind: "cli", id: cliOwner },
          ...(completion.usage ? { usage: completion.usage } : {}),
        };
      }

      const harness = await resolveHarness(runtime);
      assertCurrent();
      if (!harness.runIsolatedCompletionV2 && !harness.runIsolatedCompletion) {
        throw new IsolatedCompletionError(
          "unsupported",
          `Agent harness ${harness.id} does not support isolated completion.`,
        );
      }
      const commonParams = {
        provider,
        modelId: request.model,
        ...context,
        systemPrompt: request.systemPrompt,
        prompt: request.prompt,
        timeoutMs: request.timeoutMs,
        abortSignal: request.abortSignal,
        assertCurrent,
        thinkLevel: request.thinkLevel,
        outputTextPolicy: request.outputTextPolicy,
      };
      let result: AgentHarnessIsolatedCompletionResult | undefined;
      if (harness.runIsolatedCompletionV2) {
        let modelMaxTokens: number | undefined;
        let harnessAuth:
          | {
              model: Model;
              store: ReturnType<typeof ensureAuthProfileStore>;
              attempts: readonly PreparedAgentRuntimeAuthAttempt[];
            }
          | undefined;
        if (harness.authBootstrap === "harness") {
          const resolution = await resolveModelAsync(provider, request.model, agentDir, config, {
            ...lease.snapshot.createStores(),
            preparedModelRuntime: lease.snapshot,
            workspaceDir,
            authProfileId: request.authProfileId,
            skipAgentDiscovery: true,
            allowBundledStaticCatalogFallback: true,
            preferBundledStaticCatalogTransport: true,
          });
          const runtimeModel = resolution.model;
          if (!runtimeModel) {
            throw new IsolatedCompletionError(
              "runtime-unavailable",
              resolution.error ?? `Unknown isolated completion model ${provider}/${request.model}.`,
            );
          }
          assertCurrent();
          const authProfileStore = ensureAuthProfileStore(agentDir, {
            profileId: request.authProfileId,
            readOnly: true,
            allowKeychainPrompt: false,
            config,
          });
          const authAttempts = prepareAgentRuntimeAuth({
            provider: runtimeModel.provider,
            modelId: runtimeModel.id,
            modelApi: runtimeModel.api,
            modelBaseUrl: runtimeModel.baseUrl,
            ...context,
            env: process.env,
            authProfileStore,
            sessionAuthProfileId: request.authProfileId,
            sessionAuthProfileSource: request.authProfileId ? "user" : undefined,
            harnessId: harness.id,
            harnessRuntime: harness.id,
            harnessAuthBootstrap: harness.authBootstrap,
          }).attempts;
          harnessAuth = { model: runtimeModel, store: authProfileStore, attempts: authAttempts };
        }
        let firstError: unknown;
        let priorProfileAttempted = false;
        for (const preparedAttempt of harnessAuth?.attempts.length
          ? harnessAuth.attempts
          : [undefined]) {
          assertCurrent();
          const attempt: PreparedAgentRuntimeAuthAttempt | undefined =
            preparedAttempt?.kind === "profile"
              ? { ...preparedAttempt, plan: selectIsolatedHarnessAuthPlan(preparedAttempt) }
              : preparedAttempt;
          if (
            attempt &&
            !canRunPreparedAgentRuntimeAuthAttempt({ attempt, priorProfileAttempted })
          ) {
            firstError ??= new Error("Prepared direct auth requires a prior profile attempt.");
            continue;
          }
          if (
            attempt?.kind === "profile" &&
            harnessAuth &&
            !preparedAgentRuntimeProfileAttemptHasCandidate({
              attempt,
              store: harnessAuth.store,
              modelId: harnessAuth.model.id,
            })
          ) {
            firstError ??= new Error(
              "Prepared runtime auth candidates are temporarily unavailable.",
            );
            continue;
          }
          try {
            let authorization: AgentHarnessIsolatedCompletionAuthorization;
            if (
              attempt?.plan.harnessAuthProvider &&
              attempt.plan.modelRoute?.authRequirement !== "api-key" &&
              harnessAuth
            ) {
              const plan = attempt.plan;
              // Auth owns the resolved model tuple; a manifest alias remains only
              // on the caller's dispatch envelope, not on the materialization target.
              const { model: runtimeModel, store: authProfileStore } = harnessAuth;
              const model = await materializePreparedRuntimeModel({
                plan,
                provider: runtimeModel.provider,
                modelId: runtimeModel.id,
                model: runtimeModel,
                config,
                workspaceDir,
                metadataSnapshot: lease.snapshot.metadataSnapshot,
                resolveModel: ({ config: modelConfig, authProfileId, authProfileMode }) =>
                  resolveModelAsync(runtimeModel.provider, runtimeModel.id, agentDir, modelConfig, {
                    preparedModelRuntime: lease.snapshot,
                    workspaceDir,
                    authProfileId,
                    authProfileMode,
                    skipAgentDiscovery: true,
                    allowBundledStaticCatalogFallback: true,
                    preferBundledStaticCatalogTransport: true,
                  }),
              });
              assertCurrent();
              modelMaxTokens = model?.maxTokens;
              authorization = {
                owner: "harness",
                plan,
                authProfileStore: scopeAuthProfileStoreToPreparedPlan(authProfileStore, plan),
              };
            } else {
              authorization = await prepareHostAuthorization({
                ...context,
                provider,
                modelId: request.model,
                authProfileId:
                  attempt?.kind === "profile" ? attempt.profileId : request.authProfileId,
                preparedModelRuntime: lease.snapshot,
              });
              modelMaxTokens = authorization.model.maxTokens;
            }
            if (
              attempt?.kind === "profile" &&
              harnessAuth &&
              !preparedAgentRuntimeProfileAttemptHasCandidate({
                attempt,
                store: harnessAuth.store,
                modelId: harnessAuth.model.id,
              })
            ) {
              throw new Error("Prepared runtime auth candidates are temporarily unavailable.");
            }
            assertCurrent();
            const pending = harness.runIsolatedCompletionV2({
              ...commonParams,
              authorization:
                authorization.owner === "host"
                  ? prepareIsolatedHostAuthorization(harness, authorization)
                  : authorization,
              streamParams: clampIsolatedStreamParams(request.streamParams, modelMaxTokens),
            });
            priorProfileAttempted ||= attempt?.kind === "profile";
            result = await pending;
            break;
          } catch (error) {
            // A retired caller cannot authorize another credential attempt.
            assertCurrent();
            firstError ??= error;
          }
        }
        if (!result) {
          if (firstError instanceof Error) {
            throw firstError;
          }
          throw new Error("No prepared auth attempt succeeded.", { cause: firstError });
        }
      } else {
        const authorization = await prepareHostAuthorization({
          ...context,
          provider,
          modelId: request.model,
          authProfileId: request.authProfileId,
          preparedModelRuntime: lease.snapshot,
        });
        const harnessParams: AgentHarnessIsolatedCompletionParams = {
          ...commonParams,
          streamParams: clampIsolatedStreamParams(
            request.streamParams,
            authorization.model.maxTokens,
          ),
          model: authorization.model,
          auth: authorization.auth,
          ...(authorization.sourceAuthFingerprint
            ? { sourceAuthFingerprint: authorization.sourceAuthFingerprint }
            : {}),
        };
        assertCurrent();
        result = await harness.runIsolatedCompletion!(
          prepareIsolatedHostAuthorization(harness, harnessParams),
        );
      }
      if (!result) {
        throw new IsolatedCompletionError("runtime-unavailable", "Isolated completion failed.");
      }
      return {
        text: requireIsolatedAssistantText(result.assistant),
        provider: result.assistant.provider,
        model: result.assistant.model,
        owner: { kind: "harness", id: harness.id },
        usage: result.assistant.usage,
      };
    };
    const result = await withPluginRuntimeGenerationScope(lease.snapshot, run);
    assertCurrent();
    if (!result.text && input.outputTextPolicy !== "strict-visible") {
      throw new IsolatedCompletionError(
        "output-rejected",
        "Isolated completion returned empty output.",
      );
    }
    return result;
  } finally {
    closed = true;
    lease.release();
  }
}
