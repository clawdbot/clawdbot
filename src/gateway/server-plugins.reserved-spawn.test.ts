// Gateway plugin reserved-spawn tests lock the narrow Plugin SDK to core seam.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "../config/sessions/types.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import type { PluginRegistry } from "../plugins/registry-types.js";
import {
  withPluginRuntimeGatewayRequestScope,
  withPluginRuntimePluginIdScope,
} from "../plugins/runtime/gateway-request-scope.js";
import { resolveReservedSpawnRequesterOwnerPluginId } from "../plugins/session-ownership.js";
import type { GatewayRequestContext } from "./server-methods/types.js";
import {
  RESERVED_SUBAGENT_LABEL_MAX_BYTES,
  RESERVED_SUBAGENT_TASK_MAX_BYTES,
} from "./server-plugins-reserved-spawn.js";

const spawnSubagentDirect = vi.hoisted(() => vi.fn());
const cleanupProvisionalSession = vi.hoisted(() => vi.fn());
const getAgentRunContext = vi.hoisted(() => vi.fn());
const hasSubagentRunIdentity = vi.hoisted(() => vi.fn());
const getLatestSubagentRunByChildSessionKey = vi.hoisted(() => vi.fn());
const loadSessionEntryReadOnly = vi.hoisted(() => vi.fn());
const runWithWorkAdmission = vi.hoisted(() => vi.fn());

vi.mock("../agents/subagent-spawn.js", () => ({
  spawnSubagentDirect,
}));
vi.mock("../agents/subagent-spawn-cleanup.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../agents/subagent-spawn-cleanup.js")>()),
  cleanupProvisionalSession,
}));
vi.mock("../agents/subagent-registry.js", () => ({
  getLatestSubagentRunByChildSessionKey,
  hasSubagentRunIdentity,
}));
vi.mock("../infra/agent-run-registry.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/agent-run-registry.js")>()),
  getAgentRunContext,
}));
vi.mock("./session-utils-store.js", () => ({
  loadSessionEntryReadOnly,
}));
vi.mock("../plugins/runtime/runtime-agent.js", () => ({
  createRuntimeAgent: () => ({
    session: { runWithWorkAdmission },
  }),
}));

import { createGatewaySubagentRuntime } from "./server-plugins.js";

type RequesterOwnershipEvidence = {
  ownerPluginId: string;
  sessionKey: string;
  sessionId?: string;
  lifecycleRevisionPresent: boolean;
  lifecycleRevision?: string;
  createdAt?: number;
  resolveCurrentOwnerPluginId: (params: { entry: SessionEntry; sessionKey: string }) => string;
};

const reservation = {
  requesterSessionKey: "agent:main:main",
  targetAgentId: "worker",
  childSessionKey: "agent:worker:subagent:plugin-reserved-child",
  runId: "plugin-reserved-run",
  task: "run the reserved child",
} as const;
const defaultRequesterStorePath = "/tmp/openclaw-main-sessions.json";
const defaultRequesterCfg = {
  agents: {
    defaults: { subagents: { allowAgents: ["worker"] } },
    entries: { main: {}, worker: {} },
  },
};

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

function createHarnessOwnerRegistry(ownerPluginId = "agentic-os"): PluginRegistry {
  const registry = createEmptyPluginRegistry();
  registry.agentHarnesses.push({
    pluginId: ownerPluginId,
    pluginName: "Agentic OS",
    source: "test",
    harness: {
      id: "codex",
      label: "Codex",
    } as PluginRegistry["agentHarnesses"][number]["harness"],
  });
  return registry;
}

