import { EventEmitter } from "node:events";
import type { IncomingMessage } from "node:http";
import {
  createEmptyPluginRegistry,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { createMockServerResponse } from "openclaw/plugin-sdk/test-env";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig, PluginRuntime } from "../runtime-api.js";
import type { ResolvedGoogleChatAccount } from "./accounts.js";
import { verifyGoogleChatRequest } from "./auth.js";
import {
  handleGoogleChatWebhookRequest,
  registerGoogleChatWebhookTarget,
} from "./monitor-routing.js";

vi.mock("./auth.js", () => ({
  verifyGoogleChatRequest: vi.fn(),
}));

function createWebhookRequest(params: {
  authorization?: string;
  payload: unknown;
  path?: string;
}): IncomingMessage {
  const req = new EventEmitter() as IncomingMessage & {
    destroyed?: boolean;
    destroy: (error?: Error) => IncomingMessage;
    on: (event: string, listener: (...args: unknown[]) => void) => IncomingMessage;
  };
  req.method = "POST";
  req.url = params.path ?? "/googlechat";
  req.headers = {
    authorization: params.authorization ?? "",
    "content-type": "application/json",
  };
  req.destroyed = false;
  (req as unknown as { socket: { remoteAddress: string } }).socket = {
    remoteAddress: "127.0.0.1",
  };
  req.destroy = () => {
    req.destroyed = true;
    return req;
  };

  const originalOn = req.on.bind(req);
  let bodyScheduled = false;
  req.on = ((event: string, listener: (...args: unknown[]) => void) => {
    const result = originalOn(event, listener);
    if (!bodyScheduled && event === "data") {
      bodyScheduled = true;
      void Promise.resolve().then(() => {
        req.emit("data", Buffer.from(JSON.stringify(params.payload), "utf-8"));
        if (!req.destroyed) {
          req.emit("end");
        }
      });
    }
    return result;
  }) as IncomingMessage["on"];

  return req;
}

function createHeaderOnlyWebhookRequest(params: {
  authorization?: string;
  path?: string;
}): IncomingMessage {
  const req = new EventEmitter() as IncomingMessage;
  req.method = "POST";
  req.url = params.path ?? "/googlechat";
  req.headers = {
    authorization: params.authorization ?? "",
    "content-type": "application/json",
  };
  (req as unknown as { socket: { remoteAddress: string } }).socket = {
    remoteAddress: "127.0.0.1",
  };
  return req;
}

const baseAccount = (accountId: string) =>
  ({
    accountId,
    enabled: true,
    credentialSource: "none",
    config: {},
  }) as ResolvedGoogleChatAccount;

function registerTwoTargets() {
  const sinkA = vi.fn();
  const sinkB = vi.fn();
  const logA = vi.fn();
  const logB = vi.fn();
  const core = {} as PluginRuntime;
  const config = {} as OpenClawConfig;

  const unregisterA = registerGoogleChatWebhookTarget({
    account: baseAccount("A"),
    config,
    runtime: { log: logA },
    core,
    path: "/googlechat",
    statusSink: sinkA,
    mediaMaxMb: 5,
  });
  const unregisterB = registerGoogleChatWebhookTarget({
    account: baseAccount("B"),
    config,
    runtime: { log: logB },
    core,
    path: "/googlechat",
    statusSink: sinkB,
    mediaMaxMb: 5,
  });

  return {
    logA,
    logB,
    sinkA,
    sinkB,
    unregister: () => {
      unregisterA();
      unregisterB();
    },
  };
}

async function dispatchWebhookRequest(req: IncomingMessage) {
  const res = createMockServerResponse();
  const handled = await handleGoogleChatWebhookRequest(req, res);
  expect(handled).toBe(true);
  return res;
}

async function expectVerifiedRoute(params: {
  request: IncomingMessage;
  expectedStatus: number;
  sinkA: ReturnType<typeof vi.fn>;
  sinkB: ReturnType<typeof vi.fn>;
  expectedSink: "none" | "A" | "B";
}) {
  const res = await dispatchWebhookRequest(params.request);
  expect(res.statusCode).toBe(params.expectedStatus);
  const expectedCounts =
    params.expectedSink === "A" ? [1, 0] : params.expectedSink === "B" ? [0, 1] : [0, 0];
  expect(params.sinkA).toHaveBeenCalledTimes(expectedCounts[0]);
  expect(params.sinkB).toHaveBeenCalledTimes(expectedCounts[1]);
}

function mockSecondVerifierSuccess() {
  vi.mocked(verifyGoogleChatRequest)
    .mockResolvedValueOnce({ ok: false, reason: "invalid" })
    .mockResolvedValueOnce({ ok: true });
}

describe("Google Chat webhook routing", () => {
  afterEach(() => {
    setActivePluginRegistry(createEmptyPluginRegistry());
  });

  afterAll(() => {
    vi.doUnmock("./auth.js");
    vi.resetModules();
  });

  it("rejects ambiguous routing when multiple targets on the same path verify successfully", async () => {
    vi.mocked(verifyGoogleChatRequest).mockResolvedValue({ ok: true });

    const { sinkA, sinkB, unregister } = registerTwoTargets();

    try {
      await expectVerifiedRoute({
        request: createWebhookRequest({
          authorization: "Bearer test-token",
          payload: { type: "ADDED_TO_SPACE", space: { name: "spaces/AAA" } },
        }),
        expectedStatus: 401,
        sinkA,
        sinkB,
        expectedSink: "none",
      });
    } finally {
      unregister();
    }
  });

  it("routes to the single verified target when earlier targets fail verification", async () => {
    mockSecondVerifierSuccess();

    const { logA, logB, sinkA, sinkB, unregister } = registerTwoTargets();

    try {
      await expectVerifiedRoute({
        request: createWebhookRequest({
          authorization: "Bearer test-token",
          payload: { type: "ADDED_TO_SPACE", space: { name: "spaces/BBB" } },
        }),
        expectedStatus: 200,
        sinkA,
        sinkB,
        expectedSink: "B",
      });
      expect(logA).not.toHaveBeenCalled();
      expect(logB).not.toHaveBeenCalled();
    } finally {
      unregister();
    }
  });

  it("rejects invalid bearer before attempting to read the body", async () => {
    vi.mocked(verifyGoogleChatRequest).mockResolvedValue({ ok: false, reason: "invalid" });
    const { unregister } = registerTwoTargets();

    try {
      const req = createHeaderOnlyWebhookRequest({
        authorization: "Bearer invalid-token",
      });
      const onSpy = vi.spyOn(req, "on");
      const res = await dispatchWebhookRequest(req);
      expect(res.statusCode).toBe(401);
      expect(onSpy.mock.calls.map(([event]) => event)).not.toContain("data");
    } finally {
      unregister();
    }
  });

  it("supports add-on requests that provide systemIdToken in the body", async () => {
    mockSecondVerifierSuccess();
    const { sinkA, sinkB, unregister } = registerTwoTargets();

    try {
      await expectVerifiedRoute({
        request: createWebhookRequest({
          payload: {
            commonEventObject: { hostApp: "CHAT" },
            authorizationEventObject: { systemIdToken: "addon-token" },
            chat: {
              eventTime: "2026-03-02T00:00:00.000Z",
              user: { name: "users/12345", displayName: "Test User" },
              messagePayload: {
                space: { name: "spaces/AAA" },
                message: { text: "Hello from add-on" },
              },
            },
          },
        }),
        expectedStatus: 200,
        sinkA,
        sinkB,
        expectedSink: "B",
      });
    } finally {
      unregister();
    }
  });
});
