import fs from "node:fs/promises";
import path from "node:path";
import {
  createSubsystemLogger,
  isPathInside,
  root,
} from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import {
  buildSessionEntry,
  isSessionArchiveArtifactName,
  listSessionTranscriptCorpusEntriesForAgent,
  resolveSessionIdentityForTranscriptFile,
  type SessionFileEntry,
  type SessionTranscriptCorpusEntry,
} from "openclaw/plugin-sdk/memory-core-host-engine-qmd";
import type { ResolvedQmdConfig } from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import type { PluginStateLeaseContext } from "openclaw/plugin-sdk/plugin-state-runtime";
import { formatSessionTranscriptMemoryHitKey } from "openclaw/plugin-sdk/session-transcript-hit";
import {
  refreshQmdSessionArtifactDocIds,
  replaceQmdSessionArtifactMappings,
  type QmdSessionArtifactMapping,
} from "../qmd-session-artifacts.js";
import { sanitizeQmdCollectionNameSegment } from "./qmd-collection-metadata.js";

const log = createSubsystemLogger("memory");

type QmdSessionExporterConfig = {
  dir: string;
  retentionMs?: number;
  collectionName: string;
};

type BuildSearchPath = (
  collection: string,
  collectionRelativePath: string,
  workspaceRelativePath: string,
  absolutePath: string,
) => string;

type ExportedSessionState = {
  entryHash: string;
  mtimeMs: number;
  revisionToken: string | null;
  target: string;
  targetRevision: string | null;
};

function buildSessionExportRevision(corpusEntry: SessionTranscriptCorpusEntry): string | null {
  if (!corpusEntry.contentRevision) {
    return null;
  }
  return [
    corpusEntry.contentRevision,
    corpusEntry.sessionKey ?? "",
    corpusEntry.updatedAtMs ?? "",
    corpusEntry.generatedByDreamingNarrative === true ? "dreaming" : "",
    corpusEntry.generatedByCronRun === true ? "cron" : "",
  ].join("\0");
}

