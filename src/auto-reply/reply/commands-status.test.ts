// Tests status command rendering for sessions, agents, diagnostics, and model defaults.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { withTempHome } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { normalizeTestText } from "../../../test/helpers/normalize-text.js";
import { saveAuthProfileStore } from "../../agents/auth-profiles/store.js";
import { testing as cliBackendsTesting } from "../../agents/cli-backends.test-support.js";
import { clearAgentHarnesses, registerAgentHarness } from "../../agents/harness/registry.js";
import type { AgentHarness } from "../../agents/harness/types.js";
import {
  addSubagentRunForTests,
  resetSubagentRegistryForTests,
} from "../../agents/subagent-registry.test-helpers.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { ModelDefinitionConfig } from "../../config/types.models.js";
import type { ProviderThinkingProfile } from "../../plugins/provider-thinking.types.js";
import {
  completeTaskRunByRunId,
  createQueuedTaskRun,
  createRunningTaskRun,
  failTaskRunByRunId,
} from "../../tasks/task-executor.js";
import { resetTaskRegistryForTests } from "../../tasks/task-runtime.test-helpers.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { buildStatusPluginsReply, buildStatusReply, buildStatusText } from "./commands-status.js";
import {
  baseCommandTestConfig,
  buildCommandTestParams,
  configureInMemoryTaskRegistryStoreForTests,
} from "./commands.test-harness.js";

// Tests status command rendering for sessions, agents, and diagnostics.

type LoadProviderUsageSummary =
  typeof import("../../infra/provider-usage.js").loadProviderUsageSummary;

const providerUsageMock = vi.hoisted(() => ({
  loadProviderUsageSummary: vi.fn<LoadProviderUsageSummary>(async () => ({
    updatedAt: Date.now(),
    providers: [],
  })),
}));
const activeProviderThinkingMock = vi.hoisted(() => ({
  resolveThinkingProfile: vi.fn<
    (params: {
      provider: string;
      context: { modelId: string };
    }) => ProviderThinkingProfile | null | undefined
  >(() => undefined),
}));
type StatusPluginHealthSnapshot =
  import("../../status/status-plugin-health.js").StatusPluginHealthSnapshot;

const pluginHealthRuntimeMock = vi.hoisted(() => ({
  collectInstalledPluginHealthSnapshot: vi.fn(
    async (): Promise<StatusPluginHealthSnapshot> => ({
      plugins: [],
      diagnostics: [],
      contextEngineQuarantines: [],
      runtimeToolQuarantines: [],
      channelPluginFailures: [],
    }),
  ),
  collectRuntimePluginHealthSnapshot: vi.fn(
    (): StatusPluginHealthSnapshot => ({
      plugins: [],
      diagnostics: [],
      contextEngineQuarantines: [],
      runtimeToolQuarantines: [],
      channelPluginFailures: [],
    }),
  ),
}));

vi.mock("../../infra/provider-usage.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../infra/provider-usage.js")>();
  return {
    ...actual,
    loadProviderUsageSummary: providerUsageMock.loadProviderUsageSummary,
  };
});

vi.mock("../../plugins/provider-thinking-active.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../plugins/provider-thinking-active.js")>()),
  resolveActiveProviderThinkingProfile: activeProviderThinkingMock.resolveThinkingProfile,
}));

vi.mock("../../status/status-plugin-health.runtime.js", () => pluginHealthRuntimeMock);

vi.mock("../../agents/harness/builtin-openclaw.js", () => ({
  createOpenClawAgentHarness: () => ({
    id: "openclaw",
    label: "OpenClaw Default",
    supports: () => ({ supported: true, priority: 0 }),
    runAttempt: async () => {
      throw new Error("not used in status tests");
    },
  }),
}));

const baseCfg = baseCommandTestConfig;
const expectedCodexRuntimeUsageAuth = [
  {
    provider: "openai",
    token: "codex-app-server",
    hookProvider: "codex",
  },
];
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
  const codexProviders = new Set(["codex", "openai"]);
  const harness: AgentHarness = {
    id: "codex",
    label: "Codex",
    autoSelection: { providerIds: [...codexProviders] },
    supports: (ctx) =>
      codexProviders.has(ctx.provider.trim().toLowerCase())
        ? { supported: true, priority: 100 }
        : { supported: false },
    runAttempt: async () => {
      throw new Error("not used in status tests");
    },
  };
  registerAgentHarness(harness, { ownerPluginId: "codex" });
}

function saveStatusTestAuthProfile(params: {
  dir: string;
  profileId: string;
  provider: "openai" | "openai-codex" | "anthropic";
}): void {
  saveStatusTestAuthProfiles({
    dir: params.dir,
    profiles: [{ profileId: params.profileId, provider: params.provider }],
  });
}

function saveStatusTestAuthProfiles(params: {
  dir: string;
  profiles: Array<{ profileId: string; provider: "openai" | "openai-codex" | "anthropic" }>;
}): void {
  const agentDir = path.join(params.dir, ".openclaw", "agents", "main", "agent");
  fs.mkdirSync(agentDir, { recursive: true });
  saveAuthProfileStore(
    {
      version: 1,
      profiles: Object.fromEntries(
        params.profiles.map((profile) => [
          profile.profileId,
          profile.provider === "openai" || profile.provider === "openai-codex"
            ? {
                type: "oauth",
                provider: profile.provider,
                access: "access-token",
                refresh: "refresh-token",
                expires: Date.now() + 60 * 60_000,
              }
            : {
                type: "api_key",
                provider: "anthropic",
                key: "anthropic-api-key",
              },
        ]),
      ),
    },
    agentDir,
    { filterExternalAuthProfiles: false, syncExternalCli: false },
  );
}

