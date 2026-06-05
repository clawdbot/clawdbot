// Check Deadcode Unused Files tests cover check deadcode unused files script behavior.
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  checkUnusedFiles,
  compareUnusedFilesToAllowlist,
  KNIP_MAX_BUFFER_BYTES,
  parseKnipCompactUnusedFiles,
  runKnipUnusedFiles,
} from "../../scripts/check-deadcode-unused-files.mjs";

class FakeKnipProcess extends EventEmitter {
  readonly stderr = new EventEmitter();
  readonly stdout = new EventEmitter();
  pid = 12345;
}

function finishFakeProcess(
  child: FakeKnipProcess,
  status: number | null,
  signal: NodeJS.Signals | null,
): void {
  child.emit("exit", status, signal);
  child.emit("close", status, signal);
}

describe("check-deadcode-unused-files", () => {
  it("parses the compact Knip unused-file section", () => {
    expect(
      parseKnipCompactUnusedFiles(`
> openclaw@2026.4.27 deadcode:knip /repo
> pnpm dlx knip --reporter compact --files

Unused files (2)
src/b.ts: src/b.ts
src/a.ts: src/a.ts

Unused dependencies (1)
left-pad: package.json
`),
    ).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("parses Knip's files-only compact output", () => {
    expect(parseKnipCompactUnusedFiles("src/b.ts: src/b.ts\nsrc/a.ts: src/a.ts\n")).toEqual([
      "src/a.ts",
      "src/b.ts",
    ]);
  });

  it("ignores pnpm dlx progress lines in files-only compact output", () => {
    expect(
      parseKnipCompactUnusedFiles(`
Progress: resolved 21, reused 0, downloaded 0, added 0
src/b.ts: src/b.ts
Progress: resolved 65, reused 20, downloaded 1, added 21, done
src/a.ts: src/a.ts
`),
    ).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("reports unexpected and stale allowlist entries", () => {
    expect(
      compareUnusedFilesToAllowlist(["src/a.ts", "src/new.ts"], ["src/a.ts", "src/old.ts"]),
    ).toStrictEqual({
      actual: ["src/a.ts", "src/new.ts"],
      allowed: ["src/a.ts", "src/old.ts"],
      unexpected: ["src/new.ts"],
      stale: ["src/old.ts"],
      duplicateAllowedCount: 0,
      allowlistIsSorted: true,
    });
  });

  it("accepts optional allowlist entries whether Knip reports them or not", () => {
    expect(
      compareUnusedFilesToAllowlist(
        ["src/a.ts", "src/platform.ts"],
        ["src/a.ts"],
        ["src/platform.ts"],
      ),
    ).toStrictEqual({
      actual: ["src/a.ts", "src/platform.ts"],
      allowed: ["src/a.ts"],
      allowlistIsSorted: true,
      duplicateAllowedCount: 0,
      unexpected: [],
      stale: [],
    });
    expect(
      compareUnusedFilesToAllowlist(["src/a.ts"], ["src/a.ts"], ["src/platform.ts"]),
    ).toStrictEqual({
      actual: ["src/a.ts"],
      allowed: ["src/a.ts"],
      allowlistIsSorted: true,
      duplicateAllowedCount: 0,
      unexpected: [],
      stale: [],
    });
  });

  it("accepts exactly allowlisted unused files", () => {
    expect(checkUnusedFiles("Unused files (1)\nsrc/a.ts: src/a.ts\n", ["src/a.ts"])).toStrictEqual({
      comparison: {
        actual: ["src/a.ts"],
        allowed: ["src/a.ts"],
        allowlistIsSorted: true,
        duplicateAllowedCount: 0,
        stale: [],
        unexpected: [],
      },
      ok: true,
      message: "",
    });
  });

  it("rejects unsorted allowlists", () => {
    expect(
      compareUnusedFilesToAllowlist(["src/a.ts", "src/b.ts"], ["src/b.ts", "src/a.ts"]),
    ).toStrictEqual({
      actual: ["src/a.ts", "src/b.ts"],
      allowed: ["src/a.ts", "src/b.ts"],
      allowlistIsSorted: false,
      duplicateAllowedCount: 0,
      stale: [],
      unexpected: [],
    });
  });

  it("runs Knip through a process-group-aware subprocess", async () => {
    const calls: unknown[] = [];
    const root = mkdtempSync(path.join(os.tmpdir(), "openclaw-knip-runner-"));
    const pnpmExecPath = path.join(root, "pnpm.cjs");
    writeFileSync(pnpmExecPath, "console.log('pnpm');\n", "utf8");

    try {
      const resultPromise = runKnipUnusedFiles({
        nodeExecPath: "/test-node",
        npmExecPath: pnpmExecPath,
        spawnCommand(command: string, args: string[], options: unknown) {
          calls.push({ args, command, options });
          const child = new FakeKnipProcess();
          queueMicrotask(() => {
            child.stdout.emit("data", "partial stdout");
            child.stderr.emit("data", "partial stderr");
            finishFakeProcess(child, 0, null);
          });
          return child;
        },
        writeStatus: () => {},
      });

      const result = await resultPromise;

      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({
        args: [
          pnpmExecPath,
          "--config.minimum-release-age=0",
          "dlx",
          "--package",
          "knip@6.8.0",
          "knip",
          "--config",
          "config/knip.config.ts",
          "--production",
          "--no-progress",
          "--reporter",
          "compact",
          "--files",
          "--no-config-hints",
        ],
        command: "/test-node",
        options: {
          detached: process.platform !== "win32",
          shell: false,
          stdio: ["ignore", "pipe", "pipe"],
        },
      });
      expect(result).toStrictEqual({
        errorCode: undefined,
        errorMessage: undefined,
        output: "partial stdoutpartial stderr",
        signal: null,
        status: 0,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("falls back to bare pnpm when no managed pnpm runner is available", async () => {
    const calls: unknown[] = [];

    const resultPromise = runKnipUnusedFiles({
      npmExecPath: "",
      spawnCommand(command: string, args: string[], options: unknown) {
        calls.push({ args, command, options });
        const child = new FakeKnipProcess();
        queueMicrotask(() => finishFakeProcess(child, 0, null));
        return child;
      },
      writeStatus: () => {},
    });

    await resultPromise;

    expect(calls[0]).toMatchObject({
      args: [
        "--config.minimum-release-age=0",
        "dlx",
        "--package",
        "knip@6.8.0",
        "knip",
        "--config",
        "config/knip.config.ts",
        "--production",
        "--no-progress",
        "--reporter",
        "compact",
        "--files",
        "--no-config-hints",
      ],
      command: "pnpm",
      options: {
        detached: process.platform !== "win32",
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      },
    });
  });

  it("emits heartbeat status and reports Knip timeouts", async () => {
    const statuses: string[] = [];
    const child = new FakeKnipProcess();
    const originalKill = process.kill.bind(process);
    const kills: Array<NodeJS.Signals | number | undefined> = [];
    process.kill = ((pid: number, signal?: NodeJS.Signals | number) => {
      if (Math.abs(pid) === child.pid) {
        kills.push(signal);
        finishFakeProcess(child, null, (signal as NodeJS.Signals | undefined) ?? "SIGTERM");
        return true;
      }
      return originalKill(pid, signal as NodeJS.Signals);
    }) as typeof process.kill;
    try {
      const result = await runKnipUnusedFiles({
        heartbeatMs: 1,
        killGraceMs: 50,
        maxBufferBytes: KNIP_MAX_BUFFER_BYTES,
        spawnCommand: () => child,
        timeoutMs: 5,
        writeStatus: (message: string) => statuses.push(message),
      });

      expect(statuses.some((message) => message.includes("still running"))).toBe(true);
      expect(statuses.some((message) => message.includes("timed out"))).toBe(true);
      expect(kills).toContain("SIGTERM");
      expect(result).toStrictEqual({
        errorCode: "ETIMEDOUT",
        errorMessage: expect.stringContaining("Knip unused-file scan timed out"),
        output: "",
        signal: "SIGTERM",
        status: null,
      });
    } finally {
      process.kill = originalKill;
    }
  });

  it("keeps output delivered after process exit but before stdio close", async () => {
    const child = new FakeKnipProcess();
    const resultPromise = runKnipUnusedFiles({
      spawnCommand: () => child,
      writeStatus: () => {},
    });

    child.stdout.emit("data", "before-exit\n");
    child.emit("exit", 0, null);
    child.stdout.emit("data", "after-exit\n");
    child.emit("close", 0, null);

    await expect(resultPromise).resolves.toStrictEqual({
      errorCode: undefined,
      errorMessage: undefined,
      output: "before-exit\nafter-exit\n",
      signal: null,
      status: 0,
    });
  });

  it("bounds captured Knip output", async () => {
    const child = new FakeKnipProcess();
    const originalKill = process.kill.bind(process);
    process.kill = ((pid: number, signal?: NodeJS.Signals | number) => {
      if (Math.abs(pid) === child.pid) {
        finishFakeProcess(child, null, (signal as NodeJS.Signals | undefined) ?? "SIGTERM");
        return true;
      }
      return originalKill(pid, signal as NodeJS.Signals);
    }) as typeof process.kill;
    try {
      const resultPromise = runKnipUnusedFiles({
        killGraceMs: 50,
        maxBufferBytes: 4,
        spawnCommand: () => child,
        timeoutMs: 1000,
        writeStatus: () => {},
      });
      child.stdout.emit("data", "too much output");

      await expect(resultPromise).resolves.toStrictEqual({
        errorCode: "ENOBUFS",
        errorMessage: "Knip unused-file scan exceeded 4 output bytes",
        output: "too ",
        signal: "SIGTERM",
        status: null,
      });
    } finally {
      process.kill = originalKill;
    }
  });

  it("reports spawn errors", async () => {
    const resultPromise = runKnipUnusedFiles({
      spawnCommand: () => {
        const child = new FakeKnipProcess();
        queueMicrotask(() =>
          child.emit(
            "error",
            Object.assign(new Error("spawn pnpm ENOENT"), {
              code: "ENOENT",
            }),
          ),
        );
        return child;
      },
      writeStatus: () => {},
    });

    await expect(resultPromise).resolves.toStrictEqual({
      errorCode: "ENOENT",
      errorMessage: "spawn pnpm ENOENT",
      output: "",
      signal: null,
      status: null,
    });
  });
});
