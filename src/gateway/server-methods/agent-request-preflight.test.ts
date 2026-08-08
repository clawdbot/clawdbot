import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { attachReservedSubagentClaimToken } from "../../agents/reserved-subagent-admission.js";
import { subagentRuns } from "../../agents/subagent-registry-memory.js";
import * as sessionAccessor from "../../config/sessions/session-accessor.js";
import { DEDUPE_TTL_MS } from "../server-constants.js";
import { createAgentAdmissionController } from "./agent-admission-controller.js";
import { createAgentDedupeLifecycle } from "./agent-dedupe-lifecycle.js";
import { reserveReservedSubagentDedupeEntry, setGatewayDedupeEntries } from "./agent-dedupe.js";
import { prepareAgentRequestPreflight } from "./agent-request-preflight.js";

function runPreflight(
  swarmOutputSchema?: Record<string, unknown>,
  swarmCollector = true,
  options?: {
    enabled?: boolean;
    requesterOnlyEnabled?: boolean;
    backend?: boolean;
    register?: boolean;
    requesterAgentId?: string;
    requesterSessionKey?: string;
    idempotencyKey?: string;
    includeCollectorFields?: boolean;
    launchPending?: boolean;
    cached?: boolean;
    completed?: boolean;
    ended?: boolean;
  },
) {
  const sessionKey = "agent:worker:subagent:collector";
  if (options?.register) {
    subagentRuns.set("collector-run", {
      runId: "collector-run",
      childSessionKey: sessionKey,
      requesterSessionKey: options.requesterSessionKey ?? "agent:main:main",
      requesterDisplayKey: "main",
      requesterAgentId: options.requesterAgentId,
      task: "collect",
      cleanup: "keep",
      createdAt: 1,
      collect: true,
      outputSchema: swarmOutputSchema,
      swarmLaunchIdempotencyKey: "collector-run",
      swarmLaunchPending: options?.launchPending ?? true,
      execution: {
        status: options?.ended
          ? "terminal"
          : options?.launchPending === false
            ? "running"
            : "queued",
        endedAt: options?.ended ? 2 : undefined,
      },
      collectorCompletion: options?.completed ? { status: "done" } : undefined,
    });
  }
  const respond = vi.fn();
  const result = prepareAgentRequestPreflight({
    params: {
      message: "collect",
      sessionKey,
      idempotencyKey: options?.idempotencyKey ?? "collector-run",
      lane: "subagent",
      ...(options?.includeCollectorFields === false ? {} : { swarmCollector, swarmOutputSchema }),
    },
    respond,
    context: {
      getRuntimeConfig: () =>
        options?.requesterOnlyEnabled
          ? {
              agents: {
                list: [{ id: "main", tools: { swarm: true } }, { id: "worker" }],
              },
            }
          : options?.enabled
            ? { tools: { swarm: true } }
            : {},
      dedupe: options?.cached
        ? new Map([
            [
              "agent:collector-run",
              {
                ts: 1,
                ok: true,
                payload: { status: "accepted", runId: "gateway-run", sessionKey },
              },
            ],
          ])
        : new Map(),
    },
    client: options?.backend
      ? { connect: { client: { mode: "backend" }, scopes: ["operator.write"] } }
      : undefined,
  } as never);
  return { respond, result };
}

