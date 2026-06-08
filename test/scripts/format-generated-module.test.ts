// Format Generated Module tests cover format generated module script behavior.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  formatGeneratedModule,
  GENERATED_MODULE_FORMAT_MAX_BUFFER_BYTES,
  GENERATED_MODULE_FORMAT_TIMEOUT_MS,
  resolveGeneratedModuleFormatter,
} from "../../scripts/lib/format-generated-module.mjs";

const tempDirs: string[] = [];

function makeRepoRoot() {
  const repoRoot = mkdtempSync(path.join(os.tmpdir(), "openclaw-format-generated-module-"));
  tempDirs.push(repoRoot);
  const formatterDir = path.join(repoRoot, "node_modules", ".bin");
  mkdirSync(formatterDir, { recursive: true });
  writeFileSync(path.join(formatterDir, "oxfmt"), "#!/bin/sh\n", "utf8");
  return repoRoot;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

describe("resolveGeneratedModuleFormatter", () => {
  it("uses the direct formatter binary on non-Windows when available", () => {
    const formatterPath = path.join("/repo", "node_modules", ".bin", "oxfmt");

    expect(
      resolveGeneratedModuleFormatter({
        existsSync: (value) => value === formatterPath,
        outputPath: "/tmp/generated.ts",
        platform: "linux",
        repoRoot: "/repo",
      }),
    ).toEqual({
      command: formatterPath,
      args: ["--write", "/tmp/generated.ts"],
      shell: false,
    });
  });

  it("wraps pnpm.cmd explicitly on Windows instead of using shell mode", () => {
    expect(
      resolveGeneratedModuleFormatter({
        comSpec: "C:\\Windows\\System32\\cmd.exe",
        existsSync: () => false,
        npmExecPath: "",
        outputPath: "C:\\Users\\test\\AppData\\Local\\Temp\\generated output.ts",
        platform: "win32",
        repoRoot: "C:\\repo",
      }),
    ).toEqual({
      command: "C:\\Windows\\System32\\cmd.exe",
      args: [
        "/d",
        "/s",
        "/c",
        'pnpm.cmd exec oxfmt --write "C:\\Users\\test\\AppData\\Local\\Temp\\generated output.ts"',
      ],
      shell: false,
      windowsVerbatimArguments: true,
    });
  });

  it("runs generated module formatting with bounded child execution", () => {
    const repoRoot = makeRepoRoot();
    const calls: unknown[] = [];

    const formatted = formatGeneratedModule(
      "export const value=1;",
      {
        errorLabel: "test module",
        outputPath: "generated.ts",
        repoRoot,
      },
      {
        resolveFormatter: ({ outputPath }: { outputPath: string }) => ({
          args: ["--write", outputPath],
          command: "oxfmt",
          shell: false,
        }),
        spawnSync: (_command: string, args: string[], options: unknown) => {
          calls.push(options);
          writeFileSync(args[1] ?? "", "export const value = 1;\n", "utf8");
          return { status: 0, stderr: "", stdout: "" };
        },
      },
    );

    expect(formatted).toBe("export const value = 1;\n");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      cwd: repoRoot,
      encoding: "utf8",
      maxBuffer: GENERATED_MODULE_FORMAT_MAX_BUFFER_BYTES,
      shell: false,
      timeout: GENERATED_MODULE_FORMAT_TIMEOUT_MS,
    });
  });

  it("reports formatter timeouts with bounded output tails", () => {
    const repoRoot = makeRepoRoot();
    const timeoutError = Object.assign(new Error("spawnSync oxfmt ETIMEDOUT"), {
      code: "ETIMEDOUT",
    });

    expect(() =>
      formatGeneratedModule(
        "export const value=1;",
        {
          errorLabel: "test module",
          outputPath: "generated.ts",
          repoRoot,
        },
        {
          resolveFormatter: ({ outputPath }: { outputPath: string }) => ({
            args: ["--write", outputPath],
            command: "oxfmt",
            shell: false,
          }),
          spawnSync: () => ({
            error: timeoutError,
            signal: "SIGTERM",
            status: null,
            stderr: `DO_NOT_DUMP_OLD_STDERR${"x".repeat(20 * 1024)}\nrecent stderr tail`,
            stdout: `DO_NOT_DUMP_OLD_STDOUT${"x".repeat(20 * 1024)}\nrecent stdout tail`,
          }),
        },
      ),
    ).toThrow(
      /formatter timed out after 30000ms[\s\S]*recent stderr tail[\s\S]*recent stdout tail/u,
    );

    try {
      formatGeneratedModule(
        "export const value=1;",
        {
          errorLabel: "test module",
          outputPath: "generated.ts",
          repoRoot,
        },
        {
          resolveFormatter: ({ outputPath }: { outputPath: string }) => ({
            args: ["--write", outputPath],
            command: "oxfmt",
            shell: false,
          }),
          spawnSync: () => ({
            error: timeoutError,
            signal: "SIGTERM",
            status: null,
            stderr: `DO_NOT_DUMP_OLD_STDERR${"x".repeat(20 * 1024)}\nrecent stderr tail`,
            stdout: `DO_NOT_DUMP_OLD_STDOUT${"x".repeat(20 * 1024)}\nrecent stdout tail`,
          }),
        },
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).not.toContain("DO_NOT_DUMP_OLD_STDERR");
      expect(message).not.toContain("DO_NOT_DUMP_OLD_STDOUT");
    }
  });
});
