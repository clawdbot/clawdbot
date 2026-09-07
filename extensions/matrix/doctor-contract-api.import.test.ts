import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "./test-support.js";

// Exercise real empty-state operations without materializing client runtimes.
vi.mock("matrix-js-sdk/lib/matrix.js", () => {
  throw new Error("Matrix SDK loaded by a Doctor migration");
});
vi.mock("fake-indexeddb", () => {
  throw new Error("IndexedDB runtime loaded without a legacy snapshot");
});
vi.mock("openclaw/plugin-sdk/doctor-repair-runtime", () => {
  throw new Error("Schema repair runtime loaded without an account database");
});
vi.mock("./src/matrix/client/storage.js", () => {
  throw new Error("Client storage loaded by an absent-state Doctor migration");
});
vi.mock("./src/account-selection.js", () => {
  throw new Error("Account topology loaded without legacy credential sources");
});

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it("completes absent legacy-state checks without loading client runtimes", async () => {
  const stateDir = tempDirs.make("openclaw-matrix-doctor-import-");
  const { stateMigrations } = await import("./doctor-contract-api.js");
  const openPluginStateKeyedStore = vi.fn(() => {
    throw new Error("absent legacy sources must not open a state store");
  });
  const params = {
    config: {},
    env: { HOME: stateDir, OPENCLAW_STATE_DIR: stateDir },
    stateDir,
    oauthDir: path.join(stateDir, "oauth"),
    context: { openPluginStateKeyedStore },
  };
  for (const id of [
    "matrix-account-sqlite-schema",
    "matrix-storage-meta-json-to-plugin-state",
    "matrix-sync-cache-json-to-plugin-state",
    "matrix-legacy-crypto-migration-json-to-plugin-state",
  ]) {
    const migration = stateMigrations.find((entry) => entry.id === id);
    if (!migration) {
      throw new Error(`Missing migration: ${id}`);
    }
    await expect(migration.detectLegacyState(params)).resolves.toBeNull();
    await expect(migration.migrateLegacyState(params)).resolves.toEqual({
      changes: [],
      warnings: [],
    });
  }
  const credentials = stateMigrations.find(
    (entry) => entry.id === "matrix-credentials-json-to-plugin-state",
  );
  if (!credentials) {
    throw new Error("Missing credential migration");
  }
  await expect(credentials.detectLegacyState(params)).resolves.toBeNull();
  const credentialsDir = path.join(stateDir, "credentials", "matrix");
  fs.mkdirSync(credentialsDir, { recursive: true });
  await expect(credentials.detectLegacyState(params)).resolves.toBeNull();
  fs.writeFileSync(path.join(credentialsDir, "unrelated.json"), "{}");
  fs.mkdirSync(path.join(credentialsDir, "credentials-ops.json"));
  await expect(credentials.detectLegacyState(params)).resolves.toBeNull();
  expect(openPluginStateKeyedStore).not.toHaveBeenCalled();
});
