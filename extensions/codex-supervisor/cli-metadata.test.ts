// Codex Supervisor tests cover lightweight CLI discovery and lazy registration.
import { Command } from "commander";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  registerCodexSupervisorCli: vi.fn(),
}));

vi.mock("./src/cli.js", () => ({
  registerCodexSupervisorCli: mocks.registerCodexSupervisorCli,
}));

import entry from "./cli-metadata.js";

describe("codex-supervisor CLI metadata entry", () => {
  it("advertises codex and loads its registrar only when invoked", async () => {
    const registerCli = vi.fn();
    const api = createTestPluginApi({
      id: "codex-supervisor",
      name: "Codex Supervisor",
      registerCli,
    });

    entry.register(api);

    expect(registerCli).toHaveBeenCalledWith(expect.any(Function), {
      descriptors: [
        {
          name: "codex",
          description: "Inspect Codex sessions across the Gateway and paired nodes",
          hasSubcommands: true,
        },
      ],
    });
    expect(mocks.registerCodexSupervisorCli).not.toHaveBeenCalled();

    const registrar = registerCli.mock.calls[0]?.[0];
    if (typeof registrar !== "function") {
      throw new Error("expected codex-supervisor CLI registrar");
    }
    const program = new Command();
    await registrar({
      program,
      parentPath: [],
      config: {},
      workspaceDir: undefined,
      logger: api.logger,
    });

    expect(mocks.registerCodexSupervisorCli).toHaveBeenCalledWith(program);
  });
});
