import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type {
  CliBackendPreparedExecution,
  CliBackendToolAvailability,
} from "openclaw/plugin-sdk/cli-backend";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { resolvePreferredOpenClawTmpDir } from "openclaw/plugin-sdk/temp-path";
import {
  GOOGLE_GEMINI_CLI_PROVIDER_ID,
  resolveGeminiCliProfileHome as resolveGeminiCliProfileHomePath,
} from "./gemini-cli-auth-home.js";

const GEMINI_CLI_PROVIDER_ID = GOOGLE_GEMINI_CLI_PROVIDER_ID;
const GOOGLE_PROVIDER_ID = "google";
const VERCEL_AI_GATEWAY_PROVIDER_ID = "vercel-ai-gateway";
const GEMINI_CLI_CREDENTIALS_FILENAME = "gemini-credentials.json";
const GEMINI_CLI_GCA_AUTH_ENV = [
  "GOOGLE_GENAI_USE_GCA",
  "GOOGLE_CLOUD_ACCESS_TOKEN",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "GEMINI_FORCE_ENCRYPTED_FILE_STORAGE",
  "GEMINI_FORCE_FILE_STORAGE",
];
const GEMINI_CLI_API_KEY_AUTH_ENV = [
  ...GEMINI_CLI_GCA_AUTH_ENV,
  "GOOGLE_GENAI_USE_VERTEXAI",
  "GOOGLE_API_KEY",
  "GOOGLE_CLOUD_PROJECT",
  "GOOGLE_CLOUD_PROJECT_ID",
  "GOOGLE_CLOUD_QUOTA_PROJECT",
  "GOOGLE_CLOUD_LOCATION",
  "GOOGLE_GEMINI_BASE_URL",
  "GEMINI_CLI_CUSTOM_HEADERS",
  "GEMINI_API_KEY_AUTH_MECHANISM",
];
const GEMINI_CLI_PROFILE_AUTH_ENV = [...GEMINI_CLI_API_KEY_AUTH_ENV, "GEMINI_API_KEY"];
const GEMINI_CLI_PROFILE_SETTINGS_ENV = ["GEMINI_CLI_SYSTEM_SETTINGS_PATH"];

type GeminiAuthProfileCredential = {
  type: "api_key" | "oauth" | "token";
  provider: string;
  key?: string;
  token?: string;
  access?: string;
  refresh?: string;
  expires?: number;
  idToken?: string;
  projectId?: string;
};

type GeminiOAuthCredential = GeminiAuthProfileCredential & {
  type: "oauth";
  provider: typeof GEMINI_CLI_PROVIDER_ID;
  access: string;
  refresh: string;
  expires: number;
};

type GeminiApiKeyCredential = GeminiAuthProfileCredential & {
  type: "api_key";
  provider: typeof GEMINI_CLI_PROVIDER_ID | typeof GOOGLE_PROVIDER_ID;
  key: string;
};

type GeminiCliAuthHomeContext = {
  agentDir?: string;
  authProfileId?: string;
  systemSettingsPath?: string;
  toolAvailability?: CliBackendToolAvailability;
};

type GeminiCliAuthSelectedType = "oauth-personal" | "gemini-api-key";

function normalizeString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function throwUnsupportedGeminiCredential(credential: GeminiAuthProfileCredential): never {
  if (credential.provider === VERCEL_AI_GATEWAY_PROVIDER_ID) {
    throw new Error(
      "Gemini CLI execution cannot use a vercel-ai-gateway auth profile. Use the OpenClaw vercel-ai-gateway provider instead.",
    );
  }
  throw new Error("Gemini CLI execution requires a google-gemini-cli auth profile.");
}

function throwUnstageableSelectedGeminiProfile(
  ctx: GeminiCliAuthHomeContext,
  credential: GeminiAuthProfileCredential | undefined,
): never {
  const authProfileId = normalizeString(ctx.authProfileId);
  if (!authProfileId) {
    throw new Error("Gemini CLI execution requires a selected auth profile.");
  }
  if (!credential) {
    throw new Error(
      "Gemini CLI auth profile was selected but no credential material was found. Re-authenticate with `openclaw models auth login --provider google-gemini-cli --force`.",
    );
  }
  if (credential.provider !== GEMINI_CLI_PROVIDER_ID) {
    throwUnsupportedGeminiCredential(credential);
  }
  throw new Error(
    "Gemini CLI execution supports google-gemini-cli OAuth or API-key auth profiles. Re-authenticate with `openclaw models auth login --provider google-gemini-cli --force`.",
  );
}

