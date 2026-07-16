import type { IncomingMessage, ServerResponse } from "node:http";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { WebhookTarget } from "./monitor-types.js";
import type { GoogleChatEvent } from "./types.js";

const readJsonWebhookBodyOrReject = vi.hoisted(() => vi.fn());
const resolveWebhookTargetWithAuthOrReject = vi.hoisted(() => vi.fn());
const withResolvedWebhookRequestPipeline = vi.hoisted(() => vi.fn());
const verifyGoogleChatRequest = vi.hoisted(() => vi.fn());

vi.mock("../runtime-api.js", () => ({
  readJsonWebhookBodyOrReject,
  resolveWebhookTargetWithAuthOrReject,
  withResolvedWebhookRequestPipeline,
}));

vi.mock("./auth.js", () => ({
  verifyGoogleChatRequest,
}));

type ProcessEventFn = (event: GoogleChatEvent, target: WebhookTarget) => Promise<void>;
let createGoogleChatWebhookRequestHandler: typeof import("./monitor-webhook.js").createGoogleChatWebhookRequestHandler;

function createRequest(authorization?: string): IncomingMessage {
  return {
    method: "POST",
    url: "/googlechat",
    headers: {
      authorization: authorization ?? "",
      "content-type": "application/json",
    },
  } as IncomingMessage;
}

function createResponse() {
  const res = {
    statusCode: 0,
    headers: {} as Record<string, string>,
    body: "",
    setHeader: (name: string, value: string) => {
      res.headers[name] = value;
    },
    end: (payload?: string) => {
      res.body = payload ?? "";
      return res;
    },
  } as ServerResponse & { headers: Record<string, string>; body: string };
  return res;
}

function installSimplePipeline(targets: unknown[]) {
  withResolvedWebhookRequestPipeline.mockImplementation(
    async ({
      handle,
      req,
      res,
    }: {
      handle: (input: {
        targets: unknown[];
        req: IncomingMessage;
        res: ServerResponse;
      }) => Promise<unknown>;
      req: IncomingMessage;
      res: ServerResponse;
    }) =>
      await handle({
        targets,
        req,
        res,
      }),
  );
}

async function runWebhookHandler(options?: {
  processEvent?: ProcessEventFn;
  authorization?: string;
}) {
  const processEvent: ProcessEventFn =
    options?.processEvent ?? (vi.fn(async () => {}) as ProcessEventFn);
  const handler = createGoogleChatWebhookRequestHandler({
    webhookTargets: new Map(),
    webhookInFlightLimiter: {} as never,
    processEvent,
  });
  const req = createRequest(options?.authorization);
  const res = createResponse();
  await expect(handler(req, res)).resolves.toBe(true);
  return { processEvent, res };
}

describe("googlechat monitor webhook", () => {
  beforeAll(async () => {
    ({ createGoogleChatWebhookRequestHandler } = await import("./monitor-webhook.js"));
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("accepts add-on payloads that carry systemIdToken in the body", async () => {
    installSimplePipeline([
      {
        account: {
          accountId: "default",
          config: { appPrincipal: "chat-app" },
        },
        runtime: { error: vi.fn() },
        statusSink: vi.fn(),
        audienceType: "app-url",
        audience: "https://example.com/googlechat",
      },
    ]);
    readJsonWebhookBodyOrReject.mockResolvedValue({
      ok: true,
      value: {
        commonEventObject: { hostApp: "CHAT" },
        authorizationEventObject: { systemIdToken: "addon-token" },
        chat: {
          eventTime: "2026-03-22T00:00:00.000Z",
          user: { name: "users/123" },
          messagePayload: {
            space: { name: "spaces/AAA" },
            message: { name: "spaces/AAA/messages/1", text: "hello" },
          },
        },
      },
    });
    resolveWebhookTargetWithAuthOrReject.mockImplementation(async ({ isMatch, targets }) => {
      for (const target of targets) {
        if (await isMatch(target)) {
          return target;
        }
      }
      return null;
    });
    verifyGoogleChatRequest.mockResolvedValue({ ok: true });
    const { processEvent, res } = await runWebhookHandler();

    expect(verifyGoogleChatRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        bearer: "addon-token",
        expectedAddOnPrincipal: "chat-app",
      }),
    );
    expect(processEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "MESSAGE",
        space: { name: "spaces/AAA" },
      }),
      expect.anything(),
    );
    expect(res.statusCode).toBe(200);
    expect(res.headers["Content-Type"]).toBe("application/json");
  });

  it("rejects missing add-on bearer tokens before dispatch", async () => {
    installSimplePipeline([
      {
        account: {
          accountId: "default",
          config: { appPrincipal: "chat-app" },
        },
        runtime: { error: vi.fn() },
      },
    ]);
    readJsonWebhookBodyOrReject.mockResolvedValue({
      ok: true,
      value: {
        commonEventObject: { hostApp: "CHAT" },
        chat: {
          messagePayload: {
            space: { name: "spaces/AAA" },
            message: { name: "spaces/AAA/messages/1", text: "hello" },
          },
        },
      },
    });
    const { processEvent, res } = await runWebhookHandler();

    expect(processEvent).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
    expect(res.body).toBe("unauthorized");
  });
});
