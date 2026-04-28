import { complete, type Api, type Model } from "@mariozechner/pi-ai";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { formatErrorMessage } from "../infra/errors.js";
import { prepareProviderRuntimeAuth } from "../plugins/provider-runtime.runtime.js";
import { resolveAgentDir, resolveAgentEffectiveModelPrimary } from "./agent-scope.js";
import { DEFAULT_PROVIDER } from "./defaults.js";
import {
  applyLocalNoAuthHeaderOverride,
  getApiKeyForModel,
  type ResolvedProviderAuth,
} from "./model-auth.js";
import { splitTrailingAuthProfile } from "./model-ref-profile.js";
import {
  buildModelAliasIndex,
  resolveDefaultModelForAgent,
  resolveModelRefFromString,
} from "./model-selection.js";
import { resolveModel, resolveModelAsync } from "./pi-embedded-runner/model.js";
import { prepareModelForSimpleCompletion } from "./simple-completion-transport.js";

type SimpleCompletionAuthStorage = {
  setRuntimeApiKey: (provider: string, apiKey: string) => void;
};

type CompletionRuntimeCredential = {
  apiKey: string;
  baseUrl?: string;
};

type AllowedMissingApiKeyMode = ResolvedProviderAuth["mode"];

export type SimpleCompletionModelOptions = {
  maxTokens?: number;
  signal?: AbortSignal;
};

export type PreparedSimpleCompletionModel =
  | {
      model: Model<Api>;
      auth: ResolvedProviderAuth;
    }
  | {
      error: string;
      auth?: ResolvedProviderAuth;
    };

export type AgentSimpleCompletionSelection = {
  provider: string;
  modelId: string;
  profileId?: string;
  agentDir: string;
};

export type PreparedSimpleCompletionModelForAgent =
  | {
      selection: AgentSimpleCompletionSelection;
      model: Model<Api>;
      auth: ResolvedProviderAuth;
    }
  | {
      error: string;
      selection?: AgentSimpleCompletionSelection;
      auth?: ResolvedProviderAuth;
    };

export function resolveSimpleCompletionSelectionForAgent(params: {
  cfg: OpenClawConfig;
  agentId: string;
  modelRef?: string;
}): AgentSimpleCompletionSelection | null {
  const fallbackRef = resolveDefaultModelForAgent({
    cfg: params.cfg,
    agentId: params.agentId,
  });
  const modelRef =
    params.modelRef?.trim() || resolveAgentEffectiveModelPrimary(params.cfg, params.agentId);
  const split = modelRef ? splitTrailingAuthProfile(modelRef) : null;
  const aliasIndex = buildModelAliasIndex({
    cfg: params.cfg,
    defaultProvider: fallbackRef.provider || DEFAULT_PROVIDER,
  });
  const resolved = split
    ? resolveModelRefFromString({
        raw: split.model,
        defaultProvider: fallbackRef.provider || DEFAULT_PROVIDER,
        aliasIndex,
      })
    : null;
  const provider = resolved?.ref.provider ?? fallbackRef.provider;
  const modelId = resolved?.ref.model ?? fallbackRef.model;
  if (!provider || !modelId) {
    return null;
  }
  return {
    provider,
    modelId,
    profileId: split?.profile || undefined,
    agentDir: resolveAgentDir(params.cfg, params.agentId),
  };
}

async function setRuntimeApiKeyForCompletion(params: {
  authStorage: SimpleCompletionAuthStorage;
  model: Model<Api>;
  apiKey: string;
  authMode: ResolvedProviderAuth["mode"];
  cfg?: OpenClawConfig;
  workspaceDir?: string;
  profileId?: string;
}): Promise<CompletionRuntimeCredential> {
  if (params.model.provider === "github-copilot") {
    const { resolveCopilotApiToken } = await import("./github-copilot-token.js");
    const copilotToken = await resolveCopilotApiToken({
      githubToken: params.apiKey,
    });
    params.authStorage.setRuntimeApiKey(params.model.provider, copilotToken.token);
    return {
      apiKey: copilotToken.token,
      baseUrl: copilotToken.baseUrl,
    };
  }
  const preparedAuth = await prepareProviderRuntimeAuth({
    provider: params.model.provider,
    config: params.cfg,
    workspaceDir: params.workspaceDir,
    env: process.env,
    context: {
      config: params.cfg,
      workspaceDir: params.workspaceDir,
      env: process.env,
      provider: params.model.provider,
      modelId: params.model.id,
      model: params.model,
      apiKey: params.apiKey,
      authMode: params.authMode,
      profileId: params.profileId,
    },
  });
  const runtimeApiKey = preparedAuth?.apiKey?.trim() || params.apiKey;
  params.authStorage.setRuntimeApiKey(params.model.provider, runtimeApiKey);
  return {
    apiKey: runtimeApiKey,
    baseUrl: preparedAuth?.baseUrl,
  };
}