function requireGeminiOAuthCredential(
  credential: GeminiAuthProfileCredential | undefined,
): GeminiOAuthCredential | null {
  if (!credential) {
    return null;
  }
  if (credential.type !== "oauth") {
    return null;
  }
  if (credential.provider !== GEMINI_CLI_PROVIDER_ID) {
    throwUnsupportedGeminiCredential(credential);
  }

  const access = normalizeString(credential.access);
  const refresh = normalizeString(credential.refresh);
  if (
    !access ||
    !refresh ||
    typeof credential.expires !== "number" ||
    !Number.isFinite(credential.expires)
  ) {
    throw new Error(
      "Gemini CLI OAuth profile is missing usable token material. Re-authenticate with `openclaw models auth login --provider google-gemini-cli --force`.",
    );
  }

  return {
    ...credential,
    type: "oauth",
    provider: GEMINI_CLI_PROVIDER_ID,
    access,
    refresh,
    expires: credential.expires,
    idToken: normalizeString(credential.idToken),
    projectId: normalizeString(credential.projectId),
  };
}

function requireGeminiApiKeyCredential(
  credential: GeminiAuthProfileCredential | undefined,
): GeminiApiKeyCredential | null {
  if (!credential) {
    return null;
  }
  if (credential.type !== "api_key") {
    return null;
  }
  if (
    credential.provider !== GEMINI_CLI_PROVIDER_ID &&
    credential.provider !== GOOGLE_PROVIDER_ID
  ) {
    throwUnsupportedGeminiCredential(credential);
  }

  const key = normalizeString(credential.key);
  if (!key) {
    throw new Error("Gemini CLI API-key profile is missing usable key material.");
  }

  return {
    ...credential,
    type: "api_key",
    provider: credential.provider,
    key,
  };
}

function resolveGeminiCliProfileHome(ctx: GeminiCliAuthHomeContext): {
  home: string;
  geminiDir: string;
} {
  const agentDir = normalizeString(ctx.agentDir);
  if (!agentDir) {
    throw new Error("Gemini CLI auth profile execution requires an agent directory.");
  }
  const authProfileId = normalizeString(ctx.authProfileId);
  if (!authProfileId) {
    throw new Error("Gemini CLI auth profile execution requires a selected auth profile.");
  }

  const home = resolveGeminiCliProfileHomePath(agentDir, authProfileId);
  return { home, geminiDir: path.join(home, ".gemini") };
}

function readGeminiAuthProfileCredential(
  credential: unknown,
): GeminiAuthProfileCredential | undefined {
  if (!isRecord(credential)) {
    return undefined;
  }
  return credential as GeminiAuthProfileCredential;
}

async function readGeminiCliJsonObject(
  filePath: string | undefined,
): Promise<Record<string, unknown>> {
  const normalized = normalizeString(filePath);
  if (!normalized) {
    return {};
  }
  try {
    const parsed = JSON.parse(await fs.readFile(normalized, "utf8")) as unknown;
    if (!isRecord(parsed)) {
      throw new Error(`Gemini CLI system settings must be a JSON object: ${normalized}`);
    }
    return { ...parsed };
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code?: unknown }).code === "ENOENT"
    ) {
      return {};
    }
    throw error;
  }
}

function buildGeminiCliAuthSettings(
  selectedType: GeminiCliAuthSelectedType,
): Record<string, unknown> {
  return { security: { auth: { selectedType } } };
}

async function buildGeminiCliSystemSettings(
  ctx: GeminiCliAuthHomeContext,
  selectedType?: GeminiCliAuthSelectedType,
): Promise<Record<string, unknown>> {
  const base = await readGeminiCliJsonObject(ctx.systemSettingsPath);
  let settings = base;
  if (selectedType) {
    const security = isRecord(base.security) ? { ...base.security } : {};
    const auth = isRecord(security.auth) ? { ...security.auth } : {};
    const enforcedType = normalizeString(
      typeof auth.enforcedType === "string" ? auth.enforcedType : undefined,
    );
    if (enforcedType && enforcedType !== selectedType) {
      throw new Error(
        `Gemini CLI system settings enforce ${enforcedType} auth, but the selected OpenClaw profile requires ${selectedType}.`,
      );
    }
    security.auth = { ...auth, selectedType };
    settings = { ...base, security };
  }
  return ctx.toolAvailability
    ? applyGeminiCliToolAvailability(settings, ctx.toolAvailability)
    : settings;
}

