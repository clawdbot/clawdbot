// Doctor install tests cover install checks, repair notes, and binary/package diagnostics.
import fs from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { note } from "../../packages/terminal-core/src/note.js";
import { withTestDir } from "../test-helpers/temp-dir.js";
import { noteSourceInstallIssues, repairWindowsGitLauncher } from "./doctor-install.js";

const reconcileWindowsGitLauncher = vi.hoisted(() => vi.fn());

vi.mock("../../packages/terminal-core/src/note.js", () => ({
  note: vi.fn(),
}));

vi.mock("../infra/windows-git-launcher.js", () => ({
  reconcileWindowsGitLauncher,
}));

async function writeFile(root: string, relativePath: string, content = "") {
  const file = path.join(root, relativePath);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content, "utf8");
}

describe("noteSourceInstallIssues", () => {
  beforeEach(() => {
    vi.mocked(note).mockReset();
    reconcileWindowsGitLauncher.mockReset();
    reconcileWindowsGitLauncher.mockResolvedValue({ status: "skipped", reason: "not-windows" });
  });

  it("does not treat a packaged workspace config as a source checkout", async () => {
    await withTestDir({ prefix: "openclaw-doctor-install-" }, async (root) => {
      await fs.mkdir(path.join(root, "node_modules"), { recursive: true });
      await writeFile(root, "pnpm-workspace.yaml", "packages:\n  - .\n");

      noteSourceInstallIssues(root);

      expect(note).not.toHaveBeenCalled();
    });
  });

  it("warns source checkouts when node_modules was not installed by pnpm", async () => {
    await withTestDir({ prefix: "openclaw-doctor-install-" }, async (root) => {
      await fs.mkdir(path.join(root, "node_modules"), { recursive: true });
      await writeFile(root, "pnpm-workspace.yaml", "packages:\n  - .\n");
      await writeFile(root, "src/entry.ts", "export {};\n");

      noteSourceInstallIssues(root);

      expect(note).toHaveBeenCalledWith(
        [
          "- node_modules was not installed by pnpm (missing node_modules/.pnpm). Run: pnpm install so bundled plugins can load package-local dependencies.",
          "- tsx binary is missing for source runs. Run: pnpm install.",
        ].join("\n"),
        "Install",
      );
    });
  });
});

describe("repairWindowsGitLauncher", () => {
  beforeEach(() => {
    vi.mocked(note).mockReset();
    reconcileWindowsGitLauncher.mockReset();
  });

  it("warns without changing a legacy launcher outside repair mode", async () => {
    reconcileWindowsGitLauncher.mockResolvedValue({
      status: "needs-repair",
      launcherPath: "C:\\Users\\alice\\.local\\bin\\openclaw.cmd",
    });

    await repairWindowsGitLauncher("C:\\Users\\alice\\openclaw", false);

    expect(reconcileWindowsGitLauncher).toHaveBeenCalledWith({
      root: "C:\\Users\\alice\\openclaw",
      repair: false,
    });
    expect(note).toHaveBeenCalledWith(
      expect.stringContaining("Run: openclaw doctor --fix"),
      "Install",
    );
  });

  it("reports a launcher migrated by repair mode", async () => {
    reconcileWindowsGitLauncher.mockResolvedValue({
      status: "updated",
      launcherPath: "C:\\Users\\alice\\.local\\bin\\openclaw.cmd",
    });

    await repairWindowsGitLauncher("C:\\Users\\alice\\openclaw", true);

    expect(reconcileWindowsGitLauncher).toHaveBeenCalledWith({
      root: "C:\\Users\\alice\\openclaw",
      repair: true,
    });
    expect(note).toHaveBeenCalledWith(expect.stringContaining("Updated"), "Install");
  });

  it("directs unsupported legacy-launcher runtimes to the installer", async () => {
    reconcileWindowsGitLauncher.mockResolvedValue({
      status: "needs-reinstall",
      launcherPath: "C:\\Users\\alice\\.local\\bin\\openclaw.cmd",
    });

    await repairWindowsGitLauncher("C:\\Users\\alice\\openclaw", true);

    expect(note).toHaveBeenCalledWith(
      expect.stringContaining("Re-run the OpenClaw installer"),
      "Install",
    );
  });
});
