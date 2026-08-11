// Memory Lancedb helper module supports config behavior.
import { homedir } from "node:os";
import { join } from "node:path";
import { parseFiniteNumber } from "openclaw/plugin-sdk/number-runtime";

export type MemoryConfig = {
  embedding: {
    provider: string;
    model: string;
    apiKey?: string;
    baseUrl?: string;
    dimensions?: number;
  };
  dreaming?: Record<string, unknown>;
  dbPath?: string;
  autoCapture?: boolean;
  autoRecall?: boolean;
  captureMaxChars?: number;
  customTriggers?: string[];
  recallMaxChars?: number;
  storageOptions?: Record<string, string>;
};

export const MEMORY_CATEGORIES = ["preference", "fact", "decision", "entity", "other"] as const;
export type MemoryCategory = (typeof MEMORY_CATEGORIES)[number];

const DEFAULT_MODEL = "text-embedding-3-small";
export const DEFAULT_CAPTURE_MAX_CHARS = 500;
export const DEFAULT_RECALL_MAX_CHARS = 1000;
const DEFAULT_DB_PATH = join(homedir(), ".openclaw", "memory", "lancedb");

const EMBEDDING_DIMENSIONS: Record<string, number> = {
  "text-embedding-3-small": 1536,
  "text-embedding-3-large": 3072,
};
const EMBEDDING_CONFIG_KEYS = ["provider", "apiKey", "model", "baseUrl", "dimensions"] as const;

function assertAllowedKeys(value: Record<string, unknown>, allowed: string[], label: string) {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length === 0) {
    return;
  }
  throw new Error(`${label} has unknown keys: ${unknown.join(", ")}`);
}

export function vectorDimsForModel(model: string): number {
  const dims = EMBEDDING_DIMENSIONS[model];
  if (!dims) {
    throw new Error(`Unsupported embedding model: ${model}`);
  }
  return dims;
}

function resolveEnvVars(value: string): string {
  return value.replace(/\$\{([^}]+)\}/g, (_, envVar) => {
    const envValue = process.env[envVar];
    if (!envValue) {
      throw new Error(`Environment variable ${envVar} is not set`);
    }
    return envValue;
  });
}

function resolveEmbeddingModel(
  embedding: Record<string, unknown>,
  dimensions: number | undefined,
): string {
  const model = typeof embedding.model === "string" ? embedding.model : DEFAULT_MODEL;
  if (dimensions === undefined) {
    vectorDimsForModel(model);
  }
  return model;
}

function resolveFiniteIntegerConfig(value: unknown): number | undefined {
  if (typeof value !== "number") {
    return undefined;
  }
  const parsed = parseFiniteNumber(value);
  return parsed === undefined ? undefined : Math.floor(parsed);
}

function resolveBoundedIntegerConfig(params: {
  value: unknown;
  fallback: number;
  min: number;
  max: number;
  label: string;
}): number {
  const resolved = resolveFiniteIntegerConfig(params.value) ?? params.fallback;
  if (resolved < params.min || resolved > params.max) {
    throw new Error(`${params.label} must be between ${params.min} and ${params.max}`);
  }
  return resolved;
}

function resolveEmbeddingDimensions(embedding: Record<string, unknown>): number | undefined {
  if (embedding.dimensions === undefined) {
    return undefined;
  }
  const dimensions =
    typeof embedding.dimensions === "number" ? parseFiniteNumber(embedding.dimensions) : undefined;
  if (dimensions === undefined || !Number.isInteger(dimensions) || dimensions < 1) {
    throw new Error("embedding.dimensions must be a positive integer");
  }
  return dimensions;
}

