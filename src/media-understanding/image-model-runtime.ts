// Resolves image-capable model metadata and credential-bound runtime auth.
import { resolveModelAsync } from "../agents/embedded-agent-runner/model.js";
import { isMinimaxVlmModel } from "../agents/minimax-vlm.js";
import {
  applySecretRefHeaderSentinels,
  getApiKeyForModel,
  requireApiKey,
} from "../agents/model-auth.js";
import { normalizeModelRef } from "../agents/model-selection.js";
import { ensureOpenClawModelsJson } from "../agents/models-config.js";
import { resolveProviderModelMaterializationAuthMode } from "../agents/provider-model-route-auth.js";
import {
  protectPreparedProviderRuntimeAuth,
  unwrapSecretSentinelsForProviderEgress,
} from "../agents/provider-secret-egress.js";
import { providerUsesCredentialScopedModelMetadata } from "../agents/runtime-plan/credential-scoped-model.js";
import type { Model } from "../llm/types.js";
import { resolveCopilotApiToken } from "../plugin-sdk/provider-auth.js";
import type { ImageDescriptionRequest } from "./types.js";

type ImageRuntimeParams = {
  cfg: ImageDescriptionRequest["cfg"];
  agentDir: string;
  provider: string;
  model: string;
  profile?: string;
  preferredProfile?: string;
  authStore?: ImageDescriptionRequest["authStore"];
  workspaceDir?: string;
};

function formatModelInputCapabilities(input: Model["input"] | undefined): string {
  return input && input.length > 0 ? input.join(", ") : "none";
}

function requireImageCapableModel(params: {
  model: Model | undefined;
  resolvedProvider: string;
  resolvedModel: string;
  requestedProvider: string;
  requestedModel: string;
}): Model {
  if (!params.model) {
    throw new Error(`Unknown model: ${params.resolvedProvider}/${params.resolvedModel}`);
  }
  if (params.model.input?.includes("image")) {
    return params.model;
  }
  // Keep MiniMax's unknown-model signal so its dedicated VLM fallback remains reachable.
  if (isMinimaxVlmModel(params.resolvedProvider, params.resolvedModel)) {
    throw new Error(`Unknown model: ${params.resolvedProvider}/${params.resolvedModel}`);
  }
  throw new Error(
    `Model does not support images: ${params.requestedProvider}/${params.requestedModel} ` +
      `(resolved ${params.model.provider}/${params.model.id} input: ${formatModelInputCapabilities(params.model.input)})`,
  );
}

async function prepareResolvedImageRuntime(
  params: ImageRuntimeParams,
  resolvedModel: Model,
  authStorage: Awaited<ReturnType<typeof resolveModelAsync>>["authStorage"],
  modelRegistry: Awaited<ReturnType<typeof resolveModelAsync>>["modelRegistry"],
): Promise<{ apiKey: string; model: Model }> {
  let model = resolvedModel;
  const apiKeyInfo = await getApiKeyForModel({
    model,
    cfg: params.cfg,
    agentDir: params.agentDir,
    ...(params.workspaceDir ? { workspaceDir: params.workspaceDir } : {}),
    profileId: params.profile,
    preferredProfile: params.preferredProfile,
    store: params.authStore,
    secretSentinels: true,
  });
  if (
    providerUsesCredentialScopedModelMetadata({
      provider: model.provider,
      modelId: model.id,
      config: params.cfg,
      agentDir: params.agentDir,
      workspaceDir: params.workspaceDir,
    })
  ) {
    const authProfileMode = resolveProviderModelMaterializationAuthMode(apiKeyInfo.mode);
    const authoritative = await resolveModelAsync(
      model.provider,
      model.id,
      params.agentDir,
      params.cfg,
      {
        authStorage,
        modelRegistry,
        skipAgentDiscovery: true,
        allowBundledStaticCatalogFallback: true,
        ...(params.workspaceDir ? { workspaceDir: params.workspaceDir } : {}),
        ...(apiKeyInfo.profileId
          ? { authProfileId: apiKeyInfo.profileId }
          : authProfileMode
            ? { authProfileMode }
            : {}),
      },
    );
    model = requireImageCapableModel({
      model: authoritative.model,
      resolvedProvider: model.provider,
      resolvedModel: model.id,
      requestedProvider: params.provider,
      requestedModel: params.model,
    });
  }
  // Bedrock's runtime client owns AWS credential-chain resolution. Keep the
  // empty sentinel out of auth storage and pass it through to the stream.
  if (
    !apiKeyInfo.apiKey?.trim() &&
    apiKeyInfo.mode === "aws-sdk" &&
    model.api === "bedrock-converse-stream"
  ) {
    return { apiKey: "", model: applySecretRefHeaderSentinels(model, params.cfg) };
  }
  let apiKey = requireApiKey(apiKeyInfo, model.provider);
  // Image tool bypasses prepareRuntimeAuth — exchange OAuth token for
  // a short-lived Copilot API token so the integrator scope (vscode-chat)
  // matches what runtime chat requests send.
  if (model.provider === "github-copilot") {
    const copilotToken = await resolveCopilotApiToken({
      githubToken: unwrapSecretSentinelsForProviderEgress(
        apiKey,
        "GitHub Copilot image-auth exchange",
      ),
      config: params.cfg,
    });
    const protectedAuth = protectPreparedProviderRuntimeAuth({
      provider: model.provider,
      preparedAuth: { apiKey: copilotToken.token, baseUrl: copilotToken.baseUrl },
    });
    apiKey = protectedAuth?.apiKey ?? copilotToken.token;
    const runtimeBaseUrl = protectedAuth?.baseUrl?.trim();
    if (runtimeBaseUrl) {
      model = { ...model, baseUrl: runtimeBaseUrl };
    }
  }
  authStorage.setRuntimeApiKey(model.provider, apiKey);
  return { apiKey, model: applySecretRefHeaderSentinels(model, params.cfg) };
}

