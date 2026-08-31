// Codex CLI metadata tests cover lightweight discovery and lazy registration.
import { Command } from "commander";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  registerCodexSessionCli: vi.fn(),
}));

vi.mock("./src/session-cli.js", () => ({
  registerCodexSessionCli: mocks.registerCodexSessionCli,
}));

import entry from "./cli-metadata.js";

describe("codex CLI metadata entry", () => {
  it("advertises codex and loads its session registrar only when invoked", async () => {
    const registerCli = vi.fn();
    const api = createTestPluginApi({
      id: "codex",
      name: "Codex",
      registerCli,
    });

    entry.register(api);

    expect(registerCli).toHaveBeenCalledWith(expect.any(Function), {
      descriptors: [
        {
          name: "codex",
          description: "Inspect and branch from Codex sessions through the Gateway",
          hasSubcommands: true,
        },
      ],
    });
    expect(mocks.registerCodexSessionCli).not.toHaveBeenCalled();

    const registrar = registerCli.mock.calls[0]?.[0];
    if (typeof registrar !== "function") {
      throw new Error("expected Codex CLI registrar");
    }
    const program = new Command();
    await registrar({
      program,
      parentPath: [],
      config: {},
      workspaceDir: undefined,
      logger: api.logger,
    });

    expect(mocks.registerCodexSessionCli).toHaveBeenCalledWith(program);
  });
});
