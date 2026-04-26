import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  logProviderToolSchemaDiagnostics: vi.fn(),
  normalizeProviderToolSchemas: vi.fn((params: { tools: unknown[] }) => params.tools),
}));

vi.mock("../pi-embedded-runner/tool-schema-runtime.js", () => ({
  logProviderToolSchemaDiagnostics: mocks.logProviderToolSchemaDiagnostics,
  normalizeProviderToolSchemas: mocks.normalizeProviderToolSchemas,
}));

const { logAgentRuntimeToolDiagnostics } = await import("./tools.js");

describe("AgentRuntimePlan tool diagnostics legacy fallback", () => {
  it("falls back to provider diagnostics when no RuntimePlan is available", () => {
    const tools = [{ name: "alpha" }] as never;

    logAgentRuntimeToolDiagnostics({
      tools,
      provider: "openai",
      modelId: "gpt-5.4",
      modelApi: "openai-responses",
      workspaceDir: "/tmp/openclaw-runtime-plan-tools",
    });

    expect(mocks.logProviderToolSchemaDiagnostics).toHaveBeenCalledWith(
      expect.objectContaining({
        tools,
        provider: "openai",
        modelId: "gpt-5.4",
        modelApi: "openai-responses",
        workspaceDir: "/tmp/openclaw-runtime-plan-tools",
      }),
    );
  });
});
