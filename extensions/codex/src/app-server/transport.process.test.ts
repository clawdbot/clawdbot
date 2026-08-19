import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { closeCodexAppServerTransportAndWait } from "./transport.js";

type FixtureEvent = {
  role: "root" | "separate-leader" | "separate-descendant" | "shared-leader" | "shared-descendant";
  pid: number;
  pgid: number;
};

type ProcessRow = {
  pid: number;
  command: string;
};

const delay = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

function listProcesses(): ProcessRow[] {
  return execFileSync("ps", ["-axo", "pid=,command="], {
    encoding: "utf8",
  })
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const match = /^(\d+)\s+(.*)$/.exec(line);
      if (!match) {
        throw new Error(`unexpected ps row: ${line}`);
      }
      return {
        pid: Number(match[1]),
        command: match[2] ?? "",
      };
    });
}

async function waitForFixtureEvents(logPath: string, count: number): Promise<FixtureEvent[]> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const events = await readFixtureEvents(logPath);
    if (events.length >= count) {
      return events;
    }
    await delay(20);
  }
  throw new Error(`timed out waiting for ${count} process fixture events`);
}

async function readFixtureEvents(logPath: string): Promise<FixtureEvent[]> {
  const contents = await fs.readFile(logPath, "utf8").catch(() => "");
  return contents
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as FixtureEvent);
}

async function removeTaskOwnedFixtureProcesses(tempDir: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const allRows = listProcesses();
    const ownedRows = allRows.filter((row) => row.command.includes(tempDir));
    if (ownedRows.length === 0) {
      return;
    }
    for (const row of ownedRows) {
      try {
        process.kill(row.pid, "SIGKILL");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
          throw error;
        }
      }
    }
    await delay(20);
  }
  const survivors = listProcesses().filter((row) => row.command.includes(tempDir));
  if (survivors.length > 0) {
    throw new Error(`task-owned process fixture survived cleanup: ${JSON.stringify(survivors)}`);
  }
}

