import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { buildSkillSnapshot } from "../../skills/loading/workspace-skill-prompt.js";
import { readCodeModeSkill, resolveCodeModeSkills } from "../code-mode-skills.js";
import type {
  SandboxBackendHandle,
  SandboxCapabilityRootDiscovery,
} from "./backend-handle.types.js";
import {
  mergeSandboxEnvironmentSkillCatalog,
  prepareSandboxEnvironmentSkills,
} from "./environment-skills.js";
import { createLocalRemoteShellScriptRunner } from "./remote-fs-bridge.test-helpers.js";
import { createSandboxTestContext } from "./test-fixtures.js";

function declaration(
  name: string,
  frontmatter = "",
  location = `/sandbox/catalog/${name}/SKILL.md`,
) {
  return {
    instructions: {
      path: location,
      contents: `---\nname: ${name}\ndescription: Use ${name}\n${frontmatter}---\nFull instructions for ${name}.`,
    },
  };
}
function discovery(
  skills: NonNullable<SandboxCapabilityRootDiscovery["skills"]>,
): SandboxCapabilityRootDiscovery[] {
  return [{ id: "workspace", path: "/sandbox", skills }];
}

describe("environment skill policy and catalogs", () => {
  let root: string;
  const warn = vi.fn();
  const runShellCommand = vi.fn<SandboxBackendHandle["runShellCommand"]>();
  const backend: SandboxBackendHandle = {
    id: "test-environment",
    runtimeId: "test",
    runtimeLabel: "test",
    workdir: "/sandbox",
    capabilities: {
      environment: {
        protocolVersion: 1,
        process: true,
        filesystem: true,
        capabilityRootDiscovery: true,
      },
    },
    runShellCommand,
    buildExecSpec: async () => {
      throw new Error("not used");
    },
  };
  beforeEach(async () => {
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "environment-skills-")));
    warn.mockReset();
    runShellCommand.mockReset().mockResolvedValue({
      code: 0,
      stderr: Buffer.alloc(0),
      stdout: Buffer.from(
        JSON.stringify({ platform: "linux", bins: ["remote-tool"], env: ["REMOTE_READY"] }),
      ),
    });
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });
  function sandbox() {
    return createSandboxTestContext({
      overrides: {
        workspaceDir: root,
        agentWorkspaceDir: root,
        containerWorkdir: "/sandbox",
        backend,
      },
    });
  }
  async function prepare(skills: NonNullable<SandboxCapabilityRootDiscovery["skills"]>) {
    return await prepareSandboxEnvironmentSkills({
      sandbox: sandbox(),
      discoveries: discovery(skills),
      warn,
    });
  }

  it("uses existing invocation/config/agent policy and executor requirements, never Gateway facts", async () => {
    vi.stubEnv("HOST_ONLY", "present");
    const entries = await prepare([
      declaration(
        "available",
        "metadata: { openclaw: { requires: { bins: ['remote-tool'], env: ['REMOTE_READY'] }, os: ['linux'] } }\n",
      ),
      declaration("disabled"),
      declaration("agent-denied"),
      declaration("hidden", "disable-model-invocation: true\n"),
      declaration("host-env", "metadata: { openclaw: { requires: { env: ['HOST_ONLY'] } } }\n"),
      declaration("host-bin", "metadata: { openclaw: { requires: { bins: ['node'] } } }\n"),
      declaration("wrong-os", "metadata: { openclaw: { os: ['darwin'] } }\n"),
    ]);
    const config: OpenClawConfig = {
      agents: {
        list: [
          {
            id: "main",
            skills: ["available", "disabled", "hidden", "host-env", "host-bin", "wrong-os"],
          },
        ],
      },
      skills: { entries: { disabled: { enabled: false } } },
    };
    const merged = mergeSandboxEnvironmentSkillCatalog({
      skillsPrompt: "",
      candidates: [],
      environmentEntries: entries,
      config,
      agentId: "main",
      workspaceDir: root,
      warn,
    });
    expect(resolveCodeModeSkills(merged).map((skill) => skill.name)).toEqual(["available"]);
    expect(merged.skillsPrompt).not.toContain("Full instructions");
    expect(runShellCommand).toHaveBeenCalledOnce();
  });

  it("keeps native catalog priority, honors session overlay, and bounds the merged prompt", async () => {
    const entries = await prepare(
      Array.from({ length: 64 }, (_, index) => declaration(`skill-${index}`)),
    );
    const native = buildSkillSnapshot(root, { entries: [entries[0]!] });
    const merged = mergeSandboxEnvironmentSkillCatalog({
      skillsPrompt: native.prompt,
      candidates: native.resolvedSkills!,
      environmentEntries: entries,
      config: { skills: { limits: { maxSkillsPromptChars: 1800 } } },
      agentId: "main",
      workspaceDir: root,
      snapshot: { ...native, skillOverrides: { "skill-1": false } },
      remoteNote: "Native remote execution guidance.",
      warn,
    });
    const catalog = resolveCodeModeSkills(merged);
    expect(catalog[0]?.name).toBe("skill-0");
    expect(catalog.filter((skill) => skill.name === "skill-0")).toHaveLength(1);
    expect(catalog.some((skill) => skill.name === "skill-1")).toBe(false);
    expect(merged.skillsPrompt.length).toBeLessThanOrEqual(1800);
    expect(merged.skillsPrompt).toContain("Native remote execution guidance.");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("collision"));
  });

  it("does not reinterpret host-projected instructions, even when returned by discovery", async () => {
    await fs.mkdir(path.join(root, "skills/host"), { recursive: true });
    const context = sandbox();
    context.readOnlyResourceMounts = [
      { hostPath: `${root}/resource`, containerPath: "/sandbox/resource" },
    ];
    const entries = await prepareSandboxEnvironmentSkills({
      sandbox: context,
      warn,
      discoveries: discovery([
        declaration("host", "", "/sandbox/skills/host/SKILL.md"),
        declaration("materialized", "", "/sandbox/.openclaw/sandbox-skills/skills/x/SKILL.md"),
        declaration("resource", "", "/sandbox/resource/SKILL.md"),
        declaration("remote"),
      ]),
    });
    expect(entries.map((entry) => entry.skill.name)).toEqual(["remote"]);
  });

  it("isolates malformed and oversized skills and exposes valid remote paths to the existing reader", async () => {
    const entries = await prepare([
      declaration("valid"),
      declaration("escape", "", "/sandbox/../outside/SKILL.md"),
      declaration("invalid", 'metadata: { openclaw: { requires: { bins: ["bad;command"] } } }\n'),
      { instructions: { path: "/sandbox/oversized/SKILL.md", contents: "x".repeat(65537) } },
    ]);
    expect(entries.map((entry) => entry.skill.name)).toEqual(["valid"]);
    const snapshot = buildSkillSnapshot(root, { entries });
    const reader = vi.fn(async () => "whole remote instructions");
    const skills = resolveCodeModeSkills({
      skillsPrompt: snapshot.prompt,
      candidates: snapshot.resolvedSkills!,
      reader,
    });
    await expect(readCodeModeSkill(skills[0]!)).resolves.toBe("whole remote instructions");
    expect(reader).toHaveBeenCalledWith({
      location: "/sandbox/catalog/valid/SKILL.md",
      signal: undefined,
    });
    expect(warn).toHaveBeenCalled();
  });

  it("keeps a failed requirements probe scoped to environment skills and does not swallow abort", async () => {
    runShellCommand.mockRejectedValueOnce(new Error("sensitive remote error"));
    await expect(prepare([declaration("demo")])).resolves.toEqual([]);
    expect(warn).toHaveBeenCalledWith(
      "Environment skills unavailable: runtime requirements probe failed.",
    );
    expect(JSON.stringify(warn.mock.calls)).not.toContain("sensitive");
    await expect(
      prepareSandboxEnvironmentSkills({
        sandbox: sandbox(),
        discoveries: discovery([declaration("demo")]),
        warn,
        signal: AbortSignal.abort(),
      }),
    ).rejects.toThrow();
  });

  it.runIf(process.platform !== "win32")(
    "runs the actual bounded requirements probe without returning environment values",
    async () => {
      runShellCommand.mockImplementation(createLocalRemoteShellScriptRunner());
      const entries = await prepare([
        declaration(
          "probe",
          "metadata: { openclaw: { requires: { bins: ['python3'], env: ['PATH'] } } }\n",
        ),
      ]);
      expect(entries[0]?.environment?.bins).toContain("python3");
      expect(entries[0]?.environment?.env).toEqual(["PATH"]);
      expect(JSON.stringify(entries[0]?.environment)).not.toContain(process.env.PATH);
    },
  );
});
