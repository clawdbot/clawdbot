import { beforeEach, describe, expect, it, vi } from "vitest";
import { ContractInputError } from "../agentic-os-runtime-contract-shared.js";
import type { GatewayClient } from "./shared-types.js";

const contractMocks = vi.hoisted(() => ({
  acquire: vi.fn(),
  history: vi.fn(),
  listLeases: vi.fn(),
  listSessions: vi.fn(),
  release: vi.fn(),
  spawn: vi.fn(),
  status: vi.fn(),
}));
const canonicalSession = vi.hoisted(() => ({
  error: undefined as string | undefined,
  payload: { messages: [] as unknown[], sessionExists: false, totalMessages: 0 },
}));
const canonicalHistory = vi.hoisted(() => ({
  error: undefined as string | undefined,
  payload: { messages: [] as unknown[] },
  requests: [] as Record<string, unknown>[],
}));
const runtimeMocks = vi.hoisted(() => ({
  findTask: vi.fn(),
  waitForAgentJob: vi.fn(),
}));

vi.mock("../agentic-os-runtime-contract.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../agentic-os-runtime-contract.js")>();
  return {
    ...actual,
    acquireAgenticOsAllowLease: contractMocks.acquire,
    historyAgenticOsSession: contractMocks.history,
    listAgenticOsAllowLeases: contractMocks.listLeases,
    listAgenticOsSessions: contractMocks.listSessions,
    releaseAgenticOsAllowLease: contractMocks.release,
    spawnAgenticOsSession: contractMocks.spawn,
    statusAgenticOsSession: contractMocks.status,
  };
});
vi.mock("./sessions-read.js", () => ({
  sessionReadHandlers: {
    "sessions.get": ({
      respond,
    }: {
      respond: (ok: boolean, payload?: unknown, error?: { message: string }) => void;
    }) =>
      canonicalSession.error
        ? respond(false, undefined, { message: canonicalSession.error })
        : respond(true, canonicalSession.payload, undefined),
  },
}));
vi.mock("./chat-history-handler.js", () => ({
  chatHistoryHandlers: {
    "chat.history": ({
      params,
      respond,
    }: {
      params: Record<string, unknown>;
      respond: (ok: boolean, payload?: unknown, error?: { message: string }) => void;
    }) => {
      canonicalHistory.requests.push(params);
      if (canonicalHistory.error) {
        respond(false, undefined, { message: canonicalHistory.error });
        return;
      }
      respond(true, canonicalHistory.payload, undefined);
    },
  },
}));
vi.mock("./agent-job.js", () => ({ waitForAgentJob: runtimeMocks.waitForAgentJob }));
vi.mock("../../tasks/task-status-access.js", () => ({
  findTaskByRunIdForStatus: runtimeMocks.findTask,
}));

import { agenticOsRuntimeContractHandlers } from "./agentic-os-runtime-contract.js";

type RespondCall = [boolean, unknown?, { code?: string; message: string }?];

async function invoke(
  method: string,
  testClient: GatewayClient | null,
  params?: Record<string, unknown>,
): Promise<RespondCall> {
  const respond = vi.fn();
  const handler = agenticOsRuntimeContractHandlers[method];
  if (!handler) {
    throw new Error(`missing handler: ${method}`);
  }
  await handler({
    params:
      params ??
      (method === "sessions_status"
        ? { session_key: "agent:ai-engineer:subagent:child" }
        : method === "sessions_history"
          ? { sessionKey: "agent:ai-engineer:subagent:child" }
          : { requester_agent_id: "main" }),
    respond: respond as never,
    client: testClient,
    context: {
      getRuntimeConfig: () => ({ agents: { list: [{ id: "main", default: true }] } }),
    } as never,
    req: { type: "req", id: "req-1", method },
    isWebchatConnect: () => false,
  });
  return respond.mock.calls[0] as RespondCall;
}

function client(values: Partial<GatewayClient>): GatewayClient {
  return {
    ...values,
    connect: { scopes: ["operator.admin"], ...values.connect },
  } as GatewayClient;
}

