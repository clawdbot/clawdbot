// Line tests cover monitor.lifecycle plugin behavior.
import crypto from "node:crypto";
import { createServer, IncomingMessage, type ServerResponse } from "node:http";
import { Socket } from "node:net";
import type { webhook } from "@line/bot-sdk";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { createMockIncomingRequest } from "openclaw/plugin-sdk/test-env";
import { WEBHOOK_IN_FLIGHT_DEFAULTS } from "openclaw/plugin-sdk/webhook-request-guards";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createLineWebhookSpool } from "./webhook-spool.js";
import { createEvent, withQueue } from "./webhook-spool.test-support.js";

type LineNodeWebhookHandler = (req: IncomingMessage, res: ServerResponse) => Promise<void>;
type LineHandleWebhook = ReturnType<typeof import("./bot.js").createLineBot>["handleWebhook"];
type LineBotOptions = Parameters<typeof import("./bot.js").createLineBot>[0];

const {
  createLineBotMock,
  createLineNodeWebhookHandlerMock,
  registerWebhookTargetWithPluginRouteMock,
  runDetachedWebhookWorkMock,
  unregisterHttpMock,
} = vi.hoisted(() => ({
  createLineBotMock: vi.fn((_options: LineBotOptions) => ({
    account: { accountId: "default" },
    handleWebhook: vi.fn<LineHandleWebhook>().mockResolvedValue("durable"),
    stop: vi.fn(),
  })),
  createLineNodeWebhookHandlerMock: vi.fn<() => LineNodeWebhookHandler>(() =>
    vi.fn<LineNodeWebhookHandler>(async () => {}),
  ),
  registerWebhookTargetWithPluginRouteMock: vi.fn(),
  runDetachedWebhookWorkMock: vi.fn(),
  unregisterHttpMock: vi.fn(),
}));

let monitorLineProvider: typeof import("./monitor.js").monitorLineProvider;
let innerLineWebhookHandlerMock: ReturnType<typeof vi.fn<LineNodeWebhookHandler>>;

type RegisteredRoute = {
  accountId?: string;
  auth?: string;
  handler?: LineNodeWebhookHandler;
  path?: string;
  pluginId?: string;
  replaceExisting?: boolean;
  source?: string;
  throwOnFailure?: boolean;
};

type RegisteredTarget = {
  accountId?: string;
  path: string;
};

type WebhookRegistration = {
  route: RegisteredRoute;
  target: RegisteredTarget;
};

function requireWebhookRegistration(): WebhookRegistration {
  const registration = registerWebhookTargetWithPluginRouteMock.mock.calls[0]?.[0] as
    | WebhookRegistration
    | undefined;
  if (!registration) {
    throw new Error("expected registered LINE webhook target");
  }
  return registration;
}

function requireRegisteredRoute(): { handler: LineNodeWebhookHandler } {
  const route = requireWebhookRegistration().route;
  if (!route.handler) {
    throw new Error("expected registered LINE webhook route");
  }
  return { handler: route.handler };
}

vi.mock("./bot.js", () => ({
  createLineBot: createLineBotMock,
}));

vi.mock("openclaw/plugin-sdk/reply-runtime", () => ({
  chunkMarkdownText: vi.fn(),
  dispatchReplyWithBufferedBlockDispatcher: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/runtime-env", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/runtime-env")>(
    "openclaw/plugin-sdk/runtime-env",
  );
  return {
    ...actual,
    danger: (value: unknown) => String(value),
    logVerbose: vi.fn(),
  };
});

vi.mock("openclaw/plugin-sdk/webhook-ingress", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/webhook-ingress")>(
    "openclaw/plugin-sdk/webhook-ingress",
  );
  return {
    ...actual,
    registerWebhookTargetWithPluginRoute: registerWebhookTargetWithPluginRouteMock,
  };
});

vi.mock("openclaw/plugin-sdk/webhook-request-guards", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/webhook-request-guards")>(
    "openclaw/plugin-sdk/webhook-request-guards",
  );
  runDetachedWebhookWorkMock.mockImplementation(actual.runDetachedWebhookWork);
  return {
    ...actual,
    runDetachedWebhookWork: runDetachedWebhookWorkMock,
  };
});

vi.mock("./webhook-node.js", async () => {
  const actual = await vi.importActual<typeof import("./webhook-node.js")>("./webhook-node.js");
  return {
    ...actual,
    createLineNodeWebhookHandler: createLineNodeWebhookHandlerMock,
  };
});

