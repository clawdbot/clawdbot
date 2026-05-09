/**
 * Smoke tests for the `openclaw path` CLI handlers.
 *
 * Tests invoke each subcommand handler directly with a capturing
 * `OutputRuntimeEnv` — no commander wiring, no child process spawn.
 * Assertions inspect captured stdout/stderr and the exit code the
 * handler set on the runtime.
 */
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type OutputRuntimeEnv,
  pathEmitCommand,
  pathFindCommand,
  pathResolveCommand,
  pathSetCommand,
  pathValidateCommand,
} from "./cli.js";

interface TestRuntime extends OutputRuntimeEnv {
  readonly stdout: string[];
  readonly stderr: string[];
  exitCode: number;
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

const stdoutText = (rt: TestRuntime): string => rt.stdout.join("\n");
const stderrText = (rt: TestRuntime): string => rt.stderr.join("\n");

describe("openclaw path CLI", () => {
  let workspaceDir: string;

  beforeEach(() => {
    workspaceDir = mkdtempSync(join(tmpdir(), "oc-path-cli-"));
  });
  afterEach(() => {
    // mkdtemp leaves a small dir; OS will GC it. Skip cleanup to keep
    // the test deterministic on Windows where rmdir flakes.
  });

  describe("validate", () => {
    it("CLI-V01 accepts a well-formed path with --json", () => {
      const rt = createTestRuntime();
      pathValidateCommand("oc://AGENTS.md/Tools/-1", { json: true }, rt);
      expect(rt.exitCode).toBe(0);
      const out = JSON.parse(stdoutText(rt));
      expect(out.valid).toBe(true);
      expect(out.structure.file).toBe("AGENTS.md");
      expect(out.structure.section).toBe("Tools");
    });

    it("CLI-V02 rejects a malformed path with code 1", () => {
      const rt = createTestRuntime();
      pathValidateCommand("oc://X/a\x00b", { json: true }, rt);
      expect(rt.exitCode).toBe(1);
      const out = JSON.parse(stdoutText(rt));
      expect(out.valid).toBe(false);
    });

    it("CLI-V03 missing argument returns 2", () => {
      const rt = createTestRuntime();
      pathValidateCommand(undefined, { json: true }, rt);
      expect(rt.exitCode).toBe(2);
      expect(stderrText(rt)).toContain("missing");
    });
  });

  describe("resolve", () => {
    it("CLI-R01 finds a leaf in jsonc and prints it", async () => {
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

    it("CLI-R02 returns 1 for not-found path", async () => {
      const filePath = join(workspaceDir, "gateway.jsonc");
      writeFileSync(filePath, '{ "version": "1.0" }', "utf-8");
      const rt = createTestRuntime();
      await pathResolveCommand("oc://gateway.jsonc/missing", { cwd: workspaceDir, json: true }, rt);
      expect(rt.exitCode).toBe(1);
      const out = JSON.parse(stdoutText(rt));
      expect(out.resolved).toBe(false);
    });

    it("CLI-R03 missing argument returns 2", async () => {
      const rt = createTestRuntime();
      await pathResolveCommand(undefined, { json: true }, rt);
      expect(rt.exitCode).toBe(2);
      expect(stderrText(rt)).toContain("missing");
    });
  });

  describe("set", () => {
    it("CLI-S01 writes new bytes when path resolves", async () => {
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

    it("CLI-S03 sentinel-bearing value is refused at emit", async () => {
      const filePath = join(workspaceDir, "gateway.jsonc");
      writeFileSync(filePath, '{ "token": "x" }', "utf-8");
      const rt = createTestRuntime();
      // The sentinel-bearing value is accepted into the AST by setOcPath,
      // but `emitForKind` refuses to serialize it (defense-in-depth at
      // the per-kind emit boundary). The CLI handler must catch that
      // refusal and route it through the structured error boundary —
      // a thrown error escaping commander would print raw `String(err)`
      // and bypass our JSON/human scrubbing. Pin the structured shape:
      // exit code 1, stable code OC_EMIT_SENTINEL, message scrubbed.
      await pathSetCommand(
        "oc://gateway.jsonc/token",
        "__OPENCLAW_REDACTED__",
        { cwd: workspaceDir, json: true },
        rt,
      );
      expect(rt.exitCode).toBe(1);
      expect(stderrText(rt)).toContain("OC_EMIT_SENTINEL");
      // F13 — file context in sentinel error. Without fileNameForGuard
      // plumbing through emitForKind, the message would carry the
      // empty-slot fallback (`oc:///[raw]`); now it carries the actual
      // file (`oc://gateway.jsonc/[raw]`). Forensics + audit pipelines
      // rely on this — without the file context, "sentinel rejected
      // somewhere" doesn't tell you WHICH file was involved.
      expect(stderrText(rt)).toContain("gateway.jsonc");
    });

    it("CLI-S04 missing args returns 2", async () => {
      const rt = createTestRuntime();
      await pathSetCommand(undefined, undefined, { json: true }, rt);
      expect(rt.exitCode).toBe(2);
      expect(stderrText(rt)).toContain("requires");
    });
  });

  describe("find", () => {
    it("CLI-F01 enumerates wildcard matches", async () => {
      const filePath = join(workspaceDir, "config.jsonc");
      writeFileSync(filePath, '{ "items": [ { "id": "a" }, { "id": "b" } ] }', "utf-8");
      const rt = createTestRuntime();
      await pathFindCommand("oc://config.jsonc/items/*/id", { cwd: workspaceDir, json: true }, rt);
      expect(rt.exitCode).toBe(0);
      const out = JSON.parse(stdoutText(rt));
      expect(out.count).toBe(2);
    });

    it("CLI-F02 returns 1 when zero matches", async () => {
      const filePath = join(workspaceDir, "gateway.jsonc");
      writeFileSync(filePath, "{}", "utf-8");
      const rt = createTestRuntime();
      await pathFindCommand("oc://gateway.jsonc/nope/*", { cwd: workspaceDir, json: true }, rt);
      expect(rt.exitCode).toBe(1);
    });

    it("CLI-F03 file-slot wildcard rejected with clear error (no ENOENT)", async () => {
      // Closes Galin P3 (round 8): `find` resolves `pattern.file` to one
      // literal path, so `oc://*.jsonc/...` would silently ENOENT during
      // fs.readFile. The CLI now surfaces a clear error before touching
      // the filesystem, with stable code OC_PATH_FILE_WILDCARD_UNSUPPORTED.
      const rt = createTestRuntime();
      await pathFindCommand("oc://*.jsonc/items", { cwd: workspaceDir, json: true }, rt);
      expect(rt.exitCode).toBe(2);
      expect(stderrText(rt)).toContain("OC_PATH_FILE_WILDCARD_UNSUPPORTED");
      expect(stderrText(rt)).toContain("file-slot wildcards are not supported");
    });
  });

  describe("emit", () => {
    it("CLI-E01 round-trips jsonc bytes verbatim (byte-fidelity proof)", async () => {
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

    it("CLI-E03 emit --cwd resolves <file> against the supplied directory", async () => {
      // Closes round-10 finding F2: emit advertises --cwd / --file in
      // the docs but the handler resolved <file> against process.cwd()
      // ignoring both. Pin the new wiring: a relative <file> resolves
      // against --cwd, not against process.cwd().
      const filePath = join(workspaceDir, "AGENTS.md");
      writeFileSync(filePath, "## Tools\n- gh\n", "utf-8");
      const rt = createTestRuntime();
      // Pass a RELATIVE filename + explicit --cwd. If the handler
      // ignored --cwd, loadAst would ENOENT against process.cwd().
      await pathEmitCommand("AGENTS.md", { cwd: workspaceDir, json: true }, rt);
      expect(rt.exitCode).toBe(0);
      const out = JSON.parse(stdoutText(rt));
      expect(out.kind).toBe("md");
      expect(out.bytes).toBe("## Tools\n- gh\n");
    });
  });
});