describe.skipIf(process.platform === "win32")("Codex app-server process containment", () => {
  it("reaps descendants in independent and root process groups before close returns", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-transport-process-"));
    const logPath = path.join(tempDir, "processes.jsonl");
    const rootPath = path.join(tempDir, "root.mjs");
    const leaderPath = path.join(tempDir, "leader.mjs");
    const descendantPath = path.join(tempDir, "descendant.mjs");
    await fs.writeFile(logPath, "");
    await fs.writeFile(
      descendantPath,
      `
import { appendFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
const [logPath, role] = process.argv.slice(2);
const pgid = Number(execFileSync("ps", ["-o", "pgid=", "-p", String(process.pid)], { encoding: "utf8" }).trim());
appendFileSync(logPath, JSON.stringify({ role, pid: process.pid, pgid }) + "\\n");
for (const signal of ["SIGTERM", "SIGHUP", "SIGINT"]) process.on(signal, () => {});
setInterval(() => {}, 1_000);
`,
    );
    await fs.writeFile(
      leaderPath,
      `
import { appendFileSync } from "node:fs";
import { execFileSync, spawn } from "node:child_process";
const [logPath, role, descendantPath] = process.argv.slice(2);
const pgid = Number(execFileSync("ps", ["-o", "pgid=", "-p", String(process.pid)], { encoding: "utf8" }).trim());
appendFileSync(logPath, JSON.stringify({ role, pid: process.pid, pgid }) + "\\n");
const descendant = spawn(process.execPath, [descendantPath, logPath, role.replace("leader", "descendant")], { stdio: "ignore" });
descendant.unref();
for (const signal of ["SIGTERM", "SIGHUP", "SIGINT"]) process.on(signal, () => {});
setInterval(() => {}, 1_000);
`,
    );
    await fs.writeFile(
      rootPath,
      `
import { appendFileSync } from "node:fs";
import { execFileSync, spawn } from "node:child_process";
const [logPath, leaderPath, descendantPath] = process.argv.slice(2);
const pgid = Number(execFileSync("ps", ["-o", "pgid=", "-p", String(process.pid)], { encoding: "utf8" }).trim());
appendFileSync(logPath, JSON.stringify({ role: "root", pid: process.pid, pgid }) + "\\n");
for (const [role, detached] of [["separate-leader", true], ["shared-leader", false]]) {
  const child = spawn(process.execPath, [leaderPath, logPath, role, descendantPath], { detached, stdio: "ignore" });
  child.unref();
}
process.stdin.resume();
process.stdin.on("end", () => process.exit(0));
`,
    );

    const root = spawn(process.execPath, [rootPath, logPath, leaderPath, descendantPath], {
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    });

    try {
      const events = await waitForFixtureEvents(logPath, 5);
      const eventByRole = new Map(events.map((event) => [event.role, event]));
      const rootEvent = eventByRole.get("root");
      const separateLeader = eventByRole.get("separate-leader");
      const separateDescendant = eventByRole.get("separate-descendant");
      const sharedLeader = eventByRole.get("shared-leader");
      const sharedDescendant = eventByRole.get("shared-descendant");
      expect(rootEvent).toBeDefined();
      expect(separateLeader?.pgid).toBe(separateLeader?.pid);
      expect(separateDescendant?.pgid).toBe(separateLeader?.pgid);
      expect(sharedLeader?.pgid).toBe(rootEvent?.pgid);
      expect(sharedDescendant?.pgid).toBe(rootEvent?.pgid);
      await expect(
        closeCodexAppServerTransportAndWait(root, {
          forceKillDelayMs: 500,
          exitTimeoutMs: 2_000,
        }),
      ).resolves.toBe(true);
      expect(root.exitCode).toBe(0);
      expect(root.signalCode).toBeNull();

      const survivors = listProcesses().filter((row) => row.command.includes(tempDir));
      expect(survivors).toEqual([]);
    } finally {
      await removeTaskOwnedFixtureProcesses(tempDir);
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("revalidates and retains every identity proven while quiescing", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-identity-reuse-"));
    const rootPath = path.join(tempDir, "root.mjs");
    const sentinelPath = path.join(tempDir, "sentinel.mjs");
    const sentinelPidPath = path.join(tempDir, "sentinel.pid");
    const driverPath = path.join(tempDir, "driver.mts");
    const fakeBin = path.join(tempDir, "bin");
    const fakePsPath = path.join(fakeBin, "ps");
    const fakePsCounterPath = path.join(tempDir, "ps-count");
    const scenarioPath = path.join(tempDir, "ps-scenario.json");
    await fs.mkdir(fakeBin);
    await fs.writeFile(
      sentinelPath,
      `
for (const signal of ["SIGTERM", "SIGHUP", "SIGINT"]) process.on(signal, () => {});
setInterval(() => {}, 1_000);
`,
    );
    await fs.writeFile(
      rootPath,
      `
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
const [sentinelPath, sentinelPidPath] = process.argv.slice(2);
const sentinel = spawn(process.execPath, [sentinelPath], { detached: true, stdio: "ignore" });
sentinel.unref();
writeFileSync(sentinelPidPath, String(sentinel.pid));
process.stdin.resume();
process.stdin.on("end", () => process.exit(0));
`,
    );
    await fs.writeFile(
      fakePsPath,
      `#!/bin/sh
count=0
if [ -f ${JSON.stringify(fakePsCounterPath)} ]; then count=$(command cat ${JSON.stringify(fakePsCounterPath)}); fi
printf '%s' "$((count + 1))" > ${JSON.stringify(fakePsCounterPath)}
last=$(command cat ${JSON.stringify(scenarioPath)})
if [ "$count" -gt "$last" ]; then count=$last; fi
rows=${JSON.stringify(scenarioPath)}.$count
payload=$(command cat "$rows")
if [ "$payload" = FAIL ]; then exit 1; fi
if [ "$payload" = HANG ]; then while :; do sleep 1; done; fi
printf '%s\\n' "$payload"
`,
      { mode: 0o755 },
    );
    await fs.writeFile(
      driverPath,
      `
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
const [mode, transportPath, rootPath, sentinelPath, sentinelPidPath, fakeBin, counterPath, scenarioPath, tempDir] = process.argv.slice(2);
const { closeCodexAppServerTransportAndWait } = await import(pathToFileURL(transportPath).href);
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const readIdentity = (pid) => {
  const line = execFileSync("/bin/ps", ["-o", "pid=,ppid=,pgid=,stat=,lstart=", "-p", String(pid)], { encoding: "utf8" }).trim();
  const match = /^(\\d+)\\s+(\\d+)\\s+(\\d+)\\s+(\\S+)\\s+(.+)$/.exec(line);
  if (!match) throw new Error("unexpected process identity row: " + line);
  return { pid: Number(match[1]), ppid: Number(match[2]), pgid: Number(match[3]), state: match[4], startedAt: match[5] };
};
const waitForFile = async (filePath) => {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const contents = await fs.readFile(filePath, "utf8").catch(() => "");
    if (contents) return contents;
    await delay(20);
  }
  throw new Error("timed out waiting for sentinel PID");
};
const commandForPid = (pid) => {
  try { return execFileSync("/bin/ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" }).trim(); }
  catch { return ""; }
};
const stoppedForPid = (pid) => {
  try { return /^[Tt]/.test(execFileSync("/bin/ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" }).trim()); }
  catch { return false; }
};
const killOwned = (pid) => {
  if (!commandForPid(pid).includes(tempDir)) return;
  try { process.kill(pid, "SIGKILL"); } catch {}
};
const originalPath = process.env.PATH;
let root;
let sentinelPid;
let result;
try {
  await fs.rm(sentinelPidPath, { force: true });
  root = spawn(process.execPath, [rootPath, sentinelPath, sentinelPidPath], { detached: true, stdio: ["pipe", "pipe", "pipe"] });
  sentinelPid = Number((await waitForFile(sentinelPidPath)).trim());
  const rootIdentity = readIdentity(root.pid);
  const sentinelIdentity = readIdentity(sentinelPid);
  const stoppedRoot = { ...rootIdentity, state: "T" };
  const oldSentinel = { ...sentinelIdentity, ppid: root.pid, state: "S", startedAt: "Mon Jan 1 00:00:00 2001" };
  const stoppedOldSentinel = { ...oldSentinel, state: "T" };
  const stoppedSentinel = { ...sentinelIdentity, state: "T" };
  const snapshots =
    mode === "reuse"
      ? [
        [rootIdentity, oldSentinel],
        [rootIdentity, oldSentinel],
        [stoppedRoot, oldSentinel],
        [stoppedRoot, oldSentinel],
        [stoppedRoot, stoppedOldSentinel],
        [stoppedRoot, stoppedSentinel],
      ]
      : mode === "late"
        ? [
        [rootIdentity],
        [rootIdentity],
        [stoppedRoot, sentinelIdentity],
        [stoppedRoot, sentinelIdentity],
        [stoppedRoot, stoppedSentinel],
          ]
        : mode === "reparented"
          ? [
              [rootIdentity, { ...sentinelIdentity, ppid: root.pid }],
              [rootIdentity, { ...sentinelIdentity, ppid: root.pid }],
              [stoppedRoot, { ...sentinelIdentity, ppid: root.pid }],
              [stoppedRoot, { ...sentinelIdentity, ppid: root.pid }],
              [
                stoppedRoot,
                { ...stoppedSentinel, ppid: 1, pgid: stoppedSentinel.pgid + 1 },
              ],
            ]
          : mode === "root-resumed"
            ? [
                [rootIdentity, { ...sentinelIdentity, ppid: root.pid }],
                [rootIdentity, { ...sentinelIdentity, ppid: root.pid }],
                [rootIdentity, { ...sentinelIdentity, ppid: root.pid }],
                [rootIdentity, { ...sentinelIdentity, ppid: root.pid }],
                [stoppedRoot, { ...sentinelIdentity, ppid: root.pid }],
                [stoppedRoot, { ...sentinelIdentity, ppid: root.pid }],
                [stoppedRoot, { ...stoppedSentinel, ppid: root.pid }],
              ]
            : mode === "traced"
              ? [
                  [rootIdentity, { ...sentinelIdentity, ppid: root.pid }],
                  [rootIdentity, { ...sentinelIdentity, ppid: root.pid }],
                  [stoppedRoot, { ...sentinelIdentity, ppid: root.pid }],
                  [stoppedRoot, { ...sentinelIdentity, ppid: root.pid }],
                  [
                    stoppedRoot,
                    { ...stoppedSentinel, ppid: root.pid, state: "t" },
                  ],
                ]
              : mode === "uninterruptible"
                ? [
                    [rootIdentity, { ...sentinelIdentity, ppid: root.pid }],
                    [rootIdentity, { ...sentinelIdentity, ppid: root.pid }],
                    [
                      stoppedRoot,
                      { ...sentinelIdentity, ppid: root.pid, state: "U" },
                    ],
                    [
                      stoppedRoot,
                      { ...sentinelIdentity, ppid: root.pid, state: "U" },
                    ],
                  ]
                : mode === "snapshot-failure"
                  ? [
                      [rootIdentity, { ...sentinelIdentity, ppid: root.pid }],
                      [rootIdentity, { ...sentinelIdentity, ppid: root.pid }],
                      [stoppedRoot, { ...sentinelIdentity, ppid: root.pid }],
                      [stoppedRoot, { ...sentinelIdentity, ppid: root.pid }],
                      null,
                    ]
                  : mode === "inspection-timeout"
                    ? [
                        [rootIdentity, { ...sentinelIdentity, ppid: root.pid }],
                        [rootIdentity, { ...sentinelIdentity, ppid: root.pid }],
                        "HANG",
                      ]
              : [
              [rootIdentity, { ...sentinelIdentity, ppid: root.pid }],
              [rootIdentity, { ...sentinelIdentity, ppid: root.pid }],
              ...Array.from({ length: 8 }, () => [
                [stoppedRoot, { ...sentinelIdentity, ppid: root.pid }],
                [stoppedRoot, { ...sentinelIdentity, ppid: root.pid }],
              ]).flat(),
              [stoppedRoot, { ...stoppedSentinel, ppid: root.pid }],
            ];
  await fs.writeFile(counterPath, "0");
  await fs.writeFile(scenarioPath, String(snapshots.length - 1));
  await Promise.all(snapshots.map(async (rows, index) => {
    const contents = rows === null
      ? "FAIL\\n"
      : rows === "HANG"
        ? "HANG\\n"
        : rows.map((row) => [row.pid, row.ppid, row.pgid, row.state, row.startedAt].join(" ")).join("\\n") + "\\n";
    await fs.writeFile(scenarioPath + "." + index, contents);
  }));
  process.env.PATH = fakeBin + path.delimiter + (originalPath ?? "");
  const closed = await closeCodexAppServerTransportAndWait(root, { forceKillDelayMs: 500, exitTimeoutMs: 2_000 });
  process.env.PATH = originalPath;
  result = {
    closed,
    rootExitCode: root.exitCode,
    sentinelSurvived: commandForPid(sentinelPid).includes(tempDir),
    sentinelStopped: stoppedForPid(sentinelPid),
  };
} finally {
  process.env.PATH = originalPath;
  if (sentinelPid) killOwned(sentinelPid);
  if (root?.pid) killOwned(root.pid);
}
process.stdout.write(JSON.stringify(result));
`,
    );

    try {
      const transportPath = path.resolve("extensions/codex/src/app-server/transport.ts");
      for (const [mode, sentinelSurvived, sentinelStopped] of [
        ["reuse", true],
        ["late", false],
        ["reparented", false],
        ["root-resumed", false],
        ["traced", false],
        ["uninterruptible", false],
        ["snapshot-failure", true, false],
        ["inspection-timeout", true, false],
        ["extended", false],
      ] as const) {
        const output = execFileSync(
          process.execPath,
          [
            "--import",
            "tsx",
            driverPath,
            mode,
            transportPath,
            rootPath,
            sentinelPath,
            sentinelPidPath,
            fakeBin,
            fakePsCounterPath,
            scenarioPath,
            tempDir,
          ],
          { cwd: path.resolve("."), encoding: "utf8", timeout: 30_000 },
        );
        const result = JSON.parse(output) as {
          closed: boolean;
          rootExitCode: number | null;
          sentinelSurvived: boolean;
          sentinelStopped: boolean;
        };
        expect(result).toMatchObject({ closed: true, rootExitCode: 0, sentinelSurvived });
        if (sentinelStopped !== undefined) {
          expect(result.sentinelStopped).toBe(sentinelStopped);
        }
      }
    } finally {
      await removeTaskOwnedFixtureProcesses(tempDir);
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });
});
