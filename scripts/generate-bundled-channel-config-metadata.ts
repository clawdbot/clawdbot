#!/usr/bin/env node
// Generate Bundled Channel Config Metadata script supports OpenClaw repository automation.
import fs from "node:fs";
import path from "node:path";
import { loadBundledPluginPublicArtifactModuleSync } from "../src/plugins/public-surface-loader.js";
import { loadChannelConfigSurfaceModule } from "./load-channel-config-surface.ts";

const GENERATED_BY = "scripts/generate-bundled-channel-config-metadata.ts";
const DEFAULT_OUTPUT_PATH = "src/config/bundled-channel-config-metadata.generated.ts";
const GENERATED_JSON_CHUNK_SIZE = 16 * 1024;

type BundledPluginSource = {
  dirName: string;
  pluginDir: string;
  manifestPath: string;
  manifest: {
    id: string;
    channels?: unknown;
    name?: string;
    description?: string;
  } & Record<string, unknown>;
  packageJson?: Record<string, unknown>;
};

const { collectBundledPluginSources } = (await import(
  new URL("./lib/bundled-plugin-source-utils.mjs", import.meta.url).href
)) as {
  collectBundledPluginSources: (params?: {
    repoRoot?: string;
    requirePackageJson?: boolean;
  }) => BundledPluginSource[];
};

const { formatGeneratedModule } = (await import(
  new URL("./lib/format-generated-module.mjs", import.meta.url).href
)) as {
  formatGeneratedModule: (
    source: string,
    options: {
      repoRoot: string;
      outputPath: string;
      errorLabel: string;
    },
  ) => string;
};

const { writeGeneratedOutput } = (await import(
  new URL("./lib/generated-output-utils.mjs", import.meta.url).href
)) as {
  writeGeneratedOutput: (params: {
    repoRoot: string;
    outputPath: string;
    next: string;
    check?: boolean;
  }) => {
    changed: boolean;
    wrote: boolean;
    outputPath: string;
  };
};

type BundledChannelConfigMetadata = {
  pluginId: string;
  channelId: string;
  aliases?: readonly string[];
  order?: number;
  configurable?: boolean;
  channelEnvVars?: readonly string[];
  label?: string;
  description?: string;
  schema: Record<string, unknown>;
  uiHints?: Record<string, unknown>;
  unsupportedSecretRefSurfacePatterns?: readonly string[];
};

type BundledChannelSecuritySurface = {
  unsupportedSecretRefSurfacePatterns?: readonly string[];
};

