import { afterEach, expect, it, vi } from "vitest";

afterEach(() => {
  vi.doUnmock("openclaw/plugin-sdk/agent-harness-tool-authority-runtime");
  vi.resetModules();
});

it("does not load the private tool builder before a tool-capable turn", async () => {
  let toolBuilderImports = 0;
  vi.doMock("openclaw/plugin-sdk/agent-harness-tool-authority-runtime", () => {
    toolBuilderImports += 1;
    return {
      createOpenClawCodingToolsForAgentHarness: vi.fn(() => []),
    };
  });

  const { buildDynamicTools } = await import("./dynamic-tool-build.js");
  await import("./side-question.js");
  expect(toolBuilderImports).toBe(0);

  await expect(
    buildDynamicTools({
      attributionAttempt: {} as never,
      params: { disableTools: true } as never,
    } as never),
  ).resolves.toEqual([]);
  expect(toolBuilderImports).toBe(0);

  await expect(
    buildDynamicTools({
      attributionAttempt: {} as never,
      params: {
        disableTools: false,
        model: { compat: { supportsTools: false } },
      } as never,
    } as never),
  ).resolves.toEqual([]);
  expect(toolBuilderImports).toBe(0);
});
