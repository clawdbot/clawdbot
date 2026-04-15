import { createProviderApiKeyAuthMethod, type OpenClawConfig } from "./provider-auth-api-key.js";

export { applyOpencodeZenModelDefault, OPENCODE_ZEN_DEFAULT_MODEL } from "./provider-onboard.js";

const OPENCODE_SHARED_PROFILE_IDS = ["opencode:default", "opencode-go:default"] as const;
const OPENCODE_SHARED_HINT = "Shared API key for Zen + Go catalogs";
const OPENCODE_SHARED_WIZARD_GROUP = {
  groupId: "opencode",
  groupLabel: "OpenCode",
  groupHint: OPENCODE_SHARED_HINT,
} as const;

export function createOpencodeCatalogApiKeyAuthMethod(params: {
  providerId: string;
  label: string;
  optionKey: string;
  flagName: `--${string}`;
  defaultModel: string;
  applyConfig: (cfg: OpenClawConfig) => OpenClawConfig;
  noteMessage: string;
  choiceId: string;
  choiceLabel: string;
}) {
  return createProviderApiKeyAuthMethod({
    providerId: params.providerId,
    methodId: "api-key",
    label: params.label,
    hint: OPENCODE_SHARED_HINT,
    optionKey: params.optionKey,
    flagName: params.flagName,
    envVar: "OPENCODE_API_KEY",
    promptMessage: "Enter OpenCode API key",
    profileIds: [...OPENCODE_SHARED_PROFILE_IDS],
    defaultModel: params.defaultModel,
    expectedProviders: ["opencode", "opencode-go"],
    applyConfig: params.applyConfig,
    noteMessage: params.noteMessage,
    noteTitle: "OpenCode",
    wizard: {
      choiceId: params.choiceId,
      choiceLabel: params.choiceLabel,
      ...OPENCODE_SHARED_WIZARD_GROUP,
    },
  });
}
