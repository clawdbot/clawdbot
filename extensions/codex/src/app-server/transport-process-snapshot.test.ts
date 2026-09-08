import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isPidAlive } from "openclaw/plugin-sdk/process-runtime";
import { withEnvAsync } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it, vi } from "vitest";
import {
  type PosixProcess,
  readCodexAppServerProcessCommand,
  readCodexAppServerProcessSnapshot,
} from "./transport-process-snapshot.js";

const procfs = vi.hoisted(() => ({
  readFile: vi.fn<(file: string) => Promise<string>>(),
  readdir: vi.fn<() => Promise<string[]>>(),
}));

const observedProcess: PosixProcess = {
  pid: process.pid,
  ppid: process.ppid,
  pgid: process.pid,
  state: "S",
  startedAt: "00000000-0000-0000-0000-000000000001:12345",
};

vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:child_process")>();
  return { ...original, execFile: vi.fn(original.execFile) };
});

vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...original,
    readFile: (...args: Parameters<typeof original.readFile>) =>
      typeof args[0] === "string" &&
      args[0].startsWith("/proc/") &&
      procfs.readFile.getMockImplementation()
        ? procfs.readFile(args[0])
        : original.readFile(...args),
    readdir: (...args: Parameters<typeof original.readdir>) =>
      args[0] === "/proc" && procfs.readdir.getMockImplementation()
        ? procfs.readdir()
        : original.readdir(...args),
  };
});

it.for(["snapshot", "command"] as const)(
  "normalizes synchronous inspector launch denial for %s",
  async (kind, ctx) => {
    ctx.onTestFinished(() => {
      vi.restoreAllMocks();
    });
    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    vi.mocked(execFile).mockImplementationOnce(() => {
      throw Object.assign(new Error("spawn EPERM"), { code: "EPERM" });
    });
    const inspected =
      kind === "snapshot"
        ? readCodexAppServerProcessSnapshot(undefined, [process.pid])
        : readCodexAppServerProcessCommand(observedProcess, Date.now() + 1_000);
    await expect(inspected).rejects.toMatchObject({
      name: "ProcessInspectionError",
      reason: "permission",
      message: expect.stringContaining("Check process inspection permissions"),
    });
  },
);

describe("Codex procfs command inspector", () => {
  it.for([
    "ready",
    "empty",
    "gone",
    "replaced",
    "zombie",
    "reparented",
    "regrouped",
    "malformed",
    "permission",
    "read-error",
    "replaced after read",
  ])("binds empty-command startup readiness to the same live process: %s", async (mode, ctx) => {
    ctx.onTestFinished(() => {
      procfs.readFile.mockReset();
      vi.restoreAllMocks();
    });
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    // Synthetic procfs outcomes must not race host scheduling between reads.
    let now = Date.now();
    const deadline = now + 250;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const bootId = "00000000-0000-0000-0000-000000000001";
    let commandReads = 0;
    procfs.readFile.mockImplementation(async (file) => {
      if (file === "/proc/sys/kernel/random/boot_id") {
        return bootId;
      }
      if (file === `/proc/${process.pid}/cmdline`) {
        commandReads += 1;
        if (commandReads > 1 && mode === "empty") {
          now = deadline;
        }
        if (commandReads > 1 && mode === "read-error") {
          throw Object.assign(new Error("command read failed"), { code: "EIO" });
        }
        return commandReads === 1 || mode === "empty" ? "" : "/opt/codex\0app-server\0";
      }
      expect(file).toBe(`/proc/${process.pid}/stat`);
      if (commandReads && (mode === "gone" || mode === "permission")) {
        throw Object.assign(new Error("identity unavailable"), {
          code: mode === "gone" ? "ENOENT" : "EACCES",
        });
      }
      if (commandReads && mode === "malformed") {
        return "";
      }
      const changed = commandReads > 0;
      const state = changed && mode === "zombie" ? "Z" : "R";
      const ppid = process.ppid + Number(changed && mode === "reparented");
      const pgid = process.pid + Number(changed && mode === "regrouped");
      const replaced =
        (changed && mode === "replaced") || (commandReads > 1 && mode === "replaced after read");
      return `${process.pid} (codex) ${state} ${ppid} ${pgid}${" 0".repeat(14)} 1 0 ${replaced ? 54321 : 12345}\n`;
    });
    const observed = (await readCodexAppServerProcessSnapshot(undefined, [process.pid]))[0]!;
    const inspected = readCodexAppServerProcessCommand(observed, deadline);
    if (mode === "ready") {
      await expect(inspected).resolves.toBe("/opt/codex app-server");
    } else {
      await expect(inspected).rejects.toMatchObject({
        reason:
          mode === "empty" ? "deadline" : mode === "permission" ? "permission" : "unavailable",
      });
    }
    if (["ready", "empty", "read-error", "replaced after read"].includes(mode)) {
      expect(commandReads).toBe(2);
    }
  });

  it.for([
    {
      input: "/opt/codex\0app-server\0--listen\0stdio://\0",
      expected: "/opt/codex app-server --listen stdio://",
    },
    { input: "\0", reason: "unavailable" },
    { input: " \0 ", reason: "unavailable" },
    { code: "ENOENT", reason: "unavailable" },
    { code: "ESRCH", reason: "unavailable" },
    { code: "EACCES", reason: "permission" },
    { code: "ABORT_ERR", reason: "deadline" },
  ])(
    "reads command identity without authorizing absent or unreadable processes: %j",
    async (fixture, ctx) => {
      ctx.onTestFinished(() => {
        procfs.readFile.mockReset();
        vi.restoreAllMocks();
      });
      vi.spyOn(process, "platform", "get").mockReturnValue("linux");
      procfs.readFile.mockImplementation(async (file) => {
        expect(file).toBe(`/proc/${process.pid}/cmdline`);
        if (fixture.code) {
          throw Object.assign(new Error("command unavailable"), { code: fixture.code });
        }
        return fixture.input!;
      });

      const inspected = readCodexAppServerProcessCommand(observedProcess, Date.now() + 1_000);
      if (fixture.reason) {
        await expect(inspected).rejects.toMatchObject({ reason: fixture.reason });
        if (fixture.reason !== "permission") {
          await expect(inspected).rejects.not.toThrow("permissions");
        }
        if (fixture.reason === "deadline") {
          await expect(inspected).rejects.toThrow("deadline");
        }
      } else {
        await expect(inspected).resolves.toBe(fixture.expected);
      }
      procfs.readFile.mockClear();
      await expect(
        readCodexAppServerProcessCommand(observedProcess, Date.now() - 1),
      ).rejects.toMatchObject({ reason: "deadline" });
      expect(procfs.readFile).not.toHaveBeenCalled();
    },
  );
});

