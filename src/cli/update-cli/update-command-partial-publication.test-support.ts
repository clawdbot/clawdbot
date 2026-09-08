import fs from "node:fs/promises";
import path from "node:path";
import { inspect } from "node:util";
import { expect, vi } from "vitest";
import { resolveGatewayService } from "../../daemon/service.js";
import { openNodeSqliteDatabase } from "../../infra/node-sqlite.js";
import * as checkpoint from "../../infra/update-run-recovery-checkpoint.js";
import { loadUpdateRecovery } from "../../infra/update-run-recovery.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { withEnvAsync } from "../../test-utils/env.js";
import * as shared from "./shared.js";
import { completeUpdateCommandCandidate } from "./update-command-candidate-completion.js";
import * as replayAccess from "./update-command-checkpoint-replay.js";
import { withUpdateCommandExecutor } from "./update-command-executor.js";
import type { FinishUpdateParams } from "./update-command-post-update.js";
import { discoverUpdateCommandRecovery } from "./update-command-replay-inspection.js";
import { UpdateCommandFinalizedRecoveryFailure } from "./update-command-result.js";
import * as stoppedAdmission from "./update-command-stopped-admission.js";
import { updateCommand } from "./update-command.js";

/** Interrupt after the driver's fourth observation, not by editing a saved row.
 * Ordinary CLI re-entry must keep the sealed plan and finish the original run. */
