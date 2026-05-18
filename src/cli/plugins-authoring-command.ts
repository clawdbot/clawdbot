import fs from "node:fs";
import path from "node:path";
import { getToolPluginMetadata, type ToolPluginMetadata } from "../plugin-sdk/tool-plugin.js";
import {
  loadPluginManifest,
  PLUGIN_MANIFEST_FILENAME,
  resolvePackageExtensionEntries,
} from "../plugins/manifest.js";
import { unwrapDefaultModuleExport } from "../plugins/module-export.js";
import {
  createPluginModuleLoaderCache,
  getCachedPluginModuleLoader,
} from "../plugins/plugin-module-loader-cache.js";
import { buildPluginLoaderAliasMap } from "../plugins/sdk-alias.js";
import { defaultRuntime } from "../runtime.js";
import { toSafeImportPath } from "../shared/import-specifier.js";
import { isRecord } from "../utils.js";

type JsonObject = Record<string, unknown>;

export type PluginsBuildOptions = {
  root?: string;
  entry?: string;
  check?: boolean;
};

export type PluginsValidateOptions = {
  root?: string;
  entry?: string;
};

export type PluginsInitOptions = {
  directory?: string;
  force?: boolean;
  name?: string;
};

type LoadedToolPlugin = {
  entry: unknown;
  metadata: ToolPluginMetadata;
};

const toolPluginEntryModuleLoaders = createPluginModuleLoaderCache();

function readJsonFile(filePath: string): JsonObject {
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as JsonObject;
}

