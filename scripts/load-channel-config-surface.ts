// Load Channel Config Surface script supports OpenClaw repository automation.
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createJiti } from "jiti";
import { buildChannelConfigSchema } from "../src/channels/plugins/config-schema.js";
import {
  buildPluginLoaderAliasMap,
  buildPluginLoaderJitiOptions,
} from "../src/plugins/sdk-alias.js";

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

export async function loadChannelConfigSurfaceModule(
  modulePath: string,
): Promise<{ schema: Record<string, unknown>; uiHints?: Record<string, unknown> } | null> {
  const resolvedPath = path.resolve(modulePath);
  const aliasMap = buildPluginLoaderAliasMap(resolvedPath, "", undefined, "src");
  // Jiti 2.7 passes Windows drive paths raw to import(); use its source loader there.
  // Disabled caches keep generation source-current.
  const jiti = createJiti(import.meta.url, {
    ...buildPluginLoaderJitiOptions(aliasMap),
    tryNative: process.platform !== "win32",
    moduleCache: false,
    fsCache: false,
  });
  const imported = await jiti.import<Record<string, unknown>>(resolvedPath);
  return resolveConfigSchemaExport(imported);
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
