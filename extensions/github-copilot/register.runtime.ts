// Github Copilot plugin module implements register behavior.
import {
  coerceSecretRef,
  ensureAuthProfileStore,
  listProfilesForProvider,
} from "openclaw/plugin-sdk/provider-auth";
import { githubCopilotLoginCommand } from "./login.js";
import { PROVIDER_ID, resolveCopilotForwardCompatModel } from "./models.js";
import { DEFAULT_COPILOT_API_BASE_URL, resolveCopilotRuntimeAuth } from "./runtime-auth.js";
import { wrapCopilotAnthropicStream, wrapCopilotProviderStream } from "./stream.js";
import { fetchCopilotUsage } from "./usage.js";

export {
  coerceSecretRef,
  DEFAULT_COPILOT_API_BASE_URL,
  ensureAuthProfileStore,
  fetchCopilotUsage,
  githubCopilotLoginCommand,
  listProfilesForProvider,
  PROVIDER_ID,
  resolveCopilotRuntimeAuth,
  resolveCopilotForwardCompatModel,
  wrapCopilotAnthropicStream,
  wrapCopilotProviderStream,
};
