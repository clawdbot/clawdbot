// Covers CLI-backed attempt execution and session-binding persistence.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "../../config/sessions.js";
import {
  formatSqliteSessionFileMarker,
  parseSqliteSessionFileMarker,
} from "../../config/sessions/legacy-sqlite-marker.js";
import {
  appendTranscriptEvent,
  appendTranscriptMessage,
  listSessionEntries,
  loadTranscriptEvents,
  replaceSessionEntry,
} from "../../config/sessions/session-accessor.js";
import { clearSessionStoreCacheForTest } from "../../config/sessions/store-writer-state.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createUserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.js";
import { createTestUserTurnTranscriptTarget } from "../../sessions/user-turn-transcript.test-support.js";
import {
  disposeOpenClawAgentDatabaseByPath,
  listOpenClawAgentDatabasesForTest,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import { registerGeneratedMediaTaskActivity } from "../../tasks/generated-media-task-activity.js";
import { resetGeneratedMediaTaskActivityForTests } from "../../tasks/task-runtime.test-helpers.js";
import { createSuiteTempRootTracker } from "../../test-helpers/temp-dir.js";
import { captureEnv, setTestEnvValue } from "../../test-utils/env.js";
import {
  clearRuntimeAuthProfileStoreSnapshots,
  saveAuthProfileStore,
} from "../auth-profiles/store.js";
import { testing as cliBackendsTesting } from "../cli-backends.test-support.js";
import type { EmbeddedAgentRunResult } from "../embedded-agent.js";
import { FailoverError } from "../failover-error.js";
import { attachToolAllowlistIntersection } from "../tool-policy.js";
import {
  persistAcpTurnTranscript,
  persistCliTurnTranscript,
  runAgentAttempt as runAgentAttemptImpl,
} from "./attempt-execution.js";
import { resolveClaudeCliProjectDirForWorkspace } from "./claude-cli-project-dir.js";

type RunAgentAttemptParams = Parameters<typeof runAgentAttemptImpl>[0];
const SUBAGENT_ANNOUNCE_CHILD_SESSION_KEY = "agent:main:subagent:child";
const SUBAGENT_ANNOUNCE_REQUESTER_TOOLS = ["read", "exec", "sessions_spawn", "message"];

function createSubagentAnnounceHandoffOptions(params: {
  sourceReplyDeliveryMode: "automatic" | "message_tool_only";
  targetSessionKey: string;
  targetSessionId: string;
  provider: string;
  model: string;
  disableMessageTool?: boolean;
  requireExplicitMessageTarget?: boolean;
  modelRun?: boolean;
  promptMode?: "none";
  runtimeToolsAllow?: string[];
  trustedInternalHandoff?: boolean;
}): Partial<RunAgentAttemptParams["opts"]> {
  return {
    sourceReplyDeliveryMode: params.sourceReplyDeliveryMode,
    ...(params.disableMessageTool ? { disableMessageTool: true } : {}),
    ...(params.requireExplicitMessageTarget ? { requireExplicitMessageTarget: true } : {}),
    ...(params.modelRun ? { modelRun: true } : {}),
    ...(params.promptMode ? { promptMode: params.promptMode } : {}),
    toolsAllow: params.runtimeToolsAllow ?? [...SUBAGENT_ANNOUNCE_REQUESTER_TOOLS],
    ...(params.trustedInternalHandoff === false
      ? {}
      : {
          trustedInternalHandoff: {
            kind: "subagent-completion" as const,
            sourceSessionKey: SUBAGENT_ANNOUNCE_CHILD_SESSION_KEY,
            sourceSessionId: "subagent-announce-child",
            targetSessionKey: params.targetSessionKey,
            targetSessionId: params.targetSessionId,
            provider: params.provider,
            model: params.model,
          },
        }),
    inputProvenance: {
      kind: "inter_session",
      sourceSessionKey: SUBAGENT_ANNOUNCE_CHILD_SESSION_KEY,
      sourceChannel: "internal",
      sourceTool: "subagent_announce",
    },
    internalEvents: [
      {
        type: "task_completion",
        source: "subagent",
        childSessionKey: SUBAGENT_ANNOUNCE_CHILD_SESSION_KEY,
        childSessionId: "subagent-announce-child",
        announceType: "subagent task",
        taskLabel: "review",
        status: "ok",
        statusLabel: "completed",
        result: "child output",
        replyInstruction: "Relay this completion.",
      },
    ],
  };
}

type SubagentAnnounceDeliveryCase = {
  name: string;
  sourceReplyDeliveryMode: "automatic" | "message_tool_only";
  disableMessageTool: boolean;
  requireExplicitMessageTarget?: boolean;
  modelRun?: boolean;
  promptMode?: "none";
  inheritedToolAllow?: readonly string[];
  inheritedToolDeny?: readonly string[];
  runtimeToolsAllow?: string[];
  operatorTools?: OpenClawConfig["tools"];
  sandboxMode?: "off" | "non-main" | "all";
  trustedInternalHandoff?: boolean;
  expectedDisableTools: boolean;
  expectedToolsAllow?: readonly string[];
};

const SUBAGENT_ANNOUNCE_DELIVERY_CASES: readonly SubagentAnnounceDeliveryCase[] = [
  {
    name: "automatic source replies",
    sourceReplyDeliveryMode: "automatic" as const,
    disableMessageTool: false,
    expectedDisableTools: true,
  },
  {
    name: "message-tool-only source replies",
    sourceReplyDeliveryMode: "message_tool_only" as const,
    disableMessageTool: false,
    expectedDisableTools: false,
    expectedToolsAllow: ["message"],
  },
  {
    name: "message-tool-only source replies requiring an explicit target",
    sourceReplyDeliveryMode: "message_tool_only" as const,
    disableMessageTool: false,
    requireExplicitMessageTarget: true,
    expectedDisableTools: false,
    expectedToolsAllow: ["message"],
  },
  {
    name: "an explicitly disabled message tool",
    sourceReplyDeliveryMode: "message_tool_only" as const,
    disableMessageTool: true,
    expectedDisableTools: true,
  },
  {
    name: "a coding profile with a source-bound message grant",
    sourceReplyDeliveryMode: "message_tool_only",
    disableMessageTool: false,
    inheritedToolAllow: ["read", "exec", "sessions_spawn"],
    operatorTools: { profile: "coding" },
    expectedDisableTools: false,
    expectedToolsAllow: ["message"],
  },
  {
    name: "an operator allowlist with a source-bound message grant",
    sourceReplyDeliveryMode: "message_tool_only",
    disableMessageTool: false,
    operatorTools: { allow: ["read", "exec"] },
    expectedDisableTools: false,
    expectedToolsAllow: ["message"],
  },
  {
    name: "an inherited explicit message deny",
    sourceReplyDeliveryMode: "message_tool_only",
    disableMessageTool: false,
    inheritedToolAllow: ["*"],
    inheritedToolDeny: ["message"],
    expectedDisableTools: true,
  },
  {
    name: "a current operator message deny",
    sourceReplyDeliveryMode: "message_tool_only",
    disableMessageTool: false,
    operatorTools: { deny: ["message"] },
    expectedDisableTools: true,
  },
  {
    name: "an active sandbox message deny",
    sourceReplyDeliveryMode: "message_tool_only",
    disableMessageTool: false,
    operatorTools: { sandbox: { tools: { deny: ["message"] } } },
    sandboxMode: "all",
    expectedDisableTools: true,
  },
  {
    name: "a non-main sandbox message deny",
    sourceReplyDeliveryMode: "message_tool_only",
    disableMessageTool: false,
    operatorTools: { sandbox: { tools: { deny: ["message"] } } },
    sandboxMode: "non-main",
    expectedDisableTools: true,
  },
  {
    name: "an inactive sandbox message deny",
    sourceReplyDeliveryMode: "message_tool_only",
    disableMessageTool: false,
    operatorTools: { sandbox: { tools: { deny: ["message"] } } },
    sandboxMode: "off",
    expectedDisableTools: false,
    expectedToolsAllow: ["message"],
  },
  {
    name: "a runtime allowlist excluding message",
    sourceReplyDeliveryMode: "message_tool_only",
    disableMessageTool: false,
    runtimeToolsAllow: ["read", "exec"],
    expectedDisableTools: true,
  },
  {
    name: "an empty runtime allowlist",
    sourceReplyDeliveryMode: "message_tool_only",
    disableMessageTool: false,
    runtimeToolsAllow: [],
    expectedDisableTools: true,
  },
  {
    name: "an intersected runtime allowlist excluding message",
    sourceReplyDeliveryMode: "message_tool_only",
    disableMessageTool: false,
    runtimeToolsAllow: attachToolAllowlistIntersection(["*", "message"], [["*"], ["read"]]),
    expectedDisableTools: true,
  },
  {
    name: "an authorized messaging tool group",
    sourceReplyDeliveryMode: "message_tool_only",
    disableMessageTool: false,
    inheritedToolAllow: ["group:messaging"],
    runtimeToolsAllow: ["group:messaging"],
    operatorTools: { profile: "coding" },
    expectedDisableTools: false,
    expectedToolsAllow: ["message"],
  },
  {
    name: "an untrusted completion handoff",
    sourceReplyDeliveryMode: "message_tool_only",
    disableMessageTool: false,
    trustedInternalHandoff: false,
    expectedDisableTools: true,
  },
];

const SUBAGENT_ANNOUNCE_EMBEDDED_DELIVERY_CASES: readonly SubagentAnnounceDeliveryCase[] = [
  ...SUBAGENT_ANNOUNCE_DELIVERY_CASES.map((testCase) => {
    if (testCase.name === "automatic source replies") {
      return {
        ...testCase,
        expectedDisableTools: false,
        expectedToolsAllow: SUBAGENT_ANNOUNCE_REQUESTER_TOOLS,
      };
    }
    if (!testCase.expectedDisableTools) {
      return {
        ...testCase,
        expectedToolsAllow: testCase.runtimeToolsAllow ?? SUBAGENT_ANNOUNCE_REQUESTER_TOOLS,
      };
    }
    return testCase;
  }),
  {
    name: "a raw model run despite message-tool-only delivery",
    sourceReplyDeliveryMode: "message_tool_only",
    disableMessageTool: false,
    modelRun: true,
    expectedDisableTools: true,
  },
  {
    name: "prompt mode none despite message-tool-only delivery",
    sourceReplyDeliveryMode: "message_tool_only",
    disableMessageTool: false,
    promptMode: "none",
    expectedDisableTools: true,
  },
];

const runAgentAttempt = (
  params: Omit<RunAgentAttemptParams, "lifecycleGeneration"> &
    Partial<Pick<RunAgentAttemptParams, "lifecycleGeneration">>,
) =>
  runAgentAttemptImpl({
    ...params,
    lifecycleGeneration: params.lifecycleGeneration ?? "test-generation",
  });

const runCliAgentMock = vi.hoisted(() => vi.fn());
const runEmbeddedAgentMock = vi.hoisted(() => vi.fn());
const hasClaudeLiveSessionForOwnerMock = vi.hoisted(() => vi.fn(() => false));
const providerAuthAliasMocks = vi.hoisted(() => ({
  resolveProviderAuthAliasMap: vi.fn(() => ({})),
  resolveProviderIdForAuth: vi.fn(
    (
      provider: string,
      params?: {
        metadataSnapshot?: {
          plugins?: readonly { providerAuthAliases?: Record<string, string> }[];
        };
      },
    ) => {
      const normalized = provider.trim().toLowerCase();
      for (const plugin of params?.metadataSnapshot?.plugins ?? []) {
        const alias = plugin.providerAuthAliases?.[normalized]?.trim();
        if (alias) {
          return alias.toLowerCase();
        }
      }
      return ["codex-cli", "openai"].includes(normalized) ? "openai" : normalized;
    },
  ),
}));
const sessionWriteLockMocks = vi.hoisted(() => ({
  acquireSessionWriteLock: vi.fn(),
}));
vi.mock("../cli-runner.js", () => ({
  runCliAgent: runCliAgentMock,
}));

vi.mock("../cli-runner/claude-live-session.js", () => ({
  getClaudeLiveSessionGenerationForOwner: vi.fn(() => undefined),
  hasClaudeLiveSessionForOwner: hasClaudeLiveSessionForOwnerMock,
}));

vi.mock("../model-selection.js", () => ({
  isCliProvider: (provider: string, _cfg?: OpenClawConfig) => {
    const normalized = provider.trim().toLowerCase();
    return (
      normalized === "claude-cli" ||
      normalized === "codex-cli" ||
      normalized === "google-gemini-cli"
    );
  },
  normalizeProviderId: (provider: string) => provider.trim().toLowerCase(),
}));

vi.mock("../provider-auth-aliases.js", () => ({
  resolveProviderAuthAliasMap: providerAuthAliasMocks.resolveProviderAuthAliasMap,
  resolveProviderIdForAuth: providerAuthAliasMocks.resolveProviderIdForAuth,
}));

vi.mock("../model-runtime-aliases.js", async () => {
  const actual = await vi.importActual<typeof import("../model-runtime-aliases.js")>(
    "../model-runtime-aliases.js",
  );
  return {
    ...actual,
    resolveCliRuntimeExecutionProvider: ({
      provider,
      cfg,
      modelId,
    }: {
      provider?: string;
      cfg?: OpenClawConfig;
      modelId?: string;
    }) => {
      const key = provider && modelId ? `${provider}/${modelId}` : undefined;
      // Runtime alias tests only need the model-level runtime override path;
      // keeping the mock narrow avoids loading provider catalogs here.
      const runtime = key
        ? cfg?.agents?.defaults?.models?.[key]?.agentRuntime?.id?.trim()
        : undefined;
      return runtime || provider;
    },
  };
});

vi.mock("../embedded-agent.js", () => ({
  runEmbeddedAgent: runEmbeddedAgentMock,
}));

vi.mock("../session-write-lock.js", async () => {
  const actual = await vi.importActual<typeof import("../session-write-lock.js")>(
    "../session-write-lock.js",
  );
  sessionWriteLockMocks.acquireSessionWriteLock.mockImplementation(actual.acquireSessionWriteLock);
  return {
    ...actual,
    acquireSessionWriteLock: sessionWriteLockMocks.acquireSessionWriteLock,
  };
});

function makeCliResult(text: string): EmbeddedAgentRunResult {
  return {
    payloads: [{ text }],
    meta: {
      durationMs: 5,
      finalAssistantVisibleText: text,
      agentMeta: {
        sessionId: "session-cli",
        provider: "claude-cli",
        model: "opus",
        usage: {
          input: 12,
          output: 4,
          cacheRead: 3,
          cacheWrite: 0,
          total: 19,
        },
      },
      executionTrace: {
        winnerProvider: "claude-cli",
        winnerModel: "opus",
        fallbackUsed: false,
        runner: "cli",
      },
    },
  };
}

async function persistCliTranscriptEntry(
  params: Parameters<typeof persistCliTurnTranscript>[0],
): Promise<SessionEntry | undefined> {
  const result = await persistCliTurnTranscript(params);
  if (result.kind !== "persisted") {
    throw new Error("expected CLI transcript persistence to keep the current session");
  }
  return result.sessionEntry;
}

type TranscriptReadTarget =
  | string
  | { agentId: string; sessionId: string; sessionKey: string; storePath: string };

async function readSessionMessages(target: TranscriptReadTarget) {
  return (await readTranscriptEntries(target))
    .filter((entry) => entry.type === "message")
    .map(
      (entry) =>
        entry.message as { role?: string; content?: unknown; provider?: string; model?: string },
    );
}

async function readSessionFileEntries(target: TranscriptReadTarget) {
  return await readTranscriptEntries<{
    type?: string;
    id?: string;
    parentId?: string | null;
    cwd?: string;
    message?: { role?: string };
  }>(target);
}

async function readTranscriptEntries<T extends { type?: string; message?: unknown }>(
  target: TranscriptReadTarget,
): Promise<T[]> {
  if (typeof target !== "string") {
    return (await loadTranscriptEvents(target)) as T[];
  }
  const sessionFile = target;
  const marker = parseSqliteSessionFileMarker(sessionFile);
  if (marker) {
    return (await loadTranscriptEvents({
      agentId: marker.agentId,
      sessionId: marker.sessionId,
      storePath: marker.storePath,
    })) as T[];
  }
  // Session transcripts are JSONL; tests preserve that format so parent/child
  // id ordering and append behavior are covered end-to-end.
  const raw = await fs.readFile(sessionFile, "utf-8");
  const entries: T[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (line.length === 0) {
      continue;
    }
    entries.push(JSON.parse(line) as T);
  }
  return entries;
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null) {
    throw new Error(`${label} was not an object`);
  }
  return value as Record<string, unknown>;
}

function expectRecordFields(record: Record<string, unknown>, fields: Record<string, unknown>) {
  for (const [key, value] of Object.entries(fields)) {
    expect(record[key]).toEqual(value);
  }
}

function requireMockArg(mock: ReturnType<typeof vi.fn>, callIndex: number, label: string) {
  const arg = mock.mock.calls[callIndex]?.[0];
  if (arg === undefined) {
    throw new Error(`Expected mock argument for ${label}`);
  }
  return requireRecord(arg, label);
}

function expectMockArgFields(
  mock: ReturnType<typeof vi.fn>,
  fields: Record<string, unknown>,
  callIndex = 0,
) {
  expectRecordFields(requireMockArg(mock, callIndex, "mock call argument"), fields);
}

function firstRunCliAgentArg(callIndex = 0) {
  return requireMockArg(runCliAgentMock, callIndex, "run CLI agent argument");
}

function firstEmbeddedAgentArg(callIndex = 0) {
  return requireMockArg(runEmbeddedAgentMock, callIndex, "embedded OpenClaw agent argument");
}

