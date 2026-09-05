import type { ModelDefinitionConfig } from "openclaw/plugin-sdk/provider-model-shared";
import {
  DEFAULT_LLAMA_CPP_CONTEXT_SIZE,
  DEFAULT_LLAMA_CPP_EMBEDDING_MODEL_SIZE_BYTES,
  DEFAULT_LLAMA_CPP_MODEL_CACHE_FILE,
  DEFAULT_LLAMA_CPP_MODEL_ID,
  DEFAULT_LLAMA_CPP_MODEL_REVISION,
  DEFAULT_LLAMA_CPP_MODEL_SHA256,
  DEFAULT_LLAMA_CPP_MODEL_SIZE_BYTES,
  DEFAULT_LLAMA_CPP_MODEL_URI,
} from "./defaults.js";
import { formatLlamaCppMemory, type LlamaCppHardware } from "./hardware.js";

const GIB = 1024 ** 3;

type CatalogArtifact = {
  fileName: string;
  url: string;
  expectedSize: number;
  expectedSha256: string;
};

export type LlamaCppModelRecipe = {
  model: ModelDefinitionConfig;
  sizeBytes: number;
  memoryBytes: number;
  minimumSystemMemoryBytes: number;
  requiresAcceleration: boolean;
  artifact: CatalogArtifact;
};

function modelRecipe(params: {
  id: string;
  name: string;
  repository: string;
  file: string;
  revision: string;
  sha256: string;
  sizeBytes: number;
  memoryGiB: number;
  minimumSystemGiB: number;
  requiresAcceleration?: boolean;
  reasoning?: boolean;
  maxTokens?: number;
  source?: string;
  cacheFile?: string;
}): LlamaCppModelRecipe {
  const source = params.source ?? `hf:${params.repository}/${params.file}#${params.revision}`;
  return {
    model: {
      id: params.id,
      name: params.name,
      api: "openai-completions",
      reasoning: params.reasoning ?? false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: DEFAULT_LLAMA_CPP_CONTEXT_SIZE,
      contextTokens: DEFAULT_LLAMA_CPP_CONTEXT_SIZE,
      maxTokens: params.maxTokens ?? 2048,
      params: { modelPath: source, contextSize: DEFAULT_LLAMA_CPP_CONTEXT_SIZE },
      compat: {
        supportsTools: true,
        supportsUsageInStreaming: true,
        toolSchemaProfile: "llamacpp",
      },
    },
    sizeBytes: params.sizeBytes,
    memoryBytes: params.memoryGiB * GIB,
    minimumSystemMemoryBytes: params.minimumSystemGiB * GIB,
    requiresAcceleration: params.requiresAcceleration ?? false,
    artifact: {
      fileName:
        params.cacheFile ??
        `hf_${params.repository.replaceAll("/", "_")}_${params.revision}_${params.file}`,
      url: `https://huggingface.co/${params.repository}/resolve/${params.revision}/${params.file}?download=true`,
      expectedSize: params.sizeBytes,
      expectedSha256: params.sha256,
    },
  };
}

