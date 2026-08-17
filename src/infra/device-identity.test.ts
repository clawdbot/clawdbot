// Covers SQLite device identity creation, migration boundaries, and crypto helpers.
import { spawn, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  closeOpenClawStateDatabaseForTest,
  OPENCLAW_STATE_SCHEMA_VERSION,
} from "../state/openclaw-state-db.js";
import { withTempDir } from "../test-utils/temp-dir.js";
import { resolveDeviceIdentityCoordinatorPaths } from "./device-identity-coordinator-paths.js";
import { acquireDeviceIdentityCoordinator } from "./device-identity-coordinator.js";
import { normalizeLegacyDeviceIdentity } from "./device-identity-legacy.js";
import type { DeviceIdentityStoreOptions } from "./device-identity-store.js";
import {
  deriveDeviceIdFromPublicKey,
  loadDeviceIdentityIfPresent,
  loadDeviceIdentityIfPresentReadOnly,
  loadOrCreateDeviceIdentity,
  loadOrCreateProcessDeviceIdentity,
  normalizeDevicePublicKeyBase64Url,
  publicKeyRawBase64UrlFromPem,
  signDevicePayload,
  verifyDeviceSignature,
  type DeviceIdentity,
} from "./device-identity.js";

const SWIFT_RAW_DEVICE_ID = "56475aa75463474c0285df5dbf2bcab73da651358839e9b77481b2eab107708c";
const SWIFT_RAW_PUBLIC_KEY = "A6EHv/POEL4dcN0Y50vAmWfk1jCbpQ1fHdyGZBJVMbg=";
const SWIFT_RAW_PRIVATE_KEY = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8="; // pragma: allowlist secret
const MISMATCHED_SWIFT_RAW_PRIVATE_KEY = "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE="; // pragma: allowlist secret

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  vi.restoreAllMocks();
});

function storeOptions(rootDir: string, identityKey?: string): DeviceIdentityStoreOptions {
  return {
    env: { ...process.env, OPENCLAW_STATE_DIR: rootDir },
    path: path.join(rootDir, "state", "openclaw.sqlite"),
    ...(identityKey ? { identityKey } : {}),
  };
}

function writeRetiredIdentity(filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(
    filePath,
    `${JSON.stringify({
      deviceId: SWIFT_RAW_DEVICE_ID,
      publicKey: SWIFT_RAW_PUBLIC_KEY,
      privateKey: SWIFT_RAW_PRIVATE_KEY,
      createdAtMs: 1_700_000_000_000,
    })}\n`,
  );
}

function waitForChild(child: ChildProcess): Promise<DeviceIdentity> {
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk) => (stdout += String(chunk)));
  child.stderr?.on("data", (chunk) => (stderr += String(chunk)));
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code !== 0) {
        reject(new Error(`identity worker failed (${String(code ?? signal)}): ${stderr}`));
        return;
      }
      const resultLine = stdout.trim().split("\n").at(-1);
      if (!resultLine) {
        reject(new Error("identity worker produced no result"));
        return;
      }
      resolve(JSON.parse(resultLine) as DeviceIdentity);
    });
  });
}

