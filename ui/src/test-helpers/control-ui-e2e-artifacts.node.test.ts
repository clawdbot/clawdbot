import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { afterEach, expect, it, vi } from "vitest";
import { cleanupTempDirs, makeTempDir } from "../../../test/helpers/temp-dir.ts";
import { createControlUiE2eArtifactDir } from "./control-ui-e2e-artifacts.ts";

const tempDirs: string[] = [];
const artifactNames = ["state.png", "proof.webm", "report.json"];
// Vite rewrites asset-style new URL expressions under the ordinary UI test runner.
const sourceDir = path.dirname(fileURLToPath(import.meta.url));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  cleanupTempDirs(tempDirs);
});

it("retains old proof and repeated scenario outputs with identical filenames", () => {
  const parent = makeTempDir(tempDirs, "control-ui-proof-");
  const previous = path.join(parent, "same-scenario");
  mkdirSync(previous);
  for (const name of artifactNames) {
    writeFileSync(path.join(previous, name), `old:${name}`);
  }
  const outputs = Array.from({ length: 3 }, (_, attempt) => {
    const directory = createControlUiE2eArtifactDir("same-scenario", parent);
    for (const name of artifactNames) {
      writeFileSync(path.join(directory, name), `${attempt}:${name}`);
    }
    return directory;
  });
  for (const name of artifactNames) {
    expect(readFileSync(path.join(previous, name), "utf8")).toBe(`old:${name}`);
    for (const [attempt, directory] of outputs.entries()) {
      expect(readFileSync(path.join(directory, name), "utf8")).toBe(`${attempt}:${name}`);
    }
  }
  expect(new Set(outputs).size).toBe(3);
});

it("allocates independently in concurrent workers sharing the same parent and scope", async () => {
  const parent = makeTempDir(tempDirs, "control-ui-proof-workers-");
  const previous = path.join(parent, "same-scenario");
  mkdirSync(previous);
  for (const name of artifactNames) {
    writeFileSync(path.join(previous, name), `old:${name}`);
  }
  const moduleUrl = pathToFileURL(path.join(sourceDir, "control-ui-e2e-artifacts.ts")).href;
  const outputs = await Promise.all(
    ["first", "second"].map(
      (contents) =>
        new Promise<string>((resolve, reject) => {
          const worker = new Worker(
            `const { parentPort, workerData } = require("node:worker_threads");
             const { writeFileSync } = require("node:fs");
             const path = require("node:path");
             import(workerData.moduleUrl).then(({ createControlUiE2eArtifactDir }) => {
               const directory = createControlUiE2eArtifactDir("same-scenario", workerData.parent);
               for (const name of workerData.names) {
                 writeFileSync(path.join(directory, name), workerData.contents);
               }
               parentPort.postMessage(directory);
             });`,
            { eval: true, workerData: { moduleUrl, parent, contents, names: artifactNames } },
          );
          let directory: string;
          worker.once("message", (value: string) => {
            directory = value;
          });
          worker.once("error", reject);
          worker.once("exit", (code) => {
            if (code === 0) {
              resolve(directory);
            } else {
              reject(new Error(`Capture worker exited with ${code}`));
            }
          });
        }),
    ),
  );
  expect(new Set(outputs).size).toBe(2);
  for (const name of artifactNames) {
    expect(readFileSync(path.join(previous, name), "utf8")).toBe(`old:${name}`);
  }
  for (const [index, directory] of outputs.entries()) {
    for (const name of artifactNames) {
      expect(readFileSync(path.join(directory, name), "utf8")).toBe(["first", "second"][index]);
    }
  }
});

it("keeps explicit parents authoritative and trims the existing configured root", () => {
  const explicit = makeTempDir(tempDirs, "control-ui-proof-explicit-");
  const configured = makeTempDir(tempDirs, "control-ui-proof-configured-");
  vi.stubEnv("OPENCLAW_UI_E2E_ARTIFACT_DIR", `  ${configured}  `);
  expect(path.dirname(createControlUiE2eArtifactDir("configured"))).toBe(configured);
  expect(path.dirname(createControlUiE2eArtifactDir("explicit", explicit))).toBe(explicit);
});

it.each([undefined, "", "   "])(
  "uses the repository parent for an unset or blank root (%s)",
  (root) => {
    vi.stubEnv("OPENCLAW_UI_E2E_ARTIFACT_DIR", root);
    const directory = createControlUiE2eArtifactDir("allocator-regression");
    // Only this exclusive child is disposable; the repository evidence parent is not ours.
    tempDirs.push(directory);
    expect(path.dirname(directory)).toBe(
      path.resolve(sourceDir, "../../../.artifacts/control-ui-e2e"),
    );
  },
);

it("does not enable optional capture when allocating an always-on scenario", () => {
  const parent = makeTempDir(tempDirs, "control-ui-proof-disabled-");
  vi.stubEnv("OPENCLAW_UI_E2E_ARTIFACT_DIR", undefined);
  vi.stubEnv("OPENCLAW_CAPTURE_UI_PROOF", "0");
  expect(readdirSync(parent)).toEqual([]);
  const directory = createControlUiE2eArtifactDir("always-on", parent);
  expect(readdirSync(parent)).toEqual([path.basename(directory)]);
  expect(process.env.OPENCLAW_CAPTURE_UI_PROOF).toBe("0");
  expect(process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR).toBeUndefined();
});
