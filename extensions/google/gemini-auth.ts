import { parseGoogleOauthApiKey } from "./oauth-token-shared.js";

export function parseGeminiAuth(apiKey: string): { headers: Record<string, string> } {
  const parsed = apiKey.startsWith("{") ? parseGoogleOauthApiKey(apiKey) : null;
  if (parsed?.token) {
    return {
      headers: {
        Authorization: `Bearer ${parsed.token}`,
        "Content-Type": "application/json",
      },
    };
  }

  return {
    headers: {
      "x-goog-api-key": apiKey,
      "Content-Type": "application/json",
    },
  };
}
