// Legacy auth-choice alias handling for CLI/onboarding compatibility.
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveManifestDeprecatedProviderAuthChoice } from "../plugins/provider-auth-choices.js";
import type { AuthChoice } from "./onboard-types.js";

const LEGACY_REPLACEMENT_AUTH_CHOICES = new Set(["claude-cli"]);

/** Resolve a legacy choice and its diagnostics from one manifest generation. */
export function resolveLegacyOnboardAuthChoice(
  authChoice: AuthChoice | undefined,
  params?: {
    config?: OpenClawConfig;
    workspaceDir?: string;
    env?: NodeJS.ProcessEnv;
  },
):
  | { authChoice: AuthChoice | undefined; deprecated?: undefined }
  | {
      authChoice: AuthChoice;
      deprecated: { message: string; nonInteractiveError: string };
    } {
  if (authChoice === "oauth") {
    // Pre-manifest spelling of Anthropic setup-token auth. Entry-point
    // normalization keeps this alias out of the accepted CLI choice list.
    return { authChoice: "setup-token" };
  }
  if (typeof authChoice !== "string" || !LEGACY_REPLACEMENT_AUTH_CHOICES.has(authChoice)) {
    return { authChoice };
  }
  const deprecatedChoice = resolveManifestDeprecatedProviderAuthChoice(authChoice, params);
  if (!deprecatedChoice) {
    return { authChoice };
  }
  const replacementLabel = deprecatedChoice.choiceLabel.trim() || "the replacement auth choice";
  return {
    authChoice: deprecatedChoice.choiceId,
    deprecated: {
      message: `Auth choice "${authChoice}" is deprecated; using ${replacementLabel} setup instead.`,
      nonInteractiveError: [
        `Auth choice "${authChoice}" is deprecated.`,
        `Use "--auth-choice ${deprecatedChoice.choiceId}".`,
      ].join("\n"),
    },
  };
}
