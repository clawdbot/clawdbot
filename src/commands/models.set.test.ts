import { beforeEach, describe, expect, it, vi } from "vitest";

const readConfigFileSnapshot = vi.fn();
const writeConfigFile = vi.fn().mockResolvedValue(undefined);
const loadConfig = vi.fn().mockReturnValue({});

vi.mock("../config/config.js", () => ({
  CONFIG_PATH: "/tmp/moltbot.json",
  readConfigFileSnapshot,
  writeConfigFile,
  loadConfig,
}));

describe("models set + fallbacks", () => {
  beforeEach(() => {
    readConfigFileSnapshot.mockReset();
    writeConfigFile.mockClear();
  });

  it("normalizes z.ai provider in models set", async () => {
    readConfigFileSnapshot.mockResolvedValue({
      path: "/tmp/moltbot.json",
      exists: true,
      raw: "{}",
      parsed: {},
      valid: true,
      config: {},
      issues: [],
      legacyIssues: [],
    });

    const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
    const { modelsSetCommand } = await import("./models/set.js");

    await modelsSetCommand("z.ai/glm-4.7", runtime);

    expect(writeConfigFile).toHaveBeenCalledTimes(1);
    const written = writeConfigFile.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(written.agents).toEqual({
      defaults: {
        model: { primary: "zai/glm-4.7" },
        models: { "zai/glm-4.7": {} },
      },
    });
  });

  it("normalizes z-ai provider in models fallbacks add", async () => {
    readConfigFileSnapshot.mockResolvedValue({
      path: "/tmp/moltbot.json",
      exists: true,
      raw: "{}",
      parsed: {},
      valid: true,
      config: { agents: { defaults: { model: { fallbacks: [] } } } },
      issues: [],
      legacyIssues: [],
    });

    const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
    const { modelsFallbacksAddCommand } = await import("./models/fallbacks.js");

    await modelsFallbacksAddCommand("z-ai/glm-4.7", runtime);

    expect(writeConfigFile).toHaveBeenCalledTimes(1);
    const written = writeConfigFile.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(written.agents).toEqual({
      defaults: {
        model: { fallbacks: ["zai/glm-4.7"] },
        models: { "zai/glm-4.7": {} },
      },
    });
  });

  it("normalizes provider casing in models set", async () => {
    readConfigFileSnapshot.mockResolvedValue({
      path: "/tmp/moltbot.json",
      exists: true,
      raw: "{}",
      parsed: {},
      valid: true,
      config: {},
      issues: [],
      legacyIssues: [],
    });

    const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
    const { modelsSetCommand } = await import("./models/set.js");

    await modelsSetCommand("Z.AI/glm-4.7", runtime);

    expect(writeConfigFile).toHaveBeenCalledTimes(1);
    const written = writeConfigFile.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(written.agents).toEqual({
      defaults: {
        model: { primary: "zai/glm-4.7" },
        models: { "zai/glm-4.7": {} },
      },
    });
  });
});
