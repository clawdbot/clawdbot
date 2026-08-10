// Exercise typing ownership from a real inbound webhook through authenticated Chat HTTP.
import { generateKeyPairSync } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createReplyDispatcher } from "openclaw/plugin-sdk/reply-runtime";
import { withServer } from "openclaw/plugin-sdk/test-env";
import {
  createFixedWindowRateLimiter,
  createWebhookInFlightLimiter,
  WEBHOOK_RATE_LIMIT_DEFAULTS,
} from "openclaw/plugin-sdk/webhook-ingress";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../runtime-api.js";
import type { ResolvedGoogleChatAccount } from "./accounts.js";
import { sendGoogleChatMessage } from "./api.js";
import type { GoogleChatIngressLifecycle } from "./monitor-ingress.js";
import type { GoogleChatCoreRuntime, WebhookTarget } from "./monitor-types.js";
import { createGoogleChatWebhookRequestHandler } from "./monitor-webhook.js";
import "./monitor.js";
import type { GoogleChatEvent } from "./types.js";

const monitorMocks = vi.hoisted(() => ({
  processEvent: undefined as
    | ((
        event: GoogleChatEvent,
        target: WebhookTarget,
        lifecycle?: GoogleChatIngressLifecycle,
      ) => Promise<void>)
    | undefined,
  verifyGoogleChatRequest: vi.fn(async () => ({ ok: true as const })),
}));

vi.mock("./auth.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./auth.js")>()),
  verifyGoogleChatRequest: monitorMocks.verifyGoogleChatRequest,
}));

vi.mock("./monitor-access.js", () => ({
  applyGoogleChatInboundAccessPolicy: vi.fn(async () => ({
    ok: true,
    commandAuthorized: undefined,
    effectiveWasMentioned: undefined,
    groupBotLoopProtection: undefined,
    groupSystemPrompt: undefined,
  })),
}));

vi.mock("./monitor-routing.js", () => ({
  registerGoogleChatWebhookTarget: vi.fn(),
  setGoogleChatWebhookEventProcessor: vi.fn(
    (processEvent: (event: GoogleChatEvent, target: WebhookTarget) => Promise<void>) => {
      monitorMocks.processEvent = processEvent;
    },
  ),
}));

vi.mock("openclaw/plugin-sdk/channel-inbound", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/channel-inbound")>()),
  resolveChannelInboundRouteEnvelope: ({ accountId }: { accountId: string }) => ({
    route: { agentId: "agent-1", accountId, sessionKey: "googlechat-session-1" },
    buildEnvelope: ({ body }: { body: string }) => body,
  }),
}));

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const proofAccessToken = "ya29.googlechat-typing-integration-token";
const typingResource = "spaces/AAA/messages/typing";
const incomingResource = "spaces/AAA/messages/inbound";

type TurnMode =
  | "silent"
  | "visible"
  | "deferred-visible"
  | "deferred-silent"
  | "deferred-abandoned"
  | "turn-error"
  | "later-chunk-error"
  | "message-tool-only"
  | "fallback-then-final";

type ChatRequest = {
  method: string;
  pathname: string;
  text?: string;
  authorization?: string;
  status: number;
};

type StubOptions = {
  deleteStatus?: number;
  failPatch?: boolean;
  failSecondChunk?: boolean;
};

function createGoogleStub(options: StubOptions = {}) {
  const requests: ChatRequest[] = [];
  const tokenAssertions: string[] = [];
  const handler = (request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const url = new URL(request.url ?? "/", "http://stub.invalid");
      const body = Buffer.concat(chunks).toString("utf8");
      const json = (status: number, value: unknown) => {
        response.statusCode = status;
        response.setHeader("Content-Type", "application/json");
        response.end(JSON.stringify(value));
      };

      if (request.method === "POST" && url.pathname === "/token") {
        tokenAssertions.push(new URLSearchParams(body).get("assertion") ?? "");
        json(200, { access_token: proofAccessToken, token_type: "Bearer", expires_in: 3600 });
        return;
      }

      const payload = body ? (JSON.parse(body) as { text?: string }) : {};
      const failingPatch = options.failPatch && request.method === "PATCH";
      const failingSecondChunk = options.failSecondChunk && payload.text === "Second visible chunk";
      const status =
        request.method === "DELETE"
          ? (options.deleteStatus ?? 204)
          : failingPatch || failingSecondChunk
            ? 500
            : 200;
      requests.push({
        method: request.method ?? "",
        pathname: url.pathname,
        text: payload.text,
        authorization: request.headers.authorization,
        status,
      });

      if (status === 204) {
        response.writeHead(204);
        response.end();
        return;
      }
      if (status >= 400) {
        json(status, { error: { message: "stub: Google Chat transport unavailable" } });
        return;
      }
      const name =
        request.method === "POST" && payload.text === "_OpenClaw is typing..._"
          ? typingResource
          : request.method === "PATCH"
            ? typingResource
            : "spaces/AAA/messages/message-tool";
      json(status, { name });
    });
  };
  return { handler, requests, tokenAssertions };
}