function writeJsonFile(filePath: string, value: unknown): void {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function jsStringLiteral(value: string): string {
  return JSON.stringify(value);
}

function normalizeRelativePath(rootDir: string, targetPath: string): string {
  const relative = path
    .relative(rootDir, path.resolve(rootDir, targetPath))
    .replaceAll(path.sep, "/");
  if (relative === ".." || relative.startsWith("../")) {
    throw new Error(`entry must stay inside plugin root: ${targetPath}`);
  }
  return relative.startsWith(".") ? relative : `./${relative}`;
}

function resolveRootDir(input: string | undefined): string {
  return path.resolve(input ?? process.cwd());
}

function resolveEntryPath(rootDir: string, entry: string | undefined): string {
  if (entry) {
    return path.resolve(rootDir, entry);
  }
  const packagePath = path.join(rootDir, "package.json");
  if (fs.existsSync(packagePath)) {
    const extensionResolution = resolvePackageExtensionEntries(readJsonFile(packagePath));
    if (extensionResolution.status === "ok" && extensionResolution.entries[0]) {
      return path.resolve(rootDir, extensionResolution.entries[0]);
    }
  }
  return path.resolve(rootDir, "src/index.ts");
}

function readPackageManifest(rootDir: string): JsonObject {
  const packagePath = path.join(rootDir, "package.json");
  if (!fs.existsSync(packagePath)) {
    throw new Error(`package.json not found: ${packagePath}`);
  }
  return readJsonFile(packagePath);
}

async function importToolPluginEntry(entryPath: string): Promise<unknown> {
  const loader = getCachedPluginModuleLoader({
    cache: toolPluginEntryModuleLoaders,
    modulePath: entryPath,
    importerUrl: import.meta.url,
    loaderFilename: entryPath,
    aliasMap: buildPluginLoaderAliasMap(entryPath, process.argv[1], import.meta.url),
  });
  const loaded = loader(toSafeImportPath(entryPath));
  const mod =
    loaded && typeof loaded === "object"
      ? (loaded as { default?: unknown; createEntry?: unknown; entry?: unknown })
      : undefined;
  const candidate = unwrapDefaultModuleExport(
    mod?.default ?? mod?.createEntry ?? mod?.entry ?? loaded,
  );
  return typeof candidate === "function" ? (candidate as () => unknown)() : candidate;
}

export async function loadToolPlugin(params: {
  rootDir: string;
  entryPath: string;
}): Promise<LoadedToolPlugin> {
  if (!fs.existsSync(params.entryPath)) {
    throw new Error(
      `plugin entry not found: ${normalizeRelativePath(params.rootDir, params.entryPath)}`,
    );
  }
  const entry = await importToolPluginEntry(params.entryPath);
  const metadata = getToolPluginMetadata(entry);
  if (!metadata) {
    throw new Error(
      `plugin entry does not expose defineToolPlugin metadata: ${normalizeRelativePath(
        params.rootDir,
        params.entryPath,
      )}`,
    );
  }
  return { entry, metadata };
}

export function buildToolPluginManifest(params: {
  metadata: ToolPluginMetadata;
  packageManifest: JsonObject;
  existingManifest?: JsonObject;
}): JsonObject {
  const toolMetadata = buildToolPluginToolMetadata(params.metadata, params.existingManifest);
  const existingContracts = isRecord(params.existingManifest?.contracts)
    ? params.existingManifest.contracts
    : {};
  const {
    contracts: _existingContracts,
    toolMetadata: _existingToolMetadata,
    ...existingManifestFields
  } = params.existingManifest ?? {};
  return {
    ...existingManifestFields,
    id: params.metadata.id,
    name: params.metadata.name,
    description: params.metadata.description,
    version:
      typeof params.packageManifest.version === "string" ? params.packageManifest.version : "0.0.0",
    configSchema: params.metadata.configSchema,
    activation: params.metadata.activation,
    contracts: {
      ...existingContracts,
      tools: params.metadata.tools.map((tool) => tool.name),
    },
    ...(toolMetadata ? { toolMetadata } : {}),
  };
}

function buildToolPluginToolMetadata(
  metadata: ToolPluginMetadata,
  existingManifest: JsonObject | undefined,
): Record<string, unknown> | undefined {
  const existingToolMetadata = isRecord(existingManifest?.toolMetadata)
    ? existingManifest.toolMetadata
    : {};
  const nextEntries = metadata.tools
    .map((tool) => {
      const existingValue = existingToolMetadata[tool.name];
      const existing = isRecord(existingValue) ? { ...existingValue } : {};
      if (tool.optional) {
        existing.optional = true;
      } else {
        delete existing.optional;
      }
      return [tool.name, existing] as const;
    })
    .filter(([, value]) => Object.keys(value).length > 0);
  return nextEntries.length > 0 ? Object.fromEntries(nextEntries) : undefined;
}

export function buildToolPluginPackageManifest(params: {
  packageManifest: JsonObject;
  entry: string;
}): JsonObject {
  const openclaw =
    params.packageManifest.openclaw &&
    typeof params.packageManifest.openclaw === "object" &&
    !Array.isArray(params.packageManifest.openclaw)
      ? { ...(params.packageManifest.openclaw as JsonObject) }
      : {};
  return {
    ...params.packageManifest,
    openclaw: {
      ...openclaw,
      extensions: [params.entry],
    },
  };
}

export function validateToolPluginProject(params: {
  metadata: ToolPluginMetadata;
  manifest: JsonObject;
  packageManifest: JsonObject;
  entry: string;
}): string[] {
  const errors: string[] = [];
  const expectedManifest = buildToolPluginManifest({
    metadata: params.metadata,
    packageManifest: params.packageManifest,
    existingManifest: params.manifest,
  });
  if (JSON.stringify(params.manifest) !== JSON.stringify(expectedManifest)) {
    errors.push("openclaw.plugin.json generated metadata is stale. Run openclaw plugins build.");
  }
  if (params.manifest.id !== params.metadata.id) {
    errors.push(
      `openclaw.plugin.json id (${String(params.manifest.id)}) must match entry id (${params.metadata.id})`,
    );
  }
  if (!params.manifest.configSchema || typeof params.manifest.configSchema !== "object") {
    errors.push("openclaw.plugin.json must include object configSchema");
  }
  const manifestContracts = params.manifest.contracts as { tools?: unknown } | undefined;
  const manifestTools = Array.isArray(manifestContracts?.tools)
    ? manifestContracts.tools.filter((tool): tool is string => typeof tool === "string")
    : [];
  const metadataTools = params.metadata.tools.map((tool) => tool.name);
  const missing = metadataTools.filter((tool) => !manifestTools.includes(tool));
  const extra = manifestTools.filter((tool) => !metadataTools.includes(tool));
  if (missing.length > 0) {
    errors.push(`openclaw.plugin.json contracts.tools is missing: ${missing.join(", ")}`);
  }
  if (extra.length > 0) {
    errors.push(
      `openclaw.plugin.json contracts.tools has no matching defineToolPlugin tool: ${extra.join(
        ", ",
      )}`,
    );
  }
  const extensionResolution = resolvePackageExtensionEntries(params.packageManifest);
  if (extensionResolution.status !== "ok") {
    errors.push(
      extensionResolution.status === "missing" || extensionResolution.status === "empty"
        ? "package.json must include openclaw.extensions"
        : extensionResolution.error,
    );
  } else if (!extensionResolution.entries.includes(params.entry)) {
    errors.push(`package.json openclaw.extensions must include ${params.entry}`);
  }
  return errors;
}

export async function runPluginsBuildCommand(opts: PluginsBuildOptions): Promise<void> {
  const rootDir = resolveRootDir(opts.root);
  const entryPath = resolveEntryPath(rootDir, opts.entry);
  const entryRelative = normalizeRelativePath(rootDir, entryPath);
  const packagePath = path.join(rootDir, "package.json");
  const packageManifest = readPackageManifest(rootDir);
  const { metadata } = await loadToolPlugin({ rootDir, entryPath });
  const manifestPath = path.join(rootDir, PLUGIN_MANIFEST_FILENAME);
  const currentManifest = fs.existsSync(manifestPath) ? readJsonFile(manifestPath) : undefined;
  const manifest = buildToolPluginManifest({
    metadata,
    packageManifest,
    existingManifest: currentManifest,
  });
  const nextPackageManifest = buildToolPluginPackageManifest({
    packageManifest,
    entry: entryRelative,
  });

  if (opts.check) {
    const currentPackage = readJsonFile(packagePath);
    if (
      JSON.stringify(currentManifest) !== JSON.stringify(manifest) ||
      JSON.stringify(currentPackage) !== JSON.stringify(nextPackageManifest)
    ) {
      defaultRuntime.error("Generated plugin metadata is out of date. Run openclaw plugins build.");
      return defaultRuntime.exit(1);
    }
    defaultRuntime.log("Plugin metadata is up to date.");
    return;
  }

  writeJsonFile(manifestPath, manifest);
  writeJsonFile(packagePath, nextPackageManifest);
  defaultRuntime.log(
    `Wrote ${path.relative(process.cwd(), manifestPath) || PLUGIN_MANIFEST_FILENAME}`,
  );
  defaultRuntime.log(`Updated ${path.relative(process.cwd(), packagePath) || "package.json"}`);
}

export async function runPluginsValidateCommand(opts: PluginsValidateOptions): Promise<void> {
  const rootDir = resolveRootDir(opts.root);
  const entryPath = resolveEntryPath(rootDir, opts.entry);
  const entryRelative = normalizeRelativePath(rootDir, entryPath);
  const packageManifest = readPackageManifest(rootDir);
  const manifestResult = loadPluginManifest(rootDir, false);
  if (!manifestResult.ok) {
    defaultRuntime.error(manifestResult.error);
    return defaultRuntime.exit(1);
  }
  const manifest = readJsonFile(path.join(rootDir, PLUGIN_MANIFEST_FILENAME));
  const { metadata } = await loadToolPlugin({ rootDir, entryPath });
  const errors = validateToolPluginProject({
    metadata,
    manifest,
    packageManifest,
    entry: entryRelative,
  });
  if (errors.length > 0) {
    for (const error of errors) {
      defaultRuntime.error(error);
    }
    return defaultRuntime.exit(1);
  }
  defaultRuntime.log(`Plugin ${metadata.id} is valid.`);
}

function assertCanCreate(filePath: string, force: boolean): void {
  if (!force && fs.existsSync(filePath)) {
    throw new Error(`Refusing to overwrite existing path: ${filePath}`);
  }
}

function titleFromId(id: string): string {
  return id
    .split(/[-_]/u)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export async function runPluginsInitCommand(id: string, opts: PluginsInitOptions): Promise<void> {
  const rootDir = path.resolve(opts.directory ?? id);
  const force = opts.force === true;
  const name = opts.name ?? titleFromId(id);
  assertCanCreate(rootDir, force);
  fs.mkdirSync(path.join(rootDir, "src"), { recursive: true });

  const packageManifest = {
    name: `openclaw-plugin-${id}`,
    version: "0.1.0",
    type: "module",
    private: true,
    scripts: {
      build: "tsc -p tsconfig.json",
      "plugin:build": "npm run build && openclaw plugins build --entry ./dist/index.js",
      "plugin:validate": "npm run build && openclaw plugins validate --entry ./dist/index.js",
      test: "vitest run",
    },
    files: ["dist", "openclaw.plugin.json", "README.md"],
    peerDependencies: {
      openclaw: ">=2026.5.17",
    },
    dependencies: {
      typebox: "^1.1.38",
    },
    devDependencies: {
      openclaw: "latest",
      typescript: "^5.9.0",
      vitest: "^3.2.0",
    },
    openclaw: {
      extensions: ["./dist/index.js"],
    },
  };
  const idLiteral = jsStringLiteral(id);
  const nameLiteral = jsStringLiteral(name);
  const descriptionLiteral = jsStringLiteral(`Add ${name} tools to OpenClaw.`);
  const indexSource = `import { Type } from "typebox";
import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";

export default defineToolPlugin({
  id: ${idLiteral},
  name: ${nameLiteral},
  description: ${descriptionLiteral},
  tools: (tool) => [
    tool({
      name: "echo",
      description: "Echo input text.",
      parameters: Type.Object({
        input: Type.String({ description: "Text to echo." }),
      }),
      execute: async ({ input }) => ({ input }),
    }),
  ],
});
`;
  const testSource = `import { describe, expect, it } from "vitest";
import entry from "./index.js";
import { getToolPluginMetadata } from "openclaw/plugin-sdk/tool-plugin";

describe(${idLiteral}, () => {
  it("declares tool metadata", () => {
    expect(getToolPluginMetadata(entry)?.tools.map((tool) => tool.name)).toEqual(["echo"]);
  });
});
`;
  const readmeSource = `# ${name}

Simple OpenClaw tool plugin.

## Build

\`\`\`bash
npm install
npm run plugin:build
npm run plugin:validate
npm test
\`\`\`
`;
  const tsconfig = {
    compilerOptions: {
      target: "ES2022",
      module: "NodeNext",
      moduleResolution: "NodeNext",
      strict: true,
      declaration: true,
      outDir: "dist",
      skipLibCheck: true,
    },
    include: ["src/**/*.ts"],
  };

  writeJsonFile(path.join(rootDir, "package.json"), packageManifest);
  fs.writeFileSync(path.join(rootDir, "src/index.ts"), indexSource);
  fs.writeFileSync(path.join(rootDir, "src/index.test.ts"), testSource);
  fs.writeFileSync(path.join(rootDir, "README.md"), readmeSource);
  writeJsonFile(path.join(rootDir, "tsconfig.json"), tsconfig);
  writeJsonFile(path.join(rootDir, PLUGIN_MANIFEST_FILENAME), {
    id,
    name,
    description: `Add ${name} tools to OpenClaw.`,
    version: packageManifest.version,
    configSchema: {
      type: "object",
      additionalProperties: false,
      properties: {},
    },
    activation: { onStartup: true },
    contracts: { tools: ["echo"] },
  });
  defaultRuntime.log(`Created ${path.relative(process.cwd(), rootDir) || "."}`);
}