describe("agent request Swarm preflight", () => {
  beforeEach(() => {
    subagentRuns.clear();
    vi.spyOn(sessionAccessor, "loadSessionEntry").mockReturnValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("rejects malformed and non-object structured output schemas", () => {
    for (const schema of [
      { type: "array", items: { type: "string" } },
      { type: "object", properties: "invalid" },
    ]) {
      const { respond, result } = runPreflight(schema);
      expect(result).toBeUndefined();
      expect(respond).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({ code: "INVALID_REQUEST" }),
      );
    }
  });

  it("rejects a structured schema outside collector mode", () => {
    const { respond, result } = runPreflight({ type: "object" }, false);
    expect(result).toBeUndefined();
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        message: "active swarm collector sessions require swarmCollector=true",
      }),
    );
  });

  it("rejects collector flags while Swarm is disabled", () => {
    const { respond, result } = runPreflight(undefined, true, {
      backend: true,
      register: true,
    });

    expect(result).toBeUndefined();
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        message: "swarm collector fields require an enabled, host-registered collector run",
      }),
    );
  });

  it("rejects unregistered or non-backend collector requests", () => {
    const schema = { type: "object" };
    for (const options of [
      { enabled: true, backend: true, register: false },
      { enabled: true, backend: false, register: true },
    ]) {
      const { respond, result } = runPreflight(schema, true, options);
      expect(result).toBeUndefined();
      expect(respond).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({ code: "INVALID_REQUEST" }),
      );
      subagentRuns.clear();
    }
  });

  it("accepts an enabled backend request for a registered collector", () => {
    const { respond, result } = runPreflight({ type: "object" }, true, {
      enabled: true,
      backend: true,
      register: true,
    });

    expect(result).toBeDefined();
    expect(respond).not.toHaveBeenCalled();
  });

  it("rejects ordinary turns and mismatched launch identities for an active collector", () => {
    for (const options of [
      { includeCollectorFields: false },
      { idempotencyKey: "different-launch" },
    ]) {
      const { respond, result } = runPreflight({ type: "object" }, true, {
        enabled: true,
        backend: true,
        register: true,
        ...options,
      });

      expect(result).toBeUndefined();
      expect(respond).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({ code: "INVALID_REQUEST" }),
      );
      subagentRuns.clear();
    }
  });

  it("keeps a retained collector session reserved from its persisted marker", () => {
    vi.mocked(sessionAccessor.loadSessionEntry).mockReturnValue({
      sessionId: "collector-session",
      updatedAt: 1,
      swarmCollector: true,
    });
    const { respond, result } = runPreflight({ type: "object" }, true, {
      enabled: true,
      backend: true,
      includeCollectorFields: false,
    });
    expect(result).toBeUndefined();
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "INVALID_REQUEST" }),
    );
  });

  it("keeps a provisionally ended collector session reserved until completion", () => {
    const run = subagentRuns.get("collector-run");
    expect(run).toBeUndefined();
    const { respond, result } = runPreflight({ type: "object" }, true, {
      enabled: true,
      backend: true,
      register: true,
      includeCollectorFields: false,
    });
    const registered = subagentRuns.get("collector-run");
    if (!registered) {
      throw new Error("expected collector registration");
    }
    registered.execution = { ...registered.execution, status: "terminal", endedAt: 2 };

    const retry = runPreflight({ type: "object" }, true, {
      enabled: true,
      backend: true,
      includeCollectorFields: false,
    });
    expect(result).toBeUndefined();
    expect(respond).toHaveBeenCalled();
    expect(retry.result).toBeUndefined();
    expect(retry.respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "INVALID_REQUEST" }),
    );
  });

  it("allows an accepted collector launch identity to replay only from Gateway dedupe", () => {
    const rejected = runPreflight({ type: "object" }, true, {
      enabled: true,
      backend: true,
      register: true,
      launchPending: false,
    });
    expect(rejected.result).toBeUndefined();
    expect(rejected.respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "INVALID_REQUEST" }),
    );

    subagentRuns.clear();
    const replayed = runPreflight({ type: "object" }, true, {
      enabled: true,
      backend: true,
      register: true,
      launchPending: false,
      cached: true,
    });
    expect(replayed.result).toBeUndefined();
    expect(replayed.respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ runId: "gateway-run", status: "in_flight" }),
      undefined,
      expect.objectContaining({ cached: true, runId: "gateway-run" }),
    );
  });

  it("allows an exact cached collector replay after Swarm is disabled", () => {
    const replayed = runPreflight({ type: "object" }, true, {
      backend: true,
      register: true,
      launchPending: false,
      cached: true,
    });
    expect(replayed.result).toBeUndefined();
    expect(replayed.respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ runId: "gateway-run", status: "in_flight" }),
      undefined,
      expect.objectContaining({ cached: true, runId: "gateway-run" }),
    );
  });

  it("rejects a terminal collector even when its pending launch flag remains set", () => {
    const { respond, result } = runPreflight({ type: "object" }, true, {
      enabled: true,
      backend: true,
      register: true,
      ended: true,
    });
    expect(result).toBeUndefined();
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "INVALID_REQUEST" }),
    );
  });

  it("keeps completed collector sessions closed while allowing their exact cached replay", () => {
    const ordinary = runPreflight({ type: "object" }, true, {
      enabled: true,
      backend: true,
      register: true,
      includeCollectorFields: false,
      launchPending: false,
      completed: true,
    });
    expect(ordinary.result).toBeUndefined();
    expect(ordinary.respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "INVALID_REQUEST" }),
    );

    subagentRuns.clear();
    const replayed = runPreflight({ type: "object" }, true, {
      enabled: true,
      backend: true,
      register: true,
      launchPending: false,
      completed: true,
      cached: true,
    });
    expect(replayed.result).toBeUndefined();
    expect(replayed.respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ runId: "gateway-run", status: "in_flight" }),
      undefined,
      expect.objectContaining({ cached: true, runId: "gateway-run" }),
    );
  });

  it("uses the registered requester per-agent gate for a cross-agent collector", () => {
    const { respond, result } = runPreflight({ type: "object" }, true, {
      requesterOnlyEnabled: true,
      backend: true,
      register: true,
    });

    expect(result).toBeDefined();
    expect(respond).not.toHaveBeenCalled();
  });

  it("uses the effective requester override when its session key names another agent", () => {
    const { respond, result } = runPreflight({ type: "object" }, true, {
      requesterOnlyEnabled: true,
      backend: true,
      register: true,
      requesterAgentId: "main",
      requesterSessionKey: "agent:cron:main",
    });

    expect(result).toBeDefined();
    expect(respond).not.toHaveBeenCalled();
  });
});

