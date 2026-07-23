// Tests reply session persistence, route updates, and label behavior.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { testing as sessionMcpTesting } from "../../agents/agent-bundle-mcp-runtime.js";
import { getOrCreateSessionMcpRuntime } from "../../agents/agent-bundle-mcp-tools.js";
import * as bootstrapCache from "../../agents/bootstrap-cache.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { InternalSessionEntry as SessionEntry } from "../../config/sessions.js";
import { formatSqliteSessionFileMarker } from "../../config/sessions/legacy-sqlite-marker.js";
import {
  appendTranscriptMessage,
  appendTranscriptEvent,
  loadSessionEntry,
  loadTranscriptEvents,
} from "../../config/sessions/session-accessor.js";
import { runExclusiveSessionStoreWrite } from "../../config/sessions/store-writer.js";
import { formatZonedTimestamp } from "../../infra/format-time/format-datetime.ts";
import {
  testing as sessionBindingTesting,
  getSessionBindingService,
  registerSessionBindingAdapter,
} from "../../infra/outbound/session-binding-service.js";
import {
  enqueueSystemEvent,
  peekSystemEvents,
  resetSystemEventsForTest,
} from "../../infra/system-events.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import { MODEL_SELECTION_LOCKED_RESET_MESSAGE } from "../../sessions/model-overrides.js";
import {
  beginSessionWorkAdmission,
  isSessionLifecycleMutationActive,
  runExclusiveSessionLifecycleMutation,
} from "../../sessions/session-lifecycle-admission.js";
import { listSessionStateEventsSince } from "../../sessions/session-state-events.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { createSessionConversationTestRegistry } from "../../test-utils/session-conversation-registry.js";
import { finalizeInboundContext } from "./inbound-context.js";
import { replyRunRegistry } from "./reply-run-registry.js";
import { drainFormattedSystemEvents } from "./session-system-events.js";
import { persistSessionUsageUpdate } from "./session-usage.js";
import { resolveReplySessionPreprocessingState } from "./session.js";
import {
  initSessionState,
  readSessionStore as readSessionStoreFast,
  runExplicitResetCases,
  writeSessionStore as writeSessionStoreFast,
} from "./test/session.test-support.js";

const sessionForkMocks = vi.hoisted(() => ({
  forkSessionFromParent: vi.fn(),
  resolveParentForkTokenCount: vi.fn(),
  nextSessionId: 0,
}));
const channelSummaryMocks = vi.hoisted(() => ({
  buildChannelSummary: vi.fn(async () => [] as string[]),
}));
const browserMaintenanceMocks = vi.hoisted(() => ({
  closeTrackedBrowserTabsForSessions: vi.fn(async () => 0),
}));

type ForkSessionParamsForTest = {
  parentEntry: SessionEntry;
  storePath: string;
};

vi.mock("./session-fork.js", () => ({
  forkSessionEntryFromParent: async (params: {
    fallbackEntry?: SessionEntry;
    parentSessionKey: string;
    storePath: string;
    patch?: (patchParams: {
      entry: SessionEntry;
      parentEntry: SessionEntry;
      fork: { sessionId: string; sessionFile: string };
      decision: { status: "fork"; maxTokens: number; parentTokens?: number };
    }) => Partial<SessionEntry>;
    decisionSkipPatch?: (patchParams: {
      decision: {
        status: "skip";
        reason: "parent-too-large";
        maxTokens: number;
        parentTokens: number;
        message: string;
      };
      entry: SessionEntry;
      parentEntry: SessionEntry;
    }) => Partial<SessionEntry>;
    sessionKey?: string;
  }) => {
    const parentEntry = loadSessionEntry({
      sessionKey: params.parentSessionKey,
      storePath: params.storePath,
      readConsistency: "latest",
    });
    if (!parentEntry?.sessionId) {
      return { status: "missing-parent" };
    }
    const maxTokens = 100_000;
    const parentTokens = await sessionForkMocks.resolveParentForkTokenCount({
      parentEntry,
      storePath: params.storePath,
    });
    if (typeof parentTokens === "number" && parentTokens > maxTokens) {
      const entry = params.fallbackEntry ?? { sessionId: "", updatedAt: Date.now() };
      const decision = {
        status: "skip" as const,
        reason: "parent-too-large" as const,
        maxTokens,
        parentTokens,
        message: `Parent context is too large to fork (${parentTokens}/${maxTokens} tokens); starting with isolated context instead.`,
      };
      return {
        status: "skipped",
        reason: "decision-skip",
        parentEntry,
        sessionEntry: {
          ...entry,
          ...params.decisionSkipPatch?.({ decision, entry, parentEntry }),
        },
        decision,
      };
    }
    const fork = await sessionForkMocks.forkSessionFromParent({
      parentEntry,
      storePath: params.storePath,
    });
    if (!fork) {
      return { status: "failed" };
    }
    const entry = params.fallbackEntry ?? { sessionId: "", updatedAt: Date.now() };
    return {
      status: "forked",
      fork,
      parentEntry,
      sessionEntry: {
        ...entry,
        ...params.patch?.({
          entry,
          parentEntry,
          fork,
          decision: {
            status: "fork",
            maxTokens,
            ...(typeof parentTokens === "number" ? { parentTokens } : {}),
          },
        }),
        sessionId: fork.sessionId,
        sessionFile: fork.sessionFile,
        forkedFromParent: true,
      },
      decision: {
        status: "fork",
        maxTokens,
        ...(typeof parentTokens === "number" ? { parentTokens } : {}),
      },
    };
  },
  forkSessionFromParent: (...args: [ForkSessionParamsForTest]) =>
    sessionForkMocks.forkSessionFromParent(...args),
  resolveParentForkTokenCount: (...args: [{ parentEntry: SessionEntry; storePath: string }]) =>
    sessionForkMocks.resolveParentForkTokenCount(...args),
  resolveParentForkDecision: async (params: { parentEntry: SessionEntry; storePath: string }) => {
    const maxTokens = 100_000;
    const parentTokens = await sessionForkMocks.resolveParentForkTokenCount({
      parentEntry: params.parentEntry,
      storePath: params.storePath,
    });
    if (typeof parentTokens === "number" && parentTokens > maxTokens) {
      return {
        status: "skip",
        reason: "parent-too-large",
        maxTokens,
        parentTokens,
        message: `Parent context is too large to fork (${parentTokens}/${maxTokens} tokens); starting with isolated context instead.`,
      };
    }
    return {
      status: "fork",
      maxTokens,
      ...(typeof parentTokens === "number" ? { parentTokens } : {}),
    };
  },
}));

vi.mock("../../plugin-sdk/browser-maintenance.js", () => ({
  closeTrackedBrowserTabsForSessions: browserMaintenanceMocks.closeTrackedBrowserTabsForSessions,
}));

vi.mock("../../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: () => null,
}));

vi.mock("../../infra/channel-summary.js", () => ({
  buildChannelSummary: channelSummaryMocks.buildChannelSummary,
}));

// Perf: session-store locks are exercised elsewhere; most session tests don't need FS lock files.
vi.mock("../../agents/session-write-lock.js", async () => {
  const actual = await vi.importActual<typeof import("../../agents/session-write-lock.js")>(
    "../../agents/session-write-lock.js",
  );
  return {
    ...actual,
    acquireSessionWriteLock: vi.fn(async () => ({ release: async () => {} })),
    resolveSessionLockMaxHoldFromTimeout: vi.fn(
      ({
        timeoutMs,
        graceMs = 2 * 60 * 1000,
        minMs = 5 * 60 * 1000,
      }: {
        timeoutMs: number;
        graceMs?: number;
        minMs?: number;
      }) => Math.max(minMs, timeoutMs + graceMs),
    ),
  };
});

vi.mock("../../agents/prepared-model-catalog.js", () => ({
  loadPreparedModelCatalog: vi.fn(async () => [
    { provider: "minimax", id: "m2.7", name: "M2.7" },
    { provider: "openai", id: "gpt-4o-mini", name: "GPT-4o mini" },
  ]),
}));

let suiteRoot = "";
let suiteCase = 0;

beforeAll(async () => {
  suiteRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-session-suite-"));
});

afterAll(async () => {
  await fs.rm(suiteRoot, { recursive: true, force: true });
  suiteRoot = "";
  suiteCase = 0;
});

async function makeCaseDir(prefix: string): Promise<string> {
  const dir = path.join(suiteRoot, `${prefix}${++suiteCase}`);
  await fs.mkdir(dir);
  return dir;
}

async function makeStorePath(prefix: string): Promise<string> {
  const root = await makeCaseDir(prefix);
  return path.join(root, "sessions.json");
}

const createStorePath = makeStorePath;
const TEST_NATIVE_MODEL_PROFILE_ID = "openai:secondary@example.test";

function requireString(value: string | undefined, label: string): string {
  if (!value) {
    throw new Error(`expected ${label}`);
  }
  return value;
}

function requireMockCallArg(
  mockFn: { mock: { calls: unknown[][] } },
  label: string,
  index = 0,
): Record<string, unknown> {
  const arg = mockFn.mock.calls[index]?.[0] as Record<string, unknown> | undefined;
  if (!arg) {
    throw new Error(`expected ${label} call #${index + 1}`);
  }
  return arg;
}

function expectEntryFields(
  entry: SessionEntry,
  expected: Record<string, unknown>,
  label?: string,
): void {
  for (const [key, value] of Object.entries(expected)) {
    expect((entry as unknown as Record<string, unknown>)[key], label ?? key).toEqual(value);
  }
}

describe("resolveReplySessionPreprocessingState", () => {
  const sessionKey = "agent:main:harness:codex:supervision:media-preflight";

  function resolvePreprocessingState(storePath: string) {
    return resolveReplySessionPreprocessingState({
      cfg: { session: { store: storePath } } as OpenClawConfig,
      ctx: finalizeInboundContext({
        Body: "<media:audio>",
        RawBody: "<media:audio>",
        CommandBody: "<media:audio>",
        From: "media-preflight",
        To: "bot",
        ChatType: "direct",
        SessionKey: sessionKey,
        Provider: "telegram",
        Surface: "telegram",
      }),
    });
  }

  it("returns the valid durable harness owner lock before preprocessing", async () => {
    const storePath = await createStorePath("openclaw-media-preflight-valid-");
    await writeSessionStoreFast(storePath, {
      [sessionKey]: {
        sessionId: "native-media-session",
        updatedAt: Date.now(),
        agentHarnessId: "codex",
        modelSelectionLocked: true,
      },
    });

    expect(resolvePreprocessingState(storePath)).toMatchObject({
      sessionKey,
      storePath,
      sessionEntry: {
        sessionId: "native-media-session",
        agentHarnessId: "codex",
        modelSelectionLocked: true,
      },
    });
  });

  // A "missing session id" case is unrepresentable post-flip: sessions rows
  // are NOT NULL on session_id and upsert repairs id-less patches at write
  // time, so the store can never hand preprocessing such an entry.
  it.each([
    ["missing row", undefined],
    [
      "wrong owner",
      {
        sessionId: "native-media-session",
        updatedAt: 1,
        agentHarnessId: "other",
        modelSelectionLocked: true,
      },
    ],
  ] as const)("rejects a reserved %s before preprocessing", async (_label, entry) => {
    const storePath = await createStorePath(`openclaw-media-preflight-invalid-${_label}-`);
    await writeSessionStoreFast(storePath, entry ? { [sessionKey]: entry } : {});

    expect(() => resolvePreprocessingState(storePath)).toThrow();
  });
});

async function writeTerminalTranscriptSessionStore(params: {
  storePath: string;
  sessionKey: string;
  sessionId: string;
  status?: SessionEntry["status"];
  omitStatus?: boolean;
  updatedAt: number;
  endedAt: number;
  transcriptMutationOrder: "after-registry" | "before-registry";
}): Promise<void> {
  const sessionFile = `${params.sessionId}.jsonl`;
  const status = params.status ?? (params.omitStatus ? undefined : "done");
  const appendTranscript = () =>
    appendTranscriptEvent(
      {
        agentId: "main",
        sessionId: params.sessionId,
        sessionKey: params.sessionKey,
        storePath: params.storePath,
      },
      { type: "custom", timestamp: "1970-01-01T00:00:00.001Z" },
    );
  if (params.transcriptMutationOrder === "before-registry") {
    await appendTranscript();
  }
  await writeSessionStoreFast(params.storePath, {
    [params.sessionKey]: {
      sessionId: params.sessionId,
      sessionFile,
      updatedAt: params.updatedAt,
      startedAt: params.endedAt - 10_000,
      endedAt: params.endedAt,
      runtimeMs: 9_000,
      ...(status ? { status } : {}),
    },
  });
  if (params.transcriptMutationOrder === "after-registry") {
    await appendTranscript();
  }
}

function setMinimalCurrentConversationBindingRegistryForTests(): void {
  setActivePluginRegistry(
    createTestRegistry([
      {
        pluginId: "slack",
        source: "test",
        plugin: {
          ...createChannelTestPluginBase({ id: "slack", label: "Slack" }),
          bindings: {
            resolveCommandConversation: ({
              originatingTo,
              commandTo,
              fallbackTo,
            }: {
              originatingTo?: string;
              commandTo?: string;
              fallbackTo?: string;
            }) => {
              const conversationId = [originatingTo, commandTo, fallbackTo]
                .map((candidate) => candidate?.trim())
                .find((candidate) => candidate && candidate.length > 0);
              return conversationId ? { conversationId } : null;
            },
          },
        },
      },
      {
        pluginId: "signal",
        source: "test",
        plugin: {
          ...createChannelTestPluginBase({ id: "signal", label: "Signal" }),
          bindings: {
            resolveCommandConversation: ({
              originatingTo,
              commandTo,
              fallbackTo,
            }: {
              originatingTo?: string;
              commandTo?: string;
              fallbackTo?: string;
            }) => {
              const conversationId = [originatingTo, commandTo, fallbackTo]
                .map((candidate) => candidate?.trim().replace(/^signal:/i, ""))
                .find((candidate) => candidate && candidate.length > 0);
              return conversationId ? { conversationId } : null;
            },
          },
        },
      },
      {
        pluginId: "googlechat",
        source: "test",
        plugin: {
          ...createChannelTestPluginBase({ id: "googlechat", label: "Google Chat" }),
          bindings: {
            resolveCommandConversation: ({
              originatingTo,
              commandTo,
              fallbackTo,
            }: {
              originatingTo?: string;
              commandTo?: string;
              fallbackTo?: string;
            }) => {
              const conversationId = [originatingTo, commandTo, fallbackTo]
                .map((candidate) => candidate?.trim().replace(/^googlechat:/i, ""))
                .map((candidate) => candidate?.replace(/^spaces:/i, "spaces/"))
                .find((candidate) => candidate && candidate.length > 0);
              return conversationId ? { conversationId } : null;
            },
          },
        },
      },
    ]),
  );
}

function registerCurrentConversationBindingAdapterForTest(params: {
  channel: "slack" | "signal" | "googlechat";
  accountId: string;
}): void {
  const bindings: Array<{
    bindingId: string;
    targetSessionKey: string;
    targetKind: "session" | "subagent";
    conversation: {
      channel: string;
      accountId: string;
      conversationId: string;
      parentConversationId?: string;
    };
    status: "active";
    boundAt: number;
    metadata?: Record<string, unknown>;
  }> = [];
  registerSessionBindingAdapter({
    channel: params.channel,
    accountId: params.accountId,
    capabilities: { placements: ["current"] },
    bind: async (input) => {
      const record = {
        bindingId: `${input.conversation.channel}:${input.conversation.accountId}:${input.conversation.conversationId}`,
        targetSessionKey: input.targetSessionKey,
        targetKind: input.targetKind,
        conversation: input.conversation,
        status: "active" as const,
        boundAt: Date.now(),
        ...(input.metadata ? { metadata: input.metadata } : {}),
      };
      bindings.push(record);
      return record;
    },
    listBySession: (targetSessionKey) =>
      bindings.filter((binding) => binding.targetSessionKey === targetSessionKey),
    resolveByConversation: (ref) =>
      bindings.find(
        (binding) =>
          binding.conversation.channel === ref.channel &&
          binding.conversation.accountId === ref.accountId &&
          binding.conversation.conversationId === ref.conversationId,
      ) ?? null,
  });
}

beforeEach(() => {
  channelSummaryMocks.buildChannelSummary.mockReset().mockResolvedValue([]);
  browserMaintenanceMocks.closeTrackedBrowserTabsForSessions.mockReset().mockResolvedValue(0);
  sessionBindingTesting.resetSessionBindingAdaptersForTests();
  sessionForkMocks.nextSessionId = 0;
  sessionForkMocks.resolveParentForkTokenCount.mockReset().mockImplementation(({ parentEntry }) => {
    const tokens = parentEntry.totalTokens;
    return typeof tokens === "number" && Number.isFinite(tokens) && tokens > 0
      ? Math.floor(tokens)
      : undefined;
  });
  sessionForkMocks.forkSessionFromParent
    .mockReset()
    .mockImplementation(async ({ parentEntry, storePath }: ForkSessionParamsForTest) => {
      if (!parentEntry.sessionFile) {
        return null;
      }
      const sessionsDir = path.dirname(storePath);
      await fs.mkdir(sessionsDir, { recursive: true });
      const sessionId = `forked-session-${++sessionForkMocks.nextSessionId}`;
      const sessionFile = path.join(sessionsDir, `${sessionId}.jsonl`);
      await fs.writeFile(
        sessionFile,
        `${JSON.stringify({
          type: "session",
          version: 3,
          id: sessionId,
          timestamp: new Date().toISOString(),
          cwd: process.cwd(),
          parentSession: parentEntry.sessionFile,
        })}\n`,
        "utf-8",
      );
      return { sessionId, sessionFile: await fs.realpath(sessionFile) };
    });
});
afterEach(async () => {
  closeOpenClawStateDatabaseForTest();
  resetSystemEventsForTest();
  await sessionMcpTesting.resetSessionMcpRuntimeManager();
});
describe("initSessionState guarded initialization", () => {
  it("rejects inbound work for an archived session", async () => {
    const storePath = await createStorePath("openclaw-session-init-archived-");
    const sessionKey = "agent:main:telegram:chat:archived";
    await writeSessionStoreFast(storePath, {
      [sessionKey]: {
        sessionId: "archived-session",
        archivedAt: Date.now(),
        updatedAt: 100,
      },
    });

    await expect(
      initSessionState({
        ctx: {
          Body: "blocked while archived",
          SessionKey: sessionKey,
        },
        cfg: { session: { store: storePath } } as OpenClawConfig,
        commandAuthorized: true,
      }),
    ).rejects.toThrow(
      'Session "agent:main:telegram:chat:archived" is archived. Restore it before starting new work.',
    );
  });

  it("serializes concurrent initializers before reading the guarded snapshot", async () => {
    const storePath = await createStorePath("openclaw-session-init-race-");
    const sessionKey = "agent:main:telegram:chat:42";
    await writeSessionStoreFast(storePath, {
      [sessionKey]: {
        sessionId: "existing-session",
        updatedAt: 100,
      },
    });
    const cfg = { session: { store: storePath } } as OpenClawConfig;
    let releaseWriter = () => {};
    const writerReleased = new Promise<void>((resolve) => {
      releaseWriter = resolve;
    });
    let markWriterStarted = () => {};
    const writerStarted = new Promise<void>((resolve) => {
      markWriterStarted = resolve;
    });
    const heldWriter = runExclusiveSessionStoreWrite(storePath, async () => {
      markWriterStarted();
      await writerReleased;
    });
    await writerStarted;

    const turns = Array.from({ length: 8 }, (_, index) =>
      initSessionState({
        ctx: {
          Body: `turn ${index}`,
          SessionKey: sessionKey,
        },
        cfg,
        commandAuthorized: true,
      }),
    );

    releaseWriter();
    await heldWriter;

    await expect(Promise.all(turns)).resolves.toHaveLength(8);
  });
});

