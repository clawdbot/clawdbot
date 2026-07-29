import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { ThinkLevel } from "../../../auto-reply/thinking.js";
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "../../defaults.js";
import {
  buildModelAliasIndex,
  resolveDefaultModelForAgent,
  resolveModelRefFromString,
} from "../../model-selection.js";
import { resolveThinkingDefault } from "../../model-thinking-default.js";
import { OPENAI_PROVIDER_ID } from "../../openai-routing.js";
import type { AgentRuntimePlan } from "../../runtime-plan/types.js";
import type { RunEmbeddedAgentParams } from "./params.js";

export const CODEX_HARNESS_ID = "codex";
const OPENAI_RESPONSES_API = "openai-responses";
const OPENAI_CODEX_RESPONSES_API = "openai-chatgpt-responses";

function normalizeRuntimeId(value: string | undefined): string {
  return value?.trim().toLowerCase() ?? "";
}

export function resolveAttemptTrajectoryAttribution(params: {
  model: { api?: string; provider?: string };
  modelId: string;
  provider: string;
  runtimePlan: {
    auth?: Pick<AgentRuntimePlan["auth"], "authProfileProviderForAuth">;
    observability?: Pick<AgentRuntimePlan["observability"], "harnessId">;
  };
}): { modelApi?: string; modelId: string; provider: string } {
  const authProfileProvider = normalizeRuntimeId(
    params.runtimePlan.auth?.authProfileProviderForAuth,
  );
  const harnessId = normalizeRuntimeId(params.runtimePlan.observability?.harnessId);
  if (
    harnessId === CODEX_HARNESS_ID &&
    authProfileProvider !== OPENAI_PROVIDER_ID &&
    normalizeRuntimeId(params.model.provider) === OPENAI_PROVIDER_ID &&
    normalizeRuntimeId(params.model.api) === OPENAI_RESPONSES_API
  ) {
    return {
      modelApi: OPENAI_CODEX_RESPONSES_API,
      modelId: params.modelId,
      provider: OPENAI_PROVIDER_ID,
    };
  }
  return {
    ...(params.model.api ? { modelApi: params.model.api } : {}),
    modelId: params.modelId,
    provider: params.provider,
  };
}

export function resolveInitialThinkLevel(params: {
  requested?: ThinkLevel;
  config?: RunEmbeddedAgentParams["config"];
  provider: string;
  modelId: string;
  model: { reasoning?: boolean };
}): ThinkLevel {
  if (params.requested) {
    return params.requested;
  }
  return resolveThinkingDefault({
    cfg: params.config ?? {},
    provider: params.provider,
    model: params.modelId,
    catalog: [
      {
        provider: params.provider,
        id: params.modelId,
        name: params.modelId,
        reasoning: params.model.reasoning,
      },
    ],
  });
}

/** Marks only request parameters that OpenClaw applies to provider egress. */
export function resolveRequestStreamTransportOverrides(
  streamParams: RunEmbeddedAgentParams["streamParams"],
): "present" | undefined {
  return streamParams && Object.keys(streamParams).length > 0 ? "present" : undefined;
}

export function resolveInitialEmbeddedRunModel(params: {
  config: RunEmbeddedAgentParams["config"];
  agentId?: string;
  provider?: string;
  model?: string;
}): { provider: string; modelId: string } {
  const cfg = params.config ?? {};
  const configuredDefault = resolveDefaultModelForAgent({
    cfg,
    agentId: params.agentId,
  });
  const explicitProvider = normalizeOptionalString(params.provider);
  const explicitModel = normalizeOptionalString(params.model);
  const defaultProvider = configuredDefault.provider || DEFAULT_PROVIDER;

  if (explicitProvider && explicitModel) {
    return { provider: explicitProvider, modelId: explicitModel };
  }

  if (explicitModel) {
    const provider = explicitProvider ?? defaultProvider;
    const aliasIndex = buildModelAliasIndex({
      cfg,
      defaultProvider: provider,
    });
    const resolved = resolveModelRefFromString({
      cfg,
      raw: explicitModel,
      defaultProvider: provider,
      aliasIndex,
    });
    return {
      provider: explicitProvider ?? resolved?.ref.provider ?? provider,
      modelId: resolved?.ref.model ?? explicitModel,
    };
  }

  return {
    provider: explicitProvider ?? defaultProvider,
    modelId: configuredDefault.model || DEFAULT_MODEL,
  };
}
