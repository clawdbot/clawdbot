import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CodexAppServerStartOptions } from "./config.js";
import { resolveCodexAppServerSpawnInvocation } from "./transport-stdio.js";

const tempDirs: string[] = [];

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "openclaw-codex-spawn-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

function startOptions(command: string): CodexAppServerStartOptions {
  return {
    transport: "stdio",
    command,
    args: ["app-server", "--listen", "stdio://"],
    headers: {},
  };
}

describe("resolveCodexAppServerSpawnInvocation", () => {
  it("keeps non-Windows Codex app-server invocation unchanged", () => {
    const resolved = resolveCodexAppServerSpawnInvocation(startOptions("codex"), {
      platform: "darwin",
      env: {},
      execPath: "/usr/local/bin/node",
    });

    expect(resolved).toEqual({
      command: "codex",
      args: ["app-server", "--listen", "stdio://"],
      shell: undefined,
      windowsHide: undefined,
    });
  });

  it("resolves Windows npm .cmd Codex shims through Node instead of raw spawn", async () => {
    const binDir = await createTempDir();
    const entryPath = path.join(binDir, "node_modules", "@openai", "codex", "bin", "codex.js");
    const shimPath = path.join(binDir, "codex.cmd");
    await mkdir(path.dirname(entryPath), { recursive: true });
    await writeFile(entryPath, "console.log('codex')\n", "utf8");
    await writeFile(
      shimPath,
      '@ECHO off\r\n"%~dp0\\node_modules\\@openai\\codex\\bin\\codex.js" %*\r\n',
      "utf8",
    );

    const resolved = resolveCodexAppServerSpawnInvocation(startOptions("codex"), {
      platform: "win32",
      env: { PATH: binDir, PATHEXT: ".CMD;.EXE;.BAT" },
      execPath: "C:\\node\\node.exe",
    });

    expect(resolved).toEqual({
      command: "C:\\node\\node.exe",
      args: [entryPath, "app-server", "--listen", "stdio://"],
      shell: undefined,
      windowsHide: true,
    });
  });
});
