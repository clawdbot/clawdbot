// Runtime bridge for provider API-key auth configured by plugins.
import { upsertAuthProfileWithLockOrThrow } from "../agents/auth-profiles/profiles.js";
import { applyAuthProfileConfig, buildApiKeyCredential } from "./provider-auth-helpers.js";
import {
  ensureApiKeyFromOptionEnvOrPrompt,
  normalizeApiKeyInput,
  validateApiKeyInput,
} from "./provider-auth-input.js";
import { applyPrimaryModel } from "./provider-model-primary.js";

/** Runtime API-key auth helper bundle exposed to provider setup code. */
export const providerApiKeyAuthRuntime = {
  upsertAuthProfileWithLockOrThrow,
  applyAuthProfileConfig,
  applyPrimaryModel,
  buildApiKeyCredential,
  ensureApiKeyFromOptionEnvOrPrompt,
  normalizeApiKeyInput,
  validateApiKeyInput,
};
