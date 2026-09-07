// Matrix tests cover the released account-state upgrade through the Doctor CLI.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import type { ISyncResponse } from "matrix-js-sdk/lib/matrix.js";
import { resetPluginStateStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteBackedMatrixSyncStore } from "./src/matrix/client/file-sync-store.js";
import { installMatrixTestRuntime } from "./src/test-runtime.js";
import { useAutoCleanupTempDirTracker } from "./test-support.js";

const MATRIX_V2026_7_1_FIXTURE_BASE64 = new URL(
  "./test/fixtures/sqlite/matrix-account-v2026.7.1.sqlite.gz.base64",
  import.meta.url,
);
const MATRIX_V2026_7_1_GZIP_SHA256 =
  "2bbfc5b55c083a1532ac1162baa9a01a886b2bd6f17fb060c6794b2a10f7aeb0";
const MATRIX_V2026_7_1_RAW_SHA256 =
  "d8a543808fe9d4ae3cd989bbae9cb5e3c425fe5ecf8322309e08787fd87ec7f6";

function matrixSyncResponse(nextBatch: string): ISyncResponse {
  return {
    next_batch: nextBatch,
    rooms: { join: {}, invite: {}, leave: {}, knock: {} },
    account_data: { events: [] },
  };
}

function matrixStateRowsSha256(databasePath: string): string {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const rows = database
      .prepare(
        `SELECT plugin_id, namespace, entry_key, value_json, created_at, expires_at
         FROM plugin_state_entries
         WHERE plugin_id = 'matrix'
         ORDER BY namespace, entry_key`,
      )
      .all();
    return createHash("sha256").update(JSON.stringify(rows)).digest("hex");
  } finally {
    database.close();
  }
}

function runMatrixDoctorFix(params: { rootDir: string; stateDir: string }) {
  const configPath = path.join(params.stateDir, "openclaw.json");
  const loaderPath = path.join(params.rootDir, "doctor-test-loader.mjs");
  fs.writeFileSync(
    configPath,
    `${JSON.stringify(
      {
        gateway: {
          mode: "remote",
          remote: { url: "ws://127.0.0.1:1", token: "fixture-token" },
        },
        logging: { file: path.join(params.rootDir, "openclaw.log") },
        plugins: { allow: ["matrix"], entries: { matrix: { enabled: true } } },
      },
      null,
      2,
    )}\n`,
  );
  fs.writeFileSync(
    loaderPath,
    String.raw`import { realpathSync } from "node:fs";
const uiSource = [
  'process.stderr.write("matrix-doctor-fixture:ui\\n");',
  "export async function detectUiProtocolFreshnessIssues() { return []; }",
  "export function uiProtocolFreshnessIssueToHealthFinding() { return {}; }",
  "export function uiProtocolFreshnessIssueToRepairEffects() { return []; }",
  "export async function maybeRepairUiProtocolFreshness() {}",
].join("\n");
const healthSource = [
  'process.stderr.write("matrix-doctor-fixture:health\\n");',
  "export async function runDoctorHealthContributions() {}",
].join("\n");
if (process.versions.bun) {
  const { plugin } = await import("bun");
  const sources = new Map([
    [realpathSync("./src/commands/doctor-ui.ts"), uiSource],
    [realpathSync("./src/flows/doctor-health-contributions.ts"), healthSource],
  ]);
  const escapedPaths = [...sources.keys()].map((path) => path.replace(/[.*+?^$(){}|[\]\\]/g, "\\$&"));
  plugin({
    name: "matrix-doctor-fixture",
    setup(build) {
      build.onLoad({ filter: new RegExp("^(?:" + escapedPaths.join("|") + ")$"), namespace: "file" }, ({ path }) => ({
        contents: sources.get(realpathSync(path)),
        loader: "js",
      }));
    },
  });
} else {
  const { registerHooks } = await import("node:module");
  registerHooks({
    resolve(specifier, context, nextResolve) {
      const source = specifier.endsWith("/doctor-ui.js")
        ? uiSource
        : specifier.endsWith("/doctor-health-contributions.js")
          ? healthSource
          : undefined;
      return source === undefined
        ? nextResolve(specifier, context)
        : { shortCircuit: true, url: "data:text/javascript," + encodeURIComponent(source) };
    },
  });
}
`,
  );
  const entryPath = fileURLToPath(new URL("../../src/entry.ts", import.meta.url));
  return spawnSync(
    process.execPath,
    [
      ...(process.versions.bun ? ["--preload"] : ["--import", "tsx", "--import"]),
      loaderPath,
      entryPath,
      "doctor",
      "--fix",
      "--non-interactive",
      "--no-workspace-suggestions",
      "--no-color",
    ],
    {
      cwd: path.resolve("."),
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: params.rootDir,
        USERPROFILE: params.rootDir,
        NODE_DISABLE_COMPILE_CACHE: "1",
        NODE_ENV: undefined,
        OPENCLAW_CONFIG_PATH: configPath,
        OPENCLAW_DISABLE_BUNDLED_PLUGINS: undefined,
        OPENCLAW_HIDE_BANNER: "1",
        OPENCLAW_HOME: undefined,
        OPENCLAW_NO_RESPAWN: "1",
        OPENCLAW_SKIP_CHANNELS: "1",
        OPENCLAW_STATE_DIR: params.stateDir,
        OPENCLAW_TEST_FAST: "1",
        VITEST: undefined,
        VITEST_POOL_ID: undefined,
        VITEST_WORKER_ID: undefined,
      },
      maxBuffer: 4 * 1024 * 1024,
      timeout: 120_000,
    },
  );
}

