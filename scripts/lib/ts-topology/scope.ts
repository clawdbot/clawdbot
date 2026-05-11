import fs from "node:fs";
import path from "node:path";
import { BUNDLED_PLUGIN_PATH_PREFIX } from "../bundled-plugin-paths.mjs";
import { publicPluginSdkEntrypoints } from "../plugin-sdk-entries.mjs";
import type { ConsumerScope, PublicEntrypoint, TopologyScope, UsageBucket } from "./types.js";

function isTestFile(relPath: string): boolean {
  return (
    relPath.startsWith("test/") ||
    relPath.includes("/__tests__/") ||
    relPath.includes(".test.") ||
    relPath.includes(".spec.") ||
    relPath.includes(".e2e.") ||
    relPath.includes(".suite.") ||
    relPath.includes("test-harness") ||
    relPath.includes("test-support") ||
    relPath.includes("test-helper") ||
    relPath.includes("test-utils")
  );
}

function classifyScope(relPath: string): ConsumerScope {
  if (relPath.startsWith(BUNDLED_PLUGIN_PATH_PREFIX)) {
    return "extension";
  }
  if (relPath.startsWith("packages/")) {
    return "package";
  }
  if (relPath.startsWith("apps/")) {
    return "app";
  }
  if (relPath.startsWith("ui/")) {
    return "ui";
  }
  if (relPath.startsWith("scripts/")) {
    return "script";
  }
  if (relPath.startsWith("src/")) {
    return "src";
  }
  if (relPath.startsWith("test/")) {
    return "test";
  }
  return "other";
}

function classifyUsageBucketForRoots(internalRoots: string[], relPath: string): UsageBucket {
  if (internalRoots.some((root) => relPath === root || relPath.startsWith(`${root}/`))) {
    return "internal";
  }
  return isTestFile(relPath) ? "test" : "production";
}

function extractOwner(relPath: string): string | null {
  const scope = classifyScope(relPath);
  const parts = relPath.split("/");
  switch (scope) {
    case "extension":
      return parts[1] ? `extension:${parts[1]}` : "extension";
    case "package":
      return parts[1] ? `package:${parts[1]}` : "package";
    case "app":
      return parts[1] ? `app:${parts[1]}` : "app";
    case "src":
      return "src";
    case "ui":
      return "ui";
    case "script":
      return "scripts";
    case "other":
      return parts[0] || "other";
    case "test":
      return null;
  }
  throw new Error("Unsupported topology scope");
}

function extractExtensionId(relPath: string): string | null {
  if (!relPath.startsWith(BUNDLED_PLUGIN_PATH_PREFIX)) {
    return null;
  }
  const parts = relPath.split("/");
  return parts[1] ?? null;
}

function extractPackageOwner(relPath: string): string | null {
  const owner = extractOwner(relPath);
  return owner?.startsWith("extension:") ? null : owner;
}

function buildScopeFromEntrypoints(
  id: string,
  description: string,
  entrypoints: PublicEntrypoint[],
): TopologyScope {
  const internalRoots = [
    ...new Set(entrypoints.map((entrypoint) => path.posix.dirname(entrypoint.sourcePath))),
  ];
  const publicSpecifiers = new Set(entrypoints.map((entrypoint) => entrypoint.importSpecifier));
  return {
    id,
    description,
    entrypoints,
    importFilter(specifier: string) {
      return publicSpecifiers.has(specifier);
    },
    classifyUsageBucket(relPath: string) {
      return classifyUsageBucketForRoots(internalRoots, relPath);
    },
    classifyScope,
    ownerForPath(relPath: string) {
      return extractOwner(relPath);
    },
    extensionForPath(relPath: string) {
      return extractExtensionId(relPath);
    },
    packageOwnerForPath(relPath: string) {
      return extractPackageOwner(relPath);
    },
  };
}

export function createPluginSdkScope(_repoRoot: string): TopologyScope {
  const entrypoints = publicPluginSdkEntrypoints.map((entrypoint) => ({
    entrypoint,
    sourcePath: `src/plugin-sdk/${entrypoint}.ts`,
    importSpecifier:
      entrypoint === "index" ? "openclaw/plugin-sdk" : `openclaw/plugin-sdk/${entrypoint}`,
  }));
  return buildScopeFromEntrypoints("plugin-sdk", "OpenClaw plugin-sdk public surface", entrypoints);
}

export function createFilesystemPublicSurfaceScope(
  repoRoot: string,
  options: {
    id: string;
    description?: string;
    entrypointRoot: string;
    importPrefix: string;
  },
): TopologyScope {
  const absoluteRoot = path.join(repoRoot, options.entrypointRoot);
  const entries = fs
    .readdirSync(absoluteRoot, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
    .map((entry) => entry.name)
    .toSorted();
  const publicEntrypoints = entries.map((fileName) => {
    const entrypoint = fileName.replace(/\.ts$/, "");
    return {
      entrypoint,
      sourcePath: path.posix.join(options.entrypointRoot, fileName),
      importSpecifier:
        entrypoint === "index" ? options.importPrefix : `${options.importPrefix}/${entrypoint}`,
    };
  });
  return buildScopeFromEntrypoints(
    options.id,
    options.description ?? `Public surface rooted at ${options.entrypointRoot}`,
    publicEntrypoints,
  );
}
