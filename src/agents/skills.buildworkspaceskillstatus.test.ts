import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { withEnv, withEnvAsync } from "../test-utils/env.js";
import { buildWorkspaceSkillStatus } from "./skills-status.js";
import { writeSkill } from "./skills.e2e-test-helpers.js";
import { createCanonicalFixtureSkill } from "./skills.test-helpers.js";
import type { SkillEntry } from "./skills/types.js";
import { loadWorkspaceSkillEntries } from "./skills/workspace.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function createTempWorkspaceDir() {
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-skill-status-"));
  tempDirs.push(workspaceDir);
  return workspaceDir;
}

function makeEntry(params: {
  name: string;
  source?: string;
  os?: string[];
  requires?: { bins?: string[]; env?: string[]; config?: string[] };
  install?: Array<{
    id: string;
    kind: "brew" | "download";
    bins?: string[];
    formula?: string;
    os?: string[];
    url?: string;
    label?: string;
  }>;
}): SkillEntry {
  const filePath = `/tmp/${params.name}/SKILL.md`;
  const baseDir = `/tmp/${params.name}`;
  return {
    skill: createFixtureSkill({
      name: params.name,
      description: `desc:${params.name}`,
      filePath,
      baseDir,
      source: params.source ?? "openclaw-workspace",
    }),
    frontmatter: {},
    metadata: {
      ...(params.os ? { os: params.os } : {}),
      ...(params.requires ? { requires: params.requires } : {}),
      ...(params.install ? { install: params.install } : {}),
      ...(params.requires?.env?.[0] ? { primaryEnv: params.requires.env[0] } : {}),
    },
  };
}

function createFixtureSkill(params: {
  name: string;
  description: string;
  filePath: string;
  baseDir: string;
  source: string;
}): SkillEntry["skill"] {
  return createCanonicalFixtureSkill(params);
}

type WorkspaceSkillStatus = ReturnType<typeof buildWorkspaceSkillStatus>["skills"][number];

function requireReportedSkill(
  report: ReturnType<typeof buildWorkspaceSkillStatus>,
  name: string,
): WorkspaceSkillStatus {
  const skill = report.skills.find((entry) => entry.name === name);
  if (!skill) {
    throw new Error(`reported skill ${name} missing`);
  }
  return skill;
}

function requireSkillEntry(entry: SkillEntry | undefined, name: string): SkillEntry {
  if (!entry) {
    throw new Error(`skill entry ${name} missing`);
  }
  return entry;
}