function rerouteGoogleFetch() {
  const realFetch = globalThis.fetch;
  let googleBaseUrl = "";
  const redirectedFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const rawUrl = input instanceof Request ? input.url : String(input);
    const url = new URL(rawUrl);
    if (url.hostname === "chat.googleapis.com" || url.hostname === "oauth2.googleapis.com") {
      if (!googleBaseUrl) {
        throw new Error("Google Chat integration stub is not listening");
      }
      return await realFetch(`${googleBaseUrl}${url.pathname}${url.search}`, init);
    }
    return await realFetch(input, init);
  });
  // The guarded transport recognizes Vitest mocks and skips external DNS while preserving host policy.
  vi.stubGlobal("fetch", redirectedFetch);
  return { pointAt: (baseUrl: string) => (googleBaseUrl = baseUrl) };
}

function createAccount(id: string): ResolvedGoogleChatAccount {
  return {
    accountId: `typing-cleanup-${id}`,
    enabled: true,
    credentialSource: "inline",
    credentials: {
      type: "service_account",
      client_email: "stub-bot@stub-project.iam.gserviceaccount.com",
      private_key: privateKey.export({ type: "pkcs8", format: "pem" }),
      auth_uri: "https://accounts.google.com/o/oauth2/auth",
      token_uri: "https://oauth2.googleapis.com/token",
      auth_provider_x509_cert_url: "https://www.googleapis.com/oauth2/v1/certs",
      client_x509_cert_url:
        "https://www.googleapis.com/robot/v1/metadata/x509/stub-bot%40stub-project.iam.gserviceaccount.com",
    },
    config: { typingIndicator: "message" },
  };
}

type TurnArgs = {
  turnAdoptionLifecycle?: GoogleChatIngressLifecycle & {
    onSettled?: () => void;
  };
  adapter: {
    resolveTurn: () => {
      delivery: {
        durable: (
          payload: { text?: string },
          info: { kind: "tool" | "block" | "final" },
        ) => false | { to: string; replyToId?: string | null; threadId?: string };
        deliver: (payload: { text?: string }) => Promise<void>;
        onDelivered: () => void;
        onError: (error: unknown, info: { kind: "tool" | "block" | "final" }) => void;
      };
    };
  };
};

function createCore(mode: TurnMode, account: ResolvedGoogleChatAccount) {
  const dispatch = {
    accepted: undefined as boolean | undefined,
    durableDecisions: [] as Array<
      false | { to: string; replyToId?: string | null; threadId?: string }
    >,
    failed: 0,
    resumeDeferred: undefined as (() => Promise<void>) | undefined,
  };
  const run = vi.fn(async ({ adapter, turnAdoptionLifecycle }: TurnArgs) => {
    if (mode === "turn-error") {
      throw new Error("stub: model turn failed");
    }
    const { delivery } = adapter.resolveTurn();
    const dispatchReply = async () => {
      const dispatcher = createReplyDispatcher({
        deliver: async (payload, info) => {
          dispatch.durableDecisions.push(delivery.durable(payload, info));
          await delivery.deliver(payload);
          delivery.onDelivered();
        },
        onError: delivery.onError,
      });
      try {
        if (mode === "message-tool-only") {
          await sendGoogleChatMessage({
            account,
            space: "spaces/AAA",
            text: "Visible message tool answer",
          });
        }
        if (mode === "fallback-then-final") {
          dispatcher.sendBlockReply({ text: "First assistant answer" });
          dispatch.accepted = dispatcher.sendFinalReply({ text: "Second assistant answer" });
        } else {
          const silent =
            mode === "silent" || mode === "deferred-silent" || mode === "message-tool-only";
          dispatch.accepted = dispatcher.sendFinalReply({
            text: silent ? "NO_REPLY" : "Visible assistant answer",
          });
        }
      } finally {
        dispatcher.markComplete();
        await dispatcher.waitForIdle();
        dispatch.failed = dispatcher.getFailedCounts().final;
      }
    };
    if (mode.startsWith("deferred-")) {
      turnAdoptionLifecycle?.onDeferred();
      dispatch.resumeDeferred = async () => {
        try {
          if (mode === "deferred-abandoned") {
            await turnAdoptionLifecycle?.onAbandoned();
          } else {
            await turnAdoptionLifecycle?.onAdopted();
            await dispatchReply();
          }
        } finally {
          turnAdoptionLifecycle?.onSettled?.();
        }
      };
      return;
    }
    await dispatchReply();
  });
  const core = {
    logging: { shouldLogVerbose: () => false },
    channel: {
      inbound: { buildContext: (payload: unknown) => payload, run },
      text: {
        resolveChunkMode: () => "markdown",
        chunkMarkdownTextWithMode: (text: string) =>
          mode === "later-chunk-error" ? ["First visible chunk", "Second visible chunk"] : [text],
      },
    },
  } as unknown as GoogleChatCoreRuntime;
  return { core, dispatch, run };
}

