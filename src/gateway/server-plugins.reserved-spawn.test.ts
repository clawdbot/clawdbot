// Gateway plugin reserved-spawn tests lock the narrow Plugin SDK to core seam.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  withPluginRuntimeGatewayRequestScope,
  withPluginRuntimePluginIdScope,
} from "../plugins/runtime/gateway-request-scope.js";
import type { GatewayRequestContext } from "./server-methods/types.js";

const spawnSubagentDirect = vi.hoisted(() => vi.fn());
const cleanupProvisionalSession = vi.hoisted(() => vi.fn());
const getAgentRunContext = vi.hoisted(() => vi.fn());
const hasSubagentRunIdentity = vi.hoisted(() => vi.fn());
const getLatestSubagentRunByChildSessionKey = vi.hoisted(() => vi.fn());
const loadSessionEntryReadOnly = vi.hoisted(() => vi.fn());

vi.mock("../agents/subagent-spawn.js", () => ({
  spawnSubagentDirect,
}));
vi.mock("../agents/subagent-spawn-cleanup.js", () => ({
  cleanupProvisionalSession,
}));
vi.mock("../agents/subagent-registry.js", () => ({
  getLatestSubagentRunByChildSessionKey,
  hasSubagentRunIdentity,
}));
vi.mock("../infra/agent-events.js", () => ({
  getAgentRunContext,
  onAgentEvent: vi.fn(),
}));
vi.mock("./session-utils-store.js", () => ({
  loadSessionEntryReadOnly,
}));

import { createGatewaySubagentRuntime } from "./server-plugins.js";

type RequesterOwnershipEvidence = {
  ownerPluginId: string;
  sessionKey: string;
  sessionId?: string;
  lifecycleRevision?: string;
  createdAt?: number;
};

const reservation = {
  requesterSessionKey: "agent:main:main",
  targetAgentId: "worker",
  childSessionKey: "agent:worker:subagent:plugin-reserved-child",
  runId: "plugin-reserved-run",
  task: "run the reserved child",
} as const;

function withReservedPluginScope<T>(
  run: () => T,
  dedupe: GatewayRequestContext["dedupe"] = new Map(),
  requesterOwnership?: RequesterOwnershipEvidence,
): T {
  return withPluginRuntimeGatewayRequestScope(
    {
      context: { dedupe } as GatewayRequestContext,
      isWebchatConnect: () => false,
      ...(requesterOwnership ? { reservedSubagentRequesterOwnership: requesterOwnership } : {}),
    },
    () => withPluginRuntimePluginIdScope("agentic-os", run),
  );
}

