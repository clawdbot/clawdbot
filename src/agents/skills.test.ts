import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
  type OpenClawConfig,
} from "../config/config.js";
import { withPathResolutionEnv } from "../test-utils/env.js";
import { createFixtureSuite } from "../test-utils/fixture-suite.js";
import { createTempHomeEnv, type TempHomeEnv } from "../test-utils/temp-home.js";
import { writeSkill } from "./skills.e2e-test-helpers.js";
import {
  applySkillEnvOverrides,
  applySkillEnvOverridesFromSnapshot,
  buildWorkspaceSkillCommandSpecs,
  buildWorkspaceSkillsPrompt,
  buildWorkspaceSkillSnapshot,
  loadWorkspaceSkillEntries,
} from "./skills.js";
import { getActiveSkillEnvKeys } from "./skills/env-overrides.js";
import {
  restoreMockSkillsHomeEnv,
  setMockSkillsHomeEnv,
  type SkillsHomeEnvSnapshot,
} from "./skills/home-env.test-support.js";

const fixtureSuite = createFixtureSuite("openclaw-skills-suite-");
let tempHome: TempHomeEnv | null = null;
let skillsHomeEnv: SkillsHomeEnvSnapshot | null = null;

const resolveTestSkillDirs = (workspaceDir: string) => ({
  managedSkillsDir: path.join(workspaceDir, ".managed"),
  bundledSkillsDir: path.join(workspaceDir, ".bundled"),
});

const makeWorkspace = async () => await fixtureSuite.createCaseDir("workspace");
const apiKeyField = ["api", "Key"].join("");

function withWorkspaceHome<T>(workspaceDir: string, cb: () => T): T {
  return withPathResolutionEnv(workspaceDir, { PATH: "" }, () => cb());
}

