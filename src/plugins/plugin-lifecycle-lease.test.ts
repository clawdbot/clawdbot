import { spawn, type ChildProcessByStdio } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import type { Readable } from "node:stream";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { readPersistedInstalledPluginIndex } from "./installed-plugin-index-store.js";
import { withPluginLifecycleLease } from "./plugin-lifecycle-lease.js";

type LeaseChild = ChildProcessByStdio<null, Readable, Readable>;

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
});

async function terminateLeaseChild(child: LeaseChild): Promise<void> {
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

async function withLeaseChildren<T>(fn: (children: Set<LeaseChild>) => Promise<T>): Promise<T> {
  const children = new Set<LeaseChild>();
  try {
    return await fn(children);
  } finally {
    await Promise.all(Array.from(children, terminateLeaseChild));
  }
}

function runLeaseChild(
  children: Set<LeaseChild>,
  scriptPath: string,
  args: string[],
): { ready: Promise<void>; completed: Promise<void> } {
  const child = spawn(process.execPath, ["--import", "tsx", scriptPath, ...args], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.add(child);
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
      children.delete(child);
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
      children.delete(child);
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
  it.each([
    ["one state directory", false],
    ["an explicit database path across different state directories", true],
  ])("serializes lifecycle work sharing %s", async (_label, explicitPath) => {
    await withOpenClawTestState({ label: "plugin-lifecycle-lease" }, async (state) => {
      const firstEntered = createDeferred();
      const releaseFirst = createDeferred();
      const events: string[] = [];
      const leaseOptions = (caller: string) => ({
        env: explicitPath ? { ...state.env, OPENCLAW_STATE_DIR: state.path(caller) } : state.env,
        ...(explicitPath ? { path: state.path("shared-plugin-lifecycle.sqlite") } : {}),
        leaseMs: 1_000,
        waitMs: 3_000,
      });

      vi.useFakeTimers();
      try {
        const first = withPluginLifecycleLease(leaseOptions("state-a"), async () => {
          events.push("first-enter");
          firstEntered.resolve();
          await releaseFirst.promise;
          events.push("first-exit");
        });
        await firstEntered.promise;
        const second = withPluginLifecycleLease(leaseOptions("state-b"), async () => {
          events.push("second-enter");
        });
        try {
          await vi.advanceTimersByTimeAsync(100);
          expect(events).toEqual(["first-enter"]);
        } finally {
          releaseFirst.resolve();
          // Drive the pending acquisition retry after the first owner releases.
          await vi.advanceTimersByTimeAsync(250);
          await Promise.all([first, second]);
        }
        expect(events).toEqual(["first-enter", "first-exit", "second-enter"]);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  it("serializes lifecycle work across processes", async () => {
    await withOpenClawTestState({ label: "plugin-lifecycle-processes" }, async (state) => {
      await withLeaseChildren(async (children) => {
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
        const first = runLeaseChild(children, childScript, ["first", ...childArgs]);
        await first.ready;
        const second = runLeaseChild(children, childScript, ["second", ...childArgs]);
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
  });

  it("reloads install records after waiting for another process", async () => {
    await withOpenClawTestState({ label: "plugin-lifecycle-record-cache" }, async (state) => {
      await withLeaseChildren(async (children) => {
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

        const alpha = runLeaseChild(children, childScript, ["alpha", state.stateDir, goMarker]);
        const beta = runLeaseChild(children, childScript, ["beta", state.stateDir, goMarker]);
        await Promise.all([alpha.ready, beta.ready]);
        await fs.writeFile(goMarker, "go");
        await Promise.all([alpha.completed, beta.completed]);

        closeOpenClawStateDatabaseForTest();
        const persisted = await readPersistedInstalledPluginIndex({ env: state.env });
        expect(Object.keys(persisted?.installRecords ?? {}).toSorted()).toEqual(["alpha", "beta"]);
      });
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