describe("Agentic OS runtime handler regressions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    contractMocks.acquire.mockReturnValue({ status: "active" });
    contractMocks.status.mockReturnValue({
      session_key: "agent:ai-engineer:subagent:child",
      runId: "run-child",
    });
    contractMocks.history.mockReturnValue({
      session_key: "agent:ai-engineer:subagent:child",
    });
    canonicalSession.error = undefined;
    canonicalSession.payload = { messages: [], sessionExists: false, totalMessages: 0 };
    canonicalHistory.error = undefined;
    canonicalHistory.payload = { messages: [] };
    canonicalHistory.requests = [];
    runtimeMocks.findTask.mockReset();
    runtimeMocks.waitForAgentJob.mockReset().mockResolvedValue(null);
  });

  it("rejects device-less connected callers instead of binding authority to connId", async () => {
    const response = await invoke(
      "subagents.allowLease.acquire",
      client({ connId: "ephemeral-connection" }),
    );

    expect(response[0]).toBe(false);
    expect(response[2]?.message).toContain("stable authenticated client identity");
    expect(contractMocks.acquire).not.toHaveBeenCalled();
  });

  it("distinguishes invalid input from transient runtime failures", async () => {
    contractMocks.acquire.mockImplementationOnce(() => {
      throw new ContractInputError("synthetic invalid request");
    });
    const invalid = await invoke("subagents.allowLease.acquire", null);
    contractMocks.acquire.mockImplementationOnce(() => {
      throw new Error("synthetic database outage");
    });
    const unavailable = await invoke("subagents.allowLease.acquire", null);

    expect(invalid[2]).toMatchObject({
      code: "INVALID_REQUEST",
      message: "synthetic invalid request",
    });
    expect(unavailable[2]).toMatchObject({
      code: "UNAVAILABLE",
      message: "Agentic OS runtime contract failure",
    });
  });

  it("keeps signed device ids isolated from connection and shared client ids", async () => {
    contractMocks.acquire.mockImplementation(
      (_params: unknown, _requester: unknown, principal: string) => ({ principal }),
    );
    const first = await invoke(
      "subagents.allowLease.acquire",
      client({
        authenticatedUserId: "shared-user",
        connId: "conn-a",
        pairedClientId: "shared-client",
        connect: { device: { id: "device-a" } } as never,
      }),
    );
    const second = await invoke(
      "subagents.allowLease.acquire",
      client({
        authenticatedUserId: "shared-user",
        connId: "conn-b",
        pairedClientId: "shared-client",
        connect: { device: { id: "device-b" } } as never,
      }),
    );

    expect(first[1]).toEqual({ principal: "device-a" });
    expect(second[1]).toEqual({ principal: "device-b" });
  });

  it("projects canonical total message count instead of the one-message probe", async () => {
    canonicalSession.payload = {
      messages: [{ role: "assistant" }],
      sessionExists: true,
      totalMessages: 7,
    };
    const response = await invoke("sessions_status", null);
    const runtime = (response[1] as { runtime_session: Record<string, unknown> }).runtime_session;

    expect(runtime).toMatchObject({
      observed: true,
      message_count: 7,
      session_exists: true,
      transcript_available: true,
    });
  });

  it("does not report a missing canonical session as transcript-available", async () => {
    const response = await invoke("sessions_status", null);
    const runtime = (response[1] as { runtime_session: Record<string, unknown> }).runtime_session;

    expect(runtime).toMatchObject({
      observed: false,
      message_count: 0,
      session_exists: false,
      transcript_available: false,
    });
  });

  it("rejects malformed sessions_history limit values before canonical history reads", async () => {
    for (const limit of ["5", Number.NaN, Number.POSITIVE_INFINITY, 0, -1, 1.5, null, {}, 1001]) {
      const response = await invoke("sessions_history", null, {
        sessionKey: "agent:ai-engineer:subagent:child",
        limit,
      });

      expect(response[0]).toBe(false);
      expect(response[2]?.code).toBe("INVALID_REQUEST");
      expect(response[2]?.message).toMatch(
        /invalid positive integer: limit|limit exceeds maximum 1000/,
      );
    }
    expect(canonicalHistory.requests).toEqual([]);
  });

  it("rejects malformed sessions_history includeTools values before canonical history reads", async () => {
    for (const includeTools of ["true", 1, null, {}, []]) {
      const response = await invoke("sessions_history", null, {
        sessionKey: "agent:ai-engineer:subagent:child",
        includeTools,
      });

      expect(response[0]).toBe(false);
      expect(response[2]?.message).toContain("invalid boolean: includeTools");
    }
    expect(canonicalHistory.requests).toEqual([]);
  });

  it("forwards numeric sessions_history limits to canonical history reads", async () => {
    const response = await invoke("sessions_history", null, {
      sessionKey: "agent:ai-engineer:subagent:child",
      limit: 5,
    });

    expect(response[0]).toBe(true);
    expect(canonicalHistory.requests).toEqual([
      { sessionKey: "agent:ai-engineer:subagent:child", limit: 5 },
    ]);
  });

  it("preserves canonical sessions.get failures instead of projecting transcript absence", async () => {
    canonicalSession.error = "synthetic canonical read failure";
    const response = await invoke("sessions_status", null);

    expect(response[0]).toBe(false);
    expect(response[2]).toEqual({
      code: "UNAVAILABLE",
      message: "Agentic OS runtime contract failure",
    });
  });

  it("reports canonical chat.history failures as unavailable without leaking backend text", async () => {
    canonicalHistory.error = "private transcript store outage";
    const response = await invoke("sessions_history", null);

    expect(response[0]).toBe(false);
    expect(response[2]).toEqual({
      code: "UNAVAILABLE",
      message: "Agentic OS runtime contract failure",
    });
  });

  it("projects failed child lifecycle without exposing raw failure text", async () => {
    runtimeMocks.waitForAgentJob.mockResolvedValue({
      status: "error",
      startedAt: 10,
      endedAt: 20,
      error: "private provider failure",
    });

    const response = await invoke("sessions_status", null);
    const runtime = (response[1] as { runtime_session: Record<string, unknown> }).runtime_session;

    expect(runtime).toMatchObject({
      lifecycle_status: "failed",
      runtime_status: "failed",
      terminal: true,
      started_at_ms: 10,
      ended_at_ms: 20,
    });
    expect(JSON.stringify(runtime)).not.toContain("private provider failure");
  });

  it("keeps terminal runtime_status stable after the agent-job cache expires", async () => {
    runtimeMocks.waitForAgentJob
      .mockResolvedValueOnce({
        status: "error",
        startedAt: 10,
        endedAt: 20,
        error: "private cached failure",
      })
      .mockResolvedValueOnce(null);
    runtimeMocks.findTask.mockReturnValue({
      status: "failed",
      startedAt: 10,
      endedAt: 20,
    });

    const cached = await invoke("sessions_status", null);
    const persisted = await invoke("sessions_status", null);
    const cachedRuntime = (cached[1] as { runtime_session: Record<string, unknown> })
      .runtime_session;
    const persistedRuntime = (persisted[1] as { runtime_session: Record<string, unknown> })
      .runtime_session;

    expect(cachedRuntime).toMatchObject({
      lifecycle_status: "failed",
      runtime_status: "failed",
      terminal: true,
      started_at_ms: 10,
      ended_at_ms: 20,
    });
    expect(persistedRuntime).toEqual(cachedRuntime);
  });
});
