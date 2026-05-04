// Googlechat tests cover monitor.webhook routing plugin behavior.
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

type GoogleChatBuildContextParams = {
  messageId?: string;
  messageIdFull?: string;
  reply: {
    messageThreadId?: string;
    replyToId?: string;
    replyToIdFull?: string;
  };
};

function createGoogleChatBuildContextMock() {
  return vi.fn((params: GoogleChatBuildContextParams) => ({
    MessageSid: params.messageId,
    MessageSidFull: params.messageIdFull,
    MessageThreadId: params.reply.messageThreadId,
    ReplyToId: params.reply.replyToId,
    ReplyToIdFull: params.reply.replyToIdFull,
  }));
}

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

const sendGoogleChatMessageMock = vi.hoisted(() =>
  vi.fn().mockResolvedValue({ messageName: "spaces/AAA/messages/typing" }),
);
const updateGoogleChatMessageMock = vi.hoisted(() => vi.fn().mockResolvedValue({}));

vi.mock("./api.js", () => ({
  sendGoogleChatMessage: sendGoogleChatMessageMock,
  isGoogleChatMessageResourceName: (value: string | undefined) =>
    typeof value === "string" && /^spaces\/[^/]+\/messages\/[^/]+$/.test(value),
  isGoogleChatThreadResourceName: (value: string | undefined) =>
    typeof value === "string" && /^spaces\/[^/]+\/threads\/[^/]+$/.test(value),
  updateGoogleChatMessage: updateGoogleChatMessageMock,
  downloadGoogleChatMedia: vi.fn(),
}));

