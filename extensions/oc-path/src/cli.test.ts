/**
 * Smoke tests for the `openclaw path` CLI handlers.
 *
 * Tests invoke each subcommand through the retained Commander registration.
 * Assertions inspect captured process output and the resulting exit code.
 */
import { execFileSync } from "node:child_process";
import {
  closeSync,
  constants as fsConstants,
  openSync,
  promises as fs,
  readFileSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import { Command, CommanderError } from "commander";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerOcPathCli } from "../cli-registration.js";
import { registerPathCli } from "./cli.js";

const JSONC_INPUT_LIMIT_BYTES = 16 * 1024 * 1024;
type RegisterCli = Parameters<typeof registerOcPathCli>[0]["registerCli"];
type CliRegistrar = Parameters<RegisterCli>[0];
type CliRegistrationOptions = Parameters<RegisterCli>[1];

function resolvePathMachineOutput() {
  let resolver:
    | ((params: { argv: readonly string[]; stdoutIsTTY: boolean }) => boolean)
    | undefined;
  registerOcPathCli({
    registerCli(_registrar: CliRegistrar, options?: CliRegistrationOptions) {
      const descriptor = options?.descriptors?.[0];
      resolver = descriptor && "machineOutput" in descriptor ? descriptor.machineOutput : undefined;
    },
  } as unknown as Parameters<typeof registerOcPathCli>[0]);
  if (!resolver) {
    throw new Error("oc-path CLI descriptor is missing its machine-output resolver");
  }
  return resolver;
}

const isPathMachineOutput = resolvePathMachineOutput();

type PathCommandOptions = {
  readonly json?: boolean;
  readonly human?: boolean;
  readonly valueJson?: boolean;
  readonly cwd?: string;
  readonly file?: string;
  readonly dryRun?: boolean;
  readonly diff?: boolean;
};

interface TestRuntime {
  readonly stdout: string[];
  readonly stderr: string[];
  exitCode: number;
  error(value: string): void;
  writeStdout(value: string): void;
  exit(code: number): void;
}

function createTestRuntime(): TestRuntime {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const runtime: TestRuntime = {
    stdout,
    stderr,
    exitCode: 0,
    error: (value) => {
      stderr.push(value);
    },
    writeStdout: (value) => {
      stdout.push(value);
    },
    exit: (code) => {
      runtime.exitCode = code;
    },
  };
  return runtime;
}

const stdoutText = (rt: TestRuntime): string => rt.stdout.join("");
const stderrText = (rt: TestRuntime): string => rt.stderr.join("");

function optionArgs(options: PathCommandOptions): string[] {
  const args: string[] = [];
  if (options.json === true) {
    args.push("--json");
  }
  if (options.human === true) {
    args.push("--human");
  }
  if (options.valueJson === true) {
    args.push("--value-json");
  }
  if (options.cwd !== undefined) {
    args.push("--cwd", options.cwd);
  }
  if (options.file !== undefined) {
    args.push("--file", options.file);
  }
  if (options.dryRun === true) {
    args.push("--dry-run");
  }
  if (options.diff === true) {
    args.push("--diff");
  }
  return args;
}

async function invokePathCli(args: string[], runtime: TestRuntime): Promise<void> {
  const previousExitCode = process.exitCode;
  process.exitCode = undefined;
  const stdoutWrite = vi.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => {
    runtime.writeStdout(String(chunk));
    return true;
  }) as typeof process.stdout.write);
  const stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => {
    runtime.error(String(chunk));
    return true;
  }) as typeof process.stderr.write);
  try {
    const program = new Command();
    program.exitOverride();
    program.configureOutput({
      writeOut: (value) => runtime.writeStdout(value),
      writeErr: (value) => runtime.error(value),
    });
    registerPathCli(program);
    await program.parseAsync(["node", "openclaw", "path", ...args]);
    runtime.exitCode = process.exitCode ?? 0;
  } catch (error) {
    if (!(error instanceof CommanderError)) {
      throw error;
    }
    runtime.exitCode = error.exitCode;
  } finally {
    stdoutWrite.mockRestore();
    stderrWrite.mockRestore();
    process.exitCode = previousExitCode;
  }
}

