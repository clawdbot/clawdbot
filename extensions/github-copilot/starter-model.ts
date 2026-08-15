// Resolves a safe setup default from the authenticated Copilot model catalog.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { DEFAULT_COPILOT_MODEL } from "./model-metadata.js";
import { fetchCopilotModelCatalog, PROVIDER_ID, selectCopilotStarterModel } from "./models.js";
import { resolveCopilotRuntimeAuth } from "./runtime-auth.js";

function preferredCopilotStarterModelId(): string {
  const prefix = `${PROVIDER_ID}/`;
  return DEFAULT_COPILOT_MODEL.startsWith(prefix)
    ? DEFAULT_COPILOT_MODEL.slice(prefix.length)
    : DEFAULT_COPILOT_MODEL;
}

export async function resolveCopilotStarterModel(params: {
  githubToken: string;
  env?: NodeJS.ProcessEnv;
  githubDomain?: string;
  config?: OpenClawConfig;
}): Promise<string> {
  const auth = await resolveCopilotRuntimeAuth({
    githubToken: params.githubToken,
    ...(params.env ? { env: params.env } : {}),
    ...(params.githubDomain ? { githubDomain: params.githubDomain } : {}),
    ...(params.config ? { config: params.config } : {}),
  });
  const models = await fetchCopilotModelCatalog({
    copilotApiToken: auth.apiKey,
    baseUrl: auth.baseUrl,
  });
  const selected = selectCopilotStarterModel(models, preferredCopilotStarterModelId());
  if (!selected) {
    throw new Error(
      "GitHub Copilot did not return an enabled, picker-visible chat model with streaming and tool-call support.",
    );
  }
  return `${PROVIDER_ID}/${selected.id}`;
}