export async function resolveImageRuntime(
  params: ImageRuntimeParams,
): Promise<{ apiKey: string; model: Model }> {
  // Fast static resolution avoids provider runtime hooks during tool discovery;
  // execution falls back to full model discovery when static metadata lacks images.
  const resolvedRef = normalizeModelRef(params.provider, params.model);
  const authProfileOptions = {
    ...(params.profile ? { authProfileId: params.profile } : {}),
    ...(params.preferredProfile ? { preferredProfile: params.preferredProfile } : {}),
  };
  const fastResolved = await resolveModelAsync(
    resolvedRef.provider,
    resolvedRef.model,
    params.agentDir,
    params.cfg,
    {
      allowBundledStaticCatalogFallback: true,
      skipAgentDiscovery: true,
      skipProviderRuntimeHooks: true,
      ...(params.workspaceDir ? { workspaceDir: params.workspaceDir } : {}),
      ...authProfileOptions,
    },
  );
  if (fastResolved.model?.input?.includes("image")) {
    const normalizedResolved = await resolveModelAsync(
      resolvedRef.provider,
      resolvedRef.model,
      params.agentDir,
      params.cfg,
      {
        allowBundledStaticCatalogFallback: true,
        skipAgentDiscovery: true,
        ...(params.workspaceDir ? { workspaceDir: params.workspaceDir } : {}),
        ...authProfileOptions,
      },
    );
    if (normalizedResolved.model?.input?.includes("image")) {
      return await prepareResolvedImageRuntime(
        params,
        normalizedResolved.model,
        normalizedResolved.authStorage,
        normalizedResolved.modelRegistry,
      );
    }
  }

  const modelsOptions = params.workspaceDir ? { workspaceDir: params.workspaceDir } : undefined;
  await ensureOpenClawModelsJson(params.cfg, params.agentDir, modelsOptions);
  const resolved = await resolveModelAsync(
    resolvedRef.provider,
    resolvedRef.model,
    params.agentDir,
    params.cfg,
    {
      allowBundledStaticCatalogFallback: true,
      ...(params.workspaceDir ? { workspaceDir: params.workspaceDir } : {}),
      ...authProfileOptions,
    },
  );
  const model = requireImageCapableModel({
    model: resolved.model,
    resolvedProvider: resolvedRef.provider,
    resolvedModel: resolvedRef.model,
    requestedProvider: params.provider,
    requestedModel: params.model,
  });
  return await prepareResolvedImageRuntime(
    params,
    model,
    resolved.authStorage,
    resolved.modelRegistry,
  );
}
