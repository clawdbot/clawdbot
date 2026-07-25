// Resolves image-capable model metadata and credential-bound runtime auth.
import { resolveAgentWorkspaceDir, resolveDefaultAgentDir } from "../agents/agent-scope.js";
import { resolveModelAsync } from "../agents/embedded-agent-runner/model.js";
import { isMinimaxVlmModel } from "../agents/minimax-vlm.js";
import {
  applySecretRefHeaderSentinels,
  getApiKeyForModel,
  requireApiKey,
} from "../agents/model-auth.js";
import { normalizeModelRef } from "../agents/model-selection.js";
import { acquireAgentRunPreparedModelRuntime } from "../agents/prepared-model-runtime.js";
import { resolveProviderModelMaterializationAuthMode } from "../agents/provider-model-route-auth.js";
import { protectPreparedProviderRuntimeAuth } from "../agents/provider-secret-egress.js";
import { providerUsesCredentialScopedModelMetadata } from "../agents/runtime-plan/credential-scoped-model.js";
import { getModelRegistryRuntime } from "../agents/sessions/model-registry-runtime.js";
import { bindModelLlmRuntime } from "../llm/model-runtime-binding.js";
import type { Model } from "../llm/types.js";
import { prepareProviderRuntimeAuth } from "../plugins/provider-runtime.runtime.js";
import type { ImageDescriptionRequest } from "./types.js";

type ImageRuntimeParams = {
  cfg: ImageDescriptionRequest["cfg"];
  agentDir: string;
  provider: string;
  model: string;
  profile?: string;
  preferredProfile?: string;
  authStore?: ImageDescriptionRequest["authStore"];
  agentId?: string;
  workspaceDir?: string;
  preparedModelRuntime?: ImageDescriptionRequest["preparedModelRuntime"];
};

type ResolvedImageRuntimeContext = {
  cfg: ImageRuntimeParams["cfg"];
  agentDir: string;
  workspaceDir?: string;
};

type PreparedImageRuntime = {
  runtimeValue: string;
  model: Model;
};

type ResolvedImageRuntime = PreparedImageRuntime & { release: () => void };

const resolvedImageRuntimeContexts = new WeakMap<Model, ResolvedImageRuntimeContext>();

export function getResolvedImageRuntimeContext(
  model: Model,
): ResolvedImageRuntimeContext | undefined {
  return resolvedImageRuntimeContexts.get(model);
}

function bindResolvedImageRuntime(
  params: ImageRuntimeParams,
  apiKey: string,
  model: Model,
): PreparedImageRuntime {
  resolvedImageRuntimeContexts.set(model, {
    cfg: params.cfg,
    agentDir: params.agentDir,
    ...(params.workspaceDir ? { workspaceDir: params.workspaceDir } : {}),
  });
  return { runtimeValue: apiKey, model };
}

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
): Promise<PreparedImageRuntime> {
  let model = resolvedModel;
  const modelRuntime = getModelRegistryRuntime(modelRegistry);
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
    return bindResolvedImageRuntime(
      params,
      "",
      bindModelLlmRuntime(
        applySecretRefHeaderSentinels(model, params.cfg),
        modelRuntime.llmRuntime,
      ),
    );
  }
  let apiKey = requireApiKey(apiKeyInfo, model.provider);
  const preparedAuth = protectPreparedProviderRuntimeAuth({
    provider: model.provider,
    preparedAuth: await prepareProviderRuntimeAuth({
      provider: model.provider,
      config: params.cfg,
      workspaceDir: params.workspaceDir,
      env: process.env,
      context: {
        config: params.cfg,
        workspaceDir: params.workspaceDir,
        env: process.env,
        provider: model.provider,
        modelId: model.id,
        model,
        apiKey,
        authMode: apiKeyInfo.mode,
        profileId: apiKeyInfo.profileId,
      },
    }),
  });
  apiKey = preparedAuth?.apiKey?.trim() || apiKey;
  const runtimeBaseUrl = preparedAuth?.baseUrl?.trim();
  if (runtimeBaseUrl) {
    model = { ...model, baseUrl: runtimeBaseUrl };
  }
  authStorage.setRuntimeApiKey(model.provider, apiKey);
  return bindResolvedImageRuntime(
    params,
    apiKey,
    bindModelLlmRuntime(applySecretRefHeaderSentinels(model, params.cfg), modelRuntime.llmRuntime),
  );
}

