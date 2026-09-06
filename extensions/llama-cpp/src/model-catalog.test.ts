import { describe, expect, it } from "vitest";
import type { LlamaCppHardware } from "./hardware.js";
import { recommendLlamaCppModel, resolveLlamaCppCatalogArtifact } from "./model-catalog.js";

const GIB = 1024 ** 3;
const SMALL_MODEL = "qwen3.5-4b-q4_k_m";
const MEDIUM_MODEL = "qwen3.5-9b-q4_k_m";
const LARGE_MODEL = "qwen3.8-27b-ud-q4_k_m";

function hardware(memoryGiB: number): LlamaCppHardware {
  return {
    platform: "darwin",
    arch: "arm64",
    totalMemoryBytes: memoryGiB * GIB,
    availableMemoryBytes: memoryGiB * GIB,
    availableDiskBytes: 100 * GIB,
    availableRuntimeDiskBytes: 100 * GIB,
    sharedDisk: true,
    accelerator: { kind: "metal" },
  };
}

describe("local model recommendation", () => {
  it.each([
    { ram: 8, backend: "metal" as const, modelId: SMALL_MODEL },
    { ram: 16, backend: "metal" as const, modelId: MEDIUM_MODEL },
    { ram: 24, backend: "metal" as const, modelId: "gemma-4-12b-it-q4_k_m" },
    { ram: 32, backend: "metal" as const, modelId: LARGE_MODEL },
    { ram: 64, backend: "cpu" as const, modelId: MEDIUM_MODEL },
  ])("recommends a resident 64K model for $ram GiB on $backend", ({ ram, backend, modelId }) => {
    const result = recommendLlamaCppModel(hardware(ram), backend);

    expect(result).toMatchObject({
      kind: "recommended",
      recipe: { model: { id: modelId, contextWindow: 65536 } },
    });
  });

  it("keeps a busy high-memory host within available memory", () => {
    const host = hardware(128);
    host.availableMemoryBytes = 7 * GIB;

    expect(recommendLlamaCppModel(host, "metal")).toMatchObject({
      kind: "recommended",
      recipe: { model: { id: SMALL_MODEL } },
    });
  });

  it("does not add discrete GPU cards or VRAM to system memory", () => {
    const host = hardware(64);
    host.accelerator = {
      kind: "cuda",
      devices: Array.from({ length: 2 }, () => ({
        name: "NVIDIA Device",
        totalMemoryBytes: 8 * GIB,
        availableMemoryBytes: 8 * GIB,
        driverVersion: "580.65.06",
        computeCapability: 8.9,
      })),
    };

    expect(recommendLlamaCppModel(host, "cuda")).toMatchObject({
      kind: "recommended",
      recipe: { model: { id: SMALL_MODEL } },
    });
  });

  it("chooses a smaller download when only it fits the disk reserve", () => {
    const host = hardware(32);
    host.availableDiskBytes = 6 * GIB;

    expect(recommendLlamaCppModel(host, "metal")).toMatchObject({
      kind: "recommended",
      recipe: { model: { id: SMALL_MODEL } },
    });
  });

  it("uses the smaller cache budget on a 24 GiB NVIDIA card", () => {
    const host = hardware(64);
    host.accelerator = {
      kind: "cuda",
      devices: [
        {
          name: "NVIDIA Device",
          totalMemoryBytes: 24 * GIB,
          availableMemoryBytes: 24 * GIB,
          driverVersion: "580.65.06",
          computeCapability: 8.9,
        },
      ],
    };

    expect(recommendLlamaCppModel(host, "cuda")).toMatchObject({
      kind: "recommended",
      recipe: { model: { id: "muse-glimmer-30b-q4_k_m" } },
    });
  });

  it("charges only missing artifacts when retrying a cached model", () => {
    const host = { ...hardware(8), availableDiskBytes: 128 * 1024 ** 2 };
    expect(recommendLlamaCppModel(host, "metal")).toMatchObject({ kind: "unavailable" });
    expect(
      recommendLlamaCppModel(host, "metal", {
        modelIds: new Set([SMALL_MODEL]),
        embedding: true,
        runtime: true,
      }),
    ).toMatchObject({
      kind: "recommended",
      recipe: { model: { id: SMALL_MODEL } },
      requiredDiskBytes: 0,
    });
    expect(
      recommendLlamaCppModel(host, "metal", {
        modelIds: new Set([SMALL_MODEL]),
        embedding: true,
      }),
    ).toMatchObject({ kind: "unavailable" });
  });

  it.each([
    { cacheGiB: 0.125, runtimeGiB: 10, cached: true, kind: "recommended" },
    { cacheGiB: 100, runtimeGiB: 1, cached: false, kind: "unavailable" },
  ])(
    "checks separate cache/runtime volumes ($cacheGiB/$runtimeGiB GiB)",
    ({ cacheGiB, runtimeGiB, cached, kind }) => {
      const host = {
        ...hardware(8),
        availableDiskBytes: cacheGiB * GIB,
        availableRuntimeDiskBytes: runtimeGiB * GIB,
        sharedDisk: false,
      };
      const result = recommendLlamaCppModel(
        host,
        "metal",
        cached
          ? {
              modelIds: new Set([SMALL_MODEL]),
              embedding: true,
            }
          : {},
      );

      expect(result.kind).toBe(kind);
      if (result.kind === "unavailable") {
        expect(result.reason).toMatch(/runtime/u);
      }
    },
  );

  it.each([
    { host: { ...hardware(32), availableDiskBytes: undefined }, reason: /permissions/u },
    { host: { ...hardware(32), availableDiskBytes: GIB }, reason: /disk space/u },
    { host: hardware(4), reason: /memory budget/u },
  ])("explains why an unsafe download cannot be recommended", ({ host, reason }) => {
    expect(recommendLlamaCppModel(host, "metal")).toMatchObject({
      kind: "unavailable",
      reason: expect.stringMatching(reason),
    });
  });

  it("resolves the selected immutable download and rejects arbitrary sources", () => {
    const result = recommendLlamaCppModel(hardware(8), "metal");
    if (result.kind !== "recommended") {
      throw new Error(result.reason);
    }
    const source = result.recipe.model.params?.modelPath;
    expect(typeof source).toBe("string");
    const artifact = resolveLlamaCppCatalogArtifact(String(source));

    expect(artifact).toMatchObject({
      url: expect.stringContaining("/resolve/e87f176479d0855a907a41277aca2f8ee7a09523/"),
      expectedSize: 2_740_937_888,
      expectedSha256: "00fe7986ff5f6b463e62455821146049db6f9313603938a70800d1fb69ef11a4",
    });
    expect(resolveLlamaCppCatalogArtifact("hf:example/arbitrary/model.gguf")).toBeUndefined();
  });
});
