import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  resolveBundledRuntimeDependencyPackageInstallRoot,
  scanBundledPluginRuntimeDeps,
  type BundledRuntimeDepsInstallParams,
} from "../plugins/bundled-runtime-deps.js";
import type { RuntimeEnv } from "../runtime.js";
import { maybeRepairBundledPluginRuntimeDeps } from "./doctor-bundled-plugin-runtime-deps.js";
import type { DoctorPrompter } from "./doctor-prompter.js";

type InstalledRuntimeDeps = BundledRuntimeDepsInstallParams[];

function writeJson(filePath: string, value: unknown) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function writeBundledChannelPlugin(root: string, id: string, dependencies: Record<string, string>) {
  writeBundledChannelOwnerPlugin(root, id, [id], dependencies);
}

function writeBundledChannelOwnerPlugin(
  root: string,
  id: string,
  channels: string[],
  dependencies: Record<string, string>,
) {
  writeJson(path.join(root, "dist", "extensions", id, "package.json"), {
    dependencies,
  });
  writeJson(path.join(root, "dist", "extensions", id, "openclaw.plugin.json"), {
    id,
    channels,
    configSchema: { type: "object" },
  });
}

function writeBundledProviderPlugin(
  root: string,
  id: string,
  providers: string[],
  dependencies: Record<string, string>,
) {
  writeJson(path.join(root, "dist", "extensions", id, "package.json"), {
    dependencies,
  });
  writeJson(path.join(root, "dist", "extensions", id, "openclaw.plugin.json"), {
    id,
    providers,
    enabledByDefault: true,
    configSchema: { type: "object" },
  });
}

function writeDefaultEnabledBundledChannelPlugin(
  root: string,
  id: string,
  dependencies: Record<string, string>,
) {
  writeBundledChannelPlugin(root, id, dependencies);
  writeJson(path.join(root, "dist", "extensions", id, "openclaw.plugin.json"), {
    id,
    channels: [id],
    enabledByDefault: true,
    configSchema: { type: "object" },
  });
}

function createInstalledRuntimeDeps(): InstalledRuntimeDeps {
  return [];
}

function parseInstallSpec(spec: string): { name: string; version: string } {
  const versionSeparator = spec.startsWith("@") ? spec.indexOf("@", 1) : spec.lastIndexOf("@");
  if (versionSeparator <= 0) {
    throw new Error(`Invalid install spec ${spec}`);
  }
  return {
    name: spec.slice(0, versionSeparator),
    version: spec.slice(versionSeparator + 1),
  };
}

function materializeRuntimeDeps(params: BundledRuntimeDepsInstallParams): void {
  for (const spec of params.installSpecs ?? params.missingSpecs) {
    const { name, version } = parseInstallSpec(spec);
    writeJson(path.join(params.installRoot, "node_modules", ...name.split("/"), "package.json"), {
      name,
      version: version.replace(/^[~^]/u, ""),
    });
  }
}

function readMaterializedRuntimeDepSpecs(
  installRoot: string,
  expectedSpecs: readonly string[],
): string[] {
  return expectedSpecs.flatMap((spec) => {
    const { name } = parseInstallSpec(spec);
    const packageJsonPath = path.join(
      installRoot,
      "node_modules",
      ...name.split("/"),
      "package.json",
    );
    if (!fs.existsSync(packageJsonPath)) {
      return [];
    }
    const parsed = JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as {
      name?: unknown;
      version?: unknown;
    };
    return typeof parsed.name === "string" && typeof parsed.version === "string"
      ? [`${parsed.name}@${parsed.version}`]
      : [];
  });
}

function expectNoLegacyRuntimeDepsManifest(installRoot: string): void {
  expect(fs.existsSync(path.join(installRoot, ".openclaw-runtime-deps.json"))).toBe(false);
}

