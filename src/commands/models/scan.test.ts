import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelScanResult } from "../../agents/model-scan.js";
import type { RuntimeEnv } from "../../runtime.js";

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

describe("models scan command", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("does not load config or resolve secrets for metadata-only scans", async () => {
    const runtime = createRuntime();
    mocks.scanOpenRouterModels.mockResolvedValue([scanResult()]);

    await modelsScanCommand({ probe: false }, runtime);

    expect(mocks.loadModelsConfig).not.toHaveBeenCalled();
    expect(mocks.resolveApiKeyForProvider).not.toHaveBeenCalled();
    expect(mocks.scanOpenRouterModels).toHaveBeenCalledTimes(1);
    expect(mocks.scanOpenRouterModels.mock.calls.at(0)?.[0]?.probe).toBe(false);
    expect(runtime.lines.join("\n")).toContain("metadata only");
    expect(runtime.lines.join("\n")).toContain("Tool");
    expect(runtime.lines.join("\n")).toContain("skip");
  });

  it("downgrades to metadata-only scan when no OpenRouter key is configured", async () => {
    const runtime = createRuntime();
    vi.stubEnv("OPENROUTER_API_KEY", undefined);
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
    expect(mocks.scanOpenRouterModels.mock.calls.at(0)?.[0]?.probe).toBe(false);
    expect(runtime.lines.join("\n")).toContain("still require OPENROUTER_API_KEY");
  });

  it("uses OPENROUTER_API_KEY directly without loading model config", async () => {
    const runtime = createRuntime();
    vi.stubEnv("OPENROUTER_API_KEY", "sk-or-test");
    mocks.scanOpenRouterModels.mockResolvedValue([
      scanResult({ tool: { ok: false, latencyMs: null, skipped: false } }),
    ]);

    await expect(modelsScanCommand({ json: true }, runtime)).rejects.toThrow(
      /No tool-capable OpenRouter free models found/,
    );

    expect(mocks.loadModelsConfig).not.toHaveBeenCalled();
    expect(mocks.resolveApiKeyForProvider).not.toHaveBeenCalled();
    expect(mocks.scanOpenRouterModels).toHaveBeenCalledTimes(1);
    const scanRequest = mocks.scanOpenRouterModels.mock.calls.at(0)?.[0];
    expect(scanRequest?.apiKey).toBe("sk-or-test");
    expect(scanRequest?.probe).toBe(true);
  });

  it("rejects applying metadata-only scan results", async () => {
    const runtime = createRuntime();
    vi.stubEnv("OPENROUTER_API_KEY", undefined);

    await expect(modelsScanCommand({ probe: false, setDefault: true }, runtime)).rejects.toThrow(
      /Cannot apply metadata-only OpenRouter scan results/,
    );

    expect(mocks.scanOpenRouterModels).not.toHaveBeenCalled();
  });

  it("rejects applying auto-downgraded metadata-only scan results before scanning", async () => {
    const runtime = createRuntime();
    vi.stubEnv("OPENROUTER_API_KEY", undefined);
    mocks.loadModelsConfig.mockResolvedValue({});
    mocks.resolveApiKeyForProvider.mockResolvedValue({ apiKey: "" });

    await expect(modelsScanCommand({ setDefault: true }, runtime)).rejects.toThrow(
      /Cannot apply metadata-only OpenRouter scan results/,
    );

    expect(mocks.scanOpenRouterModels).not.toHaveBeenCalled();
  });
});