function applyGeminiCliToolAvailability(
  base: Record<string, unknown>,
  availability: CliBackendToolAvailability,
): Record<string, unknown> {
  if (availability.native.length > 0) {
    throw new Error("Gemini CLI cannot expose backend-native tools in an exact restricted run.");
  }
  const mcpServers = isRecord(base.mcpServers) ? { ...base.mcpServers } : {};
  if (!isRecord(mcpServers.openclaw)) {
    throw new Error("Gemini CLI exact tool availability requires the OpenClaw MCP server.");
  }
  const tools = isRecord(base.tools) ? { ...base.tools } : {};
  // `tools.allowed` has higher policy priority than the `tools.core` default
  // deny. Drop it so inherited system settings cannot widen this exact run.
  const {
    allowed: _allowedTools,
    core: _coreTools,
    discoveryCommand: _discoveryCommand,
    callCommand: _callCommand,
    ...nonAuthorityToolSettings
  } = tools;
  const mcp = isRecord(base.mcp) ? { ...base.mcp } : {};
  const { serverCommand: _serverCommand, ...nonAuthorityMcpSettings } = mcp;
  const experimental = isRecord(base.experimental) ? { ...base.experimental } : {};
  const agents = isRecord(base.agents) ? { ...base.agents } : {};
  const agentOverrides = isRecord(agents.overrides) ? { ...agents.overrides } : {};
  const hooksConfig = isRecord(base.hooksConfig) ? { ...base.hooksConfig } : {};
  const skills = isRecord(base.skills) ? { ...base.skills } : {};
  return {
    ...base,
    tools: {
      ...nonAuthorityToolSettings,
      core: ["mcp_openclaw_*"],
      discoveryCommand: "",
      callCommand: "",
    },
    mcp: { ...nonAuthorityMcpSettings, allowed: ["openclaw"], serverCommand: "" },
    mcpServers: {
      openclaw: {
        ...mcpServers.openclaw,
        includeTools: [...availability.openClaw],
      },
    },
    experimental: { ...experimental, enableAgents: false },
    agents: {
      ...agents,
      overrides: {
        ...agentOverrides,
        codebase_investigator: {
          ...(isRecord(agentOverrides.codebase_investigator)
            ? agentOverrides.codebase_investigator
            : {}),
          enabled: false,
        },
        cli_help: {
          ...(isRecord(agentOverrides.cli_help) ? agentOverrides.cli_help : {}),
          enabled: false,
        },
      },
    },
    hooksConfig: { ...hooksConfig, enabled: false },
    skills: { ...skills, enabled: false },
  };
}

