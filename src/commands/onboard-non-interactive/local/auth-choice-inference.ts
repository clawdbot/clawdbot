import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { resolveManifestProviderOnboardAuthFlags } from "../../../plugins/provider-auth-choices.js";
import { normalizeOptionalString } from "../../../shared/string-coerce.js";
import { CORE_ONBOARD_AUTH_FLAGS } from "../../onboard-core-auth-flags.js";
import type { AuthChoice, OnboardOptions } from "../../onboard-types.js";

type AuthChoiceFlag = {
  optionKey: string;
  authChoice: AuthChoice;
  label: string;
};

export type AuthChoiceInference = {
  choice?: AuthChoice;
  matches: AuthChoiceFlag[];
};

function hasStringValue(value: unknown): boolean {
  return typeof value === "string" ? Boolean(normalizeOptionalString(value)) : Boolean(value);
}

// Infer auth choice from explicit provider API key flags.
export function inferAuthChoiceFromFlags(
  opts: OnboardOptions,
  params?: {
    config?: OpenClawConfig;
    workspaceDir?: string;
    env?: NodeJS.ProcessEnv;
  },
): AuthChoiceInference {
  const flags = [
    ...CORE_ONBOARD_AUTH_FLAGS,
    ...resolveManifestProviderOnboardAuthFlags({
      config: params?.config,
      workspaceDir: params?.workspaceDir,
      env: params?.env,
      includeUntrustedWorkspacePlugins: false,
    }),
  ] as ReadonlyArray<{
    optionKey: string;
    authChoice: string;
    cliFlag: string;
  }>;
  const matches: AuthChoiceFlag[] = flags
    .filter(({ optionKey }) => hasStringValue(opts[optionKey]))
    .map((flag) => ({
      optionKey: flag.optionKey,
      authChoice: flag.authChoice as AuthChoice,
      label: flag.cliFlag,
    }));

  if (
    hasStringValue(opts.customBaseUrl) ||
    hasStringValue(opts.customModelId) ||
    hasStringValue(opts.customApiKey)
  ) {
    matches.push({
      optionKey: "customBaseUrl",
      authChoice: "custom-api-key",
      label: "--custom-base-url/--custom-model-id/--custom-api-key",
    });
  }

  return {
    choice: matches[0]?.authChoice,
    matches,
  };
}
