// Plugins authoring command tests cover plugin authoring command output and file generation.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Type } from "typebox";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { defineToolPlugin, getToolPluginMetadata } from "../plugin-sdk/tool-plugin.js";
import { defaultRuntime } from "../runtime.js";
import { VERSION } from "../version.js";
import {
  buildToolPluginManifest,
  buildToolPluginPackageManifest,
  loadToolPlugin,
  runPluginsBuildCommand,
  runPluginsInitCommand,
  validateToolPluginProject,
} from "./plugins-authoring-command.js";

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
