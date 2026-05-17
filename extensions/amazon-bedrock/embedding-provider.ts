import {
  debugEmbeddingsLog,
  sanitizeAndNormalizeEmbedding,
  type MemoryEmbeddingProvider,
  type MemoryEmbeddingProviderCreateOptions,
} from "openclaw/plugin-sdk/memory-core-host-engine-embeddings";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import { refreshAwsSharedConfigCacheForBedrock } from "./aws-credential-refresh.js";

// ---------------------------------------------------------------------------
// Types & constants
// ---------------------------------------------------------------------------

type BedrockEmbeddingClient = {
  region: string;
  model: string;
  dimensions?: number;
};

export const DEFAULT_BEDROCK_EMBEDDING_MODEL = "amazon.titan-embed-text-v2:0";

/** Request/response format family — each has a different API shape. */
type Family = "titan-v1" | "titan-v2" | "cohere-v3" | "cohere-v4" | "nova" | "twelvelabs";

interface ModelSpec {
  maxTokens: number;
  dims: number;
  validDims?: number[];
  family: Family;
}

// ---------------------------------------------------------------------------
// Model catalog
// ---------------------------------------------------------------------------

const MODELS: Record<string, ModelSpec> = {
  "amazon.titan-embed-text-v2:0": {
    maxTokens: 8192,
    dims: 1024,
    validDims: [256, 512, 1024],
    family: "titan-v2",
  },
  "amazon.titan-embed-text-v1": { maxTokens: 8000, dims: 1536, family: "titan-v1" },
  "amazon.titan-embed-g1-text-02": { maxTokens: 8000, dims: 1536, family: "titan-v1" },
  "amazon.titan-embed-image-v1": { maxTokens: 128, dims: 1024, family: "titan-v1" },
  "cohere.embed-english-v3": { maxTokens: 512, dims: 1024, family: "cohere-v3" },
  "cohere.embed-multilingual-v3": { maxTokens: 512, dims: 1024, family: "cohere-v3" },
  "cohere.embed-v4:0": {
    maxTokens: 128000,
    dims: 1536,
    validDims: [256, 384, 512, 768, 1024, 1536],
    family: "cohere-v4",
  },
  "amazon.nova-2-multimodal-embeddings-v1:0": {
    maxTokens: 8192,
    dims: 1024,
    validDims: [256, 384, 1024, 3072],
    family: "nova",
  },
  "twelvelabs.marengo-embed-2-7-v1:0": { maxTokens: 512, dims: 1024, family: "twelvelabs" },
  "twelvelabs.marengo-embed-3-0-v1:0": { maxTokens: 512, dims: 512, family: "twelvelabs" },
};

/** Resolve spec, stripping throughput suffixes like `:2:8k` or `:0:512`. */
function resolveSpec(modelId: string): ModelSpec | undefined {
  if (MODELS[modelId]) {
    return MODELS[modelId];
  }
  const parts = modelId.split(":");
  for (let i = parts.length - 1; i >= 1; i--) {
    const spec = MODELS[parts.slice(0, i).join(":")];
    if (spec) {
      return spec;
    }
  }
  return undefined;
}

/** Infer family from model ID prefix when not in catalog. */
function inferFamily(modelId: string): Family {
  const id = normalizeLowercaseStringOrEmpty(modelId);
  if (id.startsWith("amazon.titan-embed-text-v2")) {
    return "titan-v2";
  }
  if (id.startsWith("amazon.titan-embed")) {
    return "titan-v1";
  }
  if (id.startsWith("amazon.nova")) {
    return "nova";
  }
  if (id.startsWith("cohere.embed-v4")) {
    return "cohere-v4";
  }
  if (id.startsWith("cohere.embed")) {
    return "cohere-v3";
  }
  if (id.startsWith("twelvelabs.")) {
    return "twelvelabs";
  }
  return "titan-v1"; // safest default — simplest request format
}

// ---------------------------------------------------------------------------
// AWS SDK lazy loader
// ---------------------------------------------------------------------------

type SdkClient = import("@aws-sdk/client-bedrock-runtime").BedrockRuntimeClient;
type SdkCommand = import("@aws-sdk/client-bedrock-runtime").InvokeModelCommand;

interface AwsSdk {
  BedrockRuntimeClient: new (config: { region: string }) => SdkClient;
  InvokeModelCommand: new (input: {
    modelId: string;
    body: string;
    contentType: string;
    accept: string;
  }) => SdkCommand;
}

interface AwsCredentialProviderSdk {
  defaultProvider: (init?: { timeout?: number; maxRetries?: number }) => () => Promise<{
    accessKeyId?: string;
  }>;
}

type AwsCredentialProviderLoader = () => Promise<AwsCredentialProviderSdk | null>;

let sdkCache: AwsSdk | null = null;
let credentialProviderSdkCache: AwsCredentialProviderSdk | null | undefined;

