// Focused coverage for runtime-managed-implicit workspace provisioning (#92015).
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { makeTempWorkspace } from "../test-helpers/workspace.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { resetLegacyWorkspaceStateCheckForTest } from "./workspace-legacy-state.test-support.js";
import { readWorkspaceStateSnapshot } from "./workspace-state-store.js";
import {
  DEFAULT_AGENTS_FILENAME,
  DEFAULT_BOOTSTRAP_FILENAME,
  ensureAgentWorkspace,
} from "./workspace.js";

let testState: OpenClawTestState | undefined;

beforeEach(async () => {
  resetLegacyWorkspaceStateCheckForTest();
  testState = await createOpenClawTestState({
    layout: "state-only",
    prefix: "openclaw-workspace-provisioning-",
  });
});

afterEach(async () => {
  closeOpenClawStateDatabaseForTest();
  resetLegacyWorkspaceStateCheckForTest();
  await testState?.cleanup();
  testState = undefined;
});

async function expectPathMissing(filePath: string): Promise<void> {
  await expect(fs.access(filePath)).rejects.toHaveProperty("code", "ENOENT");
}

describe("ensureAgentWorkspace runtime-managed-implicit provisioning", () => {
  it("creates only the directory for runtime-managed-implicit provisioning (#92015)", async () => {
    const tempDir = await makeTempWorkspace("openclaw-workspace-");
    const targetDir = path.join(tempDir, "implicit-acp-workspace");

    const result = await ensureAgentWorkspace({
      dir: targetDir,
      ensureBootstrapFiles: true,
      provisioning: "runtime-managed-implicit",
    });

    expect(result.dir).toBe(targetDir);
    expect(result.bootstrapPending).toBe(false);
    // Directory is provisioned so ACP cwd fallback and media staging keep working...
    await expect(fs.access(targetDir)).resolves.toBeUndefined();
    // ...but no bootstrap files, git repo, or workspace state are seeded.
    await expectPathMissing(path.join(targetDir, DEFAULT_AGENTS_FILENAME));
    await expectPathMissing(path.join(targetDir, DEFAULT_BOOTSTRAP_FILENAME));
    await expectPathMissing(path.join(targetDir, ".git"));
    expect(readWorkspaceStateSnapshot(targetDir).setupExists).toBe(false);
  });

  it("runtime-managed-implicit provisioning preserves pre-existing workspace content", async () => {
    const tempDir = await makeTempWorkspace("openclaw-workspace-");
    const targetDir = path.join(tempDir, "implicit-acp-workspace");
    await fs.mkdir(targetDir, { recursive: true });
    await fs.writeFile(path.join(targetDir, "user-notes.md"), "keep me\n");

    await ensureAgentWorkspace({
      dir: targetDir,
      ensureBootstrapFiles: true,
      provisioning: "runtime-managed-implicit",
    });

    expect(await fs.readFile(path.join(targetDir, "user-notes.md"), "utf8")).toBe("keep me\n");
    await expectPathMissing(path.join(targetDir, DEFAULT_AGENTS_FILENAME));
    await expectPathMissing(path.join(targetDir, ".git"));
  });
});
