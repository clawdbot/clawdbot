// Covers fail-closed Doctor import of the retired primary device identity JSON.
import { createHash, generateKeyPairSync } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import {
  normalizeLegacyDeviceIdentity,
  type NormalizedLegacyDeviceIdentity,
} from "./device-identity-legacy.js";
import { deriveDeviceIdFromPublicKey } from "./device-identity.js";
import { acquireGatewayLock } from "./gateway-lock.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "./kysely-sync.js";
import {
  detectLegacyDeviceIdentity,
  migrateLegacyDeviceIdentity,
} from "./state-migrations.device-identity.js";

type MigrationDatabase = Pick<
  OpenClawStateKyselyDatabase,
  "device_auth_tokens" | "device_identities" | "migration_sources"
>;

const CREATED_AT_MS = 1_700_000_000_000;
const SWIFT_RAW_DEVICE_ID = "56475aa75463474c0285df5dbf2bcab73da651358839e9b77481b2eab107708c";
const SWIFT_RAW_PUBLIC_KEY = "A6EHv/POEL4dcN0Y50vAmWfk1jCbpQ1fHdyGZBJVMbg=";
const SWIFT_RAW_PRIVATE_KEY = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8="; // pragma: allowlist secret

describe("legacy device identity Doctor migration", () => {
  const tempDirs = useAutoCleanupTempDirTracker((cleanup) => {
    afterEach(() => {
      closeOpenClawStateDatabaseForTest();
      cleanup();
    });
  });

  function useStateDir(): { env: NodeJS.ProcessEnv; stateDir: string } {
    const stateDir = tempDirs.make("openclaw-device-identity-migration-");
    return {
      env: { ...process.env, HOME: stateDir, OPENCLAW_STATE_DIR: stateDir },
      stateDir,
    };
  }

  function database(env: NodeJS.ProcessEnv) {
    return openOpenClawStateDatabase({ env }).db;
  }

  function swiftIdentity() {
    return {
      deviceId: SWIFT_RAW_DEVICE_ID,
      publicKey: SWIFT_RAW_PUBLIC_KEY,
      privateKey: SWIFT_RAW_PRIVATE_KEY,
      createdAtMs: CREATED_AT_MS,
    };
  }

  function normalizedSwift(): NormalizedLegacyDeviceIdentity {
    const normalized = normalizeLegacyDeviceIdentity(swiftIdentity());
    if (!normalized) {
      throw new Error("expected valid Swift identity fixture");
    }
    return normalized;
  }

  function nodeIdentity() {
    const identity = normalizedSwift();
    return {
      version: 1,
      deviceId: identity.deviceId,
      publicKeyPem: identity.publicKeyPem,
      privateKeyPem: identity.privateKeyPem,
      createdAtMs: identity.createdAtMs,
    };
  }

  function anotherIdentity(): NormalizedLegacyDeviceIdentity {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const publicKeyPem = publicKey.export({ type: "spki", format: "pem" });
    const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" });
    const deviceId = deriveDeviceIdFromPublicKey(publicKeyPem);
    if (!deviceId) {
      throw new Error("expected generated device id");
    }
    return { deviceId, publicKeyPem, privateKeyPem, createdAtMs: CREATED_AT_MS + 1 };
  }

  function rewrapPem(pem: string): string {
    const [header, ...rest] = pem.trim().split("\n");
    const footer = rest.pop();
    if (!header || !footer) {
      throw new Error("expected PEM fixture");
    }
    const lines = rest.join("").match(/.{1,20}/g) ?? [];
    return `${header}\n${lines.join("\n")}\n${footer}\n`;
  }

  async function writeLegacy(params: {
    stateDir: string;
    value?: unknown;
    bytes?: Buffer;
  }): Promise<string> {
    const sourcePath = path.join(params.stateDir, "identity", "device.json");
    await fsp.mkdir(path.dirname(sourcePath), { recursive: true });
    await fsp.writeFile(
      sourcePath,
      params.bytes ?? Buffer.from(`${JSON.stringify(params.value ?? nodeIdentity())}\n`, "utf8"),
    );
    return sourcePath;
  }

  function identityRow(env: NodeJS.ProcessEnv) {
    const db = database(env);
    return executeSqliteQueryTakeFirstSync(
      db,
      getNodeSqliteKysely<MigrationDatabase>(db)
        .selectFrom("device_identities")
        .selectAll()
        .where("identity_key", "=", "primary"),
    );
  }

  function receipt(env: NodeJS.ProcessEnv) {
    const db = database(env);
    return executeSqliteQueryTakeFirstSync(
      db,
      getNodeSqliteKysely<MigrationDatabase>(db)
        .selectFrom("migration_sources")
        .selectAll()
        .where("migration_kind", "=", "legacy-device-identity-json"),
    );
  }

  function seedCanonical(env: NodeJS.ProcessEnv, identity: NormalizedLegacyDeviceIdentity): void {
    const db = database(env);
    executeSqliteQuerySync(
      db,
      getNodeSqliteKysely<MigrationDatabase>(db)
        .insertInto("device_identities")
        .values({
          identity_key: "primary",
          device_id: identity.deviceId,
          public_key_pem: identity.publicKeyPem,
          private_key_pem: identity.privateKeyPem,
          created_at_ms: identity.createdAtMs,
          updated_at_ms: identity.createdAtMs + 10,
        }),
    );
  }

  function seedInvalidCanonical(env: NodeJS.ProcessEnv): void {
    const db = database(env);
    executeSqliteQuerySync(
      db,
      getNodeSqliteKysely<MigrationDatabase>(db)
        .insertInto("device_identities")
        .values({
          identity_key: "primary",
          device_id: "0".repeat(64),
          public_key_pem: "invalid-public-key",
          private_key_pem: "invalid-private-key",
          created_at_ms: 1,
          updated_at_ms: 2,
        }),
    );
  }

  async function migrate(
    stateDir: string,
    env: NodeJS.ProcessEnv,
    overrides: {
      beforeClaim?: (sourcePath: string) => void;
      beforeCleanup?: () => void;
      removeSource?: (sourcePath: string) => Promise<void> | void;
    } = {},
  ) {
    return await migrateLegacyDeviceIdentity({
      detected: detectLegacyDeviceIdentity({
        stateDir,
        env,
        doctorOnlyStateMigrations: true,
      }),
      stateDir,
      env,
      doctorOnlyStateMigrations: true,
      ...overrides,
    });
  }

  it("detects exact source and claim paths only with explicit Doctor authority", async () => {
    const { stateDir } = useStateDir();
    const sourcePath = await writeLegacy({ stateDir });
    const disabled = detectLegacyDeviceIdentity({ stateDir });
    expect(disabled).toEqual({
      sourcePath,
      claimPath: `${sourcePath}.doctor-importing`,
      nativeClaimPath: `${sourcePath}.native-importing`,
      hasLegacy: false,
      hasInvalidCanonical: false,
    });

    expect(
      detectLegacyDeviceIdentity({ stateDir, doctorOnlyStateMigrations: true }).hasLegacy,
    ).toBe(true);
    await fsp.rename(sourcePath, `${sourcePath}.doctor-importing`);
    expect(
      detectLegacyDeviceIdentity({ stateDir, doctorOnlyStateMigrations: true }).hasLegacy,
    ).toBe(true);
    await fsp.rename(`${sourcePath}.doctor-importing`, `${sourcePath}.native-importing`);
    expect(
      detectLegacyDeviceIdentity({ stateDir, doctorOnlyStateMigrations: true }).hasLegacy,
    ).toBe(true);
  });

  it("keeps normal migration read-only and imports only with Doctor authority", async () => {
    const { env, stateDir } = useStateDir();
    const sourcePath = await writeLegacy({ stateDir });

    const skipped = await migrateLegacyDeviceIdentity({
      detected: detectLegacyDeviceIdentity({ stateDir }),
      env,
      stateDir,
    });

    expect(skipped).toEqual({ changes: [], warnings: [] });
    expect(fs.existsSync(sourcePath)).toBe(true);
    expect(identityRow(env)).toBeUndefined();
    closeOpenClawStateDatabaseForTest();

    const repaired = await migrateLegacyDeviceIdentity({
      detected: detectLegacyDeviceIdentity({ stateDir, doctorOnlyStateMigrations: true }),
      env,
      stateDir,
      doctorOnlyStateMigrations: true,
    });

    expect(repaired.changes).toContain("Migrated primary device identity to SQLite.");
    expect(fs.existsSync(sourcePath)).toBe(false);
    expect(identityRow(env)?.device_id).toBe(SWIFT_RAW_DEVICE_ID);
  });

  for (const [label, value] of [
    ["Node PEM", nodeIdentity],
    ["Swift raw-key", swiftIdentity],
  ] as const) {
    it(`imports a valid ${label} identity and preserves device auth bytes`, async () => {
      const { env, stateDir } = useStateDir();
      const sourcePath = await writeLegacy({ stateDir, value: value() });
      const authPath = path.join(stateDir, "identity", "device-auth.json");
      const authBytes = Buffer.from([0x7b, 0x0a, 0xff, 0x00, 0x7d]);
      await fsp.writeFile(authPath, authBytes);

      const result = await migrate(stateDir, env);

      expect(result.warnings).toEqual([]);
      expect(result.changes).toEqual(["Migrated primary device identity to SQLite."]);
      expect(identityRow(env)).toMatchObject({
        identity_key: "primary",
        device_id: SWIFT_RAW_DEVICE_ID,
        created_at_ms: CREATED_AT_MS,
      });
      expect(fs.existsSync(sourcePath)).toBe(false);
      await expect(fsp.readFile(authPath)).resolves.toEqual(authBytes);
      expect(receipt(env)).toMatchObject({
        removed_source: 1,
        source_record_count: 1,
        target_table: "device_identities",
      });
    });
  }

  for (const [label, value] of [
    ["Node PEM identity with an invalid timestamp", { ...nodeIdentity(), createdAtMs: -1 }],
    [
      "Swift raw-key identity without a timestamp",
      (() => {
        const legacy = { ...swiftIdentity() } as Record<string, unknown>;
        delete legacy.createdAtMs;
        return legacy;
      })(),
    ],
  ] as const) {
    it(`imports a valid ${label}`, async () => {
      const { env, stateDir } = useStateDir();
      const sourcePath = await writeLegacy({ stateDir, value });
      const startedAt = Date.now();

      const result = await migrate(stateDir, env);
      const finishedAt = Date.now();

      expect(result.warnings).toEqual([]);
      expect(identityRow(env)).toMatchObject({
        identity_key: "primary",
        device_id: SWIFT_RAW_DEVICE_ID,
      });
      expect(identityRow(env)?.created_at_ms).toBeGreaterThanOrEqual(startedAt);
      expect(identityRow(env)?.created_at_ms).toBeLessThanOrEqual(finishedAt);
      expect(fs.existsSync(sourcePath)).toBe(false);
    });
  }

  it("repairs noncanonical PEM formatting before retiring JSON", async () => {
    const { env, stateDir } = useStateDir();
    const expected = normalizedSwift();
    const preservedCreatedAtMs = expected.createdAtMs + 50;
    seedCanonical(env, {
      ...expected,
      publicKeyPem: rewrapPem(expected.publicKeyPem),
      privateKeyPem: rewrapPem(expected.privateKeyPem),
      createdAtMs: preservedCreatedAtMs,
    });
    const sourcePath = await writeLegacy({ stateDir, value: nodeIdentity() });

    const result = await migrate(stateDir, env);

    expect(result.warnings).toEqual([]);
    expect(result.changes).toEqual(["Migrated primary device identity to SQLite."]);
    expect(identityRow(env)).toMatchObject({
      device_id: expected.deviceId,
      public_key_pem: expected.publicKeyPem,
      private_key_pem: expected.privateKeyPem,
      created_at_ms: expected.createdAtMs,
    });
    expect(fs.existsSync(sourcePath)).toBe(false);
  });

  it("repairs an invalid canonical row from a validated legacy identity", async () => {
    const { env, stateDir } = useStateDir();
    const expected = normalizedSwift();
    seedInvalidCanonical(env);
    const sourcePath = await writeLegacy({ stateDir, value: nodeIdentity() });

    const result = await migrate(stateDir, env);

    expect(result.warnings).toEqual([]);
    expect(result.changes).toEqual(["Migrated primary device identity to SQLite."]);
    expect(identityRow(env)).toMatchObject({
      device_id: expected.deviceId,
      public_key_pem: expected.publicKeyPem,
      private_key_pem: expected.privateKeyPem,
      created_at_ms: expected.createdAtMs,
    });
    expect(fs.existsSync(sourcePath)).toBe(false);
    expect(JSON.parse(receipt(env)?.report_json ?? "null")).toMatchObject({
      repairedSqliteRecordCount: 1,
    });
  });

  it("replaces an invalid canonical row without legacy JSON only under Doctor authority", async () => {
    const { env, stateDir } = useStateDir();
    seedInvalidCanonical(env);

    expect(detectLegacyDeviceIdentity({ stateDir, env }).hasInvalidCanonical).toBe(false);
    const detected = detectLegacyDeviceIdentity({
      stateDir,
      env,
      doctorOnlyStateMigrations: true,
    });
    expect(detected).toMatchObject({ hasLegacy: false, hasInvalidCanonical: true });

    const skipped = await migrateLegacyDeviceIdentity({ detected, env, stateDir });
    expect(skipped).toEqual({ changes: [], warnings: [] });
    expect(identityRow(env)?.device_id).toBe("0".repeat(64));

    const result = await migrateLegacyDeviceIdentity({
      detected,
      env,
      stateDir,
      doctorOnlyStateMigrations: true,
    });

    expect(result.warnings).toEqual([]);
    expect(result.changes).toEqual(["Replaced invalid primary device identity in SQLite."]);
    expect(result.notices).toEqual([
      "The repaired device has a new identity and must be approved again.",
    ]);
    expect(identityRow(env)).toMatchObject({
      identity_key: "primary",
      device_id: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(
      detectLegacyDeviceIdentity({
        stateDir,
        env,
        doctorOnlyStateMigrations: true,
      }).hasInvalidCanonical,
    ).toBe(false);
  });

  it("repairs canonical identity metadata without rotating valid key material", async () => {
    const { env, stateDir } = useStateDir();
    const expected = normalizedSwift();
    seedCanonical(env, expected);
    const db = database(env);
    executeSqliteQuerySync(
      db,
      getNodeSqliteKysely<MigrationDatabase>(db)
        .updateTable("device_identities")
        .set({
          device_id: "0".repeat(64),
          public_key_pem: rewrapPem(expected.publicKeyPem),
          private_key_pem: rewrapPem(expected.privateKeyPem),
          created_at_ms: -1,
          updated_at_ms: -1,
        })
        .where("identity_key", "=", "primary"),
    );
    const detected = detectLegacyDeviceIdentity({
      stateDir,
      env,
      doctorOnlyStateMigrations: true,
    });

    const result = await migrateLegacyDeviceIdentity({
      detected,
      env,
      stateDir,
      doctorOnlyStateMigrations: true,
    });

    expect(result.warnings).toEqual([]);
    expect(result.changes).toEqual([
      "Repaired invalid primary device identity metadata in SQLite.",
    ]);
    expect(result.notices ?? []).toEqual([]);
    expect(identityRow(env)).toMatchObject({
      device_id: expected.deviceId,
      public_key_pem: expected.publicKeyPem,
      private_key_pem: expected.privateKeyPem,
      created_at_ms: expect.any(Number),
    });
  });

  it("prefers legacy key material that appears after invalid-row detection", async () => {
    const { env, stateDir } = useStateDir();
    seedInvalidCanonical(env);
    const detected = detectLegacyDeviceIdentity({
      stateDir,
      env,
      doctorOnlyStateMigrations: true,
    });
    expect(detected).toMatchObject({ hasLegacy: false, hasInvalidCanonical: true });
    const sourcePath = await writeLegacy({ stateDir, value: nodeIdentity() });

    const result = await migrateLegacyDeviceIdentity({
      detected,
      env,
      stateDir,
      doctorOnlyStateMigrations: true,
    });

    expect(result.warnings).toEqual([]);
    expect(result.changes).toEqual(["Migrated primary device identity to SQLite."]);
    expect(identityRow(env)?.device_id).toBe(SWIFT_RAW_DEVICE_ID);
    expect(fs.existsSync(sourcePath)).toBe(false);
  });

  it("reports a generated identity when the invalid row disappears before repair", async () => {
    const { env, stateDir } = useStateDir();
    seedInvalidCanonical(env);
    const detected = detectLegacyDeviceIdentity({
      stateDir,
      env,
      doctorOnlyStateMigrations: true,
    });
    const db = database(env);
    executeSqliteQuerySync(
      db,
      getNodeSqliteKysely<MigrationDatabase>(db)
        .deleteFrom("device_identities")
        .where("identity_key", "=", "primary"),
    );

    const result = await migrateLegacyDeviceIdentity({
      detected,
      env,
      stateDir,
      doctorOnlyStateMigrations: true,
    });

    expect(result.changes).toEqual(["Replaced invalid primary device identity in SQLite."]);
    expect(result.notices).toEqual([
      "The repaired device has a new identity and must be approved again.",
    ]);
    expect(identityRow(env)?.device_id).toMatch(/^[a-f0-9]{64}$/);
  });

  it("requires mutation-time Doctor authority after canonical state becomes invalid", async () => {
    const { env, stateDir } = useStateDir();
    seedCanonical(env, normalizedSwift());
    const sourcePath = await writeLegacy({ stateDir, value: nodeIdentity() });
    const detected = detectLegacyDeviceIdentity({
      stateDir,
      env,
      doctorOnlyStateMigrations: true,
    });
    expect(detected).toMatchObject({ hasLegacy: true, hasInvalidCanonical: false });
    const db = database(env);
    executeSqliteQuerySync(
      db,
      getNodeSqliteKysely<MigrationDatabase>(db)
        .updateTable("device_identities")
        .set({ device_id: "0".repeat(64) })
        .where("identity_key", "=", "primary"),
    );

    const result = await migrateLegacyDeviceIdentity({ detected, env, stateDir });

    expect(result).toEqual({ changes: [], warnings: [] });
    expect(identityRow(env)?.device_id).toBe("0".repeat(64));
    expect(fs.existsSync(sourcePath)).toBe(true);
  });

  it("does not generate an identity from a stale legacy-only detection", async () => {
    const { env, stateDir } = useStateDir();
    const sourcePath = await writeLegacy({ stateDir, value: nodeIdentity() });
    const detected = detectLegacyDeviceIdentity({
      stateDir,
      env,
      doctorOnlyStateMigrations: true,
    });
    expect(detected).toMatchObject({ hasLegacy: true, hasInvalidCanonical: false });
    await fsp.unlink(sourcePath);

    const result = await migrateLegacyDeviceIdentity({
      detected,
      env,
      stateDir,
      doctorOnlyStateMigrations: true,
    });

    expect(result).toEqual({ changes: [], warnings: [] });
    expect(identityRow(env)).toBeUndefined();
  });

  it("repairs an invalid canonical update timestamp before retiring JSON", async () => {
    const { env, stateDir } = useStateDir();
    const expected = normalizedSwift();
    seedCanonical(env, expected);
    const db = database(env);
    executeSqliteQuerySync(
      db,
      getNodeSqliteKysely<MigrationDatabase>(db)
        .updateTable("device_identities")
        .set({ updated_at_ms: -1 })
        .where("identity_key", "=", "primary"),
    );
    const sourcePath = await writeLegacy({ stateDir, value: nodeIdentity() });

    const result = await migrate(stateDir, env);

    expect(result.warnings).toEqual([]);
    expect(identityRow(env)).toMatchObject({
      device_id: expected.deviceId,
      public_key_pem: expected.publicKeyPem,
      private_key_pem: expected.privateKeyPem,
      created_at_ms: expected.createdAtMs,
    });
    expect(identityRow(env)?.updated_at_ms).toBeGreaterThanOrEqual(expected.createdAtMs);
    expect(fs.existsSync(sourcePath)).toBe(false);
    expect(JSON.parse(receipt(env)?.report_json ?? "null")).toMatchObject({
      repairedSqliteRecordCount: 1,
    });
  });

  it("blocks a different canonical identity and restores the source", async () => {
    const { env, stateDir } = useStateDir();
    const winner = anotherIdentity();
    seedCanonical(env, winner);
    const sourcePath = await writeLegacy({ stateDir });
    const before = await fsp.readFile(sourcePath);

    const result = await migrate(stateDir, env);

    expect(result.warnings.join("\n")).toContain("canonical SQLite device identity differs");
    expect(identityRow(env)?.device_id).toBe(winner.deviceId);
    await expect(fsp.readFile(sourcePath)).resolves.toEqual(before);
    expect(fs.existsSync(`${sourcePath}.doctor-importing`)).toBe(false);
    expect(receipt(env)).toBeUndefined();
  });

  it("restores a source changed before Doctor can claim it", async () => {
    const { env, stateDir } = useStateDir();
    const sourcePath = await writeLegacy({ stateDir });

    const result = await migrate(stateDir, env, {
      beforeClaim: (candidate) => fs.appendFileSync(candidate, " "),
    });

    expect(result.warnings.join("\n")).toContain("changed before Doctor could claim it");
    expect(fs.existsSync(sourcePath)).toBe(true);
    expect(fs.existsSync(`${sourcePath}.doctor-importing`)).toBe(false);
    expect(identityRow(env)).toBeUndefined();
    expect(receipt(env)).toBeUndefined();
  });

  it("imports an interrupted claim", async () => {
    const { env, stateDir } = useStateDir();
    const sourcePath = await writeLegacy({ stateDir });
    const claimPath = `${sourcePath}.doctor-importing`;
    await fsp.rename(sourcePath, claimPath);

    const result = await migrate(stateDir, env);

    expect(result.warnings).toEqual([]);
    expect(identityRow(env)?.device_id).toBe(SWIFT_RAW_DEVICE_ID);
    expect(fs.existsSync(sourcePath)).toBe(false);
    expect(fs.existsSync(claimPath)).toBe(false);
  });

  it("preserves an interrupted native claim for native startup", async () => {
    const { env, stateDir } = useStateDir();
    const sourcePath = await writeLegacy({ stateDir });
    const nativeClaimPath = `${sourcePath}.native-importing`;
    await fsp.rename(sourcePath, nativeClaimPath);

    const result = await migrate(stateDir, env);

    expect(result.warnings.join("\n")).toContain("Native device identity import is pending");
    expect(fs.existsSync(sourcePath)).toBe(false);
    expect(fs.existsSync(nativeClaimPath)).toBe(true);
    expect(identityRow(env)).toBeUndefined();
    expect(receipt(env)).toBeUndefined();
  });

  it("refuses source and interrupted claim together", async () => {
    const { env, stateDir } = useStateDir();
    const sourcePath = await writeLegacy({ stateDir });
    await fsp.copyFile(sourcePath, `${sourcePath}.doctor-importing`);

    const result = await migrate(stateDir, env);

    expect(result.warnings.join("\n")).toContain("source and interrupted claim both exist");
    expect(identityRow(env)).toBeUndefined();
    expect(receipt(env)).toBeUndefined();
  });

  it("rechecks the canonical row before deleting the claimed source", async () => {
    const { env, stateDir } = useStateDir();
    const sourcePath = await writeLegacy({ stateDir });
    const replacement = anotherIdentity();

    const result = await migrate(stateDir, env, {
      beforeCleanup: () => {
        const db = database(env);
        executeSqliteQuerySync(
          db,
          getNodeSqliteKysely<MigrationDatabase>(db)
            .updateTable("device_identities")
            .set({
              device_id: replacement.deviceId,
              public_key_pem: replacement.publicKeyPem,
              private_key_pem: replacement.privateKeyPem,
              created_at_ms: replacement.createdAtMs,
              updated_at_ms: replacement.createdAtMs,
            })
            .where("identity_key", "=", "primary"),
        );
      },
    });

    expect(result.warnings.join("\n")).toContain("legacy cleanup failed");
    expect(fs.existsSync(`${sourcePath}.doctor-importing`)).toBe(true);
    expect(identityRow(env)?.device_id).toBe(replacement.deviceId);
    expect(receipt(env)).toMatchObject({ removed_source: 0 });
  });

  it("resumes an interrupted claim and cleanup receipt", async () => {
    const { env, stateDir } = useStateDir();
    const sourcePath = await writeLegacy({ stateDir });
    const first = await migrate(stateDir, env, {
      removeSource: () => {
        throw new Error("simulated unlink failure");
      },
    });
    expect(first.warnings.join("\n")).toContain("legacy cleanup failed");
    expect(fs.existsSync(`${sourcePath}.doctor-importing`)).toBe(true);
    expect(receipt(env)).toMatchObject({ removed_source: 0 });

    closeOpenClawStateDatabaseForTest();
    const retry = await migrate(stateDir, env);

    expect(retry.warnings).toEqual([]);
    expect(retry.changes).toEqual([
      "Removed retired device identity JSON covered by its SQLite receipt.",
    ]);
    expect(fs.existsSync(`${sourcePath}.doctor-importing`)).toBe(false);
    expect(receipt(env)).toMatchObject({ removed_source: 1 });
  });

  it("does not discard recreated bytes that differ from the receipt", async () => {
    const { env, stateDir } = useStateDir();
    const sourcePath = await writeLegacy({ stateDir });
    await migrate(stateDir, env, {
      removeSource: () => {
        throw new Error("simulated unlink failure");
      },
    });
    const replacement = `${JSON.stringify({ ...nodeIdentity(), createdAtMs: CREATED_AT_MS + 1 })}\n`;
    await fsp.writeFile(sourcePath, replacement, "utf8");

    closeOpenClawStateDatabaseForTest();
    const retry = await migrate(stateDir, env);

    expect(retry.warnings.join("\n")).toContain("bytes differ from the migration receipt");
    await expect(fsp.readFile(sourcePath, "utf8")).resolves.toBe(replacement);
    expect(identityRow(env)?.created_at_ms).toBe(CREATED_AT_MS);
  });

  it("rejects symlinked, hardlinked, oversized, non-UTF-8, and invalid sources", async () => {
    const cases: Array<{ env: NodeJS.ProcessEnv; sourcePath: string; stateDir: string }> = [];

    const symlink = useStateDir();
    const symlinkTarget = path.join(symlink.stateDir, "outside.json");
    await fsp.writeFile(symlinkTarget, JSON.stringify(nodeIdentity()), "utf8");
    const symlinkPath = path.join(symlink.stateDir, "identity", "device.json");
    await fsp.mkdir(path.dirname(symlinkPath), { recursive: true });
    await fsp.symlink(symlinkTarget, symlinkPath);
    cases.push({ ...symlink, sourcePath: symlinkPath });

    const hardlink = useStateDir();
    const hardlinkTarget = path.join(hardlink.stateDir, "outside.json");
    await fsp.writeFile(hardlinkTarget, JSON.stringify(nodeIdentity()), "utf8");
    const hardlinkPath = path.join(hardlink.stateDir, "identity", "device.json");
    await fsp.mkdir(path.dirname(hardlinkPath), { recursive: true });
    await fsp.link(hardlinkTarget, hardlinkPath);
    cases.push({ ...hardlink, sourcePath: hardlinkPath });

    const oversized = useStateDir();
    const oversizedPath = await writeLegacy({
      stateDir: oversized.stateDir,
      bytes: Buffer.alloc(128 * 1024 + 1, 0x20),
    });
    cases.push({ ...oversized, sourcePath: oversizedPath });

    const nonUtf8 = useStateDir();
    const nonUtf8Path = await writeLegacy({
      stateDir: nonUtf8.stateDir,
      bytes: Buffer.from([0xff, 0xfe]),
    });
    cases.push({ ...nonUtf8, sourcePath: nonUtf8Path });

    const invalid = useStateDir();
    const invalidPath = await writeLegacy({
      stateDir: invalid.stateDir,
      value: { version: 1, deviceId: "broken" },
    });
    cases.push({ ...invalid, sourcePath: invalidPath });

    for (const testCase of cases) {
      closeOpenClawStateDatabaseForTest();
      const result = await migrate(testCase.stateDir, testCase.env);
      expect(result.warnings.join("\n")).toContain("Failed reading legacy device identity");
      expect(fs.existsSync(testCase.sourcePath)).toBe(true);
      expect(identityRow(testCase.env)).toBeUndefined();
      expect(receipt(testCase.env)).toBeUndefined();
    }
  });

  it("requires exclusive state ownership", async () => {
    const { env, stateDir } = useStateDir();
    const sourcePath = await writeLegacy({ stateDir });
    const gatewayLock = await acquireGatewayLock({
      allowInTests: true,
      env,
      pollIntervalMs: 10,
      port: 18_790,
      timeoutMs: 100,
    });
    if (!gatewayLock) {
      throw new Error("expected test Gateway lock");
    }
    let result: Awaited<ReturnType<typeof migrateLegacyDeviceIdentity>>;
    try {
      result = await migrate(stateDir, env);
    } finally {
      await gatewayLock.release();
    }

    expect(result.warnings.join("\n")).toContain("Gateway or another SQLite maintenance command");
    expect(fs.existsSync(sourcePath)).toBe(true);
  });

  it("records the digest of the exact imported bytes", async () => {
    const { env, stateDir } = useStateDir();
    const bytes = Buffer.from(`${JSON.stringify(nodeIdentity())}\n`, "utf8");
    await writeLegacy({ stateDir, bytes });

    await migrate(stateDir, env);

    expect(receipt(env)).toMatchObject({
      source_sha256: createHash("sha256").update(bytes).digest("hex"),
    });
  });
});
