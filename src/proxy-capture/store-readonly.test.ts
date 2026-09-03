import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupTempDirs, makeTempDir } from "../../test/helpers/temp-dir.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "../state/openclaw-state-db-contract.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { createDebugProxyCaptureReader } from "./store-readonly.js";

const cleanupDirs: string[] = [];

afterEach(() => {
  cleanupTempDirs(cleanupDirs);
});

function makeStateEnv(prefix: string): NodeJS.ProcessEnv {
  return { OPENCLAW_STATE_DIR: makeTempDir(cleanupDirs, prefix) };
}

function createCaptureDatabase(env: NodeJS.ProcessEnv, schemaVersion: number): string {
  const databasePath = resolveOpenClawStateSqlitePath(env);
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  const db = new DatabaseSync(databasePath);
  try {
    db.exec(`
      PRAGMA user_version = ${schemaVersion};
      CREATE TABLE workspace_attestations (
        workspace_key TEXT PRIMARY KEY,
        attested_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE capture_sessions (
        id TEXT NOT NULL PRIMARY KEY,
        started_at INTEGER NOT NULL,
        ended_at INTEGER,
        mode TEXT NOT NULL,
        source_scope TEXT NOT NULL,
        source_process TEXT NOT NULL,
        proxy_url TEXT
      ) STRICT;
      CREATE TABLE capture_blobs (
        blob_id TEXT NOT NULL PRIMARY KEY,
        content_type TEXT,
        encoding TEXT NOT NULL,
        size_bytes INTEGER NOT NULL,
        sha256 TEXT NOT NULL,
        data BLOB NOT NULL,
        created_at INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE capture_events (
        id INTEGER NOT NULL PRIMARY KEY,
        session_id TEXT NOT NULL,
        ts INTEGER NOT NULL,
        source_scope TEXT NOT NULL,
        source_process TEXT NOT NULL,
        protocol TEXT NOT NULL,
        direction TEXT NOT NULL,
        kind TEXT NOT NULL,
        flow_id TEXT NOT NULL,
        method TEXT,
        host TEXT,
        path TEXT,
        status INTEGER,
        close_code INTEGER,
        content_type TEXT,
        headers_json TEXT,
        data_text TEXT,
        data_blob_id TEXT,
        data_sha256 TEXT,
        error_text TEXT,
        meta_json TEXT
      ) STRICT;
      CREATE INDEX capture_events_session_ts_idx ON capture_events(session_id, ts);
      CREATE INDEX capture_events_flow_idx ON capture_events(flow_id, ts);
      INSERT INTO workspace_attestations VALUES ('workspace-1', 100, 200);
      INSERT INTO capture_sessions VALUES (
        'session-1', 1, NULL, 'qa', 'openclaw', 'candidate', NULL
      );
    `);
    db.prepare(
      `INSERT INTO capture_blobs (
         blob_id, content_type, encoding, size_bytes, sha256, data, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "blob-1",
      "application/json",
      "gzip",
      11,
      "fixture-sha",
      gzipSync(Buffer.from('{"ok":true}')),
      2,
    );
    db.prepare(
      `INSERT INTO capture_events (
         id, session_id, ts, source_scope, source_process, protocol, direction, kind, flow_id,
         method, host, path, status, content_type, data_blob_id
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      1,
      "session-1",
      3,
      "openclaw",
      "candidate",
      "https",
      "outbound",
      "request",
      "flow-1",
      "POST",
      "slack.com",
      "/api/chat.postMessage",
      200,
      "application/json",
      "blob-1",
    );
  } finally {
    db.close();
  }
  return databasePath;
}

function inspectDatabase(databasePath: string) {
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return {
      fingerprint: JSON.stringify(
        db
          .prepare(
            `SELECT type, name, tbl_name AS tableName, sql
             FROM sqlite_schema
             WHERE name NOT LIKE 'sqlite_%'
             ORDER BY type, name`,
          )
          .all(),
      ),
      userVersion: db.prepare("PRAGMA user_version").get(),
      workspaceAttestations: db
        .prepare("SELECT * FROM workspace_attestations ORDER BY workspace_key")
        .all(),
    };
  } finally {
    db.close();
  }
}

