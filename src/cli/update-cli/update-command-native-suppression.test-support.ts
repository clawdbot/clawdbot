import fs from "node:fs/promises";
import path from "node:path";
import { inspect } from "node:util";
import { expect, vi } from "vitest";
import { captureConfigWriteLockGuard } from "../../config/write-lock.js";
import { resolveGatewayService } from "../../daemon/service.js";
import { openNodeSqliteDatabase } from "../../infra/node-sqlite.js";
import * as recoveryLedger from "../../infra/update-run-recovery.js";
import { loadUpdateRecovery } from "../../infra/update-run-recovery.js";
import { defaultRuntime } from "../../runtime.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { withEnvAsync } from "../../test-utils/env.js";
import * as updateShared from "./shared.js";
import { completeUpdateCommandCandidate } from "./update-command-candidate-completion.js";
import { withUpdateCommandExecutor } from "./update-command-executor.js";
import type { FinishUpdateParams } from "./update-command-post-update.js";
import { UpdateCommandFinalizedRecoveryFailure } from "./update-command-result.js";
import { updateCommand } from "./update-command.js";

/** Leave the first real executor after disable/stop applied but readback was interrupted.
 * Only a new owner may reconcile the same pending operation and fresh native stop. */
export async function interruptNativeSuppressionReplay(
  params: FinishUpdateParams,
  releaseInspection: () => void,
  action: "stop" | "suppress" = "suppress",
): Promise<() => Promise<void>> {
  const recovery = params.opts.recovery!;
  const env = params.opts.run!.env;
  const outcome = await completeUpdateCommandCandidate(params).catch((error: unknown) => error);
  expect(outcome).toBeInstanceOf(Error);
  const pending = recovery.getRecord();
  const suppression = structuredClone(pending.nativeManager!.effects.at(-1)!);
  expect(suppression).toMatchObject({
    action,
    state: "intent",
    before: { enabled: action === "suppress", loaded: true, stopped: false },
    after: { enabled: false, loaded: true, stopped: action === "stop" },
  });
  expect(pending.effects.at(-1)).toMatchObject({
    kind: "service-restart",
    runtime: "candidate",
    state: "intent",
    observedIdentity: null,
  });
  expect(
    pending.effects.some((effect) =>
      ["package-restore", "checkpoint-restore"].includes(effect.kind),
    ),
  ).toBe(false);
  expect(pending.restore).toBeNull();
  expect(pending.terminal).toBeUndefined();
  await expect(
    withUpdateCommandExecutor(pending.runId, async (executor) => {
      await executor.enter(params.root);
    }),
  ).rejects.toThrow(/Another update executor/);
  return async () => {
    releaseInspection();
    closeOpenClawStateDatabaseForTest();
    const invoker = path.join(path.dirname(params.root), "independent-updater");
    await fs.mkdir(invoker, { recursive: true });
    await fs.writeFile(
      path.join(invoker, "package.json"),
      JSON.stringify({ name: "openclaw", version: "3.0.0" }),
    );
    const root = vi
      .spyOn(updateShared, "resolveUpdateRoot")
      .mockResolvedValue(action === "stop" ? invoker : params.root);
    const exit = vi.spyOn(defaultRuntime, "exit").mockImplementation((code) => {
      throw new Error(`fixture CLI exit ${code}`);
    });
    const invoke = (profile = env.OPENCLAW_PROFILE) =>
      withEnvAsync(
        {
          OPENCLAW_UPDATE_RUN_ID: undefined,
          OPENCLAW_PROFILE: profile,
        },
        () => updateCommand({ json: true, yes: true }),
      ).catch((error: unknown) => error);
    if (action === "stop") {
      const service = resolveGatewayService();
      const command = service.readCommand;
      const runtime = service.readRuntime;
      const config = await fs.readFile(env.OPENCLAW_CONFIG_PATH!);
      const launcher = pending.package!.descriptor.launchers[0]!;
      const launcherPath = path.join(pending.package!.descriptor.binDir, launcher.name);
      const launcherBytes = await fs.readFile(launcherPath);
      const calls = vi.mocked(service.start).mock.calls.length;
      const stop = vi.spyOn(service, "stop");
      for (const fault of [
        "profile",
        "command",
        "manager",
        "running",
        "enabled",
        "late-running",
        "checkpoint",
      ] as const) {
        let undo: (() => void | Promise<void>) | undefined;
        if (fault === "checkpoint") {
          const manifest = pending.checkpoint!.ref.manifestPath;
          const bytes = await fs.readFile(manifest);
          await fs.writeFile(manifest, "{}");
          undo = () => fs.writeFile(manifest, bytes);
        } else if (fault === "late-running") {
          let inspected = 0;
          const runtimeSpy = vi
            .spyOn(service, "readRuntime")
            .mockImplementation(async (readEnv, options) => {
              const value = await runtime(readEnv, options);
              // The initial stable observation finishes three reads; the unit
              // changes before later filesystem checks and must be re-observed.
              return ++inspected > 3 ? { ...value, status: "running", pid: process.pid } : value;
            });
          undo = () => {
            runtimeSpy.mockRestore();
            expect(inspected).toBeGreaterThanOrEqual(3);
          };
        } else if (fault === "command") {
          const spy = vi
            .spyOn(service, "readCommand")
            .mockImplementation(async (readEnv, options) => {
              const value = await command(readEnv, options);
              return (
                value && {
                  ...value,
                  programArguments: [
                    process.execPath,
                    path.join(invoker, "dist/index.js"),
                    "gateway",
                  ],
                }
              );
            });
          undo = () => spy.mockRestore();
        } else if (fault === "manager" || fault === "running") {
          const spy = vi
            .spyOn(service, "readRuntime")
            .mockImplementation(async (readEnv, options) => {
              const value = await runtime(readEnv, options);
              return fault === "manager"
                ? { ...value, systemd: { ...value.systemd, managerUid: 2002 } }
                : { ...value, status: "running", pid: process.pid };
            });
          undo = () => spy.mockRestore();
        } else if (fault === "enabled") {
          const spy = vi.spyOn(service, "isEnabled").mockResolvedValue(true);
          undo = () => spy.mockRestore();
        }
        try {
          const refused = await invoke(fault === "profile" ? "foreign" : undefined);
          expect(refused, fault).toBeInstanceOf(Error);
          expect(refused, fault).not.toBeInstanceOf(UpdateCommandFinalizedRecoveryFailure);
          expect(loadUpdateRecovery(pending.runId, { env }), fault).toEqual(pending);
          expect(await fs.readFile(env.OPENCLAW_CONFIG_PATH!), fault).toEqual(config);
          expect(await fs.readFile(launcherPath), fault).toEqual(launcherBytes);
          expect(service.start, fault).toHaveBeenCalledTimes(calls);
          expect(stop, fault).not.toHaveBeenCalled();
        } finally {
          await undo?.();
        }
      }
      stop.mockRestore();
    }
    const claim = recoveryLedger.claimUpdateRecovery;
    let checkedClaim = false;
    const claimSpy = vi
      .spyOn(recoveryLedger, "claimUpdateRecovery")
      .mockImplementation((...args) => {
        if (action === "stop" && args[0].claimId === pending.claimId) {
          const guard = captureConfigWriteLockGuard(env.OPENCLAW_CONFIG_PATH!);
          expect(guard, "the original source lock must remain live through reclaim").toBeDefined();
          guard!();
          checkedClaim = true;
        }
        return claim(...args);
      });
    const resumed = await invoke();
    claimSpy.mockRestore();
    if (action === "stop") {
      expect(checkedClaim).toBe(true);
    }
    root.mockRestore();
    exit.mockRestore();
    expect(resumed, inspect(resumed, { depth: 12 })).toBeInstanceOf(
      UpdateCommandFinalizedRecoveryFailure,
    );
    const current = loadUpdateRecovery(pending.runId, { env })!;
    expect(current.claimId).not.toBe(pending.claimId);
    expect(current.transactionId).toBe(pending.transactionId);
    expect(current.terminal).toMatchObject({
      status: "rolled-back",
      receipt: { runtime: "previous" },
    });
    const settled = current.nativeManager!.effects.find(
      (effect) => effect.effectId === suppression.effectId,
    )!;
    if (action === "stop") {
      expect(settled.state).toBe("observed");
      expect(settled.observedRevision).toBeGreaterThan(suppression.intentRevision);
    }
    expect(settled.before).toEqual(suppression.before);
    expect(settled.after).toEqual(suppression.after);
    expect(settled.intentRevision).toBe(suppression.intentRevision);
    const db = openNodeSqliteDatabase(resolveOpenClawStateSqlitePath(env), { readOnly: true });
    try {
      expect(db.prepare("SELECT COUNT(*) AS n FROM update_runs").get()?.n).toBe(1);
    } finally {
      db.close();
    }
  };
}
