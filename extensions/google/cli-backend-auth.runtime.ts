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
  assertGeminiCliLiteralIsolatedPrompt,
  GEMINI_CLI_EXACT_TOOL_ENV_BARRIERS,
  type GeminiCliRestrictedAuthContext,
  isolatedCompletionInputError,
  isolatedCompletionUnsupportedError,
  readGeminiCliJsonObject,
  resolveGeminiCliAmbientAuth,
  resolveGeminiCliTrustedTransportEnv,
} from "./cli-backend-isolated-auth.runtime.js";
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
  // Gemini CLI consumes this token only in its Code Assist branch. Keep it
  // coupled to the rejected/cleared GCA selector so Vertex cannot inherit it.
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

type GeminiCliAuthHomeContext = GeminiCliRestrictedAuthContext & {
  agentDir?: string;
  authProfileId?: string;
  isolatedCompletionCwd?: string;
  toolAvailability?: CliBackendToolAvailability;
  isolatedCompletionModelId?: string;
  isolatedCompletionPrompt?: string;
  isolatedCompletionSystemPrompt?: string;
};

type GeminiCliAuthSelectedType = "oauth-personal" | "gemini-api-key";

type GeminiCliPreparedExecution = CliBackendPreparedExecution & {
  isolatedCompletionEnforced?: true;
};

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

function buildGeminiCliAuthSettings(
  selectedType: GeminiCliAuthSelectedType,
): Record<string, unknown> {
  return { security: { auth: { selectedType } } };
}

async function buildGeminiCliSystemSettings(
  ctx: GeminiCliAuthHomeContext,
  selectedType?: string,
  ambientSafeSettings: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const base = await readGeminiCliJsonObject(ctx.systemSettingsPath);
  const ambientPrivacy = isRecord(ambientSafeSettings.privacy)
    ? ambientSafeSettings.privacy
    : undefined;
  const basePrivacy = isRecord(base.privacy) ? base.privacy : undefined;
  const ambientTelemetry = isRecord(ambientSafeSettings.telemetry)
    ? ambientSafeSettings.telemetry
    : undefined;
  const baseTelemetry = isRecord(base.telemetry) ? base.telemetry : undefined;
  let settings: Record<string, unknown> = {
    ...ambientSafeSettings,
    ...base,
    ...(ambientPrivacy || basePrivacy ? { privacy: { ...ambientPrivacy, ...basePrivacy } } : {}),
    ...(ambientTelemetry || baseTelemetry
      ? { telemetry: { ...ambientTelemetry, ...baseTelemetry } }
      : {}),
  };
  if (selectedType) {
    const security = isRecord(settings.security) ? { ...settings.security } : {};
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
    settings = { ...settings, security };
  }
  const restricted = ctx.toolAvailability
    ? applyGeminiCliToolAvailability(settings, ctx.toolAvailability)
    : settings;
  return applyGeminiCliIsolatedCompletionSettings(restricted, ctx);
}

function applyGeminiCliIsolatedCompletionSettings(
  base: Record<string, unknown>,
  ctx: GeminiCliAuthHomeContext,
): Record<string, unknown> {
  if (ctx.isolatedCompletionSystemPrompt === undefined) {
    return base;
  }
  const modelId = normalizeString(ctx.isolatedCompletionModelId);
  if (!modelId || modelId === "auto" || modelId.startsWith("auto-")) {
    throw isolatedCompletionInputError(
      "Gemini isolated completion requires one concrete model id.",
    );
  }
  const policy = {
    model: modelId,
    isLastResort: true,
    actions: {
      terminal: "prompt",
      transient: "prompt",
      not_found: "prompt",
      unknown: "prompt",
    },
    stateTransitions: {
      terminal: "terminal",
      transient: "terminal",
      not_found: "terminal",
      unknown: "terminal",
    },
  };
  const general = isRecord(base.general) ? { ...base.general } : {};
  const experimental = isRecord(base.experimental) ? { ...base.experimental } : {};
  const telemetry = isRecord(base.telemetry) ? { ...base.telemetry } : {};
  const exactModelResolution = { default: modelId };
  return {
    ...base,
    general: { ...general, maxAttempts: 1, retryFetchErrors: false },
    experimental: {
      ...experimental,
      dynamicModelConfiguration: true,
      gemmaModelRouter: { enabled: false },
    },
    modelConfigs: {
      // Gemini CLI model aliases, overrides, and ID resolutions can all change
      // the actual model. Replace that routing surface so authorization and
      // reporting stay bound to the requested concrete model.
      aliases: {},
      customAliases: {},
      overrides: [],
      customOverrides: [],
      modelIdResolutions: { [modelId]: exactModelResolution },
      classifierIdResolutions: {
        flash: exactModelResolution,
        pro: exactModelResolution,
      },
      modelChains: {
        preview: [policy],
        default: [policy],
        lite: [policy],
        [modelId]: [policy],
      },
    },
    // The CLI otherwise discovers GEMINI.md in cwd parents and configured
    // include directories, which would violate prompt-only isolation.
    context: {
      includeDirectoryTree: false,
      discoveryMaxDirs: 1,
      memoryBoundaryMarkers: [],
      includeDirectories: [],
      loadMemoryFromIncludeDirectories: false,
    },
    telemetry: { ...telemetry, logPrompts: false },
  };
}

