// Model scan tests cover provider scan behavior and discovered model output.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelScanResult } from "../../agents/model-scan.js";
import type { RuntimeEnv } from "../../runtime.js";
import { withEnvAsync } from "../../test-utils/env.js";

const mocks = vi.hoisted(() => ({
  loadModelsConfig: vi.fn(),
  resolveApiKeyForProvider: vi.fn(),
  scanOpenRouterModels: vi.fn(),
}));

vi.mock("./load-config.js", () => ({
  loadModelsConfig: mocks.loadModelsConfig,
}));

vi.mock("../../agents/model-auth.js", () => ({
  resolveApiKeyForProvider: mocks.resolveApiKeyForProvider,
}));

vi.mock("../../agents/model-scan.js", () => ({
  scanOpenRouterModels: mocks.scanOpenRouterModels,
}));

const { modelsScanCommand } = await import("./scan.js");

function createRuntime(): RuntimeEnv & { lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    log: (...args: unknown[]) => lines.push(args.join(" ")),
    error: (...args: unknown[]) => lines.push(args.join(" ")),
    exit: (code?: number) => {
      throw new Error(`exit ${code ?? 0}`);
    },
  } as RuntimeEnv & { lines: string[] };
}

function scanResult(overrides: Partial<ModelScanResult> = {}): ModelScanResult {
  return {
    id: "acme/free:free",
    name: "ACME Free",
    provider: "openrouter",
    modelRef: "openrouter/acme/free:free",
    contextLength: 128_000,
    maxCompletionTokens: 8192,
    supportedParametersCount: 2,
    supportsToolsMeta: true,
    modality: "text",
    inferredParamB: 70,
    createdAtMs: 1_700_000_000_000,
    pricing: { prompt: 0, completion: 0, request: 0, image: 0, webSearch: 0, internalReasoning: 0 },
    isFree: true,
    tool: { ok: false, latencyMs: null, skipped: true },
    image: { ok: false, latencyMs: null, skipped: true },
    ...overrides,
  };
}

function firstScanRequest(): { apiKey?: string; probe?: boolean } {
  const call = mocks.scanOpenRouterModels.mock.calls[0];
  if (!call) {
    throw new Error("expected OpenRouter scan call");
  }
  return call[0] as { apiKey?: string; probe?: boolean };
}

function withOpenRouterApiKey<T>(apiKey: string | undefined, fn: () => Promise<T>): Promise<T> {
  return withEnvAsync({ OPENROUTER_API_KEY: apiKey }, fn);
}

