// Reserved-spawn validation tests keep option/cancellation guards out of the large seam suite.
import { beforeEach, describe, expect, it, vi } from "vitest";
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
vi.mock("../infra/agent-events.js", () => ({
  getAgentRunContext,
  onAgentEvent: vi.fn(),
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
): T {
  return withPluginRuntimeGatewayRequestScope(
    {
      context: { dedupe } as GatewayRequestContext,
      isWebchatConnect: () => false,
    },
    () => withPluginRuntimePluginIdScope("agentic-os", run),
  );
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
      entry: {
        pluginOwnerId: "agentic-os",
        sessionId: "requester-session",
        lifecycleRevision: "1",
        createdAt: 1,
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
});
