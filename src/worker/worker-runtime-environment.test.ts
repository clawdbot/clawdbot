import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import {
  closeOpenClawStateDatabaseByPath,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { createWorkerRuntimeEnvironment } from "./worker.runtime.js";

it("closes the worker state database before removing its directory without closing other state", async () => {
  const unrelatedRoot = await mkdtemp(path.join(tmpdir(), "openclaw-worker-unrelated-"));
  const unrelated = openOpenClawStateDatabase({
    path: path.join(unrelatedRoot, "openclaw.sqlite"),
  });
  const environment = await createWorkerRuntimeEnvironment("worker-state-cleanup");
  const owned = openOpenClawStateDatabase();
  try {
    expect(owned.db.isOpen).toBe(true);
    expect(unrelated.db.isOpen).toBe(true);

    await environment.close();

    expect(owned.db.isOpen).toBe(false);
    expect(unrelated.db.isOpen).toBe(true);
    expect(unrelated.db.prepare("SELECT 1 AS value").get()).toEqual({ value: 1 });
    await expect(stat(environment.stateDir)).rejects.toMatchObject({ code: "ENOENT" });
    await environment.close();
  } finally {
    closeOpenClawStateDatabaseByPath(owned.path);
    closeOpenClawStateDatabaseByPath(unrelated.path);
    await rm(environment.stateDir, { recursive: true, force: true });
    await rm(unrelatedRoot, { recursive: true, force: true });
  }
});
