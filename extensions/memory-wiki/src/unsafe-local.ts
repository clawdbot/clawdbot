// Memory Wiki plugin module implements unsafe local behavior.
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { runTasksWithConcurrency } from "openclaw/plugin-sdk/concurrency-runtime";
import { isPathInside } from "openclaw/plugin-sdk/file-access-runtime";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import { walkMemoryWikiDirectory } from "./bounded-walk.js";
import type { ResolvedMemoryWikiConfig } from "./config.js";
import {
  createWikiPageFilename,
  renderMarkdownFence,
  renderWikiMarkdown,
  slugifyWikiSegment,
  toWikiPageSummary,
} from "./markdown.js";
import { syncImportedSourcePages, type BridgeMemoryWikiResult } from "./source-import.js";
import { writeImportedSourcePage } from "./source-page-shared.js";
import { resolveArtifactKey } from "./source-path-shared.js";
import {
  assertMemoryWikiSourceSyncStateCapacity,
  type readMemoryWikiSourceSyncState,
} from "./source-sync-state.js";

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
const GENERATED_IMPORTED_SOURCE_PREFIXES = ["bridge-", "unsafe-local-"];
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
  vaultRootKey: string,
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
            syncKey: await resolveArtifactKey(absolutePath),
            configuredPath: absoluteConfiguredPath,
            absolutePath,
            relativePath: path.relative(absoluteConfiguredPath, absolutePath).replace(/\\/g, "/"),
          });
        }
      } else if (stat.isFile()) {
        scopedArtifacts.push({
          syncKey: await resolveArtifactKey(absoluteConfiguredPath),
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
    if (isPathInside(vaultRootKey, artifact.syncKey)) {
      continue;
    }
    const sourceName = normalizeLowercaseStringOrEmpty(path.basename(artifact.absolutePath));
    if (GENERATED_IMPORTED_SOURCE_PREFIXES.some((prefix) => sourceName.startsWith(prefix))) {
      const sourcePage = toWikiPageSummary({
        absolutePath: artifact.absolutePath,
        relativePath: `sources/${sourceName}`,
        raw: await fs.readFile(artifact.absolutePath, "utf8"),
      });
      if (sourcePage?.importedSourceBody) {
        continue;
      }
    }
    deduped.set(artifact.syncKey, artifact);
  }
  return { artifacts: [...deduped.values()], unavailableConfiguredPaths };
}

function resolveUnsafeLocalPagePath(params: { configuredPath: string; absolutePath: string }): {
  pageId: string;
  pagePath: string;
} {
  const configuredBaseSlug = slugifyWikiSegment(path.basename(params.configuredPath));
  const configuredHash = createHash("sha1")
    .update(path.resolve(params.configuredPath))
    .digest("hex")
    .slice(0, 8);
  const artifactBaseSlug = slugifyWikiSegment(path.basename(params.absolutePath));
  const artifactHash = createHash("sha1")
    .update(path.resolve(params.absolutePath))
    .digest("hex")
    .slice(0, 8);
  const pageSlug = `${configuredBaseSlug}-${configuredHash}-${artifactBaseSlug}-${artifactHash}`;
  return {
    pageId: `source.unsafe-local.${pageSlug}`,
    pagePath: path
      .join("sources", createWikiPageFilename(`unsafe-local-${pageSlug}`))
      .replace(/\\/g, "/"),
  };
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
  prepareWrite: () => Promise<unknown>;
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
    prepareWrite: params.prepareWrite,
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
  options: { signal?: AbortSignal } = {},
): Promise<BridgeMemoryWikiResult> {
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

  const vaultRootKey = await resolveArtifactKey(config.vault.path);
  const { artifacts, unavailableConfiguredPaths } = await collectUnsafeLocalArtifacts(
    config.unsafeLocal.paths,
    vaultRootKey,
  );
  return await syncImportedSourcePages({
    config,
    group: "unsafe-local",
    signal: options.signal,
    writeSources: async ({ state, prepareWrite }) => {
      const activeKeys = new Set<string>();
      for (const [syncKey, entry] of Object.entries(state.entries)) {
        if (
          entry.group === "unsafe-local" &&
          unavailableConfiguredPaths.some((configuredPath) =>
            isPathInside(configuredPath, entry.sourcePath),
          )
        ) {
          // An unreadable configured scope remains authoritative; pruning would lose human notes.
          activeKeys.add(syncKey);
        }
      }
      assertMemoryWikiSourceSyncStateCapacity({
        state,
        group: "unsafe-local",
        incomingCount: new Set([...artifacts.map((artifact) => artifact.syncKey), ...activeKeys])
          .size,
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
            prepareWrite,
          });
        }),
        limit: UNSAFE_LOCAL_SYNC_CONCURRENCY,
        errorMode: "stop",
        throwOnError: true,
      });
      return { results, activeKeys, artifactCount: artifacts.length, workspaces: 0 };
    },
    logDetails: () => ({ configuredPathCount: config.unsafeLocal.paths.length }),
  });
}
