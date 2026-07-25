// Memory Core tests cover metadata-only CLI host propagation.
import { Command } from "commander";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { describe, expect, it, vi } from "vitest";

const registerMemoryCliMock = vi.hoisted(() => vi.fn());

vi.mock("./src/cli.js", () => ({
  registerMemoryCli: registerMemoryCliMock,
}));

import plugin from "./cli-metadata.js";

describe("memory-core CLI metadata", () => {
  it("passes the bound SQLite lease host to the lazy CLI registrar", async () => {
    let registrar: Parameters<OpenClawPluginApi["registerCli"]>[0] | undefined;
    const hostWithLease = vi.fn();
    const acquireLocalService = vi.fn(async () => undefined);
    plugin.register(
      createTestPluginApi({
        runtime: {
          llm: { acquireLocalService },
          state: { withLease: hostWithLease },
        } as unknown as OpenClawPluginApi["runtime"],
        registerCli(nextRegistrar) {
          registrar = nextRegistrar;
        },
      }),
    );
    if (!registrar) {
      throw new Error("CLI registrar missing");
    }
    const program = new Command();

    await registrar({ program } as never);

    expect(registerMemoryCliMock).toHaveBeenCalledWith(program, {
      acquireLocalService,
      withLease: expect.any(Function),
    });
    const withLease = registerMemoryCliMock.mock.calls[0]?.[1]?.withLease as
      | ((...args: unknown[]) => unknown)
      | undefined;
    if (!withLease) {
      throw new Error("bound lease hook missing");
    }
    withLease("options", "callback");
    expect(hostWithLease).toHaveBeenCalledWith("options", "callback");
  });
});
