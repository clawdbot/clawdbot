import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it } from "vitest";
import { replaceConfigFile, type OpenClawConfig } from "../config/config.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { withEnvAsync } from "../test-utils/env.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { resolvePluginArtifactDeclaredSurface } from "./capability-artifact.js";
import { resolvePluginCapabilityConsent } from "./capability-consent.js";
import { computeDeclaredSurfaceHash } from "./capability-summary.js";
import { enablePluginWithCapabilityConsent } from "./enable.js";
import { commitConfigWriteWithPendingPluginInstalls } from "./install-record-commit.js";
import { writePersistedInstalledPluginIndexInstallRecordsWithLease } from "./installed-plugin-index-records.js";
import { readPersistedInstalledPluginIndex } from "./installed-plugin-index-store.js";
import { resolveInstalledPluginIndexPolicyHash } from "./installed-plugin-index.js";
import { withPluginLifecycleLease } from "./plugin-lifecycle-lease.js";

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
});

function runChild(scriptPath: string, args: string[]) {
  const child = spawn(process.execPath, ["--import", "tsx", scriptPath, ...args], {
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  let output = "";
  expectDefined(child.stdout, "piped child stdout").on("data", (chunk) => (output += chunk));
  expectDefined(child.stderr, "piped child stderr").on("data", (chunk) => (output += chunk));
  const ready = new Promise<void>((resolve, reject) => {
    child.on("message", (message) => {
      if (message === "ready") {
        resolve();
      }
    });
    child.on("error", reject);
    child.on("close", () => {
      reject(new Error(`install-record commit child exited before ready: ${output}`));
    });
  });
  const done = new Promise<void>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`install-record commit child exited ${code}: ${output}`));
      }
    });
  });
  return { ready, done };
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
  it.each([
    { pendingRecords: false, legacy: false },
    { pendingRecords: true, legacy: false },
    { pendingRecords: true, legacy: true },
  ])(
    "preserves consent at config commit (pending: $pendingRecords, legacy: $legacy)",
    async ({ pendingRecords, legacy }) => {
      await withOpenClawTestState({ label: "plugin-consent-commit" }, async (state) => {
        const pluginId = "consent-commit";
        const installPath = state.statePath("extensions", pluginId);
        await fs.promises.mkdir(installPath, { recursive: true });
        await fs.promises.writeFile(
          path.join(installPath, "package.json"),
          JSON.stringify({
            name: "@example/consent-commit",
            openclaw: { extensions: ["./index.cjs"] },
          }),
        );
        await fs.promises.writeFile(path.join(installPath, "index.cjs"), "module.exports = {};");
        const manifestPath = path.join(installPath, "openclaw.plugin.json");
        const manifest = {
          id: pluginId,
          configSchema: { type: "object" },
          contracts: { tools: ["read"] },
        };
        await fs.promises.writeFile(manifestPath, JSON.stringify(manifest));
        const config = { plugins: { entries: { [pluginId]: { enabled: legacy } } } };
        await state.writeConfig(config);
        await withEnvAsync(state.env, async () => {
          const acceptedSurface = resolvePluginArtifactDeclaredSurface(installPath);
          const oldRecord = {
            source: "path" as const,
            installPath,
            ...(legacy
              ? {}
              : {
                  acceptedSurface,
                  acceptedSurfaceHash: computeDeclaredSurfaceHash(acceptedSurface),
                }),
          };
          await withPluginLifecycleLease({}, async (lease) => {
            await writePersistedInstalledPluginIndexInstallRecordsWithLease(
              { [pluginId]: oldRecord },
              { config, lease },
            );
          });
          const enabled = await enablePluginWithCapabilityConsent(config, pluginId);
          expect(enabled.enabled).toBe(true);
          if (legacy) {
            let commits = 0;
            await commitConfigWriteWithPendingPluginInstalls({
              nextConfig: {
                plugins: {
                  ...config.plugins,
                  installs: {
                    [pluginId]: { ...oldRecord, installedAt: "2026-08-26T00:00:00.000Z" },
                  },
                },
              },
              commit: async (nextConfig) => {
                commits += 1;
                return await replaceConfigFile({ sourceConfig: nextConfig });
              },
            });
            expect(commits).toBe(1);
            return;
          }
          await withPluginLifecycleLease({}, async (lease) => {
            await fs.promises.writeFile(
              manifestPath,
              JSON.stringify({ ...manifest, contracts: { tools: ["read", "write"] } }),
            );
            await writePersistedInstalledPluginIndexInstallRecordsWithLease(
              { [pluginId]: { source: "path", installPath } },
              { config, lease },
            );
          });
          let commits = 0;
          const commit = async (nextConfig: OpenClawConfig) => {
            commits += 1;
            return await replaceConfigFile({ sourceConfig: nextConfig });
          };
          await expect(
            commitConfigWriteWithPendingPluginInstalls({
              nextConfig: pendingRecords
                ? {
                    ...enabled.config,
                    plugins: { ...enabled.config.plugins, installs: { [pluginId]: oldRecord } },
                  }
                : enabled.config,
              commit,
            }),
          ).rejects.toMatchObject({ capabilityConsent: { pluginId } });
          expect(commits).toBe(0);
          expect(
            (await readPersistedInstalledPluginIndex({ env: state.env }))?.installRecords[pluginId]
              ?.acceptedSurface,
          ).toBeUndefined();
          await resolvePluginCapabilityConsent({
            config,
            pluginId,
            acknowledge: {
              reviewToken: computeDeclaredSurfaceHash(
                resolvePluginArtifactDeclaredSurface(installPath),
              ),
            },
          });
          await commitConfigWriteWithPendingPluginInstalls({ nextConfig: enabled.config, commit });
          expect(commits).toBe(1);
        });
      });
    },
  );

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
          const [stateDir, pluginId, enteredPath, releasePath] = process.argv.slice(2);
          process.env.OPENCLAW_STATE_DIR = stateDir;
          process.send?.("ready");
          process.disconnect?.();
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
      const firstEntered = path.join(state.stateDir, "first-entered");
      const firstRelease = path.join(state.stateDir, "first-release");
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

        const first = runChild(childScript, [state.stateDir, "first", firstEntered, firstRelease]);
        const firstDone = first.done;
        let secondDone: Promise<void> | undefined;
        try {
          // Bootstrap readiness is outside lock assertions; slow TS imports are not blocked writers.
          await first.ready;
          await waitForFile(firstEntered);
          const second = runChild(childScript, [
            state.stateDir,
            "second",
            secondEntered,
            secondRelease,
          ]);
          secondDone = second.done;
          await second.ready;

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
