import { vi } from "vitest";
import type { InternalSessionEntry as SessionEntry } from "../../../config/sessions/types.js";
import type { GatewayRecoveryRuntime } from "../../../gateway/server-instance-runtime.types.js";
import { bindGatewayContextResolver } from "../../../plugins/runtime/gateway-request-scope.js";
import {
  consumeSessionWorkAdmissionHandoff,
  type SessionWorkAdmissionLease,
} from "../../../sessions/session-lifecycle-admission.js";
import {
  createSubagentRunRecord,
  type SubagentRunRecordOverrides,
} from "../../subagent-test-fixtures.test-helpers.js";
import { recoverInterruptedSubagentRow } from "./subagent-registry-restart-recovery.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

const mocks = vi.hoisted(() => ({
  entries: {} as Record<string, SessionEntry>,
  loadSessionEntry: vi.fn(),
  patchSessionEntryCore: vi.fn(),
  readSessionMessages: vi.fn(async () => [] as unknown[]),
}));

vi.mock("../../../config/config.js", () => ({
  getRuntimeConfig: () => ({ session: { store: undefined } }),
}));
vi.mock("../../../config/sessions.js", () => ({
  resolveAgentIdFromSessionKey: () => "main",
  resolveSessionStorePathCore: () => "/tmp/subagent-recovery.sqlite",
}));
vi.mock("../../../config/sessions/session-accessor.js", () => ({
  loadSessionEntry: mocks.loadSessionEntry,
  patchSessionEntryCore: mocks.patchSessionEntryCore,
}));
vi.mock("../../../gateway/session-transcript-readers.js", () => ({
  readSessionMessagesAsync: mocks.readSessionMessages,
}));

const childSessionKey = "agent:main:subagent:restart-child";
function consumeRecoveryAdmission(payload: Record<string, unknown>): SessionWorkAdmissionLease {
  const lease = consumeSessionWorkAdmissionHandoff({
    handoffId: String(payload.internalRuntimeHandoffId),
    scope: "/tmp/subagent-recovery.sqlite",
    identities: [childSessionKey, String(payload.expectedExistingSessionId)],
    onInterrupt: () => undefined,
  });
  if (!lease) {
    throw new Error("expected recovery dispatch to consume its session admission handoff");
  }
  return lease;
}

const dispatchAgent = vi.fn(async (payload: Record<string, unknown>, _timeoutMs?: number) => {
  consumeRecoveryAdmission(payload).release();
  return {
    runId: String(payload.idempotencyKey),
    status: "accepted",
  };
});
const gatewayRuntime: GatewayRecoveryRuntime = {
  dispatchAgent: dispatchAgent as GatewayRecoveryRuntime["dispatchAgent"],
  waitForAgent: vi.fn(),
  sendRecoveryNotice: vi.fn(async () => ({ suppressed: false })),
};
const gatewayContext = {
  recoveryRuntime: gatewayRuntime,
  resolveGatewayContext: () => gatewayContext as never,
};
bindGatewayContextResolver(gatewayRuntime, gatewayContext.resolveGatewayContext);
type RecoveryParams = Parameters<typeof recoverInterruptedSubagentRow>[0];
const replaceRun = vi.fn<RecoveryParams["replaceRun"]>(() => true);
const clearAcceptedRecovery = vi.fn<RecoveryParams["clearAcceptedRecovery"]>((params) => {
  params.expected.execution.restartRecovery = undefined;
  if (params.pendingNoticeIdempotencyKey) {
    params.expected.resumptionNotice = {
      idempotencyKey: params.pendingNoticeIdempotencyKey,
    };
  }
  return true;
});
const clearPendingNotice = vi.fn<RecoveryParams["clearPendingNotice"]>((params) => {
  params.expected.resumptionNotice = undefined;
  return true;
});
const resumeAcceptedRecovery = vi.fn<RecoveryParams["resumeAcceptedRecovery"]>(() => true);
const reserveLaunch = vi.fn<RecoveryParams["reserveLaunch"]>((params) => params.idempotencyKey);
const markLaunchAttempted = vi.fn<RecoveryParams["markLaunchAttempted"]>((params) => ({
  sessionId: "session-id",
  sessionMarker: params.sessionMarker,
  idempotencyKey: params.idempotencyKey,
  phase: "attempted" as const,
  lifecycleGeneration: params.lifecycleGeneration,
}));
const markLaunchConsumed = vi.fn<RecoveryParams["markLaunchConsumed"]>((params) => ({
  sessionId: "session-id",
  sessionMarker: params.sessionMarker,
  idempotencyKey: params.idempotencyKey,
  phase: "consumed" as const,
}));
const markLaunchAccepted = vi.fn<RecoveryParams["markLaunchAccepted"]>((params) => {
  const accepted = {
    sessionId: "session-id",
    sessionMarker: params.sessionMarker,
    idempotencyKey: params.idempotencyKey,
    phase: "accepted" as const,
  };
  params.expected.execution.restartRecovery = accepted;
  return accepted;
});
const resetLaunchAttempt = vi.fn<RecoveryParams["resetLaunchAttempt"]>(() => true);
const abandonLaunch = vi.fn<RecoveryParams["abandonLaunch"]>(() => true);
const warn = vi.fn();

