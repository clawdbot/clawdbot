// Format Generated Module tests cover format generated module script behavior.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  formatGeneratedModule,
  GENERATED_MODULE_FORMAT_MAX_BUFFER_BYTES,
  GENERATED_MODULE_FORMAT_TIMEOUT_MS,
} from "../../scripts/lib/format-generated-module.mjs";

const tempDirs: string[] = [];

function makeRepoRoot() {
  const repoRoot = mkdtempSync(path.join(os.tmpdir(), "openclaw-format-generated-module-"));
  tempDirs.push(repoRoot);
  return repoRoot;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

describe("formatGeneratedModule", () => {
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
        spawnSync: (command: string, args: string[], options: unknown) => {
          calls.push({ args, command, options });
          writeFileSync(args[2] ?? "", "export const value = 1;\n", "utf8");
          return { status: 0, stderr: "", stdout: "" };
        },
      },
    );

    expect(formatted).toBe("export const value = 1;\n");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      args: [
        path.join(repoRoot, "node_modules", "oxfmt", "bin", "oxfmt"),
        "--write",
        expect.stringMatching(/generated\.ts$/u),
      ],
      command: process.execPath,
      options: {
        cwd: repoRoot,
        encoding: "utf8",
        maxBuffer: GENERATED_MODULE_FORMAT_MAX_BUFFER_BYTES,
        shell: false,
        timeout: GENERATED_MODULE_FORMAT_TIMEOUT_MS,
      },
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
