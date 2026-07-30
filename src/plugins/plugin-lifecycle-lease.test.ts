import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { readPersistedInstalledPluginIndex } from "./installed-plugin-index-store.js";
import { withPluginLifecycleLease } from "./plugin-lifecycle-lease.js";

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
});

async function waitForPath(filePath: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      await fs.access(filePath);
      return;
    } catch {
      await new Promise((resolve) => {
        setTimeout(resolve, 25);
      });
    }
  }
  throw new Error(`timed out waiting for ${filePath}`);
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function runLeaseChild(scriptPath: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", scriptPath, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`lease child exited ${code}: ${output}`));
      }
    });
  });
}

describe("plugin lifecycle lease", () => {
  it("serializes lifecycle work sharing one state directory", async () => {
    await withOpenClawTestState({ label: "plugin-lifecycle-lease" }, async (state) => {
      const firstEntered = deferred();
      const releaseFirst = deferred();
      const events: string[] = [];

      const first = withPluginLifecycleLease(
        { env: state.env, leaseMs: 1_000, waitMs: 3_000 },
        async () => {
          events.push("first-enter");
          firstEntered.resolve();
          await releaseFirst.promise;
          events.push("first-exit");
        },
      );
      await firstEntered.promise;

      const second = withPluginLifecycleLease(
        { env: state.env, leaseMs: 1_000, waitMs: 3_000 },
        async () => {
          events.push("second-enter");
        },
      );
      await new Promise((resolve) => {
        setTimeout(resolve, 100);
      });
      expect(events).toEqual(["first-enter"]);

      releaseFirst.resolve();
      await Promise.all([first, second]);
      expect(events).toEqual(["first-enter", "first-exit", "second-enter"]);
    });
  });

  it("uses an explicit shared database path instead of each caller's default state", async () => {
    await withOpenClawTestState({ label: "plugin-lifecycle-explicit-path" }, async (state) => {
      const databasePath = state.path("shared-plugin-lifecycle.sqlite");
      const firstEntered = deferred();
      const releaseFirst = deferred();
      const events: string[] = [];
      const first = withPluginLifecycleLease(
        {
          env: { ...state.env, OPENCLAW_STATE_DIR: state.path("state-a") },
          path: databasePath,
          leaseMs: 1_000,
          waitMs: 3_000,
        },
        async () => {
          events.push("first-enter");
          firstEntered.resolve();
          await releaseFirst.promise;
        },
      );
      await firstEntered.promise;
      const second = withPluginLifecycleLease(
        {
          env: { ...state.env, OPENCLAW_STATE_DIR: state.path("state-b") },
          path: databasePath,
          leaseMs: 1_000,
          waitMs: 3_000,
        },
        async () => {
          events.push("second-enter");
        },
      );
      await new Promise((resolve) => {
        setTimeout(resolve, 100);
      });
      expect(events).toEqual(["first-enter"]);
      releaseFirst.resolve();
      await Promise.all([first, second]);
      expect(events).toEqual(["first-enter", "second-enter"]);
    });
  });

  it("serializes lifecycle work across processes", async () => {
    await withOpenClawTestState({ label: "plugin-lifecycle-processes" }, async (state) => {
      const firstMarker = state.path("first-entered");
      const releaseMarker = state.path("release-first");
      const secondMarker = state.path("second-entered");
      const secondReady = state.path("second-ready");
      const secondResult = state.path("second-result");
      const leaseModuleUrl = pathToFileURL(
        path.resolve("src/plugins/plugin-lifecycle-lease.ts"),
      ).href;
      const childScript = await state.writeText(
        "lease-child.mts",
        `
          import fs from "node:fs/promises";
          import { withPluginLifecycleLease } from ${JSON.stringify(leaseModuleUrl)};
          const [role, stateDir, firstMarker, releaseMarker, secondMarker, secondReady, secondResult] = process.argv.slice(2);
          const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
          if (role === "second") {
            await fs.writeFile(secondReady, "ready");
            try {
              await withPluginLifecycleLease({ env, leaseMs: 1_000, waitMs: 0 }, async () => {
                await fs.writeFile(secondMarker, "entered");
              });
              await fs.writeFile(secondResult, "acquired");
            } catch (error) {
              await fs.writeFile(secondResult, error?.code ?? String(error));
            }
          } else {
            await withPluginLifecycleLease({ env, leaseMs: 1_000, waitMs: 5_000 }, async () => {
              await fs.writeFile(firstMarker, "entered");
              while (true) {
                try {
                  await fs.access(releaseMarker);
                  break;
                } catch {
                  await new Promise((resolve) => {
                    setTimeout(resolve, 25);
                  });
                }
              }
            });
          }
        `,
      );

      const childArgs = [
        state.stateDir,
        firstMarker,
        releaseMarker,
        secondMarker,
        secondReady,
        secondResult,
      ];
      const first = runLeaseChild(childScript, ["first", ...childArgs]);
      await waitForPath(firstMarker);
      const second = runLeaseChild(childScript, ["second", ...childArgs]);
      await waitForPath(secondReady);
      // Wait for the child to close so its result write is fully flushed before
      // reading; file existence alone can race with the write after open().
      await second;

      let assertionError: unknown;
      try {
        await expect(fs.readFile(secondResult, "utf8")).resolves.toBe(
          "OPENCLAW_STATE_LEASE_TIMEOUT",
        );
        await expect(fs.access(secondMarker)).rejects.toMatchObject({ code: "ENOENT" });
      } catch (error) {
        assertionError = error;
      } finally {
        await fs.writeFile(releaseMarker, "release");
      }
      await Promise.all([first, second]);
      if (assertionError) {
        throw assertionError instanceof Error
          ? assertionError
          : new Error("cross-process lease assertion failed", { cause: assertionError });
      }
    });
  });

  it("reloads install records after waiting for another process", async () => {
    await withOpenClawTestState({ label: "plugin-lifecycle-record-cache" }, async (state) => {
      const leaseModuleUrl = pathToFileURL(
        path.resolve("src/plugins/plugin-lifecycle-lease.ts"),
      ).href;
      const recordsModuleUrl = pathToFileURL(
        path.resolve("src/plugins/installed-plugin-index-records.ts"),
      ).href;
      const goMarker = state.path("go");
      const readyAlpha = state.path("ready-alpha");
      const readyBeta = state.path("ready-beta");
      const childScript = await state.writeText(
        "record-cache-child.mts",
        `
          import fs from "node:fs/promises";
          import { withPluginLifecycleLease } from ${JSON.stringify(leaseModuleUrl)};
          import {
            loadInstalledPluginIndexInstallRecords,
            writePersistedInstalledPluginIndexInstallRecords,
          } from ${JSON.stringify(recordsModuleUrl)};
          const [pluginId, stateDir, readyMarker, goMarker] = process.argv.slice(2);
          process.env.OPENCLAW_STATE_DIR = stateDir;
          const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
          await loadInstalledPluginIndexInstallRecords();
          await fs.writeFile(readyMarker, "ready");
          while (true) {
            try {
              await fs.access(goMarker);
              break;
            } catch {
              await new Promise((resolve) => setTimeout(resolve, 25));
            }
          }
          await withPluginLifecycleLease({ env, leaseMs: 1_000, waitMs: 5_000 }, async () => {
            const records = await loadInstalledPluginIndexInstallRecords();
            await writePersistedInstalledPluginIndexInstallRecords({
              ...records,
              [pluginId]: {
                source: "path",
                spec: pluginId,
                sourcePath: "/tmp/" + pluginId,
                installPath: "/tmp/" + pluginId,
              },
            });
          });
        `,
      );

      const alpha = runLeaseChild(childScript, ["alpha", state.stateDir, readyAlpha, goMarker]);
      const beta = runLeaseChild(childScript, ["beta", state.stateDir, readyBeta, goMarker]);
      await Promise.all([waitForPath(readyAlpha), waitForPath(readyBeta)]);
      await fs.writeFile(goMarker, "go");
      await Promise.all([alpha, beta]);

      closeOpenClawStateDatabaseForTest();
      const persisted = await readPersistedInstalledPluginIndex({ env: state.env });
      expect(Object.keys(persisted?.installRecords ?? {}).toSorted()).toEqual(["alpha", "beta"]);
    });
  });

  it("reuses the active lease for nested lifecycle work", async () => {
    await withOpenClawTestState({ label: "plugin-lifecycle-reentrant" }, async (state) => {
      const events: string[] = [];
      await withPluginLifecycleLease({ env: state.env, leaseMs: 1_000, waitMs: 0 }, async () => {
        events.push("outer");
        await withPluginLifecycleLease({ env: state.env, leaseMs: 1_000, waitMs: 0 }, async () => {
          events.push("inner");
        });
      });
      expect(events).toEqual(["outer", "inner"]);
    });
  });
});