describe("createDebugProxyCaptureReader", () => {
  it.each([3, 4, 5, 6])(
    "reads schema %s without changing its version, schema, or workspace attestations",
    (schemaVersion) => {
      const env = makeStateEnv(`openclaw-proxy-reader-v${schemaVersion}-`);
      const databasePath = createCaptureDatabase(env, schemaVersion);
      const before = inspectDatabase(databasePath);
      const reader = createDebugProxyCaptureReader({ env });

      expect(reader.getSessionEvents("session-1")).toEqual([
        expect.objectContaining({
          id: 1,
          sessionId: "session-1",
          flowId: "flow-1",
          host: "slack.com",
        }),
      ]);
      expect(reader.readBlob("blob-1")).toBe('{"ok":true}');
      expect(inspectDatabase(databasePath)).toEqual(before);
    },
  );

  it("returns empty results for a missing database without creating state artifacts", () => {
    const env = makeStateEnv("openclaw-proxy-reader-missing-");
    const reader = createDebugProxyCaptureReader({ env });
    const databasePath = resolveOpenClawStateSqlitePath(env);

    expect(reader.getSessionEvents("missing")).toEqual([]);
    expect(reader.readBlob("missing")).toBeNull();
    expect(fs.existsSync(databasePath)).toBe(false);
    expect(fs.existsSync(path.dirname(databasePath))).toBe(false);
  });

  it("observes a database created after the reader", () => {
    const env = makeStateEnv("openclaw-proxy-reader-late-db-");
    const reader = createDebugProxyCaptureReader({ env });
    expect(reader.getSessionEvents("session-1")).toEqual([]);

    createCaptureDatabase(env, 3);

    expect(reader.getSessionEvents("session-1")).toHaveLength(1);
    expect(reader.readBlob("blob-1")).toBe('{"ok":true}');
  });

  it("observes later committed WAL writes on subsequent calls", () => {
    const env = makeStateEnv("openclaw-proxy-reader-wal-");
    const databasePath = createCaptureDatabase(env, 3);
    const writer = new DatabaseSync(databasePath);
    const reader = createDebugProxyCaptureReader({ env });
    try {
      writer.exec("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0;");
      expect(reader.getSessionEvents("session-1")).toHaveLength(1);

      writer
        .prepare(
          `INSERT INTO capture_events (
             id, session_id, ts, source_scope, source_process, protocol, direction, kind, flow_id
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(2, "session-1", 4, "openclaw", "candidate", "https", "inbound", "response", "flow-1");

      expect(reader.getSessionEvents("session-1").map((event) => event.id)).toEqual([2, 1]);
    } finally {
      writer.close();
    }
  });

  it("projects exact camelCase keys with timestamp, id, and limit ordering", () => {
    const env = makeStateEnv("openclaw-proxy-reader-ordering-");
    const databasePath = createCaptureDatabase(env, 3);
    const writer = new DatabaseSync(databasePath);
    try {
      const insert = writer.prepare(
        `INSERT INTO capture_events (
           id, session_id, ts, source_scope, source_process, protocol, direction, kind, flow_id,
           method, host, path, status, close_code, content_type, headers_json, data_text,
           data_blob_id, data_sha256, error_text, meta_json
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      insert.run(
        2,
        "session-1",
        5,
        "openclaw",
        "candidate",
        "https",
        "outbound",
        "request",
        "flow-2",
        "POST",
        "slack.com",
        "/api/chat.postMessage",
        200,
        1000,
        "application/json",
        '{"authorization":"redacted"}',
        '{"text":"older"}',
        "blob-1",
        "sha-2",
        "error-2",
        '{"attempt":2}',
      );
      insert.run(
        3,
        "session-1",
        5,
        "openclaw",
        "candidate",
        "https",
        "inbound",
        "response",
        "flow-3",
        "GET",
        "slack.com",
        "/api/conversations.history",
        201,
        1001,
        "application/json",
        '{"accept":"application/json"}',
        '{"text":"newer"}',
        "blob-1",
        "sha-3",
        "error-3",
        '{"attempt":3}',
      );
      insert.run(
        4,
        "session-1",
        6,
        "openclaw",
        "candidate",
        "https",
        "inbound",
        "response",
        "flow-4",
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
      );
    } finally {
      writer.close();
    }

    const events = createDebugProxyCaptureReader({ env }).getSessionEvents("session-1", 2);

    expect(events.map((event) => event.id)).toEqual([4, 3]);
    expect(events[1]).toEqual({
      id: 3,
      sessionId: "session-1",
      ts: 5,
      sourceScope: "openclaw",
      sourceProcess: "candidate",
      protocol: "https",
      direction: "inbound",
      kind: "response",
      flowId: "flow-3",
      method: "GET",
      host: "slack.com",
      path: "/api/conversations.history",
      status: 201,
      closeCode: 1001,
      contentType: "application/json",
      headersJson: '{"accept":"application/json"}',
      dataText: '{"text":"newer"}',
      dataBlobId: "blob-1",
      dataSha256: "sha-3",
      errorText: "error-3",
      metaJson: '{"attempt":3}',
    });
  });

  it("propagates newer schema errors", () => {
    const env = makeStateEnv("openclaw-proxy-reader-newer-");
    const databasePath = resolveOpenClawStateSqlitePath(env);
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    const db = new DatabaseSync(databasePath);
    db.exec(`PRAGMA user_version = ${OPENCLAW_STATE_SCHEMA_VERSION + 1};`);
    db.close();

    expect(() => createDebugProxyCaptureReader({ env }).getSessionEvents("session-1")).toThrow(
      `uses newer schema version ${OPENCLAW_STATE_SCHEMA_VERSION + 1}`,
    );
  });

  it("propagates database corruption", () => {
    const env = makeStateEnv("openclaw-proxy-reader-corrupt-");
    const databasePath = resolveOpenClawStateSqlitePath(env);
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    fs.writeFileSync(databasePath, "not a sqlite database");

    expect(() => createDebugProxyCaptureReader({ env }).readBlob("blob-1")).toThrow();
  });

  it("propagates capture query failures", () => {
    const env = makeStateEnv("openclaw-proxy-reader-sql-");
    const databasePath = resolveOpenClawStateSqlitePath(env);
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    const db = new DatabaseSync(databasePath);
    db.exec("PRAGMA user_version = 3;");
    db.close();

    expect(() => createDebugProxyCaptureReader({ env }).getSessionEvents("session-1")).toThrow(
      /no such table: capture_events/u,
    );
  });
});
