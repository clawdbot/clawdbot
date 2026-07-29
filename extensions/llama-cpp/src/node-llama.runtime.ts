import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

export type ChatHistoryItem =
  | { type: "system"; text: string }
  | { type: "user"; text: string }
  | {
      type: "model";
      response: Array<
        | string
        | { type: "segment"; segmentType: "thought"; text: string; ended: true }
        | { type: "functionCall"; name: string; params: unknown; result: string }
      >;
    };

export type ChatModelFunctions = Record<
  string,
  {
    description?: string;
    params: unknown;
  }
>;

export type LlamaJsonSchemaInput = unknown;

type LlamaTokenUsage = {
  usedInputTokens: number;
  usedOutputTokens: number;
};

type LlamaTokenMeterState = unknown;

export type LlamaContextSequence = {
  tokenMeter: {
    getState: () => LlamaTokenMeterState;
    diff: (previous: LlamaTokenMeterState) => LlamaTokenUsage;
  };
};

export type LlamaContext = {
  getSequence: () => LlamaContextSequence;
  dispose: () => Promise<void>;
};

export type LlamaModel = {
  createContext: (params: {
    contextSize: number | { max: number };
    createSignal?: AbortSignal;
  }) => Promise<LlamaContext>;
  dispose: () => Promise<void>;
};

export type Llama = {
  getGrammarFor: (name: string) => Promise<unknown>;
  createGrammarForJsonSchema: (schema: LlamaJsonSchemaInput) => Promise<unknown>;
  loadModel: (params: {
    modelPath: string;
    loadSignal?: AbortSignal;
    gpuLayers: {
      fitContext: {
        contextSize: number;
      };
    };
  }) => Promise<LlamaModel>;
  dispose: () => Promise<void>;
};

type LlamaChat = {
  generateResponse: (
    history: ChatHistoryItem[],
    options: {
      signal?: AbortSignal;
      maxTokens?: number;
      temperature?: number;
      customStopTriggers?: string[];
      onTextChunk: (delta: string) => void;
      functions?: ChatModelFunctions;
      documentFunctionParams?: true;
      grammar?: unknown;
    },
  ) => Promise<{
    metadata: {
      stopReason: string;
    };
    response?: string;
    functionCalls?: Array<{
      functionName: string;
      params: unknown;
    }>;
  }>;
  dispose: () => void;
};

type LlamaModelDownloader = {
  download: (options: { signal?: AbortSignal }) => Promise<void>;
};

export type NodeLlamaCppModule = {
  LlamaChat: new (params: {
    contextSequence: LlamaContextSequence;
    chatWrapper: "auto";
    autoDisposeSequence: false;
  }) => LlamaChat;
  getLlama: () => Promise<Llama>;
  resolveModelFile: (
    modelPath: string,
    options: {
      directory?: string;
      download?: boolean;
      cli?: boolean;
    },
  ) => Promise<string>;
  createModelDownloader: (options: {
    modelUri: string;
    dirPath: string;
    fileName: string;
    showCliProgress: boolean;
    onProgress: (progress: { downloadedSize: number; totalSize?: number }) => void;
  }) => Promise<LlamaModelDownloader>;
};

function isNodeLlamaCppMissing(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const code = (error as Error & { code?: unknown }).code;
  return code === "ERR_MODULE_NOT_FOUND" && error.message.includes("node-llama-cpp");
}

function formatErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function formatLlamaCppSetupError(error: unknown): string {
  const detail = formatErrorMessage(error);
  const missing = isNodeLlamaCppMissing(error);
  return [
    "Local llama.cpp is unavailable.",
    missing
      ? "Reason: node-llama-cpp is missing or failed to install."
      : detail
        ? `Reason: ${detail}`
        : undefined,
    missing && detail ? `Detail: ${detail}` : null,
    "To enable local GGUF models:",
    "1) Install the official provider plugin: openclaw plugins install @openclaw/llama-cpp-provider",
    "2) Use Node 24 for native installs/updates.",
    "3) If you use pnpm from source: pnpm approve-builds, then pnpm rebuild node-llama-cpp.",
  ]
    .filter(Boolean)
    .join("\n");
}

const requireFromPlugin = createRequire(import.meta.url);

export function resolveNodeLlamaCppImportUrl(): string {
  return pathToFileURL(requireFromPlugin.resolve("node-llama-cpp")).href;
}

export async function importNodeLlamaCpp(): Promise<NodeLlamaCppModule> {
  // Keep this runtime-resolved: bundling node-llama-cpp rewrites its import.meta.url,
  // which makes its package-relative native assets resolve from the OpenClaw bundle.
  return (await import(resolveNodeLlamaCppImportUrl())) as NodeLlamaCppModule;
}
