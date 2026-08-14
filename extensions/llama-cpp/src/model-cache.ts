import { createHash } from "node:crypto";
import type { FileHandle } from "node:fs/promises";
import fs from "node:fs/promises";
import path from "node:path";
import {
  DEFAULT_LLAMA_CPP_EMBEDDING_CACHE_FILE,
  DEFAULT_LLAMA_CPP_EMBEDDING_MODEL,
  DEFAULT_LLAMA_CPP_EMBEDDING_MODEL_SHA256,
  DEFAULT_LLAMA_CPP_MODEL_CACHE_FILE,
  DEFAULT_LLAMA_CPP_MODEL_SHA256,
  DEFAULT_LLAMA_CPP_MODEL_URI,
} from "./defaults.js";

type LlamaCppModelFileInspection =
  | { status: "ready" }
  | { status: "missing" }
  | { status: "invalid" };

type LlamaCppModelCacheInspectionTarget =
  | {
      status: "inspectable";
      filePath: string;
      sourceKind: "local" | "remote";
      expectedSha256?: string;
    }
  | { status: "indeterminate"; reason: string }
  | { status: "invalid"; reason: string };

/**
 * Resolve the exact no-download cache target when that can be done without
 * network metadata. Arbitrary Hugging Face identities stay indeterminate.
 */
export function resolveLlamaCppModelCacheInspectionTarget(params: {
  source: string;
  cacheDir: string;
}): LlamaCppModelCacheInspectionTarget {
  if (params.source === DEFAULT_LLAMA_CPP_MODEL_URI) {
    return {
      status: "inspectable",
      sourceKind: "remote",
      filePath: path.join(params.cacheDir, DEFAULT_LLAMA_CPP_MODEL_CACHE_FILE),
      expectedSha256: DEFAULT_LLAMA_CPP_MODEL_SHA256,
    };
  }
  if (params.source === DEFAULT_LLAMA_CPP_EMBEDDING_MODEL) {
    return {
      status: "inspectable",
      sourceKind: "remote",
      filePath: path.join(params.cacheDir, DEFAULT_LLAMA_CPP_EMBEDDING_CACHE_FILE),
      expectedSha256: DEFAULT_LLAMA_CPP_EMBEDDING_MODEL_SHA256,
    };
  }
  if (/^(?:hf|huggingface):/iu.test(params.source)) {
    return {
      status: "indeterminate",
      reason:
        "Model cache identity requires network resolution, which passive inspection does not perform.",
    };
  }
  if (/^https:\/\//iu.test(params.source)) {
    let fileName: string;
    try {
      fileName = path.basename(decodeURIComponent(new URL(params.source).pathname));
    } catch {
      return { status: "invalid", reason: `Invalid remote model URL: ${params.source}` };
    }
    if (!fileName.toLowerCase().includes(".gguf")) {
      return {
        status: "invalid",
        reason: `Remote model URL must name a GGUF file: ${params.source}`,
      };
    }
    return {
      status: "inspectable",
      sourceKind: "remote",
      filePath: path.join(params.cacheDir, fileName),
    };
  }
  return {
    status: "inspectable",
    sourceKind: "local",
    filePath: path.isAbsolute(params.source)
      ? params.source
      : path.resolve(params.cacheDir, params.source),
  };
}

async function sha256Handle(handle: FileHandle): Promise<string> {
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  let position = 0;
  for (;;) {
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
    if (bytesRead === 0) {
      break;
    }
    hash.update(buffer.subarray(0, bytesRead));
    position += bytesRead;
  }
  return hash.digest("hex");
}

/** Inspect one cached model file without downloading, resolving, or writing it. */
export async function inspectLlamaCppModelFile(params: {
  filePath: string;
  expectedSha256?: string;
}): Promise<LlamaCppModelFileInspection> {
  const handle = await fs.open(params.filePath, "r").catch((error: unknown) => {
    const code = error instanceof Error && "code" in error ? error.code : undefined;
    if (code === "ENOENT") {
      return undefined;
    }
    throw error;
  });
  if (!handle) {
    return { status: "missing" };
  }
  try {
    if (!(await handle.stat()).isFile()) {
      return { status: "invalid" };
    }
    if (params.expectedSha256) {
      const actualSha256 = await sha256Handle(handle);
      return actualSha256 === params.expectedSha256.toLowerCase()
        ? { status: "ready" }
        : { status: "invalid" };
    }
    const header = Buffer.alloc(4);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    return bytesRead === 4 && header.toString("ascii") === "GGUF"
      ? { status: "ready" }
      : { status: "invalid" };
  } finally {
    await handle.close();
  }
}
