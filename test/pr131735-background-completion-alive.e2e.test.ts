// Boundary-level proof for the detached subagent completion boundary
// (pr131735): a rejection escaping the boundary must land in the injected
// warn instead of the gateway's process-level fatal unhandled-rejection exit.
// The proof child installs the real gateway fatal handler, so a regression
// kills the child before its verdict is printed.
import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PROOF_SCRIPT = path.join(
  REPO_ROOT,
  "test/helpers/pr131735-background-completion-alive-proof.ts",
);
const PROOF_TIMEOUT_MS = 120_000;

type ProofVerdict = {
  warningMessages: string[];
  escapedRejectionLogged: boolean;
  processAliveAfterRejection: boolean;
};

describe("subagent background completion boundary proof", () => {
  it(
    "keeps the process alive and logs the background warning when a completion escapes",
    async () => {
      let stdout: string;
      let stderr: string;
      let exitCode: number;
      try {
        const result = await execFileAsync(
          process.execPath,
          ["--import", path.join(REPO_ROOT, "scripts/tsx.mjs"), PROOF_SCRIPT],
          { timeout: PROOF_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 },
        );
        stdout = result.stdout;
        stderr = result.stderr;
        exitCode = 0;
      } catch (error) {
        const failure = error as { code?: number | string; stdout?: string; stderr?: string };
        exitCode = typeof failure.code === "number" ? failure.code : -1;
        stdout = failure.stdout ?? "";
        stderr = failure.stderr ?? "";
      }

      const verdictLine = stdout.split("\n").find((line) => line.startsWith("PROOF_VERDICT "));
      expect(verdictLine, `proof child exited ${exitCode}\n${stderr}`).toBeDefined();
      const verdict = JSON.parse(verdictLine!.slice("PROOF_VERDICT ".length)) as ProofVerdict;

      // Pre-fix, the escaped rejection reached the fatal handler and the child
      // exited before printing a verdict at all.
      expect(exitCode).toBe(0);
      expect(verdict.escapedRejectionLogged).toBe(true);
      expect(verdict.processAliveAfterRejection).toBe(true);
    },
    PROOF_TIMEOUT_MS,
  );
});
