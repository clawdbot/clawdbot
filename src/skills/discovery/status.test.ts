import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readLocalSkillCardContentSync } from "../lifecycle/clawhub.js";
import { createCanonicalFixtureSkill } from "../test-support/test-helpers.js";
import type { SkillEntry } from "../types.js";
import { buildWorkspaceSkillStatus } from "./status.js";

type SkillStatus = ReturnType<typeof buildWorkspaceSkillStatus>["skills"][number];

describe("buildWorkspaceSkillStatus", () => {
  it("surfaces valid ClawHub linkage and local Skill Card metadata", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-skill-status-"));
    try {
      const skillDir = path.join(workspaceDir, "skills", "agentreceipt");
      const originPath = path.join(skillDir, ".clawhub", "origin.json");
      const lockPath = path.join(workspaceDir, ".clawhub", "lock.json");
      const cardPath = path.join(skillDir, "skill-card.md");
      await fs.mkdir(path.dirname(originPath), { recursive: true });
      await fs.mkdir(path.dirname(lockPath), { recursive: true });
      await fs.writeFile(
        originPath,
        `${JSON.stringify(
          {
            version: 1,
            registry: "https://clawhub.ai/",
            slug: "agentreceipt",
            installedVersion: "1.2.3",
            installedAt: 123,
          },
          null,
          2,
        )}\n`,
        "utf8",
      );
      await fs.writeFile(
        lockPath,
        `${JSON.stringify(
          {
            version: 1,
            skills: {
              agentreceipt: {
                version: "1.2.3",
                installedAt: 123,
                registry: "https://clawhub.ai/",
              },
            },
          },
          null,
          2,
        )}\n`,
        "utf8",
      );
      await fs.writeFile(cardPath, "# AgentReceipt\n\nLocal trust card.\n", "utf8");

      const report = buildWorkspaceSkillStatus(workspaceDir, {
        entries: [createEntry("agentreceipt", { baseDir: skillDir })],
      });

      expect(report.skills[0]?.clawhub).toEqual({
        status: "linked",
        valid: true,
        registry: "https://clawhub.ai",
        slug: "agentreceipt",
        installedVersion: "1.2.3",
        installedAt: 123,
        originPath,
        lockPath,
      });
      expect(report.skills[0]?.skillCard).toEqual({
        present: true,
        path: cardPath,
        sizeBytes: 34,
      });
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("uses ClawHub origin metadata for linkage when the skill name is a display name", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-skill-status-"));
    try {
      const skillDir = path.join(workspaceDir, "skills", "agentreceipt");
      await writeClawHubStatusFixture({
        workspaceDir,
        skillDir,
        slug: "agentreceipt",
      });

      const report = buildWorkspaceSkillStatus(workspaceDir, {
        entries: [createEntry("AgentReceipt", { baseDir: skillDir })],
      });

      expect(report.skills[0]?.skillKey).toBe("AgentReceipt");
      expect(report.skills[0]?.clawhub).toMatchObject({
        status: "linked",
        valid: true,
        registry: "https://clawhub.ai",
        slug: "agentreceipt",
        installedVersion: "1.2.3",
        installedAt: 123,
      });
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("does not link ClawHub origin metadata from the wrong install directory", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-skill-status-"));
    try {
      const copiedSkillDir = path.join(workspaceDir, "skills", "copied-agentreceipt");
      await writeClawHubStatusFixture({
        workspaceDir,
        skillDir: copiedSkillDir,
        slug: "agentreceipt",
      });

      const report = buildWorkspaceSkillStatus(workspaceDir, {
        entries: [createEntry("copied-agentreceipt", { baseDir: copiedSkillDir })],
      });

      expect(report.skills[0]?.clawhub).toMatchObject({
        status: "invalid",
        valid: false,
        slug: "agentreceipt",
        reason: expect.stringContaining("expected ClawHub install directory"),
      });
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("does not link ClawHub origin metadata when the lockfile registry disagrees", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-skill-status-"));
    try {
      const skillDir = path.join(workspaceDir, "skills", "agentreceipt");
      await writeClawHubStatusFixture({
        workspaceDir,
        skillDir,
        slug: "agentreceipt",
        originRegistry: "https://clawhub.ai",
        lockRegistry: "https://example.invalid",
      });

      const report = buildWorkspaceSkillStatus(workspaceDir, {
        entries: [createEntry("agentreceipt", { baseDir: skillDir })],
      });

      expect(report.skills[0]?.clawhub).toMatchObject({
        status: "invalid",
        valid: false,
        slug: "agentreceipt",
        reason: expect.stringContaining("does not match the workspace ClawHub lockfile"),
      });
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform !== "win32")(
    "does not surface or read Skill Card symlinks outside the skill directory",
    async () => {
      const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-skill-status-"));
      try {
        const skillDir = path.join(workspaceDir, "skills", "agentreceipt");
        const secretPath = path.join(workspaceDir, "secret.txt");
        await fs.mkdir(skillDir, { recursive: true });
        await fs.writeFile(secretPath, "secret local file\n", "utf8");
        await fs.symlink(secretPath, path.join(skillDir, "skill-card.md"));

        const report = buildWorkspaceSkillStatus(workspaceDir, {
          entries: [createEntry("agentreceipt", { baseDir: skillDir })],
        });

        expect(report.skills[0]?.skillCard).toBeUndefined();
        expect(readLocalSkillCardContentSync(skillDir)).toBeUndefined();
      } finally {
        await fs.rm(workspaceDir, { recursive: true, force: true });
      }
    },
  );

  it("surfaces malformed or mismatched ClawHub linkage without trusting it", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-skill-status-"));
    try {
      const malformedDir = path.join(workspaceDir, "skills", "malformed");
      const missingLockDir = path.join(workspaceDir, "skills", "missing-lock");
      const mismatchDir = path.join(workspaceDir, "skills", "mismatch");

      await fs.mkdir(path.join(malformedDir, ".clawhub"), { recursive: true });
      await fs.writeFile(path.join(malformedDir, ".clawhub", "origin.json"), "{not json", "utf8");

      await writeClawHubStatusFixture({
        workspaceDir,
        skillDir: missingLockDir,
        slug: "missing-lock",
        writeLock: false,
      });
      await writeClawHubStatusFixture({
        workspaceDir,
        skillDir: mismatchDir,
        slug: "mismatch",
        installedVersion: "1.2.3",
        lockVersion: "9.9.9",
      });

      const report = buildWorkspaceSkillStatus(workspaceDir, {
        entries: [
          createEntry("malformed", { baseDir: malformedDir }),
          createEntry("missing-lock", { baseDir: missingLockDir }),
          createEntry("mismatch", { baseDir: mismatchDir }),
          createEntry("local-only", { baseDir: path.join(workspaceDir, "skills", "local-only") }),
        ],
      });
      const byName = skillStatusByName(report.skills);

      expect(requireSkillStatus(byName, "malformed").clawhub).toMatchObject({
        status: "invalid",
        valid: false,
        reason: expect.stringContaining("Malformed ClawHub origin metadata"),
      });
      expect(requireSkillStatus(byName, "missing-lock").clawhub).toMatchObject({
        status: "invalid",
        valid: false,
        reason: expect.stringContaining("not tracked by the workspace ClawHub lockfile"),
      });
      expect(requireSkillStatus(byName, "mismatch").clawhub).toMatchObject({
        status: "invalid",
        valid: false,
        reason: expect.stringContaining("does not match the workspace ClawHub lockfile"),
      });
      expect(requireSkillStatus(byName, "local-only").clawhub).toBeUndefined();
      expect(requireSkillStatus(byName, "local-only").skillCard).toBeUndefined();
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("does not surface install options for OS-scoped skills on unsupported platforms", () => {
    if (process.platform === "win32") {
      // Keep this simple; win32 platform naming is already explicitly handled elsewhere.
      return;
    }

    const mismatchedOs = process.platform === "darwin" ? "linux" : "darwin";

    const entry: SkillEntry = {
      skill: createCanonicalFixtureSkill({
        name: "os-scoped",
        description: "test",
        filePath: "/tmp/os-scoped",
        baseDir: "/tmp",
        source: "test",
      }),
      frontmatter: {},
      metadata: {
        os: [mismatchedOs],
        requires: { bins: ["fakebin"] },
        install: [
          {
            id: "brew",
            kind: "brew",
            formula: "fake",
            bins: ["fakebin"],
            label: "Install fake (brew)",
          },
        ],
      },
    };

    const report = buildWorkspaceSkillStatus("/tmp/ws", { entries: [entry] });
    expect(report.skills).toStrictEqual([
      {
        name: "os-scoped",
        description: "test",
        source: "test",
        bundled: false,
        filePath: "/tmp/os-scoped",
        baseDir: "/tmp",
        skillKey: "os-scoped",
        primaryEnv: undefined,
        emoji: undefined,
        homepage: undefined,
        always: false,
        disabled: false,
        blockedByAllowlist: false,
        blockedByAgentFilter: false,
        eligible: false,
        modelVisible: false,
        userInvocable: true,
        commandVisible: false,
        requirements: {
          anyBins: [],
          bins: ["fakebin"],
          config: [],
          env: [],
          os: [mismatchedOs],
        },
        missing: {
          anyBins: [],
          bins: ["fakebin"],
          config: [],
          env: [],
          os: [mismatchedOs],
        },
        configChecks: [],
        install: [],
      },
    ]);
  });

  it("does not expose raw config values in config checks", () => {
    const secret = "discord-token-secret-abc"; // pragma: allowlist secret
    const entry: SkillEntry = {
      skill: createCanonicalFixtureSkill({
        name: "discord",
        description: "test",
        filePath: "/tmp/discord/SKILL.md",
        baseDir: "/tmp/discord",
        source: "test",
      }),
      frontmatter: {},
      metadata: {
        requires: { config: ["channels.discord.token"] },
      },
    };

    const report = buildWorkspaceSkillStatus("/tmp/ws", {
      entries: [entry],
      config: {
        channels: {
          discord: {
            token: secret,
          },
        },
      },
    });

    expect(JSON.stringify(report)).not.toContain(secret);
    const discord = report.skills.find((skill) => skill.name === "discord");
    const check = discord?.configChecks.find((entry) => entry.path === "channels.discord.token");
    expect(check).toEqual({ path: "channels.discord.token", satisfied: true });
    expect(check && "value" in check).toBe(false);
  });

  it("reports prompt and command visibility separately from eligibility", () => {
    const entry: SkillEntry = {
      skill: createCanonicalFixtureSkill({
        name: "background-only",
        description: "test",
        filePath: "/tmp/background-only/SKILL.md",
        baseDir: "/tmp/background-only",
        source: "test",
      }),
      frontmatter: {},
      invocation: {
        userInvocable: false,
        disableModelInvocation: true,
      },
    };

    const report = buildWorkspaceSkillStatus("/tmp/ws", { entries: [entry] });
    const skill = report.skills[0];
    expect(skill?.eligible).toBe(true);
    expect(skill?.modelVisible).toBe(false);
    expect(skill?.userInvocable).toBe(false);
    expect(skill?.commandVisible).toBe(false);
  });

  it("uses default-visible exposure semantics when older entries omit exposure fields", () => {
    const entry: SkillEntry = {
      skill: createCanonicalFixtureSkill({
        name: "legacy-exposure",
        description: "test",
        filePath: "/tmp/legacy-exposure/SKILL.md",
        baseDir: "/tmp/legacy-exposure",
        source: "test",
      }),
      frontmatter: {},
      exposure: {
        includeInRuntimeRegistry: true,
      } as SkillEntry["exposure"],
    };

    const report = buildWorkspaceSkillStatus("/tmp/ws", { entries: [entry] });
    const skill = report.skills[0];
    expect(skill?.eligible).toBe(true);
    expect(skill?.modelVisible).toBe(true);
    expect(skill?.userInvocable).toBe(true);
    expect(skill?.commandVisible).toBe(true);
  });

  it("reports skills blocked by an agent skill filter", () => {
    const alpha: SkillEntry = {
      skill: createCanonicalFixtureSkill({
        name: "alpha",
        description: "test",
        filePath: "/tmp/alpha/SKILL.md",
        baseDir: "/tmp/alpha",
        source: "test",
      }),
      frontmatter: {},
    };
    const beta: SkillEntry = {
      skill: createCanonicalFixtureSkill({
        name: "beta",
        description: "test",
        filePath: "/tmp/beta/SKILL.md",
        baseDir: "/tmp/beta",
        source: "test",
      }),
      frontmatter: {},
    };

    const report = buildWorkspaceSkillStatus("/tmp/ws", {
      entries: [alpha, beta],
      agentId: "specialist",
      config: {
        agents: {
          list: [{ id: "specialist", skills: ["alpha"] }],
        },
      },
    });

    expect(report.agentId).toBe("specialist");
    expect(report.agentSkillFilter).toEqual(["alpha"]);
    expect(report.skills.find((skill) => skill.name === "alpha")?.blockedByAgentFilter).toBe(false);
    const byName = skillStatusByName(report.skills);
    expect(requireSkillStatus(byName, "alpha").modelVisible).toBe(true);
    expect(requireSkillStatus(byName, "beta").blockedByAgentFilter).toBe(true);
    expect(report.skills.find((skill) => skill.name === "beta")?.modelVisible).toBe(false);
  });

  it("classifies a mixed broken skill pack without flattening visibility reasons", () => {
    const missingBin = "openclaw-test-definitely-missing-skill-bin";
    const report = buildWorkspaceSkillStatus("/tmp/ws", {
      agentId: "specialist",
      config: {
        agents: {
          list: [
            {
              id: "specialist",
              skills: [
                "ready",
                "needs-bin",
                "needs-env",
                "prompt-hidden",
                "slash-hidden",
                "disabled",
                "bundled-blocked",
              ],
            },
          ],
        },
        skills: {
          allowBundled: ["some-other-bundled-skill"],
          entries: {
            disabled: { enabled: false },
          },
          install: {
            nodeManager: "pnpm",
          },
        },
      },
      entries: [
        createEntry("ready"),
        createEntry("needs-bin", {
          metadata: {
            requires: { bins: [missingBin] },
            install: [
              {
                kind: "node",
                package: "@openclaw/missing-skill-bin",
                bins: [missingBin],
              },
            ],
          },
        }),
        createEntry("needs-env", {
          metadata: {
            primaryEnv: "OPENCLAW_TEST_MISSING_SKILL_KEY",
            requires: { env: ["OPENCLAW_TEST_MISSING_SKILL_KEY"] },
          },
        }),
        createEntry("prompt-hidden", {
          invocation: {
            userInvocable: true,
            disableModelInvocation: true,
          },
        }),
        createEntry("slash-hidden", {
          invocation: {
            userInvocable: false,
            disableModelInvocation: false,
          },
        }),
        createEntry("agent-filtered"),
        createEntry("disabled"),
        createEntry("bundled-blocked", { source: "openclaw-bundled" }),
      ],
    });

    const byName = skillStatusByName(report.skills);
    expect(report.agentSkillFilter).toEqual([
      "ready",
      "needs-bin",
      "needs-env",
      "prompt-hidden",
      "slash-hidden",
      "disabled",
      "bundled-blocked",
    ]);
    expectStatusFlags(requireSkillStatus(byName, "ready"), {
      eligible: true,
      modelVisible: true,
      commandVisible: true,
    });
    const needsBin = requireSkillStatus(byName, "needs-bin");
    expectStatusFlags(needsBin, {
      eligible: false,
      modelVisible: false,
      commandVisible: false,
    });
    expect(needsBin.missing).toStrictEqual({
      anyBins: [],
      bins: [missingBin],
      config: [],
      env: [],
      os: [],
    });
    expect(needsBin.install).toStrictEqual([
      {
        kind: "node",
        id: "node-0",
        label: "Install @openclaw/missing-skill-bin (pnpm)",
        bins: [missingBin],
      },
    ]);
    const needsEnv = requireSkillStatus(byName, "needs-env");
    expect(needsEnv.eligible).toBe(false);
    expect(needsEnv.primaryEnv).toBe("OPENCLAW_TEST_MISSING_SKILL_KEY");
    expect(needsEnv.missing).toStrictEqual({
      anyBins: [],
      bins: [],
      config: [],
      env: ["OPENCLAW_TEST_MISSING_SKILL_KEY"],
      os: [],
    });
    expectStatusFlags(requireSkillStatus(byName, "prompt-hidden"), {
      eligible: true,
      modelVisible: false,
      commandVisible: true,
    });
    const slashHidden = requireSkillStatus(byName, "slash-hidden");
    expectStatusFlags(slashHidden, {
      eligible: true,
      modelVisible: true,
      commandVisible: false,
    });
    expect(slashHidden.userInvocable).toBe(false);
    const agentFiltered = requireSkillStatus(byName, "agent-filtered");
    expectStatusFlags(agentFiltered, {
      eligible: true,
      modelVisible: false,
      commandVisible: false,
    });
    expect(agentFiltered.blockedByAgentFilter).toBe(true);
    const disabled = requireSkillStatus(byName, "disabled");
    expectStatusFlags(disabled, {
      eligible: false,
      modelVisible: false,
      commandVisible: false,
    });
    expect(disabled.disabled).toBe(true);
    const bundledBlocked = requireSkillStatus(byName, "bundled-blocked");
    expectStatusFlags(bundledBlocked, {
      eligible: false,
      modelVisible: false,
      commandVisible: false,
    });
    expect(bundledBlocked.blockedByAllowlist).toBe(true);
  });
});

function skillStatusByName(skills: readonly SkillStatus[]): Map<string, SkillStatus> {
  return new Map(skills.map((skill) => [skill.name, skill]));
}

function requireSkillStatus(byName: ReadonlyMap<string, SkillStatus>, name: string): SkillStatus {
  const status = byName.get(name);
  if (!status) {
    throw new Error(`expected skill status ${name}`);
  }
  return status;
}

function expectStatusFlags(
  status: SkillStatus,
  expected: {
    eligible: boolean;
    modelVisible: boolean;
    commandVisible: boolean;
  },
): void {
  expect(status.eligible).toBe(expected.eligible);
  expect(status.modelVisible).toBe(expected.modelVisible);
  expect(status.commandVisible).toBe(expected.commandVisible);
}

function createEntry(
  name: string,
  params: {
    description?: string;
    source?: string;
    baseDir?: string;
    metadata?: SkillEntry["metadata"];
    invocation?: SkillEntry["invocation"];
  } = {},
): SkillEntry {
  const baseDir = params.baseDir ?? `/tmp/${name}`;
  return {
    skill: createCanonicalFixtureSkill({
      name,
      description: params.description ?? `${name} skill`,
      filePath: `${baseDir}/SKILL.md`,
      baseDir,
      source: params.source ?? "test",
    }),
    frontmatter: {},
    metadata: params.metadata,
    invocation: params.invocation,
  };
}

async function writeClawHubStatusFixture(params: {
  workspaceDir: string;
  skillDir: string;
  slug: string;
  installedVersion?: string;
  installedAt?: number;
  lockVersion?: string;
  originRegistry?: string;
  lockRegistry?: string;
  writeLock?: boolean;
}) {
  const installedVersion = params.installedVersion ?? "1.2.3";
  const installedAt = params.installedAt ?? 123;
  const originPath = path.join(params.skillDir, ".clawhub", "origin.json");
  await fs.mkdir(path.dirname(originPath), { recursive: true });
  await fs.writeFile(
    originPath,
    `${JSON.stringify(
      {
        version: 1,
        registry: params.originRegistry ?? "https://clawhub.ai",
        slug: params.slug,
        installedVersion,
        installedAt,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  if (params.writeLock === false) {
    return;
  }
  const lockPath = path.join(params.workspaceDir, ".clawhub", "lock.json");
  await fs.mkdir(path.dirname(lockPath), { recursive: true });
  await fs.writeFile(
    lockPath,
    `${JSON.stringify(
      {
        version: 1,
        skills: {
          [params.slug]: {
            version: params.lockVersion ?? installedVersion,
            installedAt,
            registry: params.lockRegistry ?? "https://clawhub.ai",
          },
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}
