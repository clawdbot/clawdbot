import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import type { TsdownPlugin } from "tsdown";
import { isRecord } from "./record-shared.mjs";

const SDK_PACKAGE = "@anthropic-ai/claude-agent-sdk";
export const CLAUDE_AGENT_SDK_ASSET_DIR = "extensions/anthropic/agent-sdk";
const NATIVE_SDK_PACKAGE =
  /^@anthropic-ai\/claude-agent-sdk-(?:(?:darwin|win32)-(?:x64|arm64)|linux-(?:x64|arm64)(?:-musl)?)$/u;

/** Preserve the official SDK package without installing its redundant native Claude executable. */
export function createClaudeAgentSdkAssetPlugin(rootDir = process.cwd()): TsdownPlugin {
  const require = createRequire(path.join(rootDir, "extensions/anthropic/package.json"));
  const sdkEntry = require.resolve(SDK_PACKAGE);
  const sdkDir = path.dirname(sdkEntry);
  const manifestPath = path.join(sdkDir, "package.json");
  const manifest: unknown = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  if (
    !isRecord(manifest) ||
    manifest.name !== SDK_PACKAGE ||
    !Array.isArray(manifest.files) ||
    !isRecord(manifest.optionalDependencies) ||
    Object.entries(manifest.optionalDependencies).some(
      ([name, version]) => !NATIVE_SDK_PACKAGE.test(name) || version !== manifest.version,
    ) ||
    (isRecord(manifest.dependencies) && Object.keys(manifest.dependencies).length > 0)
  ) {
    throw new Error(
      "Claude Agent SDK dependency layout changed; review its packaged runtime closure.",
    );
  }
  const { optionalDependencies: _nativeCli, ...packagedManifest } = manifest;
  const files: unknown[] = [
    ...new Set([...manifest.files, "package.json", "LICENSE.md", "README.md"]),
  ];
  if (
    !files.every(
      (file): file is string =>
        typeof file === "string" && file !== "." && file !== ".." && path.basename(file) === file,
    )
  ) {
    throw new Error("Claude Agent SDK asset layout changed; review its package-relative files.");
  }

  return {
    name: "openclaw:claude-agent-sdk-assets",
    resolveId: {
      // tsdown's dependency proxy forwards this.resolve(), which collapses
      // external: "relative" to true and loses chunk-relative rebasing.
      order: "pre",
      handler(id) {
        return id === SDK_PACKAGE ? { id: sdkEntry, external: "relative" } : null;
      },
    },
    outputOptions(options) {
      const previousPaths = options.paths;
      return {
        ...options,
        paths(id) {
          // An absolute external id plus this output-root path lets Rolldown rebase
          // both root hashed chunks and nested entries without relocating the SDK itself.
          if (id === sdkEntry) {
            return `./${CLAUDE_AGENT_SDK_ASSET_DIR}/${path.basename(sdkEntry)}`;
          }
          return typeof previousPaths === "function"
            ? previousPaths(id)
            : (previousPaths?.[id] ?? id);
        },
      };
    },
    generateBundle() {
      for (const file of files) {
        const sourcePath = path.join(sdkDir, file);
        this.addWatchFile(sourcePath);
        this.emitFile({
          type: "asset",
          fileName: `${CLAUDE_AGENT_SDK_ASSET_DIR}/${file}`,
          source:
            file === "package.json"
              ? `${JSON.stringify(packagedManifest, null, 2)}\n`
              : fs.readFileSync(sourcePath),
        });
      }
    },
  };
}