async function runWebhookTurn(params: {
  mode: TurnMode;
  id: string;
  stub?: StubOptions;
  afterAccepted?: (state: {
    requests: ChatRequest[];
    resumeDeferred: () => Promise<void>;
  }) => Promise<void>;
}) {
  const account = createAccount(params.id);
  const errors: string[] = [];
  const runtime = { error: (message: string) => errors.push(message), log: vi.fn() };
  const { core, dispatch, run } = createCore(params.mode, account);
  const google = createGoogleStub(params.stub);
  const fetchRouting = rerouteGoogleFetch();
  const ingressLifecycle: GoogleChatIngressLifecycle & { onSettled: ReturnType<typeof vi.fn> } = {
    admission: "exclusive",
    abortSignal: new AbortController().signal,
    onAdopted: vi.fn(async () => {}),
    onDeferred: vi.fn(),
    onAbandoned: vi.fn(async () => {}),
    onSettled: vi.fn(),
  };
  let webhookStatus = 0;
  let durableHeader: string | null = null;

  await withServer(google.handler, async (googleBaseUrl) => {
    fetchRouting.pointAt(googleBaseUrl);
    const target: WebhookTarget = {
      account,
      config: {} as OpenClawConfig,
      runtime,
      core,
      path: "/googlechat",
      audienceType: "app-url",
      audience: "https://example.com/googlechat",
      mediaMaxMb: 10,
      ingress: {
        receive: async (raw) => {
          if (!monitorMocks.processEvent) {
            throw new Error("Google Chat production event processor was not registered");
          }
          // Durable persistence is outside the typing owner; replay the admitted event immediately.
          await monitorMocks.processEvent(
            raw as GoogleChatEvent,
            target,
            params.mode.startsWith("deferred-") ? ingressLifecycle : undefined,
          );
          return { kind: "durable" as const };
        },
      },
    };
    const handler = createGoogleChatWebhookRequestHandler({
      webhookTargets: new Map([[target.path, [target]]]),
      webhookRateLimiter: createFixedWindowRateLimiter(WEBHOOK_RATE_LIMIT_DEFAULTS),
      webhookInFlightLimiter: createWebhookInFlightLimiter(),
      processEvent: async (event, eventTarget) => {
        await monitorMocks.processEvent?.(event, eventTarget);
      },
    });

    await withServer(
      (request, response) => void handler(request, response),
      async (webhookUrl) => {
        const response = await fetch(`${webhookUrl}/googlechat`, {
          method: "POST",
          headers: {
            Authorization: "Bearer inbound-google-chat-webhook-token",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            type: "MESSAGE",
            space: { name: "spaces/AAA", type: "DM" },
            message: {
              name: incomingResource,
              text: "Hello from the real Google Chat webhook",
              sender: { name: "users/alice", displayName: "Alice", type: "HUMAN" },
            },
          } satisfies GoogleChatEvent),
        });
        webhookStatus = response.status;
        durableHeader = response.headers.get("x-openclaw-delivery-accepted");
        await response.text();
        if (params.afterAccepted) {
          if (!dispatch.resumeDeferred) {
            throw new Error("Deferred Google Chat turn was not captured");
          }
          await params.afterAccepted({
            requests: google.requests,
            resumeDeferred: dispatch.resumeDeferred,
          });
        }
      },
    );
  });

  return {
    ...google,
    account,
    dispatch,
    durableHeader,
    errors,
    ingressLifecycle,
    run,
    webhookStatus,
  };
}

