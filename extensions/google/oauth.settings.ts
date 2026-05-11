import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { isRecord, normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";

type OAuthSettingsFs = {
  existsSync: (path: Parameters<typeof existsSync>[0]) => ReturnType<typeof existsSync>;
  readFileSync: (path: Parameters<typeof readFileSync>[0], encoding: "utf8") => string;
  homedir: typeof homedir;
};

const defaultFs: OAuthSettingsFs = {
  existsSync,
  readFileSync,
  homedir,
};

let oauthSettingsFs: OAuthSettingsFs = defaultFs;

type GeminiCliAuthSettings = {
  security?: {
    auth?: {
      selectedType?: unknown;
      enforcedType?: unknown;
    };
  };
  selectedAuthType?: unknown;
  enforcedAuthType?: unknown;
};

function readSettingsFile(): GeminiCliAuthSettings | null {
  const settingsPath = join(oauthSettingsFs.homedir(), ".gemini", "settings.json");
  if (!oauthSettingsFs.existsSync(settingsPath)) {
    return null;
  }
  try {
    const parsed = JSON.parse(oauthSettingsFs.readFileSync(settingsPath, "utf8")) as unknown;
    return isRecord(parsed) ? (parsed as GeminiCliAuthSettings) : null;
  } catch {
    return null;
  }
}

export function setOAuthSettingsFsForTest(overrides?: Partial<OAuthSettingsFs>): void {
  oauthSettingsFs = overrides ? { ...defaultFs, ...overrides } : defaultFs;
}

export function resolveGeminiCliSelectedAuthType(): string | undefined {
  const settings = readSettingsFile();
  if (settings) {
    const security = isRecord(settings.security) ? settings.security : undefined;
    const auth = isRecord(security?.auth) ? security.auth : undefined;
    const selectedAuthType =
      normalizeOptionalString(auth?.selectedType) ??
      normalizeOptionalString(auth?.enforcedType) ??
      normalizeOptionalString(settings.selectedAuthType) ??
      normalizeOptionalString(settings.enforcedAuthType);
    if (selectedAuthType) {
      return selectedAuthType;
    }
  }

  if (process.env.GOOGLE_GENAI_USE_GCA === "true") {
    return "oauth-personal";
  }

  return undefined;
}

export function isGeminiCliPersonalOAuth(): boolean {
  return resolveGeminiCliSelectedAuthType() === "oauth-personal";
}