describe("buildWorkspaceSkillStatus", () => {
  it("reports missing requirements and install options", () => {
    const entry = makeEntry({
      name: "status-skill",
      requires: {
        bins: ["fakebin"],
        env: ["ENV_KEY"],
        config: ["browser.enabled"],
      },
      install: [
        {
          id: "brew",
          kind: "brew",
          formula: "fakebin",
          bins: ["fakebin"],
          label: "Install fakebin",
        },
      ],
    });

    const report = withEnv({ PATH: "" }, () =>
      buildWorkspaceSkillStatus("/tmp/ws", {
        entries: [entry],
        config: { browser: { enabled: false } },
      }),
    );
    const skill = requireReportedSkill(report, "status-skill");

    expect(skill.eligible).toBe(false);
    expect(skill.missing.bins).toContain("fakebin");
    expect(skill.missing.env).toContain("ENV_KEY");
    expect(skill.missing.config).toContain("browser.enabled");
    expect(skill.install[0]?.id).toBe("brew");
  });

  it("honors legacy clawdbot skill metadata requirements and install hints", async () => {
    const workspaceDir = await createTempWorkspaceDir();
    await writeSkill({
      dir: path.join(workspaceDir, "skills", "legacy-skill"),
      name: "legacy-skill",
      description: "Legacy metadata",
      metadata:
        '{"clawdbot":{"requires":{"bins":["fakebin"]},"install":[{"id":"brew","kind":"brew","formula":"fakebin","bins":["fakebin"],"label":"Install fakebin"}]}}',
    });

    const report = withEnv({ PATH: "" }, () =>
      buildWorkspaceSkillStatus(workspaceDir, {
        managedSkillsDir: path.join(workspaceDir, ".managed"),
      }),
    );
    const skill = requireReportedSkill(report, "legacy-skill");

    expect(skill.eligible).toBe(false);
    expect(skill.requirements.bins).toEqual(["fakebin"]);
    expect(skill.missing.bins).toEqual(["fakebin"]);
    expect(skill.install[0]).toMatchObject({
      id: "brew",
      kind: "brew",
      label: "Install fakebin",
      bins: ["fakebin"],
    });
  });

  it("respects OS-gated skills", () => {
    const entry = makeEntry({
      name: "os-skill",
      os: ["darwin"],
    });

    const report = buildWorkspaceSkillStatus("/tmp/ws", { entries: [entry] });
    const skill = requireReportedSkill(report, "os-skill");

    if (process.platform === "darwin") {
      expect(skill.eligible).toBe(true);
      expect(skill.missing.os).toStrictEqual([]);
    } else {
      expect(skill.eligible).toBe(false);
      expect(skill.missing.os).toEqual(["darwin"]);
    }
  });
  it("marks bundled skills blocked by allowlist", () => {
    const entry = makeEntry({
      name: "peekaboo",
      source: "openclaw-bundled",
    });

    const report = buildWorkspaceSkillStatus("/tmp/ws", {
      entries: [entry],
      config: { skills: { allowBundled: ["other-skill"] } },
    });
    const skill = requireReportedSkill(report, "peekaboo");

    expect(skill.blockedByAllowlist).toBe(true);
    expect(skill.eligible).toBe(false);
    expect(skill.bundled).toBe(true);
  });

  it("requires explicit enablement before exposing bundled coding-agent", async () => {
    const workspaceDir = await createTempWorkspaceDir();
    const bundledSkillsDir = path.resolve("skills");
    const entries = loadWorkspaceSkillEntries(workspaceDir, {
      managedSkillsDir: path.join(workspaceDir, ".managed"),
      bundledSkillsDir,
      config: {
        skills: {
          allowBundled: ["coding-agent"],
        },
      },
    });
    const codingAgent = requireSkillEntry(
      entries.find((entry) => entry.skill.name === "coding-agent"),
      "coding-agent",
    );

    const eligibility = {
      remote: {
        platforms: [process.platform],
        hasBin: () => false,
        hasAnyBin: (bins: string[]) => bins.includes("codex"),
      },
    };
    const defaultReport = withEnv({ PATH: "" }, () =>
      buildWorkspaceSkillStatus(workspaceDir, {
        entries: [codingAgent],
        config: {
          skills: {
            allowBundled: ["coding-agent"],
          },
        },
        eligibility,
      }),
    );
    const defaultStatus = defaultReport.skills[0];
    expect(defaultStatus?.eligible).toBe(false);
    expect(defaultStatus?.requirements.config).toEqual(["skills.entries.coding-agent.enabled"]);
    expect(defaultStatus?.missing.config).toEqual(["skills.entries.coding-agent.enabled"]);

    const enabledReport = withEnv({ PATH: "" }, () =>
      buildWorkspaceSkillStatus(workspaceDir, {
        entries: [codingAgent],
        config: {
          skills: {
            allowBundled: ["coding-agent"],
            entries: {
              "coding-agent": { enabled: true },
            },
          },
        },
        eligibility,
      }),
    );
    const enabledStatus = enabledReport.skills[0];
    expect(enabledStatus?.eligible).toBe(true);
    expect(enabledStatus?.missing.config).toStrictEqual([]);
  });

  it("does not mark an overridden workspace skill as bundled by bundled name alone", async () => {
    const bundledDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-bundled-"));
    tempDirs.push(bundledDir);
    await writeSkill({
      dir: path.join(bundledDir, "peekaboo"),
      name: "peekaboo",
      description: "Bundled peekaboo",
    });

    await withEnvAsync({ OPENCLAW_BUNDLED_SKILLS_DIR: bundledDir }, async () => {
      const report = buildWorkspaceSkillStatus("/tmp/ws", {
        entries: [
          makeEntry({
            name: "peekaboo",
            source: "openclaw-workspace",
          }),
        ],
        config: { skills: { allowBundled: ["other-skill"] } },
      });
      const skill = requireReportedSkill(report, "peekaboo");

      expect(skill.source).toBe("openclaw-workspace");
      expect(skill.bundled).toBe(false);
      expect(skill.blockedByAllowlist).toBe(false);
      expect(skill.eligible).toBe(true);
    });
  });

  it("filters install options by OS", () => {
    const entry = makeEntry({
      name: "install-skill",
      requires: {
        bins: ["missing-bin"],
      },
      install: [
        {
          id: "mac",
          kind: "download",
          os: ["darwin"],
          url: "https://example.com/mac.tar.bz2",
        },
        {
          id: "linux",
          kind: "download",
          os: ["linux"],
          url: "https://example.com/linux.tar.bz2",
        },
        {
          id: "win",
          kind: "download",
          os: ["win32"],
          url: "https://example.com/win.tar.bz2",
        },
      ],
    });

    const report = withEnv({ PATH: "" }, () =>
      buildWorkspaceSkillStatus("/tmp/ws", {
        entries: [entry],
      }),
    );
    const skill = requireReportedSkill(report, "install-skill");

    if (process.platform === "darwin") {
      expect(skill.install.map((opt) => opt.id)).toEqual(["mac"]);
    } else if (process.platform === "linux") {
      expect(skill.install.map((opt) => opt.id)).toEqual(["linux"]);
    } else if (process.platform === "win32") {
      expect(skill.install.map((opt) => opt.id)).toEqual(["win"]);
    } else {
      expect(skill.install).toStrictEqual([]);
    }
  });
});
