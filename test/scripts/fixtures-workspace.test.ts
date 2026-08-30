// Fixtures Workspace tests cover shared E2E workspace fixture assertions.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const FIXTURE_SCRIPT = "scripts/e2e/lib/fixture.mjs";
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

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

function runAgentsDeleteConfig(root: string) {
  const stateDir = path.join(root, "state");
  const workspace = path.join(root, "workspace");
  mkdirSync(stateDir, { recursive: true });
  const result = spawnSync(process.execPath, [FIXTURE_SCRIPT, "agents-delete-config"], {
    encoding: "utf8",
    env: { ...process.env, OPENCLAW_STATE_DIR: stateDir, SHARED_WORKSPACE: workspace },
  });
  return { result, stateDir, workspace };
}

function runOpenWebUiWorkspace(workspaceDir: string) {
  return spawnSync(process.execPath, [FIXTURE_SCRIPT, "openwebui-workspace"], {
    encoding: "utf8",
    env: {
      ...process.env,
      OPENCLAW_WORKSPACE_DIR: workspaceDir,
    },
  });
}

describe("workspace fixture assertions", () => {
  it("writes explicit owners for the shared-workspace agents", () => {
    const root = tempDirs.make("openclaw-fixture-workspace-");
    const { result, stateDir, workspace } = runAgentsDeleteConfig(root);

    expect(result.status).toBe(0);
    expect(JSON.parse(readFileSync(path.join(stateDir, "openclaw.json"), "utf8")).agents).toEqual({
      ownership: "explicit",
      defaults: { heartbeat: { agentId: "main" } },
      entries: { main: { workspace }, ops: { workspace } },
    });
  });

  it("prepares Open WebUI without retired workspace setup state", () => {
    const root = tempDirs.make("openclaw-fixture-workspace-");
    const workspaceDir = path.join(root, "workspace");
    const nestedStatePath = path.join(workspaceDir, ".openclaw", "workspace-state.json");
    const rootStatePath = path.join(workspaceDir, "openclaw-workspace-state.json");
    mkdirSync(path.dirname(nestedStatePath), { recursive: true });
    writeFileSync(nestedStatePath, "{}\n");
    writeFileSync(rootStatePath, "{}\n");
    const result = runOpenWebUiWorkspace(workspaceDir);

    expect(result.status).toBe(0);
    expect(readFileSync(path.join(workspaceDir, "IDENTITY.md"), "utf8")).toContain(
      "Open WebUI Docker compatibility smoke test assistant.",
    );
    expect(existsSync(nestedStatePath)).toBe(false);
    expect(existsSync(rootStatePath)).toBe(false);
  });

  it("rejects oversized agents delete output before parsing it", () => {
    const root = tempDirs.make("openclaw-fixture-workspace-");
    const outputPath = path.join(root, "agents-delete.json");
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
  });

  it("bounds invalid agents delete JSON diagnostics", () => {
    const root = tempDirs.make("openclaw-fixture-workspace-");
    const outputPath = path.join(root, "agents-delete.json");
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
  });

  it.each([undefined, "local"])(
    "rejects agents delete output without gateway transport (%s)",
    (transport) => {
      const root = tempDirs.make("openclaw-fixture-workspace-");
      const stateDir = path.join(root, "state");
      const workspace = path.join(root, "workspace");
      const outputPath = path.join(root, "agents-delete.json");
      mkdirSync(stateDir, { recursive: true });
      mkdirSync(workspace, { recursive: true });
      writeFileSync(
        path.join(stateDir, "openclaw.json"),
        `${JSON.stringify({ agents: { entries: { main: { workspace } } } })}\n`,
      );
      writeFileSync(
        outputPath,
        `${JSON.stringify({
          agentId: "ops",
          workspace,
          workspaceRetained: true,
          workspaceRetainedReason: "shared",
          workspaceSharedWith: ["main"],
          ...(transport ? { transport } : {}),
        })}\n`,
      );

      const result = runAgentsDeleteAssert(root, outputPath);

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("transport mismatch");
    },
  );
});
