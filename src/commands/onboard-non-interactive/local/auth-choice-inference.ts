/**
 * Infers a non-interactive auth choice from explicit CLI flags.
 *
 * This keeps setup deterministic when users provide API-key flags without also
 * passing `--auth`, including plugin-defined provider auth flags.
 */
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { resolveManifestProviderOnboardAuthFlags } from "../../../plugins/provider-auth-choices.js";
import { CORE_ONBOARD_AUTH_FLAGS } from "../../onboard-core-auth-flags.js";
import type { AuthChoice, OnboardOptions } from "../../onboard-types.js";

type AuthChoiceFlag = {
  optionKey: string;
  authChoice: AuthChoice;
  label: string;
};

/** Inferred auth choice plus every flag that matched the provided options. */
export type AuthChoiceInference = {
  choice?: AuthChoice;
  matches: AuthChoiceFlag[];
};

function hasStringValue(value: unknown): boolean {
  return typeof value === "string" ? Boolean(normalizeOptionalString(value)) : Boolean(value);
}

/** Infers auth choice from core, plugin, and custom provider API-key flags. */
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
    // Only trusted manifests can influence implicit auth choice; untrusted
    // workspace plugins require the user to choose them explicitly.
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
