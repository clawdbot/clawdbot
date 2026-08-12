/**
 * Prepares one direct embedded-agent compaction attempt through model, auth,
 * workspace, and sandbox resolution.
 */
import fs from "node:fs/promises";
import type { ThinkLevel, ThinkingCatalogEntry } from "../../auto-reply/thinking.js";
import {
  createDiagnosticTraceContext,
  freezeDiagnosticTraceContext,
  getActiveDiagnosticTraceContext,
} from "../../infra/diagnostic-trace-context.js";
import { formatErrorMessage } from "../../infra/errors.js";
import type { ProviderRuntimeModel } from "../../plugins/provider-runtime-model.types.js";
import { prepareProviderRuntimeAuth } from "../../plugins/provider-runtime.js";
import { resolveUserPath } from "../../utils.js";
import { resolveAgentDir, resolveSessionAgentIds } from "../agent-scope.js";
import { describeFailoverError } from "../failover-error.js";
import { ensureSelectedAgentHarnessPlugin } from "../harness/runtime-plugin.js";
import { MissingProviderAuthError } from "../model-auth.js";
import type { PreparedModelRuntimeSnapshot } from "../prepared-model-runtime.js";
import { applyPreparedRuntimeAuthToModel } from "../provider-request-config.js";
import {
  protectPreparedProviderRuntimeAuth,
  unwrapSecretSentinelsForProviderEgress,
} from "../provider-secret-egress.js";
import { materializePreparedRuntimeModel } from "../runtime-plan/materialize-model.js";
import {
  resolvePreparedRuntimeAuthAttempts,
  resolvePreparedRuntimeModelAuth,
} from "../runtime-plan/resolve-auth.js";
import type { AgentRuntimeAuthPlan } from "../runtime-plan/types.js";
import { resolveSandboxContext } from "../sandbox.js";
import {
  classifyCompactionReason,
  formatUnknownCompactionReasonDetail,
} from "./compact-reasons.js";
import type { CompactEmbeddedAgentSessionRuntimeParams } from "./compact.types.js";
import { createDirectCompactionDiagId } from "./compaction-diagnostics.js";
import { resolveEmbeddedCompactionThinkingLevel } from "./compaction-runtime-context.js";
import {
  prepareCompactionHarnessAuth,
  resolveCompactionRuntimeSelection,
} from "./compaction-runtime-preparation.js";
import { log } from "./logger.js";
import { resolveTieredModel } from "./model-resolution.js";
import { resolveModelAsync } from "./model.js";
import type { EmbeddedAgentCompactResult } from "./types.js";

export type PreparedCompactEmbeddedAgentSessionParams = CompactEmbeddedAgentSessionRuntimeParams & {
  sessionFile: string;
  preparedModelRuntime: PreparedModelRuntimeSnapshot;
};