describe("Matrix account state Doctor migration", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);

  beforeEach(() => {
    resetPluginStateStoreForTests();
    installMatrixTestRuntime();
  });

  afterEach(() => {
    resetPluginStateStoreForTests();
  });

  it("repairs active account state without opening token-root archives", async () => {
    const stateDir = tempDirs.make("openclaw-matrix-doctor-");
    const storageRootDir = path.join(
      stateDir,
      "matrix",
      "accounts",
      "sync-cache-backup",
      "matrix.example.org__bot",
      "0123456789abcdef",
    );
    const archivedStorageRootDir = path.join(
      stateDir,
      "matrix",
      "accounts",
      "default",
      "matrix.example.org__bot",
      "sync-cache-backup",
    );
    const databasePath = path.join(storageRootDir, "state", "openclaw.sqlite");
    const archivedDatabasePath = path.join(archivedStorageRootDir, "state", "openclaw.sqlite");
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    fs.mkdirSync(path.dirname(archivedDatabasePath), { recursive: true });
    const compressedFixture = Buffer.from(
      fs.readFileSync(MATRIX_V2026_7_1_FIXTURE_BASE64, "utf8").replaceAll(/\s/gu, ""),
      "base64",
    );
    expect(createHash("sha256").update(compressedFixture).digest("hex")).toBe(
      MATRIX_V2026_7_1_GZIP_SHA256,
    );
    const rawFixture = gunzipSync(compressedFixture);
    expect(createHash("sha256").update(rawFixture).digest("hex")).toBe(MATRIX_V2026_7_1_RAW_SHA256);
    fs.writeFileSync(databasePath, rawFixture);
    fs.writeFileSync(archivedDatabasePath, rawFixture);

    const beforeRepairRowsSha256 = matrixStateRowsSha256(databasePath);
    const staleStore = new SqliteBackedMatrixSyncStore(storageRootDir);
    await expect(staleStore.getSavedSyncToken()).resolves.toBe("cursor-a");
    await staleStore.setSyncData(matrixSyncResponse("cursor-after-repair"));
    await expect(staleStore.flush()).rejects.toMatchObject({
      cause: {
        name: "OpenClawStateDatabaseSchemaMigrationRequiredError",
        message: expect.stringContaining("audit-events-v2"),
      },
    });
    resetPluginStateStoreForTests();

    const stale = new DatabaseSync(databasePath, { readOnly: true });
    try {
      expect(stale.prepare("PRAGMA user_version").get()).toEqual({ user_version: 1 });
      expect(stale.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
    } finally {
      stale.close();
    }

    const doctor = runMatrixDoctorFix({ rootDir: stateDir, stateDir });
    const doctorOutput = `${doctor.stderr}\n${doctor.stdout}`;
    expect(doctor.error, doctorOutput).toBeUndefined();
    expect(doctor.signal, doctorOutput).toBeNull();
    expect(doctor.status, doctorOutput).toBe(0);
    expect(doctor.stderr.match(/^matrix-doctor-fixture:(?:ui|health)$/gm)?.toSorted()).toEqual([
      "matrix-doctor-fixture:health",
      "matrix-doctor-fixture:ui",
    ]);
    expect(doctorOutput).toContain(`Matrix account SQLite ${storageRootDir}`);
    expect(doctorOutput).not.toContain(`Matrix account SQLite ${archivedStorageRootDir}`);
    expect(doctorOutput).toContain(
      "Migrated shared state audit event ledger → versioned message lifecycle schema",
    );
    expect(matrixStateRowsSha256(databasePath)).toBe(beforeRepairRowsSha256);
    expect(fs.readFileSync(archivedDatabasePath)).toEqual(rawFixture);

    const repairedStore = new SqliteBackedMatrixSyncStore(storageRootDir);
    await expect(repairedStore.getSavedSyncToken()).resolves.toBe("cursor-a");
    await repairedStore.setSyncData(matrixSyncResponse("cursor-after-repair"));
    await repairedStore.flush();
    resetPluginStateStoreForTests();

    const reopenedStore = new SqliteBackedMatrixSyncStore(storageRootDir);
    await expect(reopenedStore.getSavedSyncToken()).resolves.toBe("cursor-after-repair");
  });
});
