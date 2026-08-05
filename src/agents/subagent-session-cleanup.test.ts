import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { callGateway as defaultCallGateway, CallGatewayOptions } from "../gateway/call.js";
import {
  deleteSubagentSessionForCleanup,
  resetSubagentSessionCleanupForTests,
} from "./subagent-session-cleanup.js";

const hasLiveOrRecentlyDispatchedContinuationWorkMock = vi.hoisted(() => vi.fn(() => false));
const hasRecoverablePendingDelegateMock = vi.hoisted(() => vi.fn(() => false));
const failStagedPostCompactionDelegatesForCleanupMock = vi.hoisted(() => vi.fn(() => 0));
const countActiveDescendantRunsMock = vi.hoisted(() => vi.fn(() => 0));
const logWarnMock = vi.hoisted(() => vi.fn());
const cleanupSessionIdentity = {
  expectedSessionId: "child-session-id",
  expectedLifecycleRevision: "child-lifecycle-revision",
} as const;

vi.mock("../logging/subsystem.js", () => ({
  createSubsystemLogger: () => ({
    warn: logWarnMock,
  }),
}));

vi.mock("../auto-reply/continuation/work-store.js", () => ({
  hasLiveOrRecentlyDispatchedContinuationWork: hasLiveOrRecentlyDispatchedContinuationWorkMock,
}));

vi.mock("../auto-reply/continuation/delegate-store.js", () => ({
  hasRecoverablePendingDelegate: hasRecoverablePendingDelegateMock,
}));

vi.mock("../auto-reply/continuation/delegate-store-post-compaction.js", () => ({
  failStagedPostCompactionDelegatesForCleanup: failStagedPostCompactionDelegatesForCleanupMock,
}));

vi.mock("./subagent-registry-runtime.js", () => ({
  countActiveDescendantRuns: countActiveDescendantRunsMock,
}));

