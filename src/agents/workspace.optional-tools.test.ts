// Optional environment notes are operator-owned, not seeded bootstrap state.
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { resetLegacyWorkspaceStateCheckForTest } from "./workspace-legacy-state.test-support.js";
import {
  DEFAULT_TOOLS_FILENAME,
  ensureAgentWorkspace,
  loadWorkspaceBootstrapFiles,
} from "./workspace.js";

afterEach(resetLegacyWorkspaceStateCheckForTest);

describe("optional workspace TOOLS.md", () => {
  it("does not seed TOOLS.md or report its absence during setup", async () => {
    await withOpenClawTestState({ layout: "state-only" }, async ({ workspaceDir }) => {
      await ensureAgentWorkspace({ dir: workspaceDir, ensureBootstrapFiles: true });

      await expect(
        fs.access(path.join(workspaceDir, DEFAULT_TOOLS_FILENAME)),
      ).rejects.toHaveProperty("code", "ENOENT");
      expect(
        (await loadWorkspaceBootstrapFiles(workspaceDir)).map((file) => file.name),
      ).not.toContain(DEFAULT_TOOLS_FILENAME);
    });
  });

  it("loads only an opted-in root TOOLS.md and preserves it during setup", async () => {
    await withOpenClawTestState({ layout: "state-only" }, async ({ workspaceDir }) => {
      const nestedDir = path.join(workspaceDir, "project");
      await fs.mkdir(nestedDir);
      await fs.writeFile(path.join(nestedDir, DEFAULT_TOOLS_FILENAME), "nested");
      expect(
        (await loadWorkspaceBootstrapFiles(workspaceDir)).map((file) => file.name),
      ).not.toContain(DEFAULT_TOOLS_FILENAME);

      const toolsPath = path.join(workspaceDir, DEFAULT_TOOLS_FILENAME);
      await fs.writeFile(toolsPath, "local notes");
      await ensureAgentWorkspace({ dir: workspaceDir, ensureBootstrapFiles: true });

      const files = await loadWorkspaceBootstrapFiles(workspaceDir);
      expect(files.filter((file) => file.name === DEFAULT_TOOLS_FILENAME)).toEqual([
        {
          name: DEFAULT_TOOLS_FILENAME,
          path: toolsPath,
          content: "local notes",
          missing: false,
        },
      ]);
      expect(await fs.readFile(toolsPath, "utf8")).toBe("local notes");
    });
  });
});
