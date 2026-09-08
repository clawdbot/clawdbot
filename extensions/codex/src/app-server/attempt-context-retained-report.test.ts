// Retained workspace reporting must not diagnose active native context as truncated away.
import fs from "node:fs/promises";
import path from "node:path";
import type { EmbeddedRunAttemptParamsV2 as EmbeddedRunAttemptParams } from "openclaw/plugin-sdk/agent-harness-runtime";
import { withTempDir } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it } from "vitest";
import {
  buildCodexSystemPromptReport,
  buildCodexWorkspaceBootstrapContext,
} from "./attempt-context.js";

async function reportRetainedTools(params: {
  workspaceDir: string;
  before?: string;
  after?: string;
  contextDisabled?: boolean;
  externalWorkspace?: string;
}) {
  const toolsPath = path.join(params.workspaceDir, "TOOLS.md");
  if (params.before !== undefined) {
    await fs.writeFile(toolsPath, params.before);
  }
  const attempt = {
    sessionId: "retained-report",
    config: { agents: { defaults: { workspace: params.workspaceDir } } },
  } as EmbeddedRunAttemptParams;
  const options = {
    params: attempt,
    resolvedWorkspace: params.workspaceDir,
    effectiveWorkspace: params.workspaceDir,
    executionWorkspace: params.externalWorkspace,
    sessionKey: "agent:main:retained-report",
    sessionAgentId: "main",
    memoryToolNames: [],
    ringZeroActive: false,
  };
  const initial = await buildCodexWorkspaceBootstrapContext(options);
  if (params.after !== undefined) {
    await fs.writeFile(toolsPath, params.after);
  } else if (params.before !== undefined) {
    await fs.unlink(toolsPath);
  }
  const resumed = await buildCodexWorkspaceBootstrapContext({
    ...options,
    ringZeroActive: params.contextDisabled === true,
    retainedThreadContext: { instructions: initial.threadDeveloperInstructions },
  });
  const report = buildCodexSystemPromptReport({
    attempt,
    sessionKey: options.sessionKey,
    workspaceDir: params.workspaceDir,
    developerInstructions: resumed.threadDeveloperInstructions ?? "",
    workspaceBootstrapContext: resumed,
    skillsPrompt: "",
    tools: [],
  });
  return {
    initial,
    resumed,
    report,
    tools: report.injectedWorkspaceFiles.find((file) => file.name === "TOOLS.md"),
  };
}

describe("Codex retained workspace reporting", () => {
  it("does not report unchanged retained TOOLS.md as truncated to zero on the second turn", async () => {
    await withTempDir("codex-retained-report-", async (workspaceDir) => {
      const toolsFacts = "Camera alias: synthetic-front-door.\n";
      const { initial, resumed, report, tools } = await reportRetainedTools({
        workspaceDir,
        before: toolsFacts,
        after: toolsFacts,
      });
      expect(initial.threadDeveloperInstructions).toContain(toolsFacts.trimEnd());
      expect(resumed.threadDeveloperInstructions).toBe(initial.threadDeveloperInstructions);
      expect(tools).toBeDefined();
      expect(tools).not.toMatchObject({ injectedChars: 0, truncated: true });
      expect(tools).toMatchObject({
        rawChars: toolsFacts.trimEnd().length,
        injectionStatus: "retained_unverified",
        injectedChars: null,
        truncated: null,
      });
      expect(report.systemPrompt.chars).toBe(initial.threadDeveloperInstructions?.length);
    });
  });

  it.each([
    { change: "edited", after: "Replacement notes that are not the retained snapshot." },
    { change: "removed", after: undefined },
  ])("keeps frozen attribution unknown when TOOLS.md is $change", async ({ after }) => {
    await withTempDir("codex-retained-report-", async (workspaceDir) => {
      const { initial, resumed, report, tools } = await reportRetainedTools({
        workspaceDir,
        before: "Original synthetic aliases.",
        after,
      });
      expect(resumed.threadDeveloperInstructions).toBe(initial.threadDeveloperInstructions);
      expect(resumed.promptContext ?? "").not.toContain("TOOLS.md");
      expect(tools).toMatchObject({
        missing: after === undefined,
        rawChars: after?.length ?? 0,
        injectionStatus: "retained_unverified",
        injectedChars: null,
        truncated: null,
      });
      expect(report.systemPrompt.chars).toBe(initial.threadDeveloperInstructions?.length);
    });
  });

  it.each([undefined, "", "   "])(
    "reports a newly populated file as omitted when its initial snapshot was %j",
    async (before) => {
      await withTempDir("codex-retained-report-", async (workspaceDir) => {
        const { initial, resumed, tools } = await reportRetainedTools({
          workspaceDir,
          before,
          after: "Notes created after the session began.",
        });
        expect(initial.threadDeveloperInstructions).toBeUndefined();
        expect(resumed.threadDeveloperInstructions).toBeUndefined();
        expect(tools).toMatchObject({ missing: false, injectedChars: 0, truncated: false });
      });
    },
  );

  it("does not give disabled retained context a false truncation diagnosis", async () => {
    await withTempDir("codex-retained-report-", async (workspaceDir) => {
      const { resumed, tools } = await reportRetainedTools({
        workspaceDir,
        before: "Original aliases.",
        after: "Original aliases.",
        contextDisabled: true,
      });
      expect(resumed.threadDeveloperInstructions).toBeUndefined();
      expect(tools).toMatchObject({ injectedChars: 0, truncated: false });
    });
  });

  it("does not assert absent TOOLS.md was retained when the snapshot contains AGENTS.md only", async () => {
    await withTempDir("codex-retained-report-", async (workspaceDir) => {
      await fs.writeFile(path.join(workspaceDir, "AGENTS.md"), "Synthetic operating instructions.");
      const { initial, tools } = await reportRetainedTools({
        workspaceDir,
        externalWorkspace: path.join(workspaceDir, "project"),
      });
      expect(initial.threadDeveloperInstructions).toContain("Synthetic operating instructions.");
      expect(initial.threadDeveloperInstructions).not.toContain("TOOLS.md");
      expect(tools).toMatchObject({
        missing: true,
        rawChars: 0,
        injectionStatus: "retained_unverified",
        injectedChars: null,
        truncated: null,
      });
    });
  });
});
