// Google plugin module resolves Gemini API partner attribution headers.
import {
  resolveProviderRequestHeaders,
  type ProviderRequestCapability,
  type ProviderRequestTransport,
} from "openclaw/plugin-sdk/provider-http";
import { DEFAULT_GOOGLE_API_BASE_URL } from "./provider-policy.js";

export function resolveGoogleApiClientHeaders(params?: {
  api?: string;
  baseUrl?: string;
  capability?: ProviderRequestCapability;
  transport?: ProviderRequestTransport;
}): Record<string, string> {
  return (
    resolveProviderRequestHeaders({
      provider: "google",
      api: params?.api ?? "google-generative-ai",
      baseUrl: params?.baseUrl ?? DEFAULT_GOOGLE_API_BASE_URL,
      capability: params?.capability ?? "other",
      transport: params?.transport ?? "http",
    }) ?? {}
  );
}
