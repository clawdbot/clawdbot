import path from "node:path";
import { describe, expect, it } from "vitest";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { withTestDir } from "../test-helpers/temp-dir.js";
import { applyAllowAlwaysDecision } from "./exec-approvals-allow-always.js";
import type { ExecApprovalsFile } from "./exec-approvals-core.js";
import {
  countObsoleteGeneratedExecApprovals,
  repairObsoleteGeneratedExecApprovals,
} from "./exec-approvals-generated-migration.js";
import { loadExecApprovalsReadOnly, saveExecApprovals } from "./exec-approvals-store.js";
import { testing as execApprovalsStoreTesting } from "./exec-approvals-store.test-support.js";
import { buildCwdBoundHashedArgPattern } from "./exec-command-resolution.js";

describe("generated exec approval migration", () => {
  it("reapproval replaces obsolete grants for the same executable", () => {
    const current = buildCwdBoundHashedArgPattern(["/usr/bin/git", "status"], "/workspace");
    const updated = applyAllowAlwaysDecision({
      file: {
        version: 1,
        agents: {
          main: {
            allowlist: [
              {
                pattern: "/usr/bin/git",
                source: "allow-always",
                argPattern: "sha256:argv:obsolete",
              },
              { pattern: "/usr/bin/curl", source: "allow-always" },
            ],
          },
        },
      },
      agentId: "main",
      decision: {
        kind: "patterns",
        patterns: [{ pattern: "/usr/bin/git", argPattern: current }],
      },
    });

    expect(updated?.agents?.main?.allowlist).toEqual([
      { pattern: "/usr/bin/curl", source: "allow-always" },
      expect.objectContaining({
        pattern: "/usr/bin/git",
        source: "allow-always",
        argPattern: current,
      }),
    ]);
  });

  it("removes inactive generated grants without changing manual or cwd-bound rules", async () => {
    await withTestDir({ prefix: "openclaw-exec-approval-migration-" }, async (home) => {
      const previousStateDir = process.env.OPENCLAW_STATE_DIR;
      process.env.OPENCLAW_STATE_DIR = path.join(home, ".openclaw");
      closeOpenClawStateDatabaseForTest();
      execApprovalsStoreTesting.reset();
      try {
        const current = buildCwdBoundHashedArgPattern(["/usr/bin/git", "status"], "/workspace");
        const file: ExecApprovalsFile = {
          version: 1,
          agents: {
            main: {
              allowlist: [
                { pattern: "/usr/bin/git", source: "allow-always" },
                {
                  pattern: "/usr/bin/curl",
                  source: "allow-always",
                  argPattern: "sha256:argv:obsolete",
                },
                {
                  pattern: "C:\\Tools\\rg.exe",
                  source: "allow-always",
                  argPattern: "^--json\0$",
                },
                { pattern: "/usr/bin/git", source: "allow-always", argPattern: current },
                { pattern: "/usr/bin/python3", argPattern: "^script\\.py$" },
                { pattern: "=node-command:marker", source: "allow-always" },
              ],
            },
          },
        };
        saveExecApprovals(file);

        expect(countObsoleteGeneratedExecApprovals(loadExecApprovalsReadOnly())).toBe(3);
        expect(repairObsoleteGeneratedExecApprovals()).toBe(3);
        expect(loadExecApprovalsReadOnly().agents?.main?.allowlist).toEqual([
          expect.objectContaining({
            pattern: "/usr/bin/git",
            source: "allow-always",
            argPattern: current,
          }),
          expect.objectContaining({ pattern: "/usr/bin/python3", argPattern: "^script\\.py$" }),
          expect.objectContaining({ pattern: "=node-command:marker", source: "allow-always" }),
        ]);
      } finally {
        closeOpenClawStateDatabaseForTest();
        execApprovalsStoreTesting.reset();
        if (previousStateDir === undefined) {
          delete process.env.OPENCLAW_STATE_DIR;
        } else {
          process.env.OPENCLAW_STATE_DIR = previousStateDir;
        }
      }
    });
  });
});