afterEach(() => {
  cliBackendsTesting.resetDepsForTest();
  clearAgentHarnesses();
  providerUsageMock.loadProviderUsageSummary.mockReset();
  providerUsageMock.loadProviderUsageSummary.mockResolvedValue({
    updatedAt: Date.now(),
    providers: [],
  });
  activeProviderThinkingMock.resolveThinkingProfile.mockReset();
  activeProviderThinkingMock.resolveThinkingProfile.mockReturnValue(undefined);
  pluginHealthRuntimeMock.collectInstalledPluginHealthSnapshot.mockReset();
  pluginHealthRuntimeMock.collectInstalledPluginHealthSnapshot.mockResolvedValue({
    plugins: [],
    diagnostics: [],
    contextEngineQuarantines: [],
    runtimeToolQuarantines: [],
    channelPluginFailures: [],
  });
  pluginHealthRuntimeMock.collectRuntimePluginHealthSnapshot.mockReset();
  pluginHealthRuntimeMock.collectRuntimePluginHealthSnapshot.mockReturnValue({
    plugins: [],
    diagnostics: [],
    contextEngineQuarantines: [],
    runtimeToolQuarantines: [],
    channelPluginFailures: [],
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
    cliBackendsTesting.setDepsForTest({
      resolvePluginSetupRegistry: () => ({
        providers: [],
        cliBackends: [],
        configMigrations: [],
        autoEnableProbes: [],
        diagnostics: [],
      }),
      resolveRuntimeCliBackends: () => [
        {
          id: "claude-cli",
          pluginId: "claude-cli",
          modelProvider: "anthropic",
          config: { command: "claude" },
          bundleMcp: false,
        },
      ],
    });
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

  it("ignores stale live contextTokens when /status displays the current default model", async () => {
    const text = await buildStatusText({
      cfg: {
        ...baseCfg,
        models: {
          providers: {
            "ollama-cloud": {
              baseUrl: "https://ollama.com",
              models: [
                {
                  id: "deepseek-v4-pro",
                  name: "DeepSeek V4 Pro",
                  reasoning: true,
                  input: ["text", "image"],
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  contextWindow: 1_000_000,
                  maxTokens: 128_000,
                },
                {
                  id: "kimi-k2.7-code",
                  name: "Kimi K2.7 Code",
                  reasoning: true,
                  input: ["text", "image"],
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  contextWindow: 262_144,
                  maxTokens: 128_000,
                },
              ],
            },
          },
        },
      },
      sessionEntry: {
        sessionId: "sess-status-stale-live-context",
        updatedAt: 0,
        modelProvider: "ollama-cloud",
        model: "kimi-k2.7-code",
        totalTokens: 0,
        totalTokensFresh: true,
      },
      sessionKey: "agent:main:main",
      parentSessionKey: "agent:main:main",
      sessionScope: "per-sender",
      statusChannel: "mobilechat",
      provider: "ollama-cloud",
      model: "deepseek-v4-pro",
      contextTokens: 262_144,
      resolvedFastMode: false,
      resolvedVerboseLevel: "off",
      resolvedReasoningLevel: "off",
      resolveDefaultThinkingLevel: async () => undefined,
      isGroup: false,
      defaultGroupActivation: () => "mention",
      modelAuthOverride: "api-key",
      activeModelAuthOverride: "api-key",
    });

    const normalized = normalizeTestText(text);
    expect(normalized).toContain("Model: ollama-cloud/deepseek-v4-pro");
    expect(normalized).toContain("Context: 0/1.0m");
    expect(normalized).not.toContain("kimi-k2.7-code");
    expect(normalized).not.toContain("Context: 0/262k");
    expect(normalized).not.toContain("/262k");
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

  it("renders compact plugin health from the runtime snapshot", async () => {
    pluginHealthRuntimeMock.collectRuntimePluginHealthSnapshot.mockReturnValue({
      plugins: [],
      diagnostics: [],
      contextEngineQuarantines: [],
      runtimeToolQuarantines: [],
      channelPluginFailures: [
        {
          channelId: "broken",
          message: "failed to load setup entry: boom",
          source: "diagnostic",
        },
      ],
    });

    const text = await buildStatusText({
      cfg: baseCfg,
      sessionEntry: {
        sessionId: "sess-status-plugin-health",
        updatedAt: 0,
        contextTokens: 32_000,
      },
      sessionKey: "agent:main:main",
      parentSessionKey: "agent:main:main",
      sessionScope: "per-sender",
      statusChannel: "mobilechat",
      workspaceDir: "/tmp/status-plugin-health-workspace",
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

    // Compact status reads only the runtime snapshot; no config-driven
    // channel inspection happens on this path.
    expect(pluginHealthRuntimeMock.collectRuntimePluginHealthSnapshot).toHaveBeenCalledWith();
    expect(normalizeTestText(text)).toContain("Plugins: 1 channel plugin failure");
  });

  it("gates /status plugins behind the plugin command flag", async () => {
    const commandParams = buildCommandTestParams("/status plugins", {
      ...baseCfg,
      commands: { text: true, plugins: false },
    });

    const reply = await buildStatusPluginsReply({
      cfg: commandParams.cfg,
      command: commandParams.command,
      workspaceDir: commandParams.workspaceDir,
    });

    expect(reply?.text).toBe(
      "⚠️ /status plugins is disabled. Set commands.plugins=true to enable.",
    );
    expect(pluginHealthRuntimeMock.collectInstalledPluginHealthSnapshot).not.toHaveBeenCalled();
  });

  it("shows the effective non-OpenClaw embedded harness in /status", async () => {
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
    expect(
      providerUsageMock.loadProviderUsageSummary.mock.calls.some(([params]) =>
        params?.providers?.includes("openai"),
      ),
    ).toBe(false);
  });

  it("uses Codex OAuth auth labels for openai models running on the Codex harness", async () => {
    registerStatusCodexHarness();

    await withTempHome(
      async (dir) => {
        const agentDir = path.join(dir, ".openclaw", "agents", "main", "agent");
        fs.mkdirSync(agentDir, { recursive: true });
        saveAuthProfileStore(
          {
            version: 1,
            profiles: {
              "openai:status": {
                type: "oauth",
                provider: "openai",
                access: "access-token",
                refresh: "refresh-token",
                expires: Date.now() + 60 * 60_000,
              },
            },
          },
          agentDir,
          { filterExternalAuthProfiles: false, syncExternalCli: false },
        );
        const usageResetBase = Math.floor(Date.now() / 1000);
        providerUsageMock.loadProviderUsageSummary.mockResolvedValue({
          updatedAt: Date.now(),
          providers: [
            {
              provider: "openai",
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
        expect(normalizedCodex).toContain("oauth (openai:status)");
        expect(normalizedCodex).toContain("openai:status");
        expect(normalizedCodex).toContain("Usage: 5h 91% left");
        expect(normalizedCodex).toContain("Week 70% left");
        expect(normalizedImplicitCodex).toContain("Model: openai/gpt-5.5");
        expect(normalizedImplicitCodex).toContain("oauth (openai:status)");
        expect(normalizedImplicitCodex).toContain("Runtime: OpenAI Codex");
        expect(normalizedImplicitCodex).toContain("Usage: 5h 91% left");
        const providerUsageCall = providerUsageMock.loadProviderUsageSummary.mock.calls.find(
          ([params]) => params?.providers?.includes("openai"),
        );
        if (!providerUsageCall) {
          throw new Error("expected provider usage summary call for openai");
        }
        expect(providerUsageCall[0]?.providers).toEqual(["openai"]);
        expect(providerUsageCall[0]?.auth).toEqual(expectedCodexRuntimeUsageAuth);
      },
      {
        env: {
          OPENAI_API_KEY: undefined,
          OPENAI_OAUTH_TOKEN: undefined,
        },
        skipSessionCleanup: true,
        skipHomeCleanup: true,
      },
    );
  });

  it("uses the Codex app-server account before OpenAI env labels on Codex harness status", async () => {
    registerStatusCodexHarness();

    await withTempHome(
      async (dir) => {
        const agentDir = path.join(dir, ".openclaw", "agents", "main", "agent");
        const codexHome = path.join(agentDir, "codex-home");
        fs.mkdirSync(codexHome, { recursive: true });
        fs.writeFileSync(
          path.join(codexHome, "auth.json"),
          JSON.stringify({
            auth_mode: "chatgpt",
            tokens: {
              access_token: "codex-access-token",
              refresh_token: "codex-refresh-token",
            },
          }),
          "utf-8",
        );

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
            sessionId: "sess-status-codex-home-oauth",
            updatedAt: 0,
          },
          sessionKey: "agent:main:main",
          parentSessionKey: "agent:main:main",
          sessionScope: "per-sender",
          statusChannel: "mobilechat",
          provider: "openai",
          model: "gpt-5.5",
          contextTokens: 32_000,
          resolvedFastMode: false,
          resolvedVerboseLevel: "off",
          resolvedReasoningLevel: "off",
          resolveDefaultThinkingLevel: async () => undefined,
          isGroup: false,
          defaultGroupActivation: () => "mention",
        });

        const normalized = normalizeTestText(text);
        expect(normalized).toContain("Model: openai/gpt-5.5");
        expect(normalized).toContain("Runtime: OpenAI Codex");
        expect(normalized).toContain("oauth (codex-cli)");
        expect(normalized).not.toContain("api-key (env: OPENAI_API_KEY)");
      },
      {
        env: {
          OPENAI_API_KEY: "status-env-key-placeholder",
          OPENAI_OAUTH_TOKEN: undefined,
        },
      },
    );
  });

  it("uses Codex usage for bare codex models running on the Codex harness", async () => {
    registerStatusCodexHarness();

    await withTempHome(
      async (dir) => {
        const agentDir = path.join(dir, ".openclaw", "agents", "main", "agent");
        fs.mkdirSync(agentDir, { recursive: true });
        saveAuthProfileStore(
          {
            version: 1,
            profiles: {
              "openai:status": {
                type: "oauth",
                provider: "openai",
                access: "access-token",
                refresh: "refresh-token",
                expires: Date.now() + 60 * 60_000,
              },
            },
          },
          agentDir,
          { filterExternalAuthProfiles: false, syncExternalCli: false },
        );
        const usageResetBase = Math.floor(Date.now() / 1000);
        providerUsageMock.loadProviderUsageSummary.mockResolvedValue({
          updatedAt: Date.now(),
          providers: [
            {
              provider: "openai",
              displayName: "Codex",
              windows: [
                {
                  label: "5h",
                  usedPercent: 8,
                  resetAt: (usageResetBase + 60 * 60) * 1000,
                },
              ],
            },
          ],
        });

        const text = await buildStatusText({
          cfg: baseCfg,
          sessionEntry: {
            sessionId: "sess-status-bare-codex-oauth",
            updatedAt: 0,
          },
          sessionKey: "agent:main:main",
          parentSessionKey: "agent:main:main",
          sessionScope: "per-sender",
          statusChannel: "mobilechat",
          provider: "codex",
          model: "gpt-5.5",
          contextTokens: 32_000,
          resolvedFastMode: false,
          resolvedVerboseLevel: "off",
          resolvedReasoningLevel: "off",
          resolveDefaultThinkingLevel: async () => undefined,
          isGroup: false,
          defaultGroupActivation: () => "mention",
        });

        const normalized = normalizeTestText(text);
        expect(normalized).toContain("Model: codex/gpt-5.5");
        expect(normalized).toContain("oauth (openai:status)");
        expect(normalized).toContain("Runtime: OpenAI Codex");
        expect(normalized).toContain("Usage: 5h 92% left");
        const providerUsageCall = providerUsageMock.loadProviderUsageSummary.mock.calls.find(
          ([params]) => params?.providers?.includes("openai"),
        );
        if (!providerUsageCall) {
          throw new Error("expected provider usage summary call for openai");
        }
        expect(providerUsageCall[0]?.providers).toEqual(["openai"]);
        expect(providerUsageCall[0]?.auth).toEqual(expectedCodexRuntimeUsageAuth);
      },
      {
        env: {
          OPENAI_API_KEY: undefined,
          OPENAI_OAUTH_TOKEN: undefined,
        },
        skipSessionCleanup: true,
        skipHomeCleanup: true,
      },
    );
  });

  it("forwards a selected OpenAI profile to Codex synthetic usage", async () => {
    registerStatusCodexHarness();
    const usageResetBase = Math.floor(Date.now() / 1000);
    providerUsageMock.loadProviderUsageSummary.mockResolvedValue({
      updatedAt: Date.now(),
      providers: [
        {
          provider: "openai",
          displayName: "OpenAI",
          windows: [
            {
              label: "5h",
              usedPercent: 9,
              resetAt: (usageResetBase + 60 * 60) * 1000,
            },
          ],
        },
      ],
    });

    await withTempHome(
      async (dir) => {
        saveStatusTestAuthProfile({ dir, profileId: "work", provider: "openai" });

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
            sessionId: "sess-status-codex-synthetic-usage",
            updatedAt: 0,
            authProfileOverride: "work",
          },
          sessionKey: "agent:main:main",
          parentSessionKey: "agent:main:main",
          sessionScope: "per-sender",
          statusChannel: "mobilechat",
          provider: "openai",
          model: "gpt-5.5",
          contextTokens: 32_000,
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
        expect(normalized).toContain("Runtime: OpenAI Codex");
        expect(normalized).toContain("Usage: 5h 91% left");
        const providerUsageCall = providerUsageMock.loadProviderUsageSummary.mock.calls.find(
          ([params]) => params?.providers?.includes("openai"),
        );
        if (!providerUsageCall) {
          throw new Error("expected provider usage summary call for synthetic Codex auth");
        }
        expect(providerUsageCall[0]).toMatchObject({
          timeoutMs: 8000,
          providers: ["openai"],
          auth: [
            {
              ...expectedCodexRuntimeUsageAuth[0],
              authProfileId: "work",
            },
          ],
          config: expect.objectContaining({
            agents: expect.objectContaining({
              defaults: expect.objectContaining({ agentRuntime: { id: "codex" } }),
            }),
          }),
        });
      },
      { skipSessionCleanup: true, skipHomeCleanup: true },
    );
  });

  it("forwards legacy Codex profile providers to Codex synthetic usage", async () => {
    registerStatusCodexHarness();
    providerUsageMock.loadProviderUsageSummary.mockResolvedValue({
      updatedAt: Date.now(),
      providers: [
        {
          provider: "openai",
          displayName: "OpenAI",
          windows: [{ label: "5h", usedPercent: 9 }],
        },
      ],
    });

    await withTempHome(
      async (dir) => {
        saveStatusTestAuthProfile({
          dir,
          profileId: "openai-codex:legacy",
          provider: "openai-codex",
        });

        await buildStatusText({
          cfg: {
            ...baseCfg,
            agents: {
              defaults: {
                agentRuntime: { id: "codex" },
              },
            },
          },
          sessionEntry: {
            sessionId: "sess-status-codex-legacy-profile",
            updatedAt: 0,
            authProfileOverride: "openai-codex:legacy",
          },
          sessionKey: "agent:main:main",
          parentSessionKey: "agent:main:main",
          sessionScope: "per-sender",
          statusChannel: "mobilechat",
          provider: "openai",
          model: "gpt-5.5",
          contextTokens: 32_000,
          resolvedFastMode: false,
          resolvedVerboseLevel: "off",
          resolvedReasoningLevel: "off",
          resolveDefaultThinkingLevel: async () => undefined,
          isGroup: false,
          defaultGroupActivation: () => "mention",
          modelAuthOverride: "oauth",
          activeModelAuthOverride: "oauth",
        });

        const providerUsageCall = providerUsageMock.loadProviderUsageSummary.mock.calls.find(
          ([params]) => params?.providers?.includes("openai"),
        );
        expect(providerUsageCall?.[0]?.auth).toEqual([
          {
            ...expectedCodexRuntimeUsageAuth[0],
            authProfileId: "openai-codex:legacy",
          },
        ]);
      },
      { skipSessionCleanup: true, skipHomeCleanup: true },
    );
  });

  it("loads Codex synthetic usage when no local OpenAI profile label exists", async () => {
    registerStatusCodexHarness();
    providerUsageMock.loadProviderUsageSummary.mockResolvedValue({
      updatedAt: Date.now(),
      providers: [
        {
          provider: "openai",
          displayName: "OpenAI",
          windows: [{ label: "5h", usedPercent: 16 }],
        },
      ],
    });

    await withTempHome(async () => {
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
          sessionId: "sess-status-codex-no-profile",
          updatedAt: 0,
        },
        sessionKey: "agent:main:main",
        parentSessionKey: "agent:main:main",
        sessionScope: "per-sender",
        statusChannel: "mobilechat",
        provider: "openai",
        model: "gpt-5.5",
        contextTokens: 32_000,
        resolvedFastMode: false,
        resolvedVerboseLevel: "off",
        resolvedReasoningLevel: "off",
        resolveDefaultThinkingLevel: async () => undefined,
        isGroup: false,
        defaultGroupActivation: () => "mention",
      });

      expect(normalizeTestText(text)).toContain("Usage: 5h 84% left");
      const providerUsageCall = providerUsageMock.loadProviderUsageSummary.mock.calls.find(
        ([params]) => params?.providers?.includes("openai"),
      );
      expect(providerUsageCall?.[0]?.auth).toEqual(expectedCodexRuntimeUsageAuth);
    });
  });

  it("does not forward stale non-OpenAI profile overrides to Codex usage", async () => {
    registerStatusCodexHarness();
    providerUsageMock.loadProviderUsageSummary.mockResolvedValue({
      updatedAt: Date.now(),
      providers: [
        {
          provider: "openai",
          displayName: "OpenAI",
          windows: [{ label: "5h", usedPercent: 9 }],
        },
      ],
    });

    await withTempHome(
      async (dir) => {
        saveStatusTestAuthProfiles({
          dir,
          profiles: [
            { profileId: "openai:status", provider: "openai" },
            { profileId: "anthropic:work", provider: "anthropic" },
          ],
        });

        await buildStatusText({
          cfg: {
            ...baseCfg,
            agents: {
              defaults: {
                agentRuntime: { id: "codex" },
              },
            },
          },
          sessionEntry: {
            sessionId: "sess-status-codex-stale-profile",
            updatedAt: 0,
            authProfileOverride: "anthropic:work",
          },
          sessionKey: "agent:main:main",
          parentSessionKey: "agent:main:main",
          sessionScope: "per-sender",
          statusChannel: "mobilechat",
          provider: "openai",
          model: "gpt-5.5",
          contextTokens: 32_000,
          resolvedFastMode: false,
          resolvedVerboseLevel: "off",
          resolvedReasoningLevel: "off",
          resolveDefaultThinkingLevel: async () => undefined,
          isGroup: false,
          defaultGroupActivation: () => "mention",
        });

        const providerUsageCall = providerUsageMock.loadProviderUsageSummary.mock.calls.find(
          ([params]) => params?.providers?.includes("openai"),
        );
        expect(providerUsageCall?.[0]?.auth).toEqual(expectedCodexRuntimeUsageAuth);
      },
      { skipSessionCleanup: true, skipHomeCleanup: true },
    );
  });

  it("uses active fallback provider usage for legacy fallback notices", async () => {
    const fallbackModel: ModelDefinitionConfig = {
      id: "MiniMax-M2.7",
      name: "MiniMax M2.7",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200_000,
      maxTokens: 32_000,
    };
    const selectedModel: ModelDefinitionConfig = {
      id: "mimo-v2-flash",
      name: "MiMo V2 Flash",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 1_048_576,
      maxTokens: 32_000,
    };
    providerUsageMock.loadProviderUsageSummary.mockImplementation(async (options) => ({
      updatedAt: Date.now(),
      providers:
        options?.providers?.includes("minimax") === true
          ? [
              {
                provider: "minimax",
                displayName: "MiniMax",
                windows: [{ label: "day", usedPercent: 20 }],
              },
            ]
          : [],
    }));

    const text = await buildStatusText({
      cfg: {
        ...baseCfg,
        models: {
          providers: {
            "minimax-portal": {
              baseUrl: "https://api.minimax.test/v1",
              models: [fallbackModel],
            },
            xiaomi: {
              baseUrl: "https://api.xiaomi.test/v1",
              models: [selectedModel],
            },
          },
        },
      },
      sessionEntry: {
        sessionId: "sess-status-legacy-fallback-usage",
        updatedAt: 0,
        providerOverride: "xiaomi",
        modelOverride: "mimo-v2-flash",
        modelProvider: "minimax-portal",
        model: "MiniMax-M2.7",
        fallbackNoticeSelectedModel: "xiaomi/mimo-v2-flash",
        fallbackNoticeActiveModel: "minimax-portal/MiniMax-M2.7",
        fallbackNoticeReason: "model not allowed",
        totalTokens: 49_000,
        totalTokensFresh: true,
        contextTokens: 1_048_576,
      },
      sessionKey: "agent:main:main",
      parentSessionKey: "agent:main:main",
      sessionScope: "per-sender",
      statusChannel: "mobilechat",
      provider: "xiaomi",
      model: "mimo-v2-flash",
      contextTokens: 1_048_576,
      resolvedFastMode: false,
      resolvedVerboseLevel: "off",
      resolvedReasoningLevel: "off",
      resolveDefaultThinkingLevel: async () => undefined,
      isGroup: false,
      defaultGroupActivation: () => "mention",
      modelAuthOverride: "api-key",
      activeModelAuthOverride: "api-key",
    });

    const normalized = normalizeTestText(text);
    expect(normalized).toContain("Fallback: minimax-portal/MiniMax-M2.7");
    expect(normalized).toContain("Context: 49k/200k");
    expect(normalized).toContain("Usage: day 80% left");
    expect(providerUsageMock.loadProviderUsageSummary).toHaveBeenCalledWith(
      expect.objectContaining({ providers: ["minimax"] }),
    );
  });

  it("uses live runtime context for unresolved active fallback notices", async () => {
    const selectedModel: ModelDefinitionConfig = {
      id: "mimo-v2-flash",
      name: "MiMo V2 Flash",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 1_048_576,
      maxTokens: 32_000,
    };

    const text = await buildStatusText({
      cfg: {
        ...baseCfg,
        models: {
          providers: {
            xiaomi: {
              baseUrl: "https://api.xiaomi.test/v1",
              models: [selectedModel],
            },
          },
        },
      },
      sessionEntry: {
        sessionId: "sess-status-unresolved-fallback-context",
        updatedAt: 0,
        providerOverride: "xiaomi",
        modelOverride: "mimo-v2-flash",
        modelProvider: "custom-runtime",
        model: "unknown-fallback-model",
        fallbackNoticeSelectedModel: "xiaomi/mimo-v2-flash",
        fallbackNoticeActiveModel: "custom-runtime/unknown-fallback-model",
        fallbackNoticeReason: "model not allowed",
        totalTokens: 49_000,
        totalTokensFresh: true,
        contextTokens: 1_048_576,
      },
      sessionKey: "agent:main:main",
      parentSessionKey: "agent:main:main",
      sessionScope: "per-sender",
      statusChannel: "mobilechat",
      provider: "xiaomi",
      model: "mimo-v2-flash",
      contextTokens: 123_456,
      resolvedFastMode: false,
      resolvedVerboseLevel: "off",
      resolvedReasoningLevel: "off",
      resolveDefaultThinkingLevel: async () => undefined,
      isGroup: false,
      defaultGroupActivation: () => "mention",
      modelAuthOverride: "api-key",
      activeModelAuthOverride: "api-key",
    });

    const normalized = normalizeTestText(text);
    expect(normalized).toContain("Fallback: custom-runtime/unknown-fallback-model");
    expect(normalized).toContain("Context: 49k/123k");
    expect(normalized).not.toContain("Context: 49k/1.0m");
  });

  it("shows DeepSeek balance summaries in /status output", async () => {
    registerStatusCodexHarness();
    providerUsageMock.loadProviderUsageSummary.mockResolvedValue({
      updatedAt: Date.now(),
      providers: [
        {
          provider: "deepseek",
          displayName: "DeepSeek",
          windows: [],
          summary: "Balance ¥42.50",
        },
      ],
    });

    const text = await buildStatusText({
      cfg: baseCfg,
      sessionEntry: {
        sessionId: "sess-status-deepseek-usage",
        updatedAt: 0,
      },
      sessionKey: "agent:main:main",
      parentSessionKey: "agent:main:main",
      sessionScope: "per-sender",
      statusChannel: "mobilechat",
      provider: "deepseek",
      model: "deepseek-v4-pro",
      contextTokens: 1_000_000,
      resolvedFastMode: false,
      resolvedVerboseLevel: "off",
      resolvedReasoningLevel: "off",
      resolveDefaultThinkingLevel: async () => undefined,
      isGroup: false,
      defaultGroupActivation: () => "mention",
      modelAuthOverride: "api-key",
      activeModelAuthOverride: "api-key",
    });

    const normalized = normalizeTestText(text);
    expect(normalized).toContain("Model: deepseek/deepseek-v4-pro");
    expect(normalized).toContain("Usage: Balance ¥42.50");
    const providerUsageCall = providerUsageMock.loadProviderUsageSummary.mock.calls.find(
      ([params]) => params?.providers?.includes("deepseek"),
    );
    if (!providerUsageCall) {
      throw new Error("expected provider usage summary call for deepseek");
    }
    expect(providerUsageCall[0]?.providers).toEqual(["deepseek"]);
  });

  it("shows typed billing-only snapshots in /status output", async () => {
    providerUsageMock.loadProviderUsageSummary.mockResolvedValue({
      updatedAt: Date.now(),
      providers: [
        {
          provider: "openrouter",
          displayName: "OpenRouter",
          windows: [],
          billing: [{ type: "balance", label: "Account balance", amount: 12.5, unit: "USD" }],
        },
      ],
    });

    const text = await buildStatusText({
      cfg: baseCfg,
      sessionEntry: {
        sessionId: "sess-status-openrouter-billing",
        updatedAt: 0,
      },
      sessionKey: "agent:main:main",
      parentSessionKey: "agent:main:main",
      sessionScope: "per-sender",
      statusChannel: "mobilechat",
      provider: "openrouter",
      model: "openai/gpt-5.4",
      contextTokens: 1_000_000,
      resolvedFastMode: false,
      resolvedVerboseLevel: "off",
      resolvedReasoningLevel: "off",
      resolveDefaultThinkingLevel: async () => undefined,
      isGroup: false,
      defaultGroupActivation: () => "mention",
      modelAuthOverride: "api-key",
      activeModelAuthOverride: "api-key",
    });

    expect(normalizeTestText(text)).toContain("Usage: Account balance: $12.50");
  });

  it("uses the session-selected model provider for /status usage", async () => {
    const usageResetBase = Math.floor(Date.now() / 1000);
    providerUsageMock.loadProviderUsageSummary.mockImplementation(
      async ({ providers = [] } = {}) => ({
        updatedAt: Date.now(),
        providers: providers.map((provider) =>
          provider === "openai"
            ? {
                provider: "openai",
                displayName: "OpenAI",
                windows: [
                  {
                    label: "5h",
                    usedPercent: 9,
                    resetAt: (usageResetBase + 60 * 60) * 1000,
                  },
                ],
              }
            : {
                provider,
                displayName: "DeepSeek",
                windows: [],
                summary: "Balance ¥42.50",
              },
        ),
      }),
    );

    const text = await buildStatusText({
      cfg: {
        ...baseCfg,
        agents: {
          defaults: {
            model: "deepseek/deepseek-v4-flash",
          },
        },
      },
      sessionEntry: {
        sessionId: "sess-status-session-selected-usage",
        updatedAt: 0,
        providerOverride: "openai",
        modelOverride: "gpt-5.5",
      },
      sessionKey: "agent:main:main",
      parentSessionKey: "agent:main:main",
      sessionScope: "per-sender",
      statusChannel: "telegram",
      provider: "deepseek",
      model: "deepseek-v4-flash",
      contextTokens: 1_000_000,
      resolvedFastMode: false,
      resolvedVerboseLevel: "off",
      resolvedReasoningLevel: "off",
      resolveDefaultThinkingLevel: async () => undefined,
      isGroup: false,
      defaultGroupActivation: () => "mention",
      modelAuthOverride: "oauth (openai:status)",
      activeModelAuthOverride: "oauth (openai:status)",
    });

    const normalized = normalizeTestText(text);
    expect(normalized).toContain("Model: openai/gpt-5.5");
    expect(normalized).toContain("pinned session; config primary deepseek/deepseek-v4-flash");
    expect(normalized).toContain("clear /model default");
    expect(normalized).toContain("Usage: 5h 91% left");
    expect(normalized).not.toContain("Usage: Balance ¥42.50");
    expect(providerUsageMock.loadProviderUsageSummary).toHaveBeenCalledWith(
      expect.objectContaining({ providers: ["openai"] }),
    );
  });

  it("uses the session-selected provider for /status usage when runtime state is stale", async () => {
    const usageResetBase = Math.floor(Date.now() / 1000);
    providerUsageMock.loadProviderUsageSummary.mockImplementation(
      async ({ providers = [] } = {}) => ({
        updatedAt: Date.now(),
        providers: providers.map((provider) =>
          provider === "openai"
            ? {
                provider: "openai",
                displayName: "OpenAI",
                windows: [
                  {
                    label: "5h",
                    usedPercent: 9,
                    resetAt: (usageResetBase + 60 * 60) * 1000,
                  },
                ],
              }
            : {
                provider,
                displayName: "DeepSeek",
                windows: [],
                summary: "Balance ¥42.50",
              },
        ),
      }),
    );

    const text = await buildStatusText({
      cfg: {
        ...baseCfg,
        agents: {
          defaults: {
            model: "deepseek/deepseek-v4-flash",
          },
        },
      },
      sessionEntry: {
        sessionId: "sess-status-stale-runtime-selected-usage",
        updatedAt: 0,
        providerOverride: "openai",
        modelOverride: "gpt-5.5",
        modelOverrideSource: "user",
        modelProvider: "deepseek",
        model: "deepseek-v4-flash",
      },
      sessionKey: "agent:main:main",
      parentSessionKey: "agent:main:main",
      sessionScope: "per-sender",
      statusChannel: "telegram",
      provider: "deepseek",
      model: "deepseek-v4-flash",
      contextTokens: 1_000_000,
      resolvedFastMode: false,
      resolvedVerboseLevel: "off",
      resolvedReasoningLevel: "off",
      resolveDefaultThinkingLevel: async () => undefined,
      isGroup: false,
      defaultGroupActivation: () => "mention",
      modelAuthOverride: "oauth (openai:status)",
      activeModelAuthOverride: "api-key",
    });

    const normalized = normalizeTestText(text);
    expect(normalized).toContain("Model: openai/gpt-5.5");
    expect(normalized).toContain("pinned session; config primary deepseek/deepseek-v4-flash");
    expect(normalized).toContain("clear /model default");
    expect(normalized).toContain("Usage: 5h 91% left");
    expect(normalized).not.toContain("Usage: Balance ¥42.50");
    expect(providerUsageMock.loadProviderUsageSummary).toHaveBeenCalledWith(
      expect.objectContaining({ providers: ["openai"] }),
    );
  });

  it("uses provider-qualified model overrides for /status usage lookup", async () => {
    await withTempHome(
      async (dir) => {
        saveStatusTestAuthProfile({ dir, profileId: "openai:status", provider: "openai" });

        const usageResetBase = Math.floor(Date.now() / 1000);
        providerUsageMock.loadProviderUsageSummary.mockImplementation(
          async ({ providers = [] } = {}) => ({
            updatedAt: Date.now(),
            providers: providers.map((provider) =>
              provider === "openai"
                ? {
                    provider: "openai",
                    displayName: "OpenAI",
                    windows: [
                      {
                        label: "5h",
                        usedPercent: 9,
                        resetAt: (usageResetBase + 60 * 60) * 1000,
                      },
                    ],
                  }
                : {
                    provider,
                    displayName: "DeepSeek",
                    windows: [],
                    summary: "Balance ¥42.50",
                  },
            ),
          }),
        );

        const text = await buildStatusText({
          cfg: {
            ...baseCfg,
            models: {
              providers: {
                openai: {
                  baseUrl: "https://chatgpt.com/backend-api/codex",
                  models: [{ ...codexStatusModel, contextWindow: 258_000, contextTokens: 258_000 }],
                },
              },
            },
            agents: {
              defaults: {
                model: "deepseek/deepseek-v4-flash",
              },
            },
            auth: {
              order: {
                openai: ["openai:status"],
              },
            },
          },
          sessionEntry: {
            sessionId: "sess-status-qualified-session-selected-usage",
            updatedAt: 0,
            modelOverride: "openai/gpt-5.5",
          },
          sessionKey: "agent:main:main",
          parentSessionKey: "agent:main:main",
          sessionScope: "per-sender",
          statusChannel: "telegram",
          provider: "deepseek",
          model: "deepseek-v4-flash",
          contextTokens: 1_000_000,
          resolvedFastMode: false,
          resolvedVerboseLevel: "off",
          resolvedReasoningLevel: "off",
          resolveDefaultThinkingLevel: async () => undefined,
          isGroup: false,
          defaultGroupActivation: () => "mention",
        });

        const normalized = normalizeTestText(text);
        expect(normalized).toContain("Model: openai/gpt-5.5");
        expect(normalized).toContain("pinned session; config primary deepseek/deepseek-v4-flash");
        expect(normalized).toContain("clear /model default");
        expect(normalized).toContain("oauth (openai:status)");
        expect(normalized).toContain("Context: ?/258k");
        expect(normalized).toContain("Usage: 5h 91% left");
        expect(normalized).not.toContain("Usage: Balance ¥42.50");
        expect(providerUsageMock.loadProviderUsageSummary).toHaveBeenCalledWith(
          expect.objectContaining({ providers: ["openai"] }),
        );
      },
      { env: { OPENAI_API_KEY: undefined } },
    );
  });

  it("uses Codex OAuth auth labels for explicit OpenAI OpenClaw auth order", async () => {
    await withTempHome(
      async (dir) => {
        const agentDir = path.join(dir, ".openclaw", "agents", "main", "agent");
        fs.mkdirSync(agentDir, { recursive: true });
        saveAuthProfileStore(
          {
            version: 1,
            profiles: {
              "openai:status": {
                type: "oauth",
                provider: "openai",
                access: "access-token",
                refresh: "refresh-token",
                expires: Date.now() + 60 * 60_000,
              },
              "openai:backup": {
                type: "api_key",
                provider: "openai",
                key: "sk-test",
              },
            },
          },
          agentDir,
          { filterExternalAuthProfiles: false, syncExternalCli: false },
        );

        const text = await buildStatusText({
          cfg: {
            ...baseCfg,
            agents: {
              defaults: {
                models: {
                  "openai/gpt-5.5": {
                    agentRuntime: { id: "openclaw" },
                  },
                },
              },
            },
            auth: {
              order: {
                openai: ["openai:status", "openai:backup"],
              },
            },
          },
          sessionEntry: {
            sessionId: "sess-status-openai-agent-codex-oauth",
            updatedAt: 0,
          },
          sessionKey: "agent:main:main",
          parentSessionKey: "agent:main:main",
          sessionScope: "per-sender",
          statusChannel: "mobilechat",
          provider: "openai",
          model: "gpt-5.5",
          contextTokens: 32_000,
          resolvedHarness: "openclaw",
          resolvedFastMode: false,
          resolvedVerboseLevel: "off",
          resolvedReasoningLevel: "off",
          resolveDefaultThinkingLevel: async () => undefined,
          isGroup: false,
          defaultGroupActivation: () => "mention",
        });

        const normalized = normalizeTestText(text);
        expect(normalized).toContain("Model: openai/gpt-5.5");
        expect(normalized).toContain("oauth (openai:status)");
        expect(normalized).not.toContain("api-key (openai:backup)");
      },
      { env: { OPENAI_API_KEY: undefined }, skipSessionCleanup: true, skipHomeCleanup: true },
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

  it("prefers active Claude CLI OAuth over selected env API-key labels for runtime aliases", async () => {
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
        sessionId: "sess-status-claude-cli-env-key-shadow",
        updatedAt: 0,
        providerOverride: "anthropic",
        modelOverride: "claude-opus-4-7",
        modelProvider: "claude-cli",
        model: "claude-opus-4-7",
        fallbackNoticeSelectedModel: "anthropic/claude-opus-4-7",
        fallbackNoticeActiveModel: "claude-cli/claude-opus-4-7",
        fallbackNoticeReason: "selected model unavailable",
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
      modelAuthOverride: "api-key (env: ANTHROPIC_API_KEY)",
      activeModelAuthOverride: "oauth (claude-cli)",
    });

    const normalized = normalizeTestText(text);
    expect(normalized).toContain("Model: anthropic/claude-opus-4-7");
    expect(normalized).toContain("oauth (claude-cli)");
    expect(normalized).not.toContain("api-key (env: ANTHROPIC_API_KEY)");
    expect(normalized).not.toContain("Usage:");
  });

  it("uses Codex OAuth context overrides for openai models running on the Codex harness", async () => {
    registerStatusCodexHarness();

    const text = await buildStatusText({
      cfg: {
        ...baseCfg,
        models: {
          providers: {
            openai: {
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

  it("caps stale persisted /status context limits with the active Codex runtime window", async () => {
    registerStatusCodexHarness();

    const text = await buildStatusText({
      cfg: {
        ...baseCfg,
        models: {
          providers: {
            openai: {
              baseUrl: "https://chatgpt.com/backend-api/codex",
              models: [{ ...codexStatusModel, contextWindow: 258_000, contextTokens: 258_000 }],
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
        sessionId: "sess-status-codex-stale-context",
        updatedAt: 0,
        totalTokens: 181_000,
        contextTokens: 400_000,
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

    expect(normalizeTestText(text)).toContain("Context: 181k/258k");
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

  it("keeps /status on an explicit OpenClaw runtime override after config changes", async () => {
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
        sessionId: "sess-status-pinned-agent",
        updatedAt: 0,
        fastMode: true,
        agentRuntimeOverride: "openclaw",
        agentHarnessId: "codex",
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

  it("shows the effective Luna thinking level for a pinned Codex runtime", async () => {
    registerStatusCodexHarness();

    const text = await buildStatusText({
      cfg: baseCfg,
      sessionEntry: {
        sessionId: "sess-status-luna-codex",
        updatedAt: 0,
        thinkingLevel: "ultra",
        agentRuntimeOverride: "codex",
      },
      sessionKey: "agent:main:main",
      parentSessionKey: "agent:main:main",
      sessionScope: "per-sender",
      statusChannel: "mobilechat",
      provider: "openai",
      model: "gpt-5.6-luna",
      contextTokens: 32_000,
      resolvedThinkLevel: "ultra",
      resolvedFastMode: false,
      resolvedVerboseLevel: "off",
      resolvedReasoningLevel: "off",
      resolveDefaultThinkingLevel: async () => "ultra",
      isGroup: false,
      defaultGroupActivation: () => "mention",
      modelAuthOverride: "api-key",
      activeModelAuthOverride: "api-key",
    });

    const normalized = normalizeTestText(text);
    expect(normalized).toContain("Think: max");
    expect(normalized).not.toContain("Think: ultra");
  });

  it("clamps off to the active provider's always-thinking level", async () => {
    activeProviderThinkingMock.resolveThinkingProfile.mockReturnValue({
      levels: [{ id: "max", label: "max" }],
      defaultLevel: "max",
    });

    const text = await buildStatusText({
      cfg: baseCfg,
      sessionEntry: {
        sessionId: "sess-status-kimi-k3",
        updatedAt: 0,
        thinkingLevel: "off",
      },
      sessionKey: "agent:main:main",
      parentSessionKey: "agent:main:main",
      sessionScope: "per-sender",
      statusChannel: "mobilechat",
      provider: "moonshot",
      model: "kimi-k3",
      contextTokens: 262_144,
      resolvedThinkLevel: "off",
      resolvedFastMode: false,
      resolvedVerboseLevel: "off",
      resolvedReasoningLevel: "off",
      resolveDefaultThinkingLevel: async () => undefined,
      isGroup: false,
      defaultGroupActivation: () => "mention",
      modelAuthOverride: "api-key",
      activeModelAuthOverride: "api-key",
    });

    expect(normalizeTestText(text)).toContain("Think: max");
    expect(activeProviderThinkingMock.resolveThinkingProfile).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "moonshot",
        context: expect.objectContaining({ modelId: "kimi-k3" }),
      }),
    );
  });

  it("treats the persisted harness id as observational in /status", async () => {
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
        sessionId: "sess-status-observed-agent",
        updatedAt: 0,
        agentHarnessId: "openclaw",
      },
      sessionKey: "agent:main:main",
      parentSessionKey: "agent:main:main",
      sessionScope: "per-sender",
      statusChannel: "mobilechat",
      provider: "openai",
      model: "gpt-5.4",
      contextTokens: 32_000,
      resolvedFastMode: false,
      resolvedVerboseLevel: "off",
      resolvedReasoningLevel: "off",
      resolveDefaultThinkingLevel: async () => undefined,
      isGroup: false,
      defaultGroupActivation: () => "mention",
      modelAuthOverride: "oauth",
      activeModelAuthOverride: "oauth",
    });

    expect(normalizeTestText(text)).toContain("Runtime: OpenAI Codex");
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */

async function buildKiraStatusReply(cfg: OpenClawConfig) {
  return await buildStatusReply({
    cfg,
    command: {
      isAuthorizedSender: true,
      channel: "whatsapp",
    } as never,
    sessionKey: "agent:kira:main",
    provider: "openai",
    model: "gpt-5.4",
    contextTokens: 0,
    resolvedVerboseLevel: "off",
    resolvedReasoningLevel: "off",
    resolveDefaultThinkingLevel: async () => undefined,
    isGroup: false,
    defaultGroupActivation: () => "mention",
  });
}

describe("buildStatusReply", () => {
  beforeAll(async () => {
    await buildKiraStatusReply({
      session: { mainKey: "main", scope: "per-sender" },
      agents: {
        defaults: {
          model: "openai/gpt-5.4",
        },
      },
      channels: {
        whatsapp: { allowFrom: ["*"] },
      },
    } as OpenClawConfig);
  });

  it("shows per-agent thinkingDefault in the status card", async () => {
    const cfg = {
      session: { mainKey: "main", scope: "per-sender" },
      agents: {
        defaults: {
          model: "openai/gpt-5.4",
        },
        list: [
          {
            id: "kira",
            model: "openai/gpt-5.4",
            thinkingDefault: "xhigh",
          },
        ],
      },
      channels: {
        whatsapp: { allowFrom: ["*"] },
      },
    } as OpenClawConfig;

    const reply = await buildKiraStatusReply(cfg);

    expect(reply?.text).toContain("Think: xhigh");
  });

  it("shows per-agent fallback overrides in the status card", async () => {
    const cfg = {
      session: { mainKey: "main", scope: "per-sender" },
      agents: {
        defaults: {
          model: {
            primary: "openai/gpt-5.4",
            fallbacks: ["anthropic/claude-sonnet-4-6"],
          },
        },
        list: [
          {
            id: "kira",
            model: {
              primary: "openai/gpt-5.4",
              fallbacks: ["google/gemini-2.5-flash"],
            },
          },
        ],
      },
      channels: {
        whatsapp: { allowFrom: ["*"] },
      },
    } as OpenClawConfig;

    const reply = await buildKiraStatusReply(cfg);

    expect(reply?.text).toContain("Fallbacks: google/gemini-2.5-flash");
    expect(reply?.text).not.toContain("Fallbacks: anthropic/claude-sonnet-4-6");
  });

  it("keeps default fallback config when the agent has no explicit model", async () => {
    const cfg = {
      session: { mainKey: "main", scope: "per-sender" },
      agents: {
        defaults: {
          model: {
            primary: "openai/gpt-5.4",
            fallbacks: ["anthropic/claude-sonnet-4-6"],
          },
        },
        list: [
          {
            id: "kira",
          },
        ],
      },
      channels: {
        whatsapp: { allowFrom: ["*"] },
      },
    } as OpenClawConfig;

    const reply = await buildKiraStatusReply(cfg);

    expect(reply?.text).toContain("Fallbacks: anthropic/claude-sonnet-4-6");
  });

  it("keeps agent primary strict when the agent has no explicit fallback override", async () => {
    const cfg = {
      session: { mainKey: "main", scope: "per-sender" },
      agents: {
        defaults: {
          model: {
            primary: "openai/gpt-5.4",
            fallbacks: ["anthropic/claude-sonnet-4-6"],
          },
        },
        list: [
          {
            id: "kira",
            model: {
              primary: "openai/gpt-5.4",
            },
          },
        ],
      },
      channels: {
        whatsapp: { allowFrom: ["*"] },
      },
    } as OpenClawConfig;

    const reply = await buildKiraStatusReply(cfg);

    expect(reply?.text).not.toContain("Fallbacks:");
  });

  it("treats an explicit empty per-agent fallback override as disabling inherited fallbacks", async () => {
    const cfg = {
      session: { mainKey: "main", scope: "per-sender" },
      agents: {
        defaults: {
          model: {
            primary: "openai/gpt-5.4",
            fallbacks: ["anthropic/claude-sonnet-4-6"],
          },
        },
        list: [
          {
            id: "kira",
            model: {
              primary: "openai/gpt-5.4",
              fallbacks: [],
            },
          },
        ],
      },
      channels: {
        whatsapp: { allowFrom: ["*"] },
      },
    } as OpenClawConfig;

    const reply = await buildKiraStatusReply(cfg);

    expect(reply?.text).not.toContain("Fallbacks:");
  });
});
