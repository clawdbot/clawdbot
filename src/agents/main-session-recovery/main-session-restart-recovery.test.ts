// Verifies restart recovery marks and resumes interrupted main-agent sessions.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GatewayClientRequestError } from "../../../packages/gateway-client/src/index.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import { createExecutionIdentityAdmissionToken } from "../../audit/execution-identity-admission.js";
import { resolveReplyRunDeliveryContext } from "../../auto-reply/reply/agent-runner-core.js";
import { markInboundContextLabel } from "../../auto-reply/reply/inbound-context-marker.js";
import type { ChannelOutboundAdapter } from "../../channels/plugins/types.public.js";
import type { CliDeps } from "../../cli/outbound-send-deps.js";
import type { OpenClawConfig } from "../../config/config.js";
import * as configSessions from "../../config/sessions.js";
import type { InternalSessionEntry as SessionEntry } from "../../config/sessions.js";
import * as sessionAccessor from "../../config/sessions/session-accessor.js";
import {
  appendTranscriptMessage,
  listSessionEntriesCore,
  loadSessionEntry as loadSessionEntryRaw,
  loadTranscriptEvents,
  replaceSessionEntry,
} from "../../config/sessions/session-accessor.js";
import { resolveAgentRestartRecoveryExecutionIdentityAdmission } from "../../gateway/agent-turn/agent-restart-recovery-context.js";
import { callGateway } from "../../gateway/call.js";
import type { RestartRecoveryCandidate } from "../../gateway/chat-abort.js";
import type { GatewayRecoveryRuntime } from "../../gateway/server-instance-runtime.types.js";
import { persistGatewaySessionLifecycleEvent } from "../../gateway/session-lifecycle-state.js";
import {
  getAgentEventLifecycleGeneration,
  resetAgentEventsForTest,
  rotateAgentEventLifecycleGeneration,
} from "../../infra/agent-events.js";
import { registerAgentRunContext } from "../../infra/agent-run-registry.js";
import {
  loadDeliveryQueueEntry,
  moveDeliveryQueueEntryToFailed,
  upsertDeliveryQueueEntry,
} from "../../infra/delivery-queue-sqlite.js";
import { OUTBOUND_DELIVERY_QUEUE_NAME } from "../../infra/outbound/delivery-queue-media-staging.js";
import { ackDelivery, enqueueDeliveryOnce } from "../../infra/outbound/delivery-queue-storage.js";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "../../plugins/hook-runner-global.js";
import { addTestHook } from "../../plugins/hooks.test-fixtures.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import {
  GatewayDrainingError,
  getActiveGatewayRootWorkCount,
  markGatewayRestartDraining,
  resetGatewayWorkAdmission,
  runWithGatewayIndependentRootWorkAdmission,
  tryBeginGatewaySuspendAdmission,
  tryBeginGatewayRootWorkAdmission,
} from "../../process/gateway-work-admission.js";
import {
  beginSessionWorkAdmission,
  consumeSessionWorkAdmissionHandoff,
  getSessionWorkAdmissionOwnerRelease,
  interruptSessionWorkAdmissions,
  isSessionLifecycleMutationActive,
  isSessionWorkAdmissionActive,
  runExclusiveSessionLifecycleMutation,
} from "../../sessions/session-lifecycle-admission.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { createOutboundTestPlugin, createTestRegistry } from "../../test-utils/channel-plugins.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { buildCurrentRunRestartRecoveryClaim } from "../agent-command-restart-recovery.js";
import { beginAgentDeletion } from "../agent-lifecycle-registry.js";
import { deliverAgentCommandResult } from "../command/delivery.js";
import { setActiveEmbeddedRunLifecycleGeneration } from "../embedded-agent-runner/run-state.js";
import {
  clearActiveEmbeddedRun,
  setActiveEmbeddedRun,
  type EmbeddedAgentQueueHandle,
} from "../embedded-agent-runner/runs.js";
import {
  INTERNAL_RUNTIME_CONTEXT_BEGIN,
  INTERNAL_RUNTIME_CONTEXT_END,
} from "../internal-runtime-context.js";
import { AGENT_RUN_RESTART_ABORT_ERROR_CODE } from "../run-termination.js";
import { SessionManager } from "../sessions/session-manager.js";
import {
  createAssistantToolCallMessage,
  createSessionEntry,
  createSessionStore,
  type SessionEntryFixture,
  expectRecord,
  mockCallArg,
  waitForFast,
} from "../subagent-test-fixtures.test-helpers.js";
import { MAIN_SESSION_RECOVERY_WORK_ADMISSION_OWNER } from "./main-session-recovery-admission.js";
import * as recoveryOwnerRelease from "./main-session-recovery-owner-release.js";
import {
  claimMainSessionRecoveryOwner,
  commitMainSessionRecovery,
} from "./main-session-recovery-store.js";
import { dispatchRestartRecoveryUntilStarted } from "./main-session-restart-dispatch-start.js";
import { resolveRestartRecoveryStorePaths } from "./main-session-restart-recovery-shared.js";
import { recoverStore } from "./main-session-restart-recovery-store.js";
import {
  markRestartAbortedMainSessions,
  markStartupOrphanedMainSessionsForRecovery,
  recoverRestartAbortedMainSessions as recoverRestartAbortedMainSessionsBase,
  retryRestartAbortedMainSessionRecovery as retryRestartAbortedMainSessionRecoveryBase,
  scheduleRestartAbortedMainSessionRecoveryAfterOwnerRelease,
  scheduleRestartAbortedMainSessionRecovery as scheduleRestartAbortedMainSessionRecoveryBase,
} from "./main-session-restart-recovery.js";

const transcriptMocks = vi.hoisted(() => ({
  appendAssistantMessageToSessionTranscript: vi.fn(),
}));
const discordDeliveryContext = {
  channel: "discord",
  to: "discord:dm:123",
} as const;
const executionIdentityEnabledConfig = {
  logging: { audit: { executionIdentity: true } },
} satisfies OpenClawConfig;

vi.mock("../../gateway/call.js", () => ({
  callGateway: vi.fn(async () => ({ runId: "run-resumed" })),
}));

const sendRecoveryNotice = vi.fn<GatewayRecoveryRuntime["sendRecoveryNotice"]>(async () => ({
  suppressed: false,
}));
const mockRecoveryRuntime = {
  abortAgent: vi.fn<GatewayRecoveryRuntime["abortAgent"]>(async () => ({ aborted: true })),
  dispatchAgent: async <T>(
    params: Record<string, unknown>,
    timeoutMs?: number,
    options?: Parameters<GatewayRecoveryRuntime["dispatchAgent"]>[2],
  ) => {
    const result = (await callGateway({ method: "agent", params, timeoutMs })) as T;
    const status = (result as { status?: unknown } | undefined)?.status;
    if (status === undefined) {
      options?.onAccepted?.(result);
      options?.onExecutionStarted?.();
    }
    return result;
  },
  waitForAgent: async <T>(params: Record<string, unknown>, timeoutMs?: number) =>
    (await callGateway({ method: "agent.wait", params, timeoutMs })) as T,
  sendRecoveryNotice,
};

type RecoveryParams<T extends { gatewayRuntime: unknown }> = Omit<T, "gatewayRuntime"> &
  Partial<Pick<T, "gatewayRuntime">>;

const recoverRestartAbortedMainSessions = (
  params: RecoveryParams<Parameters<typeof recoverRestartAbortedMainSessionsBase>[0]>,
) => recoverRestartAbortedMainSessionsBase({ gatewayRuntime: mockRecoveryRuntime, ...params });
const retryRestartAbortedMainSessionRecovery = (
  params: RecoveryParams<Parameters<typeof retryRestartAbortedMainSessionRecoveryBase>[0]>,
) => retryRestartAbortedMainSessionRecoveryBase({ gatewayRuntime: mockRecoveryRuntime, ...params });
const retryRestartAbortedMainSessionRecoveryAfterOwnerRelease =
  retryRestartAbortedMainSessionRecovery;
const scheduleRestartAbortedMainSessionRecovery = (
  params: RecoveryParams<Parameters<typeof scheduleRestartAbortedMainSessionRecoveryBase>[0]>,
) =>
  scheduleRestartAbortedMainSessionRecoveryBase({ gatewayRuntime: mockRecoveryRuntime, ...params });

async function expectRecovery(
  expected: { started: number; settled: number; failed: number; skipped: number },
  cfg?: Parameters<typeof recoverRestartAbortedMainSessions>[0]["cfg"],
): Promise<void> {
  const params = cfg === undefined ? { stateDir: tmpDir } : { cfg, stateDir: tmpDir };
  await expect(recoverRestartAbortedMainSessions(params)).resolves.toEqual(expected);
}

function gatewayParams(): Record<string, unknown> {
  return expectRecord(mockCallArg(callGateway).params, "gateway params");
}

vi.mock("../../config/sessions/transcript.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../config/sessions/transcript.js")>();
  transcriptMocks.appendAssistantMessageToSessionTranscript.mockImplementation(
    actual.appendAssistantMessageToSessionTranscript,
  );
  return {
    ...actual,
    appendAssistantMessageToSessionTranscript:
      transcriptMocks.appendAssistantMessageToSessionTranscript,
  };
});

let tmpDir: string;

function loadSessionEntry(
  scope: Parameters<typeof loadSessionEntryRaw>[0],
): SessionEntry | undefined {
  return loadSessionEntryRaw(scope) as SessionEntry | undefined;
}

beforeEach(async () => {
  vi.clearAllMocks();
  vi.mocked(callGateway).mockReset();
  vi.mocked(callGateway).mockImplementation(async () => ({ runId: "run-resumed" }));
  resetAgentEventsForTest();
  resetGatewayWorkAdmission();
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-main-restart-recovery-"));
});

afterEach(async () => {
  resetGatewayWorkAdmission();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

async function makeSessionsDir(agentId = "main"): Promise<string> {
  const sessionsDir = path.join(tmpDir, "agents", agentId, "sessions");
  await fs.mkdir(sessionsDir, { recursive: true });
  return sessionsDir;
}

async function writeStorePath(
  storePath: string,
  store: Record<string, SessionEntryFixture>,
): Promise<void> {
  await Promise.all(
    Object.entries(store).map(([sessionKey, entry]) =>
      replaceSessionEntry({ storePath, sessionKey }, createSessionEntry(entry)),
    ),
  );
}

async function writeStore(
  sessionsDir: string,
  store: Record<string, SessionEntryFixture>,
): Promise<void> {
  await writeStorePath(path.join(sessionsDir, "sessions.json"), store);
}

function mainSessionEntry(overrides: SessionEntryFixture = {}): SessionEntry {
  return createSessionEntry({
    sessionId: "main-session",
    updatedAt: Date.now() - 10_000,
    status: "running",
    abortedLastRun: true,
    ...overrides,
  });
}

function runningSessionEntry(sessionId: string, overrides: SessionEntryFixture = {}): SessionEntry {
  return createSessionEntry({
    sessionId,
    updatedAt: Date.now() - 10_000,
    status: "running",
    ...overrides,
  });
}

function activeRestartRun(
  sessionKey = "agent:main:main",
  sessionId = "main-session",
  overrides: Partial<RestartRecoveryCandidate> = {},
): RestartRecoveryCandidate {
  return {
    sessionKey,
    sessionId,
    runId: "restart-run",
    lifecycleGeneration: getAgentEventLifecycleGeneration(),
    ...overrides,
  };
}

function mainSessionStore(
  overrides: SessionEntryFixture = {},
  sessionKey = "agent:main:main",
): Record<string, SessionEntry> {
  return createSessionStore(mainSessionEntry(overrides), sessionKey);
}

async function makeMainSessionFixture(
  overrides: SessionEntryFixture & { agentId?: string; sessionKey?: string } = {},
): Promise<{ sessionsDir: string; storePath: string; sessionKey: string }> {
  const { agentId = "main", sessionKey = "agent:main:main", ...entry } = overrides;
  const sessionsDir = await makeSessionsDir(agentId);
  await writeMainSession({ sessionsDir, sessionKey, ...entry });
  return {
    sessionsDir,
    storePath: path.join(sessionsDir, "sessions.json"),
    sessionKey,
  };
}

function makePendingFinalDelivery(
  text = "interrupted response",
  overrides: Partial<NonNullable<SessionEntry["pendingFinalDelivery"]>> = {},
): NonNullable<SessionEntry["pendingFinalDelivery"]> {
  return {
    kind: "replayable",
    text,
    createdAt: Date.now(),
    intentId: "intent-prepared-default",
    deliveries: [{ id: "delivery-prepared-default", state: "prepared" }],
    ...overrides,
  };
}

function makeUserMessage(content = "do the thing", overrides: Record<string, unknown> = {}) {
  return { role: "user", content, ...overrides };
}

function makeToolResultMessage(content: unknown = "done", overrides: Record<string, unknown> = {}) {
  return { role: "toolResult", content, ...overrides };
}

function makeAssistantTextMessage(text: string, overrides: Record<string, unknown> = {}) {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    ...overrides,
  };
}

function makeMessageToolCall(
  toolCallId = "message-call-1",
  message = "delivered answer",
  overrides: Record<string, unknown> = {},
) {
  return createAssistantToolCallMessage([
    {
      type: "toolCall",
      id: toolCallId,
      name: "message",
      arguments: { action: "send", message },
      ...overrides,
    },
  ]);
}

function makeMessageToolResult(
  toolCallId = "message-call-1",
  overrides: Record<string, unknown> = {},
) {
  return makeToolResultMessage([{ type: "text", text: "sent" }], {
    toolCallId,
    toolName: "message",
    isError: false,
    ...overrides,
  });
}

function makeMessageDeliveryTranscript({
  beforeCall = [],
  content = "do the thing",
  message = "delivered answer",
  sourceRunId = "discord-message-1",
  toolCallId = "message-call-1",
  tail = [],
}: {
  beforeCall?: readonly unknown[];
  content?: string;
  message?: string;
  sourceRunId?: string;
  toolCallId?: string;
  tail?: readonly unknown[];
} = {}) {
  return [
    makeUserMessage(content, { idempotencyKey: sourceRunId }),
    ...beforeCall,
    makeMessageToolCall(toolCallId, message),
    ...tail,
  ];
}

function deliveredReceiptEntry(
  toolCallId = "message-call-1",
  sourceRunId = "discord-message-1",
): Partial<SessionEntry> {
  return {
    restartRecoveryDeliveryReceiptState: "delivered-terminal",
    restartRecoveryDeliveryToolCallId: toolCallId,
    restartRecoveryDeliveryRunId: "recovery-1",
    restartRecoveryDeliverySourceRunId: sourceRunId,
    restartRecoveryDeliveryContext: discordDeliveryContext,
  };
}

function makeDeliveredReceiptFixture(
  toolCallId = "message-call-1",
  sourceRunId = "discord-message-1",
  overrides: SessionEntryFixture = {},
) {
  return makeMainSessionFixture({
    sessionKey: "agent:main:discord:direct:123",
    ...deliveredReceiptEntry(toolCallId, sourceRunId),
    ...overrides,
  });
}

function makeControlUiRecoveryFixture(overrides: SessionEntryFixture = {}) {
  return makeMainSessionFixture({
    restartRecoveryDeliveryRequestFingerprint: "request-fingerprint",
    restartRecoveryDeliveryRunId: "control-ui-run",
    restartRecoveryDeliverySourceRunId: "control-ui-run",
    restartRecoverySourceIngress: "control-ui",
    ...overrides,
  });
}

async function writeMainSession({
  sessionsDir,
  sessionKey = "agent:main:main",
  ...entry
}: SessionEntryFixture & { sessionsDir: string; sessionKey?: string }): Promise<void> {
  await writeStore(sessionsDir, mainSessionStore(entry, sessionKey));
}

function readStore(storePath: string): Record<string, SessionEntry> {
  return Object.fromEntries(
    listSessionEntriesCore({ storePath }).map(({ sessionKey, entry }) => [sessionKey, entry]),
  );
}

async function writeTranscript(
  sessionsDir: string,
  sessionId: string,
  messages: readonly unknown[],
): Promise<void> {
  const storePath = path.join(sessionsDir, "sessions.json");
  const sessionKey = Object.entries(readStore(storePath)).find(
    ([, entry]) => entry.sessionId === sessionId,
  )?.[0];
  if (!sessionKey) {
    throw new Error(`expected session entry for transcript fixture: ${sessionId}`);
  }
  for (const message of messages) {
    await appendTranscriptMessage(
      { sessionId, sessionKey, storePath },
      {
        cwd: sessionsDir,
        message,
      },
    );
  }
}

async function writeMainSessionTranscript(
  messages: readonly unknown[],
  entry: SessionEntryFixture = {},
): Promise<string> {
  const sessionsDir = await makeSessionsDir();
  await writeMainSession({ sessionsDir, ...entry });
  await writeTranscript(sessionsDir, "main-session", messages);
  return sessionsDir;
}

async function writeCompletedToolTranscript(sessionsDir: string): Promise<void> {
  await writeTranscript(sessionsDir, "main-session", [
    makeUserMessage("run the tool"),
    { role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "exec" }] },
    makeToolResultMessage(),
  ]);
}

async function loadTestTranscript(
  sessionKey: string,
  storePath: string,
): Promise<Array<{ message?: Record<string, unknown> }>> {
  return (await loadTranscriptEvents({
    sessionId: "main-session",
    sessionKey,
    storePath,
  })) as Array<{ message?: Record<string, unknown> }>;
}

function codeModeCheckpointMessage(
  toolName: "exec" | "wait" = "wait",
  checkpoint: Record<string, unknown> = {
    status: "waiting",
    runId: "cm_interrupted",
    replaySafe: true,
  },
) {
  return {
    role: "toolResult",
    toolName,
    content: [
      {
        type: "text",
        text: JSON.stringify(checkpoint),
      },
    ],
  };
}

function codeModeWaitCallMessage() {
  return {
    role: "assistant",
    content: [
      {
        type: "toolCall",
        id: "call-wait-1",
        name: "wait",
        arguments: { runId: "cm_interrupted" },
      },
    ],
    stopReason: "toolUse",
  };
}

