import type { Model } from "openclaw/plugin-sdk/llm";
/**
 * Routes compaction through selected native agent harnesses when supported.
 */
import { formatErrorMessage } from "../../infra/errors.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { parseAgentSessionKey } from "../../routing/session-key.js";
import { resolveUserPath } from "../../utils.js";
import { isDefaultAgentRuntimeId, normalizeOptionalAgentRuntimeId } from "../agent-runtime-id.js";
import { resolveAgentDir, resolveSessionAgentIds } from "../agent-scope.js";
import type { CompactEmbeddedAgentSessionParams } from "../embedded-agent-runner/compact.types.js";
import { resolveModelAsync } from "../embedded-agent-runner/model.js";
import type { EmbeddedAgentCompactResult } from "../embedded-agent-runner/types.js";
import { applySecretRefHeaderSentinels, getApiKeyForModel } from "../model-auth.js";
import { isCliRuntimeAliasForProvider, isCliRuntimeProvider } from "../model-runtime-aliases.js";
import {
  unwrapModelHeaderSentinelsForProviderEgress,
  unwrapSecretSentinelsForProviderEgress,
} from "../provider-secret-egress.js";
import { resolveAgentHarnessPolicy as resolveConfiguredAgentHarnessPolicy } from "./policy.js";
import { selectAgentHarness } from "./selection.js";
import type {
  AgentHarness,
  AgentHarnessCompactParams,
  AgentHarnessCompactResult,
} from "./types.js";

/**
 * Delegates session compaction to the selected agent harness when that runtime owns compaction.
 *
 * CLI runtimes and OpenClaw-native compaction stay on the embedded runner path; plugin harnesses
 * can opt in through their `compact` hook.
 */
const log = createSubsystemLogger("agents/harness");

type NativeCompactionRequest = "after_context_engine";

type InternalAgentHarnessCompactionOptions = {
  nativeCompactionRequest?: NativeCompactionRequest;
};

type InternalAgentHarnessCompactionCapability = {
  // Context-engine follow-up compaction is core/Codex sequencing, not a plugin SDK
  // contract. Keep it behind this private capability so public compact params stay generic.
  compactAfterContextEngine?(
    params: AgentHarnessCompactParams,
  ): Promise<AgentHarnessCompactResult | undefined>;
};

type InternalAgentHarness = AgentHarness & InternalAgentHarnessCompactionCapability;

function resolveHarnessCompactIdentity(params: CompactEmbeddedAgentSessionParams): {
  agentDir: string;
  agentId: string;
} {
  const agentIds = resolveSessionAgentIds({
    sessionKey: params.sessionKey,
    config: params.config,
    agentId: params.agentId,
  });
  return {
    agentDir: params.agentDir ?? resolveAgentDir(params.config ?? {}, agentIds.sessionAgentId),
    agentId: params.agentId ?? agentIds.sessionAgentId,
  };
}

async function resolveHarnessCompactApiKey(params: {
  agentDir: string;
  compactParams: CompactEmbeddedAgentSessionParams;
}): Promise<{ apiKey?: string; runtimeModel?: Model }> {
  const { agentDir, compactParams } = params;
  const existing = compactParams.resolvedApiKey?.trim();
  if (!compactParams.provider?.trim() || !compactParams.model?.trim()) {
    return existing ? { apiKey: existing } : {};
  }
  const authProfileId = compactParams.authProfileId?.trim() || undefined;
  const workspaceDir = resolveUserPath(compactParams.workspaceDir);
  const { model } = await resolveModelAsync(
    compactParams.provider,
    compactParams.model,
    agentDir,
    compactParams.config,
    {
      authProfileId,
      workspaceDir,
    },
  );
  if (!model) {
    return existing ? { apiKey: existing } : {};
  }
  const runtimeModel = applySecretRefHeaderSentinels(model, compactParams.config);
  if (existing) {
    return { apiKey: existing, runtimeModel };
  }
  try {
    const apiKeyInfo = await getApiKeyForModel({
      model: runtimeModel,
      cfg: compactParams.config,
      profileId: authProfileId,
      agentDir,
      workspaceDir,
      secretSentinels: true,
    });
    return {
      apiKey: apiKeyInfo.apiKey?.trim() || undefined,
      runtimeModel,
    };
  } catch (err) {
    log.debug("agent harness compaction credential lookup failed", {
      error: formatErrorMessage(err),
    });
    return { runtimeModel };
  }
}

