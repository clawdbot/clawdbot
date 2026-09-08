// Plugins CLI list tests cover plugin listing output and installed-state formatting.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  ConfigFileSnapshot,
  ConfigValidationIssue,
  OpenClawConfig,
} from "../config/types.openclaw.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import type { PluginStatusReport } from "../plugins/status.js";
import { createCompatibilityNotice, createPluginRecord } from "../plugins/status.test-fixtures.js";
import { createDeferredCore } from "../shared/deferred.js";
import { withEnvAsync } from "../test-utils/env.js";
import {
  buildPluginCompatibilityNoticesMock,
  withPluginDiagnosticsReportForInspectionMock,
  buildPluginRegistrySnapshotReportMock,
  inspectPluginRegistryMock,
  pluginCliConfigMock,
  loadPluginManifestRegistryMock,
  readConfigFileSnapshotMock,
  resetPluginsCliTestState,
  refreshPluginRegistryMock,
  runPluginsCommand,
  runtimeErrors,
  pluginsCliRuntimeLogs,
} from "./plugins-cli-test-helpers.js";

const cleanDoctorMessage =
  "Plugin discovery, module loading, compatibility, and configuration checks passed. " +
  'Run "openclaw health" to check the running Gateway, including runtime quarantines and fallbacks.';
const originalExitCode = process.exitCode;

function mockDoctorReport(report: Pick<PluginStatusReport, "plugins" | "diagnostics">) {
  withPluginDiagnosticsReportForInspectionMock.mockImplementation(async (_params, formatReport) =>
    formatReport({ ...createEmptyPluginRegistry(), workspaceScope: "omitted", ...report }),
  );
}

async function mockPluginDoctorValidationWarnings(warnings: ConfigValidationIssue[]) {
  const config: OpenClawConfig = {
    plugins: {
      allow: ["imessage", "memory-core"],
      entries: { google: { config: { apiKey: "test-google-key" } } },
    },
  };
  pluginCliConfigMock.mockReturnValue(config);
  const snapshot = (await readConfigFileSnapshotMock()) as ConfigFileSnapshot;
  readConfigFileSnapshotMock.mockResolvedValueOnce({ ...snapshot, valid: true, warnings });
  loadPluginManifestRegistryMock.mockReturnValue({
    plugins: ["google", "imessage", "memory-core"].map((id) => ({
      id,
      channels: [],
      providers: [],
      cliBackends: [],
      skills: [],
      hooks: [],
      origin: "bundled",
      rootDir: `/plugins/${id}`,
      source: `/plugins/${id}`,
      manifestPath: `/plugins/${id}/openclaw.plugin.json`,
    })),
    diagnostics: [],
  });
  mockDoctorReport({
    plugins: [createPluginRecord({ id: "google", enabled: false, status: "disabled" })],
    diagnostics: [],
  });
}

