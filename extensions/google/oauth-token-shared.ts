// Google plugin module implements oauth token shared behavior.
import { readStringValue } from "openclaw/plugin-sdk/string-coerce-runtime";

type GoogleOauthApiKeyCredential = {
  type?: string;
  access?: string;
  projectId?: string;
};

export function parseGoogleOauthApiKey(apiKey: string): {
  token?: string;
  projectId?: string;
} | null {
  try {
    const parsed = JSON.parse(apiKey) as { token?: unknown; projectId?: unknown };
    return {
      token: readStringValue(parsed.token),
      projectId: readStringValue(parsed.projectId),
    };
  } catch {
    return null;
  }
}

export function formatGoogleOauthApiKey(cred: GoogleOauthApiKeyCredential): string {
  if (cred.type !== "oauth" || typeof cred.access !== "string" || !cred.access.trim()) {
    return "";
  }
  return JSON.stringify({
    token: cred.access,
    projectId: cred.projectId,
  });
}
