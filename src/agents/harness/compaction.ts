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
import { getApiKeyForModel } from "../model-auth.js";
import { isCliRuntimeAliasForProvider, isCliRuntimeProvider } from "../model-runtime-aliases.js";
import { resolveAgentHarnessPolicy as resolveConfiguredAgentHarnessPolicy } from "./policy.js";
import { selectAgentHarness } from "./selection.js";
import type { AgentHarness } from "./types.js";

/**
 * Delegates session compaction to the selected agent harness when that runtime owns compaction.
 *
 * CLI runtimes and OpenClaw-native compaction stay on the embedded runner path; plugin harnesses
 * can opt in through their `compact` hook.
 */
const log = createSubsystemLogger("agents/harness");

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
}): Promise<string | undefined> {
  const { agentDir, compactParams } = params;
  const existing = compactParams.resolvedApiKey?.trim();
  if (existing) {
    return existing;
  }
  if (
    !compactParams.authProfileId?.trim() ||
    !compactParams.provider?.trim() ||
    !compactParams.model?.trim()
  ) {
    return undefined;
  }
  const workspaceDir = resolveUserPath(compactParams.workspaceDir);
  const { model } = await resolveModelAsync(
    compactParams.provider,
    compactParams.model,
    agentDir,
    compactParams.config,
    {
      authProfileId: compactParams.authProfileId,
      workspaceDir,
    },
  );
  if (!model) {
    return undefined;
  }
  const apiKeyInfo = await getApiKeyForModel({
    model,
    cfg: compactParams.config,
    profileId: compactParams.authProfileId,
    agentDir,
    workspaceDir,
  });
  return apiKeyInfo.apiKey?.trim() || undefined;
}

/** Runs harness-provided compaction when the selected runtime supports it. */
export async function maybeCompactAgentHarnessSession(
  params: CompactEmbeddedAgentSessionParams,
): Promise<EmbeddedAgentCompactResult | undefined> {
  if (params.provider && isCliRuntimeProvider(params.provider, { config: params.config })) {
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
  if (isCliRuntimeAliasForProvider({ runtime, provider: params.provider, cfg: params.config })) {
    return undefined;
  }
  const selectedRuntime = normalizeOptionalAgentRuntimeId(params.agentHarnessId);
  const agentHarnessRuntimeOverride =
    selectedRuntime && !isDefaultAgentRuntimeId(selectedRuntime) ? selectedRuntime : undefined;
  let harness: AgentHarness;
  try {
    harness = selectAgentHarness({
      provider: params.provider ?? "",
      modelId: params.model,
      config: params.config,
      agentId: runtimePolicyAgentId,
      sessionKey: runtimePolicySessionKey,
      agentHarnessRuntimeOverride,
    });
  } catch (err) {
    if (agentHarnessRuntimeOverride) {
      const message = formatErrorMessage(err);
      if (message.includes("does not support")) {
        // Explicit runtime overrides can name a harness that cannot serve this model. Falling back
        // to native compaction preserves existing OpenClaw behavior instead of failing rotation.
        return undefined;
      }
    }
    throw err;
  }
  if (!harness.compact) {
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
  let resolvedApiKey: string | undefined;
  try {
    resolvedApiKey = await resolveHarnessCompactApiKey({
      agentDir: compactIdentity.agentDir,
      compactParams,
    });
  } catch (err) {
    log.debug("agent harness compaction credential lookup failed", {
      error: formatErrorMessage(err),
    });
  }
  return harness.compact(resolvedApiKey ? { ...compactParams, resolvedApiKey } : compactParams);
}
