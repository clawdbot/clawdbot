// NEVER convert to top-level imports - breaks browser/Vite builds
let existsSync: typeof import("node:fs").existsSync | null = null;
let homedir: typeof import("node:os").homedir | null = null;
let join: typeof import("node:path").join | null = null;

type DynamicImport = (specifier: string) => Promise<unknown>;
type NodeBuiltinModule =
  | typeof import("node:fs")
  | typeof import("node:os")
  | typeof import("node:path");

const dynamicImport: DynamicImport = (specifier) => import(specifier);
const NODE_FS_SPECIFIER = "node:fs";
const NODE_OS_SPECIFIER = "node:os";
const NODE_PATH_SPECIFIER = "node:path";

function loadNodeBuiltinModule(specifier: string): NodeBuiltinModule | null {
  const getBuiltinModule = (typeof process !== "undefined" ? process : undefined) as
    | (NodeJS.Process & { getBuiltinModule?: (id: string) => unknown })
    | undefined;
  if (typeof getBuiltinModule?.getBuiltinModule === "function") {
    return getBuiltinModule.getBuiltinModule(specifier) as NodeBuiltinModule;
  }
  if (typeof require === "function") {
    return require(specifier) as NodeBuiltinModule;
  }
  return null;
}

function loadNodeHelpersSync(): boolean {
  try {
    const fsModule = loadNodeBuiltinModule(NODE_FS_SPECIFIER) as typeof import("node:fs") | null;
    const osModule = loadNodeBuiltinModule(NODE_OS_SPECIFIER) as typeof import("node:os") | null;
    const pathModule = loadNodeBuiltinModule(NODE_PATH_SPECIFIER) as
      | typeof import("node:path")
      | null;
    existsSync ??= fsModule?.existsSync ?? null;
    homedir ??= osModule?.homedir ?? null;
    join ??= pathModule?.join ?? null;
    if (!existsSync || !homedir || !join) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

// Eagerly load in Node.js/Bun environment only
if (typeof process !== "undefined" && (process.versions?.node || process.versions?.bun)) {
  if (!loadNodeHelpersSync()) {
    void dynamicImport(NODE_FS_SPECIFIER).then((m) => {
      existsSync = (m as typeof import("node:fs")).existsSync;
    });
    void dynamicImport(NODE_OS_SPECIFIER).then((m) => {
      homedir = (m as typeof import("node:os")).homedir;
    });
    void dynamicImport(NODE_PATH_SPECIFIER).then((m) => {
      join = (m as typeof import("node:path")).join;
    });
  }
}

let procEnvCache: Map<string, string> | null = null;

function getProcessEnv(): NodeJS.ProcessEnv | undefined {
  return typeof process === "undefined" ? undefined : process.env;
}

/**
 * Fallback for https://github.com/oven-sh/bun/issues/27802
 * Bun compiled binaries have an empty `process.env` inside sandbox
 * environments on Linux. We can recover the env from `/proc/self/environ`.
 */
function getProcEnv(key: string): string | undefined {
  if (typeof process === "undefined" || !process.versions?.bun) {
    return undefined;
  }
  const env = getProcessEnv();
  if (!env) {
    return undefined;
  }

  // If process.env already has entries, the bug is not triggered.
  if (Object.keys(env).length > 0) {
    return undefined;
  }

  if (procEnvCache === null) {
    procEnvCache = new Map();
    try {
      const fsModule = loadNodeBuiltinModule(NODE_FS_SPECIFIER) as typeof import("node:fs") | null;
      if (!fsModule) {
        return undefined;
      }
      const data = fsModule.readFileSync("/proc/self/environ", "utf-8");
      for (const entry of data.split("\0")) {
        const idx = entry.indexOf("=");
        if (idx > 0) {
          procEnvCache.set(entry.slice(0, idx), entry.slice(idx + 1));
        }
      }
    } catch {
      // /proc/self/environ may not be readable.
    }
  }

  return procEnvCache.get(key);
}

function getEnvValue(key: string): string | undefined {
  return getProcessEnv()?.[key] || getProcEnv(key);
}

let cachedVertexAdcCredentialsExists: true | null = null;

function hasVertexAdcCredentials(): boolean {
  if (cachedVertexAdcCredentialsExists === null) {
    if (!existsSync || !homedir || !join) {
      const isNode =
        typeof process !== "undefined" && (process.versions?.node || process.versions?.bun);
      if (!isNode || !loadNodeHelpersSync()) {
        return false;
      }
    }
    const nodeExistsSync = existsSync;
    const nodeHomedir = homedir;
    const nodeJoin = join;
    if (!nodeExistsSync || !nodeHomedir || !nodeJoin) {
      return false;
    }

    // Check GOOGLE_APPLICATION_CREDENTIALS env var first (standard way)
    const gacPath = getEnvValue("GOOGLE_APPLICATION_CREDENTIALS");
    if (gacPath) {
      cachedVertexAdcCredentialsExists = nodeExistsSync(gacPath) ? true : null;
    } else {
      // Fall back to default ADC path (lazy evaluation)
      cachedVertexAdcCredentialsExists = nodeExistsSync(
        nodeJoin(nodeHomedir(), ".config", "gcloud", "application_default_credentials.json"),
      )
        ? true
        : null;
    }
  }
  return cachedVertexAdcCredentialsExists === true;
}

function getApiKeyEnvVars(provider: string): readonly string[] | undefined {
  if (provider === "github-copilot") {
    return ["COPILOT_GITHUB_TOKEN"];
  }

  // ANTHROPIC_OAUTH_TOKEN takes precedence over ANTHROPIC_API_KEY
  if (provider === "anthropic") {
    return ["ANTHROPIC_OAUTH_TOKEN", "ANTHROPIC_API_KEY"];
  }

  if (provider === "moonshot") {
    return ["MOONSHOT_API_KEY", "KIMI_API_KEY"];
  }

  if (provider === "kimi" || provider === "kimi-coding") {
    return ["KIMI_API_KEY", "KIMICODE_API_KEY"];
  }

  const envMap: Record<string, string> = {
    openai: "OPENAI_API_KEY",
    "meta": "MODEL_API_KEY",
    "azure-openai-responses": "AZURE_OPENAI_API_KEY",
    deepseek: "DEEPSEEK_API_KEY",
    google: "GEMINI_API_KEY",
    "google-vertex": "GOOGLE_CLOUD_API_KEY",
    groq: "GROQ_API_KEY",
    cerebras: "CEREBRAS_API_KEY",
    xai: "XAI_API_KEY",
    openrouter: "OPENROUTER_API_KEY",
    "vercel-ai-gateway": "AI_GATEWAY_API_KEY",
    zai: "ZAI_API_KEY",
    mistral: "MISTRAL_API_KEY",
    minimax: "MINIMAX_API_KEY",
    "minimax-cn": "MINIMAX_CN_API_KEY",
    moonshotai: "MOONSHOT_API_KEY",
    "moonshotai-cn": "MOONSHOT_API_KEY",
    huggingface: "HF_TOKEN",
    fireworks: "FIREWORKS_API_KEY",
    together: "TOGETHER_API_KEY",
    opencode: "OPENCODE_API_KEY",
    "opencode-go": "OPENCODE_API_KEY",
    "cloudflare-workers-ai": "CLOUDFLARE_API_KEY",
    "cloudflare-ai-gateway": "CLOUDFLARE_API_KEY",
    xiaomi: "XIAOMI_API_KEY",
    "xiaomi-token-plan-cn": "XIAOMI_TOKEN_PLAN_CN_API_KEY",
    "xiaomi-token-plan-ams": "XIAOMI_TOKEN_PLAN_AMS_API_KEY",
    "xiaomi-token-plan-sgp": "XIAOMI_TOKEN_PLAN_SGP_API_KEY",
  };

  const envVar = envMap[provider];
  return envVar ? [envVar] : undefined;
}

/**
 * Find configured environment variables that can provide an API key for a provider.
 *
 * This only reports actual API key variables. It intentionally excludes ambient
 * credential sources such as AWS profiles, AWS IAM credentials, and Google
 * Application Default Credentials.
 */
export function findEnvKeys(provider: string): string[] | undefined {
  const envVars = getApiKeyEnvVars(provider);
  if (!envVars) {
    return undefined;
  }

  const found = envVars.filter((envVar) => Boolean(getEnvValue(envVar)));
  return found.length > 0 ? found : undefined;
}

/**
 * Get API key for provider from known environment variables, e.g. OPENAI_API_KEY.
 *
 * Will not return API keys for providers that require OAuth tokens.
 */
export function getEnvApiKey(provider: string): string | undefined {
  const envKeys = findEnvKeys(provider);
  if (envKeys?.[0]) {
    return getEnvValue(envKeys[0]);
  }

  // Vertex AI supports either an explicit API key or Application Default Credentials.
  // Auth is configured via `gcloud auth application-default login`.
  if (provider === "google-vertex") {
    const hasCredentials = hasVertexAdcCredentials();
    const hasProject = Boolean(
      getEnvValue("GOOGLE_CLOUD_PROJECT") || getEnvValue("GCLOUD_PROJECT"),
    );
    const hasLocation = Boolean(getEnvValue("GOOGLE_CLOUD_LOCATION"));

    if (hasCredentials && hasProject && hasLocation) {
      return "<authenticated>";
    }
  }

  if (provider === "amazon-bedrock") {
    // Amazon Bedrock supports multiple credential sources:
    // 1. AWS_PROFILE - named profile from ~/.aws/credentials
    // 2. AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY - standard IAM keys
    // 3. AWS_BEARER_TOKEN_BEDROCK - Bedrock bearer token
    // 4. AWS_CONTAINER_CREDENTIALS_RELATIVE_URI - ECS task roles
    // 5. AWS_CONTAINER_CREDENTIALS_FULL_URI - ECS task roles (full URI)
    // 6. AWS_WEB_IDENTITY_TOKEN_FILE - IRSA (IAM Roles for Service Accounts)
    if (
      getEnvValue("AWS_PROFILE") ||
      (getEnvValue("AWS_ACCESS_KEY_ID") && getEnvValue("AWS_SECRET_ACCESS_KEY")) ||
      getEnvValue("AWS_BEARER_TOKEN_BEDROCK") ||
      getEnvValue("AWS_CONTAINER_CREDENTIALS_RELATIVE_URI") ||
      getEnvValue("AWS_CONTAINER_CREDENTIALS_FULL_URI") ||
      getEnvValue("AWS_WEB_IDENTITY_TOKEN_FILE")
    ) {
      return "<authenticated>";
    }
  }

  return undefined;
}
