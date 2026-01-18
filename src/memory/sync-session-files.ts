import type { DatabaseSync } from "node:sqlite";

import { createSubsystemLogger } from "../logging.js";
import type { SessionFileEntry } from "./session-files.js";
import {
  buildSessionEntry,
  listSessionFilesForAgent,
  sessionPathForFile,
} from "./session-files.js";

const log = createSubsystemLogger("memory");

type ProgressState = {
  completed: number;
  total: number;
  label?: string;
  report: (update: { completed: number; total: number; label?: string }) => void;
};

export async function syncSessionFiles(params: {
  agentId: string;
  db: DatabaseSync;
  needsFullReindex: boolean;
  progress?: ProgressState;
  batchEnabled: boolean;
  concurrency: number;
  runWithConcurrency: <T>(tasks: Array<() => Promise<T>>, concurrency: number) => Promise<T[]>;
  indexFile: (entry: SessionFileEntry) => Promise<void>;
  vectorTable: string;
  ftsTable: string;
  ftsEnabled: boolean;
  ftsAvailable: boolean;
  model: string;
  dirtyFiles: Set<string>;
}) {
  const files = await listSessionFilesForAgent(params.agentId);
  const activePaths = new Set(files.map((file) => sessionPathForFile(file)));
  const indexAll = params.needsFullReindex || params.dirtyFiles.size === 0;

  log.debug("memory sync: indexing session files", {
    files: files.length,
    indexAll,
    dirtyFiles: params.dirtyFiles.size,
    batch: params.batchEnabled,
    concurrency: params.concurrency,
  });

  if (params.progress) {
    params.progress.total += files.length;
    params.progress.report({
      completed: params.progress.completed,
      total: params.progress.total,
      label: params.batchEnabled ? "Indexing session files (batch)..." : "Indexing session files…",
    });
  }

  const tasks = files.map((absPath) => async () => {
    if (!indexAll && !params.dirtyFiles.has(absPath)) {
      if (params.progress) {
        params.progress.completed += 1;
        params.progress.report({
          completed: params.progress.completed,
          total: params.progress.total,
        });
      }
      return;
    }
    const entry = await buildSessionEntry(absPath);
    if (!entry) {
      if (params.progress) {
        params.progress.completed += 1;
        params.progress.report({
          completed: params.progress.completed,
          total: params.progress.total,
        });
      }
      return;
    }
    const record = params.db
      .prepare(`SELECT hash FROM files WHERE path = ? AND source = ?`)
      .get(entry.path, "sessions") as { hash: string } | undefined;
    if (!params.needsFullReindex && record?.hash === entry.hash) {
      if (params.progress) {
        params.progress.completed += 1;
        params.progress.report({
          completed: params.progress.completed,
          total: params.progress.total,
        });
      }
      return;
    }
    await params.indexFile(entry);
    if (params.progress) {
      params.progress.completed += 1;
      params.progress.report({
        completed: params.progress.completed,
        total: params.progress.total,
      });
    }
  });

  await params.runWithConcurrency(tasks, params.concurrency);

  const staleRows = params.db
    .prepare(`SELECT path FROM files WHERE source = ?`)
    .all("sessions") as Array<{ path: string }>;
  for (const stale of staleRows) {
    if (activePaths.has(stale.path)) continue;
    params.db
      .prepare(`DELETE FROM files WHERE path = ? AND source = ?`)
      .run(stale.path, "sessions");
    try {
      params.db
        .prepare(
          `DELETE FROM ${params.vectorTable} WHERE id IN (SELECT id FROM chunks WHERE path = ? AND source = ?)`,
        )
        .run(stale.path, "sessions");
    } catch {}
    params.db
      .prepare(`DELETE FROM chunks WHERE path = ? AND source = ?`)
      .run(stale.path, "sessions");
    if (params.ftsEnabled && params.ftsAvailable) {
      try {
        params.db
          .prepare(`DELETE FROM ${params.ftsTable} WHERE path = ? AND source = ? AND model = ?`)
          .run(stale.path, "sessions", params.model);
      } catch {}
    }
  }
}
