// Covers fail-closed Doctor import of retired per-server MCP OAuth JSON stores.
import { createHash } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createMcpOAuthClientProvider } from "../agents/mcp-oauth-provider.js";
import { resolveMcpOAuthStoreKey } from "../agents/mcp-oauth-store.js";
import { clearMcpOAuthCredentials, resolveMcpOAuthAccessToken } from "../agents/mcp-oauth.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { acquireGatewayLock } from "./gateway-lock.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "./kysely-sync.js";
import {
  detectLegacyMcpOAuthStores,
  migrateLegacyMcpOAuthStores,
} from "./state-migrations.mcp-oauth.js";

type MigrationDatabase = Pick<
  OpenClawStateKyselyDatabase,
  "mcp_oauth_stores" | "migration_sources"
>;

const DEFAULT_FILE_NAME = "server-0123456789abcdef.json";

describe("legacy MCP OAuth Doctor migration", () => {
  const tempDirs = useAutoCleanupTempDirTracker((cleanup) => {
    afterEach(() => {
      closeOpenClawStateDatabaseForTest();
      vi.unstubAllEnvs();
      cleanup();
    });
  });

  function useStateDir(): { env: NodeJS.ProcessEnv; stateDir: string } {
    const stateDir = tempDirs.make("openclaw-mcp-oauth-migration-");
    return { env: { ...process.env, OPENCLAW_STATE_DIR: stateDir }, stateDir };
  }

  function database(env: NodeJS.ProcessEnv) {
    return openOpenClawStateDatabase({ env }).db;
  }

  async function writeLegacy(params: {
    stateDir: string;
    fileName?: string;
    value?: unknown;
    bytes?: Buffer;
  }): Promise<string> {
    const sourcePath = path.join(
      params.stateDir,
      "mcp-oauth",
      params.fileName ?? DEFAULT_FILE_NAME,
    );
    await fsp.mkdir(path.dirname(sourcePath), { recursive: true });
    await fsp.writeFile(
      sourcePath,
      params.bytes ?? Buffer.from(JSON.stringify(params.value ?? validStore()), "utf8"),
    );
    return sourcePath;
  }

  function validStore(overrides: Record<string, unknown> = {}) {
    return {
      clientInformation: {
        client_id: "client-1",
        client_secret: "fake",
        redirect_uris: ["http://127.0.0.1:8989/oauth/callback"],
        vendor_extension: "preserve-client-extension",
      },
      tokens: {
        access_token: "test-token-placeholder",
        token_type: "Bearer",
        expires_in: 3600,
        refresh_token: "test-auth-token",
        vendor_extension: "preserve-token-extension",
      },
      tokenExpiresAt: 10_000,
      codeVerifier: "verifier-1",
      discoveryState: {
        authorizationServerUrl: "https://auth.example.com",
        authorizationServerMetadata: {
          issuer: "https://auth.example.com",
          authorization_endpoint: "https://auth.example.com/authorize",
          token_endpoint: "https://auth.example.com/token",
          response_types_supported: ["code"],
          vendor_extension: "preserve-metadata-extension",
        },
        resourceMetadata: {
          resource: "https://mcp.example.com",
          authorization_servers: ["https://auth.example.com"],
          vendor_extension: "preserve-resource-extension",
        },
        resourceMetadataUrl: "https://mcp.example.com/.well-known/oauth-protected-resource",
      },
      lastAuthorizationUrl: "https://auth.example.com/authorize?client_id=client-1",
      redirectUrl: "http://localhost:8989/oauth/callback",
      state: "dead-and-not-imported",
      ...overrides,
    };
  }

  function storeRow(env: NodeJS.ProcessEnv, storeKey = DEFAULT_FILE_NAME.slice(0, -5)) {
    const db = database(env);
    return executeSqliteQueryTakeFirstSync(
      db,
      getNodeSqliteKysely<MigrationDatabase>(db)
        .selectFrom("mcp_oauth_stores")
        .selectAll()
        .where("store_key", "=", storeKey),
    );
  }

  function receipt(env: NodeJS.ProcessEnv, sourcePath?: string) {
    const db = database(env);
    let query = getNodeSqliteKysely<MigrationDatabase>(db)
      .selectFrom("migration_sources")
      .selectAll()
      .where("migration_kind", "=", "legacy-mcp-oauth-json");
    if (sourcePath) {
      query = query.where("source_path", "=", sourcePath);
    }
    return executeSqliteQueryTakeFirstSync(db, query);
  }

  function seedCanonical(
    env: NodeJS.ProcessEnv,
    store: Record<string, unknown>,
    storeKey = DEFAULT_FILE_NAME.slice(0, -5),
  ): void {
    const db = database(env);
    executeSqliteQuerySync(
      db,
      getNodeSqliteKysely<MigrationDatabase>(db)
        .insertInto("mcp_oauth_stores")
        .values({
          store_key: storeKey,
          format_version: 1,
          store_json: JSON.stringify(store),
          updated_at: 123,
        }),
    );
  }

  function deleteCanonical(env: NodeJS.ProcessEnv): void {
    const db = database(env);
    executeSqliteQuerySync(
      db,
      getNodeSqliteKysely<MigrationDatabase>(db).deleteFrom("mcp_oauth_stores"),
    );
  }

  async function migrate(
    stateDir: string,
    env: NodeJS.ProcessEnv,
    overrides: {
      beforeLegacyLock?: (sourcePath: string) => void;
      beforeClaim?: (sourcePath: string) => void;
      removeSource?: (sourcePath: string) => Promise<void> | void;
    } = {},
  ) {
    return await migrateLegacyMcpOAuthStores({
      detected: detectLegacyMcpOAuthStores({
        stateDir,
        doctorOnlyStateMigrations: true,
      }),
      env,
      stateDir,
      ...overrides,
    });
  }

  it("detects only exact store names and interrupted claims during explicit Doctor repair", async () => {
    const { stateDir } = useStateDir();
    const sourcePath = await writeLegacy({ stateDir });
    await writeLegacy({
      stateDir,
      fileName: "server-0123456789ABCDE0.json",
    });
    await writeLegacy({
      stateDir,
      fileName: "server-0123456789abcdef.json.backup",
    });
    expect(detectLegacyMcpOAuthStores({ stateDir }).hasLegacy).toBe(false);
    expect(
      detectLegacyMcpOAuthStores({ stateDir, doctorOnlyStateMigrations: true }).sourcePaths,
    ).toEqual([sourcePath]);

    await fsp.rename(sourcePath, `${sourcePath}.doctor-importing`);
    expect(
      detectLegacyMcpOAuthStores({ stateDir, doctorOnlyStateMigrations: true }).sourcePaths,
    ).toEqual([sourcePath]);
  });

  it("imports validated fields, preserves SDK extensions, drops dead state, and records a receipt", async () => {
    const { env, stateDir } = useStateDir();
    const sourcePath = await writeLegacy({ stateDir });

    const result = await migrate(stateDir, env);

    expect(result.warnings).toEqual([]);
    expect(result.changes).toContain(`Migrated MCP OAuth store ${DEFAULT_FILE_NAME} to SQLite.`);
    expect(fs.existsSync(sourcePath)).toBe(false);
    const row = storeRow(env);
    expect(row?.format_version).toBe(1);
    const stored = JSON.parse(row?.store_json ?? "null");
    expect(stored).toMatchObject({
      clientInformation: { vendor_extension: "preserve-client-extension" },
      tokens: { vendor_extension: "preserve-token-extension" },
      discoveryState: {
        authorizationServerMetadata: { vendor_extension: "preserve-metadata-extension" },
        resourceMetadata: { vendor_extension: "preserve-resource-extension" },
      },
    });
    expect(stored).not.toHaveProperty("state");
    expect(receipt(env, sourcePath)).toMatchObject({
      removed_source: 1,
      source_record_count: 1,
      status: "completed",
      target_table: "mcp_oauth_stores",
    });
    expect(JSON.parse(receipt(env, sourcePath)?.report_json ?? "null")).toMatchObject({
      importedRecordCount: 1,
      preservedSqliteRecordCount: 0,
      storeKey: DEFAULT_FILE_NAME.slice(0, -5),
    });
  });

  it("preserves a valid canonical SQLite row and removes stale JSON", async () => {
    const { env, stateDir } = useStateDir();
    const canonical: Record<string, unknown> = validStore({
      tokens: { access_token: "winner", token_type: "Bearer" },
      futureCanonicalField: { preserved: true },
    });
    delete canonical.state;
    seedCanonical(env, canonical);
    const sourcePath = await writeLegacy({
      stateDir,
      value: validStore({ tokens: { access_token: "stale", token_type: "Bearer" } }),
    });

    const result = await migrate(stateDir, env);

    expect(result.warnings).toEqual([]);
    expect(result.changes).toContain(
      `Preserved canonical SQLite MCP OAuth store for ${DEFAULT_FILE_NAME}.`,
    );
    expect(JSON.parse(storeRow(env)?.store_json ?? "null")).toEqual(canonical);
    expect(fs.existsSync(sourcePath)).toBe(false);
    expect(JSON.parse(receipt(env, sourcePath)?.report_json ?? "null")).toMatchObject({
      importedRecordCount: 0,
      preservedSqliteRecordCount: 1,
    });
  });

  it("merges legacy credentials into challenge-only SQLite state", async () => {
    const { env, stateDir } = useStateDir();
    const pendingAuthorizationChallenge = {
      resourceMetadataUrl: "https://mcp.example.com/.well-known/oauth-protected-resource",
      scope: "docs.read",
    };
    seedCanonical(env, {
      credentialState: "uninitialized",
      pendingAuthorizationChallenge,
    });
    const sourcePath = await writeLegacy({ stateDir });

    const result = await migrate(stateDir, env);

    expect(result.warnings).toEqual([]);
    expect(result.changes).toContain(`Migrated MCP OAuth store ${DEFAULT_FILE_NAME} to SQLite.`);
    expect(JSON.parse(storeRow(env)?.store_json ?? "null")).toMatchObject({
      pendingAuthorizationChallenge,
      tokens: {
        access_token: "test-token-placeholder",
        refresh_token: "test-auth-token",
      },
    });
    expect(JSON.parse(storeRow(env)?.store_json ?? "null")).not.toHaveProperty("credentialState");
    expect(JSON.parse(storeRow(env)?.store_json ?? "null")).not.toHaveProperty("discoveryState");
    expect(fs.existsSync(sourcePath)).toBe(false);
    expect(JSON.parse(receipt(env, sourcePath)?.report_json ?? "null")).toMatchObject({
      importedRecordCount: 1,
      preservedSqliteRecordCount: 1,
    });
  });

  it("does not import legacy credentials after challenge bootstrap becomes an active login", async () => {
    const { env, stateDir } = useStateDir();
    const serverName = "Remote Docs";
    const serverUrl = "https://mcp.example.com/mcp";
    const storeKey = resolveMcpOAuthStoreKey(serverName, serverUrl);
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    await expect(
      resolveMcpOAuthAccessToken({
        serverName,
        serverUrl,
        authorizationChallenge: true,
        scope: "docs.read",
      }),
    ).rejects.toThrow("Run openclaw mcp login Remote Docs.");
    const provider = createMcpOAuthClientProvider({
      serverName,
      serverUrl,
      onAuthorizationUrl: () => {},
    });
    await provider.saveCodeVerifier("new-login-verifier");
    const sourcePath = await writeLegacy({
      stateDir,
      fileName: `${storeKey}.json`,
    });

    const result = await migrate(stateDir, env);

    expect(result.warnings).toEqual([]);
    expect(result.changes).toContain(
      `Preserved canonical SQLite MCP OAuth store for ${storeKey}.json.`,
    );
    expect(JSON.parse(storeRow(env, storeKey)?.store_json ?? "null")).toMatchObject({
      codeVerifier: "new-login-verifier",
      pendingAuthorizationChallenge: { scope: "docs.read" },
    });
    expect(JSON.parse(storeRow(env, storeKey)?.store_json ?? "null")).not.toHaveProperty(
      "credentialState",
    );
    expect(JSON.parse(storeRow(env, storeKey)?.store_json ?? "null")).not.toHaveProperty("tokens");
    expect(fs.existsSync(sourcePath)).toBe(false);
    expect(JSON.parse(receipt(env, sourcePath)?.report_json ?? "null")).toMatchObject({
      importedRecordCount: 0,
      preservedSqliteRecordCount: 1,
    });
  });

  it("does not resurrect retired JSON after an explicit logout", async () => {
    const { env, stateDir } = useStateDir();
    const serverName = "Remote Docs";
    const serverUrl = "https://mcp.example.com/mcp";
    const storeKey = resolveMcpOAuthStoreKey(serverName, serverUrl);
    const sourcePath = await writeLegacy({
      stateDir,
      fileName: `${storeKey}.json`,
    });
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);

    await clearMcpOAuthCredentials({ serverName, serverUrl });
    expect(JSON.parse(storeRow(env, storeKey)?.store_json ?? "null")).toEqual({
      credentialState: "cleared",
    });

    const result = await migrate(stateDir, env);

    expect(result.warnings).toEqual([]);
    expect(result.changes).toContain(
      `Preserved canonical SQLite MCP OAuth store for ${storeKey}.json.`,
    );
    expect(JSON.parse(storeRow(env, storeKey)?.store_json ?? "null")).toEqual({
      credentialState: "cleared",
    });
    expect(fs.existsSync(sourcePath)).toBe(false);
    expect(JSON.parse(receipt(env, sourcePath)?.report_json ?? "null")).toMatchObject({
      importedRecordCount: 0,
      preservedSqliteRecordCount: 1,
    });
  });

  it("rejects malformed and unexpected store shapes without mutation", async () => {
    const { env, stateDir } = useStateDir();
    const malformedPath = await writeLegacy({
      stateDir,
      value: validStore({ tokens: { access_token: 42, token_type: "Bearer" } }),
    });
    const unexpectedPath = await writeLegacy({
      stateDir,
      fileName: "other-1234567890abcdef.json",
      value: { ...validStore(), unexpected: true },
    });

    const result = await migrate(stateDir, env);

    expect(result.warnings).toHaveLength(2);
    expect(result.warnings.join("\n")).toContain("tokens are invalid");
    expect(result.warnings.join("\n")).toContain("unexpected field");
    expect(fs.existsSync(malformedPath)).toBe(true);
    expect(fs.existsSync(unexpectedPath)).toBe(true);
    expect(storeRow(env)).toBeUndefined();
    expect(receipt(env)).toBeUndefined();
  });

  it("fails closed on malformed canonical challenge state before retiring JSON", async () => {
    const { env, stateDir } = useStateDir();
    seedCanonical(env, {
      credentialState: "uninitialized",
      codeVerifier: "inconsistent-verifier",
      pendingAuthorizationChallenge: { scope: "docs.read" },
    });
    const sourcePath = await writeLegacy({ stateDir });

    const result = await migrate(stateDir, env);

    expect(result.warnings.join("\n")).toContain(
      "uninitialized credential state contains authoritative OAuth fields",
    );
    expect(fs.existsSync(sourcePath)).toBe(true);
    expect(receipt(env, sourcePath)).toBeUndefined();
  });

  it("drops an orphaned legacy token expiry during import", async () => {
    const { env, stateDir } = useStateDir();
    const sourcePath = await writeLegacy({ stateDir, value: { tokenExpiresAt: 10_000 } });

    const result = await migrate(stateDir, env);

    expect(result.warnings).toEqual([]);
    expect(JSON.parse(storeRow(env)?.store_json ?? "null")).toEqual({});
    expect(fs.existsSync(sourcePath)).toBe(false);
  });

  it("imports multiple exact stores while ignoring unrelated directory entries", async () => {
    const { env, stateDir } = useStateDir();
    await writeLegacy({ stateDir });
    await writeLegacy({
      stateDir,
      fileName: "other-1234567890abcdef.json",
      value: validStore({ codeVerifier: "other-verifier" }),
    });
    const ignoredPath = await writeLegacy({
      stateDir,
      fileName: "unrelated.json.bak",
      value: { invalid: true },
    });

    const result = await migrate(stateDir, env);

    expect(result.warnings).toEqual([]);
    expect(result.changes).toHaveLength(2);
    expect(storeRow(env)).toBeDefined();
    expect(storeRow(env, "other-1234567890abcdef")).toBeDefined();
    expect(fs.existsSync(ignoredPath)).toBe(true);
  });

  it("fails closed on an ambiguous retired-runtime lock sidecar", async () => {
    const { env, stateDir } = useStateDir();
    const sourcePath = await writeLegacy({ stateDir });
    await fsp.writeFile(`${sourcePath}.lock`, "not a verifiable lock owner");

    const result = await migrate(stateDir, env);

    expect(result.changes).toEqual([]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("Failed locking legacy MCP OAuth store");
    expect(fs.existsSync(sourcePath)).toBe(true);
    expect(storeRow(env)).toBeUndefined();
  });

  it.skipIf(process.platform === "win32")(
    "rejects a symlinked legacy directory before creating lock sidecars",
    async () => {
      const { env, stateDir } = useStateDir();
      const externalDir = tempDirs.make("openclaw-mcp-oauth-external-");
      const externalSource = path.join(externalDir, DEFAULT_FILE_NAME);
      await fsp.writeFile(externalSource, JSON.stringify(validStore()));
      await fsp.mkdir(stateDir, { recursive: true });
      await fsp.symlink(externalDir, path.join(stateDir, "mcp-oauth"), "dir");

      const result = await migrate(stateDir, env);

      expect(result.changes).toEqual([]);
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toContain("Failed reading legacy MCP OAuth directory");
      expect(fs.existsSync(externalSource)).toBe(true);
      expect(fs.existsSync(`${externalSource}.lock`)).toBe(false);
      expect(storeRow(env)).toBeUndefined();
    },
  );

  it.skipIf(process.platform === "win32")(
    "rejects a legacy-directory swap at the lock boundary",
    async () => {
      const { env, stateDir } = useStateDir();
      const sourcePath = await writeLegacy({ stateDir });
      const sourceDir = path.dirname(sourcePath);
      const displacedDir = `${sourceDir}.displaced`;
      const externalDir = tempDirs.make("openclaw-mcp-oauth-swap-external-");
      const externalSource = path.join(externalDir, DEFAULT_FILE_NAME);
      await fsp.writeFile(externalSource, JSON.stringify(validStore()));

      const result = await migrate(stateDir, env, {
        beforeLegacyLock: () => {
          fs.renameSync(sourceDir, displacedDir);
          fs.symlinkSync(externalDir, sourceDir, "dir");
        },
      });

      expect(result.changes).toEqual([]);
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toContain("Failed locking legacy MCP OAuth store");
      expect(fs.existsSync(externalSource)).toBe(true);
      expect(fs.existsSync(`${externalSource}.lock`)).toBe(false);
      expect(fs.existsSync(path.join(displacedDir, DEFAULT_FILE_NAME))).toBe(true);
      expect(storeRow(env)).toBeUndefined();
    },
  );

  it("restores a source changed before Doctor could claim it", async () => {
    const { env, stateDir } = useStateDir();
    const sourcePath = await writeLegacy({ stateDir });

    const result = await migrate(stateDir, env, {
      beforeClaim: (candidate) => fs.appendFileSync(candidate, " "),
    });

    expect(result.warnings[0]).toContain("changed before Doctor could claim it");
    expect(fs.existsSync(sourcePath)).toBe(true);
    expect(fs.existsSync(`${sourcePath}.doctor-importing`)).toBe(false);
    expect(storeRow(env)).toBeUndefined();
    expect(receipt(env)).toBeUndefined();
  });

  it("imports a valid interrupted claim", async () => {
    const { env, stateDir } = useStateDir();
    const sourcePath = await writeLegacy({ stateDir });
    const claimPath = `${sourcePath}.doctor-importing`;
    await fsp.rename(sourcePath, claimPath);

    const result = await migrate(stateDir, env);

    expect(result.warnings).toEqual([]);
    expect(storeRow(env)).toBeDefined();
    expect(fs.existsSync(sourcePath)).toBe(false);
    expect(fs.existsSync(claimPath)).toBe(false);
  });

  it("refuses source and interrupted claim together without a receipt", async () => {
    const { env, stateDir } = useStateDir();
    const sourcePath = await writeLegacy({ stateDir });
    await fsp.copyFile(sourcePath, `${sourcePath}.doctor-importing`);

    const result = await migrate(stateDir, env);

    expect(result.warnings[0]).toContain("source and interrupted claim both exist");
    expect(storeRow(env)).toBeUndefined();
    expect(receipt(env)).toBeUndefined();
  });

  it("uses the receipt for cleanup-only retries and cannot resurrect deleted canonical state", async () => {
    const { env, stateDir } = useStateDir();
    const sourcePath = await writeLegacy({ stateDir });
    const first = await migrate(stateDir, env, {
      removeSource: () => {
        throw new Error("simulated unlink failure");
      },
    });
    expect(first.warnings[0]).toContain("legacy cleanup failed");
    expect(storeRow(env)).toBeDefined();
    expect(fs.existsSync(`${sourcePath}.doctor-importing`)).toBe(true);
    expect(receipt(env, sourcePath)).toMatchObject({ removed_source: 0 });

    deleteCanonical(env);
    await writeLegacy({
      stateDir,
      value: validStore({ tokens: { access_token: "decoy-token", token_type: "Bearer" } }),
    });
    const retry = await migrate(stateDir, env);

    expect(retry.warnings).toEqual([]);
    expect(retry.changes).toContain(
      "Discarded recreated retired MCP OAuth JSON without importing it.",
    );
    expect(storeRow(env)).toBeUndefined();
    expect(fs.existsSync(sourcePath)).toBe(false);
    expect(fs.existsSync(`${sourcePath}.doctor-importing`)).toBe(false);
    expect(receipt(env, sourcePath)).toMatchObject({ removed_source: 1 });
  });

  it("rejects symlinked, hardlinked, oversized, and invalid-UTF-8 sources", async () => {
    const cases: Array<{ env: NodeJS.ProcessEnv; sourcePath: string; stateDir: string }> = [];

    const symlink = useStateDir();
    const symlinkTarget = path.join(symlink.stateDir, "outside.json");
    await fsp.writeFile(symlinkTarget, JSON.stringify(validStore()), "utf8");
    const symlinkPath = path.join(symlink.stateDir, "mcp-oauth", DEFAULT_FILE_NAME);
    await fsp.mkdir(path.dirname(symlinkPath), { recursive: true });
    await fsp.symlink(symlinkTarget, symlinkPath);
    cases.push({ ...symlink, sourcePath: symlinkPath });

    const hardlink = useStateDir();
    const hardlinkTarget = path.join(hardlink.stateDir, "outside.json");
    await fsp.writeFile(hardlinkTarget, JSON.stringify(validStore()), "utf8");
    const hardlinkPath = path.join(hardlink.stateDir, "mcp-oauth", DEFAULT_FILE_NAME);
    await fsp.mkdir(path.dirname(hardlinkPath), { recursive: true });
    await fsp.link(hardlinkTarget, hardlinkPath);
    cases.push({ ...hardlink, sourcePath: hardlinkPath });

    const oversized = useStateDir();
    const oversizedPath = await writeLegacy({
      stateDir: oversized.stateDir,
      bytes: Buffer.alloc(4 * 1024 * 1024 + 1, 0x20),
    });
    cases.push({ ...oversized, sourcePath: oversizedPath });

    const invalidUtf8 = useStateDir();
    const invalidUtf8Path = await writeLegacy({
      stateDir: invalidUtf8.stateDir,
      bytes: Buffer.from([0xff, 0xfe]),
    });
    cases.push({ ...invalidUtf8, sourcePath: invalidUtf8Path });

    for (const testCase of cases) {
      closeOpenClawStateDatabaseForTest();
      const result = await migrate(testCase.stateDir, testCase.env);
      expect(result.warnings[0]).toContain("Failed reading legacy MCP OAuth store");
      expect(fs.existsSync(testCase.sourcePath)).toBe(true);
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
    let result: Awaited<ReturnType<typeof migrateLegacyMcpOAuthStores>>;
    try {
      result = await migrate(stateDir, env);
    } finally {
      await gatewayLock.release();
    }

    expect(result.warnings[0]).toContain("Gateway or another SQLite maintenance command");
    expect(fs.existsSync(sourcePath)).toBe(true);
  });

  it("records the digest of the exact imported source bytes", async () => {
    const { env, stateDir } = useStateDir();
    const bytes = Buffer.from(`${JSON.stringify(validStore())}\n`, "utf8");
    const sourcePath = await writeLegacy({ stateDir, bytes });

    await migrate(stateDir, env);

    expect(receipt(env, sourcePath)).toMatchObject({
      source_sha256: createHash("sha256").update(bytes).digest("hex"),
    });
  });
});