describe("Google Chat monitor inbound context", () => {
  afterEach(() => {
    setActivePluginRegistry(createEmptyPluginRegistry());
  });

  it("preserves the Google Chat thread resource separately from the message id", async () => {
    vi.mocked(verifyGoogleChatRequest).mockResolvedValue({ ok: true });
    await import("./monitor.js");

    const buildContext = createGoogleChatBuildContextMock();
    const run = vi.fn(async () => ({}));
    const core = {
      logging: { shouldLogVerbose: () => false },
      channel: {
        commands: {
          shouldComputeCommandAuthorized: () => false,
          resolveCommandAuthorizedFromAuthorizers: () => false,
          shouldHandleTextCommands: () => false,
          isControlCommandMessage: () => false,
        },
        text: {
          hasControlCommand: () => false,
          resolveChunkMode: () => "markdown",
          chunkMarkdownTextWithMode: (text: string) => [text],
        },
        routing: {
          resolveAgentRoute: () => ({
            agentId: "finn",
            accountId: "default",
            sessionKey: "agent:finn:googlechat:group:spaces/AAA",
          }),
        },
        session: {
          resolveStorePath: () => "/tmp/openclaw-test-store",
          readSessionUpdatedAt: () => undefined,
          recordSessionMetaFromInbound: vi.fn(async () => {}),
        },
        reply: {
          resolveEnvelopeFormatOptions: () => ({}),
          formatAgentEnvelope: ({ body }: { body: string }) => body,
        },
        turn: {
          buildContext,
          run,
        },
        media: {
          saveMediaBuffer: vi.fn(),
        },
      },
    } as unknown as PluginRuntime;

    const unregister = registerGoogleChatWebhookTarget({
      account: {
        accountId: "default",
        enabled: true,
        credentialSource: "none",
        config: {
          allowBots: true,
          typingIndicator: "none",
          groups: {
            "spaces/AAA": { users: ["users/alice"], requireMention: false },
          },
        },
      } as ResolvedGoogleChatAccount,
      config: {
        agents: { list: [{ id: "finn", name: "Cosmo" }] },
        channels: { googlechat: {} },
      } as OpenClawConfig,
      runtime: {},
      core,
      path: "/googlechat-context",
      mediaMaxMb: 5,
    });

    try {
      const res = await dispatchWebhookRequest(
        createWebhookRequest({
          authorization: "Bearer test-token",
          path: "/googlechat-context",
          payload: {
            type: "MESSAGE",
            eventTime: "2026-04-28T00:00:00.000Z",
            space: { name: "spaces/AAA", displayName: "Team Room", type: "ROOM" },
            message: {
              name: "spaces/AAA/messages/123",
              text: "hello thread",
              sender: { name: "users/alice", displayName: "Alice" },
              thread: { name: "spaces/AAA/threads/xyz" },
              annotations: [],
            },
          },
        }),
      );

      expect(res.statusCode).toBe(200);
      await vi.waitFor(() => {
        expect(buildContext).toHaveBeenCalledWith(
          expect.objectContaining({
            messageId: "spaces/AAA/messages/123",
            messageIdFull: "spaces/AAA/messages/123",
            reply: expect.objectContaining({
              messageThreadId: "spaces/AAA/threads/xyz",
              replyToId: "spaces/AAA/threads/xyz",
              replyToIdFull: "spaces/AAA/threads/xyz",
            }),
          }),
        );
        expect(run).toHaveBeenCalledWith(
          expect.objectContaining({
            adapter: expect.objectContaining({
              resolveTurn: expect.any(Function),
            }),
          }),
        );
      });
    } finally {
      unregister();
    }
  });

  it("leaves MessageThreadId unset when the inbound message has no thread", async () => {
    vi.mocked(verifyGoogleChatRequest).mockResolvedValue({ ok: true });
    await import("./monitor.js");

    const buildContext = createGoogleChatBuildContextMock();
    const run = vi.fn(async () => ({}));
    const core = {
      logging: { shouldLogVerbose: () => false },
      channel: {
        commands: {
          shouldComputeCommandAuthorized: () => false,
          resolveCommandAuthorizedFromAuthorizers: () => false,
          shouldHandleTextCommands: () => false,
          isControlCommandMessage: () => false,
        },
        text: {
          hasControlCommand: () => false,
          resolveChunkMode: () => "markdown",
          chunkMarkdownTextWithMode: (text: string) => [text],
        },
        routing: {
          resolveAgentRoute: () => ({
            agentId: "finn",
            accountId: "default",
            sessionKey: "agent:finn:googlechat:dm:spaces/DM",
          }),
        },
        session: {
          resolveStorePath: () => "/tmp/openclaw-test-store",
          readSessionUpdatedAt: () => undefined,
          recordSessionMetaFromInbound: vi.fn(async () => {}),
        },
        reply: {
          resolveEnvelopeFormatOptions: () => ({}),
          formatAgentEnvelope: ({ body }: { body: string }) => body,
        },
        turn: {
          buildContext,
          run,
        },
        media: {
          saveMediaBuffer: vi.fn(),
        },
      },
    } as unknown as PluginRuntime;

    const unregister = registerGoogleChatWebhookTarget({
      account: {
        accountId: "default",
        enabled: true,
        credentialSource: "none",
        config: {
          allowBots: true,
          typingIndicator: "none",
          dm: { policy: "allowlist", allowFrom: ["users/alice"] },
        },
      } as ResolvedGoogleChatAccount,
      config: {
        agents: { list: [{ id: "finn", name: "Cosmo" }] },
        channels: { googlechat: {} },
      } as OpenClawConfig,
      runtime: {},
      core,
      path: "/googlechat-context-dm",
      mediaMaxMb: 5,
    });

    try {
      const res = await dispatchWebhookRequest(
        createWebhookRequest({
          authorization: "Bearer test-token",
          path: "/googlechat-context-dm",
          payload: {
            type: "MESSAGE",
            eventTime: "2026-04-28T00:00:00.000Z",
            space: { name: "spaces/DM", type: "DM" },
            message: {
              name: "spaces/DM/messages/789",
              text: "hi",
              sender: { name: "users/alice", displayName: "Alice" },
              annotations: [],
            },
          },
        }),
      );

      expect(res.statusCode).toBe(200);
      await vi.waitFor(() => {
        expect(buildContext).toHaveBeenCalledWith(
          expect.objectContaining({
            messageId: "spaces/DM/messages/789",
            messageIdFull: "spaces/DM/messages/789",
            reply: expect.objectContaining({
              messageThreadId: undefined,
              replyToId: undefined,
              replyToIdFull: undefined,
            }),
          }),
        );
      });
    } finally {
      unregister();
    }
  });
});

