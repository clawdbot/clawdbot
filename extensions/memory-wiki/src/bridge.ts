import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  listActiveMemoryPublicArtifacts,
  type MemoryPluginPublicArtifact,
} from "openclaw/plugin-sdk/memory-host-core";
import type { OpenClawConfig } from "../api.js";
import type { ResolvedMemoryWikiConfig } from "./config.js";
import { appendMemoryWikiLog } from "./log.js";
import {
  createWikiPageFilename,
  renderMarkdownFence,
  renderWikiMarkdown,
  slugifyWikiSegment,
} from "./markdown.js";
import { writeImportedSourcePage } from "./source-page-shared.js";
import { resolveArtifactKey } from "./source-path-shared.js";
import {
  pruneImportedSourceEntries,
  readMemoryWikiSourceSyncState,
  writeMemoryWikiSourceSyncState,
} from "./source-sync-state.js";
import { initializeMemoryWikiVault } from "./vault.js";

type BridgeArtifact = {
  syncKey: string;
  artifactType: "markdown" | "memory-events";
  workspaceDir: string;
  relativePath: string;
  absolutePath: string;
};

export type BridgeMemoryWikiResult = {
  importedCount: number;
  updatedCount: number;
  skippedCount: number;
  removedCount: number;
  artifactCount: number;
  workspaces: number;
  pagePaths: string[];
};

function shouldImportArtifact(
  artifact: MemoryPluginPublicArtifact,
  bridgeConfig: ResolvedMemoryWikiConfig["bridge"],
): boolean {
  switch (artifact.kind) {
    case "memory-root":
      return bridgeConfig.indexMemoryRoot;
    case "daily-note":
      return bridgeConfig.indexDailyNotes;
    case "dream-report":
      return bridgeConfig.indexDreamReports;
    case "event-log":
      return bridgeConfig.followMemoryEvents;
    default:
      return false;
  }
}

async function collectBridgeArtifacts(
  bridgeConfig: ResolvedMemoryWikiConfig["bridge"],
  artifacts: MemoryPluginPublicArtifact[],
): Promise<BridgeArtifact[]> {
  const collected: BridgeArtifact[] = [];
  for (const artifact of artifacts) {
    if (!shouldImportArtifact(artifact, bridgeConfig)) {
      continue;
    }
    const syncKey = await resolveArtifactKey(artifact.absolutePath);
    collected.push({
      syncKey,
      artifactType: artifact.kind === "event-log" ? "memory-events" : "markdown",
      workspaceDir: artifact.workspaceDir,
      relativePath: artifact.relativePath,
      absolutePath: artifact.absolutePath,
    });
  }
  const deduped = new Map<string, BridgeArtifact>();
  for (const artifact of collected) {
    deduped.set(artifact.syncKey, artifact);
  }
  return [...deduped.values()];
}

