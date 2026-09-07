// A packaged install whose workspace templates are absent must still serve
// agent turns. Templates are required to *create* bootstrap files, but the
// per-turn checks only compare existing files against them, and a missing
// template there used to throw and fail every turn on a provisioned workspace.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const templateSearchDirs = vi.hoisted(() => ({ dirs: [] as string[] }));

vi.mock("./workspace-templates.js", () => ({
  resolveWorkspaceTemplateSearchDirs: async () => templateSearchDirs.dirs,
}));

async function makeProvisionedWorkspace(): Promise<string> {
  // Resolve the temp root: macOS reports /var, while path guards canonicalize
  // to /private/var, and the mismatch trips workspace boundary checks.
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "oc-ws-tpl-")));
  for (const name of ["AGENTS.md", "SOUL.md", "IDENTITY.md", "USER.md"]) {
    await fs.writeFile(path.join(root, name), `# ${name}\n\nreal user content\n`, "utf-8");
  }
  return root;
}

describe("workspace bootstrap status without packaged templates", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("resolves instead of throwing when no template directory exists", async () => {
    templateSearchDirs.dirs = [];
    const dir = await makeProvisionedWorkspace();
    const { resolveWorkspaceBootstrapStatus } = await import("./workspace.js");

    await expect(resolveWorkspaceBootstrapStatus(dir)).resolves.toMatch(/^(pending|complete)$/);
  });

  it("treats existing bootstrap files as user content when templates are unavailable", async () => {
    // An empty (but present) template dir is the packaged-install failure mode:
    // the directory resolves, every individual template read misses.
    templateSearchDirs.dirs = [
      await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "oc-tpl-empty-"))),
    ];
    const dir = await makeProvisionedWorkspace();
    const { resolveWorkspaceBootstrapStatus } = await import("./workspace.js");

    // Unknown-template content must never be mistaken for regenerable
    // boilerplate; the call completes and the files stay untouched.
    await expect(resolveWorkspaceBootstrapStatus(dir)).resolves.toMatch(/^(pending|complete)$/);
    await expect(fs.readFile(path.join(dir, "SOUL.md"), "utf-8")).resolves.toContain(
      "real user content",
    );
  });
});