describe("deleteSubagentSessionForCleanup", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetSubagentSessionCleanupForTests();
    hasLiveOrRecentlyDispatchedContinuationWorkMock.mockReset().mockReturnValue(false);
    hasRecoverablePendingDelegateMock.mockReset().mockReturnValue(false);
    failStagedPostCompactionDelegatesForCleanupMock.mockReset().mockReturnValue(0);
    countActiveDescendantRunsMock.mockReset().mockReturnValue(0);
    logWarnMock.mockReset();
  });

  afterEach(() => {
    resetSubagentSessionCleanupForTests();
    vi.useRealTimers();
  });

  it("refuses key-only deletion without scheduling a retry", async () => {
    const callGateway = vi.fn(async function mockCallGateway<T = Record<string, unknown>>(
      _opts: CallGatewayOptions,
    ): Promise<T> {
      return { ok: true } as T;
    }) as typeof defaultCallGateway;

    const result = await deleteSubagentSessionForCleanup({
      callGateway,
      childSessionKey: "agent:main:subagent:identity-missing",
    });

    expect(result).toBe("failed");
    expect(callGateway).not.toHaveBeenCalled();
    expect(hasLiveOrRecentlyDispatchedContinuationWorkMock).not.toHaveBeenCalled();
    expect(hasRecoverablePendingDelegateMock).not.toHaveBeenCalled();
    expect(countActiveDescendantRunsMock).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(5_000);
    expect(callGateway).not.toHaveBeenCalled();
  });

  it("defers deletion while accepted descendant delegate runs still depend on the child session", async () => {
    const callGateway = vi.fn(async function mockCallGateway<T = Record<string, unknown>>(
      _opts: CallGatewayOptions,
    ): Promise<T> {
      return { ok: true } as T;
    }) as typeof defaultCallGateway;
    countActiveDescendantRunsMock.mockReturnValueOnce(1).mockReturnValueOnce(0);

    await deleteSubagentSessionForCleanup({
      callGateway,
      childSessionKey: "agent:main:subagent:child",
      ...cleanupSessionIdentity,
    });
    expect(callGateway).not.toHaveBeenCalled();
    expect(failStagedPostCompactionDelegatesForCleanupMock).not.toHaveBeenCalled();
    expect(countActiveDescendantRunsMock).toHaveBeenCalledWith("agent:main:subagent:child");

    await vi.advanceTimersByTimeAsync(5_000);
    expect(callGateway).toHaveBeenCalledWith({
      method: "sessions.delete",
      params: {
        key: "agent:main:subagent:child",
        deleteTranscript: true,
        emitLifecycleHooks: false,
        expectedSessionId: cleanupSessionIdentity.expectedSessionId,
        expectedLifecycleRevision: cleanupSessionIdentity.expectedLifecycleRevision,
      },
      timeoutMs: 10_000,
    });
  });

  it("defers deletion while recoverable continuation delegate substrate exists", async () => {
    const callGateway = vi.fn(async function mockCallGateway<T = Record<string, unknown>>(
      _opts: CallGatewayOptions,
    ): Promise<T> {
      return { ok: true } as T;
    }) as typeof defaultCallGateway;
    hasRecoverablePendingDelegateMock.mockReturnValueOnce(true).mockReturnValueOnce(false);

    await deleteSubagentSessionForCleanup({
      callGateway,
      childSessionKey: "agent:main:subagent:post-compaction-owner",
      ...cleanupSessionIdentity,
    });
    expect(callGateway).not.toHaveBeenCalled();
    expect(failStagedPostCompactionDelegatesForCleanupMock).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(5_000);
    expect(callGateway).toHaveBeenCalledWith({
      method: "sessions.delete",
      params: {
        key: "agent:main:subagent:post-compaction-owner",
        deleteTranscript: true,
        emitLifecycleHooks: false,
        expectedSessionId: cleanupSessionIdentity.expectedSessionId,
        expectedLifecycleRevision: cleanupSessionIdentity.expectedLifecycleRevision,
      },
      timeoutMs: 10_000,
    });
  });

  it("drops post-compaction rows owned by completed delete-mode children before cleanup gating", async () => {
    const callGateway = vi.fn(async function mockCallGateway<T = Record<string, unknown>>(
      _opts: CallGatewayOptions,
    ): Promise<T> {
      return { ok: true } as T;
    }) as typeof defaultCallGateway;
    failStagedPostCompactionDelegatesForCleanupMock.mockReturnValueOnce(1);
    hasRecoverablePendingDelegateMock.mockReturnValue(false);
    countActiveDescendantRunsMock.mockReturnValue(0);

    await deleteSubagentSessionForCleanup({
      callGateway,
      childSessionKey: "agent:main:subagent:post-compaction-owner",
      ...cleanupSessionIdentity,
    });

    expect(failStagedPostCompactionDelegatesForCleanupMock).toHaveBeenCalledWith(
      "agent:main:subagent:post-compaction-owner",
      expect.stringContaining("will not receive a future compaction seam"),
    );
    expect(hasRecoverablePendingDelegateMock).toHaveBeenCalledWith(
      "agent:main:subagent:post-compaction-owner",
    );
    expect(logWarnMock).toHaveBeenCalledWith(
      expect.stringContaining("[subagent-session-cleanup-post-compaction-delegates-dropped]"),
    );
    expect(callGateway).toHaveBeenCalledWith({
      method: "sessions.delete",
      params: {
        key: "agent:main:subagent:post-compaction-owner",
        deleteTranscript: true,
        emitLifecycleHooks: false,
        expectedSessionId: cleanupSessionIdentity.expectedSessionId,
        expectedLifecycleRevision: cleanupSessionIdentity.expectedLifecycleRevision,
      },
      timeoutMs: 10_000,
    });
  });

  it("logs delete failures and retries cleanup a bounded number of times", async () => {
    const callGateway = vi.fn(async function mockCallGateway<T = Record<string, unknown>>(
      _opts: CallGatewayOptions,
    ): Promise<T> {
      throw new Error("delete failed");
    }) as typeof defaultCallGateway;

    await deleteSubagentSessionForCleanup({
      callGateway,
      childSessionKey: "agent:main:subagent:delete-fails",
      ...cleanupSessionIdentity,
    });
    expect(logWarnMock).toHaveBeenCalledWith(
      expect.stringContaining("[subagent-session-cleanup-delete-failed]"),
    );

    await vi.advanceTimersByTimeAsync(5_000);
    await vi.advanceTimersByTimeAsync(5_000);
    await vi.advanceTimersByTimeAsync(5_000);
    await vi.advanceTimersByTimeAsync(5_000);

    expect(callGateway).toHaveBeenCalledTimes(4);
    expect(logWarnMock).toHaveBeenCalledTimes(4);
  });
});
