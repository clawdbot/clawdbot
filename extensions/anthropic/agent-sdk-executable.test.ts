import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveClaudeAgentSdkExecutable } from "./agent-sdk-executable.js";

const NPM_CMD_SHIM = [
  "@ECHO off",
  "GOTO start",
  ":find_dp0",
  "SET dp0=%~dp0",
  "EXIT /b",
  ":start",
  "SETLOCAL",
  "CALL :find_dp0",
  'IF EXIST "%dp0%\\node.exe" (',
  '  SET "_prog=%dp0%\\node.exe"',
  ") ELSE (",
  '  SET "_prog=node"',
  "  SET PATHEXT=%PATHEXT:;.js;=;%",
  ")",
  'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe" %*',
  "",
].join("\r\n");

type FakeNpmPrefix = {
  prefix: string;
  nativeBinary: string;
  bareEnv: Record<string, string>;
};

const cleanupDirs: string[] = [];

async function createFakeNpmPrefix(options?: {
  includeExtensionlessShim?: boolean;
  includeCmdShim?: boolean;
  includeExeSibling?: boolean;
}): Promise<FakeNpmPrefix> {
  const prefix = await mkdtemp(path.join(os.tmpdir(), "openclaw-claude-win-"));
  cleanupDirs.push(prefix);
  const packageBin = path.join(prefix, "node_modules", "@anthropic-ai", "claude-code", "bin");
  await mkdir(packageBin, { recursive: true });
  const nativeBinary = path.join(packageBin, "claude.exe");
  await writeFile(nativeBinary, "fake-native-binary");
  if (options?.includeExtensionlessShim !== false) {
    await writeFile(path.join(prefix, "claude"), "#!/bin/sh\nexec node cli.js\n");
  }
  if (options?.includeCmdShim !== false) {
    await writeFile(path.join(prefix, "claude.cmd"), NPM_CMD_SHIM);
  }
  if (options?.includeExeSibling) {
    await writeFile(path.join(prefix, "claude.exe"), "fake-native-binary");
  }
  return {
    prefix,
    nativeBinary,
    bareEnv: { PATH: prefix, PATHEXT: ".EXE;.CMD;.BAT;.COM" },
  };
}