describe("reserved subagent admission TTL", () => {
  beforeEach(() => {
    vi.spyOn(sessionAccessor, "loadSessionEntry").mockReturnValue({
      sessionId: "reserved-session",
      updatedAt: 1,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("rejects an expired active reservation instead of replaying an in-flight child run", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-01T00:00:00Z"));
    const dedupe = new Map();
    const claimToken = "reserved-claim-token";
    const release = reserveReservedSubagentDedupeEntry({
      dedupe,
      runId: "reserved-expired-run",
      sessionKey: "agent:worker:subagent:reserved-expired-child",
      pluginRuntimeOwnerId: "agentic-os",
      claimToken,
    });
    vi.advanceTimersByTime(DEDUPE_TTL_MS + 1);

    const respond = vi.fn();
    const request = attachReservedSubagentClaimToken(
      {
        message: "run reserved child",
        sessionKey: "agent:worker:subagent:reserved-expired-child",
        idempotencyKey: "reserved-expired-run",
      },
      claimToken,
    ) as Record<string | symbol, unknown>;
    const result = prepareAgentRequestPreflight({
      params: request,
      respond,
      context: {
        getRuntimeConfig: () => ({}),
        dedupe,
      },
      client: {
        internal: { pluginRuntimeOwnerId: "agentic-os" },
      },
    } as never);

    expect(result).toBeUndefined();
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        message: "agent runId is reserved for a different plugin subagent admission.",
      }),
    );
    release();
  });

  it("fails closed when a reserved admission expires before final admission", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-01T00:00:00Z"));
    const dedupe = new Map();
    const claimToken = "reserved-final-claim-token";
    const release = reserveReservedSubagentDedupeEntry({
      dedupe,
      runId: "reserved-final-expired-run",
      sessionKey: "agent:worker:subagent:reserved-final-expired-child",
      pluginRuntimeOwnerId: "agentic-os",
      claimToken,
    });
    vi.advanceTimersByTime(DEDUPE_TTL_MS + 1);

    const respond = vi.fn();
    const markAccepted = vi.fn();
    const controller = createAgentAdmissionController({
      cfg: {},
      runId: "reserved-final-expired-run",
      lifecycleGeneration: "generation",
      agentDedupeKeys: ["agent:reserved-final-expired-run"],
      preAcceptedReservedSessionKey: "agent:worker:subagent:reserved-final-expired-child",
      context: { dedupe } as never,
      respond,
      dedupeLifecycle: {
        isReserved: () => true,
        reservationId: claimToken,
        markAccepted,
        abortForLifecycleRotation: vi.fn(() => false),
      } as never,
      getRequestedSessionKey: () => "agent:worker:subagent:reserved-final-expired-child",
      getResolvedSessionKey: () => "agent:worker:subagent:reserved-final-expired-child",
      getResolvedSessionId: () => "reserved-session",
      getResolvedSessionAgentId: () => "worker",
      getAgentId: () => "worker",
      getCfgForAgent: () => ({}),
      getSessionPersisted: () => false,
      getSupersededSessionId: () => undefined,
      setAdmittedSessionId: vi.fn(),
    });

    controller.assertAllowed();
    expect(controller.respondToOutcome()).toBe(true);
    expect(markAccepted).toHaveBeenCalledWith(true);
    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        runId: "reserved-final-expired-run",
        status: "timeout",
        providerStarted: false,
      }),
      undefined,
      expect.objectContaining({ cached: true, runId: "reserved-final-expired-run" }),
    );
    release();
  });

  it("adopts a real expired reservation so final admission times out instead of in-flight", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-01T00:00:00Z"));
    const dedupe = new Map();
    const claimToken = "reserved-real-final-claim-token";
    const runId = "reserved-real-final-expired-run";
    const sessionKey = "agent:worker:subagent:reserved-real-final-expired-child";
    const release = reserveReservedSubagentDedupeEntry({
      dedupe,
      runId,
      sessionKey,
      pluginRuntimeOwnerId: "agentic-os",
      claimToken,
    });
    vi.advanceTimersByTime(DEDUPE_TTL_MS + 1);

    const respond = vi.fn();
    const request = attachReservedSubagentClaimToken(
      {
        message: "run expired reserved child",
        sessionKey,
        idempotencyKey: runId,
      },
      claimToken,
    );
    const dedupeLifecycle = createAgentDedupeLifecycle({
      cfg: {},
      request,
      runId,
      lifecycleGeneration: "generation",
      agentDedupeKeys: [`agent:${runId}`],
      suppressVisibleSessionEffects: false,
      context: { dedupe } as never,
      client: { internal: { pluginRuntimeOwnerId: "agentic-os" } },
      respond,
    } as never);

    dedupeLifecycle.reserve(sessionKey);
    expect(dedupeLifecycle.reservationId).toBe(claimToken);

    const controller = createAgentAdmissionController({
      cfg: {},
      runId,
      lifecycleGeneration: "generation",
      agentDedupeKeys: [`agent:${runId}`],
      preAcceptedReservedSessionKey: sessionKey,
      context: { dedupe } as never,
      respond,
      dedupeLifecycle,
      getRequestedSessionKey: () => sessionKey,
      getResolvedSessionKey: () => sessionKey,
      getResolvedSessionId: () => "reserved-session",
      getResolvedSessionAgentId: () => "worker",
      getAgentId: () => "worker",
      getCfgForAgent: () => ({}),
      getSessionPersisted: () => false,
      getSupersededSessionId: () => undefined,
      setAdmittedSessionId: vi.fn(),
    });

    controller.assertAllowed();
    expect(controller.respondToOutcome()).toBe(true);
    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        runId,
        status: "timeout",
        providerStarted: false,
      }),
      undefined,
      expect.objectContaining({ cached: true, runId }),
    );
    expect(respond).not.toHaveBeenCalledWith(
      true,
      { runId, status: "in_flight" },
      undefined,
      expect.anything(),
    );
    release();
  });
});

