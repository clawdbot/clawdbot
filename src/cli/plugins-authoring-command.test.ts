// Plugins authoring command tests cover plugin authoring command output and file generation.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { Type } from "typebox";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { defineToolPlugin, getToolPluginMetadata } from "../plugin-sdk/tool-plugin.js";
import { defaultRuntime } from "../runtime.js";
import { withEnvAsync } from "../test-utils/env.js";
import { VERSION } from "../version.js";
import {
  buildToolPluginManifest,
  buildToolPluginPackageManifest,
  loadToolPlugin,
  runPluginsBuildCommand,
  runPluginsInitCommand,
  runPluginsValidateCommand,
  validateToolPluginProject,
} from "./plugins-authoring-command.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function createDemoMetadata() {
  const entry = defineToolPlugin({
    id: "demo-tools",
    name: "Demo Tools",
    description: "Demo tool plugin.",
    tools: (tool) => [
      tool({
        name: "demo_echo",
        description: "Echo input.",
        parameters: Type.Object({ input: Type.String() }),
        execute: ({ input }) => ({ input }),
      }),
    ],
  });
  const metadata = getToolPluginMetadata(entry);
  if (!metadata) {
    throw new Error("missing metadata");
  }
  return metadata;
}

function createOptionalDemoMetadata() {
  const entry = defineToolPlugin({
    id: "optional-demo-tools",
    name: "Optional Demo Tools",
    description: "Optional demo tool plugin.",
    tools: (tool) => [
      tool({
        name: "demo_optional_echo",
        description: "Echo input.",
        parameters: Type.Object({ input: Type.String() }),
        optional: true,
        execute: ({ input }) => ({ input }),
      }),
    ],
  });
  const metadata = getToolPluginMetadata(entry);
  if (!metadata) {
    throw new Error("missing metadata");
  }
  return metadata;
}

