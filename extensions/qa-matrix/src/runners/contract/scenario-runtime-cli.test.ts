import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { resolvePreferredOpenClawTmpDir } from "openclaw/plugin-sdk/temp-path";
import { describe, expect, it } from "vitest";
import {
  formatMatrixQaCliCommand,
  redactMatrixQaCliOutput,
  resolveMatrixQaOpenClawCliEntryPath,
  runMatrixQaOpenClawCli,
  startMatrixQaOpenClawCli,
} from "./scenario-runtime-cli.js";

describe("Matrix QA CLI runtime", () => {
  it("redacts secret CLI arguments in diagnostic command text", () => {
    expect(
      formatMatrixQaCliCommand([
        "matrix",
        "verify",
        "backup",
        "restore",
        "--recovery-key",
        "abcdef1234567890ghij",
      ]),
    ).toBe("openclaw matrix verify backup restore --recovery-key [REDACTED]");
    expect(formatMatrixQaCliCommand(["matrix", "account", "add", "--access-token=token-123"])).toBe(
      "openclaw matrix account add --access-token=[REDACTED]",
    );
    expect(
      formatMatrixQaCliCommand(["matrix", "verify", "device", "abcdef1234567890ghij", "--json"]),
    ).toBe("openclaw matrix verify device [REDACTED] --json");
  });

  it("redacts Matrix token output before diagnostics and artifacts", () => {
    expect(
      redactMatrixQaCliOutput("GET /_matrix/client/v3/sync?access_token=abcdef1234567890ghij"),
    ).toBe("GET /_matrix/client/v3/sync?access_token=abcdef…ghij");
  });

  it("prefers the ESM OpenClaw CLI entrypoint when present", async () => {
    const root = await mkdtemp(path.join(resolvePreferredOpenClawTmpDir(), "matrix-qa-cli-entry-"));
    try {
      await mkdir(path.join(root, "dist"));
      await writeFile(path.join(root, "dist", "index.mjs"), "");
      expect(resolveMatrixQaOpenClawCliEntryPath(root)).toBe(path.join(root, "dist", "index.mjs"));
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("can preserve expected non-zero CLI output for negative scenarios", async () => {
    const root = await mkdtemp(
      path.join(resolvePreferredOpenClawTmpDir(), "matrix-qa-cli-nonzero-"),
    );
    try {
      await mkdir(path.join(root, "dist"));
      await writeFile(
        path.join(root, "dist", "index.mjs"),
        [
          "process.stdout.write(JSON.stringify({ success: false, error: 'expected failure' }));",
          "process.exit(7);",
        ].join("\n"),
      );
      const result = await runMatrixQaOpenClawCli({
        allowNonZero: true,
        args: ["matrix", "verify", "backup", "restore", "--json"],
        cwd: root,
        env: process.env,
        timeoutMs: 5_000,
      });
      expect(result.exitCode).toBe(7);
      expect(result.stdout).toContain('"success":false');
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("can pass stdin to CLI commands", async () => {
    const root = await mkdtemp(path.join(resolvePreferredOpenClawTmpDir(), "matrix-qa-cli-stdin-"));
    try {
      await mkdir(path.join(root, "dist"));
      await writeFile(
        path.join(root, "dist", "index.mjs"),
        [
          "let input = '';",
          "process.stdin.setEncoding('utf8');",
          "process.stdin.on('data', (chunk) => { input += chunk; });",
          "process.stdin.on('end', () => {",
          "  process.stdout.write(JSON.stringify({ input: input.trim() }));",
          "});",
        ].join("\n"),
      );
      const result = await runMatrixQaOpenClawCli({
        args: ["matrix", "verify", "backup", "restore", "--recovery-key-stdin", "--json"],
        cwd: root,
        env: process.env,
        stdin: "stdin-recovery-key\n",
        timeoutMs: 5_000,
      });
      expect(result.stdout).toContain('"input":"stdin-recovery-key"');
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("can close stdin after interactive CLI prompts", async () => {
    const root = await mkdtemp(
      path.join(resolvePreferredOpenClawTmpDir(), "matrix-qa-cli-interactive-"),
    );
    try {
      await mkdir(path.join(root, "dist"));
      await writeFile(
        path.join(root, "dist", "index.mjs"),
        [
          "let input = '';",
          "process.stdin.setEncoding('utf8');",
          "process.stdin.on('data', (chunk) => { input += chunk; process.stdout.write('prompt answered\\n'); });",
          "process.stdin.on('end', () => {",
          "  process.stdout.write(JSON.stringify({ input: input.trim(), ended: true }));",
          "});",
        ].join("\n"),
      );
      const session = startMatrixQaOpenClawCli({
        args: ["matrix", "verify", "self"],
        cwd: root,
        env: process.env,
        timeoutMs: 5_000,
      });
      await session.writeStdin("yes\n");
      await session.waitForOutput(
        (output) => output.text.includes("prompt answered"),
        "interactive prompt acknowledgement",
        5_000,
      );
      session.endStdin();
      const result = await session.wait();

      expect(result.stdout).toContain('"input":"yes"');
      expect(result.stdout).toContain('"ended":true');
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("includes timed-out CLI output in diagnostics", async () => {
    const root = await mkdtemp(
      path.join(resolvePreferredOpenClawTmpDir(), "matrix-qa-cli-timeout-"),
    );
    try {
      await mkdir(path.join(root, "dist"));
      await writeFile(
        path.join(root, "dist", "index.mjs"),
        [
          "process.stdout.write('waiting for verification\\n');",
          "process.stderr.write('matrix sdk still syncing\\n');",
          "setInterval(() => {}, 1000);",
        ].join("\n"),
      );

      await expect(
        runMatrixQaOpenClawCli({
          args: ["matrix", "verify", "self"],
          cwd: root,
          env: process.env,
          timeoutMs: 250,
        }),
      ).rejects.toThrow(/stdout:\nwaiting for verification/);
      await expect(
        runMatrixQaOpenClawCli({
          args: ["matrix", "verify", "self"],
          cwd: root,
          env: process.env,
          timeoutMs: 250,
        }),
      ).rejects.toThrow(/stderr:\nmatrix sdk still syncing/);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});