function requestShape(requests: ChatRequest[]) {
  return requests.map(({ method, pathname, text }) => ({
    method,
    pathname,
    ...(text === undefined ? {} : { text }),
  }));
}

describe("Google Chat typing placeholder ownership through real HTTP", () => {
  beforeEach(() => {
    monitorMocks.verifyGoogleChatRequest.mockClear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("deletes only the bot typing placeholder when the real dispatcher suppresses NO_REPLY", async () => {
    const result = await runWebhookTurn({ mode: "silent", id: "silent" });

    expect(result.webhookStatus).toBe(200);
    expect(result.durableHeader).toBe("durable");
    expect(monitorMocks.verifyGoogleChatRequest).toHaveBeenCalledWith({
      bearer: "inbound-google-chat-webhook-token",
      audienceType: "app-url",
      audience: "https://example.com/googlechat",
      expectedAddOnPrincipal: undefined,
    });
    expect(result.run).toHaveBeenCalledOnce();
    expect(result.dispatch.accepted).toBe(false);
    expect(result.tokenAssertions).toHaveLength(1);
    expect(result.tokenAssertions[0]?.split(".")).toHaveLength(3);
    expect(requestShape(result.requests)).toEqual([
      { method: "POST", pathname: "/v1/spaces/AAA/messages", text: "_OpenClaw is typing..._" },
      { method: "DELETE", pathname: `/v1/${typingResource}` },
    ]);
    expect(
      result.requests.every(({ authorization }) => authorization === `Bearer ${proofAccessToken}`),
    ).toBe(true);
    expect(result.requests.some(({ pathname }) => pathname.includes(incomingResource))).toBe(false);
  });

  it("edits a typing placeholder into the visible reply without deleting it", async () => {
    const result = await runWebhookTurn({ mode: "visible", id: "visible" });

    expect(result.webhookStatus).toBe(200);
    expect(result.dispatch.accepted).toBe(true);
    expect(requestShape(result.requests)).toEqual([
      { method: "POST", pathname: "/v1/spaces/AAA/messages", text: "_OpenClaw is typing..._" },
      { method: "PATCH", pathname: `/v1/${typingResource}`, text: "Visible assistant answer" },
    ]);
  });

  it("deletes queued typing only after a deferred silent turn settles", async () => {
    const result = await runWebhookTurn({
      mode: "deferred-silent",
      id: "deferred-silent",
      afterAccepted: async ({ requests, resumeDeferred }) => {
        expect(requestShape(requests)).toEqual([
          { method: "POST", pathname: "/v1/spaces/AAA/messages", text: "_OpenClaw is typing..._" },
        ]);
        await resumeDeferred();
        await vi.waitFor(() => {
          expect(requestShape(requests)).toEqual([
            {
              method: "POST",
              pathname: "/v1/spaces/AAA/messages",
              text: "_OpenClaw is typing..._",
            },
            { method: "DELETE", pathname: `/v1/${typingResource}` },
          ]);
        });
      },
    });

    expect(result.webhookStatus).toBe(200);
    expect(result.dispatch.accepted).toBe(false);
    expect(result.ingressLifecycle.onAdopted).toHaveBeenCalledOnce();
    expect(result.ingressLifecycle.onSettled).toHaveBeenCalledOnce();
  });

  it("deletes queued typing when deferred ownership is abandoned without a reply", async () => {
    const result = await runWebhookTurn({
      mode: "deferred-abandoned",
      id: "deferred-abandoned",
      afterAccepted: async ({ requests, resumeDeferred }) => {
        expect(requestShape(requests)).toEqual([
          { method: "POST", pathname: "/v1/spaces/AAA/messages", text: "_OpenClaw is typing..._" },
        ]);
        await resumeDeferred();
        await vi.waitFor(() => {
          expect(requestShape(requests)).toEqual([
            {
              method: "POST",
              pathname: "/v1/spaces/AAA/messages",
              text: "_OpenClaw is typing..._",
            },
            { method: "DELETE", pathname: `/v1/${typingResource}` },
          ]);
        });
      },
    });

    expect(result.webhookStatus).toBe(200);
    expect(result.ingressLifecycle.onAdopted).not.toHaveBeenCalled();
    expect(result.ingressLifecycle.onAbandoned).toHaveBeenCalledOnce();
    expect(result.ingressLifecycle.onSettled).toHaveBeenCalledOnce();
  });

  it("keeps a queued typing placeholder until the deferred turn delivers its visible reply", async () => {
    const result = await runWebhookTurn({
      mode: "deferred-visible",
      id: "deferred-visible",
      afterAccepted: async ({ requests, resumeDeferred }) => {
        expect(requestShape(requests)).toEqual([
          { method: "POST", pathname: "/v1/spaces/AAA/messages", text: "_OpenClaw is typing..._" },
        ]);
        await resumeDeferred();
      },
    });

    expect(result.webhookStatus).toBe(200);
    expect(result.dispatch.accepted).toBe(true);
    expect(result.ingressLifecycle.onDeferred).toHaveBeenCalledOnce();
    expect(result.ingressLifecycle.onAdopted).toHaveBeenCalledOnce();
    expect(result.ingressLifecycle.onSettled).toHaveBeenCalledOnce();
    expect(requestShape(result.requests)).toEqual([
      { method: "POST", pathname: "/v1/spaces/AAA/messages", text: "_OpenClaw is typing..._" },
      { method: "PATCH", pathname: `/v1/${typingResource}`, text: "Visible assistant answer" },
    ]);
  });

  it("cleans up the typing placeholder when the model turn fails", async () => {
    const result = await runWebhookTurn({ mode: "turn-error", id: "turn-error" });

    expect(result.webhookStatus).toBe(503);
    expect(requestShape(result.requests)).toEqual([
      { method: "POST", pathname: "/v1/spaces/AAA/messages", text: "_OpenClaw is typing..._" },
      { method: "DELETE", pathname: `/v1/${typingResource}` },
    ]);
    expect(result.errors.some((message) => message.includes("stub: model turn failed"))).toBe(true);
  });

  it("never deletes a placeholder already converted into visible text when a later chunk fails", async () => {
    const result = await runWebhookTurn({
      mode: "later-chunk-error",
      id: "later-chunk-error",
      stub: { failSecondChunk: true },
    });

    expect(result.webhookStatus).toBe(200);
    expect(result.dispatch.failed).toBe(1);
    expect(requestShape(result.requests)).toEqual([
      { method: "POST", pathname: "/v1/spaces/AAA/messages", text: "_OpenClaw is typing..._" },
      { method: "PATCH", pathname: `/v1/${typingResource}`, text: "First visible chunk" },
      { method: "POST", pathname: "/v1/spaces/AAA/messages", text: "Second visible chunk" },
    ]);
    expect(result.errors.some((message) => message.includes("Google Chat API 500"))).toBe(true);
  });

  it("does not reuse a failed typing placeholder for a later durable final reply", async () => {
    const result = await runWebhookTurn({
      mode: "fallback-then-final",
      id: "fallback-then-final",
      stub: { failPatch: true },
    });

    expect(result.webhookStatus).toBe(200);
    expect(result.dispatch.durableDecisions).toEqual([
      false,
      { to: "spaces/AAA", replyToId: null },
    ]);
    expect(requestShape(result.requests)).toEqual([
      { method: "POST", pathname: "/v1/spaces/AAA/messages", text: "_OpenClaw is typing..._" },
      { method: "PATCH", pathname: `/v1/${typingResource}`, text: "First assistant answer" },
      { method: "POST", pathname: "/v1/spaces/AAA/messages", text: "First assistant answer" },
      { method: "POST", pathname: "/v1/spaces/AAA/messages", text: "Second assistant answer" },
      { method: "DELETE", pathname: `/v1/${typingResource}` },
    ]);
  });

  it("keeps a silent turn successful when typing cleanup itself fails", async () => {
    const result = await runWebhookTurn({
      mode: "silent",
      id: "delete-failure",
      stub: { deleteStatus: 500 },
    });

    expect(result.webhookStatus).toBe(200);
    expect(result.requests.at(-1)).toEqual(
      expect.objectContaining({ method: "DELETE", pathname: `/v1/${typingResource}`, status: 500 }),
    );
    expect(
      result.errors.some((message) => message.includes("Google Chat typing cleanup failed")),
    ).toBe(true);
  });

  it("removes typing without removing a visible message-tool-only answer", async () => {
    const result = await runWebhookTurn({ mode: "message-tool-only", id: "message-tool-only" });

    expect(result.webhookStatus).toBe(200);
    expect(result.dispatch.accepted).toBe(false);
    expect(requestShape(result.requests)).toEqual([
      { method: "POST", pathname: "/v1/spaces/AAA/messages", text: "_OpenClaw is typing..._" },
      { method: "POST", pathname: "/v1/spaces/AAA/messages", text: "Visible message tool answer" },
      { method: "DELETE", pathname: `/v1/${typingResource}` },
    ]);
  });
});
