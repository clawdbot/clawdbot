import syncFs from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { createConfigIO } from "../../config/io.js";
import { replaceConfigFile } from "../../config/mutate.js";
import { openNodeSqliteDatabase } from "../../infra/node-sqlite.js";
import * as temporaryState from "../../infra/tmp-openclaw-dir.js";
import { createUpdateRun } from "../../infra/update-run-ledger.js";
import { beginUpdateRecovery } from "../../infra/update-run-recovery.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { withUpdateCommandExecutor } from "./update-command-executor.js";
import { captureUpdateCommandPreimages } from "./update-command-preimages.js";
import type { UpdateCommandRecovery } from "./update-command-recovery.js";
import { withUpdateCommandSourceOwnership } from "./update-command-source-ownership.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  vi.restoreAllMocks();
});

it.each([
  { revoked: false, included: false, late: false },
  { revoked: true, included: false, late: false },
  { revoked: false, included: true, late: false },
  { revoked: true, included: true, late: false },
  { revoked: true, included: true, late: true },
])(
  "guards config publication with its live source executor (revoked=$revoked, included=$included, late=$late)",
  async ({ revoked, included, late }) => {
    const home = await fs.realpath(dirs.make("update-config-commit-fence-"));
    const stateDir = path.join(home, "state");
    const configPath = path.join(stateDir, "openclaw.json");
    const control = path.join(home, "control");
    await fs.mkdir(control);
    vi.spyOn(temporaryState, "resolvePreferredOpenClawTmpDir").mockReturnValue(control);
    const env = {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_CONFIG_PATH: configPath,
      OPENCLAW_HOME: undefined,
      OPENCLAW_PROFILE: undefined,
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
    };
    const options = { env };
    const run = createUpdateRun({ trigger: "cli" }, options);
    const includePath = path.join(stateDir, "includes", "gateway.json");
    const includedRaw = '{"mode":"local","port":18789}\n';
    const original = included
      ? '{"gateway":{"$include":"./includes/gateway.json"}}\n'
      : '{"gateway":{"mode":"local","port":18789}}\n';
    await fs.writeFile(configPath, original);
    if (included) {
      await fs.mkdir(path.dirname(includePath));
      if (process.platform !== "win32") {
        await fs.chmod(path.dirname(includePath), 0o3700);
      }
      await fs.writeFile(includePath, includedRaw);
    }
    let reachedCommit = false;
    const owned = withUpdateCommandExecutor(run.runId, async (executor) => {
      const fence = await executor.enter(home);
      const runtime = { root: home, nodePath: process.execPath, version: "1.0.0", buildId: null };
      let record = beginUpdateRecovery(
        { runId: run.runId, from: runtime, to: runtime },
        fence,
        options,
      );
      const recovery: UpdateCommandRecovery = {
        options,
        fence,
        getRecord: () => record,
        onRecord: (next) => {
          fence.assertCurrent();
          record = next;
        },
        assertReady: () => {
          throw new Error("Not a serving proof");
        },
      };
      await captureUpdateCommandPreimages({ recovery, env });
      const io = createConfigIO({ configPath, env, observe: false, pluginValidation: "skip" });
      const revoke = () => {
        const db = openNodeSqliteDatabase(path.join(control, "managed-update-handoffs.sqlite"));
        try {
          db.prepare("UPDATE managed_update_handoffs SET owner=? WHERE install_root=?").run(
            "replacement",
            home,
          );
        } finally {
          db.close();
        }
      };
      const beforeCommit = async () => {
        reachedCommit = true;
        if (revoked && !late) {
          revoke();
        }
        if (late) {
          const fsync = syncFs.fsyncSync;
          vi.spyOn(syncFs, "fsyncSync").mockImplementationOnce((fd) => {
            fsync(fd);
            revoke();
          });
        }
      };
      return await withUpdateCommandSourceOwnership({ recovery, env, mutation: true }, async () => {
        const nextConfig = { gateway: { mode: "local" as const, port: 18791 } };
        if (!included) {
          return io.writeConfigFile(nextConfig, { beforeCommit });
        }
        const { snapshot, writeOptions } = await io.readConfigFileSnapshotForWrite();
        return replaceConfigFile({
          snapshot,
          baseHash: snapshot.hash,
          nextConfig: {
            ...snapshot.sourceConfig,
            gateway: { ...snapshot.sourceConfig.gateway, port: 18791 },
          },
          writeOptions: { ...writeOptions, beforeCommit, skipPluginValidation: true },
          io: { ...io, env },
        });
      });
    });
    if (revoked) {
      await expect(owned).rejects.toThrow(/executor|ownership/i);
      expect(await fs.readFile(configPath, "utf8")).toBe(original);
      if (included) {
        expect(await fs.readFile(includePath, "utf8")).toBe(includedRaw);
      }
    } else {
      await owned;
      if (included) {
        expect(await fs.readFile(configPath, "utf8")).toBe(original);
        expect(JSON.parse(await fs.readFile(includePath, "utf8")).port).toBe(18791);
      } else {
        expect(JSON.parse(await fs.readFile(configPath, "utf8")).gateway.port).toBe(18791);
      }
    }
    expect(reachedCommit).toBe(true);
    if (included && process.platform !== "win32") {
      expect((await fs.stat(path.dirname(includePath))).mode & 0o7777).toBe(0o3700);
    }
  },
);