async function runConcurrentIdentityLoads(rootDir: string): Promise<DeviceIdentity[]> {
  const startPath = path.join(rootDir, "identity-start");
  const moduleUrl = new URL("./device-identity.ts", import.meta.url).href;
  const workerSource = `
    import fs from "node:fs";
    const { loadOrCreateDeviceIdentity } = await import(process.env.OPENCLAW_IDENTITY_MODULE);
    fs.writeFileSync(process.env.OPENCLAW_IDENTITY_READY_PATH, "ready");
    const deadline = Date.now() + 15_000;
    while (!fs.existsSync(process.env.OPENCLAW_IDENTITY_START_PATH)) {
      if (Date.now() >= deadline) {
        throw new Error("timed out waiting for concurrent identity start");
      }
      await new Promise((resolve) => {
        setTimeout(resolve, 2);
      });
    }
    const identity = loadOrCreateDeviceIdentity({
      env: { ...process.env, OPENCLAW_STATE_DIR: process.env.OPENCLAW_IDENTITY_STATE_DIR },
      path: process.env.OPENCLAW_IDENTITY_DATABASE_PATH,
    });
    console.log(JSON.stringify(identity));
  `;
  const workers = [0, 1].map((index) => {
    const readyPath = path.join(rootDir, `identity-ready-${index}`);
    const child = spawn(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "-e", workerSource],
      {
        env: {
          ...process.env,
          OPENCLAW_IDENTITY_DATABASE_PATH: path.join(rootDir, "state", "openclaw.sqlite"),
          OPENCLAW_IDENTITY_MODULE: moduleUrl,
          OPENCLAW_IDENTITY_READY_PATH: readyPath,
          OPENCLAW_IDENTITY_START_PATH: startPath,
          OPENCLAW_IDENTITY_STATE_DIR: rootDir,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    return { child, outcome: waitForChild(child), readyPath };
  });

  try {
    const deadline = Date.now() + 15_000;
    while (!workers.every((worker) => fs.existsSync(worker.readyPath))) {
      if (workers.some(({ child }) => child.exitCode !== null || child.signalCode !== null)) {
        break;
      }
      if (Date.now() >= deadline) {
        throw new Error("timed out waiting for concurrent identity workers");
      }
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 2);
      });
    }
    fs.writeFileSync(startPath, "start");
    return await Promise.all(workers.map((worker) => worker.outcome));
  } finally {
    for (const { child } of workers) {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill();
      }
    }
    await Promise.allSettled(workers.map((worker) => worker.outcome));
  }
}

async function startPausedBootstrapCreator(rootDir: string): Promise<{
  committedPath: string;
  continuePath: string;
  outcome: Promise<DeviceIdentity>;
  child: ChildProcess;
}> {
  const databasePath = path.join(rootDir, "state", "openclaw.sqlite");
  const readyPath = path.join(rootDir, "bootstrap-ready");
  const committedPath = path.join(rootDir, "bootstrap-committed");
  const continuePath = path.join(rootDir, "bootstrap-continue");
  const coordinatorModuleUrl = new URL("./device-identity-coordinator.ts", import.meta.url).href;
  const storeModuleUrl = new URL("./device-identity-store.ts", import.meta.url).href;
  const workerSource = `
    import fs from "node:fs";
    import path from "node:path";
    import { DatabaseSync } from "node:sqlite";
    const { acquireDeviceIdentityCoordinator } = await import(process.env.OPENCLAW_COORDINATOR_MODULE);
    const { generateStoredDeviceIdentity, insertStoredDeviceIdentityIfAbsent } =
      await import(process.env.OPENCLAW_IDENTITY_STORE_MODULE);
    const options = {
      env: { ...process.env, OPENCLAW_STATE_DIR: process.env.OPENCLAW_IDENTITY_STATE_DIR },
      path: process.env.OPENCLAW_IDENTITY_DATABASE_PATH,
    };
    const coordinator = acquireDeviceIdentityCoordinator({
      databasePath: options.path,
      stateDir: process.env.OPENCLAW_IDENTITY_STATE_DIR,
    });
    try {
      fs.mkdirSync(path.dirname(options.path), { recursive: true });
      new DatabaseSync(options.path).close();
      fs.writeFileSync(process.env.OPENCLAW_IDENTITY_READY_PATH, "ready");
      const deadline = Date.now() + 15_000;
      while (!fs.existsSync(process.env.OPENCLAW_IDENTITY_CONTINUE_PATH)) {
        if (Date.now() >= deadline) throw new Error("timed out waiting to continue bootstrap");
        await new Promise((resolve) => setTimeout(resolve, 2));
      }
      const stored = insertStoredDeviceIdentityIfAbsent(generateStoredDeviceIdentity(), options);
      fs.writeFileSync(process.env.OPENCLAW_IDENTITY_COMMITTED_PATH, "committed");
      console.log(JSON.stringify({
        deviceId: stored.deviceId,
        publicKeyPem: stored.publicKeyPem,
        privateKeyPem: stored.privateKeyPem,
      }));
    } finally {
      coordinator.release();
    }
  `;
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "-e", workerSource],
    {
      env: {
        ...process.env,
        OPENCLAW_IDENTITY_COMMITTED_PATH: committedPath,
        OPENCLAW_COORDINATOR_MODULE: coordinatorModuleUrl,
        OPENCLAW_IDENTITY_CONTINUE_PATH: continuePath,
        OPENCLAW_IDENTITY_DATABASE_PATH: databasePath,
        OPENCLAW_IDENTITY_READY_PATH: readyPath,
        OPENCLAW_IDENTITY_STATE_DIR: rootDir,
        OPENCLAW_IDENTITY_STORE_MODULE: storeModuleUrl,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const outcome = waitForChild(child);
  const deadline = Date.now() + 15_000;
  while (!fs.existsSync(readyPath)) {
    if (child.exitCode !== null || child.signalCode !== null) {
      await outcome;
    }
    if (Date.now() >= deadline) {
      child.kill();
      throw new Error("timed out waiting for paused bootstrap creator");
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 2);
    });
  }
  return { child, committedPath, continuePath, outcome };
}

