import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  prepareGatewayRunBootstrap,
  recheckGatewayRunBootstrap,
} from "../cli/gateway-cli/pre-bootstrap.js";
import { withEnvOverride } from "../config/test-helpers.js";
import * as checkpoint from "../infra/startup-migration-checkpoint.js";
import { ExitError } from "../runtime.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { runDoctorConfigPreflight } from "./doctor-config-preflight.js";
import { withDoctorConfigPreflightHome } from "./doctor-config-preflight.test-support.js";

afterEach(() => {
  vi.restoreAllMocks();
  closeOpenClawStateDatabaseForTest();
});

it.each(["backup", "active config"] as const)(
  "refuses changed %s under the lease before any repair",
  async (kind) => {
    await withDoctorConfigPreflightHome(async (home) => {
      const stateDir = path.join(home, ".openclaw");
      const configPath = path.join(stateDir, "openclaw.json");
      await fs.mkdir(stateDir, { recursive: true });
      const backup = { gateway: { mode: "local" }, plugins: { enabled: false } };
      const original =
        kind === "backup" ? '{"update":{"channel":"stable"}}\n' : JSON.stringify(backup);
      const replacement = JSON.stringify(
        kind === "backup"
          ? {
              ...backup,
              meta: { lastTouchedVersion: "9999.1.1" },
              env: { vars: { OPENCLAW_SERVICE_MARKER: "openclaw" } },
            }
          : {
              ...backup,
              agents: { defaults: { workspace: path.join(home, "changed-workspace") } },
            },
      );
      openOpenClawStateDatabase({ path: path.join(stateDir, "state", "openclaw.sqlite") });
      closeOpenClawStateDatabaseForTest();
      const stateMigration = await import("../infra/state-migrations.state-dir.js");
      const migrateStateDir = vi.spyOn(stateMigration, "autoMigrateLegacyStateDir");
      await fs.writeFile(configPath, original);
      if (kind === "backup") {
        await fs.writeFile(`${configPath}.bak`, JSON.stringify(backup));
      }
      const runtime = {
        log() {},
        error() {},
        exit(code: number): never {
          throw new ExitError(code);
        },
      };
      await withEnvOverride(
        { OPENCLAW_ALLOW_OLDER_BINARY_DESTRUCTIVE_ACTIONS: undefined },
        async () => {
          expect(await prepareGatewayRunBootstrap({ opts: {}, runtime })).toBe(true);
          const acquire = checkpoint.acquireStartupMigrationLeaseWithWait;
          vi.spyOn(checkpoint, "acquireStartupMigrationLeaseWithWait").mockImplementationOnce(
            async (params) => {
              const lease = await acquire(params);
              await fs.writeFile(kind === "backup" ? `${configPath}.bak` : configPath, replacement);
              return lease;
            },
          );
          const refusal = await runDoctorConfigPreflight({
            migrateLegacyConfig: false,
            requireStartupMigrationCheckpoint: true,
            beforeStateMigrations: (snapshot) =>
              recheckGatewayRunBootstrap({ opts: {}, runtime, snapshot }),
          }).catch((error: unknown) => error);
          expect(migrateStateDir).not.toHaveBeenCalled();
          expect(refusal).toMatchObject({ code: kind === "backup" ? 78 : 1 });
          expect(await fs.readFile(configPath, "utf8")).toBe(
            kind === "backup" ? original : replacement,
          );
          expect(
            (await fs.readdir(stateDir)).filter((name) => name.includes(".clobbered.")),
          ).toEqual([]);
        },
      );
    });
  },
);

it.each(["expired", "reassigned"] as const)(
  "does not restore a backup after the migration lease is %s during admission",
  async (loss) => {
    await withDoctorConfigPreflightHome(async (home) => {
      const stateDir = path.join(home, ".openclaw");
      const configPath = path.join(stateDir, "openclaw.json");
      await fs.mkdir(stateDir, { recursive: true });
      const original = '{"update":{"channel":"stable"}}\n';
      await fs.writeFile(configPath, original);
      await fs.writeFile(
        `${configPath}.bak`,
        JSON.stringify({ gateway: { mode: "local" }, plugins: { enabled: false } }),
      );
      openOpenClawStateDatabase({ path: path.join(stateDir, "state", "openclaw.sqlite") });
      closeOpenClawStateDatabaseForTest();
      let replacement: checkpoint.StartupMigrationLease | undefined;
      vi.spyOn(checkpoint, "acquireStartupMigrationLeaseWithWait").mockImplementationOnce(
        async (params) => {
          const stale = checkpoint.acquireStartupMigrationLease({
            ...params,
            nowMs: Date.now() - checkpoint.STARTUP_MIGRATION_LEASE_TTL_MS - 1,
          });
          if (loss === "reassigned") {
            replacement = checkpoint.acquireStartupMigrationLease(params);
          }
          return stale;
        },
      );
      try {
        const refusal = await runDoctorConfigPreflight({
          migrateLegacyConfig: false,
          requireStartupMigrationCheckpoint: true,
        }).catch((error: unknown) => error);
        expect(await fs.readFile(configPath, "utf8")).toBe(original);
        expect((await fs.readdir(stateDir)).filter((name) => name.includes(".clobbered."))).toEqual(
          [],
        );
        expect(refusal).toBeInstanceOf(Error);
        expect(String(refusal)).toContain("startup migration lease was lost");
        replacement?.heartbeat();
      } finally {
        replacement?.release();
      }
    });
  },
);
