import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { withEnvAsync } from "../test-utils/env.js";
import { createConfigIO, writeConfigFile } from "./io.js";
import { mutateConfigFileWithRetry, withConfigMutationExclusive } from "./mutate.js";
import { withConfigWriteLock } from "./write-lock.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) => {
  afterEach(() => {
    closeOpenClawStateDatabaseForTest();
    cleanup();
  });
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("direct config writer exclusion", () => {
  it.each(["direct", "runtime"] as const)(
    "makes the %s writer wait for the canonical mutation scope",
    async (writerKind) => {
      const stateDir = tempDirs.make("openclaw-config-writer-exclusion-");
      const configPath = path.join(stateDir, "openclaw.json");
      const original = '{"gateway":{"mode":"local","port":18789}}\n';
      await fs.writeFile(configPath, original);
      await withEnvAsync(
        { OPENCLAW_STATE_DIR: stateDir, OPENCLAW_CONFIG_PATH: configPath },
        async () => {
          const io = createConfigIO({ configPath, observe: false, pluginValidation: "skip" });
          // Warm the existing dynamic writer import before scheduling the competing call.
          await import("./io.write.js");
          const startWriter = deferred();
          const writer = startWriter.promise.then(() =>
            writerKind === "direct"
              ? io.writeConfigFile({ gateway: { mode: "local", port: 19876 } })
              : writeConfigFile(
                  { gateway: { mode: "local", port: 19876 } },
                  {
                    skipPluginValidation: true,
                    skipRuntimeSnapshotRefresh: true,
                  },
                ),
          );
          try {
            await withConfigMutationExclusive(async () => {
              startWriter.resolve();
              expect(
                await Promise.race([writer.then(() => "wrote"), delay(150).then(() => "blocked")]),
              ).toBe("blocked");
              expect(await fs.readFile(configPath, "utf8")).toBe(original);
            });
          } finally {
            startWriter.resolve();
            await writer;
          }
          expect((await io.readConfigFileSnapshot()).config.gateway?.port).toBe(19876);
        },
      );
    },
  );

  it("does not let detached work inherit a released mutation lock", async () => {
    const stateDir = tempDirs.make("openclaw-config-writer-detached-");
    const configPath = path.join(stateDir, "openclaw.json");
    const original = '{"gateway":{"mode":"local"}}\n';
    await fs.writeFile(configPath, original);
    await withEnvAsync(
      { OPENCLAW_STATE_DIR: stateDir, OPENCLAW_CONFIG_PATH: configPath },
      async () => {
        const io = createConfigIO({ configPath, observe: false, pluginValidation: "skip" });
        const startWriter = deferred();
        let writer!: Promise<unknown>;
        await withConfigMutationExclusive(async () => {
          writer = startWriter.promise.then(() =>
            io.writeConfigFile({ gateway: { mode: "local", port: 19876 } }),
          );
        });
        try {
          await withConfigMutationExclusive(async () => {
            startWriter.resolve();
            expect(
              await Promise.race([writer.then(() => "wrote"), delay(150).then(() => "blocked")]),
            ).toBe("blocked");
            expect(await fs.readFile(configPath, "utf8")).toBe(original);
          });
        } finally {
          startWriter.resolve();
          await writer;
        }
        expect((await io.readConfigFileSnapshot()).config.gateway?.port).toBe(19876);
      },
    );
  });

  it("keeps the lock until an already-admitted detached writer settles", async () => {
    const stateDir = tempDirs.make("openclaw-config-writer-inflight-");
    const configPath = path.join(stateDir, "openclaw.json");
    const original = '{"gateway":{"mode":"local"}}\n';
    await fs.writeFile(configPath, original);
    await withEnvAsync(
      { OPENCLAW_STATE_DIR: stateDir, OPENCLAW_CONFIG_PATH: configPath },
      async () => {
        const io = createConfigIO({ configPath, observe: false, pluginValidation: "skip" });
        const entered = deferred();
        const finish = deferred();
        let writer!: Promise<unknown>;
        const owner = withConfigMutationExclusive(async () => {
          writer = io.writeConfigFile(
            { gateway: { mode: "local", port: 19876 } },
            {
              beforeCommit: async () => {
                entered.resolve();
                await finish.promise;
              },
            },
          );
          await entered.promise;
        });
        try {
          await entered.promise;
          expect(
            await Promise.race([owner.then(() => "released"), delay(150).then(() => "held")]),
          ).toBe("held");
          expect(await fs.readFile(configPath, "utf8")).toBe(original);
          expect(await fs.stat(`${configPath}.lock`)).toBeDefined();
        } finally {
          finish.resolve();
          await owner;
          await writer;
        }
        expect((await io.readConfigFileSnapshot()).config.gateway?.port).toBe(19876);
      },
    );
  });

  it("allows a nested direct writer in the same live mutation scope", async () => {
    const stateDir = tempDirs.make("openclaw-config-writer-nested-");
    const configPath = path.join(stateDir, "openclaw.json");
    await fs.writeFile(configPath, '{"gateway":{"mode":"local"}}\n');
    await withEnvAsync(
      { OPENCLAW_STATE_DIR: stateDir, OPENCLAW_CONFIG_PATH: configPath },
      async () => {
        const io = createConfigIO({ configPath, observe: false, pluginValidation: "skip" });
        await withConfigMutationExclusive(async () => {
          await io.writeConfigFile({ gateway: { mode: "local", port: 19876 } });
          expect((await io.readConfigFileSnapshot()).config.gateway?.port).toBe(19876);
        });
      },
    );
  });
});

