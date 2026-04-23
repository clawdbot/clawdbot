import type { Api, Model } from "@mariozechner/pi-ai";
import {
  getApiKeyForModel as resolveModelApiKey,
  resolveApiKeyForProvider as resolveProviderApiKey,
} from "../../agents/model-auth.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { prepareProviderRuntimeAuth } from "../provider-runtime.runtime.js";
import type { ResolvedProviderRuntimeAuth } from "./model-auth-types.js";

export async function getApiKeyForModel(
  params: Parameters<typeof resolveModelApiKey>[0],
): Promise<Awaited<ReturnType<typeof resolveModelApiKey>>> {
  return resolveModelApiKey(params);
}

export async function resolveApiKeyForProvider(
  params: Parameters<typeof resolveProviderApiKey>[0],
): Promise<Awaited<ReturnType<typeof resolveProviderApiKey>>> {
  return resolveProviderApiKey(params);
}

/**
 * Resolve request-ready auth for a runtime model, applying any provider-owned
 * `prepareRuntimeAuth` exchange on top of the standard credential lookup.
 */
export async function getRuntimeAuthForModel(params: {
  model: Model<Api>;
  cfg?: OpenClawConfig;
  workspaceDir?: string;
}): Promise<ResolvedProviderRuntimeAuth> {
  const resolvedAuth = await resolveModelApiKey({
    model: params.model,
    cfg: params.cfg,
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
