// Legacy auth-choice alias handling for CLI/onboarding compatibility.
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  resolveManifestDeprecatedProviderAuthChoice,
  resolveManifestProviderAuthChoices,
} from "../plugins/provider-auth-choices.js";
import type { AuthChoice } from "./onboard-types.js";

const LEGACY_REPLACEMENT_AUTH_CHOICES = new Set(["claude-cli"]);

function resolveLegacyCliBackendChoice(
  choice: string,
  params?: {
    config?: OpenClawConfig;
    workspaceDir?: string;
    env?: NodeJS.ProcessEnv;
  },
) {
  if (!LEGACY_REPLACEMENT_AUTH_CHOICES.has(choice)) {
    return undefined;
  }
  return resolveManifestDeprecatedProviderAuthChoice(choice, params);
}

function resolveReplacementLabel(choiceLabel: string): string {
  return choiceLabel.trim() || "the replacement auth choice";
}

/** List deprecated CLI auth-choice aliases that manifest providers still recognize. */
export function resolveLegacyAuthChoiceAliasesForCli(params?: {
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
}): ReadonlyArray<AuthChoice> {
  const manifestCliAliases = resolveManifestProviderAuthChoices(params)
    .flatMap((choice) => choice.deprecatedChoiceIds ?? [])
    .filter((choice): choice is AuthChoice => LEGACY_REPLACEMENT_AUTH_CHOICES.has(choice))
    .toSorted((left, right) => left.localeCompare(right));
  return Array.from(new Set(manifestCliAliases));
}

/** Map old onboard auth choices to their current provider-backed choices. */
export function normalizeLegacyOnboardAuthChoice(
  authChoice: AuthChoice | undefined,
  params?: {
    config?: OpenClawConfig;
    workspaceDir?: string;
    env?: NodeJS.ProcessEnv;
  },
): AuthChoice | undefined {
  if (authChoice === "oauth") {
    return "setup-token";
  }
  if (typeof authChoice === "string") {
    const deprecatedChoice = resolveLegacyCliBackendChoice(authChoice, params);
    if (deprecatedChoice) {
      return deprecatedChoice.choiceId as AuthChoice;
    }
  }
  return authChoice;
}

/** Return true when an auth choice is a deprecated provider alias. */
export function isDeprecatedAuthChoice(
  authChoice: AuthChoice | undefined,
  params?: {
    config?: OpenClawConfig;
    workspaceDir?: string;
    env?: NodeJS.ProcessEnv;
  },
): authChoice is AuthChoice {
  return (
    typeof authChoice === "string" && Boolean(resolveLegacyCliBackendChoice(authChoice, params))
  );
}

/** Resolve the current replacement and warning text for a deprecated auth choice. */
export function resolveDeprecatedAuthChoiceReplacement(
  authChoice: AuthChoice,
  params?: {
    config?: OpenClawConfig;
    workspaceDir?: string;
    env?: NodeJS.ProcessEnv;
  },
):
  | {
      normalized: AuthChoice;
      message: string;
    }
  | undefined {
  if (typeof authChoice !== "string") {
    return undefined;
  }
  const deprecatedChoice = resolveLegacyCliBackendChoice(authChoice, params);
  if (!deprecatedChoice) {
    return undefined;
  }
  const replacementLabel = resolveReplacementLabel(deprecatedChoice.choiceLabel);
  return {
    normalized: deprecatedChoice.choiceId as AuthChoice,
    message: `Auth choice "${authChoice}" is deprecated; using ${replacementLabel} setup instead.`,
  };
}

/** Format the non-interactive error shown when a deprecated auth choice was supplied. */
export function formatDeprecatedNonInteractiveAuthChoiceError(
  authChoice: AuthChoice,
  params?: {
    config?: OpenClawConfig;
    workspaceDir?: string;
    env?: NodeJS.ProcessEnv;
  },
): string | undefined {
  const replacement = resolveDeprecatedAuthChoiceReplacement(authChoice, params);
  if (!replacement) {
    return undefined;
  }
  return [
    `Auth choice "${authChoice}" is deprecated.`,
    `Use "--auth-choice ${replacement.normalized}".`,
  ].join("\n");
}
