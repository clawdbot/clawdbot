// Plugin authoring commands for init/build/validate manifest generation.
import fs from "node:fs";
import path from "node:path";
import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import { formatCwdRelativePathOrAbsolute as formatOutputPath } from "../infra/safe-cwd.js";
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
import { VERSION } from "../version.js";

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
  type?: string;
};

type PluginScaffoldType = "tool" | "provider";

type LoadedToolPlugin = {
  entry: unknown;
  metadata: ToolPluginMetadata;
};

const SUPPORTED_PLUGIN_SCAFFOLD_TYPES = [
  "tool",
  "provider",
] as const satisfies readonly PluginScaffoldType[];
const CLAWHUB_PACKAGE_PUBLISH_WORKFLOW_REF = "9d49df109d4ad3dc8a6ecf05d26b39f46d294721";

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
  // Authoring validation imports the entry once and requires SDK metadata from defineToolPlugin.
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
  const existingExtensions = Array.isArray(openclaw.extensions)
    ? openclaw.extensions.filter((entry): entry is string => typeof entry === "string")
    : [];
  const extensions = uniqueStrings([...existingExtensions, params.entry]);
  return {
    ...params.packageManifest,
    openclaw: {
      ...openclaw,
      extensions,
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
  defaultRuntime.log(`Wrote ${formatOutputPath(manifestPath, PLUGIN_MANIFEST_FILENAME)}`);
  defaultRuntime.log(`Updated ${formatOutputPath(packagePath, "package.json")}`);
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

function resolveScaffoldType(input: string | undefined): PluginScaffoldType {
  const type = input ?? "tool";
  if (SUPPORTED_PLUGIN_SCAFFOLD_TYPES.includes(type as PluginScaffoldType)) {
    return type as PluginScaffoldType;
  }
  throw new Error(
    `Unsupported plugin scaffold type "${type}". Supported types: ${SUPPORTED_PLUGIN_SCAFFOLD_TYPES.join(
      ", ",
    )}.`,
  );
}

function normalizeDisplayName(input: string): string {
  const name = input.trim();
  if (!name) {
    throw new Error("Plugin display name is required.");
  }
  return name;
}

function normalizePluginId(input: string): string {
  const id = input.trim();
  if (!id) {
    throw new Error("Plugin id is required.");
  }
  return id;
}

function titleFromId(id: string): string {
  return id
    .split(/[-_]/u)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function upperSnakeFromId(id: string): string {
  return id
    .replace(/[^a-z0-9]+/giu, "_")
    .replace(/^_+|_+$/gu, "")
    .toUpperCase();
}

function lowerCamelFromId(id: string): string {
  const parts = id.split(/-+/u).filter(Boolean);
  return parts
    .map((part, index) => (index === 0 ? part : `${part.charAt(0).toUpperCase()}${part.slice(1)}`))
    .join("");
}

function createConfigSchema() {
  return {
    type: "object",
    additionalProperties: false,
    properties: {},
  };
}

function buildScaffoldTsconfig(type: PluginScaffoldType): JsonObject {
  return {
    compilerOptions: {
      target: "ES2022",
      module: "NodeNext",
      moduleResolution: "NodeNext",
      strict: true,
      declaration: type === "tool",
      outDir: "dist",
      skipLibCheck: true,
    },
    include: type === "provider" ? ["src/index.ts"] : ["src/**/*.ts"],
  };
}

function writeScaffoldVitestConfig(rootDir: string): void {
  fs.writeFileSync(
    path.join(rootDir, "vitest.config.ts"),
    `import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
`,
  );
}

function writeToolPluginScaffold(params: { rootDir: string; id: string; name: string }): void {
  const packageManifest = {
    name: `openclaw-plugin-${params.id}`,
    version: "0.1.0",
    type: "module",
    private: true,
    scripts: {
      build: "tsc -p tsconfig.json",
      "plugin:build": "npm run build && openclaw plugins build --entry ./dist/index.js",
      "plugin:validate": "npm run build && openclaw plugins validate --entry ./dist/index.js",
      test: "vitest run --config ./vitest.config.ts",
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
  const idLiteral = jsStringLiteral(params.id);
  const nameLiteral = jsStringLiteral(params.name);
  const description = `Add ${params.name} tools to OpenClaw.`;
  const descriptionLiteral = jsStringLiteral(description);
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
  const readmeSource = `# ${params.name}

Simple OpenClaw tool plugin.

## Build

\`\`\`bash
npm install
npm run plugin:build
npm run plugin:validate
npm test
\`\`\`
`;

  writeJsonFile(path.join(params.rootDir, "package.json"), packageManifest);
  fs.writeFileSync(path.join(params.rootDir, "src/index.ts"), indexSource);
  fs.writeFileSync(path.join(params.rootDir, "src/index.test.ts"), testSource);
  fs.writeFileSync(path.join(params.rootDir, "README.md"), readmeSource);
  writeJsonFile(path.join(params.rootDir, PLUGIN_MANIFEST_FILENAME), {
    id: params.id,
    name: params.name,
    description,
    version: packageManifest.version,
    configSchema: createConfigSchema(),
    activation: { onStartup: true },
    contracts: { tools: ["echo"] },
  });
}

function writeProviderPluginScaffold(params: { rootDir: string; id: string; name: string }): void {
  const packageName = `openclaw-plugin-${params.id}`;
  const envVar = `${upperSnakeFromId(params.id)}_API_KEY`;
  const optionKey = `${lowerCamelFromId(params.id)}ApiKey`;
  const flagName = `--${params.id}-api-key`;
  const defaultModelId = "example-chat";
  const defaultModelRef = `${params.id}/${defaultModelId}`;
  const description = `Add ${params.name} models to OpenClaw.`;
  const packageManifest = {
    name: packageName,
    version: "0.1.0",
    description: `OpenClaw provider plugin for ${params.name}.`,
    type: "module",
    scripts: {
      build: "tsc -p tsconfig.json",
      test: "vitest run --config ./vitest.config.ts",
      validate: "npm run build && clawhub package validate . --out .clawhub-validation",
    },
    files: ["dist", "openclaw.plugin.json", "README.md"],
    peerDependencies: {
      openclaw: `>=${VERSION}`,
    },
    peerDependenciesMeta: {
      openclaw: {
        optional: true,
      },
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
        clawhubSpec: `clawhub:${packageName}`,
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
    pluginInspector: {
      version: 1,
      plugin: {
        id: params.id,
        priority: "high",
        seams: ["plugin-runtime"],
        sourceRoot: ".",
        expect: {
          registrations: ["registerProvider"],
        },
      },
    },
  };
  const idLiteral = jsStringLiteral(params.id);
  const nameLiteral = jsStringLiteral(params.name);
  const envVarLiteral = jsStringLiteral(envVar);
  const optionKeyLiteral = jsStringLiteral(optionKey);
  const flagNameLiteral = jsStringLiteral(flagName);
  const defaultModelIdLiteral = jsStringLiteral(defaultModelId);
  const defaultModelRefLiteral = jsStringLiteral(defaultModelRef);
  const descriptionLiteral = jsStringLiteral(description);
  const apiKeyLabelLiteral = jsStringLiteral(`${params.name} API key`);
  const promptMessageLiteral = jsStringLiteral(`Enter ${params.name} API key`);
  const noteMessageLiteral = jsStringLiteral(
    `Replace https://api.example.com/v1 with your ${params.name} API base URL.`,
  );
  const indexSource = `import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createProviderApiKeyAuthMethod } from "openclaw/plugin-sdk/provider-auth-api-key";
import { buildSingleProviderApiKeyCatalog } from "openclaw/plugin-sdk/provider-catalog-shared";
import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";

const PLUGIN_ID = ${idLiteral};
const PROVIDER_ID = PLUGIN_ID;
const DEFAULT_MODEL_ID = ${defaultModelIdLiteral};
const DEFAULT_MODEL_REF = ${defaultModelRefLiteral};

function buildProvider(): ModelProviderConfig {
  return {
    api: "openai-completions",
    baseUrl: "https://api.example.com/v1",
    models: [
      {
        id: DEFAULT_MODEL_ID,
        name: "Example Chat",
        reasoning: false,
        input: ["text"],
        cost: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
        },
        contextWindow: 128000,
        maxTokens: 8192,
      },
    ],
  };
}

export default definePluginEntry({
  id: PLUGIN_ID,
  name: ${nameLiteral},
  description: ${descriptionLiteral},
  register(api) {
    api.registerProvider({
      id: PROVIDER_ID,
      label: ${nameLiteral},
      docsPath: "/providers/${params.id}",
      envVars: [${envVarLiteral}],
      auth: [
        createProviderApiKeyAuthMethod({
          providerId: PROVIDER_ID,
          methodId: "api-key",
          label: ${apiKeyLabelLiteral},
          hint: "OpenAI-compatible API endpoint",
          optionKey: ${optionKeyLiteral},
          flagName: ${flagNameLiteral},
          envVar: ${envVarLiteral},
          promptMessage: ${promptMessageLiteral},
          defaultModel: DEFAULT_MODEL_REF,
          expectedProviders: [PROVIDER_ID],
          noteTitle: ${nameLiteral},
          noteMessage: ${noteMessageLiteral},
        }),
      ],
      catalog: {
        order: "simple",
        run: (ctx) =>
          buildSingleProviderApiKeyCatalog({
            ctx,
            providerId: PROVIDER_ID,
            buildProvider,
            allowExplicitBaseUrl: true,
          }),
      },
    });
  },
});
`;
  const testSource = `import { describe, expect, it } from "vitest";
import type { OpenClawPluginApi, ProviderPlugin } from "openclaw/plugin-sdk/plugin-entry";
import entry from "./index.js";

describe(${idLiteral}, () => {
  it("registers the provider", () => {
    const providers: ProviderPlugin[] = [];
    const api = {
      registerProvider(provider: ProviderPlugin) {
        providers.push(provider);
      },
    } as Partial<OpenClawPluginApi>;

    entry.register(api as OpenClawPluginApi);

    expect(providers.map((provider) => provider.id)).toEqual([${idLiteral}]);
    expect(providers[0]?.label).toBe(${nameLiteral});
    expect(providers[0]?.envVars).toEqual([${envVarLiteral}]);
  });
});
`;
  const readmeSource = `# ${params.name}

OpenClaw provider plugin for ${params.name}.

## Commands

\`\`\`bash
npm install
npm run build
npm test
npm run validate
\`\`\`

\`npm run validate\` builds the plugin and runs \`clawhub package validate . --out .clawhub-validation\`.

## Provider Setup

The generated provider uses an OpenAI-compatible API shape, \`${envVar}\` for API-key auth, and \`https://api.example.com/v1\` as a placeholder base URL. Update \`src/index.ts\` with your provider's real base URL, model list, docs route, and credential copy before publishing.

## First Publish

Install dependencies, log in to the ClawHub CLI, then validate and publish manually once:

\`\`\`bash
npm install
npm exec clawhub -- login
npm run validate
npm exec clawhub -- package publish .
\`\`\`

That first publish creates the ClawHub package and establishes the package managers who can configure trusted publishing.

## Trusted Publishing

After the first publish, configure GitHub Actions OIDC publishing for future releases:

\`\`\`bash
npm exec clawhub -- package trusted-publisher set ${packageName} \\
  --repository <owner>/<repo> \\
  --workflow-filename clawhub-publish.yml
\`\`\`

Future release publishes can run through the manually dispatched \`.github/workflows/clawhub-publish.yml\` action without a long-lived ClawHub token. Run it first with \`dry_run=true\`, then rerun with \`dry_run=false\` after the preview is clean.
`;
  const workflowSource = `name: ClawHub Publish

on:
  workflow_dispatch:
    inputs:
      dry_run:
        description: Preview without publishing
        required: true
        type: boolean
        default: true

jobs:
  publish:
    permissions:
      actions: read
      contents: read
      id-token: write
    uses: openclaw/clawhub/.github/workflows/package-publish.yml@${CLAWHUB_PACKAGE_PUBLISH_WORKFLOW_REF}
    with:
      dry_run: \${{ inputs.dry_run }}
`;

  writeJsonFile(path.join(params.rootDir, "package.json"), packageManifest);
  fs.writeFileSync(path.join(params.rootDir, "src/index.ts"), indexSource);
  fs.writeFileSync(path.join(params.rootDir, "src/index.test.ts"), testSource);
  fs.writeFileSync(path.join(params.rootDir, "README.md"), readmeSource);
  fs.mkdirSync(path.join(params.rootDir, ".github/workflows"), { recursive: true });
  fs.writeFileSync(
    path.join(params.rootDir, ".github/workflows/clawhub-publish.yml"),
    workflowSource,
  );
  writeJsonFile(path.join(params.rootDir, PLUGIN_MANIFEST_FILENAME), {
    id: params.id,
    name: params.name,
    description,
    version: packageManifest.version,
    providers: [params.id],
    setup: {
      providers: [
        {
          id: params.id,
          envVars: [envVar],
        },
      ],
    },
    configSchema: createConfigSchema(),
    activation: { onStartup: true, providers: [params.id], capabilities: ["provider"] },
  });
}

export async function runPluginsInitCommand(
  idInput: string,
  opts: PluginsInitOptions,
): Promise<void> {
  const id = normalizePluginId(idInput);
  const name = opts.name ? normalizeDisplayName(opts.name) : titleFromId(id);
  const type = resolveScaffoldType(opts.type);
  const rootDir = path.resolve(opts.directory ?? id);
  const force = opts.force === true;
  assertCanCreate(rootDir, force);
  fs.mkdirSync(path.join(rootDir, "src"), { recursive: true });
  const tsconfig = buildScaffoldTsconfig(type);

  if (type === "provider") {
    writeProviderPluginScaffold({ rootDir, id, name });
  } else {
    writeToolPluginScaffold({ rootDir, id, name });
  }
  writeJsonFile(path.join(rootDir, "tsconfig.json"), tsconfig);
  writeScaffoldVitestConfig(rootDir);
  defaultRuntime.log(`Created ${formatOutputPath(rootDir, ".")}`);
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
