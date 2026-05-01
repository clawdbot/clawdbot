import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { expect, vi, type Mock } from "vitest";
import type { ResolvedBlueBubblesAccount } from "./accounts.js";
import { handleBlueBubblesWebhookRequest } from "./monitor.js";
import { registerBlueBubblesWebhookTarget } from "./monitor.js";
import type { OpenClawConfig, PluginRuntime } from "./runtime-api.js";
import { setBlueBubblesRuntime } from "./runtime.js";

export type WebhookRequestParams = {
  method?: string;
  url?: string;
  body?: unknown;
  headers?: Record<string, string>;
  remoteAddress?: string;
};

export const LOOPBACK_REMOTE_ADDRESSES_FOR_TEST = ["127.0.0.1", "::1", "::ffff:127.0.0.1"] as const;
type UnknownMock = Mock<(...args: unknown[]) => unknown>;
type HangingWebhookRequestForTest = {
  req: IncomingMessage;
  destroyMock: UnknownMock;
};

export function createMockAccount(
  overrides: Partial<ResolvedBlueBubblesAccount["config"]> = {},
): ResolvedBlueBubblesAccount {
  return {
    accountId: "default",
    enabled: true,
    configured: true,
    config: {
      serverUrl: "http://localhost:1234",
      password: "test-password",
      dmPolicy: "open",
      groupPolicy: "open",
      allowFrom: ["*"],
      groupAllowFrom: [],
      ...overrides,
    },
  };
}

export function createProtectedWebhookAccountForTest(password = "test-password") {
  return createMockAccount({ password });
}

export function createNewMessagePayloadForTest(dataOverrides: Record<string, unknown> = {}) {
  return {
    type: "new-message",
    data: {
      text: "hello",
      handle: { address: "+15551234567" },
      isGroup: false,
      isFromMe: false,
      guid: "msg-1",
      ...dataOverrides,
    },
  };
}

export function createTimestampedNewMessagePayloadForTest(
  dataOverrides: Record<string, unknown> = {},
) {
  return createNewMessagePayloadForTest({
    ...dataOverrides,
    date: Date.now(),
  });
}

function createMessageReactionPayloadForTest(dataOverrides: Record<string, unknown> = {}) {
  return {
    type: "message-reaction",
    data: {
      handle: { address: "+15551234567" },
      isGroup: false,
      isFromMe: false,
      associatedMessageGuid: "msg-original-123",
      associatedMessageType: 2000,
      ...dataOverrides,
    },
  };
}

export function createTimestampedMessageReactionPayloadForTest(
  dataOverrides: Record<string, unknown> = {},
) {
  return createMessageReactionPayloadForTest({
    ...dataOverrides,
    date: Date.now(),
  });
}

export function createMockRequest(
  method: string,
  url: string,
  body: unknown,
  headers: Record<string, string> = {},
  remoteAddress = "127.0.0.1",
): IncomingMessage {
  if (headers.host === undefined) {
    headers.host = "localhost";
  }
  const parsedUrl = new URL(url, "http://localhost");
  const hasAuthQuery = parsedUrl.searchParams.has("guid") || parsedUrl.searchParams.has("password");
  const hasAuthHeader =
    headers["x-guid"] !== undefined ||
    headers["x-password"] !== undefined ||
    headers["x-bluebubbles-guid"] !== undefined ||
    headers.authorization !== undefined;
  if (!hasAuthQuery && !hasAuthHeader) {
    parsedUrl.searchParams.set("password", "test-password");
  }

  const req = new EventEmitter() as IncomingMessage;
  req.method = method;
  req.url = `${parsedUrl.pathname}${parsedUrl.search}`;
  req.headers = headers;
  (req as unknown as { socket: { remoteAddress: string } }).socket = { remoteAddress };

  // Emit body data after a microtask.
  void Promise.resolve().then(() => {
    const bodyStr = typeof body === "string" ? body : JSON.stringify(body);
    req.emit("data", Buffer.from(bodyStr));
    req.emit("end");
  });

  return req;
}

function createMockRequestForTest(params: WebhookRequestParams = {}): IncomingMessage {
  return createMockRequest(
    params.method ?? "POST",
    params.url ?? "/bluebubbles-webhook",
    params.body ?? {},
    params.headers,
    params.remoteAddress,
  );
}

export function createRemoteWebhookRequestParamsForTest(
  params: {
    body?: unknown;
    remoteAddress?: string;
    overrides?: WebhookRequestParams;
  } = {},
): WebhookRequestParams {
  return {
    body: params.body ?? createNewMessagePayloadForTest(),
    remoteAddress: params.remoteAddress ?? "192.168.1.100",
    ...params.overrides,
  };
}

export function createPasswordQueryRequestParamsForTest(
  params: {
    body?: unknown;
    password?: string;
    remoteAddress?: string;
    overrides?: Omit<WebhookRequestParams, "url">;
  } = {},
): WebhookRequestParams {
  return createRemoteWebhookRequestParamsForTest({
    body: params.body,
    remoteAddress: params.remoteAddress,
    overrides: {
      url: `/bluebubbles-webhook?password=${params.password ?? "test-password"}`,
      ...params.overrides,
    },
  });
}

export function createLoopbackWebhookRequestParamsForTest(
  remoteAddress: (typeof LOOPBACK_REMOTE_ADDRESSES_FOR_TEST)[number],
  params: {
    body?: unknown;
    overrides?: Omit<WebhookRequestParams, "remoteAddress">;
  } = {},
): WebhookRequestParams {
  return {
    body: params.body ?? createNewMessagePayloadForTest(),
    remoteAddress,
    ...params.overrides,
  };
}