// Ordered by recommendation tier, not a benchmark score. These text-only recipes use
// native tool templates and 64K context; no unverified vision projector is enabled.
// Budgets include weights, KV cache, compute buffers, and the concurrent embedding model.
const LLAMA_CPP_MODEL_RECIPES: readonly LlamaCppModelRecipe[] = [
  modelRecipe({
    id: "qwen3.8-27b-ud-q4_k_m",
    name: "Qwen3.8 27B (UD-Q4_K_M)",
    repository: "unsloth/Qwen3.8-27B-GGUF",
    file: "Qwen3.8-27B-UD-Q4_K_M.gguf",
    revision: "4ca720788d1e01f1bff70c033e0d0028fd02e502",
    sha256: "322e194ff79741c7baa497c240f677f54b201b0efab44ca8e50f122b39123482",
    sizeBytes: 16_464_440_224,
    memoryGiB: 22,
    minimumSystemGiB: 32,
    requiresAcceleration: true,
    reasoning: true,
    maxTokens: 16384,
  }),
  modelRecipe({
    id: "muse-glimmer-30b-q4_k_m",
    name: "Muse Glimmer 30B (Q4_K_M)",
    repository: "meta-models/Muse-Glimmer-30B-GGUF",
    file: "Muse-Glimmer-30B-KQuant-17GB-Q4_K_M.gguf",
    revision: "70bf1b61ac09f91b24d39038091b41c582bc5d7a",
    sha256: "4cc57c0f51040a226e5a72cc47b7613f7772950e460a665f7083de89f183f60e",
    sizeBytes: 16_756_683_904,
    memoryGiB: 20,
    minimumSystemGiB: 32,
    requiresAcceleration: true,
    reasoning: true,
    maxTokens: 16384,
  }),
  modelRecipe({
    id: "gemma-4-26b-a4b-it-ud-q4_k_m",
    name: "Gemma 4 26B A4B (UD-Q4_K_M)",
    repository: "unsloth/gemma-4-26B-A4B-it-GGUF",
    file: "gemma-4-26B-A4B-it-UD-Q4_K_M.gguf",
    revision: "c099eb48e663fd284577b04978a94ffccb261841",
    sha256: "f2c28b3dc4776931ac6f879e11f203dec637ea0f14267a86ec8f6165f63f293f",
    sizeBytes: 16_947_541_728,
    memoryGiB: 22,
    minimumSystemGiB: 32,
    requiresAcceleration: true,
  }),
  modelRecipe({
    id: "gemma-4-12b-it-q4_k_m",
    name: "Gemma 4 12B (Q4_K_M)",
    repository: "unsloth/gemma-4-12b-it-GGUF",
    file: "gemma-4-12b-it-Q4_K_M.gguf",
    revision: "fc034cfff751157913579611efad8462ac1be606",
    sha256: "0a270ec9fe6b34f4a0d33992b6135117b484ebc4766ab76b51d4ae8c457e4c42",
    sizeBytes: 7_121_861_440,
    memoryGiB: 12,
    minimumSystemGiB: 24,
    requiresAcceleration: true,
    reasoning: true,
    maxTokens: 16384,
  }),
  modelRecipe({
    id: "qwen3.5-9b-q4_k_m",
    name: "Qwen3.5 9B (Q4_K_M)",
    repository: "unsloth/Qwen3.5-9B-GGUF",
    file: "Qwen3.5-9B-Q4_K_M.gguf",
    revision: "3885219b6810b007914f3a7950a8d1b469d598a5",
    sha256: "03b74727a860a56338e042c4420bb3f04b2fec5734175f4cb9fa853daf52b7e8",
    sizeBytes: 5_680_522_464,
    memoryGiB: 10,
    minimumSystemGiB: 16,
    reasoning: true,
    maxTokens: 16384,
  }),
  modelRecipe({
    id: DEFAULT_LLAMA_CPP_MODEL_ID,
    name: "Gemma 4 E4B (Q4_K_M)",
    repository: "unsloth/gemma-4-E4B-it-GGUF",
    file: "gemma-4-E4B-it-Q4_K_M.gguf",
    revision: DEFAULT_LLAMA_CPP_MODEL_REVISION,
    sha256: DEFAULT_LLAMA_CPP_MODEL_SHA256,
    sizeBytes: DEFAULT_LLAMA_CPP_MODEL_SIZE_BYTES,
    memoryGiB: 10,
    minimumSystemGiB: 16,
    source: DEFAULT_LLAMA_CPP_MODEL_URI,
    cacheFile: DEFAULT_LLAMA_CPP_MODEL_CACHE_FILE,
  }),
  modelRecipe({
    id: "qwen3.5-4b-q4_k_m",
    name: "Qwen3.5 4B (Q4_K_M)",
    repository: "unsloth/Qwen3.5-4B-GGUF",
    file: "Qwen3.5-4B-Q4_K_M.gguf",
    revision: "e87f176479d0855a907a41277aca2f8ee7a09523",
    sha256: "00fe7986ff5f6b463e62455821146049db6f9313603938a70800d1fb69ef11a4",
    sizeBytes: 2_740_937_888,
    memoryGiB: 6,
    minimumSystemGiB: 8,
    reasoning: true,
    maxTokens: 16384,
  }),
  modelRecipe({
    id: "gemma-4-e2b-it-q4_k_m",
    name: "Gemma 4 E2B (Q4_K_M)",
    repository: "unsloth/gemma-4-E2B-it-GGUF",
    file: "gemma-4-E2B-it-Q4_K_M.gguf",
    revision: "0314792d7f1f7e229411f620751375812bb9faf2",
    sha256: "740185b21d22ceb83a11c3aa62ad5842ef32c70f6096d756bbee85a1e4ec34b8",
    sizeBytes: 3_106_738_272,
    memoryGiB: 6,
    minimumSystemGiB: 8,
  }),
];

export function resolveLlamaCppCatalogArtifact(source: string): CatalogArtifact | undefined {
  return LLAMA_CPP_MODEL_RECIPES.find((recipe) => recipe.model.params?.modelPath === source)
    ?.artifact;
}

