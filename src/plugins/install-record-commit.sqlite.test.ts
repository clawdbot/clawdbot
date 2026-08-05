import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { withEnvAsync } from "../test-utils/env.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { writePersistedInstalledPluginIndexInstallRecordsWithLease } from "./installed-plugin-index-records.js";
import { readPersistedInstalledPluginIndex } from "./installed-plugin-index-store.js";
import { resolveInstalledPluginIndexPolicyHash } from "./installed-plugin-index.js";
import { withPluginLifecycleLease } from "./plugin-lifecycle-lease.js";

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
});

function runChild(scriptPath: string, args: string[]): Promise<void> {
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
        reject(new Error(`install-record commit child exited ${code}: ${output}`));
      }
    });
  });
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.promises.access(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function waitForFile(filePath: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fileExists(filePath)) {
      return;
    }
    await delay(10);
  }
  throw new Error(`timed out waiting for ${filePath}`);
}

async function expectFileToStayAbsent(filePath: string, durationMs = 500): Promise<void> {
  const deadline = Date.now() + durationMs;
  while (Date.now() < deadline) {
    expect(await fileExists(filePath)).toBe(false);
    await delay(10);
  }
}

describe("plugin install record commit rollback", () => {
  it("serializes two failing direct config commits and restores the original index", async () => {
    await withOpenClawTestState({ label: "plugin-record-failing-commits" }, async (state) => {
      const commitModuleUrl = pathToFileURL(
        path.resolve("src/plugins/install-record-commit.ts"),
      ).href;
      const childScript = await state.writeText(
        "fail-config-commit.mts",
        `
          import fs from "node:fs";
          import { setTimeout as delay } from "node:timers/promises";
          import { commitConfigWriteWithPendingPluginInstalls } from ${JSON.stringify(commitModuleUrl)};
          const [stateDir, pluginId, startedPath, enteredPath, releasePath] = process.argv.slice(2);
          process.env.OPENCLAW_STATE_DIR = stateDir;
          await fs.promises.writeFile(startedPath, "started");
          try {
            await commitConfigWriteWithPendingPluginInstalls({
              nextConfig: {
                plugins: {
                  installs: {
                    [pluginId]: {
                      source: "path",
                      spec: pluginId,
                      sourcePath: "/tmp/" + pluginId,
                      installPath: "/tmp/" + pluginId,
                    },
                  },
                },
              },
              commit: async () => {
                await fs.promises.writeFile(enteredPath, "entered");
                while (true) {
                  try {
                    await fs.promises.access(releasePath);
                    break;
                  } catch (error) {
                    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
                      throw error;
                    }
                  }
                  await delay(10);
                }
                throw new Error("config failed " + pluginId);
              },
            });
            throw new Error("config commit unexpectedly succeeded");
          } catch (error) {
            if (!(error instanceof Error) || error.message !== "config failed " + pluginId) {
              throw error;
            }
          }
        `,
      );
      const firstStarted = path.join(state.stateDir, "first-started");
      const firstEntered = path.join(state.stateDir, "first-entered");
      const firstRelease = path.join(state.stateDir, "first-release");
      const secondStarted = path.join(state.stateDir, "second-started");
      const secondEntered = path.join(state.stateDir, "second-entered");
      const secondRelease = path.join(state.stateDir, "second-release");

      await withEnvAsync(state.env, async () => {
        await withPluginLifecycleLease({}, async (lease) => {
          await writePersistedInstalledPluginIndexInstallRecordsWithLease(
            {
              original: {
                source: "path",
                spec: "original",
                sourcePath: "/tmp/original",
                installPath: "/tmp/original",
              },
            },
            { config: {}, lease },
          );
        });

        const firstDone = runChild(childScript, [
          state.stateDir,
          "first",
          firstStarted,
          firstEntered,
          firstRelease,
        ]);
        let secondDone: Promise<void> | undefined;
        try {
          await waitForFile(firstEntered);
          secondDone = runChild(childScript, [
            state.stateDir,
            "second",
            secondStarted,
            secondEntered,
            secondRelease,
          ]);
          await waitForFile(secondStarted);

          // The second writer must stay outside its config commit until the
          // first writer rolls its tentative index state back.
          await expectFileToStayAbsent(secondEntered);

          await fs.promises.writeFile(firstRelease, "release");
          await firstDone;
          await waitForFile(secondEntered);
          await fs.promises.writeFile(secondRelease, "release");
          await secondDone;
        } finally {
          await Promise.all([
            fs.promises.writeFile(firstRelease, "release"),
            fs.promises.writeFile(secondRelease, "release"),
          ]);
          await Promise.allSettled([firstDone, ...(secondDone ? [secondDone] : [])]);
        }
      });

      const persisted = await readPersistedInstalledPluginIndex({ env: state.env });
      expect(persisted?.installRecords).toEqual({
        original: {
          source: "path",
          spec: "original",
          sourcePath: "/tmp/original",
          installPath: "/tmp/original",
        },
      });
      expect(persisted?.policyHash).toBe(resolveInstalledPluginIndexPolicyHash({}));
    });
  });
});