function waitForFileSync(filePath: string): void {
  const deadline = Date.now() + 15_000;
  const waitBuffer = new Int32Array(new SharedArrayBuffer(4));
  while (!fs.existsSync(filePath)) {
    if (Date.now() >= deadline) {
      throw new Error(`timed out waiting for ${filePath}`);
    }
    Atomics.wait(waitBuffer, 0, 0, 2);
  }
}

describe("device identity SQLite store", () => {
  it("serializes identity ownership with the shared SQLite coordinator", async () => {
    await withTempDir("openclaw-device-identity-coordinator-", async (rootDir) => {
      const databasePath = path.join(rootDir, "state", "openclaw.sqlite");
      const lockDir = path.join(rootDir, "locks");
      const first = acquireDeviceIdentityCoordinator({ databasePath, lockDir, busyTimeoutMs: 0 });
      try {
        expect(() =>
          acquireDeviceIdentityCoordinator({ databasePath, lockDir, busyTimeoutMs: 0 }),
        ).toThrow(/migration or creation already owns this state database/);
      } finally {
        first.release();
      }

      const next = acquireDeviceIdentityCoordinator({ databasePath, lockDir, busyTimeoutMs: 0 });
      next.release();

      fs.chmodSync(lockDir, 0o755);
      const secured = acquireDeviceIdentityCoordinator({ databasePath, lockDir, busyTimeoutMs: 0 });
      try {
        expect(fs.statSync(lockDir).mode & 0o077).toBe(0);
      } finally {
        secured.release();
      }

      const symlinkLockDir = path.join(rootDir, "symlink-locks");
      fs.symlinkSync(lockDir, symlinkLockDir);
      expect(() =>
        acquireDeviceIdentityCoordinator({
          databasePath,
          lockDir: symlinkLockDir,
          busyTimeoutMs: 0,
        }),
      ).toThrow(/real directory/);
    });
  });

  it("bridges process-temp and state-local coordinator owners", async () => {
    await withTempDir("openclaw-device-identity-bridge-", async (rawRootDir) => {
      const rootDir = fs.realpathSync.native(rawRootDir);
      const databasePath = path.join(rootDir, "selected-state", "state", "openclaw.sqlite");
      const stateDir = path.join(rootDir, "selected-state");
      const temporaryDirectory = path.join(rootDir, "process-temp");
      fs.mkdirSync(temporaryDirectory, { recursive: true });
      vi.spyOn(os, "tmpdir").mockReturnValue(temporaryDirectory);

      const paths = resolveDeviceIdentityCoordinatorPaths({
        databasePath,
        stateDir,
        temporaryDirectory,
        uid: typeof process.getuid === "function" ? process.getuid() : undefined,
      });
      expect(paths).toHaveLength(2);
      const processTempPath = paths[0];
      const stateLocalPath = paths[1];
      if (!processTempPath || !stateLocalPath) {
        throw new Error("coordinator bridge paths are unavailable");
      }
      const processTempLockDir = path.dirname(processTempPath);
      const stateLockDir = path.dirname(stateLocalPath);

      const stateOnly = acquireDeviceIdentityCoordinator({
        databasePath,
        lockDir: stateLockDir,
        busyTimeoutMs: 0,
      });
      try {
        expect(() =>
          acquireDeviceIdentityCoordinator({ databasePath, stateDir, busyTimeoutMs: 0 }),
        ).toThrow(/migration or creation already owns this state database/);
        const oldAfterPartialFailure = acquireDeviceIdentityCoordinator({
          databasePath,
          lockDir: processTempLockDir,
          busyTimeoutMs: 0,
        });
        oldAfterPartialFailure.release();
      } finally {
        stateOnly.release();
      }

      const dual = acquireDeviceIdentityCoordinator({ databasePath, stateDir, busyTimeoutMs: 0 });
      try {
        expect(() =>
          acquireDeviceIdentityCoordinator({
            databasePath,
            lockDir: processTempLockDir,
            busyTimeoutMs: 0,
          }),
        ).toThrow(/migration or creation already owns this state database/);
        expect(() =>
          acquireDeviceIdentityCoordinator({
            databasePath,
            lockDir: stateLockDir,
            busyTimeoutMs: 0,
          }),
        ).toThrow(/migration or creation already owns this state database/);
      } finally {
        dual.release();
      }

      const oldRuntime = acquireDeviceIdentityCoordinator({
        databasePath,
        lockDir: processTempLockDir,
        busyTimeoutMs: 0,
      });
      const transitionalRuntime = acquireDeviceIdentityCoordinator({
        databasePath,
        lockDir: stateLockDir,
        busyTimeoutMs: 0,
      });
      transitionalRuntime.release();
      oldRuntime.release();
    });
  });

  it("reads a missing database without creating identity state or coordinator locks", async () => {
    await withTempDir("openclaw-device-identity-readonly-", async (rootDir) => {
      const temporaryDirectory = path.join(rootDir, "tmp");
      fs.mkdirSync(temporaryDirectory);
      vi.spyOn(os, "tmpdir").mockReturnValue(temporaryDirectory);
      const options = storeOptions(rootDir);
      const coordinatorPaths = resolveDeviceIdentityCoordinatorPaths({
        databasePath: options.path!,
        stateDir: rootDir,
        temporaryDirectory,
        uid: typeof process.getuid === "function" ? process.getuid() : undefined,
      });

      expect(loadDeviceIdentityIfPresent(options)).toBeNull();
      expect(fs.existsSync(options.path!)).toBe(false);
      expect(fs.existsSync(path.dirname(options.path!))).toBe(false);
      expect(coordinatorPaths.every((coordinatorPath) => !fs.existsSync(coordinatorPath))).toBe(
        true,
      );
      expect(fs.existsSync(path.join(rootDir, "locks"))).toBe(false);
    });
  });

  it("reads a missing database without creating coordinator artifacts", async () => {
    await withTempDir("openclaw-device-identity-artifact-free-", async (rootDir) => {
      const options = storeOptions(rootDir);
      const coordinatorPaths = resolveDeviceIdentityCoordinatorPaths({
        databasePath: options.path!,
        stateDir: rootDir,
        temporaryDirectory: os.tmpdir(),
        uid: typeof process.getuid === "function" ? process.getuid() : undefined,
      });

      expect(loadDeviceIdentityIfPresentReadOnly(options)).toBeNull();
      expect(fs.existsSync(options.path!)).toBe(false);
      for (const coordinatorPath of coordinatorPaths) {
        expect(fs.existsSync(coordinatorPath)).toBe(false);
      }
    });
  });

  it("reads an existing identity without changing canonical SQLite artifacts", async () => {
    await withTempDir("openclaw-device-identity-artifact-preserving-", async (rootDir) => {
      const options = storeOptions(rootDir);
      const created = loadOrCreateDeviceIdentity(options);
      closeOpenClawStateDatabaseForTest();
      const databaseDirectory = path.dirname(options.path!);
      const artifactsBeforeRead = fs.readdirSync(databaseDirectory).toSorted();

      expect(loadDeviceIdentityIfPresentReadOnly(options)).toEqual(created);
      expect(fs.readdirSync(databaseDirectory).toSorted()).toEqual(artifactsBeforeRead);
    });
  });

  it("creates and reuses the primary identity in SQLite", async () => {
    await withTempDir("openclaw-device-identity-create-", async (rootDir) => {
      const options = storeOptions(rootDir);
      const created = loadOrCreateDeviceIdentity(options);
      const loaded = loadOrCreateDeviceIdentity(options);

      expect(loaded).toEqual(created);
      expect(loadDeviceIdentityIfPresent(options)).toEqual(created);
      expect(fs.existsSync(options.path!)).toBe(true);
      expect(fs.existsSync(path.join(rootDir, "identity", "device.json"))).toBe(false);
    });
  });

  it("keeps empty-bootstrap classification on the pre-commit read snapshot", async () => {
    await withTempDir("openclaw-device-identity-bootstrap-read-", async (rootDir) => {
      const creator = await startPausedBootstrapCreator(rootDir);
      try {
        const sqlite = await import("node:sqlite");
        // oxlint-disable-next-line typescript/unbound-method -- called below with the intercepted database receiver.
        const prepare = sqlite.DatabaseSync.prototype.prepare;
        let committedDuringRead = false;
        vi.spyOn(sqlite.DatabaseSync.prototype, "prepare").mockImplementation(
          function (this: InstanceType<typeof sqlite.DatabaseSync>, sql) {
            try {
              return prepare.call(this, sql);
            } catch (error) {
              if (!committedDuringRead && /device_identities/iu.test(sql)) {
                committedDuringRead = true;
                fs.writeFileSync(creator.continuePath, "continue");
                waitForFileSync(creator.committedPath);
              }
              throw error;
            }
          },
        );

        expect(loadDeviceIdentityIfPresent(storeOptions(rootDir))).toBeNull();
        expect(committedDuringRead).toBe(true);

        const committed = await creator.outcome;
        expect(loadDeviceIdentityIfPresent(storeOptions(rootDir))).toEqual(committed);
      } finally {
        if (creator.child.exitCode === null && creator.child.signalCode === null) {
          fs.writeFileSync(creator.continuePath, "continue");
          creator.child.kill();
        }
        await Promise.allSettled([creator.outcome]);
      }
    });
  }, 30_000);

  it("does not classify a partial schema as an identity bootstrap miss", async () => {
    await withTempDir("openclaw-device-identity-partial-schema-", async (rootDir) => {
      const options = storeOptions(rootDir);
      fs.mkdirSync(path.dirname(options.path!), { recursive: true });
      const sqlite = await import("node:sqlite");
      const database = new sqlite.DatabaseSync(options.path!);
      database.exec("CREATE TABLE unrelated_state (id INTEGER PRIMARY KEY) STRICT;");
      database.close();

      expect(() => loadDeviceIdentityIfPresent(options)).toThrow(
        /no such table: device_identities/,
      );
    });
  });

  it("adopts a Swift-created version-zero identity database and completes the shared schema", async () => {
    await withTempDir("openclaw-device-identity-swift-db-", async (rootDir) => {
      const options = storeOptions(rootDir);
      const expected = normalizeLegacyDeviceIdentity({
        deviceId: SWIFT_RAW_DEVICE_ID,
        publicKey: SWIFT_RAW_PUBLIC_KEY,
        privateKey: SWIFT_RAW_PRIVATE_KEY,
        createdAtMs: 1_700_000_000_000,
      });
      if (!expected) {
        throw new Error("Swift identity fixture must normalize");
      }
      fs.mkdirSync(path.dirname(options.path!), { recursive: true });
      const sqlite = await import("node:sqlite");
      const database = new sqlite.DatabaseSync(options.path!);
      database.exec(`
        CREATE TABLE device_identities (
          identity_key TEXT NOT NULL PRIMARY KEY,
          device_id TEXT NOT NULL,
          public_key_pem TEXT NOT NULL,
          private_key_pem TEXT NOT NULL,
          created_at_ms INTEGER NOT NULL,
          updated_at_ms INTEGER NOT NULL
        ) STRICT;
        CREATE INDEX idx_device_identities_device
          ON device_identities(device_id, updated_at_ms DESC);
      `);
      database
        .prepare(`
          INSERT INTO device_identities (
            identity_key, device_id, public_key_pem, private_key_pem, created_at_ms, updated_at_ms
          ) VALUES (?, ?, ?, ?, ?, ?)
        `)
        .run(
          "primary",
          expected.deviceId,
          expected.publicKeyPem,
          expected.privateKeyPem,
          expected.createdAtMs,
          expected.createdAtMs,
        );
      database.close();

      expect(loadOrCreateDeviceIdentity(options)).toEqual({
        deviceId: expected.deviceId,
        publicKeyPem: expected.publicKeyPem,
        privateKeyPem: expected.privateKeyPem,
      });
      closeOpenClawStateDatabaseForTest();
      const verified = new sqlite.DatabaseSync(options.path!, { readOnly: true });
      expect(verified.prepare("PRAGMA user_version").get()).toEqual({
        user_version: OPENCLAW_STATE_SCHEMA_VERSION,
      });
      expect(
        verified
          .prepare("SELECT role, schema_version FROM schema_meta WHERE meta_key = 'primary'")
          .get(),
      ).toEqual({ role: "global", schema_version: OPENCLAW_STATE_SCHEMA_VERSION });
      verified.close();
    });
  });

  it("keeps process identities cached by database path and identity key", async () => {
    await withTempDir("openclaw-device-identity-cache-", async (rootDir) => {
      const primaryOptions = storeOptions(rootDir);
      const secondaryOptions = storeOptions(rootDir, "secondary");
      const primary = loadOrCreateProcessDeviceIdentity(primaryOptions);
      const secondary = loadOrCreateProcessDeviceIdentity(secondaryOptions);

      expect(loadOrCreateProcessDeviceIdentity(primaryOptions)).toBe(primary);
      expect(loadOrCreateProcessDeviceIdentity(secondaryOptions)).toBe(secondary);
      expect(secondary.deviceId).not.toBe(primary.deviceId);

      const claimPath = path.join(rootDir, "identity", "device.json.doctor-importing");
      writeRetiredIdentity(claimPath);
      expect(loadOrCreateProcessDeviceIdentity(primaryOptions)).toBe(primary);
      expect(fs.existsSync(claimPath)).toBe(true);
    });
  });

  it.each(["device.json", "device.json.doctor-importing", "device.json.native-importing"])(
    "keeps canonical SQLite authoritative when retired %s reappears",
    async (legacyName) => {
      await withTempDir("openclaw-device-identity-canonical-", async (rootDir) => {
        const options = storeOptions(rootDir);
        const canonical = loadOrCreateDeviceIdentity(options);
        expect(canonical.deviceId).not.toBe(SWIFT_RAW_DEVICE_ID);
        closeOpenClawStateDatabaseForTest();

        const legacyPath = path.join(rootDir, "identity", legacyName);
        writeRetiredIdentity(legacyPath);

        expect(loadDeviceIdentityIfPresent(options)).toEqual(canonical);
        expect(loadOrCreateDeviceIdentity(options)).toEqual(canonical);
        expect(fs.existsSync(legacyPath)).toBe(true);
      });
    },
  );

  it("returns one authoritative winner to concurrent creators", async () => {
    await withTempDir("openclaw-device-identity-concurrent-", async (rootDir) => {
      const [first, second] = await runConcurrentIdentityLoads(rootDir);

      expect(second).toEqual(first);
      expect(loadDeviceIdentityIfPresent(storeOptions(rootDir))).toEqual(first);
    });
  }, 30_000);

  it("fails closed for a corrupt persisted row", async () => {
    await withTempDir("openclaw-device-identity-corrupt-", async (rootDir) => {
      const options = storeOptions(rootDir);
      loadOrCreateDeviceIdentity(options);
      closeOpenClawStateDatabaseForTest();

      const sqlite = await import("node:sqlite");
      const database = new sqlite.DatabaseSync(options.path!);
      database
        .prepare("UPDATE device_identities SET device_id = ? WHERE identity_key = ?")
        .run("corrupt-device-id", "primary");
      database.close();

      expect(() => loadDeviceIdentityIfPresent(options)).toThrow(
        /invalid persisted device identity/,
      );
      expect(() => loadOrCreateDeviceIdentity(options)).toThrow(
        /invalid persisted device identity/,
      );
    });
  });

  it.each(["device.json", "device.json.doctor-importing", "device.json.native-importing"])(
    "blocks SQLite access while legacy %s may exist",
    async (legacyName) => {
      await withTempDir("openclaw-device-identity-legacy-", async (rootDir) => {
        const options = storeOptions(rootDir);
        const legacyPath = path.join(rootDir, "identity", legacyName);
        fs.mkdirSync(path.dirname(legacyPath), { recursive: true });
        fs.writeFileSync(legacyPath, "{}\n");

        expect(() => loadDeviceIdentityIfPresent(options)).toThrow(/doctor --fix/);
        expect(() => loadOrCreateDeviceIdentity(options)).toThrow(/doctor --fix/);
        expect(fs.existsSync(options.path!)).toBe(false);
      });
    },
  );

  it.each([
    ["canonical", (rootDir: string) => path.join(rootDir, "state", "openclaw.sqlite")],
    ["arbitrary", (rootDir: string) => path.join(rootDir, "identity-state.sqlite")],
  ])("derives the legacy root from an explicit %s database path", async (_label, dbPath) => {
    await withTempDir("openclaw-device-identity-explicit-path-", async (rootDir) => {
      const legacyPath = path.join(rootDir, "identity", "device.json");
      fs.mkdirSync(path.dirname(legacyPath), { recursive: true });
      fs.writeFileSync(legacyPath, "{}\n");

      expect(() => loadOrCreateDeviceIdentity({ path: dbPath(rootDir) })).toThrow(/doctor --fix/);
    });
  });
});

