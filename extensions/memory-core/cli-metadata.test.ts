// Memory Core tests cover metadata-only CLI host propagation.
import { Command } from "commander";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  configureMemoryCoreDreamingState,
  openMemoryCoreStateStore,
} from "./src/dreaming-state.js";

const registerMemoryCliMock = vi.hoisted(() => vi.fn());

vi.mock("./src/cli.js", () => ({
  registerMemoryCli: registerMemoryCliMock,
}));

import plugin from "./cli-metadata.js";

describe("memory-core CLI metadata", () => {
  const resetDreamingState = () =>
    configureMemoryCoreDreamingState(() => {
      throw new Error("memory-core dreaming SQLite state store is not configured");
    });

  beforeEach(resetDreamingState);
  afterEach(resetDreamingState);

  it("binds SQLite state and lease hosts to the standalone CLI", async () => {
    let registrar: Parameters<OpenClawPluginApi["registerCli"]>[0] | undefined;
    const hostWithLease = vi.fn();
    const keyedStore = {};
    const openKeyedStore = vi.fn(() => keyedStore);
    const acquireLocalService = vi.fn(async () => undefined);
    plugin.register(
      createTestPluginApi({
        runtime: {
          llm: { acquireLocalService },
          state: { openKeyedStore, withLease: hostWithLease },
        } as unknown as OpenClawPluginApi["runtime"],
        registerCli(nextRegistrar) {
          registrar = nextRegistrar;
        },
      }),
    );
    if (!registrar) {
      throw new Error("CLI registrar missing");
    }
    const storeOptions = { namespace: "cli-status-regression", maxEntries: 1 };

    expect(openMemoryCoreStateStore(storeOptions)).toBe(keyedStore);
    expect(openKeyedStore).toHaveBeenCalledWith(storeOptions);

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
