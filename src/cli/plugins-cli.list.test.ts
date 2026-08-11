// Plugins CLI list tests cover plugin listing output and installed-state formatting.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ConfigFileSnapshot,
  ConfigValidationIssue,
  OpenClawConfig,
} from "../config/types.openclaw.js";
import { createPluginRecord } from "../plugins/status.test-fixtures.js";
import { withEnvAsync } from "../test-utils/env.js";
import {
  buildPluginDiagnosticsReportMock,
  buildPluginInspectReportMock,
  buildPluginRegistrySnapshotReportMock,
  buildPluginSnapshotReportMock,
  inspectPluginRegistryMock,
  loadConfig,
  loadPluginManifestRegistry,
  readConfigFileSnapshot,
  resetPluginsCliTestState,
  refreshPluginRegistry,
  runPluginsCommand,
  runtimeErrors,
  pluginsCliRuntimeLogs,
  setInstalledPluginIndexInstallRecords,
} from "./plugins-cli-test-helpers.js";

const workshopMocks = vi.hoisted(() => ({
  detectToolPolicyDiagnostic: vi.fn(),
}));

const cleanDoctorMessage =
  "Plugin discovery, module loading, compatibility, and configuration checks passed. " +
  'Run "openclaw health" to check the running Gateway, including runtime quarantines and fallbacks.';

