import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { withTempHome } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { normalizeTestText } from "../../../test/helpers/normalize-text.js";
import { clearAgentHarnesses, registerAgentHarness } from "../../agents/harness/registry.js";
import type { AgentHarness } from "../../agents/harness/types.js";
import {
  addSubagentRunForTests,
  resetSubagentRegistryForTests,
} from "../../agents/subagent-registry.js";
import type { ModelDefinitionConfig } from "../../config/types.models.js";
import {
  completeTaskRunByRunId,
  createQueuedTaskRun,
  createRunningTaskRun,
  failTaskRunByRunId,
} from "../../tasks/task-executor.js";
import { resetTaskRegistryForTests } from "../../tasks/task-registry.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { buildStatusReply, buildStatusText } from "./commands-status.js";
import {
  baseCommandTestConfig,
  buildCommandTestParams,
  configureInMemoryTaskRegistryStoreForTests,
} from "./commands.test-harness.js";

type LoadProviderUsageSummary =
  typeof import("../../infra/provider-usage.js").loadProviderUsageSummary;

const providerUsageMock = vi.hoisted(() => ({
  loadProviderUsageSummary: vi.fn<LoadProviderUsageSummary>(async () => ({
    updatedAt: Date.now(),
    providers: [],
  })),
}));

vi.mock("../../infra/provider-usage.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../infra/provider-usage.js")>();
  return {
    ...actual,
    loadProviderUsageSummary: providerUsageMock.loadProviderUsageSummary,
  };
});

vi.mock("../../agents/harness/builtin-pi.js", () => ({
  createPiAgentHarness: () => ({
    id: "pi",
    label: "OpenClaw Pi",
    supports: () => ({ supported: true, priority: 0 }),
    runAttempt: async () => {
      throw new Error("not used in status tests");
    },
  }),
}));

const baseCfg = baseCommandTestConfig;
const codexStatusModel: ModelDefinitionConfig = {
  id: "gpt-5.5",
  name: "GPT-5.5",
  reasoning: true,
  input: ["text", "image"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1_050_000,
  contextTokens: 1_000_000,
  maxTokens: 128_000,
};

async function buildStatusReplyForTest(params: { sessionKey?: string; verbose?: boolean }) {
  const commandParams = buildCommandTestParams("/status", baseCfg);
  const sessionKey = params.sessionKey ?? commandParams.sessionKey;
  return await buildStatusReply({
    cfg: baseCfg,
    command: commandParams.command,
    sessionEntry: commandParams.sessionEntry,
    sessionKey,
    parentSessionKey: sessionKey,
    sessionScope: commandParams.sessionScope,
    storePath: commandParams.storePath,
    provider: "anthropic",
    model: "claude-opus-4-6",
    contextTokens: 0,
    resolvedThinkLevel: commandParams.resolvedThinkLevel,
    resolvedFastMode: false,
    resolvedVerboseLevel: params.verbose ? "on" : commandParams.resolvedVerboseLevel,
    resolvedReasoningLevel: commandParams.resolvedReasoningLevel,
    resolvedElevatedLevel: commandParams.resolvedElevatedLevel,
    resolveDefaultThinkingLevel: commandParams.resolveDefaultThinkingLevel,
    isGroup: commandParams.isGroup,
    defaultGroupActivation: commandParams.defaultGroupActivation,
    modelAuthOverride: "api-key",
    activeModelAuthOverride: "api-key",
  });
}

function registerStatusCodexHarness(): void {
  const harness: AgentHarness = {
    id: "codex",
    label: "Codex",
    supports: (ctx) =>
      ctx.provider === "codex" ? { supported: true, priority: 100 } : { supported: false },
    runAttempt: async () => {
      throw new Error("not used in status tests");
    },
  };
  registerAgentHarness(harness, { ownerPluginId: "codex" });
}

afterEach(() => {
  clearAgentHarnesses();
  providerUsageMock.loadProviderUsageSummary.mockReset();
  providerUsageMock.loadProviderUsageSummary.mockResolvedValue({
    updatedAt: Date.now(),
    providers: [],
  });
});

function writeTranscriptUsageLog(params: {
  dir: string;
  agentId: string;
  sessionId: string;
  usage: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    totalTokens: number;
  };
}) {
  const logPath = path.join(
    params.dir,
    ".openclaw",
    "agents",
    params.agentId,
    "sessions",
    `${params.sessionId}.jsonl`,
  );
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.writeFileSync(
    logPath,
    JSON.stringify({
      type: "message",
      message: {
        role: "assistant",
        model: "claude-opus-4-5",
        usage: params.usage,
      },
    }),
    "utf-8",
  );
}