describe("initSessionState thread forking", () => {
  it("forks a new SQLite session from the parent session", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const root = await makeCaseDir("openclaw-thread-session-");
    const sessionsDir = path.join(root, "sessions");
    await fs.mkdir(sessionsDir);

    const parentSessionId = "parent-session";
    const parentSessionFile = path.join(sessionsDir, "parent.jsonl");
    const header = {
      type: "session",
      version: 3,
      id: parentSessionId,
      timestamp: new Date().toISOString(),
      cwd: process.cwd(),
    };
    const message = {
      type: "message",
      id: "m1",
      parentId: null,
      timestamp: new Date().toISOString(),
      message: { role: "user", content: "Parent prompt" },
    };
    const assistantMessage = {
      type: "message",
      id: "m2",
      parentId: "m1",
      timestamp: new Date().toISOString(),
      message: { role: "assistant", content: "Parent reply" },
    };
    await fs.writeFile(
      parentSessionFile,
      `${JSON.stringify(header)}\n${JSON.stringify(message)}\n${JSON.stringify(assistantMessage)}\n`,
      "utf-8",
    );

    const storePath = path.join(root, "sessions.json");
    const parentSessionKey = "agent:main:slack:channel:c1";
    await writeSessionStoreFast(storePath, {
      [parentSessionKey]: {
        sessionId: parentSessionId,
        sessionFile: parentSessionFile,
        updatedAt: Date.now(),
      },
    });

    const cfg = {
      session: { store: storePath },
    } as OpenClawConfig;

    const threadSessionKey = "agent:main:slack:channel:c1:thread:123";
    const threadLabel = "Slack thread #general: starter";
    const result = await initSessionState({
      ctx: {
        Body: "Thread reply",
        SessionKey: threadSessionKey,
        ParentSessionKey: parentSessionKey,
        ThreadLabel: threadLabel,
      },
      cfg,
      commandAuthorized: true,
    });

    expect(result.sessionKey).toBe(threadSessionKey);
    expect(result.sessionEntry.sessionId).not.toBe(parentSessionId);
    expect(result.sessionEntry.displayName).toBe(threadLabel);
    expect(result.sessionEntry.totalTokens).toBeUndefined();
    expect(result.sessionEntry.totalTokensFresh).toBe(false);

    expect(result.sessionEntry.forkedFromParent).toBe(true);
    expect(result.sessionEntry.forkSource).toEqual({
      sessionKey: parentSessionKey,
      sessionId: parentSessionId,
    });
    expect(result.sessionEntry.sessionFile).toBe(
      formatSqliteSessionFileMarker({
        agentId: "main",
        sessionId: result.sessionEntry.sessionId,
        storePath,
      }),
    );
    const forkCall = requireMockCallArg(sessionForkMocks.forkSessionFromParent, "fork session");
    expect(forkCall.parentEntry).toMatchObject({
      sessionId: parentSessionId,
      sessionFile: parentSessionFile,
    });
    warn.mockRestore();
  });

  it("forks from parent when thread session key already exists but was not forked yet", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const root = await makeCaseDir("openclaw-thread-session-existing-");
    const sessionsDir = path.join(root, "sessions");
    await fs.mkdir(sessionsDir);

    const parentSessionId = "parent-session";
    const parentSessionFile = path.join(sessionsDir, "parent.jsonl");
    const header = {
      type: "session",
      version: 3,
      id: parentSessionId,
      timestamp: new Date().toISOString(),
      cwd: process.cwd(),
    };
    const message = {
      type: "message",
      id: "m1",
      parentId: null,
      timestamp: new Date().toISOString(),
      message: { role: "user", content: "Parent prompt" },
    };
    const assistantMessage = {
      type: "message",
      id: "m2",
      parentId: "m1",
      timestamp: new Date().toISOString(),
      message: { role: "assistant", content: "Parent reply" },
    };
    await fs.writeFile(
      parentSessionFile,
      `${JSON.stringify(header)}\n${JSON.stringify(message)}\n${JSON.stringify(assistantMessage)}\n`,
      "utf-8",
    );

    const storePath = path.join(root, "sessions.json");
    const parentSessionKey = "agent:main:slack:channel:c1";
    const threadSessionKey = "agent:main:slack:channel:c1:thread:123";
    await writeSessionStoreFast(storePath, {
      [parentSessionKey]: {
        sessionId: parentSessionId,
        sessionFile: parentSessionFile,
        updatedAt: Date.now(),
      },
      [threadSessionKey]: {
        sessionId: "preseed-thread-session",
        updatedAt: Date.now(),
        totalTokens: 0,
        totalTokensFresh: true,
        abortedLastRun: true,
        restartRecoveryRuns: [{ runId: "old-run", lifecycleGeneration: "old-generation" }],
        mainRestartRecovery: {
          cycleId: "old-cycle",
          revision: 4,
          chargedAttempts: 3,
          tombstone: { reason: "old transcript exhausted" },
        },
      },
    });

    const cfg = {
      session: { store: storePath },
    } as OpenClawConfig;

    const first = await initSessionState({
      ctx: {
        Body: "Thread reply",
        SessionKey: threadSessionKey,
        ParentSessionKey: parentSessionKey,
      },
      cfg,
      commandAuthorized: true,
    });

    expect(first.sessionEntry.sessionId).not.toBe("preseed-thread-session");
    expect(first.sessionEntry.forkedFromParent).toBe(true);
    expect(first.sessionEntry.forkSource).toEqual({
      sessionKey: parentSessionKey,
      sessionId: parentSessionId,
    });
    expect(first.sessionEntry.totalTokens).toBeUndefined();
    expect(first.sessionEntry.totalTokensFresh).toBe(false);
    expect(first.sessionEntry.abortedLastRun).toBe(false);
    expect(first.sessionEntry.restartRecoveryRuns).toBeUndefined();
    expect((first.sessionEntry as SessionEntry).mainRestartRecovery).toBeUndefined();

    const second = await initSessionState({
      ctx: {
        Body: "Thread reply 2",
        SessionKey: threadSessionKey,
        ParentSessionKey: parentSessionKey,
      },
      cfg,
      commandAuthorized: true,
    });

    expect(second.sessionEntry.sessionId).toBe(first.sessionEntry.sessionId);
    expect(second.sessionEntry.forkedFromParent).toBe(true);
    expect(second.sessionEntry.totalTokens).toBeUndefined();
    expect(second.sessionEntry.totalTokensFresh).toBe(false);
    expect(second.sessionEntry.restartRecoveryRuns).toBeUndefined();
    expect((second.sessionEntry as SessionEntry).mainRestartRecovery).toBeUndefined();
    warn.mockRestore();
  });

  it("skips fork and creates fresh session when parent tokens exceed threshold", async () => {
    const root = await makeCaseDir("openclaw-thread-session-overflow-");
    const sessionsDir = path.join(root, "sessions");
    await fs.mkdir(sessionsDir);

    const parentSessionId = "parent-overflow";
    const parentSessionFile = path.join(sessionsDir, "parent.jsonl");
    const header = {
      type: "session",
      version: 3,
      id: parentSessionId,
      timestamp: new Date().toISOString(),
      cwd: process.cwd(),
    };
    const message = {
      type: "message",
      id: "m1",
      parentId: null,
      timestamp: new Date().toISOString(),
      message: { role: "user", content: "Parent prompt" },
    };
    const assistantMessage = {
      type: "message",
      id: "m2",
      parentId: "m1",
      timestamp: new Date().toISOString(),
      message: { role: "assistant", content: "Parent reply" },
    };
    await fs.writeFile(
      parentSessionFile,
      `${JSON.stringify(header)}\n${JSON.stringify(message)}\n${JSON.stringify(assistantMessage)}\n`,
      "utf-8",
    );

    const storePath = path.join(root, "sessions.json");
    const parentSessionKey = "agent:main:slack:channel:c1";
    // Set totalTokens well above PARENT_FORK_MAX_TOKENS (100_000)
    await writeSessionStoreFast(storePath, {
      [parentSessionKey]: {
        sessionId: parentSessionId,
        sessionFile: parentSessionFile,
        updatedAt: Date.now(),
        totalTokens: 170_000,
      },
    });

    const cfg = {
      session: { store: storePath },
    } as OpenClawConfig;

    const threadSessionKey = "agent:main:slack:channel:c1:thread:456";
    const result = await initSessionState({
      ctx: {
        Body: "Thread reply",
        SessionKey: threadSessionKey,
        ParentSessionKey: parentSessionKey,
      },
      cfg,
      commandAuthorized: true,
    });

    // Should be marked as forked (to prevent re-attempts) but NOT actually forked from parent
    expect(result.sessionEntry.forkedFromParent).toBe(true);
    expect(result.sessionEntry.forkSource).toBeUndefined();
    // Session ID should NOT match the parent — it should be a fresh UUID
    expect(result.sessionEntry.sessionId).not.toBe(parentSessionId);
    // Session file should NOT be the parent's file (it was not forked)
    expect(result.sessionEntry.sessionFile).not.toBe(parentSessionFile);
    expect(result.sessionEntry.totalTokens).toBe(0);
    expect(result.sessionEntry.totalTokensFresh).toBe(true);
  });

  it("skips fork when resolved parent token estimate exceeds threshold", async () => {
    const root = await makeCaseDir("openclaw-thread-session-overflow-estimated-");
    const sessionsDir = path.join(root, "sessions");
    await fs.mkdir(sessionsDir);

    const parentSessionId = "parent-overflow-estimated";
    const parentSessionFile = path.join(sessionsDir, "parent.jsonl");
    await fs.writeFile(
      parentSessionFile,
      `${JSON.stringify({
        type: "session",
        version: 3,
        id: parentSessionId,
        timestamp: new Date().toISOString(),
        cwd: process.cwd(),
      })}\n`,
      "utf-8",
    );

    const storePath = path.join(root, "sessions.json");
    const parentSessionKey = "agent:main:slack:channel:c1";
    await writeSessionStoreFast(storePath, {
      [parentSessionKey]: {
        sessionId: parentSessionId,
        sessionFile: parentSessionFile,
        updatedAt: Date.now(),
        totalTokens: 1,
        totalTokensFresh: false,
      },
    });
    sessionForkMocks.resolveParentForkTokenCount.mockReturnValueOnce(170_000);

    const cfg = {
      session: { store: storePath },
    } as OpenClawConfig;

    const threadSessionKey = "agent:main:slack:channel:c1:thread:estimated";
    const result = await initSessionState({
      ctx: {
        Body: "Thread reply",
        SessionKey: threadSessionKey,
        ParentSessionKey: parentSessionKey,
      },
      cfg,
      commandAuthorized: true,
    });

    const tokenCountCall = requireMockCallArg(
      sessionForkMocks.resolveParentForkTokenCount,
      "resolveParentForkTokenCount",
    );
    const parentEntry = tokenCountCall.parentEntry as SessionEntry | undefined;
    expect(parentEntry?.sessionId).toBe(parentSessionId);
    expect(parentEntry?.totalTokensFresh).toBe(false);
    expect(tokenCountCall.storePath).toBe(storePath);
    expect(result.sessionEntry.forkedFromParent).toBe(true);
    expect(result.sessionEntry.sessionId).not.toBe(parentSessionId);
    expect(result.sessionEntry.sessionFile).not.toBe(parentSessionFile);
    expect(sessionForkMocks.forkSessionFromParent).not.toHaveBeenCalled();
  });

  it("records topic-specific SQLite session identity when MessageThreadId is present", async () => {
    const root = await makeCaseDir("openclaw-topic-session-");
    const storePath = path.join(root, "sessions.json");

    const cfg = {
      session: { store: storePath },
    } as OpenClawConfig;

    const result = await initSessionState({
      ctx: {
        Body: "Hello topic",
        SessionKey: "agent:main:telegram:group:123:topic:456",
        MessageThreadId: 456,
      },
      cfg,
      commandAuthorized: true,
    });

    expect(result.sessionEntry.lastThreadId).toBe(456);
    expect(result.sessionEntry.sessionFile).toBe(
      formatSqliteSessionFileMarker({
        agentId: "main",
        sessionId: result.sessionEntry.sessionId,
        storePath,
      }),
    );
  });

  it("records topic-specific SQLite session identity from SessionKey", async () => {
    const root = await makeCaseDir("openclaw-topic-session-key-");
    const storePath = path.join(root, "sessions.json");

    const cfg = {
      session: { store: storePath },
    } as OpenClawConfig;

    setActivePluginRegistry(createSessionConversationTestRegistry());
    try {
      const result = await initSessionState({
        ctx: {
          Body: "Hello topic",
          SessionKey: "agent:main:telegram:group:123:topic:456",
        },
        cfg,
        commandAuthorized: true,
      });

      expect(result.sessionKey).toBe("agent:main:telegram:group:123:topic:456");
      expect(result.sessionEntry.sessionFile).toBe(
        formatSqliteSessionFileMarker({
          agentId: "main",
          sessionId: result.sessionEntry.sessionId,
          storePath,
        }),
      );
    } finally {
      resetPluginRuntimeStateForTest();
    }
  });
});

describe("initSessionState RawBody", () => {
  it("uses RawBody for command extraction and reset triggers when Body contains wrapped context", async () => {
    const root = await makeCaseDir("openclaw-rawbody-");
    const storePath = path.join(root, "sessions.json");
    const cfg = { session: { store: storePath } } as OpenClawConfig;

    const statusResult = await initSessionState({
      ctx: {
        Body: `[Chat messages since your last reply - for context]\n[WhatsApp ...] Someone: hello\n\n[Current message - respond to this]\n[WhatsApp ...] Jake: /status\n[from: Jake McInteer (+6421807830)]`,
        RawBody: "/status",
        ChatType: "group",
        SessionKey: "agent:main:whatsapp:group:g1",
      },
      cfg,
      commandAuthorized: true,
    });
    expect(statusResult.triggerBodyNormalized).toBe("/status");

    const resetResult = await initSessionState({
      ctx: {
        Body: `[Context]\nJake: /new\n[from: Jake]`,
        RawBody: "/new",
        ChatType: "group",
        SessionKey: "agent:main:whatsapp:group:g1",
      },
      cfg,
      commandAuthorized: true,
    });
    expect(resetResult.isNewSession).toBe(true);
    expect(resetResult.bodyStripped).toBe("");
  });

  it("preserves argument casing while still matching reset triggers case-insensitively", async () => {
    const root = await makeCaseDir("openclaw-rawbody-reset-case-");
    const storePath = path.join(root, "sessions.json");

    const cfg = {
      session: {
        store: storePath,
        resetTriggers: ["/new"],
      },
    } as OpenClawConfig;

    const ctx = {
      RawBody: "/NEW KeepThisCase",
      ChatType: "direct",
      SessionKey: "agent:main:whatsapp:dm:s1",
    };

    const result = await initSessionState({
      ctx,
      cfg,
      commandAuthorized: true,
    });

    expect(result.isNewSession).toBe(true);
    expect(result.bodyStripped).toBe("KeepThisCase");
    expect(result.triggerBodyNormalized).toBe("/NEW KeepThisCase");
  });

  it("drops cached skills snapshot when /new rotates an existing session", async () => {
    const root = await makeCaseDir("openclaw-rawbody-reset-skills-");
    const storePath = path.join(root, "sessions.json");
    const sessionKey = "agent:main:signal:direct:uuid:reset-skills";
    const existingSessionId = "session-with-stale-skills";

    await writeSessionStoreFast(storePath, {
      [sessionKey]: {
        sessionId: existingSessionId,
        updatedAt: Date.now(),
        systemSent: true,
        totalTokens: 64_000,
        totalTokensFresh: false,
        contextTokens: 128_000,
        contextBudgetStatus: {
          schemaVersion: 1,
          source: "pre-prompt-estimate",
          updatedAt: Date.now(),
          provider: "anthropic",
          model: "claude-sonnet-4.6",
          route: "fits",
          shouldCompact: false,
          estimatedPromptTokens: 64_000,
          contextTokenBudget: 128_000,
          promptBudgetBeforeReserve: 112_000,
          reserveTokens: 16_000,
          effectiveReserveTokens: 16_000,
          remainingPromptBudgetTokens: 48_000,
          overflowTokens: 0,
          toolResultReducibleChars: 0,
          messageCount: 8,
          unwindowedMessageCount: 8,
        },
        compactionCount: 3,
        memoryFlushAt: 123,
        memoryFlushCompactionCount: 2,
        memoryFlushContextHash: "stale-context",
        memoryFlushFailureCount: 3,
        memoryFlushLastFailedAt: 456,
        memoryFlushLastFailureError: "provider crashed",
        skillsSnapshot: {
          prompt: "<available_skills><skill><name>stale</name></skill></available_skills>",
          skills: [{ name: "stale" }],
          version: 0,
        },
      },
    });

    const cfg = {
      session: {
        store: storePath,
        resetTriggers: ["/new"],
      },
    } as OpenClawConfig;

    const result = await initSessionState({
      ctx: {
        RawBody: "/new continue",
        ChatType: "direct",
        SessionKey: sessionKey,
      },
      cfg,
      commandAuthorized: true,
    });

    expect(result.isNewSession).toBe(true);
    expect(result.resetTriggered).toBe(true);
    expect(result.sessionId).toBe(existingSessionId);
    expect(result.sessionEntry.skillsSnapshot).toBeUndefined();
    expect(result.sessionEntry.totalTokens).toBe(0);
    expect(result.sessionEntry.totalTokensFresh).toBe(true);
    expect(result.sessionEntry.contextTokens).toBeUndefined();
    expect(result.sessionEntry.contextBudgetStatus).toBeUndefined();
    expect(result.sessionEntry.compactionCount).toBe(0);
    expect(result.sessionEntry.memoryFlushAt).toBeUndefined();
    expect(result.sessionEntry.memoryFlushCompactionCount).toBeUndefined();
    expect(result.sessionEntry.memoryFlushContextHash).toBeUndefined();
    expect(result.sessionEntry.memoryFlushFailureCount).toBeUndefined();
    expect(result.sessionEntry.memoryFlushLastFailedAt).toBeUndefined();
    expect(result.sessionEntry.memoryFlushLastFailureError).toBeUndefined();

    const store = readSessionStoreFast(storePath) as Record<
      string,
      {
        skillsSnapshot?: unknown;
        totalTokens?: number;
        totalTokensFresh?: boolean;
        contextTokens?: number;
        contextBudgetStatus?: unknown;
        compactionCount?: number;
        memoryFlushAt?: number;
        memoryFlushCompactionCount?: number;
        memoryFlushContextHash?: string;
        memoryFlushFailureCount?: number;
        memoryFlushLastFailedAt?: number;
        memoryFlushLastFailureError?: string;
      }
    >;
    expect(store[sessionKey]?.skillsSnapshot).toBeUndefined();
    expect(store[sessionKey]?.totalTokens).toBe(0);
    expect(store[sessionKey]?.totalTokensFresh).toBe(true);
    expect(store[sessionKey]?.contextTokens).toBeUndefined();
    expect(store[sessionKey]?.contextBudgetStatus).toBeUndefined();
    expect(store[sessionKey]?.compactionCount).toBe(0);
    expect(store[sessionKey]?.memoryFlushAt).toBeUndefined();
    expect(store[sessionKey]?.memoryFlushCompactionCount).toBeUndefined();
    expect(store[sessionKey]?.memoryFlushContextHash).toBeUndefined();
    expect(store[sessionKey]?.memoryFlushFailureCount).toBeUndefined();
    expect(store[sessionKey]?.memoryFlushLastFailedAt).toBeUndefined();
    expect(store[sessionKey]?.memoryFlushLastFailureError).toBeUndefined();
  });

  it("drains stale system events when /new rotates an existing session", async () => {
    const root = await makeCaseDir("openclaw-rawbody-reset-system-events-");
    const storePath = path.join(root, "sessions.json");
    const sessionKey = "agent:main:whatsapp:dm:system-events";
    const existingSessionId = "session-with-stale-events";

    await writeSessionStoreFast(storePath, {
      [sessionKey]: {
        sessionId: existingSessionId,
        updatedAt: Date.now(),
        systemSent: true,
      },
    });
    enqueueSystemEvent("stale session-key event", { sessionKey });
    enqueueSystemEvent("stale session-id event", { sessionKey: existingSessionId });

    const cfg = {
      session: {
        store: storePath,
        resetTriggers: ["/new"],
      },
    } as OpenClawConfig;

    const result = await initSessionState({
      ctx: {
        RawBody: "/new continue",
        ChatType: "direct",
        SessionKey: sessionKey,
      },
      cfg,
      commandAuthorized: true,
    });

    expect(result.isNewSession).toBe(true);
    expect(result.resetTriggered).toBe(true);
    expect(result.sessionId).toBe(existingSessionId);
    await expect(
      drainFormattedSystemEvents({
        cfg,
        sessionKey,
        isMainSession: false,
        isNewSession: true,
      }),
    ).resolves.toBeUndefined();
    expect(peekSystemEvents(existingSessionId)).toStrictEqual([]);
  });

  it("preserves a user model override across an implicit daily stale rollover (#90119)", async () => {
    // Regression: a user-set /model override persisted on a session that then
    // goes stale at the daily reset boundary must survive the implicit
    // rollover. Previously the carryover was gated on resetTriggered, so the
    // next non-/new turn dropped the override and reverted to the default
    // model despite the "Model set to ... for this session" ack.
    const root = await makeCaseDir("openclaw-daily-rollover-model-");
    const storePath = path.join(root, "sessions.json");
    const sessionKey = "agent:main:discord:channel:daily-rollover";
    const existingSessionId = "session-before-daily-reset";
    // Stale under the configured daily reset (atHour 4): started ~48h ago so
    // sessionStartedAt < today's reset boundary.
    const staleStartedAt = Date.now() - 48 * 60 * 60 * 1000;

    await writeSessionStoreFast(storePath, {
      [sessionKey]: {
        sessionId: existingSessionId,
        updatedAt: staleStartedAt,
        sessionStartedAt: staleStartedAt,
        lastInteractionAt: staleStartedAt,
        systemSent: true,
        // User-driven override (the thing /model writes).
        providerOverride: "minimax",
        modelOverride: "m2.7",
        modelOverrideSource: "user",
      },
    });

    const cfg = {
      session: { store: storePath, reset: { mode: "daily", atHour: 4 } },
    } as OpenClawConfig;

    const result = await initSessionState({
      ctx: {
        // Ordinary message — NOT a reset trigger.
        RawBody: "hello again",
        ChatType: "channel",
        SessionKey: sessionKey,
      },
      cfg,
      commandAuthorized: true,
    });

    // The session rolled over implicitly (stale), not via /new.
    expect(result.isNewSession).toBe(true);
    expect(result.resetTriggered).toBe(false);
    expect(result.sessionId).toBe(existingSessionId);
    // The user override must survive.
    expect(result.sessionEntry.providerOverride).toBe("minimax");
    expect(result.sessionEntry.modelOverride).toBe("m2.7");
    expect(result.sessionEntry.modelOverrideSource).toBe("user");

    const store = readSessionStoreFast(storePath) as Record<
      string,
      { providerOverride?: string; modelOverride?: string; modelOverrideSource?: string }
    >;
    expect(store[sessionKey]?.modelOverride).toBe("m2.7");
    expect(store[sessionKey]?.modelOverrideSource).toBe("user");
  });

  it("stamps trusted creation provenance when initializing a missing session", async () => {
    const root = await makeCaseDir("openclaw-session-creation-provenance-");
    const storePath = path.join(root, "sessions.json");
    const sessionKey = "agent:main:dashboard:created";

    const result = await withEnvAsync(
      { OPENCLAW_STATE_DIR: path.join(root, "state") },
      async () => {
        const initialized = await initSessionState({
          ctx: {
            RawBody: "hello",
            ChatType: "direct",
            SessionKey: sessionKey,
            SessionCreation: {
              via: "operator",
              actor: { type: "human", id: "profile-ada" },
            },
          },
          cfg: { session: { store: storePath } } as OpenClawConfig,
          commandAuthorized: true,
        });
        expect(listSessionStateEventsSince(sessionKey, "main", 0, 20).events).toContainEqual(
          expect.objectContaining({
            kind: "created",
            actorType: "human",
            actorId: "profile-ada",
          }),
        );
        return initialized;
      },
    );
    expect(result.sessionEntry).toMatchObject({
      createdVia: "operator",
      createdActor: { type: "human", id: "profile-ada" },
      createdAt: expect.any(Number),
    });
  });

  it("preserves session lineage across an implicit daily stale rollover (#90119)", async () => {
    const root = await makeCaseDir("openclaw-daily-rollover-lineage-");
    const storePath = path.join(root, "sessions.json");
    const sessionKey = "agent:main:subagent:daily-rollover-lineage";
    const existingSessionId = "session-before-daily-reset-lineage";
    const staleStartedAt = Date.now() - 48 * 60 * 60 * 1000;
    const lineage = {
      spawnedBy: "agent:main:main",
      spawnedWorkspaceDir: "/tmp/child-workspace",
      spawnedCwd: "/tmp/task-repo",
      parentSessionKey: "agent:main:main",
      forkedFromParent: true,
      forkSource: {
        sessionKey: "agent:main:root",
        sessionId: "root-transcript-generation",
      },
      createdVia: "spawn",
      createdActor: { type: "agent", id: "agent:main:main" },
      createdAt: staleStartedAt - 1_000,
      spawnDepth: 1,
      subagentRole: "leaf",
      subagentControlScope: "none",
    } as const;

    await writeSessionStoreFast(storePath, {
      [sessionKey]: {
        sessionId: existingSessionId,
        updatedAt: staleStartedAt,
        sessionStartedAt: staleStartedAt,
        lastInteractionAt: staleStartedAt,
        ...lineage,
      },
    });

    const result = await initSessionState({
      ctx: {
        RawBody: "continue child work",
        ChatType: "direct",
        SessionKey: sessionKey,
      },
      cfg: {
        session: { store: storePath, reset: { mode: "daily", atHour: 4 } },
      } as OpenClawConfig,
      commandAuthorized: true,
    });

    expect(result.isNewSession).toBe(true);
    expect(result.resetTriggered).toBe(false);
    expect(result.sessionId).toBe(existingSessionId);
    expect(result.sessionEntry.previousSessionId).toBeUndefined();
    expectEntryFields(result.sessionEntry, lineage);
  });

  it.each([
    {
      name: "preserves user-set behavior and pinned state across an implicit daily stale rollover (#92562)",
      slug: "behavior",
      entry: {
        systemSent: true,
        thinkingLevel: "medium",
        verboseLevel: "on",
        traceLevel: "high",
        reasoningLevel: "low",
        ttsAuto: "always",
        pinnedAt: 123,
      },
      expected: {
        thinkingLevel: "medium",
        verboseLevel: "on",
        traceLevel: "high",
        reasoningLevel: "low",
        ttsAuto: "always",
        pinnedAt: 123,
      },
      persisted: true,
    },
    {
      name: "preserves usage footer mode across daily rollover",
      slug: "usage",
      entry: { responseUsage: "full" as const },
      expected: { responseUsage: "full" },
    },
    {
      name: "preserves user labels across dashboard session stale rollover (#101451)",
      slug: "label",
      sessionKey: "agent:main:dashboard:8c0b2b68-05e1-4b25-a8c2-ef6f43a01f77",
      chatType: "direct",
      entry: { label: "Other", displayName: "Dashboard Chat" },
      expected: { label: "Other", displayName: "Dashboard Chat" },
      persisted: true,
    },
    {
      name: "clears an auto-fallback model override on an implicit daily stale rollover (#90119)",
      slug: "fallback",
      entry: {
        systemSent: true,
        providerOverride: "minimax",
        modelOverride: "m2.7",
        modelOverrideFallbackOriginProvider: "openai",
        modelOverrideFallbackOriginModel: "gpt-4o-mini",
      },
      expected: {},
      absent: ["modelOverride", "providerOverride", "modelOverrideSource"],
    },
    {
      name: "preserves behavior overrides while clearing an auto-fallback model override on one implicit daily rollover (#92562)",
      slug: "mixed",
      entry: {
        systemSent: true,
        thinkingLevel: "medium",
        providerOverride: "minimax",
        modelOverride: "m2.7",
        modelOverrideFallbackOriginProvider: "openai",
        modelOverrideFallbackOriginModel: "gpt-4o-mini",
      },
      expected: { thinkingLevel: "medium" },
      absent: ["modelOverride", "providerOverride"],
    },
  ])("$name", async (scenario) => {
    const storePath = await createStorePath(`openclaw-daily-rollover-${scenario.slug}-`);
    const sessionKey =
      "sessionKey" in scenario && typeof scenario.sessionKey === "string"
        ? scenario.sessionKey
        : `agent:main:discord:channel:daily-rollover-${scenario.slug}`;
    const existingSessionId = `session-before-daily-reset-${scenario.slug}`;
    const staleStartedAt = Date.now() - 48 * 60 * 60 * 1000;
    await writeSessionStoreFast(storePath, {
      [sessionKey]: {
        sessionId: existingSessionId,
        updatedAt: staleStartedAt,
        sessionStartedAt: staleStartedAt,
        lastInteractionAt: staleStartedAt,
        ...scenario.entry,
      },
    });

    const result = await initSessionState({
      ctx: {
        RawBody: "hello again",
        ChatType: "chatType" in scenario ? scenario.chatType : "channel",
        SessionKey: sessionKey,
      },
      cfg: {
        session: { store: storePath, reset: { mode: "daily", atHour: 4 } },
      } as OpenClawConfig,
      commandAuthorized: true,
    });

    expect(result.isNewSession).toBe(true);
    expect(result.resetTriggered).toBe(false);
    expect(result.sessionId).toBe(existingSessionId);
    expectEntryFields(result.sessionEntry, scenario.expected, scenario.name);
    if ("absent" in scenario && Array.isArray(scenario.absent)) {
      for (const field of scenario.absent) {
        expect(
          (result.sessionEntry as Record<string, unknown>)[field],
          scenario.name,
        ).toBeUndefined();
      }
    }
    if ("persisted" in scenario && scenario.persisted) {
      expectEntryFields(
        expectDefined(readSessionStoreFast(storePath)[sessionKey], "stored session"),
        scenario.expected,
        scenario.name,
      );
    }
  });
  it.each([
    {
      name: "rotates local session state for /new on bound ACP sessions",
      body: "/new",
      to: "1478836151241412759",
      includeBinding: true,
    },
    {
      name: "rotates local session state for ACP /new when no matching conversation binding exists",
      body: "/new",
      to: "user:12345",
      originatingTo: "user:12345",
      includeBinding: false,
    },
    {
      name: "keeps custom reset triggers working on bound ACP sessions",
      body: "/fresh",
      to: "1478836151241412759",
      includeBinding: true,
      resetTriggers: ["/fresh"],
    },
    {
      name: "keeps normal /new behavior for unbound ACP-shaped session keys",
      body: "/new",
      to: "1478836151241412759",
      includeBinding: false,
    },
  ])("$name", async (scenario) => {
    const storePath = await createStorePath("openclaw-rawbody-acp-reset-");
    const sessionKey = "agent:codex:acp:binding:discord:default:feedface";
    const existingSessionId = "session-existing";
    await writeSessionStoreFast(storePath, {
      [sessionKey]: { sessionId: existingSessionId, updatedAt: Date.now(), systemSent: true },
    });
    const bindings = scenario.includeBinding
      ? [
          {
            type: "acp" as const,
            agentId: "codex",
            match: {
              channel: "discord",
              accountId: "default",
              peer: { kind: "channel" as const, id: "1478836151241412759" },
            },
            acp: { mode: "persistent" as const },
          },
        ]
      : undefined;
    const result = await initSessionState({
      ctx: {
        RawBody: scenario.body,
        CommandBody: scenario.body,
        Provider: "discord",
        Surface: "discord",
        SenderId: "12345",
        From: "discord:12345",
        To: scenario.to,
        OriginatingTo: "originatingTo" in scenario ? scenario.originatingTo : undefined,
        SessionKey: sessionKey,
      },
      cfg: {
        session: {
          store: storePath,
          ...("resetTriggers" in scenario ? { resetTriggers: scenario.resetTriggers } : {}),
        },
        ...(bindings ? { bindings } : {}),
        channels: { discord: { allowFrom: ["*"] } },
      } as OpenClawConfig,
      commandAuthorized: true,
    });

    expect(result.resetTriggered).toBe(true);
    expect(result.isNewSession).toBe(true);
    expect(result.sessionId).not.toBe(existingSessionId);
  });
  it("does not suppress /new when active conversation binding points to a non-ACP session", async () => {
    const root = await makeCaseDir("openclaw-rawbody-acp-nonacp-binding-");
    const storePath = path.join(root, "sessions.json");
    const sessionKey = "agent:codex:acp:binding:discord:default:feedface";
    const existingSessionId = "session-existing";
    const now = Date.now();
    const channelId = "1478836151241412759";
    const nonAcpFocusSessionKey = "agent:main:discord:channel:focus-target";

    await writeSessionStoreFast(storePath, {
      [sessionKey]: {
        sessionId: existingSessionId,
        updatedAt: now,
        systemSent: true,
      },
    });

    const cfg = {
      session: { store: storePath },
      bindings: [
        {
          type: "acp",
          agentId: "codex",
          match: {
            channel: "discord",
            accountId: "default",
            peer: { kind: "channel", id: channelId },
          },
          acp: { mode: "persistent" },
        },
      ],
      channels: {
        discord: {
          allowFrom: ["*"],
        },
      },
    } as OpenClawConfig;

    sessionBindingTesting.resetSessionBindingAdaptersForTests();
    registerSessionBindingAdapter({
      channel: "discord",
      accountId: "default",
      capabilities: { bindSupported: false, unbindSupported: false, placements: ["current"] },
      listBySession: () => [],
      resolveByConversation: (ref) => {
        if (ref.conversationId !== channelId) {
          return null;
        }
        return {
          bindingId: "focus-binding",
          targetSessionKey: nonAcpFocusSessionKey,
          targetKind: "session",
          conversation: {
            channel: "discord",
            accountId: "default",
            conversationId: channelId,
          },
          status: "active",
          boundAt: now,
        };
      },
    });
    try {
      const result = await initSessionState({
        ctx: {
          RawBody: "/new",
          CommandBody: "/new",
          Provider: "discord",
          Surface: "discord",
          SenderId: "12345",
          From: "discord:12345",
          To: channelId,
          SessionKey: sessionKey,
        },
        cfg,
        commandAuthorized: true,
      });

      expect(result.resetTriggered).toBe(true);
      expect(result.isNewSession).toBe(true);
      expect(result.sessionId).not.toBe(existingSessionId);
    } finally {
      sessionBindingTesting.resetSessionBindingAdaptersForTests();
    }
  });

  it("does not suppress /new when active target session key is non-ACP even with configured ACP binding", async () => {
    const root = await makeCaseDir("openclaw-rawbody-acp-configured-fallback-target-");
    const storePath = path.join(root, "sessions.json");
    const channelId = "1478836151241412759";
    const fallbackSessionKey = "agent:main:discord:channel:focus-target";
    const existingSessionId = "session-existing";
    const now = Date.now();

    await writeSessionStoreFast(storePath, {
      [fallbackSessionKey]: {
        sessionId: existingSessionId,
        updatedAt: now,
        systemSent: true,
      },
    });

    const cfg = {
      session: { store: storePath },
      bindings: [
        {
          type: "acp",
          agentId: "codex",
          match: {
            channel: "discord",
            accountId: "default",
            peer: { kind: "channel", id: channelId },
          },
          acp: { mode: "persistent" },
        },
      ],
      channels: {
        discord: {
          allowFrom: ["*"],
        },
      },
    } as OpenClawConfig;

    const result = await initSessionState({
      ctx: {
        RawBody: "/new",
        CommandBody: "/new",
        Provider: "discord",
        Surface: "discord",
        SenderId: "12345",
        From: "discord:12345",
        To: channelId,
        SessionKey: fallbackSessionKey,
      },
      cfg,
      commandAuthorized: true,
    });

    expect(result.resetTriggered).toBe(true);
    expect(result.isNewSession).toBe(true);
    expect(result.sessionId).toBe(existingSessionId);
  });

  it("prefers native command target sessions over bound slash sessions", async () => {
    const storePath = await createStorePath("native-command-target-session-");
    const boundSlashSessionKey = "slack:slash:123";
    const targetSessionKey = "agent:main:main";
    const cfg = {
      session: { store: storePath },
    } as OpenClawConfig;

    setMinimalCurrentConversationBindingRegistryForTests();
    registerCurrentConversationBindingAdapterForTest({
      channel: "slack",
      accountId: "default",
    });
    await getSessionBindingService().bind({
      targetSessionKey: boundSlashSessionKey,
      targetKind: "session",
      conversation: {
        channel: "slack",
        accountId: "default",
        conversationId: "channel:ops",
      },
      placement: "current",
    });

    const result = await initSessionState({
      ctx: {
        Body: `/model openai/gpt-5.4@${TEST_NATIVE_MODEL_PROFILE_ID}`,
        CommandBody: `/model openai/gpt-5.4@${TEST_NATIVE_MODEL_PROFILE_ID}`,
        Provider: "slack",
        Surface: "slack",
        AccountId: "default",
        SenderId: "U123",
        From: "slack:U123",
        To: "channel:ops",
        OriginatingTo: "channel:ops",
        SessionKey: boundSlashSessionKey,
        CommandSource: "native",
        CommandTargetSessionKey: targetSessionKey,
      },
      cfg,
      commandAuthorized: true,
    });

    expect(result.sessionKey).toBe(targetSessionKey);
    expect(result.sessionCtx.SessionKey).toBe(targetSessionKey);
  });

  it("uses the default per-agent sessions store when config store is unset", async () => {
    const root = await makeCaseDir("openclaw-session-store-default-");
    const stateDir = path.join(root, ".openclaw");
    const agentId = "worker1";
    const sessionKey = `agent:${agentId}:telegram:12345`;
    const sessionId = "sess-worker-1";
    const sessionFile = path.join(stateDir, "agents", agentId, "sessions", `${sessionId}.jsonl`);
    const storePath = path.join(stateDir, "agents", agentId, "sessions", "sessions.json");

    await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
      await fs.mkdir(path.dirname(storePath), { recursive: true });
      await writeSessionStoreFast(storePath, {
        [sessionKey]: {
          sessionId,
          sessionFile,
          updatedAt: Date.now(),
        },
      });

      const cfg = {} as OpenClawConfig;
      const result = await initSessionState({
        ctx: {
          Body: "hello",
          ChatType: "direct",
          Provider: "telegram",
          Surface: "telegram",
          SessionKey: sessionKey,
        },
        cfg,
        commandAuthorized: true,
      });

      expect(result.sessionEntry.sessionId).toBe(sessionId);
      expect(result.sessionEntry.sessionFile).toBe(
        formatSqliteSessionFileMarker({
          agentId: "worker1",
          sessionId,
          storePath,
        }),
      );
      expect(result.storePath).toBe(storePath);
    });
  });

  it.each([
    {
      name: "Slack DM",
      conversation: {
        channel: "slack",
        accountId: "default",
        conversationId: "user:U123",
      },
      ctx: {
        Provider: "slack",
        Surface: "slack",
        From: "slack:user:U123",
        To: "user:U123",
        OriginatingTo: "user:U123",
        SenderId: "U123",
        ChatType: "direct",
      },
    },
    {
      name: "Signal DM",
      conversation: {
        channel: "signal",
        accountId: "default",
        conversationId: "+15550001111",
      },
      ctx: {
        Provider: "signal",
        Surface: "signal",
        From: "signal:+15550001111",
        To: "+15550001111",
        OriginatingTo: "signal:+15550001111",
        SenderId: "+15550001111",
        ChatType: "direct",
      },
    },
    {
      name: "Google Chat room",
      conversation: {
        channel: "googlechat",
        accountId: "default",
        conversationId: "spaces/AAAAAAA",
      },
      ctx: {
        Provider: "googlechat",
        Surface: "googlechat",
        From: "googlechat:users/123",
        To: "spaces/AAAAAAA",
        OriginatingTo: "googlechat:spaces/AAAAAAA",
        SenderId: "users/123",
        ChatType: "group",
      },
    },
  ])("routes generic current-conversation bindings for $name", async ({ conversation, ctx }) => {
    setMinimalCurrentConversationBindingRegistryForTests();
    registerCurrentConversationBindingAdapterForTest({
      channel: conversation.channel as "slack" | "signal" | "googlechat",
      accountId: "default",
    });
    const storePath = await createStorePath("openclaw-generic-current-binding-");
    const boundSessionKey = `agent:codex:acp:binding:${conversation.channel}:default:test`;

    await getSessionBindingService().bind({
      targetSessionKey: boundSessionKey,
      targetKind: "session",
      conversation,
    });

    const result = await initSessionState({
      ctx: {
        RawBody: "hello",
        SessionKey: `agent:main:${conversation.channel}:seed`,
        ...ctx,
      },
      cfg: {
        session: { store: storePath },
      } as OpenClawConfig,
      commandAuthorized: true,
    });

    expect(result.sessionKey).toBe(boundSessionKey);
  });

  it("does not apply a source admission id to a bound conversation target", async () => {
    setMinimalCurrentConversationBindingRegistryForTests();
    registerCurrentConversationBindingAdapterForTest({
      channel: "slack",
      accountId: "default",
    });
    const storePath = await createStorePath("openclaw-bound-admission-id-");
    const sourceSessionKey = "agent:main:slack:source";
    const sourceSessionId = "source-admission-session";
    const boundSessionKey = "plugin-binding:codex:bound-target";
    const boundSessionId = "bound-target-session";
    await writeSessionStoreFast(storePath, {
      [sourceSessionKey]: { sessionId: sourceSessionId, updatedAt: Date.now() },
      [boundSessionKey]: { sessionId: boundSessionId, updatedAt: Date.now() },
    });
    await getSessionBindingService().bind({
      targetSessionKey: boundSessionKey,
      targetKind: "session",
      conversation: {
        channel: "slack",
        accountId: "default",
        conversationId: "user:U123",
      },
    });

    const result = await initSessionState({
      ctx: {
        RawBody: "hello",
        SessionKey: sourceSessionKey,
        Provider: "slack",
        Surface: "slack",
        From: "slack:user:U123",
        To: "user:U123",
        OriginatingTo: "user:U123",
        SenderId: "U123",
        ChatType: "direct",
      },
      cfg: { session: { store: storePath } } as OpenClawConfig,
      commandAuthorized: true,
      expectedExistingSessionId: sourceSessionId,
      pinExpectedExistingSession: true,
    });

    expect(result.sessionKey).toBe(boundSessionKey);
    expect(result.sessionId).toBe(boundSessionId);
    expect(result.isNewSession).toBe(false);
  });
});

