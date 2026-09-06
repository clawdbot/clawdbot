import type { DatabaseSync, StatementSync } from "node:sqlite";
import type {
  MemoryChunk,
  MemoryEntryProvenance,
  MemorySource,
} from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import {
  compileSqliteQueryBindings,
  getNodeSqliteKysely,
} from "openclaw/plugin-sdk/sqlite-runtime";

export type IndexedMemoryChunk = MemoryChunk & {
  importance: number | null;
  triggers: string | null;
  projectKey: string | null;
};

type ChunkWrite = { id: string; chunk: IndexedMemoryChunk; embedding: number[] };
type ChunkDatabase = {
  memory_index_chunks: {
    id: string;
    path: string;
    source: MemorySource;
    start_line: number;
    end_line: number;
    hash: string;
    model: string;
    text: string;
    embedding: string;
    updated_at: number;
  };
  memory_index_chunk_recall_metadata: {
    chunk_id: string;
    importance: number | null;
    triggers: string | null;
    project_key: string | null;
  };
  memory_index_chunk_provenance: {
    chunk_id: string;
    origin_class: MemoryEntryProvenance["originClass"];
    session_kind: MemoryEntryProvenance["sessionKind"];
    observed_at: number;
    supersedes_key: string | null;
  };
};

export function createMemoryChunkWriter(
  database: DatabaseSync,
  context: { path: string; source: MemorySource; model: string; now: number },
) {
  const db = getNodeSqliteKysely<ChunkDatabase>(database);
  const chunkWrite = compileSqliteQueryBindings<ChunkWrite>((parameter) =>
    db
      .insertInto("memory_index_chunks")
      .values({
        id: parameter((row) => row.id),
        path: context.path,
        source: context.source,
        start_line: parameter((row) => row.chunk.startLine),
        end_line: parameter((row) => row.chunk.endLine),
        hash: parameter((row) => row.chunk.hash),
        model: context.model,
        text: parameter((row) => row.chunk.text),
        embedding: parameter((row) => JSON.stringify(row.embedding)),
        updated_at: context.now,
      })
      .onConflict((conflict) =>
        conflict.column("id").doUpdateSet((eb) => ({
          hash: eb.ref("excluded.hash"),
          model: eb.ref("excluded.model"),
          text: eb.ref("excluded.text"),
          embedding: eb.ref("excluded.embedding"),
          updated_at: eb.ref("excluded.updated_at"),
        })),
      ),
  );
  const recallWrite = compileSqliteQueryBindings<ChunkWrite>((parameter) =>
    db
      .insertInto("memory_index_chunk_recall_metadata")
      .values({
        chunk_id: parameter((row) => row.id),
        importance: parameter((row) => row.chunk.importance),
        triggers: parameter((row) => row.chunk.triggers),
        project_key: parameter((row) => row.chunk.projectKey),
      })
      .onConflict((conflict) =>
        conflict.column("chunk_id").doUpdateSet((eb) => ({
          importance: eb.ref("excluded.importance"),
          triggers: eb.ref("excluded.triggers"),
          project_key: eb.ref("excluded.project_key"),
        })),
      ),
  );
  const provenanceWrite = compileSqliteQueryBindings<{
    id: string;
    provenance: MemoryEntryProvenance;
  }>((parameter) =>
    db
      .insertInto("memory_index_chunk_provenance")
      .values({
        chunk_id: parameter((row) => row.id),
        origin_class: parameter((row) => row.provenance.originClass),
        session_kind: parameter((row) => row.provenance.sessionKind),
        observed_at: parameter((row) => row.provenance.observedAt),
        supersedes_key: parameter((row) => row.provenance.supersedesKey ?? null),
      })
      .onConflict((conflict) =>
        conflict.column("chunk_id").doUpdateSet((eb) => ({
          origin_class: eb.ref("excluded.origin_class"),
          session_kind: eb.ref("excluded.session_kind"),
          observed_at: eb.ref("excluded.observed_at"),
          supersedes_key: eb.ref("excluded.supersedes_key"),
        })),
      ),
  );
  let chunkStatement: StatementSync | undefined;
  let recallStatement: StatementSync | undefined;
  let provenanceStatement: StatementSync | undefined;

  // One publication owns these statements, including large embeddings. Lazy
  // preparation keeps empty writes inert and later tables untouched on failure.
  return (id: string, chunk: IndexedMemoryChunk, embedding: number[]): void => {
    const row = { id, chunk, embedding };
    (chunkStatement ??= database.prepare(chunkWrite.compiled.sql)).run(...chunkWrite.bind(row));
    (recallStatement ??= database.prepare(recallWrite.compiled.sql)).run(...recallWrite.bind(row));
    const provenance = chunk.provenance ?? {
      originClass: "untrusted" as const,
      sessionKind: "unknown" as const,
      observedAt: context.now,
    };
    (provenanceStatement ??= database.prepare(provenanceWrite.compiled.sql)).run(
      ...provenanceWrite.bind({ id, provenance }),
    );
  };
}
