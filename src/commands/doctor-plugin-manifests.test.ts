import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { cleanupTrackedTempDirs } from "../plugins/test-helpers/fs-fixtures.js";
import type { RuntimeEnv } from "../runtime.js";
import {
  collectLegacyPluginManifestContractMigrations,
  maybeRepairLegacyPluginManifestContracts,
} from "./doctor-plugin-manifests.js";
import type { DoctorPrompter } from "./doctor-prompter.js";

const tempDirs: string[] = [];

function makeTrustedBundledPluginsDir() {
  const fixturesRoot = path.join(process.cwd(), "dist", "extensions");
  fs.mkdirSync(fixturesRoot, { recursive: true });
  const dir = fs.mkdtempSync(path.join(fixturesRoot, "openclaw-doctor-plugin-manifests-"));
  tempDirs.push(dir);
  return dir;
}

function configWithPluginLoadPath(pluginRoot: string): OpenClawConfig {
  return {
    plugins: {
      load: {
        paths: [pluginRoot],
      },
    },
  };
}

function writeManifest(dir: string, manifest: Record<string, unknown>) {
  fs.writeFileSync(
    path.join(dir, "openclaw.plugin.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf-8",
  );
}

function writePackageJson(dir: string) {
  fs.writeFileSync(
    path.join(dir, "package.json"),
    `${JSON.stringify(
      {
        name: "@openclaw/test-plugin",
        version: "1.0.0",
        openclaw: {
          extensions: ["./index.ts"],
        },
      },
      null,
      2,
    )}\n`,
    "utf-8",
  );
  fs.writeFileSync(path.join(dir, "index.ts"), "export default {};\n", "utf-8");
}

function createRuntime(): RuntimeEnv {
  return {
    log: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as unknown as RuntimeEnv;
}

function createPrompter(overrides: Partial<DoctorPrompter> = {}): DoctorPrompter {
  return {
    confirm: vi.fn(),
    confirmAutoFix: vi.fn().mockResolvedValue(true),
    confirmAggressiveAutoFix: vi.fn(),
    confirmRuntimeRepair: vi.fn(),
    select: vi.fn(),
    shouldRepair: false,
    shouldForce: false,
    repairMode: {
      shouldRepair: false,
      shouldForce: false,
      nonInteractive: false,
      canPrompt: true,
    },
    ...overrides,
  } as unknown as DoctorPrompter;
}

describe("doctor plugin manifest legacy contract repair", () => {
  afterEach(() => {
    cleanupTrackedTempDirs(tempDirs);
    vi.restoreAllMocks();
  });

  it("collects legacy top-level capability keys for migration", () => {
    const pluginsRoot = makeTrustedBundledPluginsDir();
    const root = path.join(pluginsRoot, "openai");
    fs.mkdirSync(root, { recursive: true });
    writePackageJson(root);
    writeManifest(root, {
      id: "openai",
      providers: ["openai"],
      speechProviders: ["openai"],
      configSchema: { type: "object" },
    });

    const migrations = collectLegacyPluginManifestContractMigrations({
      config: configWithPluginLoadPath(pluginsRoot),
      env: {
        ...process.env,
      },
      manifestRoots: [pluginsRoot],
    });

    const manifestPath = path.join(root, "openclaw.plugin.json");
    expect(migrations).toStrictEqual([
      {
        changeLines: [`- ${manifestPath}: moved speechProviders to contracts.speechProviders`],
        manifestPath,
        nextRaw: {
          id: "openai",
          providers: ["openai"],
          contracts: {
            speechProviders: ["openai"],
          },
          configSchema: { type: "object" },
        },
        pluginId: "openai",
      },
    ]);
  });

  it("rewrites legacy top-level capability keys into contracts", async () => {
    const pluginsRoot = makeTrustedBundledPluginsDir();
    const root = path.join(pluginsRoot, "openai");
    fs.mkdirSync(root, { recursive: true });
    writePackageJson(root);
    writeManifest(root, {
      id: "openai",
      providers: ["openai"],
      speechProviders: ["openai"],
      mediaUnderstandingProviders: ["openai"],
      contracts: {
        webSearchProviders: ["gemini"],
      },
      configSchema: { type: "object" },
    });

    await maybeRepairLegacyPluginManifestContracts({
      config: configWithPluginLoadPath(pluginsRoot),
      env: {
        ...process.env,
      },
      manifestRoots: [pluginsRoot],
      runtime: createRuntime(),
      prompter: createPrompter(),
      note: vi.fn(),
    });

    const next = JSON.parse(fs.readFileSync(path.join(root, "openclaw.plugin.json"), "utf-8")) as {
      speechProviders?: string[];
      mediaUnderstandingProviders?: string[];
      contracts?: Record<string, string[]>;
    };
    expect(next.speechProviders).toBeUndefined();
    expect(next.mediaUnderstandingProviders).toBeUndefined();
    expect(next.contracts).toEqual({
      speechProviders: ["openai"],
      mediaUnderstandingProviders: ["openai"],
      webSearchProviders: ["gemini"],
    });
  });

  it("ignores non-object contracts payloads when collecting migrations", () => {
    const pluginsRoot = makeTrustedBundledPluginsDir();
    const root = path.join(pluginsRoot, "openai");
    fs.mkdirSync(root, { recursive: true });
    writePackageJson(root);
    writeManifest(root, {
      id: "openai",
      providers: ["openai"],
      speechProviders: ["openai"],
      contracts: "broken",
      configSchema: { type: "object" },
    });

    const migrations = collectLegacyPluginManifestContractMigrations({
      config: configWithPluginLoadPath(pluginsRoot),
      env: {
        ...process.env,
      },
      manifestRoots: [pluginsRoot],
    });

    const manifestPath = path.join(root, "openclaw.plugin.json");
    expect(migrations).toStrictEqual([
      {
        changeLines: [`- ${manifestPath}: moved speechProviders to contracts.speechProviders`],
        manifestPath,
        nextRaw: {
          id: "openai",
          providers: ["openai"],
          contracts: {
            speechProviders: ["openai"],
          },
          configSchema: { type: "object" },
        },
        pluginId: "openai",
      },
    ]);
  });
});