describe("initSessionState reset policy", () => {
  let clearBootstrapSnapshotOnSessionRolloverSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    clearBootstrapSnapshotOnSessionRolloverSpy = vi.spyOn(
      bootstrapCache,
      "clearBootstrapSnapshotOnSessionBoundary",
    );
  });

  afterEach(() => {
    clearBootstrapSnapshotOnSessionRolloverSpy.mockRestore();
    vi.useRealTimers();
  });

  it.each([
    {
      name: "keeps the current session across the former daily boundary by default",
      now: new Date(2026, 0, 18, 5, 0, 0),
      slug: "daily",
      updatedAt: new Date(2026, 0, 18, 3, 0, 0).getTime(),
      session: {},
      expectedNew: false,
      expectBootstrapBoundary: false,
    },
    {
      name: "treats sessions as stale before the daily reset when updated before yesterday's boundary",
      now: new Date(2026, 0, 18, 3, 0, 0),
      slug: "daily-edge",
      updatedAt: new Date(2026, 0, 17, 3, 30, 0).getTime(),
      session: { reset: { mode: "daily" as const, atHour: 4 } },
      expectedNew: true,
    },
    {
      name: "expires sessions when idle timeout wins over daily reset",
      now: new Date(2026, 0, 18, 5, 30, 0),
      slug: "idle",
      updatedAt: new Date(2026, 0, 18, 4, 45, 0).getTime(),
      session: { reset: { mode: "daily" as const, atHour: 4, idleMinutes: 30 } },
      expectedNew: true,
    },
    {
      name: "preserves idle rollover when an ordinary send asserts the current session id",
      now: new Date(2026, 0, 18, 5, 30, 0),
      slug: "idle-requested-session-ordinary",
      updatedAt: new Date(2026, 0, 18, 4, 45, 0).getTime(),
      session: { reset: { mode: "daily" as const, atHour: 4, idleMinutes: 30 } },
      requestedSessionId: "existing",
      expectedNew: true,
    },
    {
      name: "pins a durably admitted session across an idle reset boundary",
      now: new Date(2026, 0, 18, 5, 30, 0),
      slug: "idle-pinned-admission",
      updatedAt: new Date(2026, 0, 18, 4, 45, 0).getTime(),
      session: { reset: { mode: "daily" as const, atHour: 4, idleMinutes: 30 } },
      expectedExistingSessionId: "existing",
      pinExpectedExistingSession: true,
      expectedNew: false,
    },
    {
      name: "reuses an idle-expired session when a reconnecting client requests current session resume",
      now: new Date(2026, 0, 18, 5, 30, 0),
      slug: "idle-requested-session",
      updatedAt: new Date(2026, 0, 18, 4, 45, 0).getTime(),
      session: { reset: { mode: "daily" as const, atHour: 4, idleMinutes: 30 } },
      requestedSessionId: "existing",
      resumeRequestedSession: true,
      expectedNew: false,
    },
    {
      name: "does not reuse an idle-expired session for a stale asserted session id",
      now: new Date(2026, 0, 18, 5, 30, 0),
      slug: "idle-stale-requested-session",
      updatedAt: new Date(2026, 0, 18, 4, 45, 0).getTime(),
      session: { reset: { mode: "daily" as const, atHour: 4, idleMinutes: 30 } },
      requestedSessionId: "stale",
      resumeRequestedSession: true,
      expectedNew: true,
    },
  ])("$name", async (scenario) => {
    vi.setSystemTime(scenario.now);
    const storePath = await createStorePath(`openclaw-reset-${scenario.slug}-`);
    const sessionKey = scenario.slug.startsWith("idle-")
      ? "agent:main:main"
      : `agent:main:whatsapp:dm:${scenario.slug}`;
    const existingSessionId = `${scenario.slug}-session-id`;
    await writeSessionStoreFast(storePath, {
      [sessionKey]: { sessionId: existingSessionId, updatedAt: scenario.updatedAt },
    });

    const result = await initSessionState({
      ctx: { Body: "hello", SessionKey: sessionKey, Provider: "internal", Surface: "internal" },
      cfg: { session: { store: storePath, ...scenario.session } } as OpenClawConfig,
      commandAuthorized: true,
      requestedSessionId:
        "requestedSessionId" in scenario && scenario.requestedSessionId === "existing"
          ? existingSessionId
          : "requestedSessionId" in scenario && scenario.requestedSessionId === "stale"
            ? "webchat-stale-session-id"
            : undefined,
      resumeRequestedSession:
        "resumeRequestedSession" in scenario ? scenario.resumeRequestedSession : undefined,
      expectedExistingSessionId:
        "expectedExistingSessionId" in scenario ? existingSessionId : undefined,
      pinExpectedExistingSession:
        "pinExpectedExistingSession" in scenario ? scenario.pinExpectedExistingSession : undefined,
    });

    expect(result.isNewSession).toBe(scenario.expectedNew);
    expect(result.sessionId).toBe(existingSessionId);
    if ("expectBootstrapBoundary" in scenario && scenario.expectBootstrapBoundary === false) {
      expect(clearBootstrapSnapshotOnSessionRolloverSpy).toHaveBeenCalledWith({
        boundaryAppended: false,
        sessionKey,
      });
    }
  });
  it("drains stale system events when idle rollover creates a new session", async () => {
    vi.setSystemTime(new Date(2026, 0, 18, 5, 30, 0));
    const root = await makeCaseDir("openclaw-reset-idle-system-events-");
    const storePath = path.join(root, "sessions.json");
    const sessionKey = "agent:main:whatsapp:dm:idle-system-events";
    const existingSessionId = "idle-system-events-session";

    await writeSessionStoreFast(storePath, {
      [sessionKey]: {
        sessionId: existingSessionId,
        updatedAt: new Date(2026, 0, 18, 4, 45, 0).getTime(),
      },
    });
    enqueueSystemEvent("stale idle rollover event", { sessionKey });
    enqueueSystemEvent("stale idle rollover session-id event", {
      sessionKey: existingSessionId,
    });

    const cfg = {
      session: {
        store: storePath,
        reset: { mode: "idle", idleMinutes: 30 },
      },
    } as OpenClawConfig;
    const result = await initSessionState({
      ctx: { Body: "hello", SessionKey: sessionKey },
      cfg,
      commandAuthorized: true,
    });

    expect(result.isNewSession).toBe(true);
    expect(result.resetTriggered).toBe(false);
    expect(result.sessionId).toBe(existingSessionId);
    await expect(
      drainFormattedSystemEvents({
        cfg,
        sessionKey,
        isMainSession: false,
        isNewSession: true,
      }),
    ).resolves.toBeUndefined();
    expect(peekSystemEvents(existingSessionId)).toStrictEqual([]);
  });

  it("reuses completed run entries while the session is still fresh", async () => {
    vi.setSystemTime(new Date(2026, 0, 18, 5, 30, 0));
    const root = await makeCaseDir("openclaw-reset-terminal-entry-");
    const storePath = path.join(root, "sessions.json");
    const sessionKey = "agent:main:whatsapp:dm:terminal-entry";
    const existingSessionId = "terminal-entry-old";
    await writeSessionStoreFast(storePath, {
      [sessionKey]: {
        sessionId: existingSessionId,
        updatedAt: Date.now(),
        startedAt: Date.now() - 10_000,
        endedAt: Date.now() - 1_000,
        runtimeMs: 9_000,
        status: "done",
      },
    });

    const cfg = { session: { store: storePath } } as OpenClawConfig;
    const result = await initSessionState({
      ctx: { Body: "hello", SessionKey: sessionKey },
      cfg,
      commandAuthorized: true,
    });

    expect(result.isNewSession).toBe(false);
    expect(result.sessionId).toBe(existingSessionId);

    const persisted = readSessionStoreFast(storePath);
    expect(persisted[sessionKey]?.sessionId).toBe(existingSessionId);
    expect(persisted[sessionKey]?.status).toBe("done");
    expect(persisted[sessionKey]?.startedAt).toBe(Date.now() - 10_000);
    expect(persisted[sessionKey]?.endedAt).toBe(Date.now() - 1_000);
    expect(persisted[sessionKey]?.runtimeMs).toBe(9_000);
  });

  it.each([
    {
      name: "non-main terminal rows ignore later transcript mutations",
      sessionKey: "agent:main:whatsapp:dm:terminal-entry",
      updatedAtOffsetMs: -5_000,
      endedAtOffsetMs: -6_000,
      transcriptMutationOrder: "after-registry" as const,
      expectNewSession: false,
    },
    {
      name: "main status-done terminal rows reuse after a later transcript mutation",
      sessionKey: "agent:main:main",
      updatedAtOffsetMs: -10_000,
      endedAtOffsetMs: -11_000,
      transcriptMutationOrder: "after-registry" as const,
      expectNewSession: false,
    },
    {
      name: "main killed terminal rows rotate after a later transcript mutation",
      sessionKey: "agent:main:main",
      status: "killed" as const,
      updatedAtOffsetMs: -10_000,
      endedAtOffsetMs: -11_000,
      transcriptMutationOrder: "after-registry" as const,
      expectNewSession: true,
    },
    {
      name: "main endedAt-only rows rotate after a later transcript mutation",
      sessionKey: "agent:main:main",
      updatedAtOffsetMs: -10_000,
      endedAtOffsetMs: -11_000,
      transcriptMutationOrder: "after-registry" as const,
      omitStatus: true,
      expectNewSession: true,
    },
    {
      name: "failed main terminal rows recover on visible turns when the transcript exists",
      sessionKey: "agent:main:main",
      status: "failed" as const,
      updatedAtOffsetMs: -10_000,
      endedAtOffsetMs: -11_000,
      transcriptMutationOrder: "after-registry" as const,
      expectNewSession: false,
      expectRecovered: true,
    },
    {
      name: "main terminal rows reuse when the registry observes the transcript mutation",
      sessionKey: "agent:main:main",
      updatedAtOffsetMs: -1_000,
      endedAtOffsetMs: -6_000,
      transcriptMutationOrder: "before-registry" as const,
      expectNewSession: false,
    },
  ])("$name", async (scenario) => {
    vi.setSystemTime(new Date(2026, 0, 18, 5, 30, 0));
    const root = await makeCaseDir("openclaw-reset-terminal-entry-");
    const storePath = path.join(root, "sessions.json");
    const existingSessionId = "terminal-entry-old";
    const now = Date.now();
    const terminalUpdatedAt = now + scenario.updatedAtOffsetMs;
    const terminalEndedAt = now + scenario.endedAtOffsetMs;
    await writeTerminalTranscriptSessionStore({
      storePath,
      sessionKey: scenario.sessionKey,
      sessionId: existingSessionId,
      status: scenario.status,
      omitStatus: scenario.omitStatus,
      updatedAt: terminalUpdatedAt,
      endedAt: terminalEndedAt,
      transcriptMutationOrder: scenario.transcriptMutationOrder,
    });

    const cfg = { session: { store: storePath } } as OpenClawConfig;
    const result = await initSessionState({
      ctx: { Body: "hello", SessionKey: scenario.sessionKey },
      cfg,
      commandAuthorized: true,
    });

    expect(result.isNewSession).toBe(scenario.expectNewSession);
    const persisted = readSessionStoreFast(storePath);
    const entry = persisted[scenario.sessionKey];
    if (scenario.expectNewSession) {
      expect(result.sessionId).toBe(existingSessionId);
      expect(entry?.sessionId).toBe(existingSessionId);
      expect(entry?.status).toBeUndefined();
      expect(entry?.startedAt).toBeUndefined();
      expect(entry?.endedAt).toBeUndefined();
      expect(entry?.runtimeMs).toBeUndefined();
    } else if (scenario.expectRecovered) {
      // Visible turns recover recoverable terminal rows in place: the session id
      // is reused, but the terminal lifecycle fields are cleared (#86827).
      expect(result.sessionId).toBe(existingSessionId);
      expect(entry?.status).toBeUndefined();
      expect(entry?.startedAt).toBeUndefined();
      expect(entry?.endedAt).toBeUndefined();
      expect(entry?.runtimeMs).toBeUndefined();
    } else {
      expect(result.sessionId).toBe(existingSessionId);
      expect(entry?.status).toBe(scenario.status ?? "done");
      expect(entry?.endedAt).toBe(terminalEndedAt);
    }
  });

  it("recovers failed group sessions without rotating the transcript", async () => {
    vi.setSystemTime(new Date(2026, 0, 18, 5, 30, 0));
    const root = await makeCaseDir("openclaw-reset-failed-entry-");
    const storePath = path.join(root, "sessions.json");
    const sessionKey = "agent:main:telegram:group:-1001";
    const existingSessionId = "failed-entry-old";
    await writeSessionStoreFast(storePath, {
      [sessionKey]: {
        sessionId: existingSessionId,
        updatedAt: Date.now(),
        startedAt: Date.now() - 10_000,
        endedAt: Date.now() - 1_000,
        runtimeMs: 9_000,
        status: "failed",
        abortedLastRun: true,
        chatType: "group",
      },
    });

    const cfg = { session: { store: storePath } } as OpenClawConfig;
    const result = await initSessionState({
      ctx: {
        Body: "@openclaw hello",
        RawBody: "@openclaw hello",
        CommandBody: "@openclaw hello",
        SessionKey: sessionKey,
        ChatType: "group",
        Provider: "telegram",
        BotUsername: "openclaw",
      },
      cfg,
      commandAuthorized: true,
    });

    expect(result.isNewSession).toBe(false);
    expect(result.sessionId).toBe(existingSessionId);
    expect(result.abortedLastRun).toBe(false);
    expect(result.sessionEntry.abortedLastRun).toBeUndefined();

    const persisted = readSessionStoreFast(storePath);
    expect(persisted[sessionKey]?.sessionId).toBe(existingSessionId);
    expect(persisted[sessionKey]?.status).toBeUndefined();
    expect(persisted[sessionKey]?.startedAt).toBeUndefined();
    expect(persisted[sessionKey]?.endedAt).toBeUndefined();
    expect(persisted[sessionKey]?.runtimeMs).toBeUndefined();
    expect(persisted[sessionKey]?.abortedLastRun).toBeUndefined();
  });

  it.each([
    {
      name: "keeps the existing stale session for /reset soft",
      body: "/reset soft",
      slug: "soft",
    },
    {
      name: "keeps the existing stale session for /reset: soft",
      body: "/reset: soft",
      slug: "soft-colon",
    },
    {
      name: "keeps the existing stale session for multiline /reset soft tails",
      body: "/reset soft\nre-read persona files",
      slug: "soft-multiline",
    },
  ])("$name", async ({ body, slug }) => {
    vi.setSystemTime(new Date(2026, 0, 18, 5, 30, 0));
    const root = await makeCaseDir(`openclaw-reset-${slug}-stale-`);
    const storePath = path.join(root, "sessions.json");
    const sessionKey = `agent:main:whatsapp:dm:${slug}-stale`;
    const existingSessionId = `${slug}-stale-session-id`;

    await writeSessionStoreFast(storePath, {
      [sessionKey]: {
        sessionId: existingSessionId,
        updatedAt: new Date(2026, 0, 18, 4, 45, 0).getTime(),
      },
    });

    const cfg = {
      session: {
        store: storePath,
        reset: { mode: "daily", atHour: 4, idleMinutes: 30 },
      },
    } as OpenClawConfig;
    const result = await initSessionState({
      ctx: {
        Body: body,
        RawBody: body,
        CommandBody: body,
        SessionKey: sessionKey,
      },
      cfg,
      commandAuthorized: true,
    });

    expect(result.resetTriggered).toBe(false);
    expect(result.isNewSession).toBe(false);
    expect(result.sessionId).toBe(existingSessionId);
    expect(clearBootstrapSnapshotOnSessionRolloverSpy).not.toHaveBeenCalledWith({
      boundaryAppended: true,
      sessionKey,
    });
  });

  it("keeps multiline slash skill payloads on the current session", async () => {
    const root = await makeCaseDir("openclaw-skill-multiline-session-");
    const storePath = path.join(root, "sessions.json");
    const sessionKey = "agent:main:whatsapp:dm:skill-multiline";
    const existingSessionId = "skill-multiline-session-id";
    const body = "/skill demo_skill first line\nsecond line";

    await writeSessionStoreFast(storePath, {
      [sessionKey]: {
        sessionId: existingSessionId,
        updatedAt: Date.now(),
      },
    });

    const result = await initSessionState({
      ctx: {
        Body: body,
        RawBody: body,
        CommandBody: body,
        SessionKey: sessionKey,
      },
      cfg: { session: { store: storePath } } as OpenClawConfig,
      commandAuthorized: true,
    });

    expect(result.resetTriggered).toBe(false);
    expect(result.isNewSession).toBe(false);
    expect(result.sessionId).toBe(existingSessionId);
    expect(result.triggerBodyNormalized).toBe(body);
  });

  it("does not preserve a stale session for unauthorized /reset soft", async () => {
    vi.setSystemTime(new Date(2026, 0, 18, 5, 30, 0));
    const root = await makeCaseDir("openclaw-reset-soft-stale-unauthorized-");
    const storePath = path.join(root, "sessions.json");
    const sessionKey = "agent:main:whatsapp:dm:soft-stale-unauthorized";
    const existingSessionId = "soft-stale-unauthorized-session-id";

    await writeSessionStoreFast(storePath, {
      [sessionKey]: {
        sessionId: existingSessionId,
        updatedAt: new Date(2026, 0, 18, 4, 45, 0).getTime(),
      },
    });

    const cfg = {
      session: {
        store: storePath,
        reset: { mode: "daily", atHour: 4, idleMinutes: 30 },
      },
    } as OpenClawConfig;
    const result = await initSessionState({
      ctx: {
        Body: "/reset soft",
        RawBody: "/reset soft",
        CommandBody: "/reset soft",
        Provider: "whatsapp",
        Surface: "whatsapp",
        SessionKey: sessionKey,
      },
      cfg,
      commandAuthorized: false,
    });

    expect(result.resetTriggered).toBe(false);
    expect(result.isNewSession).toBe(true);
    expect(result.sessionId).toBe(existingSessionId);
    expect(clearBootstrapSnapshotOnSessionRolloverSpy).toHaveBeenCalledWith({
      boundaryAppended: true,
      sessionKey,
    });
  });

  it.each([
    {
      name: "uses per-type overrides for thread sessions",
      slug: "thread",
      sessionKey: "agent:main:slack:channel:c1:thread:123",
      sessionId: "thread-session-id",
      updatedAt: new Date(2026, 0, 18, 3, 0, 0).getTime(),
      session: {
        reset: { mode: "daily" as const, atHour: 4 },
        resetByType: { thread: { mode: "idle" as const, idleMinutes: 180 } },
      },
      ctx: { Body: "reply", ThreadLabel: "Slack thread" },
    },
    {
      name: "detects thread sessions without thread key suffix",
      slug: "thread-nosuffix",
      sessionKey: "agent:main:discord:channel:c1",
      sessionId: "thread-nosuffix",
      updatedAt: new Date(2026, 0, 18, 3, 0, 0).getTime(),
      session: { resetByType: { thread: { mode: "idle" as const, idleMinutes: 180 } } },
      ctx: { Body: "reply", ThreadLabel: "Discord thread" },
    },
    {
      name: "keeps the no-reset default for types without an override",
      slug: "type-default",
      sessionKey: "agent:main:whatsapp:dm:s4",
      sessionId: "type-default-session",
      updatedAt: new Date(2026, 0, 18, 3, 0, 0).getTime(),
      session: { resetByType: { thread: { mode: "idle" as const, idleMinutes: 60 } } },
      ctx: { Body: "hello" },
    },
    {
      name: "keeps legacy idleMinutes behavior without reset config",
      slug: "legacy",
      sessionKey: "agent:main:whatsapp:dm:s3",
      sessionId: "legacy-session-id",
      updatedAt: new Date(2026, 0, 18, 3, 30, 0).getTime(),
      session: { idleMinutes: 240 },
      ctx: { Body: "hello" },
      expectBootstrapBoundary: false,
    },
  ])("$name", async (scenario) => {
    vi.setSystemTime(new Date(2026, 0, 18, 5, 0, 0));
    const storePath = await createStorePath(`openclaw-reset-${scenario.slug}-`);
    await writeSessionStoreFast(storePath, {
      [scenario.sessionKey]: {
        sessionId: scenario.sessionId,
        updatedAt: scenario.updatedAt,
      },
    });

    const result = await initSessionState({
      ctx: { SessionKey: scenario.sessionKey, ...scenario.ctx },
      cfg: { session: { store: storePath, ...scenario.session } } as OpenClawConfig,
      commandAuthorized: true,
    });

    expect(result.isNewSession).toBe(false);
    expect(result.sessionId).toBe(scenario.sessionId);
    if ("expectBootstrapBoundary" in scenario) {
      expect(clearBootstrapSnapshotOnSessionRolloverSpy).toHaveBeenCalledWith({
        boundaryAppended: false,
        sessionKey: scenario.sessionKey,
      });
    }
  });
});

