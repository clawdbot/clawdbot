import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { resolveWorkshopSkillsDir } from "../skills/workshop/skills-root.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { collectInstalledSkillsCodeSafetyFindings } from "./audit-extra.async.js";

async function writeAuditSkill(root: string, unsafe: boolean, name = "shared-procedure") {
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
}

it.each(
  [
    { label: "default discovery", limits: {} },
    { label: "zero candidates", limits: { maxCandidatesPerRoot: 0 } },
    { label: "zero loaded skills", limits: { maxSkillsLoadedPerSource: 0 } },
    { label: "one candidate", limits: { maxCandidatesPerRoot: 1 } },
    { label: "one loaded skill", limits: { maxSkillsLoadedPerSource: 1 } },
    { label: "small prompt file cap", limits: { maxSkillFileBytes: 1 } },
  ].flatMap(({ label, limits }) => ["", "group"].map((group) => ({ label, limits, group }))),
)("audits hidden and shadowed Workshop skills with $label ($group)", async ({ limits, group }) => {
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
    await writeAuditSkill(path.join(state.workspaceDir, "skills"), false);
    const workshopDirs = await Promise.all(
      ["alpha", "beta"].map(async (agentId) => {
        const root = resolveWorkshopSkillsDir(cfg, agentId);
        await writeAuditSkill(root, false, "aaa-safe");
        return await writeAuditSkill(path.join(root, group), true);
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

it("reports an unreadable grouping directory without skipping readable siblings", async () => {
  await withOpenClawTestState({ label: "workshop-audit-group-failure" }, async (state) => {
    const cfg = { agents: { entries: { main: { workspace: state.workspaceDir } } } };
    const group = path.join(resolveWorkshopSkillsDir(cfg, "main"), "group");
    const unreadable = path.join(group, "unreadable");
    await fs.mkdir(unreadable, { recursive: true });
    const skillDir = await writeAuditSkill(group, true);
    const readdirSync = fsSync.readdirSync.bind(fsSync);
    const readdirSpy = vi.spyOn(fsSync, "readdirSync").mockImplementation((...args) => {
      if (path.resolve(String(args[0])) === unreadable) {
        throw Object.assign(new Error("Grouping directory is unreadable"), { code: "EACCES" });
      }
      return readdirSync(...args);
    });
    try {
      const findings = await collectInstalledSkillsCodeSafetyFindings({
        cfg,
        stateDir: state.stateDir,
      });
      expect(findings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            checkId: "skills.code_safety",
            severity: "critical",
            detail: expect.stringContaining(skillDir),
          }),
          expect.objectContaining({
            checkId: "skills.code_safety.scan_failed",
            detail: expect.stringContaining(unreadable),
          }),
        ]),
      );
    } finally {
      readdirSpy.mockRestore();
    }
  });
});

it.each(["contained", "escaping"] as const)("audits %s grouping symlinks", async (location) => {
  await withOpenClawTestState({ label: "workshop-audit-group-link" }, async (state) => {
    const cfg = { agents: { entries: { main: { workspace: state.workspaceDir } } } };
    const workshopDir = resolveWorkshopSkillsDir(cfg, "main");
    const target = path.join(location === "contained" ? workshopDir : state.stateDir, ".storage");
    const skillDir = await writeAuditSkill(target, true);
    await fs.mkdir(workshopDir, { recursive: true });
    await fs.symlink(target, path.join(workshopDir, "group"), "dir");
    const findings = await collectInstalledSkillsCodeSafetyFindings({
      cfg,
      stateDir: state.stateDir,
    });
    expect(findings.filter((finding) => finding.checkId === "skills.code_safety")).toEqual(
      location === "contained"
        ? [
            expect.objectContaining({
              severity: "critical",
              detail: expect.stringContaining(skillDir),
            }),
          ]
        : [],
    );
    if (location === "escaping") {
      expect(findings).toContainEqual(
        expect.objectContaining({
          checkId: "skills.code_safety.scan_failed",
          detail: expect.stringContaining("outside its configured root"),
        }),
      );
    }
  });
});

it("reports a dangling grouping link without skipping a readable dangerous sibling", async () => {
  await withOpenClawTestState({ label: "workshop-audit-dangling-link" }, async (state) => {
    const cfg = { agents: { entries: { main: { workspace: state.workspaceDir } } } };
    const workshopDir = resolveWorkshopSkillsDir(cfg, "main");
    const skillDir = await writeAuditSkill(workshopDir, true);
    const link = path.join(workshopDir, "group");
    await fs.symlink(path.join(workshopDir, "missing-group"), link, "dir");
    const findings = await collectInstalledSkillsCodeSafetyFindings({
      cfg,
      stateDir: state.stateDir,
    });
    expect(findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          severity: "critical",
          detail: expect.stringContaining(skillDir),
        }),
        expect.objectContaining({
          checkId: "skills.code_safety.scan_failed",
          detail: expect.stringContaining(link),
        }),
      ]),
    );
  });
});

