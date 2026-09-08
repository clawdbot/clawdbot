// Workspace snapshot tests cover serialized snapshots of workspace skill state.
import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { readCodeModeSkill, resolveCodeModeSkills } from "../../agents/code-mode-skills.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { withEnv, withPathResolutionEnv } from "../../test-utils/env.js";
import { createFixtureSuite } from "../../test-utils/fixture-suite.js";
import { createTempHomeEnv, type TempHomeEnv } from "../../test-utils/temp-home.js";
import { buildWorkspaceSkillStatus } from "../discovery/status.js";
import { resolveEmbeddedRunSkillEntries } from "../runtime/embedded-run-entries.js";
import { bumpSkillsSnapshotVersion } from "../runtime/refresh-state.js";
import { resolveReusableWorkspaceSkillSnapshot } from "../runtime/session-snapshot.js";
import { writeSkill, writeWorkspaceSkills } from "../test-support/e2e-test-helpers.js";
import {
  restoreMockSkillsHomeEnv,
  setMockSkillsHomeEnv,
  type SkillsHomeEnvSnapshot,
} from "../test-support/home-env.test-support.js";
import { buildSkillSnapshot } from "./workspace-skill-prompt.js";

vi.mock("./plugin-skills.js", () => ({
  resolvePluginSkillRoots: () => [],
}));

const fixtureSuite = createFixtureSuite("openclaw-skills-snapshot-suite-");
const directorySymlinkType = process.platform === "win32" ? "junction" : "dir";
let truncationWorkspaceTemplateDir = "";
let tempHome: TempHomeEnv | null = null;
let skillsHomeEnv: SkillsHomeEnvSnapshot | null = null;

beforeAll(async () => {
  await fixtureSuite.setup();
  tempHome = await createTempHomeEnv("openclaw-skills-snapshot-home-");
  skillsHomeEnv = setMockSkillsHomeEnv(tempHome.home);
  truncationWorkspaceTemplateDir = await fixtureSuite.createCaseDir(
    "template-truncation-workspace",
  );
  for (let i = 0; i < 8; i += 1) {
    const name = `skill-${String(i).padStart(2, "0")}`;
    await writeSkill({
      dir: path.join(truncationWorkspaceTemplateDir, "skills", name),
      name,
      description: "x".repeat(800),
    });
  }
});

afterAll(async () => {
  if (skillsHomeEnv) {
    await restoreMockSkillsHomeEnv(skillsHomeEnv);
    skillsHomeEnv = null;
  }
  if (tempHome) {
    await tempHome.restore();
    tempHome = null;
  }
  await fixtureSuite.cleanup();
});

function withWorkspaceHome<T>(workspaceDir: string, cb: () => T): T {
  return withPathResolutionEnv(workspaceDir, { PATH: "" }, () => cb());
}

function buildSnapshot(workspaceDir: string, options?: Parameters<typeof buildSkillSnapshot>[1]) {
  return withWorkspaceHome(workspaceDir, () =>
    buildSkillSnapshot(workspaceDir, {
      managedSkillsDir: path.join(workspaceDir, ".managed"),
      bundledSkillsDir: path.join(workspaceDir, ".bundled"),
      ...options,
    }),
  );
}

const CUSTODIAN_SKILL_NAMES = [
  "add-model-provider",
  "cloud-image-bake",
  "configure-channel",
  "diagnose-gateway",
] as const;

async function writeCustodianSkillFixture(workspaceDir: string): Promise<void> {
  for (const name of CUSTODIAN_SKILL_NAMES) {
    await writeSkill({
      dir: path.join(workspaceDir, "custodian-skills", name),
      name,
      description: `Custodian ${name}`,
    });
  }
}

function buildAgentSnapshot(params: {
  workspaceDir: string;
  config: OpenClawConfig;
  agentId: string;
}) {
  return buildSnapshot(params.workspaceDir, {
    config: params.config,
    agentId: params.agentId,
  });
}

async function cloneTemplateDir(templateDir: string, prefix: string): Promise<string> {
  const cloned = await fixtureSuite.createCaseDir(prefix);
  await fs.cp(templateDir, cloned, { recursive: true });
  return cloned;
}

