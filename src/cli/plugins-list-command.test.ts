// Plugins list command tests cover plugin list command execution and output.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
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

type SnapshotPlugin = {
  id: string;
  enabled: boolean;
  commands?: string[];
  agentHarnessIds?: string[];
};

function mockPluginListSnapshot(
  plugins: SnapshotPlugin[],
  config: OpenClawConfig = {},
  scope?: {
    workspaceDir?: string;
    workspaceScope: "selected" | "omitted";
    diagnostics?: Array<{ level: "warn"; code: "workspace-scope-omitted"; message: string }>;
  },
): void {
  vi.doMock("../config/config.js", () => ({
    getRuntimeConfig: () => config,
  }));
  vi.doMock("../plugins/status-snapshot.js", () => ({
    buildPluginRegistrySnapshotReport: () => ({
      workspaceDir: scope?.workspaceDir ?? "/workspace",
      workspaceScope: scope?.workspaceScope ?? "selected",
      registrySource: "config",
      registryDiagnostics: [],
      plugins,
      diagnostics: scope?.diagnostics ?? [],
    }),
  }));
}

function mockHumanListModules(importedModules: string[] = []): void {
  vi.doMock("../plugins/source-display.js", () => {
    importedModules.push("source-display");
    return {
      formatPluginSourceForTable: vi.fn(),
      resolvePluginSourceRoots: vi.fn(),
    };
  });
  vi.doMock("../../packages/terminal-core/src/table.js", () => {
    importedModules.push("table");
    return {
      getTerminalTableWidth: vi.fn(),
      renderTable: vi.fn(),
    };
  });
  vi.doMock("../../packages/terminal-core/src/theme.js", () => {
    importedModules.push("theme");
    return {
      theme: {
        muted: (value: string) => value,
        warn: (value: string) => value,
      },
    };
  });
  vi.doMock("./command-format.js", () => {
    importedModules.push("command-format");
    return {
      formatCliCommand: (value: string) => `formatted(${value})`,
    };
  });
  vi.doMock("./plugins-list-format.js", () => {
    importedModules.push("plugins-list-format");
    return {
      formatPluginLine: vi.fn(),
    };
  });
}

