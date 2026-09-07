import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { inspect } from "node:util";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import * as tempRoot from "../../infra/tmp-openclaw-dir.js";
import { commitUpdateRecoveryTerminal } from "../../infra/update-run-recovery-terminal.js";
import { loadUpdateRecovery, type UpdateRecoveryRecord } from "../../infra/update-run-recovery.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { withUpdateCommandExecutor } from "./update-command-executor.js";
import { retireSupersededUpdateCommandPair } from "./update-command-retirement.js";
import { createRetirementFixture } from "./update-command-retirement.test-support.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  vi.restoreAllMocks();
});
function copies(record: UpdateRecoveryRecord) {
  return [
    record.preimages!.ref,
    record.checkpoint!.ref,
    ...record.afterImages!.map((image) => image.afterUpdate.ref),
  ];
}
async function captureCopies(record: UpdateRecoveryRecord) {
  const files = new Map<string, Buffer>();
  for (const ref of copies(record)) {
    const directory = path.dirname(ref.manifestPath);
    for (const file of await fs.readdir(directory, { recursive: true, withFileTypes: true })) {
      if (file.isFile()) {
        const name = path.join(file.parentPath, file.name);
        files.set(name, await fs.readFile(name));
      }
    }
  }
  return files;
}
it.each(["success", "readiness-lost", "checkpoint-interrupted"])(
  "retires only the superseded physical pair through its durable intent (%s)",
  async (mode) => {
    const home = await fs.realpath(dirs.make("retained-pair-consumer-"));
    const root = path.join(home, "state");
    await fs.mkdir(root);
    const control = path.join(root, "control");
    await fs.mkdir(control);
    vi.spyOn(tempRoot, "resolvePreferredOpenClawTmpDir").mockReturnValue(control);
    await withEnvAsync(
      {
        HOME: root,
        USERPROFILE: root,
        OPENCLAW_STATE_DIR: root,
        OPENCLAW_CONFIG_PATH: path.join(root, "openclaw.json"),
        OPENCLAW_PROFILE: undefined,
      },
      async () => {
        const liveRoot = path.join(root, "node_modules", "openclaw");
        const generation = (version: string, existing: boolean) =>
          withUpdateCommandExecutor(randomUUID(), async (executor) => {
            const fence = await executor.enter(liveRoot);
            const f = await createRetirementFixture(root, version, existing, fence);
            const observed = await f.activate();
            f.verified();
            f.record = commitUpdateRecoveryTerminal(
              f.record,
              { status: "succeeded", package: observed, assertReady: fence.assertCurrent },
              fence,
              f.options,
            );
            const decision = f.record.package!.descriptor.retention;
            if (decision?.state !== "selected") {
              throw new Error("No selected package pair");
            }
            expect(await f.owner.retain(decision)).toMatchObject({ status: "verified" });
            return f;
          });
        const a = await generation("2.0.0", false);
        const b = await generation("3.0.0", true);
        const old = a.reload();
        const selected = b.reload();
        const kept = await captureCopies(selected);
        const retained = await fs.readFile(
          path.join(selected.package!.descriptor.backupRoot, "package.json"),
        );
        let ready = true;
        const retire = () =>
          withUpdateCommandExecutor(b.run.runId, async (executor) => {
            const fence = await executor.enter(liveRoot);
            await retireSupersededUpdateCommandPair({
              fence,
              options: b.options,
              getRecord: () => selected,
              onRecord() {
                throw new Error("Retirement cannot rewrite the selected record");
              },
              assertReady() {
                fence.assertCurrent();
                if (!ready) {
                  throw new Error("Serving proof lost");
                }
              },
            });
          });
        const remove = fs.rm.bind(fs);
        let cut = false;
        if (mode !== "success") {
          const interruption = vi.spyOn(fs, "rm").mockImplementation(async (target, options) => {
            if (
              !cut &&
              mode === "checkpoint-interrupted" &&
              target === path.dirname(old.checkpoint!.ref.manifestPath)
            ) {
              cut = true;
              throw new Error("checkpoint retirement interrupted");
            }
            await remove(target, options);
            if (
              !cut &&
              mode === "readiness-lost" &&
              target === old.package!.descriptor.backupRoot
            ) {
              cut = true;
              ready = false;
            }
          });
          await expect(retire()).rejects.toThrow();
          interruption.mockRestore();
          expect(cut).toBe(true);
          expect(a.reload().effects.at(-1)).toMatchObject({ kind: "retirement", state: "intent" });
          expect(b.reload()).toEqual(selected);
          for (const [file, bytes] of kept) {
            expect(await fs.readFile(file)).toEqual(bytes);
          }
          ready = true;
        }
        const result = await retire().catch((error: unknown) => error);
        expect(result, inspect(result, { depth: 12 })).toBeUndefined();
        const retired = a.reload();
        expect(retired.effects.filter((effect) => effect.kind === "retirement")).toHaveLength(1);
        expect(retired.effects.at(-1)).toMatchObject({
          kind: "retirement",
          state: "observed",
          package: { outcome: "completed" },
        });
        for (const ref of copies(old)) {
          await expect(fs.lstat(path.dirname(ref.manifestPath))).rejects.toMatchObject({
            code: "ENOENT",
          });
        }
        expect(b.reload()).toEqual(selected);
        for (const [file, bytes] of kept) {
          expect(await fs.readFile(file)).toEqual(bytes);
        }
        expect(
          await fs.readFile(path.join(selected.package!.descriptor.backupRoot, "package.json")),
        ).toEqual(retained);
        await retire();
        expect(loadUpdateRecovery(old.runId, a.options)).toEqual(retired);
      },
    );
  },
);