describe("reserved subagent Gateway admission", () => {
  const runId = "plugin-reserved-run";
  const sessionKey = "agent:worker:subagent:plugin-reserved-child";
  const pluginRuntimeOwnerId = "agentic-os";
  const claimToken = "reserved-claim-token";

  function createContext() {
    return {
      dedupe: new Map(),
      getRuntimeConfig: () => ({}),
    };
  }

  function createRequest() {
    return {
      message: "run reserved child",
      sessionKey,
      idempotencyKey: runId,
      lane: "subagent",
    };
  }

  it("admits only the exact internal owner and claim token", () => {
    const context = createContext();
    const release = reserveReservedSubagentDedupeEntry({
      dedupe: context.dedupe,
      runId,
      sessionKey,
      pluginRuntimeOwnerId,
      claimToken,
    });
    const exactRespond = vi.fn();
    const exactRequest = attachReservedSubagentClaimToken(createRequest(), claimToken);
    const exactClient = {
      internal: {
        pluginRuntimeOwnerId,
      },
    };
    const exact = prepareAgentRequestPreflight({
      params: exactRequest,
      respond: exactRespond,
      context,
      client: exactClient,
    } as never);
    expect(exact).toBeDefined();
    expect(exactRespond).not.toHaveBeenCalled();
    const exactLifecycle = createAgentDedupeLifecycle({
      cfg: {},
      request: exactRequest,
      runId,
      lifecycleGeneration: exact!.lifecycleGeneration,
      agentDedupeKeys: exact!.agentDedupeKeys,
      suppressVisibleSessionEffects: false,
      context,
      client: exactClient,
      respond: exactRespond,
    } as never);
    exactLifecycle.reserve(sessionKey);
    expect(exactLifecycle.reservationId).toBe(claimToken);

    for (const candidate of [
      { params: createRequest(), internal: undefined },
      {
        params: attachReservedSubagentClaimToken(createRequest(), "wrong-token"),
        internal: { pluginRuntimeOwnerId },
      },
      {
        params: attachReservedSubagentClaimToken(createRequest(), claimToken),
        internal: { pluginRuntimeOwnerId: "other-plugin" },
      },
    ]) {
      const respond = vi.fn();
      const result = prepareAgentRequestPreflight({
        params: candidate.params,
        respond,
        context,
        client: candidate.internal ? { internal: candidate.internal } : undefined,
      } as never);
      expect(result).toBeUndefined();
      expect(respond).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({
          message: "agent runId is reserved for a different plugin subagent admission.",
        }),
      );
    }
    release();
  });

  it.each([
    { name: "missing", expire: false },
    { name: "expired", expire: true },
  ])("rejects a reserved token when its Gateway marker is $name", ({ expire }) => {
    const context = createContext();
    if (expire) {
      const release = reserveReservedSubagentDedupeEntry({
        dedupe: context.dedupe,
        runId,
        sessionKey,
        pluginRuntimeOwnerId,
        claimToken,
      });
      const entry = context.dedupe.get(`agent:${runId}`);
      expect(entry?.payload).toBeDefined();
      release();
      context.dedupe.set(`agent:${runId}`, entry!);
      (entry!.payload as { expiresAtMs: number }).expiresAtMs = Date.now() - 1;
    }
    const respond = vi.fn();
    const result = prepareAgentRequestPreflight({
      params: attachReservedSubagentClaimToken(createRequest(), claimToken),
      respond,
      context,
      client: { internal: { pluginRuntimeOwnerId } },
    } as never);
    expect(result).toBeUndefined();
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        message: "agent runId is reserved for a different plugin subagent admission.",
      }),
    );
  });

  it("rejects an active reserved marker after its ttl expires", () => {
    const context = createContext();
    const release = reserveReservedSubagentDedupeEntry({
      dedupe: context.dedupe,
      runId,
      sessionKey,
      pluginRuntimeOwnerId,
      claimToken,
    });
    const entry = context.dedupe.get(`agent:${runId}`);
    expect(entry?.payload).toBeDefined();
    (entry!.payload as { expiresAtMs: number }).expiresAtMs = Date.now() - 1;

    const respond = vi.fn();
    const result = prepareAgentRequestPreflight({
      params: attachReservedSubagentClaimToken(createRequest(), claimToken),
      respond,
      context,
      client: { internal: { pluginRuntimeOwnerId } },
    } as never);

    expect(result).toBeUndefined();
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        message: "agent runId is reserved for a different plugin subagent admission.",
      }),
    );
    release();
  });

  it("blocks an ordinary admission that passed preflight before the reserved claim", () => {
    const context = createContext();
    const ordinaryClient = undefined;
    const ordinaryRespond = vi.fn();
    const preflight = prepareAgentRequestPreflight({
      params: createRequest(),
      respond: ordinaryRespond,
      context,
      client: ordinaryClient,
    } as never);
    expect(preflight).toBeDefined();

    const release = reserveReservedSubagentDedupeEntry({
      dedupe: context.dedupe,
      runId,
      sessionKey,
      pluginRuntimeOwnerId,
      claimToken,
    });
    const reservedEntry = context.dedupe.get(`agent:${runId}`);
    const dedupeLifecycle = createAgentDedupeLifecycle({
      cfg: {},
      request: createRequest(),
      runId,
      lifecycleGeneration: preflight!.lifecycleGeneration,
      agentDedupeKeys: preflight!.agentDedupeKeys,
      suppressVisibleSessionEffects: false,
      context,
      client: ordinaryClient,
      respond: ordinaryRespond,
    } as never);
    dedupeLifecycle.reserve(sessionKey);
    expect(context.dedupe.get(`agent:${runId}`)).toBe(reservedEntry);

    const controller = createAgentAdmissionController({
      cfg: {},
      runId,
      lifecycleGeneration: preflight!.lifecycleGeneration,
      agentDedupeKeys: preflight!.agentDedupeKeys,
      context,
      respond: ordinaryRespond,
      dedupeLifecycle,
      getRequestedSessionKey: () => sessionKey,
      getResolvedSessionKey: () => sessionKey,
      getResolvedSessionId: () => "ordinary-session",
      getResolvedSessionAgentId: () => "worker",
      getAgentId: () => "worker",
      getCfgForAgent: () => undefined,
      getSessionPersisted: () => false,
      getSupersededSessionId: () => undefined,
      setAdmittedSessionId: () => {},
    } as never);
    controller.assertAllowed();
    expect(controller.respondToOutcome()).toBe(true);
    expect(context.dedupe.get(`agent:${runId}`)).toBe(reservedEntry);
    expect(ordinaryRespond).toHaveBeenLastCalledWith(
      true,
      { runId, status: "in_flight" },
      undefined,
      expect.objectContaining({ cached: true, runId }),
    );
    release();
  });

  it("does not overwrite the accepted result after the reserved marker is adopted", () => {
    const context = createContext();
    const ordinaryRespond = vi.fn();
    const ordinaryRequest = createRequest();
    const preflight = prepareAgentRequestPreflight({
      params: ordinaryRequest,
      respond: ordinaryRespond,
      context,
      client: undefined,
    } as never);
    expect(preflight).toBeDefined();

    reserveReservedSubagentDedupeEntry({
      dedupe: context.dedupe,
      runId,
      sessionKey,
      pluginRuntimeOwnerId,
      claimToken,
    });
    const acceptedEntry = {
      ts: Date.now(),
      ok: true,
      payload: {
        runId,
        sessionKey,
        status: "accepted" as const,
        acceptedAt: Date.now(),
      },
    };
    setGatewayDedupeEntries({
      dedupe: context.dedupe,
      keys: preflight!.agentDedupeKeys,
      entry: acceptedEntry,
    });

    const dedupeLifecycle = createAgentDedupeLifecycle({
      cfg: {},
      request: ordinaryRequest,
      runId,
      lifecycleGeneration: preflight!.lifecycleGeneration,
      agentDedupeKeys: preflight!.agentDedupeKeys,
      suppressVisibleSessionEffects: false,
      context,
      client: undefined,
      respond: ordinaryRespond,
    } as never);
    dedupeLifecycle.reserve(sessionKey);
    expect(context.dedupe.get(`agent:${runId}`)).toBe(acceptedEntry);

    const controller = createAgentAdmissionController({
      cfg: {},
      runId,
      lifecycleGeneration: preflight!.lifecycleGeneration,
      agentDedupeKeys: preflight!.agentDedupeKeys,
      context,
      respond: ordinaryRespond,
      dedupeLifecycle,
      getRequestedSessionKey: () => sessionKey,
      getResolvedSessionKey: () => sessionKey,
      getResolvedSessionId: () => "ordinary-session",
      getResolvedSessionAgentId: () => "worker",
      getAgentId: () => "worker",
      getCfgForAgent: () => undefined,
      getSessionPersisted: () => false,
      getSupersededSessionId: () => undefined,
      setAdmittedSessionId: () => {},
    } as never);
    controller.assertAllowed();
    expect(controller.respondToOutcome()).toBe(true);
    expect(context.dedupe.get(`agent:${runId}`)).toBe(acceptedEntry);
    expect(ordinaryRespond).toHaveBeenLastCalledWith(
      true,
      { runId, status: "in_flight" },
      undefined,
      expect.objectContaining({ cached: true, runId }),
    );
  });

  it("preserves a replacement entry when clearing an unaccepted adopted reservation", () => {
    const context = createContext();
    const release = reserveReservedSubagentDedupeEntry({
      dedupe: context.dedupe,
      runId,
      sessionKey,
      pluginRuntimeOwnerId,
      claimToken,
    });
    const request = attachReservedSubagentClaimToken(createRequest(), claimToken);
    const lifecycle = createAgentDedupeLifecycle({
      cfg: {},
      request,
      runId,
      lifecycleGeneration: "generation",
      agentDedupeKeys: [`agent:${runId}`],
      suppressVisibleSessionEffects: false,
      context,
      client: { internal: { pluginRuntimeOwnerId } },
      respond: vi.fn(),
    } as never);
    lifecycle.reserve(sessionKey);

    const replacement = {
      ts: Date.now(),
      ok: false,
      payload: { runId, status: "error", summary: "replacement failed" },
    };
    context.dedupe.set(`agent:${runId}`, replacement);

    lifecycle.clearUnaccepted();

    expect(context.dedupe.get(`agent:${runId}`)).toBe(replacement);
    release();
  });
});

