// ACPX tests cover doctor migration of legacy runtime state.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createPluginStateKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import type {
  OpenKeyedStoreOptions,
  PluginDoctorStateMigrationContext,
} from "openclaw/plugin-sdk/runtime-doctor";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stateMigrations } from "./doctor-contract-api.js";
import { openAcpxProcessLeaseStateStore, type AcpxProcessLease } from "./src/process-lease.js";
import {
  ACPX_GATEWAY_INSTANCE_KEY,
  ACPX_GATEWAY_INSTANCE_MAX_ENTRIES,
  ACPX_GATEWAY_INSTANCE_NAMESPACE,
  ACPX_LEGACY_GATEWAY_INSTANCE_FILE,
  ACPX_LEGACY_PROCESS_LEASE_FILE,
  type AcpxGatewayInstanceRecord,
} from "./src/state.js";

function createDoctorContext(env: NodeJS.ProcessEnv): PluginDoctorStateMigrationContext {
  return {
    openPluginStateKeyedStore<T>(options: OpenKeyedStoreOptions) {
      return createPluginStateKeyedStoreForTests<T>("acpx", {
        ...options,
        env: options.env ?? env,
      });
    },
  };
}

describe("acpx doctor state migration", () => {
  let stateDir = "";
  let env: NodeJS.ProcessEnv;

  beforeEach(async () => {
    resetPluginStateStoreForTests();
    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-acpx-doctor-"));
    env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
  });

  afterEach(async () => {
    await fs.rm(stateDir, { recursive: true, force: true });
  });

  function migrationParams() {
    return {
      config: {},
      env,
      stateDir,
      oauthDir: path.join(stateDir, "oauth"),
      context: createDoctorContext(env),
    };
  }

  it("imports legacy gateway identity and open process leases into plugin state", async () => {
    const gatewayPath = path.join(stateDir, ACPX_LEGACY_GATEWAY_INSTANCE_FILE);
    const leasePath = path.join(stateDir, "acpx", ACPX_LEGACY_PROCESS_LEASE_FILE);
    const lease: AcpxProcessLease = {
      leaseId: "lease-1",
      gatewayInstanceId: "gw-test",
      sessionKey: "agent:codex:acp:test",
      wrapperRoot: path.join(stateDir, "acpx"),
      wrapperPath: path.join(stateDir, "acpx", "codex-acp-wrapper.mjs"),
      rootPid: 101,
      commandHash: "hash",
      startedAt: 1,
      state: "open",
    };
    await fs.mkdir(path.dirname(leasePath), { recursive: true });
    await fs.writeFile(gatewayPath, "gw-test\n", "utf8");
    await fs.writeFile(
      leasePath,
      JSON.stringify({
        version: 1,
        leases: [
          lease,
          {
            ...lease,
            leaseId: "closed-lease",
            state: "closed",
          },
        ],
      }),
      "utf8",
    );

    const migration = stateMigrations[0];
    await expect(migration.detectLegacyState(migrationParams())).resolves.toMatchObject({
      preview: [
        expect.stringContaining("ACPX gateway instance id"),
        expect.stringContaining("1 open lease"),
      ],
    });

    const result = await migration.migrateLegacyState(migrationParams());

    expect(result.warnings).toEqual([]);
    expect(result.changes).toEqual([
      "Migrated ACPX gateway instance id -> plugin state",
      expect.stringContaining("Archived ACPX gateway-instance-id legacy source"),
      "Migrated ACPX process leases -> plugin state (1 imported, 0 already present)",
      expect.stringContaining("Archived ACPX process-leases legacy source"),
    ]);
    await expect(fs.access(gatewayPath)).rejects.toThrow();
    await expect(fs.access(`${gatewayPath}.migrated`)).resolves.toBeUndefined();
    await expect(fs.access(leasePath)).rejects.toThrow();
    await expect(fs.access(`${leasePath}.migrated`)).resolves.toBeUndefined();
    await expect(
      createDoctorContext(env)
        .openPluginStateKeyedStore<AcpxGatewayInstanceRecord>({
          namespace: ACPX_GATEWAY_INSTANCE_NAMESPACE,
          maxEntries: ACPX_GATEWAY_INSTANCE_MAX_ENTRIES,
        })
        .lookup(ACPX_GATEWAY_INSTANCE_KEY),
    ).resolves.toMatchObject({ instanceId: "gw-test" });
    await expect(
      openAcpxProcessLeaseStateStore(createDoctorContext(env).openPluginStateKeyedStore).lookup(
        "lease-1",
      ),
    ).resolves.toEqual(lease);
    await expect(
      openAcpxProcessLeaseStateStore(createDoctorContext(env).openPluginStateKeyedStore).lookup(
        "closed-lease",
      ),
    ).resolves.toBeUndefined();
  });

  it("ignores legacy process lease files without open cleanup work", async () => {
    const leasePath = path.join(stateDir, "acpx", ACPX_LEGACY_PROCESS_LEASE_FILE);
    await fs.mkdir(path.dirname(leasePath), { recursive: true });
    await fs.writeFile(
      leasePath,
      JSON.stringify({
        version: 1,
        leases: [
          {
            leaseId: "closed-lease",
            gatewayInstanceId: "gw-test",
            sessionKey: "agent:codex:acp:test",
            wrapperRoot: path.join(stateDir, "acpx"),
            wrapperPath: path.join(stateDir, "acpx", "codex-acp-wrapper.mjs"),
            rootPid: 101,
            commandHash: "hash",
            startedAt: 1,
            state: "closed",
          },
        ],
      }),
      "utf8",
    );

    const migration = stateMigrations[0];

    await expect(migration.detectLegacyState(migrationParams())).resolves.toBeNull();
    await expect(migration.migrateLegacyState(migrationParams())).resolves.toEqual({
      changes: [],
      warnings: [],
    });
    await expect(fs.access(leasePath)).resolves.toBeUndefined();
  });

  it("leaves legacy leases in place when the canonical gateway id would not reap them", async () => {
    const gatewayPath = path.join(stateDir, ACPX_LEGACY_GATEWAY_INSTANCE_FILE);
    const leasePath = path.join(stateDir, "acpx", ACPX_LEGACY_PROCESS_LEASE_FILE);
    await fs.mkdir(path.dirname(leasePath), { recursive: true });
    await fs.writeFile(gatewayPath, "legacy-gw\n", "utf8");
    await fs.writeFile(
      leasePath,
      JSON.stringify({
        version: 1,
        leases: [
          {
            leaseId: "lease-1",
            gatewayInstanceId: "legacy-gw",
            sessionKey: "agent:codex:acp:test",
            wrapperRoot: path.join(stateDir, "acpx"),
            wrapperPath: path.join(stateDir, "acpx", "codex-acp-wrapper.mjs"),
            rootPid: 101,
            commandHash: "hash",
            startedAt: 1,
            state: "open",
          },
        ],
      }),
      "utf8",
    );
    await createDoctorContext(env)
      .openPluginStateKeyedStore<AcpxGatewayInstanceRecord>({
        namespace: ACPX_GATEWAY_INSTANCE_NAMESPACE,
        maxEntries: ACPX_GATEWAY_INSTANCE_MAX_ENTRIES,
      })
      .register(ACPX_GATEWAY_INSTANCE_KEY, {
        instanceId: "current-gw",
        createdAt: 2,
      });
    await openAcpxProcessLeaseStateStore(
      createDoctorContext(env).openPluginStateKeyedStore,
    ).register("current-lease", {
      leaseId: "current-lease",
      gatewayInstanceId: "current-gw",
      sessionKey: "agent:codex:acp:current",
      wrapperRoot: path.join(stateDir, "acpx"),
      wrapperPath: path.join(stateDir, "acpx", "codex-acp-wrapper.mjs"),
      rootPid: 202,
      commandHash: "hash-current",
      startedAt: 2,
      state: "open",
    });

    const result = await stateMigrations[0].migrateLegacyState(migrationParams());

    expect(result.changes).toEqual([]);
    expect(result.warnings).toEqual([
      "Skipped ACPX process lease migration because legacy leases do not match the canonical gateway instance id; left legacy sources in place for manual cleanup",
    ]);
    await expect(fs.access(gatewayPath)).resolves.toBeUndefined();
    await expect(fs.access(leasePath)).resolves.toBeUndefined();
    await expect(
      openAcpxProcessLeaseStateStore(createDoctorContext(env).openPluginStateKeyedStore).lookup(
        "lease-1",
      ),
    ).resolves.toBeUndefined();
  });

  it("adopts the legacy gateway id when upgraded startup created only an empty sqlite id", async () => {
    const gatewayPath = path.join(stateDir, ACPX_LEGACY_GATEWAY_INSTANCE_FILE);
    const leasePath = path.join(stateDir, "acpx", ACPX_LEGACY_PROCESS_LEASE_FILE);
    const legacyLease: AcpxProcessLease = {
      leaseId: "legacy-lease",
      gatewayInstanceId: "legacy-gw",
      sessionKey: "agent:codex:acp:test",
      wrapperRoot: path.join(stateDir, "acpx"),
      wrapperPath: path.join(stateDir, "acpx", "codex-acp-wrapper.mjs"),
      rootPid: 101,
      commandHash: "hash",
      startedAt: 1,
      state: "open",
    };
    await fs.mkdir(path.dirname(leasePath), { recursive: true });
    await fs.writeFile(gatewayPath, "legacy-gw\n", "utf8");
    await fs.writeFile(leasePath, JSON.stringify({ version: 1, leases: [legacyLease] }), "utf8");
    await createDoctorContext(env)
      .openPluginStateKeyedStore<AcpxGatewayInstanceRecord>({
        namespace: ACPX_GATEWAY_INSTANCE_NAMESPACE,
        maxEntries: ACPX_GATEWAY_INSTANCE_MAX_ENTRIES,
      })
      .register(ACPX_GATEWAY_INSTANCE_KEY, {
        instanceId: "fresh-empty-gw",
        createdAt: 2,
      });

    const result = await stateMigrations[0].migrateLegacyState(migrationParams());

    expect(result.warnings).toEqual([]);
    expect(result.changes).toEqual([
      "Migrated ACPX gateway instance id -> plugin state",
      expect.stringContaining("Archived ACPX gateway-instance-id legacy source"),
      "Migrated ACPX process leases -> plugin state (1 imported, 0 already present)",
      expect.stringContaining("Archived ACPX process-leases legacy source"),
    ]);
    await expect(
      createDoctorContext(env)
        .openPluginStateKeyedStore<AcpxGatewayInstanceRecord>({
          namespace: ACPX_GATEWAY_INSTANCE_NAMESPACE,
          maxEntries: ACPX_GATEWAY_INSTANCE_MAX_ENTRIES,
        })
        .lookup(ACPX_GATEWAY_INSTANCE_KEY),
    ).resolves.toMatchObject({ instanceId: "legacy-gw" });
    await expect(
      openAcpxProcessLeaseStateStore(createDoctorContext(env).openPluginStateKeyedStore).lookup(
        "legacy-lease",
      ),
    ).resolves.toEqual(legacyLease);
  });
});
