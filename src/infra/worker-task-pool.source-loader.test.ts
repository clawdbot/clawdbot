import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import { WorkerTaskPool } from "./worker-task-pool.js";

const tempDirs = createTempDirTracker();
afterEach(tempDirs.cleanup);

async function runWorker(directory: string, filename: string, source: string) {
  const workerPath = path.join(directory, filename);
  fs.writeFileSync(workerPath, source);
  const pool = new WorkerTaskPool<Record<string, never>, number>({
    workerUrl: pathToFileURL(workerPath),
    maxWorkers: 1,
  });
  try {
    return await pool.run({}, { timeoutMs: 10_000 });
  } finally {
    await pool.close();
  }
}

describe("worker task pool source loading", () => {
  it("keeps import-only dependency exports when a source worker requires compiled ESM", async () => {
    const directory = tempDirs.make("worker-import-only-");
    fs.writeFileSync(path.join(directory, "package.json"), '{"type":"module"}');
    const dependency = path.join(directory, "node_modules", "import-only-fixture");
    fs.mkdirSync(dependency, { recursive: true });
    fs.writeFileSync(
      path.join(dependency, "package.json"),
      JSON.stringify({ type: "module", exports: { node: { import: "./index.js" } } }),
    );
    fs.writeFileSync(path.join(dependency, "index.js"), "export const marker = 37;");
    fs.writeFileSync(
      path.join(directory, "bridge.js"),
      'export { marker } from "import-only-fixture";',
    );

    const result = await runWorker(
      directory,
      "worker.ts",
      `import { createRequire } from "node:module";
       import { fileURLToPath } from "node:url";
       import { parentPort } from "node:worker_threads";
       const { marker } = createRequire(import.meta.url)(
         fileURLToPath(new URL("./bridge.js", import.meta.url))
       );
       parentPort.on("message", () => parentPort.postMessage({ status: "ok", value: marker }));`,
    );

    expect(result).toBe(37);
  });

  it.each([
    {
      name: "CommonJS TypeScript",
      filename: "worker.ts",
      source: `const { parentPort } = require("node:worker_threads");
               enum Marker { Ready = 41 }
               parentPort.on("message", () => parentPort.postMessage({ status: "ok", value: Marker.Ready }));`,
    },
    {
      name: "compiled CommonJS",
      filename: "worker.cjs",
      source: `const { parentPort } = require("node:worker_threads");
               parentPort.on("message", () => parentPort.postMessage({ status: "ok", value: 41 }));`,
    },
    {
      name: "compiled ESM",
      filename: "worker.mjs",
      source: `import { parentPort } from "node:worker_threads";
               parentPort.on("message", () => parentPort.postMessage({ status: "ok", value: 41 }));`,
    },
  ])("preserves $name workers", async ({ filename, source }) => {
    const directory = tempDirs.make("worker-module-compatibility-");
    fs.writeFileSync(path.join(directory, "package.json"), '{"type":"commonjs"}');

    expect(await runWorker(directory, filename, source)).toBe(41);
  });
});
