// Memory Wiki plugin module implements unsafe local behavior.
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { runTasksWithConcurrency } from "openclaw/plugin-sdk/concurrency-runtime";
import { isPathInside } from "openclaw/plugin-sdk/file-access-runtime";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import { walkMemoryWikiDirectory } from "./bounded-walk.js";
import type { BridgeMemoryWikiResult } from "./bridge.js";
import type { ResolvedMemoryWikiConfig } from "./config.js";
import { appendMemoryWikiLog } from "./log.js";
import { renderMarkdownFence, renderWikiMarkdown } from "./markdown.js";
import { writeImportedSourcePage } from "./source-page-shared.js";
import { resolveUnsafeLocalPagePath } from "./source-path-shared.js";
import {
  assertMemoryWikiSourceSyncStateCapacity,
  pruneImportedSourceEntries,
  readMemoryWikiSourceSyncState,
  scopeImportedSourceSyncKey,
  writeMemoryWikiSourceSyncState,
} from "./source-sync-state.js";
import { initializeMemoryWikiVault } from "./vault.js";

type UnsafeLocalArtifact = {
  syncKey: string;
  configuredPath: string;
  absolutePath: string;
  relativePath: string;
};

type UnsafeLocalArtifactCollection = {
  artifacts: UnsafeLocalArtifact[];
  unavailableConfiguredPaths: string[];
};

const DIRECTORY_TEXT_EXTENSIONS = new Set([".json", ".jsonl", ".md", ".txt", ".yaml", ".yml"]);
const UNSAFE_LOCAL_SYNC_CONCURRENCY = 16;

function detectFenceLanguage(filePath: string): string {
  const ext = normalizeLowercaseStringOrEmpty(path.extname(filePath));
  if (ext === ".json" || ext === ".jsonl") {
    return "json";
  }
  if (ext === ".yaml" || ext === ".yml") {
    return "yaml";
  }
  if (ext === ".txt") {
    return "text";
  }
  return "markdown";
}

async function listAllowedFilesRecursive(rootDir: string): Promise<string[]> {
  const entries = await walkMemoryWikiDirectory(rootDir, "", {
    entryFilter: (entry) =>
      entry.kind === "directory" ||
      (entry.kind === "file" &&
        DIRECTORY_TEXT_EXTENSIONS.has(
          normalizeLowercaseStringOrEmpty(path.extname(entry.relativePath)),
        ))
        ? "include"
        : "skip",
  });
  return entries
    .filter((entry) => entry.kind === "file")
    .map((entry) => path.join(rootDir, entry.relativePath))
    .toSorted((left, right) => left.localeCompare(right));
}

async function collectUnsafeLocalArtifacts(
  configuredPaths: string[],
): Promise<UnsafeLocalArtifactCollection> {
  const artifacts: UnsafeLocalArtifact[] = [];
  const unavailableConfiguredPaths: string[] = [];
  for (const configuredPath of configuredPaths) {
    const absoluteConfiguredPath = path.resolve(configuredPath);
    const scopedArtifacts: UnsafeLocalArtifact[] = [];
    try {
      const stat = await fs.stat(absoluteConfiguredPath);
      if (stat.isDirectory()) {
        const files = await listAllowedFilesRecursive(absoluteConfiguredPath);
        for (const absolutePath of files) {
          scopedArtifacts.push({
            // The binding mirrors page identity (configured root + raw source
            // path) so every generated page keeps exactly one ownership row.
            syncKey: scopeImportedSourceSyncKey(
              "unsafe-local",
              `${absoluteConfiguredPath}\0${absolutePath}`,
            ),
            configuredPath: absoluteConfiguredPath,
            absolutePath,
            relativePath: path.relative(absoluteConfiguredPath, absolutePath).replace(/\\/g, "/"),
          });
        }
      } else if (stat.isFile()) {
        scopedArtifacts.push({
          syncKey: scopeImportedSourceSyncKey(
            "unsafe-local",
            `${absoluteConfiguredPath}\0${absoluteConfiguredPath}`,
          ),
          configuredPath: absoluteConfiguredPath,
          absolutePath: absoluteConfiguredPath,
          relativePath: path.basename(absoluteConfiguredPath),
        });
      }
    } catch {
      unavailableConfiguredPaths.push(absoluteConfiguredPath);
      continue;
    }
    artifacts.push(...scopedArtifacts);
  }

  const deduped = new Map<string, UnsafeLocalArtifact>();
  for (const artifact of artifacts) {
    deduped.set(artifact.syncKey, artifact);
  }
  return { artifacts: [...deduped.values()], unavailableConfiguredPaths };
}

function resolveUnsafeLocalTitle(artifact: UnsafeLocalArtifact): string {
  return `Unsafe Local Import: ${artifact.relativePath}`;
}

