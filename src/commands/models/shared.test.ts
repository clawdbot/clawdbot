import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { applyDefaultModelPrimaryUpdate, loadValidConfigOrThrow, updateConfig } from "./shared.js";

const mocks = vi.hoisted(() => ({
  readConfigFileSnapshot: vi.fn(),
  replaceConfigFile: vi.fn(),
}));

vi.mock("../../config/config.js", () => ({
  readConfigFileSnapshot: (...args: unknown[]) => mocks.readConfigFileSnapshot(...args),
  replaceConfigFile: (...args: unknown[]) => mocks.replaceConfigFile(...args),
}));

describe("models/shared", () => {
  beforeEach(() => {
    mocks.readConfigFileSnapshot.mockClear();
    mocks.replaceConfigFile.mockClear();
  });

  it("returns config when snapshot is valid", async () => {
    const cfg = { providers: {} } as unknown as OpenClawConfig;
    mocks.readConfigFileSnapshot.mockResolvedValue({
      valid: true,
      runtimeConfig: cfg,
      config: cfg,
    });

    await expect(loadValidConfigOrThrow()).resolves.toBe(cfg);
  });

  it("throws formatted issues when snapshot is invalid", async () => {
    mocks.readConfigFileSnapshot.mockResolvedValue({
      valid: false,
      path: "/tmp/openclaw.json",
      issues: [{ path: "providers.openai.apiKey", message: "Required" }],
    });

    await expect(loadValidConfigOrThrow()).rejects.toThrowError(
      "Invalid config at /tmp/openclaw.json\n- providers.openai.apiKey: Required",
    );
  });

  it("updateConfig writes mutated config", async () => {
    const cfg = { update: { channel: "stable" } } as unknown as OpenClawConfig;
    mocks.readConfigFileSnapshot.mockResolvedValue({
      valid: true,
      hash: "config-1",
      sourceConfig: cfg,
      config: cfg,
    });
    mocks.replaceConfigFile.mockResolvedValue(undefined);

    await updateConfig((current) => ({
      ...current,
      update: { channel: "beta" },
    }));

    expect(mocks.replaceConfigFile).toHaveBeenCalledWith({
      nextConfig: expect.objectContaining({
        update: { channel: "beta" },
      }),
      baseHash: "config-1",
    });
  });

  it("leaves OpenAI default model updates on the existing runtime", () => {
    const next = applyDefaultModelPrimaryUpdate({
      cfg: {},
      modelRaw: "openai/gpt-5.5",
      field: "model",
    });

    expect(next.agents?.defaults?.model).toEqual({ primary: "openai/gpt-5.5" });
    expect(next.agents?.defaults?.agentRuntime).toBeUndefined();
  });

  it("pins OpenAI Codex default model updates to the Codex runtime", () => {
    const next = applyDefaultModelPrimaryUpdate({
      cfg: {},
      modelRaw: "openai-codex/gpt-5.5",
      field: "model",
    });

    expect(next.agents?.defaults?.model).toEqual({ primary: "openai-codex/gpt-5.5" });
    expect(next.agents?.defaults?.agentRuntime).toEqual({ id: "codex" });
  });

  it("leaves custom OpenAI-compatible default model updates on the existing runtime", () => {
    const next = applyDefaultModelPrimaryUpdate({
      cfg: {
        models: {
          providers: {
            openai: {
              baseUrl: "https://compatible.example.test/v1",
              api: "openai-responses",
              models: [],
            },
          },
        },
      },
      modelRaw: "openai/custom-gpt",
      field: "model",
    });

    expect(next.agents?.defaults?.model).toEqual({ primary: "openai/custom-gpt" });
    expect(next.agents?.defaults?.agentRuntime).toBeUndefined();
  });
});
