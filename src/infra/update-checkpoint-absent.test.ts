import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  prepareUpdateCheckpointRestore,
  restoreUpdateCheckpointResource,
  verifyUpdateCheckpointRestore,
} from "./update-checkpoint-restore.js";
import { captureUpdateCheckpoint } from "./update-checkpoint.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
it.each(["absent", "created", "redirected", "sidecar", "sidecar-link"] as const)(
  "reconciles a missing agent family without creating directories (%s)",
  async (mode) => {
    const root = await fs.realpath(dirs.make("checkpoint-absent-"));
    const sourcePath = path.join(root, "agents", "main", "agent", "agent.sqlite");
    const access = {
      artifactRoot: path.join(root, "artifacts"),
      binding: {
        runId: randomUUID(),
        stateDir: root,
        configPath: path.join(root, "openclaw.json"),
        fromRuntime: {
          root: path.join(root, "runtime"),
          nodePath: process.execPath,
          version: "1.0.0",
        },
      },
      assertQuiescent: () => {},
    }; // Disposable fixture owns all writers.
    const capture = () =>
      captureUpdateCheckpoint({
        ...access,
        resources: [{ sourcePath, kind: "sqlite", restore: "replace" }],
        expectedSources: [],
        exclusions: [],
      });
    const checkpointRef = await capture();
    const afterUpdateRef = await capture();
    const prepared = await prepareUpdateCheckpointRestore({
      ...access,
      checkpointRef,
      afterUpdateRef,
      prepareSharedDatabase() {
        throw new Error("Absent family cannot require a database writer");
      },
    });
    expect(prepared.status).toBe("ready");
    if (prepared.status !== "ready") {
      throw new Error("No absent plan");
    }
    await expect(fs.stat(path.join(root, "agents"))).rejects.toMatchObject({ code: "ENOENT" });
    if (mode === "redirected") {
      const foreign = await fs.realpath(dirs.make("checkpoint-foreign-"));
      await fs.symlink(foreign, path.join(root, "agents"), "junction");
    } else if (mode !== "absent") {
      await fs.mkdir(path.dirname(sourcePath), { recursive: true });
      if (mode === "sidecar-link") {
        await fs.symlink(path.join(root, "missing-operator-file"), sourcePath + "-wal");
      } else {
        await fs.writeFile(sourcePath + (mode === "sidecar" ? "-wal" : ""), "unowned");
      }
    }
    const request = { ...access, planRef: prepared.planRef, resourceCursor: 0 };
    if (mode === "sidecar" || mode === "sidecar-link") {
      await expect(restoreUpdateCheckpointResource(request)).rejects.toThrow(/must close/);
      if (mode === "sidecar-link") {
        expect(await fs.readlink(sourcePath + "-wal")).toBe(
          path.join(root, "missing-operator-file"),
        );
      } else {
        expect(await fs.readFile(sourcePath + "-wal", "utf8")).toBe("unowned");
      }
    } else {
      expect((await restoreUpdateCheckpointResource(request)).status).toBe(
        mode === "absent" ? "already-applied" : "conflict",
      );
      if (mode === "absent") {
        expect((await verifyUpdateCheckpointRestore(request)).status).toBe("verified");
        await expect(fs.stat(path.join(root, "agents"))).rejects.toMatchObject({ code: "ENOENT" });
      }
      if (mode === "created") {
        expect(await fs.readFile(sourcePath, "utf8")).toBe("unowned");
      }
    }
  },
);
