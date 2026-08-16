import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { detectUnsafeExecControlShellCommand } from "../infra/exec-control-command-guard.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { withEnvAsync } from "../test-utils/env.js";
import { withTestDir } from "../test-utils/temp-dir.js";
import { createExecTool } from "./bash-tools.exec-run.js";

vi.mock("./bash-tools.exec-host-gateway.js", () => ({
  processGatewayAllowlist: async () => ({ allowWithoutEnforcedCommand: true }),
}));

vi.mock("./bash-tools.exec-host-node.js", () => ({
  executeNodeHostCommand: async () => {
    throw new Error("node host execution is not used by live state SQLite guard tests");
  },
}));

vi.mock("../utils/delivery-context.shared.js", () => ({
  normalizeDeliveryContext: (value: unknown) => value,
}));

const describeNonWin = process.platform === "win32" ? describe.skip : describe;
const quote = (value: string) => JSON.stringify(value);

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  vi.restoreAllMocks();
});

describeNonWin("exec live OpenClaw state SQLite guard", () => {
  it("detects direct and carrier-wrapped SQLite targets under the active state directory", async () => {
    await withTestDir("openclaw-exec-live-sqlite-", async (root) => {
      const stateDir = path.join(root, "state with spaces");
      const databasePath = path.join(stateDir, "state", "openclaw.sqlite");
      await fs.mkdir(path.dirname(databasePath), { recursive: true });
      await fs.writeFile(databasePath, "fixture");

      const context = { stateDir, workdir: root };
      await expect(
        detectUnsafeExecControlShellCommand(`sqlite3 --json ${quote(databasePath)}`, context),
      ).resolves.toBe("live-state-sqlite");
      await expect(
        detectUnsafeExecControlShellCommand(
          `sudo -u openclaw env sqlite3 -header -column ${quote(databasePath)}`,
          context,
        ),
      ).resolves.toBe("live-state-sqlite");
      await expect(
        detectUnsafeExecControlShellCommand(
          'sqlite3 -cmd ".timeout 1000" "$OPENCLAW_STATE_DIR/state/openclaw.sqlite"',
          context,
        ),
      ).resolves.toBe("live-state-sqlite");
      await expect(
        detectUnsafeExecControlShellCommand(
          `sqlite3 :memory: ${quote(`.open ${quote(databasePath)}`)}`,
          context,
        ),
      ).resolves.toBe("live-state-sqlite");
      await expect(
        detectUnsafeExecControlShellCommand(
          `sqlite3 :memory: ${quote(`.op ${quote(databasePath)}`)}`,
          context,
        ),
      ).resolves.toBe("live-state-sqlite");
      await expect(
        detectUnsafeExecControlShellCommand(
          `sqlite3 -cmd ${quote(`.open --readonly ${quote(databasePath)}`)} :memory:`,
          context,
        ),
      ).resolves.toBe("live-state-sqlite");
    });
  });

  it("detects relative and symlink-aliased live state targets", async () => {
    await withTestDir("openclaw-exec-live-sqlite-alias-", async (root) => {
      const stateDir = path.join(root, "state");
      const databasePath = path.join(stateDir, "agents", "main", "state.sqlite");
      const aliasDir = path.join(root, "state-alias");
      await fs.mkdir(path.dirname(databasePath), { recursive: true });
      await fs.writeFile(databasePath, "fixture");
      await fs.symlink(stateDir, aliasDir);

      const context = { stateDir, workdir: root };
      await expect(
        detectUnsafeExecControlShellCommand("sqlite3 state/agents/main/state.sqlite", context),
      ).resolves.toBe("live-state-sqlite");
      await expect(
        detectUnsafeExecControlShellCommand(
          `sqlite3 --readonly ${quote(path.join(aliasDir, "agents", "main", "state.sqlite"))}`,
          context,
        ),
      ).resolves.toBe("live-state-sqlite");
    });
  });

  it("allows SQLite inspection of a private copy outside the active state directory", async () => {
    await withTestDir("openclaw-exec-copied-sqlite-", async (root) => {
      const stateDir = path.join(root, "state");
      const copiedDatabasePath = path.join(root, "snapshot", "openclaw.sqlite");
      await fs.mkdir(path.dirname(copiedDatabasePath), { recursive: true });
      await fs.writeFile(copiedDatabasePath, "fixture");

      await expect(
        detectUnsafeExecControlShellCommand(`sqlite3 ${quote(copiedDatabasePath)}`, {
          stateDir,
          workdir: root,
        }),
      ).resolves.toBeNull();
      await expect(
        detectUnsafeExecControlShellCommand(
          `sqlite3 :memory: ${quote(`.open ${quote(copiedDatabasePath)}`)}`,
          { stateDir, workdir: root },
        ),
      ).resolves.toBeNull();
      await expect(
        detectUnsafeExecControlShellCommand(
          `sqlite3 -cmd ${quote(`.open --readonly ${quote(copiedDatabasePath)}`)} :memory:`,
          { stateDir, workdir: root },
        ),
      ).resolves.toBeNull();
      await expect(
        detectUnsafeExecControlShellCommand(`cat ${quote(path.join(stateDir, "state.sqlite"))}`, {
          stateDir,
          workdir: root,
        }),
      ).resolves.toBeNull();
    });
  });

  it("rejects the live target before the external SQLite process starts", async () => {
    await withTestDir("openclaw-exec-live-sqlite-spawn-", async (root) => {
      const stateDir = path.join(root, "state");
      const databasePath = path.join(stateDir, "agents", "main", "state.sqlite");
      const markerPath = path.join(root, "sqlite-spawned");
      const sqlitePath = path.join(root, "sqlite3");
      await fs.mkdir(path.dirname(databasePath), { recursive: true });
      await fs.writeFile(sqlitePath, `#!/bin/sh\nprintf spawned > ${quote(markerPath)}\n`, {
        mode: 0o755,
      });

      await withEnvAsync(
        {
          HOME: root,
          USERPROFILE: root,
          OPENCLAW_HOME: root,
          OPENCLAW_STATE_DIR: stateDir,
        },
        async () => {
          const tool = createExecTool({
            host: "gateway",
            security: "full",
            ask: "on-miss",
            allowBackground: false,
          });
          await expect(
            tool.execute("call-live-sqlite", {
              command: `${quote(sqlitePath)} :memory: ${quote(`.open ${quote(databasePath)}`)}`,
              workdir: root,
            }),
          ).rejects.toThrow(
            /external sqlite3 cannot open databases under the active OpenClaw state directory/,
          );
        },
      );

      await expect(fs.stat(markerPath)).rejects.toMatchObject({ code: "ENOENT" });
    });
  });
});