async function createMultiRootFixture() {
  const agentWorkspaceDir = await fixtureSuite.createCaseDir("agent-workspace");
  const executionWorkspaceDir = await fixtureSuite.createCaseDir("execution-workspace");
  for (const [workspaceDir, name, description] of [
    [agentWorkspaceDir, "middle", "Agent middle"],
    [agentWorkspaceDir, "shared", "Agent shared"],
    [executionWorkspaceDir, "aardvark", "Execution aardvark"],
    [executionWorkspaceDir, "shared", "Execution shared"],
    [executionWorkspaceDir, "zulu", "Execution zulu"],
  ] as const) {
    await writeSkill({
      dir: path.join(workspaceDir, "skills", name),
      name,
      description,
    });
  }
  for (const name of ["aardvark", "project-only", "shared"]) {
    await writeSkill({
      dir: path.join(executionWorkspaceDir, ".agents", "skills", name),
      name,
      description: `Project ${name}`,
      body: `# Project ${name} instructions\n`,
    });
  }
  const skillFilter = ["aardvark", "middle", "project-only", "shared", "zulu"];
  const snapshot = withWorkspaceHome(
    agentWorkspaceDir,
    () =>
      resolveReusableWorkspaceSkillSnapshot({
        workspaceDir: agentWorkspaceDir,
        executionWorkspaceDir,
        config: {},
        skillFilter,
        watch: false,
        snapshotVersion: 1,
      }).snapshot,
  );
  return { agentWorkspaceDir, executionWorkspaceDir, skillFilter, snapshot };
}

function expectSnapshotNamesAndPrompt(
  snapshot: ReturnType<typeof buildSkillSnapshot>,
  params: { contains?: string[]; omits?: string[] },
) {
  for (const name of params.contains ?? []) {
    expect(snapshot.skills.map((skill) => skill.name)).toContain(name);
    expect(snapshot.prompt).toContain(name);
  }
  for (const name of params.omits ?? []) {
    expect(snapshot.skills.map((skill) => skill.name)).not.toContain(name);
    expect(snapshot.prompt).not.toContain(name);
  }
}

