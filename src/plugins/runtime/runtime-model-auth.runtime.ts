// Runtime model auth helpers expose provider auth resolution to plugin runtimes.
import { getApiKeyForModelCore, resolveApiKeyForProviderCore } from "../../agents/model-auth.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { Model } from "../../llm/types.js";
import { prepareProviderRuntimeAuth } from "../provider-runtime.runtime.js";
import type { ResolvedProviderRuntimeAuth } from "./model-auth-types.js";

export async function getApiKeyForModel(
  params: Parameters<typeof getApiKeyForModelCore>[0],
): Promise<Awaited<ReturnType<typeof getApiKeyForModelCore>>> {
  return getApiKeyForModelCore(params);
}

export async function resolveProviderRuntimeApiKey(
  params: Parameters<typeof resolveApiKeyForProviderCore>[0],
): Promise<Awaited<ReturnType<typeof resolveApiKeyForProviderCore>>> {
  return resolveApiKeyForProviderCore(params);
}

/**
 * Resolve request-ready auth for a runtime model, applying any provider-owned
 * `prepareRuntimeAuth` exchange on top of the standard credential lookup.
 */
export async function getRuntimeAuthForModelCore(params: {
  model: Model;
  cfg?: OpenClawConfig;
  workspaceDir?: string;
}): Promise<ResolvedProviderRuntimeAuth> {
  const resolvedAuth = await getApiKeyForModelCore({
    model: params.model,
    cfg: params.cfg,
    workspaceDir: params.workspaceDir,
  });

  if (!resolvedAuth.apiKey || resolvedAuth.mode === "aws-sdk") {
    return resolvedAuth;
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
      apiKey: resolvedAuth.apiKey,
      authMode: resolvedAuth.mode,
      profileId: resolvedAuth.profileId,
    },
  });

  if (!preparedAuth) {
    return resolvedAuth;
  }

  return {
    ...resolvedAuth,
    ...preparedAuth,
    apiKey: preparedAuth.apiKey ?? resolvedAuth.apiKey,
  };
}
