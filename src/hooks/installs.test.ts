import fs from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { persistHookPackInstall } from "../cli/hook-install-persistence.js";
import { readConfigFileSnapshotForWrite } from "../config/config.js";
import {
  installPackageDir,
  requestDeferredPackageDirInstall,
  resolvePackageDirInstallTransaction,
} from "../infra/install-package-dir.js";
import { withPluginLifecycleLease } from "../plugins/plugin-lifecycle-lease.js";
import { writeConfigMachineState } from "../state/config-machine-state-write.js";
import { readConfigMachineState } from "../state/config-machine-state.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { withEnvAsync } from "../test-utils/env.js";
import { stageHookInstall } from "./install-record-transaction.js";
import { readHookInstalls, recordHookInstall } from "./installs.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
});

describe("hook install machine state", () => {
  it("merges independently recorded hook packs", () => {
    const stateDir = tempDirs.make("openclaw-hook-installs-");
    const options = { env: { ...process.env, OPENCLAW_STATE_DIR: stateDir } };

    recordHookInstall({ hookId: "alpha", source: "npm" }, options);
    recordHookInstall({ hookId: "beta", source: "path" }, options);

    expect(readHookInstalls(options)).toMatchObject({
      alpha: { source: "npm" },
      beta: { source: "path" },
    });
  });
});