async function writeUnsafeLocalSourcePage(params: {
  config: ResolvedMemoryWikiConfig;
  artifact: UnsafeLocalArtifact;
  sourceUpdatedAtMs: number;
  sourceSize: number;
  state: Awaited<ReturnType<typeof readMemoryWikiSourceSyncState>>;
}): Promise<{ pagePath: string; changed: boolean; created: boolean }> {
  const { pageId, pagePath } = resolveUnsafeLocalPagePath({
    configuredPath: params.artifact.configuredPath,
    absolutePath: params.artifact.absolutePath,
  });
  const title = resolveUnsafeLocalTitle(params.artifact);
  const renderFingerprint = createHash("sha1")
    .update(
      JSON.stringify({
        configuredPath: params.artifact.configuredPath,
        relativePath: params.artifact.relativePath,
      }),
    )
    .digest("hex");
  return writeImportedSourcePage({
    vaultRoot: params.config.vault.path,
    syncKey: params.artifact.syncKey,
    sourcePath: params.artifact.absolutePath,
    sourceUpdatedAtMs: params.sourceUpdatedAtMs,
    sourceSize: params.sourceSize,
    renderFingerprint,
    pagePath,
    group: "unsafe-local",
    state: params.state,
    buildRendered: (raw, updatedAt) =>
      renderWikiMarkdown({
        frontmatter: {
          pageType: "source",
          id: pageId,
          title,
          sourceType: "memory-unsafe-local",
          provenanceMode: "unsafe-local",
          sourcePath: params.artifact.absolutePath,
          unsafeLocalConfiguredPath: params.artifact.configuredPath,
          unsafeLocalRelativePath: params.artifact.relativePath,
          status: "active",
          updatedAt,
        },
        body: [
          `# ${title}`,
          "",
          "## Unsafe Local Source",
          `- Configured path: \`${params.artifact.configuredPath}\``,
          `- Relative path: \`${params.artifact.relativePath}\``,
          `- Updated: ${updatedAt}`,
          "",
          "## Content",
          renderMarkdownFence(raw, detectFenceLanguage(params.artifact.absolutePath)),
          "",
          "## Notes",
          "<!-- openclaw:human:start -->",
          "<!-- openclaw:human:end -->",
          "",
        ].join("\n"),
      }),
  });
}

export async function syncMemoryWikiUnsafeLocalSources(
  config: ResolvedMemoryWikiConfig,
): Promise<BridgeMemoryWikiResult> {
  await initializeMemoryWikiVault(config);
  if (
    config.vaultMode !== "unsafe-local" ||
    !config.unsafeLocal.allowPrivateMemoryCoreAccess ||
    config.unsafeLocal.paths.length === 0
  ) {
    return {
      importedCount: 0,
      updatedCount: 0,
      skippedCount: 0,
      removedCount: 0,
      artifactCount: 0,
      workspaces: 0,
      pagePaths: [],
    };
  }

  const { artifacts, unavailableConfiguredPaths } = await collectUnsafeLocalArtifacts(
    config.unsafeLocal.paths,
  );
  const state = await readMemoryWikiSourceSyncState(config.vault.path);
  const activeKeys = new Set<string>();
  for (const [syncKey, entry] of Object.entries(state.entries)) {
    if (
      entry.group === "unsafe-local" &&
      unavailableConfiguredPaths.some((configuredPath) =>
        isPathInside(configuredPath, entry.sourcePath),
      )
    ) {
      // A configured source scope remains authoritative until it is readable again or removed
      // from config. Treating an unreadable mount as empty would permanently delete human notes.
      activeKeys.add(syncKey);
    }
  }
  assertMemoryWikiSourceSyncStateCapacity({
    state,
    group: "unsafe-local",
    incomingCount: new Set([...artifacts.map((artifact) => artifact.syncKey), ...activeKeys]).size,
  });
  const { results } = await runTasksWithConcurrency({
    tasks: artifacts.map((artifact) => async () => {
      const stats = await fs.stat(artifact.absolutePath);
      activeKeys.add(artifact.syncKey);
      return await writeUnsafeLocalSourcePage({
        config,
        artifact,
        sourceUpdatedAtMs: stats.mtimeMs,
        sourceSize: stats.size,
        state,
      });
    }),
    limit: UNSAFE_LOCAL_SYNC_CONCURRENCY,
    errorMode: "stop",
    throwOnError: true,
  });

  const removedCount = await pruneImportedSourceEntries({
    vaultRoot: config.vault.path,
    group: "unsafe-local",
    activeKeys,
    state,
  });
  await writeMemoryWikiSourceSyncState(config.vault.path, state);
  const importedCount = results.filter((result) => result.changed && result.created).length;
  const updatedCount = results.filter((result) => result.changed && !result.created).length;
  const skippedCount = results.filter((result) => !result.changed).length;
  const pagePaths = results
    .map((result) => result.pagePath)
    .toSorted((left, right) => left.localeCompare(right));

  if (importedCount > 0 || updatedCount > 0 || removedCount > 0) {
    await appendMemoryWikiLog(config.vault.path, {
      type: "ingest",
      timestamp: new Date().toISOString(),
      details: {
        sourceType: "memory-unsafe-local",
        configuredPathCount: config.unsafeLocal.paths.length,
        artifactCount: artifacts.length,
        importedCount,
        updatedCount,
        skippedCount,
        removedCount,
      },
    });
  }

  return {
    importedCount,
    updatedCount,
    skippedCount,
    removedCount,
    artifactCount: artifacts.length,
    workspaces: 0,
    pagePaths,
  };
}