describe("buildSkillSnapshot", () => {
  it("keeps custodian skills absent from every non-custodian discovery surface", async () => {
    const workspaceDir = await fixtureSuite.createCaseDir("custodian-gate");
    await writeCustodianSkillFixture(workspaceDir);
    const config: OpenClawConfig = {
      agents: {
        defaults: { systemAgent: { agentId: "ops" } },
        entries: { ops: {}, writer: {} },
      },
    };

    const firstCustodianSnapshot = buildAgentSnapshot({ workspaceDir, config, agentId: "ops" });
    const secondCustodianSnapshot = buildAgentSnapshot({ workspaceDir, config, agentId: "ops" });
    const writerSnapshot = buildAgentSnapshot({ workspaceDir, config, agentId: "writer" });
    const custodianStatus = buildWorkspaceSkillStatus(workspaceDir, {
      config,
      agentId: "ops",
      managedSkillsDir: path.join(workspaceDir, ".managed"),
    });
    const writerStatus = buildWorkspaceSkillStatus(workspaceDir, {
      config,
      agentId: "writer",
      managedSkillsDir: path.join(workspaceDir, ".managed"),
    });

    expect(firstCustodianSnapshot.skills.map((skill) => skill.name)).toEqual(CUSTODIAN_SKILL_NAMES);
    expect(firstCustodianSnapshot.resolvedSkills?.map((skill) => skill.source)).toEqual(
      CUSTODIAN_SKILL_NAMES.map(() => "openclaw-custodian"),
    );
    expect(secondCustodianSnapshot.skills).toEqual(firstCustodianSnapshot.skills);
    expect(secondCustodianSnapshot.prompt).toBe(firstCustodianSnapshot.prompt);
    expect(writerSnapshot.skills).toEqual([]);
    expect(writerSnapshot.prompt).toBe("");
    expect(
      custodianStatus.skills
        .filter((skill) => skill.source === "openclaw-custodian")
        .map((skill) => skill.name),
    ).toEqual(CUSTODIAN_SKILL_NAMES);
    expect(writerStatus.skills.filter((skill) => skill.source === "openclaw-custodian")).toEqual(
      [],
    );
  });

  it("mirrors the system-agent resolver fallback when no owner is configured", async () => {
    const workspaceDir = await fixtureSuite.createCaseDir("custodian-owner-fallback");
    await writeCustodianSkillFixture(workspaceDir);

    const soleAgentConfig: OpenClawConfig = {
      agents: { entries: { caretaker: {} } },
    };
    const ambiguousConfig: OpenClawConfig = {
      agents: { entries: { ops: {}, writer: {} } },
    };
    const soleSnapshot = buildAgentSnapshot({
      workspaceDir,
      config: soleAgentConfig,
      agentId: "caretaker",
    });
    const mainSnapshot = buildAgentSnapshot({ workspaceDir, config: {}, agentId: "main" });
    const ambiguousSnapshot = buildAgentSnapshot({
      workspaceDir,
      config: ambiguousConfig,
      agentId: "ops",
    });

    expect(soleSnapshot.skills.map((skill) => skill.name)).toEqual(CUSTODIAN_SKILL_NAMES);
    expect(mainSnapshot.skills.map((skill) => skill.name)).toEqual(CUSTODIAN_SKILL_NAMES);
    expect(ambiguousSnapshot.skills).toEqual([]);
    expect(ambiguousSnapshot.prompt).toBe("");
  });

  it("applies per-skill disabled overrides to custodian skills", async () => {
    const workspaceDir = await fixtureSuite.createCaseDir("custodian-disabled");
    await writeCustodianSkillFixture(workspaceDir);
    const config: OpenClawConfig = {
      agents: {
        defaults: { systemAgent: { agentId: "ops" } },
        entries: { ops: {} },
      },
      skills: {
        entries: {
          "cloud-image-bake": { enabled: false },
        },
      },
    };

    const snapshot = buildAgentSnapshot({ workspaceDir, config, agentId: "ops" });

    expect(snapshot.skills.map((skill) => skill.name)).toEqual([
      "add-model-provider",
      "configure-channel",
      "diagnose-gateway",
    ]);
    expect(snapshot.prompt).not.toContain("cloud-image-bake");
  });

  it("orders agent skills before execution skills with lexical order inside each root", async () => {
    const { snapshot } = await createMultiRootFixture();

    expect(snapshot.skills.map((skill) => skill.name)).toEqual([
      "middle",
      "shared",
      "aardvark",
      "project-only",
      "zulu",
    ]);
    expect(
      [...snapshot.prompt.matchAll(/<name>([^<]+)<\/name>/g)].map((match) => match[1]),
    ).toEqual(["middle", "shared", "aardvark", "project-only", "zulu"]);
    expect(snapshot.resolvedSkills?.find((skill) => skill.name === "aardvark")?.description).toBe(
      "Execution aardvark",
    );
  });

  it("keeps the agent-workspace skill when the execution root has the same name", async () => {
    const { agentWorkspaceDir, snapshot } = await createMultiRootFixture();
    const shared = snapshot.resolvedSkills?.find((skill) => skill.name === "shared");

    expect(shared?.description).toBe("Agent shared");
    expect(shared?.filePath).toBe(path.join(agentWorkspaceDir, "skills", "shared", "SKILL.md"));
  });

  it("keeps canonical same-root snapshots byte-identical", async () => {
    const workspaceDir = await fixtureSuite.createCaseDir("canonical-workspace");
    await writeSkill({
      dir: path.join(workspaceDir, "skills", "canonical"),
      name: "canonical",
      description: "Canonical",
    });
    const build = (executionWorkspaceDir?: string) =>
      withWorkspaceHome(
        workspaceDir,
        () =>
          resolveReusableWorkspaceSkillSnapshot({
            workspaceDir,
            ...(executionWorkspaceDir ? { executionWorkspaceDir } : {}),
            config: {},
            skillFilter: ["canonical"],
            watch: false,
            snapshotVersion: 1,
          }).snapshot,
      );

    expect(JSON.stringify(build(workspaceDir))).toBe(JSON.stringify(build()));
  });

  it.each([false, true])(
    "keeps snapshot and cold fallback skills readable (stale=%s)",
    async (stale) => {
      const { agentWorkspaceDir, executionWorkspaceDir, snapshot } = await createMultiRootFixture();
      const coldSnapshot = { ...snapshot, ...(stale ? { promptFormatVersion: 0 } : {}) };
      delete coldSnapshot.resolvedSkills;
      const fallback = withWorkspaceHome(agentWorkspaceDir, () =>
        resolveEmbeddedRunSkillEntries({
          workspaceDir: agentWorkspaceDir,
          config: {},
          skillsSnapshot: coldSnapshot,
          executionWorkspaceDir,
        }),
      );

      expect(fallback.skillEntries.map((entry) => entry.skill.name)).toEqual(
        snapshot.skills.map((skill) => skill.name),
      );
      expect(fallback.skillEntries.map((entry) => entry.skill.filePath)).toEqual(
        snapshot.resolvedSkills?.map((skill) => skill.filePath),
      );
      const codeModeSkills = resolveCodeModeSkills({
        skillsPrompt: snapshot.prompt,
        candidates: fallback.skillEntries.map((entry) => entry.skill),
      });
      const projectSkill = codeModeSkills.find((skill) => skill.name === "project-only");
      expect(projectSkill).toBeDefined();
      expect(await readCodeModeSkill(projectSkill!)).toContain(
        "# Project project-only instructions",
      );
    },
  );

  it.each([false, true].flatMap((split) => [false, true].map((override) => ({ split, override }))))(
    "honors session skill policy before agent filtering (split=$split, override=$override)",
    async ({ split, override }) => {
      const workspaceDir = await fixtureSuite.createCaseDir("session-policy-agent");
      const executionWorkspaceDir = split
        ? await fixtureSuite.createCaseDir("session-policy-execution")
        : workspaceDir;
      await writeSkill({
        dir: path.join(executionWorkspaceDir, ".agents", "skills", "session-enabled"),
        name: "session-enabled",
        description: "Enabled by the session",
      });
      const snapshot = withWorkspaceHome(
        workspaceDir,
        () =>
          resolveReusableWorkspaceSkillSnapshot({
            workspaceDir,
            executionWorkspaceDir,
            agentId: "main",
            config: { agents: { defaults: { skills: [] } } },
            ...(override
              ? { skillOverrides: { "session-enabled": true } }
              : { skillFilter: ["session-enabled"] }),
            watch: false,
          }).snapshot,
      );
      expect(snapshot.skills.map((skill) => skill.name)).toEqual(["session-enabled"]);
      expect(snapshot.prompt).toContain("Enabled by the session");
    },
  );

  it.each([false, true])(
    "confines sandbox rebuilds to materialized skills (hydrated=%s)",
    async (hydrated) => {
      const { executionWorkspaceDir, snapshot } = await createMultiRootFixture();
      const workspaceDir = await fixtureSuite.createCaseDir("sandbox-materialized");
      const skillDir = path.join(workspaceDir, "skills", "middle");
      await writeSkill({ dir: skillDir, name: "middle", description: "Materialized instructions" });
      const skillsSnapshot = { ...snapshot };
      if (!hydrated) {
        delete skillsSnapshot.resolvedSkills;
      }
      const runtime = withWorkspaceHome(workspaceDir, () =>
        resolveEmbeddedRunSkillEntries({
          workspaceDir,
          executionWorkspaceDir,
          config: {},
          skillsSnapshot,
          workspaceOnly: true,
        }),
      );
      const entries = runtime.loadSkillEntries();
      expect(entries.map((entry) => entry.skill.name)).toEqual(["middle"]);
      expect(entries[0]?.skill.filePath).toBe(path.join(skillDir, "SKILL.md"));
      expect(entries[0]?.skill.description).toBe("Materialized instructions");
    },
  );

  it("invalidates execution project skills without escaping the selected workspace", async () => {
    const agentWorkspaceDir = await fixtureSuite.createCaseDir("agent-root");
    const repo = await fixtureSuite.createCaseDir("repository");
    const executionWorkspaceDir = path.join(repo, "packages", "app");
    const skillDir = path.join(executionWorkspaceDir, ".agents", "skills", "project-only");
    await writeSkill({
      dir: path.join(repo, ".agents", "skills", "ancestor"),
      name: "ancestor",
      description: "Not selected",
    });
    await writeSkill({ dir: skillDir, name: "project-only", description: "Original instructions" });
    await fs.symlink(
      path.join(repo, ".agents", "skills", "ancestor"),
      path.join(executionWorkspaceDir, ".agents", "skills", "escape"),
      directorySymlinkType,
    );
    const params = {
      workspaceDir: agentWorkspaceDir,
      executionWorkspaceDir,
      config: {},
      skillFilter: ["ancestor", "project-only"],
      watch: false,
    };
    const first = withWorkspaceHome(agentWorkspaceDir, () =>
      resolveReusableWorkspaceSkillSnapshot(params),
    );
    expect(first.snapshot.skills.map((skill) => skill.name)).toEqual(["project-only"]);
    await writeSkill({ dir: skillDir, name: "project-only", description: "Updated instructions" });
    bumpSkillsSnapshotVersion({ workspaceDir: agentWorkspaceDir, reason: "watch" });
    const next = withWorkspaceHome(agentWorkspaceDir, () =>
      resolveReusableWorkspaceSkillSnapshot({ ...params, existingSnapshot: first.snapshot }),
    );
    expect(next.shouldRefresh).toBe(true);
    expect(next.snapshot.prompt).toContain("Updated instructions");
    expect(next.snapshot.resolvedSkills?.[0]?.filePath).toBe(path.join(skillDir, "SKILL.md"));
    const sandbox = withWorkspaceHome(agentWorkspaceDir, () =>
      resolveEmbeddedRunSkillEntries({
        workspaceDir: agentWorkspaceDir,
        executionWorkspaceDir,
        config: {},
        workspaceOnly: true,
      }),
    );
    expect(sandbox.skillEntries).toEqual([]);
  });

  it("returns an empty snapshot when skills dirs are missing", async () => {
    const workspaceDir = await fixtureSuite.createCaseDir("workspace");

    const snapshot = buildSnapshot(workspaceDir);

    expect(snapshot.prompt).toBe("");
    expect(snapshot.skills).toStrictEqual([]);
  });

  it("keeps symlinked compatibility skills out of isolated session snapshots", async () => {
    if (!tempHome) {
      throw new Error("temporary home is unavailable");
    }
    const home = await fs.realpath(tempHome.home);
    const workspaceDir = await fixtureSuite.createCaseDir("workspace");
    const compatibilitySkillsDir = path.join(home, ".claude", "skills");
    const personalSkillDir = path.join(compatibilitySkillsDir, "personal-compat");
    await writeSkill({
      dir: personalSkillDir,
      name: "personal-compat",
      description: "Personal compatibility skill",
    });
    await fs.mkdir(path.join(home, ".agents"), { recursive: true });
    await fs.symlink(
      compatibilitySkillsDir,
      path.join(home, ".agents", "skills"),
      directorySymlinkType,
    );
    const buildHomeSnapshot = () =>
      buildSkillSnapshot(workspaceDir, {
        managedSkillsDir: path.join(workspaceDir, ".managed"),
        bundledSkillsDir: path.join(workspaceDir, ".bundled"),
      });
    try {
      const defaultSnapshot = withEnv(
        { HOME: home, OPENCLAW_STATE_DIR: path.join(home, ".openclaw") },
        buildHomeSnapshot,
      );
      expectSnapshotNamesAndPrompt(defaultSnapshot, { contains: ["personal-compat"] });
      expect(defaultSnapshot.resolvedSkills?.[0]?.filePath).toBe(
        await fs.realpath(path.join(personalSkillDir, "SKILL.md")),
      );

      const isolatedSnapshot = withEnv(
        { HOME: home, OPENCLAW_STATE_DIR: path.join(home, "scratch-state") },
        buildHomeSnapshot,
      );
      expectSnapshotNamesAndPrompt(isolatedSnapshot, { omits: ["personal-compat"] });
    } finally {
      await fs.rm(path.join(home, ".agents", "skills"), { force: true });
      await fs.rm(path.join(home, ".claude"), { recursive: true, force: true });
    }
  });

  it("omits disable-model-invocation skills from the prompt", async () => {
    const workspaceDir = await fixtureSuite.createCaseDir("workspace");
    await writeSkill({
      dir: path.join(workspaceDir, "skills", "visible-skill"),
      name: "visible-skill",
      description: "Visible skill",
    });
    await writeSkill({
      dir: path.join(workspaceDir, "skills", "hidden-skill"),
      name: "hidden-skill",
      description: "Hidden skill",
      frontmatterExtra: "disable-model-invocation: true",
    });

    const snapshot = buildSnapshot(workspaceDir);

    expect(snapshot.prompt).toContain("visible-skill");
    expect(snapshot.prompt).not.toContain("hidden-skill");
    expect(snapshot.skills.map((skill) => skill.name)).toContain("hidden-skill");
    expect(snapshot.skills.map((skill) => skill.name)).toContain("visible-skill");
  });

  it("keeps prompt output stable across equivalent snapshot builds", async () => {
    const workspaceDir = await fixtureSuite.createCaseDir("workspace");
    await writeSkill({
      dir: path.join(workspaceDir, "skills", "visible"),
      name: "visible",
      description: "Visible",
    });
    await writeSkill({
      dir: path.join(workspaceDir, "skills", "hidden"),
      name: "hidden",
      description: "Hidden",
      frontmatterExtra: "disable-model-invocation: true",
    });
    const config = {
      skills: {
        limits: {
          maxSkillsInPrompt: 1,
          maxSkillsPromptChars: 200,
        },
      },
    } as const;
    const opts = {
      config,
      managedSkillsDir: path.join(workspaceDir, ".managed"),
      bundledSkillsDir: path.join(workspaceDir, ".bundled"),
      eligibility: {
        remote: {
          platforms: ["linux"],
          hasBin: (_bin: string) => true,
          hasAnyBin: (_bins: string[]) => true,
          note: "Remote note",
        },
      },
    };

    const snapshot = withWorkspaceHome(workspaceDir, () => buildSkillSnapshot(workspaceDir, opts));
    const prompt = withWorkspaceHome(
      workspaceDir,
      () => buildSkillSnapshot(workspaceDir, opts).prompt,
    );

    expect(snapshot.prompt).toBe(prompt);
  });

  it("truncates the skills prompt when it exceeds the configured char budget", async () => {
    const workspaceDir = await cloneTemplateDir(truncationWorkspaceTemplateDir, "workspace");

    const snapshot = withWorkspaceHome(workspaceDir, () =>
      buildSkillSnapshot(workspaceDir, {
        config: {
          skills: {
            limits: {
              maxSkillsInPrompt: 100,
              maxSkillsPromptChars: 700,
            },
          },
        },
        managedSkillsDir: path.join(workspaceDir, ".managed"),
        bundledSkillsDir: path.join(workspaceDir, ".bundled"),
      }),
    );

    expect(snapshot.prompt).toContain("⚠️ Skills truncated");
    expect(snapshot.prompt.length).toBeLessThan(2000);
  });

  it("uses agents.list[].skills as a full replacement for inherited defaults", async () => {
    const workspaceDir = await fixtureSuite.createCaseDir("workspace");
    await writeWorkspaceSkills(workspaceDir, [
      { name: "github", description: "GitHub" },
      { name: "weather", description: "Weather" },
      { name: "docs-search", description: "Docs" },
    ]);

    const snapshot = buildSnapshot(workspaceDir, {
      agentId: "writer",
      config: {
        agents: {
          defaults: {
            skills: ["github", "weather"],
          },
          list: [{ id: "writer", skills: ["docs-search", "github"] }],
        },
      },
    });

    expect(snapshot.skills.map((skill) => skill.name).toSorted()).toEqual([
      "docs-search",
      "github",
    ]);
    expect(snapshot.skillFilter).toEqual(["docs-search", "github"]);
  });
});