vi.mock("./auto-reply-delivery.js", () => ({
  deliverLineAutoReply: vi.fn(),
}));

vi.mock("./markdown-to-line.js", () => ({
  processLineMessage: vi.fn(),
}));

vi.mock("./send.js", () => ({
  createFlexMessage: vi.fn(),
  createImageMessage: vi.fn(),
  createLocationMessage: vi.fn(),
  getUserDisplayName: vi.fn(),
  pushMessagesLine: vi.fn(),
  replyMessageLine: vi.fn(),
  showLoadingAnimation: vi.fn(),
}));

vi.mock("./template-messages.js", () => ({
  buildTemplateMessageFromPayload: vi.fn(),
}));

describe("monitorLineProvider lifecycle", () => {
  beforeAll(async () => {
    ({ monitorLineProvider } = await import("./monitor.js"));
  });

  afterAll(() => {
    vi.doUnmock("./bot.js");
    vi.doUnmock("openclaw/plugin-sdk/reply-runtime");
    vi.doUnmock("openclaw/plugin-sdk/runtime-env");
    vi.doUnmock("openclaw/plugin-sdk/webhook-ingress");
    vi.doUnmock("openclaw/plugin-sdk/webhook-request-guards");
    vi.doUnmock("./webhook-node.js");
    vi.doUnmock("./auto-reply-delivery.js");
    vi.doUnmock("./markdown-to-line.js");
    vi.doUnmock("./send.js");
    vi.doUnmock("./template-messages.js");
    vi.resetModules();
  });

  beforeEach(() => {
    createLineBotMock.mockReset();
    createLineBotMock.mockImplementation(() => ({
      account: { accountId: "default" },
      handleWebhook: vi.fn<LineHandleWebhook>().mockResolvedValue("durable"),
      stop: vi.fn(async () => undefined),
    }));
    // Clear call history only; the implementation was wired to the actual
    // helper once in the module mock factory.
    runDetachedWebhookWorkMock.mockClear();
    innerLineWebhookHandlerMock = vi.fn<LineNodeWebhookHandler>(async () => {});
    createLineNodeWebhookHandlerMock
      .mockReset()
      .mockImplementation(() => innerLineWebhookHandlerMock);
    unregisterHttpMock.mockReset();
    registerWebhookTargetWithPluginRouteMock.mockReset().mockImplementation((params) => {
      const withLeadingSlash = params.target.path.startsWith("/")
        ? params.target.path
        : `/${params.target.path}`;
      const key =
        withLeadingSlash
          .replace(/\/{2,}/g, "/")
          .replace(/\/+$/, "")
          .toLowerCase() || "/";
      const normalizedTarget = { ...params.target, path: key };
      const existing = params.targetsByPath.get(key) ?? [];
      params.targetsByPath.set(key, [...existing, normalizedTarget]);
      return {
        target: normalizedTarget,
        unregister: () => {
          unregisterHttpMock();
          const updated = (params.targetsByPath.get(key) ?? []).filter(
            (entry: unknown) => entry !== normalizedTarget,
          );
          if (updated.length > 0) {
            params.targetsByPath.set(key, updated);
          } else {
            params.targetsByPath.delete(key);
          }
        },
      };
    });
  });

  const createRouteResponse = () => {
    const resObj = {
      statusCode: 0,
      headersSent: false,
      setHeader: vi.fn(),
      end: vi.fn(() => {
        resObj.headersSent = true;
      }),
    };
    return resObj as unknown as ServerResponse & { end: ReturnType<typeof vi.fn> };
  };

  it("waits for abort before resolving", async () => {
    const abort = new AbortController();
    const statusSink = vi.fn();
    let resolved = false;

    const task = monitorLineProvider({
      channelAccessToken: "token",
      channelSecret: "secret", // pragma: allowlist secret
      config: {} as OpenClawConfig,
      runtime: {} as RuntimeEnv,
      abortSignal: abort.signal,
      statusSink,
    }).then((monitor) => {
      resolved = true;
      return monitor;
    });

    expect(registerWebhookTargetWithPluginRouteMock).toHaveBeenCalledTimes(1);
    expect(requireWebhookRegistration().route.auth).toBe("plugin");
    await vi.waitFor(() =>
      expect(statusSink).toHaveBeenCalledWith(
        expect.objectContaining({ lifecycle: "ready", connected: true }),
      ),
    );
    expect(resolved).toBe(false);

    abort.abort();
    await task;
    expect(unregisterHttpMock).toHaveBeenCalledTimes(1);
    expect(statusSink).toHaveBeenLastCalledWith(
      expect.objectContaining({ lifecycle: "stopped", running: false }),
    );
  });

  it("registers an account target without replacing existing route ownership", async () => {
    const monitor = await monitorLineProvider({
      channelAccessToken: "token",
      channelSecret: "secret", // pragma: allowlist secret
      accountId: "work",
      config: {} as OpenClawConfig,
      runtime: {} as RuntimeEnv,
    });

    const registration = requireWebhookRegistration();
    expect(registration.target.accountId).toBe("work");
    expect(registration.target.path).toBe("/line/webhook");
    expect(registration.route.accountId).toBe("work");
    expect(registration.route.auth).toBe("plugin");
    expect(registration.route.pluginId).toBe("line");
    expect(registration.route.source).toBe("line-webhook");
    expect(registration.route.throwOnFailure).toBe(true);
    expect(registration.route).not.toHaveProperty("path");
    expect(registration.route).not.toHaveProperty("replaceExisting");
    await monitor.stop();
  });

  it("stops immediately when signal is already aborted", async () => {
    const abort = new AbortController();
    abort.abort();

    await monitorLineProvider({
      channelAccessToken: "token",
      channelSecret: "secret", // pragma: allowlist secret
      config: {} as OpenClawConfig,
      runtime: {} as RuntimeEnv,
      abortSignal: abort.signal,
    });

    expect(unregisterHttpMock).toHaveBeenCalledTimes(1);
  });

  it("returns immediately without abort signal and stop is idempotent", async () => {
    const monitor = await monitorLineProvider({
      channelAccessToken: "token",
      channelSecret: "secret", // pragma: allowlist secret
      config: {} as OpenClawConfig,
      runtime: {} as RuntimeEnv,
    });

    expect(unregisterHttpMock).not.toHaveBeenCalled();
    await monitor.stop();
    await monitor.stop();
    expect(unregisterHttpMock).toHaveBeenCalledTimes(1);
  });

  it("registers the configured defaultAccount when accountId is omitted", async () => {
    const monitor = await monitorLineProvider({
      channelAccessToken: "token",
      channelSecret: "secret", // pragma: allowlist secret
      config: {
        channels: {
          line: {
            defaultAccount: "work",
            accounts: {
              work: {
                channelAccessToken: "work-token",
                channelSecret: "work-secret",
              },
            },
          },
        },
      } as OpenClawConfig,
      runtime: {} as RuntimeEnv,
    });

    const registration = requireWebhookRegistration();
    expect(registration.target.accountId).toBe("work");
    expect(registration.route.accountId).toBe("work");

    await monitor.stop();
  });

  it("does not register a webhook when bot startup fails", async () => {
    createLineBotMock.mockImplementation(() => {
      throw new Error("line bot startup failed");
    });

    await expect(
      monitorLineProvider({
        channelAccessToken: "token",
        channelSecret: "secret", // pragma: allowlist secret
        config: {} as OpenClawConfig,
        runtime: {} as RuntimeEnv,
      }),
    ).rejects.toThrow("line bot startup failed");

    expect(registerWebhookTargetWithPluginRouteMock).not.toHaveBeenCalled();
  });

  it("stops the bot and rejects startup when the webhook route cannot bind", async () => {
    const statusSink = vi.fn();
    registerWebhookTargetWithPluginRouteMock.mockImplementationOnce(() => {
      throw new Error("LINE route conflict");
    });

    await expect(
      monitorLineProvider({
        channelAccessToken: "token",
        channelSecret: "secret", // pragma: allowlist secret
        config: {} as OpenClawConfig,
        runtime: {} as RuntimeEnv,
        statusSink,
      }),
    ).rejects.toThrow("LINE route conflict");

    const bot = createLineBotMock.mock.results[0]?.value as
      | { stop: ReturnType<typeof vi.fn> }
      | undefined;
    expect(bot?.stop).toHaveBeenCalledOnce();
    expect(statusSink).not.toHaveBeenCalledWith(expect.objectContaining({ lifecycle: "ready" }));
  });

  it("resolves a reply's presentation into LINE controls before delivering it", async () => {
    // The turn adapter owns this preparation: core renders presentations inside
    // the outbound send pipeline, which replies delivered here never enter.
    const { setLineRuntime } = await import("./runtime.js");
    type ResolvedTurn = { delivery: { preparePayload?: (payload: ReplyPayload) => ReplyPayload } };
    let resolvedTurn: ResolvedTurn | undefined;
    const runTurn = async (params: {
      adapter: { resolveTurn: () => ResolvedTurn };
    }): Promise<{ dispatched: false }> => {
      resolvedTurn = params.adapter.resolveTurn();
      return { dispatched: false };
    };
    setLineRuntime({
      channel: { inbound: { run: runTurn } },
    } as unknown as Parameters<typeof setLineRuntime>[0]);
    const monitor = await monitorLineProvider({
      channelAccessToken: "token",
      channelSecret: "secret", // pragma: allowlist secret
      config: {} as OpenClawConfig,
      runtime: {} as RuntimeEnv,
    });
    const onMessage = createLineBotMock.mock.calls[0]?.[0]?.onMessage;
    if (!onMessage) {
      throw new Error("expected the LINE bot to receive an inbound message handler");
    }

    try {
      await onMessage(
        {
          ctxPayload: { From: "line:group:C1", MessageSid: "m1", RawBody: "approve?" },
          replyToken: "reply-token",
          route: { accountId: "default", agentId: "main", sessionKey: "line:C1" },
          isGroup: true,
          accountId: "default",
          turn: { record: {} },
        } as unknown as Parameters<typeof onMessage>[0],
        // Admission always hands the turn its live config; an empty one is unreachable.
        { cfg: {} } as Parameters<typeof onMessage>[1],
      );

      const prepared = resolvedTurn?.delivery.preparePayload?.({
        text: "Approve this run?",
        presentation: {
          blocks: [
            {
              type: "buttons",
              buttons: [{ label: "Approve", action: { type: "callback", value: "approve" } }],
            },
          ],
        },
      });
      const line = prepared?.channelData?.line as { flexMessage?: unknown } | undefined;

      expect(prepared?.presentation).toBeUndefined();
      expect(line?.flexMessage).toBeDefined();
    } finally {
      // A leaked registration makes later shared-path signature tests ambiguous.
      await monitor.stop();
    }
  });

  it("paces block replies with the humanDelay the turn's own config carries", async () => {
    // humanDelay lives on the agent, but only the dispatcher can act on it, so a
    // turn that never forwards it paces every block reply at zero.
    const { setLineRuntime } = await import("./runtime.js");
    type ResolvedTurn = { dispatcherOptions?: { humanDelay?: unknown } };
    let resolvedTurn: ResolvedTurn | undefined;
    const runTurn = async (params: {
      adapter: { resolveTurn: () => ResolvedTurn };
    }): Promise<{ dispatched: false }> => {
      resolvedTurn = params.adapter.resolveTurn();
      return { dispatched: false };
    };
    setLineRuntime({
      channel: { inbound: { run: runTurn } },
    } as unknown as Parameters<typeof setLineRuntime>[0]);
    const monitor = await monitorLineProvider({
      channelAccessToken: "token",
      channelSecret: "secret", // pragma: allowlist secret
      config: {} as OpenClawConfig,
      runtime: {} as RuntimeEnv,
    });
    const onMessage = createLineBotMock.mock.calls[0]?.[0]?.onMessage;
    if (!onMessage) {
      throw new Error("expected the LINE bot to receive an inbound message handler");
    }

    try {
      await onMessage(
        {
          ctxPayload: { From: "line:U1", MessageSid: "m1", RawBody: "hi" },
          replyToken: "reply-token",
          route: { accountId: "default", agentId: "ops", sessionKey: "line:U1" },
          isGroup: false,
          accountId: "default",
          turn: { record: {} },
        } as unknown as Parameters<typeof onMessage>[0],
        {
          // The per-agent entry wins, so a turn reading only the defaults would
          // pace at the wrong interval rather than not at all.
          cfg: {
            agents: {
              defaults: { humanDelay: { mode: "natural" } },
              entries: { ops: { humanDelay: { mode: "custom", minMs: 3_000, maxMs: 4_000 } } },
            },
          },
        } as Parameters<typeof onMessage>[1],
      );

      expect(resolvedTurn?.dispatcherOptions?.humanDelay).toEqual({
        mode: "custom",
        minMs: 3_000,
        maxMs: 4_000,
      });
    } finally {
      await monitor.stop();
    }
  });

  it("carries a group's skill scope into the turn that answers it", async () => {
    // The scope is configured per group but enforced per turn: it only applies
    // if the reply options reaching the agent carry it.
    const { setLineRuntime } = await import("./runtime.js");
    type ResolvedTurn = { replyOptions?: { skillFilter?: string[] } };
    let resolvedTurn: ResolvedTurn | undefined;
    const runTurn = async (params: {
      adapter: { resolveTurn: () => ResolvedTurn };
    }): Promise<{ dispatched: false }> => {
      resolvedTurn = params.adapter.resolveTurn();
      return { dispatched: false };
    };
    setLineRuntime({
      channel: { inbound: { run: runTurn } },
    } as unknown as Parameters<typeof setLineRuntime>[0]);
    const monitor = await monitorLineProvider({
      channelAccessToken: "token",
      channelSecret: "secret", // pragma: allowlist secret
      config: {} as OpenClawConfig,
      runtime: {} as RuntimeEnv,
    });
    const onMessage = createLineBotMock.mock.calls[0]?.[0]?.onMessage;
    if (!onMessage) {
      throw new Error("expected the LINE bot to receive an inbound message handler");
    }

    try {
      await onMessage(
        {
          ctxPayload: { From: "line:group:C1", MessageSid: "m1", RawBody: "hi" },
          route: { accountId: "default", agentId: "main", sessionKey: "line:C1" },
          isGroup: true,
          accountId: "default",
          skillFilter: ["triage"],
          turn: { record: {} },
        } as unknown as Parameters<typeof onMessage>[0],
        // Admission always hands the turn its live config; an empty one is unreachable.
        { cfg: {} } as Parameters<typeof onMessage>[1],
      );

      expect(resolvedTurn?.replyOptions?.skillFilter).toEqual(["triage"]);
    } finally {
      // A leaked registration makes later shared-path signature tests ambiguous.
      await monitor.stop();
    }
  });

  it("dispatches shared-path webhook posts to the account matching the signature", async () => {
    const firstMonitor = await monitorLineProvider({
      channelAccessToken: "first-token",
      channelSecret: "first-secret", // pragma: allowlist secret
      accountId: "first",
      config: {} as OpenClawConfig,
      runtime: {} as RuntimeEnv,
    });
    const secondMonitor = await monitorLineProvider({
      channelAccessToken: "second-token",
      channelSecret: "second-secret", // pragma: allowlist secret
      accountId: "second",
      config: {} as OpenClawConfig,
      runtime: {} as RuntimeEnv,
    });

    const route = requireRegisteredRoute();

    const payload = JSON.stringify({ events: [{ type: "message" }] });
    const signature = crypto.createHmac("SHA256", "second-secret").update(payload).digest("base64");
    const req = Object.assign(createMockIncomingRequest([payload]), {
      method: "POST",
      headers: { "x-line-signature": signature },
    }) as unknown as IncomingMessage;
    const res = createRouteResponse();

    await route.handler(req, res);

    const firstBot = createLineBotMock.mock.results[0]?.value as {
      handleWebhook: ReturnType<typeof vi.fn>;
    };
    const secondBot = createLineBotMock.mock.results[1]?.value as {
      handleWebhook: ReturnType<typeof vi.fn>;
    };
    expect(res.statusCode).toBe(200);
    expect(firstBot.handleWebhook).not.toHaveBeenCalled();
    expect(secondBot.handleWebhook).toHaveBeenCalledTimes(1);

    await firstMonitor.stop();
    await secondMonitor.stop();
  });

  it("marks only durably admitted signed HTTP webhooks and redacts failures", async () => {
    const runtimeError = vi.fn<(...args: unknown[]) => void>();
    const runtime: RuntimeEnv = {
      log: vi.fn<(...args: unknown[]) => void>(),
      error: runtimeError,
      exit: vi.fn<(code: number) => void>(),
    };
    const monitor = await monitorLineProvider({
      channelAccessToken: "token",
      channelSecret: "secret", // pragma: allowlist secret
      accountId: "default",
      config: {} as OpenClawConfig,
      runtime,
    });
    const route = requireRegisteredRoute();
    const server = createServer((req, res) => {
      void route.handler(req, res);
    });

    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
          server.removeListener("error", reject);
          resolve();
        });
      });
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("expected LINE webhook test server to have a TCP address");
      }

      const webhookUrl = `http://127.0.0.1:${address.port}/line/webhook`;
      const payload = JSON.stringify({ events: [{ type: "message" }] });
      const rejected = await fetch(webhookUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-line-signature": "invalid-signature",
        },
        body: payload,
      });
      expect(rejected.status).toBe(401);
      expect(rejected.headers.get("x-openclaw-delivery-accepted")).toBeNull();
      expect(await rejected.json()).toEqual({ error: "Invalid signature" });

      const bot = createLineBotMock.mock.results[0]?.value;
      if (!bot) {
        throw new Error("expected registered LINE webhook bot");
      }
      expect(bot.handleWebhook).not.toHaveBeenCalled();

      const verificationPayload = JSON.stringify({ events: [] });
      const verificationSignature = crypto
        .createHmac("SHA256", "secret")
        .update(verificationPayload)
        .digest("base64");
      const verification = await fetch(webhookUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-line-signature": verificationSignature,
        },
        body: verificationPayload,
      });
      expect(verification.status).toBe(200);
      expect(verification.headers.get("x-openclaw-delivery-accepted")).toBeNull();
      expect(await verification.json()).toEqual({ status: "ok" });
      expect(bot.handleWebhook).not.toHaveBeenCalled();

      let releaseAdmission: (() => void) | undefined;
      bot.handleWebhook.mockImplementationOnce(
        () =>
          new Promise<Awaited<ReturnType<LineHandleWebhook>>>((resolve) => {
            releaseAdmission = () => resolve("durable");
          }),
      );
      const signature = crypto.createHmac("SHA256", "secret").update(payload).digest("base64");
      let acceptedResponseReceived = false;
      const acceptedRequest = fetch(webhookUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-line-signature": signature,
        },
        body: payload,
      }).then((response) => {
        acceptedResponseReceived = true;
        return response;
      });
      await vi.waitFor(() => {
        expect(bot.handleWebhook).toHaveBeenCalledTimes(1);
      });
      expect(acceptedResponseReceived).toBe(false);
      if (!releaseAdmission) {
        throw new Error("expected pending LINE durable admission");
      }
      releaseAdmission();
      const accepted = await acceptedRequest;
      expect(accepted.status).toBe(200);
      expect(accepted.headers.get("x-openclaw-delivery-accepted")).toBe("durable");
      expect(await accepted.json()).toEqual({ status: "ok" });

      const bearerToken = "test_line_access_token_1234567890";
      bot.handleWebhook.mockRejectedValueOnce({
        code: "LINE_ADMISSION_REJECTED",
        retryAfterMs: 250,
        authorization: `Bearer ${bearerToken}`,
      });
      const response = await fetch(webhookUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-line-signature": signature,
        },
        body: payload,
      });

      expect(response.status).toBe(500);
      expect(response.headers.get("x-openclaw-delivery-accepted")).toBeNull();
      expect(await response.json()).toEqual({ error: "Internal server error" });
      expect(bot.handleWebhook).toHaveBeenCalledTimes(2);
      expect(runtimeError).toHaveBeenCalledTimes(1);
      const message = String(runtimeError.mock.calls[0]?.[0]);
      expect(message).toContain("line webhook error:");
      expect(message).toContain("LINE_ADMISSION_REJECTED");
      expect(message).toContain("retryAfterMs");
      expect(message).not.toContain("[object Object]");
      expect(message).not.toContain(bearerToken);

      // Keep the HTTP receipt tied to the real queue, including deliberate non-admission.
      await withQueue(async (queue) => {
        const delivered: webhook.Event[] = [];
        const spool = createLineWebhookSpool({
          accountId: "default",
          runtime,
          queue,
          deliver: async (event, _destination, control) => {
            delivered.push(event);
            await control.turnAdoptionLifecycle.onAdopted();
          },
        });
        bot.handleWebhook.mockImplementation(spool.accept);
        const active = createEvent({ webhookEventId: "receipt-active" });
        const standby = createEvent({ webhookEventId: "receipt-standby", mode: "standby" });
        const common = {
          mode: "standby" as const,
          timestamp: Date.now(),
          deliveryContext: { isRedelivery: false },
        };
        const postback: webhook.Event = {
          ...common,
          type: "postback",
          webhookEventId: "receipt-postback",
          source: { type: "user", userId: "user-standby" },
          postback: { data: "continue" },
        };
        const join = {
          ...common,
          type: "join",
          webhookEventId: "receipt-join",
          source: { type: "group", groupId: "group-standby" },
        };
        try {
          for (const [events, expectedIds, marker] of [
            [[standby, postback, join], [], null],
            [[standby, active], ["message:message-receipt-active"], "durable"],
            [[active], ["message:message-receipt-active"], "durable"],
          ] as const) {
            const body = JSON.stringify({ destination: "fixture-bot", events });
            const admittedResponse = await fetch(webhookUrl, {
              method: "POST",
              headers: {
                "content-type": "application/json",
                "x-line-signature": crypto
                  .createHmac("SHA256", "secret")
                  .update(body)
                  .digest("base64"),
              },
              body,
            });
            expect(admittedResponse.status).toBe(200);
            expect((await queue.listPending()).map((entry) => entry.id)).toEqual(expectedIds);
            expect(admittedResponse.headers.get("x-openclaw-delivery-accepted")).toBe(marker);
            expect(await admittedResponse.json()).toEqual({ status: "ok" });
          }
          spool.start();
          await vi.waitFor(() => expect(delivered).toEqual([active]));
        } finally {
          await spool.stop();
        }
      });
    } finally {
      try {
        if (server.listening) {
          await new Promise<void>((resolve, reject) => {
            server.close((error) => {
              if (error) {
                reject(error);
                return;
              }
              resolve();
            });
          });
        }
      } finally {
        await monitor.stop();
      }
    }
  });

  it("dispatches a signed POST through the canonical configured webhook route", async () => {
    const monitor = await monitorLineProvider({
      channelAccessToken: "token",
      channelSecret: "secret", // pragma: allowlist secret
      webhookPath: "/Line//Webhook/",
      accountId: "default",
      config: {} as OpenClawConfig,
      runtime: {} as RuntimeEnv,
    });

    const registration = requireWebhookRegistration();
    expect(registration.target.path).toBe("/Line//Webhook");

    const route = requireRegisteredRoute();
    const payload = JSON.stringify({ events: [{ type: "message" }] });
    const signature = crypto.createHmac("SHA256", "secret").update(payload).digest("base64");
    const req = Object.assign(createMockIncomingRequest([payload]), {
      method: "POST",
      headers: { "x-line-signature": signature },
    }) as unknown as IncomingMessage;
    const res = createRouteResponse();

    await route.handler(req, res);

    const bot = createLineBotMock.mock.results[0]?.value as {
      handleWebhook: ReturnType<typeof vi.fn>;
    };
    expect(res.statusCode).toBe(200);
    expect(bot.handleWebhook).toHaveBeenCalledTimes(1);

    await monitor.stop();
  });

  it("durably admits matched events before acknowledging", async () => {
    const monitor = await monitorLineProvider({
      channelAccessToken: "token",
      channelSecret: "secret", // pragma: allowlist secret
      accountId: "default",
      config: {} as OpenClawConfig,
      runtime: {} as RuntimeEnv,
    });

    const route = requireRegisteredRoute();
    const payload = JSON.stringify({ events: [{ type: "message" }] });
    const signature = crypto.createHmac("SHA256", "secret").update(payload).digest("base64");
    const req = Object.assign(createMockIncomingRequest([payload]), {
      method: "POST",
      headers: { "x-line-signature": signature },
    }) as unknown as IncomingMessage;
    const res = createRouteResponse();

    await route.handler(req, res);

    const bot = createLineBotMock.mock.results[0]?.value as {
      handleWebhook: ReturnType<typeof vi.fn>;
    };
    expect(res.statusCode).toBe(200);
    expect(runDetachedWebhookWorkMock).not.toHaveBeenCalled();
    expect(bot.handleWebhook).toHaveBeenCalledTimes(1);

    await monitor.stop();
  });

  it("waits for shared-path durable admission before acknowledging", async () => {
    const monitor = await monitorLineProvider({
      channelAccessToken: "token",
      channelSecret: "secret", // pragma: allowlist secret
      accountId: "default",
      config: {} as OpenClawConfig,
      runtime: {} as RuntimeEnv,
    });

    let releaseWebhook: (() => void) | undefined;
    const bot = createLineBotMock.mock.results[0]?.value as {
      handleWebhook: ReturnType<typeof vi.fn<LineHandleWebhook>>;
    };
    bot.handleWebhook.mockImplementation(
      () =>
        new Promise<Awaited<ReturnType<LineHandleWebhook>>>((resolve) => {
          releaseWebhook = () => resolve("durable");
        }),
    );

    const route = requireRegisteredRoute();
    const payload = JSON.stringify({ events: [{ type: "message" }] });
    const signature = crypto.createHmac("SHA256", "secret").update(payload).digest("base64");
    const req = Object.assign(createMockIncomingRequest([payload]), {
      method: "POST",
      headers: { "x-line-signature": signature },
    }) as unknown as IncomingMessage;
    const res = createRouteResponse();

    const request = route.handler(req, res);
    await vi.waitFor(() => {
      expect(bot.handleWebhook).toHaveBeenCalledTimes(1);
    });
    expect(res.headersSent).toBe(false);
    expect(bot.handleWebhook).toHaveBeenCalledTimes(1);
    if (!releaseWebhook) {
      throw new Error("expected pending LINE webhook handler");
    }
    releaseWebhook();
    await request;
    expect(res.statusCode).toBe(200);
    expect(res.headersSent).toBe(true);
    await monitor.stop();
  });

  it("rejects ambiguous shared-path webhook signatures", async () => {
    const firstMonitor = await monitorLineProvider({
      channelAccessToken: "first-token",
      channelSecret: "shared-secret", // pragma: allowlist secret
      accountId: "first",
      config: {} as OpenClawConfig,
      runtime: {} as RuntimeEnv,
    });
    const secondMonitor = await monitorLineProvider({
      channelAccessToken: "second-token",
      channelSecret: "shared-secret", // pragma: allowlist secret
      accountId: "second",
      config: {} as OpenClawConfig,
      runtime: {} as RuntimeEnv,
    });

    const route = requireRegisteredRoute();

    const payload = JSON.stringify({ events: [{ type: "message" }] });
    const signature = crypto.createHmac("SHA256", "shared-secret").update(payload).digest("base64");
    const req = Object.assign(createMockIncomingRequest([payload]), {
      method: "POST",
      headers: { "x-line-signature": signature },
    }) as unknown as IncomingMessage;
    const res = createRouteResponse();

    await route.handler(req, res);

    const firstBot = createLineBotMock.mock.results[0]?.value as {
      handleWebhook: ReturnType<typeof vi.fn>;
    };
    const secondBot = createLineBotMock.mock.results[1]?.value as {
      handleWebhook: ReturnType<typeof vi.fn>;
    };
    expect(res.statusCode).toBe(401);
    expect(res.end).toHaveBeenCalledWith(JSON.stringify({ error: "Ambiguous webhook target" }));
    expect(firstBot.handleWebhook).not.toHaveBeenCalled();
    expect(secondBot.handleWebhook).not.toHaveBeenCalled();

    await firstMonitor.stop();
    await secondMonitor.stop();
  });

  it("rejects webhook requests above the shared in-flight limit before body handling", async () => {
    const limit = WEBHOOK_IN_FLIGHT_DEFAULTS.maxInFlightPerKey;
    const heldRequests: IncomingMessage[] = [];

    const monitor = await monitorLineProvider({
      channelAccessToken: "token",
      channelSecret: "secret", // pragma: allowlist secret
      config: {} as OpenClawConfig,
      runtime: {} as RuntimeEnv,
    });

    const route = requireRegisteredRoute();
    const createHeldPostRequest = () => {
      const req = new IncomingMessage(new Socket());
      heldRequests.push(req);
      return Object.assign(req, {
        method: "POST",
        headers: { "x-line-signature": "pending" },
      }) as unknown as IncomingMessage;
    };
    const createSignedPostRequest = () => {
      const payload = JSON.stringify({ events: [{ type: "message" }] });
      const signature = crypto.createHmac("SHA256", "secret").update(payload).digest("base64");
      const req = createMockIncomingRequest([payload]);
      return Object.assign(req, {
        method: "POST",
        headers: { "x-line-signature": signature },
      }) as unknown as IncomingMessage;
    };

    const firstRequests = Array.from({ length: limit }, () =>
      route.handler(createHeldPostRequest(), createRouteResponse()),
    );
    await new Promise((resolve) => {
      setImmediate(resolve);
    });

    const overflowResponse = createRouteResponse();
    await route.handler(createSignedPostRequest(), overflowResponse);

    const bot = createLineBotMock.mock.results[0]?.value as {
      handleWebhook: ReturnType<typeof vi.fn>;
    };
    expect(bot.handleWebhook).not.toHaveBeenCalled();
    expect(overflowResponse.statusCode).toBe(429);
    expect(overflowResponse.end).toHaveBeenCalledWith("Too Many Requests");

    heldRequests.splice(0).forEach((req) => req.destroy());
    await Promise.allSettled(firstRequests);
    await monitor.stop();
  });
});
