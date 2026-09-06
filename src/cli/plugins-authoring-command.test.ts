// Plugins authoring command tests cover plugin authoring command output and file generation.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { publicPluginSdkSubpaths } from "../../scripts/lib/plugin-sdk-entries.mjs";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { defaultRuntime } from "../runtime.js";
import { withEnvAsync } from "../test-utils/env.js";
import { VERSION } from "../version.js";
import {
  runPluginsBuildCommand,
  runPluginsInitCommand,
  runPluginsValidateCommand,
} from "./plugins-authoring-command.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function writeSourceToolPluginProject(params: {
  tmpDir: string;
  packageName: string;
  pluginId: string;
  toolName: string;
  optional?: boolean;
  extraToolNames?: string[];
  configSchemaSource?: string;
}): string {
  const sourceDir = path.join(params.tmpDir, "src");
  fs.mkdirSync(sourceDir, { recursive: true });
  fs.writeFileSync(
    path.join(params.tmpDir, "package.json"),
    JSON.stringify(
      {
        name: params.packageName,
        version: "1.2.3",
        type: "module",
        openclaw: { extensions: ["./src/index.ts"] },
      },
      null,
      2,
    ),
  );
  const entryPath = path.join(sourceDir, "index.ts");
  fs.writeFileSync(
    entryPath,
    `import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";

export default defineToolPlugin({
  id: ${JSON.stringify(params.pluginId)},
  name: "Source Demo",
  description: "Source demo plugin.",
  ${params.configSchemaSource ? `configSchema: ${params.configSchemaSource},` : ""}
  tools: (tool) => ${JSON.stringify([params.toolName, ...(params.extraToolNames ?? [])])}.map((name) =>
    tool({
      name,
      description: "Echo input.",
      parameters: { type: "object", additionalProperties: false, properties: {} },
      optional: ${Boolean(params.optional)},
      execute: async () => ({ ok: true }),
    }),
  ),
});
`,
  );
  return entryPath;
}

function readProjectJson(rootDir: string, file = "openclaw.plugin.json"): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(rootDir, file), "utf8")) as Record<string, unknown>;
}

function writeProjectJson(rootDir: string, file: string, value: unknown): void {
  fs.writeFileSync(path.join(rootDir, file), `${JSON.stringify(value, null, 2)}\n`);
}

async function expectProjectValidation(rootDir: string, pluginId: string, errors: string[] = []) {
  const exitError = new Error("validation exited");
  const writeJson = vi.spyOn(defaultRuntime, "writeJson").mockImplementation(() => {});
  const error = vi.spyOn(defaultRuntime, "error").mockImplementation(() => {});
  const exit = vi.spyOn(defaultRuntime, "exit").mockImplementation(() => {
    throw exitError;
  });
  try {
    const validation = runPluginsValidateCommand({
      root: rootDir,
      entry: "./src/index.ts",
      json: true,
    });
    if (errors.length > 0) {
      await expect(validation).rejects.toBe(exitError);
      expect(exit).toHaveBeenCalledExactlyOnceWith(1, { resetStream: process.stderr });
    } else {
      await validation;
      expect(exit).not.toHaveBeenCalled();
    }
    expect(writeJson).toHaveBeenCalledExactlyOnceWith({
      valid: errors.length === 0,
      pluginId,
      errors,
    });
    expect(error.mock.calls.map(([message]) => message)).toEqual(errors);
  } finally {
    writeJson.mockRestore();
    error.mockRestore();
    exit.mockRestore();
  }
}