export function createHangingWebhookRequestForTest(
  url = "/bluebubbles-webhook?password=test-password",
  remoteAddress = "127.0.0.1",
): HangingWebhookRequestForTest {
  const req = new EventEmitter() as IncomingMessage;
  const destroyMock = vi.fn();
  req.method = "POST";
  req.url = url;
  req.headers = {};
  req.destroy = destroyMock as unknown as IncomingMessage["destroy"];
  (req as unknown as { socket: { remoteAddress: string } }).socket = { remoteAddress };
  return { req, destroyMock };
}

function createMockResponse(): ServerResponse & { body: string; statusCode: number } {
  const res = {
    statusCode: 200,
    body: "",
    setHeader: vi.fn(),
    end: vi.fn((data?: string) => {
      res.body = data ?? "";
    }),
  } as unknown as ServerResponse & { body: string; statusCode: number };
  return res;
}

async function flushAsync() {
  for (let i = 0; i < 2; i += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

export function createWebhookDispatchForTest(req: IncomingMessage) {
  const res = createMockResponse();
  const handledPromise = handleBlueBubblesWebhookRequest(req, res);
  return { res, handledPromise };
}

export async function dispatchWebhookRequestForTest(
  req: IncomingMessage,
  options: { flushAsyncAfter?: boolean } = {},
) {
  const { res, handledPromise } = createWebhookDispatchForTest(req);
  const handled = await handledPromise;
  if (options.flushAsyncAfter) {
    await flushAsync();
  }
  return { handled, res };
}

export async function dispatchWebhookPayloadForTest(params: WebhookRequestParams = {}) {
  const req = createMockRequestForTest(params);
  return dispatchWebhookRequestForTest(req, { flushAsyncAfter: true });
}

export async function expectWebhookStatusForTest(
  req: IncomingMessage,
  expectedStatus: number,
  expectedBody?: string,
) {
  const { res, handled } = await dispatchWebhookRequestForTest(req);
  expect(handled).toBe(true);
  expect(res.statusCode).toBe(expectedStatus);
  if (expectedBody !== undefined) {
    expect(res.body).toBe(expectedBody);
  }
  return res;
}

export async function expectWebhookRequestStatusForTest(
  params: WebhookRequestParams,
  expectedStatus: number,
  expectedBody?: string,
) {
  return expectWebhookStatusForTest(createMockRequestForTest(params), expectedStatus, expectedBody);
}

export function trackWebhookRegistrationForTest<T extends { unregister: () => void }>(
  registration: T,
  setUnregister: (unregister: () => void) => void,
) {
  setUnregister(registration.unregister);
  return registration;
}

function registerWebhookTargetForTest(params: {
  core: PluginRuntime;
  account?: ResolvedBlueBubblesAccount;
  config?: OpenClawConfig;
  path?: string;
  statusSink?: (event: unknown) => void;
  runtime?: {
    log: (...args: unknown[]) => unknown;
    error: (...args: unknown[]) => unknown;
  };
}) {
  setBlueBubblesRuntime(params.core);

  return registerBlueBubblesWebhookTarget({
    account: params.account ?? createMockAccount(),
    config: params.config ?? {},
    runtime: params.runtime ?? { log: vi.fn(), error: vi.fn() },
    core: params.core,
    path: params.path ?? "/bluebubbles-webhook",
    statusSink: params.statusSink,
  });
}

function registerWebhookTargetsForTest(params: {
  core: PluginRuntime;
  accounts: Array<{
    account: ResolvedBlueBubblesAccount;
    statusSink?: (event: unknown) => void;
  }>;
  config?: OpenClawConfig;
  path?: string;
  runtime?: {
    log: (...args: unknown[]) => unknown;
    error: (...args: unknown[]) => unknown;
  };
}) {
  return params.accounts.map(({ account, statusSink }) =>
    registerWebhookTargetForTest({
      core: params.core,
      account,
      config: params.config,
      path: params.path,
      runtime: params.runtime,
      statusSink,
    }),
  );
}

export function setupWebhookTargetForTest(params: {
  createCore: () => PluginRuntime;
  core?: PluginRuntime;
  account?: ResolvedBlueBubblesAccount;
  config?: OpenClawConfig;
  path?: string;
  statusSink?: (event: unknown) => void;
  runtime?: {
    log: (...args: unknown[]) => unknown;
    error: (...args: unknown[]) => unknown;
  };
}) {
  const account = params.account ?? createMockAccount();
  const config = params.config ?? {};
  const core = params.core ?? params.createCore();
  const unregister = registerWebhookTargetForTest({
    core,
    account,
    config,
    path: params.path,
    statusSink: params.statusSink,
    runtime: params.runtime,
  });
  return { account, config, core, unregister };
}

export function setupWebhookTargetsForTest(params: {
  createCore: () => PluginRuntime;
  core?: PluginRuntime;
  accounts: Array<{
    account: ResolvedBlueBubblesAccount;
    statusSink?: (event: unknown) => void;
  }>;
  config?: OpenClawConfig;
  path?: string;
  runtime?: {
    log: (...args: unknown[]) => unknown;
    error: (...args: unknown[]) => unknown;
  };
}) {
  const core = params.core ?? params.createCore();
  const unregisterFns = registerWebhookTargetsForTest({
    core,
    accounts: params.accounts,
    config: params.config,
    path: params.path,
    runtime: params.runtime,
  });
  const unregister = () => {
    for (const unregisterFn of unregisterFns) {
      unregisterFn();
    }
  };
  return { core, unregister };
}
