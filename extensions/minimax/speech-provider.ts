import { resolveAgentDir } from "openclaw/plugin-sdk/agent-scope-runtime";
import { isProviderAuthProfileConfigured } from "openclaw/plugin-sdk/provider-auth";
import { buildMinimaxSpeechProvider as createProvider } from "./speech-provider-factory.js";

export function buildMinimaxSpeechProvider() {
  return createProvider({ isProviderAuthProfileConfigured, resolveAgentDir });
}