async function loadSdk(): Promise<AwsSdk> {
  if (sdkCache) {
    return sdkCache;
  }
  try {
    sdkCache = (await import("@aws-sdk/client-bedrock-runtime")) as unknown as AwsSdk;
    return sdkCache;
  } catch {
    throw new Error(
      "No API key found for provider bedrock: @aws-sdk/client-bedrock-runtime is not installed. " +
        "Install it with: npm install @aws-sdk/client-bedrock-runtime",
    );
  }
}

async function loadCredentialProviderSdk(): Promise<AwsCredentialProviderSdk | null> {
  if (credentialProviderSdkCache !== undefined) {
    return credentialProviderSdkCache;
  }
  try {
    credentialProviderSdkCache =
      (await import("@aws-sdk/credential-provider-node")) as unknown as AwsCredentialProviderSdk;
  } catch {
    credentialProviderSdkCache = null;
  }
  return credentialProviderSdkCache;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MODEL_PREFIX_RE = /^(?:bedrock|amazon-bedrock|aws)\//;
const REGION_RE = /bedrock-runtime\.([a-z0-9-]+)\./;

function normalizeBedrockEmbeddingModel(model: string): string {
  const trimmed = model.trim();
  return trimmed ? trimmed.replace(MODEL_PREFIX_RE, "") : DEFAULT_BEDROCK_EMBEDDING_MODEL;
}

function regionFromUrl(url: string | undefined): string | undefined {
  return url?.trim() ? REGION_RE.exec(url)?.[1] : undefined;
}

// ---------------------------------------------------------------------------
// Request builders
// ---------------------------------------------------------------------------

function buildBody(family: Family, text: string, dims?: number): string {
  switch (family) {
    case "titan-v2": {
      const b: Record<string, unknown> = { inputText: text };
      if (dims != null) {
        b.dimensions = dims;
        b.normalize = true;
      }
      return JSON.stringify(b);
    }
    case "titan-v1":
      return JSON.stringify({ inputText: text });
    case "nova":
      return JSON.stringify({
        taskType: "SINGLE_EMBEDDING",
        singleEmbeddingParams: {
          embeddingPurpose: "GENERIC_INDEX",
          embeddingDimension: dims ?? 1024,
          text: { truncationMode: "END", value: text },
        },
      });
    case "twelvelabs":
      return JSON.stringify({ inputType: "text", text: { inputText: text } });
    default:
      return JSON.stringify({ inputText: text });
  }
}

function buildCohereBody(
  family: Family,
  texts: string[],
  inputType: "search_query" | "search_document",
  dims?: number,
): string {
  const body: Record<string, unknown> = { texts, input_type: inputType, truncate: "END" };
  if (family === "cohere-v4") {
    body.embedding_types = ["float"];
    if (dims != null) {
      body.output_dimension = dims;
    }
  }
  return JSON.stringify(body);
}

// ---------------------------------------------------------------------------
// Response parsers
// ---------------------------------------------------------------------------

type BedrockEmbeddingResponseJson = {
  embedding?: unknown;
  embeddings?: unknown;
  data?: unknown;
};

function parseBedrockEmbeddingResponseJson(raw: string): BedrockEmbeddingResponseJson {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Amazon Bedrock embedding response returned malformed JSON");
    }
    return parsed as BedrockEmbeddingResponseJson;
  } catch {
    throw new Error("Amazon Bedrock embedding response returned malformed JSON");
  }
}

function malformedBedrockEmbeddingResponse(): Error {
  return new Error("Amazon Bedrock embedding response returned malformed JSON");
}

