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

export class QmdSessionExporter {
  private readonly exportedSessionState = new Map<
    string,
    {
      hash: string;
      mtimeMs: number;
      target: string;
    }
  >();

  constructor(
    readonly config: QmdSessionExporterConfig,
    private readonly agentId: string,
    private readonly workspaceDir: string,
    private readonly indexPath: string,
    private readonly buildSearchPath: BuildSearchPath,
  ) {}

  async exportSessions(): Promise<void> {
    const exportDir = this.config.dir;
    await fs.mkdir(exportDir, { recursive: true });
    const exportRoot = await root(exportDir);
    const corpusEntries = await listSessionTranscriptCorpusEntriesForAgent(this.agentId);
    const keep = new Set<string>();
    const tracked = new Set<string>();
    const artifactMappings: QmdSessionArtifactMapping[] = [];
    const cutoff = this.config.retentionMs ? Date.now() - this.config.retentionMs : null;
    for (const corpusEntry of corpusEntries) {
      const sessionFile = corpusEntry.sessionFile;
      const entry = await buildSessionEntry(sessionFile, {
        generatedByDreamingNarrative: corpusEntry.generatedByDreamingNarrative === true,
        generatedByCronRun: corpusEntry.generatedByCronRun === true,
        ...(corpusEntry.sessionKey ? { sessionKey: corpusEntry.sessionKey } : {}),
        ...(corpusEntry.updatedAtMs !== undefined ? { updatedAtMs: corpusEntry.updatedAtMs } : {}),
      });
      if (!entry || (cutoff && entry.mtimeMs < cutoff)) {
        continue;
      }
      const targetName = `${this.sessionExportStem(corpusEntry)}.md`;
      const target = path.join(exportDir, targetName);
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
      const state = this.exportedSessionState.get(sessionFile);
      if (!state || state.hash !== entry.hash || state.mtimeMs !== entry.mtimeMs) {
        await exportRoot.write(targetName, renderSessionMarkdown(entry), { encoding: "utf-8" });
      }
      this.exportedSessionState.set(sessionFile, {
        hash: entry.hash,
        mtimeMs: entry.mtimeMs,
        target,
      });
      keep.add(target);
    }
    const exported = await exportRoot.list(".").catch(() => []);
    for (const name of exported) {
      if (!name.endsWith(".md")) {
        continue;
      }
      const full = path.join(exportDir, name);
      if (!keep.has(full)) {
        await exportRoot.remove(name).catch(() => undefined);
      }
    }
    for (const [sessionFile, state] of this.exportedSessionState) {
      if (!tracked.has(sessionFile) || !isPathInside(exportDir, state.target)) {
        this.exportedSessionState.delete(sessionFile);
      }
    }
    replaceQmdSessionArtifactMappings({
      collection: this.config.collectionName,
      indexPath: this.indexPath,
      mappings: artifactMappings,
    });
  }

  refreshArtifactDocIds(): void {
    try {
      refreshQmdSessionArtifactDocIds({
        collection: this.config.collectionName,
        indexPath: this.indexPath,
      });
    } catch (err) {
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