describe("Codex procfs process inspector", () => {
  it.for(["1", "2", "0", "-1", "1.5", "missing", "9007199254740992"])(
    "requires explicit thread evidence before classifying a zombie leader: %s",
    async (threads, ctx) => {
      ctx.onTestFinished(() => {
        procfs.readFile.mockReset();
        vi.restoreAllMocks();
      });
      vi.spyOn(process, "platform", "get").mockReturnValue("linux");
      procfs.readFile.mockImplementation(async (file) => {
        if (file === "/proc/sys/kernel/random/boot_id") {
          return "00000000-0000-0000-0000-000000000001";
        }
        expect(file).toBe(`/proc/${process.pid}/stat`);
        return `${process.pid} (worker) Z ${process.ppid} ${process.pid}${" 0".repeat(14)} ${threads} 0 12345\n`;
      });
      const snapshot = readCodexAppServerProcessSnapshot(undefined, [process.pid]);
      if (threads === "1" || threads === "2") {
        await expect(snapshot).resolves.toEqual([
          { ...observedProcess, state: threads === "1" ? "Z" : "Zl" },
        ]);
      } else {
        await expect(snapshot).rejects.toMatchObject({ reason: "unavailable" });
      }
    },
  );

  it.for(["ENOENT", "ESRCH", "EACCES", "exiting"] as const)(
    "distinguishes vanished or exiting neighbors from unreadable state: %s",
    async (code, ctx) => {
      ctx.onTestFinished(() => {
        procfs.readFile.mockReset();
        procfs.readdir.mockReset();
        vi.restoreAllMocks();
      });
      vi.spyOn(process, "platform", "get").mockReturnValue("linux");
      const bootId = "00000000-0000-0000-0000-000000000001";
      const neighborPid = process.pid + 1;
      procfs.readdir.mockResolvedValue([String(process.pid), String(neighborPid)]);
      procfs.readFile.mockImplementation(async (file) => {
        if (file === "/proc/sys/kernel/random/boot_id") {
          return bootId;
        }
        if (file === `/proc/${process.pid}/stat`) {
          // Fields 3..22 follow the final ')', even when comm contains ')' and spaces.
          return `${process.pid} (codex ) worker) S ${process.ppid} ${process.pid}${" 0".repeat(14)} 1 0 12345${" 0".repeat(30)}\n`;
        }
        if (file === `/proc/${neighborPid}/stat`) {
          if (code === "exiting") {
            return `${neighborPid} (worker) Z 0 -1${" 0".repeat(16)} 12345\n`;
          }
          throw Object.assign(new Error("neighbor process read failed"), { code });
        }
        throw new Error(`Unexpected procfs read: ${file}`);
      });
      const snapshot = readCodexAppServerProcessSnapshot();
      if (code === "EACCES") {
        await expect(snapshot).rejects.toMatchObject({ reason: "permission" });
      } else {
        await expect(snapshot).resolves.toEqual([
          {
            pid: process.pid,
            ppid: process.ppid,
            pgid: process.pid,
            state: "S",
            startedAt: `${bootId}:12345`,
          },
        ]);
      }
      if (code === "exiting") {
        await expect(
          readCodexAppServerProcessSnapshot(undefined, [neighborPid]),
        ).rejects.toMatchObject({ reason: "unavailable" });
      }
    },
  );
});

