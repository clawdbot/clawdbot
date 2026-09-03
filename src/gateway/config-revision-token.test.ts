import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { assertSqliteSchemaContains } from "../infra/sqlite-schema-contract.js";
import { tableExists } from "../state/openclaw-state-db-schema-helpers.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { getOpenClawStateRuntimeSchema } from "../state/openclaw-state-schema-compatibility.js";
import { loadGatewayConfigRevisionProjector } from "./config-revision-token.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function stateOptions() {
  return { path: join(tempDirs.make("openclaw-config-revision-"), "openclaw.sqlite") };
}

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
});

describe("Gateway config revision tokens", () => {
  it("lazily persists one opaque domain-separated key without changing schema version", () => {
    const options = stateOptions();
    const database = openOpenClawStateDatabase(options).db;
    const schemaVersion = database.prepare("PRAGMA user_version").get()?.user_version;
    database.exec("DROP TABLE config_revision_keys;");
    closeOpenClawStateDatabaseForTest();
    const reopened = openOpenClawStateDatabase(options).db;
    expect(tableExists(reopened, "config_revision_keys")).toBe(false);

    const projector = loadGatewayConfigRevisionProjector(options);
    const rawHash = "9ef81838b8fc191a44f1d20308dbb4e6d961dc7ee1294f9d4bd92471bde9475a";
    const rawToken = projector.projectRawHash(rawHash);
    const resolvedToken = projector.projectResolvedHash(rawHash);
    const keyRow = reopened
      .prepare("SELECT hmac_key FROM config_revision_keys WHERE id = 1")
      .get() as { hmac_key: Uint8Array };

    expect(reopened.prepare("PRAGMA user_version").get()?.user_version).toBe(schemaVersion);
    expect(keyRow.hmac_key).toHaveLength(32);
    expect(rawToken).toMatch(/^hmac-sha256:v1:[A-Za-z0-9_-]{43}$/u);
    expect(rawToken).not.toContain(rawHash);
    expect(rawToken).not.toContain(Buffer.from(keyRow.hmac_key).toString("hex"));
    expect(rawToken).not.toContain(Buffer.from(keyRow.hmac_key).toString("base64url"));
    expect(resolvedToken).not.toBe(rawToken);
    expect(projector.projectRawHash(rawHash)).toBe(rawToken);
    expect(projector.projectRawHash(`${rawHash}0`)).not.toBe(rawToken);
    expect(() =>
      assertSqliteSchemaContains(
        reopened,
        "previous state-schema reader",
        getOpenClawStateRuntimeSchema({ includeVersionLazyAdditiveTables: false }),
      ),
    ).not.toThrow();

    closeOpenClawStateDatabaseForTest();
    expect(loadGatewayConfigRevisionProjector(options).projectRawHash(rawHash)).toBe(rawToken);
  });

  it("fails closed instead of replacing corrupt persisted key material", () => {
    const options = stateOptions();
    loadGatewayConfigRevisionProjector(options);
    const database = openOpenClawStateDatabase(options).db;
    database.exec("PRAGMA ignore_check_constraints = ON;");
    database
      .prepare("UPDATE config_revision_keys SET hmac_key = ? WHERE id = 1")
      .run(randomBytes(31));
    database.exec("PRAGMA ignore_check_constraints = OFF;");

    expect(() => loadGatewayConfigRevisionProjector(options)).toThrow(
      "config revision key is corrupt",
    );
    expect(
      database
        .prepare("SELECT length(hmac_key) AS size FROM config_revision_keys WHERE id = 1")
        .get(),
    ).toEqual({ size: 31 });
  });
});