export async function prepareDirectCompactionAttempt(
  params: PreparedCompactEmbeddedAgentSessionParams,
) {
  const startedAt = Date.now();
  const diagId = params.diagId?.trim() || createDirectCompactionDiagId();
  const trigger = params.trigger ?? "manual";
  const attempt = params.attempt ?? 1;
  const maxAttempts = params.maxAttempts ?? 1;
  const runId = params.runId ?? params.sessionId;
  // Parent compaction model-call spans to the active run/harness trace when one
  // exists, otherwise start a fresh root. Compaction emits no intermediate span
  // of its own (unlike the run lifecycle, which backs its run trace with a
  // run.started span), so a child trace here would orphan the model call under a
  // phantom parent. The :compaction: runId/callId already distinguishes the span.
  const compactionModelCallTrace = freezeDiagnosticTraceContext(
    getActiveDiagnosticTraceContext() ?? createDiagnosticTraceContext(),
  );
  const diagnosticCompactionRunId = `${runId}:compaction:${diagId}`;
  let diagnosticModelCallSeq = 0;
  const resolvedWorkspace = resolveUserPath(params.workspaceDir);
  const earlyAgentIds = resolveSessionAgentIds({
    sessionKey: params.sessionKey,
    config: params.config,
    agentId: params.agentId,
  });
  const agentDir =
    params.agentDir ?? resolveAgentDir(params.config ?? {}, earlyAgentIds.sessionAgentId);
  const {
    runtimePolicySessionKey,
    runtimePolicyAgentId,
    boundHarnessRuntime,
    selectedHarnessRuntimeOverride,
    runtimeModelAuth: { plan: reusableRuntimeAuthPlan, authProfileId, modelAuth: initialModelAuth },
    provider,
    runtimeProvider,
    contextConfigProvider,
    modelId,
  } = resolveCompactionRuntimeSelection({
    ...params,
    modelId: params.model,
    boundHarnessRuntime: params.agentHarnessId,
    preparedRuntimePlan: params.runtimePlan,
  });
  // Keep the configured provider for harness policy, while auth/model loading below can
  // route OpenAI compaction through Codex OAuth when that runtime owns the session credentials.
  // Ensure the policy-selected harness plugin so selection can pick implicit codex.
  await ensureSelectedAgentHarnessPlugin({
    config: params.config,
    provider,
    modelId,
    agentId: runtimePolicyAgentId,
    sessionKey: runtimePolicySessionKey,
    agentHarnessId: boundHarnessRuntime,
    agentHarnessRuntimeOverride: selectedHarnessRuntimeOverride,
    workspaceDir: resolvedWorkspace,
    pluginRegistry: params.preparedModelRuntime.pluginRegistry!,
  });
  const attemptedThinking = new Set<ThinkLevel>();
  const fail = (reason: string, err?: unknown): EmbeddedAgentCompactResult => {
    const failureReason = classifyCompactionReason(reason);
    const failure = err ? describeFailoverError(err) : undefined;
    const detail =
      failureReason === "unknown" ? formatUnknownCompactionReasonDetail(reason) : undefined;
    const detailSuffix = detail ? ` detail=${detail}` : "";
    log.warn(
      `[compaction-diag] end runId=${runId} sessionKey=${params.sessionKey ?? params.sessionId} ` +
        `diagId=${diagId} trigger=${trigger} provider=${provider}/${modelId} ` +
        `attempt=${attempt} maxAttempts=${maxAttempts} outcome=failed reason=${failureReason}${detailSuffix} ` +
        `durationMs=${Date.now() - startedAt}`,
    );
    return {
      ok: false,
      compacted: false,
      reason,
      failure: failure
        ? {
            reason: failure.reason,
            status: failure.status,
            code: failure.code,
            rawError: failure.rawError ?? failure.message,
          }
        : undefined,
    };
  };
  const preparedModelRuntime = params.preparedModelRuntime;
  const { resolution: modelResolution } = await resolveTieredModel({
    provider: runtimeProvider,
    modelId,
    agentDir,
    config: params.config,
    workspaceDir: resolvedWorkspace,
    ...initialModelAuth,
    preparedModelRuntime,
  });
  const { model, error, authStorage, modelRegistry } = modelResolution;
  if (!model) {
    const reason = error ?? `Unknown model: ${runtimeProvider}/${modelId}`;
    return { ok: false as const, result: fail(reason) };
  }
  const modelResolutionOptions = {
    authStorage,
    modelRegistry,
    preparedModelRuntime,
    workspaceDir: resolvedWorkspace,
  };
  // Overrides stay unset when no bound/planned/explicit harness resolved so auth-aware
  // selection can pick the credential-owning harness (codex for ChatGPT OAuth); native
  // transcript compaction stays gated on the selected prepared harness.
  const {
    runtimeAuthProfileStore,
    runtimeAuthPreparation,
    selectedPreparedHarness,
    providerUsesProfileScopedModelMetadata,
  } = await prepareCompactionHarnessAuth({
    ...params,
    provider,
    metadataProvider: runtimeProvider,
    modelId,
    model,
    reusableRuntimeAuthPlan,
    agentDir,
    workspaceDir: resolvedWorkspace,
    authProfileId,
    runtimePolicyAgentId,
    runtimePolicySessionKey,
    agentHarnessId: boundHarnessRuntime,
    agentHarnessRuntimeOverride: selectedHarnessRuntimeOverride,
  });
  const preparedHarnessRuntime = selectedPreparedHarness.id;
  const resolvePreparedModel = ({
    config,
    authProfileId: profileId,
    authProfileMode: resolvedAuthProfileMode,
  }: Parameters<
    Parameters<typeof materializePreparedRuntimeModel<ProviderRuntimeModel>>[0]["resolveModel"]
  >[0]) =>
    resolveModelAsync(runtimeProvider, modelId, agentDir, config, {
      ...modelResolutionOptions,
      skipAgentDiscovery: true,
      allowBundledStaticCatalogFallback: true,
      preferBundledStaticCatalogTransport: true,
      authProfileId: profileId,
      authProfileMode: resolvedAuthProfileMode,
    });
  const materializeAuthAttemptModel = async (materializeParams: {
    plan: AgentRuntimeAuthPlan;
    model: ProviderRuntimeModel;
    forceResolve?: boolean;
  }): Promise<ProviderRuntimeModel> =>
    (await materializePreparedRuntimeModel<ProviderRuntimeModel>({
      plan: materializeParams.plan,
      provider,
      modelId,
      config: params.config,
      model: materializeParams.model,
      forceResolve: materializeParams.forceResolve,
      resolveModel: resolvePreparedModel,
    })) ?? materializeParams.model;
  const resolveRuntimeAuthAttempt = () =>
    resolvePreparedRuntimeAuthAttempts({
      attempts: runtimeAuthPreparation.attempts,
      store: runtimeAuthProfileStore,
      modelId,
      model,
      materializeModel: materializeAuthAttemptModel,
      forceCredentialScopedDirectModelResolve: providerUsesProfileScopedModelMetadata,
      resolveAuth: async ({ attempt: preparedAttempt, model: attemptModel }) =>
        await resolvePreparedRuntimeModelAuth({
          plan: preparedAttempt.plan,
          model: attemptModel,
          cfg: params.config,
          store: runtimeAuthProfileStore,
          agentDir,
          workspaceDir: resolvedWorkspace,
          ...(preparedAttempt.allowAuthProfileFallback !== undefined
            ? { allowAuthProfileFallback: preparedAttempt.allowAuthProfileFallback }
            : {}),
          secretSentinels: true,
        }),
      errorMessage: `Prepared compaction auth attempts could not be resolved for ${provider}/${modelId}.`,
    });
  let resolvedAuthAttempt: Awaited<ReturnType<typeof resolveRuntimeAuthAttempt>>;
  try {
    resolvedAuthAttempt = await resolveRuntimeAuthAttempt();
  } catch (err) {
    return { ok: false as const, result: fail(formatErrorMessage(err), err) };
  }
  let runtimeModel = resolvedAuthAttempt.model;
  const apiKeyInfo = resolvedAuthAttempt.auth;
  const resolvedRuntimeAuthPlan = resolvedAuthAttempt.plan;
  let hasRuntimeAuthExchange = false;
  try {
    if (!apiKeyInfo.apiKey) {
      if (apiKeyInfo.mode !== "aws-sdk") {
        throw new MissingProviderAuthError(runtimeModel.provider, apiKeyInfo);
      }
    } else {
      const preparedAuth = protectPreparedProviderRuntimeAuth({
        provider: runtimeModel.provider,
        preparedAuth: await prepareProviderRuntimeAuth({
          provider: runtimeModel.provider,
          config: params.config,
          workspaceDir: resolvedWorkspace,
          env: process.env,
          context: {
            config: params.config,
            agentDir,
            workspaceDir: resolvedWorkspace,
            env: process.env,
            provider: runtimeModel.provider,
            modelId,
            model: runtimeModel,
            apiKey: unwrapSecretSentinelsForProviderEgress(
              apiKeyInfo.apiKey,
              "provider runtime auth exchange",
            ),
            authMode: apiKeyInfo.mode,
            profileId: apiKeyInfo.profileId,
          },
        }),
      });
      runtimeModel = applyPreparedRuntimeAuthToModel(runtimeModel, preparedAuth);
      const runtimeApiKey = preparedAuth?.apiKey ?? apiKeyInfo.apiKey;
      hasRuntimeAuthExchange = Boolean(preparedAuth?.apiKey);
      if (!runtimeApiKey) {
        throw new Error(`Provider "${runtimeModel.provider}" runtime auth returned no apiKey.`);
      }
      authStorage.setRuntimeApiKey(runtimeModel.provider, runtimeApiKey);
    }
  } catch (err) {
    const reason = formatErrorMessage(err);
    return { ok: false as const, result: fail(reason, err) };
  }
  const runtimeCompat =
    runtimeModel.compat && typeof runtimeModel.compat === "object"
      ? (runtimeModel.compat as Record<string, unknown>)
      : undefined;
  const thinkingFormat =
    typeof runtimeCompat?.thinkingFormat === "string" ? runtimeCompat.thinkingFormat : undefined;
  const supportedReasoningEfforts =
    runtimeCompat?.supportedReasoningEfforts === null ||
    (Array.isArray(runtimeCompat?.supportedReasoningEfforts) &&
      runtimeCompat.supportedReasoningEfforts.every((effort) => typeof effort === "string"))
      ? (runtimeCompat.supportedReasoningEfforts as readonly string[] | null)
      : undefined;
  const thinkingCompat =
    thinkingFormat !== undefined || supportedReasoningEfforts !== undefined
      ? { thinkingFormat, supportedReasoningEfforts }
      : undefined;
  const thinkingCatalogEntry = {
    provider: runtimeModel.provider,
    id: runtimeModel.id,
    api: runtimeModel.api,
    reasoning: runtimeModel.reasoning,
    params: runtimeModel.params,
    ...(thinkingCompat ? { compat: thinkingCompat } : {}),
  } satisfies ThinkingCatalogEntry;
  const thinkLevel = resolveEmbeddedCompactionThinkingLevel({
    config: params.config,
    provider: runtimeModel.provider,
    modelId: runtimeModel.id,
    inheritedLevel: params.thinkLevel,
    catalog: [thinkingCatalogEntry],
    agentId: runtimePolicyAgentId,
    sessionKey: runtimePolicySessionKey,
    agentRuntime: preparedHarnessRuntime,
  });

  await fs.mkdir(resolvedWorkspace, { recursive: true });
  const sandboxSessionKey =
    params.sandboxSessionKey?.trim() || params.sessionKey?.trim() || params.sessionId;
  const sandbox = await resolveSandboxContext({
    config: params.config,
    execOverrides: params.execOverrides,
    sessionKey: sandboxSessionKey,
    workspaceDir: resolvedWorkspace,
  });
  const effectiveWorkspace = sandbox?.enabled
    ? sandbox.workspaceAccess === "rw"
      ? resolvedWorkspace
      : sandbox.workspaceDir
    : resolvedWorkspace;
  const requestedCwd = params.cwd ? resolveUserPath(params.cwd) : undefined;
  if (sandbox?.enabled && requestedCwd && requestedCwd !== resolvedWorkspace) {
    throw new Error(
      "cwd override is not supported for sandboxed embedded compaction runs; omit cwd or use the agent workspace as cwd",
    );
  }
  const effectiveCwd = sandbox?.enabled ? effectiveWorkspace : (requestedCwd ?? effectiveWorkspace);
  await fs.mkdir(effectiveWorkspace, { recursive: true });
  const isSqliteSessionTranscript = true;
  const { sessionAgentId: effectiveSkillAgentId } = earlyAgentIds;

  return {
    ok: true as const,
    value: {
      params,
      startedAt,
      diagId,
      trigger,
      attempt,
      maxAttempts,
      runId,
      compactionModelCallTrace,
      diagnosticCompactionRunId,
      nextDiagnosticModelCallId: () =>
        `${diagnosticCompactionRunId}:model:${(diagnosticModelCallSeq += 1)}`,
      earlyAgentIds,
      agentDir,
      provider,
      contextConfigProvider,
      modelId,
      preparedHarnessRuntime,
      thinkLevel,
      attemptedThinking,
      fail,
      authStorage,
      modelRegistry,
      runtimeModel,
      apiKeyInfo,
      resolvedRuntimeAuthPlan,
      hasRuntimeAuthExchange,
      resolvedWorkspace,
      sandboxSessionKey,
      sandbox,
      effectiveWorkspace,
      effectiveCwd,
      isSqliteSessionTranscript,
      effectiveSkillAgentId,
    },
  };
}

export type DirectCompactionPreparation = Extract<
  Awaited<ReturnType<typeof prepareDirectCompactionAttempt>>,
  { ok: true }
>["value"];
