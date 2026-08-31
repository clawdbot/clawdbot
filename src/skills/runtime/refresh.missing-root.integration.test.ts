import nativeFs from "node:fs";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";

vi.mock("../loading/plugin-skills.js", () => ({
  resolvePluginSkillRoots: () => [],
  resolvePluginSkillRootsFromMetadata: () => [],
}));

it("refreshes skills created beneath an initially missing project skills root", async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "skills-root-proof-")));
  const workspaceDir = path.join(root, "workspace");
  await fs.mkdir(path.join(workspaceDir, "skills", "existing"), { recursive: true });
  const registeredPaths = new Set<string>();
  const originalWatch = nativeFs.watch;
  const watchObserver = vi.spyOn(nativeFs, "watch").mockImplementation((...args) => {
    const watcher = originalWatch(...args);
    registeredPaths.add(path.resolve(String(args[0])));
    return watcher;
  });
  syncBuiltinESMExports();
  const { ensureSkillsWatcher, closeSkillsWatchers, registerSkillsChangeListener } =
    await import("./refresh.js");
  const changes: string[] = [];
  const unregister = registerSkillsChangeListener((event) => {
    if (event.workspaceDir === workspaceDir && event.reason === "watch" && event.changedPath) {
      changes.push(event.changedPath);
    }
  });
  try {
    ensureSkillsWatcher({ workspaceDir });
    const existingSkill = path.join(workspaceDir, "skills", "existing", "SKILL.md");
    // Chokidar readiness can precede missing-parent registration, and parent
    // registration does not await child watches. Observe both native watches
    // before writing the positive control or creating the absent parents.
    await vi.waitFor(() => {
      expect(registeredPaths.has(workspaceDir)).toBe(true);
      expect(registeredPaths.has(path.dirname(existingSkill))).toBe(true);
    });
    await fs.writeFile(existingSkill, "existing skill");
    await vi.waitFor(() => expect(changes).toContain(existingSkill), { timeout: 3_000 });
    const newSkill = path.join(workspaceDir, ".agents", "skills", "new", "SKILL.md");
    await fs.mkdir(path.dirname(newSkill), { recursive: true });
    await fs.writeFile(newSkill, "new skill");
    await vi.waitFor(
      () => {
        expect(
          changes.some((changed) => changed.startsWith(path.join(workspaceDir, ".agents"))),
        ).toBe(true);
      },
      { timeout: 3_000 },
    );
  } finally {
    unregister();
    await closeSkillsWatchers();
    watchObserver.mockRestore();
    syncBuiltinESMExports();
    await fs.rm(root, { recursive: true, force: true });
  }
});