function applyGeminiCliToolAvailability(
  base: Record<string, unknown>,
  availability: CliBackendToolAvailability,
): Record<string, unknown> {
  if (availability.native.length > 0) {
    throw new Error("Gemini CLI cannot expose backend-native tools in an exact restricted run.");
  }
  const mcpServers = isRecord(base.mcpServers) ? { ...base.mcpServers } : {};
  // A fully empty cap must not require the loopback server: tool-free handoffs
  // intentionally suppress that runtime before backend preparation.
  const exposesOpenClawTools = availability.openClaw.length > 0;
  let restrictedMcpServers: Record<string, unknown> = {};
  if (exposesOpenClawTools) {
    const openClawMcpServer = mcpServers.openclaw;
    if (!isRecord(openClawMcpServer)) {
      throw new Error("Gemini CLI exact tool availability requires the OpenClaw MCP server.");
    }
    restrictedMcpServers = {
      openclaw: {
        ...openClawMcpServer,
        includeTools: [...availability.openClaw],
      },
    };
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
  // Gemini treats an empty MCP allowlist as unrestricted. Use a per-run name
  // that no inherited server can know when this run must expose no MCP tools.
  const allowedMcpServers = exposesOpenClawTools ? ["openclaw"] : [crypto.randomUUID()];
  const experimental = isRecord(base.experimental) ? { ...base.experimental } : {};
  const agents = isRecord(base.agents) ? { ...base.agents } : {};
  const agentOverrides = isRecord(agents.overrides) ? { ...agents.overrides } : {};
  const hooksConfig = isRecord(base.hooksConfig) ? { ...base.hooksConfig } : {};
  const skills = isRecord(base.skills) ? { ...base.skills } : {};
  return {
    ...base,
    tools: {
      ...nonAuthorityToolSettings,
      core: exposesOpenClawTools ? ["mcp_openclaw_*"] : [],
      discoveryCommand: "",
      callCommand: "",
    },
    mcp: {
      ...nonAuthorityMcpSettings,
      allowed: allowedMcpServers,
      serverCommand: "",
    },
    mcpServers: restrictedMcpServers,
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
  await writeGeminiCliPrivateFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function createGeminiCliPrivateTempDir(prefix: string): Promise<string> {
  const directory = await fs.mkdtemp(path.join(resolvePreferredOpenClawTmpDir(), prefix));
  try {
    await fs.chmod(directory, 0o700);
    return directory;
  } catch (error) {
    // Preparation has no cleanup callback yet, so remove a partially secured
    // directory here rather than leaking it when chmod fails.
    await fs.rm(directory, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

async function writeGeminiCliPrivateFile(filePath: string, value: string): Promise<void> {
  const tempPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${crypto.randomUUID()}.tmp`,
  );
  await fs.writeFile(tempPath, value, {
    encoding: "utf8",
    mode: 0o600,
  });
  await fs.chmod(tempPath, 0o600);
  await fs.rename(tempPath, filePath);
  await fs.chmod(filePath, 0o600);
}

async function stageGeminiCliIsolatedCwd(ctx: GeminiCliAuthHomeContext): Promise<void> {
  const cwd = normalizeString(ctx.isolatedCompletionCwd);
  if (!cwd) {
    return;
  }
  // Gemini stops at the first dotenv it finds. The empty file prevents parent
  // temp directories from changing the already validated child environment.
  await writeGeminiCliPrivateFile(path.join(cwd, ".env"), "");
}

async function prepareGeminiCliProfileHome(
  ctx: GeminiCliAuthHomeContext,
  selectedType: GeminiCliAuthSelectedType,
): Promise<{
  home: string;
  geminiDir: string;
  systemSettingsPath: string;
  isolatedSystemPromptPath?: string;
  beforeExecution: () => Promise<void>;
  cleanup: () => Promise<void>;
}> {
  const settings = buildGeminiCliAuthSettings(selectedType);
  const systemSettings = await buildGeminiCliSystemSettings(ctx, selectedType);
  const isolated = ctx.isolatedCompletionSystemPrompt !== undefined;
  const exactToolAvailability = ctx.toolAvailability !== undefined;
  // Validate persistent profile ownership before allocating per-run state. A
  // validation failure cannot return the cleanup callback below.
  const persistentProfileHome =
    isolated || exactToolAvailability ? undefined : resolveGeminiCliProfileHome(ctx);
  const systemSettingsDir = await createGeminiCliPrivateTempDir("openclaw-gemini-cli-");
  const { home, geminiDir } = persistentProfileHome ?? {
    home: path.join(systemSettingsDir, "home"),
    geminiDir: path.join(systemSettingsDir, "home", ".gemini"),
  };
  const systemSettingsPath = path.join(systemSettingsDir, "settings.json");
  const isolatedSystemPrompt = ctx.isolatedCompletionSystemPrompt;
  const isolatedSystemPromptPath = isolated ? path.join(systemSettingsDir, "system.md") : undefined;
  return {
    home,
    geminiDir,
    systemSettingsPath,
    ...(isolatedSystemPromptPath ? { isolatedSystemPromptPath } : {}),
    beforeExecution: async () => {
      await stageGeminiCliIsolatedCwd(ctx);
      await fs.mkdir(geminiDir, { recursive: true, mode: 0o700 });
      await fs.chmod(home, 0o700);
      await fs.chmod(geminiDir, 0o700);
      await Promise.all([
        writeGeminiCliJson(path.join(geminiDir, "settings.json"), settings),
        writeGeminiCliJson(path.join(home, "settings.json"), settings),
        writeGeminiCliJson(systemSettingsPath, systemSettings),
        ...(isolatedSystemPromptPath && isolatedSystemPrompt !== undefined
          ? [writeGeminiCliPrivateFile(isolatedSystemPromptPath, isolatedSystemPrompt)]
          : []),
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
): Promise<GeminiCliPreparedExecution | null> {
  const oauth = requireGeminiOAuthCredential(credential);
  if (!oauth) {
    return null;
  }
  if (ctx.toolAvailability !== undefined) {
    const message =
      "Gemini CLI exact tool availability does not support OAuth; Code Assist auth can inject administrator-required tools.";
    throw ctx.isolatedCompletionSystemPrompt === undefined
      ? new Error(message)
      : isolatedCompletionUnsupportedError(message);
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
      ...(profileHome.isolatedSystemPromptPath
        ? { GEMINI_SYSTEM_MD: profileHome.isolatedSystemPromptPath }
        : {}),
      ...(profileHome.isolatedSystemPromptPath ? { GEMINI_TELEMETRY_LOG_PROMPTS: "false" } : {}),
    },
    clearEnv: [
      ...GEMINI_CLI_PROFILE_AUTH_ENV,
      ...GEMINI_CLI_PROFILE_SETTINGS_ENV,
      ...(profileHome.isolatedSystemPromptPath
        ? ["GEMINI_SYSTEM_MD", "GEMINI_CLI_HOME", "GEMINI_TELEMETRY_LOG_PROMPTS"]
        : []),
    ],
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
): Promise<GeminiCliPreparedExecution | null> {
  const apiKey = requireGeminiApiKeyCredential(credential);
  if (!apiKey) {
    return null;
  }
  const isolatedCompletionEnforced = assertGeminiCliLiteralIsolatedPrompt(ctx);
  const exactToolAvailability = ctx.toolAvailability !== undefined;

  const restrictedTransportEnv = exactToolAvailability
    ? await resolveGeminiCliTrustedTransportEnv(ctx)
    : undefined;
  const profileHome = await prepareGeminiCliProfileHome(ctx, "gemini-api-key");
  return {
    env: {
      GEMINI_CLI_HOME: profileHome.home,
      GEMINI_CLI_SYSTEM_SETTINGS_PATH: profileHome.systemSettingsPath,
      GEMINI_FORCE_FILE_STORAGE: "true",
      GEMINI_API_KEY: apiKey.key,
      ...(exactToolAvailability ? GEMINI_CLI_EXACT_TOOL_ENV_BARRIERS : {}),
      ...restrictedTransportEnv,
      ...(profileHome.isolatedSystemPromptPath
        ? { GEMINI_SYSTEM_MD: profileHome.isolatedSystemPromptPath }
        : {}),
      ...(profileHome.isolatedSystemPromptPath ? { GEMINI_TELEMETRY_LOG_PROMPTS: "false" } : {}),
    },
    clearEnv: [
      ...GEMINI_CLI_PROFILE_AUTH_ENV,
      ...GEMINI_CLI_PROFILE_SETTINGS_ENV,
      ...(exactToolAvailability ? ["GEMINI_CLI_HOME"] : []),
      ...(profileHome.isolatedSystemPromptPath
        ? ["GEMINI_SYSTEM_MD", "GEMINI_TELEMETRY_LOG_PROMPTS"]
        : []),
      ...(exactToolAvailability ? Object.keys(GEMINI_CLI_EXACT_TOOL_ENV_BARRIERS) : []),
      ...Object.keys(restrictedTransportEnv ?? {}),
    ],
    beforeExecution: async () => {
      await profileHome.beforeExecution();
      await Promise.all([
        fs.rm(path.join(profileHome.geminiDir, "oauth_creds.json"), { force: true }),
        clearGeminiCliCachedCredentials(profileHome.geminiDir),
      ]);
    },
    cleanup: profileHome.cleanup,
    ...(isolatedCompletionEnforced ? { isolatedCompletionEnforced: true as const } : {}),
  };
}

async function prepareGeminiCliRestrictedSystemSettings(
  ctx: GeminiCliAuthHomeContext,
): Promise<GeminiCliPreparedExecution> {
  const isolated = ctx.isolatedCompletionSystemPrompt !== undefined;
  const isolatedCompletionEnforced = assertGeminiCliLiteralIsolatedPrompt(ctx);
  const ambientAuth = await resolveGeminiCliAmbientAuth(ctx);
  const settings = await buildGeminiCliSystemSettings(
    ctx,
    ambientAuth.selectedType,
    ambientAuth.safeSettings,
  );
  const systemSettingsDir = await createGeminiCliPrivateTempDir("openclaw-gemini-cli-policy-");
  const systemSettingsPath = path.join(systemSettingsDir, "settings.json");
  const isolatedSystemPrompt = ctx.isolatedCompletionSystemPrompt;
  const isolatedSystemPromptPath = isolated ? path.join(systemSettingsDir, "system.md") : undefined;
  const restrictedHome = path.join(systemSettingsDir, "home");
  return {
    env: {
      GEMINI_CLI_SYSTEM_SETTINGS_PATH: systemSettingsPath,
      GEMINI_CLI_HOME: restrictedHome,
      ...(isolatedSystemPromptPath ? { GEMINI_SYSTEM_MD: isolatedSystemPromptPath } : {}),
      ...(isolated ? { GEMINI_TELEMETRY_LOG_PROMPTS: "false" } : {}),
      ...ambientAuth.envOverrides,
    },
    clearEnv: [
      // Exact-tool runs clear and restage the resolved auth into a private home.
      // Otherwise installed extensions or user state could widen the tool set.
      ...GEMINI_CLI_PROFILE_AUTH_ENV,
      ...GEMINI_CLI_PROFILE_SETTINGS_ENV,
      "GEMINI_CLI_HOME",
      ...(isolatedSystemPromptPath ? ["GEMINI_SYSTEM_MD", "GEMINI_TELEMETRY_LOG_PROMPTS"] : []),
      ...Object.keys(ambientAuth.envOverrides),
    ],
    beforeExecution: async () => {
      await stageGeminiCliIsolatedCwd(ctx);
      await fs.mkdir(restrictedHome, { recursive: true, mode: 0o700 });
      await fs.chmod(restrictedHome, 0o700);
      await Promise.all([
        writeGeminiCliJson(systemSettingsPath, settings),
        ...(isolatedSystemPromptPath && isolatedSystemPrompt !== undefined
          ? [writeGeminiCliPrivateFile(isolatedSystemPromptPath, isolatedSystemPrompt)]
          : []),
      ]);
    },
    cleanup: async () => {
      await fs.rm(systemSettingsDir, { recursive: true, force: true });
    },
    toolAvailabilityEnforced: true,
    ...(isolatedCompletionEnforced ? { isolatedCompletionEnforced: true as const } : {}),
  };
}

export async function prepareGeminiCliExecution(
  ctx: GeminiCliAuthHomeContext,
  credential: unknown,
): Promise<GeminiCliPreparedExecution | null> {
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