async function pathResolveCommand(
  path: string | undefined,
  options: PathCommandOptions,
  runtime: TestRuntime,
): Promise<void> {
  await invokePathCli(
    ["resolve", ...(path === undefined ? [] : [path]), ...optionArgs(options)],
    runtime,
  );
}

async function pathSetCommand(
  path: string | undefined,
  value: string | undefined,
  options: PathCommandOptions,
  runtime: TestRuntime,
): Promise<void> {
  await invokePathCli(
    [
      "set",
      ...(path === undefined ? [] : [path]),
      ...(value === undefined ? [] : [value]),
      ...optionArgs(options),
    ],
    runtime,
  );
}

async function pathFindCommand(
  path: string | undefined,
  options: PathCommandOptions,
  runtime: TestRuntime,
): Promise<void> {
  await invokePathCli(
    ["find", ...(path === undefined ? [] : [path]), ...optionArgs(options)],
    runtime,
  );
}

async function pathValidateCommand(
  path: string | undefined,
  options: PathCommandOptions,
  runtime: TestRuntime,
): Promise<void> {
  await invokePathCli(
    ["validate", ...(path === undefined ? [] : [path]), ...optionArgs(options)],
    runtime,
  );
}

async function pathEmitCommand(
  file: string | undefined,
  options: PathCommandOptions,
  runtime: TestRuntime,
): Promise<void> {
  await invokePathCli(
    ["emit", ...(file === undefined ? [] : [file]), ...optionArgs(options)],
    runtime,
  );
}

