import { Command } from "commander";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  registerWikiCli: vi.fn(),
  resolveMemoryWikiConfig: vi.fn(),
}));

vi.mock("./src/cli.js", () => ({
  registerWikiCli: mocks.registerWikiCli,
}));

vi.mock("./src/config.js", () => ({
  resolveMemoryWikiConfig: mocks.resolveMemoryWikiConfig,
}));

import plugin from "./cli-metadata.js";

function requireFirstCliRegistrar(mock: ReturnType<typeof vi.fn>) {
  const [call] = mock.mock.calls;
  if (!call || typeof call[0] !== "function") {
    throw new Error("expected memory-wiki CLI registrar to be registered");
  }
  return call[0] as (ctx: {
    program: Command;
    config: Record<string, unknown>;
    workspaceDir: string;
    logger: unknown;
  }) => Promise<void>;
}

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

    expect(registerCli).toHaveBeenCalledTimes(1);
    const register = requireFirstCliRegistrar(registerCli);

    await register({
      program,
      config: appConfig,
      workspaceDir: "/tmp/openclaw",
      logger: api.logger,
    });

    expect(mocks.resolveMemoryWikiConfig).toHaveBeenCalledWith(
      appConfig.plugins.entries["memory-wiki"].config,
    );
    expect(mocks.registerWikiCli).toHaveBeenCalledWith(program, resolvedConfig, appConfig);
  });
});