describe("agent request restart recovery preflight", () => {
  function runRestartRecoveryPreflight(
    backend: boolean,
    sourceTool: string,
    internalExecutionIdentityRetry?: boolean,
  ) {
    const respond = vi.fn();
    const result = prepareAgentRequestPreflight({
      params: {
        message: "continue",
        idempotencyKey: "restart-recovery-run",
        forceRestartSafeTools: true,
        forceCodeModeTools: true,
        ...(internalExecutionIdentityRetry !== undefined ? { internalExecutionIdentityRetry } : {}),
        inputProvenance: {
          kind: "internal_system",
          sourceSessionKey: "agent:main:main",
          sourceTool,
        },
      },
      respond,
      context: {
        getRuntimeConfig: () => ({}),
        dedupe: new Map(),
      },
      client: backend
        ? { connect: { client: { mode: "backend" }, scopes: ["operator.write"] } }
        : undefined,
    } as never);
    return { respond, result };
  }

  it("accepts the Code Mode override only for backend restart recovery", () => {
    const accepted = runRestartRecoveryPreflight(true, "main_session_restart_recovery", true);

    expect(accepted.result).toBeDefined();
    expect(accepted.respond).not.toHaveBeenCalled();
  });

  it("rejects private execution retry mode outside backend restart recovery", () => {
    const rejected = runRestartRecoveryPreflight(false, "main_session_restart_recovery", true);

    expect(rejected.result).toBeUndefined();
    expect(rejected.respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: "INVALID_REQUEST",
        message: expect.stringContaining("execution identity retry mode"),
      }),
    );
  });

  it.each([
    { backend: false, sourceTool: "main_session_restart_recovery" },
    { backend: true, sourceTool: "other_internal_source" },
  ])("rejects an untrusted Code Mode override", ({ backend, sourceTool }) => {
    const rejected = runRestartRecoveryPreflight(backend, sourceTool);

    expect(rejected.result).toBeUndefined();
    expect(rejected.respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: "INVALID_REQUEST",
        message: "forceCodeModeTools is reserved for main-session restart recovery.",
      }),
    );
  });
});
