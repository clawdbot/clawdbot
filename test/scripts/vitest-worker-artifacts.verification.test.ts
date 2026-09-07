import fs from "node:fs";
import path from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { afterEach, expect, it, vi } from "vitest";
import {
  hashVitestWorkerArtifact,
  verifyVitestWorkerArtifacts,
  type VitestWorkerManifest,
} from "../../scripts/lib/vitest-worker-artifacts.mts";
import { createVitestWorkerRun } from "../../scripts/lib/vitest-worker-run.mts";
import { createDeferred, withTestTimeout } from "../helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it("keeps the runner event loop responsive while verifying a completed generation", async () => {
  const directory = tempDirs.make("vitest-worker-verification-");
  fs.mkdirSync(path.join(directory, "dist"));
  const manifest: VitestWorkerManifest = {
    identity: "verification-fixture",
    inputs: {},
    outputs: {},
    durationMs: 0,
  };
  const source = "export const value = 1;\n";
  const hash = hashVitestWorkerArtifact(source);
  for (let index = 0; index < 64; index++) {
    const input = path.join(directory, `input-${index}.ts`);
    const output = `output-${index}.js`;
    fs.writeFileSync(input, source);
    fs.writeFileSync(path.join(directory, "dist", output), source);
    manifest.inputs[input] = hash;
    manifest.outputs[output] = hash;
  }

  let completed = false;
  // Supply the manifest so an asynchronous manifest read alone cannot satisfy
  // the assertion: the source/artifact traversal itself must yield to I/O.
  const verification = Promise.resolve(verifyVitestWorkerArtifacts(directory, manifest)).then(
    () => {
      completed = true;
    },
  );
  try {
    await nextTurn();
    expect(completed, "verification blocked the runner until every file was hashed").toBe(false);
  } finally {
    await verification;
  }
});

it.each(["inputs", "outputs"] as const)(
  "drains active %s reads before failed verification releases the generation",
  async (group) => {
    const owner = createVitestWorkerRun();
    const directory = owner.descriptor.directory;
    const files = group === "inputs" ? directory : path.join(directory, "dist");
    fs.mkdirSync(files, { recursive: true });
    const bad = path.join(files, "changed.js");
    const held = path.join(files, "held.js");
    fs.writeFileSync(bad, "changed");
    fs.writeFileSync(held, "expected");
    const hash = hashVitestWorkerArtifact("expected");
    const manifest: VitestWorkerManifest = {
      identity: "drain-fixture",
      durationMs: 0,
      inputs: {},
      outputs: {},
    };
    manifest[group] = Object.fromEntries(
      [bad, held].map((filename) => [
        group === "inputs" ? filename : path.basename(filename),
        hash,
      ]),
    );
    fs.writeFileSync(path.join(directory, "manifest.json"), JSON.stringify(manifest));
    const started = createDeferred();
    const failedRead = createDeferred();
    const release = createDeferred();
    const readFile = fs.promises.readFile.bind(fs.promises);
    const reader = vi.spyOn(fs.promises, "readFile").mockImplementation(async (...args) => {
      if (args[0] === held) {
        started.resolve();
        await release.promise;
      }
      const bytes = await readFile(...args);
      if (args[0] === bad) {
        failedRead.resolve();
      }
      return bytes;
    });
    let completed = false;
    let failure: unknown;
    const disposal = owner
      .dispose()
      .catch((error: unknown) => {
        failure = error;
      })
      .finally(() => {
        completed = true;
      });
    try {
      await withTestTimeout(
        Promise.all([started.promise, failedRead.promise]),
        5_000,
        "verification did not admit both reads",
      );
      await nextTurn();
      expect(completed).toBe(false);
      expect(fs.readFileSync(held, "utf8")).toBe("expected");
    } finally {
      release.resolve();
      await disposal;
      reader.mockRestore();
    }
    const diagnostic =
      group === "inputs"
        ? "Source changed during compiled subprocess invocation"
        : "Compiled subprocess artifact changed";
    expect(failure).toMatchObject({ message: expect.stringContaining(diagnostic) });
    expect(fs.existsSync(directory)).toBe(false);
  },
);
