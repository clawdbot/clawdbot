// Reserved-spawn validation tests keep option/cancellation guards out of the large seam suite.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "../config/sessions/types.js";
import type { ReservedSubagentRequesterOwnershipEvidence } from "../plugins/runtime/gateway-request-scope.js";
import {
  withPluginRuntimeGatewayRequestScope,
  withPluginRuntimePluginIdScope,
} from "../plugins/runtime/gateway-request-scope.js";
import type { GatewayRequestContext } from "./server-methods/types.js";

const spawnSubagentDirect = vi.hoisted(() => vi.fn());
const getAgentRunContext = vi.hoisted(() => vi.fn());
const hasSubagentRunIdentity = vi.hoisted(() => vi.fn());
const getLatestSubagentRunByChildSessionKey = vi.hoisted(() => vi.fn());
const loadSessionEntryReadOnly = vi.hoisted(() => vi.fn());
const runWithWorkAdmission = vi.hoisted(() => vi.fn());

vi.mock("../agents/subagent-spawn.js", () => ({
  spawnSubagentDirect,
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
  requesterOwnership?: ReservedSubagentRequesterOwnershipEvidence,
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

function requesterLoadResult(params: { lifecycleRevisionPresent: boolean; value?: string }) {
  const entry: SessionEntry = {
    pluginOwnerId: "agentic-os",
    sessionId: "requester-session",
    createdAt: 1,
    updatedAt: 1,
    ...(params.lifecycleRevisionPresent ? { lifecycleRevision: params.value } : {}),
  };
  return {
    cfg: {
      agents: {
        defaults: { subagents: { allowAgents: ["worker"] } },
        entries: { main: {}, worker: {} },
      },
    },
    storePath: "/tmp/openclaw-main-sessions.json",
    entry,
  };
}

function requesterOwnershipEvidence(params: {
  lifecycleRevisionPresent: boolean;
  value?: string;
}): ReservedSubagentRequesterOwnershipEvidence {
  return {
    ownerPluginId: "agentic-os",
    sessionKey: reservation.requesterSessionKey,
    sessionId: "requester-session",
    lifecycleRevisionPresent: params.lifecycleRevisionPresent,
    ...(params.lifecycleRevisionPresent ? { lifecycleRevision: params.value } : {}),
    createdAt: 1,
    resolveCurrentOwnerPluginId: ({ entry }) => entry.pluginOwnerId ?? "<none>",
  };
}

describe("createGatewaySubagentRuntime.spawnReserved validation", () => {
  beforeEach(() => {
    spawnSubagentDirect.mockReset().mockResolvedValue({
      status: "accepted",
      childSessionKey: reservation.childSessionKey,
      runId: reservation.runId,
      mode: "run",
    });
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
      cfg: {
        agents: {
          defaults: { subagents: { allowAgents: ["worker"] } },
          entries: { main: {}, worker: {} },
        },
      },
      storePath: "/tmp/openclaw-main-sessions.json",
      entry: {
        pluginOwnerId: "agentic-os",
        sessionId: "requester-session",
        lifecycleRevision: "1",
        createdAt: 1,
        updatedAt: 1,
      },
    });
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
    {
      name: "chat namespace run ID",
      params: { ...reservation, runId: "chat:reserved-run" },
      expected: "backend-reserved namespace",
    },
    {
      name: "agent namespace run ID",
      params: { ...reservation, runId: "agent:reserved-run" },
      expected: "backend-reserved namespace",
    },
    {
      name: "malformed task name",
      params: { ...reservation, taskName: "Bad Name" },
      expected: "Invalid taskName",
    },
    {
      name: "reserved task name",
      params: { ...reservation, taskName: "last" },
      expected: "Reserved subagent targets",
    },
    {
      name: "invalid cleanup",
      params: { ...reservation, cleanup: "Delete" } as never,
      expected: 'cleanup must be "delete" or "keep"',
    },
    {
      name: "invalid context",
      params: { ...reservation, context: "forked" } as never,
      expected: 'context must be "isolated" or "fork"',
    },
    {
      name: "invalid lightContext",
      params: { ...reservation, lightContext: "true" } as never,
      expected: "lightContext must be a boolean",
    },
  ])("rejects malformed reserved spawn input: $name", async ({ params, expected }) => {
    await expect(
      withReservedPluginScope(() => createGatewaySubagentRuntime().spawnReserved(params)),
    ).rejects.toThrow(expected);
    expect(spawnSubagentDirect).not.toHaveBeenCalled();
  });

  it("propagates requester lifecycle cancellation before child creation", async () => {
    runWithWorkAdmission.mockImplementationOnce(
      async (_target: unknown, run: (signal: AbortSignal) => Promise<unknown>) => {
        const controller = new AbortController();
        controller.abort(new Error("requester session was deleted"));
        return await run(controller.signal);
      },
    );

    await expect(
      withReservedPluginScope(() => createGatewaySubagentRuntime().spawnReserved(reservation)),
    ).rejects.toThrow("requester session was deleted");

    expect(spawnSubagentDirect).not.toHaveBeenCalled();
  });

  it("uses the loaded requester store path for plugin-owned requester admission", async () => {
    const requesterStorePath = "/tmp/openclaw-incognito/plugin-owned-main-sessions.json";
    loadSessionEntryReadOnly.mockReturnValue({
      cfg: {
        session: { store: "/tmp/openclaw-default-{agentId}-sessions.json" },
        agents: {
          defaults: { subagents: { allowAgents: ["worker"] } },
          entries: { main: {}, worker: {} },
        },
      },
      storePath: requesterStorePath,
      entry: {
        pluginOwnerId: "agentic-os",
        sessionId: "requester-session",
        lifecycleRevision: "1",
        createdAt: 1,
        updatedAt: 1,
      },
    });

    await expect(
      withReservedPluginScope(() => createGatewaySubagentRuntime().spawnReserved(reservation)),
    ).resolves.toMatchObject({
      childSessionKey: reservation.childSessionKey,
      runId: reservation.runId,
    });

    expect(runWithWorkAdmission).toHaveBeenCalledWith(
      {
        storePath: requesterStorePath,
        sessionKey: reservation.requesterSessionKey,
      },
      expect.any(Function),
    );
  });

  it.each([
    {
      name: "keeps unchanged present revision",
      initial: { lifecycleRevisionPresent: true, value: "1" },
      current: { lifecycleRevisionPresent: true, value: "1" },
      accepted: true,
    },
    {
      name: "keeps unchanged absent revision",
      initial: { lifecycleRevisionPresent: false },
      current: { lifecycleRevisionPresent: false },
      accepted: true,
    },
    {
      name: "rejects absent-to-present revision",
      initial: { lifecycleRevisionPresent: false },
      current: { lifecycleRevisionPresent: true, value: "replacement" },
      accepted: false,
    },
    {
      name: "rejects present-to-absent revision",
      initial: { lifecycleRevisionPresent: true, value: "1" },
      current: { lifecycleRevisionPresent: false },
      accepted: false,
    },
    {
      name: "rejects revision value change",
      initial: { lifecycleRevisionPresent: true, value: "1" },
      current: { lifecycleRevisionPresent: true, value: "2" },
      accepted: false,
    },
  ])("$name for wrapper-validated requester evidence", async ({ initial, current, accepted }) => {
    const scopedReservation = {
      ...reservation,
      childSessionKey: `agent:worker:subagent:${initial.lifecycleRevisionPresent ? "present" : "absent"}-${
        current.lifecycleRevisionPresent ? (current.value ?? "present") : "absent"
      }-child`,
      runId: `reserved-lifecycle-${initial.lifecycleRevisionPresent ? "present" : "absent"}-${
        current.lifecycleRevisionPresent ? (current.value ?? "present") : "absent"
      }-run`,
    };
    loadSessionEntryReadOnly
      .mockReturnValueOnce(requesterLoadResult(initial))
      .mockReturnValueOnce(requesterLoadResult(current));
    if (accepted) {
      spawnSubagentDirect.mockResolvedValueOnce({
        status: "accepted",
        childSessionKey: scopedReservation.childSessionKey,
        runId: scopedReservation.runId,
        mode: "run",
      });
    }

    const result = expect(
      withReservedPluginScope(
        () => createGatewaySubagentRuntime().spawnReserved(scopedReservation),
        new Map(),
        requesterOwnershipEvidence(initial),
      ),
    );
    if (accepted) {
      await result.resolves.toMatchObject({
        childSessionKey: scopedReservation.childSessionKey,
        runId: scopedReservation.runId,
      });
      expect(spawnSubagentDirect).toHaveBeenCalledTimes(1);
      expect(spawnSubagentDirect.mock.calls[0]?.[1]).toMatchObject({
        requesterSessionId: "requester-session",
        requesterLifecycleRevisionPresent: initial.lifecycleRevisionPresent,
        ...(initial.lifecycleRevisionPresent && initial.value !== undefined
          ? { requesterLifecycleRevision: initial.value }
          : {}),
      });
    } else {
      await result.rejects.toThrow("changed while starting reserved subagent work");
      expect(spawnSubagentDirect).not.toHaveBeenCalled();
    }
  });

  it("binds reserved claim tokens to requester lifecycle revision value", async () => {
    const loadWithRevision = (value: string) =>
      requesterLoadResult({
        lifecycleRevisionPresent: true,
        value,
      });
    loadSessionEntryReadOnly
      .mockReturnValueOnce(loadWithRevision("before-reset"))
      .mockReturnValueOnce(loadWithRevision("before-reset"))
      .mockReturnValueOnce(loadWithRevision("after-reset"))
      .mockReturnValueOnce(loadWithRevision("after-reset"));

    await expect(
      withReservedPluginScope(() => createGatewaySubagentRuntime().spawnReserved(reservation)),
    ).resolves.toMatchObject({
      childSessionKey: reservation.childSessionKey,
      runId: reservation.runId,
    });
    await expect(
      withReservedPluginScope(() => createGatewaySubagentRuntime().spawnReserved(reservation)),
    ).resolves.toMatchObject({
      childSessionKey: reservation.childSessionKey,
      runId: reservation.runId,
    });

    const firstToken = (
      spawnSubagentDirect.mock.calls[0]?.[1] as {
        reservedSubagentClaimToken?: string;
      }
    )?.reservedSubagentClaimToken;
    const secondToken = (
      spawnSubagentDirect.mock.calls[1]?.[1] as {
        reservedSubagentClaimToken?: string;
      }
    )?.reservedSubagentClaimToken;
    expect(firstToken).toBeTypeOf("string");
    expect(secondToken).toBeTypeOf("string");
    expect(firstToken).not.toBe(secondToken);
  });
});
