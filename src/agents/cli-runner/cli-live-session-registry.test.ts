import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type {
  CliBackendLiveSessionCapability,
  CliBackendLiveSessionHandle,
} from "../../plugins/cli-backend.types.js";
import { prepareSystemAgentRunAdmission } from "../admitted-run-context.js";
import { buildPreparedCliRunContext } from "../cli-runner.test-helpers.js";
import { hasModelFallbackStop } from "../failover-error.js";
import { createAgentCleanupScope } from "../run-cleanup-timeout.js";
import {
  acceptsCliLiveSession,
  buildCliLiveOwnerKey,
  closeCliLiveSession,
  createCliLiveSessionCapability,
  getCliLiveSessionGeneration,
  hasCliLiveSession,
  restartCliLiveSession,
} from "./cli-live-session-registry.js";
import { settlePreparedCliRun } from "./cli-run-settlement.js";
import { buildCliLiveSessionFingerprint } from "./live-session-fingerprint.js";

const admissions: Array<ReturnType<typeof prepareSystemAgentRunAdmission>> = [];
const sessions = new Set<CliBackendLiveSessionHandle>();
let nextOwnerId = 0;

async function createOwner(
  options: {
    sessionId?: string;
    generation?: string;
    idle?: boolean;
    deferExit?: boolean;
    cleanup?: () => Promise<void>;
    systemPrompt?: string;
    argv0?: string;
    capture?: { token: string; key: string };
    requiredGeneration?: string;
  } = {},
) {
  const index = ++nextOwnerId;
  const sessionId = options.sessionId ?? `registry-session-${index}`;
  const sessionKey = `agent:main:${sessionId}`;
  const context = buildPreparedCliRunContext({
    provider: "claude-cli",
    agentId: "main",
    runId: `registry-run-${index}`,
    sessionId,
    sessionKey,
    ...(options.systemPrompt ? { systemPrompt: options.systemPrompt } : {}),
  });
  const admission = prepareSystemAgentRunAdmission(
    {},
    context.params.runId,
    "main",
    "registry-test",
  );
  admissions.push(admission);
  context.params.admittedRunContext = await admission.admit("plugin-harness");
  const controller = new AbortController();
  context.params.abortSignal = controller.signal;
  let callerCurrent = true;
  context.params.assertCurrent = () => {
    if (!callerCurrent) {
      throw new Error("caller is no longer active");
    }
  };
  const grant = options.capture
    ? {
        transportToken: options.capture.token,
        adoptProcessToken: vi.fn(),
        revokeProcessToken: vi.fn(),
        activate: vi.fn(),
        deactivate: vi.fn(),
      }
    : undefined;
  if (grant) {
    context.preparedBackend.mcpClientGrantCapture = grant;
  }
  const beginCapture = vi.fn();
  const capability: CliBackendLiveSessionCapability = createCliLiveSessionCapability({
    context,
    argv: ["claude", "-p"],
    argv0: options.argv0,
    env: { PATH: "/usr/bin:/bin" },
    beginCapture,
    abortSignal: controller.signal,
    ...(options.cleanup ? { claimResources: () => options.cleanup } : {}),
    ...(options.capture ? { captureKey: options.capture.key } : {}),
    ...(options.requiredGeneration ? { requiredGeneration: options.requiredGeneration } : {}),
  });
  const exited = createDeferred();
  const close = vi.fn(() => {
    capability.remove(session);
    if (!options.deferExit) {
      exited.resolve();
    }
  });
  const waitForExit = vi.fn(() => exited.promise);
  const session: CliBackendLiveSessionHandle = {
    generation: options.generation ?? `generation-${index}`,
    fingerprint: capability.fingerprint,
    isIdle: vi.fn(() => options.idle ?? false),
    close,
    waitForExit,
  };
  const register = () => {
    capability.register(session);
    sessions.add(session);
    return session;
  };
  return {
    admission,
    beginCapture,
    capability,
    close,
    context,
    controller,
    revokeCaller: () => (callerCurrent = false),
    exited,
    grant,
    register,
    session,
    sessionId,
    sessionKey,
    waitForExit,
  };
}

