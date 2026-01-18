import type { Llama, LlamaEmbeddingContext, LlamaModel } from "node-llama-cpp";
import { resolveApiKeyForProvider } from "../agents/model-auth.js";
import type { ClawdbotConfig } from "../config/config.js";
import { importNodeLlamaCpp } from "./node-llama.js";

export type EmbeddingProvider = {
  id: string;
  model: string;
  embedQuery: (text: string) => Promise<number[]>;
  embedBatch: (texts: string[]) => Promise<number[][]>;
};

export type EmbeddingProviderResult = {
  provider: EmbeddingProvider;
  requestedProvider: "openai" | "local";
  fallbackFrom?: "local";
  fallbackReason?: string;
  openAi?: OpenAiEmbeddingClient;
};

export type OpenAiEmbeddingClient = {
  baseUrl: string;
  headers: Record<string, string>;
  model: string;
};

export type EmbeddingProviderOptions = {
  config: ClawdbotConfig;
  agentDir?: string;
  provider: "openai" | "local";
  remote?: {
    baseUrl?: string;
    apiKey?: string;
    headers?: Record<string, string>;
  };
  model: string;
  fallback: "openai" | "none";
  local?: {
    modelPath?: string;
    modelCacheDir?: string;
  };
};

const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_LOCAL_MODEL = "hf:ggml-org/embeddinggemma-300M-GGUF/embeddinggemma-300M-Q8_0.gguf";

function normalizeOpenAiModel(model: string): string {
  const trimmed = model.trim();
  if (!trimmed) return "text-embedding-3-small";
  if (trimmed.startsWith("openai/")) return trimmed.slice("openai/".length);
  return trimmed;
}

async function createOpenAiEmbeddingProvider(
  options: EmbeddingProviderOptions,
): Promise<{ provider: EmbeddingProvider; client: OpenAiEmbeddingClient }> {
  const client = await resolveOpenAiEmbeddingClient(options);
  const url = `${client.baseUrl.replace(/\/$/, "")}/embeddings`;

  const embed = async (input: string[]): Promise<number[][]> => {
    if (input.length === 0) return [];
    const res = await fetch(url, {
      method: "POST",
      headers: client.headers,
      body: JSON.stringify({ model: client.model, input }),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`openai embeddings failed: ${res.status} ${text}`);
    }
    const payload = (await res.json()) as {
      data?: Array<{ embedding?: number[] }>;
    };
    const data = payload.data ?? [];
    return data.map((entry) => entry.embedding ?? []);
  };

  return {
    provider: {
      id: "openai",
      model: client.model,
      embedQuery: async (text) => {
        const [vec] = await embed([text]);
        return vec ?? [];
      },
      embedBatch: embed,
    },
    client,
  };
}

async function resolveOpenAiEmbeddingClient(
  options: EmbeddingProviderOptions,
): Promise<OpenAiEmbeddingClient> {
  const remote = options.remote;
  const remoteApiKey = remote?.apiKey?.trim();
  const remoteBaseUrl = remote?.baseUrl?.trim();

  const { apiKey } = remoteApiKey
    ? { apiKey: remoteApiKey }
    : await resolveApiKeyForProvider({
        provider: "openai",
        cfg: options.config,
        agentDir: options.agentDir,
      });

  const providerConfig = options.config.models?.providers?.openai;
  const baseUrl = remoteBaseUrl || providerConfig?.baseUrl?.trim() || DEFAULT_OPENAI_BASE_URL;
  const headerOverrides = Object.assign({}, providerConfig?.headers, remote?.headers);
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`,
    ...headerOverrides,
  };
  const model = normalizeOpenAiModel(options.model);
  return { baseUrl, headers, model };
}

async function createLocalEmbeddingProvider(
  options: EmbeddingProviderOptions,
): Promise<EmbeddingProvider> {
  const modelPath = options.local?.modelPath?.trim() || DEFAULT_LOCAL_MODEL;
  const modelCacheDir = options.local?.modelCacheDir?.trim();

  // Lazy-load node-llama-cpp to keep startup light unless local is enabled.
  const { getLlama, resolveModelFile, LlamaLogLevel } = await importNodeLlamaCpp();

  let llama: Llama | null = null;
  let embeddingModel: LlamaModel | null = null;
  let embeddingContext: LlamaEmbeddingContext | null = null;

  const ensureContext = async () => {
    if (!llama) {
      llama = await getLlama({ logLevel: LlamaLogLevel.error });
    }
    if (!embeddingModel) {
      const resolved = await resolveModelFile(modelPath, modelCacheDir || undefined);
      embeddingModel = await llama.loadModel({ modelPath: resolved });
    }
    if (!embeddingContext) {
      embeddingContext = await embeddingModel.createEmbeddingContext();
    }
    return embeddingContext;
  };

  return {
    id: "local",
    model: modelPath,
    embedQuery: async (text) => {
      const ctx = await ensureContext();
      const embedding = await ctx.getEmbeddingFor(text);
      return Array.from(embedding.vector) as number[];
    },
    embedBatch: async (texts) => {
      const ctx = await ensureContext();
      const embeddings = await Promise.all(
        texts.map(async (text) => {
          const embedding = await ctx.getEmbeddingFor(text);
          return Array.from(embedding.vector) as number[];
        }),
      );
      return embeddings;
    },
  };
}

export async function createEmbeddingProvider(
  options: EmbeddingProviderOptions,
): Promise<EmbeddingProviderResult> {
  const requestedProvider = options.provider;
  if (options.provider === "local") {
    try {
      const provider = await createLocalEmbeddingProvider(options);
      return { provider, requestedProvider };
    } catch (err) {
      const reason = formatLocalSetupError(err);
      if (options.fallback === "openai") {
        try {
          const { provider, client } = await createOpenAiEmbeddingProvider(options);
          return {
            provider,
            requestedProvider,
            fallbackFrom: "local",
            fallbackReason: reason,
            openAi: client,
          };
        } catch (fallbackErr) {
          throw new Error(`${reason}\n\nFallback to OpenAI failed: ${formatError(fallbackErr)}`);
        }
      }
      throw new Error(reason);
    }
  }
  const { provider, client } = await createOpenAiEmbeddingProvider(options);
  return { provider, requestedProvider, openAi: client };
}

function formatError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function isNodeLlamaCppMissing(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code = (err as Error & { code?: unknown }).code;
  if (code === "ERR_MODULE_NOT_FOUND") {
    return err.message.includes("node-llama-cpp");
  }
  return false;
}

function formatLocalSetupError(err: unknown): string {
  const detail = formatError(err);
  const missing = isNodeLlamaCppMissing(err);
  return [
    "Local embeddings unavailable.",
    missing
      ? "Reason: optional dependency node-llama-cpp is missing (or failed to install)."
      : detail
        ? `Reason: ${detail}`
        : undefined,
    missing && detail ? `Detail: ${detail}` : null,
    "To enable local embeddings:",
    "1) Use Node 22 LTS (recommended for installs/updates)",
    missing
      ? "2) Reinstall Clawdbot (this should install node-llama-cpp): npm i -g clawdbot@latest"
      : null,
    "3) If you use pnpm: pnpm approve-builds (select node-llama-cpp), then pnpm rebuild node-llama-cpp",
    'Or set agents.defaults.memorySearch.provider = "openai" (remote).',
  ]
    .filter(Boolean)
    .join("\n");
}
