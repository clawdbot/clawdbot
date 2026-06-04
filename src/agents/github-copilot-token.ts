// Public compatibility barrel for Copilot token helpers that now live in the
// provider-auth SDK surface. Keep callers away from deep plugin-sdk paths.
export {
  DEFAULT_COPILOT_API_BASE_URL,
  deriveCopilotApiBaseUrlFromToken,
  resolveCopilotApiToken,
  type CachedCopilotToken,
} from "../plugin-sdk/provider-auth.js";
