import { beforeEach, describe, expect, it, vi } from "vitest";
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
  payload: { messages: [] as unknown[], sessionExists: false, totalMessages: 0 },
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
    }) => respond(true, canonicalSession.payload, undefined),
  },
}));
vi.mock("./agent-job.js", () => ({ waitForAgentJob: vi.fn(async () => null) }));
vi.mock("../../tasks/task-status-access.js", () => ({
  findTaskByRunIdForStatus: vi.fn(() => undefined),
}));

import { agenticOsRuntimeContractHandlers } from "./agentic-os-runtime-contract.js";

type RespondCall = [boolean, unknown?, { message: string }?];

async function invoke(method: string, testClient: GatewayClient | null): Promise<RespondCall> {
  const respond = vi.fn();
  const handler = agenticOsRuntimeContractHandlers[method];
  if (!handler) {
    throw new Error(`missing handler: ${method}`);
  }
  await handler({
    params:
      method === "sessions_status"
        ? { session_key: "agent:ai-engineer:subagent:child" }
        : { requester_agent_id: "main" },
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
    canonicalSession.payload = { messages: [], sessionExists: false, totalMessages: 0 };
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
});