it.each([300, 301])(
  "reports incomplete audit or honors a larger traversal limit (%s)",
  async (limit) => {
    await withOpenClawTestState({ label: "workshop-audit-inventory-limit" }, async (state) => {
      const cfg = {
        agents: { entries: { main: { workspace: state.workspaceDir } } },
        skills: { limits: { maxCandidatesPerRoot: limit, maxSkillsLoadedPerSource: 1 } },
      };
      const workshopDir = resolveWorkshopSkillsDir(cfg, "main");
      await Promise.all(
        Array.from({ length: 300 }, (_, index) =>
          fs.mkdir(path.join(workshopDir, `empty-${index}`), { recursive: true }),
        ),
      );
      const skillDir = await writeAuditSkill(workshopDir, true, "zzz-danger");
      const findings = await collectInstalledSkillsCodeSafetyFindings({
        cfg,
        stateDir: state.stateDir,
      });
      if (limit === 300) {
        expect(findings).toContainEqual(
          expect.objectContaining({
            checkId: "skills.code_safety.scan_failed",
            detail: expect.stringContaining("discovery limit"),
          }),
        );
      } else {
        expect(findings).toContainEqual(
          expect.objectContaining({
            severity: "critical",
            detail: expect.stringContaining(skillDir),
          }),
        );
        expect(
          findings.filter((finding) => finding.checkId === "skills.code_safety.scan_failed"),
        ).toEqual([]);
      }
    });
  },
);

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

it.runIf(process.platform !== "win32" && process.getuid?.() !== 0)(
  "reports an inaccessible Workshop ancestor instead of treating the root as missing",
  async () => {
    await withOpenClawTestState(
      { label: "workshop-audit-inaccessible-ancestor" },
      async (state) => {
        const cfg = { agents: { entries: { main: { workspace: state.workspaceDir } } } };
        const workshopDir = resolveWorkshopSkillsDir(cfg, "main");
        await fs.mkdir(workshopDir, { recursive: true });
        const agentDir = path.dirname(workshopDir);
        await fs.chmod(agentDir, 0);
        try {
          const findings = await collectInstalledSkillsCodeSafetyFindings({
            cfg,
            stateDir: state.stateDir,
          });
          expect(findings).toContainEqual(
            expect.objectContaining({
              checkId: "skills.code_safety.scan_failed",
              detail: expect.stringContaining(workshopDir),
            }),
          );
        } finally {
          await fs.chmod(agentDir, 0o700);
        }
      },
    );
  },
);

it("audits child skills even when the Workshop container has a stray definition", async () => {
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
    const skillDir = await writeAuditSkill(workshopDir, true, "child-procedure");

    const findings = await collectInstalledSkillsCodeSafetyFindings({
      cfg,
      stateDir: state.stateDir,
    });
    expect(findings.filter((finding) => finding.checkId === "skills.code_safety")).toMatchObject([
      {
        severity: "critical",
        title: expect.stringContaining("child-procedure"),
        detail: expect.stringContaining(skillDir),
      },
    ]);
  });
});