afterEach(() => {
  for (const session of sessions) {
    session.close("restart");
  }
  sessions.clear();
  for (const admission of admissions.splice(0)) {
    admission.close();
  }
  vi.restoreAllMocks();
});

describe("generic plugin-owned live session registry", () => {
  it("keeps owner identity deterministic and isolated across sessions", () => {
    const owner = {
      agentAccountId: "acct-1",
      agentId: "agent-main",
      authProfileId: "profile-a",
      sessionId: "sess-1",
      sessionKey: "key-a",
    };

    expect(buildCliLiveOwnerKey({ ...owner })).toBe(buildCliLiveOwnerKey(owner));
    expect(buildCliLiveOwnerKey({ ...owner, sessionKey: "key-b" })).not.toBe(
      buildCliLiveOwnerKey(owner),
    );
  });

  it("keeps fresh and resumed process fingerprints identical without hiding prompt changes", () => {
    const fresh = buildPreparedCliRunContext({ systemPrompt: "Original system policy." });
    const resumed = buildPreparedCliRunContext({ systemPrompt: "Original system policy." });
    const changed = buildPreparedCliRunContext({ systemPrompt: "Changed system policy." });
    const mcpFresh = buildPreparedCliRunContext({ systemPrompt: "Original system policy." });
    const mcpResumed = buildPreparedCliRunContext({ systemPrompt: "Original system policy." });
    mcpFresh.preparedBackend.mcpConfigHash = "stable-mcp-config";
    mcpResumed.preparedBackend.mcpConfigHash = "stable-mcp-config";
    const env = { PATH: "/usr/bin:/bin" };
    const freshFingerprint = buildCliLiveSessionFingerprint({
      context: fresh,
      argv: ["claude", "-p", "--session-id", "native-session"],
      env,
    });

    expect(
      buildCliLiveSessionFingerprint({
        context: resumed,
        argv: ["claude", "-p", "--resume", "native-session"],
        env,
      }),
    ).toBe(freshFingerprint);
    expect(
      buildCliLiveSessionFingerprint({
        context: changed,
        argv: ["claude", "-p", "--resume", "native-session"],
        env,
      }),
    ).not.toBe(freshFingerprint);
    expect(
      buildCliLiveSessionFingerprint({
        context: resumed,
        argv: ["claude", "-p", "--resume", "native-session", "--effort", "max"],
        env,
      }),
    ).not.toBe(freshFingerprint);
    expect(
      buildCliLiveSessionFingerprint({
        context: resumed,
        argv: ["claude", "-p", "--resume", "native-session"],
        env: { ...env, CLAUDE_CODE_EFFORT_LEVEL: "max" },
      }),
    ).not.toBe(freshFingerprint);

    const mcpFreshFingerprint = buildCliLiveSessionFingerprint({
      context: mcpFresh,
      argv: ["claude", "-p", "--session-id", "native-session", "--mcp-config", "/tmp/turn-a.json"],
      env,
    });
    expect(
      buildCliLiveSessionFingerprint({
        context: mcpResumed,
        argv: ["claude", "-p", "--resume", "native-session", "--mcp-config", "/tmp/turn-b.json"],
        env,
      }),
    ).toBe(mcpFreshFingerprint);
  });

  it("exposes only an active registered generation and never revives a removed owner", async () => {
    const owner = await createOwner({ generation: "generation-exact" });
    const identity = {
      backendId: "claude-cli",
      agentId: "main",
      sessionId: owner.sessionId,
      sessionKey: owner.sessionKey,
    };

    expect(hasCliLiveSession(identity)).toBe(false);
    owner.register();
    expect(hasCliLiveSession(identity)).toBe(true);
    expect(getCliLiveSessionGeneration(identity)).toBe("generation-exact");

    owner.capability.remove(owner.session);
    expect(owner.capability.current()).toBeUndefined();
    expect(hasCliLiveSession(identity)).toBe(false);
  });

  it.each(["admission", "caller", "signal"] as const)(
    "rejects registration after %s revocation",
    async (revocation) => {
      const owner = await createOwner();
      if (revocation === "admission") {
        owner.admission.close();
      } else if (revocation === "caller") {
        owner.revokeCaller();
      } else {
        owner.controller.abort();
      }

      expect(() => owner.register()).toThrow(
        revocation === "signal" ? /no longer active|aborted/ : "no longer active",
      );
      expect(
        hasCliLiveSession({
          backendId: "claude-cli",
          agentId: "main",
          sessionId: owner.sessionId,
          sessionKey: owner.sessionKey,
        }),
      ).toBe(false);
    },
  );

  it("fences caller-revoked live access while allowing its owned cleanup", async () => {
    const owner = await createOwner();
    owner.register();
    owner.capability.activate(owner.session);
    expect(owner.capability.current()).toBe(owner.session);
    owner.revokeCaller();
    expect(owner.controller.signal.aborted).toBe(false);
    expect(() => owner.capability.current()).toThrow("caller is no longer active");
    expect(() => owner.capability.activate(owner.session)).toThrow("caller is no longer active");
    await expect(owner.capability.restart()).rejects.toThrow("caller is no longer active");
    expect(owner.close).not.toHaveBeenCalled();
    await closeCliLiveSession(owner.context, "restart");
    expect(owner.close).toHaveBeenCalledOnce();
  });

  it.each([false, true])(
    "rechecks caller authority after registered process cleanup (revoked=%s)",
    async (revoked) => {
      const entered = createDeferred();
      const held = createDeferred();
      const owner = await createOwner({
        cleanup: async () => {
          entered.resolve();
          await held.promise;
        },
      });
      owner.register();
      const restarting = await createOwner({ sessionId: owner.sessionId });
      const run = restarting.capability.restart();
      const observed = run.then(
        () => "restarted",
        (error: unknown) => error,
      );
      try {
        await entered.promise;
        if (revoked) {
          restarting.revokeCaller();
        }
        expect(restarting.controller.signal.aborted).toBe(false);
      } finally {
        held.resolve();
      }
      expect(await observed).toEqual(
        revoked ? new Error("caller is no longer active") : "restarted",
      );
      expect(owner.close).toHaveBeenCalledOnce();
    },
  );

  it.each(["retained", "registered"] as const)(
    "refuses replacement when the %s process has not exited by the cleanup deadline",
    async (ownerKind) => {
      const owner = await createOwner({ deferExit: true });
      owner.register();
      const restarting =
        ownerKind === "retained" ? owner : await createOwner({ sessionId: owner.sessionId });
      restarting.context.params.oneShotCliRun = true;
      const replacement = vi.fn();
      const cleanupScope = createAgentCleanupScope();
      vi.useFakeTimers();
      const observed = cleanupScope
        .run(async () => {
          await restartCliLiveSession(restarting.context);
          replacement();
        })
        .then(
          () => undefined,
          (error: unknown) => error,
        );
      try {
        await vi.advanceTimersByTimeAsync(10_000);
        const failure = await observed;
        expect(failure).toBeInstanceOf(Error);
        expect(failure).toMatchObject({
          message: expect.stringContaining("resource replacement refused"),
        });
        expect(hasModelFallbackStop(failure)).toBe(true);
        expect(replacement).not.toHaveBeenCalled();
        expect(owner.close).toHaveBeenCalledOnce();
        expect(owner.capability.current()).toBeUndefined();
        expect(cleanupScope.outcome).toBe("uncertain");
        const next = await createOwner({ sessionId: owner.sessionId });
        next.context.params.oneShotCliRun = true;
        const nextRestart = next.capability.restart().then(
          () => undefined,
          (error: unknown) => error,
        );
        await vi.advanceTimersByTimeAsync(10_000);
        expect(await nextRestart).toMatchObject({
          message: expect.stringContaining("resource replacement refused"),
        });
        expect(() => next.register()).toThrow("cleanup has not settled");
        owner.exited.resolve();
        await restartCliLiveSession(next.context);
        expect(() => next.register()).not.toThrow();
      } finally {
        owner.exited.resolve();
        await observed;
        vi.useRealTimers();
      }
    },
  );

  it("joins natural retirement that starts while restart is awaiting the previous owner", async () => {
    const held = createDeferred();
    const cleanup = vi.fn(() => held.promise);
    const original = await createOwner({ cleanup });
    original.register();
    const next = await createOwner({ sessionId: original.sessionId });
    let settled = false;
    const restarting = next.capability.restart().then(() => {
      settled = true;
    });
    original.capability.remove(original.session);
    original.exited.resolve();
    try {
      await vi.waitFor(() => expect(cleanup).toHaveBeenCalledOnce());
      expect(settled).toBe(false);
    } finally {
      held.resolve();
      await restarting;
    }
    next.register();
    expect(next.capability.current()).toBe(next.session);
    expect(original.close).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "rejects the same process handle under a different owner (retired=%s)",
    async (retired) => {
      const original = await createOwner({ sessionId: "original-owner" });
      const other = await createOwner({ sessionId: "different-owner" });
      original.register();
      if (retired) {
        original.capability.remove(original.session);
      }
      try {
        expect(other.capability.fingerprint).toBe(original.capability.fingerprint);
        expect(() => other.capability.register(original.session)).toThrow();
        expect(other.capability.current()).toBeUndefined();
        expect(original.capability.current()).toBe(retired ? undefined : original.session);
      } finally {
        other.capability.remove(original.session);
      }
    },
  );

  it.each([
    {
      change: "system prompt",
      originalOptions: { systemPrompt: "Original system policy." },
      changedOptions: { systemPrompt: "Changed system policy." },
    },
    {
      change: "invocation name",
      originalOptions: { argv0: "/usr/bin/cli-alias-a" },
      changedOptions: { argv0: "/usr/bin/cli-alias-b" },
    },
  ])(
    "rejects required generation reuse after $change changes without closing its only process",
    async ({ originalOptions, changedOptions }) => {
      const original = await createOwner({
        sessionId: "required-changed-owner",
        generation: "required-generation",
        ...originalOptions,
      });
      original.register();
      const changed = await createOwner({
        sessionId: "required-changed-owner",
        requiredGeneration: "required-generation",
        ...changedOptions,
      });

      expect(changed.capability.fingerprint).not.toBe(original.capability.fingerprint);
      expect(() => changed.capability.current()).toThrow(
        expect.objectContaining({ reason: "session_expired", code: "cli_live_session_changed" }),
      );
      expect(original.close).not.toHaveBeenCalled();
      expect(original.capability.current()).toBe(original.session);
    },
  );

  it("refuses plugin restart when the exact live generation is required", async () => {
    const original = await createOwner({ generation: "required-live-process" });
    original.register();
    const resumed = await createOwner({
      sessionId: original.sessionId,
      requiredGeneration: original.session.generation,
    });
    expect(resumed.capability.current()).toBe(original.session);
    await expect(resumed.capability.restart()).rejects.toMatchObject({
      reason: "session_expired",
      code: "cli_live_session_changed",
    });
    expect(original.close).not.toHaveBeenCalled();
    expect(original.capability.current()).toBe(original.session);
  });

  it("transfers admitted MCP authority to the original private process before capture", async () => {
    const original = await createOwner({
      sessionId: "captured-owner",
      capture: { token: "process-token-a", key: "capture-a" },
    });
    original.register();
    const resumed = await createOwner({
      sessionId: "captured-owner",
      capture: { token: "turn-token-b", key: "capture-b" },
    });

    resumed.capability.activate(original.session);

    expect(resumed.grant?.adoptProcessToken).toHaveBeenCalledExactlyOnceWith("process-token-a");
    expect(resumed.beginCapture).toHaveBeenCalledExactlyOnceWith("capture-a");
    expect(resumed.grant?.adoptProcessToken.mock.invocationCallOrder[0]).toBeLessThan(
      resumed.beginCapture.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
    expect(Object.keys(resumed.capability)).not.toEqual(
      expect.arrayContaining(["ownerKey", "transportToken", "captureKey"]),
    );

    resumed.capability.remove(original.session);
    resumed.capability.remove(original.session);
    expect(original.grant?.revokeProcessToken).toHaveBeenCalledOnce();
    expect(resumed.grant?.revokeProcessToken).not.toHaveBeenCalled();
    expect(original.capability.current()).toBeUndefined();
  });

  it.each(["admission", "caller"] as const)(
    "fences MCP capture when %s authority closes during process transfer",
    async (authority) => {
      const original = await createOwner({
        sessionId: "transfer-closed-owner",
        capture: { token: "original-process-token", key: "original-capture" },
      });
      original.register();
      const resumed = await createOwner({
        sessionId: "transfer-closed-owner",
        capture: { token: "replacement-turn-token", key: "replacement-capture" },
      });
      resumed.grant?.adoptProcessToken.mockImplementation(() => {
        if (authority === "caller") {
          resumed.revokeCaller();
        } else {
          resumed.admission.close();
        }
      });

      expect(() => resumed.capability.activate(original.session)).toThrow("no longer active");

      expect(resumed.grant?.adoptProcessToken).toHaveBeenCalledExactlyOnceWith(
        "original-process-token",
      );
      expect(resumed.beginCapture).not.toHaveBeenCalled();
      expect(original.capability.current()).toBe(original.session);
    },
  );

  it.each([
    {
      name: "a captured process cannot resume without an admitted turn grant",
      originalCapture: { token: "captured-process-token", key: "captured-process-key" },
      resumedCapture: undefined,
    },
    {
      name: "an uncaptured process cannot inherit a newly admitted turn grant",
      originalCapture: undefined,
      resumedCapture: { token: "new-turn-token", key: "new-turn-key" },
    },
  ])("$name", async ({ originalCapture, resumedCapture }) => {
    const sessionId = "changed-capture-topology-owner";
    const original = await createOwner({
      sessionId,
      ...(originalCapture ? { capture: originalCapture } : {}),
    });
    original.register();
    const resumed = await createOwner({
      sessionId,
      ...(resumedCapture ? { capture: resumedCapture } : {}),
    });

    expect(() => resumed.capability.activate(original.session)).toThrow("MCP topology changed");
    expect(resumed.beginCapture).not.toHaveBeenCalled();
    if (resumed.grant) {
      expect(resumed.grant.adoptProcessToken).not.toHaveBeenCalled();
    }
    expect(original.capability.current()).toBe(original.session);
  });

  it("keeps claimed native skill resources until subprocess exit and cleans exactly once", async () => {
    const cleanup = vi.fn(async () => {});
    const owner = await createOwner({ deferExit: true, cleanup });
    owner.register();

    const closing = closeCliLiveSession(owner.context, "restart");
    owner.capability.remove(owner.session);
    await Promise.resolve();
    expect(cleanup).not.toHaveBeenCalled();

    owner.exited.resolve();
    await closing;

    expect(owner.close).toHaveBeenCalledWith("restart");
    expect(owner.waitForExit).toHaveBeenCalledOnce();
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it.each([false, true])(
    "retains natural cleanup until replacement is safe (fails=%s)",
    async (fails) => {
      const held = createDeferred();
      const failure = new Error("artifact cleanup failed");
      const cleanup = vi.fn(async () => {
        await held.promise;
        if (fails) {
          throw failure;
        }
      });
      const original = await createOwner({ cleanup });
      original.register();
      original.capability.remove(original.session);
      original.exited.resolve();
      const successor = await createOwner({ sessionId: original.sessionId });
      expect(() => successor.register()).toThrow("cleanup has not settled");
      original.revokeCaller();
      const completed = vi.fn();
      const rejected = vi.fn();
      const closing = closeCliLiveSession(original.context, "restart").then(completed, rejected);
      try {
        await vi.waitFor(() => expect(cleanup).toHaveBeenCalledOnce());
        expect(successor.close).not.toHaveBeenCalled();
        expect(completed).not.toHaveBeenCalled();
        expect(rejected).not.toHaveBeenCalled();
      } finally {
        held.resolve();
        await closing;
      }
      expect(fails ? rejected : completed).toHaveBeenCalledOnce();
      if (fails) {
        expect(rejected).toHaveBeenCalledWith(failure);
        await expect(restartCliLiveSession(successor.context)).rejects.toBe(failure);
        expect(() => successor.register()).toThrow("cleanup has not settled");
      } else {
        successor.register();
        await closeCliLiveSession(original.context, "restart");
        expect(successor.capability.current()).toBe(successor.session);
      }
    },
  );

  it.each([
    "agent-error",
    "agent-and-cleanup-error",
    "cleanup-error",
    "delivered-cleanup-error",
    "stalled",
  ] as const)("retains the natural cleanup result through settlement: %s", async (outcome) => {
    vi.useFakeTimers();
    const held = createDeferred();
    const originalError = new Error("original agent failure");
    const cleanupError = new Error("registered cleanup failure");
    const owner = await createOwner({
      cleanup: async () => {
        if (outcome === "stalled") {
          await held.promise;
        } else if (outcome !== "agent-error") {
          throw cleanupError;
        }
      },
    });
    owner.context.params.oneShotCliRun = true;
    owner.context.params.cleanupCliLiveSessionOnRunEnd = true;
    owner.register();
    owner.capability.remove(owner.session);
    owner.exited.resolve();
    const cleanupScope = createAgentCleanupScope();
    const result = {
      payloads: [{ text: "original delivery" }],
      meta: { durationMs: 1 },
      didSendViaMessagingTool: outcome === "delivered-cleanup-error",
    };
    const run = cleanupScope.run(() =>
      settlePreparedCliRun({
        context: owner.context,
        run: async () => {
          if (outcome === "agent-error" || outcome === "agent-and-cleanup-error") {
            throw originalError;
          }
          return result;
        },
      }),
    );
    let settled = false;
    const observed = run
      .then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      )
      .then((settledOutcome) => {
        settled = true;
        return settledOutcome;
      });
    try {
      if (outcome === "stalled") {
        await vi.advanceTimersByTimeAsync(9999);
        expect(settled).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
      }
      expect(await observed).toEqual(
        outcome === "agent-error" || outcome === "agent-and-cleanup-error"
          ? { error: originalError }
          : outcome === "cleanup-error"
            ? { error: cleanupError }
            : { value: result },
      );
      expect(cleanupScope.outcome).toBe(outcome === "agent-error" ? "closed" : "uncertain");
    } finally {
      held.resolve();
      vi.useRealTimers();
    }
  });

  it("does not let a previous turn close a process activated by its successor", async () => {
    const original = await createOwner({ sessionId: "transferred-close" });
    original.register();
    const successor = await createOwner({ sessionId: "transferred-close" });
    successor.capability.activate(original.session);
    await closeCliLiveSession(original.context, "restart");
    expect(original.close).not.toHaveBeenCalled();
    await closeCliLiveSession(successor.context, "restart");
    expect(original.close).toHaveBeenCalledOnce();
  });

  it("evicts an idle owner at capacity and fails closed when every owner is active", async () => {
    const owners = [];
    for (let index = 0; index < 16; index += 1) {
      const owner = await createOwner({ idle: index === 0 });
      owner.register();
      owners.push(owner);
    }

    const replacement = await createOwner();
    expect(() => replacement.register()).not.toThrow();
    expect(owners[0]?.close).toHaveBeenCalledWith("idle");

    const overflow = await createOwner();
    expect(() => overflow.register()).toThrow("Too many CLI live sessions are active.");
  });

  it("admits only local plugin-owned structured execution to reusable sessions", () => {
    const eligible = buildPreparedCliRunContext({ backend: { liveSession: "claude-stdio" } });
    eligible.executionTarget = {
      kind: "plugin",
      async *execute() {
        yield { type: "result" };
      },
    };

    expect(acceptsCliLiveSession(eligible)).toBe(true);

    const node = buildPreparedCliRunContext({
      backend: { liveSession: "claude-stdio" },
      sessionEntry: {
        sessionId: "node-session",
        updatedAt: 1,
        execHost: "node",
        execNode: "node-test",
      },
    });
    expect(acceptsCliLiveSession(node)).toBe(false);

    eligible.executionTarget = { kind: "process" };
    expect(acceptsCliLiveSession(eligible)).toBe(false);
  });
});
