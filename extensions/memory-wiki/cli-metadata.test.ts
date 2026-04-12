import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTestPluginApi } from "../../test/helpers/plugins/plugin-api.js";

const mocks = vi.hoisted(() => ({
  loadConfig: vi.fn(() => {
    throw new Error("loadConfig should not be called during CLI metadata registration");
  }),
  registerWikiCli: vi.fn(),
  resolveMemoryWikiConfig: vi.fn(),
}));

vi.mock("../../src/config/config.js", () => ({
  loadConfig: mocks.loadConfig,
}));

vi.mock("./src/cli.js", () => ({
  registerWikiCli: mocks.registerWikiCli,
}));

vi.mock("./src/config.js", () => ({
  resolveMemoryWikiConfig: mocks.resolveMemoryWikiConfig,
}));

import plugin from "./cli-metadata.js";

describe("memory-wiki cli metadata entry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses the registrar context config instead of reloading global config", async () => {
    const registerCli = vi.fn();
    const api = createTestPluginApi({
      id: "memory-wiki",
      name: "Memory Wiki",
      registerCli,
    });
    const program = new Command();
    const appConfig = {
      plugins: {
        entries: {
          "memory-wiki": {
            config: {
              vaultMode: "bridge",
            },
          },
        },
      },
    };
    const resolvedConfig = { vaultMode: "bridge", vault: { path: "/vault" } };
    mocks.resolveMemoryWikiConfig.mockReturnValue(resolvedConfig);

    plugin.register(api);

    const register = registerCli.mock.calls[0]?.[0];

    expect(registerCli).toHaveBeenCalledTimes(1);
    expect(typeof register).toBe("function");

    await register({
      program,
      config: appConfig,
      workspaceDir: "/tmp/openclaw",
      logger: api.logger,
    });

    expect(mocks.loadConfig).not.toHaveBeenCalled();
    expect(mocks.resolveMemoryWikiConfig).toHaveBeenCalledWith(
      appConfig.plugins.entries["memory-wiki"].config,
    );
    expect(mocks.registerWikiCli).toHaveBeenCalledWith(program, resolvedConfig, appConfig);
  });
});