describe("CLI attempt execution", () => {
  const fixtureRoot = createSuiteTempRootTracker({ prefix: "openclaw-cli-attempt-suite-" });
  let suiteRoot: string;
  let agentDir: string;
  let tmpDir: string;
  let storePath: string;
  let homeEnvSnapshot: ReturnType<typeof captureEnv> | undefined;

  beforeAll(async () => {
    suiteRoot = await fixtureRoot.setup();
    agentDir = path.join(suiteRoot, "agents", "main", "agent");
    storePath = path.join(suiteRoot, "sessions.json");
    await fs.mkdir(agentDir, { recursive: true });
  });

  async function runOpenClawEmbeddedAttemptForTest(overrides?: {
    opts?: Partial<RunAgentAttemptParams["opts"]>;
    config?: OpenClawConfig;
    subagentAnnounceEnvelope?: Pick<
      SubagentAnnounceDeliveryCase,
      "inheritedToolAllow" | "inheritedToolDeny"
    >;
    runId?: string;
    sessionKey?: string;
    body?: string;
    transcriptBody?: string;
    providerOverride?: string;
    modelOverride?: string;
    isFallbackRetry?: boolean;
    fallbackRuntimeState?: RunAgentAttemptParams["fallbackRuntimeState"];
    userTurnTranscriptRecorder?: RunAgentAttemptParams["userTurnTranscriptRecorder"];
    sessionEntry?: Partial<SessionEntry>;
    additionalSessionEntries?: Record<string, Partial<SessionEntry>>;
    configuredAuthProfileId?: string;
    timeoutMs?: number;
    runTimeoutOverrideMs?: number;
  }) {
    const runId = overrides?.runId ?? "run-embedded-live-stream-gate";
    const sessionKey = overrides?.sessionKey ?? `agent:main:direct:${runId}`;
    const sessionEntry: SessionEntry = {
      sessionId: `session-${runId}`,
      updatedAt: Date.now(),
      ...overrides?.sessionEntry,
    };
    const sessionStore = overrides?.subagentAnnounceEnvelope
      ? createSubagentAnnounceSessionStore(
          sessionKey,
          sessionEntry,
          overrides.subagentAnnounceEnvelope,
        )
      : { [sessionKey]: sessionEntry };
    for (const [additionalSessionKey, additionalEntry] of Object.entries(
      overrides?.additionalSessionEntries ?? {},
    )) {
      sessionStore[additionalSessionKey] = {
        sessionId: `${additionalSessionKey}-session`,
        updatedAt: Date.now(),
        ...additionalEntry,
      } as SessionEntry;
    }
    await writeSessionStoreSeed(sessionStore);
    runEmbeddedAgentMock.mockResolvedValueOnce({
      meta: { durationMs: 1 },
    } satisfies EmbeddedAgentRunResult);
    const providerOverride = overrides?.providerOverride ?? "openai";

    await runAgentAttempt({
      providerOverride,
      originalProvider: "openai",
      modelOverride: overrides?.modelOverride ?? "gpt-5.4",
      configuredAuthProfileId: overrides?.configuredAuthProfileId,
      cfg: overrides?.config ?? ({ session: { store: storePath } } as OpenClawConfig),
      sessionEntry,
      sessionId: sessionEntry.sessionId,
      sessionKey,
      sessionAgentId: "main",
      sessionFile: path.join(tmpDir, `${runId}.jsonl`),
      workspaceDir: tmpDir,
      body: overrides?.body ?? "stream gate",
      transcriptBody: overrides?.transcriptBody,
      isFallbackRetry: overrides?.isFallbackRetry ?? false,
      fallbackRuntimeState: overrides?.fallbackRuntimeState,
      resolvedThinkLevel: "medium",
      timeoutMs: overrides?.timeoutMs ?? 1_000,
      runTimeoutOverrideMs: overrides?.runTimeoutOverrideMs,
      runId,
      opts: {
        message: "stream gate",
        ...overrides?.opts,
      } as RunAgentAttemptParams["opts"],
      runContext: {} as RunAgentAttemptParams["runContext"],
      spawnedBy: undefined,
      messageChannel: "telegram",
      skillsSnapshot: undefined,
      resolvedVerboseLevel: undefined,
      agentDir,
      onAgentEvent: vi.fn(),
      authProfileProvider: providerOverride,
      sessionStore,
      storePath,
      sessionHasHistory: false,
      userTurnTranscriptRecorder: overrides?.userTurnTranscriptRecorder,
    });

    return firstEmbeddedAgentArg(runEmbeddedAgentMock.mock.calls.length - 1);
  }

  beforeEach(async () => {
    homeEnvSnapshot = captureEnv(["HOME", "OPENCLAW_STATE_DIR"]);
    setTestEnvValue("OPENCLAW_STATE_DIR", suiteRoot);
    tmpDir = await fixtureRoot.make();
    runCliAgentMock.mockReset();
    runEmbeddedAgentMock.mockReset();
    resetGeneratedMediaTaskActivityForTests();
    hasClaudeLiveSessionForOwnerMock.mockReset();
    hasClaudeLiveSessionForOwnerMock.mockReturnValue(false);
    providerAuthAliasMocks.resolveProviderAuthAliasMap.mockClear();
    providerAuthAliasMocks.resolveProviderIdForAuth.mockClear();
    sessionWriteLockMocks.acquireSessionWriteLock.mockClear();
    cliBackendsTesting.setDepsForTest({
      resolvePluginSetupCliBackend: () => undefined,
      resolvePluginSetupRegistry: () => ({ cliBackends: [] }) as never,
      resolveRuntimeCliBackends: () => [
        {
          id: "claude-cli",
          modelProvider: "anthropic",
          pluginId: "anthropic",
          config: { command: "claude", forkArg: "--fork-session" },
        },
        {
          id: "google-gemini-cli",
          modelProvider: "google",
          pluginId: "google",
          config: { command: "gemini" },
        },
      ],
    });
  });

  async function writeSessionStoreSeed(sessionStore: Record<string, SessionEntry>): Promise<void> {
    for (const [sessionKey, entry] of Object.entries(sessionStore)) {
      await replaceSessionEntry({ sessionKey, storePath }, entry);
    }
  }

  function createSubagentAnnounceSessionStore(
    requesterSessionKey: string,
    requesterSessionEntry: SessionEntry,
    envelope: Pick<SubagentAnnounceDeliveryCase, "inheritedToolAllow" | "inheritedToolDeny">,
  ): Record<string, SessionEntry> {
    return {
      [requesterSessionKey]: requesterSessionEntry,
      [SUBAGENT_ANNOUNCE_CHILD_SESSION_KEY]: {
        sessionId: "subagent-announce-child",
        updatedAt: Date.now(),
        spawnedBy: requesterSessionKey,
        spawnDepth: 1,
        subagentRole: "leaf",
        subagentControlScope: "none",
        inheritedToolPolicyVersion: 1,
        inheritedToolAllow: [...(envelope.inheritedToolAllow ?? SUBAGENT_ANNOUNCE_REQUESTER_TOOLS)],
        ...(envelope.inheritedToolDeny
          ? { inheritedToolDeny: [...envelope.inheritedToolDeny] }
          : {}),
      },
    };
  }

  function readSessionStore(): Record<string, SessionEntry> {
    return Object.fromEntries(
      listSessionEntries({ storePath }).map(({ entry, sessionKey }) => [sessionKey, entry]),
    );
  }

  afterEach(async () => {
    vi.useRealTimers();
    cliBackendsTesting.resetDepsForTest();
    clearRuntimeAuthProfileStoreSnapshots();
    clearSessionStoreCacheForTest();
    for (const database of listOpenClawAgentDatabasesForTest()) {
      if (!database.path.startsWith(`${suiteRoot}${path.sep}`)) {
        continue;
      }
      runOpenClawAgentWriteTransaction(
        (fixture) => {
          fixture.db.exec(`
            DELETE FROM session_transcript_fts;
            DELETE FROM session_nodes;
            DELETE FROM conversations;
            DELETE FROM auth_profile_store;
            DELETE FROM auth_profile_state;
            DELETE FROM cache_entries;
            DELETE FROM state_leases;
          `);
        },
        database,
        { operationLabel: "test.attempt-execution.reset" },
      );
    }
    await fs.rm(tmpDir, { recursive: true, force: true });
    await fs.rm(storePath, { force: true });
    homeEnvSnapshot?.restore();
    homeEnvSnapshot = undefined;
  });

  afterAll(async () => {
    for (const database of listOpenClawAgentDatabasesForTest()) {
      if (database.path.startsWith(`${suiteRoot}${path.sep}`)) {
        disposeOpenClawAgentDatabaseByPath(database.path, {
          env: { OPENCLAW_STATE_DIR: suiteRoot },
        });
      }
    }
    await fixtureRoot.cleanup();
  });

  it("forwards explicit local-agent timeouts while preserving the default when omitted", async () => {
    const explicitTimeoutMs = 21_600_000;
    const explicit = await runOpenClawEmbeddedAttemptForTest({
      runId: "explicit-local-timeout",
      timeoutMs: explicitTimeoutMs,
      runTimeoutOverrideMs: explicitTimeoutMs,
    });
    expect(explicit.timeoutMs).toBe(explicitTimeoutMs);
    expect(explicit.runTimeoutOverrideMs).toBe(explicitTimeoutMs);

    const configuredDefaultMs = 600_000;
    const inherited = await runOpenClawEmbeddedAttemptForTest({
      runId: "inherited-local-timeout",
      timeoutMs: configuredDefaultMs,
    });
    expect(inherited.timeoutMs).toBe(configuredDefaultMs);
    expect(inherited.runTimeoutOverrideMs).toBeUndefined();
  });

  it("forwards execution admission callbacks to the embedded runtime", async () => {
    const onExecutionStarted = vi.fn();
    const embedded = await runOpenClawEmbeddedAttemptForTest({
      runId: "embedded-execution-started",
      opts: { onExecutionStarted },
    });
    const callback = embedded.onExecutionStarted;

    expect(callback).toBeTypeOf("function");
    (callback as (info?: { lifecycleGeneration?: string }) => void)({
      lifecycleGeneration: "next-generation",
    });
    expect(onExecutionStarted).toHaveBeenCalledTimes(1);
  });

  it("forwards authoritative channel type to embedded runs with opaque session keys", async () => {
    const embedded = await runOpenClawEmbeddedAttemptForTest({
      runId: "embedded-opaque-channel",
      sessionKey: "agent:main:opaque:binding",
      sessionEntry: { chatType: "channel" },
    });

    expect(embedded).toMatchObject({
      sessionKey: "agent:main:opaque:binding",
      chatType: "channel",
    });
  });

  async function runClaudeCliAttempt(params: {
    sessionKey: string;
    sessionEntry: SessionEntry;
    sessionStore: Record<string, SessionEntry>;
    body: string;
    runId: string;
    cwd?: string;
    onExecutionStarted?: () => void;
  }) {
    await runAgentAttempt({
      providerOverride: "claude-cli",
      originalProvider: "claude-cli",
      modelOverride: "opus",
      cfg: {} as OpenClawConfig,
      sessionEntry: params.sessionEntry,
      sessionId: params.sessionEntry.sessionId,
      sessionKey: params.sessionKey,
      sessionAgentId: "main",
      sessionFile: path.join(tmpDir, "session.jsonl"),
      workspaceDir: tmpDir,
      cwd: params.cwd,
      body: params.body,
      isFallbackRetry: false,
      resolvedThinkLevel: "medium",
      timeoutMs: 1_000,
      runId: params.runId,
      opts: {
        onExecutionStarted: params.onExecutionStarted,
      } as Parameters<typeof runAgentAttempt>[0]["opts"],
      runContext: {} as Parameters<typeof runAgentAttempt>[0]["runContext"],
      spawnedBy: undefined,
      messageChannel: undefined,
      skillsSnapshot: undefined,
      resolvedVerboseLevel: undefined,
      agentDir,
      onAgentEvent: vi.fn(),
      authProfileProvider: "claude-cli",
      sessionStore: params.sessionStore,
      storePath,
      sessionHasHistory: false,
    });
  }

  it("forwards execution admission callbacks to the CLI runtime", async () => {
    const sessionKey = "agent:main:direct:cli-execution-started";
    const sessionEntry: SessionEntry = {
      sessionId: "session-cli-execution-started",
      updatedAt: Date.now(),
    };
    const sessionStore = { [sessionKey]: sessionEntry };
    await writeSessionStoreSeed(sessionStore);
    const onExecutionStarted = vi.fn();
    runCliAgentMock.mockResolvedValueOnce(makeCliResult("started"));

    await runClaudeCliAttempt({
      sessionKey,
      sessionEntry,
      sessionStore,
      body: "start",
      runId: "run-cli-execution-started",
      onExecutionStarted,
    });

    expect(firstRunCliAgentArg().onExecutionStarted).toBe(onExecutionStarted);
  });

  it("forwards authoritative group type to CLI runs with opaque session keys", async () => {
    const sessionKey = "agent:main:opaque:binding";
    const sessionEntry: SessionEntry = {
      sessionId: "session-cli-opaque-group",
      updatedAt: Date.now(),
      chatType: "group",
    };
    const sessionStore = { [sessionKey]: sessionEntry };
    await writeSessionStoreSeed(sessionStore);
    runCliAgentMock.mockResolvedValueOnce(makeCliResult("shared"));

    await runClaudeCliAttempt({
      sessionKey,
      sessionEntry,
      sessionStore,
      body: "shared",
      runId: "run-cli-opaque-group",
    });

    expect(firstRunCliAgentArg()).toMatchObject({
      sessionKey,
      chatType: "group",
    });
  });

  async function writeClaudeCliAssistantTranscript(cliSessionId: string) {
    // Claude stores resumable sessions under a workspace-derived project dir,
    // so stale-session tests must create the same on-disk shape.
    const homeDir = path.join(tmpDir, `home-${cliSessionId}`);
    const projectsDir = resolveClaudeCliProjectDirForWorkspace({
      workspaceDir: tmpDir,
      homeDir,
    });
    setTestEnvValue("HOME", homeDir);
    await fs.mkdir(projectsDir, { recursive: true });
    await fs.writeFile(
      path.join(projectsDir, `${cliSessionId}.jsonl`),
      `${JSON.stringify({
        type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text: "old reply" }] },
      })}\n`,
      "utf-8",
    );
  }

  function makeClaudeCliSessionEntry(
    openclawSessionId: string,
    cliSessionId: string,
  ): SessionEntry {
    return {
      sessionId: openclawSessionId,
      updatedAt: Date.now(),
      cliSessionBindings: {
        "claude-cli": {
          sessionId: cliSessionId,
          authProfileId: "anthropic:claude-cli",
        },
      },
      cliSessionIds: { "claude-cli": cliSessionId },
      claudeCliSessionId: cliSessionId,
    };
  }

  it("clears stale Claude CLI session IDs before a fresh retry after session expiration", async () => {
    const sessionKey = "agent:main:subagent:cli-expired";
    const homeDir = path.join(tmpDir, "home");
    const projectsDir = resolveClaudeCliProjectDirForWorkspace({
      workspaceDir: tmpDir,
      homeDir,
    });
    setTestEnvValue("HOME", homeDir);
    await fs.mkdir(projectsDir, { recursive: true });
    await fs.writeFile(
      path.join(projectsDir, "stale-cli-session.jsonl"),
      `${JSON.stringify({
        type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text: "old reply" }] },
      })}\n`,
      "utf-8",
    );
    const sessionEntry: SessionEntry = {
      sessionId: "session-cli-123",
      updatedAt: Date.now(),
      cliSessionIds: { "claude-cli": "stale-cli-session" },
      claudeCliSessionId: "stale-legacy-session",
    };
    const sessionStore: Record<string, SessionEntry> = { [sessionKey]: sessionEntry };
    await writeSessionStoreSeed(sessionStore);

    // The retry hook must clear poisoned bindings before the fresh CLI attempt
    // runs, otherwise the runner would resume the same expired Claude session.
    runCliAgentMock.mockImplementationOnce(async (args: unknown) => {
      const retry = requireRecord(args, "run CLI agent argument").onBeforeFreshCliSessionRetry;
      expect(retry).toBeTypeOf("function");
      await (
        retry as (params: {
          provider: string;
          reason: "session_expired";
          sessionId: string;
        }) => Promise<boolean>
      )({
        provider: "claude-cli",
        reason: "session_expired",
        sessionId: "stale-cli-session",
      });
      expect(sessionStore[sessionKey]?.cliSessionIds?.["claude-cli"]).toBeUndefined();
      expect(sessionStore[sessionKey]?.claudeCliSessionId).toBeUndefined();
      return makeCliResult("hello from cli");
    });

    await runAgentAttempt({
      providerOverride: "claude-cli",
      originalProvider: "claude-cli",
      modelOverride: "opus",
      cfg: {} as OpenClawConfig,
      sessionEntry,
      sessionId: sessionEntry.sessionId,
      sessionKey,
      sessionAgentId: "main",
      sessionFile: path.join(tmpDir, "session.jsonl"),
      workspaceDir: tmpDir,
      body: "retry this",
      isFallbackRetry: false,
      resolvedThinkLevel: "medium",
      timeoutMs: 1_000,
      runId: "run-cli-expired",
      opts: {} as Parameters<typeof runAgentAttempt>[0]["opts"],
      runContext: {} as Parameters<typeof runAgentAttempt>[0]["runContext"],
      spawnedBy: undefined,
      messageChannel: undefined,
      skillsSnapshot: undefined,
      resolvedVerboseLevel: undefined,
      agentDir,
      onAgentEvent: vi.fn(),
      authProfileProvider: "claude-cli",
      sessionStore,
      storePath,
      sessionHasHistory: false,
    });

    expect(runCliAgentMock).toHaveBeenCalledTimes(1);
    expect(firstRunCliAgentArg().cliSessionId).toBe("stale-cli-session");
    expect(sessionStore[sessionKey]?.cliSessionIds?.["claude-cli"]).toBeUndefined();
    expect(sessionStore[sessionKey]?.claudeCliSessionId).toBeUndefined();

    const persisted = readSessionStore();
    expect(persisted[sessionKey]?.cliSessionIds?.["claude-cli"]).toBeUndefined();
    expect(persisted[sessionKey]?.claudeCliSessionId).toBeUndefined();
  });

  it("clears reused Claude CLI session IDs after AbortError without retrying", async () => {
    const sessionKey = "agent:main:direct:cli-abort";
    const cliSessionId = "abort-poisoned-session";
    await writeClaudeCliAssistantTranscript(cliSessionId);
    const sessionEntry = makeClaudeCliSessionEntry("session-cli-abort", cliSessionId);
    const sessionStore: Record<string, SessionEntry> = { [sessionKey]: sessionEntry };
    await writeSessionStoreSeed(sessionStore);
    const abortError = Object.assign(new Error("aborted"), { name: "AbortError" });
    runCliAgentMock.mockRejectedValueOnce(abortError);

    await expect(
      runClaudeCliAttempt({
        sessionKey,
        sessionEntry,
        sessionStore,
        body: "resume after abort",
        runId: "run-cli-abort",
      }),
    ).rejects.toMatchObject({ name: "AbortError" });

    expect(runCliAgentMock).toHaveBeenCalledTimes(1);
    expect(firstRunCliAgentArg().cliSessionId).toBe(cliSessionId);
    expect(sessionStore[sessionKey]?.cliSessionBindings?.["claude-cli"]).toBeUndefined();
    expect(sessionStore[sessionKey]?.cliSessionIds?.["claude-cli"]).toBeUndefined();
    expect(sessionStore[sessionKey]?.claudeCliSessionId).toBeUndefined();

    const persisted = readSessionStore();
    expect(persisted[sessionKey]?.cliSessionBindings?.["claude-cli"]).toBeUndefined();
    expect(persisted[sessionKey]?.cliSessionIds?.["claude-cli"]).toBeUndefined();
    expect(persisted[sessionKey]?.claudeCliSessionId).toBeUndefined();
  });

  it("clears a fork-marked Claude CLI session after terminal failover", async () => {
    const sessionKey = "agent:main:direct:cli-fork-expired";
    const cliSessionId = "expired-fork-source";
    await writeClaudeCliAssistantTranscript(cliSessionId);
    const sessionEntry = makeClaudeCliSessionEntry("session-cli-fork-expired", cliSessionId);
    sessionEntry.cliSessionBindings!["claude-cli"]!.forkNextResume = true;
    const sessionStore: Record<string, SessionEntry> = { [sessionKey]: sessionEntry };
    await writeSessionStoreSeed(sessionStore);
    runCliAgentMock.mockRejectedValueOnce(
      new FailoverError("fork source expired", {
        reason: "session_expired",
        provider: "claude-cli",
        model: "opus",
      }),
    );

    await expect(
      runClaudeCliAttempt({
        sessionKey,
        sessionEntry,
        sessionStore,
        body: "fork from an expired source",
        runId: "run-cli-fork-expired",
      }),
    ).rejects.toMatchObject({ name: "FailoverError", reason: "session_expired" });

    expect(firstRunCliAgentArg().forkCliSessionOnResume).toBe(true);
    expect(sessionStore[sessionKey]?.cliSessionBindings?.["claude-cli"]).toBeUndefined();
    expect(readSessionStore()[sessionKey]?.cliSessionBindings?.["claude-cli"]).toBeUndefined();
  });

  it("preserves a reused Claude CLI session after detached media starts", async () => {
    const sessionKey = "agent:main:cron:job:run:run-id";
    const cliSessionId = "media-continuation-session";
    await writeClaudeCliAssistantTranscript(cliSessionId);
    const sessionEntry = makeClaudeCliSessionEntry("run-id", cliSessionId);
    const sessionStore: Record<string, SessionEntry> = { [sessionKey]: sessionEntry };
    await fs.writeFile(storePath, JSON.stringify(sessionStore, null, 2), "utf-8");
    const abortError = Object.assign(new Error("aborted after media start"), {
      name: "AbortError",
    });
    runCliAgentMock.mockImplementationOnce(async () => {
      registerGeneratedMediaTaskActivity("tool:image_generate:run-1", sessionKey);
      throw abortError;
    });

    await expect(
      runClaudeCliAttempt({
        sessionKey,
        sessionEntry,
        sessionStore,
        body: "generate and continue",
        runId: "run-cli-media",
      }),
    ).rejects.toBe(abortError);

    expect(sessionStore[sessionKey]?.cliSessionBindings?.["claude-cli"]?.sessionId).toBe(
      cliSessionId,
    );
    const persisted = JSON.parse(await fs.readFile(storePath, "utf-8")) as Record<
      string,
      SessionEntry
    >;
    expect(persisted[sessionKey]?.cliSessionBindings?.["claude-cli"]?.sessionId).toBe(cliSessionId);
  });

  it("atomically forks and rebinds a reused Claude CLI session after timeout failover", async () => {
    const sessionKey = "agent:main:direct:cli-timeout";
    const cliSessionId = "timeout-poisoned-session";
    const forkedCliSessionId = "timeout-recovery-fork";
    await writeClaudeCliAssistantTranscript(cliSessionId);
    const sessionEntry = makeClaudeCliSessionEntry("session-cli-timeout", cliSessionId);
    const sessionStore: Record<string, SessionEntry> = { [sessionKey]: sessionEntry };
    await writeSessionStoreSeed(sessionStore);
    runCliAgentMock.mockImplementationOnce(async (args: unknown) => {
      const runArgs = requireRecord(args, "run CLI agent argument");
      const prepareFork = runArgs.onBeforeForkedCliSessionRetry;
      const claimFork = runArgs.claimCliSessionFork;
      const persistFork = runArgs.persistCliSessionForkSuccessor;
      expect(prepareFork).toBeTypeOf("function");
      expect(claimFork).toBeTypeOf("function");
      expect(persistFork).toBeTypeOf("function");
      await (
        prepareFork as (params: {
          provider: string;
          reason: "timeout";
          sessionId: string;
        }) => Promise<boolean>
      )({
        provider: "claude-cli",
        reason: "timeout",
        sessionId: cliSessionId,
      });
      expect(sessionStore[sessionKey]?.cliSessionBindings?.["claude-cli"]?.forkNextResume).toBe(
        true,
      );
      await (claimFork as () => Promise<boolean>)();
      expect(
        sessionStore[sessionKey]?.cliSessionBindings?.["claude-cli"]?.forkNextResume,
      ).toBeUndefined();
      await (persistFork as (sessionId: string) => Promise<void>)(forkedCliSessionId);
      expect(sessionStore[sessionKey]?.cliSessionBindings?.["claude-cli"]?.sessionId).toBe(
        forkedCliSessionId,
      );
      return makeCliResult("hello after timeout");
    });

    await runClaudeCliAttempt({
      sessionKey,
      sessionEntry,
      sessionStore,
      body: "resume after timeout",
      runId: "run-cli-timeout",
    });

    expect(runCliAgentMock).toHaveBeenCalledTimes(1);
    expect(firstRunCliAgentArg().cliSessionId).toBe(cliSessionId);
    expect(sessionStore[sessionKey]?.cliSessionBindings?.["claude-cli"]?.sessionId).toBe(
      forkedCliSessionId,
    );
    expect(sessionStore[sessionKey]?.cliSessionIds?.["claude-cli"]).toBe(forkedCliSessionId);
    expect(sessionStore[sessionKey]?.claudeCliSessionId).toBe(forkedCliSessionId);

    const persisted = readSessionStore();
    expect(persisted[sessionKey]?.cliSessionBindings?.["claude-cli"]?.sessionId).toBe(
      forkedCliSessionId,
    );
  });

  it("clears a persisted fork successor before transcript fallback", async () => {
    const sessionKey = "agent:main:direct:cli-fork-timeout";
    const cliSessionId = "timeout-parent-session";
    const forkedCliSessionId = "timeout-stalled-fork";
    await writeClaudeCliAssistantTranscript(cliSessionId);
    const sessionEntry = makeClaudeCliSessionEntry("session-cli-fork-timeout", cliSessionId);
    sessionEntry.cliSessionBindings!["claude-cli"]!.forkNextResume = true;
    const sessionStore: Record<string, SessionEntry> = { [sessionKey]: sessionEntry };
    await writeSessionStoreSeed(sessionStore);
    runCliAgentMock.mockImplementationOnce(async (args: unknown) => {
      const runArgs = requireRecord(args, "run CLI agent argument");
      const claimFork = runArgs.claimCliSessionFork;
      const persistFork = runArgs.persistCliSessionForkSuccessor;
      const clearFork = runArgs.onBeforeFreshCliSessionRetry;
      expect(runArgs.forkCliSessionOnResume).toBe(true);
      expect(runArgs.onBeforeForkedCliSessionRetry).toBeUndefined();
      expect(clearFork).toBeTypeOf("function");
      await (claimFork as () => Promise<boolean>)();
      await (persistFork as (sessionId: string) => Promise<void>)(forkedCliSessionId);
      await (
        clearFork as (params: {
          provider: string;
          reason: "timeout";
          sessionId: string;
        }) => Promise<boolean>
      )({
        provider: "claude-cli",
        reason: "timeout",
        sessionId: forkedCliSessionId,
      });
      return makeCliResult("hello after fork timeout");
    });

    await runClaudeCliAttempt({
      sessionKey,
      sessionEntry,
      sessionStore,
      body: "retry after fork timeout",
      runId: "run-cli-fork-timeout",
    });

    expect(sessionStore[sessionKey]?.cliSessionBindings?.["claude-cli"]).toBeUndefined();
    const persisted = readSessionStore();
    expect(persisted[sessionKey]?.cliSessionBindings?.["claude-cli"]).toBeUndefined();
  });

  it("clears a persisted fork successor when recovery fails after rebinding", async () => {
    const sessionKey = "agent:main:direct:cli-fork-finalization-failure";
    const cliSessionId = "finalization-parent-session";
    const forkedCliSessionId = "partial-fork-successor";
    await writeClaudeCliAssistantTranscript(cliSessionId);
    const sessionEntry = makeClaudeCliSessionEntry(
      "session-cli-fork-finalization-failure",
      cliSessionId,
    );
    sessionEntry.cliSessionBindings!["claude-cli"]!.forkNextResume = true;
    const sessionStore: Record<string, SessionEntry> = { [sessionKey]: sessionEntry };
    await writeSessionStoreSeed(sessionStore);
    const finalizationError = Object.assign(new Error("fork finalization failed"), {
      name: "AbortError",
    });
    runCliAgentMock.mockImplementationOnce(async (args: unknown) => {
      const runArgs = requireRecord(args, "run CLI agent argument");
      await (runArgs.claimCliSessionFork as () => Promise<boolean>)();
      await (runArgs.persistCliSessionForkSuccessor as (sessionId: string) => Promise<void>)(
        forkedCliSessionId,
      );
      throw finalizationError;
    });

    await expect(
      runClaudeCliAttempt({
        sessionKey,
        sessionEntry,
        sessionStore,
        body: "resume and fail after fork",
        runId: "run-cli-fork-finalization-failure",
      }),
    ).rejects.toBe(finalizationError);

    expect(sessionStore[sessionKey]?.cliSessionBindings?.["claude-cli"]).toBeUndefined();
    expect(readSessionStore()[sessionKey]?.cliSessionBindings?.["claude-cli"]).toBeUndefined();
  });

  it("preserves a restored fork marker when recovery dies before producing a successor", async () => {
    const sessionKey = "agent:main:direct:cli-fork-before-successor-failure";
    const cliSessionId = "recovery-source-session";
    await writeClaudeCliAssistantTranscript(cliSessionId);
    const sessionEntry = makeClaudeCliSessionEntry(
      "session-cli-fork-before-successor-failure",
      cliSessionId,
    );
    const sessionStore: Record<string, SessionEntry> = { [sessionKey]: sessionEntry };
    await writeSessionStoreSeed(sessionStore);
    const recoveryError = Object.assign(new Error("fork process died before init"), {
      name: "AbortError",
    });
    runCliAgentMock.mockImplementationOnce(async (args: unknown) => {
      const runArgs = requireRecord(args, "run CLI agent argument");
      await (
        runArgs.onBeforeForkedCliSessionRetry as (params: {
          provider: string;
          reason: "timeout";
          sessionId: string;
        }) => Promise<boolean>
      )({ provider: "claude-cli", reason: "timeout", sessionId: cliSessionId });
      await (runArgs.claimCliSessionFork as () => Promise<boolean>)();
      await (runArgs.restoreCliSessionFork as () => Promise<void>)();
      throw recoveryError;
    });

    await expect(
      runClaudeCliAttempt({
        sessionKey,
        sessionEntry,
        sessionStore,
        body: "resume and fail before fork init",
        runId: "run-cli-fork-before-successor-failure",
      }),
    ).rejects.toBe(recoveryError);

    expect(sessionStore[sessionKey]?.cliSessionBindings?.["claude-cli"]).toMatchObject({
      sessionId: cliSessionId,
      forkNextResume: true,
    });
    expect(readSessionStore()[sessionKey]?.cliSessionBindings?.["claude-cli"]).toMatchObject({
      sessionId: cliSessionId,
      forkNextResume: true,
    });
  });

  it("does not clear a concurrent rebind after failed fork recovery", async () => {
    const sessionKey = "agent:main:direct:cli-fork-concurrent-rebind";
    const cliSessionId = "concurrent-parent-session";
    const forkedCliSessionId = "failed-fork-successor";
    const concurrentCliSessionId = "newer-concurrent-session";
    await writeClaudeCliAssistantTranscript(cliSessionId);
    const sessionEntry = makeClaudeCliSessionEntry(
      "session-cli-fork-concurrent-rebind",
      cliSessionId,
    );
    const sessionStore: Record<string, SessionEntry> = { [sessionKey]: sessionEntry };
    await writeSessionStoreSeed(sessionStore);
    const recoveryError = Object.assign(new Error("fork recovery aborted"), {
      name: "AbortError",
    });
    runCliAgentMock.mockImplementationOnce(async (args: unknown) => {
      const runArgs = requireRecord(args, "run CLI agent argument");
      await (
        runArgs.onBeforeForkedCliSessionRetry as (params: {
          provider: string;
          reason: "timeout";
          sessionId: string;
        }) => Promise<boolean>
      )({ provider: "claude-cli", reason: "timeout", sessionId: cliSessionId });
      await (runArgs.claimCliSessionFork as () => Promise<boolean>)();
      await (runArgs.persistCliSessionForkSuccessor as (sessionId: string) => Promise<void>)(
        forkedCliSessionId,
      );

      const concurrentEntry = makeClaudeCliSessionEntry(
        sessionEntry.sessionId,
        concurrentCliSessionId,
      );
      await replaceSessionEntry({ sessionKey, storePath }, concurrentEntry);
      sessionStore[sessionKey] = concurrentEntry;
      throw recoveryError;
    });

    await expect(
      runClaudeCliAttempt({
        sessionKey,
        sessionEntry,
        sessionStore,
        body: "resume while another turn rebinds",
        runId: "run-cli-fork-concurrent-rebind",
      }),
    ).rejects.toBe(recoveryError);

    expect(sessionStore[sessionKey]?.cliSessionBindings?.["claude-cli"]?.sessionId).toBe(
      concurrentCliSessionId,
    );
    expect(readSessionStore()[sessionKey]?.cliSessionBindings?.["claude-cli"]?.sessionId).toBe(
      concurrentCliSessionId,
    );
  });

  it("does not install a stale-session clearing hook for storeless CLI attempts", async () => {
    const sessionKey = "agent:main:internal-storeless";
    const cliSessionId = "storeless-stale-session";
    await writeClaudeCliAssistantTranscript(cliSessionId);
    const sessionEntry = makeClaudeCliSessionEntry("session-storeless", cliSessionId);
    runCliAgentMock.mockResolvedValueOnce(makeCliResult("storeless ok"));

    // Storeless attempts cannot persist binding cleanup, so installing the hook
    // would only give callers a false sense that stale state was repaired.
    await runAgentAttempt({
      providerOverride: "claude-cli",
      originalProvider: "claude-cli",
      modelOverride: "opus",
      cfg: {} as OpenClawConfig,
      sessionEntry,
      sessionId: sessionEntry.sessionId,
      sessionKey,
      sessionAgentId: "main",
      sessionFile: path.join(tmpDir, "session.jsonl"),
      workspaceDir: tmpDir,
      body: "storeless retry path",
      isFallbackRetry: false,
      resolvedThinkLevel: "medium",
      timeoutMs: 1_000,
      runId: "run-storeless-cli",
      opts: {} as Parameters<typeof runAgentAttempt>[0]["opts"],
      runContext: {} as Parameters<typeof runAgentAttempt>[0]["runContext"],
      spawnedBy: undefined,
      messageChannel: undefined,
      skillsSnapshot: undefined,
      resolvedVerboseLevel: undefined,
      agentDir,
      onAgentEvent: vi.fn(),
      authProfileProvider: "claude-cli",
      sessionHasHistory: false,
    });

    expect(runCliAgentMock).toHaveBeenCalledTimes(1);
    expect(firstRunCliAgentArg().cliSessionId).toBe(cliSessionId);
    expect(firstRunCliAgentArg().onBeforeFreshCliSessionRetry).toBeUndefined();
  });

  it.each(["auth", "billing", "rate_limit"] as const)(
    "clears reused Claude CLI session IDs after %s failover without retrying",
    async (reason) => {
      const sessionKey = `agent:main:direct:cli-${reason}`;
      const cliSessionId = `${reason}-poisoned-session`;
      await writeClaudeCliAssistantTranscript(cliSessionId);
      const sessionEntry = makeClaudeCliSessionEntry(`session-cli-${reason}`, cliSessionId);
      const sessionStore: Record<string, SessionEntry> = { [sessionKey]: sessionEntry };
      await writeSessionStoreSeed(sessionStore);
      runCliAgentMock.mockRejectedValueOnce(
        new FailoverError(`${reason} failed`, {
          reason,
          provider: "claude-cli",
          model: "opus",
        }),
      );

      await expect(
        runClaudeCliAttempt({
          sessionKey,
          sessionEntry,
          sessionStore,
          body: `resume after ${reason}`,
          runId: `run-cli-${reason}`,
        }),
      ).rejects.toMatchObject({ name: "FailoverError", reason });

      expect(runCliAgentMock).toHaveBeenCalledTimes(1);
      expect(firstRunCliAgentArg().cliSessionId).toBe(cliSessionId);
      expect(sessionStore[sessionKey]?.cliSessionBindings?.["claude-cli"]).toBeUndefined();
      expect(sessionStore[sessionKey]?.cliSessionIds?.["claude-cli"]).toBeUndefined();
      expect(sessionStore[sessionKey]?.claudeCliSessionId).toBeUndefined();
    },
  );

  it("clears the persisted Claude CLI binding but still forwards the candidate when the stored transcript is missing", async () => {
    const sessionKey = "agent:main:direct:claude-missing-transcript";
    const homeDir = path.join(tmpDir, "home");
    setTestEnvValue("HOME", homeDir);
    const sessionEntry: SessionEntry = {
      sessionId: "openclaw-session-123",
      updatedAt: Date.now(),
      cliSessionBindings: {
        "claude-cli": {
          sessionId: "phantom-claude-session",
          authProfileId: "anthropic:claude-cli",
        },
      },
      cliSessionIds: { "claude-cli": "phantom-claude-session" },
      claudeCliSessionId: "phantom-claude-session",
    };
    const sessionStore: Record<string, SessionEntry> = { [sessionKey]: sessionEntry };
    await writeSessionStoreSeed(sessionStore);
    runCliAgentMock.mockResolvedValueOnce(makeCliResult("fresh cli response"));

    await runClaudeCliAttempt({
      sessionKey,
      sessionEntry,
      sessionStore,
      body: "remember me",
      runId: "run-cli-missing-transcript",
    });

    expect(runCliAgentMock).toHaveBeenCalledTimes(1);
    // The persisted binding is cleared so no later turn can blindly --resume the
    // phantom session, but the candidate id still rides along to runCliAgent so
    // prepare can re-detect the missing transcript and arm raw-transcript reseed.
    expect(firstRunCliAgentArg().cliSessionId).toBe("phantom-claude-session");
    expect(firstRunCliAgentArg().cliSessionBinding).toEqual({
      sessionId: "phantom-claude-session",
      authProfileId: "anthropic:claude-cli",
    });
    expect(sessionStore[sessionKey]?.cliSessionBindings?.["claude-cli"]).toBeUndefined();
    expect(sessionStore[sessionKey]?.cliSessionIds?.["claude-cli"]).toBeUndefined();
    expect(sessionStore[sessionKey]?.claudeCliSessionId).toBeUndefined();

    const persisted = readSessionStore();
    expect(persisted[sessionKey]?.cliSessionBindings?.["claude-cli"]).toBeUndefined();
    expect(persisted[sessionKey]?.cliSessionIds?.["claude-cli"]).toBeUndefined();
    expect(persisted[sessionKey]?.claudeCliSessionId).toBeUndefined();
  });

  it("keeps the bound claude-cli session id as the reuse candidate when the native transcript is missing (so reseed can recover)", async () => {
    const sessionKey = "agent:main:direct:claude-missing-transcript-reseed";
    const cliSessionId = "cli-sid-abc";
    // Bug condition: the managed stdio child is still live but Claude wrote no
    // native transcript. The durable binding and the current candidate must both
    // survive until prepare/execution prove that exact child reusable.
    const homeDir = path.join(tmpDir, "home-missing-transcript");
    const projectsDir = resolveClaudeCliProjectDirForWorkspace({
      workspaceDir: tmpDir,
      homeDir,
    });
    setTestEnvValue("HOME", homeDir);
    await fs.mkdir(projectsDir, { recursive: true });
    // Intentionally do NOT write `${cliSessionId}.jsonl` (no native transcript).
    const sessionEntry = makeClaudeCliSessionEntry("openclaw-sid", cliSessionId);
    const sessionStore: Record<string, SessionEntry> = { [sessionKey]: sessionEntry };
    await fs.writeFile(storePath, JSON.stringify(sessionStore, null, 2), "utf-8");
    hasClaudeLiveSessionForOwnerMock.mockReturnValue(true);
    runCliAgentMock.mockResolvedValueOnce(makeCliResult("ok"));

    await runClaudeCliAttempt({
      sessionKey,
      sessionEntry,
      sessionStore,
      body: "remember our earlier chat",
      runId: "run-cli-missing-transcript-reseed",
    });

    expect(runCliAgentMock).toHaveBeenCalledTimes(1);
    // Regression guard: before the fix the candidate was dropped (undefined),
    // starving prepare's reseed; the bound id must survive as the candidate.
    expect(firstRunCliAgentArg().cliSessionId).toBe(cliSessionId);
    expect(firstRunCliAgentArg().cliSessionBinding).toEqual({
      sessionId: cliSessionId,
      authProfileId: "anthropic:claude-cli",
    });
    expect(hasClaudeLiveSessionForOwnerMock).toHaveBeenCalledWith({
      backendId: "claude-cli",
      agentAccountId: undefined,
      agentId: "main",
      authProfileId: "anthropic:claude-cli",
      sessionId: "openclaw-sid",
      sessionKey,
    });
    expect(sessionStore[sessionKey]?.cliSessionBindings?.["claude-cli"]?.sessionId).toBe(
      cliSessionId,
    );
    const persisted = JSON.parse(await fs.readFile(storePath, "utf-8")) as Record<
      string,
      SessionEntry
    >;
    expect(persisted[sessionKey]?.cliSessionBindings?.["claude-cli"]?.sessionId).toBe(cliSessionId);
  });

  it("keeps Claude CLI resume when the stored transcript has assistant content", async () => {
    const sessionKey = "agent:main:direct:claude-transcript-present";
    const cliSessionId = "existing-claude-session";
    const homeDir = path.join(tmpDir, "home");
    const projectsDir = resolveClaudeCliProjectDirForWorkspace({
      workspaceDir: tmpDir,
      homeDir,
    });
    setTestEnvValue("HOME", homeDir);
    await fs.mkdir(projectsDir, { recursive: true });
    await fs.writeFile(
      path.join(projectsDir, `${cliSessionId}.jsonl`),
      `${JSON.stringify({
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "previous reply" }],
        },
      })}\n`,
      "utf-8",
    );
    const sessionEntry: SessionEntry = {
      sessionId: "openclaw-session-456",
      updatedAt: Date.now(),
      cliSessionBindings: {
        "claude-cli": {
          sessionId: cliSessionId,
          authProfileId: "anthropic:claude-cli",
        },
      },
      cliSessionIds: { "claude-cli": cliSessionId },
      claudeCliSessionId: cliSessionId,
    };
    const sessionStore: Record<string, SessionEntry> = { [sessionKey]: sessionEntry };
    await writeSessionStoreSeed(sessionStore);
    runCliAgentMock.mockResolvedValueOnce(makeCliResult("resumed cli response"));

    await runClaudeCliAttempt({
      sessionKey,
      sessionEntry,
      sessionStore,
      body: "continue",
      runId: "run-cli-transcript-present",
    });

    expect(runCliAgentMock).toHaveBeenCalledTimes(1);
    expect(firstRunCliAgentArg().cliSessionId).toBe(cliSessionId);
    expect(firstRunCliAgentArg().cliSessionBinding).toEqual({
      sessionId: cliSessionId,
      authProfileId: "anthropic:claude-cli",
    });
    expect(sessionStore[sessionKey]?.cliSessionIds?.["claude-cli"]).toBe(cliSessionId);
    expect(sessionStore[sessionKey]?.claudeCliSessionId).toBe(cliSessionId);
  });

  it("checks Claude CLI transcript content under the process cwd", async () => {
    const sessionKey = "agent:main:direct:claude-transcript-cwd-present";
    const cliSessionId = "existing-claude-cwd-session";
    const homeDir = path.join(tmpDir, "home");
    const cwd = path.join(tmpDir, "task");
    const projectsDir = resolveClaudeCliProjectDirForWorkspace({
      workspaceDir: cwd,
      homeDir,
    });
    setTestEnvValue("HOME", homeDir);
    await fs.mkdir(projectsDir, { recursive: true });
    await fs.writeFile(
      path.join(projectsDir, `${cliSessionId}.jsonl`),
      `${JSON.stringify({
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "previous reply" }],
        },
      })}\n`,
      "utf-8",
    );
    const sessionEntry = makeClaudeCliSessionEntry("openclaw-session-cwd", cliSessionId);
    const sessionStore: Record<string, SessionEntry> = { [sessionKey]: sessionEntry };
    await writeSessionStoreSeed(sessionStore);
    runCliAgentMock.mockResolvedValueOnce(makeCliResult("resumed cli response"));

    await runClaudeCliAttempt({
      sessionKey,
      sessionEntry,
      sessionStore,
      body: "continue from task cwd",
      runId: "run-cli-transcript-cwd-present",
      cwd,
    });

    expect(runCliAgentMock).toHaveBeenCalledTimes(1);
    expect(firstRunCliAgentArg().cliSessionId).toBe(cliSessionId);
    expect(firstRunCliAgentArg().cwd).toBe(cwd);
    expect(sessionStore[sessionKey]?.cliSessionIds?.["claude-cli"]).toBe(cliSessionId);
  });

  it("passes session-bound OpenAI Codex auth profile to codex-cli aliases", async () => {
    const sessionKey = "agent:main:direct:codex-cli-auth-alias";
    const sessionEntry: SessionEntry = {
      sessionId: "openclaw-session-codex",
      updatedAt: Date.now(),
      authProfileOverride: "openai:work",
      authProfileOverrideSource: "user",
    };
    const sessionStore: Record<string, SessionEntry> = { [sessionKey]: sessionEntry };
    await writeSessionStoreSeed(sessionStore);
    runCliAgentMock.mockResolvedValueOnce(makeCliResult("codex cli response"));

    await runAgentAttempt({
      providerOverride: "codex-cli",
      originalProvider: "codex-cli",
      modelOverride: "gpt-5.4",
      cfg: {} as OpenClawConfig,
      sessionEntry,
      sessionId: sessionEntry.sessionId,
      sessionKey,
      sessionAgentId: "main",
      sessionFile: path.join(tmpDir, "session.jsonl"),
      workspaceDir: tmpDir,
      body: "continue",
      isFallbackRetry: false,
      resolvedThinkLevel: "medium",
      timeoutMs: 1_000,
      runId: "run-codex-cli-auth-alias",
      opts: {} as Parameters<typeof runAgentAttempt>[0]["opts"],
      runContext: {} as Parameters<typeof runAgentAttempt>[0]["runContext"],
      spawnedBy: undefined,
      messageChannel: undefined,
      skillsSnapshot: undefined,
      resolvedVerboseLevel: undefined,
      agentDir,
      onAgentEvent: vi.fn(),
      authProfileProvider: "openai",
      sessionStore,
      storePath,
      sessionHasHistory: false,
    });

    expect(runCliAgentMock).toHaveBeenCalledTimes(1);
    expect(firstRunCliAgentArg().authProfileId).toBe("openai:work");
  });

  it("skips auto auth-profile resolution for CLI-owned transport", async () => {
    const sessionKey = "agent:main:direct:codex-cli-owned-transport";
    const sessionEntry: SessionEntry = {
      sessionId: "openclaw-session-codex-owned",
      updatedAt: Date.now(),
    };
    const sessionStore: Record<string, SessionEntry> = { [sessionKey]: sessionEntry };
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          agentRuntime: { id: "codex" },
        },
      },
    };
    await writeSessionStoreSeed(sessionStore);
    await fs.writeFile(path.join(tmpDir, "auth-profiles.json"), "{", "utf-8");
    runCliAgentMock.mockResolvedValueOnce(makeCliResult("codex cli response"));

    await runAgentAttempt({
      providerOverride: "codex-cli",
      originalProvider: "codex-cli",
      modelOverride: "gpt-5.4",
      cfg,
      sessionEntry,
      sessionId: sessionEntry.sessionId,
      sessionKey,
      sessionAgentId: "main",
      sessionFile: path.join(tmpDir, "session.jsonl"),
      workspaceDir: tmpDir,
      body: "continue",
      isFallbackRetry: false,
      resolvedThinkLevel: "medium",
      timeoutMs: 1_000,
      runId: "run-codex-cli-owned-transport-auth-skip",
      opts: {} as Parameters<typeof runAgentAttempt>[0]["opts"],
      runContext: {} as Parameters<typeof runAgentAttempt>[0]["runContext"],
      spawnedBy: undefined,
      messageChannel: undefined,
      skillsSnapshot: undefined,
      resolvedVerboseLevel: undefined,
      agentDir,
      onAgentEvent: vi.fn(),
      authProfileProvider: "openai-codex",
      sessionStore,
      storePath,
      sessionHasHistory: false,
    });

    expect(runCliAgentMock).toHaveBeenCalledTimes(1);
    expect(firstRunCliAgentArg().authProfileId).toBeUndefined();
  });

  it("selects a google-gemini-cli auth profile for canonical Google models routed through Gemini CLI", async () => {
    const sessionKey = "agent:main:direct:gemini-cli-auth-bridge";
    const sessionEntry: SessionEntry = {
      sessionId: "openclaw-session-gemini",
      updatedAt: Date.now(),
    };
    const sessionStore: Record<string, SessionEntry> = { [sessionKey]: sessionEntry };
    saveAuthProfileStore(
      {
        version: 1,
        profiles: {
          "google-gemini-cli:user@example.test": {
            type: "oauth",
            provider: "google-gemini-cli",
            access: "access-token",
            refresh: "refresh-token",
            expires: Date.now() + 3_600_000,
            email: "user@example.test",
          },
        },
      },
      agentDir,
      { filterExternalAuthProfiles: false, syncExternalCli: false },
    );
    runCliAgentMock.mockResolvedValueOnce(makeCliResult("gemini cli response"));

    await runAgentAttempt({
      providerOverride: "google",
      originalProvider: "google",
      modelOverride: "gemini-3.1-pro-preview",
      cfg: {
        auth: {
          order: {
            "google-gemini-cli": ["google-gemini-cli:user@example.test"],
          },
        },
        agents: {
          defaults: {
            models: {
              "google/gemini-3.1-pro-preview": {
                agentRuntime: { id: "google-gemini-cli" },
              },
            },
          },
        },
      } as OpenClawConfig,
      sessionEntry,
      sessionId: sessionEntry.sessionId,
      sessionKey,
      sessionAgentId: "main",
      sessionFile: path.join(tmpDir, "session.jsonl"),
      workspaceDir: tmpDir,
      body: "continue",
      isFallbackRetry: false,
      resolvedThinkLevel: "medium",
      timeoutMs: 1_000,
      runId: "run-gemini-cli-auth-bridge",
      opts: {} as Parameters<typeof runAgentAttempt>[0]["opts"],
      runContext: {} as Parameters<typeof runAgentAttempt>[0]["runContext"],
      spawnedBy: undefined,
      messageChannel: undefined,
      skillsSnapshot: undefined,
      resolvedVerboseLevel: undefined,
      agentDir,
      onAgentEvent: vi.fn(),
      authProfileProvider: "google",
      sessionStore,
      storePath,
      sessionHasHistory: false,
    });

    expect(runCliAgentMock).toHaveBeenCalledTimes(1);
    expect(firstRunCliAgentArg().provider).toBe("google-gemini-cli");
    expect(firstRunCliAgentArg().authProfileId).toBe("google-gemini-cli:user@example.test");
  });

  it("forwards pinned canonical Google API-key profiles to Google models routed through Gemini CLI", async () => {
    const sessionKey = "agent:main:direct:gemini-cli-google-api-key";
    const sessionEntry: SessionEntry = {
      sessionId: "openclaw-session-gemini-api-key",
      updatedAt: Date.now(),
      authProfileOverride: "google:api-key",
      authProfileOverrideSource: "user",
    };
    const sessionStore: Record<string, SessionEntry> = { [sessionKey]: sessionEntry };
    saveAuthProfileStore(
      {
        version: 1,
        profiles: {
          "google:api-key": {
            type: "api_key",
            provider: "google",
            key: "gemini-api-key",
          },
        },
      },
      agentDir,
      { filterExternalAuthProfiles: false, syncExternalCli: false },
    );
    runCliAgentMock.mockResolvedValueOnce(makeCliResult("gemini cli api-key response"));

    await runAgentAttempt({
      providerOverride: "google",
      originalProvider: "google",
      modelOverride: "gemini-3.1-pro-preview",
      cfg: {
        agents: {
          defaults: {
            models: {
              "google/gemini-3.1-pro-preview": {
                agentRuntime: { id: "google-gemini-cli" },
              },
            },
          },
        },
      } as OpenClawConfig,
      sessionEntry,
      sessionId: sessionEntry.sessionId,
      sessionKey,
      sessionAgentId: "main",
      sessionFile: path.join(tmpDir, "session.jsonl"),
      workspaceDir: tmpDir,
      body: "continue",
      isFallbackRetry: false,
      resolvedThinkLevel: "medium",
      timeoutMs: 1_000,
      runId: "run-gemini-cli-google-api-key",
      opts: {} as Parameters<typeof runAgentAttempt>[0]["opts"],
      runContext: {} as Parameters<typeof runAgentAttempt>[0]["runContext"],
      spawnedBy: undefined,
      messageChannel: undefined,
      skillsSnapshot: undefined,
      resolvedVerboseLevel: undefined,
      agentDir,
      onAgentEvent: vi.fn(),
      authProfileProvider: "google",
      sessionStore,
      storePath,
      sessionHasHistory: false,
    });

    expect(runCliAgentMock).toHaveBeenCalledTimes(1);
    expect(firstRunCliAgentArg().provider).toBe("google-gemini-cli");
    expect(firstRunCliAgentArg().authProfileId).toBe("google:api-key");
  });

  it("rejects incompatible pinned profiles before selecting another CLI identity", async () => {
    const sessionKey = "agent:main:direct:gemini-cli-incompatible-auth";
    const sessionEntry: SessionEntry = {
      sessionId: "openclaw-session-gemini-incompatible-auth",
      updatedAt: Date.now(),
      authProfileOverride: "vercel-ai-gateway:default",
      authProfileOverrideSource: "user",
    };
    const sessionStore: Record<string, SessionEntry> = { [sessionKey]: sessionEntry };
    saveAuthProfileStore(
      {
        version: 1,
        profiles: {
          "vercel-ai-gateway:default": {
            type: "api_key",
            provider: "vercel-ai-gateway",
            key: "vercel-key",
          },
        },
      },
      agentDir,
      { filterExternalAuthProfiles: false, syncExternalCli: false },
    );
    expect(() =>
      runAgentAttempt({
        providerOverride: "google",
        originalProvider: "google",
        modelOverride: "gemini-3.1-pro-preview",
        cfg: {
          agents: {
            defaults: {
              models: {
                "google/gemini-3.1-pro-preview": {
                  agentRuntime: { id: "google-gemini-cli" },
                },
              },
            },
          },
        } as OpenClawConfig,
        sessionEntry,
        sessionId: sessionEntry.sessionId,
        sessionKey,
        sessionAgentId: "main",
        sessionFile: path.join(tmpDir, "session.jsonl"),
        workspaceDir: tmpDir,
        body: "continue",
        isFallbackRetry: false,
        resolvedThinkLevel: "medium",
        timeoutMs: 1_000,
        runId: "run-gemini-cli-incompatible-auth",
        opts: {} as Parameters<typeof runAgentAttempt>[0]["opts"],
        runContext: {} as Parameters<typeof runAgentAttempt>[0]["runContext"],
        spawnedBy: undefined,
        messageChannel: undefined,
        skillsSnapshot: undefined,
        resolvedVerboseLevel: undefined,
        agentDir,
        onAgentEvent: vi.fn(),
        authProfileProvider: "google",
        sessionStore,
        storePath,
        sessionHasHistory: false,
      }),
    ).toThrow(/cannot use auth profile "vercel-ai-gateway:default"/);

    expect(runCliAgentMock).not.toHaveBeenCalled();
  });

  it("ignores stale auto-selected profiles when resolving Gemini CLI auth order", async () => {
    const sessionKey = "agent:main:direct:gemini-cli-stale-auto-auth";
    const sessionEntry: SessionEntry = {
      sessionId: "openclaw-session-gemini-stale-auto-auth",
      updatedAt: Date.now(),
      authProfileOverride: "openai:work",
      authProfileOverrideSource: "auto",
    };
    const sessionStore: Record<string, SessionEntry> = { [sessionKey]: sessionEntry };
    saveAuthProfileStore(
      {
        version: 1,
        profiles: {
          "openai:work": {
            type: "oauth",
            provider: "openai",
            access: "openai-access",
            refresh: "openai-refresh",
            expires: Date.now() + 60_000,
          },
          "google:api-key": {
            type: "api_key",
            provider: "google",
            key: "gemini-api-key",
          },
        },
      },
      agentDir,
      { filterExternalAuthProfiles: false, syncExternalCli: false },
    );
    runCliAgentMock.mockResolvedValueOnce(makeCliResult("gemini cli api-key response"));

    await runAgentAttempt({
      providerOverride: "google",
      originalProvider: "google",
      modelOverride: "gemini-3.1-pro-preview",
      cfg: {
        auth: {
          order: {
            google: ["google:api-key"],
          },
        },
        agents: {
          defaults: {
            models: {
              "google/gemini-3.1-pro-preview": {
                agentRuntime: { id: "google-gemini-cli" },
              },
            },
          },
        },
      } as OpenClawConfig,
      sessionEntry,
      sessionId: sessionEntry.sessionId,
      sessionKey,
      sessionAgentId: "main",
      sessionFile: path.join(tmpDir, "session.jsonl"),
      workspaceDir: tmpDir,
      body: "continue",
      isFallbackRetry: false,
      resolvedThinkLevel: "medium",
      timeoutMs: 1_000,
      runId: "run-gemini-cli-stale-auto-auth",
      opts: {} as Parameters<typeof runAgentAttempt>[0]["opts"],
      runContext: {} as Parameters<typeof runAgentAttempt>[0]["runContext"],
      spawnedBy: undefined,
      messageChannel: undefined,
      skillsSnapshot: undefined,
      resolvedVerboseLevel: undefined,
      agentDir,
      onAgentEvent: vi.fn(),
      authProfileProvider: "google",
      sessionStore,
      storePath,
      sessionHasHistory: false,
    });

    expect(runCliAgentMock).toHaveBeenCalledTimes(1);
    expect(firstRunCliAgentArg().provider).toBe("google-gemini-cli");
    expect(firstRunCliAgentArg().authProfileId).toBe("google:api-key");
  });

  it("selects canonical Google API-key auth order for Google models routed through Gemini CLI", async () => {
    const sessionKey = "agent:main:direct:gemini-cli-google-api-key-order";
    const sessionEntry: SessionEntry = {
      sessionId: "openclaw-session-gemini-api-key-order",
      updatedAt: Date.now(),
    };
    const sessionStore: Record<string, SessionEntry> = { [sessionKey]: sessionEntry };
    saveAuthProfileStore(
      {
        version: 1,
        profiles: {
          "google:api-key": {
            type: "api_key",
            provider: "google",
            key: "gemini-api-key",
          },
        },
      },
      agentDir,
      { filterExternalAuthProfiles: false, syncExternalCli: false },
    );
    runCliAgentMock.mockResolvedValueOnce(makeCliResult("gemini cli api-key response"));

    await runAgentAttempt({
      providerOverride: "google",
      originalProvider: "google",
      modelOverride: "gemini-3.1-pro-preview",
      cfg: {
        auth: {
          order: {
            google: ["google:api-key"],
          },
        },
        agents: {
          defaults: {
            models: {
              "google/gemini-3.1-pro-preview": {
                agentRuntime: { id: "google-gemini-cli" },
              },
            },
          },
        },
      } as OpenClawConfig,
      sessionEntry,
      sessionId: sessionEntry.sessionId,
      sessionKey,
      sessionAgentId: "main",
      sessionFile: path.join(tmpDir, "session.jsonl"),
      workspaceDir: tmpDir,
      body: "continue",
      isFallbackRetry: false,
      resolvedThinkLevel: "medium",
      timeoutMs: 1_000,
      runId: "run-gemini-cli-google-api-key-order",
      opts: {} as Parameters<typeof runAgentAttempt>[0]["opts"],
      runContext: {} as Parameters<typeof runAgentAttempt>[0]["runContext"],
      spawnedBy: undefined,
      messageChannel: undefined,
      skillsSnapshot: undefined,
      resolvedVerboseLevel: undefined,
      agentDir,
      onAgentEvent: vi.fn(),
      authProfileProvider: "google",
      sessionStore,
      storePath,
      sessionHasHistory: false,
    });

    expect(runCliAgentMock).toHaveBeenCalledTimes(1);
    expect(firstRunCliAgentArg().provider).toBe("google-gemini-cli");
    expect(firstRunCliAgentArg().authProfileId).toBe("google:api-key");
  });

  it.each(["CLI", "ACP"] as const)(
    "keeps an explicit internal %s transcript out of the visible session path",
    async (runtime) => {
      const visibleSessionId = `session-explicit-internal-${runtime.toLowerCase()}`;
      const sessionId = `internal-${visibleSessionId}`;
      const sessionKey = `agent:main:internal-session-effects:${visibleSessionId}`;
      setTestEnvValue("HOME", tmpDir);
      setTestEnvValue("OPENCLAW_STATE_DIR", path.join(tmpDir, "state"));
      const internalStorePath = storePath;
      const internalSessionFile = formatSqliteSessionFileMarker({
        agentId: "main",
        sessionId,
        storePath: internalStorePath,
      });
      const sessionEntry: SessionEntry = {
        sessionId,
        sessionFile: internalSessionFile,
        updatedAt: Date.now(),
      };

      if (runtime === "CLI") {
        await persistCliTurnTranscript({
          body: "internal prompt",
          result: makeCliResult("internal reply"),
          sessionId,
          sessionKey,
          sessionFile: internalSessionFile,
          sessionEntry,
          sessionAgentId: "main",
          sessionCwd: tmpDir,
          storePath,
          config: {},
          embeddedAssistantGapFill: true,
        });
      } else {
        await persistAcpTurnTranscript({
          body: "internal prompt",
          finalText: "internal reply",
          sessionId,
          sessionKey,
          sessionFile: internalSessionFile,
          sessionEntry,
          sessionAgentId: "main",
          sessionCwd: tmpDir,
          storePath,
          config: {},
        });
      }

      expect(await readSessionMessages(internalSessionFile)).toContainEqual(
        expect.objectContaining({
          role: "assistant",
          content: [{ type: "text", text: "internal reply" }],
        }),
      );
      expect(
        await loadTranscriptEvents({
          agentId: "main",
          sessionId: visibleSessionId,
          storePath,
        }),
      ).toEqual([]);
    },
  );

  it("persists CLI replies into the session transcript", async () => {
    const sessionKey = "agent:main:subagent:cli-transcript";
    const sessionFile = path.join(tmpDir, "session-cli-transcript.jsonl");
    const sessionEntry: SessionEntry = {
      sessionId: "session-cli-transcript",
      sessionFile,
      updatedAt: 1,
      status: "running",
      startedAt: 2,
    };
    const sessionStore: Record<string, SessionEntry> = { [sessionKey]: sessionEntry };
    await writeSessionStoreSeed({
      [sessionKey]: {
        ...sessionEntry,
        updatedAt: 5,
        status: "done",
        endedAt: 4,
      },
    });
    clearSessionStoreCacheForTest();

    const nowCalls: number[] = [];
    let nextNow = 10_000;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => {
      nextNow += 1_000;
      nowCalls.push(nextNow);
      return nextNow;
    });
    let updatedEntry: SessionEntry | undefined;
    try {
      updatedEntry = await persistCliTranscriptEntry({
        body: "persist this",
        result: makeCliResult("hello from cli"),
        sessionId: sessionEntry.sessionId,
        sessionKey,
        sessionEntry,
        sessionStore,
        storePath,
        sessionAgentId: "main",
        sessionCwd: tmpDir,
        config: {},
      });
    } finally {
      nowSpy.mockRestore();
    }

    expect(updatedEntry).not.toHaveProperty("sessionFile");
    const target = {
      agentId: "main",
      sessionId: sessionEntry.sessionId,
      sessionKey,
      storePath,
    };
    const entries = await readSessionFileEntries(target);
    expectRecordFields(requireRecord(entries[0], "session entry"), {
      type: "session",
      id: sessionEntry.sessionId,
      cwd: tmpDir,
    });
    expectRecordFields(requireRecord(entries[1], "user transcript entry"), {
      type: "message",
      parentId: null,
    });
    expectRecordFields(requireRecord(entries[2], "assistant transcript entry"), {
      type: "message",
      parentId: entries[1]?.id,
    });
    const messages = await readSessionMessages(target);
    expect(messages).toHaveLength(2);
    expectRecordFields(requireRecord(messages[0], "user message"), {
      role: "user",
      content: "persist this",
    });
    expectRecordFields(requireRecord(messages[1], "assistant message"), {
      role: "assistant",
      api: "cli",
      provider: "claude-cli",
      model: "opus",
      content: [{ type: "text", text: "hello from cli" }],
    });

    const persisted = readSessionStore();
    expect(persisted[sessionKey]).not.toHaveProperty("sessionFile");
    expect(persisted[sessionKey]?.updatedAt).toBeGreaterThan(sessionEntry.updatedAt);
    expect(persisted[sessionKey]?.updatedAt).toBeLessThanOrEqual(nowCalls.at(-1) ?? 0);
    expect(sessionStore[sessionKey]?.updatedAt).toBe(persisted[sessionKey]?.updatedAt);
  });

  it("mirrors only the CLI reply when the shared recorder already persisted the user turn", async () => {
    const sessionKey = "agent:main:direct:cli-recorder-owned-user";
    const sessionFile = path.join(tmpDir, "session-cli-recorder-owned-user.jsonl");
    const sessionEntry: SessionEntry = {
      sessionId: "session-cli-recorder-owned-user",
      sessionFile,
      updatedAt: Date.now(),
    };
    const sessionStore: Record<string, SessionEntry> = { [sessionKey]: sessionEntry };
    await writeSessionStoreSeed(sessionStore);
    await appendTranscriptMessage(
      { agentId: "main", sessionId: sessionEntry.sessionId, sessionKey, storePath },
      {
        message: {
          role: "user",
          content: "canonical current ask",
          timestamp: Date.now(),
        },
        cwd: tmpDir,
      },
    );

    await persistCliTurnTranscript({
      body: "canonical current ask",
      result: makeCliResult("hello from cli"),
      sessionId: sessionEntry.sessionId,
      sessionKey,
      sessionEntry,
      sessionStore,
      storePath,
      sessionAgentId: "main",
      sessionCwd: tmpDir,
      config: {},
      skipUserTurn: true,
    });

    const messages = await readSessionMessages(
      formatSqliteSessionFileMarker({
        agentId: "main",
        sessionId: sessionEntry.sessionId,
        storePath,
      }),
    );
    expect(messages.filter((message) => message.role === "user")).toHaveLength(1);
    expect(messages).toContainEqual(
      expect.objectContaining({
        role: "assistant",
        content: [{ type: "text", text: "hello from cli" }],
      }),
    );
  });

  it("does not gap-fill an assistant already owned by the runtime", async () => {
    const sessionKey = "agent:main:direct:runtime-owned-assistant";
    const sessionEntry: SessionEntry = {
      sessionId: "session-runtime-owned-assistant",
      updatedAt: Date.now(),
    };
    await appendTranscriptMessage(
      { agentId: "main", sessionId: sessionEntry.sessionId, sessionKey, storePath },
      {
        message: {
          role: "assistant",
          content: [{ type: "text", text: "runtime answer" }],
          timestamp: Date.now(),
        },
        cwd: tmpDir,
      },
    );

    await persistCliTurnTranscript({
      body: "ignored prompt",
      result: makeCliResult("runtime answer"),
      sessionId: sessionEntry.sessionId,
      sessionKey,
      sessionEntry,
      storePath,
      sessionAgentId: "main",
      sessionCwd: tmpDir,
      config: {},
      embeddedAssistantGapFill: true,
      skipAssistantTurn: true,
    });

    const messages = await readSessionMessages(
      formatSqliteSessionFileMarker({
        agentId: "main",
        sessionId: sessionEntry.sessionId,
        storePath,
      }),
    );
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      role: "assistant",
      content: [{ type: "text", text: "runtime answer" }],
    });
  });

  it("holds the session-key lease for the embedded assistant gap-fill", async () => {
    const sessionKey = "agent:main:direct:gap-fill-lease";
    const sessionEntry: SessionEntry = {
      sessionId: "session-gap-fill-lease",
      updatedAt: Date.now(),
    };
    await writeSessionStoreSeed({ [sessionKey]: sessionEntry });
    const release = vi.fn();
    sessionWriteLockMocks.acquireSessionWriteLock.mockResolvedValueOnce({ release });

    await persistCliTurnTranscript({
      body: "ignored prompt",
      result: makeCliResult("runtime answer"),
      sessionId: sessionEntry.sessionId,
      sessionKey,
      sessionEntry,
      storePath,
      sessionAgentId: "main",
      sessionCwd: tmpDir,
      config: {},
      embeddedAssistantGapFill: true,
    });

    expect(sessionWriteLockMocks.acquireSessionWriteLock).toHaveBeenCalledOnce();
    expect(sessionWriteLockMocks.acquireSessionWriteLock).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionFile: expect.any(String),
        targetKind: "session-key",
      }),
    );
    expect(release).toHaveBeenCalledOnce();
  });

  it("persists a media-only ACP user turn when the reply is empty", async () => {
    const sessionKey = "agent:main:direct:acp-media-only";
    const sessionFile = path.join(tmpDir, "session-acp-media-only.jsonl");
    const sessionEntry: SessionEntry = {
      sessionId: "session-acp-media-only",
      sessionFile,
      updatedAt: Date.now(),
    };
    const sessionStore: Record<string, SessionEntry> = { [sessionKey]: sessionEntry };
    await writeSessionStoreSeed(sessionStore);

    await persistAcpTurnTranscript({
      body: "[media attached: media://inbound/image-1]",
      transcriptBody: "",
      userInput: {
        text: "",
        media: [{ path: "/media/inbound/image-1.png", contentType: "image/png" }],
      },
      finalText: "",
      sessionId: sessionEntry.sessionId,
      sessionKey,
      sessionEntry,
      sessionStore,
      storePath,
      sessionAgentId: "main",
      sessionCwd: tmpDir,
      config: {},
    });

    expect(
      await readSessionMessages(
        formatSqliteSessionFileMarker({
          agentId: "main",
          sessionId: sessionEntry.sessionId,
          storePath,
        }),
      ),
    ).toContainEqual(
      expect.objectContaining({
        role: "user",
        content: "",
        __openclaw: {
          media: [
            expect.objectContaining({
              path: "/media/inbound/image-1.png",
              contentType: "image/png",
            }),
          ],
        },
      }),
    );
  });

  it("does not append a CLI transcript after the session is deleted", async () => {
    const sessionKey = "agent:main:subagent:cli-transcript-deleted";
    const staleSessionFile = path.join(tmpDir, "session-cli-stale.jsonl");
    const staleEntry: SessionEntry = {
      sessionId: "session-cli-stale",
      sessionFile: staleSessionFile,
      updatedAt: 1,
    };
    const sessionStore: Record<string, SessionEntry> = { [sessionKey]: staleEntry };
    clearSessionStoreCacheForTest();

    const result = await persistCliTurnTranscript({
      body: "late prompt",
      result: makeCliResult("late reply"),
      sessionId: staleEntry.sessionId,
      sessionKey,
      sessionEntry: staleEntry,
      sessionStore,
      storePath,
      sessionAgentId: "main",
      sessionCwd: tmpDir,
      config: {},
    });

    expect(result).toEqual({ kind: "session-rebound", sessionEntry: undefined });
    await expect(fs.stat(staleSessionFile)).rejects.toMatchObject({ code: "ENOENT" });
    const persisted = readSessionStore();
    expect(persisted[sessionKey]).toBeUndefined();
  });

  it("embedded assistant gap-fill skips user mirror and dedupes identical assistant tails", async () => {
    const sessionKey = "agent:main:subagent:embedded-gap-fill";
    const sessionEntry: SessionEntry = {
      sessionId: "session-embedded-gap-fill",
      updatedAt: Date.now(),
    };
    const sessionStore: Record<string, SessionEntry> = { [sessionKey]: sessionEntry };
    await writeSessionStoreSeed(sessionStore);

    const result = makeCliResult("already mirrored");
    result.meta.executionTrace = {
      winnerProvider: "anthropic",
      winnerModel: "claude-opus-4-6",
      fallbackUsed: false,
      runner: "embedded",
    };

    const updatedFirst = await persistCliTranscriptEntry({
      body: "ignored for gap fill",
      transcriptBody: "also ignored",
      result,
      sessionId: sessionEntry.sessionId,
      sessionKey,
      sessionEntry,
      sessionStore,
      storePath,
      sessionAgentId: "main",
      sessionCwd: tmpDir,
      config: {},
      embeddedAssistantGapFill: true,
    });

    const target = {
      agentId: "main",
      sessionId: sessionEntry.sessionId,
      sessionKey,
      storePath,
    };
    let messages = await readSessionMessages(target);
    expect(messages).toHaveLength(1);
    expectRecordFields(requireRecord(messages[0], "assistant message"), {
      role: "assistant",
      content: [{ type: "text", text: "already mirrored" }],
    });

    await persistCliTurnTranscript({
      body: "still ignored",
      result,
      sessionId: sessionEntry.sessionId,
      sessionKey,
      sessionEntry: updatedFirst,
      sessionStore,
      storePath,
      sessionAgentId: "main",
      sessionCwd: tmpDir,
      config: {},
      embeddedAssistantGapFill: true,
    });

    messages = await readSessionMessages(target);
    expect(messages).toHaveLength(1);
  });

  it("embedded assistant gap-fill skips trailing openclaw.cache-ttl custom entries (regression for #83427)", async () => {
    const sessionKey = "agent:main:subagent:embedded-gap-fill-cache-ttl";
    const sessionEntry: SessionEntry = {
      sessionId: "session-embedded-gap-fill-cache-ttl",
      updatedAt: Date.now(),
    };
    const sessionStore: Record<string, SessionEntry> = { [sessionKey]: sessionEntry };
    await writeSessionStoreSeed(sessionStore);

    const result = makeCliResult("canonical answer");
    result.meta.executionTrace = {
      winnerProvider: "anthropic",
      winnerModel: "claude-haiku-4-5-20251001",
      fallbackUsed: false,
      runner: "embedded",
    };

    const updatedFirst = await persistCliTranscriptEntry({
      body: "ignored for gap fill",
      result,
      sessionId: sessionEntry.sessionId,
      sessionKey,
      sessionEntry,
      sessionStore,
      storePath,
      sessionAgentId: "main",
      sessionCwd: tmpDir,
      config: {},
      embeddedAssistantGapFill: true,
    });
    await appendTranscriptEvent(
      { agentId: "main", sessionId: sessionEntry.sessionId, sessionKey, storePath },
      {
        type: "custom",
        customType: "openclaw.cache-ttl",
        timestamp: new Date().toISOString(),
        data: {
          provider: "anthropic",
          modelId: "claude-haiku-4-5-20251001",
        },
      } as never,
    );

    await persistCliTurnTranscript({
      body: "still ignored",
      result,
      sessionId: sessionEntry.sessionId,
      sessionKey,
      sessionEntry: updatedFirst,
      sessionStore,
      storePath,
      sessionAgentId: "main",
      sessionCwd: tmpDir,
      config: {},
      embeddedAssistantGapFill: true,
    });

    const messages = await readSessionMessages({
      agentId: "main",
      sessionId: sessionEntry.sessionId,
      sessionKey,
      storePath,
    });
    expect(messages).toHaveLength(1);
    expectRecordFields(requireRecord(messages[0], "assistant message"), {
      role: "assistant",
      content: [{ type: "text", text: "canonical answer" }],
    });
  });

  it("embedded assistant gap-fill appends repeated replies after a user tail", async () => {
    const sessionKey = "agent:main:subagent:embedded-repeated-reply";
    const sessionEntry: SessionEntry = {
      sessionId: "session-embedded-repeated-reply",
      updatedAt: Date.now(),
    };
    const sessionStore: Record<string, SessionEntry> = { [sessionKey]: sessionEntry };
    await writeSessionStoreSeed(sessionStore);

    const result = makeCliResult("same answer");
    result.meta.executionTrace = {
      winnerProvider: "anthropic",
      winnerModel: "claude-opus-4-6",
      fallbackUsed: false,
      runner: "embedded",
    };

    const updatedFirst = await persistCliTranscriptEntry({
      body: "ignored for gap fill",
      result,
      sessionId: sessionEntry.sessionId,
      sessionKey,
      sessionEntry,
      sessionStore,
      storePath,
      sessionAgentId: "main",
      sessionCwd: tmpDir,
      config: {},
      embeddedAssistantGapFill: true,
    });
    expect(updatedFirst).not.toHaveProperty("sessionFile");

    await appendTranscriptMessage(
      { agentId: "main", sessionId: sessionEntry.sessionId, sessionKey, storePath },
      {
        message: {
          role: "user",
          content: "next prompt",
          timestamp: Date.now(),
        },
        cwd: tmpDir,
      },
    );

    await persistCliTurnTranscript({
      body: "still ignored",
      result,
      sessionId: sessionEntry.sessionId,
      sessionKey,
      sessionEntry: updatedFirst,
      sessionStore,
      storePath,
      sessionAgentId: "main",
      sessionCwd: tmpDir,
      config: {},
      embeddedAssistantGapFill: true,
    });

    const messages = await readSessionMessages({
      agentId: "main",
      sessionId: sessionEntry.sessionId,
      sessionKey,
      storePath,
    });
    expect(messages.map((message) => message.role)).toEqual(["assistant", "user", "assistant"]);
    expect(messages).toHaveLength(3);
    expectRecordFields(requireRecord(messages[2], "deduped assistant message"), {
      content: [{ type: "text", text: "same answer" }],
    });
  });

  it("persists the transcript body instead of runtime-only CLI prompt context", async () => {
    const sessionKey = "agent:main:subagent:cli-transcript-clean";
    const sessionEntry: SessionEntry = {
      sessionId: "session-cli-transcript-clean",
      updatedAt: Date.now(),
    };
    const sessionStore: Record<string, SessionEntry> = { [sessionKey]: sessionEntry };
    await writeSessionStoreSeed(sessionStore);

    await persistCliTranscriptEntry({
      body: [
        "<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>",
        "secret runtime context",
        "<<<END_OPENCLAW_INTERNAL_CONTEXT>>>",
        "",
        "visible ask",
      ].join("\n"),
      transcriptBody: "visible ask",
      result: makeCliResult("hello from cli"),
      sessionId: sessionEntry.sessionId,
      sessionKey,
      sessionEntry,
      sessionStore,
      storePath,
      sessionAgentId: "main",
      sessionCwd: tmpDir,
      config: {},
    });

    const messages = await readSessionMessages({
      agentId: "main",
      sessionId: sessionEntry.sessionId,
      sessionKey,
      storePath,
    });
    expectRecordFields(requireRecord(messages[0], "transcript user message"), {
      role: "user",
      content: "visible ask",
    });
  });

  it("forwards separate user trigger, channel, and provider context to CLI runs", async () => {
    const sessionKey = "agent:main:direct:claude-channel-context";
    const sessionEntry: SessionEntry = {
      sessionId: "openclaw-session-channel",
      updatedAt: Date.now(),
    };
    const sessionStore: Record<string, SessionEntry> = { [sessionKey]: sessionEntry };
    await writeSessionStoreSeed(sessionStore);
    runCliAgentMock.mockResolvedValueOnce(makeCliResult("channel aware"));

    await runAgentAttempt({
      providerOverride: "claude-cli",
      originalProvider: "claude-cli",
      modelOverride: "opus",
      cfg: {} as OpenClawConfig,
      sessionEntry,
      sessionId: sessionEntry.sessionId,
      sessionKey,
      sessionAgentId: "main",
      sessionFile: path.join(tmpDir, "session.jsonl"),
      workspaceDir: tmpDir,
      body: "route this",
      isFallbackRetry: false,
      resolvedThinkLevel: "medium",
      timeoutMs: 1_000,
      runId: "run-cli-channel-context",
      opts: {
        messageProvider: "discord-voice",
      } as Parameters<typeof runAgentAttempt>[0]["opts"],
      runContext: {
        currentChannelId: "channel:voice-room",
        chatId: "voice-room",
        channelContext: {
          sender: { id: "sender-voice", unionId: "sender-union" },
          chat: { id: "voice-room" },
        },
        senderId: "sender-voice",
      } as Parameters<typeof runAgentAttempt>[0]["runContext"],
      spawnedBy: undefined,
      messageChannel: "discord",
      skillsSnapshot: undefined,
      resolvedVerboseLevel: undefined,
      agentDir,
      onAgentEvent: vi.fn(),
      authProfileProvider: "claude-cli",
      sessionStore,
      storePath,
      sessionHasHistory: false,
    });

    expect(runCliAgentMock).toHaveBeenCalledTimes(1);
    expectMockArgFields(runCliAgentMock, {
      trigger: "user",
      messageChannel: "discord",
      messageProvider: "discord-voice",
      currentChannelId: "channel:voice-room",
      chatId: "voice-room",
      channelContext: {
        sender: { id: "sender-voice", unionId: "sender-union" },
        chat: { id: "voice-room" },
      },
      senderId: "sender-voice",
    });
  });

  it("forwards message-tool-only policy and requires explicit subagent targets", async () => {
    const sessionKey = "agent:main:subagent:claude-message-policy";
    const sessionEntry: SessionEntry = {
      sessionId: "openclaw-session-cli-message-policy",
      updatedAt: Date.now(),
    };
    const sessionStore: Record<string, SessionEntry> = { [sessionKey]: sessionEntry };
    await writeSessionStoreSeed(sessionStore);
    runCliAgentMock.mockResolvedValueOnce(makeCliResult("sent"));

    await runAgentAttempt({
      providerOverride: "claude-cli",
      originalProvider: "claude-cli",
      modelOverride: "opus",
      cfg: {} as OpenClawConfig,
      sessionEntry,
      sessionId: sessionEntry.sessionId,
      sessionKey,
      sessionAgentId: "main",
      sessionFile: path.join(tmpDir, "session.jsonl"),
      workspaceDir: tmpDir,
      body: "route this",
      isFallbackRetry: false,
      resolvedThinkLevel: "medium",
      timeoutMs: 1_000,
      runId: "run-cli-message-policy",
      opts: {
        sourceReplyDeliveryMode: "message_tool_only",
      } as Parameters<typeof runAgentAttempt>[0]["opts"],
      runContext: {} as Parameters<typeof runAgentAttempt>[0]["runContext"],
      spawnedBy: undefined,
      messageChannel: "discord",
      skillsSnapshot: undefined,
      resolvedVerboseLevel: undefined,
      agentDir,
      onAgentEvent: vi.fn(),
      authProfileProvider: "claude-cli",
      sessionStore,
      storePath,
      sessionHasHistory: false,
    });

    expectMockArgFields(runCliAgentMock, {
      sourceReplyDeliveryMode: "message_tool_only",
      requireExplicitMessageTarget: true,
    });
  });

  it("does not pass auth-order profiles to CLI backends that do not stage them", async () => {
    const sessionKey = "agent:main:direct:claude-auth-order";
    const sessionEntry: SessionEntry = {
      sessionId: "openclaw-session-claude-auth-order",
      updatedAt: Date.now(),
    };
    const sessionStore: Record<string, SessionEntry> = { [sessionKey]: sessionEntry };
    await writeSessionStoreSeed(sessionStore);
    runCliAgentMock.mockResolvedValueOnce(makeCliResult("ambient claude cli"));

    await runAgentAttempt({
      providerOverride: "claude-cli",
      originalProvider: "claude-cli",
      modelOverride: "opus",
      cfg: {
        auth: {
          order: {
            "claude-cli": ["claude-cli:work"],
          },
        },
      } as OpenClawConfig,
      sessionEntry,
      sessionId: sessionEntry.sessionId,
      sessionKey,
      sessionAgentId: "main",
      sessionFile: path.join(tmpDir, "session.jsonl"),
      workspaceDir: tmpDir,
      body: "use ambient cli auth",
      isFallbackRetry: false,
      resolvedThinkLevel: "medium",
      timeoutMs: 1_000,
      runId: "run-claude-auth-order",
      opts: {} as Parameters<typeof runAgentAttempt>[0]["opts"],
      runContext: {} as Parameters<typeof runAgentAttempt>[0]["runContext"],
      spawnedBy: undefined,
      messageChannel: undefined,
      skillsSnapshot: undefined,
      resolvedVerboseLevel: undefined,
      agentDir,
      onAgentEvent: vi.fn(),
      authProfileProvider: "claude-cli",
      sessionStore,
      storePath,
      sessionHasHistory: false,
    });

    expect(runCliAgentMock).toHaveBeenCalledTimes(1);
    expect(firstRunCliAgentArg().authProfileId).toBeUndefined();
  });

  it("does not pass auth-order profiles to configured CLI runtimes that do not stage them", async () => {
    const sessionKey = "agent:main:direct:anthropic-claude-runtime-auth-order";
    const sessionEntry: SessionEntry = {
      sessionId: "openclaw-session-anthropic-claude-runtime-auth-order",
      updatedAt: Date.now(),
    };
    const sessionStore: Record<string, SessionEntry> = { [sessionKey]: sessionEntry };
    saveAuthProfileStore(
      {
        version: 1,
        profiles: {
          "anthropic:work": {
            type: "api_key",
            provider: "anthropic",
            key: "test-key",
          },
        },
      },
      agentDir,
      { filterExternalAuthProfiles: false, syncExternalCli: false },
    );
    runCliAgentMock.mockResolvedValueOnce(makeCliResult("configured claude cli"));

    await runAgentAttempt({
      providerOverride: "anthropic",
      originalProvider: "anthropic",
      modelOverride: "claude-opus-4-7",
      cfg: {
        auth: {
          order: {
            anthropic: ["anthropic:work"],
          },
        },
        agents: {
          defaults: {
            models: {
              "anthropic/claude-opus-4-7": { agentRuntime: { id: "claude-cli" } },
            },
          },
        },
      } as OpenClawConfig,
      sessionEntry,
      sessionId: sessionEntry.sessionId,
      sessionKey,
      sessionAgentId: "main",
      sessionFile: path.join(tmpDir, "session.jsonl"),
      workspaceDir: tmpDir,
      body: "use ambient cli auth",
      isFallbackRetry: false,
      resolvedThinkLevel: "medium",
      timeoutMs: 1_000,
      runId: "run-configured-claude-auth-order",
      opts: {
        messageProvider: "discord",
        bashElevated: {
          enabled: true,
          allowed: true,
          defaultLevel: "ask",
          fullAccessAvailable: false,
          fullAccessBlockedReason: "runtime",
        },
      } as Parameters<typeof runAgentAttempt>[0]["opts"],
      runContext: {
        groupId: "group-a",
        groupChannel: "ops",
        groupSpace: "guild-a",
      } as Parameters<typeof runAgentAttempt>[0]["runContext"],
      spawnedBy: "agent:main:discord:channel:parent",
      messageChannel: undefined,
      skillsSnapshot: undefined,
      resolvedVerboseLevel: undefined,
      agentDir,
      onAgentEvent: vi.fn(),
      authProfileProvider: "anthropic",
      sessionStore,
      storePath,
      sessionHasHistory: false,
    });

    expect(runCliAgentMock).toHaveBeenCalledTimes(1);
    expectMockArgFields(runCliAgentMock, {
      provider: "claude-cli",
      modelProvider: "anthropic",
      model: "claude-opus-4-7",
      messageProvider: "discord",
      groupId: "group-a",
      groupChannel: "ops",
      groupSpace: "guild-a",
      spawnedBy: "agent:main:discord:channel:parent",
      bashElevated: {
        enabled: true,
        allowed: true,
        defaultLevel: "ask",
        fullAccessAvailable: false,
        fullAccessBlockedReason: "runtime",
      },
    });
    expect(firstRunCliAgentArg().authProfileId).toBeUndefined();
  });

  it("forwards runtime toolsAllow into CLI attempts so the CLI harness can fail closed", async () => {
    const sessionKey = "agent:main:direct:claude-tools-allow";
    const sessionEntry: SessionEntry = {
      sessionId: "openclaw-session-cli-tools-allow",
      updatedAt: Date.now(),
    };
    const sessionStore: Record<string, SessionEntry> = { [sessionKey]: sessionEntry };
    await writeSessionStoreSeed(sessionStore);
    runCliAgentMock.mockResolvedValueOnce(makeCliResult("restricted cli"));

    await runAgentAttempt({
      providerOverride: "claude-cli",
      originalProvider: "claude-cli",
      modelOverride: "opus",
      cfg: {} as OpenClawConfig,
      sessionEntry,
      sessionId: sessionEntry.sessionId,
      sessionKey,
      sessionAgentId: "main",
      sessionFile: path.join(tmpDir, "session.jsonl"),
      workspaceDir: tmpDir,
      body: "route this",
      isFallbackRetry: false,
      resolvedThinkLevel: "medium",
      timeoutMs: 1_000,
      runId: "run-cli-tools-allow",
      opts: {
        toolsAllow: ["read", "web_search"],
      } as Parameters<typeof runAgentAttempt>[0]["opts"],
      runContext: {} as Parameters<typeof runAgentAttempt>[0]["runContext"],
      spawnedBy: undefined,
      messageChannel: "discord",
      skillsSnapshot: undefined,
      resolvedVerboseLevel: undefined,
      agentDir,
      onAgentEvent: vi.fn(),
      authProfileProvider: "claude-cli",
      sessionStore,
      storePath,
      sessionHasHistory: false,
    });

    expectMockArgFields(runCliAgentMock, {
      provider: "claude-cli",
      toolsAllow: ["read", "web_search"],
    });
  });

  it.each(SUBAGENT_ANNOUNCE_DELIVERY_CASES)(
    "bounds CLI subagent completion handoff tools for $name",
    async ({
      sourceReplyDeliveryMode,
      disableMessageTool,
      requireExplicitMessageTarget,
      inheritedToolAllow,
      inheritedToolDeny,
      runtimeToolsAllow,
      operatorTools,
      sandboxMode,
      trustedInternalHandoff,
      expectedDisableTools,
      expectedToolsAllow,
    }) => {
      const sessionKey = "agent:main:direct:claude-announce";
      const sessionEntry: SessionEntry = {
        sessionId: "openclaw-session-cli-announce",
        updatedAt: Date.now(),
      };
      const sessionStore = createSubagentAnnounceSessionStore(sessionKey, sessionEntry, {
        inheritedToolAllow,
        inheritedToolDeny,
      });
      await writeSessionStoreSeed(sessionStore);
      runCliAgentMock.mockResolvedValueOnce(makeCliResult("completion announce"));

      await runAgentAttempt({
        providerOverride: "claude-cli",
        originalProvider: "claude-cli",
        modelOverride: "opus",
        cfg: {
          session: { store: storePath },
          ...(operatorTools ? { tools: operatorTools } : {}),
          ...(sandboxMode ? { agents: { defaults: { sandbox: { mode: sandboxMode } } } } : {}),
        },
        sessionEntry,
        sessionId: sessionEntry.sessionId,
        sessionKey,
        sessionAgentId: "main",
        sessionFile: path.join(tmpDir, "session.jsonl"),
        workspaceDir: tmpDir,
        body: "A background task finished. Process the completion update now.",
        isFallbackRetry: false,
        resolvedThinkLevel: "medium",
        timeoutMs: 1_000,
        runId: "run-cli-announce",
        opts: createSubagentAnnounceHandoffOptions({
          sourceReplyDeliveryMode,
          targetSessionKey: sessionKey,
          targetSessionId: sessionEntry.sessionId,
          provider: "claude-cli",
          model: "opus",
          disableMessageTool,
          requireExplicitMessageTarget,
          runtimeToolsAllow,
          trustedInternalHandoff,
        }) as Parameters<typeof runAgentAttempt>[0]["opts"],
        runContext: {} as Parameters<typeof runAgentAttempt>[0]["runContext"],
        spawnedBy: undefined,
        messageChannel: "telegram",
        skillsSnapshot: undefined,
        resolvedVerboseLevel: undefined,
        agentDir,
        onAgentEvent: vi.fn(),
        authProfileProvider: "claude-cli",
        sessionStore,
        storePath,
        sessionHasHistory: false,
      });

      expectMockArgFields(runCliAgentMock, {
        provider: "claude-cli",
        sourceReplyDeliveryMode,
        requireExplicitMessageTarget: requireExplicitMessageTarget === true,
        toolsAllow: expectedToolsAllow,
        disableTools: expectedDisableTools,
        allowEmptyAssistantReplyAsSilent: true,
      });
      expect(runEmbeddedAgentMock).not.toHaveBeenCalled();
    },
  );

  it.each(SUBAGENT_ANNOUNCE_EMBEDDED_DELIVERY_CASES)(
    "bounds embedded subagent completion handoff tools for $name",
    async ({
      sourceReplyDeliveryMode,
      disableMessageTool,
      requireExplicitMessageTarget,
      modelRun,
      promptMode,
      inheritedToolAllow,
      inheritedToolDeny,
      runtimeToolsAllow,
      operatorTools,
      sandboxMode,
      trustedInternalHandoff,
      expectedDisableTools,
      expectedToolsAllow,
    }) => {
      const runId = `embedded-announce-${sourceReplyDeliveryMode}-${disableMessageTool}`;
      const sessionKey = `agent:main:direct:${runId}`;
      const sessionId = `session-${runId}`;
      const embeddedArg = await runOpenClawEmbeddedAttemptForTest({
        runId,
        body: "A background task finished. Process the completion update now.",
        config: {
          session: { store: storePath },
          ...(operatorTools ? { tools: operatorTools } : {}),
          ...(sandboxMode ? { agents: { defaults: { sandbox: { mode: sandboxMode } } } } : {}),
        },
        subagentAnnounceEnvelope: { inheritedToolAllow, inheritedToolDeny },
        opts: createSubagentAnnounceHandoffOptions({
          sourceReplyDeliveryMode,
          targetSessionKey: sessionKey,
          targetSessionId: sessionId,
          provider: "openai",
          model: "gpt-5.4",
          disableMessageTool,
          requireExplicitMessageTarget,
          modelRun,
          promptMode,
          runtimeToolsAllow,
          trustedInternalHandoff,
        }),
      });

      expectRecordFields(embeddedArg, {
        provider: "openai",
        sourceReplyDeliveryMode,
        requireExplicitMessageTarget,
        toolsAllow: expectedToolsAllow,
        disableTools: expectedDisableTools,
        disableMessageTool: disableMessageTool || undefined,
        modelRun: modelRun || undefined,
        promptMode,
        allowEmptyAssistantReplyAsSilent: true,
      });
      expect(runCliAgentMock).not.toHaveBeenCalled();
    },
  );

  it("keeps trusted CLI completion handoffs tool-free when inherited policy is restricted", async () => {
    const sessionKey = "agent:main:direct:claude-trusted-announce";
    const childSessionKey = "agent:openclaw:subagent:child";
    const sessionEntry: SessionEntry = {
      sessionId: "openclaw-session-cli-trusted-announce",
      updatedAt: Date.now(),
    };
    const sessionStore: Record<string, SessionEntry> = {
      [sessionKey]: sessionEntry,
      [childSessionKey]: {
        sessionId: "child-session-id",
        updatedAt: Date.now(),
        spawnedBy: sessionKey,
        spawnDepth: 1,
        subagentRole: "orchestrator",
        subagentControlScope: "children",
        inheritedToolPolicyVersion: 1,
        inheritedToolDeny: ["exec"],
      },
    };
    await writeSessionStoreSeed(sessionStore);
    runCliAgentMock.mockResolvedValueOnce(makeCliResult("trusted announce"));

    await runAgentAttempt({
      providerOverride: "claude-cli",
      originalProvider: "claude-cli",
      modelOverride: "opus",
      cfg: { session: { store: storePath } } as OpenClawConfig,
      sessionEntry,
      sessionId: sessionEntry.sessionId,
      sessionKey,
      sessionAgentId: "main",
      sessionFile: path.join(tmpDir, "session.jsonl"),
      workspaceDir: tmpDir,
      body: "A background task finished. Process the completion update now.",
      isFallbackRetry: false,
      resolvedThinkLevel: "medium",
      timeoutMs: 1_000,
      runId: "run-cli-trusted-announce",
      opts: {
        trustedInternalHandoff: {
          kind: "subagent-completion",
          sourceSessionKey: childSessionKey,
          sourceSessionId: "child-session-id",
          targetSessionKey: sessionKey,
          targetSessionId: sessionEntry.sessionId,
          provider: "claude-cli",
          model: "opus",
        },
        inputProvenance: {
          kind: "inter_session",
          sourceSessionKey: childSessionKey,
          sourceChannel: "internal",
          sourceTool: "subagent_announce",
        },
        internalEvents: [
          {
            type: "task_completion",
            source: "subagent",
            childSessionKey,
            childSessionId: "child-session-id",
            announceType: "subagent task",
            taskLabel: "review",
            status: "ok",
            statusLabel: "completed",
            result: "child output",
            replyInstruction: "Relay this completion.",
          },
        ],
      } as Parameters<typeof runAgentAttempt>[0]["opts"],
      runContext: {} as Parameters<typeof runAgentAttempt>[0]["runContext"],
      spawnedBy: undefined,
      messageChannel: "telegram",
      skillsSnapshot: undefined,
      resolvedVerboseLevel: undefined,
      agentDir,
      onAgentEvent: vi.fn(),
      authProfileProvider: "claude-cli",
      sessionStore,
      storePath,
      sessionHasHistory: false,
    });

    expectMockArgFields(runCliAgentMock, {
      provider: "claude-cli",
      disableTools: true,
      allowEmptyAssistantReplyAsSilent: true,
    });
    expect(runEmbeddedAgentMock).not.toHaveBeenCalled();
  });

  it("stamps CLI prompts with current timestamp context", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2024-06-05T15:30:00Z"));
    const sessionKey = "agent:main:direct:claude-timestamp";
    const sessionEntry: SessionEntry = {
      sessionId: "openclaw-session-cli-timestamp",
      updatedAt: Date.now(),
    };
    const sessionStore: Record<string, SessionEntry> = { [sessionKey]: sessionEntry };
    await writeSessionStoreSeed(sessionStore);
    runCliAgentMock.mockResolvedValueOnce(makeCliResult("timestamped cli"));
    const userTurnTranscriptRecorder = createUserTurnTranscriptRecorder({
      input: { text: "canonical timestamp question" },
      target: createTestUserTurnTranscriptTarget({
        sessionId: sessionEntry.sessionId,
        sessionKey,
        sessionEntry,
        agentId: "main",
        cwd: tmpDir,
        storePath,
      }),
    });
    await runAgentAttempt({
      providerOverride: "claude-cli",
      originalProvider: "claude-cli",
      modelOverride: "opus",
      cfg: { agents: { defaults: { userTimezone: "UTC" } } } as OpenClawConfig,
      sessionEntry,
      sessionId: sessionEntry.sessionId,
      sessionKey,
      sessionAgentId: "main",
      sessionFile: path.join(tmpDir, "session.jsonl"),
      workspaceDir: tmpDir,
      body: "what time is it?",
      transcriptBody: "canonical timestamp question",
      isFallbackRetry: false,
      resolvedThinkLevel: "medium",
      timeoutMs: 1_000,
      runId: "run-cli-timestamp",
      opts: {} as Parameters<typeof runAgentAttempt>[0]["opts"],
      runContext: {} as Parameters<typeof runAgentAttempt>[0]["runContext"],
      spawnedBy: undefined,
      messageChannel: "discord",
      skillsSnapshot: undefined,
      resolvedVerboseLevel: undefined,
      agentDir,
      onAgentEvent: vi.fn(),
      authProfileProvider: "claude-cli",
      sessionStore,
      storePath,
      sessionHasHistory: false,
      userTurnTranscriptRecorder,
    });

    expectMockArgFields(runCliAgentMock, {
      prompt: "[Wed 2024-06-05 15:30 UTC] what time is it?",
      transcriptPrompt: "canonical timestamp question",
      imagePrompt: "what time is it?",
      userTurnTranscriptRecorder,
      suppressNextUserMessagePersistence: false,
    });
  });

  it("routes canonical Anthropic models through the configured Claude CLI runtime", async () => {
    const sessionKey = "agent:main:direct:canonical-claude-cli";
    const sessionEntry: SessionEntry = {
      sessionId: "openclaw-session-canonical-cli",
      updatedAt: Date.now(),
    };
    const sessionStore: Record<string, SessionEntry> = { [sessionKey]: sessionEntry };
    await writeSessionStoreSeed(sessionStore);
    runCliAgentMock.mockResolvedValueOnce(makeCliResult("canonical cli"));
    const fallbackRuntimeState: NonNullable<RunAgentAttemptParams["fallbackRuntimeState"]> = {};
    const images = [{ type: "image" as const, data: "aGVsbG8=", mimeType: "image/png" }];
    const imageOrder = ["inline" as const];

    await runAgentAttempt({
      providerOverride: "anthropic",
      originalProvider: "anthropic",
      modelOverride: "claude-opus-4-7",
      cfg: {
        agents: {
          defaults: {
            models: {
              "anthropic/claude-opus-4-7": { agentRuntime: { id: "claude-cli" } },
            },
          },
        },
      } as OpenClawConfig,
      sessionEntry,
      sessionId: sessionEntry.sessionId,
      sessionKey,
      sessionAgentId: "main",
      sessionFile: path.join(tmpDir, "session.jsonl"),
      workspaceDir: tmpDir,
      body: "route this",
      isFallbackRetry: true,
      resolvedThinkLevel: "medium",
      timeoutMs: 1_000,
      runId: "run-canonical-claude-cli",
      opts: { images, imageOrder } as Parameters<typeof runAgentAttempt>[0]["opts"],
      runContext: {} as Parameters<typeof runAgentAttempt>[0]["runContext"],
      spawnedBy: undefined,
      messageChannel: "telegram",
      skillsSnapshot: undefined,
      resolvedVerboseLevel: undefined,
      agentDir,
      onAgentEvent: vi.fn(),
      authProfileProvider: "anthropic",
      sessionStore,
      storePath,
      sessionHasHistory: false,
      fallbackRuntimeState,
    });

    expect(runEmbeddedAgentMock).not.toHaveBeenCalled();
    expectMockArgFields(runCliAgentMock, {
      provider: "claude-cli",
      model: "claude-opus-4-7",
      imagePrompt: "route this",
      images,
      imageOrder,
    });
    expect(fallbackRuntimeState.originRuntime).toBe("cli");

    const fallbackArg = await runOpenClawEmbeddedAttemptForTest({
      runId: "run-canonical-claude-cli-fallback",
      isFallbackRetry: true,
      fallbackRuntimeState,
      opts: { images },
    });
    expect(fallbackArg.images).toEqual(images);
  });

  it("routes provider-qualified Anthropic shorthand through the configured Claude CLI runtime", async () => {
    const sessionKey = "agent:main:direct:shorthand-claude-cli";
    const sessionEntry: SessionEntry = {
      sessionId: "openclaw-session-shorthand-cli",
      updatedAt: Date.now(),
    };
    const sessionStore: Record<string, SessionEntry> = { [sessionKey]: sessionEntry };
    await writeSessionStoreSeed(sessionStore);
    runCliAgentMock.mockResolvedValueOnce(makeCliResult("shorthand cli"));

    await runAgentAttempt({
      providerOverride: "anthropic",
      originalProvider: "anthropic",
      modelOverride: "opus-4.7",
      cfg: {
        agents: {
          defaults: {
            models: {
              "anthropic/opus-4.7": { agentRuntime: { id: "claude-cli" } },
            },
          },
        },
      } as OpenClawConfig,
      sessionEntry,
      sessionId: sessionEntry.sessionId,
      sessionKey,
      sessionAgentId: "main",
      sessionFile: path.join(tmpDir, "session.jsonl"),
      workspaceDir: tmpDir,
      body: "route this",
      isFallbackRetry: false,
      resolvedThinkLevel: "medium",
      timeoutMs: 1_000,
      runId: "run-shorthand-claude-cli",
      opts: {} as Parameters<typeof runAgentAttempt>[0]["opts"],
      runContext: {} as Parameters<typeof runAgentAttempt>[0]["runContext"],
      spawnedBy: undefined,
      messageChannel: "telegram",
      skillsSnapshot: undefined,
      resolvedVerboseLevel: undefined,
      agentDir,
      onAgentEvent: vi.fn(),
      authProfileProvider: "anthropic",
      sessionStore,
      storePath,
      sessionHasHistory: false,
    });

    expect(runEmbeddedAgentMock).not.toHaveBeenCalled();
    expectMockArgFields(runCliAgentMock, {
      provider: "claude-cli",
      model: "opus-4.7",
    });
  });

  it("routes canonical OpenAI models through the configured embedded Codex runtime", async () => {
    const sessionKey = "agent:main:direct:canonical-codex-cli";
    const sessionEntry: SessionEntry = {
      sessionId: "openclaw-session-canonical-codex-cli",
      updatedAt: Date.now(),
    };
    const sessionStore: Record<string, SessionEntry> = { [sessionKey]: sessionEntry };
    await writeSessionStoreSeed(sessionStore);
    runEmbeddedAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "canonical codex embedded" }],
      meta: {
        durationMs: 5,
        finalAssistantVisibleText: "canonical codex embedded",
        executionTrace: { runner: "openclaw" },
      },
    });

    await runAgentAttempt({
      providerOverride: "openai",
      originalProvider: "openai",
      modelOverride: "gpt-5.4",
      cfg: {
        agents: {
          defaults: {
            models: {
              "openai/gpt-5.4": { agentRuntime: { id: "codex" } },
            },
          },
        },
      } as OpenClawConfig,
      sessionEntry,
      sessionId: sessionEntry.sessionId,
      sessionKey,
      sessionAgentId: "main",
      sessionFile: path.join(tmpDir, "session.jsonl"),
      workspaceDir: tmpDir,
      body: "route this",
      isFallbackRetry: false,
      resolvedThinkLevel: "medium",
      timeoutMs: 1_000,
      runId: "run-canonical-codex-cli",
      opts: {} as Parameters<typeof runAgentAttempt>[0]["opts"],
      runContext: {
        chatId: "chat-embedded",
        channelContext: {
          sender: { id: "sender-embedded", unionId: "embedded-union" },
          chat: { id: "chat-embedded" },
        },
        senderId: "sender-embedded",
      } as Parameters<typeof runAgentAttempt>[0]["runContext"],
      spawnedBy: undefined,
      messageChannel: "telegram",
      skillsSnapshot: undefined,
      resolvedVerboseLevel: undefined,
      agentDir,
      onAgentEvent: vi.fn(),
      authProfileProvider: "openai",
      sessionStore,
      storePath,
      sessionHasHistory: false,
    });

    expect(runCliAgentMock).not.toHaveBeenCalled();
    expectMockArgFields(runEmbeddedAgentMock, {
      provider: "openai",
      model: "gpt-5.4",
      chatId: "chat-embedded",
      channelContext: {
        sender: { id: "sender-embedded", unionId: "embedded-union" },
        chat: { id: "chat-embedded" },
      },
      senderId: "sender-embedded",
    });
  });

  it("keeps live stream output for visible subagent lane runs", async () => {
    const embeddedArg = await runOpenClawEmbeddedAttemptForTest({
      opts: { lane: "subagent" },
      runId: "visible-subagent-stream",
    });

    expect(embeddedArg.suppressLiveStreamOutput).toBe(false);
  });

  it("forwards Gateway plugin runtime binding to embedded runs", async () => {
    const embeddedArg = await runOpenClawEmbeddedAttemptForTest({
      opts: { allowGatewaySubagentBinding: true },
      runId: "gateway-plugin-runtime-binding",
    });

    expect(embeddedArg.allowGatewaySubagentBinding).toBe(true);
  });

  it("suppresses live stream output for hidden internal runs", async () => {
    const embeddedArg = await runOpenClawEmbeddedAttemptForTest({
      opts: { lane: "subagent", sessionEffects: "internal" },
      runId: "internal-subagent-stream",
    });

    expect(embeddedArg.suppressLiveStreamOutput).toBe(true);
  });

  it("preserves embedded OpenAI-compatible tools for the exact trusted completion", async () => {
    const runId = "trusted-glm-completion";
    const childSessionKey = "agent:main:subagent:glm-child";
    const sessionKey = `agent:main:direct:${runId}`;
    const sessionId = `session-${runId}`;
    const trustedInternalHandoff = {
      kind: "subagent-completion" as const,
      sourceSessionKey: childSessionKey,
      sourceSessionId: "glm-child-session",
      targetSessionKey: sessionKey,
      targetSessionId: sessionId,
      provider: "openai",
      model: "glm-4.5",
    };

    const embeddedArg = await runOpenClawEmbeddedAttemptForTest({
      runId,
      modelOverride: "glm-4.5",
      additionalSessionEntries: {
        [childSessionKey]: {
          sessionId: "glm-child-session",
          spawnedBy: sessionKey,
          spawnDepth: 1,
          subagentRole: "orchestrator",
          subagentControlScope: "children",
          inheritedToolPolicyVersion: 1,
        },
      },
      opts: {
        trustedInternalHandoff,
        inputProvenance: {
          kind: "inter_session",
          sourceSessionKey: childSessionKey,
          sourceTool: "subagent_announce",
        },
        internalEvents: [
          {
            type: "task_completion",
            source: "subagent",
            childSessionKey,
            childSessionId: "glm-child-session",
            announceType: "subagent task",
            taskLabel: "review",
            status: "ok",
            statusLabel: "completed",
            result: "child output",
            replyInstruction: "Review and continue.",
          },
        ],
      },
    });

    expect(embeddedArg.disableTools).toBe(false);
    expect(embeddedArg.trustedInternalHandoff).toEqual(trustedInternalHandoff);
  });

  it("preserves embedded tools for a verified nested subagent completion", async () => {
    const runId = "trusted-nested-glm-completion";
    const requesterSessionKey = "agent:main:subagent:parent-child";
    const childSessionKey = "agent:main:subagent:leaf";
    const requesterSessionId = "parent-child-session";
    const childSessionId = "leaf-session";
    const trustedInternalHandoff = {
      kind: "subagent-completion" as const,
      sourceSessionKey: childSessionKey,
      sourceSessionId: childSessionId,
      targetSessionKey: requesterSessionKey,
      targetSessionId: requesterSessionId,
      provider: "openai",
      model: "glm-4.5",
    };

    const embeddedArg = await runOpenClawEmbeddedAttemptForTest({
      runId,
      sessionKey: requesterSessionKey,
      modelOverride: "glm-4.5",
      sessionEntry: {
        sessionId: requesterSessionId,
        spawnedBy: "agent:main:direct:root",
        spawnDepth: 1,
        subagentRole: "orchestrator",
        subagentControlScope: "children",
        inheritedToolPolicyVersion: 1,
        inheritedToolDeny: ["exec"],
      },
      additionalSessionEntries: {
        [childSessionKey]: {
          sessionId: childSessionId,
          spawnedBy: requesterSessionKey,
          spawnDepth: 2,
          subagentRole: "leaf",
          subagentControlScope: "none",
          inheritedToolPolicyVersion: 1,
          inheritedToolDeny: ["exec", "read"],
        },
      },
      opts: {
        trustedInternalHandoff,
        inputProvenance: {
          kind: "inter_session",
          sourceSessionKey: childSessionKey,
          sourceTool: "subagent_announce",
        },
        internalEvents: [
          {
            type: "task_completion",
            source: "subagent",
            childSessionKey,
            childSessionId,
            announceType: "subagent task",
            taskLabel: "review",
            status: "ok",
            statusLabel: "completed",
            result: "child output",
            replyInstruction: "Review and continue.",
          },
        ],
      },
    });

    expect(embeddedArg.disableTools).toBe(false);
    expect(embeddedArg.trustedInternalHandoff).toEqual(trustedInternalHandoff);
  });

  it("keeps duplicate completion events tool-free despite an otherwise exact capability", async () => {
    const runId = "duplicate-glm-completion";
    const childSessionKey = "agent:main:subagent:duplicate-child";
    const sessionKey = `agent:main:direct:${runId}`;
    const sessionId = `session-${runId}`;
    const completionEvent = {
      type: "task_completion" as const,
      source: "subagent" as const,
      childSessionKey,
      childSessionId: "duplicate-child-session",
      announceType: "subagent task",
      taskLabel: "review",
      status: "ok" as const,
      statusLabel: "completed",
      result: "child output",
      replyInstruction: "Review and continue.",
    };
    const embeddedArg = await runOpenClawEmbeddedAttemptForTest({
      runId,
      modelOverride: "glm-4.5",
      additionalSessionEntries: {
        [childSessionKey]: {
          sessionId: completionEvent.childSessionId,
          spawnedBy: sessionKey,
          spawnDepth: 1,
          subagentRole: "orchestrator",
          subagentControlScope: "children",
          inheritedToolPolicyVersion: 1,
        },
      },
      opts: {
        trustedInternalHandoff: {
          kind: "subagent-completion",
          sourceSessionKey: childSessionKey,
          sourceSessionId: completionEvent.childSessionId,
          targetSessionKey: sessionKey,
          targetSessionId: sessionId,
          provider: "openai",
          model: "glm-4.5",
        },
        inputProvenance: {
          kind: "inter_session",
          sourceSessionKey: childSessionKey,
          sourceTool: "subagent_announce",
        },
        internalEvents: [completionEvent, completionEvent],
      },
    });

    expect(embeddedArg.disableTools).toBe(true);
    expect(embeddedArg.trustedInternalHandoff).toBeUndefined();
  });

  it("keeps an exact completion capability tool-free when persisted lineage is missing", async () => {
    const runId = "missing-lineage-completion";
    const childSessionKey = "agent:main:subagent:missing";
    const sessionKey = `agent:main:direct:${runId}`;
    const sessionId = `session-${runId}`;
    const embeddedArg = await runOpenClawEmbeddedAttemptForTest({
      runId,
      modelOverride: "glm-4.5",
      opts: {
        trustedInternalHandoff: {
          kind: "subagent-completion",
          sourceSessionKey: childSessionKey,
          targetSessionKey: sessionKey,
          targetSessionId: sessionId,
          provider: "openai",
          model: "glm-4.5",
        },
        inputProvenance: {
          kind: "inter_session",
          sourceSessionKey: childSessionKey,
          sourceTool: "subagent_announce",
        },
        internalEvents: [
          {
            type: "task_completion",
            source: "subagent",
            childSessionKey,
            announceType: "subagent task",
            taskLabel: "review",
            status: "ok",
            statusLabel: "completed",
            result: "child output",
            replyInstruction: "Review and continue.",
          },
        ],
      },
    });

    expect(embeddedArg.disableTools).toBe(true);
    expect(embeddedArg.trustedInternalHandoff).toBeUndefined();
  });

  it("forwards canonical transcript text without replacing embedded image content", async () => {
    const recorder = createUserTurnTranscriptRecorder({
      target: createTestUserTurnTranscriptTarget({
        sessionId: "session-embedded-image-turn",
        sessionKey: "agent:main:direct:embedded-image-turn",
        agentId: "main",
        cwd: tmpDir,
        storePath,
      }),
    });
    const images = [{ type: "image" as const, data: "aGVsbG8=", mimeType: "image/png" }];
    const embeddedArg = await runOpenClawEmbeddedAttemptForTest({
      runId: "embedded-image-turn",
      body: "runtime image prompt",
      transcriptBody: "canonical image caption",
      opts: { images },
      userTurnTranscriptRecorder: recorder,
    });

    expect(embeddedArg).toMatchObject({
      prompt: "runtime image prompt",
      transcriptPrompt: "canonical image caption",
      images,
      userTurnTranscriptRecorder: recorder,
      suppressNextUserMessagePersistence: false,
    });
  });

  it.each([
    { originRuntime: undefined, retry: false, expectedImages: true },
    { originRuntime: "cli" as const, retry: true, expectedImages: true },
    { originRuntime: "embedded" as const, retry: true, expectedImages: false },
  ])(
    "forwards embedded images for originRuntime=$originRuntime retry=$retry",
    async ({ originRuntime, retry, expectedImages }) => {
      const images = [{ type: "image" as const, data: "aGVsbG8=", mimeType: "image/png" }];
      const imageOrder = ["inline" as const];
      const embeddedArg = await runOpenClawEmbeddedAttemptForTest({
        runId: `embedded-image-fallback-${originRuntime ?? "unset"}-${retry}`,
        isFallbackRetry: retry,
        fallbackRuntimeState: originRuntime === undefined ? undefined : { originRuntime },
        opts: { images, imageOrder },
      });

      expect(embeddedArg.images).toEqual(expectedImages ? images : undefined);
      expect(embeddedArg.imageOrder).toEqual(expectedImages ? imageOrder : undefined);
    },
  );

  it("records raw CLI-shaped model runs as embedded origins", async () => {
    const images = [{ type: "image" as const, data: "aGVsbG8=", mimeType: "image/png" }];
    const fallbackRuntimeState: NonNullable<RunAgentAttemptParams["fallbackRuntimeState"]> = {};

    const firstArg = await runOpenClawEmbeddedAttemptForTest({
      runId: "raw-cli-shaped-origin",
      providerOverride: "claude-cli",
      modelOverride: "claude-opus-4-7",
      fallbackRuntimeState,
      opts: { modelRun: true, images },
    });
    expect(fallbackRuntimeState.originRuntime).toBe("embedded");
    expect(firstArg.images).toEqual(images);

    const retryArg = await runOpenClawEmbeddedAttemptForTest({
      runId: "raw-cli-shaped-origin-retry",
      providerOverride: "claude-cli",
      modelOverride: "claude-opus-4-7",
      isFallbackRetry: true,
      fallbackRuntimeState,
      opts: { modelRun: true, images },
    });
    expect(retryArg.images).toBeUndefined();
  });

  it("forwards selected auth profiles through metadata-scoped provider aliases", async () => {
    const sessionKey = "agent:main:direct:metadata-auth-alias";
    const sessionEntry: SessionEntry = {
      sessionId: "openclaw-session-metadata-auth-alias",
      updatedAt: Date.now(),
      authProfileOverride: "openai:work",
      authProfileOverrideSource: "user",
    };
    const sessionStore: Record<string, SessionEntry> = { [sessionKey]: sessionEntry };
    saveAuthProfileStore(
      {
        version: 1,
        profiles: {
          "openai:work": {
            type: "oauth",
            provider: "openai",
            access: "access-token",
            refresh: "refresh-token",
            expires: Date.now() + 60_000,
          },
        },
      },
      agentDir,
      { filterExternalAuthProfiles: false, syncExternalCli: false },
    );
    runEmbeddedAgentMock.mockResolvedValueOnce({
      meta: { durationMs: 1 },
    } satisfies EmbeddedAgentRunResult);

    await runAgentAttempt({
      providerOverride: "fixture",
      originalProvider: "fixture",
      modelOverride: "fixture-model",
      cfg: {} as OpenClawConfig,
      sessionEntry,
      sessionId: sessionEntry.sessionId,
      sessionKey,
      sessionAgentId: "main",
      sessionFile: path.join(tmpDir, "session.jsonl"),
      workspaceDir: tmpDir,
      body: "use selected auth",
      isFallbackRetry: false,
      resolvedThinkLevel: "medium",
      timeoutMs: 1_000,
      runId: "run-metadata-auth-alias",
      opts: {} as Parameters<typeof runAgentAttempt>[0]["opts"],
      runContext: {} as Parameters<typeof runAgentAttempt>[0]["runContext"],
      spawnedBy: undefined,
      messageChannel: undefined,
      skillsSnapshot: undefined,
      resolvedVerboseLevel: undefined,
      agentDir,
      onAgentEvent: vi.fn(),
      authProfileProvider: "fixture",
      sessionStore,
      storePath,
      pluginsEnabled: true,
      metadataSnapshot: {
        plugins: [
          {
            id: "alias-owner",
            origin: "global",
            providerAuthAliases: { fixture: "openai" },
          },
        ],
      } as never,
      sessionHasHistory: false,
    });

    expectMockArgFields(runEmbeddedAgentMock, {
      provider: "fixture",
      model: "fixture-model",
      authProfileId: "openai:work",
      authProfileIdSource: "user",
    });
  });

  it("forwards user-pinned OpenAI API-key backup profiles to Codex harness runs", async () => {
    const { clearAgentHarnesses, registerAgentHarness } = await import("../harness/registry.js");
    const sessionKey = "agent:main:direct:openai-chatgpt-api-key";
    const sessionEntry: SessionEntry = {
      sessionId: "openclaw-session-openai-chatgpt-api-key",
      updatedAt: Date.now(),
      authProfileOverride: "openai:backup",
      authProfileOverrideSource: "user",
    };
    const sessionStore: Record<string, SessionEntry> = { [sessionKey]: sessionEntry };
    saveAuthProfileStore(
      {
        version: 1,
        profiles: {
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
    clearAgentHarnesses();
    registerAgentHarness({
      id: "codex",
      label: "Codex",
      supports: () => ({ supported: true, priority: 100 }),
      runAttempt: vi.fn(),
    });
    runEmbeddedAgentMock.mockResolvedValueOnce({
      meta: { durationMs: 1 },
    } satisfies EmbeddedAgentRunResult);

    try {
      await runAgentAttempt({
        providerOverride: "openai",
        originalProvider: "openai",
        modelOverride: "gpt-5.4",
        cfg: {} as OpenClawConfig,
        sessionEntry,
        sessionId: sessionEntry.sessionId,
        sessionKey,
        sessionAgentId: "main",
        sessionFile: path.join(tmpDir, "session.jsonl"),
        workspaceDir: tmpDir,
        body: "use backup auth",
        isFallbackRetry: false,
        resolvedThinkLevel: "medium",
        timeoutMs: 1_000,
        runId: "run-openai-chatgpt-api-key-backup",
        opts: {} as Parameters<typeof runAgentAttempt>[0]["opts"],
        runContext: {} as Parameters<typeof runAgentAttempt>[0]["runContext"],
        spawnedBy: undefined,
        messageChannel: undefined,
        skillsSnapshot: undefined,
        resolvedVerboseLevel: undefined,
        agentDir,
        onAgentEvent: vi.fn(),
        authProfileProvider: "openai",
        sessionStore,
        storePath,
        sessionHasHistory: false,
      });
    } finally {
      clearAgentHarnesses();
    }

    expectMockArgFields(runEmbeddedAgentMock, {
      provider: "openai",
      model: "gpt-5.4",
      authProfileId: "openai:backup",
      authProfileIdSource: "user",
    });
  });

  it("keeps one-shot model runs on the raw embedded provider path", async () => {
    const sessionKey = "agent:main:direct:model-run-raw";
    const sessionEntry: SessionEntry = {
      sessionId: "openclaw-session-model-run-raw",
      updatedAt: Date.now(),
    };
    const sessionStore: Record<string, SessionEntry> = { [sessionKey]: sessionEntry };
    await writeSessionStoreSeed(sessionStore);
    runEmbeddedAgentMock.mockResolvedValueOnce({
      meta: { durationMs: 1 },
    } satisfies EmbeddedAgentRunResult);

    await runAgentAttempt({
      providerOverride: "anthropic",
      modelOverride: "claude-opus-4-7",
      originalProvider: "anthropic",
      cfg: {
        agents: {
          defaults: {
            agentRuntime: { id: "claude-cli" },
          },
        },
      } as OpenClawConfig,
      sessionEntry,
      sessionId: sessionEntry.sessionId,
      sessionKey,
      sessionAgentId: "main",
      sessionFile: path.join(tmpDir, "session.jsonl"),
      workspaceDir: tmpDir,
      body: "raw prompt",
      isFallbackRetry: false,
      resolvedThinkLevel: "medium",
      timeoutMs: 1_000,
      runId: "run-model-run-raw",
      opts: {
        modelRun: true,
        promptMode: "none",
        messageProvider: "discord-voice",
        inputProvenance: {
          kind: "inter_session",
          sourceSessionKey: "agent:main:discord:source",
          sourceTool: "sessions_send",
        },
      } as Parameters<typeof runAgentAttempt>[0]["opts"],
      runContext: {} as Parameters<typeof runAgentAttempt>[0]["runContext"],
      spawnedBy: undefined,
      messageChannel: "discord",
      skillsSnapshot: undefined,
      resolvedVerboseLevel: undefined,
      agentDir,
      onAgentEvent: vi.fn(),
      authProfileProvider: "anthropic",
      sessionStore,
      storePath,
      sessionHasHistory: true,
    });

    expect(runCliAgentMock).not.toHaveBeenCalled();
    expectMockArgFields(runEmbeddedAgentMock, {
      provider: "anthropic",
      model: "claude-opus-4-7",
      agentHarnessId: "openclaw",
      prompt: "raw prompt",
      messageChannel: "discord",
      messageProvider: "discord-voice",
      modelRun: true,
      promptMode: "none",
      disableTools: true,
    });
    expect(firstEmbeddedAgentArg().prompt).not.toContain("[Inter-session message]");
  });

  it("forwards trusted elevated defaults to embedded agent runs", async () => {
    const sessionKey = "agent:main:telegram:direct:123";
    const sessionEntry: SessionEntry = {
      sessionId: "openclaw-session-elevated-followup",
      updatedAt: Date.now(),
    };
    const sessionStore: Record<string, SessionEntry> = { [sessionKey]: sessionEntry };
    const bashElevated = {
      enabled: true,
      allowed: true,
      defaultLevel: "on" as const,
    };
    await writeSessionStoreSeed(sessionStore);
    runEmbeddedAgentMock.mockResolvedValueOnce({
      meta: { durationMs: 1 },
    } satisfies EmbeddedAgentRunResult);

    await runAgentAttempt({
      providerOverride: "openai",
      originalProvider: "openai",
      modelOverride: "gpt-5.4",
      cfg: {} as OpenClawConfig,
      sessionEntry,
      sessionId: sessionEntry.sessionId,
      sessionKey,
      sessionAgentId: "main",
      sessionFile: path.join(tmpDir, "session.jsonl"),
      workspaceDir: tmpDir,
      body: "follow up after approved exec",
      isFallbackRetry: false,
      resolvedThinkLevel: "medium",
      timeoutMs: 1_000,
      runId: "run-elevated-followup",
      opts: {
        bashElevated,
      } as Parameters<typeof runAgentAttempt>[0]["opts"],
      runContext: {} as Parameters<typeof runAgentAttempt>[0]["runContext"],
      spawnedBy: undefined,
      messageChannel: "telegram",
      skillsSnapshot: undefined,
      resolvedVerboseLevel: undefined,
      agentDir,
      onAgentEvent: vi.fn(),
      authProfileProvider: "openai",
      sessionStore,
      storePath,
      sessionHasHistory: false,
    });

    expectMockArgFields(runEmbeddedAgentMock, {
      provider: "openai",
      model: "gpt-5.4",
      bashElevated,
    });
  });

  it("forwards one-shot CLI cleanup to CLI providers", async () => {
    const sessionKey = "agent:main:direct:cleanup-claude-cli";
    const sessionEntry: SessionEntry = {
      sessionId: "openclaw-session-cleanup-cli",
      updatedAt: Date.now(),
    };
    const sessionStore: Record<string, SessionEntry> = { [sessionKey]: sessionEntry };
    await writeSessionStoreSeed(sessionStore);
    runCliAgentMock.mockResolvedValueOnce(makeCliResult("cleanup cli"));

    await runAgentAttempt({
      providerOverride: "claude-cli",
      originalProvider: "claude-cli",
      modelOverride: "claude-opus-4-7",
      cfg: {} as OpenClawConfig,
      sessionEntry,
      sessionId: sessionEntry.sessionId,
      sessionKey,
      sessionAgentId: "main",
      sessionFile: path.join(tmpDir, "session.jsonl"),
      workspaceDir: tmpDir,
      body: "cleanup",
      isFallbackRetry: false,
      resolvedThinkLevel: "medium",
      timeoutMs: 1_000,
      runId: "run-cleanup-claude-cli",
      opts: {
        cleanupBundleMcpOnRunEnd: true,
        cleanupCliLiveSessionOnRunEnd: true,
      } as Parameters<typeof runAgentAttempt>[0]["opts"],
      runContext: {} as Parameters<typeof runAgentAttempt>[0]["runContext"],
      spawnedBy: undefined,
      messageChannel: undefined,
      skillsSnapshot: undefined,
      resolvedVerboseLevel: undefined,
      agentDir,
      onAgentEvent: vi.fn(),
      authProfileProvider: "claude-cli",
      sessionStore,
      storePath,
      sessionHasHistory: false,
    });

    expectMockArgFields(runCliAgentMock, {
      cleanupBundleMcpOnRunEnd: true,
      cleanupCliLiveSessionOnRunEnd: true,
    });
    expect(runEmbeddedAgentMock).not.toHaveBeenCalled();
  });

  it("replaces a stale automatic session profile with the configured model profile", async () => {
    const embeddedArg = await runOpenClawEmbeddedAttemptForTest({
      runId: "configured-auth-replaces-auto",
      configuredAuthProfileId: "openai:verified",
      sessionEntry: {
        authProfileOverride: "openai:stale-auto",
        authProfileOverrideSource: "auto",
      },
    });

    expectRecordFields(embeddedArg, {
      authProfileId: "openai:verified",
      authProfileIdSource: "user",
    });
  });

  it("preserves an explicit session profile over the configured model profile", async () => {
    const embeddedArg = await runOpenClawEmbeddedAttemptForTest({
      runId: "session-auth-over-configured",
      configuredAuthProfileId: "openai:verified",
      sessionEntry: {
        authProfileOverride: "openai:session-choice",
        authProfileOverrideSource: "user",
      },
    });

    expectRecordFields(embeddedArg, {
      authProfileId: "openai:session-choice",
      authProfileIdSource: "user",
    });
  });
});

describe("embedded attempt harness pinning", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-embedded-attempt-"));
    runCliAgentMock.mockReset();
    runEmbeddedAgentMock.mockReset();
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("does not store a session harness pin for default OpenAI Codex routing", async () => {
    const sessionEntry: SessionEntry = {
      sessionId: "legacy-session",
      updatedAt: Date.now(),
    };
    runEmbeddedAgentMock.mockResolvedValueOnce({
      meta: { durationMs: 1 },
    } satisfies EmbeddedAgentRunResult);

    await runAgentAttempt({
      providerOverride: "openai",
      originalProvider: "openai",
      modelOverride: "gpt-5.4",
      cfg: {} as OpenClawConfig,
      sessionEntry,
      sessionId: sessionEntry.sessionId,
      sessionKey: "agent:main:main",
      sessionAgentId: "main",
      sessionFile: path.join(tmpDir, "session.jsonl"),
      workspaceDir: tmpDir,
      body: "continue",
      isFallbackRetry: false,
      resolvedThinkLevel: "medium",
      timeoutMs: 1_000,
      runId: "run-legacy-runtime-pin",
      opts: {} as Parameters<typeof runAgentAttempt>[0]["opts"],
      runContext: {} as Parameters<typeof runAgentAttempt>[0]["runContext"],
      spawnedBy: undefined,
      messageChannel: undefined,
      skillsSnapshot: undefined,
      resolvedVerboseLevel: undefined,
      agentDir: tmpDir,
      onAgentEvent: vi.fn(),
      authProfileProvider: "openai",
      sessionHasHistory: true,
    });

    expectMockArgFields(runEmbeddedAgentMock, { agentHarnessId: undefined });
  });

  it("keeps a catalog-adopted Codex harness pinned for direct command attempts", async () => {
    const sessionEntry: SessionEntry = {
      sessionId: "mixed-provider-session",
      updatedAt: Date.now(),
      agentHarnessId: "codex",
      modelSelectionLocked: true,
      pluginExtensions: {
        codex: {
          supervision: {
            sourceThreadId: "019f-codex-thread",
            modelLocked: true,
          },
        },
      },
    };
    runEmbeddedAgentMock.mockResolvedValueOnce({
      meta: { durationMs: 1 },
    } satisfies EmbeddedAgentRunResult);

    await runAgentAttempt({
      providerOverride: "anthropic",
      originalProvider: "anthropic",
      modelOverride: "claude-opus-4-7",
      cfg: {
        agents: {
          defaults: {
            models: {
              "anthropic/claude-opus-4-7": { agentRuntime: { id: "claude-cli" } },
            },
          },
        },
      } as OpenClawConfig,
      sessionEntry,
      agentHarnessRuntimeOverride: "codex",
      sessionId: sessionEntry.sessionId,
      sessionKey: "agent:main:main",
      sessionAgentId: "main",
      sessionFile: path.join(tmpDir, "session.jsonl"),
      workspaceDir: tmpDir,
      body: "switch to minimax",
      isFallbackRetry: false,
      resolvedThinkLevel: "medium",
      timeoutMs: 1_000,
      runId: "run-mixed-provider-auto-runtime",
      opts: {} as Parameters<typeof runAgentAttempt>[0]["opts"],
      runContext: {} as Parameters<typeof runAgentAttempt>[0]["runContext"],
      spawnedBy: undefined,
      messageChannel: undefined,
      skillsSnapshot: undefined,
      resolvedVerboseLevel: undefined,
      agentDir: tmpDir,
      onAgentEvent: vi.fn(),
      authProfileProvider: "anthropic",
      sessionHasHistory: true,
    });

    expect(runCliAgentMock).not.toHaveBeenCalled();
    expectMockArgFields(runEmbeddedAgentMock, {
      provider: "anthropic",
      model: "claude-opus-4-7",
      agentHarnessId: "codex",
      agentHarnessRuntimeOverride: "codex",
      modelSelectionLocked: true,
    });
  });

  it("ignores stale session Codex harness pins on non-OpenAI model switches", async () => {
    const sessionEntry: SessionEntry = {
      sessionId: "mixed-provider-session",
      updatedAt: Date.now(),
      agentHarnessId: "codex",
    };
    runEmbeddedAgentMock.mockResolvedValueOnce({
      meta: { durationMs: 1 },
    } satisfies EmbeddedAgentRunResult);

    await runAgentAttempt({
      providerOverride: "minimax",
      originalProvider: "minimax",
      modelOverride: "minimax-m2.7",
      cfg: {} as OpenClawConfig,
      sessionEntry,
      sessionId: sessionEntry.sessionId,
      sessionKey: "agent:main:main",
      sessionAgentId: "main",
      sessionFile: path.join(tmpDir, "session.jsonl"),
      workspaceDir: tmpDir,
      body: "switch to minimax",
      isFallbackRetry: false,
      resolvedThinkLevel: "medium",
      timeoutMs: 1_000,
      runId: "run-mixed-provider-auto-runtime",
      opts: {} as Parameters<typeof runAgentAttempt>[0]["opts"],
      runContext: {} as Parameters<typeof runAgentAttempt>[0]["runContext"],
      spawnedBy: undefined,
      messageChannel: undefined,
      skillsSnapshot: undefined,
      resolvedVerboseLevel: undefined,
      agentDir: tmpDir,
      onAgentEvent: vi.fn(),
      authProfileProvider: "minimax",
      sessionHasHistory: true,
    });

    expectMockArgFields(runEmbeddedAgentMock, { agentHarnessId: undefined });
  });

  it("does not leak a persisted CLI harness alias across providers", async () => {
    const sessionEntry: SessionEntry = {
      sessionId: "legacy-cli-pin",
      updatedAt: Date.now(),
      agentHarnessId: "claude-cli",
    };
    runEmbeddedAgentMock.mockResolvedValueOnce({
      meta: { durationMs: 1 },
    } satisfies EmbeddedAgentRunResult);

    await runAgentAttempt({
      providerOverride: "openai",
      originalProvider: "openai",
      modelOverride: "gpt-5.4",
      cfg: {} as OpenClawConfig,
      sessionEntry,
      sessionId: sessionEntry.sessionId,
      sessionKey: "agent:main:main",
      sessionAgentId: "main",
      sessionFile: path.join(tmpDir, "session.jsonl"),
      workspaceDir: tmpDir,
      body: "continue",
      isFallbackRetry: false,
      resolvedThinkLevel: "medium",
      timeoutMs: 1_000,
      runId: "run-provider-incompatible-cli-pin",
      opts: {} as Parameters<typeof runAgentAttempt>[0]["opts"],
      runContext: {} as Parameters<typeof runAgentAttempt>[0]["runContext"],
      spawnedBy: undefined,
      messageChannel: undefined,
      skillsSnapshot: undefined,
      resolvedVerboseLevel: undefined,
      agentDir: tmpDir,
      onAgentEvent: vi.fn(),
      authProfileProvider: "openai",
      sessionHasHistory: true,
    });

    expect(runCliAgentMock).not.toHaveBeenCalled();
    expectMockArgFields(runEmbeddedAgentMock, {
      provider: "openai",
      model: "gpt-5.4",
      agentHarnessId: undefined,
      agentHarnessRuntimeOverride: undefined,
    });
  });

  it("forwards runtime toolsAllow into embedded attempts", async () => {
    const sessionEntry: SessionEntry = {
      sessionId: "tools-allow-session",
      updatedAt: Date.now(),
    };
    runEmbeddedAgentMock.mockResolvedValueOnce({
      meta: { durationMs: 1 },
    } satisfies EmbeddedAgentRunResult);

    await runAgentAttempt({
      providerOverride: "openai",
      originalProvider: "openai",
      modelOverride: "gpt-5.4",
      cfg: {} as OpenClawConfig,
      sessionEntry,
      sessionId: sessionEntry.sessionId,
      sessionKey: "agent:main:main",
      sessionAgentId: "main",
      sessionFile: path.join(tmpDir, "session.jsonl"),
      workspaceDir: tmpDir,
      body: "read only",
      isFallbackRetry: false,
      resolvedThinkLevel: "medium",
      timeoutMs: 1_000,
      runId: "run-tools-allow",
      opts: {
        toolsAllow: ["read", "web_search"],
      } as Parameters<typeof runAgentAttempt>[0]["opts"],
      runContext: {} as Parameters<typeof runAgentAttempt>[0]["runContext"],
      spawnedBy: undefined,
      messageChannel: undefined,
      skillsSnapshot: undefined,
      resolvedVerboseLevel: undefined,
      agentDir: tmpDir,
      onAgentEvent: vi.fn(),
      authProfileProvider: "openai",
      sessionHasHistory: false,
    });

    expectMockArgFields(runEmbeddedAgentMock, { toolsAllow: ["read", "web_search"] });
  });

  it("lets provider/model runtime policy choose Codex without storing a session harness pin", async () => {
    const sessionEntry: SessionEntry = {
      sessionId: "codex-history-session",
      updatedAt: Date.now(),
    };
    runEmbeddedAgentMock.mockResolvedValueOnce({
      meta: { durationMs: 1 },
    } satisfies EmbeddedAgentRunResult);

    await runAgentAttempt({
      providerOverride: "codex",
      originalProvider: "codex",
      modelOverride: "gpt-5.4",
      cfg: {
        models: {
          providers: {
            codex: {
              baseUrl: "https://api.openai.com/v1",
              agentRuntime: { id: "codex" },
              models: [],
            },
          },
        },
      } as OpenClawConfig,
      sessionEntry,
      sessionId: sessionEntry.sessionId,
      sessionKey: "agent:main:main",
      sessionAgentId: "main",
      sessionFile: path.join(tmpDir, "session.jsonl"),
      workspaceDir: tmpDir,
      body: "continue",
      isFallbackRetry: false,
      resolvedThinkLevel: "medium",
      timeoutMs: 1_000,
      runId: "run-codex-no-runtime-pin",
      opts: {} as Parameters<typeof runAgentAttempt>[0]["opts"],
      runContext: {} as Parameters<typeof runAgentAttempt>[0]["runContext"],
      spawnedBy: undefined,
      messageChannel: undefined,
      skillsSnapshot: undefined,
      resolvedVerboseLevel: undefined,
      agentDir: tmpDir,
      onAgentEvent: vi.fn(),
      authProfileProvider: "codex",
      sessionHasHistory: true,
    });

    expectMockArgFields(runEmbeddedAgentMock, { agentHarnessId: undefined });
  });

  it("auto-forwards OpenAI Codex auth profiles to default Codex harness runs", async () => {
    const { clearAgentHarnesses, registerAgentHarness } = await import("../harness/registry.js");
    const sessionEntry: SessionEntry = {
      sessionId: "codex-auth-session",
      updatedAt: Date.now(),
    };
    saveAuthProfileStore(
      {
        version: 1,
        profiles: {
          "openai:work": {
            type: "oauth",
            provider: "openai",
            access: "access-token",
            refresh: "refresh-token",
            expires: Date.now() + 60_000,
          },
        },
      },
      tmpDir,
      { filterExternalAuthProfiles: false, syncExternalCli: false },
    );
    runEmbeddedAgentMock.mockResolvedValueOnce({
      meta: { durationMs: 1 },
    } satisfies EmbeddedAgentRunResult);
    clearAgentHarnesses();
    registerAgentHarness({
      id: "codex",
      label: "Codex",
      supports: () => ({ supported: true, priority: 100 }),
      runAttempt: vi.fn(),
    });

    try {
      await runAgentAttempt({
        providerOverride: "openai",
        originalProvider: "openai",
        modelOverride: "gpt-5.4",
        cfg: {} as OpenClawConfig,
        sessionEntry,
        sessionId: sessionEntry.sessionId,
        sessionKey: "agent:main:main",
        sessionAgentId: "main",
        sessionFile: path.join(tmpDir, "session.jsonl"),
        workspaceDir: tmpDir,
        body: "continue",
        isFallbackRetry: false,
        resolvedThinkLevel: "medium",
        timeoutMs: 1_000,
        runId: "run-codex-auto-auth-profile",
        opts: {} as Parameters<typeof runAgentAttempt>[0]["opts"],
        runContext: {} as Parameters<typeof runAgentAttempt>[0]["runContext"],
        spawnedBy: undefined,
        messageChannel: undefined,
        skillsSnapshot: undefined,
        resolvedVerboseLevel: undefined,
        agentDir: tmpDir,
        onAgentEvent: vi.fn(),
        authProfileProvider: "openai",
        sessionHasHistory: true,
      });
    } finally {
      clearAgentHarnesses();
    }

    expectMockArgFields(runEmbeddedAgentMock, {
      agentHarnessId: undefined,
      authProfileId: "openai:work",
      authProfileIdSource: "auto",
    });
  });

  it("pins a fresh OpenAI session to the Codex harness by default", async () => {
    const sessionEntry: SessionEntry = {
      sessionId: "fresh-session",
      updatedAt: Date.now(),
    };
    runEmbeddedAgentMock.mockResolvedValueOnce({
      meta: { durationMs: 1 },
    } satisfies EmbeddedAgentRunResult);

    await runAgentAttempt({
      providerOverride: "openai",
      originalProvider: "openai",
      modelOverride: "gpt-5.4",
      cfg: {} as OpenClawConfig,
      sessionEntry,
      sessionId: sessionEntry.sessionId,
      sessionKey: "agent:main:main",
      sessionAgentId: "main",
      sessionFile: path.join(tmpDir, "session.jsonl"),
      workspaceDir: tmpDir,
      body: "start",
      isFallbackRetry: false,
      resolvedThinkLevel: "medium",
      timeoutMs: 1_000,
      runId: "run-fresh-no-pin",
      opts: {} as Parameters<typeof runAgentAttempt>[0]["opts"],
      runContext: {} as Parameters<typeof runAgentAttempt>[0]["runContext"],
      spawnedBy: undefined,
      messageChannel: undefined,
      skillsSnapshot: undefined,
      resolvedVerboseLevel: undefined,
      agentDir: tmpDir,
      onAgentEvent: vi.fn(),
      authProfileProvider: "openai",
      sessionHasHistory: false,
    });

    expectMockArgFields(runEmbeddedAgentMock, { agentHarnessId: undefined });
  });

  it("honors a resolved persisted OpenClaw harness", async () => {
    const sessionEntry: SessionEntry = {
      sessionId: "stale-agent-session",
      updatedAt: Date.now(),
      agentHarnessId: "openclaw",
    };
    runEmbeddedAgentMock.mockResolvedValueOnce({
      meta: { durationMs: 1 },
    } satisfies EmbeddedAgentRunResult);

    await runAgentAttempt({
      providerOverride: "openai",
      originalProvider: "openai",
      modelOverride: "gpt-5.4",
      cfg: {} as OpenClawConfig,
      sessionEntry,
      agentHarnessRuntimeOverride: "openclaw",
      sessionId: sessionEntry.sessionId,
      sessionKey: "agent:main:main",
      sessionAgentId: "main",
      sessionFile: path.join(tmpDir, "session.jsonl"),
      workspaceDir: tmpDir,
      body: "continue",
      isFallbackRetry: false,
      resolvedThinkLevel: "medium",
      timeoutMs: 1_000,
      runId: "run-stale-openai-runtime-pin",
      opts: {} as Parameters<typeof runAgentAttempt>[0]["opts"],
      runContext: {} as Parameters<typeof runAgentAttempt>[0]["runContext"],
      spawnedBy: undefined,
      messageChannel: undefined,
      skillsSnapshot: undefined,
      resolvedVerboseLevel: undefined,
      agentDir: tmpDir,
      onAgentEvent: vi.fn(),
      authProfileProvider: "openai",
      sessionHasHistory: true,
    });

    expectMockArgFields(runEmbeddedAgentMock, {
      provider: "openai",
      agentHarnessId: "openclaw",
      agentHarnessRuntimeOverride: "openclaw",
    });
  });

  it("honors an explicit OpenClaw session runtime override", async () => {
    const sessionEntry: SessionEntry = {
      sessionId: "explicit-openclaw-session",
      updatedAt: Date.now(),
      agentRuntimeOverride: "openclaw",
      agentHarnessId: "codex",
    };
    runEmbeddedAgentMock.mockResolvedValueOnce({
      meta: { durationMs: 1 },
    } satisfies EmbeddedAgentRunResult);

    await runAgentAttempt({
      providerOverride: "openai",
      originalProvider: "openai",
      modelOverride: "gpt-5.6-luna",
      cfg: {} as OpenClawConfig,
      sessionEntry,
      agentHarnessRuntimeOverride: "openclaw",
      sessionId: sessionEntry.sessionId,
      sessionKey: "agent:main:main",
      sessionAgentId: "main",
      sessionFile: path.join(tmpDir, "session.jsonl"),
      workspaceDir: tmpDir,
      body: "continue",
      isFallbackRetry: false,
      resolvedThinkLevel: "ultra",
      timeoutMs: 1_000,
      runId: "run-explicit-openclaw-runtime",
      opts: {} as Parameters<typeof runAgentAttempt>[0]["opts"],
      runContext: {} as Parameters<typeof runAgentAttempt>[0]["runContext"],
      spawnedBy: undefined,
      messageChannel: undefined,
      skillsSnapshot: undefined,
      resolvedVerboseLevel: undefined,
      agentDir: tmpDir,
      onAgentEvent: vi.fn(),
      authProfileProvider: "openai",
      sessionHasHistory: true,
    });

    expectMockArgFields(runEmbeddedAgentMock, {
      provider: "openai",
      model: "gpt-5.6-luna",
      agentHarnessId: "openclaw",
      agentHarnessRuntimeOverride: "openclaw",
      thinkLevel: "ultra",
    });
  });

  it("routes explicit OpenAI native runs with legacy Codex OAuth through OpenClaw", async () => {
    const sessionEntry: SessionEntry = {
      sessionId: "explicit-agent-codex-oauth-session",
      updatedAt: Date.now(),
      authProfileOverride: "openai:work",
      authProfileOverrideSource: "user",
    };
    runEmbeddedAgentMock.mockResolvedValueOnce({
      meta: { durationMs: 1 },
    } satisfies EmbeddedAgentRunResult);

    await runAgentAttempt({
      providerOverride: "openai",
      originalProvider: "openai",
      modelOverride: "gpt-5.4",
      cfg: {
        models: {
          providers: {
            openai: {
              baseUrl: "https://api.openai.com/v1",
              agentRuntime: { id: "openclaw" },
              models: [],
            },
          },
        },
      } as OpenClawConfig,
      sessionEntry,
      sessionId: sessionEntry.sessionId,
      sessionKey: "agent:main:main",
      sessionAgentId: "main",
      sessionFile: path.join(tmpDir, "session.jsonl"),
      workspaceDir: tmpDir,
      body: "continue",
      isFallbackRetry: false,
      resolvedThinkLevel: "medium",
      timeoutMs: 1_000,
      runId: "run-openai-agent-codex-oauth",
      opts: {} as Parameters<typeof runAgentAttempt>[0]["opts"],
      runContext: {} as Parameters<typeof runAgentAttempt>[0]["runContext"],
      spawnedBy: undefined,
      messageChannel: undefined,
      skillsSnapshot: undefined,
      resolvedVerboseLevel: undefined,
      agentDir: tmpDir,
      onAgentEvent: vi.fn(),
      authProfileProvider: "openai",
      sessionHasHistory: false,
    });

    expectMockArgFields(runEmbeddedAgentMock, {
      provider: "openai",
      model: "gpt-5.4",
      agentHarnessId: "openclaw",
      agentHarnessRuntimeOverride: "openclaw",
      authProfileId: "openai:work",
      authProfileIdSource: "user",
    });
  });

  it("does not pass CLI runtime aliases as embedded harness ids for fallback providers", async () => {
    const sessionEntry: SessionEntry = {
      sessionId: "fallback-session",
      updatedAt: Date.now(),
    };
    runEmbeddedAgentMock.mockResolvedValueOnce({
      meta: { durationMs: 1 },
    } satisfies EmbeddedAgentRunResult);

    await runAgentAttempt({
      providerOverride: "openai",
      originalProvider: "claude-cli",
      modelOverride: "gpt-5.4",
      cfg: {
        agents: {
          defaults: {
            agentRuntime: { id: "claude-cli" },
          },
        },
      } as OpenClawConfig,
      sessionEntry,
      sessionId: sessionEntry.sessionId,
      sessionKey: "agent:main:main",
      sessionAgentId: "main",
      sessionFile: path.join(tmpDir, "session.jsonl"),
      workspaceDir: tmpDir,
      body: "fallback",
      isFallbackRetry: true,
      resolvedThinkLevel: "medium",
      timeoutMs: 1_000,
      runId: "run-openai-fallback-with-cli-runtime",
      opts: {} as Parameters<typeof runAgentAttempt>[0]["opts"],
      runContext: {} as Parameters<typeof runAgentAttempt>[0]["runContext"],
      spawnedBy: undefined,
      messageChannel: undefined,
      skillsSnapshot: undefined,
      resolvedVerboseLevel: undefined,
      agentDir: tmpDir,
      onAgentEvent: vi.fn(),
      authProfileProvider: "openai",
      sessionHasHistory: false,
    });

    expect(runCliAgentMock).not.toHaveBeenCalled();
    expect(runEmbeddedAgentMock).toHaveBeenCalledOnce();
    expect(firstEmbeddedAgentArg()).not.toHaveProperty("agentHarnessId", "claude-cli");
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