export const memoryConfigSchema = {
  parse(value: unknown): MemoryConfig {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("memory config required");
    }
    const cfg = value as Record<string, unknown>;
    assertAllowedKeys(
      cfg,
      [
        "embedding",
        "dreaming",
        "dbPath",
        "autoCapture",
        "autoRecall",
        "captureMaxChars",
        "customTriggers",
        "recallMaxChars",
        "storageOptions",
      ],
      "memory config",
    );

    const embedding = cfg.embedding as Record<string, unknown> | undefined;
    if (!embedding || typeof embedding !== "object" || Array.isArray(embedding)) {
      throw new Error("embedding config required");
    }
    assertAllowedKeys(embedding, [...EMBEDDING_CONFIG_KEYS], "embedding config");
    if (Object.keys(embedding).length === 0) {
      throw new Error("embedding config must include at least one setting");
    }

    const dimensions = resolveEmbeddingDimensions(embedding);
    const model = resolveEmbeddingModel(embedding, dimensions);
    const provider = typeof embedding.provider === "string" ? embedding.provider.trim() : "openai";
    if (!provider) {
      throw new Error("embedding.provider must not be empty");
    }

    const captureMaxChars = resolveBoundedIntegerConfig({
      value: cfg.captureMaxChars,
      fallback: DEFAULT_CAPTURE_MAX_CHARS,
      min: 100,
      max: 10_000,
      label: "captureMaxChars",
    });
    const recallMaxChars = resolveBoundedIntegerConfig({
      value: cfg.recallMaxChars,
      fallback: DEFAULT_RECALL_MAX_CHARS,
      min: 100,
      max: 10_000,
      label: "recallMaxChars",
    });
    let customTriggers: string[] | undefined;
    if (cfg.customTriggers !== undefined) {
      if (!Array.isArray(cfg.customTriggers)) {
        throw new Error("customTriggers must be an array of strings");
      }
      customTriggers = cfg.customTriggers.map((trigger, index) => {
        if (typeof trigger !== "string") {
          throw new Error(`customTriggers.${index} must be a string`);
        }
        const normalized = trigger.trim();
        if (!normalized) {
          throw new Error(`customTriggers.${index} must not be empty`);
        }
        if (normalized.length > 100) {
          throw new Error(`customTriggers.${index} must be at most 100 characters`);
        }
        return normalized;
      });
      if (customTriggers.length > 50) {
        throw new Error("customTriggers must include at most 50 entries");
      }
    }

    const dreaming =
      cfg.dreaming === undefined
        ? undefined
        : cfg.dreaming && typeof cfg.dreaming === "object" && !Array.isArray(cfg.dreaming)
          ? (cfg.dreaming as Record<string, unknown>)
          : (() => {
              throw new Error("dreaming config must be an object");
            })();

    // Parse storageOptions (object with string values)
    let storageOptions: Record<string, string> | undefined;
    const storageOpts = cfg.storageOptions as Record<string, unknown> | undefined;
    if (storageOpts !== undefined && storageOpts !== null) {
      if (!storageOpts || typeof storageOpts !== "object" || Array.isArray(storageOpts)) {
        throw new Error("storageOptions must be an object");
      }
      storageOptions = {};
      // Validate all values are strings
      for (const [key, valueLocal] of Object.entries(storageOpts)) {
        if (typeof valueLocal !== "string") {
          throw new Error(`storageOptions.${key} must be a string`);
        }
        storageOptions[key] = resolveEnvVars(valueLocal);
      }
    }

    return {
      embedding: {
        provider,
        model,
        apiKey: typeof embedding.apiKey === "string" ? resolveEnvVars(embedding.apiKey) : undefined,
        baseUrl:
          typeof embedding.baseUrl === "string" ? resolveEnvVars(embedding.baseUrl) : undefined,
        dimensions,
      },
      dreaming,
      dbPath: typeof cfg.dbPath === "string" ? cfg.dbPath : DEFAULT_DB_PATH,
      autoCapture: cfg.autoCapture === true,
      autoRecall: cfg.autoRecall !== false,
      captureMaxChars,
      ...(customTriggers ? { customTriggers } : {}),
      recallMaxChars,
      ...(storageOptions ? { storageOptions } : {}),
    };
  },
};