function asNumberArray(value: unknown): number[] {
  if (!Array.isArray(value)) {
    throw malformedBedrockEmbeddingResponse();
  }
  for (const entry of value) {
    if (typeof entry !== "number" || !Number.isFinite(entry)) {
      throw malformedBedrockEmbeddingResponse();
    }
  }
  return value;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asNumberArrayBatch(value: unknown): number[][] {
  if (!Array.isArray(value)) {
    throw malformedBedrockEmbeddingResponse();
  }
  return value.map((entry) => asNumberArray(entry));
}

function parseSingle(family: Family, raw: string): number[] {
  const data = parseBedrockEmbeddingResponseJson(raw);
  switch (family) {
    case "nova":
      return asNumberArray(Array.isArray(data.embeddings) ? data.embeddings[0]?.embedding : null);
    case "twelvelabs": {
      if (Array.isArray(data.data)) {
        return asNumberArray(asRecord(data.data[0])?.embedding);
      }
      const dataRecord = asRecord(data.data);
      if (dataRecord) {
        return asNumberArray(dataRecord.embedding);
      }
      return asNumberArray(data.embedding);
    }
    default:
      return asNumberArray(data.embedding);
  }
}

function parseCohereBatch(family: Family, raw: string): number[][] {
  const data = parseBedrockEmbeddingResponseJson(raw);
  const embeddings = data.embeddings;
  if (!embeddings) {
    throw malformedBedrockEmbeddingResponse();
  }
  if (family === "cohere-v4" && !Array.isArray(embeddings)) {
    const embeddingRecord = asRecord(embeddings);
    if (!embeddingRecord) {
      throw malformedBedrockEmbeddingResponse();
    }
    return asNumberArrayBatch(embeddingRecord.float);
  }
  return asNumberArrayBatch(embeddings);
}

export const __testing = {
  parseCohereBatch,
  parseSingle,
};

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export async function createBedrockEmbeddingProvider(
  options: MemoryEmbeddingProviderCreateOptions,
): Promise<{ provider: MemoryEmbeddingProvider; client: BedrockEmbeddingClient }> {
  const client = resolveBedrockEmbeddingClient(options);
  const { BedrockRuntimeClient, InvokeModelCommand } = await loadSdk();
  const spec = resolveSpec(client.model);
  const family = spec?.family ?? inferFamily(client.model);

  debugEmbeddingsLog("memory embeddings: bedrock client", {
    region: client.region,
    model: client.model,
    dimensions: client.dimensions,
    family,
  });

  const invoke = async (body: string, signal?: AbortSignal): Promise<string> => {
    await refreshAwsSharedConfigCacheForBedrock();
    const sdk = new BedrockRuntimeClient({ region: client.region });
    try {
      const res = await sdk.send(
        new InvokeModelCommand({
          modelId: client.model,
          body,
          contentType: "application/json",
          accept: "application/json",
        }),
        signal ? { abortSignal: signal } : undefined,
      );
      return new TextDecoder().decode(res.body);
    } finally {
      sdk.destroy();
    }
  };

  const isCohere = family === "cohere-v3" || family === "cohere-v4";

  const embedSingle = async (text: string, signal?: AbortSignal): Promise<number[]> => {
    const raw = await invoke(buildBody(family, text, client.dimensions), signal);
    return sanitizeAndNormalizeEmbedding(parseSingle(family, raw));
  };

  const embedCohere = async (
    texts: string[],
    inputType: "search_query" | "search_document",
    signal?: AbortSignal,
  ): Promise<number[][]> => {
    const raw = await invoke(buildCohereBody(family, texts, inputType, client.dimensions), signal);
    return parseCohereBatch(family, raw).map((e) => sanitizeAndNormalizeEmbedding(e));
  };

  const embedQuery = async (
    text: string,
    options?: { signal?: AbortSignal },
  ): Promise<number[]> => {
    if (!text.trim()) {
      return [];
    }
    if (isCohere) {
      return (await embedCohere([text], "search_query", options?.signal))[0] ?? [];
    }
    return embedSingle(text, options?.signal);
  };

  const embedBatch = async (
    texts: string[],
    options?: { signal?: AbortSignal },
  ): Promise<number[][]> => {
    if (texts.length === 0) {
      return [];
    }
    if (isCohere) {
      return embedCohere(texts, "search_document", options?.signal);
    }
    return Promise.all(
      texts.map((t) => (t.trim() ? embedSingle(t, options?.signal) : Promise.resolve([]))),
    );
  };

  return {
    provider: {
      id: "bedrock",
      model: client.model,
      maxInputTokens: spec?.maxTokens,
      embedQuery,
      embedBatch,
    },
    client,
  };
}

// ---------------------------------------------------------------------------
// Client resolution
// ---------------------------------------------------------------------------

function resolveBedrockEmbeddingClient(
  options: MemoryEmbeddingProviderCreateOptions,
): BedrockEmbeddingClient {
  const model = normalizeBedrockEmbeddingModel(options.model);
  const spec = resolveSpec(model);
  const providerConfig = options.config.models?.providers?.["amazon-bedrock"];

  const region =
    regionFromUrl(options.remote?.baseUrl) ??
    regionFromUrl(providerConfig?.baseUrl) ??
    process.env.AWS_REGION ??
    process.env.AWS_DEFAULT_REGION ??
    "us-east-1";

  let dimensions: number | undefined;
  if (options.outputDimensionality != null) {
    if (spec?.validDims && !spec.validDims.includes(options.outputDimensionality)) {
      throw new Error(
        `Invalid dimensions ${options.outputDimensionality} for ${model}. Valid values: ${spec.validDims.join(", ")}`,
      );
    }
    dimensions = options.outputDimensionality;
  } else {
    dimensions = spec?.dims;
  }

  return { region, model, dimensions };
}

// ---------------------------------------------------------------------------
// Credential detection
// ---------------------------------------------------------------------------

export async function hasAwsCredentials(
  env: NodeJS.ProcessEnv = process.env,
  loadCredentialProvider: AwsCredentialProviderLoader = loadCredentialProviderSdk,
): Promise<boolean> {
  if (env.AWS_ACCESS_KEY_ID?.trim() && env.AWS_SECRET_ACCESS_KEY?.trim()) {
    return true;
  }
  if (env.AWS_BEARER_TOKEN_BEDROCK?.trim()) {
    return true;
  }
  const credentialProviderSdk = await loadCredentialProvider();
  if (!credentialProviderSdk) {
    return false;
  }
  try {
    const credentials = await credentialProviderSdk.defaultProvider({
      timeout: 1000,
      maxRetries: 0,
    })();
    return typeof credentials.accessKeyId === "string" && credentials.accessKeyId.trim().length > 0;
  } catch {
    return false;
  }
}
