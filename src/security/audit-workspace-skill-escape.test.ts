import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { collectWorkspaceSkillSymlinkEscapeFindings } from "./audit-workspace-skills.js";
import { AsyncTempCaseFactory } from "./test-temp-cases.js";

const isWindows = process.platform === "win32";

describe("security audit workspace skill path escape findings", () => {
  const tempCases = new AsyncTempCaseFactory("openclaw-security-audit-workspace-");

  function requireFinding(
    findings: Awaited<ReturnType<typeof collectWorkspaceSkillSymlinkEscapeFindings>>,
    checkId: string,
  ) {
    const finding = findings.find((entry) => entry.checkId === checkId);
    if (!finding) {
      throw new Error(`expected security finding ${checkId}`);
    }
    return finding;
  }

  beforeAll(async () => {
    await tempCases.setup();
  });

  afterAll(async () => {
    await tempCases.cleanup();
  });

  it("evaluates workspace skill path escape findings", async () => {
    const runs = [
      !isWindows
        ? (async () => {
            const tmp = await tempCases.makeTmpDir("workspace-skill-symlink-escape");
            const workspaceDir = path.join(tmp, "workspace");
            const outsideDir = path.join(tmp, "outside");
            await fs.mkdir(path.join(workspaceDir, "skills", "leak"), { recursive: true });
            await fs.mkdir(outsideDir, { recursive: true });
            const outsideSkillPath = path.join(outsideDir, "SKILL.md");
            await fs.writeFile(outsideSkillPath, "# outside\n", "utf-8");
            await fs.symlink(
              outsideSkillPath,
              path.join(workspaceDir, "skills", "leak", "SKILL.md"),
            );
            const findings = await collectWorkspaceSkillSymlinkEscapeFindings({
              cfg: { agents: { defaults: { workspace: workspaceDir } } } satisfies OpenClawConfig,
            });
            const finding = requireFinding(findings, "skills.workspace.symlink_escape");
            expect(finding.severity).toBe("warn");
            expect(finding.detail).toContain(outsideSkillPath);
          })()
        : Promise.resolve(),
      (async () => {
        const tmp = await tempCases.makeTmpDir("workspace-skill-in-root");
        const workspaceDir = path.join(tmp, "workspace");
        await fs.mkdir(path.join(workspaceDir, "skills", "safe"), { recursive: true });
        await fs.writeFile(
          path.join(workspaceDir, "skills", "safe", "SKILL.md"),
          "# in workspace\n",
          "utf-8",
        );
        const findings = await collectWorkspaceSkillSymlinkEscapeFindings({
          cfg: { agents: { defaults: { workspace: workspaceDir } } } satisfies OpenClawConfig,
        });
        expect(findings.map((entry) => entry.checkId)).not.toContain(
          "skills.workspace.symlink_escape",
        );
      })(),
    ];

    await Promise.all(runs);
  });

  it("treats an unresolvable realpath (timeout/error simulation) as a potential symlink escape", async () => {
    const tmp = await tempCases.makeTmpDir("workspace-skill-realpath-unresolvable");
    const workspaceDir = path.join(tmp, "workspace");
    const skillsDir = path.join(workspaceDir, "skills", "suspect-skill");
    await fs.mkdir(skillsDir, { recursive: true });
    await fs.writeFile(path.join(skillsDir, "SKILL.md"), "# suspect\n", "utf-8");

    // Simulate realpath failing for the skill file path — this mirrors what
    // happens when a slow/hanging NFS or SMB mount causes the 2 s deadline in
    // realpathWithTimeout to fire. The .catch(() => null) inside the helper
    // converts any rejection to null, which is the same signal produced by a
    // genuine timeout. All other paths resolve to their string value so the BFS
    // and workspace-root detection work normally.
    const realpathSpy = vi
      .spyOn(fs, "realpath")
      .mockImplementation(async (p: unknown): Promise<string> => {
        if (String(p).endsWith("SKILL.md")) {
          throw new Error("simulated realpath timeout");
        }
        return String(p);
      });

    try {
      const findings = await collectWorkspaceSkillSymlinkEscapeFindings({
        cfg: { agents: { defaults: { workspace: workspaceDir } } } satisfies OpenClawConfig,
      });
      const escapeFinding = requireFinding(findings, "skills.workspace.symlink_escape");
      expect(escapeFinding.severity).toBe("warn");
      // The finding must call out that realpath was unverifiable, not that it
      // resolved to a path outside the workspace.
      expect(escapeFinding.detail).toContain("realpath timed out");
    } finally {
      realpathSpy.mockRestore();
    }
  });

  it("surfaces scan_truncated finding when BFS visit cap is hit", async () => {
    const tmp = await tempCases.makeTmpDir("workspace-skill-bfs-truncated");
    const workspaceDir = path.join(tmp, "workspace");
    const skillsRoot = path.join(workspaceDir, "skills");
    await fs.mkdir(skillsRoot, { recursive: true });

    // Use a tiny injected visit cap to exercise the truncation branch without
    // forcing the test to await tens of thousands of mocked readdir calls.
    const FAKE_DIRS = 3;
    const fakeDirEntries = Array.from({ length: FAKE_DIRS }, (_, i) => ({
      name: `d${i}`,
      isDirectory: () => true,
      isFile: () => false,
      isSymbolicLink: () => false,
      isBlockDevice: () => false,
      isCharacterDevice: () => false,
      isFIFO: () => false,
      isSocket: () => false,
      parentPath: skillsRoot,
      path: skillsRoot,
    })) as unknown as Awaited<ReturnType<typeof fs.readdir>>;

    let readdirCalls = 0;
    const readdirSpy = vi.spyOn(fs, "readdir").mockImplementation(async () => {
      return readdirCalls++ === 0 ? fakeDirEntries : ([] as unknown as typeof fakeDirEntries);
    });
    const realpathSpy = vi
      .spyOn(fs, "realpath")
      .mockImplementation(async (p: unknown) => String(p));

    try {
      const findings = await collectWorkspaceSkillSymlinkEscapeFindings({
        cfg: { agents: { defaults: { workspace: workspaceDir } } } satisfies OpenClawConfig,
        skillScanLimits: { maxDirVisits: 2 },
      });
      const truncFinding = requireFinding(findings, "skills.workspace.scan_truncated");
      expect(truncFinding.severity).toBe("warn");
      expect(truncFinding.detail).toContain(workspaceDir);
    } finally {
      readdirSpy.mockRestore();
      realpathSpy.mockRestore();
    }
  });
});