const withClearedEnv = <T>(
  keys: string[],
  run: (original: Record<string, string | undefined>) => T,
): T => {
  const original: Record<string, string | undefined> = {};
  for (const key of keys) {
    original[key] = process.env[key];
    delete process.env[key];
  }

  try {
    return run(original);
  } finally {
    for (const key of keys) {
      const value = original[key];
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
};

async function writeEnvSkill(workspaceDir: string) {
  const skillDir = path.join(workspaceDir, "skills", "env-skill");
  await writeSkill({
    dir: skillDir,
    name: "env-skill",
    description: "Needs env",
    metadata: '{"openclaw":{"requires":{"env":["ENV_KEY"]},"primaryEnv":"ENV_KEY"}}',
  });
}

beforeAll(async () => {
  await fixtureSuite.setup();
  tempHome = await createTempHomeEnv("openclaw-skills-home-");
  skillsHomeEnv = setMockSkillsHomeEnv(tempHome.home);
  await fs.mkdir(path.join(tempHome.home, ".openclaw", "agents", "main", "sessions"), {
    recursive: true,
  });
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

afterEach(() => {
  clearRuntimeConfigSnapshot();
});

describe("buildWorkspaceSkillCommandSpecs", () => {
  it("sanitizes and de-duplicates command names", async () => {
    const workspaceDir = await makeWorkspace();
    await writeSkill({
      dir: path.join(workspaceDir, "skills", "hello-world"),
      name: "hello-world",
      description: "Hello world skill",
    });
    await writeSkill({
      dir: path.join(workspaceDir, "skills", "hello_world"),
      name: "hello_world",
      description: "Hello underscore skill",
    });
    await writeSkill({
      dir: path.join(workspaceDir, "skills", "help"),
      name: "help",
      description: "Help skill",
    });
    await writeSkill({
      dir: path.join(workspaceDir, "skills", "hidden"),
      name: "hidden-skill",
      description: "Hidden skill",
      frontmatterExtra: "user-invocable: false",
    });

    const commands = withWorkspaceHome(workspaceDir, () =>
      buildWorkspaceSkillCommandSpecs(workspaceDir, {
        ...resolveTestSkillDirs(workspaceDir),
        reservedNames: new Set(["help"]),
      }),
    );

    const names = commands.map((entry) => entry.name).toSorted();
    expect(names).toEqual(["hello_world", "hello_world_2", "help_2"]);
    expect(commands.find((entry) => entry.skillName === "hidden-skill")).toBeUndefined();
  });

  it("truncates descriptions longer than 100 characters for Discord compatibility", async () => {
    const workspaceDir = await makeWorkspace();
    const longDescription =
      "This is a very long description that exceeds Discord's 100 character limit for slash command descriptions and should be truncated";
    await writeSkill({
      dir: path.join(workspaceDir, "skills", "long-desc"),
      name: "long-desc",
      description: longDescription,
    });
    await writeSkill({
      dir: path.join(workspaceDir, "skills", "short-desc"),
      name: "short-desc",
      description: "Short description",
    });

    const commands = buildWorkspaceSkillCommandSpecs(
      workspaceDir,
      resolveTestSkillDirs(workspaceDir),
    );

    const longCmd = commands.find((entry) => entry.skillName === "long-desc");
    const shortCmd = commands.find((entry) => entry.skillName === "short-desc");

    expect(longCmd?.description.length).toBeLessThanOrEqual(100);
    expect(longCmd?.description.endsWith("…")).toBe(true);
    expect(shortCmd?.description).toBe("Short description");
  });

  it("includes tool-dispatch metadata from frontmatter", async () => {
    const workspaceDir = await makeWorkspace();
    await writeSkill({
      dir: path.join(workspaceDir, "skills", "tool-dispatch"),
      name: "tool-dispatch",
      description: "Dispatch to a tool",
      frontmatterExtra: "command-dispatch: tool\ncommand-tool: sessions_send",
    });

    const commands = buildWorkspaceSkillCommandSpecs(
      workspaceDir,
      resolveTestSkillDirs(workspaceDir),
    );
    const cmd = commands.find((entry) => entry.skillName === "tool-dispatch");
    expect(cmd?.dispatch).toEqual({ kind: "tool", toolName: "sessions_send", argMode: "raw" });
  });

  it("inherits agents.defaults.skills when agentId is provided", async () => {
    const workspaceDir = await makeWorkspace();
    await writeSkill({
      dir: path.join(workspaceDir, "skills", "alpha-skill"),
      name: "alpha-skill",
      description: "Alpha skill",
    });
    await writeSkill({
      dir: path.join(workspaceDir, "skills", "beta-skill"),
      name: "beta-skill",
      description: "Beta skill",
    });

    const commands = buildWorkspaceSkillCommandSpecs(workspaceDir, {
      ...resolveTestSkillDirs(workspaceDir),
      config: {
        agents: {
          defaults: {
            skills: ["alpha-skill"],
          },
          list: [{ id: "writer", workspace: workspaceDir }],
        },
      },
      agentId: "writer",
    });

    expect(commands.map((entry) => entry.skillName)).toEqual(["alpha-skill"]);
  });

  it("includes enabled Claude bundle markdown commands as native OpenClaw slash commands", async () => {
    const workspaceDir = await makeWorkspace();
    const pluginRoot = path.join(tempHome!.home, ".openclaw", "extensions", "compound-bundle");
    await fs.mkdir(path.join(pluginRoot, ".claude-plugin"), { recursive: true });
    await fs.mkdir(path.join(pluginRoot, "commands"), { recursive: true });
    await fs.writeFile(
      path.join(pluginRoot, ".claude-plugin", "plugin.json"),
      `${JSON.stringify({ name: "compound-bundle" }, null, 2)}\n`,
      "utf-8",
    );
    await fs.writeFile(
      path.join(pluginRoot, "commands", "workflows-review.md"),
      [
        "---",
        "name: workflows:review",
        "description: Review code with a structured checklist",
        "---",
        "Review the branch carefully.",
        "",
      ].join("\n"),
      "utf-8",
    );

    const commands = buildWorkspaceSkillCommandSpecs(workspaceDir, {
      ...resolveTestSkillDirs(workspaceDir),
      config: {
        plugins: {
          entries: {
            "compound-bundle": { enabled: true },
          },
        },
      },
    });

    expect(commands).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "workflows_review",
          skillName: "workflows:review",
          description: "Review code with a structured checklist",
          promptTemplate: "Review the branch carefully.",
        }),
      ]),
    );
    expect(
      commands.find((entry) => entry.skillName === "workflows:review")?.sourceFilePath,
    ).toContain(path.join(pluginRoot, "commands", "workflows-review.md"));
  });
});

