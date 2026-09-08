/** Tests Code Mode skills and read tools. */

import fs from "node:fs/promises";
import os from "node:os";
import nodePath from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Skill } from "../skills/loading/skill-contract.js";
import { resolveSkillsPrompt } from "../skills/loading/workspace-skill-prompt.js";
import { createFixtureSkillEntry } from "../skills/test-support/test-helpers.js";
import { createOpenClawReadTool } from "./agent-tools.read.js";
import {
  readCodeModeSkill,
  resolveCodeModeSkills,
  type CodeModeSkill,
} from "./code-mode-skills.js";
import { applyCodeModeCatalog } from "./code-mode.js";
import {
  resetCodeModeTestState,
  pluginTool,
  createCodeModeHarness,
  runUntilCompleted,
} from "./code-mode.test-support.js";
import { createReadTool } from "./sessions/index.js";

function skillCandidate(params: {
  name: string;
  description: string;
  filePath: string;
  readContent?: string;
  hostFilePath?: string;
}): Skill {
  return {
    ...params,
    baseDir: params.filePath.replace(/\/[^/]+$/u, ""),
    sourceInfo: {
      path: params.filePath,
      source: "test",
      scope: "temporary",
      origin: "top-level",
    },
    disableModelInvocation: false,
    source: "test",
  };
}

function resolveFilesystemCodeModeSkill(filePath: string): CodeModeSkill {
  const name = "demo";
  return expectDefined(
    resolveCodeModeSkills({
      skillsPrompt: [
        "<available_skills>",
        "  <skill>",
        `    <name>${name}</name>`,
        "    <description>Demo</description>",
        `    <location>${filePath}</location>`,
        "  </skill>",
        "</available_skills>",
      ].join("\n"),
      candidates: [skillCandidate({ name, description: "Demo skill", filePath })],
    })[0],
    "filesystem Code Mode skill test invariant",
  );
}

