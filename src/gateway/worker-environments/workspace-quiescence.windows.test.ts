import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { runCommandWithTimeout } from "../../process/exec.js";
import {
  REMOTE_WORKSPACE_QUIESCE_JS,
  REMOTE_WORKSPACE_RENEW_QUIESCENCE_JS,
  REMOTE_WORKSPACE_RESUME_JS,
} from "./workspace-quiescence-scripts.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function leaseDatabase(home: string) {
  return path.join(home, ".openclaw-worker", "quiescence", "windows-shared-host.sqlite");
}

function readLease(home: string, workspace: string) {
  const database = new DatabaseSync(leaseDatabase(home), { readOnly: true });
  try {
    return database
      .prepare("SELECT lease_json FROM workspace_leases WHERE workspace_key = ?")
      .get(createHash("sha256").update(workspace).digest("hex")) as
      | { lease_json: string }
      | undefined;
  } finally {
    database.close();
  }
}

describe.runIf(process.platform === "win32")("Windows workspace quiescence", () => {
  it("serializes file-backed shared-host lease acquisition, renewal, and release", async () => {
    const root = tempDirs.make("openclaw-windows-quiescence-test-");
    const home = path.join(root, "home");
    const workspace = path.join(root, "workspace");
    await fs.mkdir(home);
    await fs.mkdir(workspace);
    const realWorkspace = await fs.realpath(workspace);
    const environment = { ...process.env, HOME: home, USERPROFILE: home };

    const quiesced = await runCommandWithTimeout(
      [process.execPath, "-e", REMOTE_WORKSPACE_QUIESCE_JS, realWorkspace, "20000", "shared-host"],
      { timeoutMs: 10_000, baseEnv: environment },
    );
    expect(quiesced.code).toBe(0);
    const nonce = /^quiesced ([a-f0-9]{32})\n$/u.exec(quiesced.stdout)?.[1];
    expect(nonce).toBeDefined();
    expect(readLease(home, realWorkspace)?.lease_json).toContain('"sharedHost":true');

    const overlapping = await runCommandWithTimeout(
      [process.execPath, "-e", REMOTE_WORKSPACE_QUIESCE_JS, realWorkspace, "20000", "shared-host"],
      { timeoutMs: 10_000, baseEnv: environment },
    );
    expect(overlapping.code).not.toBe(0);
    expect(overlapping.stderr).toContain("workspace quiescence lease is already active");

    const renewed = await runCommandWithTimeout(
      [
        process.execPath,
        "-e",
        REMOTE_WORKSPACE_RENEW_QUIESCENCE_JS,
        realWorkspace,
        nonce!,
        "20000",
        "final",
        "shared-host",
      ],
      { timeoutMs: 10_000, baseEnv: environment },
    );
    expect(renewed).toMatchObject({ code: 0, stdout: `renewed ${nonce}\n` });

    await expect(
      runCommandWithTimeout(
        [process.execPath, "-e", REMOTE_WORKSPACE_RESUME_JS, realWorkspace, nonce!],
        { timeoutMs: 10_000, baseEnv: environment },
      ),
    ).resolves.toMatchObject({ code: 0 });
    expect(readLease(home, realWorkspace)).toBeUndefined();

    const database = new DatabaseSync(leaseDatabase(home));
    for (const [leaseWorkspace, expiresAtMs] of [
      [realWorkspace, 1],
      ["abandoned-workspace", 1],
      ["active-workspace", Date.now() + 60_000],
    ] as const) {
      database
        .prepare("INSERT INTO workspace_leases (workspace_key, lease_json) VALUES (?, ?)")
        .run(
          createHash("sha256").update(leaseWorkspace).digest("hex"),
          JSON.stringify({
            version: 1,
            nonce: "d".repeat(32),
            sharedHost: true,
            processes: [],
            watchdog: null,
            expiresAtMs,
          }),
        );
    }
    database.close();
    const simultaneous = await Promise.all([
      runCommandWithTimeout(
        [
          process.execPath,
          "-e",
          REMOTE_WORKSPACE_QUIESCE_JS,
          realWorkspace,
          "20000",
          "shared-host",
        ],
        { timeoutMs: 10_000, baseEnv: environment },
      ),
      runCommandWithTimeout(
        [
          process.execPath,
          "-e",
          REMOTE_WORKSPACE_QUIESCE_JS,
          realWorkspace,
          "20000",
          "shared-host",
        ],
        { timeoutMs: 10_000, baseEnv: environment },
      ),
    ]);
    expect(simultaneous.filter((result) => result.code === 0)).toHaveLength(1);
    expect(simultaneous.find((result) => result.code !== 0)?.stderr).toContain(
      "workspace quiescence lease is already active",
    );
    expect(readLease(home, "abandoned-workspace")).toBeUndefined();
    expect(readLease(home, "active-workspace")).toBeDefined();
    const winner = simultaneous.find((result) => result.code === 0)!;
    const winnerNonce = /^quiesced ([a-f0-9]{32})\n$/u.exec(winner.stdout)?.[1];
    expect(winnerNonce).toBeDefined();
    await expect(
      runCommandWithTimeout(
        [process.execPath, "-e", REMOTE_WORKSPACE_RESUME_JS, realWorkspace, winnerNonce!],
        { timeoutMs: 10_000, baseEnv: environment },
      ),
    ).resolves.toMatchObject({ code: 0 });
    expect(readLease(home, realWorkspace)).toBeUndefined();

    const dedicated = await runCommandWithTimeout(
      [process.execPath, "-e", REMOTE_WORKSPACE_QUIESCE_JS, realWorkspace, "20000", "dedicated"],
      { timeoutMs: 10_000, baseEnv: environment },
    );
    expect(dedicated.code).not.toBe(0);
    expect(dedicated.stderr).toContain("workspace quiescence requires POSIX");
  });

  it("retains the active lease when a transactional renewal is interrupted", async () => {
    const root = tempDirs.make("openclaw-windows-quiescence-recovery-test-");
    const home = path.join(root, "home");
    const workspace = path.join(root, "workspace");
    await fs.mkdir(home);
    await fs.mkdir(workspace);
    const realWorkspace = await fs.realpath(workspace);
    const environment = { ...process.env, HOME: home, USERPROFILE: home };
    const quiesced = await runCommandWithTimeout(
      [process.execPath, "-e", REMOTE_WORKSPACE_QUIESCE_JS, realWorkspace, "20000", "shared-host"],
      { timeoutMs: 10_000, baseEnv: environment },
    );
    const nonce = /^quiesced ([a-f0-9]{32})\n$/u.exec(quiesced.stdout)?.[1];
    expect(nonce).toBeDefined();
    const before = readLease(home, realWorkspace)?.lease_json;

    const interrupted = spawn(
      process.execPath,
      [
        "-e",
        String.raw`const { DatabaseSync } = require("node:sqlite");
const database = new DatabaseSync(process.argv[1]);
database.exec("BEGIN IMMEDIATE");
database.prepare("UPDATE workspace_leases SET lease_json = ? WHERE workspace_key = ?").run(process.argv[3], process.argv[2]);
process.stdout.write("updated\n");
setInterval(() => {}, 1000);`,
        leaseDatabase(home),
        createHash("sha256").update(realWorkspace).digest("hex"),
        JSON.stringify({ ...JSON.parse(before!), expiresAtMs: Date.now() + 60_000 }),
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    const [updated] = (await once(interrupted.stdout, "data")) as [Buffer];
    expect(updated.toString("utf8")).toBe("updated\n");
    expect(interrupted.kill()).toBe(true);
    await once(interrupted, "exit");
    expect(readLease(home, realWorkspace)?.lease_json).toBe(before);

    await expect(
      runCommandWithTimeout(
        [
          process.execPath,
          "-e",
          REMOTE_WORKSPACE_RENEW_QUIESCENCE_JS,
          realWorkspace,
          nonce!,
          "20000",
          "final",
          "shared-host",
        ],
        { timeoutMs: 10_000, baseEnv: environment },
      ),
    ).resolves.toMatchObject({ code: 0, stdout: `renewed ${nonce}\n` });
    await expect(
      runCommandWithTimeout(
        [process.execPath, "-e", REMOTE_WORKSPACE_RESUME_JS, realWorkspace, nonce!],
        { timeoutMs: 10_000, baseEnv: environment },
      ),
    ).resolves.toMatchObject({ code: 0 });
    expect(readLease(home, realWorkspace)).toBeUndefined();
  });
});
