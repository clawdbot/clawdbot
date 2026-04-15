import type { OpenClawConfig } from "../config/config.js";
import { createProviderApiKeyAuthMethod } from "../plugins/provider-api-key-auth.js";
import type { ProviderAuthMethod } from "../plugins/types.js";

export function createOpencodeCatalogApiKeyAuthMethod(params: {
  providerId: string;
  label: string;
  optionKey: string;
  flagName: `--${string}`;
  defaultModel: string;
  applyConfig: (cfg: OpenClawConfig) => OpenClawConfig;
  noteMessage?: string;
  choiceId?: string;
  choiceLabel?: string;
}): ProviderAuthMethod {
  return createProviderApiKeyAuthMethod({
    providerId: params.providerId,
    methodId: `${params.providerId}-catalog-api-key`,
    label: params.label,
    optionKey: params.optionKey,
    flagName: params.flagName,
    envVar: "OPENCODE_API_KEY",
    promptMessage: "Enter your OpenCode API key",
    defaultModel: params.defaultModel,
    applyConfig: params.applyConfig,
    noteMessage: params.noteMessage,
    wizard:
      params.choiceId || params.choiceLabel
        ? {
            choiceId: params.choiceId,
            choiceLabel: params.choiceLabel,
          }
        : undefined,
  });
}