describe("Code Mode skills and read tools", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    resetCodeModeTestState();
  });

  it("keeps Code Mode skill parsing aligned with the production prompt renderer", () => {
    const entries = [createFixtureSkillEntry("alpha"), createFixtureSkillEntry("beta")];
    const skillsPrompt = resolveSkillsPrompt({
      entries,
      workspaceDir: "/workspace",
    });

    expect(
      resolveCodeModeSkills({
        skillsPrompt,
        candidates: entries.map((entry) => entry.skill),
      }).map(({ name, location }) => ({ name, location })),
    ).toEqual([
      { name: "alpha", location: "/skills/alpha/SKILL.md" },
      { name: "beta", location: "/skills/beta/SKILL.md" },
    ]);
  });

  it("lists and reads only prompt-eligible skills through the worker bridge", async () => {
    const demo = skillCandidate({
      name: "demo",
      description: "Full demo description",
      filePath: "/host/skills/demo/SKILL.md",
    });
    const hidden = skillCandidate({
      name: "hidden",
      description: "Hidden skill",
      filePath: "/host/skills/hidden/SKILL.md",
    });
    const reader = vi.fn(async ({ location }: { location: string }) =>
      location === "/guest/skills/demo/SKILL.md"
        ? "---\nname: demo\n---\n\n# Complete demo instructions\n"
        : "# Hidden\n",
    );
    const codeModeSkills = resolveCodeModeSkills({
      skillsPrompt: [
        "<available_skills>",
        "  <skill>",
        "    <name>demo</name>",
        "    <description>Short prompt description</description>",
        "    <location>/guest/skills/demo/SKILL.md</location>",
        "  </skill>",
        "</available_skills>",
      ].join("\n"),
      candidates: [demo, hidden],
      reader,
    });
    const {
      config,
      catalogRef,
      tools: codeModeTools,
    } = createCodeModeHarness({
      codeModeSkills,
    });
    applyCodeModeCatalog({
      tools: [...codeModeTools, pluginTool("fake_noop", "Noop")],
      config,
      sessionId: "session-code-mode",
      sessionKey: "agent:main:main",
      runId: "run-code-mode",
      catalogRef,
      codeModeSkills,
    });

    const details = await runUntilCompleted({
      execTool: expectDefined(codeModeTools[0], "codeModeTools[0] test invariant"),
      waitTool: expectDefined(codeModeTools[1], "codeModeTools[1] test invariant"),
      code: `
        const listed = await skills.list();
        const body = await skills.read("demo");
        let unknown;
        try {
          await skills.read("missing");
        } catch (error) {
          unknown = error.message;
        }
        return { listed, body, unknown };
      `,
    });

    expect(details.status).toBe("completed");
    expect(details.value).toEqual({
      listed: [
        {
          name: "demo",
          description: "Full demo description",
          location: "/guest/skills/demo/SKILL.md",
        },
      ],
      body: "---\nname: demo\n---\n\n# Complete demo instructions\n",
      unknown: 'Unknown skill "missing". Available skills: demo',
    });
    expect(codeModeTools[0]?.description).toContain("`await skills.read(name)`");
    expect(reader).toHaveBeenCalledOnce();
    expect(reader).toHaveBeenCalledWith({
      location: "/guest/skills/demo/SKILL.md",
      signal: expect.any(AbortSignal),
    });
  });

  it("reads a skill-root relative file and rejects path escape", async () => {
    const tmpParent = await fs.realpath(
      await fs.mkdtemp(nodePath.join(os.tmpdir(), "oc-skill-relative-")),
    );
    const skillRoot = nodePath.join(tmpParent, "demo");
    await fs.mkdir(nodePath.join(skillRoot, "modules"), { recursive: true });
    await fs.writeFile(nodePath.join(skillRoot, "SKILL.md"), "# skill\n", "utf8");
    await fs.writeFile(
      nodePath.join(skillRoot, "modules", "during-dining.md"),
      "# dining module\n",
      "utf8",
    );
    const demo = skillCandidate({
      name: "demo",
      description: "Full demo description",
      filePath: nodePath.join(skillRoot, "SKILL.md"),
    });
    const reader = vi.fn(async () => "# skill from collection reader\n");
    const codeModeSkills = resolveCodeModeSkills({
      skillsPrompt: [
        "<available_skills>",
        "  <skill>",
        "    <name>demo</name>",
        "    <description>Short prompt description</description>",
        "    <location>/guest/skills/demo/SKILL.md</location>",
        "  </skill>",
        "</available_skills>",
      ].join("\n"),
      candidates: [demo],
      reader,
    });
    const {
      config,
      catalogRef,
      tools: codeModeTools,
    } = createCodeModeHarness({
      codeModeSkills,
    });
    applyCodeModeCatalog({
      tools: [...codeModeTools, pluginTool("fake_noop", "Noop")],
      config,
      sessionId: "session-code-mode",
      sessionKey: "agent:main:main",
      runId: "run-code-mode",
      catalogRef,
      codeModeSkills,
    });

    const details = await runUntilCompleted({
      execTool: expectDefined(codeModeTools[0], "codeModeTools[0] test invariant"),
      waitTool: expectDefined(codeModeTools[1], "codeModeTools[1] test invariant"),
      code: `
        const moduleBody = await skills.read("demo", "modules/during-dining.md");
        let escaped;
        try {
          await skills.read("demo", "../secret.md");
        } catch (error) {
          escaped = error.message;
        }
        return { moduleBody, escaped };
      `,
    });

    expect(details.status).toBe("completed");
    expect(details.value).toEqual({
      moduleBody: "# dining module\n",
      escaped: 'invalid skill relative path "../secret.md"',
    });
    expect(reader).not.toHaveBeenCalled();
    expect(codeModeTools[0]?.description).toContain("skills.read(name,");
    await expect(readCodeModeSkill(codeModeSkills[0]!, undefined, "../etc/passwd")).rejects.toThrow(
      /invalid skill relative path/,
    );
    await fs.rm(tmpParent, { recursive: true, force: true });
  });

  it("reads a node-hosted skill module through the locator reader", async () => {
    const reader = vi.fn(async ({ location }: { location: string }) => {
      if (location === "node://node-1/skills/demo/modules/during-dining.md") {
        return "# dining module\n";
      }
      return "# skill\n";
    });
    const skill: CodeModeSkill = {
      name: "demo",
      description: "demo",
      location: "node://node-1/skills/demo/SKILL.md",
      source: {
        filePath: "node://node-1/skills/demo/SKILL.md",
        readContent: "# skill\n",
      },
      reader,
    };
    await expect(readCodeModeSkill(skill, undefined, "modules/during-dining.md")).resolves.toBe(
      "# dining module\n",
    );
    expect(reader).toHaveBeenCalledWith({
      location: "node://node-1/skills/demo/modules/during-dining.md",
      signal: undefined,
    });
    for (const encodedEscape of [
      "%2e%2e/other/SKILL.md",
      "%252e%252e/other/SKILL.md",
      "modules%2f..%2fsecret.md",
    ]) {
      await expect(readCodeModeSkill(skill, undefined, encodedEscape)).rejects.toThrow(
        /invalid skill relative path/,
      );
    }
    expect(reader).toHaveBeenCalledOnce();
    await expect(
      readCodeModeSkill({ ...skill, reader: undefined }, undefined, "modules/x.md"),
    ).rejects.toThrow(/node-hosted skill relative reads require a node skill reader/);
  });

  it("reads a sandbox companion from the materialized host root, not the container locator", async () => {
    const tmpParent = await fs.realpath(
      await fs.mkdtemp(nodePath.join(os.tmpdir(), "oc-skill-sandbox-root-")),
    );
    const hostRoot = nodePath.join(tmpParent, "materialized");
    await fs.mkdir(nodePath.join(hostRoot, "modules"), { recursive: true });
    await fs.writeFile(nodePath.join(hostRoot, "SKILL.md"), "# skill\n", "utf8");
    await fs.writeFile(nodePath.join(hostRoot, "modules", "during-dining.md"), "HOST_OK", "utf8");
    // Unrelated host directory that happens to match the container locator.
    const unrelatedRoot = nodePath.join(tmpParent, "unrelated");
    await fs.mkdir(nodePath.join(unrelatedRoot, "modules"), { recursive: true });
    await fs.writeFile(
      nodePath.join(unrelatedRoot, "modules", "during-dining.md"),
      "UNRELATED",
      "utf8",
    );

    const demo = skillCandidate({
      name: "demo",
      description: "Demo skill",
      filePath: nodePath.join(unrelatedRoot, "SKILL.md"),
      hostFilePath: nodePath.join(hostRoot, "SKILL.md"),
    });
    const codeModeSkills = resolveCodeModeSkills({
      skillsPrompt: [
        "<available_skills>",
        "  <skill>",
        "    <name>demo</name>",
        "    <description>Demo</description>",
        `    <location>${nodePath.join(unrelatedRoot, "SKILL.md")}</location>`,
        "  </skill>",
        "</available_skills>",
      ].join("\n"),
      candidates: [demo],
    });

    expect(codeModeSkills[0]?.source.filePath).toBe(nodePath.join(hostRoot, "SKILL.md"));
    await expect(
      readCodeModeSkill(codeModeSkills[0]!, undefined, "modules/during-dining.md"),
    ).resolves.toBe("HOST_OK");
    await fs.rm(tmpParent, { recursive: true, force: true });
  });

  it("does not advertise companion reads when every selected skill is node-hosted", () => {
    const codeModeSkills: CodeModeSkill[] = [
      {
        name: "demo",
        description: "demo",
        location: "node://node-1/skills/demo/SKILL.md",
        source: {
          filePath: "node://node-1/skills/demo/SKILL.md",
          readContent: "# skill\n",
        },
      },
    ];
    const {
      config,
      catalogRef,
      tools: codeModeTools,
    } = createCodeModeHarness({
      codeModeSkills,
    });
    applyCodeModeCatalog({
      tools: [...codeModeTools, pluginTool("fake_noop", "Noop")],
      config,
      sessionId: "session-code-mode",
      sessionKey: "agent:main:main",
      runId: "run-code-mode",
      catalogRef,
      codeModeSkills,
    });
    expect(codeModeTools[0]?.description).toContain("`await skills.read(name)`");
    expect(codeModeTools[0]?.description).not.toContain("skills.read(name,");
    expect(codeModeTools[0]?.description).toContain("not available for node-hosted skills");
  });

  it.runIf(process.platform !== "win32")(
    "rejects a selected skill root that is rebound before a companion read",
    async () => {
      const tmpParent = await fs.realpath(
        await fs.mkdtemp(nodePath.join(os.tmpdir(), "oc-skill-root-rebind-")),
      );
      const skillRoot = nodePath.join(tmpParent, "demo");
      const selectedRoot = nodePath.join(tmpParent, "selected-demo");
      const replacementRoot = nodePath.join(tmpParent, "replacement");
      await fs.mkdir(skillRoot, { recursive: true });
      await fs.mkdir(nodePath.join(replacementRoot, ".ssh"), { recursive: true });
      await fs.writeFile(nodePath.join(skillRoot, "SKILL.md"), "# selected skill\n", "utf8");
      await fs.writeFile(nodePath.join(replacementRoot, ".ssh", "id_rsa"), "SECRET", "utf8");

      const skill = resolveFilesystemCodeModeSkill(nodePath.join(skillRoot, "SKILL.md"));
      await fs.rename(skillRoot, selectedRoot);
      await fs.symlink(replacementRoot, skillRoot, "dir");

      await expect(readCodeModeSkill(skill, undefined, ".ssh/id_rsa")).rejects.toThrow(
        /escapes skill root/,
      );
      await fs.rm(tmpParent, { recursive: true, force: true });
    },
  );

  it("rejects an oversized companion file before returning it", async () => {
    const tmpParent = await fs.realpath(
      await fs.mkdtemp(nodePath.join(os.tmpdir(), "oc-skill-bound-")),
    );
    const skillRoot = nodePath.join(tmpParent, "demo");
    await fs.mkdir(skillRoot, { recursive: true });
    await fs.writeFile(nodePath.join(skillRoot, "SKILL.md"), "# skill\n", "utf8");
    await fs.writeFile(nodePath.join(skillRoot, "huge.md"), "x".repeat(256_001), "utf8");
    const skill = resolveFilesystemCodeModeSkill(nodePath.join(skillRoot, "SKILL.md"));
    await expect(readCodeModeSkill(skill, undefined, "huge.md")).rejects.toThrow(
      'skill relative file exceeds 256000 bytes: "huge.md"',
    );
    const reader = vi.fn(async () => "y".repeat(256_001));
    await expect(
      readCodeModeSkill(
        {
          name: "demo",
          description: "demo",
          location: "node://node-1/skills/demo/SKILL.md",
          source: {
            filePath: "node://node-1/skills/demo/SKILL.md",
            readContent: "# skill\n",
          },
          reader,
        },
        undefined,
        "modules/huge.md",
      ),
    ).rejects.toThrow(/exceeds 256000 bytes/);
    await fs.rm(tmpParent, { recursive: true, force: true });
  });

  it("preserves missing and directory companion failures through the worker bridge", async () => {
    const tmpParent = await fs.realpath(
      await fs.mkdtemp(nodePath.join(os.tmpdir(), "oc-skill-ops-")),
    );
    const skillRoot = nodePath.join(tmpParent, "demo");
    await fs.mkdir(nodePath.join(skillRoot, "modules"), { recursive: true });
    await fs.writeFile(nodePath.join(skillRoot, "SKILL.md"), "# skill\n", "utf8");
    const demo = skillCandidate({
      name: "demo",
      description: "Full demo description",
      filePath: nodePath.join(skillRoot, "SKILL.md"),
    });
    const codeModeSkills = resolveCodeModeSkills({
      skillsPrompt: [
        "<available_skills>",
        "  <skill>",
        "    <name>demo</name>",
        "    <description>Short prompt description</description>",
        "    <location>/guest/skills/demo/SKILL.md</location>",
        "  </skill>",
        "</available_skills>",
      ].join("\n"),
      candidates: [demo],
    });
    const {
      config,
      catalogRef,
      tools: codeModeTools,
    } = createCodeModeHarness({
      codeModeSkills,
    });
    applyCodeModeCatalog({
      tools: [...codeModeTools, pluginTool("fake_noop", "Noop")],
      config,
      sessionId: "session-code-mode",
      sessionKey: "agent:main:main",
      runId: "run-code-mode",
      catalogRef,
      codeModeSkills,
    });

    const details = await runUntilCompleted({
      execTool: expectDefined(codeModeTools[0], "codeModeTools[0] test invariant"),
      waitTool: expectDefined(codeModeTools[1], "codeModeTools[1] test invariant"),
      code: `
        let missing;
        try {
          await skills.read("demo", "missing.md");
        } catch (error) {
          missing = error.message;
        }
        let directory;
        try {
          await skills.read("demo", "modules");
        } catch (error) {
          directory = error.message;
        }
        return { missing, directory };
      `,
    });

    expect(details.status).toBe("completed");
    const value = details.value as { missing: string; directory: string };
    expect(value.missing).toMatch(/^skill relative file not-found: "missing.md"/);
    expect(value.missing).not.toMatch(/escapes skill root/);
    expect(value.directory).toMatch(/^skill relative file not-file: "modules"/);
    expect(value.directory).not.toMatch(/escapes skill root/);
    await expect(readCodeModeSkill(codeModeSkills[0]!, undefined, "missing.md")).rejects.toThrow(
      /skill relative file not-found/,
    );
    await expect(readCodeModeSkill(codeModeSkills[0]!, undefined, "modules")).rejects.toThrow(
      /skill relative file not-file/,
    );
    await fs.rm(tmpParent, { recursive: true, force: true });
  });

  it.runIf(process.platform !== "win32")(
    "rejects a real symlink that escapes the skill root",
    async () => {
      const tmpParent = await fs.realpath(
        await fs.mkdtemp(nodePath.join(os.tmpdir(), "oc-skill-root-")),
      );
      const skillRoot = nodePath.join(tmpParent, "demo");
      const outside = nodePath.join(tmpParent, "outside.txt");
      await fs.mkdir(nodePath.join(skillRoot, "modules"), { recursive: true });
      await fs.writeFile(nodePath.join(skillRoot, "SKILL.md"), "# skill\n", "utf8");
      await fs.writeFile(
        nodePath.join(skillRoot, "modules", "during-dining.md"),
        "# dining\n",
        "utf8",
      );
      await fs.writeFile(outside, "secret\n", "utf8");
      await fs.symlink(outside, nodePath.join(skillRoot, "modules", "link.md"));
      const skill = resolveFilesystemCodeModeSkill(nodePath.join(skillRoot, "SKILL.md"));
      await expect(readCodeModeSkill(skill, undefined, "modules/during-dining.md")).resolves.toBe(
        "# dining\n",
      );
      await expect(readCodeModeSkill(skill, undefined, "modules/link.md")).rejects.toThrow(
        /escapes skill root/,
      );
      await fs.rm(tmpParent, { recursive: true, force: true });
    },
  );

  it.runIf(process.platform !== "win32")(
    "rejects a hardlink that aliases an inode outside the skill root",
    async () => {
      const tmpParent = await fs.realpath(
        await fs.mkdtemp(nodePath.join(os.tmpdir(), "oc-skill-hardlink-")),
      );
      const skillRoot = nodePath.join(tmpParent, "demo");
      const outside = nodePath.join(tmpParent, "outside.txt");
      await fs.mkdir(nodePath.join(skillRoot, "modules"), { recursive: true });
      await fs.writeFile(nodePath.join(skillRoot, "SKILL.md"), "# skill\n", "utf8");
      await fs.writeFile(outside, "secret\n", "utf8");
      await fs.link(outside, nodePath.join(skillRoot, "modules", "alias.md"));
      const skill = resolveFilesystemCodeModeSkill(nodePath.join(skillRoot, "SKILL.md"));
      await expect(readCodeModeSkill(skill, undefined, "modules/alias.md")).rejects.toThrow(
        /escapes skill root/,
      );
      await fs.rm(tmpParent, { recursive: true, force: true });
    },
  );

  it.each([
    {
      name: "existing ordinary file",
      path: "notes.txt",
      content: "ordinary file content",
      expected: { kind: "text", content: "ordinary file content" },
    },
    {
      name: "missing implicitly optional daily memory",
      path: "memory/2026-05-15.md",
      expected: {
        kind: "not_found",
        status: "not_found",
        path: "memory/2026-05-15.md",
        optional: true,
      },
    },
  ])(
    "returns $name through the wrapped Code Mode boundary",
    async ({ path, content, expected }) => {
      const { config, catalogRef, tools: codeModeTools } = createCodeModeHarness();
      const read = createOpenClawReadTool(
        createReadTool("/workspace", {
          operations: {
            access: async () => {
              if (content === undefined) {
                throw Object.assign(new Error("missing"), { code: "ENOENT" });
              }
            },
            readFile: async () => Buffer.from(content ?? "unreachable"),
          },
        }) as unknown as Parameters<typeof createOpenClawReadTool>[0],
      );
      applyCodeModeCatalog({
        tools: [...codeModeTools, read],
        config,
        sessionId: "session-code-mode",
        sessionKey: "agent:main:main",
        runId: "run-code-mode",
        catalogRef,
      });

      const details = await runUntilCompleted({
        execTool: expectDefined(codeModeTools[0], "codeModeTools[0] test invariant"),
        waitTool: expectDefined(codeModeTools[1], "codeModeTools[1] test invariant"),
        code: `return await read(${JSON.stringify({ path })});`,
      });

      expect(details).toMatchObject({ status: "completed", value: expected });
    },
  );
});