describe("buildWorkspaceSkillsPrompt", () => {
  it("returns empty prompt when skills dirs are missing", async () => {
    const workspaceDir = await makeWorkspace();

    const prompt = withWorkspaceHome(workspaceDir, () =>
      buildWorkspaceSkillsPrompt(workspaceDir, resolveTestSkillDirs(workspaceDir)),
    );

    expect(prompt).toBe("");
  });

  it("loads bundled skills when present", async () => {
    const workspaceDir = await makeWorkspace();
    const bundledDir = path.join(workspaceDir, ".bundled");
    const bundledSkillDir = path.join(bundledDir, "peekaboo");

    await writeSkill({
      dir: bundledSkillDir,
      name: "peekaboo",
      description: "Capture UI",
      body: "# Peekaboo\n",
    });

    const prompt = buildWorkspaceSkillsPrompt(workspaceDir, {
      managedSkillsDir: path.join(workspaceDir, ".managed"),
      bundledSkillsDir: bundledDir,
    });
    expect(prompt).toContain("peekaboo");
    expect(prompt).toContain("Capture UI");
    expect(prompt).toContain(path.join(bundledSkillDir, "SKILL.md"));
  });

  it("loads extra skill folders from config (lowest precedence)", async () => {
    const workspaceDir = await makeWorkspace();
    const extraDir = path.join(workspaceDir, ".extra");
    const bundledDir = path.join(workspaceDir, ".bundled");
    const managedDir = path.join(workspaceDir, ".managed");

    await writeSkill({
      dir: path.join(extraDir, "demo-skill"),
      name: "demo-skill",
      description: "Extra version",
      body: "# Extra\n",
    });
    await writeSkill({
      dir: path.join(bundledDir, "demo-skill"),
      name: "demo-skill",
      description: "Bundled version",
      body: "# Bundled\n",
    });
    await writeSkill({
      dir: path.join(managedDir, "demo-skill"),
      name: "demo-skill",
      description: "Managed version",
      body: "# Managed\n",
    });
    await writeSkill({
      dir: path.join(workspaceDir, "skills", "demo-skill"),
      name: "demo-skill",
      description: "Workspace version",
      body: "# Workspace\n",
    });

    const prompt = buildWorkspaceSkillsPrompt(workspaceDir, {
      bundledSkillsDir: bundledDir,
      managedSkillsDir: managedDir,
      config: { skills: { load: { extraDirs: [extraDir] } } },
    });

    expect(prompt).toContain("Workspace version");
    expect(prompt).not.toContain("Managed version");
    expect(prompt).not.toContain("Bundled version");
    expect(prompt).not.toContain("Extra version");
  });

  it("loads skills from workspace skills/", async () => {
    const workspaceDir = await makeWorkspace();
    const skillDir = path.join(workspaceDir, "skills", "demo-skill");

    await writeSkill({
      dir: skillDir,
      name: "demo-skill",
      description: "Does demo things",
      body: "# Demo Skill\n",
    });

    const prompt = buildWorkspaceSkillsPrompt(workspaceDir, resolveTestSkillDirs(workspaceDir));
    expect(prompt).toContain("demo-skill");
    expect(prompt).toContain("Does demo things");
    expect(prompt).toContain(path.join(skillDir, "SKILL.md"));
  });

  it("omits disable-model-invocation skills from available_skills for freshly loaded entries", async () => {
    const workspaceDir = await makeWorkspace();
    const skillDir = path.join(workspaceDir, "skills", "hidden-skill");

    await writeSkill({
      dir: skillDir,
      name: "hidden-skill",
      description: "Hidden from the prompt",
      frontmatterExtra: "disable-model-invocation: true",
    });

    const prompt = buildWorkspaceSkillsPrompt(workspaceDir, resolveTestSkillDirs(workspaceDir));

    expect(prompt).not.toContain("hidden-skill");
    expect(prompt).not.toContain("Hidden from the prompt");
    expect(prompt).not.toContain(path.join(skillDir, "SKILL.md"));
  });
});