describe("buildStatusReply subagent summary", () => {
  beforeEach(() => {
    resetSubagentRegistryForTests();
    resetTaskRegistryForTests({ persist: false });
    configureInMemoryTaskRegistryStoreForTests();
  });

  afterEach(() => {
    resetSubagentRegistryForTests();
    resetTaskRegistryForTests({ persist: false });
  });

  it("counts ended orchestrators with active descendants as active", async () => {
    const parentKey = "agent:main:subagent:status-ended-parent";
    addSubagentRunForTests({
      runId: "run-status-ended-parent",
      childSessionKey: parentKey,
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "status orchestrator",
      cleanup: "keep",
      createdAt: Date.now() - 120_000,
      startedAt: Date.now() - 120_000,
      endedAt: Date.now() - 110_000,
      outcome: { status: "ok" },
    });
    addSubagentRunForTests({
      runId: "run-status-active-child",
      childSessionKey: "agent:main:subagent:status-ended-parent:subagent:child",
      requesterSessionKey: parentKey,
      requesterDisplayKey: "subagent:status-ended-parent",
      task: "status child still running",
      cleanup: "keep",
      createdAt: Date.now() - 60_000,
      startedAt: Date.now() - 60_000,
    });

    const reply = await buildStatusReplyForTest({});

    expect(reply?.text).toContain("🤖 Subagents: 1 active");
  });

  it("dedupes stale rows in the verbose subagent status summary", async () => {
    const childSessionKey = "agent:main:subagent:status-dedupe-worker";
    addSubagentRunForTests({
      runId: "run-status-current",
      childSessionKey,
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "current status worker",
      cleanup: "keep",
      createdAt: Date.now() - 60_000,
      startedAt: Date.now() - 60_000,
    });
    addSubagentRunForTests({
      runId: "run-status-stale",
      childSessionKey,
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "stale status worker",
      cleanup: "keep",
      createdAt: Date.now() - 120_000,
      startedAt: Date.now() - 120_000,
      endedAt: Date.now() - 90_000,
      outcome: { status: "ok" },
    });

    const reply = await buildStatusReplyForTest({ verbose: true });

    expect(reply?.text).toContain("🤖 Subagents: 1 active");
    expect(reply?.text).not.toContain("· 1 done");
  });

  it("does not count a child session that moved to a newer parent in the old parent's status", async () => {
    const oldParentKey = "agent:main:subagent:status-old-parent";
    const newParentKey = "agent:main:subagent:status-new-parent";
    const childSessionKey = "agent:main:subagent:status-shared-child";
    addSubagentRunForTests({
      runId: "run-status-old-parent",
      childSessionKey: oldParentKey,
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "old parent",
      cleanup: "keep",
      createdAt: Date.now() - 120_000,
      startedAt: Date.now() - 120_000,
    });
    addSubagentRunForTests({
      runId: "run-status-new-parent",
      childSessionKey: newParentKey,
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "new parent",
      cleanup: "keep",
      createdAt: Date.now() - 90_000,
      startedAt: Date.now() - 90_000,
    });
    addSubagentRunForTests({
      runId: "run-status-child-stale-old-parent",
      childSessionKey,
      requesterSessionKey: oldParentKey,
      requesterDisplayKey: oldParentKey,
      controllerSessionKey: oldParentKey,
      task: "stale old parent child",
      cleanup: "keep",
      createdAt: Date.now() - 60_000,
      startedAt: Date.now() - 60_000,
    });
    addSubagentRunForTests({
      runId: "run-status-child-current-new-parent",
      childSessionKey,
      requesterSessionKey: newParentKey,
      requesterDisplayKey: newParentKey,
      controllerSessionKey: newParentKey,
      task: "current new parent child",
      cleanup: "keep",
      createdAt: Date.now() - 30_000,
      startedAt: Date.now() - 30_000,
    });

    const reply = await buildStatusReplyForTest({ sessionKey: oldParentKey, verbose: true });

    expect(reply?.text).not.toContain("🤖 Subagents: 1 active");
    expect(reply?.text).not.toContain("stale old parent child");
  });

  it("counts controller-owned runs even when the latest child requester differs", async () => {
    addSubagentRunForTests({
      runId: "run-status-controller-owned",
      childSessionKey: "agent:main:subagent:status-controller-owned",
      requesterSessionKey: "agent:main:requester-only",
      requesterDisplayKey: "requester-only",
      controllerSessionKey: "agent:main:main",
      task: "controller-owned status worker",
      cleanup: "keep",
      createdAt: Date.now() - 60_000,
      startedAt: Date.now() - 60_000,
    });

    const reply = await buildStatusReplyForTest({});

    expect(reply?.text).toContain("🤖 Subagents: 1 active");
  });

  it("includes active and total task counts for the current session", async () => {
    createRunningTaskRun({
      runtime: "subagent",
      requesterSessionKey: "agent:main:main",
      childSessionKey: "agent:main:subagent:status-task-running",
      runId: "run-status-task-running",
      task: "active background task",
      progressSummary: "still working",
    });
    createQueuedTaskRun({
      runtime: "cron",
      requesterSessionKey: "agent:main:main",
      childSessionKey: "agent:main:subagent:status-task-queued",
      runId: "run-status-task-queued",
      task: "queued background task",
    });

    const reply = await buildStatusReplyForTest({});

    expect(reply?.text).toContain("📌 Tasks: 2 active · 2 total");
    expect(reply?.text).toMatch(/📌 Tasks: 2 active · 2 total · (subagent|cron) · /);
  });

  it("hides stale completed task rows from the session task line", async () => {
    createRunningTaskRun({
      runtime: "subagent",
      requesterSessionKey: "agent:main:main",
      childSessionKey: "agent:main:subagent:status-task-live",
      runId: "run-status-task-live",
      task: "live background task",
      progressSummary: "still working",
    });
    createQueuedTaskRun({
      runtime: "cron",
      requesterSessionKey: "agent:main:main",
      childSessionKey: "agent:main:subagent:status-task-stale-done",
      runId: "run-status-task-stale-done",
      task: "stale completed task",
    });
    completeTaskRunByRunId({
      runId: "run-status-task-stale-done",
      endedAt: Date.now() - 10 * 60_000,
      terminalSummary: "done a while ago",
    });

    const reply = await buildStatusReplyForTest({});

    expect(reply?.text).toContain("📌 Tasks: 1 active · 1 total");
    expect(reply?.text).toContain("live background task");
    expect(reply?.text).not.toContain("stale completed task");
    expect(reply?.text).not.toContain("done a while ago");
  });

  it("shows a recent failure when no active tasks remain", async () => {
    createRunningTaskRun({
      runtime: "acp",
      requesterSessionKey: "agent:main:main",
      childSessionKey: "agent:main:acp:status-task-failed",
      runId: "run-status-task-failed",
      task: "failed background task",
    });
    failTaskRunByRunId({
      runId: "run-status-task-failed",
      endedAt: Date.now(),
      error: "approval denied",
    });

    const reply = await buildStatusReplyForTest({});

    expect(reply?.text).toContain("📌 Tasks: 1 recent failure");
    expect(reply?.text).toContain("failed background task");
    expect(reply?.text).toContain("approval denied");
  });

  it("does not leak internal runtime context through the task status line", async () => {
    createRunningTaskRun({
      runtime: "subagent",
      requesterSessionKey: "agent:main:main",
      childSessionKey: "agent:main:subagent:status-task-leak",
      runId: "run-status-task-leak",
      task: "leaked context task",
    });
    failTaskRunByRunId({
      runId: "run-status-task-leak",
      endedAt: Date.now(),
      error: [
        "OpenClaw runtime context (internal):",
        "This context is runtime-generated, not user-authored. Keep internal details private.",
        "",
        "[Internal task completion event]",
        "source: subagent",
      ].join("\n"),
    });

    const reply = await buildStatusReplyForTest({});

    expect(reply?.text).toContain("📌 Tasks: 1 recent failure");
    expect(reply?.text).toContain("leaked context task");
    expect(reply?.text).not.toContain("OpenClaw runtime context (internal):");
    expect(reply?.text).not.toContain("Internal task completion event");
  });

  it("truncates long task titles and details in the session task line", async () => {
    createRunningTaskRun({
      runtime: "subagent",
      requesterSessionKey: "agent:main:main",
      childSessionKey: "agent:main:subagent:status-task-truncated",
      runId: "run-status-task-truncated",
      task: "This is a deliberately long task prompt that should never be emitted in full by /status because it can include internal instructions and file paths that are not appropriate for the headline line shown to users.",
      progressSummary:
        "This progress detail is also intentionally long so the status surface proves it truncates verbose task context instead of dumping a multi-sentence internal update into the reply output.",
    });

    const reply = await buildStatusReplyForTest({});

    expect(reply?.text).toContain(
      "This is a deliberately long task prompt that should never be emitted in full by…",
    );
    expect(reply?.text).toContain(
      "This progress detail is also intentionally long so the status surface proves it truncates verbose task context instead…",
    );
    expect(reply?.text).not.toContain("internal instructions and file paths");
    expect(reply?.text).not.toContain("dumping a multi-sentence internal update");
  });

  it("prefers failure context over newer success context when showing recent failures", async () => {
    createRunningTaskRun({
      runtime: "acp",
      requesterSessionKey: "agent:main:main",
      childSessionKey: "agent:main:acp:status-task-failed-priority",
      runId: "run-status-task-failed-priority",
      task: "failed background task",
    });
    failTaskRunByRunId({
      runId: "run-status-task-failed-priority",
      endedAt: Date.now() - 30_000,
      error: "approval denied",
    });
    createRunningTaskRun({
      runtime: "subagent",
      requesterSessionKey: "agent:main:main",
      childSessionKey: "agent:main:subagent:status-task-succeeded-later",
      runId: "run-status-task-succeeded-later",
      task: "later successful task",
    });
    completeTaskRunByRunId({
      runId: "run-status-task-succeeded-later",
      endedAt: Date.now(),
      terminalSummary: "all done",
    });

    const reply = await buildStatusReplyForTest({});

    expect(reply?.text).toContain("📌 Tasks: 1 recent failure");
    expect(reply?.text).toContain("failed background task");
    expect(reply?.text).toContain("approval denied");
    expect(reply?.text).not.toContain("later successful task");
    expect(reply?.text).not.toContain("all done");
  });

  it("falls back to same-agent task counts without details when the current session has none", async () => {
    createRunningTaskRun({
      runtime: "subagent",
      requesterSessionKey: "agent:main:other",
      childSessionKey: "agent:main:subagent:status-agent-fallback-running",
      runId: "run-status-agent-fallback-running",
      agentId: "main",
      task: "hidden task title",
      progressSummary: "hidden progress detail",
    });
    createQueuedTaskRun({
      runtime: "cron",
      requesterSessionKey: "agent:main:another",
      childSessionKey: "agent:main:subagent:status-agent-fallback-queued",
      runId: "run-status-agent-fallback-queued",
      agentId: "main",
      task: "another hidden task title",
    });

    const reply = await buildStatusReplyForTest({ sessionKey: "agent:main:empty-session" });

    expect(reply?.text).toContain("📌 Tasks: 2 active · 2 total · agent-local");
    expect(reply?.text).not.toContain("hidden task title");
    expect(reply?.text).not.toContain("hidden progress detail");
    expect(reply?.text).not.toContain("subagent");
    expect(reply?.text).not.toContain("cron");
  });

  it("uses transcript usage fallback in /status output", async () => {
    await withTempHome(async (dir) => {
      const sessionId = "sess-status-transcript";
      writeTranscriptUsageLog({
        dir,
        agentId: "main",
        sessionId,
        usage: {
          input: 1,
          output: 2,
          cacheRead: 1000,
          cacheWrite: 0,
          totalTokens: 1003,
        },
      });

      const text = await buildStatusText({
        cfg: baseCfg,
        sessionEntry: {
          sessionId,
          updatedAt: 0,
          totalTokens: 3,
          contextTokens: 32_000,
        },
        sessionKey: "agent:main:main",
        parentSessionKey: "agent:main:main",
        sessionScope: "per-sender",
        statusChannel: "mobilechat",
        provider: "anthropic",
        model: "claude-opus-4-5",
        contextTokens: 32_000,
        resolvedFastMode: false,
        resolvedVerboseLevel: "off",
        resolvedReasoningLevel: "off",
        resolveDefaultThinkingLevel: async () => undefined,
        isGroup: false,
        defaultGroupActivation: () => "mention",
        modelAuthOverride: "api-key",
        activeModelAuthOverride: "api-key",
      });

      expect(normalizeTestText(text)).toContain("Context: 1.0k/32k");
    });
  });

  it("shows gateway and system uptime in /status output", async () => {
    vi.spyOn(process, "uptime").mockReturnValue(2 * 60 * 60 + 5 * 60);
    vi.spyOn(os, "uptime").mockReturnValue(4 * 24 * 60 * 60 + 3 * 60 * 60);

    const text = await buildStatusText({
      cfg: baseCfg,
      sessionEntry: {
        sessionId: "sess-status-uptime",
        updatedAt: 0,
        contextTokens: 32_000,
      },
      sessionKey: "agent:main:main",
      parentSessionKey: "agent:main:main",
      sessionScope: "per-sender",
      statusChannel: "mobilechat",
      provider: "anthropic",
      model: "claude-opus-4-5",
      contextTokens: 32_000,
      resolvedFastMode: false,
      resolvedVerboseLevel: "off",
      resolvedReasoningLevel: "off",
      resolveDefaultThinkingLevel: async () => undefined,
      isGroup: false,
      defaultGroupActivation: () => "mention",
      modelAuthOverride: "api-key",
      activeModelAuthOverride: "api-key",
    });

    expect(normalizeTestText(text)).toContain("Uptime: gateway 2h 5m · system 4d 3h");
  });

  it("shows the effective non-PI embedded harness in /status", async () => {
    registerStatusCodexHarness();

    const text = await buildStatusText({
      cfg: {
        ...baseCfg,
        agents: {
          defaults: {
            agentRuntime: { id: "codex" },
          },
        },
      },
      sessionEntry: {
        sessionId: "sess-status-codex",
        updatedAt: 0,
        fastMode: true,
      },
      sessionKey: "agent:main:main",
      parentSessionKey: "agent:main:main",
      sessionScope: "per-sender",
      statusChannel: "mobilechat",
      provider: "openai",
      model: "gpt-5.4",
      contextTokens: 32_000,
      resolvedFastMode: true,
      resolvedVerboseLevel: "off",
      resolvedReasoningLevel: "off",
      resolveDefaultThinkingLevel: async () => undefined,
      isGroup: false,
      defaultGroupActivation: () => "mention",
      modelAuthOverride: "api-key",
      activeModelAuthOverride: "api-key",
    });

    const normalized = normalizeTestText(text);
    expect(normalized).toContain("Runtime: OpenAI Codex");
    expect(normalized).toContain("Fast");
    expect(normalized).not.toContain("Fast · codex");
  });

  it("uses Codex OAuth auth labels for openai models running on the Codex harness", async () => {
    registerStatusCodexHarness();

    await withTempHome(
      async (dir) => {
        const authPath = path.join(
          dir,
          ".openclaw",
          "agents",
          "main",
          "agent",
          "auth-profiles.json",
        );
        fs.mkdirSync(path.dirname(authPath), { recursive: true });
        fs.writeFileSync(
          authPath,
          JSON.stringify({
            version: 1,
            profiles: {
              "openai-codex:status": {
                type: "oauth",
                provider: "openai-codex",
                access: "access-token",
                refresh: "refresh-token",
                expires: Date.now() + 60 * 60_000,
              },
            },
          }),
          "utf8",
        );
        const usageResetBase = Math.floor(Date.now() / 1000);
        providerUsageMock.loadProviderUsageSummary.mockResolvedValue({
          updatedAt: Date.now(),
          providers: [
            {
              provider: "openai-codex",
              displayName: "Codex",
              windows: [
                {
                  label: "5h",
                  usedPercent: 9,
                  resetAt: (usageResetBase + 60 * 60) * 1000,
                },
                {
                  label: "Week",
                  usedPercent: 30,
                  resetAt: (usageResetBase + 3 * 24 * 60 * 60) * 1000,
                },
              ],
            },
          ],
        });

        const commonParams = {
          sessionEntry: {
            sessionId: "sess-status-codex-oauth",
            updatedAt: 0,
          },
          sessionKey: "agent:main:main",
          parentSessionKey: "agent:main:main",
          sessionScope: "per-sender" as const,
          statusChannel: "mobilechat",
          provider: "openai",
          model: "gpt-5.5",
          contextTokens: 32_000,
          resolvedFastMode: false,
          resolvedVerboseLevel: "off" as const,
          resolvedReasoningLevel: "off" as const,
          resolveDefaultThinkingLevel: async () => undefined,
          isGroup: false,
          defaultGroupActivation: () => "mention" as const,
        };

        const codexText = await buildStatusText({
          cfg: {
            ...baseCfg,
            agents: {
              defaults: {
                agentRuntime: { id: "codex" },
              },
            },
          },
          ...commonParams,
        });
        const implicitCodexText = await buildStatusText({
          cfg: baseCfg,
          ...commonParams,
        });

        const normalizedCodex = normalizeTestText(codexText);
        const normalizedImplicitCodex = normalizeTestText(implicitCodexText);
        expect(normalizedCodex).toContain("Model: openai/gpt-5.5");
        expect(normalizedCodex).toContain("oauth (openai-codex:status)");
        expect(normalizedCodex).toContain("openai-codex:status");
        expect(normalizedCodex).toContain("Usage: 5h 91% left");
        expect(normalizedCodex).toContain("Week 70% left");
        expect(normalizedImplicitCodex).toContain("Model: openai/gpt-5.5");
        expect(normalizedImplicitCodex).toContain("oauth (openai-codex:status)");
        expect(normalizedImplicitCodex).toContain("Runtime: OpenAI Codex");
        expect(normalizedImplicitCodex).toContain("Usage: 5h 91% left");
        const providerUsageCall = providerUsageMock.loadProviderUsageSummary.mock.calls.find(
          ([params]) => params?.providers?.includes("openai-codex"),
        );
        if (!providerUsageCall) {
          throw new Error("expected provider usage summary call for openai-codex");
        }
        expect(providerUsageCall[0]?.providers).toEqual(["openai-codex"]);
      },
      {
        env: {
          OPENAI_API_KEY: undefined,
          OPENAI_OAUTH_TOKEN: undefined,
        },
      },
    );
  });

  it("uses Claude CLI OAuth auth labels for anthropic models running on the Claude CLI runtime", async () => {
    await withTempHome(
      async (dir) => {
        const authPath = path.join(dir, ".claude", ".credentials.json");
        fs.mkdirSync(path.dirname(authPath), { recursive: true });
        fs.writeFileSync(
          authPath,
          JSON.stringify({
            claudeAiOauth: {
              accessToken: "access-token",
              refreshToken: "refresh-token",
              expiresAt: Date.now() + 60_000,
            },
          }),
          "utf8",
        );

        const text = await buildStatusText({
          cfg: {
            ...baseCfg,
            agents: {
              defaults: {
                agentRuntime: { id: "claude-cli" },
              },
            },
          },
          sessionEntry: {
            sessionId: "sess-status-claude-cli-oauth",
            updatedAt: 0,
          },
          sessionKey: "agent:main:main",
          parentSessionKey: "agent:main:main",
          sessionScope: "per-sender",
          statusChannel: "mobilechat",
          provider: "anthropic",
          model: "claude-opus-4-7",
          contextTokens: 32_000,
          resolvedHarness: "claude-cli",
          resolvedFastMode: false,
          resolvedVerboseLevel: "off",
          resolvedReasoningLevel: "off",
          resolveDefaultThinkingLevel: async () => undefined,
          isGroup: false,
          defaultGroupActivation: () => "mention",
        });

        const normalized = normalizeTestText(text);
        expect(normalized).toContain("Model: anthropic/claude-opus-4-7");
        expect(normalized).toContain("oauth (claude-cli)");
      },
      {
        env: {
          ANTHROPIC_API_KEY: undefined,
          ANTHROPIC_OAUTH_TOKEN: undefined,
        },
      },
    );
  });

  it("uses Codex OAuth context overrides for openai models running on the Codex harness", async () => {
    registerStatusCodexHarness();

    const text = await buildStatusText({
      cfg: {
        ...baseCfg,
        models: {
          providers: {
            "openai-codex": {
              baseUrl: "https://chatgpt.com/backend-api/codex",
              models: [codexStatusModel],
            },
          },
        },
        agents: {
          defaults: {
            agentRuntime: { id: "codex" },
          },
        },
      },
      sessionEntry: {
        sessionId: "sess-status-codex-context",
        updatedAt: 0,
        totalTokens: 25_000,
      },
      sessionKey: "agent:main:main",
      parentSessionKey: "agent:main:main",
      sessionScope: "per-sender",
      statusChannel: "mobilechat",
      provider: "openai",
      model: "gpt-5.5",
      resolvedFastMode: false,
      resolvedVerboseLevel: "off",
      resolvedReasoningLevel: "off",
      resolveDefaultThinkingLevel: async () => undefined,
      isGroup: false,
      defaultGroupActivation: () => "mention",
      modelAuthOverride: "oauth",
      activeModelAuthOverride: "oauth",
    });

    const normalized = normalizeTestText(text);
    expect(normalized).toContain("Model: openai/gpt-5.5");
    expect(normalized).toContain("Context: 25k/1.0m");
  });

  it("uses workspace-scoped auth evidence in /status auth labels", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-status-auth-label-"));
    const workspaceDir = path.join(tempRoot, "workspace");
    const pluginDir = path.join(workspaceDir, ".openclaw", "extensions", "workspace-auth-label");
    const bundledDir = path.join(tempRoot, "bundled");
    const stateDir = path.join(tempRoot, "state");
    const credentialPath = path.join(tempRoot, "credentials.json");
    fs.mkdirSync(pluginDir, { recursive: true });
    fs.mkdirSync(bundledDir, { recursive: true });
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(pluginDir, "index.ts"), "export default {}\n", "utf8");
    fs.writeFileSync(credentialPath, "{}", "utf8");
    fs.writeFileSync(
      path.join(pluginDir, "openclaw.plugin.json"),
      JSON.stringify({
        id: "workspace-auth-label",
        configSchema: { type: "object" },
        setup: {
          providers: [
            {
              id: "anthropic",
              authEvidence: [
                {
                  type: "local-file-with-env",
                  fileEnvVar: "WORKSPACE_STATUS_CREDENTIALS",
                  credentialMarker: "workspace-status-local-credentials",
                  source: "workspace status credentials",
                },
              ],
            },
          ],
        },
      }),
      "utf8",
    );

    try {
      await withEnvAsync(
        {
          OPENCLAW_BUNDLED_PLUGINS_DIR: bundledDir,
          OPENCLAW_STATE_DIR: stateDir,
          ANTHROPIC_API_KEY: undefined,
          ANTHROPIC_OAUTH_TOKEN: undefined,
          WORKSPACE_STATUS_CREDENTIALS: credentialPath,
        },
        async () => {
          const text = await buildStatusText({
            cfg: {
              ...baseCfg,
              plugins: { allow: ["workspace-auth-label"] },
            },
            sessionEntry: {
              sessionId: "sess-status-workspace-auth",
              updatedAt: 0,
            },
            sessionKey: "agent:main:main",
            parentSessionKey: "agent:main:main",
            sessionScope: "per-sender",
            statusChannel: "mobilechat",
            workspaceDir,
            provider: "anthropic",
            model: "claude-opus-4-5",
            contextTokens: 32_000,
            resolvedFastMode: false,
            resolvedVerboseLevel: "off",
            resolvedReasoningLevel: "off",
            resolveDefaultThinkingLevel: async () => undefined,
            isGroup: false,
            defaultGroupActivation: () => "mention",
          });

          expect(normalizeTestText(text)).toContain("workspace status credentials");
        },
      );
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("keeps /status on a session-pinned PI harness after config changes", async () => {
    registerStatusCodexHarness();

    const text = await buildStatusText({
      cfg: {
        ...baseCfg,
        agents: {
          defaults: {
            agentRuntime: { id: "codex" },
          },
        },
      },
      sessionEntry: {
        sessionId: "sess-status-pinned-pi",
        updatedAt: 0,
        fastMode: true,
        agentHarnessId: "pi",
      },
      sessionKey: "agent:main:main",
      parentSessionKey: "agent:main:main",
      sessionScope: "per-sender",
      statusChannel: "mobilechat",
      provider: "openai",
      model: "gpt-5.4",
      contextTokens: 32_000,
      resolvedFastMode: true,
      resolvedVerboseLevel: "off",
      resolvedReasoningLevel: "off",
      resolveDefaultThinkingLevel: async () => undefined,
      isGroup: false,
      defaultGroupActivation: () => "mention",
      modelAuthOverride: "api-key",
      activeModelAuthOverride: "api-key",
    });

    const normalized = normalizeTestText(text);
    expect(normalized).toContain("Fast");
    expect(normalized).not.toContain("codex");
  });
});
