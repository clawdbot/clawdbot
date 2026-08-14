import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_LLAMA_CPP_MODEL_CACHE_FILE,
  DEFAULT_LLAMA_CPP_MODEL_SHA256,
  DEFAULT_LLAMA_CPP_MODEL_URI,
} from "./defaults.js";
import {
  inspectLlamaCppModelFile,
  resolveLlamaCppModelCacheInspectionTarget,
} from "./model-cache.js";

const roots = new Set<string>();

afterEach(async () => {
  await Promise.all([...roots].map((root) => fs.rm(root, { recursive: true, force: true })));
  roots.clear();
});

async function writeModel(contents: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-llama-cache-"));
  roots.add(root);
  const filePath = path.join(root, "model.gguf");
  await fs.writeFile(filePath, contents);
  return filePath;
}

describe("inspectLlamaCppModelFile", () => {
  it("distinguishes missing, invalid, and GGUF files", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-llama-cache-"));
    roots.add(root);
    const missing = path.join(root, "missing.gguf");
    const invalid = await writeModel("not-a-gguf");
    const valid = await writeModel("GGUFtest");

    await expect(inspectLlamaCppModelFile({ filePath: missing })).resolves.toEqual({
      status: "missing",
    });
    await expect(inspectLlamaCppModelFile({ filePath: invalid })).resolves.toEqual({
      status: "invalid",
    });
    await expect(inspectLlamaCppModelFile({ filePath: valid })).resolves.toEqual({
      status: "ready",
    });
  });

  it("validates a known cached artifact by SHA-256", async () => {
    const filePath = await writeModel("GGUFknown-model");
    const expectedSha256 = createHash("sha256").update("GGUFknown-model").digest("hex");

    await expect(inspectLlamaCppModelFile({ filePath, expectedSha256 })).resolves.toEqual({
      status: "ready",
    });
    await expect(
      inspectLlamaCppModelFile({ filePath, expectedSha256: "0".repeat(64) }),
    ).resolves.toEqual({ status: "invalid" });
  });
});

describe("resolveLlamaCppModelCacheInspectionTarget", () => {
  const cacheDir = path.join(os.tmpdir(), "openclaw-llama-models");

  it("resolves local, known default, and HTTPS cache paths without network access", () => {
    expect(
      resolveLlamaCppModelCacheInspectionTarget({
        source: "relative/chat.gguf",
        cacheDir,
      }),
    ).toEqual({
      status: "inspectable",
      sourceKind: "local",
      filePath: path.join(cacheDir, "relative/chat.gguf"),
    });
    expect(
      resolveLlamaCppModelCacheInspectionTarget({
        source: DEFAULT_LLAMA_CPP_MODEL_URI,
        cacheDir,
      }),
    ).toEqual({
      status: "inspectable",
      sourceKind: "remote",
      filePath: path.join(cacheDir, DEFAULT_LLAMA_CPP_MODEL_CACHE_FILE),
      expectedSha256: DEFAULT_LLAMA_CPP_MODEL_SHA256,
    });
    expect(
      resolveLlamaCppModelCacheInspectionTarget({
        source: "https://models.example/chat.gguf?download=true",
        cacheDir,
      }),
    ).toEqual({
      status: "inspectable",
      sourceKind: "remote",
      filePath: path.join(cacheDir, "chat.gguf"),
    });
  });

  it("fails closed for remote identities that require metadata or name no GGUF", () => {
    expect(
      resolveLlamaCppModelCacheInspectionTarget({
        source: "hf:example/model",
        cacheDir,
      }),
    ).toMatchObject({ status: "indeterminate" });
    expect(
      resolveLlamaCppModelCacheInspectionTarget({
        source: "https://models.example/model.bin",
        cacheDir,
      }),
    ).toMatchObject({ status: "invalid" });
  });
});