function lockedHarnessRequesterOwnership(params: {
  registry: Pick<PluginRegistry, "agentHarnesses">;
  sessionKey: string;
  sessionId: string;
  lifecycleRevision?: string;
  lifecycleRevisionPresent?: boolean;
  createdAt: number;
  pluginId?: string;
}): RequesterOwnershipEvidence {
  const pluginId = params.pluginId ?? "agentic-os";
  const evidence: RequesterOwnershipEvidence = {
    ownerPluginId: pluginId,
    sessionKey: params.sessionKey,
    sessionId: params.sessionId,
    lifecycleRevisionPresent: params.lifecycleRevisionPresent ?? true,
    createdAt: params.createdAt,
    resolveCurrentOwnerPluginId: ({ entry, sessionKey }) =>
      resolveReservedSpawnRequesterOwnerPluginId({
        entry,
        pluginId,
        registry: params.registry,
        sessionKey,
      }),
  };
  if (params.lifecycleRevision !== undefined) {
    evidence.lifecycleRevision = params.lifecycleRevision;
  }
  return evidence;
}

describe("createGatewaySubagentRuntime.spawnReserved", () => {
  beforeEach(() => {
    spawnSubagentDirect.mockReset();
    cleanupProvisionalSession.mockReset().mockResolvedValue(false);
    getAgentRunContext.mockReset().mockReturnValue(undefined);
    hasSubagentRunIdentity.mockReset().mockReturnValue(false);
    getLatestSubagentRunByChildSessionKey.mockReset().mockReturnValue(undefined);
    runWithWorkAdmission
      .mockReset()
      .mockImplementation(
        async (_target: unknown, run: (signal: AbortSignal) => Promise<unknown>) =>
          await run(new AbortController().signal),
      );
    loadSessionEntryReadOnly.mockReset().mockReturnValue({
      cfg: defaultRequesterCfg,
      storePath: defaultRequesterStorePath,
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

  it("rejects oversized tasks before reserved identity checks or child creation", async () => {
    const oversizedTask = `${" ".repeat(RESERVED_SUBAGENT_TASK_MAX_BYTES + 1)}trimmed-small`;

    await expect(
      withReservedPluginScope(() =>
        createGatewaySubagentRuntime().spawnReserved({
          ...reservation,
          task: oversizedTask,
        }),
      ),
    ).rejects.toThrow(`${RESERVED_SUBAGENT_TASK_MAX_BYTES} byte limit`);

    expect(loadSessionEntryReadOnly).not.toHaveBeenCalled();
    expect(getAgentRunContext).not.toHaveBeenCalled();
    expect(hasSubagentRunIdentity).not.toHaveBeenCalled();
    expect(getLatestSubagentRunByChildSessionKey).not.toHaveBeenCalled();
    expect(spawnSubagentDirect).not.toHaveBeenCalled();
  });

  it("applies the reserved task byte limit to raw UTF-8 input", async () => {
    spawnSubagentDirect.mockResolvedValueOnce({
      status: "accepted",
      childSessionKey: reservation.childSessionKey,
      runId: reservation.runId,
      mode: "run",
    });
    const exactLimitTask = "a".repeat(RESERVED_SUBAGENT_TASK_MAX_BYTES);

    await expect(
      withReservedPluginScope(() =>
        createGatewaySubagentRuntime().spawnReserved({
          ...reservation,
          task: exactLimitTask,
        }),
      ),
    ).resolves.toMatchObject({
      childSessionKey: reservation.childSessionKey,
      runId: reservation.runId,
    });

    const multibyteOverLimitTask = `${"€".repeat(
      Math.floor(RESERVED_SUBAGENT_TASK_MAX_BYTES / Buffer.byteLength("€", "utf8")),
    )}€`;
    expect(Buffer.byteLength(multibyteOverLimitTask, "utf8")).toBeGreaterThan(
      RESERVED_SUBAGENT_TASK_MAX_BYTES,
    );
    await expect(
      withReservedPluginScope(() =>
        createGatewaySubagentRuntime().spawnReserved({
          ...reservation,
          childSessionKey: "agent:worker:subagent:plugin-reserved-child-utf8",
          runId: "plugin-reserved-run-utf8",
          task: multibyteOverLimitTask,
        }),
      ),
    ).rejects.toThrow(`${RESERVED_SUBAGENT_TASK_MAX_BYTES} byte limit`);

    const rawWhitespaceOverLimitTask = `${" ".repeat(RESERVED_SUBAGENT_TASK_MAX_BYTES)}x`;
    await expect(
      withReservedPluginScope(() =>
        createGatewaySubagentRuntime().spawnReserved({
          ...reservation,
          childSessionKey: "agent:worker:subagent:plugin-reserved-child-raw",
          runId: "plugin-reserved-run-raw",
          task: rawWhitespaceOverLimitTask,
        }),
      ),
    ).rejects.toThrow(`${RESERVED_SUBAGENT_TASK_MAX_BYTES} byte limit`);
  });

  it.each([
    {
      name: "multibyte UTF-8",
      label: `${"€".repeat(
        Math.floor(RESERVED_SUBAGENT_LABEL_MAX_BYTES / Buffer.byteLength("€", "utf8")),
      )}€`,
    },
    {
      name: "raw leading whitespace",
      label: `${" ".repeat(RESERVED_SUBAGENT_LABEL_MAX_BYTES)}x`,
    },
  ])(
    "rejects oversized labels before reserved identity checks or child creation: $name",
    async ({ label }) => {
      expect(Buffer.byteLength(label, "utf8")).toBeGreaterThan(RESERVED_SUBAGENT_LABEL_MAX_BYTES);

      await expect(
        withReservedPluginScope(() =>
          createGatewaySubagentRuntime().spawnReserved({
            ...reservation,
            label,
          }),
        ),
      ).rejects.toThrow(`${RESERVED_SUBAGENT_LABEL_MAX_BYTES} byte limit`);

      expect(loadSessionEntryReadOnly).not.toHaveBeenCalled();
      expect(getAgentRunContext).not.toHaveBeenCalled();
      expect(hasSubagentRunIdentity).not.toHaveBeenCalled();
      expect(getLatestSubagentRunByChildSessionKey).not.toHaveBeenCalled();
      expect(spawnSubagentDirect).not.toHaveBeenCalled();
    },
  );

  it("forwards only generic reservation and ownership data", async () => {
    const runtime = createGatewaySubagentRuntime();
    const dedupe: GatewayRequestContext["dedupe"] = new Map();
    const labeledReservation = { ...reservation, label: "bounded label" };
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
      withReservedPluginScope(() => runtime.spawnReserved(labeledReservation), dedupe),
    ).resolves.toEqual({
      childSessionKey: reservation.childSessionKey,
      runId: reservation.runId,
      mode: "run",
    });
    expect(spawnSubagentDirect).toHaveBeenCalledWith(
      {
        task: reservation.task,
        label: labeledReservation.label,
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
        requesterLifecycleRevisionPresent: true,
        requesterLifecycleRevision: "1",
        reservedSubagentClaimToken: expect.any(String),
        signal: expect.any(AbortSignal),
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

  it("leaves requester child-cap accounting to core shared admission", async () => {
    let resolveFirst:
      | ((value: {
          status: "accepted";
          childSessionKey: string;
          runId: string;
          mode: "run";
        }) => void)
      | undefined;
    const secondReservation = {
      ...reservation,
      childSessionKey: "agent:worker:subagent:plugin-reserved-concurrent-child-2",
      runId: "plugin-reserved-concurrent-run-2",
    };
    spawnSubagentDirect
      .mockImplementationOnce(async (_params: unknown, context: Record<string, unknown>) => {
        expect(context).not.toHaveProperty("reservedSubagentAdditionalActiveChildren");
        return await new Promise((resolve) => {
          resolveFirst = resolve;
        });
      })
      .mockImplementationOnce(async (_params: unknown, context: Record<string, unknown>) => {
        expect(context).not.toHaveProperty("reservedSubagentAdditionalActiveChildren");
        return {
          status: "accepted",
          childSessionKey: secondReservation.childSessionKey,
          runId: secondReservation.runId,
          mode: "run",
        };
      });
    const runtime = createGatewaySubagentRuntime();
    const first = withReservedPluginScope(() => runtime.spawnReserved(reservation));
    await vi.waitFor(() => expect(spawnSubagentDirect).toHaveBeenCalledTimes(1));

    await expect(
      withReservedPluginScope(() => runtime.spawnReserved(secondReservation)),
    ).resolves.toMatchObject({
      childSessionKey: secondReservation.childSessionKey,
      runId: secondReservation.runId,
    });
    expect(spawnSubagentDirect).toHaveBeenCalledTimes(2);

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
    const sessionIdentity = {
      expectedSessionId: "child-session-original",
      expectedLifecycleRevision: "child-lifecycle-original",
    };
    spawnSubagentDirect.mockResolvedValueOnce({
      status: "error",
      error: "gateway request timeout for agent",
      childSessionKey: reservation.childSessionKey,
      runId: reservation.runId,
      reservedCleanup: { sessionDeletion: "indeterminate", sessionIdentity },
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
      expectedIdentity: sessionIdentity,
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

  it("keeps indeterminate cleanup scheduled after the initial retry window", async () => {
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
    await expect(
      withReservedPluginScope(() => runtime.spawnReserved(boundedReservation), dedupe),
    ).rejects.toThrow("gateway request timeout for agent");

    await vi.advanceTimersByTimeAsync(3);

    expect(cleanupProvisionalSession).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(1);
    expect(dedupe.has(`agent:${boundedReservation.runId}`)).toBe(true);
    await expect(
      withReservedPluginScope(() => runtime.spawnReserved(boundedReservation), dedupe),
    ).rejects.toThrow("already claimed");
    expect(spawnSubagentDirect).toHaveBeenCalledTimes(1);

    cleanupProvisionalSession.mockResolvedValueOnce(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(cleanupProvisionalSession).toHaveBeenCalledTimes(4);
    expect(dedupe.has(`agent:${boundedReservation.runId}`)).toBe(false);
    spawnSubagentDirect.mockResolvedValueOnce({
      status: "accepted",
      childSessionKey: boundedReservation.childSessionKey,
      runId: boundedReservation.runId,
      mode: "run",
    });
    await expect(
      withReservedPluginScope(() => runtime.spawnReserved(boundedReservation), dedupe),
    ).resolves.toMatchObject({
      childSessionKey: boundedReservation.childSessionKey,
      runId: boundedReservation.runId,
    });
    expect(spawnSubagentDirect).toHaveBeenCalledTimes(2);
  });

  it("releases process claims after bounded cleanup retries when durable registry owns the failure", async () => {
    vi.stubEnv("OPENCLAW_TEST_FAST", "1");
    vi.useFakeTimers();
    const runtime = createGatewaySubagentRuntime();
    const dedupe: GatewayRequestContext["dedupe"] = new Map();
    const durableReservation = {
      ...reservation,
      childSessionKey: "agent:worker:subagent:plugin-reserved-durable-child",
      runId: "plugin-reserved-durable-run",
    };
    let durableOwner = false;
    getLatestSubagentRunByChildSessionKey.mockImplementation((childSessionKey: string) =>
      durableOwner && childSessionKey === durableReservation.childSessionKey
        ? {
            runId: durableReservation.runId,
            childSessionKey: durableReservation.childSessionKey,
            spawnFailureCleanup: { status: "exhausted" },
          }
        : undefined,
    );
    spawnSubagentDirect.mockResolvedValueOnce({
      status: "error",
      error: "gateway request timeout for agent",
      childSessionKey: durableReservation.childSessionKey,
      runId: durableReservation.runId,
      reservedCleanup: { sessionDeletion: "indeterminate" },
    });

    await expect(
      withReservedPluginScope(() => runtime.spawnReserved(durableReservation), dedupe),
    ).rejects.toThrow("gateway request timeout for agent");
    expect(dedupe.has(`agent:${durableReservation.runId}`)).toBe(true);

    durableOwner = true;
    await vi.advanceTimersByTimeAsync(10);

    expect(cleanupProvisionalSession).toHaveBeenCalledTimes(3);
    expect(dedupe.has(`agent:${durableReservation.runId}`)).toBe(false);
    await expect(
      withReservedPluginScope(() => runtime.spawnReserved(durableReservation), dedupe),
    ).rejects.toThrow("already exists");
    expect(spawnSubagentDirect).toHaveBeenCalledTimes(1);
  });

  it("keeps reserved claims when replacement inspection throws", async () => {
    vi.stubEnv("OPENCLAW_TEST_FAST", "1");
    vi.useFakeTimers();
    const runtime = createGatewaySubagentRuntime();
    const dedupe: GatewayRequestContext["dedupe"] = new Map();
    const guardedReservation = {
      ...reservation,
      childSessionKey: "agent:worker:subagent:plugin-reserved-inspection-throws-child",
      runId: "plugin-reserved-inspection-throws-run",
    };
    const sessionIdentity = {
      expectedSessionId: "plugin-child-inspection-original",
      expectedLifecycleRevision: "plugin-child-inspection-lifecycle",
    };
    const requesterEntry = {
      cfg: defaultRequesterCfg,
      storePath: defaultRequesterStorePath,
      entry: {
        pluginOwnerId: "agentic-os",
        sessionId: "requester-session",
        lifecycleRevision: "1",
        createdAt: 1,
      },
    };
    loadSessionEntryReadOnly.mockImplementation((sessionKey: string) => {
      if (sessionKey === guardedReservation.childSessionKey) {
        throw new Error("session store unavailable");
      }
      return requesterEntry;
    });
    spawnSubagentDirect.mockResolvedValueOnce({
      status: "error",
      error: "gateway request timeout for agent",
      childSessionKey: guardedReservation.childSessionKey,
      runId: guardedReservation.runId,
      reservedCleanup: { sessionDeletion: "indeterminate", sessionIdentity },
    });

    await expect(
      withReservedPluginScope(() => runtime.spawnReserved(guardedReservation), dedupe),
    ).rejects.toThrow("gateway request timeout for agent");
    expect(dedupe.has(`agent:${guardedReservation.runId}`)).toBe(true);

    cleanupProvisionalSession.mockResolvedValueOnce(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(cleanupProvisionalSession).toHaveBeenCalledWith(guardedReservation.childSessionKey, {
      emitLifecycleHooks: false,
      deleteTranscript: true,
      expectedIdentity: sessionIdentity,
    });
    expect(dedupe.has(`agent:${guardedReservation.runId}`)).toBe(true);

    await expect(
      withReservedPluginScope(() => runtime.spawnReserved(guardedReservation), dedupe),
    ).rejects.toThrow("already claimed");
    expect(spawnSubagentDirect).toHaveBeenCalledTimes(1);
  });

  it("releases reserved claims when a replacement child identity proves the original is gone", async () => {
    vi.stubEnv("OPENCLAW_TEST_FAST", "1");
    vi.useFakeTimers();
    const runtime = createGatewaySubagentRuntime();
    const dedupe: GatewayRequestContext["dedupe"] = new Map();
    const replacedReservation = {
      ...reservation,
      childSessionKey: "agent:worker:subagent:plugin-reserved-replaced-child",
      runId: "plugin-reserved-replaced-run",
    };
    const sessionIdentity = {
      expectedSessionId: "plugin-child-original",
      expectedLifecycleRevision: "plugin-child-original-lifecycle",
    };
    const requesterEntry = {
      cfg: defaultRequesterCfg,
      storePath: defaultRequesterStorePath,
      entry: {
        pluginOwnerId: "agentic-os",
        sessionId: "requester-session",
        lifecycleRevision: "1",
        createdAt: 1,
      },
    };
    loadSessionEntryReadOnly.mockImplementation((sessionKey: string) =>
      sessionKey === replacedReservation.childSessionKey
        ? {
            cfg: requesterEntry.cfg,
            entry: {
              sessionId: "plugin-child-replacement",
              lifecycleRevision: "plugin-child-replacement-lifecycle",
              updatedAt: 2,
            },
          }
        : requesterEntry,
    );
    spawnSubagentDirect
      .mockResolvedValueOnce({
        status: "error",
        error: "gateway request timeout for agent",
        childSessionKey: replacedReservation.childSessionKey,
        runId: replacedReservation.runId,
        reservedCleanup: { sessionDeletion: "indeterminate", sessionIdentity },
      })
      .mockResolvedValueOnce({
        status: "accepted",
        childSessionKey: replacedReservation.childSessionKey,
        runId: replacedReservation.runId,
        mode: "run",
      });

    await expect(
      withReservedPluginScope(() => runtime.spawnReserved(replacedReservation), dedupe),
    ).rejects.toThrow("gateway request timeout for agent");
    expect(dedupe.has(`agent:${replacedReservation.runId}`)).toBe(true);

    cleanupProvisionalSession.mockResolvedValueOnce(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(cleanupProvisionalSession).toHaveBeenCalledWith(replacedReservation.childSessionKey, {
      emitLifecycleHooks: false,
      deleteTranscript: true,
      expectedIdentity: sessionIdentity,
    });
    expect(dedupe.has(`agent:${replacedReservation.runId}`)).toBe(false);

    await expect(
      withReservedPluginScope(() => runtime.spawnReserved(replacedReservation), dedupe),
    ).resolves.toMatchObject({
      childSessionKey: replacedReservation.childSessionKey,
      runId: replacedReservation.runId,
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
        cfg: defaultRequesterCfg,
        storePath: defaultRequesterStorePath,
        entry: {
          pluginOwnerId: "agentic-os",
          sessionId: "requester-session",
          lifecycleRevision: "1",
          createdAt: 1,
        },
      })
      .mockReturnValueOnce({
        cfg: defaultRequesterCfg,
        storePath: defaultRequesterStorePath,
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
    const registry = createHarnessOwnerRegistry();
    loadSessionEntryReadOnly.mockReturnValue({
      cfg: defaultRequesterCfg,
      storePath: defaultRequesterStorePath,
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
        lockedHarnessRequesterOwnership({
          registry,
          sessionKey: lockedReservation.requesterSessionKey,
          sessionId: "locked-harness-session",
          lifecycleRevision: "7",
          createdAt: 3,
        }),
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
    const registry = createHarnessOwnerRegistry();
    const loaded = {
      cfg: defaultRequesterCfg,
      storePath: defaultRequesterStorePath,
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
        lockedHarnessRequesterOwnership({
          registry,
          sessionKey: lockedReservation.requesterSessionKey,
          sessionId: "locked-harness-session",
          lifecycleRevision: "7",
          createdAt: 3,
        }),
      ),
    ).rejects.toThrow("changed while starting reserved subagent work");

    expect(spawnSubagentDirect).not.toHaveBeenCalled();
  });

  it("rejects a wrapper-validated locked-harness requester when harness ownership changes after admission", async () => {
    const lockedReservation = {
      ...reservation,
      requesterSessionKey: "agent:main:harness:codex:thread-1",
      childSessionKey: "agent:worker:subagent:locked-harness-derived-owner-changed-child",
      runId: "locked-harness-derived-owner-changed-run",
    };
    const registry = createHarnessOwnerRegistry();
    const loaded = {
      cfg: defaultRequesterCfg,
      storePath: defaultRequesterStorePath,
      entry: {
        sessionId: "locked-harness-session",
        lifecycleRevision: "7",
        createdAt: 3,
        agentHarnessId: "codex",
        modelSelectionLocked: true,
      },
    };
    loadSessionEntryReadOnly.mockReturnValueOnce(loaded).mockImplementationOnce(() => {
      registry.agentHarnesses[0]!.pluginId = "foreign-plugin";
      return loaded;
    });

    await expect(
      withReservedPluginScope(
        () => createGatewaySubagentRuntime().spawnReserved(lockedReservation),
        new Map(),
        lockedHarnessRequesterOwnership({
          registry,
          sessionKey: lockedReservation.requesterSessionKey,
          sessionId: "locked-harness-session",
          lifecycleRevision: "7",
          createdAt: 3,
        }),
      ),
    ).rejects.toThrow('is owned by plugin "foreign-plugin", not "agentic-os"');

    expect(loadSessionEntryReadOnly).toHaveBeenCalledTimes(2);
    expect(spawnSubagentDirect).not.toHaveBeenCalled();
  });

  it("rejects a wrapper-validated locked-harness requester when harness ownership changes even with unchanged explicit owner", async () => {
    const lockedReservation = {
      ...reservation,
      requesterSessionKey: "agent:main:harness:codex:thread-1",
      childSessionKey: "agent:worker:subagent:locked-harness-explicit-owner-stale-child",
      runId: "locked-harness-explicit-owner-stale-run",
    };
    const registry = createHarnessOwnerRegistry();
    const loaded = {
      cfg: defaultRequesterCfg,
      storePath: defaultRequesterStorePath,
      entry: {
        pluginOwnerId: "agentic-os",
        sessionId: "locked-harness-session",
        lifecycleRevision: "7",
        createdAt: 3,
        agentHarnessId: "codex",
        modelSelectionLocked: true,
      },
    };
    loadSessionEntryReadOnly.mockReturnValueOnce(loaded).mockImplementationOnce(() => {
      registry.agentHarnesses[0]!.pluginId = "foreign-plugin";
      return loaded;
    });

    await expect(
      withReservedPluginScope(
        () => createGatewaySubagentRuntime().spawnReserved(lockedReservation),
        new Map(),
        lockedHarnessRequesterOwnership({
          registry,
          sessionKey: lockedReservation.requesterSessionKey,
          sessionId: "locked-harness-session",
          lifecycleRevision: "7",
          createdAt: 3,
        }),
      ),
    ).rejects.toThrow('is owned by plugin "foreign-plugin", not "agentic-os"');

    expect(loadSessionEntryReadOnly).toHaveBeenCalledTimes(2);
    expect(spawnSubagentDirect).not.toHaveBeenCalled();
  });

  it("rejects a wrapper-validated requester when current plugin ownership changes after admission", async () => {
    const lockedReservation = {
      ...reservation,
      requesterSessionKey: "agent:main:harness:codex:thread-1",
      childSessionKey: "agent:worker:subagent:locked-harness-owner-changed-child",
      runId: "locked-harness-owner-changed-run",
    };
    const registry = createHarnessOwnerRegistry();
    const loaded = {
      cfg: defaultRequesterCfg,
      storePath: defaultRequesterStorePath,
      entry: {
        pluginOwnerId: "agentic-os",
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
        pluginOwnerId: "foreign-plugin",
      },
    });

    await expect(
      withReservedPluginScope(
        () => createGatewaySubagentRuntime().spawnReserved(lockedReservation),
        new Map(),
        lockedHarnessRequesterOwnership({
          registry,
          sessionKey: lockedReservation.requesterSessionKey,
          sessionId: "locked-harness-session",
          lifecycleRevision: "7",
          createdAt: 3,
        }),
      ),
    ).rejects.toThrow('is owned by plugin "foreign-plugin", not "agentic-os"');

    expect(loadSessionEntryReadOnly).toHaveBeenCalledTimes(2);
    expect(spawnSubagentDirect).not.toHaveBeenCalled();
  });
});