async function withHookInstallFixture(
  mode: "install" | "update" | "link",
  run: (fixture: {
    configPath: string;
    sourceDir: string;
    targetDir: string;
    payloadTransaction: ReturnType<typeof resolvePackageDirInstallTransaction>;
  }) => Promise<void>,
) {
  const root = tempDirs.make("openclaw-hook-commit-");
  const stateDir = join(root, "state");
  const configPath = join(stateDir, "openclaw.json");
  const sourceDir = join(root, "source");
  const targetDir = mode === "link" ? sourceDir : join(stateDir, "hooks", "alpha");
  fs.mkdirSync(sourceDir, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(join(sourceDir, "payload.txt"), "candidate");
  fs.writeFileSync(configPath, "{}\n");
  await withEnvAsync(
    { OPENCLAW_HOME: root, OPENCLAW_STATE_DIR: stateDir, OPENCLAW_CONFIG_PATH: configPath },
    async () => {
      await withPluginLifecycleLease({}, async () => {
        if (mode === "update") {
          fs.mkdirSync(targetDir, { recursive: true });
          fs.writeFileSync(join(targetDir, "payload.txt"), "previous");
          writeConfigMachineState("hooks.internal.installs", {
            alpha: { source: "path", installPath: targetDir, version: "1.0.0" },
          });
        }
        const result =
          mode === "link"
            ? undefined
            : await installPackageDir(
                requestDeferredPackageDirInstall({
                  sourceDir,
                  targetDir,
                  mode,
                  timeoutMs: 30_000,
                  copyErrorPrefix: "fixture copy failed",
                  hasDeps: false,
                  depsLogMessage: "unused",
                }),
              );
        if (result && !result.ok) {
          throw new Error(result.error);
        }
        await run({
          configPath,
          sourceDir,
          targetDir,
          payloadTransaction: result ? resolvePackageDirInstallTransaction(result) : undefined,
        });
      });
    },
  );
}

describe("hook install commit ownership", () => {
  it.each(
    (["install", "update", "link"] as const).flatMap((mode) =>
      (["before record", "after record", "after config"] as const).map((phase) => ({
        mode,
        phase,
      })),
    ),
  )(
    "compensates $mode cancellation $phase without touching its source",
    async ({ mode, phase }) => {
      await withHookInstallFixture(
        mode,
        async ({ configPath, sourceDir, targetDir, payloadTransaction }) => {
          const { snapshot, writeOptions } = await readConfigFileSnapshotForWrite();
          const previousRecords = readConfigMachineState("hooks.internal.installs");
          const previousConfig = fs.readFileSync(configPath, "utf8");
          let closed = phase === "before record";

          await expect(
            persistHookPackInstall({
              snapshot: {
                config: snapshot.config,
                baseHash: snapshot.hash ?? undefined,
                writeOptions,
              },
              hookPackId: "alpha",
              hooks: ["command-audit"],
              // Missing optional fields must compare equal to their persisted JSON representation.
              install: { source: "path", installPath: targetDir, version: undefined },
              payloadTransaction,
              beforePersistentApply() {
                if (phase === "after config") {
                  closed = Boolean(
                    JSON.parse(fs.readFileSync(configPath, "utf8")).hooks?.internal?.entries?.[
                      "command-audit"
                    ]?.enabled,
                  );
                }
                if (closed) {
                  throw new Error("hook authority closed");
                }
                if (phase === "after record") {
                  queueMicrotask(() => {
                    closed = true;
                  });
                }
              },
            }),
          ).rejects.toThrow("hook authority closed");

          expect(readConfigMachineState("hooks.internal.installs")).toEqual(previousRecords);
          expect(fs.readFileSync(configPath, "utf8")).toBe(previousConfig);
          expect(fs.readFileSync(join(sourceDir, "payload.txt"), "utf8")).toBe("candidate");
          if (mode === "install") {
            expect(fs.existsSync(targetDir)).toBe(false);
          } else {
            expect(fs.readFileSync(join(targetDir, "payload.txt"), "utf8")).toBe(
              mode === "update" ? "previous" : "candidate",
            );
          }
        },
      );
    },
  );

  it("refuses compensation after its lifecycle lease has been replaced", async () => {
    const root = tempDirs.make("openclaw-hook-lease-");
    const payload = join(root, "payload.txt");
    fs.writeFileSync(payload, "successor payload");
    await withEnvAsync({ OPENCLAW_STATE_DIR: join(root, "state") }, async () => {
      const transaction = await withPluginLifecycleLease({}, async (lease) => {
        return await stageHookInstall({
          update: { hookId: "alpha", source: "path", installPath: root },
          lease,
          payloadTransaction: {
            async commit() {},
            async rollback() {
              fs.unlinkSync(payload);
            },
          },
        });
      });
      await withPluginLifecycleLease({}, async () => {
        const successor = readHookInstalls();
        await expect(transaction.rollback()).rejects.toThrow("lost");
        expect(readHookInstalls()).toEqual(successor);
        expect(fs.readFileSync(payload, "utf8")).toBe("successor payload");
      });
    });
  });

  it.each(["unrelated", "replacement"] as const)(
    "preserves a %s record written before compensation",
    async (writer) => {
      await withHookInstallFixture("install", async ({ targetDir, payloadTransaction }) => {
        await withPluginLifecycleLease({}, async (lease) => {
          const transaction = await stageHookInstall({
            update: { hookId: "alpha", source: "path", installPath: targetDir, version: undefined },
            payloadTransaction,
            lease,
          });
          const hookId = writer === "replacement" ? "alpha" : "beta";
          recordHookInstall({ hookId, source: "npm", version: "2.0.0" });

          if (writer === "replacement") {
            await expect(transaction.rollback()).rejects.toThrow(
              "newer record and payload retained",
            );
            expect(fs.existsSync(targetDir)).toBe(true);
          } else {
            await transaction.rollback();
            expect(fs.existsSync(targetDir)).toBe(false);
            expect(readHookInstalls().alpha).toBeUndefined();
          }
          expect(readHookInstalls()[hookId]).toMatchObject({ source: "npm", version: "2.0.0" });
        });
      });
    },
  );

  it.each(["logging", "cleanup"] as const)(
    "keeps committed state after a %s failure",
    async (failure) => {
      await withHookInstallFixture(
        "update",
        async ({ configPath, targetDir, payloadTransaction }) => {
          if (!payloadTransaction) {
            throw new Error("expected payload transaction");
          }
          const { snapshot, writeOptions } = await readConfigFileSnapshotForWrite();
          await expect(
            persistHookPackInstall({
              snapshot: {
                config: snapshot.config,
                baseHash: snapshot.hash ?? undefined,
                writeOptions,
              },
              hookPackId: "alpha",
              hooks: ["command-audit"],
              install: { source: "path", installPath: targetDir, version: "2.0.0" },
              payloadTransaction: {
                ...payloadTransaction,
                async commit() {
                  await payloadTransaction.commit();
                  if (failure === "cleanup") {
                    throw new Error("cleanup unavailable");
                  }
                },
              },
              runtime: {
                log() {
                  throw new Error("logging unavailable");
                },
                error() {},
                exit() {
                  throw new Error("unexpected exit");
                },
              },
            }),
          ).rejects.toThrow(failure === "cleanup" ? "committed" : "logging unavailable");

          expect(readHookInstalls().alpha).toMatchObject({ version: "2.0.0" });
          expect(fs.readFileSync(join(targetDir, "payload.txt"), "utf8")).toBe("candidate");
          expect(
            JSON.parse(fs.readFileSync(configPath, "utf8")).hooks.internal.entries["command-audit"]
              .enabled,
          ).toBe(true);
        },
      );
    },
  );
});
