import { describe, expect, it } from "vitest";
import { OPENCLAW_EMBEDDED_CONTEXT_ENGINE_HOST } from "./host-compat.js";
import { buildContextEngineRuntimeSettings } from "./runtime-settings.js";

describe("context engine runtime settings", () => {
  it("builds declared normal runtime settings from host and model inputs", () => {
    const settings = buildContextEngineRuntimeSettings({
      contextEngineHost: OPENCLAW_EMBEDDED_CONTEXT_ENGINE_HOST,
      harnessId: "embedded",
      runtimeId: "direct",
      provider: "openai",
      requestedModel: "gpt-5.5",
      resolvedModel: "gpt-5.5",
      selectedContextEngineId: "hypermem",
      contextEngineSelectionSource: "configured",
      promptTokenBudget: 128_000,
      maxOutputTokens: 8192,
    });

    expect(settings).toMatchObject({
      schemaVersion: 1,
      runtime: {
        host: "openclaw",
        mode: "normal",
        harnessId: "embedded",
        runtimeId: "direct",
      },
      model: {
        requested: "gpt-5.5",
        resolved: "gpt-5.5",
        provider: "openai",
      },
      contextEngineSelection: {
        selectedId: "hypermem",
        source: "configured",
      },
      executionHost: {
        id: OPENCLAW_EMBEDDED_CONTEXT_ENGINE_HOST.id,
        label: OPENCLAW_EMBEDDED_CONTEXT_ENGINE_HOST.label,
      },
      limits: {
        promptTokenBudget: 128_000,
        maxOutputTokens: 8192,
      },
      diagnostics: {
        fallbackReason: null,
        degradedReason: null,
      },
    });
  });

  it("marks fallback mode when a fallback reason is present", () => {
    const settings = buildContextEngineRuntimeSettings({
      contextEngineHost: OPENCLAW_EMBEDDED_CONTEXT_ENGINE_HOST,
      resolvedModel: "gpt-5-mini",
      fallbackReason: "primary_unavailable",
    });

    expect(settings.runtime.mode).toBe("fallback");
    expect(settings.diagnostics.fallbackReason).toBe("provider_unavailable");
  });

  it("preserves known fallback reason codes", () => {
    const settings = buildContextEngineRuntimeSettings({
      contextEngineHost: OPENCLAW_EMBEDDED_CONTEXT_ENGINE_HOST,
      resolvedModel: "gpt-5-mini",
      fallbackReason: "provider_timeout",
    });

    expect(settings.runtime.mode).toBe("fallback");
    expect(settings.diagnostics.fallbackReason).toBe("provider_timeout");
  });

  it("marks fallback mode when resolved model differs from the requested model", () => {
    const settings = buildContextEngineRuntimeSettings({
      contextEngineHost: OPENCLAW_EMBEDDED_CONTEXT_ENGINE_HOST,
      requestedModel: "openai/gpt-5.5",
      resolvedModel: "anthropic/claude-sonnet-4-6",
    });

    expect(settings.runtime.mode).toBe("fallback");
    expect(settings.diagnostics.fallbackReason).toBeNull();
  });

  it("marks degraded mode when a degraded reason is present", () => {
    const settings = buildContextEngineRuntimeSettings({
      contextEngineHost: OPENCLAW_EMBEDDED_CONTEXT_ENGINE_HOST,
      resolvedModel: "gpt-5-mini",
      degradedReason: "context_pressure_high",
    });

    expect(settings.runtime.mode).toBe("degraded");
    expect(settings.diagnostics.degradedReason).toBe("context_overflow");
  });

  it("keeps host and selection ids nullable when unknown", () => {
    const settings = buildContextEngineRuntimeSettings({
      contextEngineHost: {
        ...OPENCLAW_EMBEDDED_CONTEXT_ENGINE_HOST,
        id: "",
      },
    });

    expect(settings.contextEngineSelection).toEqual({
      selectedId: null,
      source: "unknown",
    });
    expect(settings.executionHost.id).toBeNull();
  });
});
