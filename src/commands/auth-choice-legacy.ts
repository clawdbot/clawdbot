import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  resolveManifestDeprecatedProviderAuthChoice,
  resolveManifestProviderAuthChoices,
} from "../plugins/provider-auth-choices.js";
import type { AuthChoice } from "./onboard-types.js";

function resolveLegacyCliBackendChoice(
  choice: string,
  params?: {
    config?: OpenClawConfig;
    workspaceDir?: string;
    env?: NodeJS.ProcessEnv;
  },
) {
  if (!choice.endsWith("-cli")) {
    return undefined;
  }
  return resolveManifestDeprecatedProviderAuthChoice(choice, params);
}

function resolveReplacementLabel(choiceLabel: string): string {
  return choiceLabel.trim() || "the replacement auth choice";
}

export function resolveLegacyAuthChoiceAliasesForCli(params?: {
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
}): ReadonlyArray<AuthChoice> {
  const manifestCliAliases = resolveManifestProviderAuthChoices(params)
    .flatMap((choice) => choice.deprecatedChoiceIds ?? [])
    .filter((choice): choice is AuthChoice => choice.endsWith("-cli"))
    .toSorted((left, right) => left.localeCompare(right));
  return manifestCliAliases;
}

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
