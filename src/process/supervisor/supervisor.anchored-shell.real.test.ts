import { spawnSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isProcessAlive, waitForDead, waitForPidFile } from "../../../test/helpers/process-wait.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { createWindowsOutputDecoder } from "../../infra/windows-encoding.js";
import { getWindowsCmdExePath } from "../../infra/windows-install-roots.js";
import { killPidIfAlive } from "../../test-utils/process-tree.js";
import { createProcessSupervisor } from "./supervisor.js";
import type { ManagedRun } from "./types.js";

const activePids = new Set<number>();
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(async () => {
  for (const pid of activePids) {
    killPidIfAlive(pid);
  }
  await Promise.all([...activePids].map((pid) => waitForDead(pid, 5_000).catch(() => {})));
  activePids.clear();
});

async function createDescendantScope(
  options: { inheritLineage?: boolean; oneShot?: boolean; ignoreTerm?: boolean } = {},
) {
  const cwd = tempDirs.make("openclaw-anchored-shell-");
  const descendantPath = path.join(cwd, "descendant.cjs");
  const descendantPidPath = path.join(cwd, "descendant.pid");
  const releasePath = path.join(cwd, "descendant.release");
  const rootPath = path.join(cwd, "root.cjs");
  await writeFile(
    descendantPath,
    `
      const { existsSync, writeFileSync } = require("node:fs");
      ${options.ignoreTerm ? 'process.on("SIGTERM", () => {});' : ""}
      const releaseTimer = setInterval(() => {
        if (existsSync(process.argv[2])) {
          clearInterval(releaseTimer);
        }
      }, 20);
      writeFileSync(process.argv[3], String(process.pid));
    `,
    "utf8",
  );
  if (process.platform === "win32") {
    const koffiPath = createRequire(import.meta.url).resolve("koffi");
    await writeFile(
      rootPath,
      `
        const koffi = require(${JSON.stringify(koffiPath)});
        const kernel32 = koffi.load("kernel32.dll");
        const handle = koffi.pointer("ANCHORED_SHELL_FIXTURE_HANDLE", koffi.opaque());
        const bytes = koffi.pointer("uint8_t");
        const createProcess = kernel32.func("__stdcall", "CreateProcessW", "int32_t", [
          "str16", koffi.pointer("uint16_t"), "void *", "void *", "int32_t", "uint32_t",
          "void *", "str16", bytes, bytes,
        ]);
        const closeHandle = kernel32.func("__stdcall", "CloseHandle", "int32_t", [handle]);
        const getLastError = kernel32.func("__stdcall", "GetLastError", "uint32_t", []);
        // Production only supports x64/arm64, where these Win32 structures are 104/24 bytes.
        const startupInfo = Buffer.alloc(104);
        const processInfo = Buffer.alloc(24);
        startupInfo.writeUInt32LE(startupInfo.length, 0);
        const commandLine = Buffer.from(
          [
            process.execPath,
            ${JSON.stringify(descendantPath)},
            ${JSON.stringify(releasePath)},
            ${JSON.stringify(descendantPidPath)},
          ].map((value) => '"' + value + '"').join(" ") + String.fromCharCode(0),
          "utf16le",
        );

        // Native creation avoids libuv's private Job; no inherited handles guarantees pipe EOF.
        if (!createProcess(
          process.execPath, commandLine, null, null, 0, 0x08000000, null, null,
          startupInfo, processInfo,
        )) {
          throw new Error("fixture CreateProcessW failed (Win32 error " + getLastError() + ")");
        }
        for (const offset of [8, 0]) {
          if (!closeHandle(processInfo.readBigUInt64LE(offset))) {
            throw new Error("fixture CloseHandle failed (Win32 error " + getLastError() + ")");
          }
        }
        ${fragmentedOutputFixture()}
      `,
      "utf8",
    );
  } else {
    await writeFile(
      rootPath,
      `
        const { spawn } = require("node:child_process");
        const child = spawn(process.execPath, [${JSON.stringify(descendantPath)}, ${JSON.stringify(releasePath)}, ${JSON.stringify(descendantPidPath)}], {
          stdio: ${JSON.stringify(options.inheritLineage === false ? ["ignore", "ignore", "ignore"] : ["ignore", "ignore", "ignore", 3])},
        });
        child.unref();
        const ready = setInterval(() => {
          if (!require("node:fs").existsSync(${JSON.stringify(descendantPidPath)})) return;
          clearInterval(ready);
          ${fragmentedOutputFixture()}
        }, 10);
      `,
      "utf8",
    );
  }
  const supervisor = createProcessSupervisor();
  const scopeKey = `anchored-shell:${cwd}`;
  const cleanup = supervisor.acquireScopeCleanup(scopeKey, { processTree: "required-all" });
  const run = await supervisor.spawn({
    ...(options.oneShot
      ? {
          mode: "child" as const,
          argv: [process.execPath, rootPath],
          stdinMode: "pipe-closed" as const,
        }
      : { mode: "anchored-shell" as const, command: "node root.cjs" }),
    scopeKey,
    cwd,
    env:
      process.platform === "win32"
        ? {
            ...process.env,
            COMSPEC: getWindowsCmdExePath(process.env),
            ComSpec: "Z:\\invalid-later-duplicate\\cmd.exe",
          }
        : process.env,
  });
  return {
    run,
    supervisor,
    scopeKey,
    cleanup,
    readPid: () => waitForPidFile(descendantPidPath, 5_000),
    release: () => writeFile(releasePath, "", "utf8"),
  };
}