type LlamaCppRecommendation =
  | { kind: "unavailable"; reason: string }
  | {
      kind: "recommended";
      recipe: LlamaCppModelRecipe;
      reason: string;
      memoryBudgetBytes: number;
      requiredDiskBytes: number;
    };

export function resolveLlamaCppModelCandidates(
  hardware: LlamaCppHardware,
  backend: "cpu" | "metal" | "cuda",
): { recipes: readonly LlamaCppModelRecipe[]; memoryBudgetBytes: number } {
  // Leave host headroom even on an idle machine. Available memory also limits upgrades
  // on busy hosts; unified memory must not be added to system RAM a second time.
  const systemBudget = Math.min(
    hardware.availableMemoryBytes,
    hardware.totalMemoryBytes - Math.max(2 * GIB, hardware.totalMemoryBytes * 0.25),
  );
  const gpuBudget =
    hardware.accelerator.kind === "cuda"
      ? Math.max(
          0,
          ...hardware.accelerator.devices.map((device) =>
            Math.min(
              device.availableMemoryBytes,
              device.totalMemoryBytes - Math.max(GIB, device.totalMemoryBytes * 0.1),
            ),
          ),
        )
      : 0;
  // Require one device to hold the model; summing cards would assume a topology and
  // tensor-split configuration that setup has not measured or configured.
  const memoryBudgetBytes = backend === "cuda" ? Math.min(systemBudget, gpuBudget) : systemBudget;
  const candidates = LLAMA_CPP_MODEL_RECIPES.filter(
    (recipe) =>
      (!recipe.requiresAcceleration || backend !== "cpu") &&
      hardware.totalMemoryBytes >= recipe.minimumSystemMemoryBytes &&
      memoryBudgetBytes >= recipe.memoryBytes,
  );
  return { recipes: candidates, memoryBudgetBytes };
}

export function recommendLlamaCppModel(
  hardware: LlamaCppHardware,
  backend: "cpu" | "metal" | "cuda",
  cached: { modelIds?: ReadonlySet<string>; embedding?: boolean; runtime?: boolean } = {},
): LlamaCppRecommendation {
  if (
    hardware.availableDiskBytes === undefined ||
    hardware.availableRuntimeDiskBytes === undefined
  ) {
    return {
      kind: "unavailable",
      reason:
        "Cannot measure free space in the model cache or runtime directory. Check their permissions and retry setup.",
    };
  }
  const { recipes: candidates, memoryBudgetBytes } = resolveLlamaCppModelCandidates(
    hardware,
    backend,
  );
  // A custom model cache may be on another volume. Charge each destination only
  // for its own artifacts; shared volumes must fit both allocations together.
  const runtimeDiskBytes = cached.runtime ? 0 : (backend === "cuda" ? 3 : 2) * GIB;
  if (!hardware.sharedDisk && hardware.availableRuntimeDiskBytes < runtimeDiskBytes) {
    return {
      kind: "unavailable",
      reason:
        "There is not enough free disk space in the runtime directory. Free space on that volume and retry setup.",
    };
  }
  const modelDiskBudget = hardware.sharedDisk
    ? Math.min(hardware.availableDiskBytes, hardware.availableRuntimeDiskBytes) - runtimeDiskBytes
    : hardware.availableDiskBytes;
  for (const recipe of candidates) {
    // The archive, extracted runtime and interrupted downloads need working space too.
    const modelDiskBytes =
      (cached.modelIds?.has(recipe.model.id) ? 0 : recipe.sizeBytes) +
      (cached.embedding ? 0 : DEFAULT_LLAMA_CPP_EMBEDDING_MODEL_SIZE_BYTES);
    if (modelDiskBudget < modelDiskBytes) {
      continue;
    }
    const placement =
      backend === "metal"
        ? "Metal unified memory"
        : backend === "cuda"
          ? "NVIDIA GPU memory"
          : "CPU memory";
    return {
      kind: "recommended",
      recipe,
      memoryBudgetBytes,
      requiredDiskBytes: modelDiskBytes + runtimeDiskBytes,
      reason: `${recipe.model.name} fits the ${formatLlamaCppMemory(memoryBudgetBytes)} ${placement} budget with a 64K context. Runtime verification checks the actual model before activation.`,
    };
  }
  return {
    kind: "unavailable",
    reason:
      candidates.length > 0
        ? "There is not enough free disk space for a recommended model, embeddings, and the runtime. Free space in the model cache and retry setup."
        : `No recommended model fits the current ${formatLlamaCppMemory(Math.max(0, memoryBudgetBytes))} memory budget. Close other applications and retry, or configure an existing GGUF or external server.`,
  };
}
