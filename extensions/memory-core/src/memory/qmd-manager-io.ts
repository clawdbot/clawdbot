import fs from "node:fs/promises";
import readline from "node:readline";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import {
  buildMemoryReadResult,
  buildMemoryReadResultFromSlice,
  DEFAULT_MEMORY_READ_LINES,
  isFileMissingError,
  type MemoryEmbeddingProbeResult,
  type MemoryProviderStatus,
  type MemoryReadResult,
  type MemorySource,
  statRegularFile,
} from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { openNodeSqliteDatabase } from "openclaw/plugin-sdk/sqlite-runtime";
import { isDefaultQmdMemoryPath as isDefaultMemoryPath } from "./qmd-document-resolver.js";
import { qmdManagerLog } from "./qmd-manager-base.js";
import {
  normalizePositiveInteger,
  parseQmdStatusVectorCount,
  qmdUsesVectors,
} from "./qmd-manager-helpers.js";
import { QmdManagerSearch } from "./qmd-manager-search.js";

type SqliteDatabase = import("node:sqlite").DatabaseSync;

export abstract class QmdManagerIo extends QmdManagerSearch {
  async readFile(params: {
    relPath: string;
    from?: number;
    lines?: number;
  }): Promise<MemoryReadResult> {
    const relPath = params.relPath?.trim();
    if (!relPath) {
      throw new Error("path required");
    }
    const absPath = this.resolveReadPath(relPath);
    if (!absPath.endsWith(".md")) {
      throw new Error("path required");
    }
    let statResult: Awaited<ReturnType<typeof statRegularFile>>;
    try {
      statResult = await statRegularFile(absPath);
    } catch (err) {
      if (err instanceof Error && err.message === "path must be a regular file") {
        throw new Error("path required", { cause: err });
      }
      throw err;
    }
    if (statResult.missing) {
      return { text: "", path: relPath };
    }
    if (params.from !== undefined || params.lines !== undefined) {
      const startLine = normalizePositiveInteger(params.from, 1);
      const requestedCount = normalizePositiveInteger(
        params.lines ?? DEFAULT_MEMORY_READ_LINES,
        DEFAULT_MEMORY_READ_LINES,
      );
      const partial = await this.readPartialText(absPath, startLine, requestedCount);
      if (partial.missing) {
        return { text: "", path: relPath };
      }
      return buildMemoryReadResultFromSlice({
        selectedLines: partial.selectedLines,
        relPath,
        startLine,
        moreSourceLinesRemain: partial.moreSourceLinesRemain,
        maxChars: this.contextLimits?.memoryGetMaxChars,
        suggestReadFallback: isDefaultMemoryPath(relPath),
      });
    }
    const full = await this.readFullText(absPath);
    if (full.missing) {
      return { text: "", path: relPath };
    }
    return buildMemoryReadResult({
      content: full.text,
      relPath,
      from: params.from,
      lines: params.lines,
      defaultLines: DEFAULT_MEMORY_READ_LINES,
      maxChars: this.contextLimits?.memoryGetMaxChars,
      suggestReadFallback: isDefaultMemoryPath(relPath),
    });
  }

  status(): MemoryProviderStatus {
    const counts = this.readCounts();
    return {
      backend: "qmd",
      provider: "qmd",
      model: "qmd",
      requestedProvider: "qmd",
      files: counts.totalDocuments,
      chunks: counts.totalDocuments,
      dirty: this.dirty,
      workspaceDir: this.workspaceDir,
      dbPath: this.indexPath,
      sources: Array.from(this.sources),
      sourceCounts: counts.sourceCounts,
      vector: {
        enabled: qmdUsesVectors(this.qmd.searchMode),
        available: this.vectorAvailable ?? undefined,
        semanticAvailable: this.vectorAvailable ?? undefined,
        loadError: this.vectorStatusDetail ?? undefined,
      },
      batch: {
        enabled: false,
        failures: 0,
        limit: 0,
        wait: false,
        concurrency: 0,
        pollIntervalMs: 0,
        timeoutMs: 0,
      },
      custom: {
        qmd: {
          collections: this.qmd.collections.length,
          lastUpdateAt: this.lastUpdateAt,
          embedFailures: this.embedFailureCount,
          embedBackoffUntil: this.embedBackoffUntil,
        },
      },
    };
  }

  async probeEmbeddingAvailability(): Promise<MemoryEmbeddingProbeResult> {
    if (!qmdUsesVectors(this.qmd.searchMode)) {
      return { ok: true, checked: false };
    }
    const ok = await this.probeVectorAvailability();
    return {
      ok,
      error: ok ? undefined : (this.vectorStatusDetail ?? "QMD semantic vectors are unavailable"),
    };
  }

