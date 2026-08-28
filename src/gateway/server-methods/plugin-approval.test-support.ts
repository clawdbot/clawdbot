import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { expect, vi } from "vitest";
import type { PluginApprovalRequestPayload } from "../../infra/plugin-approvals.js";
import { ExecApprovalManager } from "../exec-approval-manager.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

export function createManager() {
  return new ExecApprovalManager<PluginApprovalRequestPayload>({ approvalKind: "plugin" });
}

function createLogGatewayMock() {
  return { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() };
}

export function createApprovalContext(
  params: {
    broadcast?: ReturnType<typeof vi.fn>;
    hasExecApprovalClients?: GatewayRequestHandlerOptions["context"]["hasExecApprovalClients"];
  } = {},
): GatewayRequestHandlerOptions["context"] {
  return {
    broadcast: params.broadcast ?? vi.fn(),
    logGateway: createLogGatewayMock(),
    hasExecApprovalClients: params.hasExecApprovalClients ?? (() => true),
  } as unknown as GatewayRequestHandlerOptions["context"];
}

export function createClient(
  params: {
    connId?: string;
    clientId?: string;
    displayName?: string;
    deviceId?: string;
    scopes?: string[];
    approvalRuntime?: boolean;
  } = {},
): GatewayRequestHandlerOptions["client"] {
  const connect: Record<string, unknown> = {
    client: {
      id: params.clientId ?? "test-client",
      displayName: params.displayName ?? "Test Client",
    },
  };
  if (params.deviceId) {
    connect.device = { id: params.deviceId };
  }
  if (params.scopes) {
    connect.scopes = params.scopes;
  }
  return {
    connId: params.connId ?? "conn-test-client",
    connect,
    ...(params.approvalRuntime ? { internal: { approvalRuntime: true } } : {}),
  } as unknown as GatewayRequestHandlerOptions["client"];
}

export function createMockOptions(
  method: string,
  params: Record<string, unknown>,
  overrides?: Partial<GatewayRequestHandlerOptions>,
): GatewayRequestHandlerOptions {
  return {
    req: { method, params, id: "req-1" },
    params,
    client: createClient(),
    isWebchatConnect: () => false,
    respond: vi.fn(),
    context: createApprovalContext(),
    ...overrides,
  } as unknown as GatewayRequestHandlerOptions;
}

export function createNoExecApprovalContext(): GatewayRequestHandlerOptions["context"] {
  return createApprovalContext({ hasExecApprovalClients: () => false });
}

type MockCallSource = {
  mock: {
    calls: ArrayLike<ReadonlyArray<unknown>>;
  };
};

export const requireRecord = createRequireRecord("object", "expected-label");

export function requireArray(value: unknown, label: string): unknown[] {
  expect(Array.isArray(value), label).toBe(true);
  return value as unknown[];
}

export function mockCall(source: unknown, index: number, label: string) {
  const call = (source as MockCallSource).mock.calls[index];
  if (!call) {
    throw new Error(`Expected ${label}`);
  }
  return call;
}

export function responseCall(source: unknown, index = 0) {
  const call = mockCall(source, index, `response call ${index}`);
  return {
    ok: call[0],
    result: call[1],
    error: call[2],
  };
}

export function responseResult(source: unknown, index = 0) {
  return requireRecord(responseCall(source, index).result, `response result ${index}`);
}

export function responseError(source: unknown, index = 0) {
  return requireRecord(responseCall(source, index).error, `response error ${index}`);
}

export function acceptedResult(source: unknown) {
  const callSource = source as MockCallSource;
  const call = Array.from(callSource.mock.calls).find((candidate) => {
    const result = candidate[1];
    return typeof result === "object" && result !== null && "status" in result
      ? (result as Record<string, unknown>).status === "accepted"
      : false;
  });
  if (!call) {
    throw new Error("Expected accepted response call");
  }
  return requireRecord(call[1], "accepted response result");
}

function acceptedApprovalId(source: unknown) {
  const id = acceptedResult(source).id;
  expect(id, "accepted approval id").toBeTypeOf("string");
  return id as string;
}

export function expectResponseOk(source: unknown, index = 0) {
  const call = responseCall(source, index);
  expect(call.ok).toBe(true);
  expect(call.error).toBeUndefined();
  return requireRecord(call.result, `response result ${index}`);
}

export function expectResponseRejected(source: unknown, index = 0) {
  expect(responseCall(source, index).ok).toBe(false);
  return responseError(source, index);
}

export async function waitForAcceptedApproval(respond: unknown) {
  await vi.waitFor(() => {
    const accepted = acceptedResult(respond);
    expect(accepted.status).toBe("accepted");
    expect(accepted.id).toBeTypeOf("string");
  });
  return acceptedApprovalId(respond);
}

export function createOwnedClient(owner: "owner" | "other" = "owner") {
  return createClient({
    connId: `conn-${owner}`,
    clientId: `client-${owner}`,
    deviceId: `device-${owner}`,
  });
}

export function registerApproval(
  approvalManager: ExecApprovalManager<PluginApprovalRequestPayload>,
  params: {
    title?: string;
    description?: string;
    id?: string;
    allowedDecisions?: PluginApprovalRequestPayload["allowedDecisions"];
  } = {},
) {
  const request = {
    title: params.title ?? "T",
    description: params.description ?? "D",
    ...(params.allowedDecisions ? { allowedDecisions: params.allowedDecisions } : {}),
  };
  const record = params.id
    ? approvalManager.create(request, 60_000, params.id)
    : approvalManager.create(request, 60_000);
  void approvalManager.register(record, 60_000);
  return record;
}

export function registerOwnedApproval(
  approvalManager: ExecApprovalManager<PluginApprovalRequestPayload>,
  params: { title: string; id?: string; owner?: "owner" | "other" },
) {
  const record = registerApproval(approvalManager, { title: params.title, id: params.id });
  const owner = params.owner ?? "owner";
  record.requestedByDeviceId = `device-${owner}`;
  record.requestedByConnId = `conn-${owner}`;
  record.requestedByClientId = `client-${owner}`;
  return record;
}

export function expectPluginApprovalId(value: unknown, label: string): string {
  expect(value, label).toBeTypeOf("string");
  if (typeof value !== "string") {
    throw new Error(`${label} must be a string`);
  }
  expect(value.startsWith("plugin:"), label).toBe(true);
  const uuid = value.slice("plugin:".length);
  expect(uuid).toHaveLength(36);
  expect(uuid.split("-").map((part) => part.length)).toEqual([8, 4, 4, 4, 12]);
  expect(
    uuid.split("-").every((part) => /^[0-9a-f]+$/.test(part)),
    label,
  ).toBe(true);
  return value;
}

export function broadcastCall(opts: GatewayRequestHandlerOptions, index = 0) {
  const call = mockCall(opts.context.broadcast, index, "broadcast call");
  return {
    event: call?.[0],
    payload: requireRecord(call?.[1], "broadcast payload"),
    options: call?.[2],
  };
}
