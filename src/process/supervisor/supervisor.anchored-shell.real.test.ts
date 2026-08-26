import { writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isProcessAlive, waitForDead, waitForPidFile } from "../../../test/helpers/process-wait.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { createWindowsOutputDecoder } from "../../infra/windows-encoding.js";
import { getWindowsCmdExePath } from "../../infra/windows-install-roots.js";
import { killPidIfAlive } from "../../test-utils/process-tree.js";
import { createProcessSupervisor } from "./supervisor.js";

const activePids = new Set<number>();
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(async () => {
  for (const pid of activePids) {
    killPidIfAlive(pid);
  }
  await Promise.all([...activePids].map((pid) => waitForDead(pid, 5_000).catch(() => {})));
  activePids.clear();
});

async function createDescendantScope() {
  const cwd = tempDirs.make("openclaw-anchored-shell-");
  const descendantPath = path.join(cwd, "descendant.cjs");
  const descendantPidPath = path.join(cwd, "descendant.pid");
  const releasePath = path.join(cwd, "descendant.release");
  const rootPath = path.join(cwd, "root.cjs");
  await writeFile(
    descendantPath,
    `
      const { existsSync, writeFileSync } = require("node:fs");
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
          stdio: ["ignore", "ignore", "ignore", 3],
        });
        child.unref();
        ${fragmentedOutputFixture()}
      `,
      "utf8",
    );
  }
  const supervisor = createProcessSupervisor();
  const scopeKey = `anchored-shell:${cwd}`;
  const run = await supervisor.spawn({
    mode: "anchored-shell",
    command: "node root.cjs",
    sessionId: "anchored-shell-real",
    backendId: "anchored-shell-real",
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
  it.each([
    { name: "cancels retained descendants idempotently", cancel: true },
    { name: "releases ownership after descendants exit naturally", cancel: false },
  ])("$name after root settlement and fragmented output flush", async ({ cancel }) => {
    const { run, supervisor, scopeKey, readPid, release } = await createDescendantScope();
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
    await Promise.all([
      run.waitForExtinction!(),
      supervisor.waitForScope(scopeKey),
      supervisor.waitForScope(scopeKey),
    ]);
    expect(supervisor.getRecord(run.runId)).toMatchObject({
      state: "exited",
      terminationReason: "exit",
      exitCode: 0,
    });
    await waitForDead(descendantPid, 5_000);
  });
});
