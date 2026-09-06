import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { inspectCheckpointFile } from "./update-checkpoint-files.js";
import {
  prepareUpdateCheckpointRestore,
  restoreUpdateCheckpointResource,
  verifyUpdateCheckpointRestore,
} from "./update-checkpoint-restore.js";
import {
  captureUpdateCheckpoint,
  captureUpdateCheckpointPreimages,
  reopenUpdateCheckpointPreimages,
  retireUpdateCheckpointPreimages,
  reopenUpdateCheckpoint,
  type UpdateCheckpointAccess,
  type UpdateCheckpointResource,
} from "./update-checkpoint.js";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) {
    await fs.rm(root, { recursive: true, force: true });
  }
});
async function fixture() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "checkpoint-preimage-")));
  roots.push(root);
  const configPath = path.join(root, "config.json");
  const servicePath = path.join(root, "gateway.service");
  const envPath = path.join(root, "gateway.env");
  const absentPath = path.join(root, "optional.env");
  const includePath = path.join(root, "gateway.json");
  const original = new Map([
    [configPath, '{"gateway":{"$include":"gateway.json"}}'],
    [includePath, '{"bind":"localhost"}'],
    [servicePath, "[Service]\nEnvironmentFile=gateway.env\n"],
    [envPath, "OPERATOR_LABEL=original\n"],
  ]);
  for (const [file, bytes] of original) {
    await fs.writeFile(file, bytes, { mode: 0o600 });
  }
  const access: UpdateCheckpointAccess = {
    artifactRoot: path.join(root, "artifacts"),
    binding: {
      runId: "preimage-run",
      stateDir: root,
      configPath,
      fromRuntime: {
        root: path.join(root, "package"),
        version: "1.0.0",
        nodePath: process.execPath,
      },
    },
    // All state in this fixture is synthetic; it owns and serializes every writer.
    assertQuiescent() {},
  };
  const resources: UpdateCheckpointResource[] = [
    { sourcePath: configPath, kind: "config", restore: "replace" },
    { sourcePath: includePath, kind: "config", restore: "replace" },
    ...[servicePath, envPath, absentPath].map((sourcePath) => ({
      sourcePath,
      kind: "service" as const,
      restore: "replace" as const,
    })),
  ];
  const checkpointRef = await captureUpdateCheckpointPreimages({
    ...access,
    resources,
    assertSourcesQuiescent() {
      access.assertQuiescent();
      return undefined;
    },
  });
  // Simulate the lifecycle owner's suppression writes, before global exclusion.
  await fs.writeFile(servicePath, "suppressed definition\n");
  await fs.unlink(envPath);
  await fs.writeFile(absentPath, "temporary service environment\n");
  const postMutationSources = await Promise.all(
    resources.map(async ({ sourcePath }) => ({
      sourcePath,
      state: await inspectCheckpointFile(sourcePath),
    })),
  );
  return {
    access,
    resources,
    original,
    servicePath,
    envPath,
    absentPath,
    checkpointRef,
    postMutationSources,
  };
}

