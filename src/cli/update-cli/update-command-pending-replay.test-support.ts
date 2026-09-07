import fs from "node:fs/promises";
import path from "node:path";
import { inspect } from "node:util";
import { expect, vi } from "vitest";
import { openNodeSqliteDatabase, resolveImmutableSqliteFileUri } from "../../infra/node-sqlite.js";
import * as checkpoint from "../../infra/update-checkpoint-restore.js";
import { loadUpdateRecovery } from "../../infra/update-run-recovery.js";
import * as pluginLease from "../../plugins/plugin-lifecycle-lease.js";
import * as agentLease from "../../state/openclaw-agent-db-maintenance-lease.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import * as updateShared from "./shared.js";
import { resumePendingUpdateCommand } from "./update-command-pending-replay.js";
import type { FinishUpdateParams } from "./update-command-post-update.js";
import { discoverUpdateCommandRecovery } from "./update-command-replay-inspection.js";
import { restoreUpdateCommandFailure } from "./update-command-restore.js";
import { UpdateCommandFinalizedRecoveryFailure } from "./update-command-result.js";
import { updateCommand } from "./update-command.js";

export function useShortRealReplayLeases() {
  const plugin = pluginLease.withPluginLifecycleLease;
  const agent = agentLease.withAgentDatabaseMaintenanceLease;
  vi.spyOn(pluginLease, "withPluginLifecycleLease").mockImplementation((options, operation) =>
    plugin({ ...options, leaseMs: 30_000 }, operation),
  );
  vi.spyOn(agentLease, "withAgentDatabaseMaintenanceLease").mockImplementation(
    (options, operation) => agent({ ...options, leaseMs: 30_000 }, operation),
  );
}

/** Cut the actual driver after canonical displacement, then leave the first
 * installation owner. A returned callback uses a NEW real executor and journal
 * claim; it never reconstructs a fence from the saved record. */
export async function interruptSealedReplay(
  params: FinishUpdateParams,
  conflict: boolean,
  shadowCanonical = false,
): Promise<() => Promise<void>> {
  const recovery = params.opts.recovery!;
  const env = params.opts.run!.env;
  const file = resolveOpenClawStateSqlitePath(env);
  let displacedPath = "";
  let interrupted = false;
  const original = checkpoint.restoreUpdateCheckpointResource;
  const interruption = vi
    .spyOn(checkpoint, "restoreUpdateCheckpointResource")
    .mockImplementation(async (input) => {
      if (input.resourceCursor !== 0 || interrupted) {
        return await original(input);
      }
      interrupted = true;
      const opened = await checkpoint.reopenUpdateCheckpointRestorePlan(input.planRef, input);
      displacedPath = path.join(opened.plan.resources[0]!.stageDirectory, "displaced");
      await fs.rename(file, displacedPath);
      throw new Error("fixture process interrupted after canonical displacement");
    });
  const error = await restoreUpdateCommandFailure(params.opts, params.updateStepTimeoutMs).catch(
    (cause: unknown) => cause,
  );
  interruption.mockRestore();
  expect(error).toBeInstanceOf(Error);
  expect(interrupted, inspect(error, { depth: 10 })).toBe(true);
  await expect(fs.lstat(file)).rejects.toMatchObject({ code: "ENOENT" });
  const record = recovery.getRecord();
  expect(record.restore?.planSha256).toBeTruthy();
  expect(record.effects.at(-1)).toMatchObject({ kind: "checkpoint-restore", state: "intent" });
  expect(await discoverUpdateCommandRecovery(env)).toEqual(record);
  const plan = await fs.readFile(record.restore!.planPath);
  const displaced = await fs.readFile(displacedPath);
  const db = openNodeSqliteDatabase(resolveImmutableSqliteFileUri(displacedPath), {
    readOnly: true,
  });
  const expiry = Number(
    db.prepare("SELECT MAX(expires_at) AS expiry FROM state_leases").get()?.expiry,
  );
  db.close();
  const resume = () =>
    resumePendingUpdateCommand({
      opts: { json: true, yes: true },
      root: params.root,
      timeoutMs: params.updateStepTimeoutMs,
    });
  await expect(resume()).rejects.toThrow(/Another update executor/);
  return async () => {
    // Old ownership is gone, but its existing writer lease must first expire.
    closeOpenClawStateDatabaseForTest();
    if (shadowCanonical) {
      await fs.copyFile(displacedPath, file);
      const shadow = openNodeSqliteDatabase(file);
      shadow
        .prepare("DELETE FROM config_machine_state WHERE state_key = ?")
        .run("update.recovery." + record.runId);
      shadow.close();
      const canonical = await fs.readFile(file);
      await expect(resume()).rejects.toThrow(/family|recovery|publication/i);
      expect(await fs.readFile(file)).toEqual(canonical);
    } else if (conflict) {
      const config = env.OPENCLAW_CONFIG_PATH!;
      await fs.writeFile(config, "operator change must survive");
      await expect(resume()).rejects.toThrow(/conflicts/);
      expect(await fs.readFile(config, "utf8")).toBe("operator change must survive");
      await expect(fs.lstat(file)).rejects.toMatchObject({ code: "ENOENT" });
    } else {
      if (expiry > Date.now()) {
        await expect(resume()).rejects.toThrow(/lease still prevents/);
        await expect(fs.lstat(file)).rejects.toMatchObject({ code: "ENOENT" });
        expect(await fs.readFile(displacedPath)).toEqual(displaced);
        await new Promise<void>((resolve) => {
          setTimeout(resolve, Math.max(1, expiry - Date.now() + 30));
        });
      }
      const root = vi.spyOn(updateShared, "resolveUpdateRoot").mockResolvedValue(params.root);
      const outcome = await updateCommand({ json: true, yes: true }).catch(
        (cause: unknown) => cause,
      );
      root.mockRestore();
      expect(outcome, inspect(outcome, { depth: 12 })).toBeInstanceOf(
        UpdateCommandFinalizedRecoveryFailure,
      );
      const current = loadUpdateRecovery(record.runId, { env })!;
      expect(current.claimId).not.toBe(record.claimId);
      expect(current.terminal).toMatchObject({
        status: "rolled-back",
        receipt: { runtime: "previous" },
      });
      const canonical = openNodeSqliteDatabase(file, { readOnly: true });
      expect(canonical.prepare("SELECT COUNT(*) AS n FROM update_runs").get()?.n).toBe(1);
      canonical.close();
    }
    expect(await fs.readFile(displacedPath)).toEqual(displaced);
    expect(await fs.readFile(record.restore!.planPath)).toEqual(plan);
  };
}
