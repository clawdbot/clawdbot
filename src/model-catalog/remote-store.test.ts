import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import {
  markRemoteModelCatalogChecked,
  readRemoteModelCatalog,
  writeRemoteModelCatalog,
} from "./remote-store.js";

const roots: string[] = [];
afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("remote model catalog store", () => {
  it("lazily adds the cache table to an existing current-schema database", () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-catalog-")));
    roots.push(root);
    const options = { path: path.join(root, "state.sqlite") };
    openOpenClawStateDatabase(options);
    closeOpenClawStateDatabaseForTest();

    const { DatabaseSync } = requireNodeSqlite();
    const preCatalog = new DatabaseSync(options.path);
    preCatalog.exec("DROP TABLE model_catalog_remote;");
    preCatalog.exec("DROP INDEX idx_task_runs_status;");
    preCatalog.close();

    const reopened = openOpenClawStateDatabase(options);
    expect(
      reopened.db
        .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = ?")
        .get("model_catalog_remote"),
    ).toBeUndefined();
    expect(
      reopened.db
        .prepare("SELECT name FROM sqlite_schema WHERE type = 'index' AND name = ?")
        .get("idx_task_runs_status"),
    ).toEqual({ name: "idx_task_runs_status" });
    closeOpenClawStateDatabaseForTest();

    expect(readRemoteModelCatalog(options)).toBeUndefined();
    const upgraded = new DatabaseSync(options.path, { readOnly: true });
    expect(
      upgraded
        .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = ?")
        .get("model_catalog_remote"),
    ).toEqual({ name: "model_catalog_remote" });
    upgraded.close();
  });

  it("lazily ensures twice and upserts the single slot", () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-catalog-")));
    roots.push(root);
    const options = { path: path.join(root, "state.sqlite") };
    expect(readRemoteModelCatalog(options)).toBeUndefined();
    expect(readRemoteModelCatalog(options)).toBeUndefined();
    writeRemoteModelCatalog(
      {
        bundle_json: '{"schemaVersion":1}',
        generated_at: 1,
        min_version: null,
        source_url: "https://catalog.test/one",
        etag: null,
        last_modified: null,
        checked_at: 2,
      },
      options,
    );
    writeRemoteModelCatalog(
      {
        bundle_json: '{"schemaVersion":1,"updated":true}',
        generated_at: 3,
        min_version: "2026.7.0",
        source_url: "https://catalog.test/two",
        etag: '"two"',
        last_modified: null,
        checked_at: 4,
      },
      options,
    );
    const retained = writeRemoteModelCatalog(
      {
        bundle_json: '{"schemaVersion":1,"older":true}',
        generated_at: 2,
        min_version: null,
        source_url: "https://catalog.test/two",
        etag: '"older"',
        last_modified: null,
        checked_at: 5,
      },
      options,
    );
    expect(retained).toMatchObject({ status: "retained-newer", row: { generated_at: 3 } });
    expect(
      writeRemoteModelCatalog(
        {
          bundle_json: '{"schemaVersion":1,"sameGenerationDifferentBody":true}',
          generated_at: 3,
          min_version: null,
          source_url: "https://catalog.test/two",
          etag: '"different"',
          last_modified: null,
          checked_at: 5,
        },
        options,
      ),
    ).toMatchObject({
      status: "retained-newer",
      row: { bundle_json: expect.stringContaining("updated") },
    });
    expect(
      markRemoteModelCatalogChecked(
        5,
        {
          expected: {
            source_url: "https://catalog.test/two",
            generated_at: 2,
            etag: '"older"',
            last_modified: null,
          },
        },
        options,
      ),
    ).toBe(false);
    expect(
      markRemoteModelCatalogChecked(
        6,
        {
          expected: {
            source_url: "https://catalog.test/two",
            generated_at: 3,
            etag: '"two"',
            last_modified: null,
          },
        },
        options,
      ),
    ).toBe(true);
    expect(readRemoteModelCatalog(options)).toMatchObject({
      id: 1,
      generated_at: 3,
      source_url: "https://catalog.test/two",
      checked_at: 6,
    });
  });
});