describe("openclaw path CLI", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);

  it("reports its TTY-aware machine-output mode to the CLI", () => {
    const argv = ["node", "openclaw", "path", "validate", "oc://AGENTS.md"];
    expect(isPathMachineOutput({ argv, stdoutIsTTY: false })).toBe(true);
    expect(isPathMachineOutput({ argv, stdoutIsTTY: true })).toBe(false);
    expect(isPathMachineOutput({ argv: [...argv, "--json"], stdoutIsTTY: true })).toBe(true);
    expect(isPathMachineOutput({ argv: [...argv, "--human"], stdoutIsTTY: false })).toBe(false);
  });

  describe("validate", () => {
    it("CLI-V01 accepts a well-formed path with --json", async () => {
      const rt = createTestRuntime();
      await pathValidateCommand("oc://AGENTS.md/Tools/-1", { json: true }, rt);
      expect(rt.exitCode).toBe(0);
      const out = JSON.parse(stdoutText(rt));
      expect(out.valid).toBe(true);
      expect(out.structure.file).toBe("AGENTS.md");
      expect(out.structure.section).toBe("Tools");
    });

    it("CLI-V02 rejects a malformed path with code 1", async () => {
      const rt = createTestRuntime();
      await pathValidateCommand("oc://X/a\x00b", { json: true }, rt);
      expect(rt.exitCode).toBe(1);
      const out = JSON.parse(stdoutText(rt));
      expect(out.valid).toBe(false);
    });

    it("CLI-V03 missing argument is rejected by Commander", async () => {
      const rt = createTestRuntime();
      await pathValidateCommand(undefined, { json: true }, rt);
      expect(rt.exitCode).toBe(1);
      expect(stderrText(rt)).toContain("missing required argument");
    });
  });

  describe("resolve", () => {
    it("CLI-R01 finds a leaf in jsonc and prints it", async () => {
      const workspaceDir = tempDirs.make("oc-path-cli-");
      const filePath = join(workspaceDir, "gateway.jsonc");
      writeFileSync(filePath, '{ "version": "1.0" }', "utf-8");
      const rt = createTestRuntime();
      await pathResolveCommand("oc://gateway.jsonc/version", { cwd: workspaceDir, json: true }, rt);
      expect(rt.exitCode).toBe(0);
      const out = JSON.parse(stdoutText(rt));
      expect(out.resolved).toBe(true);
      expect(out.match.kind).toBe("leaf");
      expect(out.match.valueText).toBe("1.0");
    });

    it("CLI-R04 finds a leaf in yaml and prints it", async () => {
      const workspaceDir = tempDirs.make("oc-path-cli-");
      const filePath = join(workspaceDir, "workflow.yaml");
      writeFileSync(filePath, "name: inbox-triage\nsteps:\n  - id: fetch\n", "utf-8");
      const rt = createTestRuntime();
      await pathResolveCommand(
        "oc://workflow.yaml/steps/0/id",
        { cwd: workspaceDir, json: true },
        rt,
      );
      expect(rt.exitCode).toBe(0);
      const out = JSON.parse(stdoutText(rt));
      expect(out.resolved).toBe(true);
      expect(out.match.kind).toBe("leaf");
      expect(out.match.valueText).toBe("fetch");
    });

    it("CLI-R02 returns 1 for not-found path", async () => {
      const workspaceDir = tempDirs.make("oc-path-cli-");
      const filePath = join(workspaceDir, "gateway.jsonc");
      writeFileSync(filePath, '{ "version": "1.0" }', "utf-8");
      const rt = createTestRuntime();
      await pathResolveCommand("oc://gateway.jsonc/missing", { cwd: workspaceDir, json: true }, rt);
      expect(rt.exitCode).toBe(1);
      const out = JSON.parse(stdoutText(rt));
      expect(out.resolved).toBe(false);
    });

    it("CLI-R03 missing argument is rejected by Commander", async () => {
      const rt = createTestRuntime();
      await pathResolveCommand(undefined, { json: true }, rt);
      expect(rt.exitCode).toBe(1);
      expect(stderrText(rt)).toContain("missing required argument");
    });

    it("bounds every file-loading verb before parsing oversized input", async () => {
      const workspaceDir = tempDirs.make("oc-path-cli-");
      const filePath = join(workspaceDir, "oversized.json");
      const content = `"${"界".repeat(Math.floor(JSONC_INPUT_LIMIT_BYTES / 3) + 1)}"`;
      writeFileSync(filePath, content, "utf-8");
      const unboundedRead = vi
        .spyOn(fs, "readFile")
        .mockRejectedValue(new Error("unbounded file read"));
      const cases: ReadonlyArray<{
        code: string;
        run: (runtime: TestRuntime) => Promise<void>;
      }> = [
        {
          code: "OC_JSONC_INPUT_TOO_LARGE",
          run: (runtime) =>
            pathResolveCommand(
              "oc://oversized.json/value",
              { file: filePath, json: true },
              runtime,
            ),
        },
        {
          code: "OC_JSONC_INPUT_TOO_LARGE",
          run: (runtime) =>
            pathFindCommand("oc://oversized.json/*", { file: filePath, json: true }, runtime),
        },
        {
          code: "OC_JSONC_INPUT_TOO_LARGE",
          run: (runtime) =>
            pathSetCommand(
              "oc://oversized.json/value",
              "next",
              { file: filePath, json: true, dryRun: true },
              runtime,
            ),
        },
        {
          code: "OC_JSONC_INPUT_TOO_LARGE",
          run: (runtime) => pathEmitCommand(filePath, { json: true }, runtime),
        },
        {
          code: "OC_PATH_INPUT_TOO_LARGE",
          run: (runtime) =>
            pathResolveCommand("oc://oversized.md/value", { file: filePath, json: true }, runtime),
        },
      ];

      try {
        for (const testCase of cases) {
          const rt = createTestRuntime();
          await testCase.run(rt);
          expect(rt.exitCode).toBe(2);
          expect(stdoutText(rt)).toBe("");
          expect(JSON.parse(stderrText(rt))).toMatchObject({
            error: { code: testCase.code },
          });
        }
        expect(unboundedRead).not.toHaveBeenCalled();
      } finally {
        unboundedRead.mockRestore();
      }
    });

    it.runIf(process.platform !== "win32")(
      "rejects a FIFO without waiting for a writer",
      async () => {
        const workspaceDir = tempDirs.make("oc-path-cli-");
        const fifoPath = join(workspaceDir, "input.json");
        execFileSync("mkfifo", [fifoPath]);
        const releaseBlockedReader = setTimeout(() => {
          const fd = openSync(fifoPath, fsConstants.O_WRONLY | fsConstants.O_NONBLOCK);
          writeSync(fd, '{"ok":true}');
          closeSync(fd);
        }, 250);
        const rt = createTestRuntime();

        try {
          await pathResolveCommand("oc://input.json/ok", { file: fifoPath, json: true }, rt);
        } finally {
          clearTimeout(releaseBlockedReader);
        }

        expect(rt.exitCode).toBe(2);
        expect(JSON.parse(stderrText(rt))).toMatchObject({
          error: { code: "OC_PATH_FILE_NOT_REGULAR" },
        });
      },
    );
  });

  describe("set", () => {
    it("CLI-S01 writes new bytes when path resolves", async () => {
      const workspaceDir = tempDirs.make("oc-path-cli-");
      const filePath = join(workspaceDir, "gateway.jsonc");
      writeFileSync(filePath, '{ "version": "1.0" }', "utf-8");
      const rt = createTestRuntime();
      await pathSetCommand(
        "oc://gateway.jsonc/version",
        "2.0",
        { cwd: workspaceDir, json: true },
        rt,
      );
      expect(rt.exitCode).toBe(0);
      const after = readFileSync(filePath, "utf-8");
      expect(after).toContain('"2.0"');
    });

    it("CLI-S02 --dry-run does not write to disk", async () => {
      const workspaceDir = tempDirs.make("oc-path-cli-");
      const filePath = join(workspaceDir, "gateway.jsonc");
      const before = '{ "version": "1.0" }';
      writeFileSync(filePath, before, "utf-8");
      const rt = createTestRuntime();
      await pathSetCommand(
        "oc://gateway.jsonc/version",
        "2.0",
        { cwd: workspaceDir, json: true, dryRun: true },
        rt,
      );
      expect(rt.exitCode).toBe(0);
      const out = JSON.parse(stdoutText(rt));
      expect(out.dryRun).toBe(true);
      expect(out.bytes).toContain('"2.0"');
      // File on disk unchanged.
      expect(readFileSync(filePath, "utf-8")).toBe(before);
    });

    it("CLI-S02b --dry-run human output reports the rendered UTF-8 byte count", async () => {
      const workspaceDir = tempDirs.make("oc-path-cli-");
      const filePath = join(workspaceDir, "gateway.jsonc");
      const before = '{ "version": "1.0" }';
      writeFileSync(filePath, before, "utf-8");
      const rt = createTestRuntime();
      await pathSetCommand(
        "oc://gateway.jsonc/version",
        "中文",
        { cwd: workspaceDir, human: true, dryRun: true },
        rt,
      );

      const [header, ...bodyLines] = stdoutText(rt).split("\n");
      const body = bodyLines.join("\n");
      expect(header).toBe(
        `--dry-run: would write ${Buffer.byteLength(body, "utf8")} bytes to ${filePath}`,
      );
      expect(readFileSync(filePath, "utf-8")).toBe(before);
    });

    it.runIf(process.platform !== "win32").each([
      { label: "LF", before: '{ "version": "1.0" }\n', json: false },
      { label: "CRLF", before: '{ "version": "1.0" }\r\n', json: true },
      { label: "no final newline", before: '{ "version": "1.0" }', json: true },
      {
        label: "middle-of-file",
        before: `{\n${"  // leading context\n".repeat(5)}  "version": "1.0"\n${"  // trailing context\n".repeat(5)}}\n`,
        json: true,
      },
    ])("emits an applicable $label dry-run patch", async ({ before, json }) => {
      const workspaceDir = tempDirs.make("oc-path-cli-");
      const filePath = join(workspaceDir, "gateway.jsonc");
      const patchPath = join(workspaceDir, "preview.patch");
      const after = before.replace('"1.0"', '"2.0"');
      writeFileSync(filePath, before, "utf-8");
      const rt = createTestRuntime();
      await pathSetCommand(
        "oc://gateway.jsonc/version",
        "2.0",
        { cwd: workspaceDir, human: !json, json, dryRun: true, diff: true },
        rt,
      );

      expect(rt.exitCode).toBe(0);
      const output = stdoutText(rt);
      const payload = json ? JSON.parse(output) : undefined;
      const patch = json ? payload.diff : output;
      if (json) {
        expect(payload.bytes).toBe(after);
      }
      writeFileSync(patchPath, patch, "utf-8");
      expect(readFileSync(filePath, "utf-8")).toBe(before);
      execFileSync(
        "git",
        ["apply", "--check", `-p${filePath.split("/").filter(Boolean).length}`, patchPath],
        {
          cwd: workspaceDir,
        },
      );
      execFileSync("patch", ["--dry-run", "--fuzz=0", filePath, patchPath]);
      expect(readFileSync(filePath, "utf-8")).toBe(before);
      execFileSync("patch", ["--fuzz=0", filePath, patchPath]);
      expect(readFileSync(filePath, "utf-8")).toBe(after);
    });

    it("CLI-S05c --dry-run --diff shows line-ending-only byte changes", async () => {
      const workspaceDir = tempDirs.make("oc-path-cli-");
      const filePath = join(workspaceDir, "AGENTS.md");
      const before = "---\r\nname: x\r\n---\r\n";
      writeFileSync(filePath, before, "utf-8");
      const rt = createTestRuntime();
      await pathSetCommand(
        "oc://AGENTS.md/[frontmatter]/name",
        "x",
        { cwd: workspaceDir, json: true, dryRun: true, diff: true },
        rt,
      );
      expect(rt.exitCode).toBe(0);
      const out = JSON.parse(stdoutText(rt));
      expect(out.diff).toContain("-name: x\r");
      expect(out.diff).toContain("+name: x");
      expect(readFileSync(filePath, "utf-8")).toBe(before);
    });

    it("CLI-S06 --dry-run --diff includes diff in JSON output", async () => {
      const workspaceDir = tempDirs.make("oc-path-cli-");
      const filePath = join(workspaceDir, "gateway.jsonc");
      writeFileSync(filePath, '{ "version": "1.0" }', "utf-8");
      const rt = createTestRuntime();
      await pathSetCommand(
        "oc://gateway.jsonc/version",
        "2.0",
        { cwd: workspaceDir, json: true, dryRun: true, diff: true },
        rt,
      );
      expect(rt.exitCode).toBe(0);
      const out = JSON.parse(stdoutText(rt));
      expect(out.dryRun).toBe(true);
      expect(out.bytes).toContain('"2.0"');
      expect(out.diff).toContain('-{ "version": "1.0" }');
      expect(out.diff).toContain('+{ "version": "2.0" }');
    });

    it("CLI-S07 rejects --diff without --dry-run", async () => {
      const workspaceDir = tempDirs.make("oc-path-cli-");
      const filePath = join(workspaceDir, "gateway.jsonc");
      const before = '{ "version": "1.0" }';
      writeFileSync(filePath, before, "utf-8");
      const rt = createTestRuntime();
      await pathSetCommand(
        "oc://gateway.jsonc/version",
        "2.0",
        { cwd: workspaceDir, json: true, diff: true },
        rt,
      );
      expect(rt.exitCode).toBe(1);
      expect(JSON.parse(stdoutText(rt))).toMatchObject({
        ok: false,
        reason: "--diff requires --dry-run",
      });
      expect(readFileSync(filePath, "utf-8")).toBe(before);
    });

    it("CLI-S08 sets slash-deep JSONC paths and parsed JSON values", async () => {
      const workspaceDir = tempDirs.make("oc-path-cli-");
      const filePath = join(workspaceDir, "openclaw.json");
      writeFileSync(
        filePath,
        '{ "agents": { "list": [{ "tools": { "exec": { "security": "deny" } } }] }, "gateway": { "auth": { "token": "${TOKEN}" } } }\n',
        "utf-8",
      );
      const rt = createTestRuntime();

      await pathSetCommand(
        "oc://openclaw.json/gateway/auth/token",
        '{"source":"file","provider":"secrets","id":"/test"}',
        { cwd: workspaceDir, json: true, valueJson: true },
        rt,
      );

      expect(rt.exitCode).toBe(0);
      expect(JSON.parse(readFileSync(filePath, "utf8")).gateway.auth.token).toEqual({
        source: "file",
        provider: "secrets",
        id: "/test",
      });

      const rt2 = createTestRuntime();
      await pathSetCommand(
        "oc://openclaw.json/agents/list/0/tools/exec/security",
        "allowlist",
        { cwd: workspaceDir, json: true },
        rt2,
      );

      expect(rt2.exitCode).toBe(0);
      expect(JSON.parse(readFileSync(filePath, "utf8")).agents.list[0].tools.exec.security).toBe(
        "allowlist",
      );
    });

    it("CLI-S03 sentinel-bearing value is refused at emit", async () => {
      const workspaceDir = tempDirs.make("oc-path-cli-");
      const filePath = join(workspaceDir, "gateway.jsonc");
      writeFileSync(filePath, '{ "token": "x" }', "utf-8");
      const rt = createTestRuntime();
      // Sentinel values can enter the AST, but emit must reject them through
      // the structured CLI error boundary instead of escaping Commander.
      await pathSetCommand(
        "oc://gateway.jsonc/token",
        "__OPENCLAW_REDACTED__",
        { cwd: workspaceDir, json: true },
        rt,
      );
      expect(rt.exitCode).toBe(1);
      expect(stderrText(rt)).toContain("OC_EMIT_SENTINEL");
      // Include the actual file in the sentinel error so operators can locate it.
      expect(stderrText(rt)).toContain("gateway.jsonc");
    });

    it("CLI-S04 missing args are rejected by Commander", async () => {
      const rt = createTestRuntime();
      await pathSetCommand(undefined, undefined, { json: true }, rt);
      expect(rt.exitCode).toBe(1);
      expect(stderrText(rt)).toContain("missing required argument");
    });

    it("CLI-S05 malformed yaml returns structured parse-error", async () => {
      const workspaceDir = tempDirs.make("oc-path-cli-");
      const filePath = join(workspaceDir, "workflow.yaml");
      const before = "key: value\n  bad indent: oops\n";
      writeFileSync(filePath, before, "utf-8");
      const rt = createTestRuntime();
      await pathSetCommand(
        "oc://workflow.yaml/key",
        "new-value",
        { cwd: workspaceDir, json: true },
        rt,
      );
      expect(rt.exitCode).toBe(1);
      const out = JSON.parse(stdoutText(rt));
      expect(out).toMatchObject({ ok: false, reason: "parse-error" });
      expect(readFileSync(filePath, "utf-8")).toBe(before);
    });
  });

  describe("find", () => {
    it("CLI-F01 enumerates wildcard matches", async () => {
      const workspaceDir = tempDirs.make("oc-path-cli-");
      const filePath = join(workspaceDir, "config.jsonc");
      writeFileSync(filePath, '{ "items": [ { "id": "a" }, { "id": "b" } ] }', "utf-8");
      const rt = createTestRuntime();
      await pathFindCommand("oc://config.jsonc/items/*/id", { cwd: workspaceDir, json: true }, rt);
      expect(rt.exitCode).toBe(0);
      const out = JSON.parse(stdoutText(rt));
      expect(out.count).toBe(2);
    });

    it("CLI-F02 returns 1 when zero matches", async () => {
      const workspaceDir = tempDirs.make("oc-path-cli-");
      const filePath = join(workspaceDir, "gateway.jsonc");
      writeFileSync(filePath, "{}", "utf-8");
      const rt = createTestRuntime();
      await pathFindCommand("oc://gateway.jsonc/nope/*", { cwd: workspaceDir, json: true }, rt);
      expect(rt.exitCode).toBe(1);
    });

    it("CLI-F03 file-slot wildcard rejected with clear error (no ENOENT)", async () => {
      const workspaceDir = tempDirs.make("oc-path-cli-");
      // File-slot wildcards must fail clearly before filesystem access.
      const rt = createTestRuntime();
      await pathFindCommand("oc://*.jsonc/items", { cwd: workspaceDir, json: true }, rt);
      expect(rt.exitCode).toBe(2);
      expect(stderrText(rt)).toContain("OC_PATH_FILE_WILDCARD_UNSUPPORTED");
      expect(stderrText(rt)).toContain("file-slot wildcards are not supported");
    });
  });

  describe("emit", () => {
    it("CLI-E01 round-trips jsonc bytes verbatim (byte-fidelity proof)", async () => {
      const workspaceDir = tempDirs.make("oc-path-cli-");
      const filePath = join(workspaceDir, "gateway.jsonc");
      const before = '// keep this comment\n{\n  "v": 1\n}\n';
      writeFileSync(filePath, before, "utf-8");
      const rt = createTestRuntime();
      await pathEmitCommand(filePath, { json: true }, rt);
      expect(rt.exitCode).toBe(0);
      const out = JSON.parse(stdoutText(rt));
      expect(out.kind).toBe("jsonc");
      expect(out.bytes).toBe(before);
    });

    it("CLI-E02 round-trips md verbatim", async () => {
      const workspaceDir = tempDirs.make("oc-path-cli-");
      const filePath = join(workspaceDir, "AGENTS.md");
      const before = "## Tools\n- gh\n## Boundaries\n- never rm -rf\n";
      writeFileSync(filePath, before, "utf-8");
      const rt = createTestRuntime();
      await pathEmitCommand(filePath, { json: true }, rt);
      expect(rt.exitCode).toBe(0);
      const out = JSON.parse(stdoutText(rt));
      expect(out.kind).toBe("md");
      expect(out.bytes).toBe(before);
    });

    it("CLI-E04 round-trips yaml verbatim", async () => {
      const workspaceDir = tempDirs.make("oc-path-cli-");
      const filePath = join(workspaceDir, "workflow.yaml");
      const before = "# keep comment\nname: inbox-triage\nsteps:\n  - id: fetch\n";
      writeFileSync(filePath, before, "utf-8");
      const rt = createTestRuntime();
      await pathEmitCommand(filePath, { json: true }, rt);
      expect(rt.exitCode).toBe(0);
      const out = JSON.parse(stdoutText(rt));
      expect(out.kind).toBe("yaml");
      expect(out.bytes).toBe(before);
    });

    it("CLI-S07b reports accurate UTF-8 byte counts for multibyte set output", async () => {
      const workspaceDir = tempDirs.make("oc-path-cli-");
      const filePath = join(workspaceDir, "gateway.jsonc");
      const before = '{\n  "version": "1.0"\n}\n';
      writeFileSync(filePath, before, "utf-8");
      // Replace the whole file with CJK content via the version key.
      // CJK chars are 1 UTF-16 unit but 3 UTF-8 bytes.
      const cjkValue = "中".repeat(30);
      const rt = createTestRuntime();
      await pathSetCommand(
        "oc://gateway.jsonc/version",
        cjkValue,
        { cwd: workspaceDir, json: true },
        rt,
      );
      expect(rt.exitCode).toBe(0);
      const out = JSON.parse(stdoutText(rt));
      // bytesWritten must match the file's actual UTF-8 byte size on disk
      const onDisk = readFileSync(filePath, "utf-8");
      expect(out.bytesWritten).toBe(Buffer.byteLength(onDisk, "utf8"));
      // bytesWritten exceeds JS string length (50 UTF-16 units < ~110 UTF-8 bytes)
      expect(out.bytesWritten).toBeGreaterThan(onDisk.length);
    });

    it("CLI-E03 emit --cwd resolves <file> against the supplied directory", async () => {
      // A relative file must resolve against --cwd, not the process directory.
      const workspaceDir = tempDirs.make("oc-path-cli-");
      const filePath = join(workspaceDir, "AGENTS.md");
      writeFileSync(filePath, "## Tools\n- gh\n", "utf-8");
      const rt = createTestRuntime();
      await pathEmitCommand("AGENTS.md", { cwd: workspaceDir, json: true }, rt);
      expect(rt.exitCode).toBe(0);
      const out = JSON.parse(stdoutText(rt));
      expect(out.kind).toBe("md");
      expect(out.bytes).toBe("## Tools\n- gh\n");
    });
  });
});