describe("models scan command", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does not load config or resolve secrets for metadata-only scans", async () => {
    const runtime = createRuntime();
    mocks.scanOpenRouterModels.mockResolvedValue([scanResult()]);

    await modelsScanCommand({ probe: false }, runtime);

    expect(mocks.loadModelsConfig).not.toHaveBeenCalled();
    expect(mocks.resolveApiKeyForProvider).not.toHaveBeenCalled();
    expect(mocks.scanOpenRouterModels).toHaveBeenCalledTimes(1);
    expect(firstScanRequest().probe).toBe(false);
    expect(runtime.lines.join("\n")).toContain("metadata only");
    expect(runtime.lines.join("\n")).toContain("Tool");
    expect(runtime.lines.join("\n")).toContain("skip");
  });

  it("prints metadata-only JSON in the same deterministic ranking as the table", async () => {
    const runtime = createRuntime();
    mocks.scanOpenRouterModels.mockResolvedValue([
      scanResult({
        id: "zeta/free:free",
        modelRef: "openrouter/zeta/free:free",
        contextLength: 128_000,
      }),
      scanResult({
        id: "alpha/free:free",
        modelRef: "openrouter/alpha/free:free",
        contextLength: 128_000,
      }),
      scanResult({
        id: "larger/free:free",
        modelRef: "openrouter/larger/free:free",
        contextLength: 256_000,
      }),
    ]);

    await modelsScanCommand({ probe: false, json: true }, runtime);

    expect(runtime.lines).toHaveLength(1);
    const results = JSON.parse(runtime.lines[0] ?? "") as ModelScanResult[];
    expect(results.map((result) => result.modelRef)).toEqual([
      "openrouter/larger/free:free",
      "openrouter/alpha/free:free",
      "openrouter/zeta/free:free",
    ]);
    expect(mocks.loadModelsConfig).not.toHaveBeenCalled();
    expect(mocks.resolveApiKeyForProvider).not.toHaveBeenCalled();
  });

  it("sanitizes provider-controlled model refs and modality in scan tables", async () => {
    const runtime = createRuntime();
    mocks.scanOpenRouterModels.mockResolvedValue([
      scanResult({
        modelRef: "openrouter/evil\u001b[31m\nmodel:free",
        modality: "text\u001b[31m\nnext\tvalue\u0007",
      }),
    ]);

    await modelsScanCommand({ probe: false }, runtime);

    const row = runtime.lines.find((line) => line.includes("openrouter/evil"));
    expect(row).toContain("openrouter/evil\\nmodel:free");
    expect(row).toContain("modality:text\\nnext\\tvalue");
    expect(
      Array.from(row ?? "").every((character) => {
        const code = character.charCodeAt(0);
        return code > 0x1f && (code < 0x7f || code > 0x9f);
      }),
    ).toBe(true);
  });

  it("downgrades to metadata-only scan when no OpenRouter key is configured", async () => {
    await withOpenRouterApiKey(undefined, async () => {
      const runtime = createRuntime();
      mocks.loadModelsConfig.mockResolvedValue({});
      mocks.resolveApiKeyForProvider.mockResolvedValue({ apiKey: "" });
      mocks.scanOpenRouterModels.mockResolvedValue([scanResult()]);

      await modelsScanCommand({}, runtime);

      expect(mocks.loadModelsConfig).toHaveBeenCalledTimes(1);
      expect(mocks.resolveApiKeyForProvider).toHaveBeenCalledWith({
        provider: "openrouter",
        cfg: {},
      });
      expect(mocks.scanOpenRouterModels).toHaveBeenCalledTimes(1);
      expect(firstScanRequest().probe).toBe(false);
      expect(runtime.lines.join("\n")).toContain("still require OPENROUTER_API_KEY");
    });
  });

  it("uses OPENROUTER_API_KEY directly without loading model config", async () => {
    await withOpenRouterApiKey("sk-or-test", async () => {
      const runtime = createRuntime();
      mocks.scanOpenRouterModels.mockResolvedValue([
        scanResult({ tool: { ok: false, latencyMs: null, skipped: false } }),
      ]);

      await expect(modelsScanCommand({ json: true }, runtime)).rejects.toThrow(
        /No tool-capable OpenRouter free models found/,
      );

      expect(mocks.loadModelsConfig).not.toHaveBeenCalled();
      expect(mocks.resolveApiKeyForProvider).not.toHaveBeenCalled();
      expect(mocks.scanOpenRouterModels).toHaveBeenCalledTimes(1);
      const scanRequest = firstScanRequest();
      expect(scanRequest?.apiKey).toBe("sk-or-test");
      expect(scanRequest?.probe).toBe(true);
    });
  });

  it("rejects applying metadata-only scan results", async () => {
    await withOpenRouterApiKey(undefined, async () => {
      const runtime = createRuntime();

      await expect(modelsScanCommand({ probe: false, setDefault: true }, runtime)).rejects.toThrow(
        /Cannot apply metadata-only OpenRouter scan results/,
      );

      expect(mocks.scanOpenRouterModels).not.toHaveBeenCalled();
    });
  });

  it.each([
    [{ minParams: "7b" }, "--min-params"],
    [{ maxAgeDays: "30d" }, "--max-age-days"],
    [{ maxCandidates: "2.5" }, "--max-candidates"],
    [{ timeout: "1000ms" }, "--timeout"],
    [{ concurrency: "2x" }, "--concurrency"],
  ])("rejects partial numeric option %s", async (opts, label) => {
    const runtime = createRuntime();

    await expect(modelsScanCommand(opts, runtime)).rejects.toThrow(label);

    expect(mocks.scanOpenRouterModels).not.toHaveBeenCalled();
  });

  it("rejects applying auto-downgraded metadata-only scan results before scanning", async () => {
    await withOpenRouterApiKey(undefined, async () => {
      const runtime = createRuntime();
      mocks.loadModelsConfig.mockResolvedValue({});
      mocks.resolveApiKeyForProvider.mockResolvedValue({ apiKey: "" });

      await expect(modelsScanCommand({ setDefault: true }, runtime)).rejects.toThrow(
        /Cannot apply metadata-only OpenRouter scan results/,
      );

      expect(mocks.scanOpenRouterModels).not.toHaveBeenCalled();
    });
  });
});