describe("initSessionState browser tab cleanup", () => {
  it("closes tracked browser tabs when idle session expires", async () => {
    vi.setSystemTime(new Date(2026, 0, 18, 5, 30, 0));
    const storePath = await createStorePath("openclaw-tab-cleanup-idle-");
    const sessionKey = "agent:main:whatsapp:dm:tab-idle";
    const existingSessionId = "tab-idle-session-id";

    await writeSessionStoreFast(storePath, {
      [sessionKey]: {
        sessionId: existingSessionId,
        updatedAt: new Date(2026, 0, 18, 4, 45, 0).getTime(),
      },
    });

    const cfg = {
      session: {
        store: storePath,
        reset: { mode: "daily", atHour: 4, idleMinutes: 30 },
      },
    } as OpenClawConfig;
    const result = await initSessionState({
      ctx: { Body: "hello", SessionKey: sessionKey },
      cfg,
      commandAuthorized: true,
    });

    expect(result.isNewSession).toBe(true);
    const cleanupParams = requireMockCallArg(
      browserMaintenanceMocks.closeTrackedBrowserTabsForSessions,
      "closeTrackedBrowserTabsForSessions",
    );
    expect(cleanupParams.sessionKeys).toEqual([existingSessionId, sessionKey]);
  });

  it.each([
    {
      name: "skips browser tab cleanup when root browser support is disabled",
      slug: "browser-disabled",
      config: { browser: { enabled: false } },
    },
    {
      name: "skips browser tab cleanup when the browser plugin entry is disabled",
      slug: "browser-plugin-disabled",
      config: { plugins: { entries: { browser: { enabled: false } } } },
    },
  ])("$name", async ({ slug, config }) => {
    vi.setSystemTime(new Date(2026, 0, 18, 5, 30, 0));
    const storePath = await createStorePath(`openclaw-tab-cleanup-${slug}-`);
    const sessionKey = `agent:main:webchat:dm:tab-${slug}`;

    await writeSessionStoreFast(storePath, {
      [sessionKey]: {
        sessionId: `tab-${slug}-session-id`,
        updatedAt: new Date(2026, 0, 18, 4, 45, 0).getTime(),
      },
    });

    const cfg = {
      ...config,
      session: {
        store: storePath,
        reset: { mode: "daily", atHour: 4, idleMinutes: 30 },
      },
    } as OpenClawConfig;
    const result = await initSessionState({
      ctx: { Body: "hello", SessionKey: sessionKey },
      cfg,
      commandAuthorized: true,
    });

    expect(result.isNewSession).toBe(true);
    expect(browserMaintenanceMocks.closeTrackedBrowserTabsForSessions).not.toHaveBeenCalled();
  });

  it("closes tracked browser tabs on explicit /new reset", async () => {
    const storePath = await createStorePath("openclaw-tab-cleanup-reset-");
    const sessionKey = "agent:main:telegram:dm:tab-reset";
    const existingSessionId = "tab-reset-session-id";

    await writeSessionStoreFast(storePath, {
      [sessionKey]: {
        sessionId: existingSessionId,
        updatedAt: Date.now(),
      },
    });

    const cfg = {
      session: { store: storePath, idleMinutes: 999 },
    } as OpenClawConfig;
    const result = await initSessionState({
      ctx: {
        Body: "/new",
        RawBody: "/new",
        CommandBody: "/new",
        SessionKey: sessionKey,
      },
      cfg,
      commandAuthorized: true,
    });

    expect(result.isNewSession).toBe(true);
    const cleanupParams = requireMockCallArg(
      browserMaintenanceMocks.closeTrackedBrowserTabsForSessions,
      "closeTrackedBrowserTabsForSessions",
    );
    expect(cleanupParams.sessionKeys).toEqual([existingSessionId, sessionKey]);
  });

  it("does not close browser tabs for a fresh session without previous state", async () => {
    const storePath = await createStorePath("openclaw-tab-cleanup-fresh-");
    const sessionKey = "agent:main:telegram:dm:tab-fresh";

    const cfg = {
      session: { store: storePath, idleMinutes: 999 },
    } as OpenClawConfig;
    const result = await initSessionState({
      ctx: {
        Body: "hello",
        SessionKey: sessionKey,
      },
      cfg,
      commandAuthorized: true,
    });

    expect(result.isNewSession).toBe(true);
    expect(browserMaintenanceMocks.closeTrackedBrowserTabsForSessions).not.toHaveBeenCalled();
  });

  it("includes the peer-scoped runtime key for direct-message cleanup", async () => {
    const storePath = await createStorePath("openclaw-tab-cleanup-peer-key-");
    const canonicalKey = "agent:main:main";
    const existingSessionId = "tab-peer-key-session-id";
    await writeSessionStoreFast(storePath, {
      [canonicalKey]: {
        sessionId: existingSessionId,
        updatedAt: Date.now(),
      },
    });

    const cfg = { session: { store: storePath } } as OpenClawConfig;
    const result = await initSessionState({
      ctx: {
        Body: "/new",
        RawBody: "/new",
        CommandBody: "/new",
        From: "12345",
        Provider: "telegram",
        ChatType: "direct",
      },
      cfg,
      commandAuthorized: true,
    });

    expect(result.isNewSession).toBe(true);
    const cleanupParams = requireMockCallArg(
      browserMaintenanceMocks.closeTrackedBrowserTabsForSessions,
      "closeTrackedBrowserTabsForSessions",
    );
    expect(cleanupParams.sessionKeys).toEqual([
      existingSessionId,
      canonicalKey,
      "agent:main:telegram:default:direct:12345",
    ]);
  });
});

describe("initSessionState channel reset overrides", () => {
  it("uses channel-specific reset policy when configured", async () => {
    const root = await makeCaseDir("openclaw-channel-idle-");
    const storePath = path.join(root, "sessions.json");
    const sessionKey = "agent:main:discord:dm:123";
    const sessionId = "session-override";
    const updatedAt = Date.now() - (10080 - 1) * 60_000;

    await writeSessionStoreFast(storePath, {
      [sessionKey]: {
        sessionId,
        updatedAt,
      },
    });

    const cfg = {
      session: {
        store: storePath,
        idleMinutes: 60,
        resetByType: { direct: { mode: "idle", idleMinutes: 10 } },
        resetByChannel: { discord: { mode: "idle", idleMinutes: 10080 } },
      },
    } as OpenClawConfig;

    const result = await initSessionState({
      ctx: {
        Body: "Hello",
        SessionKey: sessionKey,
        Provider: "discord",
      },
      cfg,
      commandAuthorized: true,
    });

    expect(result.isNewSession).toBe(false);
    expect(result.sessionEntry.sessionId).toBe(sessionId);
  });
});

describe("initSessionState reset triggers in WhatsApp groups", () => {
  async function seedSessionStore(params: {
    storePath: string;
    sessionKey: string;
    sessionId: string;
  }): Promise<void> {
    await writeSessionStoreFast(params.storePath, {
      [params.sessionKey]: {
        sessionId: params.sessionId,
        updatedAt: Date.now(),
      },
    });
  }

  function makeCfg(params: { storePath: string; allowFrom: string[] }): OpenClawConfig {
    return {
      session: { store: params.storePath, idleMinutes: 999 },
      channels: {
        whatsapp: {
          allowFrom: params.allowFrom,
          groupPolicy: "open",
        },
      },
    } as OpenClawConfig;
  }

  it("applies WhatsApp group reset authorization across sender variants", async () => {
    const sessionKey = "agent:main:whatsapp:group:120363406150318674@g.us";
    const existingSessionId = "existing-session-123";
    const storePath = await createStorePath("openclaw-group-reset");
    const cases = [
      {
        name: "authorized sender",
        allowFrom: ["+41796666864"],
        body: `[Chat messages since your last reply - for context]\\n[WhatsApp 120363406150318674@g.us 2026-01-13T07:45Z] Someone: hello\\n\\n[Current message - respond to this]\\n[WhatsApp 120363406150318674@g.us 2026-01-13T07:45Z] Peschiño: /new\\n[from: Peschiño (+41796666864)]`,
        senderName: "Peschiño",
        senderE164: "+41796666864",
        senderId: "41796666864:0@s.whatsapp.net",
        expectedIsNewSession: true,
      },
      {
        name: "LID sender with unauthorized E164",
        allowFrom: ["+41796666864"],
        body: `[WhatsApp 120363406150318674@g.us 2026-01-13T07:45Z] Other: /new\n[from: Other (+1555123456)]`,
        senderName: "Other",
        senderE164: "+1555123456",
        senderId: "123@lid",
        expectedIsNewSession: true,
      },
    ] as const;

    for (const testCase of cases) {
      await seedSessionStore({
        storePath,
        sessionKey,
        sessionId: existingSessionId,
      });
      const cfg = makeCfg({
        storePath,
        allowFrom: [...testCase.allowFrom],
      });

      const result = await initSessionState({
        ctx: {
          Body: testCase.body,
          RawBody: "/new",
          CommandBody: "/new",
          From: "120363406150318674@g.us",
          To: "+41779241027",
          ChatType: "group",
          SessionKey: sessionKey,
          Provider: "whatsapp",
          Surface: "whatsapp",
          SenderName: testCase.senderName,
          SenderE164: testCase.senderE164,
          SenderId: testCase.senderId,
        },
        cfg,
        commandAuthorized: true,
      });

      expect(result.triggerBodyNormalized, testCase.name).toBe("/new");
      expect(result.isNewSession, testCase.name).toBe(testCase.expectedIsNewSession);
      if (testCase.expectedIsNewSession) {
        expect(result.sessionId, testCase.name).toBe(existingSessionId);
        expect(result.bodyStripped, testCase.name).toBe("");
      } else {
        expect(result.sessionId, testCase.name).toBe(existingSessionId);
      }
    }
  });

  it("preserves scoped WhatsApp group activation state across stale rollover", async () => {
    const sessionKey =
      "agent:main:whatsapp:group:120363406150318674@g.us:thread:whatsapp-account-work";
    const storePath = await createStorePath("openclaw-group-activation-backfill-");
    await writeSessionStoreFast(storePath, {
      [sessionKey]: {
        sessionId: "old-group-activation-session",
        updatedAt: 0,
        groupActivation: "always",
      },
    });
    const cfg = makeCfg({
      storePath,
      allowFrom: ["+41796666864"],
    });

    const result = await initSessionState({
      ctx: {
        Body: "hello without mention",
        RawBody: "hello without mention",
        CommandBody: "hello without mention",
        From: "120363406150318674@g.us",
        To: "+41779241027",
        ChatType: "group",
        SessionKey: sessionKey,
        Provider: "whatsapp",
        Surface: "whatsapp",
        SenderName: "Peschiño",
        SenderE164: "+41796666864",
        SenderId: "41796666864:0@s.whatsapp.net",
      },
      cfg,
      commandAuthorized: false,
    });

    expect(result.isNewSession).toBe(true);
    expect(result.sessionId).toBe("old-group-activation-session");
    expect(result.sessionEntry.groupActivation).toBe("always");
    expect(result.sessionEntry.sessionId).toBe(result.sessionId);
    expect(typeof result.sessionEntry.updatedAt).toBe("number");
  });
});

describe("initSessionState reset triggers in Slack channels", () => {
  async function seedSessionStore(params: {
    storePath: string;
    sessionKey: string;
    sessionId: string;
  }): Promise<void> {
    await writeSessionStoreFast(params.storePath, {
      [params.sessionKey]: {
        sessionId: params.sessionId,
        updatedAt: Date.now(),
      },
    });
  }

  it("supports mention-prefixed Slack reset commands and preserves args", async () => {
    setMinimalCurrentConversationBindingRegistryForTests();
    const existingSessionId = "existing-session-123";
    const sessionKey = "agent:main:slack:channel:c2";
    const body = "<@U123> /new take notes";
    const storePath = await createStorePath("openclaw-slack-channel-new-");
    await seedSessionStore({
      storePath,
      sessionKey,
      sessionId: existingSessionId,
    });
    const cfg = {
      session: { store: storePath, idleMinutes: 999 },
    } as OpenClawConfig;

    const result = await initSessionState({
      ctx: {
        Body: body,
        RawBody: body,
        BodyForCommands: "/new take notes",
        CommandBody: body,
        From: "slack:channel:C1",
        To: "channel:C1",
        ChatType: "channel",
        SessionKey: sessionKey,
        Provider: "slack",
        Surface: "slack",
        SenderId: "U123",
        SenderName: "Owner",
        WasMentioned: true,
      },
      cfg,
      commandAuthorized: true,
    });

    expect(result.isNewSession).toBe(true);
    expect(result.resetTriggered).toBe(true);
    expect(result.sessionId).toBe(existingSessionId);
    expect(result.bodyStripped).toBe("take notes");
  });
});

