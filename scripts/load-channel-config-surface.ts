import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { createJiti } from "jiti";
import { buildChannelConfigSchema } from "../src/channels/plugins/config-schema.js";
import {
  buildPluginLoaderJitiOptions,
  resolvePluginSdkAliasFile,
  resolvePluginSdkScopedAliasMap,
} from "../src/plugins/sdk-alias.js";

type CreateJiti = typeof createJiti;

const jitiFactoryOverrideKey = Symbol.for("openclaw.channelConfigSurfaceJitiFactoryOverride");
const requireForJiti = createRequire(import.meta.url);
let createJitiLoaderFactory: CreateJiti | undefined;

function loadCreateJitiLoaderFactory(): CreateJiti {
  const override = (
    globalThis as typeof globalThis & {
      [jitiFactoryOverrideKey]?: CreateJiti;
    }
  )[jitiFactoryOverrideKey];
  if (override) {
    return override;
  }
  if (createJitiLoaderFactory) {
    return createJitiLoaderFactory;
  }
  const loaded = requireForJiti("jiti") as { createJiti?: CreateJiti };
  if (typeof loaded.createJiti !== "function") {
    throw new Error("jiti module did not export createJiti");
  }
  createJitiLoaderFactory = loaded.createJiti;
  return createJitiLoaderFactory;
}

function isBuiltChannelConfigSchema(
  value: unknown,
): value is { schema: Record<string, unknown>; uiHints?: Record<string, unknown> } {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as { schema?: unknown };
  return Boolean(candidate.schema && typeof candidate.schema === "object");
}

function resolveConfigSchemaExport(
  imported: Record<string, unknown>,
): { schema: Record<string, unknown>; uiHints?: Record<string, unknown> } | null {
  for (const [name, value] of Object.entries(imported)) {
    if (name.endsWith("ChannelConfigSchema") && isBuiltChannelConfigSchema(value)) {
      return value;
    }
  }

  for (const [name, value] of Object.entries(imported)) {
    if (!name.endsWith("ConfigSchema") || name.endsWith("AccountConfigSchema")) {
      continue;
    }
    if (isBuiltChannelConfigSchema(value)) {
      return value;
    }
    if (value && typeof value === "object") {
      return buildChannelConfigSchema(value as never);
    }
  }

  for (const value of Object.values(imported)) {
    if (isBuiltChannelConfigSchema(value)) {
      return value;
    }
  }

  return null;
}

function resolveRepoRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}

function isMissingExecutableError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  return "code" in error && error.code === "ENOENT";
}

export async function loadChannelConfigSurfaceModule(
  modulePath: string,
  options?: { repoRoot?: string },
): Promise<{ schema: Record<string, unknown>; uiHints?: Record<string, unknown> } | null> {
  const repoRoot = options?.repoRoot ?? resolveRepoRoot();
  const loaderRepoRoot = resolveRepoRoot();
  const bunBuildChannelConfigSchemaUrl = pathToFileURL(
    path.join(loaderRepoRoot, "src/channels/plugins/config-schema.ts"),
  ).href;
  const loadViaBun = (candidatePath: string) => {
    const script = `
      import { pathToFileURL } from "node:url";
      const { buildChannelConfigSchema } = await import(${JSON.stringify(bunBuildChannelConfigSchemaUrl)});
      const modulePath = process.env.OPENCLAW_CONFIG_SURFACE_MODULE;
      if (!modulePath) {
        throw new Error("missing OPENCLAW_CONFIG_SURFACE_MODULE");
      }
      const imported = await import(pathToFileURL(modulePath).href);
      const isBuilt = (value) => Boolean(
        value &&
          typeof value === "object" &&
          value.schema &&
          typeof value.schema === "object"
      );
      const resolve = (mod) => {
        for (const [name, value] of Object.entries(mod)) {
          if (name.endsWith("ChannelConfigSchema") && isBuilt(value)) return value;
        }
        for (const [name, value] of Object.entries(mod)) {
          if (!name.endsWith("ConfigSchema") || name.endsWith("AccountConfigSchema")) continue;
          if (isBuilt(value)) return value;
          if (value && typeof value === "object") return buildChannelConfigSchema(value);
        }
        for (const value of Object.values(mod)) {
          if (isBuilt(value)) return value;
        }
        return null;
      };
      process.stdout.write(JSON.stringify(resolve(imported)));
    `;
    const result = spawnSync("bun", ["-e", script], {
      cwd: repoRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        OPENCLAW_CONFIG_SURFACE_MODULE: path.resolve(candidatePath),
      },
    });
    if (result.error) {
      if (isMissingExecutableError(result.error)) {
        return null;
      }
      throw result.error;
    }
    if (result.status !== 0) {
      throw new Error(result.stderr || result.stdout || `bun loader failed for ${candidatePath}`);
    }
    return JSON.parse(result.stdout || "null") as {
      schema: Record<string, unknown>;
      uiHints?: Record<string, unknown>;
    } | null;
  };
  const loadViaJiti = (candidatePath: string) => {
    const resolvedPath = path.resolve(candidatePath);
    const pluginSdkAlias = resolvePluginSdkAliasFile({
      srcFile: "root-alias.cjs",
      distFile: "root-alias.cjs",
      modulePath: resolvedPath,
      pluginSdkResolution: "src",
    });
    const aliasMap = {
      ...(pluginSdkAlias ? { "openclaw/plugin-sdk": pluginSdkAlias } : {}),
      ...resolvePluginSdkScopedAliasMap({
        modulePath: resolvedPath,
        pluginSdkResolution: "src",
      }),
    };
    const jiti = loadCreateJitiLoaderFactory()(import.meta.url, {
      ...buildPluginLoaderJitiOptions(aliasMap),
      interopDefault: true,
      tryNative: false,
      moduleCache: false,
      fsCache: false,
    });
    return jiti(resolvedPath) as Record<string, unknown>;
  };
  const loadViaNativeImport = async (candidatePath: string) => {
    const imported = (await import(pathToFileURL(path.resolve(candidatePath)).href)) as Record<
      string,
      unknown
    >;
    return resolveConfigSchemaExport(imported);
  };
  const loadFromPath = async (
    candidatePath: string,
  ): Promise<{ schema: Record<string, unknown>; uiHints?: Record<string, unknown> } | null> => {
    try {
      const resolved = await loadViaNativeImport(candidatePath);
      if (resolved) {
        return resolved;
      }
    } catch {
      // Fall through to the compatibility loaders when the module needs custom
      // plugin SDK aliasing or cannot be imported by the current Node loader.
    }

    try {
      // Prefer the source-aware Jiti path so generated config metadata stays
      // stable before and after build output exists in the repo.
      const imported = loadViaJiti(candidatePath);
      const resolved = resolveConfigSchemaExport(imported);
      if (resolved) {
        return resolved;
      }
    } catch {
      // Fall back to Bun below when the source-aware loader cannot resolve the
      // module graph in the current environment.
    }

    const bunLoaded = loadViaBun(candidatePath);
    if (bunLoaded && isBuiltChannelConfigSchema(bunLoaded)) {
      return bunLoaded;
    }
    return null;
  };

  return loadFromPath(modulePath);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const modulePath = process.argv[2]?.trim();
  if (!modulePath) {
    process.exit(2);
  }

  const resolved = await loadChannelConfigSurfaceModule(modulePath);
  if (!resolved) {
    process.exit(3);
  }

  process.stdout.write(JSON.stringify(resolved));
  process.exit(0);
}
