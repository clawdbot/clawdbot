import { beforeEach, describe, expect, it, vi } from "vitest";
import { subagentRuns } from "../../agents/subagents/registry/subagent-registry-memory.js";
import * as sessionAccessor from "../../config/sessions/session-accessor.js";
import { prepareAgentRequestPreflight } from "./agent-request-preflight.js";
import { createAgentTurnService } from "./agent-turn-service.js";
import { createAgentTurnIo } from "./io.js";

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
  const context = {
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
  };
  const client = options?.backend
    ? { connect: { client: { mode: "backend" }, scopes: ["operator.write"] } }
    : undefined;
  const io = createAgentTurnIo(respond);
  const result = prepareAgentRequestPreflight({
    request: {
      message: "collect",
      sessionKey,
      idempotencyKey: options?.idempotencyKey ?? "collector-run",
      lane: "subagent",
      ...(options?.includeCollectorFields === false ? {} : { swarmCollector, swarmOutputSchema }),
    },
    io,
    context,
    client,
  } as never);
  const replay = async () => {
    if (!result) {
      return;
    }
    await createAgentTurnService({ context, isWebchatConnect: () => false } as never).startTurn({
      preflight: result,
      principal: client ?? null,
      io,
    } as never);
  };
  return { respond, result, replay };
}

describe("agent request Swarm preflight", () => {
  beforeEach(() => {
    subagentRuns.clear();
    vi.spyOn(sessionAccessor, "loadSessionEntry").mockReturnValue(undefined);
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

  it("allows an accepted collector launch identity to replay only from Gateway dedupe", async () => {
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
    expect(replayed.result).toBeDefined();
    await replayed.replay();
    expect(replayed.respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ runId: "gateway-run", status: "in_flight" }),
      undefined,
      expect.objectContaining({ cached: true, runId: "gateway-run" }),
    );
  });

  it("allows an exact cached collector replay after Swarm is disabled", async () => {
    const replayed = runPreflight({ type: "object" }, true, {
      backend: true,
      register: true,
      launchPending: false,
      cached: true,
    });
    expect(replayed.result).toBeDefined();
    await replayed.replay();
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

  it("keeps completed collector sessions closed while allowing their exact cached replay", async () => {
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
    expect(replayed.result).toBeDefined();
    await replayed.replay();
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

describe("agent request restart recovery preflight", () => {
  function runRestartRecoveryPreflight(
    backend: boolean,
    sourceTool: string,
    internalExecutionIdentityRetry?: boolean,
    internalExecutionIdentityRecoveryAttempt?: number,
  ) {
    const respond = vi.fn();
    const result = prepareAgentRequestPreflight({
      request: {
        message: "continue",
        idempotencyKey: "restart-recovery-run",
        forceRestartSafeTools: true,
        forceCodeModeTools: true,
        ...(internalExecutionIdentityRetry !== undefined ? { internalExecutionIdentityRetry } : {}),
        ...(internalExecutionIdentityRecoveryAttempt !== undefined
          ? { internalExecutionIdentityRecoveryAttempt }
          : {}),
        inputProvenance: {
          kind: "internal_system",
          sourceSessionKey: "agent:main:main",
          sourceTool,
        },
      },
      io: createAgentTurnIo(respond),
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
    const accepted = runRestartRecoveryPreflight(true, "main_session_restart_recovery", true, 1);

    expect(accepted.result).toBeDefined();
    expect(accepted.respond).not.toHaveBeenCalled();
  });

  it("rejects private execution retry mode outside backend restart recovery", () => {
    const rejected = runRestartRecoveryPreflight(false, "main_session_restart_recovery", true, 1);

    expect(rejected.result).toBeUndefined();
    expect(rejected.respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: "INVALID_REQUEST",
        message: expect.stringContaining("execution identity recovery fields"),
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

describe("agent request session ownership preflight", () => {
  function runBareSessionPreflight(owner?: string) {
    const respond = vi.fn();
    const result = prepareAgentRequestPreflight({
      request: {
        message: "continue",
        sessionKey: "global",
        idempotencyKey: "bare-session-run",
      },
      io: createAgentTurnIo(respond),
      context: {
        getRuntimeConfig: () => ({
          session: { store: "/tmp/shared.sqlite" },
          agents: {
            ownership: "explicit",
            defaults: owner ? { sessionStore: { agentId: owner } } : undefined,
            entries: { ops: {}, research: {} },
          },
        }),
        dedupe: new Map(),
      },
      client: null,
    } as never);
    return { respond, result };
  }

  it("admits a bare key owned by the configured fixed store", () => {
    const { respond, result } = runBareSessionPreflight("ops");

    expect(result).toBeDefined();
    expect(respond).not.toHaveBeenCalled();
  });

  it("rejects an ownerless bare key with a typed selection error", () => {
    const { respond, result } = runBareSessionPreflight();

    expect(result).toBeUndefined();
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: "INVALID_REQUEST",
        message: expect.stringContaining("has no explicit owner"),
      }),
    );
  });
});