function createNonInteractivePrompter(
  options: { updateInProgress?: boolean } = {},
): DoctorPrompter {
  return {
    shouldRepair: false,
    shouldForce: false,
    repairMode: {
      shouldRepair: false,
      shouldForce: false,
      nonInteractive: true,
      canPrompt: false,
      updateInProgress: options.updateInProgress ?? false,
    },
    confirm: async () => false,
    confirmAutoFix: async () => false,
    confirmAggressiveAutoFix: async () => false,
    confirmRuntimeRepair: async () => false,
    select: async (_params: unknown, fallback: unknown) => fallback,
  } as DoctorPrompter;
}

function createRuntime(options: { logs?: string[]; errors?: string[] } = {}): RuntimeEnv {
  return {
    log: (message: unknown) => {
      options.logs?.push(String(message));
    },
    error: (message: unknown) => {
      options.errors?.push(String(message));
    },
    exit: (code: number) => {
      throw new Error(`Unexpected runtime exit ${code}`);
    },
  };
}

describe("doctor bundled plugin runtime deps", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("skips source checkouts", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-doctor-bundled-"));
    fs.mkdirSync(path.join(root, ".git"));
    fs.mkdirSync(path.join(root, "src"));
    fs.mkdirSync(path.join(root, "extensions"));
    writeJson(path.join(root, "dist", "extensions", "discord", "package.json"), {
      dependencies: {
        "dep-one": "1.0.0",
      },
    });

    const result = scanBundledPluginRuntimeDeps({ packageRoot: root });
    expect(result.missing).toEqual([]);
    expect(result.conflicts).toEqual([]);
  });

  it("reports missing deps and conflicts", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-doctor-bundled-"));
    writeJson(path.join(root, "package.json"), { name: "openclaw" });

    writeJson(path.join(root, "dist", "extensions", "alpha", "package.json"), {
      dependencies: {
        "@openclaw/plugin-sdk": "workspace:*",
        "dep-one": "1.0.0",
        "@scope/dep-two": "2.0.0",
        openclaw: "workspace:*",
      },
      optionalDependencies: {
        "dep-opt": "3.0.0",
      },
    });
    writeJson(path.join(root, "dist", "extensions", "beta", "package.json"), {
      dependencies: {
        "dep-one": "1.0.0",
        "dep-conflict": "1.0.0",
      },
    });
    writeJson(path.join(root, "dist", "extensions", "gamma", "package.json"), {
      dependencies: {
        "dep-conflict": "2.0.0",
      },
    });

    writeJson(path.join(root, "node_modules", "dep-one", "package.json"), {
      name: "dep-one",
      version: "1.0.0",
    });

    const result = scanBundledPluginRuntimeDeps({ packageRoot: root });
    const missing = result.missing.map((dep) => `${dep.name}@${dep.version}`);

    expect(missing).toEqual(["@scope/dep-two@2.0.0", "dep-one@1.0.0", "dep-opt@3.0.0"]);
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]?.name).toBe("dep-conflict");
    expect(result.conflicts[0]?.versions).toEqual(["1.0.0", "2.0.0"]);
  });

  it("limits configured scans to enabled bundled channel plugins", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-doctor-bundled-"));
    writeJson(path.join(root, "package.json"), { name: "openclaw" });

    writeBundledChannelPlugin(root, "discord", { "discord-only": "1.0.0" });
    writeBundledChannelPlugin(root, "whatsapp", { "whatsapp-only": "1.0.0" });

    const result = scanBundledPluginRuntimeDeps({
      packageRoot: root,
      config: {
        plugins: { enabled: true },
        channels: {
          discord: { enabled: true },
        },
      },
    });

    expect(result.missing.map((dep) => `${dep.name}@${dep.version}`)).toEqual([
      "discord-only@1.0.0",
    ]);
    expect(result.conflicts).toEqual([]);
  });

  it("does not report bundled channel deps when the channel is not enabled", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-doctor-bundled-"));
    writeJson(path.join(root, "package.json"), { name: "openclaw" });
    writeBundledChannelPlugin(root, "discord", { "discord-only": "1.0.0" });

    const result = scanBundledPluginRuntimeDeps({
      packageRoot: root,
      config: {
        plugins: { enabled: true },
      },
    });

    expect(result.missing).toEqual([]);
    expect(result.conflicts).toEqual([]);
  });

  it("does not include explicitly disabled but configured bundled channel deps", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-doctor-bundled-"));
    writeJson(path.join(root, "package.json"), { name: "openclaw" });
    writeBundledChannelPlugin(root, "telegram", { "telegram-only": "1.0.0" });

    const result = scanBundledPluginRuntimeDeps({
      packageRoot: root,
      includeConfiguredChannels: true,
      config: {
        plugins: { enabled: true },
        channels: {
          telegram: { enabled: false, botToken: "123:abc" },
        },
      },
    });

    expect(result.missing).toEqual([]);
    expect(result.conflicts).toEqual([]);
  });

  it("includes configured bundled channel deps for doctor recovery when not explicitly disabled", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-doctor-bundled-"));
    writeJson(path.join(root, "package.json"), { name: "openclaw" });
    writeBundledChannelPlugin(root, "telegram", { "telegram-only": "1.0.0" });

    const result = scanBundledPluginRuntimeDeps({
      packageRoot: root,
      includeConfiguredChannels: true,
      config: {
        plugins: { enabled: true },
        channels: {
          telegram: { botToken: "123:abc" },
        },
      },
    });

    expect(result.missing.map((dep) => `${dep.name}@${dep.version}`)).toEqual([
      "telegram-only@1.0.0",
    ]);
    expect(result.conflicts).toEqual([]);
  });

  it("does not include configured bundled channel deps when the plugin entry is disabled", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-doctor-bundled-"));
    writeJson(path.join(root, "package.json"), { name: "openclaw" });
    writeBundledChannelPlugin(root, "telegram", { "telegram-only": "1.0.0" });

    const result = scanBundledPluginRuntimeDeps({
      packageRoot: root,
      includeConfiguredChannels: true,
      config: {
        plugins: {
          enabled: true,
          entries: {
            telegram: { enabled: false },
          },
        },
        channels: {
          telegram: { botToken: "123:abc" },
        },
      },
    });

    expect(result.missing).toEqual([]);
    expect(result.conflicts).toEqual([]);
  });

  it("lets channel disablement suppress default-enabled bundled channel deps", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-doctor-bundled-"));
    writeJson(path.join(root, "package.json"), { name: "openclaw" });
    writeDefaultEnabledBundledChannelPlugin(root, "demo", { "demo-only": "1.0.0" });

    const result = scanBundledPluginRuntimeDeps({
      packageRoot: root,
      includeConfiguredChannels: true,
      config: {
        plugins: { enabled: true },
        channels: {
          demo: { enabled: false },
        },
      },
    });

    expect(result.missing).toEqual([]);
    expect(result.conflicts).toEqual([]);
  });

  it("reports default-enabled gateway startup sidecar deps", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-doctor-bundled-"));
    writeJson(path.join(root, "package.json"), { name: "openclaw" });
    writeJson(path.join(root, "dist", "extensions", "browser", "package.json"), {
      dependencies: {
        "browser-only": "1.0.0",
      },
    });
    writeJson(path.join(root, "dist", "extensions", "browser", "openclaw.plugin.json"), {
      id: "browser",
      enabledByDefault: true,
      configSchema: { type: "object" },
    });

    const result = scanBundledPluginRuntimeDeps({
      packageRoot: root,
      config: {
        plugins: { enabled: true },
      },
    });

    expect(result.missing.map((dep) => `${dep.name}@${dep.version}`)).toEqual([
      "browser-only@1.0.0",
    ]);
    expect(result.conflicts).toEqual([]);
  });

  it("reports explicitly enabled provider deps", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-doctor-bundled-"));
    writeJson(path.join(root, "package.json"), { name: "openclaw" });
    writeJson(path.join(root, "dist", "extensions", "bedrock", "package.json"), {
      dependencies: {
        "bedrock-only": "1.0.0",
      },
    });
    writeJson(path.join(root, "dist", "extensions", "bedrock", "openclaw.plugin.json"), {
      id: "bedrock",
      enabledByDefault: true,
      providers: ["bedrock"],
      configSchema: { type: "object" },
    });

    const result = scanBundledPluginRuntimeDeps({
      packageRoot: root,
      config: {
        plugins: {
          enabled: true,
          allow: ["bedrock"],
          entries: { bedrock: { enabled: true } },
        },
      },
    });

    expect(result.missing.map((dep) => `${dep.name}@${dep.version}`)).toEqual([
      "bedrock-only@1.0.0",
    ]);
    expect(result.conflicts).toEqual([]);
  });

  it("does not report allowlist-excluded default-enabled bundled plugin deps", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-doctor-bundled-"));
    writeJson(path.join(root, "package.json"), { name: "openclaw" });
    writeJson(path.join(root, "dist", "extensions", "openai", "package.json"), {
      dependencies: {
        "openai-only": "1.0.0",
      },
    });
    writeJson(path.join(root, "dist", "extensions", "openai", "openclaw.plugin.json"), {
      id: "openai",
      enabledByDefault: true,
      configSchema: { type: "object" },
    });

    const result = scanBundledPluginRuntimeDeps({
      packageRoot: root,
      config: {
        plugins: { enabled: true, allow: ["browser"] },
      },
    });

    expect(result.missing).toEqual([]);
    expect(result.conflicts).toEqual([]);
  });

  it("lets explicit bundled channel enablement bypass runtime-deps allowlist gating", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-doctor-bundled-"));
    writeJson(path.join(root, "package.json"), { name: "openclaw" });
    writeBundledChannelPlugin(root, "telegram", { "telegram-only": "1.0.0" });

    const result = scanBundledPluginRuntimeDeps({
      packageRoot: root,
      config: {
        plugins: { enabled: true, allow: ["browser"] },
        channels: {
          telegram: { enabled: true },
        },
      },
    });

    expect(result.missing.map((dep) => `${dep.name}@${dep.version}`)).toEqual([
      "telegram-only@1.0.0",
    ]);
    expect(result.conflicts).toEqual([]);
  });

  it("does not let doctor channel recovery bypass restrictive plugin allowlists", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-doctor-bundled-"));
    writeJson(path.join(root, "package.json"), { name: "openclaw" });
    writeBundledChannelPlugin(root, "telegram", { "telegram-only": "1.0.0" });

    const result = scanBundledPluginRuntimeDeps({
      packageRoot: root,
      includeConfiguredChannels: true,
      config: {
        plugins: { enabled: true, allow: ["browser"] },
        channels: {
          telegram: { botToken: "123:abc" },
        },
      },
    });

    expect(result.missing).toEqual([]);
    expect(result.conflicts).toEqual([]);
  });

  it("does not repair inactive default-enabled provider deps", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-doctor-bundled-"));
    writeJson(path.join(root, "package.json"), { name: "openclaw" });
    writeJson(path.join(root, "dist", "extensions", "bedrock", "package.json"), {
      dependencies: {
        "bedrock-only": "1.0.0",
      },
    });
    writeJson(path.join(root, "dist", "extensions", "bedrock", "openclaw.plugin.json"), {
      id: "bedrock",
      enabledByDefault: true,
      providers: ["bedrock"],
      configSchema: { type: "object" },
    });
    const installed = createInstalledRuntimeDeps();

    await maybeRepairBundledPluginRuntimeDeps({
      runtime: createRuntime(),
      prompter: createNonInteractivePrompter(),
      packageRoot: root,
      config: {
        plugins: { enabled: true },
      },
      installDeps: (params) => {
        installed.push(params);
        materializeRuntimeDeps(params);
      },
    });

    expect(installed).toEqual([]);
  });

  it("repairs explicitly enabled provider deps", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-doctor-bundled-"));
    writeJson(path.join(root, "package.json"), { name: "openclaw" });
    writeJson(path.join(root, "dist", "extensions", "bedrock", "package.json"), {
      dependencies: {
        "bedrock-only": "1.0.0",
      },
    });
    writeJson(path.join(root, "dist", "extensions", "bedrock", "openclaw.plugin.json"), {
      id: "bedrock",
      enabledByDefault: true,
      providers: ["bedrock"],
      configSchema: { type: "object" },
    });
    const installed = createInstalledRuntimeDeps();

    await maybeRepairBundledPluginRuntimeDeps({
      runtime: createRuntime(),
      prompter: createNonInteractivePrompter(),
      packageRoot: root,
      config: {
        plugins: {
          enabled: true,
          allow: ["bedrock"],
          entries: { bedrock: { enabled: true } },
        },
      },
      installDeps: (params) => {
        installed.push(params);
        materializeRuntimeDeps(params);
      },
    });

    expect(installed).toEqual([
      {
        installRoot: resolveBundledRuntimeDependencyPackageInstallRoot(root),
        missingSpecs: ["bedrock-only@1.0.0"],
        installSpecs: ["bedrock-only@1.0.0"],
      },
    ]);
  });

  it("repairs configured provider deps", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-doctor-bundled-"));
    writeJson(path.join(root, "package.json"), { name: "openclaw" });
    writeBundledProviderPlugin(root, "anthropic-vertex", ["anthropic-vertex"], {
      "@anthropic-ai/vertex-sdk": "^0.16.0",
    });
    const installed = createInstalledRuntimeDeps();

    await maybeRepairBundledPluginRuntimeDeps({
      runtime: createRuntime(),
      prompter: createNonInteractivePrompter(),
      packageRoot: root,
      config: {
        plugins: { enabled: true },
        agents: {
          defaults: {
            model: "anthropic-vertex/claude-sonnet-4-6",
          },
        },
      },
      installDeps: (params) => {
        installed.push(params);
        materializeRuntimeDeps(params);
      },
    });

    expect(installed).toEqual([
      {
        installRoot: resolveBundledRuntimeDependencyPackageInstallRoot(root),
        missingSpecs: ["@anthropic-ai/vertex-sdk@^0.16.0"],
        installSpecs: ["@anthropic-ai/vertex-sdk@^0.16.0"],
      },
    ]);
  });

  it("repairs configured provider deps from provider aliases and subagent defaults", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-doctor-bundled-"));
    writeJson(path.join(root, "package.json"), { name: "openclaw" });
    writeBundledProviderPlugin(root, "amazon-bedrock", ["amazon-bedrock"], {
      "bedrock-only": "1.0.0",
    });
    const installed = createInstalledRuntimeDeps();

    await maybeRepairBundledPluginRuntimeDeps({
      runtime: createRuntime(),
      prompter: createNonInteractivePrompter(),
      packageRoot: root,
      config: {
        plugins: { enabled: true },
        models: {
          providers: {
            "aws-bedrock": {
              baseUrl: "",
              auth: "aws-sdk",
              models: [],
            },
          },
        },
        agents: {
          defaults: {
            subagents: {
              model: "bedrock/claude-sonnet-4-6",
            },
          },
        },
      },
      installDeps: (params) => {
        installed.push(params);
        materializeRuntimeDeps(params);
      },
    });

    expect(installed).toEqual([
      {
        installRoot: resolveBundledRuntimeDependencyPackageInstallRoot(root),
        missingSpecs: ["bedrock-only@1.0.0"],
        installSpecs: ["bedrock-only@1.0.0"],
      },
    ]);
  });

  it("repairs missing deps during non-interactive doctor", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-doctor-bundled-"));
    writeJson(path.join(root, "package.json"), { name: "openclaw" });
    writeBundledChannelPlugin(root, "telegram", { grammy: "1.37.0" });
    const installed = createInstalledRuntimeDeps();

    await maybeRepairBundledPluginRuntimeDeps({
      runtime: createRuntime(),
      prompter: createNonInteractivePrompter(),
      packageRoot: root,
      config: {
        plugins: { enabled: true },
        channels: { telegram: { enabled: true } },
      },
      installDeps: (params) => {
        installed.push(params);
        materializeRuntimeDeps(params);
      },
    });

    const installRoot = resolveBundledRuntimeDependencyPackageInstallRoot(root);
    expect(installed).toEqual([
      {
        installRoot,
        missingSpecs: ["grammy@1.37.0"],
        installSpecs: ["grammy@1.37.0"],
      },
    ]);
    expect(installRoot).not.toBe(root);
    expect(readMaterializedRuntimeDepSpecs(installRoot, ["grammy@1.37.0"])).toEqual([
      "grammy@1.37.0",
    ]);
    expectNoLegacyRuntimeDepsManifest(installRoot);
  });

  it("logs runtime dependency repair progress before and after install", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-doctor-bundled-"));
    writeJson(path.join(root, "package.json"), { name: "openclaw" });
    writeBundledChannelPlugin(root, "telegram", { grammy: "1.37.0" });
    const logs: string[] = [];

    await maybeRepairBundledPluginRuntimeDeps({
      runtime: createRuntime({ logs }),
      prompter: createNonInteractivePrompter(),
      packageRoot: root,
      config: {
        plugins: { enabled: true },
        channels: { telegram: { enabled: true } },
      },
      installDeps: async () => {},
    });

    expect(logs).toEqual(
      expect.arrayContaining([
        expect.stringContaining("Installing bundled plugin runtime deps (1 specs): grammy@1.37.0"),
        expect.stringContaining("Installed bundled plugin runtime deps in"),
      ]),
    );
  });

  it("logs runtime dependency repair heartbeats while install is pending", async () => {
    vi.useFakeTimers();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-doctor-bundled-"));
    writeJson(path.join(root, "package.json"), { name: "openclaw" });
    writeBundledChannelPlugin(root, "telegram", { grammy: "1.37.0" });
    const logs: string[] = [];
    let finishInstall!: () => void;

    const repair = maybeRepairBundledPluginRuntimeDeps({
      runtime: createRuntime({ logs }),
      prompter: createNonInteractivePrompter(),
      packageRoot: root,
      config: {
        plugins: { enabled: true },
        channels: { telegram: { enabled: true } },
      },
      installDeps: async () =>
        await new Promise<void>((resolve) => {
          finishInstall = resolve;
        }),
    });

    await vi.waitFor(() =>
      expect(logs).toEqual([expect.stringContaining("Installing bundled plugin runtime deps")]),
    );
    await vi.advanceTimersByTimeAsync(15_000);
    expect(logs).toContain("Still installing bundled plugin runtime deps after 15s...");

    finishInstall();
    await repair;
  });

  it("awaits async runtime-deps repairs before reporting completion", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-doctor-bundled-"));
    writeJson(path.join(root, "package.json"), { name: "openclaw" });
    writeBundledChannelPlugin(root, "telegram", { grammy: "1.37.0" });
    const installed = createInstalledRuntimeDeps();
    const notes: string[] = [];
    let finishInstall!: () => void;

    const repair = maybeRepairBundledPluginRuntimeDeps({
      runtime: { error: () => {}, log: () => {} } as never,
      prompter: createNonInteractivePrompter(),
      packageRoot: root,
      config: {
        plugins: { enabled: true },
        channels: { telegram: { enabled: true } },
      },
      installDeps: async (params) => {
        installed.push(params);
        await new Promise<void>((resolve) => {
          finishInstall = resolve;
        });
      },
    }).then(() => notes.push("done"));

    await vi.waitFor(() => expect(installed).toHaveLength(1));
    expect(notes).toEqual([]);

    finishInstall();
    await repair;
    expect(notes).toEqual(["done"]);
  });

  it("repairs deps for configured channel owner plugins", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-doctor-bundled-"));
    writeJson(path.join(root, "package.json"), { name: "openclaw" });
    writeBundledChannelOwnerPlugin(root, "chat-bridge", ["telegram"], { grammy: "1.37.0" });
    const installed = createInstalledRuntimeDeps();

    await maybeRepairBundledPluginRuntimeDeps({
      runtime: createRuntime(),
      prompter: createNonInteractivePrompter(),
      packageRoot: root,
      config: {
        plugins: { enabled: true },
        channels: { telegram: { enabled: true } },
      },
      installDeps: (params) => {
        installed.push(params);
        materializeRuntimeDeps(params);
      },
    });

    const installRoot = resolveBundledRuntimeDependencyPackageInstallRoot(root);
    expect(installed).toEqual([
      {
        installRoot,
        missingSpecs: ["grammy@1.37.0"],
        installSpecs: ["grammy@1.37.0"],
      },
    ]);
  });

  it("does not repair configured channel deps when the owner plugin is disabled", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-doctor-bundled-"));
    writeJson(path.join(root, "package.json"), { name: "openclaw" });
    writeBundledChannelPlugin(root, "discord", { "discord-api-types": "0.38.47" });
    const installed = createInstalledRuntimeDeps();

    await maybeRepairBundledPluginRuntimeDeps({
      runtime: createRuntime(),
      prompter: createNonInteractivePrompter(),
      packageRoot: root,
      config: {
        plugins: {
          enabled: true,
          entries: {
            discord: { enabled: false },
          },
        },
        channels: {
          discord: { enabled: true, token: "disabled-plugin-entry-token" },
        },
      },
      installDeps: (params) => {
        installed.push(params);
        materializeRuntimeDeps(params);
      },
    });

    expect(installed).toEqual([]);
  });

  it("throws when bundled runtime dependency repair fails", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-doctor-bundled-"));
    const errors: string[] = [];
    writeJson(path.join(root, "package.json"), { name: "openclaw" });
    writeBundledChannelPlugin(root, "telegram", { grammy: "1.37.0" });

    await expect(
      maybeRepairBundledPluginRuntimeDeps({
        runtime: createRuntime({ errors }),
        prompter: createNonInteractivePrompter(),
        packageRoot: root,
        config: {
          plugins: { enabled: true },
          channels: { telegram: { enabled: true } },
        },
        installDeps: () => {
          throw new Error("ENOSPC");
        },
      }),
    ).rejects.toThrow("ENOSPC");

    expect(errors.join("\n")).toContain(
      "Failed to install bundled plugin runtime deps: Error: ENOSPC",
    );
  });

  it("repairs Feishu runtime deps from preserved source config", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-doctor-bundled-"));
    writeJson(path.join(root, "package.json"), { name: "openclaw" });
    writeBundledChannelPlugin(root, "feishu", { "@larksuiteoapi/node-sdk": "^1.61.0" });
    const installed = createInstalledRuntimeDeps();

    await maybeRepairBundledPluginRuntimeDeps({
      runtime: createRuntime(),
      prompter: createNonInteractivePrompter({ updateInProgress: true }),
      packageRoot: root,
      includeConfiguredChannels: true,
      config: {
        plugins: { enabled: true },
        channels: { feishu: { enabled: true } },
      },
      installDeps: (params) => {
        installed.push(params);
      },
    });

    const installRoot = resolveBundledRuntimeDependencyPackageInstallRoot(root);
    expect(installed).toEqual([
      {
        installRoot,
        missingSpecs: ["@larksuiteoapi/node-sdk@^1.61.0"],
        installSpecs: ["@larksuiteoapi/node-sdk@^1.61.0"],
      },
    ]);
    expect(installRoot).not.toBe(root);
  });

  it("repairs missing deps into an external stage dir when configured", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-doctor-bundled-"));
    const stageDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-doctor-bundled-stage-"));
    writeJson(path.join(root, "package.json"), { name: "openclaw", version: "2026.4.22" });
    writeBundledChannelPlugin(root, "slack", { "@slack/web-api": "7.15.1" });
    const env = { OPENCLAW_PLUGIN_STAGE_DIR: stageDir };
    const installed = createInstalledRuntimeDeps();

    await maybeRepairBundledPluginRuntimeDeps({
      runtime: createRuntime(),
      prompter: createNonInteractivePrompter(),
      env,
      packageRoot: root,
      config: {
        plugins: { enabled: true },
        channels: { slack: { enabled: true } },
      },
      installDeps: (params) => {
        installed.push(params);
        materializeRuntimeDeps(params);
      },
    });

    const installRoot = resolveBundledRuntimeDependencyPackageInstallRoot(root, { env });
    expect(installed).toEqual([
      {
        installRoot,
        missingSpecs: ["@slack/web-api@7.15.1"],
        installSpecs: ["@slack/web-api@7.15.1"],
      },
    ]);
    expect(installRoot).toContain(stageDir);
    expect(readMaterializedRuntimeDepSpecs(installRoot, ["@slack/web-api@7.15.1"])).toEqual([
      "@slack/web-api@7.15.1",
    ]);
    expectNoLegacyRuntimeDepsManifest(installRoot);
  });

  it("repairs the complete dependency plan into the final layered stage dir", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-doctor-bundled-"));
    const baselineStageDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "openclaw-doctor-bundled-baseline-"),
    );
    const writableStageDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "openclaw-doctor-bundled-writable-"),
    );
    writeJson(path.join(root, "package.json"), { name: "openclaw", version: "2026.4.25" });
    writeBundledChannelPlugin(root, "slack", {
      "@slack/web-api": "7.15.1",
      grammy: "1.37.0",
    });
    const env = {
      OPENCLAW_PLUGIN_STAGE_DIR: [baselineStageDir, writableStageDir].join(path.delimiter),
    };
    const installRoot = resolveBundledRuntimeDependencyPackageInstallRoot(root, { env });
    const baselineRoot = installRoot.replace(writableStageDir, baselineStageDir);
    writeJson(path.join(baselineRoot, "node_modules", "@slack", "web-api", "package.json"), {
      name: "@slack/web-api",
      version: "7.15.1",
    });
    const installed = createInstalledRuntimeDeps();

    await maybeRepairBundledPluginRuntimeDeps({
      runtime: createRuntime(),
      prompter: createNonInteractivePrompter(),
      env,
      packageRoot: root,
      config: {
        plugins: { enabled: true },
        channels: { slack: { enabled: true } },
      },
      installDeps: (params) => {
        installed.push(params);
      },
    });

    expect(installRoot).toContain(writableStageDir);
    expect(installed).toEqual([
      {
        installRoot,
        missingSpecs: ["@slack/web-api@7.15.1", "grammy@1.37.0"],
        installSpecs: ["@slack/web-api@7.15.1", "grammy@1.37.0"],
      },
    ]);
    expectNoLegacyRuntimeDepsManifest(installRoot);
  });

  it("drops stale legacy bundled deps manifests when repairing a subset", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-doctor-bundled-"));
    writeJson(path.join(root, "package.json"), { name: "openclaw" });
    writeBundledChannelPlugin(root, "telegram", { grammy: "1.37.0" });
    writeBundledChannelPlugin(root, "slack", { "@slack/web-api": "7.15.1" });
    const installRoot = resolveBundledRuntimeDependencyPackageInstallRoot(root);
    writeJson(path.join(installRoot, ".openclaw-runtime-deps.json"), {
      specs: ["@slack/web-api@7.15.1"],
    });
    const installed = createInstalledRuntimeDeps();

    await maybeRepairBundledPluginRuntimeDeps({
      runtime: createRuntime(),
      prompter: createNonInteractivePrompter(),
      packageRoot: root,
      includeConfiguredChannels: true,
      config: {
        plugins: { enabled: true },
        channels: {
          telegram: { enabled: true },
          slack: { enabled: false, botToken: "xoxb-test", appToken: "xapp-test" },
        },
      },
      installDeps: (params) => {
        installed.push(params);
        materializeRuntimeDeps(params);
      },
    });

    expect(installed).toEqual([
      {
        installRoot,
        missingSpecs: ["grammy@1.37.0"],
        installSpecs: ["grammy@1.37.0"],
      },
    ]);
    expect(installRoot).not.toBe(root);
    expect(readMaterializedRuntimeDepSpecs(installRoot, ["grammy@1.37.0"])).toEqual([
      "grammy@1.37.0",
    ]);
    expectNoLegacyRuntimeDepsManifest(installRoot);
  });
});