  async probeVectorAvailability(): Promise<boolean> {
    if (!qmdUsesVectors(this.qmd.searchMode)) {
      this.vectorAvailable = false;
      this.vectorStatusDetail = null;
      return false;
    }
    try {
      const result = await this.runQmd(["status"], {
        timeoutMs: this.qmd.limits.timeoutMs,
      });
      const vectorCount = parseQmdStatusVectorCount(`${result.stdout}\n${result.stderr}`);
      if (vectorCount === null) {
        this.vectorAvailable = false;
        this.vectorStatusDetail = "Could not determine QMD vector status from `qmd status`";
        return false;
      }
      this.vectorAvailable = vectorCount > 0;
      this.vectorStatusDetail =
        vectorCount > 0
          ? null
          : "QMD index has 0 vectors; semantic search is unavailable until embeddings finish";
      return this.vectorAvailable;
    } catch (err) {
      const message = formatErrorMessage(err);
      this.vectorAvailable = false;
      this.vectorStatusDetail = `QMD status probe failed: ${message}`;
      return false;
    }
  }

  protected async readPartialText(
    absPath: string,
    from?: number,
    lines?: number,
  ): Promise<
    { missing: true } | { missing: false; selectedLines: string[]; moreSourceLinesRemain: boolean }
  > {
    const start = normalizePositiveInteger(from, 1);
    const count = normalizePositiveInteger(lines, Number.MAX_SAFE_INTEGER);
    let handle;
    try {
      handle = await fs.open(absPath);
    } catch (err) {
      if (isFileMissingError(err)) {
        return { missing: true };
      }
      throw err;
    }
    const stream = handle.createReadStream({ encoding: "utf-8" });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    const selected: string[] = [];
    let index = 0;
    let moreSourceLinesRemain = false;
    try {
      for await (const line of rl) {
        index += 1;
        if (index < start) {
          continue;
        }
        if (selected.length >= count) {
          moreSourceLinesRemain = true;
          break;
        }
        selected.push(line);
      }
    } finally {
      rl.close();
      await handle.close();
    }
    return {
      missing: false,
      selectedLines: selected.slice(0, count),
      moreSourceLinesRemain,
    };
  }

  protected async readFullText(
    absPath: string,
  ): Promise<{ missing: true } | { missing: false; text: string }> {
    try {
      return { missing: false, text: await fs.readFile(absPath, "utf-8") };
    } catch (err) {
      if (isFileMissingError(err)) {
        return { missing: true };
      }
      throw err;
    }
  }

  protected ensureDb(): SqliteDatabase {
    if (this.db) {
      return this.db;
    }
    this.db = openNodeSqliteDatabase(this.indexPath, { readOnly: true });
    // busy_timeout is per-connection; keep it below the write path because this
    // synchronous read runs on the main thread and WAL readers rarely block.
    this.db.exec("PRAGMA busy_timeout = 1000");
    return this.db;
  }

  protected resolveReadPath(relPath: string): string {
    return this.documentResolver.resolveReadPath(relPath);
  }

  protected readCounts(): {
    totalDocuments: number;
    sourceCounts: Array<{ source: MemorySource; files: number; chunks: number }>;
  } {
    try {
      const rows = this.ensureDb()
        .prepare(
          "SELECT collection, COUNT(*) as c FROM documents WHERE active = 1 GROUP BY collection",
        )
        .all() as Array<{ collection: string; c: number }>;
      const bySource = new Map<MemorySource, { files: number; chunks: number }>();
      for (const source of this.sources) {
        bySource.set(source, { files: 0, chunks: 0 });
      }
      let total = 0;
      for (const row of rows) {
        const source = this.collectionRoots.get(row.collection)?.kind ?? "memory";
        const entry = bySource.get(source) ?? { files: 0, chunks: 0 };
        entry.files += row.c ?? 0;
        entry.chunks += row.c ?? 0;
        bySource.set(source, entry);
        total += row.c ?? 0;
      }
      return {
        totalDocuments: total,
        sourceCounts: Array.from(bySource.entries()).map(([source, value]) => ({
          source,
          files: value.files,
          chunks: value.chunks,
        })),
      };
    } catch (err) {
      qmdManagerLog.warn(`failed to read qmd index stats: ${String(err)}`);
      return {
        totalDocuments: 0,
        sourceCounts: Array.from(this.sources).map((source) => ({
          source,
          files: 0,
          chunks: 0,
        })),
      };
    }
  }
}