export async function resolveImageRuntime(
  params: ImageRuntimeParams,
): Promise<ResolvedImageRuntime> {
  // Fast static resolution avoids provider runtime hooks during tool discovery. The bounded lease
  // admits dynamic workspaces before attachment preprocessing reaches the embedded run boundary.
  const resolvedRef = normalizeModelRef(params.provider, params.model);
  const workspaceDir =
    params.workspaceDir ??
    (params.agentId ? resolveAgentWorkspaceDir(params.cfg ?? {}, params.agentId) : undefined);
  const runtimeParams = workspaceDir ? { ...params, workspaceDir } : params;
  const authProfileOptions = {
    ...(params.profile ? { authProfileId: params.profile } : {}),
    ...(params.preferredProfile ? { preferredProfile: params.preferredProfile } : {}),
  };
  const preparedRuntimeLease = params.preparedModelRuntime
    ? { snapshot: params.preparedModelRuntime, release: () => {} }
    : await acquireAgentRunPreparedModelRuntime({
        agentDir: params.agentDir,
        ...(params.agentId ? { agentId: params.agentId } : {}),
        config: params.cfg ?? {},
        inheritedAuthDir: resolveDefaultAgentDir(params.cfg ?? {}),
        ...(runtimeParams.workspaceDir ? { workspaceDir: runtimeParams.workspaceDir } : {}),
      });
  let leaseRetained = false;
  const retainLease = (resolved: PreparedImageRuntime): ResolvedImageRuntime => {
    leaseRetained = true;
    return { ...resolved, release: preparedRuntimeLease.release };
  };
  try {
    const preparedRuntime = preparedRuntimeLease.snapshot;
    const preparedWorkspaceDir = preparedRuntime.workspaceDir ?? runtimeParams.workspaceDir;
    const preparedParams: ImageRuntimeParams = {
      ...runtimeParams,
      agentDir: preparedRuntime.agentDir,
      cfg: preparedRuntime.config,
      ...(preparedWorkspaceDir ? { workspaceDir: preparedWorkspaceDir } : {}),
    };
    // Media request types carry this agent-owned handle opaquely to avoid importing the agent
    // runtime graph into provider contracts. This is the sole boundary that consumes its stores.
    const preparedStores = preparedRuntime.createStores() as Required<
      Pick<NonNullable<Parameters<typeof resolveModelAsync>[4]>, "authStorage" | "modelRegistry">
    >;
    const fastResolved = await resolveModelAsync(
      resolvedRef.provider,
      resolvedRef.model,
      preparedParams.agentDir,
      preparedParams.cfg,
      {
        allowBundledStaticCatalogFallback: true,
        ...preparedStores,
        skipAgentDiscovery: true,
        skipProviderRuntimeHooks: true,
        ...(preparedParams.workspaceDir ? { workspaceDir: preparedParams.workspaceDir } : {}),
        ...authProfileOptions,
      },
    );
    if (fastResolved.model?.input?.includes("image")) {
      const normalizedResolved = await resolveModelAsync(
        resolvedRef.provider,
        resolvedRef.model,
        preparedParams.agentDir,
        preparedParams.cfg,
        {
          allowBundledStaticCatalogFallback: true,
          ...preparedStores,
          skipAgentDiscovery: true,
          ...(preparedParams.workspaceDir ? { workspaceDir: preparedParams.workspaceDir } : {}),
          ...authProfileOptions,
        },
      );
      if (normalizedResolved.model?.input?.includes("image")) {
        return retainLease(
          await prepareResolvedImageRuntime(
            preparedParams,
            normalizedResolved.model,
            normalizedResolved.authStorage,
            normalizedResolved.modelRegistry,
          ),
        );
      }
    }

    const resolved = await resolveModelAsync(
      resolvedRef.provider,
      resolvedRef.model,
      preparedParams.agentDir,
      preparedParams.cfg,
      {
        allowBundledStaticCatalogFallback: true,
        ...preparedStores,
        skipAgentDiscovery: true,
        ...(preparedParams.workspaceDir ? { workspaceDir: preparedParams.workspaceDir } : {}),
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
    return retainLease(
      await prepareResolvedImageRuntime(
        preparedParams,
        model,
        resolved.authStorage,
        resolved.modelRegistry,
      ),
    );
  } finally {
    if (!leaseRetained) {
      preparedRuntimeLease.release();
    }
  }
}