describe("legacy device identity normalization", () => {
  it("normalizes valid Node PEM material and derives its canonical device id", () => {
    const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
    const publicKeyPem = publicKey.export({ type: "spki", format: "pem" });
    const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" });
    const normalized = normalizeLegacyDeviceIdentity({
      version: 1,
      deviceId: "stale-device-id",
      publicKeyPem,
      privateKeyPem,
      createdAtMs: 1_700_000_000_000,
    });

    expect(normalized).toMatchObject({
      deviceId: deriveDeviceIdFromPublicKey(publicKeyPem),
      publicKeyPem,
      privateKeyPem,
      createdAtMs: 1_700_000_000_000,
    });
  });

  it("converts valid Swift raw-key material to PEM", () => {
    const normalized = normalizeLegacyDeviceIdentity({
      deviceId: SWIFT_RAW_DEVICE_ID,
      publicKey: SWIFT_RAW_PUBLIC_KEY,
      privateKey: SWIFT_RAW_PRIVATE_KEY,
      createdAtMs: 1_700_000_000_000,
    });

    expect(normalized?.deviceId).toBe(SWIFT_RAW_DEVICE_ID);
    expect(normalized?.createdAtMs).toBe(1_700_000_000_000);
    expect(crypto.createPublicKey(normalized?.publicKeyPem ?? "").asymmetricKeyType).toBe(
      "ed25519",
    );
    expect(crypto.createPrivateKey(normalized?.privateKeyPem ?? "").asymmetricKeyType).toBe(
      "ed25519",
    );
  });

  it("rejects mismatched or malformed legacy key material", () => {
    expect(
      normalizeLegacyDeviceIdentity({
        deviceId: SWIFT_RAW_DEVICE_ID,
        publicKey: SWIFT_RAW_PUBLIC_KEY,
        privateKey: MISMATCHED_SWIFT_RAW_PRIVATE_KEY,
        createdAtMs: 1_700_000_000_000,
      }),
    ).toBeNull();
    expect(
      normalizeLegacyDeviceIdentity({
        version: 1,
        deviceId: SWIFT_RAW_DEVICE_ID,
        publicKeyPem: "not-a-key",
        privateKeyPem: "not-a-key",
        createdAtMs: Number.NaN,
      }),
    ).toBeNull();
  });
});

