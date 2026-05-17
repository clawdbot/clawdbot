import { describe, expect, it, vi } from "vitest";
import { qaSuiteProgressTesting, runQaSuite } from "./suite.js";

describe("qa suite", () => {
  it("rejects unsupported transport ids before starting the lab", async () => {
    const startLab = vi.fn();

    await expect(
      runQaSuite({
        transportId: "qa-nope" as unknown as "qa-channel",
        startLab,
      }),
    ).rejects.toThrow("unsupported QA transport: qa-nope");

    expect(startLab).not.toHaveBeenCalled();
  });

  it("parses progress env booleans", () => {
    expect(qaSuiteProgressTesting.parseQaSuiteBooleanEnv("true")).toBe(true);
    expect(qaSuiteProgressTesting.parseQaSuiteBooleanEnv("on")).toBe(true);
    expect(qaSuiteProgressTesting.parseQaSuiteBooleanEnv("false")).toBe(false);
    expect(qaSuiteProgressTesting.parseQaSuiteBooleanEnv("off")).toBe(false);
    expect(qaSuiteProgressTesting.parseQaSuiteBooleanEnv("maybe")).toBeUndefined();
  });

  it("defaults progress logging from CI when no override is set", () => {
    expect(qaSuiteProgressTesting.shouldLogQaSuiteProgress({ CI: "true" })).toBe(true);
    expect(qaSuiteProgressTesting.shouldLogQaSuiteProgress({ CI: "false" })).toBe(false);
  });

  it("resolves transport-ready timeout from params and env", () => {
    expect(qaSuiteProgressTesting.resolveQaSuiteTransportReadyTimeoutMs(undefined, {})).toBe(
      120_000,
    );
    expect(
      qaSuiteProgressTesting.resolveQaSuiteTransportReadyTimeoutMs(undefined, {
        OPENCLAW_QA_TRANSPORT_READY_TIMEOUT_MS: "180000",
      }),
    ).toBe(180_000);
    expect(
      qaSuiteProgressTesting.resolveQaSuiteTransportReadyTimeoutMs(undefined, {
        OPENCLAW_QA_TRANSPORT_READY_TIMEOUT_MS: "bad",
      }),
    ).toBe(120_000);
    expect(qaSuiteProgressTesting.resolveQaSuiteTransportReadyTimeoutMs(90_000, {})).toBe(90_000);
  });

  it("applies OPENCLAW_QA_SUITE_PROGRESS override and falls back on invalid values", () => {
    expect(
      qaSuiteProgressTesting.shouldLogQaSuiteProgress({
        CI: "false",
        OPENCLAW_QA_SUITE_PROGRESS: "true",
      }),
    ).toBe(true);
    expect(
      qaSuiteProgressTesting.shouldLogQaSuiteProgress({
        CI: "true",
        OPENCLAW_QA_SUITE_PROGRESS: "false",
      }),
    ).toBe(false);
    expect(
      qaSuiteProgressTesting.shouldLogQaSuiteProgress({
        CI: "false",
        OPENCLAW_QA_SUITE_PROGRESS: "on",
      }),
    ).toBe(true);
    expect(
      qaSuiteProgressTesting.shouldLogQaSuiteProgress({
        CI: "true",
        OPENCLAW_QA_SUITE_PROGRESS: "off",
      }),
    ).toBe(false);
    expect(
      qaSuiteProgressTesting.shouldLogQaSuiteProgress({
        CI: "true",
        OPENCLAW_QA_SUITE_PROGRESS: "definitely",
      }),
    ).toBe(true);
  });

  it("sanitizes scenario ids for progress logs", () => {
    expect(qaSuiteProgressTesting.sanitizeQaSuiteProgressValue("scenario-id")).toBe("scenario-id");
    expect(qaSuiteProgressTesting.sanitizeQaSuiteProgressValue("scenario\nid\tvalue")).toBe(
      "scenario id value",
    );
    expect(qaSuiteProgressTesting.sanitizeQaSuiteProgressValue("\u0000\u0001")).toBe("<empty>");
  });

  it("builds a codex mock runtime env patch that stays on the QA mock provider", () => {
    expect(
      qaSuiteProgressTesting.buildQaRuntimeEnvPatch({
        providerMode: "mock-openai",
        forcedRuntime: "codex",
        mockBaseUrl: "http://127.0.0.1:44080",
      }),
    ).toEqual({
      OPENCLAW_BUILD_PRIVATE_QA: "1",
      OPENCLAW_QA_FORCE_RUNTIME: "codex",
      OPENCLAW_CODEX_APP_SERVER_ARGS:
        "app-server -c openai_base_url=http://127.0.0.1:44080/v1 --listen stdio://",
      OPENAI_API_KEY: "qa-mock-openai-key",
      CODEX_API_KEY: "qa-mock-openai-key",
    });
  });

  it("omits mock OpenAI rewiring for non-codex runtime overrides", () => {
    expect(
      qaSuiteProgressTesting.buildQaRuntimeEnvPatch({
        providerMode: "mock-openai",
        forcedRuntime: "pi",
        mockBaseUrl: "http://127.0.0.1:44080",
      }),
    ).toEqual({
      OPENCLAW_BUILD_PRIVATE_QA: "1",
      OPENCLAW_QA_FORCE_RUNTIME: "pi",
    });
  });

  it("remaps mock-openai model refs onto the app-server OpenAI provider for codex cells only", () => {
    expect(
      qaSuiteProgressTesting.remapModelRefForForcedRuntime({
        modelRef: "mock-openai/gpt-5.5",
        providerMode: "mock-openai",
        forcedRuntime: "codex",
      }),
    ).toBe("openai/gpt-5.5");
    expect(
      qaSuiteProgressTesting.remapModelRefForForcedRuntime({
        modelRef: "mock-openai/gpt-5.5",
        providerMode: "mock-openai",
        forcedRuntime: "pi",
      }),
    ).toBe("mock-openai/gpt-5.5");
  });
});