describe("pre-stop checkpoint preimages", () => {
  it("seals original config/include/service/env bytes and absence after lifecycle mutation", async () => {
    const f = await fixture();
    const request = {
      ...f.access,
      resources: f.resources,
      exclusions: [],
      preimages: { checkpointRef: f.checkpointRef, postMutationSources: f.postMutationSources },
    };
    const ref = await captureUpdateCheckpoint(request);
    const checkpoint = await reopenUpdateCheckpoint(ref, f.access);
    for (const resource of checkpoint.manifest.resources) {
      const expected = f.original.get(resource.sourcePath);
      if (expected === undefined) {
        expect(resource.captured).toBeNull();
        expect(resource.sourceState).toBeNull();
      } else {
        expect(resource.artifact).not.toBeNull();
        expect(
          await fs.readFile(path.join(path.dirname(ref.manifestPath), resource.artifact!), "utf8"),
        ).toBe(expected);
      }
    }
    expect(await fs.readFile(f.servicePath, "utf8")).toBe("suppressed definition\n");
    await expect(fs.stat(f.envPath)).rejects.toMatchObject({ code: "ENOENT" });
    // The final checkpoint owns its copies, not a live dependency on the early artifact.
    await retireUpdateCheckpointPreimages(f.checkpointRef, {
      ...f.access,
      // Fixture owns this supersession: all original copies are durably sealed above.
      assertSuperseded() {},
    });
    await expect(reopenUpdateCheckpoint(ref, f.access)).resolves.toBeDefined();
    const afterUpdateRef = await captureUpdateCheckpoint({
      ...f.access,
      resources: f.resources,
      exclusions: [],
      expectedSources: f.postMutationSources,
    });
    const prepared = await prepareUpdateCheckpointRestore({
      ...f.access,
      checkpointRef: ref,
      afterUpdateRef,
      prepareSharedDatabase() {
        throw new Error("No database in this fixture");
      },
    });
    expect(prepared.status).toBe("ready");
    if (prepared.status !== "ready") {
      return;
    }
    for (let resourceCursor = 0; resourceCursor < f.resources.length; resourceCursor++) {
      const result = await restoreUpdateCheckpointResource({
        ...f.access,
        planRef: prepared.planRef,
        resourceCursor,
      });
      expect(["applied", "already-applied"]).toContain(result.status);
    }
    for (const [file, bytes] of f.original) {
      expect(await fs.readFile(file, "utf8")).toBe(bytes);
    }
    await expect(fs.stat(f.absentPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(
      (await verifyUpdateCheckpointRestore({ ...f.access, planRef: prepared.planRef })).status,
    ).toBe("verified");
  });

  it.each(["edit", "recreate", "absence"])(
    "refuses an operator %s after lifecycle receipts without sealing",
    async (change) => {
      const f = await fixture();
      if (change === "edit") {
        await fs.writeFile(f.servicePath, "operator definition");
      } else if (change === "recreate") {
        await fs.rename(f.servicePath, `${f.servicePath}.saved`);
        await fs.writeFile(f.servicePath, "suppressed definition\n");
      } else {
        await fs.writeFile(f.envPath, "operator environment");
      }
      const request = {
        ...f.access,
        resources: f.resources,
        exclusions: [],
        preimages: { checkpointRef: f.checkpointRef, postMutationSources: f.postMutationSources },
      };
      await expect(captureUpdateCheckpoint(request)).rejects.toThrow(/preimage.*binding/iu);
    },
  );
  it("keeps pre-stop artifacts distinct from whole-state checkpoints and rejects foreign bindings", async () => {
    const f = await fixture();
    await expect(reopenUpdateCheckpoint(f.checkpointRef, f.access)).rejects.toThrow(/purpose/iu);
    await expect(reopenUpdateCheckpointPreimages(f.checkpointRef, f.access)).resolves.toBeDefined();
    await expect(
      captureUpdateCheckpoint({
        ...f.access,
        binding: { ...f.access.binding, runId: "different-run" },
        resources: f.resources,
        exclusions: [],
        preimages: { checkpointRef: f.checkpointRef, postMutationSources: f.postMutationSources },
      }),
    ).rejects.toThrow(/binding/iu);
  });

  it.each(["missing-receipt", "extra-receipt", "missing-resource", "wrong-kind", "after-image"])(
    "rejects %s in a preimage import",
    async (failure) => {
      const f = await fixture();
      const resources = f.resources.map((r) => ({ ...r }));
      const postMutationSources = [...f.postMutationSources];
      if (failure === "missing-receipt") {
        postMutationSources.pop();
      }
      if (failure === "extra-receipt") {
        postMutationSources.push({ sourcePath: `${f.envPath}.unowned`, state: null });
      }
      if (failure === "missing-resource") {
        resources.pop();
      }
      if (failure === "wrong-kind") {
        const resource = resources[0];
        if (!resource) {
          throw new Error("Fixture must include a config resource");
        }
        resource.kind = "plugin";
      }
      await expect(
        captureUpdateCheckpoint({
          ...f.access,
          resources,
          exclusions: [],
          ...(failure === "after-image" ? { expectedSources: postMutationSources } : {}),
          preimages: { checkpointRef: f.checkpointRef, postMutationSources },
        }),
      ).rejects.toThrow(/preimage/iu);
    },
  );

  it("rejects corrupted original bytes before importing and does not overwrite live files", async () => {
    const f = await fixture();
    const early = await reopenUpdateCheckpointPreimages(f.checkpointRef, f.access);
    const service = early.manifest.resources.find((r) => r.sourcePath === f.servicePath)!;
    await fs.writeFile(
      path.join(path.dirname(f.checkpointRef.manifestPath), service.artifact!),
      "corrupt",
    );
    await expect(
      captureUpdateCheckpoint({
        ...f.access,
        resources: f.resources,
        exclusions: [],
        preimages: { checkpointRef: f.checkpointRef, postMutationSources: f.postMutationSources },
      }),
    ).rejects.toThrow(/artifact changed/iu);
    expect(await fs.readFile(f.servicePath, "utf8")).toBe("suppressed definition\n");
  });

  it.each(["late-write", "lost-fence"])(
    "rechecks %s before sealing the imported checkpoint",
    async (failure) => {
      const f = await fixture();
      let held = true;
      const copy = fs.cp.bind(fs);
      vi.spyOn(fs, "cp").mockImplementationOnce(async (...args) => {
        await copy(...args);
        if (failure === "late-write") {
          await fs.writeFile(f.servicePath, "operator changed during capture");
        } else {
          held = false;
        }
      });
      await expect(
        captureUpdateCheckpoint({
          ...f.access,
          assertQuiescent() {
            if (!held) {
              throw new Error("Lost current fence");
            }
          },
          resources: f.resources,
          exclusions: [],
          preimages: {
            checkpointRef: f.checkpointRef,
            postMutationSources: f.postMutationSources,
          },
        }),
      ).rejects.toThrow(/binding changed|before checkpoint seal|Lost current fence/u);
      const directories = await fs.readdir(f.access.artifactRoot);
      for (const directory of directories.filter((dir) => dir !== f.checkpointRef.checkpointId)) {
        await expect(
          fs.stat(path.join(f.access.artifactRoot, directory, "manifest.json")),
        ).rejects.toMatchObject({ code: "ENOENT" });
      }
    },
  );

  it("cannot snapshot databases or directories under the narrow preimage fence", async () => {
    const f = await fixture();
    const directory = path.join(f.access.binding.stateDir, "definition-dir");
    await fs.mkdir(directory);
    for (const resource of [
      { sourcePath: f.envPath, kind: "sqlite" as const, restore: "replace" as const },
      {
        sourcePath: directory,
        kind: "service" as const,
        restore: "replace" as const,
      },
    ]) {
      await expect(
        captureUpdateCheckpointPreimages({
          ...f.access,
          resources: [resource],
          assertSourcesQuiescent() {
            f.access.assertQuiescent();
            return undefined;
          },
        }),
      ).rejects.toThrow(/files only|regular files/u);
    }
  });
  it("captures current post-stop database work alongside earlier file preimages", async () => {
    const f = await fixture();
    const databasePath = path.join(f.access.binding.stateDir, "agent.sqlite");
    const db = new DatabaseSync(databasePath);
    db.exec("CREATE TABLE work(id INTEGER PRIMARY KEY, body TEXT); PRAGMA user_version=1");
    db.prepare("INSERT INTO work VALUES(?, ?)").run(1, "agent work during stop");
    db.close();
    const ref = await captureUpdateCheckpoint({
      ...f.access,
      resources: [...f.resources, { sourcePath: databasePath, kind: "sqlite", restore: "replace" }],
      exclusions: [],
      preimages: { checkpointRef: f.checkpointRef, postMutationSources: f.postMutationSources },
    });
    const checkpoint = await reopenUpdateCheckpoint(ref, f.access);
    const resource = checkpoint.manifest.resources.find((r) => r.sourcePath === databasePath)!;
    const snapshot = new DatabaseSync(
      path.join(path.dirname(ref.manifestPath), resource.artifact!),
      { readOnly: true },
    );
    try {
      expect(snapshot.prepare("SELECT body FROM work").get()).toEqual({
        body: "agent work during stop",
      });
    } finally {
      snapshot.close();
    }
  });

  it("rejects an asynchronous preimage fence before publishing an artifact", async () => {
    const f = await fixture();
    const before = await fs.readdir(f.access.artifactRoot);
    const request = {
      ...f.access,
      resources: f.resources,
      assertSourcesQuiescent: async () => {
        throw new Error("owner fence lost");
      },
    };
    // Untyped callers must not be able to treat a pending assertion as current authority.
    await expect(
      Reflect.apply(captureUpdateCheckpointPreimages, undefined, [request]),
    ).rejects.toThrow(/synchronous/u);
    expect(await fs.readdir(f.access.artifactRoot)).toEqual(before);
  });
});