describe("main-session-restart-recovery", () => {
  it.each([
    { name: "stale same-id rows", keys: ["active"], live: true },
    { name: "cross-session run fences", keys: ["active", "sibling"], live: true },
    { name: "closed owners of running rows", keys: ["active"], live: false },
  ])("preserves exact restart identities against $name", async ({ keys, live }) => {
    const sessionsDir = await makeSessionsDir();
    const storePath = path.join(sessionsDir, "sessions.json");
    const sessionKeys = ["agent:main:active", "agent:main:sibling"];
    await writeStore(
      sessionsDir,
      Object.fromEntries(sessionKeys.map((key) => [key, runningSessionEntry("shared-session")])),
    );
    const activeRuns = keys.map((key) => ({
      runId: `run-${key}`,
      lifecycleGeneration: getAgentEventLifecycleGeneration(),
      sessionKey: `agent:main:${key}`,
      sessionId: "shared-session",
    }));
    for (const run of activeRuns) {
      registerAgentRunContext(run.runId, run);
    }
    let ownerActive = true;
    queueMicrotask(() => {
      ownerActive = live;
    });
    const result = await markRestartAbortedMainSessions({
      stateDir: tmpDir,
      activeRuns,
      isActiveRun: () => ownerActive,
    });
    expect(result).toEqual({ marked: live ? keys.length : 0, skipped: 0 });
    const store = readStore(storePath);
    for (const key of sessionKeys) {
      const expected = activeRuns.filter((run) => live && run.sessionKey === key);
      expect(store[key]?.abortedLastRun).toBe(expected.length > 0 ? true : undefined);
      expect(store[key]?.restartRecoveryRuns).toEqual(
        expected.length > 0
          ? expected.map(({ runId, lifecycleGeneration }) => ({ runId, lifecycleGeneration }))
          : undefined,
      );
    }
  });

  it("marks only recoverable sessions owned by active runs", async () => {
    // Only top-level running main sessions are restart-recoverable. Completed,
    // child, cron, and non-active sessions must not be marked.
    const sessionsDir = await makeSessionsDir();
    await writeStore(sessionsDir, {
      "agent:main:main": {
        ...runningSessionEntry("main-session"),
      },
      "agent:main:completed": {
        sessionId: "completed-session",
        updatedAt: Date.now() - 10_000,
        status: "done",
      },
      "agent:main:subagent:child": {
        ...runningSessionEntry("child-session"),
        spawnDepth: 1,
      },
      "cron:nightly": {
        ...runningSessionEntry("cron-session"),
      },
      "agent:main:other": {
        ...runningSessionEntry("other-session"),
      },
    });

    registerAgentRunContext("restart-run", {
      sessionKey: "agent:main:main",
      sessionId: "main-session",
    });
    registerAgentRunContext("key-only-run", {
      sessionKey: "agent:main:main",
    });
    registerAgentRunContext("stale-session-run", {
      sessionKey: "agent:main:main",
      sessionId: "stale-session",
    });
    const result = await markRestartAbortedMainSessions({
      stateDir: tmpDir,
      activeRuns: [
        activeRestartRun(),
        activeRestartRun("agent:main:subagent:child", "child-session"),
      ],
    });

    const store = readStore(path.join(sessionsDir, "sessions.json"));
    expect(result).toEqual({ marked: 1, skipped: 1 });
    expect(store["agent:main:main"]?.abortedLastRun).toBe(true);
    expect(store["agent:main:completed"]?.abortedLastRun).toBeUndefined();
    expect(store["agent:main:subagent:child"]?.abortedLastRun).toBeUndefined();
    expect(store["cron:nightly"]?.abortedLastRun).toBeUndefined();
    expect(store["agent:main:other"]?.abortedLastRun).toBeUndefined();
    const lifecycleGeneration = getAgentEventLifecycleGeneration();
    expect(store["agent:main:main"]?.restartRecoveryRuns).toEqual([
      { runId: "key-only-run", lifecycleGeneration },
      { runId: "restart-run", lifecycleGeneration },
    ]);
  });

  it.each<{
    name: string;
    identities: string[][];
    expected: string[];
    release?: boolean;
  }>([
    { name: "paired channel turn", identities: [["main", "session-main"]], expected: ["main"] },
    { name: "key-only channel turn", identities: [["main"]], expected: ["main"] },
    { name: "ID-only turn", identities: [["session-main"]], expected: ["main", "stale"] },
    {
      name: "crossed pairs from separate turns",
      identities: [
        ["main", "session-sibling"],
        ["sibling", "session-main"],
      ],
      expected: [],
    },
    { name: "stale paired ID", identities: [["main", "old-session"]], expected: [] },
    {
      name: "released channel turn",
      identities: [["main", "session-main"]],
      expected: [],
      release: true,
    },
  ])("recovers an admitted $name without a chat run", async ({ identities, expected, release }) => {
    const storePath = path.join(tmpDir, "admitted-channel", "sessions.json");
    const otherStorePath = path.join(tmpDir, "other-admitted-channel", "sessions.json");
    const key = (name: string) => `agent:main:${name}`;
    const entries = {
      [key("main")]: runningSessionEntry("session-main"),
      [key("sibling")]: runningSessionEntry("session-sibling"),
      [key("stale")]: runningSessionEntry("session-main"),
    };
    await writeStorePath(storePath, entries);
    await writeStorePath(otherStorePath, entries);
    const admissions = await Promise.all(
      identities.map((group) =>
        beginSessionWorkAdmission({
          scope: storePath,
          identities: group.map((identity) =>
            identity === "main" || identity === "sibling" ? key(identity) : identity,
          ),
          assertAllowed: () => undefined,
        }),
      ),
    );
    if (release) {
      queueMicrotask(() => admissions.forEach((admission) => admission.release()));
    }
    try {
      await expect(
        markRestartAbortedMainSessions({
          cfg: { session: { store: otherStorePath } },
          stateDir: tmpDir,
          activeRuns: [],
        }),
      ).resolves.toEqual({
        marked: expected.length,
        skipped: 0,
      });
      const store = readStore(storePath);
      for (const name of ["main", "sibling", "stale"]) {
        expect(store[key(name)]?.abortedLastRun).toBe(expected.includes(name) ? true : undefined);
        expect(store[key(name)]?.restartRecoveryForceSafeTools).toBe(
          expected.includes(name) ? true : undefined,
        );
        expect(readStore(otherStorePath)[key(name)]?.abortedLastRun).toBeUndefined();
      }
    } finally {
      admissions.forEach((admission) => admission.release());
    }
  });

  it("does not scan stale stores for agents absent from the configured roster", async () => {
    const configuredSessionsDir = await makeSessionsDir("main");
    await writeMainSession({ sessionsDir: configuredSessionsDir });
    const staleSessionsDir = await makeSessionsDir("amnesia-probe");
    await writeMainSession({
      sessionsDir: staleSessionsDir,
      sessionKey: "agent:amnesia-probe:main",
    });

    const cfg = {
      agents: { list: [{ id: "main", default: true }] },
    } as OpenClawConfig;
    const storePaths = await resolveRestartRecoveryStorePaths({ cfg, stateDir: tmpDir });

    expect(storePaths).toContain(path.join(configuredSessionsDir, "sessions.json"));
    expect(storePaths).not.toContain(path.join(staleSessionsDir, "sessions.json"));
  });

  it("marks an admitted custom-store turn after a deleted agent leaves its directory behind", async () => {
    await withEnvAsync({ OPENCLAW_STATE_DIR: tmpDir }, async () => {
      const staleSessionsDir = await makeSessionsDir("retired-probe");
      await writeMainSession({
        sessionsDir: staleSessionsDir,
        sessionKey: "agent:retired-probe:main",
      });
      closeOpenClawAgentDatabasesForTest();
      const deletion = beginAgentDeletion({
        agentId: "retired-probe",
        agentDir: path.join(tmpDir, "agents", "retired-probe", "agent"),
        workspaceDir: path.join(tmpDir, "workspace-retired-probe"),
        sessionsDir: staleSessionsDir,
        deleteFiles: false,
      });
      const storePath = path.join(tmpDir, "active-custom-store", "sessions.json");
      const sessionKey = "agent:main:custom";
      let admission: Awaited<ReturnType<typeof beginSessionWorkAdmission>> | undefined;
      try {
        await writeStorePath(storePath, {
          [sessionKey]: runningSessionEntry("custom-session"),
        });
        admission = await beginSessionWorkAdmission({
          scope: storePath,
          identities: [sessionKey, "custom-session"],
          assertAllowed: () => undefined,
        });

        await expect(
          markRestartAbortedMainSessions({
            cfg: { agents: { list: [{ id: "main", default: true }] } },
            stateDir: tmpDir,
            activeRuns: [],
          }),
        ).resolves.toEqual({ marked: 1, skipped: 0 });
        expect(loadSessionEntry({ sessionKey, storePath })).toMatchObject({
          sessionId: "custom-session",
          abortedLastRun: true,
          restartRecoveryForceSafeTools: true,
        });
      } finally {
        admission?.release();
        deletion.rollback();
        closeOpenClawAgentDatabasesForTest();
        closeOpenClawStateDatabaseForTest();
      }
    });
  });

  it("keeps a configured fixed store when its path carries a retired owner id", async () => {
    const sessionsDir = await makeSessionsDir("old");
    const storePath = path.join(sessionsDir, "sessions.json");
    await writeMainSession({ sessionsDir, sessionKey: "agent:old:main" });

    const cfg = {
      agents: { list: [{ id: "main", default: true }] },
      session: { store: storePath },
    } as OpenClawConfig;

    await expect(resolveRestartRecoveryStorePaths({ cfg, stateDir: tmpDir })).resolves.toContain(
      storePath,
    );
  });

  it("marks active sessions in a configured custom session store", async () => {
    const storePath = path.join(tmpDir, "custom", "sessions.json");
    await writeStorePath(storePath, {
      "agent:main:issue-82433": {
        ...runningSessionEntry("custom-session"),
      },
    });
    await writeTranscript(path.dirname(storePath), "custom-session", [
      { role: "user", content: "continue this custom-store turn" },
      { role: "toolResult", content: "custom result" },
    ]);

    const result = await markRestartAbortedMainSessions({
      cfg: { session: { store: storePath } },
      stateDir: tmpDir,
      activeRuns: [activeRestartRun("agent:main:issue-82433", "custom-session")],
    });

    const store = readStore(storePath);
    expect(result).toEqual({ marked: 1, skipped: 0 });
    expect(store["agent:main:issue-82433"]?.abortedLastRun).toBe(true);

    const recovery = await recoverRestartAbortedMainSessions({
      cfg: { session: { store: storePath } },
      stateDir: tmpDir,
    });

    expect(recovery).toEqual({ started: 1, settled: 0, failed: 0, skipped: 0 });
  });

  it("dispatches a bare fixed-store recovery under its persisted owner", async () => {
    const storePath = path.join(tmpDir, "shared", "sessions.json");
    await writeStorePath(storePath, {
      global: mainSessionEntry({
        pendingFinalDelivery: makePendingFinalDelivery(),
        restartRecoveryForceSafeTools: true,
      }),
    });
    const cfg = {
      agents: {
        ownership: "explicit",
        defaults: { sessionStore: { agentId: "ops" } },
        entries: { ops: {}, research: {} },
      },
      session: { scope: "global", store: storePath },
    } satisfies OpenClawConfig;

    await expect(
      recoverStore({
        cfg,
        gatewayRuntime: mockRecoveryRuntime,
        handledSessionKeys: new Set(),
        storePath,
      }),
    ).resolves.toEqual({ started: 1, settled: 0, failed: 0, skipped: 0 });
    expect(gatewayParams()).toMatchObject({ agentId: "ops", sessionKey: "global" });
  });

  it("dispatches a config-less bare recovery under the legacy implicit owner", async () => {
    const storePath = path.join(tmpDir, "legacy-shared", "sessions.json");
    await writeStorePath(storePath, {
      global: mainSessionEntry({
        pendingFinalDelivery: makePendingFinalDelivery(),
        restartRecoveryForceSafeTools: true,
      }),
    });

    await expect(
      recoverStore({
        gatewayRuntime: mockRecoveryRuntime,
        handledSessionKeys: new Set(),
        storePath,
      }),
    ).resolves.toEqual({ started: 1, settled: 0, failed: 0, skipped: 0 });
    expect(gatewayParams()).toMatchObject({ agentId: "main", sessionKey: "global" });
  });

  it("persists abort-registry runs after their event context was cleared", async () => {
    const sessionsDir = await makeSessionsDir();
    await writeMainSession({
      sessionsDir,
    });

    const result = await markRestartAbortedMainSessions({
      stateDir: tmpDir,
      activeRuns: [
        {
          runId: "cleared-context-run",
          lifecycleGeneration: "pre-restart",
          sessionKey: "agent:main:main",
          sessionId: "main-session",
        },
      ],
    });

    const store = readStore(path.join(sessionsDir, "sessions.json"));
    expect(result).toEqual({ marked: 1, skipped: 0 });
    expect(store["agent:main:main"]?.restartRecoveryRuns).toEqual([
      {
        runId: "cleared-context-run",
        lifecycleGeneration: "pre-restart",
      },
    ]);
  });

  it("marks queued abort-registry runs before lifecycle start changes session status", async () => {
    const sessionsDir = await makeSessionsDir();
    await writeStore(sessionsDir, {
      "agent:main:main": {
        sessionId: "main-session",
        updatedAt: Date.now() - 10_000,
        status: "done",
        startedAt: 1_000,
        endedAt: 2_000,
        runtimeMs: 1_000,
      },
    });

    const result = await markRestartAbortedMainSessions({
      stateDir: tmpDir,
      activeRuns: [
        {
          runId: "queued-run",
          lifecycleGeneration: "pre-restart",
          sessionKey: "agent:main:main",
          sessionId: "main-session",
        },
      ],
    });

    const store = readStore(path.join(sessionsDir, "sessions.json"));
    expect(result).toEqual({ marked: 1, skipped: 0 });
    expect(store["agent:main:main"]).toEqual(
      expect.objectContaining({
        status: "running",
        abortedLastRun: true,
        restartRecoveryRuns: [
          {
            runId: "queued-run",
            lifecycleGeneration: "pre-restart",
          },
        ],
      }),
    );
    expect(store["agent:main:main"]?.startedAt).toBeUndefined();
    expect(store["agent:main:main"]?.endedAt).toBeUndefined();
    expect(store["agent:main:main"]?.runtimeMs).toBeUndefined();
  });

  it.each([
    {
      name: "does not reopen a queued run that completed before store persistence",
      updatedAt: undefined,
      runId: "completed-run",
      observedAt: undefined,
      isActive: false,
      currentGeneration: false,
    },
    {
      name: "does not reopen a session completed after a failed terminal persistence candidate",
      updatedAt: 3_000,
      runId: "failed-persistence-run",
      observedAt: 2_000,
      isActive: true,
      currentGeneration: false,
    },
    {
      name: "does not reopen a terminal row written at the observed event timestamp",
      updatedAt: 2_000,
      runId: "just-persisted-run",
      observedAt: 2_000,
      isActive: true,
      currentGeneration: false,
    },
    {
      name: "does not reopen a completed session via current-generation maintenance-expired abort controller",
      updatedAt: 3_000,
      runId: "stale-abort-controller-run",
      observedAt: 5_000,
      isActive: true,
      currentGeneration: true,
    },
  ])("$name", async ({ updatedAt, runId, observedAt, isActive, currentGeneration }) => {
    const sessionsDir = await makeSessionsDir();
    await writeStore(sessionsDir, {
      "agent:main:main": createSessionEntry({
        sessionId: "main-session",
        updatedAt: updatedAt ?? Date.now() - 10_000,
        status: "done",
      }),
    });

    const result = await markRestartAbortedMainSessions({
      stateDir: tmpDir,
      activeRuns: [
        {
          runId,
          lifecycleGeneration: currentGeneration
            ? getAgentEventLifecycleGeneration()
            : "pre-restart",
          sessionKey: "agent:main:main",
          sessionId: "main-session",
          ...(observedAt === undefined ? {} : { observedAt }),
        },
      ],
      isActiveRun: () => isActive,
    });

    const store = readStore(path.join(sessionsDir, "sessions.json"));
    expect(result).toEqual({ marked: 0, skipped: 0 });
    expect(store["agent:main:main"]?.status).toBe("done");
    expect(store["agent:main:main"]?.restartRecoveryRuns).toBeUndefined();
  });

  it("preserves current-generation markers across repeated restart marking", async () => {
    const sessionsDir = await makeSessionsDir();
    const lifecycleGeneration = getAgentEventLifecycleGeneration();
    await writeMainSession({
      sessionsDir,
      restartRecoveryRuns: [
        {
          runId: "first-restart-run",
          lifecycleGeneration,
        },
      ],
    });

    await markRestartAbortedMainSessions({
      stateDir: tmpDir,
      activeRuns: [
        {
          runId: "second-restart-run",
          lifecycleGeneration,
          sessionKey: "agent:main:main",
          sessionId: "main-session",
        },
      ],
    });

    const store = readStore(path.join(sessionsDir, "sessions.json"));
    expect(store["agent:main:main"]?.restartRecoveryRuns).toEqual([
      {
        runId: "first-restart-run",
        lifecycleGeneration,
      },
      {
        runId: "second-restart-run",
        lifecycleGeneration,
      },
    ]);
  });

  it("replaces an older marker when the same run id is active after another restart", async () => {
    const sessionsDir = await makeSessionsDir();
    await writeMainSession({
      sessionsDir,
      restartRecoveryRuns: [
        {
          runId: "shared-run",
          lifecycleGeneration: "first-generation",
        },
      ],
    });

    await markRestartAbortedMainSessions({
      stateDir: tmpDir,
      activeRuns: [
        {
          runId: "shared-run",
          lifecycleGeneration: "second-generation",
          sessionKey: "agent:main:main",
          sessionId: "main-session",
        },
      ],
    });

    const store = readStore(path.join(sessionsDir, "sessions.json"));
    expect(store["agent:main:main"]?.restartRecoveryRuns).toEqual([
      {
        runId: "shared-run",
        lifecycleGeneration: "second-generation",
      },
    ]);
  });

  it("uses active pairs to avoid marking stale duplicate keys in another store", async () => {
    // Custom and default stores can contain the same session key. Active ids
    // keep restart marking tied to the store that owned the interrupted run.
    const defaultSessionsDir = await makeSessionsDir();
    await writeStore(defaultSessionsDir, {
      "agent:main:issue-82433": {
        ...runningSessionEntry("stale-default-session"),
      },
    });

    const storePath = path.join(tmpDir, "custom-duplicate-key", "sessions.json");
    await writeStorePath(storePath, {
      "agent:main:issue-82433": {
        ...runningSessionEntry("active-custom-session"),
      },
    });

    const result = await markRestartAbortedMainSessions({
      cfg: { session: { store: storePath } },
      stateDir: tmpDir,
      activeRuns: [activeRestartRun("agent:main:issue-82433", "active-custom-session")],
    });

    const defaultStore = readStore(path.join(defaultSessionsDir, "sessions.json"));
    const customStore = readStore(storePath);
    expect(result).toEqual({ marked: 1, skipped: 0 });
    expect(defaultStore["agent:main:issue-82433"]?.abortedLastRun).toBeUndefined();
    expect(customStore["agent:main:issue-82433"]?.abortedLastRun).toBe(true);
  });

  it("resumes marked sessions with a tool-result transcript tail", async () => {
    const sessionsDir = await makeSessionsDir();
    await writeStore(sessionsDir, mainSessionStore());
    await writeCompletedToolTranscript(sessionsDir);

    await expectRecovery({ started: 1, settled: 0, failed: 0, skipped: 0 });
    expect(callGateway).toHaveBeenCalledOnce();
    const resumeParams = gatewayParams() as Record<string, unknown>;
    expect(resumeParams.sessionKey).toBe("agent:main:main");
    expect(resumeParams.deliver).toBe(false);
    expect(resumeParams.lane).toBe("main");
    const store = readStore(path.join(sessionsDir, "sessions.json"));
    expect(store["agent:main:main"]?.abortedLastRun).toBe(false);
  });

  it("resumes when durable commentary is mirrored after the restart recovery mark", async () => {
    const sessionsDir = await makeSessionsDir();
    const sessionKey = "agent:main:main";
    await writeStore(sessionsDir, {
      [sessionKey]: runningSessionEntry("main-session"),
    });
    await writeTranscript(sessionsDir, "main-session", [
      { role: "user", content: "finish the interrupted long-running turn" },
    ]);

    await expect(
      markRestartAbortedMainSessions({
        stateDir: tmpDir,
        activeRuns: [activeRestartRun(sessionKey)],
        reason: "gateway restart drain",
      }),
    ).resolves.toEqual({ marked: 1, skipped: 0 });

    await writeTranscript(sessionsDir, "main-session", [
      {
        role: "assistant",
        content: [{ type: "text", text: "Checking the remaining background task." }],
        stopReason: "stop",
        openclawStreamFallback: {
          replacementText: "Checking the remaining background task.",
          source: "segment",
          itemId: "progress-after-recovery-mark",
        },
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "The restart handoff is in progress." }],
        stopReason: "stop",
        openclawStreamFallback: {
          replacementText: "The restart handoff is in progress.",
          source: "segment",
          itemId: "progress-after-recovery-mark-2",
        },
      },
    ]);

    await expectRecovery({ started: 1, settled: 0, failed: 0, skipped: 0 });
    expect(callGateway).toHaveBeenCalledOnce();
    expect(gatewayParams().sessionKey).toBe(sessionKey);
    expect(readStore(path.join(sessionsDir, "sessions.json"))[sessionKey]).toMatchObject({
      status: "running",
      abortedLastRun: false,
    });

    const transcript = await loadTestTranscript(
      sessionKey,
      path.join(sessionsDir, "sessions.json"),
    );
    expect(
      transcript
        .map((event) => event.message)
        .filter(
          (message) =>
            message?.role === "assistant" &&
            (message as { openclawStreamFallback?: { source?: unknown } }).openclawStreamFallback
              ?.source === "segment",
        ),
    ).toHaveLength(2);
  });

  it("resumes a drain-marked turn that settles normally before the replacement starts", async () => {
    const sessionsDir = await makeSessionsDir();
    const storePath = path.join(sessionsDir, "sessions.json");
    const sessionKey = "agent:main:main";
    const runId = "drain-overlap-run";
    const lifecycleGeneration = getAgentEventLifecycleGeneration();
    await writeStore(sessionsDir, {
      [sessionKey]: runningSessionEntry("main-session"),
    });
    await writeTranscript(sessionsDir, "main-session", [
      { role: "user", content: "finish the admitted work after the restart" },
    ]);

    const rootAdmission = tryBeginGatewayRootWorkAdmission();
    expect(rootAdmission).not.toBeNull();
    await rootAdmission?.run(async () => {
      await expect(
        markRestartAbortedMainSessions({
          stateDir: tmpDir,
          activeRuns: [{ runId, lifecycleGeneration, sessionKey, sessionId: "main-session" }],
          reason: "gateway restart drain",
        }),
      ).resolves.toEqual({ marked: 1, skipped: 0 });
      markGatewayRestartDraining();
      await expect(
        runWithGatewayIndependentRootWorkAdmission(async () => undefined),
      ).rejects.toBeInstanceOf(GatewayDrainingError);
      await writeTranscript(sessionsDir, "main-session", [
        {
          role: "toolResult",
          toolName: "sessions_spawn",
          isError: true,
          content: [{ type: "text", text: "Gateway restart admission is closed." }],
        },
        makeAssistantTextMessage("The Gateway is restarting; retry after it comes back."),
      ]);
      await withEnvAsync({ OPENCLAW_STATE_DIR: tmpDir }, async () => {
        await persistGatewaySessionLifecycleEvent({
          sessionKey,
          agentId: "main",
          event: {
            ts: Date.now(),
            sessionId: "main-session",
            runId,
            lifecycleGeneration,
            data: { phase: "end", stopReason: "stop" },
          },
        });
      });
    });
    rootAdmission?.release();

    expect(loadSessionEntry({ sessionKey, storePath })).toMatchObject({
      status: "running",
      abortedLastRun: true,
    });
    expect(loadSessionEntry({ sessionKey, storePath })?.restartRecoveryRuns).toBeUndefined();

    resetGatewayWorkAdmission();
    rotateAgentEventLifecycleGeneration();
    const recovery = scheduleRestartAbortedMainSessionRecovery({
      delayMs: 0,
      getConfig: () => ({}),
      maxRetries: 1,
      stateDir: tmpDir,
    });
    await waitForFast(() => expect(callGateway).toHaveBeenCalledOnce());
    await recovery.stop();

    expect(gatewayParams()).toMatchObject({
      expectedExistingSessionId: "main-session",
      inputProvenance: {
        kind: "internal_system",
        sourceSessionKey: sessionKey,
        sourceTool: "main_session_restart_recovery",
      },
      sessionKey,
    });
    expect(gatewayParams().idempotencyKey).not.toBe(runId);
  });

  it.each([
    {
      label: "same-process lifecycle rotation",
      sessionKey: "agent:main:telegram:group:-100:topic:2",
      sessionId: "topic-2-session",
      restartRecoveryRuns: [
        {
          runId: "announce:v1:agent:main:subagent:child:run-1",
          lifecycleGeneration: "generation-old",
        },
      ],
      userMessage: { role: "user", content: "earlier human request" },
    },
    {
      label: "full restart",
      sessionKey: "agent:main:telegram:group:-100:topic:8893",
      sessionId: "topic-8893-session",
      restartRecoveryRuns: undefined,
      userMessage: {
        role: "user",
        content: "A background task finished.",
        provenance: {
          kind: "inter_session",
          sourceSessionKey: "agent:main:subagent:child",
          sourceChannel: "internal",
          sourceTool: "subagent_announce",
        },
      },
    },
  ])("reconciles an interrupted completion after $label", async (fixture) => {
    const sessionsDir = await makeSessionsDir();
    const storePath = path.join(sessionsDir, "sessions.json");
    await writeStore(sessionsDir, {
      [fixture.sessionKey]: {
        sessionId: fixture.sessionId,
        updatedAt: Date.now() - 10_000,
        status: "running",
        abortedLastRun: true,
        restartRecoveryRuns: fixture.restartRecoveryRuns,
      },
    });
    await writeTranscript(sessionsDir, fixture.sessionId, [
      fixture.userMessage,
      { role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "exec" }] },
      { role: "toolResult", content: "done" },
    ]);

    await expectRecovery({ started: 0, settled: 0, failed: 0, skipped: 1 });
    expect(callGateway).not.toHaveBeenCalled();
    expect(loadSessionEntry({ sessionKey: fixture.sessionKey, storePath })).toMatchObject({
      status: "killed",
      abortedLastRun: false,
    });
    expect(readStore(storePath)[fixture.sessionKey]).not.toHaveProperty("restartRecoveryRuns");
  });

  it("resumes an explicit human run despite stale completion provenance", async () => {
    const sessionsDir = await makeSessionsDir();
    const sessionKey = "agent:main:telegram:group:-100:topic:41818";
    await writeStore(sessionsDir, {
      [sessionKey]: {
        ...runningSessionEntry("topic-41818-session"),
        abortedLastRun: true,
        restartRecoveryRuns: [{ runId: "human-run-2", lifecycleGeneration: "generation-old" }],
      },
    });
    await writeTranscript(sessionsDir, "topic-41818-session", [
      {
        role: "user",
        content: "A background task finished.",
        provenance: {
          kind: "inter_session",
          sourceSessionKey: "agent:main:subagent:child",
          sourceChannel: "internal",
          sourceTool: "subagent_announce",
        },
      },
      { role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "exec" }] },
      { role: "toolResult", content: "done" },
    ]);

    await expectRecovery({ started: 1, settled: 0, failed: 0, skipped: 0 });
    expect(callGateway).toHaveBeenCalledOnce();
    expect(gatewayParams().sessionKey).toBe(sessionKey);
  });

  it("retries when a human recovery run appears during announce reconciliation", async () => {
    const sessionsDir = await makeSessionsDir();
    const storePath = path.join(sessionsDir, "sessions.json");
    const sessionKey = "agent:main:telegram:group:-100:topic:41819";
    const announceRun = {
      runId: "announce:v1:agent:main:subagent:child:run-race",
      lifecycleGeneration: "generation-old",
    };
    const humanRun = { runId: "human-run-race", lifecycleGeneration: "generation-old" };
    await writeStore(sessionsDir, {
      [sessionKey]: {
        ...runningSessionEntry("topic-41819-session"),
        abortedLastRun: true,
        restartRecoveryRuns: [announceRun],
      },
    });
    await writeTranscript(sessionsDir, "topic-41819-session", [
      { role: "user", content: "earlier human request" },
      { role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "exec" }] },
      { role: "toolResult", content: "done" },
    ]);
    const updateSessionEntry = sessionAccessor.updateSessionEntry;
    let injectedHumanRun = false;
    const updateSpy = vi
      .spyOn(sessionAccessor, "updateSessionEntry")
      .mockImplementation(async (scope, update, options) => {
        if (!injectedHumanRun) {
          injectedHumanRun = true;
          await updateSessionEntry(scope, (entry) => ({
            restartRecoveryRuns: [...(entry.restartRecoveryRuns ?? []), humanRun],
          }));
        }
        return await updateSessionEntry(scope, update, options);
      });

    try {
      await expectRecovery({ started: 0, settled: 0, failed: 1, skipped: 0 });
    } finally {
      updateSpy.mockRestore();
    }

    expect(callGateway).not.toHaveBeenCalled();
    expect(loadSessionEntry({ sessionKey, storePath })).toMatchObject({
      status: "running",
      abortedLastRun: true,
      restartRecoveryRuns: [announceRun, humanRun],
    });
    await expectRecovery({ started: 1, settled: 0, failed: 0, skipped: 0 });
    expect(callGateway).toHaveBeenCalledOnce();
  });

  it.each([
    {
      label: "the interrupted run's exact route",
      sessionContext: {
        channel: "discord",
        to: "discord:dm:stale",
        accountId: "old",
      },
      recoveryContext: {
        channel: "discord",
        to: "discord:dm:123",
        accountId: "main",
        threadId: 123,
      },
    },
    {
      label: "an unclaimed session's persisted route",
      sessionContext: {
        channel: "discord",
        to: "discord:dm:123",
        accountId: "main",
        threadId: 123,
      },
      recoveryContext: undefined,
    },
  ])(
    "delivers resumed marked sessions through reply payload hooks using $label",
    async ({ sessionContext, recoveryContext }) => {
      const sessionsDir = await makeSessionsDir();
      const storePath = path.join(sessionsDir, "sessions.json");
      const deliveredText = vi.fn();
      const hookHandler = vi.fn(
        async (event: { payload: { text?: string } }, context: Record<string, unknown>) => ({
          payload: {
            ...event.payload,
            text: `hooked: ${event.payload.text ?? ""}`,
          },
          metadata: context,
        }),
      );
      const discordOutbound: ChannelOutboundAdapter = {
        deliveryMode: "direct",
        sendText: async ({ to, text }) => {
          deliveredText({ to, text });
          return { channel: "discord", messageId: "delivered-1" };
        },
      };
      const registry = createTestRegistry([
        {
          pluginId: "discord",
          source: "test",
          plugin: createOutboundTestPlugin({ id: "discord", outbound: discordOutbound }),
        },
      ]);
      addTestHook({
        registry,
        pluginId: "recovery-hook-test",
        hookName: "reply_payload_sending",
        handler: hookHandler,
      });
      resetGlobalHookRunner();
      initializeGlobalHookRunner(registry);
      setActivePluginRegistry(registry);
      const previousStateDir = process.env.OPENCLAW_STATE_DIR;
      process.env.OPENCLAW_STATE_DIR = tmpDir;

      await writeMainSession({
        sessionsDir,
        sessionKey: "agent:main:discord:direct:123",
        deliveryContext: sessionContext,
        restartRecoveryDeliveryContext: recoveryContext,
      });
      await writeCompletedToolTranscript(sessionsDir);
      vi.mocked(callGateway).mockImplementationOnce(async ({ params }) => {
        const request = params as Record<string, unknown>;
        const runId = String(request.idempotencyKey);
        const sessionKey = String(request.sessionKey);
        const result = {
          payloads: [{ text: "final answer" }],
          meta: { durationMs: 1 },
        };
        await deliverAgentCommandResult({
          cfg: {} as OpenClawConfig,
          deps: {} as CliDeps,
          runtime: { log: vi.fn(), error: vi.fn() } as never,
          opts: {
            message: String(request.message),
            deliver: request.deliver === true,
            bestEffortDeliver: request.bestEffortDeliver === true,
            channel: String(request.channel),
            to: String(request.to),
            accountId: String(request.accountId),
            threadId: String(request.threadId),
            sessionKey,
            runId,
          },
          outboundSession: { key: sessionKey, agentId: "main" },
          sessionEntry: loadSessionEntry({ sessionKey, storePath }),
          payloads: result.payloads,
          result,
        } as Parameters<typeof deliverAgentCommandResult>[0]);
        return { runId, status: "ok" };
      });

      try {
        await expectRecovery({ started: 0, settled: 1, failed: 0, skipped: 0 });
        const resumeParams = gatewayParams() as Record<string, unknown>;
        expect(resumeParams).toMatchObject({
          sessionKey: "agent:main:discord:direct:123",
          deliver: true,
          bestEffortDeliver: true,
          lane: "main",
          channel: "discord",
          to: "discord:dm:123",
          accountId: "main",
          threadId: "123",
        });
        const recoveryRunId = String(resumeParams.idempotencyKey);
        expect(hookHandler).toHaveBeenCalledWith(
          {
            payload: expect.objectContaining({ text: "final answer" }),
            kind: "final",
            channel: "discord",
            sessionKey: "agent:main:discord:direct:123",
            runId: recoveryRunId,
            usageState: undefined,
          },
          {
            channelId: "discord",
            accountId: "main",
            conversationId: "discord:dm:123",
            sessionKey: "agent:main:discord:direct:123",
            runId: recoveryRunId,
          },
        );
        expect(deliveredText).toHaveBeenCalledExactlyOnceWith({
          to: "discord:dm:123",
          text: "hooked: final answer",
        });
      } finally {
        closeOpenClawStateDatabaseForTest();
        resetGlobalHookRunner();
        setActivePluginRegistry(createEmptyPluginRegistry());
        if (previousStateDir === undefined) {
          delete process.env.OPENCLAW_STATE_DIR;
        } else {
          process.env.OPENCLAW_STATE_DIR = previousStateDir;
        }
      }
    },
  );

  it("re-adopts a persisted Telegram private-topic route and releases the next turn", async () => {
    const sessionsDir = await makeSessionsDir();
    const storePath = path.join(sessionsDir, "sessions.json");
    const sessionKey = "agent:main:telegram:direct:12345:thread:12345:99";
    const deliveryContext = {
      channel: "telegram",
      to: "telegram:12345",
      accountId: "work",
      threadId: "99",
    } as const;
    const delivery = {
      kind: "external" as const,
      context: deliveryContext,
      route: {
        channel: "telegram",
        accountId: "work",
        target: { to: "telegram:12345", chatType: "direct" as const },
        thread: { id: "99", kind: "topic" as const, source: "turn" as const },
      },
      origin: {
        provider: "telegram",
        to: "telegram:12345",
        accountId: "work",
        threadId: "99",
      },
    };
    const interruptedEntry = mainSessionEntry({ delivery });
    const recoveryContext = resolveReplyRunDeliveryContext({
      cfg: {},
      sessionCtx: {
        Provider: "telegram",
        OriginatingChannel: "telegram",
        OriginatingTo: "telegram:12345",
        AccountId: "work",
        MessageThreadId: 99,
        TransportThreadId: 99,
        SessionKey: sessionKey,
      },
      sessionEntry: interruptedEntry,
      sessionKey,
    });
    expect(recoveryContext).toEqual({ ...deliveryContext, threadId: 99 });
    await writeMainSession({
      sessionsDir,
      sessionKey,
      delivery,
      restartRecoveryDeliveryContext: recoveryContext,
    });
    await writeCompletedToolTranscript(sessionsDir);

    const deliveredText = vi.fn();
    const telegramOutbound: ChannelOutboundAdapter = {
      deliveryMode: "direct",
      sendText: async ({ to, text, threadId }) => {
        deliveredText({ to, text, threadId });
        return { channel: "telegram", messageId: "delivered-telegram-1" };
      },
    };
    resetGlobalHookRunner();
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "telegram",
          source: "test",
          plugin: createOutboundTestPlugin({ id: "telegram", outbound: telegramOutbound }),
        },
      ]),
    );
    const previousStateDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = tmpDir;

    vi.mocked(callGateway).mockImplementationOnce(async ({ params }) => {
      const request = params as Record<string, unknown>;
      const runId = String(request.idempotencyKey);
      const current = loadSessionEntry({ sessionKey, storePath });
      if (!current) {
        throw new Error("expected claimed Telegram recovery session");
      }
      expect(
        buildCurrentRunRestartRecoveryClaim({
          deliveryContext,
          entry: current,
          runId,
        }),
      ).toMatchObject({
        restartRecoveryDeliveryContext: recoveryContext,
        restartRecoveryDeliveryRunId: runId,
      });
      const result = {
        payloads: [{ text: "recovered private-topic reply" }],
        meta: { durationMs: 1 },
      };
      await deliverAgentCommandResult({
        cfg: {} as OpenClawConfig,
        deps: {} as CliDeps,
        runtime: { log: vi.fn(), error: vi.fn() } as never,
        opts: {
          message: String(request.message),
          deliver: request.deliver === true,
          bestEffortDeliver: request.bestEffortDeliver === true,
          channel: String(request.channel),
          to: String(request.to),
          accountId: String(request.accountId),
          threadId: String(request.threadId),
          sessionKey,
          runId,
        },
        outboundSession: { key: sessionKey, agentId: "main" },
        sessionEntry: current,
        payloads: result.payloads,
        result,
      } as Parameters<typeof deliverAgentCommandResult>[0]);
      return { runId, status: "ok" };
    });

    try {
      await expectRecovery({ started: 0, settled: 1, failed: 0, skipped: 0 });
      expect(gatewayParams()).toMatchObject({
        sessionKey,
        channel: "telegram",
        to: "telegram:12345",
        accountId: "work",
        threadId: "99",
      });
      expect(deliveredText).toHaveBeenCalledWith({
        to: "telegram:12345",
        text: "recovered private-topic reply",
        threadId: "99",
      });
      const completed = loadSessionEntry({ sessionKey, storePath });
      expect(completed).toMatchObject({ status: "done", abortedLastRun: false });
      expect(completed?.restartRecoveryDeliveryRunId).toBeUndefined();
      expect(completed?.restartRecoveryDeliveryContext).toBeUndefined();
      if (!completed) {
        throw new Error("expected completed Telegram recovery session");
      }
      expect(
        buildCurrentRunRestartRecoveryClaim({
          deliveryContext,
          entry: completed,
          runId: "telegram-follow-up-run",
          sourceIngress: "channel",
          sourceRunId: "telegram-follow-up-source",
        }),
      ).toMatchObject({
        restartRecoveryDeliveryContext: deliveryContext,
        restartRecoveryDeliveryRunId: "telegram-follow-up-run",
        restartRecoveryDeliverySourceRunId: "telegram-follow-up-source",
      });
    } finally {
      closeOpenClawStateDatabaseForTest();
      resetGlobalHookRunner();
      setActivePluginRegistry(createEmptyPluginRegistry());
      if (previousStateDir === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = previousStateDir;
      }
    }
  });

  it("reuses a transcript-only claim without inferring historical session routes", async () => {
    const { sessionsDir, storePath } = await makeMainSessionFixture({
      sessionKey: "agent:main:discord:direct:123",
      restartRecoveryDeliveryRunId: "control-ui-run",
      restartRecoveryDeliverySourceRunId: "control-ui-run",
      restartRecoverySourceIngress: "internal",
      restartRecoverySourceReplyDeliveryMode: "message_tool_only",
      deliveryContext: {
        channel: "discord",
        to: "discord:dm:stale",
        accountId: "old",
      },
    });
    await writeCompletedToolTranscript(sessionsDir);
    let claimAtDispatch: string | undefined;
    let sourceClaimAtDispatch: string | undefined;
    vi.mocked(callGateway).mockImplementationOnce(async ({ params }) => {
      const entry = loadSessionEntry({
        sessionKey: "agent:main:discord:direct:123",
        storePath,
      });
      claimAtDispatch = entry?.restartRecoveryDeliveryRunId;
      sourceClaimAtDispatch = entry?.restartRecoveryDeliverySourceRunId;
      return { runId: String((params as { idempotencyKey?: unknown }).idempotencyKey) };
    });

    await expectRecovery({ started: 1, settled: 0, failed: 0, skipped: 0 });
    const resumeParams = gatewayParams() as Record<string, unknown>;
    expect(resumeParams.deliver).toBe(false);
    expect(resumeParams.sourceReplyDeliveryMode).toBe("message_tool_only");
    expect(claimAtDispatch).toBe(resumeParams.idempotencyKey);
    expect(claimAtDispatch).not.toBe("control-ui-run");
    expect(sourceClaimAtDispatch).toBe("control-ui-run");
  });

  it.each([
    ["fresh default config", undefined],
    ["upgrade config without the new setting", {}],
    ["explicit collection disable", { logging: { audit: { executionIdentity: false } } }],
    ["disabled audit ledger", { logging: { audit: { enabled: false, executionIdentity: true } } }],
  ] satisfies Array<[string, OpenClawConfig | undefined]>)(
    "stores no recovery identity with %s",
    async (_label, cfg) => {
      const sessionsDir = await makeSessionsDir();
      const storePath = path.join(sessionsDir, "sessions.json");
      await writeMainSession({ sessionsDir });
      await writeCompletedToolTranscript(sessionsDir);

      await expectRecovery({ started: 1, settled: 0, failed: 0, skipped: 0 }, cfg);

      const entry = loadSessionEntry({ sessionKey: "agent:main:main", storePath });
      expect(entry?.mainRestartRecovery?.executionIdentity).toBeUndefined();
      expect(gatewayParams()).not.toHaveProperty("internalExecutionIdentityRetry");
      expect(gatewayParams().internalExecutionIdentityRecoveryAttempt).toBe(1);
    },
  );

  it("keeps ambiguous pre-admission recovery identity unbound", async () => {
    const { sessionsDir, storePath } = await makeMainSessionFixture({
      restartRecoveryDeliveryRunId: "control-ui-run",
      restartRecoveryDeliverySourceRunId: "control-ui-run",
    });
    await writeCompletedToolTranscript(sessionsDir);
    vi.mocked(callGateway).mockRejectedValueOnce(new Error("gateway unavailable"));

    await expectRecovery(
      { started: 0, settled: 0, failed: 1, skipped: 0 },
      executionIdentityEnabledConfig,
    );

    const firstRecoveryRunId = (
      vi.mocked(callGateway).mock.calls[0]?.[0].params as { idempotencyKey?: unknown } | undefined
    )?.idempotencyKey;
    expect(firstRecoveryRunId).toEqual(expect.any(String));
    expect(firstRecoveryRunId).not.toBe("control-ui-run");
    const pending = loadSessionEntry({ sessionKey: "agent:main:main", storePath });
    expect(pending).toMatchObject({
      abortedLastRun: true,
      mainRestartRecovery: { chargedAttempts: 1 },
      restartRecoveryDeliveryRunId: firstRecoveryRunId,
      restartRecoveryDeliverySourceRunId: "control-ui-run",
      sessionId: "main-session",
      status: "running",
    });
    expect(pending?.mainRestartRecovery?.reservation).toBeUndefined();
    expect(pending?.mainRestartRecovery?.executionIdentity).toBeUndefined();
    const firstRequest = vi.mocked(callGateway).mock.calls[0]?.[0];
    expect(firstRequest).toBeDefined();
    expect((firstRequest!.params as Record<string, unknown>).internalExecutionIdentityRetry).toBe(
      false,
    );
    expect(
      (firstRequest!.params as Record<string, unknown>).internalExecutionIdentityRecoveryAttempt,
    ).toBe(1);

    await expectRecovery(
      { started: 1, settled: 0, failed: 0, skipped: 0 },
      executionIdentityEnabledConfig,
    );
    const runIds = vi
      .mocked(callGateway)
      .mock.calls.map(([request]) =>
        request.method === "agent"
          ? (request.params as { idempotencyKey?: unknown }).idempotencyKey
          : undefined,
      )
      .filter((runId) => runId !== undefined);
    expect(runIds).toEqual([firstRecoveryRunId, firstRecoveryRunId]);
    const recovered = loadSessionEntry({ sessionKey: "agent:main:main", storePath });
    expect(recovered).toMatchObject({
      abortedLastRun: false,
      mainRestartRecovery: { chargedAttempts: 2 },
      restartRecoveryDeliveryRunId: firstRecoveryRunId,
      restartRecoveryDeliverySourceRunId: "control-ui-run",
      status: "running",
    });
    const agentRequests = vi
      .mocked(callGateway)
      .mock.calls.map(([request]) => request)
      .filter((request) => request.method === "agent");
    expect(agentRequests[1]).toBeDefined();
    expect(
      (agentRequests[1]!.params as Record<string, unknown>).internalExecutionIdentityRetry,
    ).toBe(true);
    expect(
      (agentRequests[1]!.params as Record<string, unknown>)
        .internalExecutionIdentityRecoveryAttempt,
    ).toBe(2);
  });

  it("preserves recovery identity when a prior-lifecycle delivery run rotates", async () => {
    const previousRecoveryRunId = "recovery-run-a";
    const sourceRunId = "channel-run";
    const previousExecutionIdentity = createExecutionIdentityAdmissionToken(previousRecoveryRunId, {
      contextId: "recovery-context",
      executionId: "recovery-execution",
      now: 123,
    });
    const { sessionsDir, storePath, sessionKey } = await makeMainSessionFixture({
      sessionKey: "agent:main:discord:direct:123",
      mainRestartRecovery: {
        cycleId: "cycle-1",
        revision: 1,
        chargedAttempts: 1,
        executionIdentity: previousExecutionIdentity,
      },
      restartRecoveryDeliveryRunId: previousRecoveryRunId,
      restartRecoveryDeliverySourceRunId: sourceRunId,
      restartRecoveryDeliveryContext: discordDeliveryContext,
      restartRecoveryRuns: [
        { runId: previousRecoveryRunId, lifecycleGeneration: "previous-generation" },
      ],
    });
    await writeTranscript(sessionsDir, "main-session", [
      makeUserMessage("original channel turn", { idempotencyKey: `${sourceRunId}:user` }),
      makeUserMessage("first restart continuation", {
        idempotencyKey: `${previousRecoveryRunId}:user`,
      }),
      makeMessageToolCall("later-tool-call"),
      makeMessageToolResult("later-tool-call"),
    ]);
    let dispatchedRunId: string | undefined;
    let dispatchError: unknown;
    vi.mocked(callGateway).mockImplementationOnce(async ({ method, params }) => {
      expect(method).toBe("agent");
      dispatchedRunId = String((params as { idempotencyKey?: unknown }).idempotencyKey);
      const sessionManager = SessionManager.open(
        { agentId: "main", sessionId: "main-session", sessionKey, storePath },
        sessionsDir,
      );
      try {
        const sessionEntry = loadSessionEntry({ sessionKey, storePath });
        const gatewayAdmission = resolveAgentRestartRecoveryExecutionIdentityAdmission({
          collectionEnabled: true,
          isRestartRecoveryResumeRun: true,
          retryOnly:
            (params as { internalExecutionIdentityRetry?: unknown })
              .internalExecutionIdentityRetry === true,
          runId: dispatchedRunId,
          sessionEntry,
        });
        expect(gatewayAdmission?.consume(dispatchedRunId)).toEqual({
          accepted: true,
          token: previousExecutionIdentity,
        });
        const recoveryMessage = {
          role: "user" as const,
          content: "[System] continue after restart",
          idempotencyKey: `${dispatchedRunId}:user`,
          timestamp: Date.now(),
        };
        sessionManager.appendMessage(recoveryMessage);
      } catch (error) {
        dispatchError = error;
        throw error;
      }
      return { runId: dispatchedRunId };
    });

    const recoveryResult = await recoverRestartAbortedMainSessions({
      cfg: executionIdentityEnabledConfig,
      stateDir: tmpDir,
    });

    expect(dispatchError).toBeUndefined();
    expect(recoveryResult).toEqual({ started: 1, settled: 0, failed: 0, skipped: 0 });
    expect(dispatchedRunId).toEqual(expect.any(String));
    expect(dispatchedRunId).not.toBe(previousRecoveryRunId);
    expect(gatewayParams()).toMatchObject({
      channel: "discord",
      idempotencyKey: dispatchedRunId,
      to: "discord:dm:123",
    });
    const recoveredEntry = loadSessionEntry({ sessionKey, storePath });
    expect(recoveredEntry).toMatchObject({
      restartRecoveryDeliveryContext: discordDeliveryContext,
      restartRecoveryDeliveryRunId: dispatchedRunId,
      restartRecoveryDeliverySourceRunId: sourceRunId,
    });
    expect(recoveredEntry?.mainRestartRecovery?.executionIdentity).toEqual(
      previousExecutionIdentity,
    );
    const transcript = await loadTestTranscript(sessionKey, storePath);
    expect(
      transcript
        .map((event) => event.message?.idempotencyKey)
        .filter((key) => typeof key === "string"),
    ).toEqual([`${sourceRunId}:user`, `${previousRecoveryRunId}:user`, `${dispatchedRunId}:user`]);
  });

  it("does not manufacture recovery identity before collection is disabled", async () => {
    const { sessionsDir, storePath } = await makeMainSessionFixture({
      restartRecoveryDeliveryRunId: "control-ui-run",
      restartRecoveryDeliverySourceRunId: "control-ui-run",
    });
    await writeCompletedToolTranscript(sessionsDir);
    vi.mocked(callGateway).mockRejectedValueOnce(new Error("gateway unavailable"));

    await expectRecovery(
      { started: 0, settled: 0, failed: 1, skipped: 0 },
      executionIdentityEnabledConfig,
    );
    const retained = loadSessionEntry({ sessionKey: "agent:main:main", storePath })
      ?.mainRestartRecovery?.executionIdentity;
    expect(retained).toBeUndefined();

    await expectRecovery(
      { started: 1, settled: 0, failed: 0, skipped: 0 },
      { logging: { audit: { executionIdentity: false } } },
    );

    const requests = vi
      .mocked(callGateway)
      .mock.calls.map(([request]) => request)
      .filter((request) => request.method === "agent");
    expect(requests).toHaveLength(2);
    const retryRequest = requests[1];
    if (!retryRequest) {
      throw new Error("expected retry request");
    }
    expect(retryRequest.params).not.toHaveProperty("internalExecutionIdentityRetry");
    expect(
      (retryRequest.params as Record<string, unknown>).internalExecutionIdentityRecoveryAttempt,
    ).toBe(2);
    expect(
      loadSessionEntry({ sessionKey: "agent:main:main", storePath })?.mainRestartRecovery
        ?.executionIdentity,
    ).toBeUndefined();
  });

  it("retries reservation cleanup after a transient session-store failure", async () => {
    const sessionsDir = await makeSessionsDir();
    const storePath = path.join(sessionsDir, "sessions.json");
    await writeStore(sessionsDir, mainSessionStore());
    await writeCompletedToolTranscript(sessionsDir);
    let dispatchFailed = false;
    vi.mocked(callGateway).mockImplementationOnce(async () => {
      dispatchFailed = true;
      throw new Error("gateway unavailable");
    });
    const applySessionEntryReplacements = sessionAccessor.applySessionEntryReplacements;
    let cleanupFailures = 0;
    const replacementSpy = vi
      .spyOn(sessionAccessor, "applySessionEntryReplacements")
      .mockImplementation(async (params) => {
        if (dispatchFailed && params.requireWriteSuccess && cleanupFailures < 2) {
          cleanupFailures += 1;
          throw new Error("transient session-store failure");
        }
        return await applySessionEntryReplacements(params);
      });

    try {
      await expect(
        recoverRestartAbortedMainSessions({ cfg: {}, stateDir: tmpDir }),
      ).resolves.toEqual({ started: 0, settled: 0, failed: 1, skipped: 0 });
    } finally {
      replacementSpy.mockRestore();
    }

    expect(cleanupFailures).toBe(2);
    const entry = loadSessionEntry({ sessionKey: "agent:main:main", storePath });
    expect(entry?.mainRestartRecovery).toMatchObject({ chargedAttempts: 1 });
    expect(entry?.mainRestartRecovery?.reservation).toBeUndefined();
  });

  it("schedules exact reservation cleanup after immediate retries are exhausted", async () => {
    const sessionsDir = await makeSessionsDir();
    const storePath = path.join(sessionsDir, "sessions.json");
    await writeStore(sessionsDir, mainSessionStore());
    await writeCompletedToolTranscript(sessionsDir);
    let dispatchFailed = false;
    vi.mocked(callGateway).mockImplementationOnce(async () => {
      dispatchFailed = true;
      throw new Error("gateway unavailable");
    });
    const applySessionEntryReplacements = sessionAccessor.applySessionEntryReplacements;
    const schedulePendingSpy = vi
      .spyOn(recoveryOwnerRelease, "scheduleMainSessionRecoveryPendingTarget")
      .mockImplementation(() => {});
    let cleanupFailures = 0;
    const replacementSpy = vi
      .spyOn(sessionAccessor, "applySessionEntryReplacements")
      .mockImplementation(async (params) => {
        if (dispatchFailed && params.requireWriteSuccess && cleanupFailures < 3) {
          cleanupFailures += 1;
          throw new Error("extended session-store failure");
        }
        return await applySessionEntryReplacements(params);
      });

    try {
      await expect(
        recoverRestartAbortedMainSessions({ cfg: {}, stateDir: tmpDir }),
      ).resolves.toEqual({ started: 0, settled: 0, failed: 1, skipped: 0 });
      expect(
        loadSessionEntry({ sessionKey: "agent:main:main", storePath })?.mainRestartRecovery
          ?.reservation,
      ).toBeDefined();
      await vi.waitFor(
        () => {
          expect(
            loadSessionEntry({ sessionKey: "agent:main:main", storePath })?.mainRestartRecovery
              ?.reservation,
          ).toBeUndefined();
        },
        { timeout: 3_000 },
      );
      expect(schedulePendingSpy).toHaveBeenCalledWith({
        sessionId: "main-session",
        sessionKey: "agent:main:main",
        storePath,
      });
    } finally {
      schedulePendingSpy.mockRestore();
      replacementSpy.mockRestore();
    }

    expect(cleanupFailures).toBe(3);
    expect(
      loadSessionEntry({ sessionKey: "agent:main:main", storePath })?.mainRestartRecovery,
    ).toMatchObject({ chargedAttempts: 1 });
  });

  it("retries reservation cleanup when durable dispatch preparation is rejected", async () => {
    const sessionsDir = await makeSessionsDir();
    const storePath = path.join(sessionsDir, "sessions.json");
    await writeStore(sessionsDir, mainSessionStore());
    await writeCompletedToolTranscript(sessionsDir);
    const applySessionEntryReplacements = sessionAccessor.applySessionEntryReplacements;
    let preparationRejected = false;
    let cleanupFailures = 0;
    const replacementSpy = vi
      .spyOn(sessionAccessor, "applySessionEntryReplacements")
      .mockImplementation(async (params) => {
        const entry = loadSessionEntry({ sessionKey: "agent:main:main", storePath });
        if (
          !preparationRejected &&
          params.requireWriteSuccess !== true &&
          entry?.mainRestartRecovery?.reservation
        ) {
          preparationRejected = true;
          return false;
        }
        if (preparationRejected && params.requireWriteSuccess && cleanupFailures < 2) {
          cleanupFailures += 1;
          throw new Error("transient session-store failure");
        }
        return await applySessionEntryReplacements(params);
      });

    try {
      await expect(
        recoverRestartAbortedMainSessions({ cfg: {}, stateDir: tmpDir }),
      ).resolves.toEqual({ started: 0, settled: 0, failed: 1, skipped: 0 });
    } finally {
      replacementSpy.mockRestore();
    }

    expect(preparationRejected).toBe(true);
    expect(cleanupFailures).toBe(2);
    expect(callGateway).not.toHaveBeenCalled();
    const entry = loadSessionEntry({ sessionKey: "agent:main:main", storePath });
    expect(entry?.mainRestartRecovery).toMatchObject({ chargedAttempts: 0 });
    expect(entry?.mainRestartRecovery?.reservation).toBeUndefined();
  });

  it("refunds an explicit Gateway rejection before recovery admission", async () => {
    const sessionsDir = await makeSessionsDir();
    const storePath = path.join(sessionsDir, "sessions.json");
    await writeStore(sessionsDir, mainSessionStore());
    await writeCompletedToolTranscript(sessionsDir);
    vi.mocked(callGateway).mockRejectedValueOnce(
      new GatewayClientRequestError({
        code: "UNAVAILABLE",
        message: "restart recovery reservation is stale",
        retryable: false,
      }),
    );

    await expect(recoverRestartAbortedMainSessions({ cfg: {}, stateDir: tmpDir })).resolves.toEqual(
      { started: 0, settled: 0, failed: 1, skipped: 0 },
    );

    expect(callGateway).toHaveBeenCalledOnce();
    const entry = loadSessionEntry({ sessionKey: "agent:main:main", storePath });
    expect(entry?.mainRestartRecovery).toMatchObject({ chargedAttempts: 0 });
    expect(entry?.mainRestartRecovery?.reservation).toBeUndefined();
  });

  it("does not settle an ambiguous recovery after a foreground owner wins admission", async () => {
    const sessionsDir = await makeSessionsDir();
    const storePath = path.join(sessionsDir, "sessions.json");
    await writeStore(sessionsDir, mainSessionStore());
    await writeCompletedToolTranscript(sessionsDir);
    vi.mocked(callGateway).mockImplementation(async (request) => {
      if (request.method === "agent") {
        throw new Error("ambiguous dispatch transport failure");
      }
      const owner = await claimMainSessionRecoveryOwner({
        lifecycleGeneration: getAgentEventLifecycleGeneration(),
        sessionId: "main-session",
        target: { sessionKey: "agent:main:main", storePath },
      });
      expect(owner.kind).toBe("claimed");
      return { runId: "recovery-run", status: "ok", endedAt: Date.now() };
    });

    await expect(recoverRestartAbortedMainSessions({ cfg: {}, stateDir: tmpDir })).resolves.toEqual(
      { started: 0, settled: 0, failed: 1, skipped: 0 },
    );
    expect(loadSessionEntry({ sessionKey: "agent:main:main", storePath })).toMatchObject({
      abortedLastRun: true,
      status: "running",
      mainRestartRecovery: {
        foregroundClaims: { tokens: [expect.any(String)] },
      },
    });
  });

  it("rolls back the reservation when ambiguous settlement persistence fails", async () => {
    const sessionsDir = await makeSessionsDir();
    const storePath = path.join(sessionsDir, "sessions.json");
    await writeStore(sessionsDir, mainSessionStore());
    await writeCompletedToolTranscript(sessionsDir);
    let dispatchFailed = false;
    vi.mocked(callGateway).mockImplementation(async (request) => {
      if (request.method === "agent") {
        dispatchFailed = true;
        throw new Error("ambiguous dispatch transport failure");
      }
      return { runId: "recovery-run", status: "ok", endedAt: Date.now() };
    });
    const applySessionEntryReplacements = sessionAccessor.applySessionEntryReplacements;
    let postDispatchWrites = 0;
    let settlementFailed = false;
    const replacementSpy = vi
      .spyOn(sessionAccessor, "applySessionEntryReplacements")
      .mockImplementation(async (params) => {
        if (dispatchFailed && params.requireWriteSuccess !== true) {
          postDispatchWrites += 1;
          if (postDispatchWrites === 2) {
            settlementFailed = true;
            throw new Error("settlement store failure");
          }
        }
        return await applySessionEntryReplacements(params);
      });

    try {
      await expect(
        recoverRestartAbortedMainSessions({ cfg: {}, stateDir: tmpDir }),
      ).resolves.toEqual({ started: 0, settled: 0, failed: 1, skipped: 0 });
    } finally {
      replacementSpy.mockRestore();
    }
    expect(settlementFailed).toBe(true);
    const entry = loadSessionEntry({ sessionKey: "agent:main:main", storePath });
    expect(entry).toMatchObject({ status: "running", abortedLastRun: true });
    expect(entry?.mainRestartRecovery).toMatchObject({ chargedAttempts: 1 });
    expect(entry?.mainRestartRecovery?.reservation).toBeUndefined();
  });

  it("settles an admitted recovery that completed before its ambiguous response", async () => {
    const sessionsDir = await makeSessionsDir();
    const storePath = path.join(sessionsDir, "sessions.json");
    await writeStore(sessionsDir, mainSessionStore());
    await writeCompletedToolTranscript(sessionsDir);
    vi.mocked(callGateway).mockImplementation(async (request) => {
      if (request.method === "agent") {
        const recoveryRunId = String(
          (request.params as { idempotencyKey?: unknown }).idempotencyKey,
        );
        const current = loadSessionEntry({ sessionKey: "agent:main:main", storePath })!;
        const completed: SessionEntry = {
          ...current,
          status: "done",
          abortedLastRun: false,
          restartRecoveryDeliveryRunId: undefined,
          restartRecoveryDeliverySourceRunId: undefined,
          restartRecoveryRuns: undefined,
          restartRecoveryTerminalRunIds: [recoveryRunId],
          mainRestartRecovery: current.mainRestartRecovery
            ? { ...current.mainRestartRecovery, reservation: undefined }
            : undefined,
        };
        await replaceSessionEntry({ sessionKey: "agent:main:main", storePath }, completed);
        throw new Error("accepted response was lost after completion");
      }
      return { runId: "recovery-run", status: "ok", endedAt: Date.now() };
    });

    await expect(recoverRestartAbortedMainSessions({ cfg: {}, stateDir: tmpDir })).resolves.toEqual(
      { started: 0, settled: 1, failed: 0, skipped: 0 },
    );
    expect(loadSessionEntry({ sessionKey: "agent:main:main", storePath })).toMatchObject({
      abortedLastRun: false,
      status: "done",
    });
  });

  it("settles a reused recovery RPC whose accepted cache already completed", async () => {
    const { sessionsDir, storePath } = await makeMainSessionFixture({
      restartRecoveryDeliveryRunId: "recovery-run",
      restartRecoveryDeliverySourceRunId: "control-ui-run",
    });
    await writeCompletedToolTranscript(sessionsDir);
    vi.mocked(callGateway)
      .mockResolvedValueOnce({
        runId: "recovery-run",
        status: "accepted",
      })
      .mockResolvedValueOnce({
        runId: "recovery-run",
        status: "ok",
        endedAt: Date.now(),
      });

    await expectRecovery({ started: 0, settled: 1, failed: 0, skipped: 0 }, {});

    expect(gatewayParams().idempotencyKey).toBe("recovery-run");
    expect(vi.mocked(callGateway).mock.calls[1]?.[0]).toMatchObject({
      method: "agent.wait",
      params: { runId: "recovery-run", timeoutMs: 0 },
    });
    expect(loadSessionEntry({ sessionKey: "agent:main:main", storePath })).toMatchObject({
      abortedLastRun: false,
      endedAt: expect.any(Number),
      restartRecoveryTerminalRunIds: ["control-ui-run", "recovery-run"],
      sessionId: "main-session",
      status: "done",
    });
    const settled = loadSessionEntry({ sessionKey: "agent:main:main", storePath });
    expect(settled?.restartRecoveryDeliveryRunId).toBeUndefined();
    expect(settled?.restartRecoveryDeliverySourceRunId).toBeUndefined();
    expect(settled?.mainRestartRecovery).toBeUndefined();
  });

  it("does not settle a cached terminal response after a foreground owner wins admission", async () => {
    const { sessionsDir, storePath } = await makeMainSessionFixture({
      restartRecoveryDeliveryRunId: "recovery-run",
      restartRecoveryDeliverySourceRunId: "control-ui-run",
    });
    await writeCompletedToolTranscript(sessionsDir);
    let foregroundClaimed = false;
    vi.mocked(callGateway).mockImplementation(async (request) => {
      if (request.method === "agent") {
        return { runId: "recovery-run", status: "accepted" };
      }
      if (!foregroundClaimed) {
        const owner = await claimMainSessionRecoveryOwner({
          lifecycleGeneration: getAgentEventLifecycleGeneration(),
          sessionId: "main-session",
          target: { sessionKey: "agent:main:main", storePath },
        });
        expect(owner.kind).toBe("claimed");
        foregroundClaimed = true;
      }
      return { runId: "recovery-run", status: "ok", endedAt: Date.now() };
    });

    await expect(recoverRestartAbortedMainSessions({ cfg: {}, stateDir: tmpDir })).resolves.toEqual(
      { started: 0, settled: 0, failed: 1, skipped: 0 },
    );
    expect(loadSessionEntry({ sessionKey: "agent:main:main", storePath })).toMatchObject({
      abortedLastRun: true,
      status: "running",
      mainRestartRecovery: {
        foregroundClaims: { tokens: [expect.any(String)] },
      },
    });
  });

  it("settles a reused recovery RPC after its dispatch wait times out", async () => {
    const { sessionsDir, storePath } = await makeMainSessionFixture({
      restartRecoveryDeliveryRunId: "recovery-run",
      restartRecoveryDeliverySourceRunId: "control-ui-run",
    });
    await writeCompletedToolTranscript(sessionsDir);
    vi.mocked(callGateway)
      .mockRejectedValueOnce(new Error("gateway request timeout for agent"))
      .mockResolvedValueOnce({
        runId: "recovery-run",
        status: "ok",
        endedAt: Date.now(),
      });

    await expectRecovery({ started: 0, settled: 1, failed: 0, skipped: 0 }, {});

    expect(gatewayParams().idempotencyKey).toBe("recovery-run");
    expect(vi.mocked(callGateway).mock.calls[1]?.[0]).toMatchObject({
      method: "agent.wait",
      params: { runId: "recovery-run", timeoutMs: 0 },
    });
    expect(loadSessionEntry({ sessionKey: "agent:main:main", storePath })).toMatchObject({
      abortedLastRun: false,
      restartRecoveryTerminalRunIds: ["control-ui-run", "recovery-run"],
      status: "done",
    });
    expect(
      loadSessionEntry({ sessionKey: "agent:main:main", storePath })?.mainRestartRecovery,
    ).toBeUndefined();
  });

  it.each(["interrupted run", "unclaimed session"])(
    "does not deliver restart recovery through the %s route when session send policy denies sends",
    async (routeOwner) => {
      const { sessionsDir } = await makeMainSessionFixture({
        sessionKey: "agent:main:discord:direct:123",
        [routeOwner === "interrupted run" ? "restartRecoveryDeliveryContext" : "deliveryContext"]: {
          channel: "discord",
          to: "discord:dm:123",
          accountId: "main",
        },
      });
      await writeCompletedToolTranscript(sessionsDir);

      const result = await recoverRestartAbortedMainSessions({
        cfg: { session: { sendPolicy: { default: "deny" } } },
        stateDir: tmpDir,
      });

      expect(result).toEqual({ started: 1, settled: 0, failed: 0, skipped: 0 });
      expect(gatewayParams().deliver).toBe(false);
    },
  );

  it("resumes stale approval-pending exec tool results with restart-safe tools", async () => {
    const sessionsDir = await writeMainSessionTranscript([
      { role: "user", content: "run a command that needs approval" },
      { role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "exec" }] },
      {
        role: "toolResult",
        content: "Approval required (id stale, full stale-approval-id).",
        details: {
          status: "approval-pending",
          approvalId: "stale-approval-id",
          host: "gateway",
          command: "echo stale",
        },
      },
    ]);

    await expectRecovery({ started: 1, settled: 0, failed: 0, skipped: 0 });
    expect(callGateway).toHaveBeenCalledOnce();
    expect(gatewayParams()).toMatchObject({ forceRestartSafeTools: true });
    const store = readStore(path.join(sessionsDir, "sessions.json"));
    expect(store["agent:main:main"]?.status).toBe("running");
    expect(store["agent:main:main"]?.abortedLastRun).toBe(false);
  });

  it.each([
    ["missing", undefined],
    ["empty", []],
  ] as const)(
    "resumes safely when pending final delivery identities are %s",
    async (_, deliveries) => {
      const sessionsDir = await makeSessionsDir();
      const pendingPayload = "The final answer is 42.";
      await writeMainSession({
        sessionsDir,
        restartRecoveryForceSafeTools: true,
        pendingFinalDelivery: {
          kind: "replayable",
          text: pendingPayload,
          createdAt: Date.now() - 5_000,
          ...(deliveries ? { deliveries: [...deliveries] } : {}),
          context: {
            channel: "discord",
            to: "discord:dm:final",
            accountId: "main",
          },
        },
        restartRecoveryBeforeAgentReplyState: "handled-reply",
        restartRecoveryDeliveryRunId: "discord-message-1",
        restartRecoveryDeliverySourceRunId: "discord-message-1",
        restartRecoverySourceIngress: "channel",
        restartRecoveryDeliveryContext: {
          channel: "discord",
          to: "discord:dm:stale",
          accountId: "old",
        },
      });
      await writeTranscript(sessionsDir, "main-session", [
        { role: "user", content: "calculate the answer" },
        { role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "calc" }] },
        { role: "toolResult", content: "42" },
      ]);

      await expectRecovery({ started: 1, settled: 0, failed: 0, skipped: 0 }, {});
      expect(callGateway).toHaveBeenCalledOnce();
      expect(gatewayParams()).toMatchObject({ forceRestartSafeTools: true });
      expect(gatewayParams().message).toContain(pendingPayload);
      expect(sendRecoveryNotice).not.toHaveBeenCalled();
    },
  );

  it("retries a prepared pending final only when no queue owner exists", async () => {
    const sessionsDir = await makeSessionsDir();
    await writeMainSession({
      sessionsDir,
      pendingFinalDelivery: makePendingFinalDelivery("The prepared final answer.", {
        intentId: "intent-prepared",
        deliveries: [{ id: "delivery-prepared", state: "prepared" }],
      }),
    });
    await writeTranscript(sessionsDir, "main-session", [
      { role: "user", content: "finish the answer" },
    ]);

    await expectRecovery({ started: 1, settled: 0, failed: 0, skipped: 0 });

    expect(callGateway).toHaveBeenCalledOnce();
    expect(gatewayParams().message).toContain("The prepared final answer.");
  });

  it("quietly completes a pending final whose deliveries are terminal", async () => {
    const sessionsDir = await makeSessionsDir();
    const storePath = path.join(sessionsDir, "sessions.json");
    await writeMainSession({
      sessionsDir,
      pendingFinalDelivery: makePendingFinalDelivery("Already delivered.", {
        intentId: "intent-delivered",
        deliveries: [
          { id: "delivery-delivered", state: "delivered" },
          { id: "delivery-suppressed", state: "suppressed" },
        ],
      }),
    });

    await expectRecovery({ started: 0, settled: 1, failed: 0, skipped: 0 });

    expect(callGateway).not.toHaveBeenCalled();
    expect(sendRecoveryNotice).not.toHaveBeenCalled();
    expect(loadSessionEntry({ sessionKey: "agent:main:main", storePath })).toMatchObject({
      status: "done",
      abortedLastRun: false,
    });
    expect(
      loadSessionEntry({ sessionKey: "agent:main:main", storePath })?.pendingFinalDelivery,
    ).toBeUndefined();
  });

  it.each([
    [
      { id: "delivery-already-delivered", state: "delivered" as const },
      { id: "delivery-still-pending", state: "queued" as const },
    ],
    [
      { id: "delivery-still-pending", state: "queued" as const },
      { id: "delivery-already-delivered", state: "delivered" as const },
    ],
  ])("defers mixed deliveries while any exact queue owner is pending", async (...deliveries) => {
    try {
      await enqueueDeliveryOnce(
        {
          channel: "discord",
          to: "discord:dm:123",
          payloads: [{ text: "Pending sibling." }],
          queuePolicy: "required",
          completionRetention: "permanent",
        },
        "delivery-still-pending",
        tmpDir,
      );
      const sessionsDir = await makeSessionsDir();
      await writeMainSession({
        sessionsDir,
        pendingFinalDelivery: makePendingFinalDelivery("Partially delivered answer.", {
          context: discordDeliveryContext,
          intentId: "intent-mixed-pending",
          deliveries,
        }),
      });

      await expectRecovery({ started: 0, settled: 0, failed: 0, skipped: 1 });

      expect(callGateway).not.toHaveBeenCalled();
      expect(sendRecoveryNotice).not.toHaveBeenCalled();
    } finally {
      closeOpenClawStateDatabaseForTest();
    }
  });

  it("completes terminal deliveries despite a residual pending queue row", async () => {
    try {
      await enqueueDeliveryOnce(
        {
          channel: "discord",
          to: "discord:dm:123",
          payloads: [{ text: "Already delivered." }],
          queuePolicy: "required",
          completionRetention: "permanent",
        },
        "delivery-terminal-with-row",
        tmpDir,
      );
      const sessionsDir = await makeSessionsDir();
      const storePath = path.join(sessionsDir, "sessions.json");
      await writeMainSession({
        sessionsDir,
        pendingFinalDelivery: makePendingFinalDelivery("Already delivered.", {
          intentId: "intent-terminal-with-row",
          deliveries: [{ id: "delivery-terminal-with-row", state: "delivered" }],
        }),
      });

      await expectRecovery({ started: 0, settled: 1, failed: 0, skipped: 0 });

      expect(callGateway).not.toHaveBeenCalled();
      expect(sendRecoveryNotice).not.toHaveBeenCalled();
      expect(loadSessionEntry({ sessionKey: "agent:main:main", storePath })?.status).toBe("done");
    } finally {
      closeOpenClawStateDatabaseForTest();
    }
  });

  it("resumes safely when residual ambiguity has no notice identity", async () => {
    const sessionsDir = await makeSessionsDir();
    await writeMainSession({
      sessionsDir,
      pendingFinalDelivery: {
        kind: "transport-only",
        createdAt: Date.now(),
        // No context and no intentId: debt cannot be recorded, so the remaining
        // fail arm resumes under restart-safe tool policy.
        deliveries: [{ id: "delivery-identity-less", state: "unknown" }],
      },
    });

    await expectRecovery({ started: 1, settled: 0, failed: 0, skipped: 0 });

    expect(callGateway).toHaveBeenCalledOnce();
    expect(gatewayParams()).toMatchObject({ forceRestartSafeTools: true });
  });

  it("completes an unqueued media-only final with owed notice debt", async () => {
    const sessionsDir = await makeSessionsDir();
    const storePath = path.join(sessionsDir, "sessions.json");
    await writeMainSession({
      sessionsDir,
      pendingFinalDelivery: {
        kind: "transport-only",
        createdAt: Date.now(),
        intentId: "intent-media-only",
        deliveries: [{ id: "delivery-media-only", state: "prepared" }],
        context: discordDeliveryContext,
      },
    });

    await expectRecovery({ started: 0, settled: 1, failed: 0, skipped: 0 });

    expect(callGateway).not.toHaveBeenCalled();
    // The debt is delivered on the next same-route turn; a fire-and-forget
    // notice would be lost during the outage that interrupted the send.
    expect(sendRecoveryNotice).not.toHaveBeenCalled();
    const entry = loadSessionEntry({ sessionKey: "agent:main:main", storePath });
    expect(entry?.status).toBe("done");
    expect(entry?.pendingFinalDelivery).toBeUndefined();
    expect(entry?.pendingDeliveryNotice).toMatchObject({
      intentId: "intent-media-only",
      state: "owed",
      context: discordDeliveryContext,
    });
  });

  it.each(["owed", "unresolved", "acknowledged"] as const)(
    "preserves a prior %s notice when the same pending final completes",
    async (state) => {
      const sessionsDir = await makeSessionsDir();
      const storePath = path.join(sessionsDir, "sessions.json");
      const pending = makePendingFinalDelivery("Uncertain reply.", {
        context: discordDeliveryContext,
        intentId: "intent-notice-retained",
        deliveries: [{ id: "delivery-notice-retained", state: "unknown" }],
      });
      await writeMainSession({
        sessionsDir,
        pendingFinalDelivery: pending,
        pendingDeliveryNotice: {
          createdAt: pending.createdAt,
          context: discordDeliveryContext,
          intentId: "intent-notice-retained",
          state,
        },
      });
      await expectRecovery({ started: 0, settled: 1, failed: 0, skipped: 0 });
      const entry = loadSessionEntry({ sessionKey: "agent:main:main", storePath });
      expect(entry?.pendingFinalDelivery).toBeUndefined();
      expect(entry?.pendingDeliveryNotice?.state).toBe(state);
      expect(sendRecoveryNotice).not.toHaveBeenCalled();
    },
  );

  it("completes an unqueued text and media final with owed notice debt instead of replaying", async () => {
    const sessionsDir = await makeSessionsDir();
    const storePath = path.join(sessionsDir, "sessions.json");
    await writeMainSession({
      sessionsDir,
      pendingFinalDelivery: {
        kind: "transport-only",
        createdAt: Date.now(),
        context: discordDeliveryContext,
        intentId: "intent-text-media",
        deliveries: [
          { id: "delivery-text", state: "prepared" },
          { id: "delivery-media", state: "prepared" },
        ],
      },
    });

    await expectRecovery({ started: 0, settled: 1, failed: 0, skipped: 0 });

    expect(callGateway).not.toHaveBeenCalled();
    expect(sendRecoveryNotice).not.toHaveBeenCalled();
    expect(
      loadSessionEntry({ sessionKey: "agent:main:main", storePath })?.pendingDeliveryNotice,
    ).toMatchObject({ intentId: "intent-text-media", state: "owed" });
  });

  it.each(["delivered", "unknown"] as const)(
    "completes with owed notice debt when a %s delivery is mixed with prepared work",
    async (state) => {
      const sessionsDir = await makeSessionsDir();
      const storePath = path.join(sessionsDir, "sessions.json");
      await writeMainSession({
        sessionsDir,
        pendingFinalDelivery: makePendingFinalDelivery("Do not regenerate this aggregate.", {
          context: discordDeliveryContext,
          intentId: `intent-mixed-${state}`,
          deliveries: [
            { id: `delivery-${state}`, state },
            { id: "delivery-still-prepared", state: "prepared" },
          ],
        }),
      });

      await expectRecovery({ started: 0, settled: 1, failed: 0, skipped: 0 });

      expect(callGateway).not.toHaveBeenCalled();
      expect(sendRecoveryNotice).not.toHaveBeenCalled();
      const entry = loadSessionEntry({ sessionKey: "agent:main:main", storePath });
      expect(entry?.status).toBe("done");
      expect(entry?.pendingDeliveryNotice).toMatchObject({
        intentId: `intent-mixed-${state}`,
        state: "owed",
      });
    },
  );

  it.each(["pending", "failed", "completed", "settling"] as const)(
    "keeps a prepared pending final aligned with its exact queue owner in %s",
    async (ownerStatus) => {
      const deliveryId = `delivery-owner-${ownerStatus}`;
      try {
        await enqueueDeliveryOnce(
          {
            channel: "discord",
            to: "discord:dm:123",
            payloads: [{ text: "Queue owns this final." }],
            queuePolicy: "required",
            completionRetention: "permanent",
          },
          deliveryId,
          tmpDir,
        );
        if (ownerStatus === "settling") {
          const entry = loadDeliveryQueueEntry(OUTBOUND_DELIVERY_QUEUE_NAME, deliveryId, tmpDir)!;
          upsertDeliveryQueueEntry({
            queueName: OUTBOUND_DELIVERY_QUEUE_NAME,
            entry: { ...entry, recoveryState: "settlement_pending" },
            status: "failed",
            stateDir: tmpDir,
          });
        } else if (ownerStatus === "failed") {
          moveDeliveryQueueEntryToFailed(OUTBOUND_DELIVERY_QUEUE_NAME, deliveryId, tmpDir);
        } else if (ownerStatus === "completed") {
          await ackDelivery(deliveryId, tmpDir);
        }
        const sessionsDir = await makeSessionsDir();
        await writeMainSession({
          sessionsDir,
          pendingFinalDelivery: makePendingFinalDelivery("Queue owns this final.", {
            context: discordDeliveryContext,
            intentId: `intent-owner-${ownerStatus}`,
            deliveries: [{ id: deliveryId, state: "prepared" }],
          }),
        });

        await expectRecovery(
          ownerStatus === "pending" || ownerStatus === "settling"
            ? { started: 0, settled: 0, failed: 0, skipped: 1 }
            : { started: 0, settled: 1, failed: 0, skipped: 0 },
        );

        expect(callGateway).not.toHaveBeenCalled();
        expect(sendRecoveryNotice).not.toHaveBeenCalled();
        if (ownerStatus !== "pending" && ownerStatus !== "settling") {
          const sessionsStorePath = path.join(sessionsDir, "sessions.json");
          expect(
            loadSessionEntry({ sessionKey: "agent:main:main", storePath: sessionsStorePath })
              ?.pendingDeliveryNotice,
          ).toMatchObject({ intentId: `intent-owner-${ownerStatus}`, state: "owed" });
        }
      } finally {
        closeOpenClawStateDatabaseForTest();
      }
    },
  );

  it("resumes a hook-owned pending final with active global reply hooks", async () => {
    const sessionsDir = await makeSessionsDir();
    const storePath = path.join(sessionsDir, "sessions.json");
    const sessionKey = "agent:main:discord:direct:123";
    const registry = createEmptyPluginRegistry();
    addTestHook({
      registry,
      pluginId: "restart-recovery-hook",
      hookName: "before_agent_reply",
      handler: vi.fn(),
    });
    initializeGlobalHookRunner(registry);
    await writeMainSession({
      sessionsDir,
      sessionKey,
      pendingFinalDelivery: makePendingFinalDelivery("hook reply", {
        context: {
          channel: "discord",
          to: "discord:dm:123",
        },
      }),
      restartRecoveryBeforeAgentReplyState: "handled-reply",
      restartRecoveryForceSafeTools: true,
    });
    await writeTranscript(sessionsDir, "main-session", [
      { role: "user", content: "answer from the hook" },
    ]);

    try {
      await expectRecovery({ started: 1, settled: 0, failed: 0, skipped: 0 }, {});
    } finally {
      resetGlobalHookRunner();
    }

    expect(callGateway).toHaveBeenCalledOnce();
    expect(sendRecoveryNotice).not.toHaveBeenCalled();
    expect(loadSessionEntry({ sessionKey, storePath })?.status).toBe("running");
  });

  it("retains restart safety when the first restart follows pending final persistence", async () => {
    const sessionsDir = await writeMainSessionTranscript(
      [
        { role: "user", content: "do the thing" },
        {
          role: "toolResult",
          toolName: "exec",
          content: [
            {
              type: "text",
              text: JSON.stringify({ status: "completed", value: "done", replaySafe: true }),
            },
          ],
        },
        { role: "assistant", content: [{ type: "text", text: "Safe work finished." }] },
      ],
      {
        pendingFinalDelivery: makePendingFinalDelivery("Safe work finished.", {
          createdAt: Date.now() - 5_000,
        }),
      },
    );

    await expectRecovery({ started: 1, settled: 0, failed: 0, skipped: 0 });
    expect(gatewayParams()).toMatchObject({ forceRestartSafeTools: true });
    const store = readStore(path.join(sessionsDir, "sessions.json"));
    expect(store["agent:main:main"]?.restartRecoveryForceSafeTools).toBe(true);
  });

  it("sanitizes durable pending final delivery payloads before resume prompts", async () => {
    const sessionsDir = await makeSessionsDir();
    const pendingPayload = [
      "The final answer is 42.",
      INTERNAL_RUNTIME_CONTEXT_BEGIN,
      "internal recovery detail",
      INTERNAL_RUNTIME_CONTEXT_END,
      "",
      markInboundContextLabel("Conversation info:"),
      "```json",
      '{"message_id":"msg-1"}',
      "```",
    ].join("\n");
    await writeMainSession({
      sessionsDir,
      pendingFinalDelivery: makePendingFinalDelivery(pendingPayload, {
        createdAt: Date.now() - 5_000,
      }),
    });
    await writeTranscript(sessionsDir, "main-session", [
      { role: "user", content: "calculate the answer" },
      { role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "calc" }] },
      { role: "toolResult", content: "42" },
    ]);

    await expectRecovery({ started: 1, settled: 0, failed: 0, skipped: 0 });
    expect(gatewayParams().message).toContain("The final answer is 42.");
    expect(gatewayParams().message).not.toContain(INTERNAL_RUNTIME_CONTEXT_BEGIN);
    expect(gatewayParams().message).not.toContain("Conversation info");

    const store = readStore(path.join(sessionsDir, "sessions.json"));
    expect(store["agent:main:main"]?.pendingFinalDelivery).toMatchObject({
      kind: "replayable",
      text: "The final answer is 42.",
    });
  });

  it("resumes an unguarded pending final delivery without a transcript", async () => {
    const sessionsDir = await makeSessionsDir();
    await writeStore(sessionsDir, {
      "agent:main:main": {
        ...runningSessionEntry("missing-transcript-session"),
        abortedLastRun: true,
        pendingFinalDelivery: makePendingFinalDelivery("The durable final answer.", {
          createdAt: Date.now() - 5_000,
        }),
      },
    });

    await expectRecovery({ started: 1, settled: 0, failed: 0, skipped: 0 });
    expect(gatewayParams().message).toContain("The durable final answer.");
    expect(gatewayParams()).not.toHaveProperty("forceRestartSafeTools");
  });

  it("resumes pending final delivery even when the transcript tail is assistant output", async () => {
    const sessionsDir = await writeMainSessionTranscript(
      [
        { role: "user", content: "finish" },
        { role: "assistant", content: "assistant final was already captured" },
      ],
      {
        pendingFinalDelivery: makePendingFinalDelivery("assistant final was already captured", {
          createdAt: Date.now() - 5_000,
        }),
      },
    );

    await expectRecovery({ started: 1, settled: 0, failed: 0, skipped: 0 });
    expect(callGateway).toHaveBeenCalledOnce();
    expect(gatewayParams().message).toContain("assistant final was already captured");
    const store = readStore(path.join(sessionsDir, "sessions.json"));
    expect(store["agent:main:main"]?.status).toBe("running");
    expect(store["agent:main:main"]?.pendingFinalDelivery).toMatchObject({
      kind: "replayable",
      text: "assistant final was already captured",
    });
  });

  it("does not scan ordinary running sessions without the restart-aborted marker", async () => {
    const sessionsDir = await makeSessionsDir();
    await writeStore(sessionsDir, {
      "agent:main:main": {
        ...runningSessionEntry("main-session"),
      },
    });
    await writeTranscript(sessionsDir, "main-session", [
      { role: "user", content: "current process owns this" },
      { role: "toolResult", content: "done" },
    ]);

    await expectRecovery({ started: 0, settled: 0, failed: 0, skipped: 0 });
    expect(callGateway).not.toHaveBeenCalled();
  });

  it("skips restart-aborted sessions that a current process owns", async () => {
    const sessionsDir = await makeSessionsDir();
    await writeStore(sessionsDir, {
      "agent:main:active-key": {
        ...runningSessionEntry("active-key-session"),
        abortedLastRun: true,
      },
      "agent:main:active-id": {
        ...runningSessionEntry("active-id-session"),
        abortedLastRun: true,
      },
      "agent:main:recoverable": {
        ...runningSessionEntry("recoverable-session"),
        abortedLastRun: true,
      },
    });
    await writeTranscript(sessionsDir, "active-key-session", [
      { role: "user", content: "new run owns this key" },
      { role: "toolResult", content: "done" },
    ]);
    await writeTranscript(sessionsDir, "active-id-session", [
      { role: "user", content: "new run owns this id" },
      { role: "toolResult", content: "done" },
    ]);
    await writeTranscript(sessionsDir, "recoverable-session", [
      { role: "user", content: "recover this one" },
      { role: "toolResult", content: "done" },
    ]);

    const result = await recoverRestartAbortedMainSessions({
      stateDir: tmpDir,
      activeSessionKeys: ["agent:main:active-key"],
      activeSessionIds: ["active-key-session", "active-id-session"],
    });

    expect(result).toEqual({ started: 1, settled: 0, failed: 0, skipped: 2 });
    expect(callGateway).toHaveBeenCalledOnce();
    const store = readStore(path.join(sessionsDir, "sessions.json"));
    expect(store["agent:main:active-key"]?.abortedLastRun).toBe(true);
    expect(store["agent:main:active-id"]?.abortedLastRun).toBe(true);
    expect(store["agent:main:recoverable"]?.abortedLastRun).toBe(false);
  });

  it("recovers duplicate-key restart-aborted rows when the active run owns a different session id", async () => {
    const sessionsDir = await makeSessionsDir();
    await writeStore(sessionsDir, {
      "agent:main:main": {
        ...runningSessionEntry("stale-session"),
        abortedLastRun: true,
      },
    });
    await writeTranscript(sessionsDir, "stale-session", [
      { role: "user", content: "recover the stale duplicate" },
      { role: "toolResult", content: "done" },
    ]);

    const result = await recoverRestartAbortedMainSessions({
      stateDir: tmpDir,
      activeSessionKeys: ["agent:main:main"],
      activeSessionIds: ["new-current-session"],
    });

    expect(result).toEqual({ started: 1, settled: 0, failed: 0, skipped: 0 });
    expect(callGateway).toHaveBeenCalledOnce();
    const store = readStore(path.join(sessionsDir, "sessions.json"));
    expect(store["agent:main:main"]?.abortedLastRun).toBe(false);
  });

  it("marks startup-orphaned running main sessions before recovery", async () => {
    const sessionsDir = await makeSessionsDir();
    const cutoff = Date.now();
    await writeStore(sessionsDir, {
      "agent:main:main": {
        sessionId: "main-session",
        updatedAt: cutoff - 10_000,
        status: "running",
      },
      "agent:main:active-key": {
        sessionId: "active-key-session",
        updatedAt: cutoff - 10_000,
        status: "running",
      },
      "agent:main:active-id": {
        sessionId: "active-id-session",
        updatedAt: cutoff - 10_000,
        status: "running",
      },
      "agent:main:fresh": {
        sessionId: "fresh-session",
        updatedAt: cutoff + 1,
        status: "running",
      },
      "agent:main:subagent:child": {
        sessionId: "child-session",
        updatedAt: cutoff - 10_000,
        status: "running",
        spawnDepth: 1,
      },
      "agent:main:cron:nightly": {
        sessionId: "cron-session",
        updatedAt: cutoff - 10_000,
        status: "running",
      },
      "agent:main:completed": {
        sessionId: "completed-session",
        updatedAt: cutoff - 10_000,
        status: "done",
        restartRecoveryRuns: [
          {
            runId: "completed-prior-process-run",
            lifecycleGeneration: "prior-process",
          },
        ],
      },
      "agent:main:already-marked": {
        sessionId: "already-marked-session",
        updatedAt: cutoff - 10_000,
        status: "running",
        abortedLastRun: true,
        restartRecoveryRuns: [
          {
            runId: "marked-prior-process-run",
            lifecycleGeneration: "prior-process",
          },
        ],
      },
    });
    await writeTranscript(sessionsDir, "main-session", [
      { role: "user", content: "run the tool" },
      { role: "toolResult", content: "done" },
    ]);
    await writeTranscript(sessionsDir, "already-marked-session", [
      { role: "user", content: "already interrupted" },
      { role: "toolResult", content: "done" },
    ]);

    const marked = await markStartupOrphanedMainSessionsForRecovery({
      stateDir: tmpDir,
      activeSessionKeys: ["agent:main:active-key"],
      activeSessionIds: ["active-key-session", "active-id-session"],
      updatedBeforeMs: cutoff,
    });

    expect(marked).toEqual({ marked: 1, skipped: 2 });
    let store = readStore(path.join(sessionsDir, "sessions.json"));
    expect(store["agent:main:main"]?.abortedLastRun).toBe(true);
    expect(store["agent:main:active-key"]?.abortedLastRun).toBeUndefined();
    expect(store["agent:main:active-id"]?.abortedLastRun).toBeUndefined();
    expect(store["agent:main:fresh"]?.abortedLastRun).toBeUndefined();
    expect(store["agent:main:subagent:child"]?.abortedLastRun).toBeUndefined();
    expect(store["agent:main:cron:nightly"]?.abortedLastRun).toBeUndefined();
    expect(store["agent:main:completed"]?.abortedLastRun).toBeUndefined();
    expect(store["agent:main:already-marked"]?.abortedLastRun).toBe(true);
    expect(store["agent:main:completed"]?.restartRecoveryRuns).toHaveLength(1);
    expect(store["agent:main:already-marked"]?.restartRecoveryRuns).toHaveLength(1);

    const recovered = await recoverRestartAbortedMainSessions({ stateDir: tmpDir });

    expect(recovered).toEqual({ started: 2, settled: 0, failed: 0, skipped: 0 });
    expect(callGateway).toHaveBeenCalledTimes(2);
    store = readStore(path.join(sessionsDir, "sessions.json"));
    expect(store["agent:main:main"]?.abortedLastRun).toBe(false);
    expect(store["agent:main:already-marked"]?.abortedLastRun).toBe(false);
  });

  it("does not create empty agent databases while scanning startup recovery", async () => {
    const agentIds = Array.from({ length: 12 }, (_, index) => `agent-${index + 1}`);
    const databasePaths = await Promise.all(
      agentIds.map(async (agentId) => {
        await makeSessionsDir(agentId);
        return path.join(tmpDir, "agents", agentId, "agent", "openclaw-agent.sqlite");
      }),
    );

    await expect(markStartupOrphanedMainSessionsForRecovery({ stateDir: tmpDir })).resolves.toEqual(
      { marked: 0, skipped: 0 },
    );
    for (const databasePath of databasePaths) {
      await expect(fs.stat(databasePath)).rejects.toMatchObject({ code: "ENOENT" });
    }
  });

  it("does not enter the writer lane for agent databases without running sessions", async () => {
    const agentIds = Array.from({ length: 12 }, (_, index) => `agent-${index + 1}`);
    const env = { ...process.env, OPENCLAW_STATE_DIR: tmpDir };
    for (const agentId of agentIds) {
      openOpenClawAgentDatabase({
        agentId,
        env,
        path: path.join(tmpDir, "agents", agentId, "agent", "openclaw-agent.sqlite"),
      });
    }
    closeOpenClawAgentDatabasesForTest();
    const applySessionEntryReplacements = vi.spyOn(
      sessionAccessor,
      "applySessionEntryReplacements",
    );

    try {
      await expect(
        markStartupOrphanedMainSessionsForRecovery({ stateDir: tmpDir }),
      ).resolves.toEqual({ marked: 0, skipped: 0 });
      expect(applySessionEntryReplacements).not.toHaveBeenCalled();
    } finally {
      applySessionEntryReplacements.mockRestore();
    }
  });

  it("keeps corrupt existing agent databases on the startup recovery error path", async () => {
    await makeSessionsDir();
    const databasePath = path.join(tmpDir, "agents", "main", "agent", "openclaw-agent.sqlite");
    await fs.mkdir(path.dirname(databasePath), { recursive: true });
    await fs.writeFile(databasePath, "not a sqlite database");

    await expect(
      markStartupOrphanedMainSessionsForRecovery({ stateDir: tmpDir }),
    ).rejects.toThrow();
  });

  it.each([
    ["current owner before delayed stale registration", "current-first"],
    ["stale owner before current registration", "stale-first"],
  ] as const)("keeps a live session running with %s", async (_label, registrationOrder) => {
    const sessionsDir = await makeSessionsDir();
    const cutoff = Date.now();
    const sessionKey = "agent:main:generation-race";
    const sessionId = "generation-race-session";
    await writeStore(sessionsDir, {
      [sessionKey]: {
        sessionId,
        updatedAt: cutoff - 10_000,
        status: "running",
      },
      "agent:main:control": {
        sessionId: "control-session",
        updatedAt: cutoff - 10_000,
        status: "running",
      },
    });
    await writeTranscript(sessionsDir, "control-session", [
      { role: "user", content: "resume the control session" },
      { role: "toolResult", content: "done" },
    ]);

    const createHandle = (runId: string): EmbeddedAgentQueueHandle => ({
      kind: "embedded",
      runId,
      queueMessage: async () => {},
      isStreaming: () => true,
      isCompacting: () => false,
      abort: () => {},
    });
    const priorLifecycleGeneration = getAgentEventLifecycleGeneration();
    const staleHandle = createHandle("stale-generation-run");
    setActiveEmbeddedRunLifecycleGeneration(staleHandle, priorLifecycleGeneration);
    if (registrationOrder === "stale-first") {
      setActiveEmbeddedRun(sessionId, staleHandle, sessionKey);
    }

    rotateAgentEventLifecycleGeneration();
    const currentHandle = createHandle("current-generation-run");
    setActiveEmbeddedRun(sessionId, currentHandle, sessionKey);
    if (registrationOrder === "current-first") {
      setActiveEmbeddedRun(sessionId, staleHandle, sessionKey);
    }

    const recovery = scheduleRestartAbortedMainSessionRecovery({
      getConfig: () => ({}),
      delayMs: 0,
      stateDir: tmpDir,
    });
    try {
      await waitForFast(() =>
        expect(
          loadSessionEntry({
            sessionKey: "agent:main:control",
            storePath: path.join(sessionsDir, "sessions.json"),
          }),
        ).toMatchObject({ abortedLastRun: false }),
      );
      await recovery.stop();

      expect(callGateway).toHaveBeenCalledOnce();
      const activeEntry = loadSessionEntry({
        sessionKey,
        storePath: path.join(sessionsDir, "sessions.json"),
      });
      expect(activeEntry).toMatchObject({ status: "running" });
      expect(activeEntry?.abortedLastRun).toBeUndefined();
    } finally {
      await recovery.stop();
      clearActiveEmbeddedRun(sessionId, currentHandle, sessionKey);
      clearActiveEmbeddedRun(sessionId, staleHandle, sessionKey);
    }
  });

  it("cancels a stale startup owner after a mid-scan lifecycle rotation", async () => {
    const sessionsDir = await makeSessionsDir();
    const storePath = path.join(sessionsDir, "sessions.json");
    const sessionKey = "agent:main:generation-race";
    const sessionId = "generation-race-session";
    await writeStore(sessionsDir, {
      [sessionKey]: {
        sessionId,
        updatedAt: Date.now() - 10_000,
        status: "running",
      },
    });

    const originalApply = sessionAccessor.applySessionEntryReplacements;
    const markerEntered = createDeferred();
    const releaseMarker = createDeferred();
    let pausedMarker = false;
    const replacementSpy = vi
      .spyOn(sessionAccessor, "applySessionEntryReplacements")
      .mockImplementation(async (params) => {
        if (params.requireWriteSuccess === true && !pausedMarker) {
          pausedMarker = true;
          markerEntered.resolve();
          await releaseMarker.promise;
        }
        return await originalApply(params);
      });
    const recovery = scheduleRestartAbortedMainSessionRecovery({
      getConfig: () => ({}),
      delayMs: 0,
      stateDir: tmpDir,
    });
    await markerEntered.promise;
    expect(getActiveGatewayRootWorkCount()).toBe(1);

    // Rotate while the production scheduler owns the startup scan. Its marker
    // must re-read the replacement generation's owner before writing, while
    // stop waits for that in-flight root-work admission to leave cleanly.
    rotateAgentEventLifecycleGeneration();
    const liveAbort = vi.fn();
    const liveHandle: EmbeddedAgentQueueHandle = {
      kind: "embedded",
      runId: "live-run",
      queueMessage: async () => {},
      isStreaming: () => true,
      isCompacting: () => false,
      abort: liveAbort,
    };
    setActiveEmbeddedRun(sessionId, liveHandle, sessionKey);
    let stopSettled = false;
    const stopping = recovery.stop().then(() => {
      stopSettled = true;
    });
    try {
      await Promise.resolve();
      expect(stopSettled).toBe(false);

      releaseMarker.resolve();
      await stopping;

      expect(callGateway).not.toHaveBeenCalled();
      const entry = loadSessionEntry({ sessionKey, storePath });
      expect(entry).toMatchObject({ status: "running" });
      expect(entry?.abortedLastRun).toBeUndefined();
      expect(entry?.mainRestartRecovery).toBeUndefined();
      expect(liveAbort).not.toHaveBeenCalled();
      expect(getActiveGatewayRootWorkCount()).toBe(0);
    } finally {
      releaseMarker.resolve();
      await stopping;
      replacementSpy.mockRestore();
      clearActiveEmbeddedRun(sessionId, liveHandle, sessionKey);
    }
  });

  it("recovers only the configured store for duplicate startup-orphaned session keys", async () => {
    const cutoff = Date.now();
    const defaultSessionsDir = await makeSessionsDir();
    await writeStore(defaultSessionsDir, {
      "agent:main:main": {
        sessionId: "default-main-session",
        updatedAt: cutoff - 10_000,
        status: "running",
      },
    });
    await writeTranscript(defaultSessionsDir, "default-main-session", [
      { role: "user", content: "continue default" },
      { role: "toolResult", content: "default result" },
    ]);

    const customStorePath = path.join(tmpDir, "custom-startup-duplicate", "sessions.json");
    await writeStorePath(customStorePath, {
      "agent:main:main": {
        sessionId: "custom-main-session",
        updatedAt: cutoff - 10_000,
        status: "running",
      },
    });
    await writeTranscript(path.dirname(customStorePath), "custom-main-session", [
      { role: "user", content: "continue custom" },
      { role: "toolResult", content: "custom result" },
    ]);

    const recovery = scheduleRestartAbortedMainSessionRecovery({
      getConfig: () => ({ session: { store: customStorePath } }),
      delayMs: 0,
      stateDir: tmpDir,
    });
    try {
      await waitForFast(() =>
        expect(
          loadSessionEntry({ sessionKey: "agent:main:main", storePath: customStorePath }),
        ).toMatchObject({ abortedLastRun: false }),
      );
      await recovery.stop();
    } finally {
      await recovery.stop();
    }

    expect(callGateway).toHaveBeenCalledOnce();
    const defaultStore = readStore(path.join(defaultSessionsDir, "sessions.json"));
    const customStore = readStore(customStorePath);
    expect(defaultStore["agent:main:main"]?.abortedLastRun).toBe(true);
    expect(customStore["agent:main:main"]?.abortedLastRun).toBe(false);
  });

  it("rediscovers a restored configured store between startup marking and recovery", async () => {
    const sessionsDir = await makeSessionsDir();
    const storePath = path.join(sessionsDir, "sessions.json");
    await writeMainSession({ sessionsDir, abortedLastRun: undefined });
    await writeTranscript(sessionsDir, "main-session", [
      { role: "user", content: "resume the interrupted main session" },
      { role: "toolResult", content: "main result" },
    ]);

    const lateSessionsDir = path.join(tmpDir, "agents", "late", "sessions");
    const lateStorePath = path.join(lateSessionsDir, "sessions.json");
    const cfg = {
      agents: { list: [{ id: "main", default: true }, { id: "late" }] },
    } as OpenClawConfig;
    const discoverySpy = vi.spyOn(configSessions, "resolveAllAgentSessionStoreTargetsSync");
    const originalApply = sessionAccessor.applySessionEntryReplacements;
    let restoredLateStore = false;
    const replacementSpy = vi
      .spyOn(sessionAccessor, "applySessionEntryReplacements")
      .mockImplementation(async (params) => {
        const result = await originalApply(params);
        if (params.requireWriteSuccess === true && !restoredLateStore) {
          restoredLateStore = true;
          await writeStorePath(lateStorePath, {
            "agent:late:main": {
              sessionId: "late-session",
              updatedAt: 1,
              status: "running",
              abortedLastRun: true,
            },
          });
          await writeTranscript(lateSessionsDir, "late-session", [
            { role: "user", content: "resume the restored session" },
            { role: "toolResult", content: "late result" },
          ]);
        }
        return result;
      });

    const recovery = scheduleRestartAbortedMainSessionRecovery({
      getConfig: () => cfg,
      delayMs: 0,
      stateDir: tmpDir,
    });
    try {
      await waitForFast(() => expect(callGateway).toHaveBeenCalledTimes(2));
      await recovery.stop();

      expect(loadSessionEntry({ sessionKey: "agent:main:main", storePath })).toMatchObject({
        abortedLastRun: false,
      });
      expect(
        loadSessionEntry({ sessionKey: "agent:late:main", storePath: lateStorePath }),
      ).toMatchObject({ abortedLastRun: false });
      expect(discoverySpy.mock.calls.filter(([observedCfg]) => observedCfg === cfg)).toHaveLength(
        2,
      );
    } finally {
      await recovery.stop();
      replacementSpy.mockRestore();
      discoverySpy.mockRestore();
    }
  });

  it("cancels startup recovery when its gateway lifecycle stops", async () => {
    const sessionsDir = await makeSessionsDir();
    await writeMainSession({
      sessionsDir,
      pendingFinalDelivery: makePendingFinalDelivery(),
    });

    vi.useFakeTimers();
    try {
      const recovery = scheduleRestartAbortedMainSessionRecovery({
        getConfig: () => ({}),
        delayMs: 5_000,
        stateDir: tmpDir,
      });

      await Promise.all([recovery.stop(), recovery.stop()]);
      await vi.advanceTimersByTimeAsync(5_000);

      expect(callGateway).not.toHaveBeenCalled();
      expect(
        loadSessionEntry({
          sessionKey: "agent:main:main",
          storePath: path.join(sessionsDir, "sessions.json"),
        }),
      ).toMatchObject({ status: "running", abortedLastRun: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels an immediate startup recovery before its queued attempt can claim a session", async () => {
    const { storePath } = await makeMainSessionFixture({
      pendingFinalDelivery: makePendingFinalDelivery(),
    });

    const recovery = scheduleRestartAbortedMainSessionRecovery({
      getConfig: () => ({}),
      delayMs: 0,
      stateDir: tmpDir,
    });
    await recovery.stop();

    expect(callGateway).not.toHaveBeenCalled();
    expect(getActiveGatewayRootWorkCount()).toBe(0);
    expect(loadSessionEntry({ sessionKey: "agent:main:main", storePath })).toMatchObject({
      status: "running",
      abortedLastRun: true,
    });
  });

  it("waits for startup release while preserving the registration cutoff", async () => {
    const sessionsDir = await makeSessionsDir();
    const storePath = path.join(sessionsDir, "sessions.json");
    const releaseStartup = createDeferred();
    await writeStore(sessionsDir, {
      "agent:main:main": {
        ...runningSessionEntry("pre-start-session"),
        updatedAt: 1,
      },
    });
    await writeTranscript(sessionsDir, "pre-start-session", [
      { role: "user", content: "resume the interrupted work" },
      { role: "toolResult", content: "done" },
    ]);

    const recovery = scheduleRestartAbortedMainSessionRecovery({
      getConfig: () => ({}),
      delayMs: 0,
      stateDir: tmpDir,
      waitForStart: () => releaseStartup.promise,
    });
    await Promise.resolve();
    expect(callGateway).not.toHaveBeenCalled();

    const postRegistrationUpdatedAt = Date.now() + 60_000;
    await writeStore(sessionsDir, {
      ...readStore(storePath),
      "agent:main:fresh": {
        ...runningSessionEntry("post-start-session"),
        updatedAt: postRegistrationUpdatedAt,
      },
    });
    await writeTranscript(sessionsDir, "post-start-session", [
      { role: "user", content: "new work from this gateway" },
      { role: "toolResult", content: "done" },
    ]);

    releaseStartup.resolve();
    await waitForFast(() => expect(callGateway).toHaveBeenCalledOnce());
    await recovery.stop();

    const store = readStore(storePath);
    expect(store["agent:main:main"]?.abortedLastRun).toBe(false);
    expect(store["agent:main:fresh"]).toMatchObject({
      sessionId: "post-start-session",
      status: "running",
    });
    expect(store["agent:main:fresh"]?.abortedLastRun).toBeUndefined();
  });

  it("uses the live configured roster after the startup recovery barrier", async () => {
    const sessionsDir = await makeSessionsDir("work");
    const storePath = path.join(sessionsDir, "sessions.json");
    const releaseStartup = createDeferred();
    await writeMainSession({ sessionsDir, sessionKey: "agent:work:main" });
    await writeTranscript(sessionsDir, "main-session", [
      { role: "user", content: "resume after config reload" },
      { role: "toolResult", content: "done" },
    ]);
    let currentConfig = {
      agents: { list: [{ id: "main", default: true }] },
    } as OpenClawConfig;

    const recovery = scheduleRestartAbortedMainSessionRecovery({
      delayMs: 0,
      getConfig: () => currentConfig,
      stateDir: tmpDir,
      waitForStart: () => releaseStartup.promise,
    });
    await Promise.resolve();
    currentConfig = {
      agents: { list: [{ id: "main", default: true }, { id: "work" }] },
    } as OpenClawConfig;
    releaseStartup.resolve();

    await waitForFast(() => expect(callGateway).toHaveBeenCalledOnce());
    await recovery.stop();
    expect(loadSessionEntry({ sessionKey: "agent:work:main", storePath })).toMatchObject({
      abortedLastRun: false,
    });
  });

  it("stops without waiting for an unresolved startup release", async () => {
    const releaseStartup = createDeferred();
    const { storePath } = await makeMainSessionFixture({
      pendingFinalDelivery: makePendingFinalDelivery(),
    });

    const recovery = scheduleRestartAbortedMainSessionRecovery({
      getConfig: () => ({}),
      delayMs: 0,
      stateDir: tmpDir,
      waitForStart: () => releaseStartup.promise,
    });
    await recovery.stop();
    releaseStartup.resolve();
    await Promise.resolve();

    expect(callGateway).not.toHaveBeenCalled();
    expect(getActiveGatewayRootWorkCount()).toBe(0);
    expect(loadSessionEntry({ sessionKey: "agent:main:main", storePath })).toMatchObject({
      status: "running",
      abortedLastRun: true,
    });
  });

  it("fences an in-flight startup recovery before its durable session claim", async () => {
    const { storePath } = await makeMainSessionFixture({
      pendingFinalDelivery: makePendingFinalDelivery(),
    });

    const originalApply = sessionAccessor.applySessionEntryReplacements;
    const observeEntered = createDeferred();
    const releaseObserve = createDeferred();
    let pausedObservation = false;
    const replacementSpy = vi
      .spyOn(sessionAccessor, "applySessionEntryReplacements")
      .mockImplementation(async (params) => {
        if (params.requireWriteSuccess === true && !pausedObservation) {
          pausedObservation = true;
          observeEntered.resolve();
          await releaseObserve.promise;
        }
        return await originalApply(params);
      });

    const recovery = scheduleRestartAbortedMainSessionRecovery({
      getConfig: () => ({}),
      delayMs: 0,
      stateDir: tmpDir,
    });
    let stopping: Promise<void> | undefined;
    try {
      await observeEntered.promise;
      expect(getActiveGatewayRootWorkCount()).toBe(1);
      let stopSettled = false;
      stopping = recovery.stop().then(() => {
        stopSettled = true;
      });
      await Promise.resolve();

      expect(stopSettled).toBe(false);
      expect(callGateway).not.toHaveBeenCalled();

      releaseObserve.resolve();
      await stopping;

      expect(callGateway).not.toHaveBeenCalled();
      expect(getActiveGatewayRootWorkCount()).toBe(0);
      expect(loadSessionEntry({ sessionKey: "agent:main:main", storePath })).toMatchObject({
        status: "running",
        abortedLastRun: true,
      });
      expect(
        loadSessionEntry({ sessionKey: "agent:main:main", storePath })?.mainRestartRecovery,
      ).toBeUndefined();
    } finally {
      releaseObserve.resolve();
      await stopping;
      replacementSpy.mockRestore();
    }
  });

  it("joins an in-flight startup dispatch before stopping its recovery owner", async () => {
    await makeMainSessionFixture({
      pendingFinalDelivery: makePendingFinalDelivery(),
    });

    const dispatchEntered = createDeferred();
    const releaseDispatch = createDeferred();
    vi.mocked(callGateway).mockImplementationOnce(async () => {
      dispatchEntered.resolve();
      await releaseDispatch.promise;
      return { runId: "run-resumed" };
    });

    const recovery = scheduleRestartAbortedMainSessionRecovery({
      getConfig: () => ({}),
      delayMs: 0,
      stateDir: tmpDir,
    });
    let stopping: Promise<void> | undefined;
    try {
      await dispatchEntered.promise;
      let stopSettled = false;
      stopping = recovery.stop().then(() => {
        stopSettled = true;
      });
      await Promise.resolve();

      expect(stopSettled).toBe(false);
      expect(getActiveGatewayRootWorkCount()).toBe(1);

      releaseDispatch.resolve();
      await stopping;

      expect(callGateway).toHaveBeenCalledOnce();
      expect(getActiveGatewayRootWorkCount()).toBe(0);
    } finally {
      releaseDispatch.resolve();
      await stopping;
    }
  });

  it("fences an ambiguous terminal probe when its startup recovery owner stops", async () => {
    const { storePath } = await makeMainSessionFixture({
      pendingFinalDelivery: makePendingFinalDelivery(),
    });

    const probeEntered = createDeferred();
    const releaseProbe = createDeferred();
    let recoveryRunId: string | undefined;
    vi.mocked(callGateway).mockImplementation(async (request) => {
      if (request.method === "agent") {
        recoveryRunId = String((request.params as { idempotencyKey?: unknown }).idempotencyKey);
        throw new Error("ambiguous recovery dispatch transport failure");
      }
      if (request.method === "agent.wait") {
        probeEntered.resolve();
        await releaseProbe.promise;
        return { runId: recoveryRunId, status: "ok", endedAt: Date.now() };
      }
      return { runId: "run-resumed" };
    });

    const recovery = scheduleRestartAbortedMainSessionRecovery({
      getConfig: () => ({}),
      delayMs: 0,
      stateDir: tmpDir,
    });
    let stopping: Promise<void> | undefined;
    try {
      await probeEntered.promise;
      expect(getActiveGatewayRootWorkCount()).toBe(1);
      expect(recoveryRunId).toEqual(expect.any(String));

      let stopSettled = false;
      stopping = recovery.stop().then(() => {
        stopSettled = true;
      });
      await Promise.resolve();

      expect(stopSettled).toBe(false);
      expect(callGateway).toHaveBeenCalledTimes(2);

      releaseProbe.resolve();
      await stopping;

      const entry = loadSessionEntry({ sessionKey: "agent:main:main", storePath });
      expect(entry).toMatchObject({
        status: "running",
        abortedLastRun: true,
        pendingFinalDelivery: {
          kind: "replayable",
          text: "interrupted response",
        },
        mainRestartRecovery: { chargedAttempts: 1 },
      });
      expect(entry?.mainRestartRecovery?.reservation).toBeUndefined();
      expect(entry?.restartRecoveryTerminalRunIds ?? []).not.toContain(recoveryRunId);
      expect(entry?.restartRecoveryRuns ?? []).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ runId: recoveryRunId })]),
      );
      expect(callGateway).toHaveBeenCalledTimes(2);
      expect(getActiveGatewayRootWorkCount()).toBe(0);
    } finally {
      releaseProbe.resolve();
      await (stopping ?? recovery.stop());
    }
  });

  it("retains canonical retry backoff when startup recovery begins immediately", async () => {
    const sessionsDir = await makeSessionsDir();
    await writeMainSession({
      sessionsDir,
      pendingFinalDelivery: makePendingFinalDelivery(),
    });
    const cfg = {} as OpenClawConfig;
    const discoverySpy = vi.spyOn(configSessions, "resolveAllAgentSessionStoreTargetsSync");
    const firstDispatch = createDeferred();
    const secondDispatch = createDeferred();
    let firstAgentDispatch = true;
    vi.mocked(callGateway).mockImplementation(async (request) => {
      if (request.method === "agent") {
        if (firstAgentDispatch) {
          firstAgentDispatch = false;
          firstDispatch.resolve();
          throw new Error("transient startup failure");
        }
        secondDispatch.resolve();
      }
      return { runId: "run-resumed" };
    });

    vi.useFakeTimers();
    const retryScheduled = createDeferred();
    const fakeSetTimeout = globalThis.setTimeout;
    const setTimeoutSpy = vi
      .spyOn(globalThis, "setTimeout")
      .mockImplementation((...args: Parameters<typeof setTimeout>) => {
        const timer = fakeSetTimeout(...args);
        if (args[1] === 5_000) {
          retryScheduled.resolve();
        }
        return timer;
      });
    const countAgentDispatches = () =>
      vi.mocked(callGateway).mock.calls.filter(([request]) => request.method === "agent").length;
    let recovery: ReturnType<typeof scheduleRestartAbortedMainSessionRecovery> | undefined;
    try {
      recovery = scheduleRestartAbortedMainSessionRecovery({
        getConfig: () => cfg,
        delayMs: 0,
        maxRetries: 2,
        stateDir: tmpDir,
      });
      await firstDispatch.promise;
      await retryScheduled.promise;
      expect(countAgentDispatches()).toBe(1);

      await writeStore(sessionsDir, {
        "agent:main:late-startup-row": {
          sessionId: "late-startup-session",
          updatedAt: 1,
          status: "running",
        },
      });
      await writeTranscript(sessionsDir, "late-startup-session", [
        { role: "user", content: "this row appeared after startup marking" },
        { role: "toolResult", content: "done" },
      ]);

      await vi.advanceTimersByTimeAsync(4_999);
      expect(countAgentDispatches()).toBe(1);

      await vi.advanceTimersByTimeAsync(1);
      await secondDispatch.promise;
      await recovery.stop();

      expect(countAgentDispatches()).toBe(2);
      const lateEntry = loadSessionEntry({
        sessionKey: "agent:main:late-startup-row",
        storePath: path.join(sessionsDir, "sessions.json"),
      });
      expect(lateEntry).toMatchObject({ status: "running" });
      expect(lateEntry?.abortedLastRun).toBeUndefined();
      expect(discoverySpy.mock.calls.filter(([observedCfg]) => observedCfg === cfg)).toHaveLength(
        4,
      );
    } finally {
      await recovery?.stop();
      setTimeoutSpy.mockRestore();
      discoverySpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it("admits each scheduled recovery attempt as independent root work", async () => {
    const sessionsDir = await makeSessionsDir();
    await writeMainSession({
      sessionsDir,
      pendingFinalDelivery: makePendingFinalDelivery(),
    });

    const suspensionRef: {
      current: ReturnType<typeof tryBeginGatewaySuspendAdmission>;
    } = { current: null };
    vi.mocked(callGateway)
      .mockImplementationOnce(async () => {
        expect(getActiveGatewayRootWorkCount()).toBe(1);
        suspensionRef.current = tryBeginGatewaySuspendAdmission(() => {});
        expect(suspensionRef.current?.commit()).toBe(true);
        throw new Error("retry after suspension");
      })
      .mockImplementationOnce(async () => {
        expect(getActiveGatewayRootWorkCount()).toBe(1);
        return { runId: "run-resumed", status: "timeout" };
      })
      .mockImplementationOnce(async () => {
        expect(getActiveGatewayRootWorkCount()).toBe(1);
        return { runId: "run-resumed" };
      });

    scheduleRestartAbortedMainSessionRecovery({
      getConfig: () => ({}),
      delayMs: 1,
      maxRetries: 2,
      stateDir: tmpDir,
    });

    await waitForFast(() => {
      expect(callGateway).toHaveBeenCalledTimes(2);
      expect(getActiveGatewayRootWorkCount()).toBe(0);
    });
    expect(suspensionRef.current?.release()).toBe(true);

    await waitForFast(() => {
      expect(callGateway).toHaveBeenCalledTimes(3);
      const entry = loadSessionEntry({
        storePath: path.join(sessionsDir, "sessions.json"),
        sessionKey: "agent:main:main",
      });
      expect(entry?.abortedLastRun).toBe(false);
    });
    const runIds = vi
      .mocked(callGateway)
      .mock.calls.map(([request]) =>
        request.method === "agent"
          ? (request.params as { idempotencyKey?: unknown }).idempotencyKey
          : undefined,
      )
      .filter((runId) => runId !== undefined);
    expect(new Set(runIds).size).toBe(1);
    expect(getActiveGatewayRootWorkCount()).toBe(0);
  });

  it("retries only the requested abandoned durable claim", async () => {
    const sessionsDir = await makeSessionsDir();
    const storePath = path.join(sessionsDir, "sessions.json");
    await writeStore(sessionsDir, {
      "agent:main:main": {
        ...mainSessionEntry(),
        restartRecoveryDeliveryRunId: "recovery-main",
        restartRecoveryDeliverySourceRunId: "source-main",
        restartRecoverySourceIngress: "channel",
        restartRecoverySourceReplyDeliveryMode: "message_tool_only",
        restartRecoveryDeliveryContext: {
          channel: "discord",
          to: "discord:dm:main",
          accountId: "work",
        },
      },
      "agent:main:other": {
        ...runningSessionEntry("other-session"),
        abortedLastRun: true,
        restartRecoveryDeliveryRunId: "recovery-other",
        restartRecoveryDeliverySourceRunId: "source-other",
      },
    });
    await writeTranscript(sessionsDir, "main-session", [
      { role: "user", content: "recover only me" },
    ]);
    await writeTranscript(sessionsDir, "other-session", [
      { role: "user", content: "leave me pending" },
    ]);

    const result = await retryRestartAbortedMainSessionRecovery({
      cfg: {},
      expectedRecoveryRunId: "recovery-main",
      expectedRecoverySourceRunId: "source-main",
      expectedSessionId: "main-session",
      sessionKey: "agent:main:main",
      storePath,
    });

    expect(result).toEqual({ started: 1, settled: 0, failed: 0, skipped: 0 });
    expect(callGateway).toHaveBeenCalledOnce();
    expect(gatewayParams().idempotencyKey).toBe("recovery-main");
    expect(gatewayParams()).toMatchObject({
      expectedExistingSessionId: "main-session",
      internalRuntimeHandoffId: expect.any(String),
      sessionKey: "agent:main:main",
      sourceReplyDeliveryMode: "message_tool_only",
      deliver: false,
      channel: "discord",
      to: "discord:dm:main",
      accountId: "work",
    });
    expect(loadSessionEntry({ sessionKey: "agent:main:main", storePath })).toMatchObject({
      abortedLastRun: false,
      restartRecoveryDeliveryRunId: "recovery-main",
    });
    expect(loadSessionEntry({ sessionKey: "agent:main:other", storePath })).toMatchObject({
      abortedLastRun: true,
      restartRecoveryDeliveryRunId: "recovery-other",
    });
  });

  it("retries only the exact interrupted row released by its final foreground owner", async () => {
    const sessionsDir = await makeSessionsDir();
    const storePath = path.join(sessionsDir, "sessions.json");
    await writeStore(sessionsDir, {
      "agent:main:main": {
        ...mainSessionEntry(),
      },
      "agent:main:other": {
        ...runningSessionEntry("other-session"),
        abortedLastRun: true,
      },
    });
    await writeCompletedToolTranscript(sessionsDir);
    await writeTranscript(sessionsDir, "other-session", [
      { role: "user", content: "leave this row pending" },
    ]);

    const result = await retryRestartAbortedMainSessionRecoveryAfterOwnerRelease({
      expectedSessionId: "main-session",
      sessionKey: "agent:main:main",
      storePath,
    });

    expect(result).toEqual({ started: 1, settled: 0, failed: 0, skipped: 0 });
    expect(callGateway).toHaveBeenCalledOnce();
    expect(loadSessionEntry({ sessionKey: "agent:main:main", storePath })).toMatchObject({
      abortedLastRun: false,
    });
    expect(loadSessionEntry({ sessionKey: "agent:main:other", storePath })).toMatchObject({
      abortedLastRun: true,
    });
    expect(isSessionWorkAdmissionActive(storePath, ["agent:main:main", "main-session"])).toBe(
      false,
    );
  });

  it("retries a failed exact owner-release recovery with bounded backoff", async () => {
    const { sessionsDir, storePath } = await makeMainSessionFixture({
      restartRecoveryDeliveryRunId: "control-ui-run",
      restartRecoveryDeliverySourceRunId: "control-ui-run",
    });
    await writeCompletedToolTranscript(sessionsDir);
    vi.mocked(callGateway)
      .mockRejectedValueOnce(new Error("temporary dispatch failure"))
      .mockResolvedValueOnce({ runId: "run-resumed", status: "running" })
      .mockResolvedValueOnce({ runId: "run-resumed" });

    scheduleRestartAbortedMainSessionRecoveryAfterOwnerRelease({
      delayMs: 0,
      expectedSessionId: "main-session",
      getConfig: () => ({}),
      getGatewayRuntime: () => mockRecoveryRuntime,
      maxRetries: 2,
      sessionKey: "agent:main:main",
      storePath,
    });

    await vi.waitFor(() => expect(callGateway).toHaveBeenCalledTimes(3), { timeout: 5_000 });
    expect(loadSessionEntry({ sessionKey: "agent:main:main", storePath })).toMatchObject({
      abortedLastRun: false,
    });
    expect(getActiveGatewayRootWorkCount()).toBe(0);
  });

  it("tombstones exhausted recovery with replacement-session instructions", async () => {
    const { storePath } = await makeMainSessionFixture({
      sessionKey: "agent:main:discord:direct:123",
      mainRestartRecovery: {
        cycleId: "cycle-exhausted",
        revision: 1,
        chargedAttempts: 3,
      },
      restartRecoveryDeliveryContext: discordDeliveryContext,
    });

    await expectRecovery({ started: 0, settled: 0, failed: 0, skipped: 1 });
    expect(sendRecoveryNotice).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("Resume in new session"),
      }),
    );
    expect(sendRecoveryNotice).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining("/new or /reset") }),
    );
    expect(
      loadSessionEntry({ sessionKey: "agent:main:discord:direct:123", storePath }),
    ).toMatchObject({
      status: "failed",
      mainRestartRecovery: { tombstone: expect.any(Object) },
    });
  });

  it("rejects foreground takeover while tombstoning exhausted recovery", async () => {
    const { sessionsDir, storePath, sessionKey } = await makeMainSessionFixture({
      mainRestartRecovery: {
        cycleId: "cycle-exhausted",
        revision: 1,
        chargedAttempts: 3,
      },
    });
    await writeTranscript(sessionsDir, "main-session", [
      { role: "user", content: "continue this turn" },
    ]);
    const appendAssistantMessageToSessionTranscript =
      transcriptMocks.appendAssistantMessageToSessionTranscript.getMockImplementation();
    if (!appendAssistantMessageToSessionTranscript) {
      throw new Error("expected transcript append implementation");
    }
    transcriptMocks.appendAssistantMessageToSessionTranscript.mockImplementationOnce(
      async (params) => {
        const owner = await claimMainSessionRecoveryOwner({
          lifecycleGeneration: getAgentEventLifecycleGeneration(),
          sessionId: "main-session",
          target: { sessionKey, storePath },
        });
        expect(owner).toEqual({ kind: "invalidated", reason: "recovery_exhausted" });
        return await appendAssistantMessageToSessionTranscript(params);
      },
    );

    await expectRecovery({ started: 0, settled: 0, failed: 0, skipped: 1 });

    const entry = loadSessionEntry({ sessionKey, storePath });
    expect(entry).toMatchObject({
      status: "failed",
      abortedLastRun: false,
      mainRestartRecovery: { tombstone: expect.any(Object) },
    });
    const notices = (
      await loadTranscriptEvents({
        agentId: "main",
        sessionId: "main-session",
        sessionKey,
        storePath,
      })
    ).filter((event) => {
      const record = event as { type?: unknown; message?: { idempotencyKey?: unknown } };
      return (
        record.type === "message" &&
        typeof record.message?.idempotencyKey === "string" &&
        record.message.idempotencyKey.endsWith(":failed-notice")
      );
    });
    expect(notices).toHaveLength(1);
  });

  it("retries tombstoning after a transcript metadata conflict", async () => {
    const { sessionsDir, storePath, sessionKey } = await makeMainSessionFixture({
      mainRestartRecovery: {
        cycleId: "cycle-exhausted",
        revision: 1,
        chargedAttempts: 3,
      },
    });
    await writeTranscript(sessionsDir, "main-session", [
      { role: "user", content: "continue this turn" },
    ]);
    transcriptMocks.appendAssistantMessageToSessionTranscript.mockResolvedValueOnce({
      ok: false,
      code: "session-rebound",
      reason: "session metadata changed",
    });

    await expectRecovery({ started: 0, settled: 0, failed: 0, skipped: 1 });

    expect(transcriptMocks.appendAssistantMessageToSessionTranscript).toHaveBeenCalledTimes(2);
    expect(loadSessionEntry({ sessionKey, storePath })).toMatchObject({
      status: "failed",
      abortedLastRun: false,
      mainRestartRecovery: { tombstone: expect.any(Object) },
    });
  });

  it("tombstones when the final owner-release retry consumes the last charge", async () => {
    const { sessionsDir, storePath } = await makeControlUiRecoveryFixture({
      mainRestartRecovery: {
        cycleId: "cycle-final-attempt",
        revision: 1,
        chargedAttempts: 2,
      },
    });
    await writeCompletedToolTranscript(sessionsDir);
    vi.mocked(callGateway)
      .mockRejectedValueOnce(new Error("final ambiguous dispatch failure"))
      .mockResolvedValueOnce({ runId: "run-resumed", status: "running" });

    scheduleRestartAbortedMainSessionRecoveryAfterOwnerRelease({
      delayMs: 0,
      expectedSessionId: "main-session",
      getConfig: () => ({}),
      getGatewayRuntime: () => mockRecoveryRuntime,
      maxRetries: 1,
      sessionKey: "agent:main:main",
      storePath,
    });

    await waitForFast(() => {
      expect(loadSessionEntry({ sessionKey: "agent:main:main", storePath })).toMatchObject({
        status: "failed",
        lastRunId: "control-ui-run",
        mainRestartRecovery: { tombstone: expect.any(Object) },
      });
    });
    expect(callGateway).toHaveBeenCalledTimes(2);
  });

  it("tombstones when the final startup retry consumes the last charge", async () => {
    const { storePath } = await makeMainSessionFixture({
      mainRestartRecovery: {
        cycleId: "cycle-final-startup-attempt",
        revision: 1,
        chargedAttempts: 2,
      },
      pendingFinalDelivery: makePendingFinalDelivery(),
    });
    vi.mocked(callGateway)
      .mockImplementationOnce(async () => {
        await replaceSessionEntry({ sessionKey: "agent:main:fresh", storePath }, {
          sessionId: "fresh-session",
          updatedAt: Date.now(),
          status: "running",
          abortedLastRun: true,
          mainRestartRecovery: {
            cycleId: "cycle-fresh-exhausted",
            revision: 1,
            chargedAttempts: 3,
          },
        } as SessionEntry);
        throw new Error("final ambiguous dispatch failure");
      })
      .mockResolvedValueOnce({ runId: "run-resumed" });

    scheduleRestartAbortedMainSessionRecovery({
      getConfig: () => ({ agents: { entries: { main: { default: true } } } }),
      delayMs: 0,
      maxRetries: 1,
      stateDir: tmpDir,
    });

    await waitForFast(() => {
      expect(loadSessionEntry({ sessionKey: "agent:main:main", storePath })).toMatchObject({
        status: "failed",
        mainRestartRecovery: { tombstone: expect.any(Object) },
      });
    });
    expect(callGateway).toHaveBeenCalledTimes(2);
    const freshEntry = loadSessionEntry({ sessionKey: "agent:main:fresh", storePath });
    expect(freshEntry).toMatchObject({
      sessionId: "fresh-session",
      status: "running",
      abortedLastRun: true,
      mainRestartRecovery: { chargedAttempts: 3 },
    });
    expect(freshEntry?.mainRestartRecovery?.tombstone).toBeUndefined();
  });

  it("tombstones when message-tool-only authority cannot be reconstructed", async () => {
    const { sessionsDir, storePath } = await makeMainSessionFixture({
      restartRecoveryDeliveryRunId: "recovery-main",
      restartRecoverySourceIngress: "channel",
      restartRecoverySourceReplyDeliveryMode: "message_tool_only",
      restartRecoveryDeliveryContext: {
        channel: "discord",
        to: "discord:dm:main",
        accountId: "work",
      },
    });
    await writeTranscript(sessionsDir, "main-session", [
      { role: "user", content: "recover only with delivery authority" },
    ]);

    await expectRecovery({ started: 0, settled: 0, failed: 0, skipped: 1 });
    expect(sendRecoveryNotice).toHaveBeenCalledOnce();
    expect(sendRecoveryNotice).toHaveBeenCalledWith({
      accountId: "work",
      channel: "discord",
      to: "discord:dm:main",
      threadId: undefined,
      idempotencyKey: "main-session-restart-recovery:recovery-main:failed-notice",
      text: expect.stringContaining("Resume in new session"),
    });
    const failedEntry = loadSessionEntry({ sessionKey: "agent:main:main", storePath });
    expect(failedEntry).toMatchObject({
      abortedLastRun: false,
      status: "failed",
      mainRestartRecovery: { tombstone: expect.any(Object) },
    });
    expect(failedEntry?.restartRecoveryDeliveryRunId).toBe("recovery-main");
    expect(failedEntry?.restartRecoverySourceReplyDeliveryMode).toBe("message_tool_only");
  });

  it("does not restore channel authority from a generic session route", async () => {
    const { sessionsDir, storePath } = await makeMainSessionFixture({
      channel: "discord",
      lastTo: "discord:dm:fallback",
      restartRecoveryDeliveryRunId: "recovery-main",
      restartRecoveryDeliverySourceRunId: "source-main",
      restartRecoverySourceIngress: "channel",
      restartRecoverySourceReplyDeliveryMode: "message_tool_only",
    });
    await writeTranscript(sessionsDir, "main-session", [
      { role: "user", content: "do not inherit a fallback route" },
    ]);

    await expectRecovery({ started: 0, settled: 0, failed: 0, skipped: 1 });
    expect(callGateway).not.toHaveBeenCalled();
    const events = await loadTranscriptEvents({
      agentId: "main",
      sessionId: "main-session",
      sessionKey: "agent:main:main",
      storePath,
    });
    expect(events.at(-1)).toMatchObject({
      message: {
        role: "assistant",
        content: [
          {
            type: "text",
            text: expect.stringContaining("Resume in new session"),
          },
        ],
      },
    });
    expect(loadSessionEntry({ sessionKey: "agent:main:main", storePath })).toMatchObject({
      status: "failed",
      abortedLastRun: false,
      mainRestartRecovery: { tombstone: expect.any(Object) },
    });
  });

  it("waits for an abandoned durable claim to reach execution in its owning Gateway", async () => {
    const { sessionsDir, storePath } = await makeMainSessionFixture({
      restartRecoveryDeliveryRunId: "recovery-main",
      restartRecoveryDeliverySourceRunId: "source-main",
    });
    await writeTranscript(sessionsDir, "main-session", [
      { role: "user", content: "recover without a socket" },
    ]);
    const dispatchAgent = vi.fn(
      async (
        _params: unknown,
        _timeoutMs: number | undefined,
        options: Parameters<GatewayRecoveryRuntime["dispatchAgent"]>[2],
      ) => {
        options?.onAccepted?.({ runId: "recovery-main", status: "accepted" });
        options?.onExecutionStarted?.();
        return await new Promise<never>(() => {});
      },
    );

    const result = await retryRestartAbortedMainSessionRecovery({
      cfg: {},
      expectedRecoveryRunId: "recovery-main",
      expectedRecoverySourceRunId: "source-main",
      expectedSessionId: "main-session",
      sessionKey: "agent:main:main",
      storePath,
      gatewayRuntime: {
        abortAgent: vi.fn(),
        dispatchAgent: dispatchAgent as GatewayRecoveryRuntime["dispatchAgent"],
        waitForAgent: vi.fn(),
        sendRecoveryNotice: vi.fn(),
      },
    });

    expect(result).toEqual({ started: 1, settled: 0, failed: 0, skipped: 0 });
    expect(dispatchAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKey: "recovery-main",
        sessionKey: "agent:main:main",
      }),
      undefined,
      expect.objectContaining({
        expectFinal: true,
        onAccepted: expect.any(Function),
        onExecutionStarted: expect.any(Function),
      }),
    );
    expect(callGateway).not.toHaveBeenCalled();
  });

  it("aborts an exact recovery accepted after the execution-start deadline", async () => {
    vi.useFakeTimers();
    let accept: (() => void) | undefined;
    const abortAgent = vi.fn<GatewayRecoveryRuntime["abortAgent"]>(async () => ({
      aborted: true,
    }));
    const dispatchAgent = vi.fn(
      async (
        _request: Parameters<GatewayRecoveryRuntime["dispatchAgent"]>[0],
        _timeoutMs: Parameters<GatewayRecoveryRuntime["dispatchAgent"]>[1],
        options: Parameters<GatewayRecoveryRuntime["dispatchAgent"]>[2],
      ) => {
        accept = () => options?.onAccepted?.({ runId: "recovery-main", status: "accepted" });
        return await new Promise<never>((_resolve, reject) => {
          options?.signal?.addEventListener(
            "abort",
            () => reject(new Error("execution-start wait aborted")),
            { once: true },
          );
        });
      },
    );

    try {
      const outcome = dispatchRestartRecoveryUntilStarted({
        agentId: "main",
        agentParams: {
          agentId: "main",
          idempotencyKey: "recovery-main",
          message: "resume",
          sessionKey: "agent:main:main",
        },
        gatewayRuntime: {
          abortAgent,
          dispatchAgent: dispatchAgent as GatewayRecoveryRuntime["dispatchAgent"],
          sendRecoveryNotice: vi.fn(),
          waitForAgent: vi.fn(),
        },
        recoveryRunId: "recovery-main",
        sessionKey: "agent:main:main",
      });

      await vi.advanceTimersByTimeAsync(10_000);
      await expect(outcome).resolves.toMatchObject({ kind: "failed" });
      expect(accept).toBeTypeOf("function");
      accept?.();
      await vi.waitFor(() => expect(abortAgent).toHaveBeenCalledTimes(1));
      expect(abortAgent).toHaveBeenCalledWith(
        {
          agentId: "main",
          runId: "recovery-main",
          sessionKey: "agent:main:main",
        },
        2_000,
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("restores an accepted recovery that fails before execution starts", async () => {
    const { sessionsDir, storePath } = await makeMainSessionFixture({
      restartRecoveryDeliveryRunId: "recovery-main",
      restartRecoveryDeliverySourceRunId: "source-main",
    });
    await writeTranscript(sessionsDir, "main-session", [
      { role: "user", content: "recover without losing the owner" },
    ]);
    const scheduleSpy = vi
      .spyOn(recoveryOwnerRelease, "scheduleMainSessionRecoveryPendingTarget")
      .mockImplementation(() => {});
    let acceptedObserver: ((payload: unknown) => void) | undefined;
    const dispatchAgent = vi.fn<GatewayRecoveryRuntime["dispatchAgent"]>(
      async (request, _timeoutMs, options) => {
        const runId = request.idempotencyKey!;
        await commitMainSessionRecovery({
          command: {
            kind: "admit_recovery",
            lifecycleGeneration: getAgentEventLifecycleGeneration(),
            now: Date.now(),
            runId,
            sessionId: "main-session",
          },
          requireWriteSuccess: true,
          target: { sessionKey: "agent:main:main", storePath },
        });
        acceptedObserver = options?.onAccepted;
        acceptedObserver?.({ runId, status: "accepted" });
        throw new Error("detached execution failed before provider start");
      },
    );

    try {
      const result = await retryRestartAbortedMainSessionRecovery({
        cfg: {},
        expectedRecoveryRunId: "recovery-main",
        expectedRecoverySourceRunId: "source-main",
        expectedSessionId: "main-session",
        sessionKey: "agent:main:main",
        storePath,
        gatewayRuntime: {
          abortAgent: vi.fn(),
          dispatchAgent: dispatchAgent as GatewayRecoveryRuntime["dispatchAgent"],
          waitForAgent: vi.fn(async () => ({
            runId: "recovery-main",
            status: "timeout",
            timeoutPhase: "queue",
            providerStarted: false,
          })) as GatewayRecoveryRuntime["waitForAgent"],
          sendRecoveryNotice: vi.fn(),
        },
      });

      expect(result).toEqual({ started: 0, settled: 0, failed: 1, skipped: 0 });
      expect(acceptedObserver).toBeTypeOf("function");
      expect(scheduleSpy).toHaveBeenCalledWith({
        sessionId: "main-session",
        sessionKey: "agent:main:main",
        storePath,
      });
      expect(loadSessionEntry({ sessionKey: "agent:main:main", storePath })).toMatchObject({
        status: "running",
        abortedLastRun: true,
        restartRecoveryDeliverySourceRunId: "source-main",
        mainRestartRecovery: { chargedAttempts: 1 },
      });
      expect(
        loadSessionEntry({ sessionKey: "agent:main:main", storePath })
          ?.restartRecoveryDeliveryRunId,
      ).toBeUndefined();
    } finally {
      scheduleSpy.mockRestore();
    }
  });

  it.each([
    {
      label: "restores the interrupted claim after confirmed cancellation",
      aborted: true,
      cached: false,
      expectedAbortedLastRun: true,
      expectedRunId: undefined,
      expectedScheduleCount: 1,
    },
    {
      label: "keeps the claim fenced when cancellation is not confirmed",
      aborted: false,
      cached: false,
      expectedAbortedLastRun: false,
      expectedRunId: "recovery-main",
      expectedScheduleCount: 0,
    },
    {
      label: "restores a cached in-flight claim after confirmed cancellation",
      aborted: true,
      cached: true,
      expectedAbortedLastRun: true,
      expectedRunId: undefined,
      expectedScheduleCount: 1,
    },
  ])(
    "$label when accepted recovery never starts",
    async ({ aborted, cached, expectedAbortedLastRun, expectedRunId, expectedScheduleCount }) => {
      vi.useFakeTimers();
      const { sessionsDir, storePath } = await makeMainSessionFixture({
        restartRecoveryDeliveryRunId: "recovery-main",
        restartRecoveryDeliverySourceRunId: "source-main",
      });
      await writeTranscript(sessionsDir, "main-session", [
        { role: "user", content: "recover after a stalled accepted dispatch" },
      ]);
      const scheduleSpy = vi
        .spyOn(recoveryOwnerRelease, "scheduleMainSessionRecoveryPendingTarget")
        .mockImplementation(() => {});
      const accepted = createDeferred();
      const abortAgent = vi.fn<GatewayRecoveryRuntime["abortAgent"]>(async () => ({ aborted }));
      const dispatchAgent = vi.fn(
        async (
          request: Parameters<GatewayRecoveryRuntime["dispatchAgent"]>[0],
          _timeoutMs: Parameters<GatewayRecoveryRuntime["dispatchAgent"]>[1],
          options: Parameters<GatewayRecoveryRuntime["dispatchAgent"]>[2],
        ) => {
          const runId = request.idempotencyKey!;
          await commitMainSessionRecovery({
            command: {
              kind: "admit_recovery",
              lifecycleGeneration: getAgentEventLifecycleGeneration(),
              now: Date.now(),
              runId,
              sessionId: "main-session",
            },
            requireWriteSuccess: true,
            target: { sessionKey: "agent:main:main", storePath },
          });
          if (cached) {
            accepted.resolve();
            return { runId, status: "in_flight" };
          }
          options?.onAccepted?.({ runId, status: "accepted" });
          accepted.resolve();
          return await new Promise<never>((_resolve, reject) => {
            const signal = options?.signal;
            if (!signal) {
              reject(new Error("expected execution-start abort signal"));
              return;
            }
            signal.addEventListener(
              "abort",
              () => {
                // A start callback that loses the deadline race cannot reclaim ownership.
                options?.onExecutionStarted?.();
                const abortError =
                  signal.reason instanceof Error
                    ? signal.reason
                    : new Error("execution-start wait aborted");
                void Promise.resolve(options?.onSignalAbort?.()).then(
                  () => reject(abortError),
                  () => reject(abortError),
                );
              },
              { once: true },
            );
          });
        },
      );

      try {
        const recovery = retryRestartAbortedMainSessionRecovery({
          cfg: {},
          expectedRecoveryRunId: "recovery-main",
          expectedRecoverySourceRunId: "source-main",
          expectedSessionId: "main-session",
          sessionKey: "agent:main:main",
          storePath,
          gatewayRuntime: {
            abortAgent,
            dispatchAgent: dispatchAgent as GatewayRecoveryRuntime["dispatchAgent"],
            waitForAgent: vi.fn(async () => ({
              runId: "recovery-main",
              status: "timeout",
              timeoutPhase: "queue",
              providerStarted: false,
            })) as GatewayRecoveryRuntime["waitForAgent"],
            sendRecoveryNotice: vi.fn(),
          },
        });

        await accepted.promise;
        await vi.advanceTimersByTimeAsync(10_000);
        await expect(recovery).resolves.toEqual({ started: 0, settled: 0, failed: 1, skipped: 0 });
        expect(abortAgent).toHaveBeenCalledWith(
          {
            agentId: "main",
            runId: "recovery-main",
            sessionKey: "agent:main:main",
          },
          2_000,
        );
        expect(scheduleSpy).toHaveBeenCalledTimes(expectedScheduleCount);
        expect(loadSessionEntry({ sessionKey: "agent:main:main", storePath })).toMatchObject({
          status: "running",
          abortedLastRun: expectedAbortedLastRun,
          restartRecoveryDeliverySourceRunId: "source-main",
        });
        expect(
          loadSessionEntry({ sessionKey: "agent:main:main", storePath })
            ?.restartRecoveryDeliveryRunId,
        ).toBe(expectedRunId);
      } finally {
        scheduleSpy.mockRestore();
        vi.useRealTimers();
      }
    },
  );

  it("holds lifecycle replacement behind the targeted recovery dispatch", async () => {
    const sessionsDir = await makeSessionsDir();
    const storePath = path.join(sessionsDir, "sessions.json");
    const sessionKey = "agent:main:main";
    const sessionId = "main-session";
    await writeStore(sessionsDir, {
      [sessionKey]: {
        sessionId,
        updatedAt: Date.now() - 10_000,
        status: "running",
        abortedLastRun: true,
        restartRecoveryDeliveryRunId: "recovery-main",
        restartRecoveryDeliverySourceRunId: "source-main",
      },
    });
    await writeTranscript(sessionsDir, sessionId, [{ role: "user", content: "recover me" }]);
    const dispatchEntered = createDeferred();
    const releaseDispatch = createDeferred();
    let adoptedAdmission: ReturnType<typeof consumeSessionWorkAdmissionHandoff>;
    vi.mocked(callGateway).mockImplementationOnce(async ({ params }) => {
      const handoffId = (params as { internalRuntimeHandoffId?: string }).internalRuntimeHandoffId;
      adoptedAdmission = consumeSessionWorkAdmissionHandoff({
        handoffId: handoffId ?? "",
        scope: storePath,
        identities: [sessionKey, sessionId],
      });
      dispatchEntered.resolve();
      await releaseDispatch.promise;
      return { runId: "recovery-main" };
    });

    const recovery = retryRestartAbortedMainSessionRecovery({
      cfg: {},
      expectedRecoveryRunId: "recovery-main",
      expectedRecoverySourceRunId: "source-main",
      expectedSessionId: sessionId,
      sessionKey,
      storePath,
    });
    let mutationRan = false;
    let mutation: Promise<void> | undefined;
    try {
      await dispatchEntered.promise;
      expect(isSessionWorkAdmissionActive(storePath, [sessionKey, sessionId])).toBe(true);
      const recoveryAdmissionRelease = getSessionWorkAdmissionOwnerRelease({
        scope: storePath,
        identities: [sessionKey, sessionId],
        owner: MAIN_SESSION_RECOVERY_WORK_ADMISSION_OWNER,
      });
      expect(recoveryAdmissionRelease).toBeInstanceOf(Promise);
      mutation = runExclusiveSessionLifecycleMutation({
        scope: storePath,
        identities: [sessionKey, sessionId],
        prepare: async () => {
          expect(
            await interruptSessionWorkAdmissions({
              scope: storePath,
              identities: [sessionKey, sessionId],
              timeoutMs: 1_000,
            }),
          ).toBe(true);
        },
        run: async () => {
          mutationRan = true;
        },
      });
      await waitForFast(() =>
        expect(isSessionLifecycleMutationActive(storePath, [sessionKey, sessionId])).toBe(true),
      );
      expect(mutationRan).toBe(false);

      releaseDispatch.resolve();
      await expect(recovery).resolves.toEqual({ started: 1, settled: 0, failed: 0, skipped: 0 });
      expect(mutationRan).toBe(false);
      adoptedAdmission?.release();
      await recoveryAdmissionRelease;
      await mutation;
      expect(mutationRan).toBe(true);
      expect(
        getSessionWorkAdmissionOwnerRelease({
          scope: storePath,
          identities: [sessionKey, sessionId],
          owner: MAIN_SESSION_RECOVERY_WORK_ADMISSION_OWNER,
        }),
      ).toBeUndefined();
    } finally {
      releaseDispatch.resolve();
      await Promise.allSettled([recovery, ...(mutation ? [mutation] : [])]);
    }
  });

  it("does not retry a replacement durable claim", async () => {
    const sessionsDir = await makeSessionsDir();
    const storePath = path.join(sessionsDir, "sessions.json");
    await writeStore(sessionsDir, {
      "agent:main:main": {
        ...runningSessionEntry("replacement-session"),
        abortedLastRun: true,
        restartRecoveryDeliveryRunId: "replacement-recovery",
        restartRecoveryDeliverySourceRunId: "replacement-source",
      },
    });
    await writeTranscript(sessionsDir, "replacement-session", [
      { role: "user", content: "replacement turn" },
    ]);

    const result = await retryRestartAbortedMainSessionRecovery({
      expectedRecoveryRunId: "stale-recovery",
      expectedRecoverySourceRunId: "stale-source",
      expectedSessionId: "stale-session",
      sessionKey: "agent:main:main",
      storePath,
    });

    expect(result).toEqual({ started: 0, settled: 0, failed: 0, skipped: 0 });
    expect(callGateway).not.toHaveBeenCalled();
    expect(loadSessionEntry({ sessionKey: "agent:main:main", storePath })).toMatchObject({
      abortedLastRun: true,
      restartRecoveryDeliveryRunId: "replacement-recovery",
      restartRecoveryDeliverySourceRunId: "replacement-source",
      sessionId: "replacement-session",
    });
  });

  it("does not dispatch an archived durable recovery claim", async () => {
    const sessionsDir = await makeSessionsDir();
    await writeStore(sessionsDir, {
      "agent:main:main": {
        sessionId: "archived-session",
        updatedAt: Date.now() - 10_000,
        archivedAt: Date.now() - 5_000,
        status: "running",
        abortedLastRun: true,
        restartRecoveryDeliveryRunId: "archived-recovery",
        restartRecoveryDeliverySourceRunId: "archived-source",
      },
    });
    await writeTranscript(sessionsDir, "archived-session", [
      { role: "user", content: "do not recover while archived" },
    ]);

    await expectRecovery({ started: 0, settled: 0, failed: 0, skipped: 1 });
    expect(callGateway).not.toHaveBeenCalled();
  });

  it("resumes marked sessions without a meaningful transcript tail", async () => {
    const sessionsDir = await writeMainSessionTranscript([
      { role: "system", content: "session metadata only" },
    ]);

    await expectRecovery({ started: 1, settled: 0, failed: 0, skipped: 0 });
    expect(callGateway).toHaveBeenCalledOnce();
    const store = readStore(path.join(sessionsDir, "sessions.json"));
    expect(store["agent:main:main"]?.status).toBe("running");
    expect(store["agent:main:main"]?.abortedLastRun).toBe(false);
  });

  it("completes an interrupted turn whose exact terminal source reply was delivered", async () => {
    const sessionsDir = await makeSessionsDir();
    const storePath = path.join(sessionsDir, "sessions.json");
    const sessionKey = "agent:main:discord:direct:123";
    await writeStore(sessionsDir, {
      [sessionKey]: {
        sessionId: "main-session",
        updatedAt: Date.now() - 10_000,
        startedAt: Date.now() - 20_000,
        status: "running",
        abortedLastRun: true,
        restartRecoveryBeforeAgentReplyState: "pending",
        restartRecoveryDeliveryRunId: "recovery-1",
        restartRecoveryDeliverySourceRunId: "discord-message-1",
        restartRecoveryDeliveryContext: discordDeliveryContext,
      },
    });
    await writeTranscript(sessionsDir, "main-session", [
      { role: "user", content: "do the thing", idempotencyKey: "discord-message-1" },
      makeMessageToolCall(),
      {
        role: "assistant",
        content: [{ type: "text", text: "delivered answer" }],
        stopReason: "stop",
        openclawDeliveryMirror: {
          kind: "message-tool-source-reply",
          final: true,
          sourceTurnId: "discord-message-1",
          toolCallId: "message-call-1",
        },
      },
      {
        role: "toolResult",
        toolCallId: "message-call-1",
        toolName: "message",
        content: [{ type: "text", text: "sent" }],
      },
    ]);

    await expectRecovery({ started: 0, settled: 1, failed: 0, skipped: 0 });

    expect(callGateway).not.toHaveBeenCalled();
    expect(loadSessionEntry({ sessionKey, storePath })).toMatchObject({
      status: "done",
      abortedLastRun: false,
      restartRecoveryTerminalRunIds: ["discord-message-1"],
    });
    const completed = loadSessionEntry({ sessionKey, storePath });
    expect(completed?.lastRunId).toBeUndefined();
    expect(completed?.restartRecoveryDeliveryRunId).toBeUndefined();
    expect(completed?.restartRecoveryDeliverySourceRunId).toBeUndefined();
    expect(completed?.restartRecoveryDeliveryContext).toBeUndefined();
    expect(completed?.restartRecoveryBeforeAgentReplyState).toBeUndefined();
    expect(completed?.pendingFinalDelivery).toBeUndefined();
  });

  it("resumes a Control UI turn while a global before_agent_reply hook is active", async () => {
    const registry = createEmptyPluginRegistry();
    addTestHook({
      registry,
      pluginId: "restart-recovery-hook",
      hookName: "before_agent_reply",
      handler: vi.fn(),
    });
    initializeGlobalHookRunner(registry);
    const { sessionsDir, sessionKey } = await makeControlUiRecoveryFixture();
    await writeTranscript(sessionsDir, "main-session", [
      makeUserMessage("do the thing", { idempotencyKey: "control-ui-run:user" }),
    ]);

    try {
      await expectRecovery({ started: 1, settled: 0, failed: 0, skipped: 0 }, {});
    } finally {
      resetGlobalHookRunner();
    }

    expect(vi.mocked(callGateway).mock.calls[0]?.[0]).toMatchObject({ method: "agent" });
    expect(gatewayParams()).toMatchObject({ deliver: false, sessionKey });
  });

  it("resumes with restart-safe tools while a terminal provider outcome remains unknown", async () => {
    const { sessionsDir, storePath, sessionKey } = await makeMainSessionFixture({
      sessionKey: "agent:main:discord:direct:123",
      restartRecoveryDeliveryReceiptState: "terminal-pending",
      restartRecoveryDeliveryToolCallId: "message-call-1",
      restartRecoveryDeliveryRunId: "recovery-1",
      restartRecoveryDeliverySourceRunId: "discord-message-1",
      restartRecoveryDeliveryContext: discordDeliveryContext,
    });
    await writeTranscript(sessionsDir, "main-session", [
      { role: "user", content: "do the thing", idempotencyKey: "discord-message-1" },
    ]);

    await expectRecovery({ started: 1, settled: 0, failed: 0, skipped: 0 });

    expect(callGateway).toHaveBeenCalledOnce();
    expect(gatewayParams()).toMatchObject({ forceRestartSafeTools: true });
    expect(sendRecoveryNotice).not.toHaveBeenCalled();
    expect(loadSessionEntry({ sessionKey, storePath })?.status).toBe("running");
  });

  it("completes from a durable terminal provider receipt without replaying", async () => {
    const { sessionsDir, storePath, sessionKey } = await makeDeliveredReceiptFixture();
    await writeTranscript(sessionsDir, "main-session", makeMessageDeliveryTranscript());

    await expectRecovery({ started: 0, settled: 1, failed: 0, skipped: 0 });

    expect(callGateway).not.toHaveBeenCalled();
    expect(loadSessionEntry({ sessionKey, storePath })).toMatchObject({
      status: "done",
      abortedLastRun: false,
      restartRecoveryTerminalRunIds: ["discord-message-1"],
    });
    const transcript = await loadTestTranscript(sessionKey, storePath);
    expect(transcript.map((event) => event.message).filter(Boolean)).toContainEqual(
      expect.objectContaining({
        role: "toolResult",
        toolCallId: "message-call-1",
        toolName: "message",
        isError: false,
      }),
    );
    expect(
      loadSessionEntry({ sessionKey, storePath })?.restartRecoveryDeliveryToolCallId,
    ).toBeUndefined();
  });

  it("reconciles a receipt delivered during a restart-recovery continuation", async () => {
    const { sessionsDir, storePath, sessionKey } =
      await makeDeliveredReceiptFixture("message-call-recovered");
    await writeTranscript(
      sessionsDir,
      "main-session",
      makeMessageDeliveryTranscript({
        toolCallId: "message-call-recovered",
        beforeCall: [
          makeAssistantTextMessage("starting"),
          makeUserMessage("[System] continue after restart", {
            idempotencyKey: "recovery-1:user",
          }),
        ],
      }),
    );

    await expectRecovery({ started: 0, settled: 1, failed: 0, skipped: 0 });

    expect(callGateway).not.toHaveBeenCalled();
    expect(loadSessionEntry({ sessionKey, storePath })).toMatchObject({
      status: "done",
      abortedLastRun: false,
      restartRecoveryTerminalRunIds: ["discord-message-1"],
    });
    const transcript = await loadTestTranscript(sessionKey, storePath);
    expect(
      transcript
        .map((event) => event.message)
        .some(
          (message) =>
            message?.idempotencyKey ===
            "restart-recovery:message-tool-result:discord-message-1:message-call-recovered",
        ),
    ).toBe(true);
  });

  it.each([
    {
      label: "missing message tool call",
      sourceTurnId: "discord-message-1",
      messages: [makeUserMessage("do the thing", { idempotencyKey: "discord-message-1" })],
    },
    {
      label: "missing durable source turn",
      sourceTurnId: "discord-message-missing",
      messages: [makeMessageToolCall()],
    },
    {
      label: "checkpoint from an earlier turn",
      sourceTurnId: "discord-message-current",
      messages: [
        makeUserMessage("current turn", { idempotencyKey: "discord-message-current" }),
        makeMessageToolCall("message-call-1", "current answer"),
        makeUserMessage("later turn", { idempotencyKey: "discord-message-later" }),
      ],
    },
    {
      label: "unfinished sibling tool work",
      sourceTurnId: "discord-message-1",
      messages: [
        makeUserMessage("do the thing", { idempotencyKey: "discord-message-1" }),
        createAssistantToolCallMessage([
          {
            type: "toolCall",
            id: "message-call-1",
            name: "message",
            arguments: { action: "send", message: "current answer" },
          },
          { type: "toolCall", id: "pending-write", name: "write", arguments: {} },
        ]),
        makeMessageToolResult("message-call-1"),
      ],
    },
    {
      label: "non-successful existing tool result",
      sourceTurnId: "discord-message-1",
      messages: [
        ...makeMessageDeliveryTranscript(),
        {
          role: "toolResult",
          toolCallId: "message-call-1",
          toolName: "message",
          isError: true,
          content: [{ type: "text", text: "transport reported failure" }],
        },
      ],
    },
  ])(
    "resumes safely when terminal completion cannot reconcile $label",
    async ({ sourceTurnId, messages }) => {
      const { sessionsDir, storePath, sessionKey } = await makeDeliveredReceiptFixture(
        "message-call-1",
        sourceTurnId,
      );
      await writeTranscript(sessionsDir, "main-session", messages);

      await expectRecovery({ started: 1, settled: 0, failed: 0, skipped: 0 });

      expect(callGateway).toHaveBeenCalledOnce();
      expect(gatewayParams()).toMatchObject({ forceRestartSafeTools: true });
      expect(sendRecoveryNotice).not.toHaveBeenCalled();
      expect(loadSessionEntry({ sessionKey, storePath })).toMatchObject({
        status: "running",
        abortedLastRun: false,
      });
    },
  );

  it("completes a checkpointed silent before_agent_reply result without dispatch", async () => {
    const { sessionsDir, storePath, sessionKey } = await makeMainSessionFixture({
      sessionKey: "agent:main:discord:direct:123",
      restartRecoveryBeforeAgentReplyState: "handled-silent",
      restartRecoveryDeliveryRunId: "recovery-1",
      restartRecoveryDeliverySourceRunId: "discord-message-1",
      restartRecoveryDeliveryContext: discordDeliveryContext,
    });
    await writeTranscript(sessionsDir, "main-session", [
      { role: "user", content: "do the thing", idempotencyKey: "discord-message-1" },
    ]);

    await expectRecovery({ started: 0, settled: 1, failed: 0, skipped: 0 });

    expect(callGateway).not.toHaveBeenCalled();
    expect(loadSessionEntry({ sessionKey, storePath })).toMatchObject({
      status: "done",
      abortedLastRun: false,
      restartRecoveryTerminalRunIds: ["discord-message-1"],
    });
  });

  it("matches a checkpointed Control UI hook to its run-keyed user turn", async () => {
    const { sessionsDir, storePath, sessionKey } = await makeControlUiRecoveryFixture({
      restartRecoveryBeforeAgentReplyState: "handled-silent",
    });
    await writeTranscript(sessionsDir, "main-session", [
      { role: "user", content: "quiet", idempotencyKey: "control-ui-run:user" },
    ]);

    await expectRecovery({ started: 0, settled: 1, failed: 0, skipped: 0 });

    expect(callGateway).not.toHaveBeenCalled();
    expect(loadSessionEntry({ sessionKey, storePath })).toMatchObject({
      status: "done",
      abortedLastRun: false,
      lastRunId: "control-ui-run",
      restartRecoveryTerminalRunIds: ["control-ui-run"],
    });
  });

  it("resumes safely when a silent checkpoint belongs to an earlier turn", async () => {
    const { sessionsDir, storePath, sessionKey } = await makeMainSessionFixture({
      sessionKey: "agent:main:discord:direct:123",
      restartRecoveryBeforeAgentReplyState: "handled-silent",
      restartRecoveryDeliveryRunId: "recovery-1",
      restartRecoveryDeliverySourceRunId: "discord-message-1",
      restartRecoveryDeliveryContext: discordDeliveryContext,
    });
    await writeTranscript(sessionsDir, "main-session", [
      { role: "user", content: "current turn", idempotencyKey: "discord-message-1" },
      { role: "user", content: "later turn", idempotencyKey: "discord-message-2" },
    ]);

    await expectRecovery({ started: 1, settled: 0, failed: 0, skipped: 0 });

    expect(gatewayParams()).toMatchObject({ forceRestartSafeTools: true });
    expect(sendRecoveryNotice).not.toHaveBeenCalled();
    expect(loadSessionEntry({ sessionKey, storePath })?.status).toBe("running");
  });

  it("resumes safely for a source-less silent before_agent_reply checkpoint", async () => {
    const { sessionsDir, storePath, sessionKey } = await makeMainSessionFixture({
      sessionKey: "agent:main:custom:direct:123",
      restartRecoveryBeforeAgentReplyState: "handled-silent",
      restartRecoveryDeliveryRunId: "recovery-1",
      restartRecoveryDeliveryContext: discordDeliveryContext,
    });
    await writeTranscript(sessionsDir, "main-session", [{ role: "user", content: "quiet" }]);

    await expectRecovery({ started: 1, settled: 0, failed: 0, skipped: 0 });

    expect(gatewayParams()).toMatchObject({ forceRestartSafeTools: true });
    expect(sendRecoveryNotice).not.toHaveBeenCalled();
    expect(loadSessionEntry({ sessionKey, storePath })).toMatchObject({
      status: "running",
      abortedLastRun: false,
    });
  });

  it.each(["pending", "handled-reply", "handled-unrecoverable"] as const)(
    "resumes safely for a %s before_agent_reply checkpoint without a recoverable result",
    async (restartRecoveryBeforeAgentReplyState) => {
      const { sessionsDir, storePath, sessionKey } = await makeMainSessionFixture({
        sessionKey: "agent:main:discord:direct:123",
        restartRecoveryBeforeAgentReplyState,
        restartRecoveryDeliveryRunId: "recovery-1",
        restartRecoveryDeliverySourceRunId: "discord-message-1",
        restartRecoveryDeliveryContext: discordDeliveryContext,
      });
      await writeTranscript(sessionsDir, "main-session", [
        { role: "user", content: "do the thing", idempotencyKey: "discord-message-1" },
      ]);

      await expectRecovery({ started: 1, settled: 0, failed: 0, skipped: 0 });

      expect(gatewayParams()).toMatchObject({ forceRestartSafeTools: true });
      expect(sendRecoveryNotice).not.toHaveBeenCalled();
      expect(loadSessionEntry({ sessionKey, storePath })?.status).toBe("running");
    },
  );

  it.each([
    ["progress delivery", false, "discord-message-1"],
    ["an older turn's terminal delivery", true, "discord-message-0"],
  ])("does not complete from %s", async (_label, final, sourceTurnId) => {
    const sessionsDir = await makeSessionsDir();
    const sessionKey = "agent:main:discord:direct:123";
    await writeMainSession({
      sessionsDir,
      sessionKey,
      restartRecoveryDeliveryRunId: "recovery-1",
      restartRecoveryDeliverySourceRunId: "discord-message-1",
      restartRecoveryDeliveryContext: discordDeliveryContext,
    });
    await writeTranscript(sessionsDir, "main-session", [
      { role: "user", content: "do the thing" },
      {
        role: "assistant",
        content: [{ type: "text", text: "not this turn's terminal answer" }],
        stopReason: "stop",
        openclawDeliveryMirror: {
          kind: "message-tool-source-reply",
          final,
          sourceTurnId,
          toolCallId: "message-call-1",
        },
      },
    ]);

    await expectRecovery({ started: 1, settled: 0, failed: 0, skipped: 0 });
    expect(callGateway).toHaveBeenCalledOnce();
    expect(sendRecoveryNotice).not.toHaveBeenCalled();
  });

  it.each([
    [
      "completed assistant output",
      makeAssistantTextMessage("finished answer", { stopReason: "stop" }),
    ],
    [
      "errored assistant output",
      makeAssistantTextMessage("provider failed", { stopReason: "error" }),
    ],
    [
      "an errored tail carrying a non-restart abort code",
      {
        role: "assistant",
        content: [{ type: "text", text: "" }],
        stopReason: "error",
        errorMessage: "This operation was aborted",
        errorCode: "OPENCLAW_FIRST_EVENT_TIMEOUT",
      },
    ],
  ])(
    "resumes %s at the transcript tail for model reconciliation",
    async (_label, assistantMessage) => {
      await writeMainSessionTranscript([
        { role: "user", content: "do the thing" },
        assistantMessage,
      ]);

      await expectRecovery({ started: 1, settled: 0, failed: 0, skipped: 0 });
      expect(callGateway).toHaveBeenCalledOnce();
      expect(gatewayParams()).not.toHaveProperty("forceRestartSafeTools");
    },
  );

  it.each([
    ["Request was aborted"],
    ["This operation was aborted"],
    ["agent run aborted for restart"],
  ])(
    "resumes a pre-upgrade errored tail persisted as %s without an abort code",
    async (errorMessage) => {
      // The process that wrote this tail predates errorCode propagation, and it
      // can be the very process replaced by the upgrade running recovery now.
      await writeMainSessionTranscript([
        { role: "user", content: "do the thing" },
        { role: "assistant", content: [], stopReason: "error", errorMessage },
      ]);

      await expectRecovery({ started: 1, settled: 0, failed: 0, skipped: 0 });
      expect(callGateway).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    [
      "no abort string",
      makeAssistantTextMessage("partial answer", { stopReason: "aborted" }),
      false,
    ],
    [
      "a worker abort string",
      makeAssistantTextMessage("", {
        stopReason: "aborted",
        errorMessage: "Worker inference aborted.",
      }),
      false,
    ],
    [
      "a dangling side-effecting call",
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "call-1", name: "write", arguments: {} }],
        stopReason: "aborted",
        errorMessage: "Worker inference aborted.",
      },
      true,
    ],
  ])(
    "resumes an aborted tail persisted with %s",
    async (_label, assistantMessage, forceRestartSafeTools) => {
      await writeMainSessionTranscript([
        { role: "user", content: "do the thing" },
        assistantMessage,
      ]);

      await expectRecovery({ started: 1, settled: 0, failed: 0, skipped: 0 });
      expect(callGateway).toHaveBeenCalledTimes(1);
      if (forceRestartSafeTools) {
        expect(gatewayParams()).toMatchObject({ forceRestartSafeTools: true });
      } else {
        expect(gatewayParams()).not.toMatchObject({ forceRestartSafeTools: true });
      }
    },
  );

  it("resumes a restart interrupted at the Code Mode wait control", async () => {
    const sessionsDir = await makeSessionsDir();
    await writeStore(sessionsDir, {
      "agent:main:demo-channel:room-1": {
        ...runningSessionEntry("main-session"),
        abortedLastRun: true,
        restartRecoveryDeliveryContext: {
          channel: "discord",
          to: "discord:channel:room-1",
          accountId: "default",
          threadId: "thread-1",
        },
      },
    });
    await writeTranscript(sessionsDir, "main-session", [
      { role: "user", content: "do the thing" },
      {
        role: "toolResult",
        toolName: "exec",
        content: [
          {
            type: "text",
            text: JSON.stringify({
              status: "waiting",
              runId: "cm_interrupted",
              reason: "yield",
              replaySafe: true,
            }),
          },
        ],
      },
      createAssistantToolCallMessage([
        { type: "thinking", thinking: "The read-only work is still pending." },
        { type: "text", text: "" },
        {
          type: "toolCall",
          id: "call-wait-1",
          name: "wait",
          arguments: { runId: "cm_interrupted" },
        },
      ]),
    ]);

    await expectRecovery({ started: 1, settled: 0, failed: 0, skipped: 0 });
    expect(callGateway).toHaveBeenCalledOnce();
    const gatewayCall = vi.mocked(callGateway).mock.calls[0]?.[0] as
      | {
          method?: string;
          params?: Record<string, unknown>;
        }
      | undefined;
    expect(gatewayCall?.method).toBe("agent");
    expect(gatewayCall?.params).toMatchObject({
      message: expect.stringContaining("Continue from the existing transcript"),
      deliver: true,
      channel: "discord",
      accountId: "default",
      sessionKey: "agent:main:demo-channel:room-1",
      to: "discord:channel:room-1",
      threadId: "thread-1",
      bestEffortDeliver: true,
      forceRestartSafeTools: true,
    });

    const store = readStore(path.join(sessionsDir, "sessions.json"));
    expect(store["agent:main:demo-channel:room-1"]?.status).toBe("running");
    expect(store["agent:main:demo-channel:room-1"]?.abortedLastRun).toBe(false);
    expect(store["agent:main:demo-channel:room-1"]?.restartRecoveryForceSafeTools).toBe(true);
  });

  it("reads a provider-native Code Mode wait input", async () => {
    await writeMainSessionTranscript([
      { role: "user", content: "do the thing" },
      codeModeCheckpointMessage("exec"),
      createAssistantToolCallMessage([
        {
          type: "tool_use",
          id: "call-wait-1",
          name: "wait",
          input: { runId: "cm_interrupted" },
        },
      ]),
    ]);

    await expectRecovery({ started: 1, settled: 0, failed: 0, skipped: 0 });
    expect(gatewayParams()).toMatchObject({
      forceRestartSafeTools: true,
      forceCodeModeTools: true,
    });
  });

  it.each([
    {
      replaySafe: true,
      expected: { started: 1, settled: 0, failed: 0, skipped: 0 },
      gatewayCalls: 1,
    },
    {
      replaySafe: false,
      expected: { started: 1, settled: 0, failed: 0, skipped: 0 },
      gatewayCalls: 1,
    },
  ])(
    "classifies a direct waiting checkpoint with replaySafe=$replaySafe",
    async ({ replaySafe, expected, gatewayCalls }) => {
      await writeMainSessionTranscript([
        { role: "user", content: "do the thing" },
        {
          role: "toolResult",
          toolName: "exec",
          content: [
            {
              type: "text",
              text: JSON.stringify({
                status: "waiting",
                runId: "cm_interrupted",
                replaySafe,
              }),
            },
          ],
        },
      ]);

      await expectRecovery(expected);
      expect(callGateway).toHaveBeenCalledTimes(gatewayCalls);
      expect(gatewayParams()).toMatchObject({ forceRestartSafeTools: true });
      if (!replaySafe) {
        expect(gatewayParams()).not.toHaveProperty("forceCodeModeTools");
      }
    },
  );

  it.each(["completed", "failed"] as const)(
    "keeps restart safety after a terminal Code Mode %s result",
    async (status) => {
      await writeMainSessionTranscript([
        { role: "user", content: "do the thing" },
        {
          role: "toolResult",
          toolName: "wait",
          content: [
            {
              type: "text",
              text: JSON.stringify({
                status,
                replaySafe: true,
                ...(status === "completed" ? { value: "done" } : { error: "safe failure" }),
              }),
            },
          ],
        },
      ]);

      await expectRecovery({ started: 1, settled: 0, failed: 0, skipped: 0 });
      expect(gatewayParams()).toMatchObject({ forceRestartSafeTools: true });
    },
  );

  it.each([
    {
      label: "a replay-safe checkpoint earlier in the interrupted turn",
      messages: [
        { role: "user", content: "do the thing" },
        codeModeCheckpointMessage("exec"),
        createAssistantToolCallMessage([
          {
            type: "toolCall",
            id: "call-read-current",
            name: "read",
            arguments: { path: "README.md" },
          },
        ]),
        {
          role: "toolResult",
          toolName: "read",
          toolCallId: "call-read-current",
          content: [{ type: "text", text: "current read result" }],
        },
      ],
      forceRestartSafeTools: true,
    },
    {
      label: "a replay-safe checkpoint from an earlier user turn",
      messages: [
        { role: "user", content: "finish the earlier turn" },
        codeModeCheckpointMessage("exec"),
        { role: "user", content: "start the current turn" },
        createAssistantToolCallMessage([
          {
            type: "toolCall",
            id: "call-read-current",
            name: "read",
            arguments: { path: "README.md" },
          },
        ]),
        {
          role: "toolResult",
          toolName: "read",
          toolCallId: "call-read-current",
          content: [{ type: "text", text: "current read result" }],
        },
      ],
      forceRestartSafeTools: false,
    },
  ])(
    "preserves the restart-safe boundary after an ordinary tool result with $label",
    async ({ messages, forceRestartSafeTools }) => {
      await writeMainSessionTranscript(messages);

      await expectRecovery({ started: 1, settled: 0, failed: 0, skipped: 0 });
      if (forceRestartSafeTools) {
        expect(gatewayParams()).toMatchObject({ forceRestartSafeTools: true });
      } else {
        expect(gatewayParams()).not.toMatchObject({ forceRestartSafeTools: true });
      }
    },
  );

  it("keeps restart safety across a second restart of the recovery turn", async () => {
    await writeMainSessionTranscript(
      [
        { role: "user", content: "do the thing" },
        {
          role: "user",
          content:
            "[System] Your previous turn was interrupted by a gateway restart while OpenClaw was waiting on tool/model work. Continue from the existing transcript and finish the interrupted response.",
        },
        createAssistantToolCallMessage([
          {
            type: "toolCall",
            id: "call-read-1",
            name: "read",
            arguments: { path: "README.md" },
          },
        ]),
        {
          role: "toolResult",
          toolName: "read",
          content: [{ type: "text", text: "read result" }],
        },
      ],
      { restartRecoveryForceSafeTools: true },
    );

    await expectRecovery({ started: 1, settled: 0, failed: 0, skipped: 0 });
    expect(gatewayParams()).toMatchObject({ forceRestartSafeTools: true });
  });

  it("keeps restart safety after the recovery prompt leaves the recent transcript window", async () => {
    await writeMainSessionTranscript(
      [
        { role: "user", content: "do the thing" },
        ...Array.from({ length: 24 }, (_, index) => ({
          role: "toolResult",
          toolName: "read",
          content: [{ type: "text", text: `read result ${index}` }],
        })),
      ],
      { restartRecoveryForceSafeTools: true },
    );

    await expectRecovery({ started: 1, settled: 0, failed: 0, skipped: 0 });
    expect(gatewayParams()).toMatchObject({ forceRestartSafeTools: true });
  });

  it("resumes an in-flight safe tool call across a repeated restart", async () => {
    await writeMainSessionTranscript(
      [
        { role: "user", content: "do the thing" },
        createAssistantToolCallMessage([
          { type: "thinking", thinking: "I need one more read." },
          { type: "toolCall", id: "call-read-2", name: "read", arguments: { path: "README.md" } },
        ]),
      ],
      { restartRecoveryForceSafeTools: true },
    );

    await expectRecovery({ started: 1, settled: 0, failed: 0, skipped: 0 });
    expect(gatewayParams()).toMatchObject({ forceRestartSafeTools: true });
  });

  it("resumes completed assistant output under the retained restart-safe guard", async () => {
    await writeMainSessionTranscript(
      [
        { role: "user", content: "do the thing" },
        { role: "assistant", content: [{ type: "text", text: "Done already." }] },
      ],
      { restartRecoveryForceSafeTools: true },
    );

    await expectRecovery({ started: 1, settled: 0, failed: 0, skipped: 0 });
    expect(callGateway).toHaveBeenCalledOnce();
    expect(gatewayParams()).toMatchObject({ forceRestartSafeTools: true });
  });

  it("resumes after a completed historical recovery prompt", async () => {
    await writeMainSessionTranscript([
      {
        role: "user",
        content:
          "[System] Your previous turn was interrupted by a gateway restart while OpenClaw was waiting on tool/model work. Continue from the existing transcript and finish the interrupted response.",
      },
      { role: "assistant", content: [{ type: "text", text: "Finished that recovery." }] },
      { role: "user", content: "a later request" },
      { role: "assistant", content: [{ type: "text", text: "Finished the later request." }] },
    ]);

    await expectRecovery({ started: 1, settled: 0, failed: 0, skipped: 0 });
    expect(callGateway).toHaveBeenCalledOnce();
    expect(gatewayParams()).not.toHaveProperty("forceRestartSafeTools");
  });

  it("resumes safely without replaying visible assistant text beside a Code Mode wait", async () => {
    await writeMainSessionTranscript([
      { role: "user", content: "do the thing" },
      codeModeCheckpointMessage("exec"),
      createAssistantToolCallMessage([
        { type: "text", text: "I already sent this part." },
        {
          type: "toolCall",
          id: "call-wait-1",
          name: "wait",
          arguments: { runId: "cm_interrupted" },
        },
      ]),
    ]);

    await expectRecovery({ started: 1, settled: 0, failed: 0, skipped: 0 });
    expect(callGateway).toHaveBeenCalledOnce();
    expect(gatewayParams()).toMatchObject({ forceRestartSafeTools: true });
    expect(gatewayParams()).not.toHaveProperty("forceCodeModeTools");
  });

  it.each([
    {
      label: "empty provider abort artifact",
      content: [],
      expected: { started: 1, settled: 0, failed: 0, skipped: 0 },
      gatewayCalls: 1,
    },
    {
      label: "provider abort artifact with partial output",
      content: [{ type: "text", text: "partial answer" }],
      expected: { started: 1, settled: 0, failed: 0, skipped: 0 },
      gatewayCalls: 1,
    },
  ])(
    "handles $label without discarding assistant output",
    async ({ content, expected, gatewayCalls }) => {
      await writeMainSessionTranscript([
        { role: "user", content: "do the thing" },
        codeModeCheckpointMessage("exec"),
        codeModeWaitCallMessage(),
        {
          role: "assistant",
          content,
          stopReason: "error",
          errorMessage: "Request was aborted",
          errorCode: AGENT_RUN_RESTART_ABORT_ERROR_CODE,
        },
      ]);

      await expectRecovery(expected);
      expect(callGateway).toHaveBeenCalledTimes(gatewayCalls);
      expect(gatewayParams()).toMatchObject({ forceRestartSafeTools: true });
    },
  );

  it("resumes a partial streamed answer interrupted by a restart", async () => {
    await writeMainSessionTranscript([
      { role: "user", content: "do the thing" },
      makeAssistantTextMessage("Here is the first half of the answer", {
        stopReason: "aborted",
        errorMessage: "This operation was aborted",
      }),
    ]);

    await expectRecovery({ started: 1, settled: 0, failed: 0, skipped: 0 });
    expect(callGateway).toHaveBeenCalledTimes(1);
    expect(gatewayParams()).not.toMatchObject({ forceRestartSafeTools: true });
  });

  it("resumes an abort artifact persisted with the gateway restart reason", async () => {
    await writeMainSessionTranscript([
      { role: "user", content: "do the thing" },
      {
        role: "assistant",
        content: [],
        stopReason: "aborted",
        errorMessage: "agent run aborted for restart",
      },
    ]);

    await expectRecovery({ started: 1, settled: 0, failed: 0, skipped: 0 });
    expect(callGateway).toHaveBeenCalledTimes(1);
  });

  it("resumes a side-effecting tool call restricted to restart-safe tools", async () => {
    await writeMainSessionTranscript([
      { role: "user", content: "do the thing" },
      createAssistantToolCallMessage([
        { type: "text", text: "Running the check now." },
        { type: "toolCall", id: "call-bash-1", name: "bash", arguments: { command: "true" } },
      ]),
    ]);

    await expectRecovery({ started: 1, settled: 0, failed: 0, skipped: 0 });
    expect(callGateway).toHaveBeenCalledTimes(1);
    expect(gatewayParams()).toMatchObject({ forceRestartSafeTools: true });
  });

  it("reports an interrupted native tool outcome as unknown", async () => {
    await writeMainSessionTranscript([
      { role: "user", content: "run the command" },
      createAssistantToolCallMessage([
        { type: "toolCall", id: "call-bash-1", name: "bash", arguments: { command: "true" } },
      ]),
      {
        role: "toolResult",
        toolName: "bash",
        toolCallId: "call-bash-1",
        content: "native tool call had no matching result",
        details: { reason: "missing_tool_result" },
        isError: true,
      },
    ]);

    await expectRecovery({ started: 1, settled: 0, failed: 0, skipped: 0 });
    expect(gatewayParams().message).toContain("unknown outcome");
    expect(gatewayParams().message).toContain("never claim completion or success");
    expect(gatewayParams()).toMatchObject({ forceRestartSafeTools: true });
  });

  it("keeps a confirmed native tool failure distinct from an unknown outcome", async () => {
    await writeMainSessionTranscript([
      { role: "user", content: "run the command" },
      createAssistantToolCallMessage([
        { type: "toolCall", id: "call-bash-1", name: "bash", arguments: { command: "false" } },
      ]),
      {
        role: "toolResult",
        toolName: "bash",
        toolCallId: "call-bash-1",
        content: "command failed with exit code 1",
        details: { reason: "nonzero_exit" },
        isError: true,
      },
    ]);

    await expectRecovery({ started: 1, settled: 0, failed: 0, skipped: 0 });
    expect(gatewayParams()).not.toHaveProperty("forceRestartSafeTools");
  });

  it("keeps a dangling side-effecting call in an aborted tail restricted", async () => {
    await writeMainSessionTranscript([
      { role: "user", content: "do the thing" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Kicking that off." },
          { type: "toolCall", id: "call-bash-1", name: "bash", arguments: { command: "true" } },
        ],
        stopReason: "aborted",
        errorMessage: "This operation was aborted",
      },
    ]);

    await expectRecovery({ started: 1, settled: 0, failed: 0, skipped: 0 });
    expect(callGateway).toHaveBeenCalledTimes(1);
    expect(gatewayParams()).toMatchObject({ forceRestartSafeTools: true });
  });

  it("resumes an interrupted replay-safe tool call without restricting tools", async () => {
    await writeMainSessionTranscript([
      { role: "user", content: "do the thing" },
      createAssistantToolCallMessage([
        { type: "text", text: "Let me look that up." },
        { type: "toolCall", id: "call-read-1", name: "read", arguments: { path: "README.md" } },
      ]),
    ]);

    await expectRecovery({ started: 1, settled: 0, failed: 0, skipped: 0 });
    expect(callGateway).toHaveBeenCalledTimes(1);
    expect(gatewayParams()).not.toMatchObject({ forceRestartSafeTools: true });
  });

  it("resumes through the shutdown error persisted for an interrupted Code Mode wait", async () => {
    await writeMainSessionTranscript([
      { role: "user", content: "do the thing" },
      codeModeCheckpointMessage(),
      codeModeWaitCallMessage(),
      {
        role: "toolResult",
        toolName: "wait",
        toolCallId: "call-wait-1",
        content: [{ type: "text", text: "Error: The operation was aborted." }],
        details: {
          status: "failed",
          error: "Error: The operation was aborted.",
          code: "internal_error",
        },
        isError: true,
      },
      {
        role: "assistant",
        content: [],
        stopReason: "aborted",
        errorMessage: "Request was aborted",
      },
    ]);

    await expectRecovery({ started: 1, settled: 0, failed: 0, skipped: 0 });
    expect(gatewayParams()).toMatchObject({
      forceRestartSafeTools: true,
      forceCodeModeTools: true,
    });
  });

  it("resumes through the current Code Mode abort persisted for an interrupted wait", async () => {
    await writeMainSessionTranscript([
      { role: "user", content: "do the thing" },
      codeModeCheckpointMessage(),
      codeModeWaitCallMessage(),
      {
        role: "toolResult",
        toolName: "wait",
        toolCallId: "call-wait-1",
        content: [
          {
            type: "text",
            text: JSON.stringify({
              status: "failed",
              code: "aborted",
              error: "code mode execution aborted",
            }),
          },
        ],
        details: {
          status: "failed",
          code: "aborted",
          error: "code mode execution aborted",
          replaySafe: true,
        },
        isError: true,
      },
      {
        role: "assistant",
        content: [],
        stopReason: "aborted",
        errorCode: "OPENCLAW_RESTART_ABORT",
        errorMessage: "agent run aborted for restart",
      },
    ]);

    await expectRecovery({ started: 1, settled: 0, failed: 0, skipped: 0 });
    expect(gatewayParams()).toMatchObject({
      forceRestartSafeTools: true,
      forceCodeModeTools: true,
    });
  });

  it.each([
    {
      label: "matching failed-wait result identity",
      toolCallIds: ["call-wait-1"],
      restoresCodeModeTools: true,
    },
    {
      label: "mismatched failed-wait result identity",
      toolCallIds: ["call-other"],
      restoresCodeModeTools: false,
    },
    {
      label: "missing failed-wait result identity",
      toolCallIds: [undefined],
      restoresCodeModeTools: false,
    },
    {
      label: "duplicate failed-wait result identities",
      toolCallIds: ["call-wait-1", "call-wait-1"],
      restoresCodeModeTools: false,
    },
  ])(
    "restores Code Mode tools only for exactly one $label",
    async ({ toolCallIds, restoresCodeModeTools }) => {
      await writeMainSessionTranscript([
        { role: "user", content: "do the thing" },
        codeModeCheckpointMessage(),
        codeModeWaitCallMessage(),
        ...toolCallIds.map((toolCallId) => ({
          role: "toolResult",
          toolName: "wait",
          ...(toolCallId ? { toolCallId } : {}),
          content: [{ type: "text", text: "Error: The operation was aborted." }],
          details: {
            status: "failed",
            error: "Error: The operation was aborted.",
            code: "internal_error",
          },
          isError: true,
        })),
      ]);

      await expectRecovery({ started: 1, settled: 0, failed: 0, skipped: 0 });
      expect(gatewayParams()).toMatchObject({ forceRestartSafeTools: true });
      if (restoresCodeModeTools) {
        expect(gatewayParams()).toMatchObject({ forceCodeModeTools: true });
      } else {
        expect(gatewayParams()).not.toHaveProperty("forceCodeModeTools");
      }
    },
  );

  it.each([
    {
      label: "non-replay-safe checkpoint",
      checkpoint: {
        status: "waiting",
        runId: "cm_interrupted",
        reason: "pending_tools",
        replaySafe: false,
      },
    },
    {
      label: "replay-safe checkpoint for another run",
      checkpoint: {
        status: "waiting",
        runId: "cm_other",
        reason: "yield",
        replaySafe: true,
      },
    },
  ])("resumes a Code Mode wait safely after a $label", async ({ checkpoint }) => {
    await writeMainSessionTranscript([
      { role: "user", content: "do the thing" },
      codeModeCheckpointMessage("wait", checkpoint),
      codeModeWaitCallMessage(),
    ]);

    await expectRecovery({ started: 1, settled: 0, failed: 0, skipped: 0 });
    expect(callGateway).toHaveBeenCalledOnce();
    expect(gatewayParams()).toMatchObject({ forceRestartSafeTools: true });
    expect(gatewayParams()).not.toHaveProperty("forceCodeModeTools");
  });

  it("resumes a mixed Code Mode wait and side-effecting tool tail safely", async () => {
    await writeMainSessionTranscript([
      { role: "user", content: "do the thing" },
      codeModeCheckpointMessage("exec"),
      createAssistantToolCallMessage([
        {
          type: "toolCall",
          id: "call-wait-1",
          name: "wait",
          arguments: { runId: "cm_interrupted" },
        },
        {
          type: "toolCall",
          id: "call-write-1",
          name: "write",
          arguments: { path: "result.txt", content: "done" },
        },
      ]),
    ]);

    await expectRecovery({ started: 1, settled: 0, failed: 0, skipped: 0 });
    expect(callGateway).toHaveBeenCalledOnce();
    expect(gatewayParams()).toMatchObject({ forceRestartSafeTools: true });
    expect(gatewayParams()).not.toHaveProperty("forceCodeModeTools");
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