describe("plugin authoring commands", () => {
  beforeAll(async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-plugin-source-warm-"));
    try {
      const entryPath = writeSourceToolPluginProject({
        tmpDir,
        packageName: "openclaw-plugin-source-warm",
        pluginId: "source-warm",
        toolName: "source_warm_echo",
      });
      await runPluginsBuildCommand({ root: tmpDir, entry: entryPath });
    } finally {
      fs.rmSync(tmpDir, { force: true, recursive: true });
    }
  });

  it.each([false, true])(
    "builds and validates tool metadata with optional=%s",
    async (optional) => {
      const tmpDir = tempDirs.make("openclaw-plugin-generated-manifest-");
      const entryPath = writeSourceToolPluginProject({
        tmpDir,
        packageName: "openclaw-plugin-demo-tools",
        pluginId: "demo-tools",
        toolName: "demo_echo",
        optional,
      });
      await runPluginsBuildCommand({ root: tmpDir, entry: entryPath });

      expect(readProjectJson(tmpDir)).toEqual({
        id: "demo-tools",
        name: "Source Demo",
        description: "Source demo plugin.",
        version: "1.2.3",
        configSchema: {
          type: "object",
          additionalProperties: false,
          properties: {},
        },
        activation: { onStartup: true },
        contracts: { tools: ["demo_echo"] },
        ...(optional ? { toolMetadata: { demo_echo: { optional: true } } } : {}),
      });
      await expectProjectValidation(tmpDir, "demo-tools");
    },
  );

  it("preserves manifest-owned metadata while updating generated fields", async () => {
    const tmpDir = tempDirs.make("openclaw-plugin-manifest-owned-metadata-");
    const entryPath = writeSourceToolPluginProject({
      tmpDir,
      packageName: "openclaw-plugin-optional-demo-tools",
      pluginId: "optional-demo-tools",
      toolName: "demo_optional_echo",
      optional: true,
    });
    const existingManifest = {
      id: "old-id",
      name: "Old name",
      uiHints: { apiKey: { secret: true } },
      contracts: {
        tools: ["stale_tool"],
        agentToolResultMiddleware: ["existing-middleware"],
      },
      toolMetadata: {
        demo_optional_echo: {
          authSignals: [{ provider: "demo", envVars: ["DEMO_API_KEY"] }],
          configSignals: [{ rootPath: "plugins.entries.optional-demo-tools.config.apiKey" }],
        },
        stale_tool: {
          optional: true,
        },
      },
    };

    writeProjectJson(tmpDir, "openclaw.plugin.json", existingManifest);
    await runPluginsBuildCommand({ root: tmpDir, entry: entryPath });
    const manifest = readProjectJson(tmpDir);

    expect(manifest).toMatchObject({
      id: "optional-demo-tools",
      name: "Source Demo",
      uiHints: { apiKey: { secret: true } },
      contracts: {
        tools: ["demo_optional_echo"],
        agentToolResultMiddleware: ["existing-middleware"],
      },
      toolMetadata: {
        demo_optional_echo: {
          optional: true,
          authSignals: [{ provider: "demo", envVars: ["DEMO_API_KEY"] }],
          configSignals: [{ rootPath: "plugins.entries.optional-demo-tools.config.apiKey" }],
        },
      },
    });
    expect((manifest.toolMetadata as Record<string, unknown>).stale_tool).toBeUndefined();
    await expectProjectValidation(tmpDir, "optional-demo-tools");
  });

  it("drops stale manifest-owned tool metadata when no generated metadata remains", async () => {
    const tmpDir = tempDirs.make("openclaw-plugin-stale-tool-metadata-");
    const entryPath = writeSourceToolPluginProject({
      tmpDir,
      packageName: "openclaw-plugin-demo-tools",
      pluginId: "demo-tools",
      toolName: "demo_echo",
    });
    writeProjectJson(tmpDir, "openclaw.plugin.json", {
      id: "demo-tools",
      name: "Demo Tools",
      toolMetadata: {
        stale_tool: { optional: true },
      },
    });
    await runPluginsBuildCommand({ root: tmpDir, entry: entryPath });

    expect(readProjectJson(tmpDir).toolMetadata).toBeUndefined();
    await expectProjectValidation(tmpDir, "demo-tools");
  });

  it("aligns package metadata with the selected runtime extension entry", async () => {
    const tmpDir = tempDirs.make("openclaw-plugin-selected-entry-");
    const entryPath = writeSourceToolPluginProject({
      tmpDir,
      packageName: "demo",
      pluginId: "demo-tools",
      toolName: "demo_echo",
    });
    writeProjectJson(tmpDir, "package.json", {
      name: "demo",
      openclaw: { setupEntry: "./setup.ts", extensions: ["./src/other.ts"] },
    });
    await runPluginsBuildCommand({ root: tmpDir, entry: entryPath });

    expect(readProjectJson(tmpDir, "package.json")).toEqual({
      name: "demo",
      openclaw: {
        setupEntry: "./setup.ts",
        extensions: ["./src/other.ts", "./src/index.ts"],
      },
    });
    await expectProjectValidation(tmpDir, "demo-tools");
  });

  it("emits a stable JSON validation result without human output", async () => {
    const tmpDir = tempDirs.make("openclaw-plugin-valid-json-");
    const entryPath = writeSourceToolPluginProject({
      tmpDir,
      packageName: "openclaw-plugin-valid-json",
      pluginId: "valid-json",
      toolName: "valid_json_echo",
    });
    await runPluginsBuildCommand({ root: tmpDir, entry: entryPath });
    const writeJson = vi.spyOn(defaultRuntime, "writeJson").mockImplementation(() => {});
    const log = vi.spyOn(defaultRuntime, "log").mockImplementation(() => {});
    const error = vi.spyOn(defaultRuntime, "error").mockImplementation(() => {});

    try {
      await runPluginsValidateCommand({ root: tmpDir, entry: entryPath, json: true });

      expect(writeJson).toHaveBeenCalledOnce();
      expect(writeJson).toHaveBeenCalledWith({ valid: true, pluginId: "valid-json", errors: [] });
      expect(log).not.toHaveBeenCalled();
      expect(error).not.toHaveBeenCalled();
    } finally {
      writeJson.mockRestore();
      log.mockRestore();
      error.mockRestore();
    }
  });

  it("keeps validation errors on stderr and sanitizes JSON paths", async () => {
    const homeDir = tempDirs.make("openclaw-plugin-invalid-json-home-");
    const rootDir = path.join(homeDir, "plugins", "invalid-json");
    fs.mkdirSync(rootDir, { recursive: true });
    fs.writeFileSync(path.join(rootDir, "package.json"), "{}\n");
    const writeJson = vi.spyOn(defaultRuntime, "writeJson").mockImplementation(() => {});
    const log = vi.spyOn(defaultRuntime, "log").mockImplementation(() => {});
    const error = vi.spyOn(defaultRuntime, "error").mockImplementation(() => {});
    const exit = vi.spyOn(defaultRuntime, "exit").mockImplementation((code) => {
      throw new Error(`expected runtime exit ${code}`);
    });

    try {
      await expect(
        withEnvAsync({ OPENCLAW_HOME: homeDir }, async () => {
          await runPluginsValidateCommand({ root: rootDir, json: true });
        }),
      ).rejects.toThrow("expected runtime exit 1");

      expect(writeJson).toHaveBeenCalledWith({
        valid: false,
        errors: [
          "plugin manifest not found: $OPENCLAW_HOME/plugins/invalid-json/openclaw.plugin.json",
        ],
      });
      expect(error).toHaveBeenCalledWith(
        `plugin manifest not found: ${rootDir}/openclaw.plugin.json`,
      );
      expect(log).not.toHaveBeenCalled();
      expect(exit).toHaveBeenCalledWith(1, { resetStream: process.stderr });
    } finally {
      writeJson.mockRestore();
      log.mockRestore();
      error.mockRestore();
      exit.mockRestore();
    }
  });

  it.each(["validate", "build --check"] as const)(
    "accepts reordered JSON object keys without rewriting files in %s",
    async (command) => {
      const tmpDir = tempDirs.make("openclaw-plugin-reordered-json-");
      const entryPath = writeSourceToolPluginProject({
        tmpDir,
        packageName: "openclaw-plugin-reordered-json",
        pluginId: "reordered-json",
        toolName: "reordered_json_echo",
      });
      await runPluginsBuildCommand({ root: tmpDir, entry: entryPath });

      const manifestPath = path.join(tmpDir, "openclaw.plugin.json");
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
      const configSchema = manifest.configSchema as Record<string, unknown>;
      fs.writeFileSync(
        manifestPath,
        JSON.stringify(
          {
            ...manifest,
            configSchema: {
              properties: configSchema.properties,
              additionalProperties: configSchema.additionalProperties,
              type: configSchema.type,
            },
          },
          null,
          2,
        ),
      );
      const packagePath = path.join(tmpDir, "package.json");
      const manifestBefore = fs.readFileSync(manifestPath, "utf8");
      const packageBefore = fs.readFileSync(packagePath, "utf8");
      const exit = vi.spyOn(defaultRuntime, "exit").mockImplementation((code) => {
        throw new Error(`unexpected runtime exit ${code}`);
      });
      const log = vi.spyOn(defaultRuntime, "log").mockImplementation(() => {});
      const error = vi.spyOn(defaultRuntime, "error").mockImplementation(() => {});

      try {
        if (command === "validate") {
          await runPluginsValidateCommand({ root: tmpDir, entry: entryPath });
          expect(log).toHaveBeenCalledWith("Plugin reordered-json is valid.");
        } else {
          await runPluginsBuildCommand({ root: tmpDir, entry: entryPath, check: true });
          expect(log).toHaveBeenCalledWith("Plugin metadata is up to date.");
        }
        expect(exit).not.toHaveBeenCalled();
        expect(error).not.toHaveBeenCalled();
        expect(fs.readFileSync(manifestPath, "utf8")).toBe(manifestBefore);
        expect(fs.readFileSync(packagePath, "utf8")).toBe(packageBefore);
      } finally {
        exit.mockRestore();
        log.mockRestore();
        error.mockRestore();
      }
    },
  );

  it("keeps generated contract arrays ordered", async () => {
    const tmpDir = tempDirs.make("openclaw-plugin-contract-order-");
    const entryPath = writeSourceToolPluginProject({
      tmpDir,
      packageName: "openclaw-plugin-demo-tools",
      pluginId: "demo-tools",
      toolName: "demo_echo",
      extraToolNames: ["demo_extra"],
    });
    await runPluginsBuildCommand({ root: tmpDir, entry: entryPath });
    writeProjectJson(tmpDir, "openclaw.plugin.json", {
      ...readProjectJson(tmpDir),
      contracts: { tools: ["demo_extra", "demo_echo"] },
    });

    await expectProjectValidation(tmpDir, "demo-tools", [
      "openclaw.plugin.json generated metadata is stale. Run openclaw plugins build.",
    ]);
  });

  it("projects undefined TypeBox options into the persisted manifest shape", async () => {
    const tmpDir = tempDirs.make("openclaw-plugin-undefined-schema-");
    const entryPath = writeSourceToolPluginProject({
      tmpDir,
      packageName: "openclaw-plugin-undefined-schema-options",
      pluginId: "undefined-schema-options",
      toolName: "undefined_schema_echo",
      configSchemaSource: `Type.Object(
        { value: Type.Optional(Type.String({ description: undefined })) },
        { description: undefined },
      )`,
    });
    fs.appendFileSync(
      entryPath,
      `\nimport { Type } from ${JSON.stringify(fileURLToPath(import.meta.resolve("typebox")))};\n`,
    );
    await runPluginsBuildCommand({ root: tmpDir, entry: entryPath });

    const manifest = readProjectJson(tmpDir);
    const persistedSchema = manifest.configSchema as Record<string, unknown>;
    const persistedProperties = persistedSchema.properties as Record<string, unknown>;
    expect(Object.hasOwn(persistedSchema, "description")).toBe(false);
    expect(Object.hasOwn(persistedProperties.value as object, "description")).toBe(false);
    await expectProjectValidation(tmpDir, "undefined-schema-options");
  });

  it.each([
    {
      label: "own prototype key versus different own key",
      expected: '{"__proto__":{}}',
      actual: '{"safe":{}}',
      stale: true,
    },
    {
      label: "different own key versus own prototype key",
      expected: '{"safe":{}}',
      actual: '{"__proto__":{}}',
      stale: true,
    },
    {
      label: "matching own prototype keys",
      expected: '{"__proto__":{}}',
      actual: '{"__proto__":{}}',
      stale: false,
    },
  ])("compares $label in generated schemas", async ({ expected, actual, stale }) => {
    const tmpDir = tempDirs.make("openclaw-plugin-schema-own-keys-");
    const entryPath = writeSourceToolPluginProject({
      tmpDir,
      packageName: "openclaw-plugin-demo-tools",
      pluginId: "demo-tools",
      toolName: "demo_echo",
      configSchemaSource: `{ type: "object", properties: JSON.parse(${JSON.stringify(expected)}) }`,
    });
    await runPluginsBuildCommand({ root: tmpDir, entry: entryPath });
    writeProjectJson(tmpDir, "openclaw.plugin.json", {
      ...readProjectJson(tmpDir),
      configSchema: { type: "object", properties: JSON.parse(actual) as Record<string, unknown> },
    });

    await expectProjectValidation(
      tmpDir,
      "demo-tools",
      stale
        ? ["openclaw.plugin.json generated metadata is stale. Run openclaw plugins build."]
        : [],
    );
  });

  it("still rejects a changed generated config schema", async () => {
    const tmpDir = tempDirs.make("openclaw-plugin-stale-schema-");
    const entryPath = writeSourceToolPluginProject({
      tmpDir,
      packageName: "openclaw-plugin-demo-tools",
      pluginId: "demo-tools",
      toolName: "demo_echo",
    });
    await runPluginsBuildCommand({ root: tmpDir, entry: entryPath });
    const generated = readProjectJson(tmpDir);
    writeProjectJson(tmpDir, "openclaw.plugin.json", {
      ...generated,
      configSchema: {
        ...(generated.configSchema as Record<string, unknown>),
        additionalProperties: true,
      },
    });

    await expectProjectValidation(tmpDir, "demo-tools", [
      "openclaw.plugin.json generated metadata is stale. Run openclaw plugins build.",
    ]);
  });

  it("rejects a missing generated manifest without changing package metadata", async () => {
    const tmpDir = tempDirs.make("openclaw-plugin-missing-generated-manifest-");
    const entryPath = writeSourceToolPluginProject({
      tmpDir,
      packageName: "openclaw-plugin-missing-generated-manifest",
      pluginId: "missing-generated-manifest",
      toolName: "missing_generated_manifest_echo",
    });
    const packagePath = path.join(tmpDir, "package.json");
    const packageBefore = fs.readFileSync(packagePath, "utf8");
    const exit = vi.spyOn(defaultRuntime, "exit").mockImplementation((code) => {
      throw new Error(`runtime exit ${code}`);
    });
    const error = vi.spyOn(defaultRuntime, "error").mockImplementation(() => {});

    try {
      await expect(
        runPluginsBuildCommand({ root: tmpDir, entry: entryPath, check: true }),
      ).rejects.toThrow("runtime exit 1");
      expect(error).toHaveBeenCalledWith(
        "Generated plugin metadata is out of date. Run openclaw plugins build.",
      );
      expect(fs.readFileSync(packagePath, "utf8")).toBe(packageBefore);
      expect(fs.existsSync(path.join(tmpDir, "openclaw.plugin.json"))).toBe(false);
    } finally {
      exit.mockRestore();
      error.mockRestore();
    }
  });

  it("reports stale manifest contracts", async () => {
    const tmpDir = tempDirs.make("openclaw-plugin-stale-contracts-");
    const entryPath = writeSourceToolPluginProject({
      tmpDir,
      packageName: "openclaw-plugin-demo-tools",
      pluginId: "demo-tools",
      toolName: "demo_echo",
    });
    await runPluginsBuildCommand({ root: tmpDir, entry: entryPath });
    writeProjectJson(tmpDir, "openclaw.plugin.json", {
      ...readProjectJson(tmpDir),
      configSchema: {},
      contracts: { tools: ["other_tool"] },
    });

    await expectProjectValidation(tmpDir, "demo-tools", [
      "openclaw.plugin.json generated metadata is stale. Run openclaw plugins build.",
      "openclaw.plugin.json contracts.tools is missing: demo_echo",
      "openclaw.plugin.json contracts.tools has no matching defineToolPlugin tool: other_tool",
    ]);
  });

  it("reports missing entries with an author-facing path", async () => {
    const tmpDir = tempDirs.make("openclaw-plugin-missing-");
    writeProjectJson(tmpDir, "package.json", {});

    await expect(
      runPluginsBuildCommand({ root: tmpDir, entry: "./dist/index.js" }),
    ).rejects.toThrow("plugin entry not found: ./dist/index.js");
  });

  it("throws a user-friendly error when package.json is malformed JSON", async () => {
    const tmpDir = tempDirs.make("openclaw-plugin-bad-json-");
    const packagePath = path.join(tmpDir, "package.json");
    const entryPath = writeSourceToolPluginProject({
      tmpDir,
      packageName: "openclaw-plugin-bad-json",
      pluginId: "bad-json",
      toolName: "bad_json_echo",
    });
    fs.writeFileSync(packagePath, "{invalid json");

    await expect(runPluginsBuildCommand({ root: tmpDir, entry: entryPath })).rejects.toThrow(
      `Malformed JSON in ${packagePath}`,
    );
  });

  it("loads source entries that import the OpenClaw plugin SDK package subpath", async () => {
    const tmpDir = tempDirs.make("openclaw-plugin-source-");
    const entryPath = writeSourceToolPluginProject({
      tmpDir,
      packageName: "openclaw-plugin-source-demo",
      pluginId: "source-demo",
      toolName: "source_echo",
    });

    await runPluginsBuildCommand({ root: tmpDir, entry: entryPath });
    expect(readProjectJson(tmpDir)).toMatchObject({
      id: "source-demo",
      contracts: { tools: ["source_echo"] },
    });
  });

  it("finishes a build from an absolute root after the launch directory is removed", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-plugin-deleted-cwd-build-"));
    const packagePath = path.join(tmpDir, "package.json");
    const entryPath = writeSourceToolPluginProject({
      tmpDir,
      packageName: "openclaw-plugin-deleted-cwd-build",
      pluginId: "deleted-cwd-build",
      toolName: "deleted_cwd_echo",
    });
    const originalCwd = process.cwd();
    const originalWriteFileSync = fs.writeFileSync.bind(fs);
    let cwdRemoved = false;
    const log = vi.spyOn(defaultRuntime, "log").mockImplementation(() => {});
    const cwd = vi.spyOn(process, "cwd").mockImplementation(() => {
      if (cwdRemoved) {
        throw new Error("ENOENT: no such file or directory, uv_cwd");
      }
      return originalCwd;
    });
    const writeFileSync = vi
      .spyOn(fs, "writeFileSync")
      .mockImplementation((file, data, options) => {
        originalWriteFileSync(file, data, options);
        if (file === packagePath) {
          cwdRemoved = true;
        }
      });

    try {
      await runPluginsBuildCommand({ root: tmpDir, entry: entryPath });

      expect(fs.existsSync(path.join(tmpDir, "openclaw.plugin.json"))).toBe(true);
      expect(log).toHaveBeenCalledWith(`Wrote ${path.join(tmpDir, "openclaw.plugin.json")}`);
      expect(log).toHaveBeenCalledWith(`Updated ${packagePath}`);
    } finally {
      writeFileSync.mockRestore();
      cwd.mockRestore();
      log.mockRestore();
      fs.rmSync(tmpDir, { force: true, recursive: true });
    }
  });

  it("finishes init with an absolute directory after the launch directory is removed", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-plugin-deleted-cwd-init-"));
    const projectDir = path.join(tmpDir, "demo");
    const log = vi.spyOn(defaultRuntime, "log").mockImplementation(() => {});
    const cwd = vi.spyOn(process, "cwd").mockImplementation(() => {
      throw new Error("ENOENT: no such file or directory, uv_cwd");
    });

    try {
      await runPluginsInitCommand("demo", { directory: projectDir });

      expect(fs.existsSync(path.join(projectDir, "package.json"))).toBe(true);
      expect(log).toHaveBeenCalledWith(`Created ${projectDir}`);
    } finally {
      cwd.mockRestore();
      log.mockRestore();
      fs.rmSync(tmpDir, { force: true, recursive: true });
    }
  });

  it("scaffolds a dist-entry tool plugin project", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-plugin-init-"));
    const projectDir = path.join(tmpDir, "stock-quotes");

    await runPluginsInitCommand("stock-quotes", {
      directory: projectDir,
      name: 'Stock "Quotes"',
    });

    expect(fs.readFileSync(path.join(projectDir, "src/index.ts"), "utf8")).toContain(
      'name: "Stock \\"Quotes\\""',
    );
    expect(
      JSON.parse(fs.readFileSync(path.join(projectDir, "package.json"), "utf8")),
    ).toMatchObject({
      dependencies: {
        typebox: "^1.1.38",
      },
      peerDependencies: {
        openclaw: ">=2026.5.17",
      },
      devDependencies: {
        openclaw: "latest",
        typescript: "^5.9.0",
        vitest: "^3.2.0",
      },
      scripts: {
        "plugin:build": "npm run build && openclaw plugins build --entry ./dist/index.js",
        "plugin:validate": "npm run build && openclaw plugins validate --entry ./dist/index.js",
        test: "vitest run --config ./vitest.config.ts",
      },
      openclaw: {
        extensions: ["./dist/index.js"],
        compat: {
          pluginApi: ">=2026.5.17",
        },
        build: {
          openclawVersion: VERSION,
        },
      },
    });
    expect(
      JSON.parse(fs.readFileSync(path.join(projectDir, "openclaw.plugin.json"), "utf8")),
    ).toMatchObject({
      id: "stock-quotes",
      name: 'Stock "Quotes"',
      configSchema: {
        type: "object",
        additionalProperties: false,
        properties: {},
      },
      contracts: { tools: ["echo"] },
    });
    expect(fs.readFileSync(path.join(projectDir, "src/index.test.ts"), "utf8")).toContain(
      "getToolPluginMetadata",
    );
    expect(fs.readFileSync(path.join(projectDir, "vitest.config.ts"), "utf8")).toContain(
      'include: ["src/**/*.test.ts"]',
    );
  });

  it("scaffolds a provider plugin project with ClawHub validation and release metadata", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-provider-init-"));
    const projectDir = path.join(tmpDir, "plugin-init-test");

    await runPluginsInitCommand("plugin-init-test", {
      directory: projectDir,
      name: "Plugin Init Test",
      type: "provider",
    });

    const packageManifest = JSON.parse(
      fs.readFileSync(path.join(projectDir, "package.json"), "utf8"),
    );
    expect(packageManifest).toMatchObject({
      name: "openclaw-plugin-plugin-init-test",
      scripts: {
        build: "tsc -p tsconfig.json",
        test: "vitest run --config ./vitest.config.ts",
        validate: "npm run build && clawhub package validate . --out .clawhub-validation",
      },
      peerDependencies: {
        openclaw: `>=${VERSION}`,
      },
      devDependencies: {
        clawhub: "latest",
        openclaw: "latest",
        typescript: "^5.9.0",
        vitest: "^3.2.0",
      },
      openclaw: {
        extensions: ["./dist/index.js"],
        install: {
          clawhubSpec: "clawhub:openclaw-plugin-plugin-init-test",
          defaultChoice: "clawhub",
          minHostVersion: `>=${VERSION}`,
        },
        compat: {
          pluginApi: `>=${VERSION}`,
        },
        build: {
          openclawVersion: VERSION,
        },
        release: {
          publishToClawHub: true,
        },
      },
    });
    expect(packageManifest.scripts).not.toHaveProperty("plugin:build");
    expect(packageManifest.scripts).not.toHaveProperty("plugin:validate");

    const manifest = JSON.parse(
      fs.readFileSync(path.join(projectDir, "openclaw.plugin.json"), "utf8"),
    );
    expect(manifest).toMatchObject({
      id: "plugin-init-test",
      name: "Plugin Init Test",
      version: "0.1.0",
      providers: ["plugin-init-test"],
      setup: {
        providers: [
          {
            id: "plugin-init-test",
            envVars: ["PLUGIN_INIT_TEST_API_KEY"],
          },
        ],
      },
      configSchema: {
        type: "object",
        additionalProperties: false,
        properties: {},
      },
    });

    const indexSource = fs.readFileSync(path.join(projectDir, "src/index.ts"), "utf8");
    expect(indexSource).toContain("definePluginEntry");
    expect(indexSource).toContain("api.registerProvider");
    for (const [, subpath] of indexSource.matchAll(/from "openclaw\/plugin-sdk\/([^"]+)"/g)) {
      expect(publicPluginSdkSubpaths).toContain(subpath);
    }

    expect(fs.readFileSync(path.join(projectDir, "src/index.test.ts"), "utf8")).toContain(
      "OpenClawPluginApi",
    );
    expect(fs.readFileSync(path.join(projectDir, "vitest.config.ts"), "utf8")).toContain(
      'include: ["src/**/*.test.ts"]',
    );
    const readme = fs.readFileSync(path.join(projectDir, "README.md"), "utf8");
    expect(readme).toContain("npm run validate");
    expect(readme).toContain("npm exec clawhub -- login");
    expect(readme).toContain("npm exec clawhub -- package publish .");
    expect(readme).toContain("npm exec clawhub -- package trusted-publisher set");

    const workflow = fs.readFileSync(
      path.join(projectDir, ".github/workflows/clawhub-publish.yml"),
      "utf8",
    );
    expect(workflow).not.toContain("release:");
    expect(workflow).not.toContain("secrets: inherit");
    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).toContain(
      "openclaw/clawhub/.github/workflows/package-publish.yml@9d49df109d4ad3dc8a6ecf05d26b39f46d294721",
    );
  });
});
