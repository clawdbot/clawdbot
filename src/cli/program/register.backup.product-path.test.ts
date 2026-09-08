import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";

function runBackupCli(params: {
  env: NodeJS.ProcessEnv;
  outputPath: string;
  preloadPath: string;
}): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        "--import",
        params.preloadPath,
        "--import",
        "tsx",
        path.resolve("src/entry.ts"),
        "backup",
        "create",
        "--output",
        params.outputPath,
        "--no-include-workspace",
        "--verify",
        "--json",
      ],
      {
        env: params.env,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
}

describe("backup create CLI", () => {
  it("completes when the SQLite snapshot outlives the audit lease", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "backup-cli-audit-lease-", scenario: "minimal" },
      async (state) => {
        await state.writeConfig({ gateway: { mode: "local" } });
        await state.writeText(
          "logs/config-audit.jsonl",
          `${JSON.stringify({
            ts: "2026-09-03T00:00:00.000Z",
            source: "config-io",
            event: "config.write",
            argv: ["openclaw", "config", "set", "proof", "lease"],
            execArgv: [],
          })}\n`,
        );
        const markerPath = state.path("sqlite-backup-entered");
        const preloadPath = await state.writeText(
          "shift-clock-at-sqlite-backup.mjs",
          `
            import fs from "node:fs";
            import { syncBuiltinESMExports } from "node:module";
            const sqlite = process.getBuiltinModule("node:sqlite");
            const originalBackup = sqlite.backup.bind(sqlite);
            let shifted = false;
            sqlite.backup = async (...args) => {
              if (!shifted) {
                shifted = true;
                fs.writeFileSync(process.env.PROOF_SNAPSHOT_MARKER, "entered\\n", { mode: 0o600 });
                const realNow = Date.now.bind(Date);
                Date.now = () => realNow() + 61_000;
              }
              return await originalBackup(...args);
            };
            syncBuiltinESMExports();
          `,
        );
        const outputPath = state.path("backup.tar.gz");

        const result = await runBackupCli({
          env: {
            ...process.env,
            ...state.env,
            OPENCLAW_TEST_CONSOLE: "1",
            PROOF_SNAPSHOT_MARKER: markerPath,
          },
          outputPath,
          preloadPath,
        });

        expect(result.code, result.stderr).toBe(0);
        expect(await fs.readFile(markerPath, "utf8")).toBe("entered\n");
        expect((await fs.stat(outputPath)).size).toBeGreaterThan(0);
      },
    );
  });
});