function hasMissingApiKeyAllowance(params: {
  mode: ResolvedProviderAuth["mode"];
  allowMissingApiKeyModes?: ReadonlyArray<AllowedMissingApiKeyMode>;
}): boolean {
  return Boolean(params.allowMissingApiKeyModes?.includes(params.mode));
}

export async function prepareSimpleCompletionModel(params: {
  cfg: OpenClawConfig | undefined;
  provider: string;
  modelId: string;
  agentDir?: string;
  profileId?: string;
  preferredProfile?: string;
  allowMissingApiKeyModes?: ReadonlyArray<AllowedMissingApiKeyMode>;
  skipPiDiscovery?: boolean;
}): Promise<PreparedSimpleCompletionModel> {
  const resolved = params.skipPiDiscovery
    ? await resolveModelAsync(params.provider, params.modelId, params.agentDir, params.cfg, {
        skipPiDiscovery: true,
      })
    : resolveModel(params.provider, params.modelId, params.agentDir, params.cfg);
  if (!resolved.model) {
    return {
      error: resolved.error ?? `Unknown model: ${params.provider}/${params.modelId}`,
    };
  }

  let auth: ResolvedProviderAuth;
  try {
    auth = await getApiKeyForModel({
      model: resolved.model,
      cfg: params.cfg,
      agentDir: params.agentDir,
      profileId: params.profileId,
      preferredProfile: params.preferredProfile,
    });
  } catch (err) {
    return {
      error: `Auth lookup failed for provider "${resolved.model.provider}": ${formatErrorMessage(err)}`,
    };
  }
  const rawApiKey = auth.apiKey?.trim();
  if (
    !rawApiKey &&
    !hasMissingApiKeyAllowance({
      mode: auth.mode,
      allowMissingApiKeyModes: params.allowMissingApiKeyModes,
    })
  ) {
    return {
      error: `No API key resolved for provider "${resolved.model.provider}" (auth mode: ${auth.mode}).`,
      auth,
    };
  }

  let resolvedApiKey = rawApiKey;
  let resolvedModel = resolved.model;
  if (rawApiKey) {
    const runtimeCredential = await setRuntimeApiKeyForCompletion({
      authStorage: resolved.authStorage,
      model: resolved.model,
      apiKey: rawApiKey,
      authMode: auth.mode,
      cfg: params.cfg,
      workspaceDir: params.agentDir,
      profileId: auth.profileId,
    });
    resolvedApiKey = runtimeCredential.apiKey;
    const runtimeBaseUrl = runtimeCredential.baseUrl?.trim();
    if (runtimeBaseUrl) {
      resolvedModel = {
        ...resolvedModel,
        baseUrl: runtimeBaseUrl,
      };
    }
  }

  const resolvedAuth: ResolvedProviderAuth = {
    ...auth,
    apiKey: resolvedApiKey,
  };

  return {
    model: applyLocalNoAuthHeaderOverride(resolvedModel, resolvedAuth),
    auth: resolvedAuth,
  };
}

export async function prepareSimpleCompletionModelForAgent(params: {
  cfg: OpenClawConfig;
  agentId: string;
  modelRef?: string;
  preferredProfile?: string;
  allowMissingApiKeyModes?: ReadonlyArray<AllowedMissingApiKeyMode>;
  skipPiDiscovery?: boolean;
}): Promise<PreparedSimpleCompletionModelForAgent> {
  const selection = resolveSimpleCompletionSelectionForAgent({
    cfg: params.cfg,
    agentId: params.agentId,
    modelRef: params.modelRef,
  });
  if (!selection) {
    return {
      error: `No model configured for agent ${params.agentId}.`,
    };
  }
  const prepared = await prepareSimpleCompletionModel({
    cfg: params.cfg,
    provider: selection.provider,
    modelId: selection.modelId,
    agentDir: selection.agentDir,
    profileId: selection.profileId,
    preferredProfile: params.preferredProfile,
    allowMissingApiKeyModes: params.allowMissingApiKeyModes,
    skipPiDiscovery: params.skipPiDiscovery,
  });
  if ("error" in prepared) {
    return {
      ...prepared,
      selection,
    };
  }
  return {
    selection,
    model: prepared.model,
    auth: prepared.auth,
  };
}

export async function completeWithPreparedSimpleCompletionModel(params: {
  model: Model<Api>;
  auth: ResolvedProviderAuth;
  context: Parameters<typeof complete>[1];
  options?: SimpleCompletionModelOptions;
}) {
  const completionModel = prepareModelForSimpleCompletion({ model: params.model });
  return await complete(completionModel, params.context, {
    ...params.options,
    apiKey: params.auth.apiKey,
  });
}