describe("included config writer exclusion", () => {
  it.each(["top-level", "delegated"] as const)(
    "waits for exact included-file exclusion through a %s include",
    async (shape) => {
      const stateDir = tempDirs.make("openclaw-included-writer-exclusion-");
      const configPath = path.join(stateDir, "openclaw.json");
      const includePath = path.join(stateDir, "gateway.json5");
      const rootRaw =
        shape === "delegated"
          ? '{"gateway":{"$include":"./gateway-parent.json5"}}\n'
          : '{"gateway":{"$include":"./gateway.json5"}}\n';
      const includeRaw = '{"mode":"local","port":18789}\n';
      const parentPath = path.join(stateDir, "gateway-parent.json5");
      const parentRaw = '{"$include":"./gateway.json5"}\n';
      if (shape === "delegated") {
        await fs.writeFile(parentPath, parentRaw);
      }
      await fs.writeFile(configPath, rootRaw);
      await fs.writeFile(includePath, includeRaw);
      await withEnvAsync(
        { OPENCLAW_STATE_DIR: stateDir, OPENCLAW_CONFIG_PATH: configPath },
        async () => {
          const io = createConfigIO({ configPath, observe: false, pluginValidation: "skip" });
          expect((await io.readConfigFileSnapshot()).config.gateway?.port).toBe(18789);
          const startWriter = deferred();
          const writer = startWriter.promise.then(() =>
            mutateConfigFileWithRetry({
              writeOptions: { skipPluginValidation: true, skipRuntimeSnapshotRefresh: true },
              mutate: (draft) => {
                draft.gateway = { ...draft.gateway, port: 19876 };
              },
            }),
          );
          try {
            await withConfigWriteLock(includePath, async () => {
              startWriter.resolve();
              expect(
                await Promise.race([writer.then(() => "wrote"), delay(250).then(() => "blocked")]),
              ).toBe("blocked");
              expect(await fs.readFile(configPath, "utf8")).toBe(rootRaw);
              expect(await fs.readFile(includePath, "utf8")).toBe(includeRaw);
            });
          } finally {
            startWriter.resolve();
            await writer;
          }
          expect(await fs.readFile(configPath, "utf8")).toBe(rootRaw);
          expect((await io.readConfigFileSnapshot()).config.gateway?.port).toBe(19876);
          if (shape === "delegated") {
            expect(await fs.readFile(parentPath, "utf8")).toBe(parentRaw);
          }
        },
      );
    },
  );
});
