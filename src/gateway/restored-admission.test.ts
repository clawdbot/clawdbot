import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { stableStringify } from "../agents/stable-stringify.js";
import { sha256File, sha256Hex } from "../infra/crypto-digest.js";
import {
  RESTORED_ADMISSION_DESCRIPTOR_VERSION,
  RESTORED_RECOVERY_POINT_RESULT_VERSION,
  type RestoredRecoveryPointResult,
} from "../snapshot/restored-recovery-point.js";
import { resolveOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.paths.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { completeRestoredAdmission } from "./restored-admission.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("Gateway restored admission", () => {
  it("persists exact readiness and replays only after owners reconcile again", async () => {
    const fixture = await createFixture();
    const startScheduler = vi.fn(async () => ({ enabled: true, jobs: 2, nextWakeAtMs: 17 }));

    const first = await completeRestoredAdmission({
      descriptorPath: fixture.descriptorPath,
      env: fixture.env,
      startScheduler,
      getOwnerReadiness: () => ({ ready: true, failing: [] }),
    });
    const replay = await completeRestoredAdmission({
      descriptorPath: fixture.descriptorPath,
      env: fixture.env,
      startScheduler,
      getOwnerReadiness: () => ({ ready: true, failing: [] }),
    });

    expect(first.replayed).toBe(false);
    expect(replay).toEqual({ record: first.record, replayed: true });
    expect(startScheduler).toHaveBeenCalledTimes(2);
    expect(
      JSON.parse(await fs.readFile(path.join(fixture.journalPath, "ready.json"), "utf8")),
    ).toEqual(first.record);
  });

  it("quarantines changed restored bytes before scheduler start", async () => {
    const fixture = await createFixture();
    await fs.appendFile(resolveOpenClawStateSqlitePath(fixture.env), "changed");
    const startScheduler = vi.fn(async () => ({}));

    await expect(
      completeRestoredAdmission({
        descriptorPath: fixture.descriptorPath,
        env: fixture.env,
        startScheduler,
        getOwnerReadiness: () => ({ ready: true, failing: [] }),
      }),
    ).rejects.toMatchObject({
      code: "restored-admission.target-conflict",
      disposition: "quarantine",
    });
    expect(startScheduler).not.toHaveBeenCalled();
  });

  it("holds admission when an owner is not ready", async () => {
    const fixture = await createFixture();

    await expect(
      completeRestoredAdmission({
        descriptorPath: fixture.descriptorPath,
        env: fixture.env,
        startScheduler: async () => ({ enabled: true }),
        getOwnerReadiness: () => ({ ready: false, failing: ["discord"] }),
      }),
    ).rejects.toMatchObject({
      code: "restored-admission.owner-readiness-hold",
      disposition: "hold",
    });
    await expect(fs.access(path.join(fixture.journalPath, "ready.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});

async function createFixture() {
  const tempDir = tempDirs.make("openclaw-gateway-restored-admission-");
  const env = { OPENCLAW_STATE_DIR: path.join(tempDir, "state") };
  const globalPath = resolveOpenClawStateSqlitePath(env);
  const agentPath = resolveOpenClawAgentSqlitePath({ agentId: "main", env });
  await fs.mkdir(path.dirname(globalPath), { recursive: true });
  await fs.mkdir(path.dirname(agentPath), { recursive: true });
  await fs.writeFile(globalPath, "global-state");
  await fs.writeFile(agentPath, "agent-state");
  const journalPath = path.join(tempDir, "journal");
  await fs.mkdir(journalPath, { recursive: true, mode: 0o700 });
  const descriptorPath = path.join(journalPath, "startup.json");
  const resultWithoutReceipt: Omit<
    Extract<RestoredRecoveryPointResult, { ok: true }>,
    "restoreReceiptIdentity"
  > = {
    version: RESTORED_RECOVERY_POINT_RESULT_VERSION,
    ok: true as const,
    runtimeLineage: "runtime/tenant-7",
    lifecycleOwnerGeneration: "owner-generation-8",
    destinationRuntimeGeneration: "generation-8",
    restoreOperationId: "restore-8",
    destinationOwner: "lobster/tenant-7",
    admissionIdentity: "admission-8",
    recoveryPointId: "a".repeat(64),
    acceptanceSetId: "b".repeat(64),
    startupDescriptorPath: descriptorPath,
    components: await Promise.all(
      [
        { componentId: "sqlite/global", targetPath: globalPath },
        { componentId: "sqlite/agent/main", targetPath: agentPath },
      ].map(async ({ componentId, targetPath }) => {
        const artifactSha256 = await sha256File(targetPath);
        return {
          componentId,
          artifactSha256,
          targetIdentity: sha256Hex(
            stableStringify({
              componentId,
              destinationRuntimeGeneration: "generation-8",
              artifactSha256,
            }),
          ),
        };
      }),
    ),
  };
  const result: RestoredRecoveryPointResult = {
    ...resultWithoutReceipt,
    restoreReceiptIdentity: sha256Hex(stableStringify(resultWithoutReceipt)),
  };
  await fs.writeFile(
    descriptorPath,
    `${stableStringify({
      version: RESTORED_ADMISSION_DESCRIPTOR_VERSION,
      journalPath,
      result,
    })}\n`,
    { mode: 0o600 },
  );
  return { descriptorPath, env, journalPath };
}
