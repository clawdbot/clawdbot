// Covers fail-closed Doctor import of the retired APNs registration JSON store.
import { createHash } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { captureEnv, deleteTestEnvValue, setTestEnvValue } from "../test-utils/env.js";
import { acquireGatewayLock } from "./gateway-lock.js";
import {
  clearApnsRegistrationIfCurrent,
  loadApnsRegistration,
  registerApnsRegistration,
  type ApnsRegistration,
} from "./push-apns.js";
import {
  detectLegacyApnsRegistrations,
  migrateLegacyApnsRegistrations,
} from "./state-migrations.apns.js";

const APNS_DEVICE_FIELD = "token";
const APNS_DEVICE_IDENTIFIER = "abcd1234abcd1234abcd1234abcd1234";

describe("legacy APNs Doctor migration", () => {
  let envSnapshot: ReturnType<typeof captureEnv> | undefined;
  const tempDirs = useAutoCleanupTempDirTracker((cleanup) => {
    afterEach(() => {
      closeOpenClawStateDatabaseForTest();
      envSnapshot?.restore();
      envSnapshot = undefined;
      cleanup();
    });
  });

  function useStateDir(): string {
    const stateDir = tempDirs.make("openclaw-apns-migration-");
    envSnapshot ??= captureEnv(["OPENCLAW_STATE_DIR", "OPENCLAW_APNS_RELAY_ALLOW_HTTP"]);
    setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);
    return stateDir;
  }

  function envFor(stateDir: string): NodeJS.ProcessEnv {
    return { ...process.env, OPENCLAW_STATE_DIR: stateDir };
  }

  function directRegistration(overrides: Record<string, unknown> = {}) {
    return {
      nodeId: "legacy-direct",
      [APNS_DEVICE_FIELD]: `<${APNS_DEVICE_IDENTIFIER.toUpperCase()}>`,
      topic: " ai.openclaw.ios ",
      environment: "invalid-old-value",
      updatedAtMs: 1_000,
      ...overrides,
    };
  }

  function relayRegistration(overrides: Record<string, unknown> = {}) {
    return {
      nodeId: "legacy-relay",
      transport: "relay",
      relayHandle: "relay-handle-123",
      sendGrant: "send-grant-123",
      installationId: "installation-123",
      topic: "ai.openclaw.ios",
      environment: "sandbox",
      distribution: "official",
      relayOrigin: "https://ios-push-relay-sandbox.openclaw.ai/",
      tokenDebugSuffix: " abcd-1234 ",
      updatedAtMs: 2_000,
      ...overrides,
    };
  }

  async function writeLegacyState(
    stateDir: string,
    registrationsByNodeId: Record<string, unknown>,
  ): Promise<string> {
    const sourcePath = path.join(stateDir, "push", "apns-registrations.json");
    await fsp.mkdir(path.dirname(sourcePath), { recursive: true });
    await fsp.writeFile(sourcePath, JSON.stringify({ registrationsByNodeId }, null, 2), "utf8");
    return sourcePath;
  }

  async function migrate(
    stateDir: string,
    overrides: {
      beforeClaim?: () => void;
      removeSource?: (sourcePath: string) => Promise<void> | void;
    } = {},
  ) {
    return await migrateLegacyApnsRegistrations({
      detected: detectLegacyApnsRegistrations({
        stateDir,
        doctorOnlyStateMigrations: true,
      }),
      env: envFor(stateDir),
      stateDir,
      ...overrides,
    });
  }

  it("detects source and interrupted claims only for explicit Doctor repair", async () => {
    const stateDir = useStateDir();
    const sourcePath = await writeLegacyState(stateDir, {});
    expect(detectLegacyApnsRegistrations({ stateDir }).hasLegacy).toBe(false);
    expect(
      detectLegacyApnsRegistrations({ stateDir, doctorOnlyStateMigrations: true }).hasLegacy,
    ).toBe(true);

    await fsp.rename(sourcePath, `${sourcePath}.doctor-importing`);
    expect(
      detectLegacyApnsRegistrations({ stateDir, doctorOnlyStateMigrations: true }).hasLegacy,
    ).toBe(true);
  });

  it("imports shipped direct and relay shapes, records a receipt, and removes JSON", async () => {
    const stateDir = useStateDir();
    const sourcePath = await writeLegacyState(stateDir, {
      "legacy-direct": directRegistration(),
      "legacy-relay": relayRegistration(),
    });
    const sourceBytes = await fsp.readFile(sourcePath);
    const sourceSha256 = createHash("sha256").update(sourceBytes).digest("hex");

    const result = await migrate(stateDir);

    expect(result.warnings).toEqual([]);
    await expect(loadApnsRegistration("legacy-direct", stateDir)).resolves.toEqual({
      nodeId: "legacy-direct",
      transport: "direct",
      [APNS_DEVICE_FIELD]: APNS_DEVICE_IDENTIFIER,
      topic: "ai.openclaw.ios",
      environment: "sandbox",
      updatedAtMs: 1_000,
    });
    await expect(loadApnsRegistration("legacy-relay", stateDir)).resolves.toEqual({
      nodeId: "legacy-relay",
      transport: "relay",
      relayHandle: "relay-handle-123",
      sendGrant: "send-grant-123",
      installationId: "installation-123",
      topic: "ai.openclaw.ios",
      environment: "sandbox",
      distribution: "official",
      relayOrigin: "https://ios-push-relay-sandbox.openclaw.ai",
      tokenDebugSuffix: "abcd1234",
      updatedAtMs: 2_000,
    });
    expect(fs.existsSync(sourcePath)).toBe(false);
    const receipt = openOpenClawStateDatabase()
      .db.prepare(
        `SELECT source_sha256, source_size_bytes, source_record_count,
                status, removed_source, report_json
           FROM migration_sources
          WHERE migration_kind = ?`,
      )
      .get("legacy-apns-registrations-json") as Record<string, unknown>;
    expect(receipt).toMatchObject({
      source_sha256: sourceSha256,
      source_size_bytes: sourceBytes.byteLength,
      source_record_count: 2,
      status: "completed",
      removed_source: 1,
    });
    expect(JSON.parse(String(receipt.report_json))).toMatchObject({
      source: "legacy-apns-registrations-json",
      target: "apns_registrations",
      sourceRecordCount: 2,
      importedRecordCount: 2,
    });
  });

  it("preserves canonical SQLite rows and imports only missing node ids", async () => {
    const stateDir = useStateDir();
    const canonical = await registerApnsRegistration({
      nodeId: "shared-node",
      transport: "direct",
      [APNS_DEVICE_FIELD]: APNS_DEVICE_IDENTIFIER,
      topic: "ai.openclaw.ios",
      environment: "production",
      baseDir: stateDir,
    });
    await writeLegacyState(stateDir, {
      "shared-node": directRegistration({
        nodeId: "shared-node",
        [APNS_DEVICE_FIELD]: "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
        updatedAtMs: canonical.updatedAtMs + 10_000,
      }),
      "legacy-only": directRegistration({ nodeId: "legacy-only" }),
    });

    const result = await migrate(stateDir);

    expect(result.warnings).toEqual([]);
    await expect(loadApnsRegistration("shared-node", stateDir)).resolves.toEqual(canonical);
    await expect(loadApnsRegistration("legacy-only", stateDir)).resolves.toMatchObject({
      nodeId: "legacy-only",
      [APNS_DEVICE_FIELD]: APNS_DEVICE_IDENTIFIER,
    });
  });

  it("does not resurrect a registration deleted before the first Doctor import", async () => {
    const stateDir = useStateDir();
    await writeLegacyState(stateDir, {
      "legacy-direct": directRegistration(),
    });
    const current = await registerApnsRegistration({
      nodeId: "legacy-direct",
      transport: "direct",
      [APNS_DEVICE_FIELD]: APNS_DEVICE_IDENTIFIER,
      topic: "ai.openclaw.ios",
      environment: "production",
      baseDir: stateDir,
    });
    await expect(
      clearApnsRegistrationIfCurrent({
        nodeId: "legacy-direct",
        registration: current,
        baseDir: stateDir,
      }),
    ).resolves.toBe(true);
    closeOpenClawStateDatabaseForTest();

    const result = await migrate(stateDir);

    expect(result.warnings).toEqual([]);
    await expect(loadApnsRegistration("legacy-direct", stateDir)).resolves.toBeNull();
    expect(result.notices).toContain("Kept 1 deleted APNs registration retired.");
  });

  it("uses the supplied environment while verifying local relay origins", async () => {
    const stateDir = useStateDir();
    await writeLegacyState(stateDir, {
      "legacy-relay": relayRegistration({ relayOrigin: "http://127.0.0.1:18791/" }),
    });
    const env = {
      ...envFor(stateDir),
      OPENCLAW_APNS_RELAY_ALLOW_HTTP: "true",
    };

    const result = await migrateLegacyApnsRegistrations({
      detected: detectLegacyApnsRegistrations({
        stateDir,
        doctorOnlyStateMigrations: true,
      }),
      env,
      stateDir,
    });

    expect(result.warnings).toEqual([]);
    const row = openOpenClawStateDatabase({ env })
      .db.prepare("SELECT relay_origin FROM apns_registrations WHERE node_id = ?")
      .get("legacy-relay");
    expect(row).toEqual({ relay_origin: "http://127.0.0.1:18791" });
    closeOpenClawStateDatabaseForTest();
    deleteTestEnvValue("OPENCLAW_APNS_RELAY_ALLOW_HTTP");
    await expect(loadApnsRegistration("legacy-relay", stateDir)).resolves.toMatchObject({
      relayOrigin: "http://127.0.0.1:18791",
    });
  });

  it.each([
    ["invalid root", []],
    [
      "unknown field",
      { registrationsByNodeId: { node: directRegistration({ nodeId: "node", extra: true }) } },
    ],
    [
      "mismatched node id",
      { registrationsByNodeId: { key: directRegistration({ nodeId: "other" }) } },
    ],
    [
      "invalid relay",
      { registrationsByNodeId: { "legacy-relay": relayRegistration({ distribution: "beta" }) } },
    ],
    [
      "out-of-range direct timestamp",
      {
        registrationsByNodeId: {
          node: directRegistration({
            nodeId: "node",
            updatedAtMs: Number.MAX_SAFE_INTEGER,
          }),
        },
      },
    ],
    [
      "out-of-range relay timestamp",
      {
        registrationsByNodeId: {
          "legacy-relay": relayRegistration({
            updatedAtMs: Number.MAX_SAFE_INTEGER,
          }),
        },
      },
    ],
    [
      "overlong relay handle",
      {
        registrationsByNodeId: {
          "legacy-relay": relayRegistration({ relayHandle: "x".repeat(257) }),
        },
      },
    ],
    [
      "control character in send grant",
      {
        registrationsByNodeId: {
          "legacy-relay": relayRegistration({ sendGrant: "send\ngrant" }),
        },
      },
    ],
    [
      "invalid relay origin",
      {
        registrationsByNodeId: {
          "legacy-relay": relayRegistration({ relayOrigin: "ftp://relay.example" }),
        },
      },
    ],
  ])("refuses %s atomically", async (_label, raw) => {
    const stateDir = useStateDir();
    const sourcePath = path.join(stateDir, "push", "apns-registrations.json");
    await fsp.mkdir(path.dirname(sourcePath), { recursive: true });
    await fsp.writeFile(sourcePath, JSON.stringify(raw), "utf8");

    const result = await migrate(stateDir);

    expect(result.warnings[0]).toMatch(/legacy APNs/i);
    await expect(loadApnsRegistration("node", stateDir)).resolves.toBeNull();
    expect(fs.existsSync(sourcePath)).toBe(true);
  });

  it("sanitizes malformed JSON warnings", async () => {
    const stateDir = useStateDir();
    const sourcePath = path.join(stateDir, "push", "apns-registrations.json");
    const privateMarker = "must-not-appear-in-doctor-output";
    await fsp.mkdir(path.dirname(sourcePath), { recursive: true });
    await fsp.writeFile(
      sourcePath,
      `{"registrationsByNodeId":{"node":{"nodeId":"node","value":${privateMarker}}}}`,
      "utf8",
    );

    const result = await migrate(stateDir);

    expect(result.warnings).toEqual([
      "Failed reading legacy APNs state: Error: legacy JSON store contains invalid JSON",
    ]);
    expect(result.warnings.join("\n")).not.toContain(privateMarker);
    expect(fs.existsSync(sourcePath)).toBe(true);
  });

  it("sanitizes legacy entry identifiers in warnings", async () => {
    const privateMarker = "must-not-appear-in-doctor-output";
    const malformedStores = [
      {
        registrationsByNodeId: {
          [privateMarker]: directRegistration({ nodeId: "different-node" }),
        },
      },
      {
        registrationsByNodeId: {
          node: directRegistration({ nodeId: "node", [privateMarker]: true }),
        },
      },
    ];

    for (const raw of malformedStores) {
      closeOpenClawStateDatabaseForTest();
      const stateDir = useStateDir();
      const sourcePath = path.join(stateDir, "push", "apns-registrations.json");
      await fsp.mkdir(path.dirname(sourcePath), { recursive: true });
      await fsp.writeFile(sourcePath, JSON.stringify(raw), "utf8");

      const result = await migrate(stateDir);

      expect(result.warnings[0]).toMatch(/legacy APNs/i);
      expect(result.warnings.join("\n")).not.toContain(privateMarker);
      expect(fs.existsSync(sourcePath)).toBe(true);
    }
  });

  it("rolls back inserted rows when a later canonical row is invalid", async () => {
    const stateDir = useStateDir();
    const sourcePath = await writeLegacyState(stateDir, {
      "legacy-only": directRegistration({ nodeId: "legacy-only" }),
      "corrupt-node": directRegistration({ nodeId: "corrupt-node" }),
    });
    openOpenClawStateDatabase()
      .db.prepare(
        `INSERT INTO apns_registrations (
           node_id, transport, topic, environment, updated_at_ms
         ) VALUES (?, ?, ?, ?, ?)`,
      )
      .run("corrupt-node", "unknown", "ai.openclaw.ios", "sandbox", 1);

    const result = await migrate(stateDir);

    expect(result.warnings[0]).toContain("invalid APNs registration row");
    await expect(loadApnsRegistration("legacy-only", stateDir)).resolves.toBeNull();
    expect(fs.existsSync(sourcePath)).toBe(true);
    expect(fs.existsSync(`${sourcePath}.doctor-importing`)).toBe(false);
  });

  it("streams valid legacy stores larger than the retired reader's 4 MiB limit", async () => {
    const stateDir = useStateDir();
    const registrationsByNodeId: Record<string, unknown> = {};
    for (let index = 0; index < 2_500; index += 1) {
      const nodeId = `legacy-relay-${index}`;
      registrationsByNodeId[nodeId] = relayRegistration({
        nodeId,
        relayHandle: "h".repeat(256),
        sendGrant: `grant-${"g".repeat(1_018)}`,
        installationId: "i".repeat(256),
        topic: "t".repeat(255),
      });
    }
    const sourcePath = await writeLegacyState(stateDir, registrationsByNodeId);
    expect((await fsp.stat(sourcePath)).size).toBeGreaterThan(4 * 1024 * 1024);

    const result = await migrate(stateDir);

    expect(result.warnings).toEqual([]);
    await expect(loadApnsRegistration("legacy-relay-0", stateDir)).resolves.toMatchObject({
      nodeId: "legacy-relay-0",
      transport: "relay",
    });
    await expect(loadApnsRegistration("legacy-relay-2499", stateDir)).resolves.toMatchObject({
      nodeId: "legacy-relay-2499",
      transport: "relay",
    });
    expect(
      openOpenClawStateDatabase()
        .db.prepare("SELECT source_record_count FROM migration_sources WHERE migration_kind = ?")
        .get("legacy-apns-registrations-json"),
    ).toEqual({ source_record_count: 2_500 });
    expect(fs.existsSync(sourcePath)).toBe(false);
  });

  it("rejects symlinks, hardlinks, and invalid UTF-8", async () => {
    for (const kind of ["symlink", "hardlink", "invalid-utf8"] as const) {
      closeOpenClawStateDatabaseForTest();
      const stateDir = tempDirs.make(`openclaw-apns-${kind}-`);
      const sourcePath = path.join(stateDir, "push", "apns-registrations.json");
      const targetPath = path.join(stateDir, "target.json");
      await fsp.mkdir(path.dirname(sourcePath), { recursive: true });
      await fsp.writeFile(targetPath, JSON.stringify({ registrationsByNodeId: {} }), "utf8");
      if (kind === "symlink") {
        await fsp.symlink(targetPath, sourcePath);
      } else if (kind === "hardlink") {
        await fsp.link(targetPath, sourcePath);
      } else {
        await fsp.writeFile(sourcePath, Buffer.from([0xc3, 0x28]));
      }

      const result = await migrate(stateDir);

      expect(result.warnings.length).toBeGreaterThan(0);
      expect(fs.existsSync(sourcePath)).toBe(true);
    }
  });

  it("detects source mutation before claim and leaves the replacement untouched", async () => {
    const stateDir = useStateDir();
    const sourcePath = await writeLegacyState(stateDir, {
      "legacy-direct": directRegistration(),
    });
    const replacement = JSON.stringify({ registrationsByNodeId: {} });

    const result = await migrate(stateDir, {
      beforeClaim: () => {
        fs.writeFileSync(sourcePath, replacement, "utf8");
      },
    });

    expect(result.warnings[0]).toContain("changed before Doctor could claim");
    expect(fs.existsSync(sourcePath)).toBe(true);
    await expect(fsp.readFile(sourcePath, "utf8")).resolves.toBe(replacement);
    await expect(loadApnsRegistration("legacy-direct", stateDir)).resolves.toBeNull();
  });

  it("requires exclusive state ownership", async () => {
    const stateDir = useStateDir();
    const sourcePath = await writeLegacyState(stateDir, {
      "legacy-direct": directRegistration(),
    });
    const env = envFor(stateDir);
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

    let result: Awaited<ReturnType<typeof migrateLegacyApnsRegistrations>>;
    try {
      result = await migrate(stateDir);
    } finally {
      await gatewayLock.release();
    }

    expect(result.warnings[0]).toContain("Gateway or another SQLite maintenance command");
    expect(fs.existsSync(sourcePath)).toBe(true);
  });

  it("imports an interrupted claim when no receipt exists", async () => {
    const stateDir = useStateDir();
    const sourcePath = await writeLegacyState(stateDir, {
      "legacy-direct": directRegistration(),
    });
    const claimPath = `${sourcePath}.doctor-importing`;
    await fsp.rename(sourcePath, claimPath);

    const result = await migrate(stateDir);

    expect(result.warnings).toEqual([]);
    await expect(loadApnsRegistration("legacy-direct", stateDir)).resolves.toMatchObject({
      nodeId: "legacy-direct",
    });
    expect(fs.existsSync(claimPath)).toBe(false);
  });

  it("refuses source and claim files together without a receipt", async () => {
    const stateDir = useStateDir();
    const sourcePath = await writeLegacyState(stateDir, {
      "legacy-direct": directRegistration(),
    });
    const claimPath = `${sourcePath}.doctor-importing`;
    await fsp.writeFile(claimPath, JSON.stringify({ registrationsByNodeId: {} }), "utf8");

    const result = await migrate(stateDir);

    expect(result.warnings[0]).toContain("source and interrupted claim both exist");
    expect(fs.existsSync(sourcePath)).toBe(true);
    expect(fs.existsSync(claimPath)).toBe(true);
    await expect(loadApnsRegistration("legacy-direct", stateDir)).resolves.toBeNull();
  });

  it("uses the receipt for cleanup-only retries and never resurrects deleted rows", async () => {
    const stateDir = useStateDir();
    const sourcePath = await writeLegacyState(stateDir, {
      "legacy-direct": directRegistration(),
    });
    const first = await migrate(stateDir, {
      removeSource: () => {
        throw new Error("simulated unlink failure");
      },
    });
    expect(first.warnings[0]).toContain("legacy cleanup failed");
    expect(fs.existsSync(`${sourcePath}.doctor-importing`)).toBe(true);
    expect(
      openOpenClawStateDatabase()
        .db.prepare("SELECT removed_source FROM migration_sources WHERE migration_kind = ?")
        .get("legacy-apns-registrations-json"),
    ).toEqual({ removed_source: 0 });
    const imported = (await loadApnsRegistration("legacy-direct", stateDir)) as ApnsRegistration;
    await expect(
      clearApnsRegistrationIfCurrent({
        nodeId: "legacy-direct",
        registration: imported,
        baseDir: stateDir,
      }),
    ).resolves.toBe(true);

    const retry = await migrate(stateDir);
    expect(retry.warnings).toEqual([]);
    await expect(loadApnsRegistration("legacy-direct", stateDir)).resolves.toBeNull();
    expect(fs.existsSync(`${sourcePath}.doctor-importing`)).toBe(false);
    expect(
      openOpenClawStateDatabase()
        .db.prepare("SELECT removed_source FROM migration_sources WHERE migration_kind = ?")
        .get("legacy-apns-registrations-json"),
    ).toEqual({ removed_source: 1 });

    await writeLegacyState(stateDir, {
      "recreated-node": directRegistration({ nodeId: "recreated-node" }),
    });
    const recreated = await migrate(stateDir);
    expect(recreated.warnings).toEqual([]);
    await expect(loadApnsRegistration("recreated-node", stateDir)).resolves.toBeNull();
    expect(fs.existsSync(sourcePath)).toBe(false);
  });
});