describe("plugins cli list", () => {
  beforeEach(() => {
    resetPluginsCliTestState();
    process.exitCode = undefined;
  });

  afterEach(() => {
    process.exitCode = originalExitCode;
  });

  it("distinguishes plugin load errors from disabled reasons across list formats", async () => {
    const disabledReason = "workspace plugin (disabled by default)";
    buildPluginRegistrySnapshotReportMock.mockReturnValue({
      workspaceDir: "/workspace",
      registrySource: "persisted",
      registryDiagnostics: [],
      plugins: [
        createPluginRecord({
          id: "broken",
          description: "Broken plugin description",
          status: "error",
          error: "missing plugin module",
        }),
        createPluginRecord({ id: "healthy", description: "Healthy plugin" }),
        createPluginRecord({
          id: "disabled",
          description: "Disabled plugin description",
          enabled: false,
          status: "disabled",
          error: disabledReason,
          activationReason: disabledReason,
        }),
      ],
      diagnostics: [],
    });

    await runPluginsCommand(["plugins", "list"]);

    const output = pluginsCliRuntimeLogs.join("\n");
    expect(output).toContain("missing plugin module");
    expect(output).toContain("Healthy plugin");
    expect(output).toContain("Disabled plugin description");

    await runPluginsCommand(["plugins", "list", "--verbose"]);

    const verboseOutput = pluginsCliRuntimeLogs.at(-1) ?? "";
    expect(verboseOutput).toContain(`activation reason: ${disabledReason}`);
    expect(verboseOutput).not.toContain(`error: ${disabledReason}`);
    expect(verboseOutput).toContain("error: missing plugin module");
  });

  it.each([
    { label: "default", args: [], visibleError: true },
    { label: "verbose", args: ["--verbose"], visibleError: true },
    { label: "enabled-only", args: ["--enabled"], visibleError: false },
  ])(
    "surfaces plugin discovery and stale-registry diagnostics in the $label list",
    async ({ args, visibleError }) => {
      const refreshMessage =
        "Persisted plugin registry is stale. Run `openclaw plugins registry --refresh`.";
      const dependencyError = "Plugin dependency example-package could not be resolved.";
      buildPluginRegistrySnapshotReportMock.mockReturnValue({
        workspaceDir: "/workspace",
        registrySource: "derived",
        registryDiagnostics: [
          {
            level: "info",
            code: "persisted-registry-missing",
            message: "Persisted plugin registry is missing; using the derived index.",
          },
          {
            level: "warn",
            code: "persisted-registry-stale-source",
            message: refreshMessage,
          },
        ],
        plugins: [
          createPluginRecord({ id: "healthy", description: "Healthy plugin" }),
          createPluginRecord({
            id: "broken",
            enabled: visibleError,
            status: "error",
            error: dependencyError,
          }),
        ],
        diagnostics: [
          { level: "warn", message: "Duplicate plugin ID shadows an installed plugin." },
          { level: "error", message: "Plugin manifest could not be loaded." },
          { level: "error", pluginId: "broken", message: dependencyError },
        ],
      });

      await runPluginsCommand(["plugins", "list", ...args]);

      const output = pluginsCliRuntimeLogs.join("\n");
      expect(output).toContain("Warning: Duplicate plugin ID shadows an installed plugin.");
      expect(output).toContain("Error: Plugin manifest could not be loaded.");
      expect(output).toContain(`Warning: ${refreshMessage}`);
      expect(output).not.toContain("Persisted plugin registry is missing");
      expect(output.split(dependencyError)).toHaveLength(2);
      expect(output.includes(`Error: ${dependencyError}`)).toBe(!visibleError);
    },
  );

  it("includes imported state in JSON output", async () => {
    const registryDiagnostics = [
      {
        level: "info",
        code: "persisted-registry-missing",
        message: "Persisted plugin registry is missing; using the derived index.",
      },
    ];
    const diagnostics = [{ level: "warn", message: "Plugin discovery needs attention." }];
    buildPluginRegistrySnapshotReportMock.mockReturnValue({
      workspaceDir: "/workspace",
      registrySource: "persisted",
      registryDiagnostics,
      plugins: [
        createPluginRecord({
          id: "demo",
          imported: true,
          activated: true,
          explicitlyEnabled: true,
        }),
      ],
      diagnostics,
    });

    await runPluginsCommand(["plugins", "list", "--json"]);

    expect(buildPluginRegistrySnapshotReportMock).toHaveBeenCalledTimes(1);
    const [reportOptions] = buildPluginRegistrySnapshotReportMock.mock.calls[0] as [
      {
        config?: unknown;
        logger?: { info?: unknown; warn?: unknown; error?: unknown };
      },
    ];
    expect(reportOptions?.config).toEqual({});
    expect(reportOptions?.logger?.info).toBeTypeOf("function");
    expect(reportOptions?.logger?.warn).toBeTypeOf("function");
    expect(reportOptions?.logger?.error).toBeTypeOf("function");

    const output = JSON.parse(pluginsCliRuntimeLogs[0] ?? "null") as {
      workspaceDir?: string;
      registry?: { source?: string; diagnostics?: unknown[] };
      plugins?: Array<{
        id?: string;
        imported?: boolean;
        activated?: boolean;
        explicitlyEnabled?: boolean;
      }>;
      diagnostics?: unknown[];
    };
    expect(output.workspaceDir).toBe("/workspace");
    expect(output.registry?.source).toBe("persisted");
    expect(output.registry?.diagnostics).toEqual(registryDiagnostics);
    expect(output.plugins).toHaveLength(1);
    expect(output.plugins?.[0]?.id).toBe("demo");
    expect(output.plugins?.[0]?.imported).toBe(true);
    expect(output.plugins?.[0]?.activated).toBe(true);
    expect(output.plugins?.[0]?.explicitlyEnabled).toBe(true);
    expect(output.diagnostics).toEqual(diagnostics);
  });

  it.each([false, true])(
    "publishes Doctor output and exit status only after cleanup (json: %s)",
    async (json) => {
      const entered = createDeferredCore();
      const finish = createDeferredCore();
      process.exitCode = 7;
      withPluginDiagnosticsReportForInspectionMock.mockImplementation(
        async (_params, formatReport) => {
          const text = formatReport({ ...createEmptyPluginRegistry(), workspaceScope: "omitted" });
          entered.resolve();
          await finish.promise;
          return text;
        },
      );
      const command = runPluginsCommand(["plugins", "doctor", ...(json ? ["--json"] : [])]);
      try {
        await entered.promise;
        expect(pluginsCliRuntimeLogs).toEqual([]);
        expect(process.exitCode).toBe(7);
      } finally {
        finish.resolve();
        await command;
      }
      expect(process.exitCode).toBe(0);
      expect(pluginsCliRuntimeLogs).toHaveLength(1);
    },
  );

  it.each(["format", "dispose"])("does not publish success when Doctor %s fails", async (phase) => {
    process.exitCode = 7;
    const failure = new Error(`Doctor ${phase} failed`);
    if (phase === "format") {
      buildPluginCompatibilityNoticesMock.mockImplementation(() => {
        throw failure;
      });
    } else {
      withPluginDiagnosticsReportForInspectionMock.mockImplementation(
        async (_params, formatReport) => {
          formatReport({ ...createEmptyPluginRegistry(), workspaceScope: "omitted" });
          throw failure;
        },
      );
    }
    await expect(runPluginsCommand(["plugins", "doctor", "--json"])).rejects.toBe(failure);
    expect(pluginsCliRuntimeLogs).toEqual([]);
    expect(process.exitCode).toBe(7);
  });

  it("keeps doctor on a module-loading snapshot", async () => {
    mockDoctorReport({
      plugins: [],
      diagnostics: [],
    });

    await runPluginsCommand(["plugins", "doctor"]);

    expect(withPluginDiagnosticsReportForInspectionMock).toHaveBeenCalledWith(
      {
        config: {},
        effectiveOnly: true,
      },
      expect.any(Function),
    );
    expect(pluginsCliRuntimeLogs).toContain(cleanDoctorMessage);
  });

  it.each([
    { severity: "info", code: "hook-only", healthy: true, args: [] },
    { severity: "info", code: "hook-only", healthy: true, args: ["--json"] },
    {
      severity: "warn",
      code: "removed-session-transcript-file-api",
      healthy: false,
      args: [],
    },
    {
      severity: "warn",
      code: "removed-session-transcript-file-api",
      healthy: false,
      args: ["--json"],
    },
  ] as const)(
    "keeps $severity compatibility notices visible while reporting healthy=$healthy ($args)",
    async ({ code, healthy, args }) => {
      const notice = createCompatibilityNotice({ pluginId: "compatible-plugin", code });
      mockDoctorReport({
        plugins: [createPluginRecord({ id: "compatible-plugin" })],
        diagnostics: [],
      });
      buildPluginCompatibilityNoticesMock.mockReturnValue([notice]);

      await runPluginsCommand(["plugins", "doctor", ...args]);

      expect(process.exitCode).toBe(healthy ? 0 : 1);

      if (args.length > 0) {
        expect(JSON.parse(pluginsCliRuntimeLogs[0] ?? "null")).toMatchObject({
          ok: healthy,
          compatibility: [notice],
          pluginErrors: [],
          diagnostics: [],
          configurationWarnings: [],
        });
        return;
      }

      const output = pluginsCliRuntimeLogs.join("\n");
      expect(output).toContain(notice.message);
      expect(output).toContain(`[${notice.severity}]`);
      if (healthy) {
        expect(output).toContain(cleanDoctorMessage);
      } else {
        expect(output).not.toContain(cleanDoctorMessage);
      }
    },
  );

  it("updates the doctor exit status as health changes in one process", async () => {
    mockDoctorReport({
      plugins: [createPluginRecord({ id: "compatible-plugin" })],
      diagnostics: [],
    });
    const compatibilityNotice = (code: "hook-only" | "removed-session-transcript-file-api") =>
      createCompatibilityNotice({ pluginId: "compatible-plugin", code });

    for (const [code, exitCode] of [
      ["hook-only", 0],
      ["removed-session-transcript-file-api", 1],
      ["hook-only", 0],
    ] as const) {
      buildPluginCompatibilityNoticesMock.mockReturnValue([compatibilityNotice(code)]);
      await runPluginsCommand(["plugins", "doctor"]);
      expect(process.exitCode).toBe(exitCode);
    }
  });

  it.each([
    { format: "human", args: [] },
    { format: "JSON", args: ["--json"] },
  ])(
    "reports validated disabled-plugin configuration warnings in $format output",
    async ({ args }) => {
      await mockPluginDoctorValidationWarnings([
        {
          path: "plugins.entries.google",
          message: "plugin disabled (not in allowlist) but config is present",
        },
      ]);

      await runPluginsCommand(["plugins", "doctor", ...args]);

      expect(process.exitCode).toBe(1);

      const warning =
        "- plugins.entries.google: plugin disabled (not in allowlist) but config is present";
      if (args.includes("--json")) {
        const output = JSON.parse(pluginsCliRuntimeLogs[0] ?? "null") as {
          ok: boolean;
          configurationWarnings: string[];
        };
        expect(output.ok).toBe(false);
        expect(output.configurationWarnings).toEqual([warning]);
        return;
      }
      expect(pluginsCliRuntimeLogs.join("\n")).toContain(warning);
      expect(pluginsCliRuntimeLogs).not.toContain(cleanDoctorMessage);
    },
  );

  it("deduplicates plugin validation warnings while ignoring other config owners", async () => {
    const googleWarning = {
      path: "plugins.entries.google",
      message: "plugin disabled (not in allowlist) but config is present",
    };
    await mockPluginDoctorValidationWarnings([
      { path: "gateway.auth", message: "owned by gateway doctor" },
      { path: "plugins", message: "root plugin warning" },
      googleWarning,
      googleWarning,
      { path: "pluginsOther.entries.google", message: "not a plugin-owned path" },
    ]);

    await runPluginsCommand(["plugins", "doctor", "--json"]);

    const output = JSON.parse(pluginsCliRuntimeLogs[0] ?? "null") as {
      ok: boolean;
      configurationWarnings: string[];
    };
    expect(output.ok).toBe(false);
    expect(output.configurationWarnings).toEqual([
      "- plugins: root plugin warning",
      "- plugins.entries.google: plugin disabled (not in allowlist) but config is present",
    ]);
  });

  it.each([
    { format: "human", args: [] },
    { format: "JSON", args: ["--json"] },
  ])("ignores unrelated validation warnings in $format doctor output", async ({ args }) => {
    await mockPluginDoctorValidationWarnings([
      { path: "gateway.auth", message: "owned by gateway doctor" },
    ]);

    await runPluginsCommand(["plugins", "doctor", ...args]);

    if (args.includes("--json")) {
      expect(JSON.parse(pluginsCliRuntimeLogs[0] ?? "null")).toMatchObject({
        ok: true,
        configurationWarnings: [],
      });
      return;
    }
    expect(pluginsCliRuntimeLogs).toContain(cleanDoctorMessage);
  });

  it.each([
    { format: "human", args: [] },
    { format: "JSON", args: ["--json"] },
  ])("sanitizes plugin warning terminal controls in $format doctor output", async ({ args }) => {
    await mockPluginDoctorValidationWarnings([
      {
        path: "plugins.\nentries.google\u001b[31m",
        message: "bad\r\n\tvalue\u001b[0m\u0007",
      },
    ]);

    await runPluginsCommand(["plugins", "doctor", ...args]);

    const warning = "- plugins.\\nentries.google: bad\\r\\n\\tvalue";
    if (args.includes("--json")) {
      expect(JSON.parse(pluginsCliRuntimeLogs[0] ?? "null")).toMatchObject({
        ok: false,
        configurationWarnings: [warning],
      });
      return;
    }
    const output = pluginsCliRuntimeLogs.join("\n");
    expect(output).toContain(warning);
    expect(output).not.toContain("\u0007");
    expect(output).not.toContain("\u001b");
  });

  it("emits one sanitized JSON doctor report without human decoration", async () => {
    const homeDir = "/tmp/openclaw-plugin-doctor-home";
    mockDoctorReport({
      plugins: [
        createPluginRecord({
          id: "broken",
          origin: "config",
          source: `${homeDir}/plugins/broken/index.ts`,
          status: "error",
          error: `failed to load ${homeDir}/plugins/broken/runtime.ts`,
        }),
      ],
      diagnostics: [
        {
          level: "warn",
          pluginId: "broken",
          source: `${homeDir}/plugins/shadowed/index.ts`,
          message:
            "duplicate plugin id resolved by explicit config-selected plugin; " +
            `global plugin will be overridden by config plugin (${homeDir}/plugins/broken/index.ts)`,
        },
        {
          level: "warn",
          message: `failed to inspect ${homeDir}/plugins/unreadable`,
        },
      ],
    });

    await withEnvAsync({ OPENCLAW_HOME: homeDir }, async () => {
      await runPluginsCommand(["plugins", "doctor", "--json"]);
    });

    expect(pluginsCliRuntimeLogs).toHaveLength(1);
    expect(runtimeErrors).toEqual([]);
    expect(pluginsCliRuntimeLogs[0]).not.toContain(homeDir);
    expect(pluginsCliRuntimeLogs[0]).not.toContain("Plugin errors:");
    expect(pluginsCliRuntimeLogs[0]).not.toContain("Docs:");
    expect(JSON.parse(pluginsCliRuntimeLogs[0] ?? "null")).toEqual({
      ok: false,
      pluginErrors: [
        {
          id: "broken",
          error: "failed to load $OPENCLAW_HOME/plugins/broken/runtime.ts",
          source: "$OPENCLAW_HOME/plugins/broken/index.ts",
        },
      ],
      diagnostics: [
        {
          level: "warn",
          message: "failed to inspect $OPENCLAW_HOME/plugins/unreadable",
        },
      ],
      sourceShadowing: [
        {
          pluginId: "broken",
          message:
            "duplicate plugin id resolved by explicit config-selected plugin; " +
            "global plugin will be overridden by config plugin ($OPENCLAW_HOME/plugins/broken/index.ts)",
          active: {
            source: "$OPENCLAW_HOME/plugins/broken/index.ts",
            origin: "config",
            status: "error",
            error: "failed to load $OPENCLAW_HOME/plugins/broken/runtime.ts",
          },
          shadowedSource: "$OPENCLAW_HOME/plugins/shadowed/index.ts",
          repair: [
            "openclaw plugins inspect broken",
            "edit or remove the config-selected plugin source",
            "openclaw plugins registry --refresh",
            "openclaw gateway restart --force",
          ],
        },
      ],
      compatibility: [],
      configurationWarnings: [],
    });
  });

  it.each([
    {
      description: "a required plugin is missing",
      diagnostic: {
        level: "warn" as const,
        pluginId: "calendar",
        message: 'plugin "calendar" requires plugin "contacts"; install "contacts" to use it',
      },
      expected: 'calendar: plugin "calendar" requires plugin "contacts"',
    },
    {
      description: "discovery cannot read an extensions directory",
      diagnostic: {
        level: "warn" as const,
        message: "failed to read extensions dir: /tmp/plugins (permission denied)",
      },
      expected: "failed to read extensions dir: /tmp/plugins (permission denied)",
    },
  ])(
    "reports actionable discovery warnings when $description",
    async ({ diagnostic, expected }) => {
      mockDoctorReport({ plugins: [], diagnostics: [diagnostic] });

      await runPluginsCommand(["plugins", "doctor"]);

      const output = pluginsCliRuntimeLogs.join("\n");
      expect(output).toContain("Diagnostics:");
      expect(output).toContain(expected);
      expect(output).not.toContain(cleanDoctorMessage);
    },
  );

  it("keeps actionable discovery warnings alongside existing errors", async () => {
    mockDoctorReport({
      plugins: [],
      diagnostics: [
        { level: "error", pluginId: "broken", message: "plugin manifest invalid" },
        { level: "warn", pluginId: "calendar", message: "required plugin contacts is missing" },
      ],
    });

    await runPluginsCommand(["plugins", "doctor"]);

    const output = pluginsCliRuntimeLogs.join("\n");
    expect(output).toContain("broken: plugin manifest invalid");
    expect(output).toContain("calendar: required plugin contacts is missing");
    expect(output).not.toContain(cleanDoctorMessage);
  });

  it("reports stale plugin config in doctor output without claiming full plugin health", async () => {
    const sourceConfig = {
      plugins: {
        allow: ["lossless-claw"],
        entries: {
          "lossless-claw": { enabled: true },
        },
        slots: {
          contextEngine: "lossless-claw",
        },
      },
    };
    pluginCliConfigMock.mockReturnValue({});
    readConfigFileSnapshotMock.mockResolvedValueOnce({
      path: "/tmp/openclaw-config.json5",
      exists: true,
      raw: "{}",
      parsed: sourceConfig,
      resolved: sourceConfig,
      sourceConfig,
      runtimeConfig: {},
      config: {},
      valid: true,
      hash: "mock",
      issues: [],
      warnings: [],
      legacyIssues: [],
    });
    mockDoctorReport({
      plugins: [],
      diagnostics: [],
    });

    await runPluginsCommand(["plugins", "doctor"]);

    const output = pluginsCliRuntimeLogs.join("\n");
    expect(output).toContain("Plugin configuration:");
    expect(output).toContain(
      "Stale plugin references (plugins.allow/deny/entries): lossless-claw.",
    );
    expect(output).toContain(
      'plugins.slots.contextEngine: slot references missing plugin "lossless-claw".',
    );
    expect(output).toContain(
      'Run "openclaw doctor --fix" to remove stale plugin ids and dangling channel references.',
    );
    expect(output).toContain(
      "No plugin install-tree issues detected; configuration warnings remain.",
    );
    expect(output).not.toContain(cleanDoctorMessage);
  });

  it("reports missing configured Codex runtime plugin in doctor output", async () => {
    const sourceConfig = {
      agents: {
        defaults: {
          models: {
            "openai/gpt-5.5": {
              agentRuntime: { id: "codex" },
            },
          },
        },
      },
    };
    pluginCliConfigMock.mockReturnValue(sourceConfig);
    readConfigFileSnapshotMock.mockResolvedValueOnce({
      path: "/tmp/openclaw-config.json5",
      exists: true,
      raw: "{}",
      parsed: sourceConfig,
      resolved: sourceConfig,
      sourceConfig,
      runtimeConfig: sourceConfig,
      config: sourceConfig,
      valid: true,
      hash: "mock",
      issues: [],
      warnings: [],
      legacyIssues: [],
    });
    mockDoctorReport({
      plugins: [],
      diagnostics: [],
    });

    await runPluginsCommand(["plugins", "doctor"]);

    const output = pluginsCliRuntimeLogs.join("\n");
    expect(output).toContain("Plugin configuration:");
    expect(output).toContain('Configured runtime "codex" requires the Codex plugin');
    expect(output).toContain("openclaw doctor --fix");
    expect(output).toContain("openclaw plugins install @openclaw/codex");
    expect(output).toContain(
      "No plugin install-tree issues detected; configuration warnings remain.",
    );
    expect(output).not.toContain(cleanDoctorMessage);
  });

  it("reports missing configured ACPX runtime plugin in doctor output", async () => {
    const sourceConfig = {
      acp: {
        backend: "acpx",
      },
    };
    pluginCliConfigMock.mockReturnValue(sourceConfig);
    mockDoctorReport({
      plugins: [],
      diagnostics: [],
    });

    await runPluginsCommand(["plugins", "doctor"]);

    const output = pluginsCliRuntimeLogs.join("\n");
    expect(output).toContain("Plugin configuration:");
    expect(output).toContain('Configured runtime "acpx" requires the ACPX Runtime plugin');
    expect(output).toContain("openclaw doctor --fix");
    expect(output).toContain("openclaw plugins install @openclaw/acpx");
    expect(output).not.toContain(cleanDoctorMessage);
  });

  it("reports blocked configured ACPX runtime with ACP-specific guidance", async () => {
    const sourceConfig = {
      acp: {
        backend: "acpx",
      },
      plugins: {
        entries: {
          acpx: { enabled: false },
        },
      },
    };
    pluginCliConfigMock.mockReturnValue(sourceConfig);
    mockDoctorReport({
      plugins: [],
      diagnostics: [],
    });

    await runPluginsCommand(["plugins", "doctor"]);

    const output = pluginsCliRuntimeLogs.join("\n");
    expect(output).toContain('Configured runtime "acpx" requires the ACPX Runtime plugin');
    expect(output).toContain("Set plugins.entries.acpx.enabled=true");
    expect(output).toContain("disable ACP/acpx in acp config");
    expect(output).not.toContain('runtime policy to "openclaw"');
    expect(output).not.toContain("openclaw plugins install @openclaw/acpx");
    expect(output).not.toContain(cleanDoctorMessage);
  });

  it("reports disabled configured ACPX runtime with ACP-specific guidance", async () => {
    const sourceConfig = {
      acp: {
        backend: "acpx",
      },
    };
    pluginCliConfigMock.mockReturnValue(sourceConfig);
    mockDoctorReport({
      plugins: [createPluginRecord({ id: "acpx", enabled: false, status: "disabled" })],
      diagnostics: [],
    });

    await runPluginsCommand(["plugins", "doctor"]);

    const output = pluginsCliRuntimeLogs.join("\n");
    expect(output).toContain('Configured runtime "acpx" requires the ACPX Runtime plugin');
    expect(output).toContain('Enable the "acpx" plugin');
    expect(output).toContain("disable ACP/acpx in acp config");
    expect(output).not.toContain('runtime policy to "openclaw"');
    expect(output).not.toContain("openclaw plugins install @openclaw/acpx");
    expect(output).not.toContain(cleanDoctorMessage);
  });

  it("does not report implicit OpenAI Codex preference as configured runtime", async () => {
    const sourceConfig = {
      agents: {
        defaults: {
          model: "openai/gpt-5.5",
        },
      },
    };
    pluginCliConfigMock.mockReturnValue(sourceConfig);
    mockDoctorReport({
      plugins: [],
      diagnostics: [],
    });

    await runPluginsCommand(["plugins", "doctor"]);

    const output = pluginsCliRuntimeLogs.join("\n");
    expect(output).not.toContain('Configured runtime "codex"');
    expect(output).toContain(cleanDoctorMessage);
  });

  it("does not report configured Codex runtime when the plugin is enabled", async () => {
    const sourceConfig = {
      agents: {
        defaults: {
          models: {
            "openai/gpt-5.5": {
              agentRuntime: { id: "codex" },
            },
          },
        },
      },
    };
    pluginCliConfigMock.mockReturnValue(sourceConfig);
    mockDoctorReport({
      plugins: [createPluginRecord({ id: "codex" })],
      diagnostics: [],
    });

    await runPluginsCommand(["plugins", "doctor"]);

    expect(pluginsCliRuntimeLogs).toContain(cleanDoctorMessage);
  });

  it("reports configured Codex runtime when the plugin record is disabled", async () => {
    const sourceConfig = {
      agents: {
        defaults: {
          models: {
            "openai/gpt-5.5": {
              agentRuntime: { id: "codex" },
            },
          },
        },
      },
    };
    pluginCliConfigMock.mockReturnValue(sourceConfig);
    mockDoctorReport({
      plugins: [createPluginRecord({ id: "codex", enabled: false, status: "disabled" })],
      diagnostics: [],
    });

    await runPluginsCommand(["plugins", "doctor"]);

    const output = pluginsCliRuntimeLogs.join("\n");
    expect(output).toContain('Configured runtime "codex" requires the Codex plugin');
    expect(output).toContain('but "codex" is disabled');
    expect(output).toContain('Enable the "codex" plugin');
    expect(output).not.toContain("openclaw plugins install @openclaw/codex");
    expect(output).not.toContain(cleanDoctorMessage);
  });

  it("reports blocked configured Codex runtime without install advice", async () => {
    const sourceConfig = {
      plugins: {
        deny: ["codex"],
      },
      agents: {
        defaults: {
          models: {
            "openai/gpt-5.5": {
              agentRuntime: { id: "codex" },
            },
          },
        },
      },
    };
    pluginCliConfigMock.mockReturnValue(sourceConfig);
    mockDoctorReport({
      plugins: [],
      diagnostics: [],
    });

    await runPluginsCommand(["plugins", "doctor"]);

    const output = pluginsCliRuntimeLogs.join("\n");
    expect(output).toContain('Configured runtime "codex" requires the Codex plugin');
    expect(output).toContain('but "codex" is blocked by plugin configuration');
    expect(output).toContain('Remove "codex" from plugins.deny');
    expect(output).not.toContain('Run "openclaw doctor --fix" to install');
    expect(output).not.toContain("openclaw plugins install @openclaw/codex");
    expect(output).not.toContain(cleanDoctorMessage);
  });

  it("reports disabled configured Codex runtime entry without install advice", async () => {
    const sourceConfig = {
      plugins: {
        entries: {
          codex: { enabled: false },
        },
      },
      agents: {
        defaults: {
          models: {
            "openai/gpt-5.5": {
              agentRuntime: { id: "codex" },
            },
          },
        },
      },
    };
    pluginCliConfigMock.mockReturnValue(sourceConfig);
    mockDoctorReport({
      plugins: [],
      diagnostics: [],
    });

    await runPluginsCommand(["plugins", "doctor"]);

    const output = pluginsCliRuntimeLogs.join("\n");
    expect(output).toContain('Configured runtime "codex" requires the Codex plugin');
    expect(output).toContain('but "codex" is blocked by plugin configuration');
    expect(output).toContain("Set plugins.entries.codex.enabled=true");
    expect(output).not.toContain('Run "openclaw doctor --fix" to install');
    expect(output).not.toContain("openclaw plugins install @openclaw/codex");
    expect(output).not.toContain(cleanDoctorMessage);
  });

  it("reports config-selected plugin source shadowing in doctor output", async () => {
    mockDoctorReport({
      plugins: [
        createPluginRecord({
          id: "discord",
          origin: "config",
          source: "/tmp/openclaw-upstream/extensions/discord/index.ts",
          status: "error",
          error: "Cannot find module 'chalk'",
        }),
      ],
      diagnostics: [
        {
          level: "warn",
          pluginId: "discord",
          source: "/tmp/openclaw/npm/node_modules/@openclaw/discord/index.ts",
          message:
            "duplicate plugin id resolved by explicit config-selected plugin; global plugin will be overridden by config plugin (/tmp/openclaw-upstream/extensions/discord/index.ts)",
        },
      ],
    });

    await runPluginsCommand(["plugins", "doctor"]);

    const output = pluginsCliRuntimeLogs.join("\n");
    expect(output).toContain("Plugin source shadowing:");
    expect(output).toContain(
      "discord: duplicate plugin id resolved by explicit config-selected plugin",
    );
    expect(output).toContain("active: /tmp/openclaw-upstream/extensions/discord/index.ts");
    expect(output).toContain("shadowed: /tmp/openclaw/npm/node_modules/@openclaw/discord/index.ts");
    expect(output).toContain("openclaw plugins registry --refresh");
  });

  it("does not report healthy config-selected plugin source shadowing as doctor issue", async () => {
    mockDoctorReport({
      plugins: [
        createPluginRecord({
          id: "discord",
          origin: "config",
          source: "/tmp/openclaw-upstream/extensions/discord/index.ts",
          status: "loaded",
        }),
      ],
      diagnostics: [
        {
          level: "warn",
          pluginId: "discord",
          source: "/tmp/openclaw/npm/node_modules/@openclaw/discord/index.ts",
          message:
            "duplicate plugin id resolved by explicit config-selected plugin; global plugin will be overridden by config plugin (/tmp/openclaw-upstream/extensions/discord/index.ts)",
        },
      ],
    });

    await runPluginsCommand(["plugins", "doctor"]);

    expect(pluginsCliRuntimeLogs).toContain(cleanDoctorMessage);
  });

  it("reports persisted plugin registry state without refreshing", async () => {
    inspectPluginRegistryMock.mockResolvedValue({
      state: "stale",
      refreshReasons: ["stale-manifest"],
      differences: [
        {
          pluginId: "demo",
          persistedSource: "/plugins/demo/index.js",
          derivedSource: "/plugins/demo/dist/index.js",
        },
      ],
      persisted: {
        plugins: [{ pluginId: "demo", enabled: true }],
      },
      current: {
        plugins: [
          { pluginId: "demo", enabled: true },
          { pluginId: "next", enabled: false },
        ],
      },
    });

    await runPluginsCommand(["plugins", "registry"]);

    expect(inspectPluginRegistryMock).toHaveBeenCalledWith({ config: {} });
    expect(refreshPluginRegistryMock).not.toHaveBeenCalled();
    expect(pluginsCliRuntimeLogs.join("\n")).toContain("State:");
    expect(pluginsCliRuntimeLogs.join("\n")).toContain("stale");
    expect(pluginsCliRuntimeLogs.join("\n")).toContain("Refresh reasons:");
    expect(pluginsCliRuntimeLogs.join("\n")).toContain(
      "demo: persisted /plugins/demo/index.js; derived /plugins/demo/dist/index.js",
    );
    expect(pluginsCliRuntimeLogs.join("\n")).toContain("openclaw plugins registry --refresh");
  });

  it("refreshes the persisted plugin registry on request", async () => {
    refreshPluginRegistryMock.mockResolvedValue({
      plugins: [
        { pluginId: "demo", enabled: true },
        { pluginId: "off", enabled: false },
      ],
    });
    inspectPluginRegistryMock.mockResolvedValue({
      state: "fresh",
      refreshReasons: [],
      differences: [],
      persisted: { plugins: [] },
      current: { plugins: [] },
    });

    await runPluginsCommand(["plugins", "registry", "--refresh"]);

    expect(refreshPluginRegistryMock).toHaveBeenCalledWith({
      config: {},
      reason: "manual",
    });
    expect(inspectPluginRegistryMock).toHaveBeenCalledWith({ config: {} });
    expect(pluginsCliRuntimeLogs.join("\n")).toContain("Plugin registry refreshed: 1/2 enabled");
  });

  it("fails a registry refresh when the persisted replacement stays stale", async () => {
    refreshPluginRegistryMock.mockResolvedValue({ plugins: [] });
    inspectPluginRegistryMock.mockResolvedValue({
      state: "stale",
      refreshReasons: ["source-changed"],
      differences: [
        {
          pluginId: "demo",
          persistedSource: "/plugins/demo/index.js",
          derivedSource: "/plugins/demo/dist/index.js",
        },
      ],
      persisted: { plugins: [] },
      current: { plugins: [] },
    });

    await expect(runPluginsCommand(["plugins", "registry", "--refresh"])).rejects.toThrow(
      /demo: persisted \/plugins\/demo\/index\.js; derived \/plugins\/demo\/dist\/index\.js.*openclaw plugins registry --refresh/su,
    );
  });

  it("returns registry differences when a JSON refresh stays stale", async () => {
    refreshPluginRegistryMock.mockResolvedValue({ plugins: [] });
    inspectPluginRegistryMock.mockResolvedValue({
      state: "stale",
      refreshReasons: ["source-changed"],
      differences: [
        {
          pluginId: "demo",
          persistedSource: "/plugins/demo/index.js",
          derivedSource: "/plugins/demo/dist/index.js",
        },
      ],
      persisted: { plugins: [] },
      current: { plugins: [] },
    });

    await expect(
      runPluginsCommand(["plugins", "registry", "--refresh", "--json"]),
    ).rejects.toThrow();
    expect(JSON.parse(pluginsCliRuntimeLogs.at(-1) ?? "null")).toMatchObject({
      ok: false,
      refreshed: false,
      state: "stale",
      refreshReasons: ["source-changed"],
      differences: [
        {
          pluginId: "demo",
          persistedSource: "/plugins/demo/index.js",
          derivedSource: "/plugins/demo/dist/index.js",
        },
      ],
    });
  });
});