function fragmentedOutputFixture(): string {
  return `
    process.stdout.write("owned-stdout-one\\nowned-stdout-two\\n");
    process.stderr.write("owned-stderr-one\\nowned-stderr-two\\n");
    process.stdout.write(Buffer.from([0xf0, 0x9f]));
    process.stderr.write(Buffer.from([0xf0, 0x9f]));
    setTimeout(() => {
      process.stdout.write(Buffer.from([0x98, 0x80, 0xe2, 0x82]));
      process.stderr.write(Buffer.from([0x98, 0x80, 0xe2, 0x82]));
    }, 50);
  `;
}

async function expectPending(promise: Promise<void>) {
  const settled = await Promise.race([
    promise.then(() => true),
    new Promise<false>((resolve) => {
      setImmediate(() => resolve(false));
    }),
  ]);
  expect(settled).toBe(false);
}

describe("supervisor anchored shell real process ownership", () => {
  it.skipIf(process.platform === "win32")(
    "keeps the root command alive when it closes its inherited lineage descriptor",
    async () => {
      const supervisor = createProcessSupervisor();
      const command = `${JSON.stringify(process.execPath)} -e ${JSON.stringify(
        'require("node:fs").closeSync(3); setTimeout(() => process.stdout.write("SURVIVED\\n"), 300)',
      )}`;
      const run = await supervisor.spawn({ mode: "anchored-shell", command });
      try {
        await expect(run.wait()).resolves.toMatchObject({
          exitCode: 0,
          exitSignal: null,
          stdout: "SURVIVED\n",
        });
        await run.waitForExtinction!();
      } finally {
        await supervisor.shutdown();
      }
    },
  );

  it.skipIf(process.platform !== "win32")(
    "keeps anchored Windows commands console-free",
    async () => {
      const cwd = tempDirs.make("openclaw-anchored-shell-console-");
      const koffiPath = createRequire(import.meta.url).resolve("koffi");
      await writeFile(
        path.join(cwd, "console.cjs"),
        `
        const koffi = require(${JSON.stringify(koffiPath)});
        const kernel32 = koffi.load("kernel32.dll");
        const getConsoleWindow = kernel32.func("__stdcall", "GetConsoleWindow", "void *", []);
        process.stdout.write(JSON.stringify({ hasConsole: Boolean(getConsoleWindow()) }));
        process.stderr.write("owned-console-stderr");
        process.exitCode = 23;
      `,
        "utf8",
      );
      const supervisor = createProcessSupervisor();
      try {
        const run = await supervisor.spawn({
          mode: "anchored-shell",
          command: `"${process.execPath}" console.cjs`,
          cwd,
        });
        const result = await run.wait();
        await run.waitForExtinction!();
        expect(result).toMatchObject({
          reason: "exit",
          exitCode: 23,
          stderr: "owned-console-stderr",
        });
        expect(JSON.parse(result.stdout), "PR138751_UNEXPECTED_CONSOLE").toEqual({
          hasConsole: false,
        });
      } finally {
        await supervisor.shutdown();
      }
    },
  );

  it.skipIf(process.platform === "win32").each([
    { oneShot: false, ignoreTerm: false },
    { oneShot: true, ignoreTerm: false },
    { oneShot: true, ignoreTerm: true },
  ])(
    "observes children that closed inherited descriptors (oneShot=$oneShot, ignores TERM=$ignoreTerm)",
    async ({ oneShot, ignoreTerm }) => {
      const fixture = await createDescendantScope({ inheritLineage: false, oneShot, ignoreTerm });
      const pid = await fixture.readPid();
      activePids.add(pid);
      try {
        await expect(fixture.run.wait()).resolves.toMatchObject({ exitCode: 0, exitSignal: null });
        const cleanup = fixture.cleanup();
        if (ignoreTerm) {
          await expect(cleanup).rejects.toThrow("cleanup identity lost");
        } else {
          await cleanup;
          expect(isProcessAlive(pid)).toBe(false);
        }
        await waitForDead(pid, 5_000);
      } finally {
        await fixture.release();
        killPidIfAlive(pid);
        await waitForDead(pid, 5_000);
        if (ignoreTerm) {
          await expect(fixture.supervisor.shutdown()).rejects.toThrow("cleanup identity lost");
        } else {
          await fixture.supervisor.shutdown();
        }
      }
    },
  );
  it.each(["inherited", "replacement", "empty"] as const)(
    "completes an otherwise idle host with %s command environment",
    async (environment) => {
      const cwd = tempDirs.make("openclaw-anchored-shell-idle-");
      const hostPath = path.join(cwd, "host.mts");
      const supervisorUrl = new URL("./supervisor.ts", import.meta.url).href;
      let command =
        'printf "%s\\n" "${OPENCLAW_TEST_PARENT_ENV-absent}" "${OPENCLAW_TEST_CHILD_ENV-absent}"';
      if (process.platform === "win32") {
        const commandPath = path.join(cwd, "environment.cmd");
        await writeFile(
          commandPath,
          "@echo off\r\nif defined OPENCLAW_TEST_PARENT_ENV (echo parent) else (echo absent)\r\nif defined OPENCLAW_TEST_CHILD_ENV (echo child) else (echo absent)\r\n",
        );
        command = `"${commandPath}"`;
      }
      await writeFile(
        hostPath,
        `
          const { createProcessSupervisor } = await import(${JSON.stringify(supervisorUrl)});
          const supervisor = createProcessSupervisor();
          const environment = ${JSON.stringify(environment)};
          const run = await supervisor.spawn({
            mode: "anchored-shell",
            command: ${JSON.stringify(command)},
            ...(environment === "inherited" ? {} : {
              env: environment === "empty" ? {} : { OPENCLAW_TEST_CHILD_ENV: "child" },
            }),
          });
          try {
            const result = await run.wait();
            await run.waitForExtinction();
            console.log(JSON.stringify(result));
          } finally {
            await supervisor.shutdown();
          }
        `,
        "utf8",
      );
      // A separate host has no Vitest timers or IPC keeping admission alive.
      const host = spawnSync(process.execPath, ["--import", "tsx", hostPath], {
        env: {
          ...process.env,
          OPENCLAW_TEST_PARENT_ENV: "parent",
          OPENCLAW_TEST_CHILD_ENV: undefined,
        },
        encoding: "utf8",
        timeout: 10_000,
      });
      expect(host.error).toBeUndefined();
      expect(host.status, host.stderr).toBe(0);
      const result = JSON.parse(host.stdout);
      expect({ ...result, stdout: result.stdout.replaceAll("\r\n", "\n") }).toMatchObject({
        reason: "exit",
        exitCode: 0,
        stdout:
          environment === "inherited"
            ? "parent\nabsent\n"
            : environment === "replacement"
              ? "absent\nchild\n"
              : "absent\nabsent\n",
      });
    },
  );

  it.each(["exit", "cancel"] as const)(
    "keeps a replacement's status independent of an older live child's %s",
    async (completion) => {
      const supervisor = createProcessSupervisor();
      const runs: ManagedRun[] = [];
      const oldOutput = createDeferred();
      const spawn = async (scopeKey: string) => {
        const ready = createDeferred();
        const run = await supervisor.spawn({
          mode: "child",
          runId: "shared-correlation",
          scopeKey,
          argv: [
            process.execPath,
            "-e",
            `
              process.stdout.write("ready\\n");
              process.stdin.on("data", (data) => {
                if (data.toString() === "emit") process.stdout.write("older-output\\n");
                else process.exit(Number(data.toString()));
              });
            `,
          ],
          stdinMode: "pipe-open",
          onStdout: (chunk) => {
            if (chunk.includes("ready")) {
              ready.resolve();
            }
            if (chunk.includes("older-output")) {
              oldOutput.resolve();
            }
          },
        });
        runs.push(run);
        activePids.add(run.pid!);
        await Promise.race([
          ready.promise,
          run.wait().then(() => {
            throw new Error("child exited before readiness");
          }),
        ]);
        return run;
      };
      try {
        const older = await spawn("older-backend");
        const replacement = await spawn("replacement-backend");
        const snapshot = { ...replacement.activity };
        older.stdin!.write("emit");
        await oldOutput.promise;
        expect(replacement.activity).toEqual(snapshot);

        if (completion === "exit") {
          older.stdin!.write("23");
        } else {
          older.cancel();
        }
        expect(replacement.activity).toEqual(snapshot);
        await older.wait();
        expect(isProcessAlive(replacement.pid!)).toBe(true);
        expect(replacement.activity).toEqual(snapshot);

        replacement.stdin!.write("0");
        await expect(replacement.wait()).resolves.toMatchObject({ reason: "exit", exitCode: 0 });
        expect(replacement.activity.resultSettled).toBe(true);
      } finally {
        for (const run of runs) {
          run.cancel();
        }
        await Promise.all(runs.map((run) => run.wait()));
        await supervisor.shutdown();
      }
    },
  );

  it("keeps a replacement supervised after an older tree with the same run ID becomes extinct", async () => {
    const first = await createDescendantScope();
    const descendantPid = await first.readPid();
    activePids.add(descendantPid);
    let replacement: Awaited<ReturnType<typeof first.supervisor.spawn>> | undefined;
    try {
      await first.run.wait();
      expect(isProcessAlive(descendantPid)).toBe(true);
      const ready = createDeferred();
      replacement = await first.supervisor.spawn({
        mode: "child",
        runId: first.run.runId,
        scopeKey: "fallback-real",
        argv: [process.execPath, "-e", "process.stdout.write('ready');setInterval(() => {}, 1000)"],
        stdinMode: "pipe-closed",
        onStdout: () => ready.resolve(),
      });
      const replacementPid = replacement.pid!;
      activePids.add(replacementPid);
      await ready.promise;
      await first.release();
      await first.run.waitForExtinction!();
      expect(replacement.activity.resultSettled).toBe(false);
      await first.supervisor.shutdown();

      expect(isProcessAlive(replacementPid)).toBe(false);
      await expect(replacement.wait()).resolves.toMatchObject({ reason: "manual-cancel" });
    } finally {
      await first.release();
      first.run.cancel();
      replacement?.cancel();
      await Promise.all([first.run.waitForExtinction!(), replacement?.wait()]);
      await first.supervisor.shutdown();
    }
  });

  it.each([
    { name: "cancels retained descendants idempotently", cancel: true },
    { name: "releases ownership after descendants exit naturally", cancel: false },
  ])("$name after root settlement and fragmented output flush", async ({ cancel }) => {
    const { run, supervisor, scopeKey, cleanup, readPid, release } = await createDescendantScope();
    const result = await run.wait();
    const decoder = createWindowsOutputDecoder();
    const finalTail = decoder.decode(Buffer.from([0xe2, 0x82])) + decoder.flush();

    expect(result).toMatchObject({ reason: "exit", exitCode: 0, exitSignal: null });
    expect(finalTail).not.toBe("");
    expect(result.stdout.replaceAll("\r\n", "\n")).toBe(
      `owned-stdout-one\nowned-stdout-two\n😀${finalTail}`,
    );
    expect(result.stderr.replaceAll("\r\n", "\n")).toBe(
      `owned-stderr-one\nowned-stderr-two\n😀${finalTail}`,
    );
    const descendantPid = await readPid();
    activePids.add(descendantPid);
    expect(descendantPid).toBeGreaterThan(0);
    expect(isProcessAlive(descendantPid)).toBe(true);
    await expectPending(run.waitForExtinction!());

    if (cancel) {
      supervisor.cancelScope(scopeKey);
      supervisor.cancelScope(scopeKey);
    } else {
      await release();
    }
    await Promise.all([run.waitForExtinction!(), cleanup(), cleanup()]);
    await expect(run.wait()).resolves.toMatchObject({ reason: "exit", exitCode: 0 });
    await waitForDead(descendantPid, 5_000);
  });
});
