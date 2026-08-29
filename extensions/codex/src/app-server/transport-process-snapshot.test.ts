import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isPidAlive } from "openclaw/plugin-sdk/process-runtime";
import { withEnvAsync } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it, vi } from "vitest";
import {
  readCodexAppServerProcessCommand,
  readCodexAppServerProcessSnapshot,
} from "./transport-process-snapshot.js";

const procfs = vi.hoisted(() => ({
  readFile: vi.fn<(file: string) => Promise<string>>(),
  readdir: vi.fn<() => Promise<string[]>>(),
}));

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

describe("Codex procfs command inspector", () => {
  it.for([
    {
      input: "/opt/codex\0app-server\0--listen\0stdio://\0",
      expected: "/opt/codex app-server --listen stdio://",
    },
    { input: "", expected: undefined },
    { input: "\0", expected: undefined },
    { code: "ENOENT", expected: undefined },
    { code: "ESRCH", expected: undefined },
    { code: "EACCES", expected: undefined },
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

      expect(await readCodexAppServerProcessCommand(process.pid, Date.now() + 1_000)).toBe(
        fixture.expected,
      );
      procfs.readFile.mockClear();
      expect(await readCodexAppServerProcessCommand(process.pid, Date.now() - 1)).toBeUndefined();
      expect(procfs.readFile).not.toHaveBeenCalled();
    },
  );
});

describe.skipIf(process.platform !== "linux")("Codex procfs process inspector", () => {
  it.for(["ENOENT", "ESRCH", "EACCES"] as const)(
    "distinguishes a vanished neighbor from unreadable state: %s",
    async (code, ctx) => {
      ctx.onTestFinished(() => {
        procfs.readFile.mockReset();
        procfs.readdir.mockReset();
      });
      const bootId = "00000000-0000-0000-0000-000000000001";
      const neighborPid = process.pid + 1;
      procfs.readdir.mockResolvedValue([String(process.pid), String(neighborPid)]);
      procfs.readFile.mockImplementation(async (file) => {
        if (file === "/proc/sys/kernel/random/boot_id") {
          return bootId;
        }
        if (file === `/proc/${process.pid}/stat`) {
          // Fields 3..22 follow the final ')', even when comm contains ')' and spaces.
          return `${process.pid} (codex ) worker) S ${process.ppid} ${process.pid}${" 0".repeat(16)} 12345${" 0".repeat(30)}\n`;
        }
        if (file === `/proc/${neighborPid}/stat`) {
          throw Object.assign(new Error("neighbor process read failed"), { code });
        }
        throw new Error(`Unexpected procfs read: ${file}`);
      });
      const snapshot = await readCodexAppServerProcessSnapshot();
      expect(snapshot).toEqual(
        code === "EACCES"
          ? undefined
          : [
              {
                pid: process.pid,
                ppid: process.ppid,
                pgid: process.pid,
                state: "S",
                startedAt: `${bootId}:12345`,
              },
            ],
      );
    },
  );
});

describe.skipIf(process.platform === "win32" || process.platform === "linux")(
  "Codex POSIX process inspector",
  () => {
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
                ? await readCodexAppServerProcessCommand(process.pid, startedAt + budgetMs)
                : await readCodexAppServerProcessSnapshot(startedAt + budgetMs);
            const pid = Number(await fs.readFile(pidPath, "utf8"));
            inspectorPid = pid;
            expect(pid).toBeGreaterThan(0);
            expect(result).toBeUndefined();
            // Allow scheduler jitter, but not the inspector's unbounded event loop.
            expect(Date.now() - startedAt).toBeLessThan(budgetMs + 500);
            await expect.poll(() => isPidAlive(pid)).toBe(false);
          },
        );
      },
    );
  },
);
