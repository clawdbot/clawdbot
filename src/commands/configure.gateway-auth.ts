import { ensureAuthProfileStore } from "../agents/auth-profiles.js";
import type { MoltbotConfig, GatewayAuthConfig } from "../config/config.js";
import type { RuntimeEnv } from "../runtime.js";
import type { WizardPrompter } from "../wizard/prompts.js";
import { applyAuthChoice, resolvePreferredProviderForAuthChoice } from "./auth-choice.js";
import { promptAuthChoiceGrouped } from "./auth-choice-prompt.js";
import {
  applyModelAllowlist,
  applyModelFallbacksFromSelection,
  applyPrimaryModel,
  promptDefaultModel,
  promptModelAllowlist,
} from "./model-picker.js";

type GatewayAuthChoice = "token" | "password";

const ANTHROPIC_OAUTH_MODEL_KEYS = [
  "anthropic/claude-opus-4-5",
  "anthropic/claude-sonnet-4-5",
  "anthropic/claude-haiku-4-5",
];

export function buildGatewayAuthConfig(params: {
  existing?: GatewayAuthConfig;
  mode: GatewayAuthChoice;
  token?: string;
  password?: string;
}): GatewayAuthConfig | undefined {
  const allowTailscale = params.existing?.allowTailscale;
  const base: GatewayAuthConfig = {};
  if (typeof allowTailscale === "boolean") base.allowTailscale = allowTailscale;

  if (params.mode === "token") {
    return { ...base, mode: "token", token: params.token };
  }
  return { ...base, mode: "password", password: params.password };
}

export async function promptAuthConfig(
  cfg: MoltbotConfig,
  runtime: RuntimeEnv,
  prompter: WizardPrompter,
): Promise<MoltbotConfig> {
  const authChoice = await promptAuthChoiceGrouped({
    prompter,
    store: ensureAuthProfileStore(undefined, {
      allowKeychainPrompt: false,
    }),
    includeSkip: true,
  });

  let next = cfg;
  if (authChoice !== "skip") {
    const applied = await applyAuthChoice({
      authChoice,
      config: next,
      prompter,
      runtime,
      setDefaultModel: true,
    });
    next = applied.config;
  } else {
    const modelSelection = await promptDefaultModel({
      config: next,
      prompter,
      allowKeep: true,
      ignoreAllowlist: true,
      preferredProvider: resolvePreferredProviderForAuthChoice(authChoice),
    });
    if (modelSelection.model) {
      next = applyPrimaryModel(next, modelSelection.model);
    }
  }

  const anthropicOAuth =
    authChoice === "setup-token" || authChoice === "token" || authChoice === "oauth";

  const allowlistSelection = await promptModelAllowlist({
    config: next,
    prompter,
    allowedKeys: anthropicOAuth ? ANTHROPIC_OAUTH_MODEL_KEYS : undefined,
    initialSelections: anthropicOAuth ? ["anthropic/claude-opus-4-5"] : undefined,
    message: anthropicOAuth ? "Anthropic OAuth models" : undefined,
  });
  if (allowlistSelection.models) {
    next = applyModelAllowlist(next, allowlistSelection.models);
    next = applyModelFallbacksFromSelection(next, allowlistSelection.models);
  }

  return next;
}
