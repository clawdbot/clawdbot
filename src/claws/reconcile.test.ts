import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { readClawStatus } from "./lifecycle-status.js";
import { applyClawReconcileKeepLocal, planClawReconcile } from "./reconcile.js";
import { createUpdatePlanFixture } from "./update-plan.test-helpers.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => closeOpenClawStateDatabaseForTest());

describe("claws reconcile keep-local", () => {
  it("adopts drifted file content so the record stops reporting modified", async () => {
    const current = await createUpdatePlanFixture(tempDirs.make("openclaw-claw-reconcile-"));
    await writeFile(join(current.root, "workspace-worker", "SOUL.md"), "drifted locally\n", "utf8");

    const drift = await planClawReconcile("worker", { env: current.env, config: current.config });
    expect(drift.files).toEqual([expect.objectContaining({ path: "SOUL.md", state: "modified" })]);

    const result = await applyClawReconcileKeepLocal(
      drift,
      { config: current.config },
      { env: current.env, nowMs: 1 },
    );
    expect(result.adoptedFiles).toEqual(["SOUL.md"]);

    const status = await readClawStatus("worker", { env: current.env, config: current.config });
    expect(status.records[0]?.workspaceFiles.find((file) => file.path === "SOUL.md")).toMatchObject(
      { state: "unchanged" },
    );
  });

  it("refuses to adopt unsafe workspace files", async () => {
    const current = await createUpdatePlanFixture(tempDirs.make("openclaw-claw-reconcile-"));
    await writeFile(join(current.root, "workspace-worker", "SOUL.md"), "drifted locally\n", "utf8");
    const drift = await planClawReconcile("worker", { env: current.env, config: current.config });
    const unsafe = {
      ...drift,
      files: [{ path: "SOUL.md", state: "unsafe", workspace: current.addPlan.agent.workspace }],
    };
    await expect(
      applyClawReconcileKeepLocal(unsafe, { config: current.config }, { env: current.env }),
    ).rejects.toThrow("Unsafe workspace files cannot be adopted");
  });
});