describe("createGatewaySubagentRuntime.spawnReserved", () => {
  beforeEach(() => {
    spawnSubagentDirect.mockReset();
    cleanupProvisionalSession.mockReset().mockResolvedValue(false);
    getAgentRunContext.mockReset().mockReturnValue(undefined);
    hasSubagentRunIdentity.mockReset().mockReturnValue(false);
    getLatestSubagentRunByChildSessionKey.mockReset().mockReturnValue(undefined);
    loadSessionEntryReadOnly.mockReset().mockReturnValue({
      cfg: {
        agents: {
          defaults: { subagents: { allowAgents: ["worker"] } },
          entries: { main: {}, worker: {} },
        },
      },
      entry: {
        pluginOwnerId: "agentic-os",
        sessionId: "requester-session",
        lifecycleRevision: "1",
        createdAt: 1,
      },
    });
    spawnSubagentDirect.mockResolvedValue({
      status: "accepted",
      childSessionKey: reservation.childSessionKey,
      runId: reservation.runId,
      mode: "run",
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  it("requires an active plugin scope", async () => {
    await expect(createGatewaySubagentRuntime().spawnReserved(reservation)).rejects.toThrow(
      "requires an active plugin runtime scope",
    );
    expect(spawnSubagentDirect).not.toHaveBeenCalled();
  });

  it("requires a live Gateway context", async () => {
    await expect(
      withPluginRuntimePluginIdScope("agentic-os", () =>
        createGatewaySubagentRuntime().spawnReserved(reservation),
      ),
    ).rejects.toThrow("requires a live Gateway context");
    expect(spawnSubagentDirect).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "unscoped requester",
      params: { ...reservation, requesterSessionKey: "main" },
      expected: "canonical agent session key",
    },
    {
      name: "noncanonical requester",
      params: {
        ...reservation,
        requesterSessionKey: "Agent:Main:Subagent:Controller",
      },
      expected: "canonical agent session key",
    },
    {
      name: "invalid target",
      params: { ...reservation, targetAgentId: "Worker Agent" },
      expected: "targetAgentId is invalid",
    },
    {
      name: "noncanonical child",
      params: {
        ...reservation,
        childSessionKey: "agent:worker:subagent:Plugin-Reserved-Child",
      },
      expected: "canonical values",
    },
    {
      name: "blank task",
      params: { ...reservation, task: " " },
      expected: "task must be non-empty",
    },
    {
      name: "backend-reserved run ID",
      params: {
        ...reservation,
        runId: "exec-approval-followup:approval-1:nonce:nonce-1",
      },
      expected: "backend-reserved namespace",
    },
  ])("rejects malformed reserved spawn input: $name", async ({ params, expected }) => {
    await expect(
      withReservedPluginScope(() => createGatewaySubagentRuntime().spawnReserved(params)),
    ).rejects.toThrow(expected);
    expect(spawnSubagentDirect).not.toHaveBeenCalled();
  });

  it("forwards only generic reservation and ownership data", async () => {
    const runtime = createGatewaySubagentRuntime();
    const dedupe: GatewayRequestContext["dedupe"] = new Map();
    spawnSubagentDirect.mockImplementationOnce(
      async (_params: unknown, context: { reservedSubagentClaimToken?: string }) => {
        const reserved = dedupe.get(`agent:${reservation.runId}`);
        expect(reserved?.payload).toMatchObject({
          pluginRuntimeOwnerId: "agentic-os",
          runId: reservation.runId,
          sessionKey: reservation.childSessionKey,
          reservedSubagentClaimToken: context.reservedSubagentClaimToken,
        });
        return {
          status: "accepted",
          childSessionKey: reservation.childSessionKey,
          runId: reservation.runId,
          mode: "run",
        };
      },
    );

    await expect(
      withReservedPluginScope(() => runtime.spawnReserved(reservation), dedupe),
    ).resolves.toEqual({
      childSessionKey: reservation.childSessionKey,
      runId: reservation.runId,
      mode: "run",
    });
    expect(spawnSubagentDirect).toHaveBeenCalledWith(
      {
        task: reservation.task,
        agentId: reservation.targetAgentId,
        mode: "run",
        expectsCompletionMessage: false,
      },
      {
        agentSessionKey: reservation.requesterSessionKey,
        authorizedTargetAgentId: reservation.targetAgentId,
        preallocatedChildSessionKey: reservation.childSessionKey,
        preallocatedRunId: reservation.runId,
        pluginOwnerId: "agentic-os",
        requesterSessionId: "requester-session",
        reservedSubagentClaimToken: expect.any(String),
      },
    );
    expect(dedupe.has(`agent:${reservation.runId}`)).toBe(false);
  });

  it.each([
    {
      name: "cached Gateway run",
      arrange: () => undefined,
      dedupe: new Map([
        [
          `agent:${reservation.runId}`,
          {
            ts: Date.now(),
            ok: true,
            payload: {
              status: "accepted",
              runId: reservation.runId,
              sessionKey: "agent:other:main",
            },
          },
        ],
      ]) as GatewayRequestContext["dedupe"],
      expected: "runId already exists in the Gateway dedupe cache",
    },
    {
      name: "active Gateway run",
      arrange: () => getAgentRunContext.mockReturnValue({ sessionKey: "agent:other:main" }),
      dedupe: new Map() as GatewayRequestContext["dedupe"],
      expected: "runId is already active",
    },
    {
      name: "persisted run",
      arrange: () => hasSubagentRunIdentity.mockReturnValue(true),
      dedupe: new Map() as GatewayRequestContext["dedupe"],
      expected: "runId already exists",
    },
    {
      name: "persisted child",
      arrange: () =>
        getLatestSubagentRunByChildSessionKey.mockReturnValue({
          childSessionKey: reservation.childSessionKey,
        }),
      dedupe: new Map() as GatewayRequestContext["dedupe"],
      expected: "childSessionKey already exists",
    },
  ])(
    "rejects a reserved identity collision before dispatch: $name",
    async ({ arrange, dedupe, expected }) => {
      arrange();

      await expect(
        withReservedPluginScope(
          () => createGatewaySubagentRuntime().spawnReserved(reservation),
          dedupe,
        ),
      ).rejects.toThrow(expected);
      expect(spawnSubagentDirect).not.toHaveBeenCalled();
    },
  );

  it("allows exactly one concurrent claimant for the same reserved identities", async () => {
    let resolveFirst:
      | ((value: {
          status: "accepted";
          childSessionKey: string;
          runId: string;
          mode: "run";
        }) => void)
      | undefined;
    spawnSubagentDirect.mockImplementationOnce(
      async () =>
        await new Promise((resolve) => {
          resolveFirst = resolve;
        }),
    );
    const runtime = createGatewaySubagentRuntime();
    const first = withReservedPluginScope(() => runtime.spawnReserved(reservation));
    await vi.waitFor(() => expect(spawnSubagentDirect).toHaveBeenCalledTimes(1));

    await expect(withReservedPluginScope(() => runtime.spawnReserved(reservation))).rejects.toThrow(
      "already claimed",
    );
    expect(spawnSubagentDirect).toHaveBeenCalledTimes(1);

    resolveFirst?.({
      status: "accepted",
      childSessionKey: reservation.childSessionKey,
      runId: reservation.runId,
      mode: "run",
    });
    await expect(first).resolves.toMatchObject({
      childSessionKey: reservation.childSessionKey,
      runId: reservation.runId,
    });
  });

  it("fails closed when core returns different identities", async () => {
    spawnSubagentDirect.mockResolvedValueOnce({
      status: "accepted",
      childSessionKey: "agent:worker:subagent:different",
      runId: reservation.runId,
      mode: "run",
    });

    await expect(
      withReservedPluginScope(() => createGatewaySubagentRuntime().spawnReserved(reservation)),
    ).rejects.toThrow("returned different child or run identities");
  });

  it("retains reserved claims after indeterminate cleanup until deletion is confirmed", async () => {
    vi.stubEnv("OPENCLAW_TEST_FAST", "1");
    vi.useFakeTimers();
    const runtime = createGatewaySubagentRuntime();
    const dedupe: GatewayRequestContext["dedupe"] = new Map();
    spawnSubagentDirect.mockResolvedValueOnce({
      status: "error",
      error: "gateway request timeout for agent",
      childSessionKey: reservation.childSessionKey,
      runId: reservation.runId,
      reservedCleanup: { sessionDeletion: "indeterminate" },
    });

    await expect(
      withReservedPluginScope(() => runtime.spawnReserved(reservation), dedupe),
    ).rejects.toThrow("gateway request timeout for agent");
    expect(dedupe.has(`agent:${reservation.runId}`)).toBe(true);

    await expect(
      withReservedPluginScope(() => runtime.spawnReserved(reservation), dedupe),
    ).rejects.toThrow("already claimed");
    expect(spawnSubagentDirect).toHaveBeenCalledTimes(1);

    cleanupProvisionalSession.mockResolvedValueOnce(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(cleanupProvisionalSession).toHaveBeenCalledWith(reservation.childSessionKey, {
      emitLifecycleHooks: false,
      deleteTranscript: true,
    });
    expect(dedupe.has(`agent:${reservation.runId}`)).toBe(false);

    await expect(
      withReservedPluginScope(() => runtime.spawnReserved(reservation), dedupe),
    ).resolves.toMatchObject({
      childSessionKey: reservation.childSessionKey,
      runId: reservation.runId,
    });
    expect(spawnSubagentDirect).toHaveBeenCalledTimes(2);
  });

  it("bounds indeterminate cleanup retries without retaining permanent process claims", async () => {
    vi.stubEnv("OPENCLAW_TEST_FAST", "1");
    vi.useFakeTimers();
    const runtime = createGatewaySubagentRuntime();
    const dedupe: GatewayRequestContext["dedupe"] = new Map();
    const boundedReservation = {
      ...reservation,
      childSessionKey: "agent:worker:subagent:plugin-reserved-bounded-child",
      runId: "plugin-reserved-bounded-run",
    };
    spawnSubagentDirect.mockResolvedValueOnce({
      status: "error",
      error: "gateway request timeout for agent",
      childSessionKey: boundedReservation.childSessionKey,
      runId: boundedReservation.runId,
      reservedCleanup: { sessionDeletion: "indeterminate" },
    });
    spawnSubagentDirect.mockResolvedValueOnce({
      status: "accepted",
      childSessionKey: boundedReservation.childSessionKey,
      runId: boundedReservation.runId,
      mode: "run",
    });

    await expect(
      withReservedPluginScope(() => runtime.spawnReserved(boundedReservation), dedupe),
    ).rejects.toThrow("gateway request timeout for agent");

    await vi.advanceTimersByTimeAsync(10);

    expect(cleanupProvisionalSession).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
    expect(dedupe.has(`agent:${boundedReservation.runId}`)).toBe(false);
    await expect(
      withReservedPluginScope(() => runtime.spawnReserved(boundedReservation), dedupe),
    ).resolves.toMatchObject({
      childSessionKey: boundedReservation.childSessionKey,
      runId: boundedReservation.runId,
    });
    expect(spawnSubagentDirect).toHaveBeenCalledTimes(2);
  });

  it("rechecks requester ownership inside the admitted reserved spawn", async () => {
    const revalidatedReservation = {
      ...reservation,
      childSessionKey: "agent:worker:subagent:plugin-reserved-revalidated-child",
      runId: "plugin-reserved-revalidated-run",
    };
    spawnSubagentDirect.mockResolvedValueOnce({
      status: "accepted",
      childSessionKey: revalidatedReservation.childSessionKey,
      runId: revalidatedReservation.runId,
      mode: "run",
    });

    await expect(
      withReservedPluginScope(() =>
        createGatewaySubagentRuntime().spawnReserved({
          ...revalidatedReservation,
        }),
      ),
    ).resolves.toMatchObject({
      childSessionKey: revalidatedReservation.childSessionKey,
      runId: revalidatedReservation.runId,
    });

    expect(spawnSubagentDirect).toHaveBeenCalledTimes(1);
    expect(spawnSubagentDirect.mock.calls[0]?.[1]).not.toHaveProperty(
      "revalidateReservedRequesterOwnership",
    );
    expect(loadSessionEntryReadOnly).toHaveBeenCalledTimes(2);
  });

  it("rejects when requester ownership changes before the admitted spawn body", async () => {
    const revalidatedReservation = {
      ...reservation,
      childSessionKey: "agent:worker:subagent:plugin-reserved-revalidate-fail-child",
      runId: "plugin-reserved-revalidate-fail-run",
    };
    spawnSubagentDirect.mockResolvedValueOnce({
      status: "accepted",
      childSessionKey: revalidatedReservation.childSessionKey,
      runId: revalidatedReservation.runId,
      mode: "run",
    });
    loadSessionEntryReadOnly
      .mockReturnValueOnce({
        cfg: {
          agents: {
            defaults: { subagents: { allowAgents: ["worker"] } },
            entries: { main: {}, worker: {} },
          },
        },
        entry: {
          pluginOwnerId: "agentic-os",
          sessionId: "requester-session",
          lifecycleRevision: "1",
          createdAt: 1,
        },
      })
      .mockReturnValueOnce({
        cfg: {
          agents: {
            defaults: { subagents: { allowAgents: ["worker"] } },
            entries: { main: {}, worker: {} },
          },
        },
        entry: {
          pluginOwnerId: "foreign-plugin",
          sessionId: "requester-session",
          lifecycleRevision: "2",
          createdAt: 1,
        },
      });

    await expect(
      withReservedPluginScope(() =>
        createGatewaySubagentRuntime().spawnReserved({
          ...revalidatedReservation,
        }),
      ),
    ).rejects.toThrow('is owned by plugin "foreign-plugin", not "agentic-os"');

    expect(spawnSubagentDirect).not.toHaveBeenCalled();
  });

  it("accepts a wrapper-validated locked-harness requester without explicit pluginOwnerId", async () => {
    const lockedReservation = {
      ...reservation,
      requesterSessionKey: "agent:main:harness:codex:thread-1",
      childSessionKey: "agent:worker:subagent:locked-harness-reserved-child",
      runId: "locked-harness-reserved-run",
    };
    loadSessionEntryReadOnly.mockReturnValue({
      cfg: {
        agents: {
          defaults: { subagents: { allowAgents: ["worker"] } },
          entries: { main: {}, worker: {} },
        },
      },
      entry: {
        sessionId: "locked-harness-session",
        lifecycleRevision: "7",
        createdAt: 3,
        agentHarnessId: "codex",
        modelSelectionLocked: true,
      },
    });
    spawnSubagentDirect.mockResolvedValueOnce({
      status: "accepted",
      childSessionKey: lockedReservation.childSessionKey,
      runId: lockedReservation.runId,
      mode: "run",
    });

    await expect(
      withReservedPluginScope(
        () => createGatewaySubagentRuntime().spawnReserved(lockedReservation),
        new Map(),
        {
          ownerPluginId: "agentic-os",
          sessionKey: lockedReservation.requesterSessionKey,
          sessionId: "locked-harness-session",
          lifecycleRevision: "7",
          createdAt: 3,
        },
      ),
    ).resolves.toMatchObject({
      childSessionKey: lockedReservation.childSessionKey,
      runId: lockedReservation.runId,
    });

    expect(spawnSubagentDirect).toHaveBeenCalledTimes(1);
  });

  it("rejects a wrapper-validated requester when the same key is replaced before admission", async () => {
    const lockedReservation = {
      ...reservation,
      requesterSessionKey: "agent:main:harness:codex:thread-1",
      childSessionKey: "agent:worker:subagent:locked-harness-replaced-child",
      runId: "locked-harness-replaced-run",
    };
    const loaded = {
      cfg: {
        agents: {
          defaults: { subagents: { allowAgents: ["worker"] } },
          entries: { main: {}, worker: {} },
        },
      },
      entry: {
        sessionId: "locked-harness-session",
        lifecycleRevision: "7",
        createdAt: 3,
        agentHarnessId: "codex",
        modelSelectionLocked: true,
      },
    };
    loadSessionEntryReadOnly.mockReturnValueOnce(loaded).mockReturnValueOnce({
      ...loaded,
      entry: {
        ...loaded.entry,
        sessionId: "replacement-session",
      },
    });

    await expect(
      withReservedPluginScope(
        () => createGatewaySubagentRuntime().spawnReserved(lockedReservation),
        new Map(),
        {
          ownerPluginId: "agentic-os",
          sessionKey: lockedReservation.requesterSessionKey,
          sessionId: "locked-harness-session",
          lifecycleRevision: "7",
          createdAt: 3,
        },
      ),
    ).rejects.toThrow("changed while starting reserved subagent work");

    expect(spawnSubagentDirect).not.toHaveBeenCalled();
  });
});
