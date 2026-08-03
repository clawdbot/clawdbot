/**
 * Amazon Bedrock embedding provider runtime. It normalizes model-specific
 * request/response shapes across Titan, Cohere, Nova, and TwelveLabs models.
 */
import {
  debugEmbeddingsLog,
  sanitizeAndNormalizeEmbedding,
  type MemoryEmbeddingProvider,
  type MemoryEmbeddingProviderCreateOptions,
} from "openclaw/plugin-sdk/memory-core-host-engine-embeddings";
import {
  asOptionalRecord as asRecord,
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { refreshAwsSharedConfigCacheForBedrock } from "./aws-credential-refresh.js";

// ---------------------------------------------------------------------------
// Types & constants
// ---------------------------------------------------------------------------

type BedrockEmbeddingClient = {
  region: string;
  model: string;
  dimensions?: number;
  endpoint?: string;
};

/** Default Bedrock embedding model used when no explicit model is configured. */
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

/** Strip AWS inference profile prefix (us., eu., ap., apac., au., jp., global.) from model ID. */
function stripInferenceProfilePrefix(modelId: string): string {
  return modelId.replace(/^(?:us|eu|ap|apac|au|jp|global)\./, "");
}

/** Resolve spec, stripping throughput suffixes like `:2:8k` or `:0:512`. */
function resolveSpec(modelId: string): ModelSpec | undefined {
  const bare = stripInferenceProfilePrefix(modelId);
  if (MODELS[bare]) {
    return MODELS[bare];
  }
  const parts = bare.split(":");
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
  const id = normalizeLowercaseStringOrEmpty(stripInferenceProfilePrefix(modelId));
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

type AwsSdk = typeof import("@aws-sdk/client-bedrock-runtime");
type AwsCredentialProvider = typeof import("@aws-sdk/credential-provider-node").defaultProvider;
type AwsCredentialProviderLoader = () => Promise<AwsCredentialProvider | null>;

let sdkPromise: Promise<AwsSdk> | null = null;
let credentialProviderPromise: Promise<AwsCredentialProvider | null> | null = null;

async function loadSdk(): Promise<AwsSdk> {
  try {
    return await (sdkPromise ??= import("@aws-sdk/client-bedrock-runtime"));
  } catch {
    sdkPromise = null;
    throw new Error(
      "No API key found for provider bedrock: @aws-sdk/client-bedrock-runtime is not installed. " +
        "Install it with: npm install @aws-sdk/client-bedrock-runtime",
    );
  }
}

function loadDefaultCredentialProvider(): Promise<AwsCredentialProvider | null> {
  return (credentialProviderPromise ??= import("@aws-sdk/credential-provider-node")
    .then(({ defaultProvider }) => defaultProvider)
    .catch(() => null));
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MODEL_PREFIX_RE = /^(?:bedrock|amazon-bedrock|aws)\//;
const REGION_RE = /bedrock-runtime(?:-fips)?\.([a-z0-9-]+)\./u;

function normalizeBedrockEmbeddingModel(model: string): string {
  const trimmed = model.trim();
  return trimmed ? trimmed.replace(MODEL_PREFIX_RE, "") : DEFAULT_BEDROCK_EMBEDDING_MODEL;
}

function regionFromUrl(
  url: string | undefined,
  BedrockRuntimeClient: AwsSdk["BedrockRuntimeClient"],
): string | undefined {
  if (!url?.trim()) {
    return undefined;
  }
  try {
    const hostname = new URL(url).hostname;
    const region = REGION_RE.exec(hostname)?.[1];
    if (!region) {
      return undefined;
    }
    const sdk = new BedrockRuntimeClient({ region });
    try {
      const useFipsEndpoint = hostname.includes("bedrock-runtime-fips.");
      for (const useDualstackEndpoint of [false, true]) {
        try {
          const regionalHostname = sdk.config.endpointProvider({
            Region: region,
            UseFIPS: useFipsEndpoint,
            UseDualStack: useDualstackEndpoint,
          }).url.hostname;
          if (hostname === regionalHostname) {
            return region;
          }

          const servicePrefix = `bedrock-runtime${useFipsEndpoint ? "-fips" : ""}.${region}.`;
          const privateLinkHostname = `${servicePrefix}vpce.${regionalHostname.slice(servicePrefix.length)}`;
          if (hostname === privateLinkHostname || hostname.endsWith(`.${privateLinkHostname}`)) {
            return region;
          }
        } catch {
          // Some AWS partitions do not support every FIPS/dual-stack combination.
        }
      }
      return undefined;
    } finally {
      sdk.destroy();
    }
  } catch {
    return undefined;
  }
}

function normalizeBedrockEmbeddingEndpoint(value: string): string {
  const endpoint = new URL(value);
  endpoint.pathname = endpoint.pathname.replace(/\/+$/u, "");
  // URL keeps a root slash in href; remove only that pathname slash, never query/hash payload.
  return endpoint.pathname === "/" ? endpoint.href.replace(/\/(?=[?#]|$)/u, "") : endpoint.href;
}

function parseBedrockEndpointQuery(search: string): Record<string, string | string[]> {
  const valuesByName = new Map<string, string[]>();
  for (const parameter of search.slice(1).split("&")) {
    const separator = parameter.indexOf("=");
    const name = decodeURIComponent(separator < 0 ? parameter : parameter.slice(0, separator));
    // Smithy treats + literally; URLSearchParams would incorrectly sign it as a space.
    const value = decodeURIComponent(separator < 0 ? "" : parameter.slice(separator + 1));
    const existing = valuesByName.get(name);
    if (existing) {
      existing.push(value);
    } else {
      valuesByName.set(name, [value]);
    }
  }
  return Object.fromEntries(
    Array.from(valuesByName, ([name, values]) => [name, values.length === 1 ? values[0] : values]),
  );
}

async function resolveEffectiveBedrockEmbeddingEndpoint(
  client: BedrockEmbeddingClient,
  BedrockRuntimeClient: AwsSdk["BedrockRuntimeClient"],
): Promise<string | undefined> {
  const region = client.region;
  const sdk = new BedrockRuntimeClient({ region });
  const retainEndpoint = async (endpoint: string): Promise<string> => {
    // A FIPS region alias forces endpoint mode on even when SDK flags are explicitly disabled.
    client.region = await sdk.config.region();
    return endpoint;
  };
  let effectiveEndpoint = client.endpoint;
  try {
    const configuredSdkEndpoint = sdk.config.ignoreConfiguredEndpointUrls
      ? undefined
      : await sdk.config.serviceConfiguredEndpoint?.();
    effectiveEndpoint ??= configuredSdkEndpoint
      ? normalizeBedrockEmbeddingEndpoint(configuredSdkEndpoint)
      : undefined;
    if (!effectiveEndpoint) {
      return undefined;
    }

    const candidate = new URL(effectiveEndpoint);
    if (
      candidate.protocol !== "https:" ||
      candidate.port ||
      candidate.href !== `${candidate.origin}/`
    ) {
      return retainEndpoint(effectiveEndpoint);
    }

    const [useFipsEndpoint, useDualstackEndpoint] = await Promise.all([
      sdk.config.useFipsEndpoint(),
      sdk.config.useDualstackEndpoint(),
    ]);
    const regionalEndpoint = sdk.config.endpointProvider({
      Region: region,
      UseFIPS: useFipsEndpoint,
      UseDualStack: useDualstackEndpoint,
    });
    if (configuredSdkEndpoint) {
      const effectiveSdkEndpoint = sdk.config.endpointProvider({
        Region: region,
        UseFIPS: useFipsEndpoint,
        UseDualStack: useDualstackEndpoint,
        Endpoint: configuredSdkEndpoint,
      });
      // Only genuine regional URLs may lose identity; matching custom overrides stay explicit.
      return regionalEndpoint.url.href === candidate.href &&
        effectiveSdkEndpoint.url.href === candidate.href
        ? undefined
        : retainEndpoint(effectiveEndpoint);
    }
    if (regionalEndpoint.url.href === candidate.href) {
      return undefined;
    }

    // Plain regional config is shipped region metadata and must still inherit FIPS/dual-stack.
    return sdk.config.endpointProvider({ Region: region, UseFIPS: false, UseDualStack: false }).url
      .href === candidate.href
      ? undefined
      : retainEndpoint(effectiveEndpoint);
  } catch {
    // Invalid SDK endpoint modes must never turn an explicit operator endpoint into a fallback.
    return effectiveEndpoint ? retainEndpoint(effectiveEndpoint) : undefined;
  } finally {
    sdk.destroy();
  }
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

const testing = {
  parseCohereBatch,
  parseSingle,
  stripInferenceProfilePrefix,
};

if (process.env.VITEST === "true") {
  Reflect.set(globalThis, Symbol.for("openclaw.amazonBedrockEmbeddingTestApi"), testing);
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export async function createBedrockEmbeddingProvider(
  options: MemoryEmbeddingProviderCreateOptions,
): Promise<{ provider: MemoryEmbeddingProvider; client: BedrockEmbeddingClient }> {
  const { BedrockRuntimeClient, InvokeModelCommand } = await loadSdk();
  const client = resolveBedrockEmbeddingClient(options, BedrockRuntimeClient);
  const endpoint = await resolveEffectiveBedrockEmbeddingEndpoint(client, BedrockRuntimeClient);
  if (endpoint) {
    client.endpoint = endpoint;
  } else {
    // The SDK owns genuine regional endpoints, mode policy, and existing cache identity.
    delete client.endpoint;
  }
  const spec = resolveSpec(client.model);
  const family = spec?.family ?? inferFamily(client.model);

  debugEmbeddingsLog("memory embeddings: bedrock client", {
    region: client.region,
    model: client.model,
    dimensions: client.dimensions,
    family,
  });

  const endpointUrl = client.endpoint ? new URL(client.endpoint) : undefined;
  const endpointSearch = endpointUrl?.search;
  const endpointQuery = endpointSearch ? parseBedrockEndpointQuery(endpointSearch) : undefined;

  const invoke = async (body: string, signal?: AbortSignal): Promise<string> => {
    await refreshAwsSharedConfigCacheForBedrock();
    const sdk = new BedrockRuntimeClient({
      region: client.region,
      ...(client.endpoint
        ? { endpoint: client.endpoint, useFipsEndpoint: false, useDualstackEndpoint: false }
        : {}),
    });
    try {
      if (endpointQuery && endpointSearch) {
        // Smithy's EndpointV1 serializer drops endpoint query parameters; restore before signing.
        sdk.middlewareStack.add(
          (next) => (args) => {
            const request = asRecord(args.request);
            if (!request) {
              throw new Error("Amazon Bedrock SDK did not create an HTTP request");
            }
            request.query = { ...endpointQuery, ...asRecord(request.query) };
            return next(args);
          },
          { name: "bedrockCustomEndpointQuery", step: "build" },
        );
        sdk.middlewareStack.addRelativeTo(
          (next) => (args) => {
            const request = asRecord(args.request);
            if (!request || typeof request.path !== "string") {
              throw new Error("Amazon Bedrock SDK did not create a signed HTTP request");
            }
            // SigV4 canonicalizes the query bag; the post-sign wire path retains original ordering.
            request.path += endpointSearch;
            request.query = {};
            return next(args);
          },
          {
            name: "bedrockCustomEndpointWireQuery",
            relation: "after",
            toMiddleware: "httpSigningMiddleware",
          },
        );
      }
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
    optionsValue?: { signal?: AbortSignal },
  ): Promise<number[]> => {
    if (!text.trim()) {
      return [];
    }
    if (isCohere) {
      return (await embedCohere([text], "search_query", optionsValue?.signal))[0] ?? [];
    }
    return embedSingle(text, optionsValue?.signal);
  };

  const embedBatch = async (
    texts: string[],
    optionsLocal?: { signal?: AbortSignal },
  ): Promise<number[][]> => {
    if (texts.length === 0) {
      return [];
    }
    if (isCohere) {
      return embedCohere(texts, "search_document", optionsLocal?.signal);
    }
    return Promise.all(
      texts.map((t) => (t.trim() ? embedSingle(t, optionsLocal?.signal) : Promise.resolve([]))),
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
  BedrockRuntimeClient: AwsSdk["BedrockRuntimeClient"],
): BedrockEmbeddingClient {
  const model = normalizeBedrockEmbeddingModel(options.model);
  const spec = resolveSpec(model);
  const providerConfig = options.config.models?.providers?.["amazon-bedrock"];
  const configuredEndpointValue =
    normalizeOptionalString(options.remote?.baseUrl) ??
    normalizeOptionalString(providerConfig?.baseUrl);
  const configuredEndpoint = configuredEndpointValue
    ? normalizeBedrockEmbeddingEndpoint(configuredEndpointValue)
    : undefined;

  const region =
    regionFromUrl(options.remote?.baseUrl, BedrockRuntimeClient) ??
    regionFromUrl(providerConfig?.baseUrl, BedrockRuntimeClient) ??
    normalizeOptionalString(process.env.AWS_REGION) ??
    normalizeOptionalString(process.env.AWS_DEFAULT_REGION) ??
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

  return {
    region,
    model,
    dimensions,
    ...(configuredEndpoint ? { endpoint: configuredEndpoint } : {}),
  };
}

// ---------------------------------------------------------------------------
// Credential detection
// ---------------------------------------------------------------------------

export async function hasAwsCredentials(
  env: NodeJS.ProcessEnv = process.env,
  loadCredentialProvider: AwsCredentialProviderLoader = loadDefaultCredentialProvider,
): Promise<boolean> {
  if (env.AWS_ACCESS_KEY_ID?.trim() && env.AWS_SECRET_ACCESS_KEY?.trim()) {
    return true;
  }
  if (env.AWS_BEARER_TOKEN_BEDROCK?.trim()) {
    return true;
  }
  const defaultProvider = await loadCredentialProvider();
  if (!defaultProvider) {
    return false;
  }
  try {
    const credentials = await defaultProvider({
      timeout: 1000,
      maxRetries: 0,
    })();
    return typeof credentials.accessKeyId === "string" && credentials.accessKeyId.trim().length > 0;
  } catch {
    return false;
  }
}
