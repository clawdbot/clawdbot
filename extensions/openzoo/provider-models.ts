// Openzoo provider module implements model/runtime integration.
import { buildLiveModelProviderConfig } from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import type { ModelDefinitionConfig } from "openclaw/plugin-sdk/provider-model-shared";
import { ssrfPolicyFromHttpBaseUrlAllowedHostname } from "openclaw/plugin-sdk/ssrf-runtime";
import {
  asOptionalRecord,
  asPositiveSafeInteger,
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";

export const OPENZOO_PROVIDER_ID = "openzoo";
export const OPENZOO_PROVIDER_LABEL = "openzoo";
export const OPENZOO_DEFAULT_PORT = 8402;
export const OPENZOO_PORT_ENV_VAR = "OPENZOO_PORT";
export const OPENZOO_BASE_URL_ENV_VAR = "OPENZOO_BASE_URL";
export const OPENZOO_DEFAULT_BASE_URL = `http://localhost:${OPENZOO_DEFAULT_PORT}/v1`;
// The proxy takes payment, not keys; this placeholder only satisfies the Bearer transport.
export const OPENZOO_LOCAL_API_KEY_PLACEHOLDER = "sk-openzoo";
export const OPENZOO_DEFAULT_MODEL_ID = "auto";
export const OPENZOO_DEFAULT_MODEL_REF = `${OPENZOO_PROVIDER_ID}/${OPENZOO_DEFAULT_MODEL_ID}`;
export const OPENZOO_DEFAULT_MODEL_NAME = "auto";

type OpenzooModelCatalogEntry = {
  id: string;
  name: string;
  reasoning: boolean;
  input: Array<"text" | "image">;
  contextWindow?: number;
  maxTokens?: number;
};

export const OPENZOO_MODEL_CATALOG: OpenzooModelCatalogEntry[] = [
  {
    id: OPENZOO_DEFAULT_MODEL_ID,
    name: OPENZOO_DEFAULT_MODEL_NAME,
    input: ["text"],
    reasoning: false,
  },
];

// The proxy spills long context server-side, so the client-usable window really is ~128M.
export const OPENZOO_DEFAULT_CONTEXT_WINDOW = 128_000_000;
export const OPENZOO_DEFAULT_MAX_TOKENS = 8192;
// USD per million tokens, matching the live `auto` row (1e-7 / 2e-7 per token).
export const OPENZOO_DEFAULT_COST = {
  input: 0.1,
  output: 0.2,
  cacheRead: 0,
  cacheWrite: 0,
};

const DISCOVERY_TIMEOUT_MS = 5000;
const PER_TOKEN_TO_PER_MILLION = 1_000_000;
// Reasoning is only advertised when the id unambiguously says so: a wrong `true`
// breaks requests, a wrong `false` only hides a toggle. Tokens are matched on
// id boundaries so `sao10k` (o1) and `solar-pro4` (o4) do not false-positive.
const REASONING_ID_TOKEN_RE = /(?:^|[^a-z0-9])(?:o1|o3|o4|r1|qwq|reasoner|thinking)(?:[^a-z0-9]|$)/;

/** Normalizes an operator-supplied proxy URL to `<origin>[/path]` with a `/v1` default path. */
export function normalizeOpenzooBaseUrl(value: string | undefined): string | undefined {
  const trimmed = normalizeOptionalString(value);
  if (!trimmed) {
    return undefined;
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return undefined;
  }
  const path = parsed.pathname.replace(/\/+$/, "");
  parsed.pathname = path === "" ? "/v1" : path;
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString().replace(/\/+$/, "");
}

function resolveOpenzooPort(raw: string | undefined): number {
  const trimmed = normalizeOptionalString(raw);
  if (!trimmed || !/^\d{1,5}$/.test(trimmed)) {
    return OPENZOO_DEFAULT_PORT;
  }
  const port = Number(trimmed);
  return port >= 1 && port <= 65535 ? port : OPENZOO_DEFAULT_PORT;
}

/** Resolves the proxy base URL: configured value, then OPENZOO_BASE_URL, then OPENZOO_PORT. */
export function resolveOpenzooBaseUrl(params?: {
  env?: NodeJS.ProcessEnv;
  configuredBaseUrl?: string;
}): string {
  const env = params?.env ?? process.env;
  const configured = normalizeOpenzooBaseUrl(params?.configuredBaseUrl);
  if (configured) {
    return configured;
  }
  const fromEnv = normalizeOpenzooBaseUrl(env[OPENZOO_BASE_URL_ENV_VAR]);
  if (fromEnv) {
    return fromEnv;
  }
  const port = resolveOpenzooPort(env[OPENZOO_PORT_ENV_VAR]);
  return port === OPENZOO_DEFAULT_PORT ? OPENZOO_DEFAULT_BASE_URL : `http://localhost:${port}/v1`;
}

export function resolveOpenzooModelsUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/models`;
}

export function resolveOpenzooInfoUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/info`;
}

function toPricePerMillion(perToken: unknown): number | undefined {
  let num: number;
  if (typeof perToken === "number") {
    num = perToken;
  } else if (typeof perToken === "string") {
    const trimmed = perToken.trim();
    if (!trimmed) {
      return undefined;
    }
    num = Number(trimmed);
  } else {
    return undefined;
  }
  return Number.isFinite(num) && num >= 0 ? num * PER_TOKEN_TO_PER_MILLION : undefined;
}

function parseModality(row: Record<string, unknown>): Array<"text" | "image"> {
  const modalities = asOptionalRecord(row.architecture)?.input_modalities;
  if (!Array.isArray(modalities)) {
    return ["text"];
  }
  const hasImage = modalities.some(
    (entry) => typeof entry === "string" && normalizeLowercaseStringOrEmpty(entry) === "image",
  );
  return hasImage ? ["text", "image"] : ["text"];
}