export async function interruptPartialPublicationReplay(
  params: FinishUpdateParams,
  options: { refusalsOnly?: boolean; custodyOnly?: boolean } = {},
) {
  const recovery = params.opts.recovery!;
  const env = params.opts.run!.env;
  let interrupted = false;
  const create = checkpoint.createUpdateRecoveryCheckpointAdapter;
  const cut = vi
    .spyOn(checkpoint, "createUpdateRecoveryCheckpointAdapter")
    .mockImplementation((input) => {
      const adapter = create(input);
      const next = adapter.next;
      adapter.next = async () => {
        if (
          adapter.record.restore?.resourceCursor === 3 &&
          adapter.record.restore.phase === "observed"
        ) {
          interrupted = true;
          throw new Error("fixture interruption after fourth publication observation");
        }
        return next();
      };
      return adapter;
    });
  const failure = await completeUpdateCommandCandidate(params).catch((error: unknown) => error);
  cut.mockRestore();
  expect(interrupted, inspect(failure, { depth: 8 })).toBe(true);
  const record = recovery.getRecord();
  expect(record.terminal).toBeUndefined();
  expect(record.restore).toMatchObject({ resourceCursor: 3, phase: "observed" });
  expect(record.effects.at(-1)).toMatchObject({ kind: "checkpoint-restore", state: "intent" });
  expect(record.effects).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        kind: "service-restart",
        runtime: "candidate",
        state: "cancelled",
      }),
      expect.objectContaining({ kind: "package-restore", state: "observed" }),
    ]),
  );
  expect(record.nativeManager!.effects.at(-1)).toMatchObject({ action: "stop", state: "observed" });
  expect(record.afterImages).toHaveLength(3);
  const planBytes = await fs.readFile(record.restore!.planPath);
  const plan = JSON.parse(planBytes.toString());
  expect(plan.resources).toHaveLength(5);
  expect(await discoverUpdateCommandRecovery(env)).toEqual(record);
  await expect(
    withUpdateCommandExecutor(record.runId, async (executor) => {
      await executor.enter(params.root);
    }),
  ).rejects.toThrow(/Another update executor/);
  const file = resolveOpenClawStateSqlitePath(env);
  const db = openNodeSqliteDatabase(file, { readOnly: true });
  const expiry = Number(
    db.prepare("SELECT MAX(expires_at) AS expiry FROM state_leases").get()?.expiry,
  );
  db.close();
  return async () => {
    closeOpenClawStateDatabaseForTest();
    if (expiry > Date.now()) {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, expiry - Date.now() + 30);
      });
    }
    const root = vi.spyOn(shared, "resolveUpdateRoot").mockResolvedValue(path.dirname(params.root));
    const invoke = (profile = env.OPENCLAW_PROFILE) =>
      withEnvAsync({ OPENCLAW_UPDATE_RUN_ID: undefined, OPENCLAW_PROFILE: profile }, () =>
        updateCommand({ json: true, yes: true }),
      ).catch((error: unknown) => error);
    if (options.refusalsOnly) {
      const service = resolveGatewayService();
      const runtime = service.readRuntime;
      const launcher = record.package!.descriptor.launchers[0]!;
      const launcherPath = path.join(record.package!.descriptor.binDir, launcher.name);
      const launcherBytes = await fs.readFile(launcherPath);
      const config = await fs.readFile(env.OPENCLAW_CONFIG_PATH!);
      const starts = vi.mocked(service.start).mock.calls.length;
      const stop = vi.spyOn(service, "stop");
      // File probes intentionally change identity clocks even when bytes are
      // put back. Exercise native guards first so those probes cannot mask them.
      const faults = options.custodyOnly
        ? (["late-candidate", "late-launcher"] as const)
        : (["profile", "manager", "running", "enabled", "package", "source", "plan"] as const);
      for (const fault of faults) {
        let faultOutcome: unknown;
        let undo: (() => void | Promise<void>) | undefined;
        if (fault === "late-candidate") {
          const verify = stoppedAdmission.verifyStoppedServiceReplayPackage;
          const displaced = `${record.package!.descriptor.backupRoot}.candidate`;
          const retained = `${displaced}.fixture-held`;
          let moved = false;
          const spy = vi
            .spyOn(stoppedAdmission, "verifyStoppedServiceReplayPackage")
            .mockImplementation(async (...args) => {
              await verify(...args);
              if (!moved) {
                await fs.rename(displaced, retained);
                moved = true;
              }
            });
          undo = async () => {
            spy.mockRestore();
            expect(moved, inspect(faultOutcome, { depth: 10 })).toBe(true);
            if (moved) {
              await fs.rename(retained, displaced);
            }
          };
        } else if (fault === "late-launcher") {
          const createReplayAccess = replayAccess.createUpdateCommandCheckpointReplayAccess;
          let changed = false;
          const spy = vi
            .spyOn(replayAccess, "createUpdateCommandCheckpointReplayAccess")
            .mockImplementation((input) => {
              const access = createReplayAccess(input);
              const prepare = access.prepareCanonicalWrite!;
              access.prepareCanonicalWrite = async (current) => {
                if (!changed) {
                  await fs.writeFile(launcherPath, "candidate launcher\n");
                  changed = true;
                }
                return prepare(current);
              };
              return access;
            });
          undo = async () => {
            spy.mockRestore();
            expect(changed, inspect(faultOutcome, { depth: 10 })).toBe(true);
            await fs.writeFile(launcherPath, launcherBytes);
          };
        } else if (fault === "plan" || fault === "source" || fault === "package") {
          const target =
            fault === "plan"
              ? record.restore!.planPath
              : fault === "source"
                ? env.OPENCLAW_CONFIG_PATH!
                : launcherPath;
          const bytes = await fs.readFile(target);
          await fs.writeFile(target, fault === "plan" ? "{}" : "changed operator bytes\n");
          undo = () => fs.writeFile(target, bytes);
        } else if (fault === "manager" || fault === "running") {
          let inspected = false;
          const spy = vi
            .spyOn(service, "readRuntime")
            .mockImplementation(async (readEnv, inspection) => {
              const value = await runtime(readEnv, inspection);
              inspected = true;
              return fault === "manager"
                ? { ...value, systemd: { ...value.systemd, managerUid: 2002 } }
                : { ...value, status: "running", pid: process.pid };
            });
          undo = () => {
            spy.mockRestore();
            expect(inspected, inspect(faultOutcome, { depth: 8 })).toBe(true);
          };
        } else if (fault === "enabled") {
          let inspected = false;
          const spy = vi.spyOn(service, "isEnabled").mockImplementation(async () => {
            inspected = true;
            return true;
          });
          undo = () => {
            spy.mockRestore();
            expect(inspected, inspect(faultOutcome, { depth: 8 })).toBe(true);
          };
        }
        try {
          const refused = await invoke(fault === "profile" ? "foreign" : undefined);
          faultOutcome = refused;
          expect(refused, fault).toBeInstanceOf(Error);
          expect(refused, fault).not.toBeInstanceOf(UpdateCommandFinalizedRecoveryFailure);
          expect(loadUpdateRecovery(record.runId, { env }), fault).toEqual(record);
          expect(service.start, fault).toHaveBeenCalledTimes(starts);
          expect(stop, fault).not.toHaveBeenCalled();
        } finally {
          await undo?.();
        }
        expect(await fs.readFile(record.restore!.planPath), fault).toEqual(planBytes);
        expect(await fs.readFile(env.OPENCLAW_CONFIG_PATH!), fault).toEqual(config);
        expect(await fs.readFile(launcherPath), fault).toEqual(launcherBytes);
      }
      stop.mockRestore();
      root.mockRestore();
      return;
    }
    const outcome = await invoke();
    root.mockRestore();
    expect(outcome, inspect(outcome, { depth: 12 })).toBeInstanceOf(
      UpdateCommandFinalizedRecoveryFailure,
    );
    const current = loadUpdateRecovery(record.runId, { env })!;
    expect(current.terminal).toMatchObject({
      status: "rolled-back",
      receipt: { runtime: "previous" },
    });
    expect(current.restore).toMatchObject({
      restoreId: record.restore!.restoreId,
      planSha256: record.restore!.planSha256,
      resourceCursor: 4,
      phase: "observed",
    });
    expect(await fs.readFile(record.restore!.planPath)).toEqual(planBytes);
    const canonical = openNodeSqliteDatabase(file, { readOnly: true });
    expect(canonical.prepare("SELECT COUNT(*) AS n FROM update_runs").get()?.n).toBe(1);
    canonical.close();
  };
}