/** Runs harness-provided compaction when the selected runtime supports it. */
export async function maybeCompactAgentHarnessSession(
  params: CompactEmbeddedAgentSessionParams,
  options: InternalAgentHarnessCompactionOptions = {},
): Promise<EmbeddedAgentCompactResult | undefined> {
  const selectedRuntime = normalizeOptionalAgentRuntimeId(params.agentHarnessId);
  const pinnedHarnessId =
    selectedRuntime && !isDefaultAgentRuntimeId(selectedRuntime) ? selectedRuntime : undefined;
  if (
    !pinnedHarnessId &&
    params.provider &&
    isCliRuntimeProvider(params.provider, { config: params.config })
  ) {
    return undefined;
  }
  const runtimePolicySessionKey = params.sandboxSessionKey ?? params.sessionKey;
  const runtimePolicyAgentId =
    params.sandboxSessionKey && parseAgentSessionKey(params.sandboxSessionKey)
      ? undefined
      : params.agentId;
  const runtime = resolveConfiguredAgentHarnessPolicy({
    provider: params.provider,
    modelId: params.model,
    config: params.config,
    agentId: runtimePolicyAgentId,
    sessionKey: runtimePolicySessionKey,
  }).runtime;
  if (
    isCliRuntimeAliasForProvider({
      runtime: pinnedHarnessId ?? runtime,
      provider: params.provider,
      cfg: params.config,
    })
  ) {
    return undefined;
  }
  const harness = selectAgentHarness({
    provider: params.provider ?? "",
    modelId: params.model,
    config: params.config,
    agentId: runtimePolicyAgentId,
    sessionKey: runtimePolicySessionKey,
    agentHarnessId: pinnedHarnessId,
  });
  const internalHarness = harness as InternalAgentHarness;
  const shouldCompactAfterContextEngine =
    options.nativeCompactionRequest === "after_context_engine";
  if (shouldCompactAfterContextEngine && !internalHarness.compactAfterContextEngine) {
    return undefined;
  }
  if (!options.nativeCompactionRequest && !harness.compact) {
    if (harness.id !== "openclaw") {
      return {
        ok: false,
        compacted: false,
        reason: `Agent harness "${harness.id}" does not support compaction.`,
        failure: { reason: "unsupported_harness_compaction" },
      };
    }
    return undefined;
  }
  const compactIdentity = resolveHarnessCompactIdentity(params);
  const compactParams = {
    ...params,
    agentDir: compactIdentity.agentDir,
    agentId: compactIdentity.agentId,
  };
  let resolvedApiKey = compactParams.resolvedApiKey?.trim() || undefined;
  let runtimeModel: Model | undefined;
  try {
    const resolved = await resolveHarnessCompactApiKey({
      agentDir: compactIdentity.agentDir,
      compactParams,
    });
    resolvedApiKey = resolved.apiKey;
    runtimeModel = resolved.runtimeModel;
  } catch (err) {
    log.debug("agent harness compaction credential lookup failed", {
      error: formatErrorMessage(err),
    });
  }
  const resolvedCompactParams =
    resolvedApiKey || runtimeModel
      ? {
          ...compactParams,
          ...(resolvedApiKey
            ? {
                resolvedApiKey: unwrapSecretSentinelsForProviderEgress(
                  resolvedApiKey,
                  "plugin harness compaction handoff",
                ),
              }
            : {}),
          ...(runtimeModel
            ? {
                runtimeModel: unwrapModelHeaderSentinelsForProviderEgress(
                  runtimeModel,
                  "plugin harness compaction handoff",
                ),
              }
            : {}),
        }
      : compactParams;
  if (shouldCompactAfterContextEngine) {
    return internalHarness.compactAfterContextEngine?.(resolvedCompactParams);
  }
  return harness.compact?.(resolvedCompactParams);
}