function pathStatRevision(stat: {
  dev: number;
  ino: number;
  mtimeMs: number;
  size: number;
}): string {
  return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}`;
}

export class QmdSessionExporter {
  private readonly exportedSessionState = new Map<string, ExportedSessionState>();

  constructor(
    readonly config: QmdSessionExporterConfig,
    private readonly agentId: string,
    private readonly workspaceDir: string,
    private readonly indexPath: string,
    private readonly buildSearchPath: BuildSearchPath,
  ) {}

  async exportSessions(lease: PluginStateLeaseContext): Promise<void> {
    const { signal } = lease;
    signal.throwIfAborted();
    const exportDir = this.config.dir;
    lease.assertOwned();
    await fs.mkdir(exportDir, { recursive: true });
    signal.throwIfAborted();
    const exportRoot = await root(exportDir);
    signal.throwIfAborted();
    const corpusEntries = await listSessionTranscriptCorpusEntriesForAgent(this.agentId);
    signal.throwIfAborted();
    const keep = new Set<string>();
    const tracked = new Set<string>();
    const artifactMappings: QmdSessionArtifactMapping[] = [];
    const cutoff = this.config.retentionMs ? Date.now() - this.config.retentionMs : null;
    for (const corpusEntry of corpusEntries) {
      signal.throwIfAborted();
      const sessionFile = corpusEntry.sessionFile;
      const targetName = `${this.sessionExportStem(corpusEntry)}.md`;
      const target = path.join(exportDir, targetName);
      const revisionToken = buildSessionExportRevision(corpusEntry);
      const state = this.exportedSessionState.get(sessionFile);
      // The corpus owns source revision detection. This hot path only stats the
      // derived target, so unchanged transcripts are never reread or rehashed.
      const targetRevision =
        state?.target === target
          ? await exportRoot
              .stat(targetName)
              .then(pathStatRevision)
              .catch(() => null)
          : null;
      signal.throwIfAborted();
      if (
        revisionToken &&
        state?.revisionToken === revisionToken &&
        state.targetRevision !== null &&
        targetRevision === state.targetRevision
      ) {
        if (cutoff && state.mtimeMs < cutoff) {
          continue;
        }
        tracked.add(sessionFile);
        const identity = this.buildSessionArtifactMapping(
          sessionFile,
          targetName,
          target,
          corpusEntry,
        );
        if (identity) {
          artifactMappings.push(identity);
        }
        keep.add(target);
        continue;
      }
      const entry = await buildSessionEntry(sessionFile, {
        generatedByDreamingNarrative: corpusEntry.generatedByDreamingNarrative === true,
        generatedByCronRun: corpusEntry.generatedByCronRun === true,
        ...(corpusEntry.sessionKey ? { sessionKey: corpusEntry.sessionKey } : {}),
        ...(corpusEntry.updatedAtMs !== undefined ? { updatedAtMs: corpusEntry.updatedAtMs } : {}),
      });
      if (!entry || (cutoff && entry.mtimeMs < cutoff)) {
        continue;
      }
      tracked.add(sessionFile);
      const identity = this.buildSessionArtifactMapping(
        sessionFile,
        targetName,
        target,
        corpusEntry,
      );
      if (identity) {
        artifactMappings.push(identity);
      }
      const needsWrite =
        !state ||
        state.target !== target ||
        state.entryHash !== entry.hash ||
        state.targetRevision === null ||
        targetRevision !== state.targetRevision;
      let nextTargetRevision = targetRevision;
      if (needsWrite) {
        // fs-safe Root.write stages a sibling and atomically renames it, so a
        // failed export cannot expose partially rendered markdown to QMD.
        lease.assertOwned();
        await exportRoot.write(targetName, renderSessionMarkdown(entry), { encoding: "utf-8" });
        signal.throwIfAborted();
        nextTargetRevision = await exportRoot
          .stat(targetName)
          .then(pathStatRevision)
          .catch(() => null);
        signal.throwIfAborted();
      }
      lease.assertOwned();
      this.exportedSessionState.set(sessionFile, {
        entryHash: entry.hash,
        mtimeMs: entry.mtimeMs,
        revisionToken,
        target,
        targetRevision: nextTargetRevision,
      });
      keep.add(target);
    }
    const exported = await exportRoot.list(".").catch((error: unknown) => {
      signal.throwIfAborted();
      log.debug(`failed to list qmd session exports: ${String(error)}`);
      return [];
    });
    signal.throwIfAborted();
    for (const name of exported) {
      if (!name.endsWith(".md")) {
        continue;
      }
      const full = path.join(exportDir, name);
      if (!keep.has(full)) {
        lease.assertOwned();
        await exportRoot.remove(name).catch((error: unknown) => {
          signal.throwIfAborted();
          log.debug(`failed to remove stale qmd session export ${name}: ${String(error)}`);
        });
        signal.throwIfAborted();
      }
    }
    for (const [sessionFile, state] of this.exportedSessionState) {
      if (!tracked.has(sessionFile) || !isPathInside(exportDir, state.target)) {
        lease.assertOwned();
        this.exportedSessionState.delete(sessionFile);
      }
    }
    signal.throwIfAborted();
    lease.assertOwned();
    replaceQmdSessionArtifactMappings({
      collection: this.config.collectionName,
      indexPath: this.indexPath,
      mappings: artifactMappings,
    });
  }

  refreshArtifactDocIds(lease: PluginStateLeaseContext): void {
    const { signal } = lease;
    signal.throwIfAborted();
    lease.assertOwned();
    try {
      refreshQmdSessionArtifactDocIds({
        assertOwned: () => lease.assertOwned(),
        collection: this.config.collectionName,
        indexPath: this.indexPath,
      });
    } catch (err) {
      signal.throwIfAborted();
      log.warn(`failed to refresh qmd session artifact identity docids: ${String(err)}`);
    }
  }

  private buildSessionArtifactMapping(
    sessionFile: string,
    artifactPath: string,
    target: string,
    corpusEntry?: SessionTranscriptCorpusEntry,
  ): QmdSessionArtifactMapping | null {
    const identity = corpusEntry ?? resolveSessionIdentityForTranscriptFile(sessionFile);
    if (!identity?.agentId) {
      return null;
    }
    return {
      agentId: identity.agentId,
      archived: isSessionArchiveArtifactName(path.basename(sessionFile)),
      artifactPath,
      collection: this.config.collectionName,
      memoryKey: formatSessionTranscriptMemoryHitKey({
        agentId: identity.agentId,
        sessionId: identity.sessionId,
      }),
      searchPath: this.buildSearchPath(
        this.config.collectionName,
        artifactPath,
        path.relative(this.workspaceDir, target),
        target,
      ),
      sessionId: identity.sessionId,
    };
  }

  private sessionExportStem(corpusEntry: SessionTranscriptCorpusEntry): string {
    return corpusEntry.transcriptSource === "sqlite"
      ? corpusEntry.sessionId
      : path.basename(corpusEntry.sessionFile, ".jsonl");
  }
}

export function resolveQmdSessionExporterConfig(params: {
  qmd: ResolvedQmdConfig;
  agentId: string;
  qmdDir: string;
}): QmdSessionExporterConfig | null {
  if (!params.qmd.sessions.enabled) {
    return null;
  }
  return {
    dir: params.qmd.sessions.exportDir ?? path.join(params.qmdDir, "sessions"),
    ...(params.qmd.sessions.retentionDays
      ? { retentionMs: params.qmd.sessions.retentionDays * 24 * 60 * 60 * 1000 }
      : {}),
    collectionName: pickSessionCollectionName(params.qmd, params.agentId),
  };
}

function pickSessionCollectionName(qmd: ResolvedQmdConfig, agentId: string): string {
  const existing = new Set(qmd.collections.map((collection) => collection.name));
  const base = `sessions-${sanitizeQmdCollectionNameSegment(agentId)}`;
  if (!existing.has(base)) {
    return base;
  }
  let counter = 2;
  let candidate = `${base}-${counter}`;
  while (existing.has(candidate)) {
    counter += 1;
    candidate = `${base}-${counter}`;
  }
  return candidate;
}

function renderSessionMarkdown(entry: SessionFileEntry): string {
  const header = `# Session ${path.basename(entry.path, path.extname(entry.path))}`;
  const body = entry.content?.trim().length ? entry.content.trim() : "(empty)";
  return `${header}\n\n${body}\n`;
}