function writeSourceToolPluginProject(params: {
  tmpDir: string;
  packageName: string;
  pluginId: string;
  toolName: string;
}): string {
  const sourceDir = path.join(params.tmpDir, "src");
  fs.mkdirSync(sourceDir, { recursive: true });
  fs.writeFileSync(
    path.join(params.tmpDir, "package.json"),
    JSON.stringify(
      {
        name: params.packageName,
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
  tools: (tool) => [
    tool({
      name: ${JSON.stringify(params.toolName)},
      description: "Echo input.",
      parameters: { type: "object", additionalProperties: false, properties: {} },
      execute: async () => ({ ok: true }),
    }),
  ],
});
`,
  );
  return entryPath;
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
      await loadToolPlugin({ rootDir: tmpDir, entryPath });
    } finally {
      fs.rmSync(tmpDir, { force: true, recursive: true });
    }
  });

  it("generates manifest metadata from defineToolPlugin metadata", () => {
    const metadata = createDemoMetadata();

    expect(buildToolPluginManifest({ metadata, packageManifest: { version: "1.2.3" } })).toEqual({
      id: "demo-tools",
      name: "Demo Tools",
      description: "Demo tool plugin.",
      version: "1.2.3",
      configSchema: {
        type: "object",
        additionalProperties: false,
        properties: {},
      },
      activation: { onStartup: true },
      contracts: { tools: ["demo_echo"] },
    });
  });

  it("generates optional tool metadata for optional tool plugins", () => {
    const metadata = createOptionalDemoMetadata();

    expect(buildToolPluginManifest({ metadata, packageManifest: { version: "1.2.3" } })).toEqual({
      id: "optional-demo-tools",
      name: "Optional Demo Tools",
      description: "Optional demo tool plugin.",
      version: "1.2.3",
      configSchema: {
        type: "object",
        additionalProperties: false,
        properties: {},
      },
      activation: { onStartup: true },
      contracts: { tools: ["demo_optional_echo"] },
      toolMetadata: {
        demo_optional_echo: { optional: true },
      },
    });
  });

  it("preserves manifest-owned metadata while updating generated fields", () => {
    const metadata = createOptionalDemoMetadata();
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

    const manifest = buildToolPluginManifest({
      metadata,
      packageManifest: { version: "1.2.3" },
      existingManifest,
    });

    expect(manifest).toMatchObject({
      id: "optional-demo-tools",
      name: "Optional Demo Tools",
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
    expect(
      validateToolPluginProject({
        metadata,
        entry: "./src/index.ts",
        manifest,
        packageManifest: { version: "1.2.3", openclaw: { extensions: ["./src/index.ts"] } },
      }),
    ).toEqual([]);
  });

  it("drops stale manifest-owned tool metadata when no generated metadata remains", () => {
    const metadata = createDemoMetadata();
    const packageManifest = { version: "1.2.3", openclaw: { extensions: ["./src/index.ts"] } };
    const manifest = buildToolPluginManifest({
      metadata,
      packageManifest,
      existingManifest: {
        id: "demo-tools",
        name: "Demo Tools",
        toolMetadata: {
          stale_tool: { optional: true },
        },
      },
    });

    expect(manifest.toolMetadata).toBeUndefined();
    expect(
      validateToolPluginProject({
        metadata,
        entry: "./src/index.ts",
        manifest,
        packageManifest,
      }),
    ).toEqual([]);
  });

  it("aligns package metadata with the selected runtime extension entry", () => {
    expect(
      buildToolPluginPackageManifest({
        packageManifest: {
          name: "demo",
          openclaw: { setupEntry: "./setup.ts", extensions: ["./src/other.ts"] },
        },
        entry: "./src/index.ts",
      }),
    ).toEqual({
      name: "demo",
      openclaw: {
        setupEntry: "./setup.ts",
        extensions: ["./src/other.ts", "./src/index.ts"],
      },
    });
  });

  it("validates manifest tools and package entry metadata", () => {
    const metadata = createDemoMetadata();
    const packageManifest = { version: "1.2.3", openclaw: { extensions: ["./src/index.ts"] } };

    expect(
      validateToolPluginProject({
        metadata,
        entry: "./src/index.ts",
        manifest: buildToolPluginManifest({ metadata, packageManifest }),
        packageManifest,
      }),
    ).toEqual([]);
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

  it("keeps generated contract arrays ordered", () => {
    const metadata = createDemoMetadata();
    const extraTool = {
      ...expectDefined(metadata.tools[0], "demo tool metadata"),
      name: "demo_extra",
    };
    const metadataWithTools = { ...metadata, tools: [...metadata.tools, extraTool] };
    const packageManifest = { version: "1.2.3", openclaw: { extensions: ["./src/index.ts"] } };
    const generated = buildToolPluginManifest({ metadata: metadataWithTools, packageManifest });
    const manifest = {
      ...generated,
      contracts: { tools: ["demo_extra", "demo_echo"] },
    };

    expect(
      validateToolPluginProject({
        metadata: metadataWithTools,
        entry: "./src/index.ts",
        manifest,
        packageManifest,
      }),
    ).toEqual(["openclaw.plugin.json generated metadata is stale. Run openclaw plugins build."]);
  });

  it("projects undefined TypeBox options into the persisted manifest shape", () => {
    const entry = defineToolPlugin({
      id: "undefined-schema-options",
      name: "Undefined Schema Options",
      description: "Plugin with optional TypeBox schema metadata.",
      configSchema: Type.Object(
        { value: Type.Optional(Type.String({ description: undefined })) },
        { description: undefined },
      ),
      tools: (tool) => [
        tool({
          name: "undefined_schema_echo",
          description: "Echo input.",
          parameters: Type.Object({ input: Type.String() }),
          execute: ({ input }) => ({ input }),
        }),
      ],
    });
    const metadata = getToolPluginMetadata(entry);
    if (!metadata) {
      throw new Error("missing metadata");
    }
    const runtimeSchema = metadata.configSchema;
    const runtimeProperties = runtimeSchema.properties as Record<string, unknown>;
    expect(Object.hasOwn(runtimeSchema, "description")).toBe(true);
    expect(Object.hasOwn(runtimeProperties.value as object, "description")).toBe(true);

    const packageManifest = { version: "1.2.3", openclaw: { extensions: ["./src/index.ts"] } };
    const manifest = buildToolPluginManifest({ metadata, packageManifest });
    const persistedSchema = manifest.configSchema as Record<string, unknown>;
    const persistedProperties = persistedSchema.properties as Record<string, unknown>;
    expect(Object.hasOwn(persistedSchema, "description")).toBe(false);
    expect(Object.hasOwn(persistedProperties.value as object, "description")).toBe(false);
    expect(
      validateToolPluginProject({
        metadata,
        entry: "./src/index.ts",
        manifest,
        packageManifest,
      }),
    ).toEqual([]);
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
  ])("compares $label in generated schemas", ({ expected, actual, stale }) => {
    const metadata = createDemoMetadata();
    const packageManifest = { version: "1.2.3", openclaw: { extensions: ["./src/index.ts"] } };
    const metadataWithSchema = {
      ...metadata,
      configSchema: { type: "object", properties: JSON.parse(expected) as Record<string, unknown> },
    };
    const generated = buildToolPluginManifest({ metadata: metadataWithSchema, packageManifest });
    const manifest = {
      ...generated,
      configSchema: { type: "object", properties: JSON.parse(actual) as Record<string, unknown> },
    };

    expect(
      validateToolPluginProject({
        metadata: metadataWithSchema,
        entry: "./src/index.ts",
        manifest,
        packageManifest,
      }),
    ).toEqual(
      stale
        ? ["openclaw.plugin.json generated metadata is stale. Run openclaw plugins build."]
        : [],
    );
  });

  it("still rejects a changed generated config schema", () => {
    const metadata = createDemoMetadata();
    const packageManifest = { version: "1.2.3", openclaw: { extensions: ["./src/index.ts"] } };
    const generated = buildToolPluginManifest({ metadata, packageManifest });
    const manifest = {
      ...generated,
      configSchema: {
        ...(generated.configSchema as Record<string, unknown>),
        additionalProperties: true,
      },
    };

    expect(
      validateToolPluginProject({
        metadata,
        entry: "./src/index.ts",
        manifest,
        packageManifest,
      }),
    ).toEqual(["openclaw.plugin.json generated metadata is stale. Run openclaw plugins build."]);
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

  it("reports stale manifest contracts", () => {
    const metadata = createDemoMetadata();

    expect(
      validateToolPluginProject({
        metadata,
        entry: "./src/index.ts",
        manifest: {
          id: "demo-tools",
          configSchema: {},
          contracts: { tools: ["other_tool"] },
        },
        packageManifest: { openclaw: { extensions: ["./src/index.ts"] } },
      }),
    ).toEqual([
      "openclaw.plugin.json generated metadata is stale. Run openclaw plugins build.",
      "openclaw.plugin.json contracts.tools is missing: demo_echo",
      "openclaw.plugin.json contracts.tools has no matching defineToolPlugin tool: other_tool",
    ]);
  });

  it("reports missing entries with an author-facing path", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-plugin-missing-"));

    await expect(
      loadToolPlugin({ rootDir: tmpDir, entryPath: path.join(tmpDir, "dist/index.js") }),
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
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-plugin-source-"));
    const entryPath = writeSourceToolPluginProject({
      tmpDir,
      packageName: "openclaw-plugin-source-demo",
      pluginId: "source-demo",
      toolName: "source_echo",
    });

    const loaded = await loadToolPlugin({
      rootDir: tmpDir,
      entryPath,
    });

    expect(loaded.metadata.id).toBe("source-demo");
    expect(loaded.metadata.tools.map((tool) => tool.name)).toEqual(["source_echo"]);
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
    expect(indexSource).toContain("buildSingleProviderApiKeyCatalog");

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