describe.skipIf(process.platform === "win32" || process.platform === "linux")(
  "Codex POSIX process inspector",
  () => {
    it.for(["gone", "missing observer", "malformed"])(
      "requires complete selected ps evidence when the target is %s",
      async (mode, ctx) => {
        const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-ps-selected-"));
        ctx.onTestFinished(() => fs.rm(tempDir, { recursive: true, force: true }));
        await fs.writeFile(
          path.join(tempDir, "ps"),
          `#!/usr/bin/env node
const selected = process.argv[process.argv.indexOf("-p") + 1]?.split(",");
if (selected?.includes("${process.pid}") && ${JSON.stringify(mode)} !== "missing observer") {
  console.log("${process.pid} ${process.ppid} ${process.pid} S Sat Aug 29 10:00:00 2026");
}
if (${JSON.stringify(mode)} === "malformed") console.log("unusable selected process");
`,
          { mode: 0o755 },
        );
        await withEnvAsync(
          { PATH: `${tempDir}${path.delimiter}${process.env.PATH ?? ""}` },
          async () => {
            const inspected = readCodexAppServerProcessSnapshot(undefined, [process.pid + 1]);
            if (mode === "gone") {
              await expect(inspected).resolves.toMatchObject([{ pid: process.pid }]);
            } else {
              await expect(inspected).rejects.toMatchObject({ reason: "unavailable" });
            }
          },
        );
      },
    );

    it.for([
      ["snapshot", "unavailable"],
      ["snapshot", "hung"],
      ["command", "unavailable"],
      ["command", "hung"],
    ] as const)(
      "settles a %s ps inspector without leaking its process",
      async ([kind, mode], ctx) => {
        const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-ps-deadline-"));
        const inspectorPath = path.join(tempDir, "ps");
        const pidPath = path.join(tempDir, "inspector.pid");
        let inspectorPid: number | undefined;
        ctx.onTestFinished(async () => {
          const pid = inspectorPid ?? Number(await fs.readFile(pidPath, "utf8").catch(() => ""));
          if (pid && isPidAlive(pid)) {
            const command = execFileSync("/bin/ps", ["-o", "command=", "-p", String(pid)], {
              encoding: "utf8",
              stdio: ["ignore", "pipe", "ignore"],
            });
            if (command.includes(inspectorPath)) {
              process.kill(pid, "SIGKILL");
            }
          }
          await fs.rm(tempDir, { recursive: true, force: true });
        });
        await fs.writeFile(
          inspectorPath,
          `#!/usr/bin/env node
const fs = require("node:fs");
fs.writeFileSync(process.env.CODEX_TEST_PS_PID_FILE, String(process.pid));
${mode === "unavailable" ? "process.exit(1);" : "setInterval(() => {}, 1000);"}
`,
          { mode: 0o755 },
        );
        await withEnvAsync(
          {
            PATH: `${tempDir}${path.delimiter}${process.env.PATH ?? ""}`,
            CODEX_TEST_PS_PID_FILE: pidPath,
          },
          async () => {
            const startedAt = Date.now();
            const budgetMs = 1_000;
            const result =
              kind === "command"
                ? readCodexAppServerProcessCommand(observedProcess, startedAt + budgetMs)
                : readCodexAppServerProcessSnapshot(startedAt + budgetMs);
            await expect(result).rejects.toMatchObject({
              reason: mode === "hung" ? "deadline" : "unavailable",
            });
            const pid = Number(await fs.readFile(pidPath, "utf8"));
            inspectorPid = pid;
            expect(pid).toBeGreaterThan(0);
            // Allow scheduler jitter, but not the inspector's unbounded event loop.
            expect(Date.now() - startedAt).toBeLessThan(budgetMs + 500);
            await expect.poll(() => isPidAlive(pid)).toBe(false);
          },
        );
      },
    );
  },
);
