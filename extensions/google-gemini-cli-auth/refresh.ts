import { existsSync, readFileSync, realpathSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";

const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";

const CLIENT_ID_KEYS = ["CLAWDBOT_GEMINI_OAUTH_CLIENT_ID", "GEMINI_CLI_OAUTH_CLIENT_ID"];
const CLIENT_SECRET_KEYS = [
  "CLAWDBOT_GEMINI_OAUTH_CLIENT_SECRET",
  "GEMINI_CLI_OAUTH_CLIENT_SECRET",
];

export type GeminiCliOAuthCredentials = {
  access: string;
  refresh: string;
  expires: number;
  email?: string;
  projectId: string;
};

function resolveEnv(keys: string[]): string | undefined {
  for (const key of keys) {
    const value = process.env[key]?.trim();
    if (value) return value;
  }
  return undefined;
}

function findInPath(name: string): string | null {
  const exts = process.platform === "win32" ? [".cmd", ".bat", ".exe", ""] : [""];
  const paths = process.env.PATH?.split(delimiter) || [];
  for (const dir of paths) {
    for (const ext of exts) {
      const full = join(dir, name + ext);
      if (existsSync(full)) return full;
    }
  }
  return null;
}

function resolveCredentials(): { clientId: string; clientSecret: string | undefined } {
  const envClientId = resolveEnv(CLIENT_ID_KEYS);
  const envClientSecret = resolveEnv(CLIENT_SECRET_KEYS);
  if (envClientId) {
    return { clientId: envClientId, clientSecret: envClientSecret };
  }

  // Try to extract from Gemini CLI
  try {
    const geminiPath = findInPath("gemini");
    if (geminiPath) {
      const resolvedPath = realpathSync(geminiPath);
      const geminiCliDir = dirname(dirname(resolvedPath));
      const searchPaths = [
        join(geminiCliDir, "node_modules", "@google", "gemini-cli-core", "dist", "src", "code_assist", "oauth2.js"),
        join(geminiCliDir, "node_modules", "@google", "gemini-cli-core", "dist", "code_assist", "oauth2.js"),
      ];
      for (const p of searchPaths) {
        if (existsSync(p)) {
          const content = readFileSync(p, "utf8");
          const idMatch = content.match(/(\d+-[a-z0-9]+\.apps\.googleusercontent\.com)/);
          const secretMatch = content.match(/(GOCSPX-[A-Za-z0-9_-]+)/);
          if (idMatch && secretMatch) {
            return { clientId: idMatch[1], clientSecret: secretMatch[1] };
          }
        }
      }
    }
  } catch {
    // Extraction failed
  }

  throw new Error(
    "Gemini CLI OAuth credentials not found. Set GEMINI_CLI_OAUTH_CLIENT_ID and GEMINI_CLI_OAUTH_CLIENT_SECRET, or ensure gemini-cli is installed.",
  );
}

export async function refreshGoogleGeminiCliCredentials(
  credentials: GeminiCliOAuthCredentials,
): Promise<GeminiCliOAuthCredentials> {
  if (!credentials.refresh?.trim()) {
    throw new Error("Google Gemini CLI OAuth refresh token missing; re-authenticate.");
  }

  const { clientId, clientSecret } = resolveCredentials();

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: credentials.refresh,
    client_id: clientId,
  });
  if (clientSecret) {
    body.set("client_secret", clientSecret);
  }

  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body,
  });

  if (!response.ok) {
    const text = await response.text();
    if (response.status === 400 || response.status === 401) {
      throw new Error(
        `Google Gemini CLI OAuth refresh token expired or invalid. Re-authenticate with \`clawdbot models auth login --provider google-gemini-cli\`.`,
      );
    }
    throw new Error(`Google Gemini CLI OAuth refresh failed: ${text || response.statusText}`);
  }

  const payload = await response.json();
  if (!payload.access_token || !payload.expires_in) {
    throw new Error("Google Gemini CLI OAuth refresh response missing access token.");
  }

  return {
    ...credentials,
    access: payload.access_token,
    refresh: payload.refresh_token || credentials.refresh,
    expires: Date.now() + payload.expires_in * 1000,
  };
}
