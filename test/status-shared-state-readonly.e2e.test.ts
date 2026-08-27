// Status shared-state E2E tests enforce the CLI/Gateway SQLite ownership boundary.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { writePersistedInstalledPluginIndexInstallRecords } from "../src/plugins/installed-plugin-index-records.js";
import { createOpenClawTestInstance } from "./helpers/openclaw-test-instance.js";

const DEGRADED_PLUGIN_ID = "status-degraded-plugin";

function createUnavailablePluginFixture(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-status-degraded-plugin-"));
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({
      name: DEGRADED_PLUGIN_ID,
      version: "1.0.0",
      type: "module",
      main: "./missing-main.js",
      openclaw: { extensions: ["./index.js"] },
      peerDependencies: { openclaw: ">=2026.1.1" },
    }),
  );
  fs.writeFileSync(
    path.join(root, "openclaw.plugin.json"),
    JSON.stringify({
      id: DEGRADED_PLUGIN_ID,
      configSchema: { type: "object", additionalProperties: false, properties: {} },
    }),
  );
  fs.writeFileSync(path.join(root, "index.js"), "export default { register() {} };\n");
  return root;
}

function seedInspectableTask(db: DatabaseSync): void {
  const now = Date.now();
  // Seed through the persisted schema so the CLI must inspect state owned by
  // another process instead of seeing its own in-memory registry.
  db.prepare(
    `INSERT INTO task_runs (
       task_id, runtime, requester_session_key, owner_key, scope_kind,
       child_session_key, agent_id, task, status, delivery_status,
       notify_policy, created_at, last_event_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    // Keep the task inside the reconciliation grace window so status should
    // report the committed running record unchanged.
    "status-read-only-task",
    "subagent",
    "agent:main:main",
    "agent:main:main",
    "session",
    "agent:main:subagent:status-read-only",
    "main",
    "Prove status reads shared task state without joining its write lifecycle",
    "running",
    "pending",
    "done_only",
    now,
    now,
  );
}

describe("status shared-state ownership", () => {
  it("projects Gateway-owned runtime degradation across status processes", async () => {
    const pluginRoot = createUnavailablePluginFixture();
    const instance = await createOpenClawTestInstance({
      name: "status-runtime-degradation",
      env: {
        STATUS_E2E_MISSING_SECRET: undefined,
        VITEST: undefined,
        VITEST_POOL_ID: undefined,
        VITEST_WORKER_ID: undefined,
      },
      config: {
        tts: {
          providers: {
            elevenlabs: {
              apiKey: {
                source: "env",
                provider: "default",
                id: "STATUS_E2E_MISSING_SECRET",
              },
            },
          },
        },
        plugins: {
          enabled: true,
          allow: [DEGRADED_PLUGIN_ID],
          load: { paths: [pluginRoot] },
          entries: { [DEGRADED_PLUGIN_ID]: { enabled: true } },
        },
      },
    });
    try {
      await writePersistedInstalledPluginIndexInstallRecords(
        {
          [DEGRADED_PLUGIN_ID]: {
            source: "npm",
            spec: DEGRADED_PLUGIN_ID,
            installPath: pluginRoot,
          },
        },
        { env: instance.env },
      );
      await instance.startGateway();

      const rpc = await instance.cli(["gateway", "call", "status", "--json"]);
      expect(rpc.code, rpc.stderr).toBe(0);
      const gatewayStatus = JSON.parse(rpc.stdout) as {
        degradedSecretOwners: unknown[];
        degradedPlugins: unknown[];
      };
      expect(gatewayStatus.degradedSecretOwners).toEqual([
        expect.objectContaining({
          ownerKind: "capability",
          ownerId: "tts",
          paths: ["tts.providers.elevenlabs.apiKey"],
          reason: "secret reference was not found",
        }),
      ]);
      expect(gatewayStatus.degradedPlugins).toEqual([
        expect.objectContaining({
          pluginId: DEGRADED_PLUGIN_ID,
          state: "configured-unavailable",
          diagnostic: expect.objectContaining({ reason: "missing-openclaw-peer-link" }),
        }),
      ]);

      for (const args of [["status"], ["status", "--all"], ["status", "--json"]]) {
        const status = await instance.cli(args, { timeoutMs: 60_000 });
        expect(status.code, status.stderr).toBe(0);
        if (args.includes("--json")) {
          const payload = JSON.parse(status.stdout) as typeof gatewayStatus;
          expect(payload.degradedSecretOwners).toEqual(gatewayStatus.degradedSecretOwners);
          expect(payload.degradedPlugins).toEqual(gatewayStatus.degradedPlugins);
        } else {
          expect(status.stdout).toContain("Degraded secrets");
          expect(status.stdout).toContain("capability:tts");
          expect(status.stdout).toContain("Degraded plugins");
          expect(status.stdout).toContain(DEGRADED_PLUGIN_ID);
        }
        expect(`${status.stdout}\n${status.stderr}`).not.toContain("STATUS_E2E_MISSING_SECRET");
        expect(`${status.stdout}\n${status.stderr}`).not.toContain(pluginRoot);
      }

      const logs = instance.logs();
      expect(logs).toContain("Secret owner capability:tts is configured-unavailable");
      expect(logs).toContain(`Plugin \"${DEGRADED_PLUGIN_ID}\"`);
      expect(logs).not.toContain("STATUS_E2E_MISSING_SECRET");
    } finally {
      await instance.cleanup();
      fs.rmSync(pluginRoot, { recursive: true, force: true });
    }
  }, 120_000);

  it("keeps healthy and unreachable Gateway degradation summaries empty", async () => {
    const instance = await createOpenClawTestInstance({ name: "status-runtime-healthy" });
    try {
      await instance.startGateway();
      const healthy = await instance.cli(["status", "--json"]);
      expect(healthy.code, healthy.stderr).toBe(0);
      expect(JSON.parse(healthy.stdout)).toMatchObject({
        degradedSecretOwners: [],
        degradedPlugins: [],
      });

      await instance.stopGateway();
      const unreachable = await instance.cli(["status", "--json"]);
      expect(unreachable.code, unreachable.stderr).toBe(0);
      expect(JSON.parse(unreachable.stdout)).toMatchObject({
        degradedSecretOwners: [],
        degradedPlugins: [],
      });
    } finally {
      await instance.cleanup();
    }
  }, 120_000);

  it.each([
    { name: "text status", args: ["status"] },
    { name: "JSON status", args: ["status", "--json"] },
    { name: "all status", args: ["status", "--all"] },
    { name: "channel probe", args: ["channels", "status", "--probe", "--json"] },
  ])(
    "does not create shared state during $name",
    async ({ name, args }) => {
      const instance = await createOpenClawTestInstance({
        name: `status-read-only-${name.replaceAll(" ", "-")}`,
      });
      const databasePath = path.join(instance.stateDir, "state", "openclaw.sqlite");
      try {
        expect(fs.existsSync(databasePath)).toBe(false);

        const status = await instance.cli(args);

        expect(status.code, status.stderr).toBe(0);
        if (args[0] === "status" && args.includes("--json")) {
          expect(JSON.parse(status.stdout)).toMatchObject({ tasks: { total: 0 } });
        }
        expect(fs.existsSync(databasePath)).toBe(false);
      } finally {
        await instance.cleanup();
      }
    },
    120_000,
  );

  it("reads committed tasks while the Gateway owns state and another writer is active", async () => {
    const instance = await createOpenClawTestInstance({ name: "status-read-only-live-gateway" });
    const databasePath = path.join(instance.stateDir, "state", "openclaw.sqlite");
    let writer: DatabaseSync | undefined;
    try {
      await instance.startGateway();
      writer = new DatabaseSync(databasePath);
      seedInspectableTask(writer);
      // A read-only status path can overlap this writer. Writable schema/bootstrap work cannot.
      writer.exec("BEGIN IMMEDIATE");

      const status = await instance.cli(["status", "--json"], { timeoutMs: 15_000 });

      expect(status.code, status.stderr).toBe(0);
      expect(JSON.parse(status.stdout)).toMatchObject({ tasks: { total: 1 } });
      expect(instance.child?.exitCode).toBeNull();

      writer.exec("ROLLBACK");
      writer.close();
      writer = undefined;
      await instance.stopGateway();

      const verifier = new DatabaseSync(databasePath, { readOnly: true });
      try {
        expect(verifier.prepare("PRAGMA integrity_check").get()).toEqual({
          integrity_check: "ok",
        });
      } finally {
        verifier.close();
      }
    } finally {
      if (writer?.isTransaction) {
        writer.exec("ROLLBACK");
      }
      writer?.close();
      await instance.cleanup();
    }
  }, 120_000);
});
