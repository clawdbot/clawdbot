import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

type Outcome = "failure" | "finding" | "success";

describe("deadcode command reporting", () => {
  it.each<{
    wrapper: "exports" | "unused-files";
    outcomes: Outcome[];
  }>([
    { wrapper: "exports", outcomes: ["failure", "finding", "success"] },
    { wrapper: "unused-files", outcomes: ["failure", "finding"] },
    { wrapper: "unused-files", outcomes: ["failure", "success"] },
    { wrapper: "exports", outcomes: ["success", "success", "failure"] },
    { wrapper: "unused-files", outcomes: ["success", "finding"] },
    { wrapper: "exports", outcomes: ["success", "success", "success"] },
    { wrapper: "unused-files", outcomes: ["success", "success"] },
  ])("reports every $wrapper outcome: $outcomes", ({ wrapper, outcomes }) => {
    const root = mkdtempSync(path.join(os.tmpdir(), "openclaw-deadcode-reporting-"));
    const pnpm = path.join(root, "pnpm.cjs");
    const scopes = ["production", "full-tree", "script"].slice(0, outcomes.length);
    const configs = [
      "config/knip.config.ts",
      "config/knip.all-exports.config.ts",
      "config/knip.scripts-exports.config.ts",
    ].slice(0, outcomes.length);
    const kind = wrapper === "exports" ? "unused-export" : "unused-file";

    try {
      // Synthetic Knip output only: keep the real CLI, launcher and child processes.
      // No child completes until all scopes start, so serial launch fails the barrier.
      writeFileSync(
        pnpm,
        `
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const configs = ${JSON.stringify(configs)};
const outcomes = ${JSON.stringify(outcomes)};
const index = configs.indexOf(args[args.indexOf("--config") + 1]);
if (index < 0) throw new Error("Unexpected scan config");
const marker = (i, phase) => path.join(__dirname, i + "." + phase);
fs.writeFileSync(marker(index, "started"), JSON.stringify(args));
const deadline = setTimeout(() => {
  console.error("Fixture concurrency barrier timed out");
  process.exit(3);
}, 5000);
const barrier = setInterval(() => {
  if (!configs.every((_, i) => fs.existsSync(marker(i, "started")))) return;
  if (index > 0 && !fs.existsSync(marker(index - 1, "completed"))) return;
  clearInterval(barrier);
  clearTimeout(deadline);
  const outcome = outcomes[index];
  if (outcome === "failure") {
    console.error("SYNTHETIC_SCAN_FAILURE_" + index);
    process.exitCode = 2;
  } else if (outcome === "finding") {
    console.log(args.includes("--files")
      ? "Unused files (1)\\nsrc/diagnostic-fixture.ts: src/diagnostic-fixture.ts"
      : "Unused exports (1)\\nsrc/diagnostic-fixture.ts: syntheticFinding");
    process.exitCode = 1;
  }
  fs.writeFileSync(marker(index, "completed"), outcome);
}, 5);
`,
      );
      const result = spawnSync(
        process.execPath,
        ["--import", "./scripts/tsx.mjs", `scripts/check-deadcode-${wrapper}.mts`],
        {
          cwd: process.cwd(),
          env: { ...process.env, npm_execpath: pnpm },
          encoding: "utf8",
          timeout: 15_000,
        },
      );
      const output = result.stdout + result.stderr;
      expect(result.error, output).toBeUndefined();
      expect(result.signal, output).toBeNull();
      expect(result.status, output).toBe(
        outcomes.every((outcome) => outcome === "success") ? 0 : 1,
      );

      for (const [index, outcome] of outcomes.entries()) {
        expect(readFileSync(path.join(root, `${index}.completed`), "utf8")).toBe(outcome);
        const scanArgs = ["--config", configs[index]];
        if (index === 0) {
          scanArgs.push("--production");
        }
        if (index === 2) {
          scanArgs.push("--include-entry-exports");
        }
        expect(JSON.parse(readFileSync(path.join(root, `${index}.started`), "utf8"))).toEqual([
          "dlx",
          "--package",
          "knip@6.32.2",
          "knip",
          ...scanArgs,
          "--no-progress",
          "--reporter",
          "compact",
          ...(wrapper === "exports"
            ? ["--include", "exports,nsExports,types,nsTypes,enumMembers,namespaceMembers"]
            : ["--files"]),
          "--no-config-hints",
        ]);
        const scanName = `${scopes[index]} ${kind} scan`;
        expect(
          output.split("\n").filter((line) => line.includes(scanName)),
          output,
        ).toHaveLength(1);
        if (outcome === "success") {
          expect(result.stdout).toContain(`[deadcode] Knip ${scanName} passed with 0 entries.`);
        } else {
          expect(result.stdout).not.toContain(scanName);
          expect(result.stderr).toContain(
            outcome === "failure" ? `SYNTHETIC_SCAN_FAILURE_${index}` : "src/diagnostic-fixture.ts",
          );
        }
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