async function writeGeminiCliJson(filePath: string, value: unknown): Promise<void> {
  const tempPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${crypto.randomUUID()}.tmp`,
  );
  await fs.writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await fs.chmod(tempPath, 0o600);
  await fs.rename(tempPath, filePath);
  await fs.chmod(filePath, 0o600);
}

async function prepareGeminiCliProfileHome(
  ctx: GeminiCliAuthHomeContext,
  selectedType: GeminiCliAuthSelectedType,
): Promise<{
  home: string;
  geminiDir: string;
  systemSettingsPath: string;
  beforeExecution: () => Promise<void>;
  cleanup: () => Promise<void>;
}> {
  const { home, geminiDir } = resolveGeminiCliProfileHome(ctx);
  const settings = buildGeminiCliAuthSettings(selectedType);
  const systemSettings = await buildGeminiCliSystemSettings(ctx, selectedType);
  const systemSettingsDir = await fs.mkdtemp(
    path.join(resolvePreferredOpenClawTmpDir(), "openclaw-gemini-cli-"),
  );
  await fs.chmod(systemSettingsDir, 0o700);
  const systemSettingsPath = path.join(systemSettingsDir, "settings.json");
  return {
    home,
    geminiDir,
    systemSettingsPath,
    beforeExecution: async () => {
      await fs.mkdir(geminiDir, { recursive: true, mode: 0o700 });
      await fs.chmod(home, 0o700);
      await fs.chmod(geminiDir, 0o700);
      await Promise.all([
        writeGeminiCliJson(path.join(geminiDir, "settings.json"), settings),
        writeGeminiCliJson(path.join(home, "settings.json"), settings),
        writeGeminiCliJson(systemSettingsPath, systemSettings),
      ]);
    },
    cleanup: async () => {
      await fs.rm(systemSettingsDir, { recursive: true, force: true });
    },
  };
}

async function clearGeminiCliCachedCredentials(geminiDir: string): Promise<void> {
  // Gemini prefers its token store over oauth_creds.json. Rebuild that store
  // from the selected OpenClaw profile each run so stale CLI auth cannot win.
  await fs.rm(path.join(geminiDir, GEMINI_CLI_CREDENTIALS_FILENAME), { force: true });
}

function buildGeminiCliProjectEnv(projectId: string | undefined): Record<string, string> {
  const normalized = normalizeString(projectId);
  if (!normalized) {
    return {};
  }
  return {
    GOOGLE_CLOUD_PROJECT: normalized,
    GOOGLE_CLOUD_PROJECT_ID: normalized,
    GOOGLE_CLOUD_QUOTA_PROJECT: normalized,
  };
}

async function prepareGeminiCliOAuthHome(
  ctx: GeminiCliAuthHomeContext,
  credential: GeminiAuthProfileCredential | undefined,
): Promise<CliBackendPreparedExecution | null> {
  const oauth = requireGeminiOAuthCredential(credential);
  if (!oauth) {
    return null;
  }

  const profileHome = await prepareGeminiCliProfileHome(ctx, "oauth-personal");
  const idToken = normalizeString(oauth.idToken);
  const oauthCreds: Record<string, string | number> = {
    access_token: oauth.access,
    refresh_token: oauth.refresh,
    expiry_date: oauth.expires,
    token_type: "Bearer",
  };
  if (idToken) {
    oauthCreds.id_token = idToken;
  }

  return {
    env: {
      GEMINI_CLI_HOME: profileHome.home,
      GEMINI_CLI_SYSTEM_SETTINGS_PATH: profileHome.systemSettingsPath,
      GEMINI_FORCE_FILE_STORAGE: "true",
      ...buildGeminiCliProjectEnv(oauth.projectId),
    },
    clearEnv: [...GEMINI_CLI_PROFILE_AUTH_ENV, ...GEMINI_CLI_PROFILE_SETTINGS_ENV],
    beforeExecution: async () => {
      await profileHome.beforeExecution();
      await clearGeminiCliCachedCredentials(profileHome.geminiDir);
      await writeGeminiCliJson(path.join(profileHome.geminiDir, "oauth_creds.json"), oauthCreds);
    },
    cleanup: profileHome.cleanup,
  };
}

async function prepareGeminiCliApiKeyHome(
  ctx: GeminiCliAuthHomeContext,
  credential: GeminiAuthProfileCredential | undefined,
): Promise<CliBackendPreparedExecution | null> {
  const apiKey = requireGeminiApiKeyCredential(credential);
  if (!apiKey) {
    return null;
  }

  const profileHome = await prepareGeminiCliProfileHome(ctx, "gemini-api-key");
  return {
    env: {
      GEMINI_CLI_HOME: profileHome.home,
      GEMINI_CLI_SYSTEM_SETTINGS_PATH: profileHome.systemSettingsPath,
      GEMINI_FORCE_FILE_STORAGE: "true",
      GEMINI_API_KEY: apiKey.key,
    },
    clearEnv: [...GEMINI_CLI_PROFILE_AUTH_ENV, ...GEMINI_CLI_PROFILE_SETTINGS_ENV],
    beforeExecution: async () => {
      await profileHome.beforeExecution();
      await Promise.all([
        fs.rm(path.join(profileHome.geminiDir, "oauth_creds.json"), { force: true }),
        clearGeminiCliCachedCredentials(profileHome.geminiDir),
      ]);
    },
    cleanup: profileHome.cleanup,
  };
}

async function prepareGeminiCliRestrictedSystemSettings(
  ctx: GeminiCliAuthHomeContext,
): Promise<CliBackendPreparedExecution> {
  const settings = await buildGeminiCliSystemSettings(ctx);
  const systemSettingsDir = await fs.mkdtemp(
    path.join(resolvePreferredOpenClawTmpDir(), "openclaw-gemini-cli-policy-"),
  );
  await fs.chmod(systemSettingsDir, 0o700);
  const systemSettingsPath = path.join(systemSettingsDir, "settings.json");
  return {
    env: { GEMINI_CLI_SYSTEM_SETTINGS_PATH: systemSettingsPath },
    clearEnv: [...GEMINI_CLI_PROFILE_SETTINGS_ENV],
    beforeExecution: async () => {
      await writeGeminiCliJson(systemSettingsPath, settings);
    },
    cleanup: async () => {
      await fs.rm(systemSettingsDir, { recursive: true, force: true });
    },
    toolAvailabilityEnforced: true,
  };
}

export async function prepareGeminiCliExecution(
  ctx: GeminiCliAuthHomeContext,
  credential: unknown,
): Promise<CliBackendPreparedExecution | null> {
  const authCredential = readGeminiAuthProfileCredential(credential);
  const prepared =
    (await prepareGeminiCliOAuthHome(ctx, authCredential)) ??
    (await prepareGeminiCliApiKeyHome(ctx, authCredential));
  if (prepared) {
    return ctx.toolAvailability ? { ...prepared, toolAvailabilityEnforced: true } : prepared;
  }
  if (normalizeString(ctx.authProfileId)) {
    throwUnstageableSelectedGeminiProfile(ctx, authCredential);
  }
  return ctx.toolAvailability ? await prepareGeminiCliRestrictedSystemSettings(ctx) : null;
}
