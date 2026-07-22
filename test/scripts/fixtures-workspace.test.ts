// Fixtures Workspace tests cover shared E2E workspace fixture assertions.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const FIXTURE_SCRIPT = "scripts/e2e/lib/fixture.mjs";

function runAgentsDeleteAssert(root: string, outputPath: string, env: Record<string, string> = {}) {
  return spawnSync(process.execPath, [FIXTURE_SCRIPT, "agents-delete-assert", outputPath], {
    encoding: "utf8",
    env: {
      ...process.env,
      OPENCLAW_STATE_DIR: path.join(root, "state"),
      SHARED_WORKSPACE: path.join(root, "workspace"),
      ...env,
    },
  });
}

describe("workspace fixture assertions", () => {
  it("accepts canonical agent entries after a shared-workspace delete", () => {
    const root = mkdtempSync(path.join(tmpdir(), "openclaw-fixture-workspace-"));
    const stateDir = path.join(root, "state");
    const workspace = path.join(root, "workspace");
    const outputPath = path.join(root, "agents-delete.json");
    try {
      mkdirSync(stateDir, { recursive: true });
      mkdirSync(workspace, { recursive: true });
      writeFileSync(
        path.join(stateDir, "openclaw.json"),
        JSON.stringify({ agents: { entries: { main: { workspace } } } }),
        "utf8",
      );
      writeFileSync(
        outputPath,
        JSON.stringify({
          agentId: "ops",
          workspace,
          workspaceRetained: true,
          workspaceRetainedReason: "shared",
          workspaceSharedWith: ["main"],
        }),
        "utf8",
      );

      const result = runAgentsDeleteAssert(root, outputPath);

      expect(result.status).toBe(0);
      expect(result.stdout).toContain("agents delete shared workspace smoke ok");
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("rejects oversized agents delete output before parsing it", () => {
    const root = mkdtempSync(path.join(tmpdir(), "openclaw-fixture-workspace-"));
    const outputPath = path.join(root, "agents-delete.json");
    try {
      mkdirSync(root, { recursive: true });
      writeFileSync(
        outputPath,
        `DO_NOT_DUMP_OLD_AGENTS_DELETE${"x".repeat(70 * 1024)}\nrecent agents delete tail`,
        "utf8",
      );

      const result = runAgentsDeleteAssert(root, outputPath, {
        OPENCLAW_FIXTURE_AGENTS_DELETE_OUTPUT_MAX_BYTES: "1024",
      });

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("agents delete --json output exceeded 1024 bytes");
      expect(result.stderr).toContain("recent agents delete tail");
      expect(result.stderr).not.toContain("DO_NOT_DUMP_OLD_AGENTS_DELETE");
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("bounds invalid agents delete JSON diagnostics", () => {
    const root = mkdtempSync(path.join(tmpdir(), "openclaw-fixture-workspace-"));
    const outputPath = path.join(root, "agents-delete.json");
    try {
      mkdirSync(root, { recursive: true });
      writeFileSync(
        outputPath,
        `DO_NOT_DUMP_OLD_INVALID_JSON${"x".repeat(70 * 1024)}\nrecent invalid json tail`,
        "utf8",
      );

      const result = runAgentsDeleteAssert(root, outputPath, {
        OPENCLAW_FIXTURE_AGENTS_DELETE_OUTPUT_MAX_BYTES: "131072",
      });

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("agents delete --json did not emit valid JSON");
      expect(result.stderr).toContain("recent invalid json tail");
      expect(result.stderr).not.toContain("DO_NOT_DUMP_OLD_INVALID_JSON");
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });
});