describe("device identity crypto helpers", () => {
  it("preserves existing public-key wire normalization", () => {
    const { publicKey } = crypto.generateKeyPairSync("ed25519");
    const publicKeyPem = publicKey.export({ type: "spki", format: "pem" });
    const publicKeyRaw = publicKeyRawBase64UrlFromPem(publicKeyPem);
    const standardBase64 = `${publicKeyRaw.replaceAll("-", "+").replaceAll("_", "/")}=`;

    expect(normalizeDevicePublicKeyBase64Url(publicKeyPem)).toBe(publicKeyRaw);
    expect(normalizeDevicePublicKeyBase64Url(standardBase64)).toBe(publicKeyRaw);
    expect(normalizeDevicePublicKeyBase64Url(`${standardBase64}=`)).toBe(publicKeyRaw);
    expect(deriveDeviceIdFromPublicKey(publicKeyRaw)).toBe(
      deriveDeviceIdFromPublicKey(publicKeyPem),
    );
  });

  it("signs payloads that verify against PEM and raw public key forms", () => {
    const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
    const publicKeyPem = publicKey.export({ type: "spki", format: "pem" });
    const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" });
    const payload = JSON.stringify({ action: "system.run", ts: 1234 });
    const signature = signDevicePayload(privateKeyPem, payload);
    const publicKeyRaw = publicKeyRawBase64UrlFromPem(publicKeyPem);

    expect(verifyDeviceSignature(publicKeyPem, payload, signature)).toBe(true);
    expect(verifyDeviceSignature(publicKeyRaw, payload, signature)).toBe(true);
    expect(verifyDeviceSignature(publicKeyRaw, `${payload}!`, signature)).toBe(false);
  });
});
