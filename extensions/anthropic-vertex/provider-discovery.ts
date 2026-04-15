import { readFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import type { ProviderCatalogContext } from "openclaw/plugin-sdk/provider-catalog-shared";
import type {
  ModelDefinitionConfig,
  ModelProviderConfig,
} from "openclaw/plugin-sdk/provider-model-shared";

const PROVIDER_ID = "anthropic-vertex";
const ANTHROPIC_VERTEX_DEFAULT_REGION = "global";
const ANTHROPIC_VERTEX_REGION_RE = /^[a-z0-9-]+$/;
const ANTHROPIC_VERTEX_DEFAULT_CONTEXT_WINDOW = 1_000_000;
const GCP_VERTEX_CREDENTIALS_MARKER = "gcp-vertex-credentials";
const GCLOUD_DEFAULT_ADC_PATH = join(
  homedir(),
  ".config",
  "gcloud",
  "application_default_credentials.json",
);

type AnthropicVertexProviderPlugin = {
  id: string;
  label: string;
  docsPath: string;
  auth: [];
  catalog: {
    order: "simple";
    run: (ctx: ProviderCatalogContext) => ReturnType<typeof runAnthropicVertexCatalog>;
  };
  resolveConfigApiKey: (params: { env: NodeJS.ProcessEnv }) => string | undefined;
};

type AdcProjectFile = {
  project_id?: unknown;
  quota_project_id?: unknown;
};

function normalizeOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalizeLowercaseStringOrEmpty(value: unknown): string {
  return normalizeOptionalString(value)?.toLowerCase() ?? "";
}

function resolveAnthropicVertexRegion(env: NodeJS.ProcessEnv = process.env): string {
  const region =
    normalizeOptionalString(env.GOOGLE_CLOUD_LOCATION) ||
    normalizeOptionalString(env.CLOUD_ML_REGION);

  return region && ANTHROPIC_VERTEX_REGION_RE.test(region)
    ? region
    : ANTHROPIC_VERTEX_DEFAULT_REGION;
}

function hasAnthropicVertexMetadataServerAdc(env: NodeJS.ProcessEnv = process.env): boolean {
  const explicitMetadataOptIn = normalizeOptionalString(env.ANTHROPIC_VERTEX_USE_GCP_METADATA);
  return (
    explicitMetadataOptIn === "1" ||
    normalizeLowercaseStringOrEmpty(explicitMetadataOptIn) === "true"
  );
}

function resolveAnthropicVertexDefaultAdcPath(env: NodeJS.ProcessEnv = process.env): string {
  return platform() === "win32"
    ? join(
        env.APPDATA ?? join(homedir(), "AppData", "Roaming"),
        "gcloud",
        "application_default_credentials.json",
      )
    : GCLOUD_DEFAULT_ADC_PATH;
}

function resolveAnthropicVertexAdcCredentialsPathCandidate(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const explicit = normalizeOptionalString(env.GOOGLE_APPLICATION_CREDENTIALS);
  if (explicit) {
    return explicit;
  }
  if (env !== process.env) {
    return undefined;
  }
  return resolveAnthropicVertexDefaultAdcPath(env);
}

function readAnthropicVertexAdc(env: NodeJS.ProcessEnv = process.env): AdcProjectFile | null {
  const credentialsPath = resolveAnthropicVertexAdcCredentialsPathCandidate(env);
  if (!credentialsPath) {
    return null;
  }
  try {
    return JSON.parse(readFileSync(credentialsPath, "utf8")) as AdcProjectFile;
  } catch {
    return null;
  }
}

function hasAnthropicVertexAvailableAuth(env: NodeJS.ProcessEnv = process.env): boolean {
  return hasAnthropicVertexMetadataServerAdc(env) || readAnthropicVertexAdc(env) !== null;
}

function resolveAnthropicVertexConfigApiKey(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  return hasAnthropicVertexAvailableAuth(env) ? GCP_VERTEX_CREDENTIALS_MARKER : undefined;
}

function buildAnthropicVertexModel(params: {
  id: string;
  name: string;
  reasoning: boolean;
  input: ModelDefinitionConfig["input"];
  cost: ModelDefinitionConfig["cost"];
  maxTokens: number;
}): ModelDefinitionConfig {
  return {
    id: params.id,
    name: params.name,
    reasoning: params.reasoning,
    input: params.input,
    cost: params.cost,
    contextWindow: ANTHROPIC_VERTEX_DEFAULT_CONTEXT_WINDOW,
    maxTokens: params.maxTokens,
  };
}

function buildAnthropicVertexProvider(params?: { env?: NodeJS.ProcessEnv }): ModelProviderConfig {
  const region = resolveAnthropicVertexRegion(params?.env);
  const baseUrl =
    normalizeLowercaseStringOrEmpty(region) === "global"
      ? "https://aiplatform.googleapis.com"
      : `https://${region}-aiplatform.googleapis.com`;

  return {
    baseUrl,
    api: "anthropic-messages",
    apiKey: GCP_VERTEX_CREDENTIALS_MARKER,
    models: [
      buildAnthropicVertexModel({
        id: "claude-opus-4-6",
        name: "Claude Opus 4.6",
        reasoning: true,
        input: ["text", "image"],
        cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
        maxTokens: 128000,
      }),
      buildAnthropicVertexModel({
        id: "claude-sonnet-4-6",
        name: "Claude Sonnet 4.6",
        reasoning: true,
        input: ["text", "image"],
        cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
        maxTokens: 128000,
      }),
    ],
  };
}

function mergeImplicitAnthropicVertexProvider(params: {
  existing?: ModelProviderConfig;
  implicit: ModelProviderConfig;
}) {
  const { existing, implicit } = params;
  if (!existing) {
    return implicit;
  }
  return {
    ...implicit,
    ...existing,
    models:
      Array.isArray(existing.models) && existing.models.length > 0
        ? existing.models
        : implicit.models,
  };
}

function resolveImplicitAnthropicVertexProvider(params?: { env?: NodeJS.ProcessEnv }) {
  const env = params?.env ?? process.env;
  if (!hasAnthropicVertexAvailableAuth(env)) {
    return null;
  }

  return buildAnthropicVertexProvider({ env });
}

async function runAnthropicVertexCatalog(ctx: ProviderCatalogContext) {
  const implicit = resolveImplicitAnthropicVertexProvider({
    env: ctx.env,
  });
  if (!implicit) {
    return null;
  }
  return {
    provider: mergeImplicitAnthropicVertexProvider({
      existing: ctx.config.models?.providers?.[PROVIDER_ID],
      implicit,
    }),
  };
}

export const anthropicVertexProviderDiscovery: AnthropicVertexProviderPlugin = {
  id: PROVIDER_ID,
  label: "Anthropic Vertex",
  docsPath: "/providers/models",
  auth: [],
  catalog: {
    order: "simple",
    run: runAnthropicVertexCatalog,
  },
  resolveConfigApiKey: ({ env }) => resolveAnthropicVertexConfigApiKey(env),
};

export default anthropicVertexProviderDiscovery;