describe("applySkillEnvOverrides", () => {
  it("sets and restores env vars", async () => {
    const workspaceDir = await makeWorkspace();
    await writeEnvSkill(workspaceDir);

    const entries = loadWorkspaceSkillEntries(workspaceDir, resolveTestSkillDirs(workspaceDir));

    withClearedEnv(["ENV_KEY"], () => {
      const restore = applySkillEnvOverrides({
        skills: entries,
        config: { skills: { entries: { "env-skill": { apiKey: "injected" } } } }, // pragma: allowlist secret
      });

      try {
        expect(process.env.ENV_KEY).toBe("injected");
        expect(getActiveSkillEnvKeys().has("ENV_KEY")).toBe(true);
      } finally {
        restore();
        expect(process.env.ENV_KEY).toBeUndefined();
        expect(getActiveSkillEnvKeys().has("ENV_KEY")).toBe(false);
      }
    });
  });

  it("keeps env keys tracked until all overlapping overrides restore", async () => {
    const workspaceDir = await makeWorkspace();
    await writeEnvSkill(workspaceDir);

    const entries = loadWorkspaceSkillEntries(workspaceDir, resolveTestSkillDirs(workspaceDir));

    withClearedEnv(["ENV_KEY"], () => {
      const config = { skills: { entries: { "env-skill": { [apiKeyField]: "injected" } } } }; // pragma: allowlist secret
      const restoreFirst = applySkillEnvOverrides({ skills: entries, config });
      const restoreSecond = applySkillEnvOverrides({ skills: entries, config });

      try {
        expect(process.env.ENV_KEY).toBe("injected");
        expect(getActiveSkillEnvKeys().has("ENV_KEY")).toBe(true);

        restoreFirst();
        expect(process.env.ENV_KEY).toBe("injected");
        expect(getActiveSkillEnvKeys().has("ENV_KEY")).toBe(true);
      } finally {
        restoreSecond();
        expect(process.env.ENV_KEY).toBeUndefined();
        expect(getActiveSkillEnvKeys().has("ENV_KEY")).toBe(false);
      }
    });
  });

  it("applies env overrides from snapshots", async () => {
    const workspaceDir = await makeWorkspace();
    await writeEnvSkill(workspaceDir);

    const snapshot = buildWorkspaceSkillSnapshot(workspaceDir, {
      ...resolveTestSkillDirs(workspaceDir),
      config: { skills: { entries: { "env-skill": { apiKey: "snap-key" } } } }, // pragma: allowlist secret
    });

    withClearedEnv(["ENV_KEY"], () => {
      const restore = applySkillEnvOverridesFromSnapshot({
        snapshot,
        config: { skills: { entries: { "env-skill": { apiKey: "snap-key" } } } }, // pragma: allowlist secret
      });

      try {
        expect(process.env.ENV_KEY).toBe("snap-key");
      } finally {
        restore();
        expect(process.env.ENV_KEY).toBeUndefined();
      }
    });
  });

  it("prefers the active runtime snapshot over raw SecretRef skill config", async () => {
    const workspaceDir = await makeWorkspace();
    await writeEnvSkill(workspaceDir);

    const entries = loadWorkspaceSkillEntries(workspaceDir, resolveTestSkillDirs(workspaceDir));
    const sourceConfig: OpenClawConfig = {
      skills: {
        entries: {
          "env-skill": {
            apiKey: {
              source: "file",
              provider: "default",
              id: "/skills/entries/env-skill/apiKey",
            },
          },
        },
      },
    };
    const runtimeConfig: OpenClawConfig = {
      skills: {
        entries: {
          "env-skill": {
            apiKey: "resolved-key",
          },
        },
      },
    };
    setRuntimeConfigSnapshot(runtimeConfig, sourceConfig);

    withClearedEnv(["ENV_KEY"], () => {
      const restore = applySkillEnvOverrides({
        skills: entries,
        config: sourceConfig,
      });

      try {
        expect(process.env.ENV_KEY).toBe("resolved-key");
      } finally {
        restore();
        expect(process.env.ENV_KEY).toBeUndefined();
      }
    });
  });

  it("prefers resolved caller skill config when the active runtime snapshot is still raw", async () => {
    const workspaceDir = await makeWorkspace();
    await writeEnvSkill(workspaceDir);

    const entries = loadWorkspaceSkillEntries(workspaceDir, resolveTestSkillDirs(workspaceDir));
    const sourceConfig: OpenClawConfig = {
      skills: {
        entries: {
          "env-skill": {
            apiKey: {
              source: "file",
              provider: "default",
              id: "/skills/entries/env-skill/apiKey",
            },
          },
        },
      },
    };
    const callerConfig: OpenClawConfig = {
      skills: {
        entries: {
          "env-skill": {
            apiKey: "resolved-key",
          },
        },
      },
    };
    setRuntimeConfigSnapshot(sourceConfig, sourceConfig);

    withClearedEnv(["ENV_KEY"], () => {
      const restore = applySkillEnvOverrides({
        skills: entries,
        config: callerConfig,
      });

      try {
        expect(process.env.ENV_KEY).toBe("resolved-key");
      } finally {
        restore();
        expect(process.env.ENV_KEY).toBeUndefined();
      }
    });
  });

  it("does not resolve raw skill apiKey refs when the host already provides primaryEnv", async () => {
    const workspaceDir = await makeWorkspace();
    await writeEnvSkill(workspaceDir);

    const entries = loadWorkspaceSkillEntries(workspaceDir, resolveTestSkillDirs(workspaceDir));

    withClearedEnv(["ENV_KEY"], () => {
      process.env.ENV_KEY = "host-key";
      const restore = applySkillEnvOverrides({
        skills: entries,
        config: {
          skills: {
            entries: {
              "env-skill": {
                apiKey: {
                  source: "env",
                  provider: "default",
                  id: "OPENAI_API_KEY",
                },
              },
            },
          },
        },
      });

      try {
        expect(process.env.ENV_KEY).toBe("host-key");
      } finally {
        restore();
        expect(process.env.ENV_KEY).toBe("host-key");
        delete process.env.ENV_KEY;
      }
    });
  });

  it("blocks unsafe env overrides but allows declared secrets", async () => {
    const workspaceDir = await makeWorkspace();
    const skillDir = path.join(workspaceDir, "skills", "unsafe-env-skill");
    await writeSkill({
      dir: skillDir,
      name: "unsafe-env-skill",
      description: "Needs env",
      metadata:
        '{"openclaw":{"requires":{"env":["OPENAI_API_KEY","NODE_OPTIONS"]},"primaryEnv":"OPENAI_API_KEY"}}',
    });

    const entries = loadWorkspaceSkillEntries(workspaceDir, resolveTestSkillDirs(workspaceDir));

    withClearedEnv(["OPENAI_API_KEY", "NODE_OPTIONS"], () => {
      const restore = applySkillEnvOverrides({
        skills: entries,
        config: {
          skills: {
            entries: {
              "unsafe-env-skill": {
                env: {
                  OPENAI_API_KEY: "sk-test", // pragma: allowlist secret
                  NODE_OPTIONS: "--require /tmp/evil.js",
                },
              },
            },
          },
        },
      });

      try {
        expect(process.env.OPENAI_API_KEY).toBe("sk-test");
        expect(process.env.NODE_OPTIONS).toBeUndefined();
      } finally {
        restore();
        expect(process.env.OPENAI_API_KEY).toBeUndefined();
        expect(process.env.NODE_OPTIONS).toBeUndefined();
      }
    });
  });

  it("blocks dangerous host env overrides even when declared", async () => {
    const workspaceDir = await makeWorkspace();
    const skillDir = path.join(workspaceDir, "skills", "dangerous-env-skill");
    await writeSkill({
      dir: skillDir,
      name: "dangerous-env-skill",
      description: "Needs env",
      metadata: '{"openclaw":{"requires":{"env":["BASH_ENV","SHELL"]}}}',
    });

    const entries = loadWorkspaceSkillEntries(workspaceDir, resolveTestSkillDirs(workspaceDir));

    withClearedEnv(["BASH_ENV", "SHELL"], () => {
      const restore = applySkillEnvOverrides({
        skills: entries,
        config: {
          skills: {
            entries: {
              "dangerous-env-skill": {
                env: {
                  BASH_ENV: "/tmp/pwn.sh",
                  SHELL: "/tmp/evil-shell",
                },
              },
            },
          },
        },
      });

      try {
        expect(process.env.BASH_ENV).toBeUndefined();
        expect(process.env.SHELL).toBeUndefined();
      } finally {
        restore();
        expect(process.env.BASH_ENV).toBeUndefined();
        expect(process.env.SHELL).toBeUndefined();
      }
    });
  });

  it("blocks override-only host env overrides in skill config", async () => {
    const workspaceDir = await makeWorkspace();
    const skillDir = path.join(workspaceDir, "skills", "override-env-skill");
    await writeSkill({
      dir: skillDir,
      name: "override-env-skill",
      description: "Needs env",
      metadata:
        '{"openclaw":{"requires":{"env":["HTTPS_PROXY","NODE_TLS_REJECT_UNAUTHORIZED","DOCKER_HOST"]}}}',
    });

    const entries = loadWorkspaceSkillEntries(workspaceDir, resolveTestSkillDirs(workspaceDir));

    withClearedEnv(["HTTPS_PROXY", "NODE_TLS_REJECT_UNAUTHORIZED", "DOCKER_HOST"], () => {
      const restore = applySkillEnvOverrides({
        skills: entries,
        config: {
          skills: {
            entries: {
              "override-env-skill": {
                env: {
                  HTTPS_PROXY: "http://proxy.example.test:8080",
                  NODE_TLS_REJECT_UNAUTHORIZED: "0",
                  DOCKER_HOST: "tcp://docker.example.test:2376",
                },
              },
            },
          },
        },
      });

      try {
        expect(process.env.HTTPS_PROXY).toBeUndefined();
        expect(process.env.NODE_TLS_REJECT_UNAUTHORIZED).toBeUndefined();
        expect(process.env.DOCKER_HOST).toBeUndefined();
      } finally {
        restore();
        expect(process.env.HTTPS_PROXY).toBeUndefined();
        expect(process.env.NODE_TLS_REJECT_UNAUTHORIZED).toBeUndefined();
        expect(process.env.DOCKER_HOST).toBeUndefined();
      }
    });
  });

  it("allows required env overrides from snapshots", async () => {
    const workspaceDir = await makeWorkspace();
    const skillDir = path.join(workspaceDir, "skills", "snapshot-env-skill");
    await writeSkill({
      dir: skillDir,
      name: "snapshot-env-skill",
      description: "Needs env",
      metadata: '{"openclaw":{"requires":{"env":["OPENAI_API_KEY"]}}}',
    });

    const config = {
      skills: {
        entries: {
          "snapshot-env-skill": {
            env: {
              OPENAI_API_KEY: "snap-secret", // pragma: allowlist secret
            },
          },
        },
      },
    };
    const snapshot = buildWorkspaceSkillSnapshot(workspaceDir, {
      ...resolveTestSkillDirs(workspaceDir),
      config,
    });

    withClearedEnv(["OPENAI_API_KEY"], () => {
      const restore = applySkillEnvOverridesFromSnapshot({
        snapshot,
        config,
      });

      try {
        expect(process.env.OPENAI_API_KEY).toBe("snap-secret");
      } finally {
        restore();
        expect(process.env.OPENAI_API_KEY).toBeUndefined();
      }
    });
  });
});
