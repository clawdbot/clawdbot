import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeEnv } from "../../runtime.js";
import { listFallbacksCommand } from "./fallbacks-shared.js";

const mocks = vi.hoisted(() => ({
  loadModelsConfig: vi.fn(),
}));

vi.mock("./load-config.js", () => ({
  loadModelsConfig: mocks.loadModelsConfig,
}));

describe("listFallbacksCommand", () => {
  beforeEach(() => {
    mocks.loadModelsConfig.mockReset();
  });

  it.each([
    {
      label: "Fallbacks",
      key: "model" as const,
      commandName: "models fallbacks list",
      model: "anthropic/claude-sonnet-4-6",
    },
    {
      label: "Image fallbacks",
      key: "imageModel" as const,
      commandName: "models image-fallbacks list",
      model: "openai/gpt-image-1",
    },
  ])("attributes $label diagnostics to the real CLI command", async (testCase) => {
    mocks.loadModelsConfig.mockResolvedValue({
      agents: {
        defaults: {
          [testCase.key]: { fallbacks: [testCase.model] },
        },
      },
    });
    const runtime = {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
    } satisfies RuntimeEnv;

    await listFallbacksCommand(
      { label: testCase.label, key: testCase.key },
      { json: true },
      runtime,
    );

    expect(mocks.loadModelsConfig).toHaveBeenCalledWith({
      commandName: testCase.commandName,
      runtime,
    });
    expect(runtime.log).toHaveBeenCalledOnce();
    expect(JSON.parse(runtime.log.mock.calls[0]?.[0] as string)).toEqual({
      fallbacks: [testCase.model],
    });
  });

  it.each([
    { label: "Fallbacks", key: "model" as const, model: "anthropic/claude-sonnet-4-6" },
    { label: "Image fallbacks", key: "imageModel" as const, model: "openai/gpt-image-1" },
  ])("writes populated plain $label directly to stdout", async (testCase) => {
    mocks.loadModelsConfig.mockResolvedValue({
      agents: {
        defaults: {
          [testCase.key]: { fallbacks: [testCase.model] },
        },
      },
    });
    const runtime = {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
      writeStdout: vi.fn(),
      writeJson: vi.fn(),
    };

    await listFallbacksCommand(
      { label: testCase.label, key: testCase.key },
      { plain: true },
      runtime,
    );

    expect(runtime.writeStdout).toHaveBeenCalledExactlyOnceWith(testCase.model);
    expect(runtime.log).not.toHaveBeenCalled();
  });
});
