import type {
  EmbeddingProviderCreateOptions,
  EmbeddingProviderStartupInspectionResult,
} from "openclaw/plugin-sdk/embedding-providers";
import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  DEFAULT_LLAMA_CPP_EMBEDDING_MODEL,
  DEFAULT_LLAMA_CPP_MODEL_ID,
  LLAMA_CPP_PROVIDER_ID,
  resolveLlamaCppModelCacheDir,
  resolveLlamaCppModelSource,
} from "./defaults.js";
import {
  inspectLlamaCppModelFile,
  resolveLlamaCppModelCacheInspectionTarget,
} from "./model-cache.js";

const LLAMA_CPP_SETUP_REMEDIATION = [
  "Run `openclaw configure` and choose llama.cpp once.",
  "Retry `openclaw memory status --deep` after setup completes.",
] as const;

class LlamaCppStartupPrerequisiteError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "LlamaCppStartupPrerequisiteError";
  }
}

export function resolveConfiguredLlamaCppProvider(
  options: EmbeddingProviderCreateOptions,
): ModelProviderConfig {
  const provider = options.config.models?.providers?.[LLAMA_CPP_PROVIDER_ID];
  if (!provider?.localService || !provider.baseUrl) {
    throw new LlamaCppStartupPrerequisiteError(
      "managed-server-config-missing",
      "Local embeddings need the managed llama.cpp server config. Run `openclaw configure`, choose llama.cpp once, then retry `openclaw memory status --deep`.",
    );
  }
  return provider;
}

export function resolveLlamaCppProviderPort(provider: ModelProviderConfig): number {
  let port: number;
  try {
    port = Number(new URL(provider.baseUrl ?? "").port);
  } catch {
    throw new LlamaCppStartupPrerequisiteError(
      "managed-server-base-url-invalid",
      "Managed llama.cpp provider baseUrl must be a valid URL.",
    );
  }
  if (!Number.isInteger(port) || port <= 0) {
    throw new LlamaCppStartupPrerequisiteError(
      "managed-server-port-missing",
      "Managed llama.cpp provider baseUrl must include a loopback port.",
    );
  }
  return port;
}

export function resolveLlamaCppChatModel(
  options: EmbeddingProviderCreateOptions,
  provider: ModelProviderConfig,
): ModelProviderConfig["models"][number] {
  const configuredPrimary = options.config.agents?.defaults?.model;
  const primaryRef =
    typeof configuredPrimary === "string" ? configuredPrimary : configuredPrimary?.primary;
  const primaryId = primaryRef?.startsWith(`${LLAMA_CPP_PROVIDER_ID}/`)
    ? primaryRef.slice(LLAMA_CPP_PROVIDER_ID.length + 1)
    : undefined;
  const chatModel =
    provider.models.find((model) => model.id === primaryId) ??
    provider.models.find((model) => model.id !== DEFAULT_LLAMA_CPP_MODEL_ID) ??
    provider.models[0];
  if (!chatModel) {
    throw new LlamaCppStartupPrerequisiteError(
      "chat-model-preset-missing",
      "Managed llama.cpp provider has no chat model preset.",
    );
  }
  return chatModel;
}

export function resolveLlamaCppEmbeddingSource(options: EmbeddingProviderCreateOptions): string {
  return normalizeOptionalString(options.local?.modelPath) ?? DEFAULT_LLAMA_CPP_EMBEDDING_MODEL;
}

export async function inspectLlamaCppEmbeddingStartupPrerequisites(
  options: EmbeddingProviderCreateOptions,
): Promise<EmbeddingProviderStartupInspectionResult> {
  try {
    const provider = resolveConfiguredLlamaCppProvider(options);
    resolveLlamaCppProviderPort(provider);
    const chatModel = resolveLlamaCppChatModel(options, provider);
    const target = resolveLlamaCppModelCacheInspectionTarget({
      source: resolveLlamaCppModelSource(chatModel),
      cacheDir: resolveLlamaCppModelCacheDir(provider),
    });
    if (target.status === "indeterminate") {
      return { status: "indeterminate", reason: target.reason };
    }
    if (target.status === "invalid") {
      throw new LlamaCppStartupPrerequisiteError("chat-model-source-invalid", target.reason);
    }
    const inspection = await inspectLlamaCppModelFile({
      filePath: target.filePath,
      ...(target.expectedSha256 ? { expectedSha256: target.expectedSha256 } : {}),
    });
    if (inspection.status === "missing") {
      throw new LlamaCppStartupPrerequisiteError(
        "chat-model-cache-missing",
        `Managed llama.cpp chat model is not cached at ${target.filePath}.`,
      );
    }
    if (inspection.status === "invalid") {
      throw new LlamaCppStartupPrerequisiteError(
        "chat-model-cache-invalid",
        `Managed llama.cpp chat model cache is invalid at ${target.filePath}.`,
      );
    }

    const embeddingTarget = resolveLlamaCppModelCacheInspectionTarget({
      source: resolveLlamaCppEmbeddingSource(options),
      cacheDir: resolveLlamaCppModelCacheDir(provider),
    });
    if (embeddingTarget.status === "indeterminate") {
      return { status: "indeterminate", reason: embeddingTarget.reason };
    }
    if (embeddingTarget.status === "invalid") {
      throw new LlamaCppStartupPrerequisiteError(
        "embedding-model-source-invalid",
        embeddingTarget.reason,
      );
    }
    const embeddingInspection = await inspectLlamaCppModelFile({
      filePath: embeddingTarget.filePath,
      ...(embeddingTarget.expectedSha256 ? { expectedSha256: embeddingTarget.expectedSha256 } : {}),
    });
    if (embeddingInspection.status === "missing") {
      if (embeddingTarget.sourceKind === "local") {
        throw new LlamaCppStartupPrerequisiteError(
          "embedding-model-cache-missing",
          `Managed llama.cpp embedding model is not cached at ${embeddingTarget.filePath}.`,
        );
      }
      return {
        status: "indeterminate",
        reason:
          `Managed llama.cpp embedding model is not cached at ${embeddingTarget.filePath}; ` +
          "startup may download it, which passive preflight does not perform.",
      };
    }
    if (embeddingInspection.status === "invalid") {
      if (embeddingTarget.sourceKind === "local" || !embeddingTarget.expectedSha256) {
        throw new LlamaCppStartupPrerequisiteError(
          "embedding-model-cache-invalid",
          `Managed llama.cpp embedding model cache is invalid at ${embeddingTarget.filePath}.`,
        );
      }
      return {
        status: "indeterminate",
        reason:
          `Managed llama.cpp embedding model cache needs repair at ${embeddingTarget.filePath}; ` +
          "startup may download it again, which passive preflight does not perform.",
      };
    }
    return { status: "ready" };
  } catch (error) {
    if (error instanceof LlamaCppStartupPrerequisiteError) {
      return {
        status: "blocked",
        issues: [
          {
            code: error.code,
            message: error.message,
            remediation: LLAMA_CPP_SETUP_REMEDIATION,
          },
        ],
      };
    }
    return {
      status: "indeterminate",
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}