export function parseOpenzooReasoning(modelId: string): boolean {
  return REASONING_ID_TOKEN_RE.test(normalizeLowercaseStringOrEmpty(modelId));
}

function readRowId(row: unknown): string {
  const id = asOptionalRecord(row)?.id;
  return typeof id === "string" ? id.trim() : "";
}

type ProjectedRow =
  | { kind: "model"; model: ModelDefinitionConfig }
  | { kind: "skip" }
  | { kind: "malformed" };

function projectRow(row: unknown, id: string): ProjectedRow {
  const record = asOptionalRecord(row);
  const pricing = record ? asOptionalRecord(record.pricing) : undefined;
  if (!record || !pricing) {
    return { kind: "malformed" };
  }
  // `kind` marks media rows (image/video); they are not chat models.
  if (normalizeOptionalString(record.kind)) {
    return { kind: "skip" };
  }
  const fallbackCost = id === OPENZOO_DEFAULT_MODEL_ID ? OPENZOO_DEFAULT_COST : undefined;
  const input = toPricePerMillion(pricing.prompt) ?? fallbackCost?.input;
  const output = toPricePerMillion(pricing.completion) ?? fallbackCost?.output;
  // Unpriced rows cannot be metered honestly; the gateway never serves them for free.
  if (!(input !== undefined && input > 0) && !(output !== undefined && output > 0)) {
    return { kind: "skip" };
  }
  const topProvider = asOptionalRecord(record.top_provider);
  const name = normalizeOptionalString(record.name);
  return {
    kind: "model",
    model: {
      id,
      name: name ?? id,
      reasoning: parseOpenzooReasoning(id),
      input: parseModality(record),
      cost: {
        input: input ?? 0,
        output: output ?? 0,
        cacheRead: toPricePerMillion(pricing.input_cache_read) ?? 0,
        cacheWrite: toPricePerMillion(pricing.input_cache_write) ?? 0,
      },
      // The primary provider window bounds real requests; the catalog-wide value can be larger.
      contextWindow:
        asPositiveSafeInteger(topProvider?.context_length) ??
        asPositiveSafeInteger(record.context_length) ??
        OPENZOO_DEFAULT_CONTEXT_WINDOW,
      maxTokens:
        asPositiveSafeInteger(topProvider?.max_completion_tokens) ?? OPENZOO_DEFAULT_MAX_TOKENS,
    },
  };
}

function buildStaticCatalog(): ModelDefinitionConfig[] {
  return OPENZOO_MODEL_CATALOG.map((model) => ({
    id: model.id,
    name: model.name,
    reasoning: model.reasoning,
    input: model.input,
    cost: OPENZOO_DEFAULT_COST,
    contextWindow: model.contextWindow ?? OPENZOO_DEFAULT_CONTEXT_WINDOW,
    maxTokens: model.maxTokens ?? OPENZOO_DEFAULT_MAX_TOKENS,
  }));
}

function readGatewayModelRows(body: unknown): readonly unknown[] {
  const data = asOptionalRecord(body)?.data;
  if (!Array.isArray(data)) {
    throw new Error("openzoo model list: malformed JSON response");
  }
  return data;
}

export function projectOpenzooModels(rows: readonly unknown[]): ModelDefinitionConfig[] {
  const models: ModelDefinitionConfig[] = [];
  const discoveredIds = new Set<string>();
  for (const rawEntry of rows) {
    const id = readRowId(rawEntry);
    if (!id || discoveredIds.has(id)) {
      continue;
    }
    const projected = projectRow(rawEntry, id);
    if (projected.kind !== "model") {
      // A malformed or skipped row must not hide a later valid row with the same id.
      continue;
    }
    models.push(projected.model);
    discoveredIds.add(id);
  }
  for (const staticModel of buildStaticCatalog()) {
    if (!discoveredIds.has(staticModel.id)) {
      models.unshift(staticModel);
    }
  }
  return models;
}

export async function discoverOpenzooModels(params?: {
  baseUrl?: string;
  signal?: AbortSignal;
}): Promise<ModelDefinitionConfig[]> {
  const baseUrl = params?.baseUrl ?? OPENZOO_DEFAULT_BASE_URL;
  const provider = await buildLiveModelProviderConfig({
    providerId: OPENZOO_PROVIDER_ID,
    endpoint: resolveOpenzooModelsUrl(baseUrl),
    providerConfig: { baseUrl, api: "openai-completions" },
    models: buildStaticCatalog(),
    timeoutMs: DISCOVERY_TIMEOUT_MS,
    ttlMs: 0,
    ...(params?.signal ? { signal: params.signal } : {}),
    readRows: readGatewayModelRows,
    buildRequestHeaders: () => ({ Accept: "application/json" }),
    policy: ssrfPolicyFromHttpBaseUrlAllowedHostname(baseUrl),
    auditContext: "openzoo.model_discovery",
    projectRows: projectOpenzooModels,
  });
  return provider.models;
}

export function buildOpenzooModelDefinition(): ModelDefinitionConfig {
  return {
    id: OPENZOO_DEFAULT_MODEL_ID,
    name: OPENZOO_DEFAULT_MODEL_NAME,
    reasoning: false,
    input: ["text"],
    cost: OPENZOO_DEFAULT_COST,
    contextWindow: OPENZOO_DEFAULT_CONTEXT_WINDOW,
    maxTokens: OPENZOO_DEFAULT_MAX_TOKENS,
  };
}