function resolveChannelConfigSchemaModulePath(rootDir: string): string | null {
  const candidates = [
    path.join(rootDir, "src", "config-schema.ts"),
    path.join(rootDir, "src", "config-schema.js"),
    path.join(rootDir, "src", "config-schema.mts"),
    path.join(rootDir, "src", "config-schema.mjs"),
    path.join(rootDir, "src", "config-surface.ts"),
    path.join(rootDir, "src", "config-surface.js"),
    path.join(rootDir, "src", "config-surface.mts"),
    path.join(rootDir, "src", "config-surface.mjs"),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

function resolvePackageChannelMeta(source: BundledPluginSource) {
  const openclawMeta =
    source.packageJson &&
    typeof source.packageJson === "object" &&
    !Array.isArray(source.packageJson) &&
    "openclaw" in source.packageJson
      ? (source.packageJson.openclaw as Record<string, unknown> | undefined)
      : undefined;
  const channelMeta =
    openclawMeta &&
    typeof openclawMeta.channel === "object" &&
    openclawMeta.channel &&
    !Array.isArray(openclawMeta.channel)
      ? (openclawMeta.channel as Record<string, unknown>)
      : undefined;
  return channelMeta;
}

function resolveRootLabel(source: BundledPluginSource, channelId: string): string | undefined {
  const channelMeta = resolvePackageChannelMeta(source);
  if (channelMeta?.id === channelId && typeof channelMeta.label === "string") {
    return channelMeta.label.trim();
  }
  if (typeof source.manifest?.name === "string" && source.manifest.name.trim()) {
    return source.manifest.name.trim();
  }
  return undefined;
}

function resolveRootDescription(
  source: BundledPluginSource,
  channelId: string,
): string | undefined {
  const channelMeta = resolvePackageChannelMeta(source);
  if (channelMeta?.id === channelId && typeof channelMeta.blurb === "string") {
    return channelMeta.blurb.trim();
  }
  if (typeof source.manifest?.description === "string" && source.manifest.description.trim()) {
    return source.manifest.description.trim();
  }
  return undefined;
}

function resolveRootAliases(source: BundledPluginSource, channelId: string): string[] {
  const channelMeta = resolvePackageChannelMeta(source);
  if (channelMeta?.id !== channelId || !Array.isArray(channelMeta.aliases)) {
    return [];
  }
  return [
    ...new Set(
      channelMeta.aliases
        .map((alias) => (typeof alias === "string" ? alias.trim().toLowerCase() : ""))
        .filter((alias) => alias.length > 0),
    ),
  ].toSorted((left, right) => left.localeCompare(right));
}

function resolveRootOrder(source: BundledPluginSource, channelId: string): number | undefined {
  const channelMeta = resolvePackageChannelMeta(source);
  const order = channelMeta?.id === channelId ? channelMeta.order : undefined;
  return typeof order === "number" && Number.isFinite(order) ? order : undefined;
}

function resolveRootConfigurable(source: BundledPluginSource, channelId: string): boolean {
  const channelMeta = resolvePackageChannelMeta(source);
  const exposure =
    channelMeta?.id === channelId &&
    channelMeta.exposure &&
    typeof channelMeta.exposure === "object" &&
    !Array.isArray(channelMeta.exposure)
      ? (channelMeta.exposure as Record<string, unknown>)
      : null;
  return exposure?.configured !== false;
}

function resolveRootChannelEnvVars(source: BundledPluginSource, channelId: string): string[] {
  const channelMeta = resolvePackageChannelMeta(source);
  if (channelMeta?.id !== channelId) {
    return [];
  }
  const configuredState = channelMeta.configuredState;
  if (!configuredState || typeof configuredState !== "object" || Array.isArray(configuredState)) {
    return [];
  }
  const env = (configuredState as Record<string, unknown>).env;
  if (!env || typeof env !== "object" || Array.isArray(env)) {
    return [];
  }
  const envRecord = env as Record<string, unknown>;
  const values = [envRecord.allOf, envRecord.anyOf].flatMap((value) =>
    Array.isArray(value) ? value : [],
  );
  return [
    ...new Set(
      values
        .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
        .filter((entry) => entry.length > 0),
    ),
  ].toSorted((left, right) => left.localeCompare(right));
}

function formatTypeScriptModule(source: string, outputPath: string, repoRoot: string): string {
  return formatGeneratedModule(source, {
    repoRoot,
    outputPath,
    errorLabel: "bundled channel config metadata",
  });
}

function formatJsonStringChunks(value: unknown): string {
  const json = JSON.stringify(value);
  const chunks: string[] = [];
  for (let index = 0; index < json.length; index += GENERATED_JSON_CHUNK_SIZE) {
    chunks.push(JSON.stringify(json.slice(index, index + GENERATED_JSON_CHUNK_SIZE)));
  }
  return chunks.join(",\n  ");
}

function resolveChannelUnsupportedSecretRefSurfacePatterns(
  source: BundledPluginSource,
  channelId: string,
): string[] {
  try {
    const surface = loadBundledPluginPublicArtifactModuleSync<BundledChannelSecuritySurface>({
      dirName: source.dirName,
      artifactBasename: "security-contract-api.js",
    });
    const prefix = `channels.${channelId}.`;
    return [
      ...new Set(
        (surface.unsupportedSecretRefSurfacePatterns ?? []).filter(
          (pattern): pattern is string => typeof pattern === "string" && pattern.startsWith(prefix),
        ),
      ),
    ].toSorted((left, right) => left.localeCompare(right));
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.startsWith("Unable to resolve bundled plugin public surface ")
    ) {
      return [];
    }
    throw error;
  }
}

async function collectBundledChannelConfigMetadata(params?: { repoRoot?: string }) {
  const repoRoot = path.resolve(params?.repoRoot ?? process.cwd());
  const sources = collectBundledPluginSources({ repoRoot, requirePackageJson: true });
  const entries: BundledChannelConfigMetadata[] = [];

  for (const source of sources) {
    const channelIds = Array.isArray(source.manifest?.channels)
      ? source.manifest.channels.filter(
          (entry: unknown): entry is string => typeof entry === "string" && entry.trim().length > 0,
        )
      : [];
    if (channelIds.length === 0) {
      continue;
    }
    const modulePath = resolveChannelConfigSchemaModulePath(source.pluginDir);
    if (!modulePath) {
      continue;
    }
    const surface = await loadChannelConfigSurfaceModule(modulePath);
    if (!surface?.schema) {
      continue;
    }
    for (const channelId of channelIds) {
      const aliases = resolveRootAliases(source, channelId);
      const order = resolveRootOrder(source, channelId);
      const configurable = resolveRootConfigurable(source, channelId);
      const channelEnvVars = resolveRootChannelEnvVars(source, channelId);
      const label = resolveRootLabel(source, channelId);
      const description = resolveRootDescription(source, channelId);
      const unsupportedSecretRefSurfacePatterns = resolveChannelUnsupportedSecretRefSurfacePatterns(
        source,
        channelId,
      );
      entries.push({
        pluginId: source.manifest.id,
        channelId,
        ...(aliases.length > 0 ? { aliases } : {}),
        ...(order === undefined ? {} : { order }),
        ...(configurable ? {} : { configurable }),
        ...(channelEnvVars.length > 0 ? { channelEnvVars } : {}),
        ...(label ? { label } : {}),
        ...(description ? { description } : {}),
        schema: surface.schema,
        ...(Object.keys(surface.uiHints ?? {}).length > 0 ? { uiHints: surface.uiHints } : {}),
        ...(unsupportedSecretRefSurfacePatterns.length > 0
          ? { unsupportedSecretRefSurfacePatterns }
          : {}),
      });
    }
  }

  return entries.toSorted((left, right) => left.channelId.localeCompare(right.channelId));
}

async function writeBundledChannelConfigMetadataModule(params?: {
  repoRoot?: string;
  outputPath?: string;
  check?: boolean;
}) {
  const repoRoot = path.resolve(params?.repoRoot ?? process.cwd());
  const outputPath = params?.outputPath ?? DEFAULT_OUTPUT_PATH;
  const entries = await collectBundledChannelConfigMetadata({ repoRoot });
  const chunks = formatJsonStringChunks(entries);
  const next = formatTypeScriptModule(
    `// Auto-generated by ${GENERATED_BY}. Do not edit directly.

type BundledChannelConfigMetadata = {
  pluginId: string;
  channelId: string;
  aliases?: readonly string[];
  order?: number;
  configurable?: boolean;
  channelEnvVars?: readonly string[];
  label?: string;
  description?: string;
  schema: Record<string, unknown>;
  uiHints?: Record<string, unknown>;
  unsupportedSecretRefSurfacePatterns?: readonly string[];
};

const RAW_BUNDLED_CHANNEL_CONFIG_METADATA = [
  ${chunks},
].join("");

export const GENERATED_BUNDLED_CHANNEL_CONFIG_METADATA = JSON.parse(
  RAW_BUNDLED_CHANNEL_CONFIG_METADATA,
) as readonly BundledChannelConfigMetadata[];
`,
    outputPath,
    repoRoot,
  );
  return writeGeneratedOutput({
    repoRoot,
    outputPath,
    next,
    check: params?.check,
  });
}

if (import.meta.url === new URL(process.argv[1] ?? "", "file://").href) {
  const check = process.argv.includes("--check");
  const result = await writeBundledChannelConfigMetadataModule({ check });
  if (!result.changed) {
    process.exitCode = 0;
  } else if (check) {
    console.error(
      `[bundled-channel-config-metadata] stale generated output at ${path.relative(process.cwd(), result.outputPath)}`,
    );
    process.exitCode = 1;
  } else {
    console.log(
      `[bundled-channel-config-metadata] wrote ${path.relative(process.cwd(), result.outputPath)}`,
    );
  }
}