describe("Google Chat delivery thread routing", () => {
  afterEach(() => {
    setActivePluginRegistry(createEmptyPluginRegistry());
    sendGoogleChatMessageMock.mockClear();
    updateGoogleChatMessageMock.mockClear();
  });

  function createPluginRuntime(deliverPayload?: {
    text: string;
    replyToId: string;
  }): PluginRuntime {
    const buildContext = createGoogleChatBuildContextMock();
    const run = vi.fn(
      async (params: {
        adapter: {
          resolveTurn: () => {
            delivery: {
              deliver: (payload: { text: string; replyToId: string }) => Promise<void>;
            };
          };
        };
      }) => {
        if (deliverPayload) {
          await params.adapter.resolveTurn().delivery.deliver(deliverPayload);
        }
        return {};
      },
    );

    return {
      logging: { shouldLogVerbose: () => false },
      channel: {
        commands: {
          shouldComputeCommandAuthorized: () => false,
          resolveCommandAuthorizedFromAuthorizers: () => false,
          shouldHandleTextCommands: () => false,
          isControlCommandMessage: () => false,
        },
        text: {
          hasControlCommand: () => false,
          resolveChunkMode: () => "markdown",
          chunkMarkdownTextWithMode: (text: string) => [text],
        },
        routing: {
          resolveAgentRoute: () => ({
            agentId: "finn",
            accountId: "default",
            sessionKey: "agent:finn:googlechat:group:spaces/AAA",
          }),
        },
        session: {
          resolveStorePath: () => "/tmp/openclaw-test-store",
          readSessionUpdatedAt: () => undefined,
          recordSessionMetaFromInbound: vi.fn(async () => {}),
        },
        reply: {
          resolveEnvelopeFormatOptions: () => ({}),
          formatAgentEnvelope: ({ body }: { body: string }) => body,
        },
        turn: {
          buildContext,
          run,
        },
        media: {
          saveMediaBuffer: vi.fn(),
        },
      },
    } as unknown as PluginRuntime;
  }

  const inboundPayload = {
    type: "MESSAGE",
    eventTime: "2026-04-28T00:00:00.000Z",
    space: { name: "spaces/AAA", displayName: "Team Room", type: "ROOM" },
    message: {
      name: "spaces/AAA/messages/123",
      text: "hello",
      sender: { name: "users/alice", displayName: "Alice" },
      thread: { name: "spaces/AAA/threads/xyz" },
      annotations: [],
    },
  };

  const accountConfig = {
    accountId: "default",
    enabled: true,
    credentialSource: "none",
    config: {
      allowBots: true,
      groups: {
        "spaces/AAA": { users: ["users/alice"], requireMention: false },
      },
    },
  } as ResolvedGoogleChatAccount;

  it("threads delivered replies through the inbound thread when replyToId is a message resource", async () => {
    vi.mocked(verifyGoogleChatRequest).mockResolvedValue({ ok: true });
    await import("./monitor.js");

    updateGoogleChatMessageMock.mockRejectedValueOnce(new Error("typing message disappeared"));
    const core = createPluginRuntime({
      text: "threaded reply",
      replyToId: "spaces/AAA/messages/123",
    });

    const unregister = registerGoogleChatWebhookTarget({
      account: accountConfig,
      config: {
        agents: { list: [{ id: "finn", name: "Cosmo" }] },
        channels: { googlechat: {} },
      } as OpenClawConfig,
      runtime: {},
      core,
      path: "/googlechat-delivery-thread",
      mediaMaxMb: 5,
    });

    try {
      const res = await dispatchWebhookRequest(
        createWebhookRequest({
          authorization: "Bearer test-token",
          path: "/googlechat-delivery-thread",
          payload: inboundPayload,
        }),
      );

      expect(res.statusCode).toBe(200);
      await vi.waitFor(() => {
        expect(updateGoogleChatMessageMock).toHaveBeenCalledWith({
          account: expect.objectContaining({ accountId: "default" }),
          messageName: "spaces/AAA/messages/typing",
          text: "threaded reply",
        });
      });
      expect(sendGoogleChatMessageMock).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          text: expect.stringContaining("is typing"),
          thread: "spaces/AAA/threads/xyz",
        }),
      );
      expect(sendGoogleChatMessageMock).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          text: "threaded reply",
          thread: "spaces/AAA/threads/xyz",
        }),
      );
    } finally {
      unregister();
    }
  });
});