afterEach(async () => {
  for (const dir of cleanupDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

describe("resolveClaudeAgentSdkExecutable", () => {
  it("keeps the host command unchanged outside Windows", async () => {
    const { prefix } = await createFakeNpmPrefix();

    expect(
      resolveClaudeAgentSdkExecutable({
        command: path.join(prefix, "claude"),
        env: {},
        platform: "linux",
      }),
    ).toBe(path.join(prefix, "claude"));
    expect(
      resolveClaudeAgentSdkExecutable({
        command: "claude",
        env: {},
        platform: "darwin",
      }),
    ).toBe("claude");
  });

  it("resolves an extensionless npm shim path to the native exe entrypoint on Windows", async () => {
    const { prefix, nativeBinary } = await createFakeNpmPrefix();

    expect(
      resolveClaudeAgentSdkExecutable({
        command: path.join(prefix, "claude"),
        env: { PATHEXT: ".EXE;.CMD;.BAT;.COM" },
        platform: "win32",
      }),
    ).toBe(nativeBinary);
  });

  it("prefers a PATHEXT .exe sibling over the .cmd wrapper on Windows", async () => {
    const { prefix } = await createFakeNpmPrefix({ includeExeSibling: true });

    expect(
      resolveClaudeAgentSdkExecutable({
        command: path.join(prefix, "claude"),
        env: { PATHEXT: ".EXE;.CMD;.BAT;.COM" },
        platform: "win32",
      }),
    ).toBe(path.join(prefix, "claude.exe"));
  });

  it("resolves a bare command through PATH/PATHEXT without picking the extensionless shim", async () => {
    const { nativeBinary, bareEnv } = await createFakeNpmPrefix();

    expect(
      resolveClaudeAgentSdkExecutable({
        command: "claude",
        env: bareEnv,
        platform: "win32",
      }),
    ).toBe(nativeBinary);
  });

  it("unwraps a .cmd shim path supplied by the host on Windows", async () => {
    const { prefix, nativeBinary } = await createFakeNpmPrefix();

    expect(
      resolveClaudeAgentSdkExecutable({
        command: path.join(prefix, "claude.cmd"),
        env: {},
        platform: "win32",
      }),
    ).toBe(nativeBinary);
  });

  it("keeps an already native executable path unchanged on Windows", async () => {
    const { nativeBinary } = await createFakeNpmPrefix();

    expect(
      resolveClaudeAgentSdkExecutable({
        command: nativeBinary,
        env: {},
        platform: "win32",
      }),
    ).toBe(nativeBinary);
  });

  it("falls back to the host command when wrapper resolution cannot find a direct entrypoint", async () => {
    const prefix = await mkdtemp(path.join(os.tmpdir(), "openclaw-claude-win-"));
    cleanupDirs.push(prefix);
    const opaqueWrapper = path.join(prefix, "claude.cmd");
    await writeFile(opaqueWrapper, "@ECHO off\r\necho wrapper\r\n");

    expect(
      resolveClaudeAgentSdkExecutable({
        command: opaqueWrapper,
        env: {},
        platform: "win32",
      }),
    ).toBe(opaqueWrapper);
  });

  it("keeps an extensionless path without PATHEXT siblings unchanged on Windows", async () => {
    const prefix = await mkdtemp(path.join(os.tmpdir(), "openclaw-claude-win-"));
    cleanupDirs.push(prefix);
    const portableTool = path.join(prefix, "claude");
    await writeFile(portableTool, "fake-portable-binary");

    expect(
      resolveClaudeAgentSdkExecutable({
        command: portableTool,
        env: { PATHEXT: ".EXE;.CMD" },
        platform: "win32",
      }),
    ).toBe(portableTool);
  });

  it("hands the SDK the JS entrypoint when only a Node-script launcher exists", async () => {
    const prefix = await mkdtemp(path.join(os.tmpdir(), "openclaw-claude-win-"));
    cleanupDirs.push(prefix);
    const jsEntrypoint = path.join(
      prefix,
      "node_modules",
      "@anthropic-ai",
      "claude-code",
      "cli.js",
    );
    await mkdir(path.dirname(jsEntrypoint), { recursive: true });
    await writeFile(jsEntrypoint, "// fake js entrypoint");
    const cmdShim = NPM_CMD_SHIM.replace("bin\\claude.exe", "cli.js");
    const cmdShimPath = path.join(prefix, "claude.cmd");
    await writeFile(cmdShimPath, cmdShim);

    expect(
      resolveClaudeAgentSdkExecutable({
        command: cmdShimPath,
        env: {},
        platform: "win32",
      }),
    ).toBe(jsEntrypoint);
  });

  it("passes a bare .js command through as the SDK node-script entrypoint on Windows", async () => {
    const prefix = await mkdtemp(path.join(os.tmpdir(), "openclaw-claude-win-"));
    cleanupDirs.push(prefix);
    const jsEntrypoint = path.join(prefix, "claude.js");
    await writeFile(jsEntrypoint, "// fake js entrypoint");

    expect(
      resolveClaudeAgentSdkExecutable({
        command: jsEntrypoint,
        env: {},
        platform: "win32",
      }),
    ).toBe(jsEntrypoint);
  });

  it("falls back to the host command for a Node entrypoint the SDK cannot run directly", async () => {
    const prefix = await mkdtemp(path.join(os.tmpdir(), "openclaw-claude-win-"));
    cleanupDirs.push(prefix);
    const cjsEntrypoint = path.join(
      prefix,
      "node_modules",
      "@anthropic-ai",
      "claude-code",
      "cli.cjs",
    );
    await mkdir(path.dirname(cjsEntrypoint), { recursive: true });
    await writeFile(cjsEntrypoint, "// fake cjs entrypoint");
    const cmdShim = NPM_CMD_SHIM.replace("bin\\claude.exe", "cli.cjs");
    const cmdShimPath = path.join(prefix, "claude.cmd");
    await writeFile(cmdShimPath, cmdShim);

    expect(
      resolveClaudeAgentSdkExecutable({
        command: cmdShimPath,
        env: {},
        platform: "win32",
      }),
    ).toBe(cmdShimPath);
  });
});
