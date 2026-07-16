import {
  coerceSecretRef,
  ensureAuthProfileStore,
  listProfilesForProvider,
} from "openclaw/plugin-sdk/provider-auth";
import { githubCopilotLoginCommand } from "openclaw/plugin-sdk/provider-auth-login";
import { PROVIDER_ID, resolveCopilotForwardCompatModel } from "./models.js";
import { wrapCopilotAnthropicStream, wrapCopilotProviderStream } from "./stream.js";
import { DEFAULT_COPILOT_API_BASE_URL, resolveCopilotApiToken } from "./token.js";
import { fetchCopilotUsage } from "./usage.js";

export {
  coerceSecretRef,
  DEFAULT_COPILOT_API_BASE_URL,
  ensureAuthProfileStore,
  fetchCopilotUsage,
  githubCopilotLoginCommand,
  listProfilesForProvider,
  PROVIDER_ID,
  resolveCopilotApiToken,
  resolveCopilotForwardCompatModel,
  wrapCopilotAnthropicStream,
  wrapCopilotProviderStream,
};
