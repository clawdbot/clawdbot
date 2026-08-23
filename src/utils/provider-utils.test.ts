// Provider utility tests cover provider normalization and utility behavior.
import { beforeEach, describe, expect, it, vi } from "vitest";

const { resolveProviderReasoningOutputModeWithPluginMock } = vi.hoisted(() => ({
  resolveProviderReasoningOutputModeWithPluginMock: vi.fn(),
}));

vi.mock("../plugins/provider-runtime.js", async () => {
  const actual = await vi.importActual<typeof import("../plugins/provider-runtime.js")>(
    "../plugins/provider-runtime.js",
  );
  return {
    ...actual,
    resolveProviderReasoningOutputModeWithPlugin: resolveProviderReasoningOutputModeWithPluginMock,
  };
});

import { isReasoningTagProvider } from "./provider-utils.js";

describe("isReasoningTagProvider", () => {
  beforeEach(() => {
    resolveProviderReasoningOutputModeWithPluginMock.mockReset();
    resolveProviderReasoningOutputModeWithPluginMock.mockReturnValue(undefined);
  });

  it("falls back to provider hooks for unknown providers", () => {
    resolveProviderReasoningOutputModeWithPluginMock.mockReturnValue("tagged");

    expect(
      isReasoningTagProvider("custom-provider", {
        workspaceDir: process.cwd(),
        modelId: "custom/model",
      }),
    ).toBe(true);
    expect(resolveProviderReasoningOutputModeWithPluginMock).toHaveBeenCalledTimes(1);
  });

  it("returns native when hooks do not provide an override", () => {
    expect(isReasoningTagProvider("custom-provider")).toBe(false);
    expect(resolveProviderReasoningOutputModeWithPluginMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["google-generative-ai", false],
    [null, false],
    [undefined, false],
    ["", false],
  ] as const)("returns %s for %s", (value, expected) => {
    expect(isReasoningTagProvider(value, { workspaceDir: process.cwd() })).toBe(expected);
  });

  it.each([
    ["google", true],
    ["Google", true],
    ["google-gemini-cli", true],
    ["anthropic", false],
    ["openai", false],
    ["openrouter", false],
    ["ollama", false],
    ["minimax", false],
    ["minimax-cn", false],
  ] as const)("uses provider hooks when available for %s", (value, expected) => {
    resolveProviderReasoningOutputModeWithPluginMock.mockReturnValueOnce(
      expected ? "tagged" : "native",
    );

    expect(isReasoningTagProvider(value, { workspaceDir: process.cwd() })).toBe(expected);
    expect(resolveProviderReasoningOutputModeWithPluginMock).toHaveBeenCalledTimes(1);
  });
});