function resolveBridgeTitle(artifact: BridgeArtifact, agentIds: string[]): string {
  if (artifact.artifactType === "memory-events") {
    if (agentIds.length === 0) {
      return "Memory Bridge: event journal";
    }
    return `Memory Bridge (${agentIds.join(", ")}): event journal`;
  }
  const base = artifact.relativePath
    .replace(/\.md$/i, "")
    .replace(/^memory\//, "")
    .replace(/\//g, " / ");
  if (agentIds.length === 0) {
    return `Memory Bridge: ${base}`;
  }
  return `Memory Bridge (${agentIds.join(", ")}): ${base}`;
}

function resolveBridgePagePath(params: { workspaceDir: string; relativePath: string }): {
  pageId: string;
  pagePath: string;
  workspaceSlug: string;
  artifactSlug: string;
} {
  const workspaceBaseSlug = slugifyWikiSegment(path.basename(params.workspaceDir));
  const workspaceHash = createHash("sha1").update(path.resolve(params.workspaceDir)).digest("hex");
  const artifactBaseSlug = slugifyWikiSegment(
    params.relativePath.replace(/\.md$/i, "").replace(/\//g, "-"),
  );
  const artifactHash = createHash("sha1").update(params.relativePath).digest("hex");
  const workspaceSlug = `${workspaceBaseSlug}-${workspaceHash.slice(0, 8)}`;
  const artifactSlug = `${artifactBaseSlug}-${artifactHash.slice(0, 8)}`;
  const fileName = createWikiPageFilename(`bridge-${workspaceSlug}-${artifactSlug}`);
  return {
    pageId: `source.bridge.${workspaceSlug}.${artifactSlug}`,
    pagePath: path.join("sources", fileName).replace(/\\/g, "/"),
    workspaceSlug,
    artifactSlug,
  };
}

async function writeBridgeSourcePage(params: {
  config: ResolvedMemoryWikiConfig;
  artifact: BridgeArtifact;
  agentIds: string[];
  sourceUpdatedAtMs: number;
  sourceSize: number;
  state: Awaited<ReturnType<typeof readMemoryWikiSourceSyncState>>;
}): Promise<{ pagePath: string; changed: boolean; created: boolean }> {
  const { pageId, pagePath } = resolveBridgePagePath({
    workspaceDir: params.artifact.workspaceDir,
    relativePath: params.artifact.relativePath,
  });
  const title = resolveBridgeTitle(params.artifact, params.agentIds);
  const renderFingerprint = createHash("sha1")
    .update(
      JSON.stringify({
        artifactType: params.artifact.artifactType,
        workspaceDir: params.artifact.workspaceDir,
        relativePath: params.artifact.relativePath,
        agentIds: params.agentIds,
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
    group: "bridge",
    state: params.state,
    buildRendered: (raw, updatedAt) => {
      const contentLanguage =
        params.artifact.artifactType === "memory-events" ? "json" : "markdown";
      return renderWikiMarkdown({
        frontmatter: {
          pageType: "source",
          id: pageId,
          title,
          sourceType:
            params.artifact.artifactType === "memory-events"
              ? "memory-bridge-events"
              : "memory-bridge",
          sourcePath: params.artifact.absolutePath,
          bridgeRelativePath: params.artifact.relativePath,
          bridgeWorkspaceDir: params.artifact.workspaceDir,
          bridgeAgentIds: params.agentIds,
          status: "active",
          updatedAt,
        },
        body: [
          `# ${title}`,
          "",
          "## Bridge Source",
          `- Workspace: \`${params.artifact.workspaceDir}\``,
          `- Relative path: \`${params.artifact.relativePath}\``,
          `- Kind: \`${params.artifact.artifactType}\``,
          `- Agents: ${params.agentIds.length > 0 ? params.agentIds.join(", ") : "unknown"}`,
          `- Updated: ${updatedAt}`,
          "",
          "## Content",
          renderMarkdownFence(raw, contentLanguage),
          "",
          "## Notes",
          "<!-- openclaw:human:start -->",
          "<!-- openclaw:human:end -->",
          "",
        ].join("\n"),
      });
    },
  });
}

export async function syncMemoryWikiBridgeSources(params: {
  config: ResolvedMemoryWikiConfig;
  appConfig?: OpenClawConfig;
}): Promise<BridgeMemoryWikiResult> {
  await initializeMemoryWikiVault(params.config);
  if (
    params.config.vaultMode !== "bridge" ||
    !params.config.bridge.enabled ||
    !params.config.bridge.readMemoryArtifacts ||
    !params.appConfig
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

  const publicArtifacts = await listActiveMemoryPublicArtifacts({ cfg: params.appConfig });
  const state = await readMemoryWikiSourceSyncState(params.config.vault.path);
  const results: Array<{ pagePath: string; changed: boolean; created: boolean }> = [];
  let artifactCount = 0;
  const activeKeys = new Set<string>();
  const artifacts = await collectBridgeArtifacts(params.config.bridge, publicArtifacts);
  const agentIdsByWorkspace = new Map<string, string[]>();
  for (const artifact of publicArtifacts) {
    agentIdsByWorkspace.set(artifact.workspaceDir, artifact.agentIds);
  }
  artifactCount = artifacts.length;
  for (const artifact of artifacts) {
    const stats = await fs.stat(artifact.absolutePath);
    activeKeys.add(artifact.syncKey);
    results.push(
      await writeBridgeSourcePage({
        config: params.config,
        artifact,
        agentIds: agentIdsByWorkspace.get(artifact.workspaceDir) ?? [],
        sourceUpdatedAtMs: stats.mtimeMs,
        sourceSize: stats.size,
        state,
      }),
    );
  }
  const workspaceCount = new Set(publicArtifacts.map((artifact) => artifact.workspaceDir)).size;

  const removedCount = await pruneImportedSourceEntries({
    vaultRoot: params.config.vault.path,
    group: "bridge",
    activeKeys,
    state,
  });
  await writeMemoryWikiSourceSyncState(params.config.vault.path, state);
  const importedCount = results.filter((result) => result.changed && result.created).length;
  const updatedCount = results.filter((result) => result.changed && !result.created).length;
  const skippedCount = results.filter((result) => !result.changed).length;
  const pagePaths = results
    .map((result) => result.pagePath)
    .toSorted((left, right) => left.localeCompare(right));

  if (importedCount > 0 || updatedCount > 0 || removedCount > 0) {
    await appendMemoryWikiLog(params.config.vault.path, {
      type: "ingest",
      timestamp: new Date().toISOString(),
      details: {
        sourceType: "memory-bridge",
        workspaces: workspaceCount,
        artifactCount,
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
    artifactCount,
    workspaces: workspaceCount,
    pagePaths,
  };
}
