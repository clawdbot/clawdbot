import { spawn } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { withEnvAsync } from "../test-utils/env.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { commitConfigWriteWithPendingPluginInstalls } from "./install-record-commit.js";
import { readPersistedInstalledPluginIndex } from "./installed-plugin-index-store.js";

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
        reject(new Error(`install-record successor child exited ${code}: ${output}`));
      }
    });
  });
}

describe("plugin install record commit rollback", () => {
  it("keeps a successor index when config commit fails after another process writes", async () => {
    await withOpenClawTestState({ label: "plugin-record-successor" }, async (state) => {
      const leaseModuleUrl = pathToFileURL(
        path.resolve("src/plugins/plugin-lifecycle-lease.ts"),
      ).href;
      const recordsModuleUrl = pathToFileURL(
        path.resolve("src/plugins/installed-plugin-index-records.ts"),
      ).href;
      const childScript = await state.writeText(
        "write-successor.mts",
        `
          import { withPluginLifecycleLease } from ${JSON.stringify(leaseModuleUrl)};
          import { writePersistedInstalledPluginIndexInstallRecordsWithLease } from ${JSON.stringify(recordsModuleUrl)};
          const [stateDir] = process.argv.slice(2);
          const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
          await withPluginLifecycleLease({ env, leaseMs: 1_000, waitMs: 5_000 }, async (lease) => {
            await writePersistedInstalledPluginIndexInstallRecordsWithLease(
              {
                successor: {
                  source: "path",
                  spec: "successor",
                  sourcePath: "/tmp/successor",
                  installPath: "/tmp/successor",
                },
              },
              { env, config: {}, lease },
            );
          });
        `,
      );

      await withEnvAsync(state.env, async () => {
        await expect(
          commitConfigWriteWithPendingPluginInstalls({
            nextConfig: {
              plugins: {
                installs: {
                  tentative: {
                    source: "path",
                    spec: "tentative",
                    sourcePath: "/tmp/tentative",
                    installPath: "/tmp/tentative",
                  },
                },
              },
            },
            commit: async () => {
              await runChild(childScript, [state.stateDir]);
              throw new Error("config changed");
            },
          }),
        ).rejects.toThrow("config changed");
      });

      const persisted = await readPersistedInstalledPluginIndex({ env: state.env });
      expect(persisted?.installRecords).toEqual({
        successor: {
          source: "path",
          spec: "successor",
          sourcePath: "/tmp/successor",
          installPath: "/tmp/successor",
        },
      });
    });
  });
});
