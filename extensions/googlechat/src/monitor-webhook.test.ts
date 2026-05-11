import type { IncomingMessage, ServerResponse } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { WebhookTarget } from "./monitor-types.js";
import type { GoogleChatEvent } from "./types.js";

const readJsonWebhookBodyOrReject = vi.hoisted(() => vi.fn());
const resolveWebhookTargetWithAuthOrReject = vi.hoisted(() => vi.fn());
const withResolvedWebhookRequestPipeline = vi.hoisted(() => vi.fn());
const verifyGoogleChatRequest = vi.hoisted(() => vi.fn());

vi.mock("openclaw/plugin-sdk/webhook-request-guards", () => ({
  readJsonWebhookBodyOrReject,
}));

vi.mock("openclaw/plugin-sdk/webhook-targets", () => ({
  resolveWebhookTargetWithAuthOrReject,
  withResolvedWebhookRequestPipeline,
}));

vi.mock("./auth.js", () => ({
  verifyGoogleChatRequest,
}));

type ProcessEventFn = (event: GoogleChatEvent, target: WebhookTarget) => Promise<void>;
let createGoogleChatWebhookRequestHandler: typeof import("./monitor-webhook.js").createGoogleChatWebhookRequestHandler;
let warnAppPrincipalMisconfiguration: typeof import("./monitor-webhook.js").warnAppPrincipalMisconfiguration;

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
    ({ createGoogleChatWebhookRequestHandler, warnAppPrincipalMisconfiguration } =
      await import("./monitor-webhook.js"));
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterAll(() => {
    vi.doUnmock("openclaw/plugin-sdk/webhook-request-guards");
    vi.doUnmock("openclaw/plugin-sdk/webhook-targets");
    vi.doUnmock("./auth.js");
    vi.resetModules();
  });

  it("accepts add-on payloads that carry systemIdToken in the body", async () => {
    const target = {
      account: {
        accountId: "default",
        config: { appPrincipal: "chat-app" },
      },
      runtime: { error: vi.fn() },
      statusSink: vi.fn(),
      audienceType: "app-url",
      audience: "https://example.com/googlechat",
    };
    installSimplePipeline([target]);
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

    expect(verifyGoogleChatRequest).toHaveBeenCalledWith({
      bearer: "addon-token",
      audienceType: "app-url",
      audience: "https://example.com/googlechat",
      expectedAddOnPrincipal: "chat-app",
    });
    expect(processEvent).toHaveBeenCalledWith(
      {
        type: "MESSAGE",
        space: { name: "spaces/AAA" },
        message: { name: "spaces/AAA/messages/1", text: "hello" },
        user: { name: "users/123" },
        eventTime: "2026-03-22T00:00:00.000Z",
      },
      target,
    );
    expect(res.statusCode).toBe(200);
    expect(res.headers["Content-Type"]).toBe("application/json");
  });

  it("logs WARN with reason when verification fails (missing token)", async () => {
    const logFn = vi.fn();
    installSimplePipeline([
      {
        account: {
          accountId: "acct-1",
          config: { appPrincipal: "chat-app" },
        },
        runtime: { log: logFn, error: vi.fn() },
        audienceType: "app-url",
        audience: "https://example.com/googlechat",
      },
    ]);
    readJsonWebhookBodyOrReject.mockResolvedValue({
      ok: true,
      value: {
        commonEventObject: { hostApp: "CHAT" },
        authorizationEventObject: { systemIdToken: "bad-token" },
        chat: {
          messagePayload: {
            space: { name: "spaces/AAA" },
            message: { name: "spaces/AAA/messages/1", text: "hi" },
          },
        },
      },
    });
    resolveWebhookTargetWithAuthOrReject.mockImplementation(async ({ isMatch, targets, res }) => {
      for (const target of targets) {
        if (await isMatch(target)) {
          return target;
        }
      }
      res.statusCode = 401;
      res.end("unauthorized");
      return null;
    });
    verifyGoogleChatRequest.mockResolvedValue({ ok: false, reason: "missing token" });
    const { processEvent, res } = await runWebhookHandler();

    expect(logFn).toHaveBeenCalledWith("[acct-1] Google Chat webhook auth rejected: missing token");
    expect(processEvent).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
  });

  it("logs WARN with reason when verification fails (unexpected principal)", async () => {
    const logFn = vi.fn();
    installSimplePipeline([
      {
        account: {
          accountId: "acct-2",
          config: { appPrincipal: "chat-app" },
        },
        runtime: { log: logFn, error: vi.fn() },
        audienceType: "app-url",
        audience: "https://example.com/googlechat",
      },
    ]);
    readJsonWebhookBodyOrReject.mockResolvedValue({
      ok: true,
      value: {
        commonEventObject: { hostApp: "CHAT" },
        authorizationEventObject: { systemIdToken: "bad-token" },
        chat: {
          messagePayload: {
            space: { name: "spaces/AAA" },
            message: { name: "spaces/AAA/messages/1", text: "hi" },
          },
        },
      },
    });
    resolveWebhookTargetWithAuthOrReject.mockImplementation(async ({ isMatch, targets, res }) => {
      for (const target of targets) {
        if (await isMatch(target)) {
          return target;
        }
      }
      res.statusCode = 401;
      res.end("unauthorized");
      return null;
    });
    verifyGoogleChatRequest.mockResolvedValue({
      ok: false,
      reason: "unexpected add-on principal: 999999999999999999999",
    });
    const { processEvent, res } = await runWebhookHandler();

    expect(logFn).toHaveBeenCalledWith(
      "[acct-2] Google Chat webhook auth rejected: unexpected add-on principal: 999999999999999999999",
    );
    expect(processEvent).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
  });

  it("does not log WARN when verification succeeds", async () => {
    const logFn = vi.fn();
    installSimplePipeline([
      {
        account: {
          accountId: "acct-ok",
          config: { appPrincipal: "chat-app" },
        },
        runtime: { log: logFn, error: vi.fn() },
        statusSink: vi.fn(),
        audienceType: "app-url",
        audience: "https://example.com/googlechat",
      },
    ]);
    readJsonWebhookBodyOrReject.mockResolvedValue({
      ok: true,
      value: {
        commonEventObject: { hostApp: "CHAT" },
        authorizationEventObject: { systemIdToken: "good-token" },
        chat: {
          eventTime: "2026-03-22T00:00:00.000Z",
          user: { name: "users/123" },
          messagePayload: {
            space: { name: "spaces/AAA" },
            message: { name: "spaces/AAA/messages/1", text: "hi" },
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
    const { res } = await runWebhookHandler();

    expect(logFn).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(200);
  });

  it("does not log failed candidate targets when another target verifies", async () => {
    const logA = vi.fn();
    const logB = vi.fn();
    const targetA = {
      account: {
        accountId: "acct-a",
        config: { appPrincipal: "chat-app-a" },
      },
      runtime: { log: logA, error: vi.fn() },
      audienceType: "app-url",
      audience: "https://example.com/googlechat",
    };
    const targetB = {
      account: {
        accountId: "acct-b",
        config: { appPrincipal: "chat-app-b" },
      },
      runtime: { log: logB, error: vi.fn() },
      statusSink: vi.fn(),
      audienceType: "app-url",
      audience: "https://example.com/googlechat",
    };
    installSimplePipeline([targetA, targetB]);
    readJsonWebhookBodyOrReject.mockResolvedValue({
      ok: true,
      value: {
        commonEventObject: { hostApp: "CHAT" },
        authorizationEventObject: { systemIdToken: "shared-path-token" },
        chat: {
          eventTime: "2026-03-22T00:00:00.000Z",
          user: { name: "users/123" },
          messagePayload: {
            space: { name: "spaces/BBB" },
            message: { name: "spaces/BBB/messages/1", text: "hi" },
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
    verifyGoogleChatRequest
      .mockResolvedValueOnce({ ok: false, reason: "unexpected add-on principal: 111" })
      .mockResolvedValueOnce({ ok: true });
    const { processEvent, res } = await runWebhookHandler();

    expect(logA).not.toHaveBeenCalled();
    expect(logB).not.toHaveBeenCalled();
    expect(processEvent).toHaveBeenCalledWith(
      {
        type: "MESSAGE",
        space: { name: "spaces/BBB" },
        message: { name: "spaces/BBB/messages/1", text: "hi" },
        user: { name: "users/123" },
        eventTime: "2026-03-22T00:00:00.000Z",
      },
      targetB,
    );
    expect(res.statusCode).toBe(200);
  });

  it("rejects missing add-on bearer tokens before dispatch", async () => {
    const logFn = vi.fn();
    installSimplePipeline([
      {
        account: {
          accountId: "default",
          config: { appPrincipal: "chat-app" },
        },
        runtime: { log: logFn, error: vi.fn() },
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
    expect(logFn).toHaveBeenCalledWith(
      "[default] Google Chat webhook auth rejected: missing token",
    );
    expect(res.statusCode).toBe(401);
    expect(res.body).toBe("unauthorized");
  });
});

describe("warnAppPrincipalMisconfiguration", () => {
  it("warns when appPrincipal is missing for app-url audience", () => {
    const log = vi.fn();
    warnAppPrincipalMisconfiguration({
      accountId: "acct-missing",
      audienceType: "app-url",
      appPrincipal: undefined,
      log,
    });
    expect(log).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledWith(
      '[acct-missing] appPrincipal is missing for audienceType "app-url"; add-on token verification will fail. Set appPrincipal to the numeric OAuth 2.0 client ID (uniqueId, 21 digits), not an email.',
    );
  });

  it("warns when appPrincipal contains @ for app-url audience", () => {
    const log = vi.fn();
    warnAppPrincipalMisconfiguration({
      accountId: "acct-email",
      audienceType: "app-url",
      appPrincipal: "bot@example.iam.gserviceaccount.com",
      log,
    });
    expect(log).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledWith(
      '[acct-email] appPrincipal "bot@example.iam.gserviceaccount.com" looks like an email address. Set appPrincipal to the numeric OAuth 2.0 client ID (uniqueId, 21 digits), not an email.',
    );
  });

  it("does not warn for valid numeric appPrincipal with app-url audience", () => {
    const log = vi.fn();
    warnAppPrincipalMisconfiguration({
      accountId: "acct-ok",
      audienceType: "app-url",
      appPrincipal: "123456789012345678901",
      log,
    });
    expect(log).not.toHaveBeenCalled();
  });

  it("does not warn for project-number audience even with missing appPrincipal", () => {
    const log = vi.fn();
    warnAppPrincipalMisconfiguration({
      accountId: "acct-pn",
      audienceType: "project-number",
      appPrincipal: undefined,
      log,
    });
    expect(log).not.toHaveBeenCalled();
  });
});