describe("runPluginsListCommand", () => {
  afterEach(() => {
    vi.doUnmock("../config/config.js");
    vi.doUnmock("../plugins/status.js");
    vi.doUnmock("../plugins/status-snapshot.js");
    vi.doUnmock("../plugins/source-display.js");
    vi.doUnmock("../../packages/terminal-core/src/table.js");
    vi.doUnmock("../../packages/terminal-core/src/theme.js");
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
    vi.doMock("./plugins-command-helpers.js", () => {
      throw new Error("plugins list JSON must not import plugin command helpers");
    });
    vi.doMock("../plugins/status-snapshot.js", () => ({
      buildPluginRegistrySnapshotReport: () => ({
        workspaceDir: "/workspace",
        workspaceScope: "selected",
        registrySource: "config",
        registryDiagnostics: [],
        plugins: [
          {
            id: "demo",
            enabled: true,
            commands: ["demo"],
            agentHarnessIds: ["runtime-only"],
          },
        ],
        diagnostics: [],
      }),
    }));
    mockHumanListModules(importedHumanModules);

    const { runPluginsListCommand } = await import("./plugins-list-command.js");
    const writes: unknown[] = [];

    await runPluginsListCommand({ json: true }, createJsonRuntime(writes));

    expect(importedHumanModules).toEqual([]);
    expect(writes).toEqual([
      {
        workspaceDir: "/workspace",
        workspaceScope: "selected",
        registry: {
          source: "config",
          diagnostics: [],
        },
        plugins: [{ id: "demo", enabled: true, commands: ["demo"] }],
        diagnostics: [],
      },
    ]);
  });

  it.each([
    { label: "normal", options: { enabled: true } },
    { label: "verbose", options: { enabled: true, verbose: true } },
  ])(
    "explains an empty enabled-only $label list when plugins are installed",
    async ({ options }) => {
      mockPluginListSnapshot([{ id: "disabled-plugin", enabled: false }]);
      mockHumanListModules();
      const { runPluginsListCommand } = await import("./plugins-list-command.js");
      const writes: unknown[] = [];

      await runPluginsListCommand(options, createJsonRuntime(writes));

      expect(writes).toEqual([
        "No enabled plugins found. Run formatted(openclaw plugins list) to inspect installed plugins.",
      ]);
    },
  );

  it.each([
    { label: "normal", options: { enabled: true } },
    { label: "verbose", options: { enabled: true, verbose: true } },
  ])("explains a globally disabled $label plugin inventory", async ({ options }) => {
    mockPluginListSnapshot([{ id: "disabled-plugin", enabled: false }], {
      plugins: { enabled: false },
    });
    mockHumanListModules();
    const { runPluginsListCommand } = await import("./plugins-list-command.js");
    const writes: unknown[] = [];

    await runPluginsListCommand(options, createJsonRuntime(writes));

    expect(writes).toEqual([
      "No enabled plugins found. Plugins are globally disabled. Run formatted(openclaw plugins list) to inspect installed plugins.",
    ]);
  });

  it.each([
    { label: "denylist", config: { plugins: { deny: ["disabled-plugin"] } } },
    {
      label: "allowlist",
      config: { plugins: { allow: ["allowed-plugin"] } },
    },
  ])("does not suggest a blocked mutation for a $label", async ({ config }) => {
    mockPluginListSnapshot([{ id: "disabled-plugin", enabled: false }], config);
    mockHumanListModules();
    const { runPluginsListCommand } = await import("./plugins-list-command.js");
    const writes: unknown[] = [];

    await runPluginsListCommand({ enabled: true }, createJsonRuntime(writes));

    expect(writes).toEqual([
      "No enabled plugins found. Run formatted(openclaw plugins list) to inspect installed plugins.",
    ]);
  });

  it("keeps install guidance when an enabled-only list has no installed plugins", async () => {
    mockPluginListSnapshot([]);
    mockHumanListModules();
    const { runPluginsListCommand } = await import("./plugins-list-command.js");
    const writes: unknown[] = [];

    await runPluginsListCommand({ enabled: true }, createJsonRuntime(writes));

    expect(writes).toEqual([
      "No plugins found. Run formatted(openclaw plugins install <plugin>) to add one, or formatted(openclaw plugins list --json) to inspect raw discovery state.",
    ]);
  });

  it("makes omitted workspace plugin scope visible in human output", async () => {
    const message =
      "Workspace plugin discovery was skipped; set agents.defaults.systemAgent.agentId.";
    mockPluginListSnapshot(
      [],
      {},
      {
        workspaceScope: "omitted",
        diagnostics: [{ level: "warn", code: "workspace-scope-omitted", message }],
      },
    );
    mockHumanListModules();
    const { runPluginsListCommand } = await import("./plugins-list-command.js");
    const writes: unknown[] = [];

    await runPluginsListCommand({}, createJsonRuntime(writes));

    expect(writes).toEqual([
      `Warning: ${message}`,
      "",
      "No plugins found. Run formatted(openclaw plugins install <plugin>) to add one, or formatted(openclaw plugins list --json) to inspect raw discovery state.",
    ]);
  });

  it("keeps empty enabled-only JSON lazy when every installed plugin is disabled", async () => {
    const importedHumanModules: string[] = [];
    mockPluginListSnapshot([{ id: "disabled-plugin", enabled: false }]);
    mockHumanListModules(importedHumanModules);
    const { runPluginsListCommand } = await import("./plugins-list-command.js");
    const writes: unknown[] = [];

    await runPluginsListCommand({ enabled: true, json: true }, createJsonRuntime(writes));

    expect(importedHumanModules).toEqual([]);
    expect(writes).toEqual([
      {
        workspaceDir: "/workspace",
        workspaceScope: "selected",
        registry: { source: "config", diagnostics: [] },
        plugins: [],
        diagnostics: [],
      },
    ]);
  });
});
