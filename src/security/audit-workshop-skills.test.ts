import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { resolveWorkshopSkillsDir } from "../skills/workshop/skills-root.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { collectInstalledSkillsCodeSafetyFindings } from "./audit-extra.async.js";

it.each([
  { label: "default discovery", limits: {} },
  { label: "zero candidates", limits: { maxCandidatesPerRoot: 0 } },
  { label: "zero loaded skills", limits: { maxSkillsLoadedPerSource: 0 } },
  { label: "one candidate", limits: { maxCandidatesPerRoot: 1 } },
  { label: "one loaded skill", limits: { maxSkillsLoadedPerSource: 1 } },
  { label: "small prompt file cap", limits: { maxSkillFileBytes: 1 } },
])("audits hidden and shadowed Workshop skills with $label", async ({ limits }) => {
  await withOpenClawTestState({ label: "workshop-security-audit" }, async (state) => {
    const cfg = {
      skills: { limits },
      agents: {
        entries: {
          alpha: { workspace: state.workspaceDir, skills: [] },
          beta: { workspace: state.workspaceDir },
        },
      },
    };
    const writeSkill = async (root: string, unsafe: boolean, name = "shared-procedure") => {
      const dir = path.join(root, name);
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(
        path.join(dir, "SKILL.md"),
        `---\nname: ${name}\ndescription: Test procedure\n---\nFollow the procedure.\n`,
      );
      if (unsafe) {
        await fs.writeFile(
          path.join(dir, "run.js"),
          'const { execSync } = require("node:child_process"); execSync(input);\n',
        );
      }
      return await fs.realpath(dir);
    };
    await writeSkill(path.join(state.workspaceDir, "skills"), false);
    const workshopDirs = await Promise.all(
      ["alpha", "beta"].map(async (agentId) => {
        const root = resolveWorkshopSkillsDir(cfg, agentId);
        await writeSkill(root, false, "aaa-safe");
        return await writeSkill(root, true);
      }),
    );

    const findings = await collectInstalledSkillsCodeSafetyFindings({
      cfg,
      stateDir: state.stateDir,
    });
    const critical = findings.filter(
      (finding) => finding.checkId === "skills.code_safety" && finding.severity === "critical",
    );
    expect(critical).toHaveLength(2);
    for (const dir of workshopDirs) {
      expect(critical.some((finding) => finding.detail.includes(dir))).toBe(true);
    }
  });
});

it.each(["missing", "unreadable"] as const)(
  "reports an unreadable Workshop root but keeps a missing root quiet (%s)",
  async (rootState) => {
    await withOpenClawTestState({ label: "workshop-audit-root-failure" }, async (state) => {
      const cfg = { agents: { entries: { main: { workspace: state.workspaceDir } } } };
      const workshopDir = resolveWorkshopSkillsDir(cfg, "main");
      if (rootState === "unreadable") {
        await fs.mkdir(workshopDir, { recursive: true });
      }
      const readdirSync = fsSync.readdirSync.bind(fsSync);
      const readdirSpy = vi.spyOn(fsSync, "readdirSync").mockImplementation((...args) => {
        if (path.resolve(String(args[0])) === workshopDir) {
          throw Object.assign(new Error("Workshop directory is unreadable"), { code: "EACCES" });
        }
        return readdirSync(...args);
      });
      try {
        const findings = await collectInstalledSkillsCodeSafetyFindings({
          cfg,
          stateDir: state.stateDir,
        });
        expect(
          findings.filter((finding) => finding.checkId === "skills.code_safety.scan_failed"),
        ).toEqual(
          rootState === "unreadable"
            ? [
                expect.objectContaining({
                  severity: "warn",
                  detail: expect.stringContaining(workshopDir),
                }),
              ]
            : [],
        );
      } finally {
        readdirSpy.mockRestore();
      }
    });
  },
);

it("audits an active root-level Workshop definition without child directories", async () => {
  await withOpenClawTestState({ label: "workshop-audit-root-definition" }, async (state) => {
    const cfg = {
      agents: { entries: { main: { workspace: state.workspaceDir } } },
      skills: { limits: { maxCandidatesPerRoot: 0, maxSkillsLoadedPerSource: 0 } },
    };
    const workshopDir = resolveWorkshopSkillsDir(cfg, "main");
    await fs.mkdir(workshopDir, { recursive: true });
    await fs.writeFile(
      path.join(workshopDir, "SKILL.md"),
      "---\nname: root-procedure\ndescription: Root procedure\n---\nFollow the procedure.\n",
    );
    await fs.writeFile(
      path.join(workshopDir, "run.js"),
      'const { execSync } = require("node:child_process"); execSync(input);\n',
    );

    const findings = await collectInstalledSkillsCodeSafetyFindings({
      cfg,
      stateDir: state.stateDir,
    });
    expect(findings.filter((finding) => finding.checkId === "skills.code_safety")).toMatchObject([
      {
        severity: "critical",
        title: expect.stringContaining("root-procedure"),
        detail: expect.stringContaining(await fs.realpath(workshopDir)),
      },
    ]);
  });
});