function run(overrides: Partial<SubagentRunRecordOverrides> = {}): SubagentRunRecord {
  return createSubagentRunRecord({
    runId: "original-run",
    childSessionKey,
    requesterSessionKey: "agent:main:main",
    requesterDisplayKey: "main",
    requesterOrigin: { channel: "qa-channel", to: "qa-requester", accountId: "default" },
    task: "finish the restart-safe task",
    cleanup: "keep",
    createdAt: Date.now() - 60_000,
    startedAt: Date.now() - 55_000,
    ...overrides,
  });
}

function getMockSessionId(): string {
  const sessionId = mocks.entries[childSessionKey]?.sessionId;
  if (!sessionId) {
    throw new Error("expected mock recovery session");
  }
  return sessionId;
}

function recover(
  entry: SubagentRunRecord,
  overrides: Partial<Parameters<typeof recoverInterruptedSubagentRow>[0]> = {},
) {
  return recoverInterruptedSubagentRow({
    runId: entry.runId,
    entry,
    now: Date.now(),
    gatewayRuntime,
    isCurrent: () => true,
    abandonLaunch,
    clearAcceptedRecovery,
    clearPendingNotice,
    getRun: () => entry,
    replaceRun,
    markLaunchAccepted,
    markLaunchAttempted,
    markLaunchConsumed,
    reserveLaunch,
    resumeAcceptedRecovery,
    resetLaunchAttempt,
    warn,
    ...overrides,
  });
}

export const restartRecoveryTestHarness = {
  mocks,
  childSessionKey,
  gatewayRuntime,
  consumeRecoveryAdmission,
  dispatchAgent,
  replaceRun,
  clearAcceptedRecovery,
  clearPendingNotice,
  resumeAcceptedRecovery,
  reserveLaunch,
  markLaunchAttempted,
  markLaunchConsumed,
  markLaunchAccepted,
  resetLaunchAttempt,
  abandonLaunch,
  warn,
  run,
  getMockSessionId,
  recover,
  reset() {
    vi.clearAllMocks();
    mocks.entries = {
      [childSessionKey]: {
        sessionId: "session-id",
        updatedAt: Date.now(),
        abortedLastRun: true,
      },
    };
    mocks.loadSessionEntry.mockImplementation(
      ({ sessionKey }: { sessionKey: string }) => mocks.entries[sessionKey],
    );
    mocks.patchSessionEntryCore.mockImplementation(
      async (
        { sessionKey }: { sessionKey: string },
        update: (entry: SessionEntry) => SessionEntry | null,
      ) => {
        const current = mocks.entries[sessionKey];
        if (!current) {
          return null;
        }
        const next = update({ ...current });
        if (next) {
          mocks.entries[sessionKey] = next;
        }
        return next;
      },
    );
    dispatchAgent.mockImplementation(async (payload) => {
      consumeRecoveryAdmission(payload).release();
      return {
        runId: String(payload.idempotencyKey),
        status: "accepted",
      };
    });
    replaceRun.mockReturnValue(true);
    reserveLaunch.mockImplementation((params: { idempotencyKey: string }) => params.idempotencyKey);
    markLaunchAttempted.mockImplementation(
      (params: { idempotencyKey: string; lifecycleGeneration: string; sessionMarker: string }) => ({
        sessionId: getMockSessionId(),
        sessionMarker: params.sessionMarker,
        idempotencyKey: params.idempotencyKey,
        phase: "attempted" as const,
        lifecycleGeneration: params.lifecycleGeneration,
      }),
    );
    markLaunchConsumed.mockImplementation(
      (params: { idempotencyKey: string; sessionMarker: string }) => ({
        sessionId: getMockSessionId(),
        sessionMarker: params.sessionMarker,
        idempotencyKey: params.idempotencyKey,
        phase: "consumed" as const,
      }),
    );
    markLaunchAccepted.mockImplementation((params) => {
      const accepted = {
        sessionId: getMockSessionId(),
        sessionMarker: params.sessionMarker,
        idempotencyKey: params.idempotencyKey,
        phase: "accepted" as const,
      };
      params.expected.execution.restartRecovery = accepted;
      return accepted;
    });
    resetLaunchAttempt.mockReturnValue(true);
    abandonLaunch.mockReturnValue(true);
    clearAcceptedRecovery.mockImplementation((params) => {
      params.expected.execution.restartRecovery = undefined;
      if (params.pendingNoticeIdempotencyKey) {
        params.expected.resumptionNotice = {
          idempotencyKey: params.pendingNoticeIdempotencyKey,
        };
      }
      return true;
    });
    clearPendingNotice.mockImplementation((params) => {
      params.expected.resumptionNotice = undefined;
      return true;
    });
    resumeAcceptedRecovery.mockReturnValue(true);
    vi.mocked(gatewayRuntime.sendRecoveryNotice).mockResolvedValue({ suppressed: false });
    mocks.readSessionMessages.mockResolvedValue([]);
  },
};