async function mockPluginDoctorValidationWarnings(warnings: ConfigValidationIssue[]) {
  const config: OpenClawConfig = {
    plugins: {
      allow: ["imessage", "memory-core"],
      entries: { google: { config: { apiKey: "test-google-key" } } },
    },
  };
  loadConfig.mockReturnValue(config);
  const snapshot = (await readConfigFileSnapshot()) as ConfigFileSnapshot;
  readConfigFileSnapshot.mockResolvedValueOnce({ ...snapshot, valid: true, warnings });
  loadPluginManifestRegistry.mockReturnValue({
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
  buildPluginDiagnosticsReportMock.mockReturnValue({
    plugins: [createPluginRecord({ id: "google", enabled: false, status: "disabled" })],
    diagnostics: [],
  });
}

vi.mock("../skills/workshop/tool-policy-diagnostic.js", () => ({
  detectSkillWorkshopToolPolicyDiagnostic: workshopMocks.detectToolPolicyDiagnostic,
}));

describe("plugins cli list", () => {
  beforeEach(() => {
    resetPluginsCliTestState();
    workshopMocks.detectToolPolicyDiagnostic.mockReset();
  });

  it("includes imported state in JSON output", async () => {
    buildPluginRegistrySnapshotReportMock.mockReturnValue({
      workspaceDir: "/workspace",
      registrySource: "persisted",
      registryDiagnostics: [],
      plugins: [
        createPluginRecord({
          id: "demo",
          imported: true,
          activated: true,
          explicitlyEnabled: true,
        }),
      ],
      diagnostics: [],
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
    expect(output.registry?.diagnostics).toEqual([]);
    expect(output.plugins).toHaveLength(1);
    expect(output.plugins?.[0]?.id).toBe("demo");
    expect(output.plugins?.[0]?.imported).toBe(true);
    expect(output.plugins?.[0]?.activated).toBe(true);
    expect(output.plugins?.[0]?.explicitlyEnabled).toBe(true);
    expect(output.diagnostics).toEqual([]);
  });

  it("keeps doctor on a module-loading snapshot", async () => {
    buildPluginDiagnosticsReportMock.mockReturnValue({
      plugins: [],
      diagnostics: [],
    });

    await runPluginsCommand(["plugins", "doctor"]);

    expect(buildPluginDiagnosticsReportMock).toHaveBeenCalledWith({
      config: {},
      effectiveOnly: true,
    });
    expect(pluginsCliRuntimeLogs).toContain(cleanDoctorMessage);
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
    buildPluginDiagnosticsReportMock.mockReturnValue({
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
      buildPluginDiagnosticsReportMock.mockReturnValue({ plugins: [], diagnostics: [diagnostic] });

      await runPluginsCommand(["plugins", "doctor"]);

      const output = pluginsCliRuntimeLogs.join("\n");
      expect(output).toContain("Diagnostics:");
      expect(output).toContain(expected);
      expect(output).not.toContain(cleanDoctorMessage);
    },
  );

  it("keeps actionable discovery warnings alongside existing errors", async () => {
    buildPluginDiagnosticsReportMock.mockReturnValue({
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
    loadConfig.mockReturnValue({});
    readConfigFileSnapshot.mockResolvedValueOnce({
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
    buildPluginDiagnosticsReportMock.mockReturnValue({
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
    loadConfig.mockReturnValue(sourceConfig);
    readConfigFileSnapshot.mockResolvedValueOnce({
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
    buildPluginDiagnosticsReportMock.mockReturnValue({
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
    loadConfig.mockReturnValue(sourceConfig);
    buildPluginDiagnosticsReportMock.mockReturnValue({
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
    loadConfig.mockReturnValue(sourceConfig);
    buildPluginDiagnosticsReportMock.mockReturnValue({
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
    loadConfig.mockReturnValue(sourceConfig);
    buildPluginDiagnosticsReportMock.mockReturnValue({
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
    loadConfig.mockReturnValue(sourceConfig);
    buildPluginDiagnosticsReportMock.mockReturnValue({
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
    loadConfig.mockReturnValue(sourceConfig);
    buildPluginDiagnosticsReportMock.mockReturnValue({
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
    loadConfig.mockReturnValue(sourceConfig);
    buildPluginDiagnosticsReportMock.mockReturnValue({
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
    loadConfig.mockReturnValue(sourceConfig);
    buildPluginDiagnosticsReportMock.mockReturnValue({
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
    loadConfig.mockReturnValue(sourceConfig);
    buildPluginDiagnosticsReportMock.mockReturnValue({
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
    buildPluginDiagnosticsReportMock.mockReturnValue({
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
    buildPluginDiagnosticsReportMock.mockReturnValue({
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
    expect(refreshPluginRegistry).not.toHaveBeenCalled();
    expect(pluginsCliRuntimeLogs.join("\n")).toContain("State:");
    expect(pluginsCliRuntimeLogs.join("\n")).toContain("stale");
    expect(pluginsCliRuntimeLogs.join("\n")).toContain("Refresh reasons:");
    expect(pluginsCliRuntimeLogs.join("\n")).toContain("openclaw plugins registry --refresh");
  });

  it("refreshes the persisted plugin registry on request", async () => {
    refreshPluginRegistry.mockResolvedValue({
      plugins: [
        { pluginId: "demo", enabled: true },
        { pluginId: "off", enabled: false },
      ],
    });

    await runPluginsCommand(["plugins", "registry", "--refresh"]);

    expect(refreshPluginRegistry).toHaveBeenCalledWith({
      config: {},
      reason: "manual",
    });
    expect(inspectPluginRegistryMock).not.toHaveBeenCalled();
    expect(pluginsCliRuntimeLogs.join("\n")).toContain("Plugin registry refreshed: 1/2 enabled");
  });

  it("keeps inspect on the static snapshot by default", async () => {
    setInstalledPluginIndexInstallRecords({
      "openclaw-mem0": {
        source: "clawhub",
        spec: "clawhub:openclaw-mem0",
        installPath: "/plugins/openclaw-mem0",
        version: "2026.5.1",
        clawhubPackage: "openclaw-mem0",
        clawhubChannel: "official",
        artifactKind: "npm-pack",
        artifactFormat: "tgz",
        npmIntegrity: "sha512-clawpack",
        npmShasum: "1".repeat(40),
        npmTarballName: "openclaw-mem0-2026.5.1.tgz",
        clawpackSha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        clawpackSpecVersion: 1,
        clawpackManifestSha256: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        clawpackSize: 4096,
      },
    });
    buildPluginSnapshotReportMock.mockReturnValue({
      plugins: [createPluginRecord({ id: "openclaw-mem0", name: "Mem0" })],
      diagnostics: [],
    });
    buildPluginInspectReportMock.mockReturnValue({
      workspaceDir: "/workspace",
      plugin: createPluginRecord({ id: "openclaw-mem0", name: "Mem0" }),
      shape: "hook-only",
      capabilityMode: "plain",
      capabilityCount: 1,
      capabilities: [],
      typedHooks: [{ name: "agent_end" }],
      customHooks: [],
      tools: [],
      commands: [],
      cliCommands: [],
      services: [],
      gatewayDiscoveryServices: [],
      mcpServers: [
        { name: "local", hasStdioTransport: true },
        { name: "remote", hasStdioTransport: false },
        { name: "broken", hasStdioTransport: false, unsupported: true },
      ],
      lspServers: [],
      httpRouteCount: 0,
      bundleCapabilities: [],
      diagnostics: [],
      policy: {
        allowConversationAccess: true,
        allowedModels: [],
        hasAllowedModelsConfig: false,
      },
      usesLegacyBeforeAgentStart: false,
      compatibility: [],
    });

    await runPluginsCommand(["plugins", "inspect", "openclaw-mem0"]);

    expect(buildPluginDiagnosticsReportMock).not.toHaveBeenCalled();
    expect(pluginsCliRuntimeLogs.join("\n")).toContain("Policy");
    expect(pluginsCliRuntimeLogs.join("\n")).toContain("allowConversationAccess: true");
    expect(pluginsCliRuntimeLogs.join("\n")).toContain("ClawHub package: openclaw-mem0");
    expect(pluginsCliRuntimeLogs.join("\n")).toContain("Artifact kind: npm-pack");
    expect(pluginsCliRuntimeLogs.join("\n")).toContain("Npm integrity: sha512-clawpack");
    expect(pluginsCliRuntimeLogs.join("\n")).toContain(
      "ClawPack sha256: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    );
    expect(pluginsCliRuntimeLogs.join("\n")).toContain("ClawPack spec: 1");
    expect(pluginsCliRuntimeLogs.join("\n")).toContain("ClawPack size: 4096 bytes");
    expect(pluginsCliRuntimeLogs.join("\n")).toContain("remote");
    expect(pluginsCliRuntimeLogs.join("\n")).not.toContain("remote (unsupported transport)");
    expect(pluginsCliRuntimeLogs.join("\n")).toContain("broken (unsupported transport)");
  });

  it("runtime-inspects without repairing deps", async () => {
    buildPluginSnapshotReportMock.mockReturnValue({
      plugins: [createPluginRecord({ id: "openclaw-mem0", name: "Mem0" })],
      diagnostics: [],
    });
    buildPluginInspectReportMock.mockReturnValue({
      workspaceDir: "/workspace",
      plugin: createPluginRecord({ id: "openclaw-mem0", name: "Mem0" }),
      shape: "hook-only",
      capabilityMode: "plain",
      capabilityCount: 1,
      capabilities: [],
      typedHooks: [],
      customHooks: [],
      tools: [],
      commands: [],
      cliCommands: [],
      services: [],
      gatewayDiscoveryServices: [],
      mcpServers: [],
      lspServers: [],
      httpRouteCount: 0,
      bundleCapabilities: [],
      diagnostics: [],
      policy: {
        allowedModels: [],
        hasAllowedModelsConfig: false,
      },
      usesLegacyBeforeAgentStart: false,
      compatibility: [],
    });

    await runPluginsCommand(["plugins", "inspect", "openclaw-mem0", "--runtime"]);

    expect(buildPluginDiagnosticsReportMock).toHaveBeenCalledWith({
      config: {},
      onlyPluginIds: ["openclaw-mem0"],
    });
  });

  it("does not runtime-load plugins when inspect target is missing", async () => {
    buildPluginSnapshotReportMock.mockReturnValue({
      plugins: [],
      diagnostics: [],
    });

    await expect(runPluginsCommand(["plugins", "inspect", "missing-plugin"])).rejects.toThrow(
      "__exit__:1",
    );

    expect(buildPluginSnapshotReportMock).toHaveBeenCalledWith({ config: {} });
    expect(buildPluginDiagnosticsReportMock).not.toHaveBeenCalled();
    expect(runtimeErrors.at(-1)).toContain("Plugin not found: missing-plugin");
  });

  it("explains a policy-hidden built-in Skill Workshop at the legacy inspect surface", async () => {
    const config: OpenClawConfig = {
      tools: { profile: "messaging" },
    };
    loadConfig.mockReturnValue(config);
    workshopMocks.detectToolPolicyDiagnostic.mockReturnValue({
      agentId: "main",
      source: "tools.profile",
      detail: 'tools.profile: "messaging" does not include "skill_workshop".',
      fix: 'Add tools.alsoAllow: ["skill_workshop"].',
      message:
        'Skill Workshop is active, but "skill_workshop" is hidden for agent "main": tools.profile: "messaging" does not include "skill_workshop". Add tools.alsoAllow: ["skill_workshop"].',
    });
    buildPluginSnapshotReportMock.mockReturnValue({
      plugins: [],
      diagnostics: [],
    });

    await expect(runPluginsCommand(["plugins", "inspect", "skill-workshop"])).rejects.toThrow(
      "__exit__:1",
    );

    expect(runtimeErrors.at(-1)).toContain(
      "Skill Workshop is built into OpenClaw, not a plugin; configure it under skills.workshop.",
    );
    expect(workshopMocks.detectToolPolicyDiagnostic).toHaveBeenCalledWith({
      config,
      workshopEnabled: true,
    });
    expect(runtimeErrors.at(-1)).toContain(
      'tools.profile: "messaging" does not include "skill_workshop".',
    );
    expect(runtimeErrors.at(-1)).toContain('Add tools.alsoAllow: ["skill_workshop"].');
  });
});
