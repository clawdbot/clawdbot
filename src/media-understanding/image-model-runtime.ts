// Resolves image-capable model metadata and credential-bound runtime auth.
import { resolveAgentWorkspaceDir } from "../agents/agent-scope.js";
import { resolveModelAsync } from "../agents/embedded-agent-runner/model.js";
import { isMinimaxVlmModel } from "../agents/minimax-vlm.js";
import {
  applySecretRefHeaderSentinels,
  getApiKeyForModelCore,
  requireApiKey,
} from "../agents/model-auth.js";
import { normalizeModelRef } from "../agents/model-selection.js";
import {
  acquireAgentRunPreparedModelRuntime,
  type PreparedModelRuntimeSnapshot,
} from "../agents/prepared-model-runtime.js";
import { resolveProviderModelMaterializationAuthMode } from "../agents/provider-model-route-auth.js";
import { applyPreparedRuntimeAuthToModel } from "../agents/provider-request-config.js";
import { protectPreparedProviderRuntimeAuth } from "../agents/provider-secret-egress.js";
import { providerUsesCredentialScopedModelMetadata } from "../agents/runtime-plan/credential-scoped-model.js";
import { getModelRegistryRuntime } from "../agents/sessions/model-registry-runtime.js";
import { bindModelLlmRuntime } from "../llm/model-runtime-binding.js";
import type { Model } from "../llm/types.js";
import { prepareProviderRuntimeAuth } from "../plugins/provider-runtime.runtime.js";
import { withPluginRuntimeGenerationScope } from "../plugins/runtime/generation-scope.js";
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

type PreparedImageRuntime = {
  runtimeValue: string;
  model: Model;
};

type ResolvedImageRuntime = PreparedImageRuntime & {
  preparedModelRuntime: PreparedModelRuntimeSnapshot;
  workspaceDir?: string;
  release: () => void;
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
): Promise<PreparedImageRuntime> {
  let model = resolvedModel;
  const modelRuntime = getModelRegistryRuntime(modelRegistry);
  const apiKeyInfo = await getApiKeyForModelCore({
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
        preparedModelRuntime: params.preparedModelRuntime as PreparedModelRuntimeSnapshot,
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
    return {
      runtimeValue: "",
      model: bindModelLlmRuntime(
        applySecretRefHeaderSentinels(model, params.cfg),
        modelRuntime.llmRuntime,
      ),
    };
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
  model = applyPreparedRuntimeAuthToModel(model, preparedAuth);
  authStorage.setRuntimeApiKey(model.provider, apiKey);
  return {
    runtimeValue: apiKey,
    model: bindModelLlmRuntime(
      applySecretRefHeaderSentinels(model, params.cfg),
      modelRuntime.llmRuntime,
    ),
  };
}

export async function resolveImageRuntime(
  params: ImageRuntimeParams,
): Promise<ResolvedImageRuntime> {
  const borrowedRuntime = params.preparedModelRuntime as PreparedModelRuntimeSnapshot | undefined;
  const workspaceDir =
    params.workspaceDir ??
    (params.agentId ? resolveAgentWorkspaceDir(params.cfg ?? {}, params.agentId) : undefined);
  const runtimeParams = workspaceDir ? { ...params, workspaceDir } : params;
  const plannedRef = normalizeModelRef(params.provider, params.model, {
    allowPluginNormalization: false,
    config: borrowedRuntime?.config ?? params.cfg,
    workspaceDir: borrowedRuntime?.workspaceDir ?? workspaceDir,
    manifestPlugins: borrowedRuntime?.metadataSnapshot.plugins,
  });
  const authProfileOptions = {
    ...(params.profile ? { authProfileId: params.profile } : {}),
    ...(params.preferredProfile ? { preferredProfile: params.preferredProfile } : {}),
  };
  // Borrow a supplied generation; only direct calls acquire and release a new lease.
  const preparedRuntimeLease = borrowedRuntime
    ? {
        snapshot: borrowedRuntime,
        release: () => {},
      }
    : await acquireAgentRunPreparedModelRuntime(
        {
          agentDir: params.agentDir,
          ...(params.agentId ? { agentId: params.agentId } : {}),
          config: params.cfg ?? {},
          ...(runtimeParams.workspaceDir ? { workspaceDir: runtimeParams.workspaceDir } : {}),
          loadRuntimePlugins: true,
          runtimePluginSelections: [...new Set([plannedRef.model, params.model.trim()])].map(
            (modelId) => ({
              provider: plannedRef.provider,
              modelId,
              agentId: params.agentId || undefined,
            }),
          ),
        },
        // The request already chose a model; full inventory discovery must stay outside setup.
        { catalogMode: "static" },
      );
  const preparedRuntime = preparedRuntimeLease.snapshot;
  const preparedWorkspaceDir = preparedRuntime.workspaceDir ?? runtimeParams.workspaceDir;
  let leaseRetained = false;
  const retainLease = (resolved: PreparedImageRuntime): ResolvedImageRuntime => {
    leaseRetained = true;
    return {
      ...resolved,
      preparedModelRuntime: preparedRuntime,
      workspaceDir: preparedWorkspaceDir,
      release: preparedRuntimeLease.release,
    };
  };
  try {
    // Planning is static; the retained generation owns executable normalization and
    // credential-bound model/auth preparation, even across asynchronous work.
    return await withPluginRuntimeGenerationScope(preparedRuntime, async () => {
      const preparedParams: ImageRuntimeParams = {
        ...runtimeParams,
        agentDir: preparedRuntime.agentDir,
        cfg: preparedRuntime.config,
        preparedModelRuntime: preparedRuntime,
        ...(preparedWorkspaceDir ? { workspaceDir: preparedWorkspaceDir } : {}),
      };
      const resolvedRef = normalizeModelRef(params.provider, params.model, {
        config: preparedRuntime.config,
        workspaceDir: preparedWorkspaceDir,
        pluginMetadataSnapshot: preparedRuntime.metadataSnapshot,
        manifestPlugins: preparedRuntime.metadataSnapshot.plugins,
      });
      // Media request types carry this agent-owned handle opaquely to avoid importing the agent
      // runtime graph into provider contracts. This is the sole boundary that consumes its stores.
      const preparedStores = preparedRuntime.createStores() as Required<
        Pick<NonNullable<Parameters<typeof resolveModelAsync>[4]>, "authStorage" | "modelRegistry">
      >;
      const resolveOptions = {
        allowBundledStaticCatalogFallback: true,
        ...preparedStores,
        preparedModelRuntime: preparedRuntime,
        skipAgentDiscovery: true,
        ...(preparedParams.workspaceDir ? { workspaceDir: preparedParams.workspaceDir } : {}),
        ...authProfileOptions,
      };
      const resolved = await resolveModelAsync(
        resolvedRef.provider,
        resolvedRef.model,
        preparedParams.agentDir,
        preparedParams.cfg,
        resolveOptions,
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
    });
  } finally {
    if (!leaseRetained) {
      preparedRuntimeLease.release();
    }
  }
}
