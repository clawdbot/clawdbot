import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { readPersistedInstalledPluginIndex } from "./installed-plugin-index-store.js";
import { withPluginLifecycleLease } from "./plugin-lifecycle-lease.js";

const activeLeaseChildren = new Set<ChildProcessWithoutNullStreams>();

afterEach(async () => {
  closeOpenClawStateDatabaseForTest();
  await Promise.all(Array.from(activeLeaseChildren, terminateLeaseChild));
});

async function terminateLeaseChild(child: ChildProcessWithoutNullStreams): Promise<void> {
  await new Promise<void>((resolve) => {
    const onClose = () => resolve();
    child.once("close", onClose);
    if (child.exitCode !== null || child.signalCode !== null) {
      child.off("close", onClose);
      resolve();
      return;
    }
    child.kill("SIGKILL");
  });
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function runLeaseChild(
  scriptPath: string,
  args: string[],
): { ready: Promise<void>; completed: Promise<void> } {
  const child = spawn(process.execPath, ["--import", "tsx", scriptPath, ...args], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  activeLeaseChildren.add(child);
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");

  let stdout = "";
  let stderr = "";
  let pendingLine = "";
  let readySettled = false;
  let resolveReady!: () => void;
  let rejectReady!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });

  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
    pendingLine += chunk;
    const lines = pendingLine.split("\n");
    pendingLine = lines.pop() ?? "";
    if (!readySettled && lines.includes("ready")) {
      readySettled = true;
      resolveReady();
    }
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });

  const completed = new Promise<void>((resolve, reject) => {
    child.once("error", (error) => {
      activeLeaseChildren.delete(child);
      const failure = new Error(`failed to start lease child: ${error.message}`, {
        cause: error,
      });
      if (!readySettled) {
        readySettled = true;
        rejectReady(failure);
      }
      reject(failure);
    });
    child.once("close", (code, signal) => {
      activeLeaseChildren.delete(child);
      const output = `stdout:\n${stdout}\nstderr:\n${stderr}`;
      if (!readySettled) {
        readySettled = true;
        rejectReady(
          new Error(`lease child exited before readiness (${code ?? signal})\n${output}`),
        );
      }
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`lease child exited ${code ?? signal}\n${output}`));
      }
    });
  });
  void completed.catch(() => {});
  return { ready, completed };
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
      const releaseMarker = state.path("release-first");
      const secondMarker = state.path("second-entered");
      const secondResult = state.path("second-result");
      const leaseModuleUrl = pathToFileURL(
        path.resolve("src/plugins/plugin-lifecycle-lease.ts"),
      ).href;
      const childScript = await state.writeText(
        "lease-child.mts",
        `
          import fs from "node:fs/promises";
          import { withPluginLifecycleLease } from ${JSON.stringify(leaseModuleUrl)};
          const [role, stateDir, releaseMarker, secondMarker, secondResult] = process.argv.slice(2);
          const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
          if (role === "second") {
            process.stdout.write("ready\\n");
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
              process.stdout.write("ready\\n");
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

      const childArgs = [state.stateDir, releaseMarker, secondMarker, secondResult];
      const first = runLeaseChild(childScript, ["first", ...childArgs]);
      await first.ready;
      const second = runLeaseChild(childScript, ["second", ...childArgs]);
      await second.ready;
      // Wait for the child to close so its result write is fully flushed before
      // reading; file existence alone can race with the write after open().
      await second.completed;

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
      await Promise.all([first.completed, second.completed]);
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
      const childScript = await state.writeText(
        "record-cache-child.mts",
        `
          import fs from "node:fs/promises";
          import { withPluginLifecycleLease } from ${JSON.stringify(leaseModuleUrl)};
          import {
            loadInstalledPluginIndexInstallRecords,
            writePersistedInstalledPluginIndexInstallRecords,
          } from ${JSON.stringify(recordsModuleUrl)};
          const [pluginId, stateDir, goMarker] = process.argv.slice(2);
          process.env.OPENCLAW_STATE_DIR = stateDir;
          const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
          await loadInstalledPluginIndexInstallRecords();
          process.stdout.write("ready\\n");
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

      const alpha = runLeaseChild(childScript, ["alpha", state.stateDir, goMarker]);
      const beta = runLeaseChild(childScript, ["beta", state.stateDir, goMarker]);
      await Promise.all([alpha.ready, beta.ready]);
      await fs.writeFile(goMarker, "go");
      await Promise.all([alpha.completed, beta.completed]);

      closeOpenClawStateDatabaseForTest();
      const persisted = await readPersistedInstalledPluginIndex({ env: state.env });
      expect(Object.keys(persisted?.installRecords ?? {}).toSorted()).toEqual(["alpha", "beta"]);
    });
  });

  it("reuses the active lease for nested lifecycle work", async () => {
    await withOpenClawTestState({ label: "plugin-lifecycle-reentrant" }, async (state) => {
      const events: string[] = [];
      await withPluginLifecycleLease(
        { env: state.env, leaseMs: 1_000, waitMs: 0 },
        async (outerLease) => {
          events.push("outer");
          await withPluginLifecycleLease({}, async (innerLease) => {
            events.push("inner");
            expect(innerLease).toBe(outerLease);
            expect(innerLease.databasePath).toBe(
              path.resolve(state.stateDir, "state", "openclaw.sqlite"),
            );
          });
        },
      );
      expect(events).toEqual(["outer", "inner"]);
    });
  });
});