describe("initSessionState preserves behavior overrides across /new and /reset", () => {
  async function seedSessionStoreWithOverrides(params: {
    storePath: string;
    sessionKey: string;
    sessionId: string;
    overrides: Record<string, unknown>;
  }): Promise<void> {
    await writeSessionStoreFast(params.storePath, {
      [params.sessionKey]: {
        sessionId: params.sessionId,
        updatedAt: Date.now(),
        ...params.overrides,
      },
    });
  }

  it("rejects explicit resets without replacing a model-locked session", async () => {
    const storePath = await createStorePath("openclaw-reset-model-locked-");
    const sessionKey = "agent:main:telegram:dm:model-locked";
    const existingSessionId = "existing-model-locked-session";

    for (const body of ["/new", "/reset openai/gpt-5.5 continue"] as const) {
      await seedSessionStoreWithOverrides({
        storePath,
        sessionKey,
        sessionId: existingSessionId,
        overrides: {
          agentHarnessId: "codex",
          modelSelectionLocked: true,
          pluginExtensions: {
            codex: { threadId: "codex-thread-1" },
          },
        },
      });

      await expect(
        initSessionState({
          ctx: {
            Body: body,
            RawBody: body,
            CommandBody: body,
            From: "model-locked",
            To: "bot",
            ChatType: "direct",
            SessionKey: sessionKey,
            Provider: "telegram",
            Surface: "telegram",
          },
          cfg: {
            session: { store: storePath, idleMinutes: 999 },
          } as OpenClawConfig,
          commandAuthorized: true,
        }),
      ).rejects.toThrow(MODEL_SELECTION_LOCKED_RESET_MESSAGE);

      expect(loadSessionEntry({ storePath, sessionKey })).toMatchObject({
        sessionId: existingSessionId,
        agentHarnessId: "codex",
        modelSelectionLocked: true,
        pluginExtensions: {
          codex: { threadId: "codex-thread-1" },
        },
      });
    }
  });

  it("does not implicitly expire a model-locked session", async () => {
    const storePath = await createStorePath("openclaw-expiry-model-locked-");
    const sessionKey = "agent:main:telegram:dm:model-locked-expiry";
    const existingSessionId = "existing-model-locked-expiry-session";
    await writeSessionStoreFast(storePath, {
      [sessionKey]: {
        sessionId: existingSessionId,
        updatedAt: Date.now() - 60 * 60 * 1000,
        agentHarnessId: "codex",
        modelSelectionLocked: true,
        pluginExtensions: {
          codex: { threadId: "codex-thread-expiry" },
        },
      },
    });

    const result = await initSessionState({
      ctx: {
        Body: "continue",
        RawBody: "continue",
        CommandBody: "continue",
        From: "model-locked-expiry",
        To: "bot",
        ChatType: "direct",
        SessionKey: sessionKey,
        Provider: "telegram",
        Surface: "telegram",
      },
      cfg: {
        session: { store: storePath, idleMinutes: 1 },
      } as OpenClawConfig,
      commandAuthorized: true,
    });

    expect(result.isNewSession).toBe(false);
    expect(result.sessionId).toBe(existingSessionId);
    expect(result.sessionEntry).toMatchObject({
      agentHarnessId: "codex",
      modelSelectionLocked: true,
      pluginExtensions: {
        codex: { threadId: "codex-thread-expiry" },
      },
    });
  });

  it("preserves behavior overrides across /new and /reset", async () => {
    const storePath = await createStorePath("openclaw-reset-overrides-");
    const sessionKey = "agent:main:telegram:dm:user-overrides";
    const existingSessionId = "existing-session-overrides";
    const overrides = {
      verboseLevel: "on",
      thinkingLevel: "high",
      reasoningLevel: "low",
      label: "telegram-priority",
    } as const;
    const cases = await runExplicitResetCases({
      storePath,
      sessionKey,
      sessionId: existingSessionId,
      entry: overrides,
    });

    for (const { name, result } of cases) {
      expect(result.isNewSession, name).toBe(true);
      expect(result.resetTriggered, name).toBe(true);
      expect(result.sessionId, name).toBe(existingSessionId);
      expectEntryFields(result.sessionEntry, overrides, name);
    }
  });

  it("preserves usage family metadata across /new and /reset", async () => {
    const storePath = await createStorePath("openclaw-reset-usage-family-");
    const sessionKey = "agent:main:telegram:dm:user-usage-family";
    const existingSessionId = "existing-session-usage-family";
    const cases = await runExplicitResetCases({
      storePath,
      sessionKey,
      sessionId: existingSessionId,
      entry: {
        usageFamilyKey: "family:user-usage-family",
        usageFamilySessionIds: ["ancestor-session", existingSessionId],
      },
    });

    for (const { name, result, stored } of cases) {
      expect(result.resetTriggered, name).toBe(true);
      expect(result.sessionId, name).toBe(existingSessionId);
      expect(result.sessionEntry.usageFamilyKey, name).toBe("family:user-usage-family");
      expect(result.sessionEntry.usageFamilySessionIds, name).toEqual([
        "ancestor-session",
        existingSessionId,
      ]);
      expect(
        expectDefined(stored[sessionKey], "stored[sessionKey] test invariant").usageFamilyKey,
        name,
      ).toBe("family:user-usage-family");
      expect(
        expectDefined(stored[sessionKey], "stored[sessionKey] test invariant")
          .usageFamilySessionIds,
        name,
      ).toEqual(["ancestor-session", existingSessionId]);
    }
  });

  it("preserves selected auth profile overrides across /new and /reset", async () => {
    const storePath = await createStorePath("openclaw-reset-model-auth-");
    const sessionKey = "agent:main:telegram:dm:user-model-auth";
    const existingSessionId = "existing-session-model-auth";
    const overrides = {
      providerOverride: "openai",
      modelOverride: "gpt-4o",
      authProfileOverride: "20251001",
      authProfileOverrideSource: "user",
      authProfileOverrideCompactionCount: 2,
      cliSessionIds: { "claude-cli": "cli-session-123" },
      cliSessionBindings: {
        "claude-cli": {
          sessionId: "cli-session-123",
          authProfileId: "anthropic:default",
        },
      },
      claudeCliSessionId: "cli-session-123",
    } as const;
    const cases = await runExplicitResetCases({
      storePath,
      sessionKey,
      sessionId: existingSessionId,
      entry: overrides,
    });

    for (const { name, result, stored } of cases) {
      expect(result.isNewSession, name).toBe(true);
      expect(result.resetTriggered, name).toBe(true);
      expect(result.sessionId, name).toBe(existingSessionId);
      expect(result.sessionEntry.providerOverride, name).toBe(overrides.providerOverride);
      expect(result.sessionEntry.modelOverride, name).toBe(overrides.modelOverride);
      expect(result.sessionEntry.authProfileOverride, name).toBe(overrides.authProfileOverride);
      expect(result.sessionEntry.authProfileOverrideSource, name).toBe(
        overrides.authProfileOverrideSource,
      );
      expect(result.sessionEntry.authProfileOverrideCompactionCount, name).toBe(
        overrides.authProfileOverrideCompactionCount,
      );
      expect(result.sessionEntry.cliSessionIds).toBeUndefined();
      expect(result.sessionEntry.cliSessionBindings).toBeUndefined();
      expect(result.sessionEntry.claudeCliSessionId).toBeUndefined();
      expect(
        expectDefined(stored[sessionKey], "stored[sessionKey] test invariant").cliSessionIds,
      ).toBeUndefined();
      expect(
        expectDefined(stored[sessionKey], "stored[sessionKey] test invariant").cliSessionBindings,
      ).toBeUndefined();
      expect(
        expectDefined(stored[sessionKey], "stored[sessionKey] test invariant").claudeCliSessionId,
      ).toBeUndefined();
    }
  });

  it("clears auto-sourced model/provider/auth overrides on /new and /reset (#69301)", async () => {
    const storePath = await createStorePath("openclaw-reset-auto-overrides-");
    const sessionKey = "agent:main:telegram:direct:6761477233";
    const existingSessionId = "existing-session-auto-overrides";
    const autoOverrides = {
      providerOverride: "openai",
      modelOverride: "gpt-5.4",
      modelOverrideSource: "auto",
      authProfileOverride: "openai:default",
      authProfileOverrideSource: "auto",
      authProfileOverrideCompactionCount: 1,
      verboseLevel: "on",
    } as const;
    const cases = await runExplicitResetCases({
      storePath,
      sessionKey,
      sessionId: existingSessionId,
      entry: autoOverrides,
    });

    for (const { name, result } of cases) {
      expect(result.isNewSession, name).toBe(true);
      expect(result.resetTriggered, name).toBe(true);
      expect(result.sessionId, name).toBe(existingSessionId);
      expect(result.sessionEntry.modelOverride, name).toBeUndefined();
      expect(result.sessionEntry.providerOverride, name).toBeUndefined();
      expect(result.sessionEntry.modelOverrideSource, name).toBeUndefined();
      expect(result.sessionEntry.authProfileOverride, name).toBeUndefined();
      expect(result.sessionEntry.authProfileOverrideSource, name).toBeUndefined();
      expect(result.sessionEntry.authProfileOverrideCompactionCount, name).toBeUndefined();
      // Unrelated behavior overrides still carry across the reset.
      expect(result.sessionEntry.verboseLevel, name).toBe(autoOverrides.verboseLevel);
    }
  });

  it("clears recovered auto fallback model overrides without modelOverrideSource on /new and /reset", async () => {
    const storePath = await createStorePath("openclaw-reset-recovered-auto-fallback-");
    const sessionKey = "agent:main:telegram:direct:6761477233";
    const existingSessionId = "existing-session-recovered-auto-fallback";
    const autoOverrides = {
      providerOverride: "openai",
      modelOverride: "gpt-5.4",
      modelOverrideFallbackOriginProvider: "anthropic",
      modelOverrideFallbackOriginModel: "claude-opus-4-6",
      verboseLevel: "on",
    } as const;
    const cases = await runExplicitResetCases({
      storePath,
      sessionKey,
      sessionId: existingSessionId,
      entry: autoOverrides,
    });

    for (const { name, result } of cases) {
      expect(result.isNewSession, name).toBe(true);
      expect(result.resetTriggered, name).toBe(true);
      expect(result.sessionId, name).toBe(existingSessionId);
      expect(result.sessionEntry.modelOverride, name).toBeUndefined();
      expect(result.sessionEntry.providerOverride, name).toBeUndefined();
      expect(result.sessionEntry.modelOverrideSource, name).toBeUndefined();
      expect(result.sessionEntry.modelOverrideFallbackOriginProvider, name).toBeUndefined();
      expect(result.sessionEntry.modelOverrideFallbackOriginModel, name).toBeUndefined();
      expect(result.sessionEntry.verboseLevel, name).toBe(autoOverrides.verboseLevel);
    }
  });

  it("clears recovered Codex fallback metadata for Discord channel sessions on /new", async () => {
    const storePath = await createStorePath("openclaw-reset-discord-codex-fallback-");
    const sessionKey = "agent:main:discord:channel:1488013357016420522";
    const existingSessionId = "existing-discord-codex-fallback";
    await seedSessionStoreWithOverrides({
      storePath,
      sessionKey,
      sessionId: existingSessionId,
      overrides: {
        providerOverride: "codex",
        modelOverride: "gpt-5.4",
        modelOverrideFallbackOriginProvider: "openai",
        modelOverrideFallbackOriginModel: "gpt-5.5",
        totalTokens: 231_980,
        contextTokens: 272_000,
        totalTokensFresh: true,
      },
    });

    const result = await initSessionState({
      ctx: {
        Body: "/new",
        RawBody: "/new",
        CommandBody: "/new",
        From: "discord-user",
        To: "discord-bot",
        ChatType: "group",
        SessionKey: sessionKey,
        Provider: "discord",
        Surface: "discord",
      },
      cfg: {
        session: { store: storePath, idleMinutes: 999 },
        agents: {
          defaults: {
            model: {
              primary: "codex/gpt-5.5",
              fallbacks: [],
            },
          },
        },
      } as OpenClawConfig,
      commandAuthorized: true,
    });

    expect(result.isNewSession).toBe(true);
    expect(result.resetTriggered).toBe(true);
    expect(result.sessionId).toBe(existingSessionId);
    expect(result.sessionEntry.providerOverride).toBeUndefined();
    expect(result.sessionEntry.modelOverride).toBeUndefined();
    expect(result.sessionEntry.modelOverrideSource).toBeUndefined();
    expect(result.sessionEntry.modelOverrideFallbackOriginProvider).toBeUndefined();
    expect(result.sessionEntry.modelOverrideFallbackOriginModel).toBeUndefined();
    expect(result.sessionEntry.totalTokens).toBe(0);
    expect(result.sessionEntry.contextTokens).toBeUndefined();
    expect(result.sessionEntry.totalTokensFresh).toBe(true);
  });

  it("clears stale runtime model cache fields on /new and /reset (#77322)", async () => {
    const storePath = await createStorePath("openclaw-reset-runtime-model-cache-");
    const sessionKey = "agent:main:telegram:direct:runtime-model-cache";
    const existingSessionId = "existing-session-runtime-model-cache";
    const runtimeModelCache = {
      modelProvider: "openai",
      model: "gpt-5.4-mini",
      contextTokens: 400_000,
      cacheRead: 1_000,
      cacheWrite: 2_000,
      fallbackNoticeSelectedModel: "openai/gpt-5.4-mini",
      fallbackNoticeActiveModel: "minimax/m2.7",
      fallbackNoticeReason: "rate limit",
      systemPromptReport: {
        source: "run",
        generatedAt: 1,
        provider: "openai",
        model: "gpt-5.4-mini",
        systemPrompt: { chars: 1, projectContextChars: 0, nonProjectContextChars: 1 },
        injectedWorkspaceFiles: [],
        skills: { promptChars: 0, entries: [] },
        tools: { listChars: 0, schemaChars: 0, entries: [] },
      },
      verboseLevel: "on",
    } as const;
    const explicitUserOverride = {
      providerOverride: "minimax",
      modelOverride: "m2.7",
      modelOverrideSource: "user",
    } as const;
    const cases = await runExplicitResetCases({
      storePath,
      sessionKey,
      sessionId: existingSessionId,
      entry: { ...runtimeModelCache, ...explicitUserOverride },
    });

    for (const { name, result, stored } of cases) {
      expect(result.isNewSession, name).toBe(true);
      expect(result.resetTriggered, name).toBe(true);
      expect(result.sessionId, name).toBe(existingSessionId);
      expect(result.sessionEntry.modelProvider, name).toBeUndefined();
      expect(result.sessionEntry.model, name).toBeUndefined();
      expect(result.sessionEntry.cacheRead, name).toBeUndefined();
      expect(result.sessionEntry.cacheWrite, name).toBeUndefined();
      expect(result.sessionEntry.fallbackNoticeSelectedModel, name).toBeUndefined();
      expect(result.sessionEntry.fallbackNoticeActiveModel, name).toBeUndefined();
      expect(result.sessionEntry.fallbackNoticeReason, name).toBeUndefined();
      expect(result.sessionEntry.systemPromptReport, name).toBeUndefined();
      expect(result.sessionEntry.providerOverride, name).toBe(
        explicitUserOverride.providerOverride,
      );
      expect(result.sessionEntry.modelOverride, name).toBe(explicitUserOverride.modelOverride);
      expect(result.sessionEntry.modelOverrideSource, name).toBe(
        explicitUserOverride.modelOverrideSource,
      );
      expect(result.sessionEntry.verboseLevel, name).toBe(runtimeModelCache.verboseLevel);
      expect(stored[sessionKey]?.modelProvider, name).toBeUndefined();
      expect(stored[sessionKey]?.model, name).toBeUndefined();
      expect(stored[sessionKey]?.cacheRead, name).toBeUndefined();
      expect(stored[sessionKey]?.cacheWrite, name).toBeUndefined();
      expect(stored[sessionKey]?.fallbackNoticeSelectedModel, name).toBeUndefined();
      expect(stored[sessionKey]?.fallbackNoticeActiveModel, name).toBeUndefined();
      expect(stored[sessionKey]?.fallbackNoticeReason, name).toBeUndefined();
      expect(stored[sessionKey]?.systemPromptReport, name).toBeUndefined();
      expect(stored[sessionKey]?.providerOverride, name).toBe(
        explicitUserOverride.providerOverride,
      );
      expect(stored[sessionKey]?.modelOverride, name).toBe(explicitUserOverride.modelOverride);
      expect(stored[sessionKey]?.modelOverrideSource, name).toBe(
        explicitUserOverride.modelOverrideSource,
      );
      expect(stored[sessionKey]?.contextTokens, name).toBeUndefined();
      expect(stored[sessionKey]?.verboseLevel, name).toBe(runtimeModelCache.verboseLevel);
    }
  });

  it("preserves spawned session ownership metadata across /new and /reset", async () => {
    const storePath = await createStorePath("openclaw-reset-spawned-metadata-");
    const sessionKey = "subagent:owned-child";
    const existingSessionId = "existing-session-owned-child";
    const overrides = {
      spawnedBy: "agent:main:main",
      spawnedWorkspaceDir: "/tmp/child-workspace",
      spawnedCwd: "/tmp/task-repo",
      parentSessionKey: "agent:main:main",
      forkedFromParent: true,
      spawnDepth: 2,
      subagentRole: "orchestrator",
      subagentControlScope: "children",
      displayName: "Ops Child",
    } as const;
    const cases = [
      { name: "new preserves spawned session ownership metadata", body: "/new" },
      { name: "reset preserves spawned session ownership metadata", body: "/reset" },
    ] as const;

    for (const testCase of cases) {
      await seedSessionStoreWithOverrides({
        storePath,
        sessionKey,
        sessionId: existingSessionId,
        overrides: { ...overrides },
      });

      const cfg = {
        session: { store: storePath, idleMinutes: 999 },
      } as OpenClawConfig;

      const result = await initSessionState({
        ctx: {
          Body: testCase.body,
          RawBody: testCase.body,
          CommandBody: testCase.body,
          From: "user-owned-child",
          To: "bot",
          ChatType: "direct",
          SessionKey: sessionKey,
          Provider: "telegram",
          Surface: "telegram",
        },
        cfg,
        commandAuthorized: true,
      });

      expect(result.isNewSession, testCase.name).toBe(true);
      expect(result.resetTriggered, testCase.name).toBe(true);
      expect(result.sessionId, testCase.name).toBe(existingSessionId);
      expectEntryFields(result.sessionEntry, overrides, testCase.name);
    }
  });

  it("requires operator.admin when Provider is internal even if Surface carries external metadata", async () => {
    const storePath = await createStorePath("openclaw-internal-reset-provider-authoritative-");
    const sessionKey = "agent:main:telegram:dm:provider-authoritative";
    const existingSessionId = "existing-session-provider-authoritative";

    await seedSessionStoreWithOverrides({
      storePath,
      sessionKey,
      sessionId: existingSessionId,
      overrides: {},
    });

    const cfg = {
      session: { store: storePath, idleMinutes: 999 },
    } as OpenClawConfig;

    const result = await initSessionState({
      ctx: {
        Body: "/reset",
        RawBody: "/reset",
        CommandBody: "/reset",
        Provider: "webchat",
        Surface: "telegram",
        OriginatingChannel: "telegram",
        GatewayClientScopes: ["operator.write"],
        ChatType: "direct",
        SessionKey: sessionKey,
      },
      cfg,
      commandAuthorized: true,
    });

    expect(result.resetTriggered).toBe(false);
    expect(result.isNewSession).toBe(false);
    expect(result.sessionId).toBe(existingSessionId);
  });

  it.each([
    {
      name: "keeps the existing session for /reset soft",
      slug: "soft-reset",
      body: "/reset soft",
      entry: {
        cliSessionIds: { "claude-cli": "cli-session-1" },
        cliSessionBindings: {
          "claude-cli": { sessionId: "cli-session-1", extraSystemPromptHash: "prompt-hash" },
        },
      },
    },
    {
      name: "keeps the existing session for /reset newline soft",
      slug: "reset-newline-soft",
      body: "/reset \nsoft",
      entry: {},
    },
  ])("$name", async ({ slug, body, entry }) => {
    const storePath = await createStorePath(`openclaw-${slug}-`);
    const sessionKey = `agent:main:telegram:dm:user-${slug}`;
    const existingSessionId = `existing-session-${slug}`;
    await seedSessionStoreWithOverrides({
      storePath,
      sessionKey,
      sessionId: existingSessionId,
      overrides: entry,
    });

    const result = await initSessionState({
      ctx: {
        Body: body,
        RawBody: body,
        CommandBody: body,
        Provider: "telegram",
        Surface: "telegram",
        ChatType: "direct",
        SessionKey: sessionKey,
      },
      cfg: { session: { store: storePath, idleMinutes: 999 } } as OpenClawConfig,
      commandAuthorized: true,
    });

    expect(result.resetTriggered).toBe(false);
    expect(result.isNewSession).toBe(false);
    expect(result.sessionId).toBe(existingSessionId);
  });
  it("retains the transcript in place on /new", async () => {
    const storePath = await createStorePath("openclaw-archive-old-");
    const sessionKey = "agent:main:telegram:dm:user-archive";
    const existingSessionId = "existing-session-archive";
    await seedSessionStoreWithOverrides({
      storePath,
      sessionKey,
      sessionId: existingSessionId,
      overrides: { verboseLevel: "on" },
    });
    await appendTranscriptMessage(
      { agentId: "main", sessionId: existingSessionId, sessionKey, storePath },
      { message: { role: "user", content: "kept question" } },
    );
    await appendTranscriptMessage(
      { agentId: "main", sessionId: existingSessionId, sessionKey, storePath },
      { message: { role: "assistant", content: "kept answer" } },
    );

    const cfg = {
      session: { store: storePath, idleMinutes: 999 },
    } as OpenClawConfig;

    const result = await initSessionState({
      ctx: {
        Body: "/new",
        RawBody: "/new",
        CommandBody: "/new",
        From: "user-archive",
        To: "bot",
        ChatType: "direct",
        SessionKey: sessionKey,
        Provider: "telegram",
        Surface: "telegram",
      },
      cfg,
      commandAuthorized: true,
    });

    expect(result.isNewSession).toBe(true);
    expect(result.resetTriggered).toBe(true);
    expect(result.sessionId).toBe(existingSessionId);
    const events = await loadTranscriptEvents({
      agentId: "main",
      sessionId: existingSessionId,
      sessionKey,
      storePath,
    });
    expect(events.map((event) => (event as { type?: unknown }).type)).toContain("reset");
    expect(
      events.findLast((event) => (event as { type?: unknown }).type === "reset"),
    ).toMatchObject({ reason: "new", firstKeptEntryId: expect.any(String) });
    const archived = (await fs.readdir(path.dirname(storePath))).filter((entry) =>
      entry.startsWith(`${existingSessionId}.jsonl.reset.`),
    );
    expect(archived).toHaveLength(0);
  });

  it("drains foreign work before appending a reply reset boundary", async () => {
    const storePath = await createStorePath("openclaw-rollover-admission-");
    const sessionKey = "agent:main:telegram:dm:rollover-admission";
    const existingSessionId = "session-before-admitted-rollover";
    const transcriptPath = path.join(path.dirname(storePath), `${existingSessionId}.jsonl`);
    await writeSessionStoreFast(storePath, {
      [sessionKey]: { sessionId: existingSessionId, updatedAt: Date.now() },
    });
    await fs.writeFile(transcriptPath, '{"type":"message"}\n', "utf8");

    let signalInterrupted = () => {};
    const interrupted = new Promise<void>((resolve) => {
      signalInterrupted = resolve;
    });
    const admission = await beginSessionWorkAdmission({
      scope: storePath,
      identities: [sessionKey, existingSessionId],
      assertAllowed: () => {},
      onInterrupt: signalInterrupted,
    });
    const initialization = initSessionState({
      ctx: {
        Body: "/new",
        RawBody: "/new",
        CommandBody: "/new",
        From: "user-rollover-admission",
        To: "bot",
        ChatType: "direct",
        SessionKey: sessionKey,
        Provider: "telegram",
        Surface: "telegram",
      },
      cfg: { session: { store: storePath, idleMinutes: 999 } } as OpenClawConfig,
      commandAuthorized: true,
    });

    try {
      await interrupted;
      // Foreign owners may need the writer lane to finalize before releasing.
      // The rollover must not hold that lane while it drains them.
      await runExclusiveSessionStoreWrite(storePath, async () => {});
      expect(readSessionStoreFast(storePath)[sessionKey]?.sessionId).toBe(existingSessionId);
      expect(await fs.stat(transcriptPath).catch(() => null)).not.toBeNull();

      admission.release();
      const result = await initialization;
      expect(result.sessionId).toBe(existingSessionId);
      expect(await fs.stat(transcriptPath).catch(() => null)).not.toBeNull();
    } finally {
      admission.release();
      await initialization.catch(() => {});
    }
  });

  it("keeps the initiating reply admission during an in-band rollover", async () => {
    const storePath = await createStorePath("openclaw-rollover-initiator-");
    const sessionKey = "agent:main:telegram:dm:rollover-initiator";
    const existingSessionId = "session-before-initiating-rollover";
    await writeSessionStoreFast(storePath, {
      [sessionKey]: { sessionId: existingSessionId, updatedAt: Date.now() },
    });
    const onInterrupt = vi.fn();
    const admission = await beginSessionWorkAdmission({
      scope: storePath,
      identities: [sessionKey, existingSessionId],
      assertAllowed: () => {},
      onInterrupt,
    });

    try {
      const result = await admission.run(
        async () =>
          await initSessionState({
            ctx: {
              Body: "/reset",
              RawBody: "/reset",
              CommandBody: "/reset",
              From: "user-rollover-initiator",
              To: "bot",
              ChatType: "direct",
              SessionKey: sessionKey,
              Provider: "telegram",
              Surface: "telegram",
            },
            cfg: { session: { store: storePath, idleMinutes: 999 } } as OpenClawConfig,
            commandAuthorized: true,
          }),
      );
      expect(result.sessionId).toBe(existingSessionId);
      expect(onInterrupt).not.toHaveBeenCalled();
    } finally {
      admission.release();
    }
  });

  it("cancels a competing admitted rollover without deadlocking the session", async () => {
    const storePath = await createStorePath("openclaw-rollover-contenders-");
    const sessionKey = "agent:main:telegram:dm:rollover-contenders";
    const existingSessionId = "session-before-competing-rollovers";
    await writeSessionStoreFast(storePath, {
      [sessionKey]: { sessionId: existingSessionId, updatedAt: Date.now() },
    });
    const controllers = [new AbortController(), new AbortController()];
    const admissions = await Promise.all(
      controllers.map(
        async (controller) =>
          await beginSessionWorkAdmission({
            scope: storePath,
            identities: [sessionKey, existingSessionId],
            assertAllowed: () => {},
            onInterrupt: () => controller.abort(new Error("competing rollover interrupted")),
          }),
      ),
    );
    const runRollover = async (index: number) => {
      const admission = expectDefined(admissions[index], "admissions[index] test invariant");
      const controller = expectDefined(controllers[index], "controllers[index] test invariant");
      try {
        return await admission.run(
          async () =>
            await initSessionState({
              ctx: {
                Body: "/new",
                RawBody: "/new",
                CommandBody: "/new",
                From: `user-rollover-contender-${index}`,
                To: "bot",
                ChatType: "direct",
                SessionKey: sessionKey,
                Provider: "telegram",
                Surface: "telegram",
              },
              cfg: { session: { store: storePath, idleMinutes: 999 } } as OpenClawConfig,
              commandAuthorized: true,
              signal: controller.signal,
            }),
        );
      } finally {
        admission.release();
      }
    };

    const outcomes = await Promise.allSettled([runRollover(0), runRollover(1)]);
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(1);
    expect(readSessionStoreFast(storePath)[sessionKey]?.sessionId).toBe(existingSessionId);
  });

  it.each([
    {
      name: "reuses a fresh replacement without interrupting its work",
      body: "continue",
      expectedInterruption: false,
    },
    {
      name: "reacquires a changed identity before an explicit reset",
      body: "/new",
      expectedInterruption: true,
    },
  ])("$name", async ({ body, expectedInterruption }) => {
    const storePath = await createStorePath("openclaw-rollover-revalidation-");
    const sessionKey = "agent:main:telegram:dm:rollover-revalidation";
    const staleSessionId = "stale-session-before-revalidation";
    const replacementSessionId = "fresh-replacement-before-revalidation";
    const postDrainSessionId = "replacement-created-during-drain";
    const finalGapSessionId = "replacement-created-before-destructive-write";
    await writeSessionStoreFast(storePath, {
      [sessionKey]: {
        sessionId: staleSessionId,
        updatedAt: Date.now() - 10 * 60_000,
      },
    });

    let replacementInterrupted = false;
    let replacementIdentityFenced = false;
    let postDrainIdentityFenced = false;
    let finalGapIdentityFenced = false;
    let postDrainAdmission: Awaited<ReturnType<typeof beginSessionWorkAdmission>> | undefined;
    let finalGapAdmission: Awaited<ReturnType<typeof beginSessionWorkAdmission>> | undefined;
    let postDrainFinalization = Promise.resolve();
    let finalGapRebind = Promise.resolve();
    let releaseReplacementAdmission = () => {};
    const replacementAdmission = await beginSessionWorkAdmission({
      scope: storePath,
      identities: [replacementSessionId],
      assertAllowed: () => {},
      onInterrupt: () => {
        replacementInterrupted = true;
        replacementIdentityFenced = isSessionLifecycleMutationActive(storePath, [
          replacementSessionId,
        ]);
        if (!expectedInterruption) {
          releaseReplacementAdmission();
          return;
        }
        postDrainFinalization = runExclusiveSessionStoreWrite(storePath, async () => {
          await writeSessionStoreFast(storePath, {
            [sessionKey]: { sessionId: postDrainSessionId, updatedAt: Date.now() },
          });
        })
          .then(async () => {
            let releasePostDrainAdmission = () => {};
            postDrainAdmission = await beginSessionWorkAdmission({
              scope: storePath,
              identities: [postDrainSessionId],
              assertAllowed: () => {},
              onInterrupt: () => {
                postDrainIdentityFenced = isSessionLifecycleMutationActive(storePath, [
                  postDrainSessionId,
                ]);
                releasePostDrainAdmission();
                finalGapRebind = runExclusiveSessionStoreWrite(storePath, async () => {
                  await writeSessionStoreFast(storePath, {
                    [sessionKey]: { sessionId: finalGapSessionId, updatedAt: Date.now() },
                  });
                  let releaseFinalGapAdmission = () => {};
                  finalGapAdmission = await beginSessionWorkAdmission({
                    scope: storePath,
                    identities: [finalGapSessionId],
                    assertAllowed: () => {},
                    onInterrupt: () => {
                      finalGapIdentityFenced = isSessionLifecycleMutationActive(storePath, [
                        finalGapSessionId,
                      ]);
                      releaseFinalGapAdmission();
                    },
                  });
                  releaseFinalGapAdmission = finalGapAdmission.release;
                });
              },
            });
            releasePostDrainAdmission = postDrainAdmission.release;
          })
          .finally(releaseReplacementAdmission);
      },
    });
    releaseReplacementAdmission = replacementAdmission.release;

    let signalMutationStarted = () => {};
    const mutationStarted = new Promise<void>((resolve) => {
      signalMutationStarted = resolve;
    });
    let releaseMutation = () => {};
    const mutationGate = new Promise<void>((resolve) => {
      releaseMutation = resolve;
    });
    const blockingMutation = runExclusiveSessionLifecycleMutation({
      scope: storePath,
      identities: [sessionKey, staleSessionId],
      run: async () => {
        signalMutationStarted();
        await mutationGate;
      },
    });
    await mutationStarted;

    let signalWriterStarted = () => {};
    const writerStarted = new Promise<void>((resolve) => {
      signalWriterStarted = resolve;
    });
    let releaseWriter = () => {};
    const writerGate = new Promise<void>((resolve) => {
      releaseWriter = resolve;
    });
    const blockingWriter = runExclusiveSessionStoreWrite(storePath, async () => {
      signalWriterStarted();
      await writerGate;
    });
    await writerStarted;

    const initialization = initSessionState({
      ctx: {
        Body: body,
        RawBody: body,
        CommandBody: body,
        From: "user-rollover-revalidation",
        To: "bot",
        ChatType: "direct",
        SessionKey: sessionKey,
        Provider: "telegram",
        Surface: "telegram",
      },
      cfg: {
        session: { store: storePath, reset: { mode: "idle", idleMinutes: 1 } },
      } as OpenClawConfig,
      commandAuthorized: true,
    });
    const replaceSession = runExclusiveSessionStoreWrite(storePath, async () => {
      await writeSessionStoreFast(storePath, {
        [sessionKey]: { sessionId: replacementSessionId, updatedAt: Date.now() },
      });
    });

    try {
      releaseWriter();
      await blockingWriter;
      await replaceSession;
      releaseMutation();
      await blockingMutation;

      const result = await initialization;
      await postDrainFinalization;
      await finalGapRebind;
      expect(replacementInterrupted).toBe(expectedInterruption);
      if (expectedInterruption) {
        expect(replacementIdentityFenced).toBe(true);
        expect(postDrainIdentityFenced).toBe(true);
        expect(finalGapIdentityFenced).toBe(true);
        expect(result.sessionId).toBe(finalGapSessionId);
      } else {
        expect(result.sessionId).toBe(replacementSessionId);
      }
    } finally {
      releaseWriter();
      releaseMutation();
      replacementAdmission.release();
      postDrainAdmission?.release();
      finalGapAdmission?.release();
      await Promise.allSettled([blockingWriter, replaceSession, blockingMutation, initialization]);
      await postDrainFinalization.catch(() => {});
      await finalGapRebind.catch(() => {});
    }
  });

  it("retains the transcript on daily/scheduled reset (stale session)", async () => {
    // Daily resets occur when the session becomes stale (not via /new or /reset command).
    // Previously, previousSessionEntry was only set when resetTriggered=true, leaving
    // old transcript files orphaned on disk. Refs #35481.
    vi.useFakeTimers();
    try {
      // Simulate: it is 5am, session was last active at 3am (before 4am daily boundary)
      vi.setSystemTime(new Date(2026, 0, 18, 5, 0, 0));
      const storePath = await createStorePath("openclaw-stale-archive-");
      const sessionKey = "agent:main:telegram:dm:archive-stale-user";
      const existingSessionId = "stale-session-to-be-archived";
      const transcriptPath = path.join(path.dirname(storePath), `${existingSessionId}.jsonl`);

      await writeSessionStoreFast(storePath, {
        [sessionKey]: {
          sessionId: existingSessionId,
          updatedAt: new Date(2026, 0, 18, 3, 0, 0).getTime(),
        },
      });
      await fs.writeFile(transcriptPath, '{"type":"message"}\n', "utf8");

      const cfg = {
        session: { store: storePath, reset: { mode: "daily", atHour: 4 } },
      } as OpenClawConfig;
      const result = await initSessionState({
        ctx: {
          Body: "hello",
          RawBody: "hello",
          CommandBody: "hello",
          From: "user-stale",
          To: "bot",
          ChatType: "direct",
          SessionKey: sessionKey,
          Provider: "telegram",
          Surface: "telegram",
        },
        cfg,
        commandAuthorized: true,
      });

      expect(result.isNewSession).toBe(true);
      expect(result.resetTriggered).toBe(false);
      expect(result.sessionId).toBe(existingSessionId);
      expect(await fs.stat(transcriptPath).catch(() => null)).not.toBeNull();
      const archived = (await fs.readdir(path.dirname(storePath))).filter((entry) =>
        entry.startsWith(`${existingSessionId}.jsonl.reset.`),
      );
      expect(archived).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("defers implicit daily rollover while the same session has an active run", async () => {
    vi.useFakeTimers();
    const existingSessionId = "active-stale-session";
    let operation: ReturnType<typeof replyRunRegistry.begin> | undefined;
    try {
      vi.setSystemTime(new Date(2026, 0, 18, 5, 0, 0));
      const storePath = await createStorePath("openclaw-active-stale-archive-");
      const sessionKey = "agent:main:telegram:dm:active-stale-user";
      const transcriptPath = path.join(path.dirname(storePath), `${existingSessionId}.jsonl`);
      const sessionStartedAt = new Date(2026, 0, 18, 3, 0, 0).getTime();

      await writeSessionStoreFast(storePath, {
        [sessionKey]: {
          sessionId: existingSessionId,
          updatedAt: sessionStartedAt,
          sessionStartedAt,
        },
      });
      await fs.writeFile(transcriptPath, '{"type":"message"}\n', "utf8");
      operation = replyRunRegistry.begin({
        sessionKey,
        sessionId: existingSessionId,
        resetTriggered: false,
      });
      operation.setPhase("running");

      const cfg = {
        session: { store: storePath, reset: { mode: "daily", atHour: 4 } },
      } as OpenClawConfig;
      const result = await initSessionState({
        ctx: {
          Body: "hello while active",
          RawBody: "hello while active",
          CommandBody: "hello while active",
          From: "user-active-stale",
          To: "bot",
          ChatType: "direct",
          SessionKey: sessionKey,
          Provider: "telegram",
          Surface: "telegram",
        },
        cfg,
        commandAuthorized: true,
      });

      expect(result.isNewSession).toBe(false);
      expect(result.resetTriggered).toBe(false);
      expect(result.sessionId).toBe(existingSessionId);
      expect(result.previousSessionEntry).toBeUndefined();
      expect(result.sessionEntry.sessionStartedAt).toBe(sessionStartedAt);
      expect(await fs.stat(transcriptPath).catch(() => null)).not.toBeNull();
      const archived = (await fs.readdir(path.dirname(storePath))).filter((entry) =>
        entry.startsWith(`${existingSessionId}.jsonl.reset.`),
      );
      expect(archived).toHaveLength(0);
    } finally {
      operation?.complete();
      vi.useRealTimers();
    }
  });

  it("does not defer stale boundary append for the current turn's queued reservation", async () => {
    vi.useFakeTimers();
    let operation: ReturnType<typeof replyRunRegistry.begin> | undefined;
    try {
      vi.setSystemTime(new Date(2026, 0, 18, 5, 0, 0));
      const storePath = await createStorePath("openclaw-queued-stale-archive-");
      const sessionKey = "agent:main:telegram:dm:queued-stale-user";
      const existingSessionId = "queued-stale-session";
      const transcriptPath = path.join(path.dirname(storePath), `${existingSessionId}.jsonl`);

      await writeSessionStoreFast(storePath, {
        [sessionKey]: {
          sessionId: existingSessionId,
          updatedAt: new Date(2026, 0, 18, 3, 0, 0).getTime(),
        },
      });
      await fs.writeFile(transcriptPath, '{"type":"message"}\n', "utf8");
      operation = replyRunRegistry.begin({
        sessionKey,
        sessionId: existingSessionId,
        resetTriggered: false,
      });

      const cfg = {
        session: { store: storePath, reset: { mode: "daily", atHour: 4 } },
      } as OpenClawConfig;
      const result = await initSessionState({
        ctx: {
          Body: "hello after boundary",
          RawBody: "hello after boundary",
          CommandBody: "hello after boundary",
          From: "user-queued-stale",
          To: "bot",
          ChatType: "direct",
          SessionKey: sessionKey,
          Provider: "telegram",
          Surface: "telegram",
        },
        cfg,
        commandAuthorized: true,
      });

      expect(operation.phase).toBe("queued");
      expect(result.isNewSession).toBe(true);
      expect(result.resetTriggered).toBe(false);
      expect(result.sessionId).toBe(existingSessionId);
      expect(result.previousSessionEntry?.sessionId).toBe(existingSessionId);
      expect(await fs.stat(transcriptPath).catch(() => null)).not.toBeNull();
      const archived = (await fs.readdir(path.dirname(storePath))).filter((entry) =>
        entry.startsWith(`${existingSessionId}.jsonl.reset.`),
      );
      expect(archived).toHaveLength(0);
    } finally {
      operation?.complete();
      vi.useRealTimers();
    }
  });

  it("does not defer stale boundary append for a different active session id", async () => {
    vi.useFakeTimers();
    let operation: ReturnType<typeof replyRunRegistry.begin> | undefined;
    try {
      vi.setSystemTime(new Date(2026, 0, 18, 5, 0, 0));
      const storePath = await createStorePath("openclaw-active-other-stale-archive-");
      const sessionKey = "agent:main:telegram:dm:active-other-stale-user";
      const existingSessionId = "inactive-stale-session";
      const transcriptPath = path.join(path.dirname(storePath), `${existingSessionId}.jsonl`);

      await writeSessionStoreFast(storePath, {
        [sessionKey]: {
          sessionId: existingSessionId,
          updatedAt: new Date(2026, 0, 18, 3, 0, 0).getTime(),
        },
      });
      await fs.writeFile(transcriptPath, '{"type":"message"}\n', "utf8");
      operation = replyRunRegistry.begin({
        sessionKey,
        sessionId: "different-active-session",
        resetTriggered: false,
      });
      operation.setPhase("running");

      const cfg = {
        session: { store: storePath, reset: { mode: "daily", atHour: 4 } },
      } as OpenClawConfig;
      const result = await initSessionState({
        ctx: {
          Body: "hello after boundary",
          RawBody: "hello after boundary",
          CommandBody: "hello after boundary",
          From: "user-active-other-stale",
          To: "bot",
          ChatType: "direct",
          SessionKey: sessionKey,
          Provider: "telegram",
          Surface: "telegram",
        },
        cfg,
        commandAuthorized: true,
      });

      expect(result.isNewSession).toBe(true);
      expect(result.resetTriggered).toBe(false);
      expect(result.sessionId).toBe(existingSessionId);
      expect(result.previousSessionEntry?.sessionId).toBe(existingSessionId);
      expect(await fs.stat(transcriptPath).catch(() => null)).not.toBeNull();
      const archived = (await fs.readdir(path.dirname(storePath))).filter((entry) =>
        entry.startsWith(`${existingSessionId}.jsonl.reset.`),
      );
      expect(archived).toHaveLength(0);
    } finally {
      operation?.complete();
      vi.useRealTimers();
    }
  });

  it("keeps provider-owned CLI sessions under the default no-reset policy", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date(2026, 0, 18, 5, 0, 0));
      const storePath = await createStorePath("openclaw-cli-implicit-reset-");
      const sessionKey = "agent:main:telegram:dm:claude-cli-user";
      const existingSessionId = "provider-owned-session";
      const transcriptPath = path.join(path.dirname(storePath), `${existingSessionId}.jsonl`);
      const cliBinding = {
        sessionId: "claude-session-1",
        authProfileId: "anthropic:claude-cli",
        mcpResumeHash: "mcp-resume-hash",
      };

      await writeSessionStoreFast(storePath, {
        [sessionKey]: {
          sessionId: existingSessionId,
          updatedAt: new Date(2026, 0, 18, 3, 0, 0).getTime(),
          modelProvider: "claude-cli",
          model: "claude-opus-4-6",
          cliSessionBindings: {
            "claude-cli": cliBinding,
          },
          cliSessionIds: {
            "claude-cli": cliBinding.sessionId,
          },
          claudeCliSessionId: cliBinding.sessionId,
        },
      });
      await fs.writeFile(transcriptPath, '{"type":"message"}\n', "utf8");

      const cfg = { session: { store: storePath } } as OpenClawConfig;
      const result = await initSessionState({
        ctx: {
          Body: "hello",
          RawBody: "hello",
          CommandBody: "hello",
          From: "claude-cli-user",
          To: "bot",
          ChatType: "direct",
          SessionKey: sessionKey,
          Provider: "telegram",
          Surface: "telegram",
        },
        cfg,
        commandAuthorized: true,
      });

      expect(result.isNewSession).toBe(false);
      expect(result.sessionId).toBe(existingSessionId);
      expect(result.sessionEntry.cliSessionBindings?.["claude-cli"]).toEqual(cliBinding);
      const transcriptStat = await fs.stat(transcriptPath).catch(() => null);
      if (!transcriptStat) {
        throw new Error("expected transcript file to remain after stale reset");
      }
      const archived = (await fs.readdir(path.dirname(storePath))).filter((entry) =>
        entry.startsWith(`${existingSessionId}.jsonl.reset.`),
      );
      expect(archived).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("honors explicit reset policies for provider-owned CLI sessions", async () => {
    const storePath = await createStorePath("openclaw-cli-explicit-reset-");
    const sessionKey = "agent:main:telegram:dm:claude-cli-explicit-user";
    const existingSessionId = "provider-owned-explicit-session";
    const cfg = {
      session: {
        store: storePath,
        reset: { mode: "idle", idleMinutes: 1 },
      },
    } as OpenClawConfig;

    await writeSessionStoreFast(storePath, {
      [sessionKey]: {
        sessionId: existingSessionId,
        updatedAt: Date.now() - 5 * 60_000,
        modelProvider: "claude-cli",
        cliSessionBindings: {
          "claude-cli": {
            sessionId: "claude-session-explicit",
          },
        },
      },
    });

    const result = await initSessionState({
      ctx: {
        Body: "hello",
        RawBody: "hello",
        CommandBody: "hello",
        From: "claude-cli-explicit-user",
        To: "bot",
        ChatType: "direct",
        SessionKey: sessionKey,
        Provider: "telegram",
        Surface: "telegram",
      },
      cfg,
      commandAuthorized: true,
    });

    expect(result.isNewSession).toBe(true);
    expect(result.sessionId).toBe(existingSessionId);
    expect(result.sessionEntry.cliSessionBindings).toBeUndefined();
  });

  it("disposes the previous bundle MCP runtime on session rollover", async () => {
    const storePath = await createStorePath("openclaw-stale-runtime-dispose-");
    const sessionKey = "agent:main:telegram:dm:runtime-stale-user";
    const existingSessionId = "stale-runtime-session";
    const cfg = {
      session: {
        store: storePath,
        reset: { mode: "idle", idleMinutes: 1 },
      },
    } as OpenClawConfig;

    await writeSessionStoreFast(storePath, {
      [sessionKey]: {
        sessionId: existingSessionId,
        updatedAt: Date.now() - 5 * 60_000,
      },
    });

    await getOrCreateSessionMcpRuntime({
      sessionId: existingSessionId,
      sessionKey,
      workspaceDir: path.dirname(storePath),
      cfg,
    });

    expect(sessionMcpTesting.getCachedSessionIds()).toContain(existingSessionId);

    await initSessionState({
      ctx: {
        Body: "hello",
        RawBody: "hello",
        CommandBody: "hello",
        From: "user-stale-runtime",
        To: "bot",
        ChatType: "direct",
        SessionKey: sessionKey,
        Provider: "telegram",
        Surface: "telegram",
      },
      cfg,
      commandAuthorized: true,
    });

    expect(sessionMcpTesting.getCachedSessionIds()).not.toContain(existingSessionId);
  });

  it("idle-based new session does NOT preserve overrides (no entry to read)", async () => {
    const storePath = await createStorePath("openclaw-idle-no-preserve-");
    const sessionKey = "agent:main:telegram:dm:new-user";

    const cfg = {
      session: { store: storePath, idleMinutes: 0 },
    } as OpenClawConfig;

    const result = await initSessionState({
      ctx: {
        Body: "hello",
        RawBody: "hello",
        CommandBody: "hello",
        From: "new-user",
        To: "bot",
        ChatType: "direct",
        SessionKey: sessionKey,
        Provider: "telegram",
        Surface: "telegram",
      },
      cfg,
      commandAuthorized: true,
    });

    expect(result.isNewSession).toBe(true);
    expect(result.resetTriggered).toBe(false);
    expect(result.sessionEntry.verboseLevel).toBeUndefined();
    expect(result.sessionEntry.thinkingLevel).toBeUndefined();
  });
});

describe("drainFormattedSystemEvents", () => {
  it("adds a local timestamp to queued system events by default", async () => {
    vi.useFakeTimers();
    try {
      const timestamp = new Date("2026-01-12T20:19:17Z");
      const expectedTimestamp = formatZonedTimestamp(timestamp, { displaySeconds: true });
      vi.setSystemTime(timestamp);

      enqueueSystemEvent("Model switched.", { sessionKey: "agent:main:main" });

      const result = await drainFormattedSystemEvents({
        cfg: {} as OpenClawConfig,
        sessionKey: "agent:main:main",
        isMainSession: true,
        isNewSession: false,
      });

      const expectedTimestampText = requireString(expectedTimestamp, "formatted timestamp");
      expect(result).toContain(`System: [${expectedTimestampText}] Model switched.`);
    } finally {
      resetSystemEventsForTest();
      vi.useRealTimers();
    }
  });

  it("keeps channel summary lines prefixed as trusted system output on new main sessions", async () => {
    channelSummaryMocks.buildChannelSummary.mockResolvedValue([
      "WhatsApp: linked\n  - default (line one\nline two)",
    ]);

    const result = await drainFormattedSystemEvents({
      cfg: { channels: {} } as OpenClawConfig,
      sessionKey: "agent:main:main",
      isMainSession: true,
      isNewSession: true,
    });

    expect(result).toContain("System: WhatsApp: linked");
    for (const line of result!.split("\n")) {
      expect(line).toMatch(/^System:/);
    }
  });

  it("leaves tagged cron events queued during heartbeat runs instead of re-rendering them (#44922)", async () => {
    try {
      // A `sessionTarget: "main"` cron systemEvent is enqueued tagged `cron:<jobId>`
      // and is surfaced by the heartbeat's dedicated reminder prompt. The generic
      // render must not also emit it as a raw `System:` line during that heartbeat
      // run, or the model sees the same text twice.
      enqueueSystemEvent("Reminder: rotate API keys", {
        sessionKey: "agent:main:main",
        contextKey: "cron:rotate-keys",
      });
      enqueueSystemEvent("Model switched.", { sessionKey: "agent:main:main" });

      const result = await drainFormattedSystemEvents({
        cfg: {} as OpenClawConfig,
        sessionKey: "agent:main:main",
        isMainSession: true,
        isNewSession: false,
        suppressHeartbeatOwnedEvents: true,
      });

      expect(result).toContain("Model switched.");
      expect(result).not.toContain("rotate API keys");
      // The cron event stays queued so the heartbeat path remains its single owner.
      expect(peekSystemEvents("agent:main:main")).toEqual(["Reminder: rotate API keys"]);
    } finally {
      resetSystemEventsForTest();
    }
  });

  it("renders tagged cron events on normal turns so skipped heartbeats still have a fallback", async () => {
    try {
      enqueueSystemEvent("Reminder: rotate API keys", {
        sessionKey: "agent:main:main",
        contextKey: "cron:rotate-keys",
      });

      const result = await drainFormattedSystemEvents({
        cfg: {} as OpenClawConfig,
        sessionKey: "agent:main:main",
        isMainSession: true,
        isNewSession: false,
      });

      expect(result).toContain("Reminder: rotate API keys");
      expect(peekSystemEvents("agent:main:main")).toEqual([]);
    } finally {
      resetSystemEventsForTest();
    }
  });
});

describe("persistSessionUsageUpdate", () => {
  async function seedSessionStore(
    storePath: string,
    sessionKey: string,
    entry: Record<string, unknown>,
  ) {
    await writeSessionStoreFast(storePath, { [sessionKey]: entry });
  }

  it("uses lastCallUsage for totalTokens when provided", async () => {
    const storePath = await createStorePath("openclaw-usage-");
    const sessionKey = "main";
    await seedSessionStore(storePath, sessionKey, {
      sessionId: "s1",
      updatedAt: Date.now(),
      totalTokens: 100_000,
    });

    const accumulatedUsage = { input: 180_000, output: 10_000, total: 190_000 };
    const lastCallUsage = { input: 12_000, output: 2_000, total: 14_000 };

    await persistSessionUsageUpdate({
      storePath,
      sessionKey,
      usage: accumulatedUsage,
      lastCallUsage,
      contextTokensUsed: 200_000,
    });

    const stored = readSessionStoreFast(storePath);
    expect(expectDefined(stored[sessionKey], "stored[sessionKey] test invariant").totalTokens).toBe(
      12_000,
    );
    expect(
      expectDefined(stored[sessionKey], "stored[sessionKey] test invariant").totalTokensFresh,
    ).toBe(true);
    expect(expectDefined(stored[sessionKey], "stored[sessionKey] test invariant").inputTokens).toBe(
      180_000,
    );
    expect(
      expectDefined(stored[sessionKey], "stored[sessionKey] test invariant").outputTokens,
    ).toBe(10_000);
  });

  it("keeps the prior total stale when last-call context is unavailable", async () => {
    const storePath = await createStorePath("openclaw-usage-unavailable-context-");
    const sessionKey = "main";
    await seedSessionStore(storePath, sessionKey, {
      sessionId: "s1",
      updatedAt: Date.now(),
      totalTokens: 148_874,
      totalTokensFresh: true,
    });

    await persistSessionUsageUpdate({
      storePath,
      sessionKey,
      usage: { input: 12, output: 15_104, cacheRead: 819_661, cacheWrite: 93_130 },
      lastCallUsage: {
        input: 12,
        output: 15_104,
        cacheRead: 819_661,
        cacheWrite: 93_130,
        contextUsage: { state: "unavailable" },
        total: 927_907,
      },
      contextTokensUsed: 200_000,
    });

    const stored = readSessionStoreFast(storePath);
    expect(expectDefined(stored[sessionKey], "stored[sessionKey] test invariant").totalTokens).toBe(
      148_874,
    );
    expect(
      expectDefined(stored[sessionKey], "stored[sessionKey] test invariant").totalTokensFresh,
    ).toBe(false);
    expect(expectDefined(stored[sessionKey], "stored[sessionKey] test invariant").inputTokens).toBe(
      12,
    );
    expect(expectDefined(stored[sessionKey], "stored[sessionKey] test invariant").cacheRead).toBe(
      819_661,
    );
  });

  it.each([
    {
      name: "marks a fresh zero stale when a completed run has no context snapshot",
      totalTokens: 0,
      preserve: false,
      expectedFresh: false,
    },
    {
      name: "preserves fresh post-compaction totalTokens across model-only updates",
      totalTokens: 42_000,
      preserve: true,
      expectedFresh: true,
    },
  ])("$name", async ({ totalTokens, preserve, expectedFresh }) => {
    const storePath = await createStorePath("openclaw-usage-no-snapshot-");
    const sessionKey = "main";
    await seedSessionStore(storePath, sessionKey, {
      sessionId: "s1",
      updatedAt: Date.now(),
      totalTokens,
      totalTokensFresh: true,
    });

    await persistSessionUsageUpdate({
      storePath,
      sessionKey,
      modelUsed: "claude-sonnet-4-6",
      contextTokensUsed: 200_000,
      preserveFreshTotalTokensOnStaleUsage: preserve,
    });

    const stored = expectDefined(readSessionStoreFast(storePath)[sessionKey], "stored session");
    expect(stored.totalTokens).toBe(totalTokens);
    expect(stored.totalTokensFresh).toBe(expectedFresh);
  });
  it("accounts exhausted-run usage without committing its model and persists CLI binding", async () => {
    const storePath = await createStorePath("openclaw-usage-exhausted-");
    const sessionKey = "main";
    await seedSessionStore(storePath, sessionKey, {
      sessionId: "s1",
      updatedAt: 1,
      modelProvider: "google",
      model: "gemini-3-pro",
      contextTokens: 1_000_000,
      cliSessionBindings: {
        "claude-cli": { sessionId: "existing-cli-session" },
      },
      cliSessionIds: {
        "claude-cli": "existing-cli-session",
      },
      claudeCliSessionId: "existing-cli-session",
    });

    await persistSessionUsageUpdate({
      storePath,
      sessionKey,
      usage: { input: 120, output: 8, total: 128 },
      lastCallUsage: { input: 100, output: 8, total: 108 },
      providerUsed: "claude-cli",
      modelUsed: "claude-sonnet-4-6",
      contextTokensUsed: 200_000,
      cliSessionBinding: { sessionId: "exhausted-cli-session" },
      preserveRuntimeModel: true,
    });

    const stored = readSessionStoreFast(storePath);
    expect(stored[sessionKey]).toMatchObject({
      modelProvider: "google",
      model: "gemini-3-pro",
      contextTokens: 1_000_000,
      inputTokens: 120,
      outputTokens: 8,
      totalTokens: 100,
      totalTokensFresh: true,
      cliSessionBindings: {
        "claude-cli": { sessionId: "exhausted-cli-session" },
      },
      cliSessionIds: {
        "claude-cli": "exhausted-cli-session",
      },
      claudeCliSessionId: "exhausted-cli-session",
    });
  });

  it("accounts goal usage when fresh token snapshots are persisted", async () => {
    const storePath = await createStorePath("openclaw-usage-goal-");
    const sessionKey = "main";
    await seedSessionStore(storePath, sessionKey, {
      sessionId: "s1",
      updatedAt: 1,
      goal: {
        schemaVersion: 1,
        id: "goal-1",
        objective: "ship",
        status: "active",
        createdAt: 1,
        updatedAt: 1,
        tokenStart: 0,
        tokenStartFresh: false,
        tokensUsed: 0,
        tokenBudget: 20,
        continuationTurns: 0,
      },
    });

    await persistSessionUsageUpdate({
      storePath,
      sessionKey,
      usage: { input: 100, output: 5, total: 105 },
      lastCallUsage: { input: 100, output: 5, total: 105 },
      contextTokensUsed: 200_000,
    });

    const stored1 = readSessionStoreFast(storePath);
    const storedEntry1 = stored1[sessionKey];
    expect(storedEntry1?.goal?.tokenStart).toBe(100);
    expect(storedEntry1?.goal?.tokenStartFresh).toBe(true);
    expect(storedEntry1?.goal?.tokensUsed).toBe(0);
    expect(storedEntry1?.goal?.status).toBe("active");

    await persistSessionUsageUpdate({
      storePath,
      sessionKey,
      usage: { input: 125, output: 5, total: 130 },
      lastCallUsage: { input: 125, output: 5, total: 130 },
      contextTokensUsed: 200_000,
    });

    const stored2 = readSessionStoreFast(storePath);
    const storedEntry2 = stored2[sessionKey];
    expect(storedEntry2?.goal?.tokenStart).toBe(100);
    expect(storedEntry2?.goal?.tokensUsed).toBe(25);
    expect(storedEntry2?.goal?.status).toBe("budget_limited");
  });

  it.each([
    {
      name: "uses lastCallUsage cache counters when available",
      seed: {},
      update: {
        usage: { input: 100_000, output: 8_000, cacheRead: 260_000, cacheWrite: 90_000 },
        lastCallUsage: { input: 12_000, output: 1_000, cacheRead: 18_000, cacheWrite: 4_000 },
      },
      expected: { inputTokens: 100_000, outputTokens: 8_000, cacheRead: 18_000, cacheWrite: 4_000 },
    },
    {
      name: "marks totalTokens as unknown when no fresh context snapshot is available",
      seed: {},
      update: { usage: { input: 50_000, output: 5_000, total: 55_000 } },
      expected: { totalTokens: undefined, totalTokensFresh: false },
    },
    {
      name: "preserves fresh post-compaction totalTokens across stale usage updates",
      seed: { totalTokens: 42_000, totalTokensFresh: true },
      update: {
        usage: { input: 50_000, output: 5_000, total: 55_000 },
        preserveFreshTotalTokensOnStaleUsage: true,
      },
      expected: { totalTokens: 42_000, totalTokensFresh: true },
    },
    {
      name: "marks older fresh totalTokens stale when no compaction preservation is requested",
      seed: { totalTokens: 42_000, totalTokensFresh: true },
      update: { usage: { input: 50_000, output: 5_000, total: 55_000 } },
      expected: { totalTokens: 42_000, totalTokensFresh: false },
    },
    {
      name: "uses promptTokens when available without lastCallUsage",
      seed: {},
      update: { usage: { input: 50_000, output: 5_000, total: 55_000 }, promptTokens: 42_000 },
      expected: { totalTokens: 42_000, totalTokensFresh: true },
    },
  ])("$name", async ({ seed, update, expected, name }) => {
    const storePath = await createStorePath("openclaw-usage-");
    const sessionKey = "main";
    await seedSessionStore(storePath, sessionKey, {
      sessionId: "s1",
      updatedAt: Date.now(),
      ...seed,
    });

    await persistSessionUsageUpdate({
      storePath,
      sessionKey,
      contextTokensUsed: 200_000,
      ...update,
    });

    expectEntryFields(
      expectDefined(readSessionStoreFast(storePath)[sessionKey], "stored session"),
      expected,
      name,
    );
  });
  it("treats CLI usage as a fresh context snapshot when requested", async () => {
    const storePath = await createStorePath("openclaw-usage-cli-");
    const sessionKey = "main";
    await seedSessionStore(storePath, sessionKey, { sessionId: "s1", updatedAt: Date.now() });

    await persistSessionUsageUpdate({
      storePath,
      sessionKey,
      usage: { input: 24_000, output: 2_000, cacheRead: 8_000 },
      usageIsContextSnapshot: true,
      providerUsed: "claude-cli",
      cliSessionBinding: {
        sessionId: "cli-session-1",
        authProfileId: "anthropic:default",
        extraSystemPromptHash: "prompt-hash",
        mcpConfigHash: "mcp-hash",
      },
      contextTokensUsed: 200_000,
    });

    const stored = readSessionStoreFast(storePath);
    expect(expectDefined(stored[sessionKey], "stored[sessionKey] test invariant").totalTokens).toBe(
      32_000,
    );
    expect(
      expectDefined(stored[sessionKey], "stored[sessionKey] test invariant").totalTokensFresh,
    ).toBe(true);
    expect(
      expectDefined(stored[sessionKey], "stored[sessionKey] test invariant").cliSessionIds?.[
        "claude-cli"
      ],
    ).toBe("cli-session-1");
    expect(
      expectDefined(stored[sessionKey], "stored[sessionKey] test invariant").cliSessionBindings?.[
        "claude-cli"
      ],
    ).toEqual({
      sessionId: "cli-session-1",
      authProfileId: "anthropic:default",
      extraSystemPromptHash: "prompt-hash",
      mcpConfigHash: "mcp-hash",
    });
  });

  it("clears stale CLI binding when usage update reports an unflushed replacement", async () => {
    const storePath = await createStorePath("openclaw-usage-cli-clear-");
    const sessionKey = "main";
    await seedSessionStore(storePath, sessionKey, {
      sessionId: "s1",
      updatedAt: Date.now(),
      cliSessionIds: {
        "claude-cli": "stale-cli-session",
        "codex-cli": "codex-session",
      },
      cliSessionBindings: {
        "claude-cli": {
          sessionId: "stale-cli-session",
          authProfileId: "anthropic:old",
        },
        "codex-cli": {
          sessionId: "codex-session",
        },
      },
      claudeCliSessionId: "stale-cli-session",
    });

    await persistSessionUsageUpdate({
      storePath,
      sessionKey,
      usage: { input: 24_000, output: 2_000, cacheRead: 8_000 },
      usageIsContextSnapshot: true,
      providerUsed: "claude-cli",
      clearCliSessionBinding: true,
      contextTokensUsed: 200_000,
    });

    const stored = readSessionStoreFast(storePath);
    expect(
      expectDefined(stored[sessionKey], "stored[sessionKey] test invariant").cliSessionIds?.[
        "claude-cli"
      ],
    ).toBeUndefined();
    expect(
      expectDefined(stored[sessionKey], "stored[sessionKey] test invariant").cliSessionIds?.[
        "codex-cli"
      ],
    ).toBe("codex-session");
    expect(
      expectDefined(stored[sessionKey], "stored[sessionKey] test invariant").cliSessionBindings?.[
        "claude-cli"
      ],
    ).toBeUndefined();
    expect(
      expectDefined(stored[sessionKey], "stored[sessionKey] test invariant").cliSessionBindings?.[
        "codex-cli"
      ],
    ).toEqual({
      sessionId: "codex-session",
    });
    expect(
      expectDefined(stored[sessionKey], "stored[sessionKey] test invariant").claudeCliSessionId,
    ).toBeUndefined();
  });

  it("prefers fresh final usage over zero compactionTokensAfter", async () => {
    const storePath = await createStorePath("openclaw-usage-compaction-reset-");
    const sessionKey = "main";
    await seedSessionStore(storePath, sessionKey, {
      sessionId: "s1",
      updatedAt: Date.now(),
      totalTokens: 1_794_391,
      totalTokensFresh: true,
      inputTokens: 20,
      outputTokens: 10_855,
      cacheRead: 1_761_324,
      cacheWrite: 33_047,
    });

    await persistSessionUsageUpdate({
      storePath,
      sessionKey,
      usage: { input: 20, output: 10_855, cacheRead: 1_761_324, cacheWrite: 33_047 },
      lastCallUsage: { input: 20, output: 10_855, cacheRead: 1_761_324, cacheWrite: 33_047 },
      usageIsContextSnapshot: true,
      providerUsed: "claude-cli",
      contextTokensUsed: 1_048_576,
      compactionTokensAfter: 0,
    });

    const stored = readSessionStoreFast(storePath);
    expect(expectDefined(stored[sessionKey], "stored[sessionKey] test invariant").totalTokens).toBe(
      1_794_391,
    );
    expect(
      expectDefined(stored[sessionKey], "stored[sessionKey] test invariant").totalTokensFresh,
    ).toBe(true);
    expect(expectDefined(stored[sessionKey], "stored[sessionKey] test invariant").inputTokens).toBe(
      20,
    );
    expect(
      expectDefined(stored[sessionKey], "stored[sessionKey] test invariant").outputTokens,
    ).toBe(10_855);
    expect(expectDefined(stored[sessionKey], "stored[sessionKey] test invariant").cacheRead).toBe(
      1_761_324,
    );
    expect(expectDefined(stored[sessionKey], "stored[sessionKey] test invariant").cacheWrite).toBe(
      33_047,
    );
  });

  it("prefers fresh lastCallUsage over positive compactionTokensAfter", async () => {
    const storePath = await createStorePath("openclaw-usage-compaction-positive-");
    const sessionKey = "main";
    await seedSessionStore(storePath, sessionKey, {
      sessionId: "s1",
      updatedAt: Date.now(),
      totalTokens: 180_000,
      totalTokensFresh: true,
    });

    await persistSessionUsageUpdate({
      storePath,
      sessionKey,
      usage: { input: 100_000, output: 3_000, cacheRead: 20_000 },
      lastCallUsage: { input: 91_000, output: 1_000, cacheRead: 4_000 },
      providerUsed: "openai",
      contextTokensUsed: 200_000,
      compactionTokensAfter: 80_000,
    });

    const stored = readSessionStoreFast(storePath);
    expect(expectDefined(stored[sessionKey], "stored[sessionKey] test invariant").totalTokens).toBe(
      95_000,
    );
    expect(
      expectDefined(stored[sessionKey], "stored[sessionKey] test invariant").totalTokensFresh,
    ).toBe(true);
    expect(expectDefined(stored[sessionKey], "stored[sessionKey] test invariant").inputTokens).toBe(
      100_000,
    );
    expect(
      expectDefined(stored[sessionKey], "stored[sessionKey] test invariant").outputTokens,
    ).toBe(3_000);
    expect(expectDefined(stored[sessionKey], "stored[sessionKey] test invariant").cacheRead).toBe(
      4_000,
    );
  });

  it("uses positive compactionTokensAfter when final usage has no prompt total", async () => {
    const storePath = await createStorePath("openclaw-usage-compaction-fallback-");
    const sessionKey = "main";
    await seedSessionStore(storePath, sessionKey, {
      sessionId: "s1",
      updatedAt: Date.now(),
      totalTokens: 180_000,
      totalTokensFresh: true,
      inputTokens: 5_000,
      outputTokens: 2_000,
      cacheRead: 50_000,
      contextBudgetStatus: {
        schemaVersion: 1,
        source: "pre-prompt-estimate",
        updatedAt: 1,
        provider: "claude-cli",
        model: "claude-opus-4-7",
        route: "compact_only",
        shouldCompact: true,
        estimatedPromptTokens: 180_000,
        contextTokenBudget: 1_048_576,
        promptBudgetBeforeReserve: 1_044_480,
        reserveTokens: 4_096,
        effectiveReserveTokens: 4_096,
        remainingPromptBudgetTokens: 864_480,
        overflowTokens: 0,
        toolResultReducibleChars: 0,
        messageCount: 0,
        unwindowedMessageCount: 0,
      },
    });

    await persistSessionUsageUpdate({
      storePath,
      sessionKey,
      usage: { output: 125 },
      lastCallUsage: { output: 125 },
      providerUsed: "claude-cli",
      compactionTokensAfter: 80_000,
    });

    const stored = readSessionStoreFast(storePath);
    expect(expectDefined(stored[sessionKey], "stored[sessionKey] test invariant").totalTokens).toBe(
      80_000,
    );
    expect(
      expectDefined(stored[sessionKey], "stored[sessionKey] test invariant").totalTokensFresh,
    ).toBe(true);
    expect(
      expectDefined(stored[sessionKey], "stored[sessionKey] test invariant").inputTokens,
    ).toBeUndefined();
    expect(
      expectDefined(stored[sessionKey], "stored[sessionKey] test invariant").outputTokens,
    ).toBeUndefined();
    expect(
      expectDefined(stored[sessionKey], "stored[sessionKey] test invariant").cacheRead,
    ).toBeUndefined();
    expect(
      expectDefined(stored[sessionKey], "stored[sessionKey] test invariant").contextBudgetStatus,
    ).toBeUndefined();
  });

  it("persists totalTokens from promptTokens when usage is unavailable", async () => {
    const storePath = await createStorePath("openclaw-usage-");
    const sessionKey = "main";
    await seedSessionStore(storePath, sessionKey, {
      sessionId: "s1",
      updatedAt: Date.now(),
      inputTokens: 1_234,
      outputTokens: 456,
    });

    await persistSessionUsageUpdate({
      storePath,
      sessionKey,
      usage: undefined,
      promptTokens: 39_000,
      contextTokensUsed: 200_000,
    });

    const stored = readSessionStoreFast(storePath);
    expect(expectDefined(stored[sessionKey], "stored[sessionKey] test invariant").totalTokens).toBe(
      39_000,
    );
    expect(
      expectDefined(stored[sessionKey], "stored[sessionKey] test invariant").totalTokensFresh,
    ).toBe(true);
    expect(expectDefined(stored[sessionKey], "stored[sessionKey] test invariant").inputTokens).toBe(
      1_234,
    );
    expect(
      expectDefined(stored[sessionKey], "stored[sessionKey] test invariant").outputTokens,
    ).toBe(456);
  });

  it("keeps non-clamped lastCallUsage totalTokens when exceeding context window", async () => {
    const storePath = await createStorePath("openclaw-usage-");
    const sessionKey = "main";
    await seedSessionStore(storePath, sessionKey, { sessionId: "s1", updatedAt: Date.now() });

    await persistSessionUsageUpdate({
      storePath,
      sessionKey,
      usage: { input: 300_000, output: 10_000, total: 310_000 },
      lastCallUsage: { input: 250_000, output: 5_000, total: 255_000 },
      contextTokensUsed: 200_000,
    });

    const stored = readSessionStoreFast(storePath);
    expect(expectDefined(stored[sessionKey], "stored[sessionKey] test invariant").totalTokens).toBe(
      250_000,
    );
    expect(
      expectDefined(stored[sessionKey], "stored[sessionKey] test invariant").totalTokensFresh,
    ).toBe(true);
  });

  it("snapshots estimatedCostUsd instead of accumulating (fixes #69347)", async () => {
    const storePath = await createStorePath("openclaw-usage-cost-");
    const sessionKey = "main";
    await seedSessionStore(storePath, sessionKey, {
      sessionId: "s1",
      updatedAt: Date.now(),
    });

    const cfg: OpenClawConfig = {
      models: {
        providers: {
          openai: {
            baseUrl: "https://api.openai.com/v1",
            models: [
              {
                id: "gpt-5.4",
                name: "GPT 5.4",
                reasoning: true,
                input: ["text"],
                cost: { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 0.5 },
                contextWindow: 200_000,
                maxTokens: 8_192,
              },
            ],
          },
        },
      },
    };

    // First persist: 2000 input + 500 output + 1000 cacheRead + 200 cacheWrite tokens
    // Cost = (2000*1.25 + 500*10 + 1000*0.125 + 200*0.5) / 1e6 = $0.007725
    await persistSessionUsageUpdate({
      storePath,
      sessionKey,
      cfg,
      usage: { input: 2_000, output: 500, cacheRead: 1_000, cacheWrite: 200 },
      lastCallUsage: { input: 800, output: 200, cacheRead: 300, cacheWrite: 50 },
      providerUsed: "openai",
      modelUsed: "gpt-5.4",
      contextTokensUsed: 200_000,
    });

    const stored1 = readSessionStoreFast(storePath);
    expect(
      expectDefined(stored1[sessionKey], "stored1[sessionKey] test invariant").estimatedCostUsd,
    ).toBeCloseTo(0.007725, 8);

    // Second persist with SAME cumulative usage (e.g., heartbeat or redundant persist)
    // Before fix: cost would accumulate to $0.0155 (2x)
    // After fix: cost stays $0.00775 (snapshotted)
    await persistSessionUsageUpdate({
      storePath,
      sessionKey,
      cfg,
      usage: { input: 2_000, output: 500, cacheRead: 1_000, cacheWrite: 200 },
      lastCallUsage: { input: 800, output: 200, cacheRead: 300, cacheWrite: 50 },
      providerUsed: "openai",
      modelUsed: "gpt-5.4",
      contextTokensUsed: 200_000,
    });

    const stored2 = readSessionStoreFast(storePath);
    // Cost should still be $0.007725, NOT $0.01545
    expect(
      expectDefined(stored2[sessionKey], "stored2[sessionKey] test invariant").estimatedCostUsd,
    ).toBeCloseTo(0.007725, 8);
  });

  it("preserves the displayed session model when heartbeat usage uses a heartbeat model", async () => {
    const storePath = await createStorePath("openclaw-usage-heartbeat-model-");
    const sessionKey = "main";
    await seedSessionStore(storePath, sessionKey, {
      sessionId: "s1",
      updatedAt: Date.now(),
      modelProvider: "openai",
      model: "gpt-5.4",
    });

    await persistSessionUsageUpdate({
      storePath,
      sessionKey,
      isHeartbeat: true,
      usage: { input: 1_200, output: 100, cacheRead: 300, cacheWrite: 10 },
      lastCallUsage: { input: 900, output: 80, cacheRead: 200, cacheWrite: 5 },
      providerUsed: "openai",
      modelUsed: "gpt-5.1-codex-mini",
      contextTokensUsed: 128_000,
    });

    const stored = readSessionStoreFast(storePath);
    expect(
      expectDefined(stored[sessionKey], "stored[sessionKey] test invariant").modelProvider,
    ).toBe("openai");
    expect(expectDefined(stored[sessionKey], "stored[sessionKey] test invariant").model).toBe(
      "gpt-5.4",
    );
    expect(expectDefined(stored[sessionKey], "stored[sessionKey] test invariant").inputTokens).toBe(
      1_200,
    );
    expect(
      expectDefined(stored[sessionKey], "stored[sessionKey] test invariant").outputTokens,
    ).toBe(100);
    expect(expectDefined(stored[sessionKey], "stored[sessionKey] test invariant").cacheRead).toBe(
      200,
    );
    expect(expectDefined(stored[sessionKey], "stored[sessionKey] test invariant").totalTokens).toBe(
      1_105,
    );
  });

  it("persists heartbeat CLI binding while preserving displayed session model", async () => {
    const storePath = await createStorePath("openclaw-usage-heartbeat-cli-binding-");
    const sessionKey = "main";
    await seedSessionStore(storePath, sessionKey, {
      sessionId: "s1",
      updatedAt: Date.now(),
      modelProvider: "openai",
      model: "gpt-5.4",
      cliSessionBindings: {
        "claude-cli": { sessionId: "old-heartbeat-cli-session" },
      },
      cliSessionIds: {
        "claude-cli": "old-heartbeat-cli-session",
      },
      claudeCliSessionId: "old-heartbeat-cli-session",
    });

    await persistSessionUsageUpdate({
      storePath,
      sessionKey,
      isHeartbeat: true,
      usage: { input: 1_200, output: 100 },
      usageIsContextSnapshot: true,
      providerUsed: "claude-cli",
      modelUsed: "claude-sonnet-4-6",
      cliSessionBinding: {
        sessionId: "new-heartbeat-cli-session",
        authProfileId: "anthropic:heartbeat",
      },
      contextTokensUsed: 128_000,
    });

    const stored = readSessionStoreFast(storePath);
    expect(
      expectDefined(stored[sessionKey], "stored[sessionKey] test invariant").modelProvider,
    ).toBe("openai");
    expect(expectDefined(stored[sessionKey], "stored[sessionKey] test invariant").model).toBe(
      "gpt-5.4",
    );
    expect(
      expectDefined(stored[sessionKey], "stored[sessionKey] test invariant").cliSessionIds?.[
        "claude-cli"
      ],
    ).toBe("new-heartbeat-cli-session");
    expect(
      expectDefined(stored[sessionKey], "stored[sessionKey] test invariant").cliSessionBindings?.[
        "claude-cli"
      ],
    ).toEqual({
      sessionId: "new-heartbeat-cli-session",
      authProfileId: "anthropic:heartbeat",
    });
    expect(
      expectDefined(stored[sessionKey], "stored[sessionKey] test invariant").claudeCliSessionId,
    ).toBe("new-heartbeat-cli-session");
  });

  it("honors heartbeat CLI binding clears while preserving displayed session model", async () => {
    const storePath = await createStorePath("openclaw-usage-heartbeat-cli-clear-");
    const sessionKey = "main";
    await seedSessionStore(storePath, sessionKey, {
      sessionId: "s1",
      updatedAt: Date.now(),
      modelProvider: "openai",
      model: "gpt-5.4",
      cliSessionIds: {
        "claude-cli": "old-heartbeat-cli-session",
        "codex-cli": "codex-cli-session",
      },
      cliSessionBindings: {
        "claude-cli": { sessionId: "old-heartbeat-cli-session" },
        "codex-cli": { sessionId: "codex-cli-session" },
      },
      claudeCliSessionId: "old-heartbeat-cli-session",
    });

    await persistSessionUsageUpdate({
      storePath,
      sessionKey,
      isHeartbeat: true,
      usage: { input: 1_200, output: 100 },
      usageIsContextSnapshot: true,
      providerUsed: "claude-cli",
      modelUsed: "claude-sonnet-4-6",
      clearCliSessionBinding: true,
      contextTokensUsed: 128_000,
    });

    const stored = readSessionStoreFast(storePath);
    expect(
      expectDefined(stored[sessionKey], "stored[sessionKey] test invariant").modelProvider,
    ).toBe("openai");
    expect(expectDefined(stored[sessionKey], "stored[sessionKey] test invariant").model).toBe(
      "gpt-5.4",
    );
    expect(
      expectDefined(stored[sessionKey], "stored[sessionKey] test invariant").cliSessionIds?.[
        "claude-cli"
      ],
    ).toBeUndefined();
    expect(
      expectDefined(stored[sessionKey], "stored[sessionKey] test invariant").cliSessionIds?.[
        "codex-cli"
      ],
    ).toBe("codex-cli-session");
    expect(
      expectDefined(stored[sessionKey], "stored[sessionKey] test invariant").cliSessionBindings?.[
        "claude-cli"
      ],
    ).toBeUndefined();
    expect(
      expectDefined(stored[sessionKey], "stored[sessionKey] test invariant").cliSessionBindings?.[
        "codex-cli"
      ],
    ).toEqual({
      sessionId: "codex-cli-session",
    });
    expect(
      expectDefined(stored[sessionKey], "stored[sessionKey] test invariant").claudeCliSessionId,
    ).toBeUndefined();
  });

  it("preserves the displayed session model when an internal announce uses fallback", async () => {
    const storePath = await createStorePath("openclaw-usage-internal-announce-model-");
    const sessionKey = "agent:main:telegram:group:-1003871627242:topic:6823";
    await seedSessionStore(storePath, sessionKey, {
      sessionId: "s1",
      updatedAt: Date.now(),
      modelProvider: "openai",
      model: "gpt-5.5",
      contextTokens: 200_000,
      inputTokens: 1_234,
      outputTokens: 56,
      cacheRead: 7,
      cacheWrite: 8,
      totalTokens: 1_305,
      totalTokensFresh: true,
      estimatedCostUsd: 0.123,
      cliSessionIds: { "claude-cli": "visible-cli-session" },
      cliSessionBindings: {
        "claude-cli": {
          sessionId: "visible-cli-session",
          authProfileId: "anthropic:visible",
        },
      },
      claudeCliSessionId: "visible-cli-session",
    });

    await persistSessionUsageUpdate({
      storePath,
      sessionKey,
      preserveUserFacingSessionModelState: true,
      usage: { input: 39_908, output: 122, cacheRead: 0, cacheWrite: 0 },
      lastCallUsage: { input: 39_908, output: 122, cacheRead: 0, cacheWrite: 0 },
      providerUsed: "google",
      modelUsed: "gemini-2.5-flash",
      cliSessionId: "internal-cli-session",
      cliSessionBinding: {
        sessionId: "internal-cli-session",
        authProfileId: "anthropic:internal",
      },
      contextTokensUsed: 1_000_000,
    });
    await persistSessionUsageUpdate({
      storePath,
      sessionKey,
      preserveUserFacingSessionModelState: true,
      providerUsed: "claude-cli",
      modelUsed: "claude-sonnet-4-6",
      cliSessionId: "internal-cli-session-2",
      contextTokensUsed: 900_000,
    });

    const stored = readSessionStoreFast(storePath);
    expect(
      expectDefined(stored[sessionKey], "stored[sessionKey] test invariant").modelProvider,
    ).toBe("openai");
    expect(expectDefined(stored[sessionKey], "stored[sessionKey] test invariant").model).toBe(
      "gpt-5.5",
    );
    expect(
      expectDefined(stored[sessionKey], "stored[sessionKey] test invariant").contextTokens,
    ).toBe(200_000);
    expect(expectDefined(stored[sessionKey], "stored[sessionKey] test invariant").inputTokens).toBe(
      1_234,
    );
    expect(
      expectDefined(stored[sessionKey], "stored[sessionKey] test invariant").outputTokens,
    ).toBe(56);
    expect(expectDefined(stored[sessionKey], "stored[sessionKey] test invariant").cacheRead).toBe(
      7,
    );
    expect(expectDefined(stored[sessionKey], "stored[sessionKey] test invariant").cacheWrite).toBe(
      8,
    );
    expect(expectDefined(stored[sessionKey], "stored[sessionKey] test invariant").totalTokens).toBe(
      1_305,
    );
    expect(
      expectDefined(stored[sessionKey], "stored[sessionKey] test invariant").totalTokensFresh,
    ).toBe(true);
    expect(
      expectDefined(stored[sessionKey], "stored[sessionKey] test invariant").estimatedCostUsd,
    ).toBe(0.123);
    expect(
      expectDefined(stored[sessionKey], "stored[sessionKey] test invariant").cliSessionIds?.[
        "claude-cli"
      ],
    ).toBe("visible-cli-session");
    expect(
      expectDefined(stored[sessionKey], "stored[sessionKey] test invariant").cliSessionBindings?.[
        "claude-cli"
      ],
    ).toEqual({
      sessionId: "visible-cli-session",
      authProfileId: "anthropic:visible",
    });
    expect(
      expectDefined(stored[sessionKey], "stored[sessionKey] test invariant").claudeCliSessionId,
    ).toBe("visible-cli-session");
  });

  it("persists zero estimatedCostUsd for free priced models", async () => {
    const storePath = await createStorePath("openclaw-usage-free-cost-");
    const sessionKey = "main";
    await seedSessionStore(storePath, sessionKey, {
      sessionId: "s1",
      updatedAt: Date.now(),
    });

    await persistSessionUsageUpdate({
      storePath,
      sessionKey,
      cfg: {
        models: {
          providers: {
            openai: {
              baseUrl: "https://api.openai.com/v1",
              models: [
                {
                  id: "gpt-5.3-codex-spark",
                  name: "GPT 5.3 Codex Spark",
                  reasoning: true,
                  input: ["text"],
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  contextWindow: 200_000,
                  maxTokens: 8_192,
                },
              ],
            },
          },
        },
      } satisfies OpenClawConfig,
      usage: { input: 5_107, output: 1_827, cacheRead: 1_536, cacheWrite: 0 },
      lastCallUsage: { input: 5_107, output: 1_827, cacheRead: 1_536, cacheWrite: 0 },
      providerUsed: "openai",
      modelUsed: "gpt-5.3-codex-spark",
      contextTokensUsed: 200_000,
    });

    const stored = readSessionStoreFast(storePath);
    expect(
      expectDefined(stored[sessionKey], "stored[sessionKey] test invariant").estimatedCostUsd,
    ).toBe(0);
  });
});

describe("initSessionState stale threadId fallback", () => {
  it("does not inherit lastThreadId from a previous thread interaction in non-thread sessions", async () => {
    const storePath = await createStorePath("stale-thread-");
    const cfg = { session: { store: storePath } } as OpenClawConfig;

    // First interaction: inside a DM topic (thread session)
    const threadResult = await initSessionState({
      ctx: {
        Body: "hello from topic",
        SessionKey: "agent:main:main:thread:42",
        MessageThreadId: 42,
      },
      cfg,
      commandAuthorized: true,
    });
    expect(threadResult.sessionEntry.lastThreadId).toBe(42);

    // Second interaction: plain DM (non-thread session), same store
    // The main session should NOT inherit threadId=42
    const mainResult = await initSessionState({
      ctx: {
        Body: "hello from DM",
        SessionKey: "agent:main:main",
      },
      cfg,
      commandAuthorized: true,
    });
    expect(mainResult.sessionEntry.lastThreadId).toBeUndefined();
    expect(mainResult.sessionEntry.deliveryContext?.threadId).toBeUndefined();
  });

  it("preserves explicit transport thread routing in non-thread sessions", async () => {
    const storePath = await createStorePath("transport-thread-");
    const cfg = { session: { store: storePath } } as OpenClawConfig;

    const result = await initSessionState({
      ctx: {
        Body: "reply from Slack DM thread",
        SessionKey: "agent:main:main",
        OriginatingChannel: "slack",
        OriginatingTo: "user:U1",
        AccountId: "default",
        TransportThreadId: "650.000",
      },
      cfg,
      commandAuthorized: true,
    });

    expect(result.sessionEntry.lastThreadId).toBe("650.000");
    expect(result.sessionEntry.deliveryContext?.threadId).toBe("650.000");
  });

  it("preserves lastThreadId within the same thread session", async () => {
    const storePath = await createStorePath("preserve-thread-");
    const cfg = { session: { store: storePath } } as OpenClawConfig;

    // First message in thread
    await initSessionState({
      ctx: {
        Body: "first",
        SessionKey: "agent:main:main:thread:99",
        MessageThreadId: 99,
      },
      cfg,
      commandAuthorized: true,
    });

    // Second message in same thread (MessageThreadId still present)
    const result = await initSessionState({
      ctx: {
        Body: "second",
        SessionKey: "agent:main:main:thread:99",
        MessageThreadId: 99,
      },
      cfg,
      commandAuthorized: true,
    });
    expect(result.sessionEntry.lastThreadId).toBe(99);
  });
});

describe("initSessionState dmScope delivery migration", () => {
  it.each([
    {
      name: "retires stale main-session delivery route when dmScope uses per-channel DM keys",
      legacyTo: "6101296751",
      expectRetired: true,
    },
    {
      name: "keeps legacy main-session delivery route when current DM target does not match",
      legacyTo: "1111",
      expectRetired: false,
    },
  ])("$name", async ({ legacyTo, expectRetired }) => {
    const storePath = await createStorePath("dm-scope-main-route-");
    await writeSessionStoreFast(storePath, {
      "agent:main:main": {
        sessionId: "legacy-main",
        updatedAt: Date.now(),
        lastChannel: "telegram",
        lastTo: legacyTo,
        lastAccountId: "default",
        deliveryContext: { channel: "telegram", to: legacyTo, accountId: "default" },
      },
    });
    const result = await initSessionState({
      ctx: {
        Body: "hello",
        SessionKey: "agent:main:telegram:direct:6101296751",
        OriginatingChannel: "telegram",
        OriginatingTo: "6101296751",
        AccountId: "default",
      },
      cfg: {
        session: { store: storePath, dmScope: "per-channel-peer" },
      } as OpenClawConfig,
      commandAuthorized: true,
    });

    const persisted = readSessionStoreFast(storePath);
    const legacy = persisted["agent:main:main"];
    if (expectRetired) {
      expect(result.sessionKey).toBe("agent:main:telegram:direct:6101296751");
      expect(legacy?.sessionId).toBe("legacy-main");
      expect(legacy?.route).toBeUndefined();
      expect(legacy?.deliveryContext).toBeUndefined();
      expect(legacy?.lastChannel).toBeUndefined();
      expect(legacy?.lastTo).toBeUndefined();
      expect(persisted[result.sessionKey]?.deliveryContext?.to).toBe("6101296751");
    } else {
      expect(legacy?.deliveryContext).toEqual({
        channel: "telegram",
        to: legacyTo,
        accountId: "default",
      });
      expect(legacy?.lastTo).toBe(legacyTo);
    }
  });
});
describe("initSessionState internal channel routing preservation", () => {
  it("clears stale thread routing on non-thread system-event sessions", async () => {
    const storePath = await createStorePath("system-event-clears-stale-thread-");
    const sessionKey = "agent:main:mattermost:channel:chan1";
    await writeSessionStoreFast(storePath, {
      [sessionKey]: {
        sessionId: "sess-system-event-stale-thread",
        updatedAt: Date.now(),
        lastChannel: "mattermost",
        lastTo: "channel:CHAN1",
        lastAccountId: "default",
        lastThreadId: "stale-root",
        deliveryContext: {
          channel: "mattermost",
          to: "channel:CHAN1",
          accountId: "default",
          threadId: "stale-root",
        },
        route: {
          channel: "mattermost",
          accountId: "default",
          target: { to: "channel:CHAN1" },
          thread: { id: "stale-root", kind: "thread", source: "session" },
        },
        origin: {
          provider: "mattermost",
          to: "channel:CHAN1",
          accountId: "default",
          threadId: "stale-root",
        },
      },
    });
    const cfg = { session: { store: storePath } } as OpenClawConfig;

    const result = await initSessionState({
      ctx: {
        Body: "heartbeat tick",
        SessionKey: sessionKey,
        Provider: "heartbeat",
        From: "heartbeat",
        To: "heartbeat",
      },
      cfg,
      commandAuthorized: true,
    });

    expect(result.sessionEntry.lastChannel).toBe("mattermost");
    expect(result.sessionEntry.lastTo).toBe("channel:CHAN1");
    expect(result.sessionEntry.lastThreadId).toBeUndefined();
    expect(result.sessionEntry.deliveryContext).toEqual({
      channel: "mattermost",
      to: "channel:CHAN1",
      accountId: "default",
    });
    expect(result.sessionEntry.route).toEqual({
      channel: "mattermost",
      accountId: "default",
      target: { to: "channel:CHAN1" },
    });
    expect(result.sessionEntry.origin).toEqual({
      provider: "mattermost",
      to: "channel:CHAN1",
      accountId: "default",
    });

    const persisted = readSessionStoreFast(storePath);
    expect(persisted[sessionKey]?.lastThreadId).toBeUndefined();
    expect(persisted[sessionKey]?.deliveryContext).toEqual({
      channel: "mattermost",
      to: "channel:CHAN1",
      accountId: "default",
    });
    expect(persisted[sessionKey]?.route).toEqual({
      channel: "mattermost",
      accountId: "default",
      target: { to: "channel:CHAN1" },
    });
    expect(persisted[sessionKey]?.origin).toEqual({
      provider: "mattermost",
      to: "channel:CHAN1",
      accountId: "default",
    });
  });

  it("does not synthesize heartbeat routing on a session with no external route", async () => {
    const storePath = await createStorePath("system-event-no-route-");
    const sessionKey = "agent:main:main";
    await writeSessionStoreFast(storePath, {
      [sessionKey]: {
        sessionId: "sess-system-event-no-route",
        updatedAt: Date.now(),
      },
    });
    const cfg = { session: { store: storePath } } as OpenClawConfig;

    const result = await initSessionState({
      ctx: {
        Body: "HEARTBEAT_OK",
        SessionKey: sessionKey,
        Provider: "heartbeat",
        From: "heartbeat",
        To: "heartbeat",
      },
      cfg,
      commandAuthorized: true,
    });

    expect(result.sessionEntry.lastChannel).toBeUndefined();
    expect(result.sessionEntry.lastTo).toBeUndefined();
    expect(result.sessionEntry.deliveryContext).toBeUndefined();
    expect(result.sessionEntry.origin).toBeUndefined();
  });

  it("preserves the existing user route when a heartbeat targets a different chat on the shared session", async () => {
    const storePath = await createStorePath("system-event-preserve-user-route-");
    const sessionKey = "agent:main:main";
    await writeSessionStoreFast(storePath, {
      [sessionKey]: {
        sessionId: "sess-system-event-shared",
        updatedAt: Date.now(),
        lastChannel: "feishu",
        lastTo: "user:ou_sender_1",
        deliveryContext: {
          channel: "feishu",
          to: "user:ou_sender_1",
          accountId: "default",
        },
        origin: {
          provider: "feishu",
          from: "user:ou_sender_1",
          to: "user:ou_sender_1",
          accountId: "default",
        },
      },
    });
    const cfg = { session: { store: storePath } } as OpenClawConfig;

    const result = await initSessionState({
      ctx: {
        Body: "heartbeat tick",
        SessionKey: sessionKey,
        Provider: "heartbeat",
        From: "chat:oc_group_chat",
        To: "chat:oc_group_chat",
        OriginatingChannel: "feishu",
        OriginatingTo: "chat:oc_group_chat",
        AccountId: "default",
      },
      cfg,
      commandAuthorized: true,
    });

    expect(result.sessionEntry.lastChannel).toBe("feishu");
    expect(result.sessionEntry.lastTo).toBe("user:ou_sender_1");
    expect(result.sessionEntry.deliveryContext).toEqual({
      channel: "feishu",
      to: "user:ou_sender_1",
      accountId: "default",
    });
    expect(result.sessionEntry.origin).toEqual({
      provider: "feishu",
      from: "user:ou_sender_1",
      to: "user:ou_sender_1",
      accountId: "default",
    });
  });

  it.each([
    {
      name: "keeps persisted external lastChannel when OriginatingChannel is internal webchat",
      prefix: "preserve-external-channel-",
      sessionKey: "agent:main:telegram:group:12345",
      seed: { lastChannel: "telegram", lastTo: "group:12345" },
      ctx: {
        Body: "internal follow-up",
        OriginatingChannel: "webchat",
        OriginatingTo: "session:dashboard",
      },
      expected: { lastChannel: "telegram", lastTo: "group:12345" },
      expectedDelivery: { channel: "telegram", to: "group:12345" },
    },
    {
      name: "preserves persisted external route when webchat views a channel-peer session (fixes #47745)",
      prefix: "webchat-direct-route-preserve-",
      sessionKey: "agent:main:imessage:direct:+1555",
      seed: { lastChannel: "imessage", lastTo: "+1555" },
      session: { dmScope: "per-channel-peer" as const },
      ctx: {
        Body: "reply from control ui",
        OriginatingChannel: "webchat",
        OriginatingTo: "session:dashboard",
        Surface: "webchat",
      },
      expected: { lastChannel: "imessage", lastTo: "+1555" },
      expectedDelivery: { channel: "imessage", to: "+1555" },
    },
    {
      name: "lets direct webchat turns own routing for sessions with no prior external route",
      prefix: "webchat-direct-route-noext-",
      sessionKey: "agent:main:main",
      seed: {},
      session: { dmScope: "per-channel-peer" as const },
      ctx: {
        Body: "reply from control ui",
        OriginatingChannel: "webchat",
        OriginatingTo: "session:dashboard",
        Surface: "webchat",
      },
      expected: { delivery: { kind: "internal" } },
    },
    {
      name: "keeps persisted external route when OriginatingChannel is non-deliverable",
      prefix: "preserve-nondeliverable-route-",
      sessionKey: "agent:main:discord:channel:24680",
      seed: { lastChannel: "discord", lastTo: "channel:24680" },
      ctx: {
        Body: "internal handoff",
        OriginatingChannel: "sessions_send",
        OriginatingTo: "session:handoff",
      },
      expected: { lastChannel: "discord", lastTo: "channel:24680" },
      expectedDelivery: { channel: "discord", to: "channel:24680" },
    },
    {
      name: "uses session key channel hint when first turn is internal webchat",
      prefix: "session-key-channel-hint-",
      sessionKey: "agent:main:telegram:group:98765",
      ctx: { Body: "hello", OriginatingChannel: "webchat" },
      expected: { lastChannel: "telegram" },
      expectedDelivery: { channel: "telegram" },
    },
    {
      name: "keeps internal route when there is no persisted external fallback",
      prefix: "no-external-fallback-",
      sessionKey: "agent:main:main",
      ctx: {
        Body: "handoff only",
        OriginatingChannel: "sessions_send",
        OriginatingTo: "session:handoff",
      },
      expected: { delivery: { kind: "internal" } },
    },
    {
      name: "keeps webchat channel for webchat/main sessions",
      prefix: "preserve-webchat-main-",
      sessionKey: "agent:main:main",
      ctx: { Body: "hello", OriginatingChannel: "webchat" },
      expected: { delivery: { kind: "internal" } },
    },
    {
      name: "preserves external route for main session when webchat accesses without destination (fixes #47745)",
      prefix: "webchat-main-preserve-external-",
      sessionKey: "agent:main:main",
      seed: { lastChannel: "whatsapp", lastTo: "+15555550123" },
      ctx: { Body: "webchat follow-up", OriginatingChannel: "webchat" },
      expected: { lastChannel: "whatsapp", lastTo: "+15555550123" },
    },
    {
      name: "preserves external route for main session when webchat sends with destination (fixes #47745)",
      prefix: "preserve-main-external-webchat-send-",
      sessionKey: "agent:main:main",
      seed: { lastChannel: "whatsapp", lastTo: "+15555550123" },
      ctx: {
        Body: "reply only here",
        OriginatingChannel: "webchat",
        OriginatingTo: "session:webchat-main",
      },
      expected: { lastChannel: "whatsapp", lastTo: "+15555550123" },
      expectedDelivery: { channel: "whatsapp", to: "+15555550123" },
    },
    {
      name: "uses the configured default account for persisted routing when AccountId is omitted",
      prefix: "default-account-routing-context-",
      sessionKey: "agent:main:discord:channel:24680",
      config: { channels: { discord: { defaultAccount: "work" } } },
      ctx: { Body: "hello", OriginatingChannel: "discord", OriginatingTo: "channel:24680" },
      expected: { lastAccountId: "work" },
      expectedDelivery: { accountId: "work" },
    },
  ])("$name", async (scenario) => {
    const storePath = await createStorePath(scenario.prefix);
    const seed = "seed" in scenario ? scenario.seed : undefined;
    if (seed) {
      await writeSessionStoreFast(storePath, {
        [scenario.sessionKey]: {
          sessionId: `session-${scenario.prefix}`,
          updatedAt: Date.now(),
          ...seed,
          ...("lastChannel" in seed
            ? { deliveryContext: { channel: seed.lastChannel, to: seed.lastTo } }
            : {}),
        },
      });
    }
    const result = await initSessionState({
      ctx: { SessionKey: scenario.sessionKey, ...scenario.ctx },
      cfg: {
        ...("config" in scenario ? scenario.config : {}),
        session: { store: storePath, ...("session" in scenario ? scenario.session : {}) },
      } as OpenClawConfig,
      commandAuthorized: true,
    });

    expectEntryFields(result.sessionEntry, scenario.expected, scenario.name);
    const expectedDelivery = "expectedDelivery" in scenario ? scenario.expectedDelivery : undefined;
    if (expectedDelivery) {
      expect(result.sessionEntry.deliveryContext, scenario.name).toMatchObject(expectedDelivery);
    }
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
