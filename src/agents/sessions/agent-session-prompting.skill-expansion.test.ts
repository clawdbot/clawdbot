// Focused behavior coverage for `/skill:` expansion honoring the configured size limit.
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { DEFAULT_MAX_SKILL_FILE_BYTES } from "../../skills/loading/bounded-skill-read.js";
import type { Skill } from "../../skills/loading/session.js";
import { AgentSessionPrompting } from "./agent-session-prompting.js";
import type { AgentSessionConfig } from "./agent-session-types.js";
import { createExtensionRuntime } from "./extensions/loader.js";
import type { ExtensionRunner, LoadExtensionsResult, ResourceLoader } from "./index.js";
import { createSyntheticSourceInfo } from "./source-info.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

class TestPrompting extends AgentSessionPrompting {
  // Stubs for abstract members declared in AgentSessionBase.
  protected isRetryableError(): boolean {
    return false;
  }

  protected async prepareRetry(): Promise<boolean> {
    return false;
  }

  protected async checkCompaction(): Promise<boolean> {
    return false;
  }

  abortRetry(): void {}

  abortCompaction(): void {}

  abortBranchSummary(): void {}

  abortBash(): void {}

  protected flushPendingBashMessages(): void {}

  public expand(text: string): string {
    // expandSkillCommand is private to AgentSessionPrompting; bypass via any
    // so this focused test can exercise the expansion path without wiring a
    // full Agent runtime.
    return (this as unknown as { expandSkillCommand(text: string): string }).expandSkillCommand(
      text,
    );
  }

  public setExtensionRunnerForTest(runner: ExtensionRunner): void {
    (this as unknown as { currentExtensionRunner: ExtensionRunner }).currentExtensionRunner =
      runner;
  }
}

function createEmptyResourceLoader(
  skills: Skill[] = [],
  skillFileSizeLimit = DEFAULT_MAX_SKILL_FILE_BYTES,
): ResourceLoader {
  const extensionsResult: LoadExtensionsResult = {
    extensions: [],
    errors: [],
    runtime: createExtensionRuntime(),
  };
  return {
    getExtensions: () => extensionsResult,
    getSkills: () => ({ skills, diagnostics: [] }),
    getSkillFileSizeLimit: () => skillFileSizeLimit,
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => undefined,
    getAppendSystemPrompt: () => [],
    extendResources: () => {},
    reload: async () => {},
  };
}

function createTestPrompting(resourceLoader: ResourceLoader): TestPrompting {
  const config: AgentSessionConfig = {
    agent: {} as AgentSessionConfig["agent"],
    sessionManager: {} as AgentSessionConfig["sessionManager"],
    settingsManager: {} as AgentSessionConfig["settingsManager"],
    resourceLoader,
    modelRegistry: {} as AgentSessionConfig["modelRegistry"],
    cwd: process.cwd(),
  };
  const prompting = new TestPrompting(config);
  const emitError = vi.fn();
  prompting.setExtensionRunnerForTest({ emitError } as unknown as ExtensionRunner);
  return prompting;
}

async function writeSkillFile(dir: string, name: string, bodyBytes: number): Promise<string> {
  await fs.mkdir(dir, { recursive: true });
  const skillFile = path.join(dir, "SKILL.md");
  await fs.writeFile(
    skillFile,
    `---\nname: ${name}\ndescription: expansion probe\n---\n${"x".repeat(bodyBytes)}`,
    "utf-8",
  );
  return skillFile;
}

function createSkill(filePath: string): Skill {
  return {
    name: "test",
    description: "expansion probe",
    filePath,
    baseDir: path.dirname(filePath),
    source: "path",
    sourceInfo: createSyntheticSourceInfo(filePath, { source: "local" }),
    disableModelInvocation: false,
  };
}

describe("AgentSessionPrompting /skill: expansion limit", () => {
  it("expands a skill file that is under the configured limit", async () => {
    const tempDir = tempDirs.make("openclaw-skill-expansion-ok-");
    const skillFile = await writeSkillFile(tempDir, "test", 1_000);
    const prompting = createTestPrompting(
      createEmptyResourceLoader([createSkill(skillFile)], 10_000),
    );

    const expanded = prompting.expand("/skill:test");

    expect(expanded).toContain('<skill name="test"');
    expect(expanded).toContain("x".repeat(100));
  });

  it("rejects an oversized skill file using the configured limit and returns the original command", async () => {
    const tempDir = tempDirs.make("openclaw-skill-expansion-oversized-");
    const skillFile = await writeSkillFile(tempDir, "test", 2_000);
    const prompting = createTestPrompting(
      createEmptyResourceLoader([createSkill(skillFile)], 1_000),
    );

    const expanded = prompting.expand("/skill:test extra args");

    expect(expanded).toBe("/skill:test extra args");
    const runner = (
      prompting as unknown as { currentExtensionRunner: { emitError: ReturnType<typeof vi.fn> } }
    ).currentExtensionRunner;
    expect(runner.emitError).toHaveBeenCalledWith(
      expect.objectContaining({
        extensionPath: skillFile,
        event: "skill_expansion",
        error: expect.stringContaining("exceeds"),
      }),
    );
  });
});
