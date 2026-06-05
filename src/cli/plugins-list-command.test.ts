// Plugins list command tests cover plugin list command execution and output.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OutputRuntimeEnv } from "../runtime.js";

function createJsonRuntime(writes: unknown[]): OutputRuntimeEnv {
  return {
    log: (...args: unknown[]) => writes.push(args.length === 1 ? args[0] : args),
    error: vi.fn(),
    exit: vi.fn((code: number) => {
      throw new Error(`exit ${code}`);
    }),
    writeStdout: (value: string) => writes.push(value),
    writeJson: (value: unknown) => writes.push(value),
  };
}

describe("runPluginsListCommand", () => {
  afterEach(() => {
    vi.doUnmock("../config/config.js");
    vi.doUnmock("../plugins/status.js");
    vi.doUnmock("../plugins/status-snapshot.js");
    vi.doUnmock("../plugins/source-display.js");
    vi.doUnmock("../terminal/table.js");
    vi.doUnmock("../terminal/theme.js");
    vi.doUnmock("./command-format.js");
    vi.doUnmock("./plugins-list-format.js");
    vi.resetModules();
  });

  it("does not import human list renderers for JSON output", async () => {
    vi.resetModules();
    const importedHumanModules: string[] = [];

    vi.doMock("../config/config.js", () => ({
      getRuntimeConfig: () => ({}),
    }));
    vi.doMock("../plugins/status.js", () => {
      throw new Error("plugins list JSON must use the snapshot status module");
    });
    vi.doMock("../plugins/status-snapshot.js", () => ({
      buildPluginRegistrySnapshotReport: () => ({
        workspaceDir: "/workspace",
        registrySource: "config",
        registryDiagnostics: [],
        plugins: [{ id: "demo", enabled: true }],
        diagnostics: [],
      }),
    }));
    vi.doMock("../plugins/source-display.js", () => {
      importedHumanModules.push("source-display");
      return {
        formatPluginSourceForTable: vi.fn(),
        resolvePluginSourceRoots: vi.fn(),
      };
    });
    vi.doMock("../terminal/table.js", () => {
      importedHumanModules.push("table");
      return {
        getTerminalTableWidth: vi.fn(),
        renderTable: vi.fn(),
      };
    });
    vi.doMock("../terminal/theme.js", () => {
      importedHumanModules.push("theme");
      return {
        theme: {
          muted: (value: string) => value,
          heading: (value: string) => value,
          command: (value: string) => value,
          error: (value: string) => value,
          success: (value: string) => value,
          warn: (value: string) => value,
        },
      };
    });
    vi.doMock("./command-format.js", () => {
      importedHumanModules.push("command-format");
      return {
        formatCliCommand: (value: string) => value,
      };
    });
    vi.doMock("./plugins-list-format.js", () => {
      importedHumanModules.push("plugins-list-format");
      return {
        formatPluginLine: vi.fn(),
      };
    });

    const { runPluginsListCommand } = await import("./plugins-list-command.js");
    const writes: unknown[] = [];

    await runPluginsListCommand({ json: true }, createJsonRuntime(writes));

    expect(importedHumanModules).toEqual([]);
    expect(writes).toEqual([
      {
        workspaceDir: "/workspace",
        registry: {
          source: "config",
          diagnostics: [],
        },
        plugins: [{ id: "demo", enabled: true }],
        diagnostics: [],
      },
    ]);
  });
});
