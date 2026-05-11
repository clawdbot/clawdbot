import { type IncomingMessage, type ServerResponse } from "node:http";
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import type { PluginRuntime } from "../../runtime-api.js";
import { setMattermostRuntime } from "../runtime.js";
import { resolveMattermostAccount } from "./accounts.js";
import type { MattermostClient, MattermostPost } from "./client.js";
import {
  buildButtonAttachments,
  computeInteractionCallbackUrl,
  createMattermostInteractionHandler,
  generateInteractionToken,
  getInteractionCallbackUrl,
  getInteractionSecret,
  resolveInteractionCallbackPath,
  resolveInteractionCallbackUrl,
  setInteractionCallbackUrl,
  setInteractionSecret,
  verifyInteractionToken,
} from "./interactions.js";

type ButtonAttachments = ReturnType<typeof buildButtonAttachments>;
type ButtonAttachment = ButtonAttachments[number];
type ButtonAction = NonNullable<ButtonAttachment["actions"]>[number];

function requireFirstAttachment(attachments: ButtonAttachments): ButtonAttachment {
  const [attachment] = attachments;
  if (!attachment) {
    throw new Error("Expected button attachment fixture");
  }
  return attachment;
}

function requireActions(attachments: ButtonAttachments): ButtonAction[] {
  const attachment = requireFirstAttachment(attachments);
  if (!attachment.actions) {
    throw new Error("Expected button attachment fixture actions");
  }
  return attachment.actions;
}

function requireAction(attachments: ButtonAttachments, index = 0): ButtonAction {
  const action = requireActions(attachments).at(index);
  if (!action) {
    throw new Error(`Expected button attachment action at index ${index}`);
  }
  return action;
}

// ── HMAC token management ────────────────────────────────────────────

describe("setInteractionSecret / getInteractionSecret", () => {
  beforeEach(() => {
    setInteractionSecret("test-bot-token");
  });

  it("derives a deterministic secret from the bot token", () => {
    setInteractionSecret("token-a");
    const secretA = getInteractionSecret();
    setInteractionSecret("token-a");
    const secretA2 = getInteractionSecret();
    expect(secretA).toBe(secretA2);
  });

  it("produces different secrets for different tokens", () => {
    setInteractionSecret("token-a");
    const secretA = getInteractionSecret();
    setInteractionSecret("token-b");
    const secretB = getInteractionSecret();
    expect(secretA).not.toBe(secretB);
  });

  it("returns a hex string", () => {
    expect(getInteractionSecret()).toMatch(/^[0-9a-f]+$/);
  });
});

// ── Token generation / verification ──────────────────────────────────

describe("generateInteractionToken / verifyInteractionToken", () => {
  beforeEach(() => {
    setInteractionSecret("test-bot-token");
  });

  it("generates a hex token", () => {
    const token = generateInteractionToken({ action_id: "click" });
    expect(token).toMatch(/^[0-9a-f]{64}$/);
  });

  it("verifies a valid token", () => {
    const context = { action_id: "do_now", item_id: "123" };
    const token = generateInteractionToken(context);
    expect(verifyInteractionToken(context, token)).toBe(true);
  });

  it("rejects a tampered token", () => {
    const context = { action_id: "do_now" };
    const token = generateInteractionToken(context);
    const tampered = token.replace(/.$/, token.endsWith("0") ? "1" : "0");
    expect(verifyInteractionToken(context, tampered)).toBe(false);
  });

  it("rejects a token generated with different context", () => {
    const token = generateInteractionToken({ action_id: "a" });
    expect(verifyInteractionToken({ action_id: "b" }, token)).toBe(false);
  });

  it("rejects tokens with wrong length", () => {
    const context = { action_id: "test" };
    expect(verifyInteractionToken(context, "short")).toBe(false);
  });

  it("is deterministic for the same context", () => {
    const context = { action_id: "test", x: 1 };
    const t1 = generateInteractionToken(context);
    const t2 = generateInteractionToken(context);
    expect(t1).toBe(t2);
  });

  it("produces the same token regardless of key order", () => {
    const contextA = { action_id: "do_now", tweet_id: "123", action: "do" };
    const contextB = { action: "do", action_id: "do_now", tweet_id: "123" };
    const contextC = { tweet_id: "123", action: "do", action_id: "do_now" };
    const tokenA = generateInteractionToken(contextA);
    const tokenB = generateInteractionToken(contextB);
    const tokenC = generateInteractionToken(contextC);
    expect(tokenA).toBe(tokenB);
    expect(tokenB).toBe(tokenC);
  });

  it("verifies a token when Mattermost reorders context keys", () => {
    // Simulate: token generated with keys in one order, verified with keys in another
    // (Mattermost reorders context keys when storing/returning interactive message payloads)
    const originalContext = { action_id: "bm_do", tweet_id: "999", action: "do" };
    const token = generateInteractionToken(originalContext);

    // Mattermost returns keys in alphabetical order (or any arbitrary order)
    const reorderedContext = { action: "do", action_id: "bm_do", tweet_id: "999" };
    expect(verifyInteractionToken(reorderedContext, token)).toBe(true);
  });

  it("verifies nested context regardless of nested key order", () => {
    const originalContext = {
      action_id: "nested",
      payload: {
        model: "gpt-5",
        meta: {
          provider: "openai",
          page: 2,
        },
      },
    };
    const token = generateInteractionToken(originalContext);

    const reorderedContext = {
      payload: {
        meta: {
          page: 2,
          provider: "openai",
        },
        model: "gpt-5",
      },
      action_id: "nested",
    };

    expect(verifyInteractionToken(reorderedContext, token)).toBe(true);
  });

  it("rejects nested context tampering", () => {
    const originalContext = {
      action_id: "nested",
      payload: {
        provider: "openai",
        model: "gpt-5",
      },
    };
    const token = generateInteractionToken(originalContext);
    const tamperedContext = {
      action_id: "nested",
      payload: {
        provider: "anthropic",
        model: "gpt-5",
      },
    };

    expect(verifyInteractionToken(tamperedContext, token)).toBe(false);
  });

  it("scopes tokens per account when account secrets differ", () => {
    setInteractionSecret("acct-a", "bot-token-a");
    setInteractionSecret("acct-b", "bot-token-b");
    const context = { action_id: "do_now", item_id: "123" };
    const tokenA = generateInteractionToken(context, "acct-a");

    expect(verifyInteractionToken(context, tokenA, "acct-a")).toBe(true);
    expect(verifyInteractionToken(context, tokenA, "acct-b")).toBe(false);
  });
});

// ── Callback URL registry ────────────────────────────────────────────

describe("callback URL registry", () => {
  it("stores and retrieves callback URLs", () => {
    setInteractionCallbackUrl("acct1", "http://localhost:18789/mattermost/interactions/acct1");
    expect(getInteractionCallbackUrl("acct1")).toBe(
      "http://localhost:18789/mattermost/interactions/acct1",
    );
  });

  it("returns undefined for unknown account", () => {
    expect(getInteractionCallbackUrl("nonexistent-account-id")).toBeUndefined();
  });
});

describe("resolveInteractionCallbackUrl", () => {
  afterEach(() => {
    for (const accountId of ["cached", "default", "acct", "myaccount"]) {
      setInteractionCallbackUrl(accountId, "");
    }
  });

  it("prefers cached URL from registry", () => {
    setInteractionCallbackUrl("cached", "http://cached:1234/path");
    expect(resolveInteractionCallbackUrl("cached")).toBe("http://cached:1234/path");
  });

  it("recomputes from config when bypassing the cache explicitly", () => {
    setInteractionCallbackUrl("acct", "http://cached:1234/path");
    const url = computeInteractionCallbackUrl("acct", {
      gateway: { port: 9999, customBindHost: "gateway.internal" },
    });
    expect(url).toBe("http://gateway.internal:9999/mattermost/interactions/acct");
  });

  it("uses interactions.callbackBaseUrl when configured", () => {
    const url = resolveInteractionCallbackUrl("default", {
      channels: {
        mattermost: {
          interactions: {
            callbackBaseUrl: "https://gateway.example.com/openclaw",
          },
        },
      },
    });
    expect(url).toBe("https://gateway.example.com/openclaw/mattermost/interactions/default");
  });

  it("trims trailing slashes from callbackBaseUrl", () => {
    const url = resolveInteractionCallbackUrl("acct", {
      channels: {
        mattermost: {
          interactions: {
            callbackBaseUrl: "https://gateway.example.com/root///",
          },
        },
      },
    });
    expect(url).toBe("https://gateway.example.com/root/mattermost/interactions/acct");
  });

  it("uses merged per-account interactions.callbackBaseUrl", () => {
    const cfg = {
      gateway: { port: 9999 },
      channels: {
        mattermost: {
          accounts: {
            acct: {
              botToken: "bot-token",
              baseUrl: "https://chat.example.com",
              interactions: {
                callbackBaseUrl: "https://gateway.example.com/root",
              },
            },
          },
        },
      },
    };
    const account = resolveMattermostAccount({
      cfg,
      accountId: "acct",
      allowUnresolvedSecretRef: true,
    });
    const url = resolveInteractionCallbackUrl(account.accountId, {
      gateway: cfg.gateway,
      interactions: account.config.interactions,
    });
    expect(url).toBe("https://gateway.example.com/root/mattermost/interactions/acct");
  });

  it("falls back to gateway.customBindHost when configured", () => {
    const url = resolveInteractionCallbackUrl("default", {
      gateway: { port: 9999, customBindHost: "gateway.internal" },
    });
    expect(url).toBe("http://gateway.internal:9999/mattermost/interactions/default");
  });

  it("falls back to localhost when customBindHost is a wildcard bind address", () => {
    const url = resolveInteractionCallbackUrl("default", {
      gateway: { port: 9999, customBindHost: "0.0.0.0" },
    });
    expect(url).toBe("http://localhost:9999/mattermost/interactions/default");
  });

  it("brackets IPv6 custom bind hosts", () => {
    const url = resolveInteractionCallbackUrl("acct", {
      gateway: { port: 9999, customBindHost: "::1" },
    });
    expect(url).toBe("http://[::1]:9999/mattermost/interactions/acct");
  });

  it("uses default port 18789 when no config provided", () => {
    const url = resolveInteractionCallbackUrl("myaccount");
    expect(url).toBe("http://localhost:18789/mattermost/interactions/myaccount");
  });
});

describe("resolveInteractionCallbackPath", () => {
  it("builds the per-account callback path", () => {
    expect(resolveInteractionCallbackPath("acct")).toBe("/mattermost/interactions/acct");
  });
});

// ── buildButtonAttachments ───────────────────────────────────────────

describe("buildButtonAttachments", () => {
  beforeEach(() => {
    setInteractionSecret("test-bot-token");
  });

  it("returns an array with one attachment containing all buttons", () => {
    const result = buildButtonAttachments({
      callbackUrl: "http://localhost:18789/mattermost/interactions/default",
      buttons: [
        { id: "btn1", name: "Click Me" },
        { id: "btn2", name: "Skip", style: "danger" },
      ],
    });

    expect(result).toHaveLength(1);
    expect(requireActions(result)).toHaveLength(2);
  });

  it("sets type to 'button' on every action", () => {
    const result = buildButtonAttachments({
      callbackUrl: "http://localhost:18789/cb",
      buttons: [{ id: "a", name: "A" }],
    });

    expect(requireAction(result).type).toBe("button");
  });

  it("includes HMAC _token in integration context", () => {
    const result = buildButtonAttachments({
      callbackUrl: "http://localhost:18789/cb",
      buttons: [{ id: "test", name: "Test" }],
    });

    const action = requireAction(result);
    expect(action.integration.context._token).toMatch(/^[0-9a-f]{64}$/);
  });

  it("includes sanitized action_id in integration context", () => {
    const result = buildButtonAttachments({
      callbackUrl: "http://localhost:18789/cb",
      buttons: [{ id: "my_action", name: "Do It" }],
    });

    const action = requireAction(result);
    // sanitizeActionId strips hyphens and underscores (Mattermost routing bug #25747)
    expect(action.integration.context.action_id).toBe("myaction");
    expect(action.id).toBe("myaction");
  });

  it("merges custom context into integration context", () => {
    const result = buildButtonAttachments({
      callbackUrl: "http://localhost:18789/cb",
      buttons: [{ id: "btn", name: "Go", context: { tweet_id: "123", batch: true } }],
    });

    const ctx = requireAction(result).integration.context;
    expect(ctx.tweet_id).toBe("123");
    expect(ctx.batch).toBe(true);
    expect(ctx.action_id).toBe("btn");
    expect(ctx._token).toMatch(/^[0-9a-f]{64}$/);
  });

  it("passes callback URL to each button integration", () => {
    const url = "http://localhost:18789/mattermost/interactions/default";
    const result = buildButtonAttachments({
      callbackUrl: url,
      buttons: [
        { id: "a", name: "A" },
        { id: "b", name: "B" },
      ],
    });

    for (const action of requireActions(result)) {
      expect(action.integration.url).toBe(url);
    }
  });

  it("preserves button style", () => {
    const result = buildButtonAttachments({
      callbackUrl: "http://localhost/cb",
      buttons: [
        { id: "ok", name: "OK", style: "primary" },
        { id: "no", name: "No", style: "danger" },
      ],
    });

    expect(requireAction(result, 0).style).toBe("primary");
    expect(requireAction(result, 1).style).toBe("danger");
  });

  it("uses provided text for the attachment", () => {
    const result = buildButtonAttachments({
      callbackUrl: "http://localhost/cb",
      buttons: [{ id: "x", name: "X" }],
      text: "Choose an action:",
    });

    expect(requireFirstAttachment(result).text).toBe("Choose an action:");
  });

  it("defaults to empty string text when not provided", () => {
    const result = buildButtonAttachments({
      callbackUrl: "http://localhost/cb",
      buttons: [{ id: "x", name: "X" }],
    });

    expect(requireFirstAttachment(result).text).toBe("");
  });

  it("generates verifiable tokens", () => {
    const result = buildButtonAttachments({
      callbackUrl: "http://localhost/cb",
      buttons: [{ id: "verify_me", name: "V", context: { extra: "data" } }],
    });

    const ctx = requireAction(result).integration.context;
    const token = ctx._token as string;
    const { _token, ...contextWithoutToken } = ctx;
    expect(verifyInteractionToken(contextWithoutToken, token)).toBe(true);
  });

  it("generates tokens that verify even when Mattermost reorders context keys", () => {
    const result = buildButtonAttachments({
      callbackUrl: "http://localhost/cb",
      buttons: [{ id: "do_action", name: "Do", context: { tweet_id: "42", category: "ai" } }],
    });

    const ctx = requireAction(result).integration.context;
    const token = ctx._token as string;

    // Simulate Mattermost returning context with keys in a different order
    const reordered: Record<string, unknown> = {};
    const keys = Object.keys(ctx).filter((k) => k !== "_token");
    // Reverse the key order to simulate reordering
    for (const key of keys.toReversed()) {
      reordered[key] = ctx[key];
    }
    expect(verifyInteractionToken(reordered, token)).toBe(true);
  });
});

describe("createMattermostInteractionHandler", () => {
  function setInteractionRuntime(
    enqueueSystemEvent: (
      text: string,
      options: { sessionKey?: string | null; sessionId?: string | null; userId?: string | null },
    ) => boolean = () => true,
  ) {
    setMattermostRuntime({
      system: {
        enqueueSystemEvent,
      },
    } as unknown as PluginRuntime);
  }

  function createMattermostClientMock(
    requestImpl: (path: string, init?: { method?: string }) => Promise<unknown>,
  ): MattermostClient {
    return {
      baseUrl: "https://chat.example.com",
      apiBaseUrl: "https://chat.example.com/api/v4",
      token: "bot-token",
      request: async <T>(path: string, init?: RequestInit) => (await requestImpl(path, init)) as T,
      fetchImpl: vi.fn<typeof fetch>(),
    };
  }

  beforeEach(() => {
    setInteractionRuntime();
    setInteractionSecret("acct", "bot-token");
  });

  function createReq(params: {
    method?: string;
    body?: unknown;
    remoteAddress?: string;
    headers?: Record<string, string>;
  }): IncomingMessage {
    const body = params.body === undefined ? "" : JSON.stringify(params.body);
    const listeners = new Map<string, Array<(...args: unknown[]) => void>>();

    const req = {
      destroyed: false,
      method: params.method ?? "POST",
      headers: params.headers ?? {},
      socket: { remoteAddress: params.remoteAddress ?? "203.0.113.10" },
      on(event: string, handler: (...args: unknown[]) => void) {
        const existing = listeners.get(event) ?? [];
        existing.push(handler);
        listeners.set(event, existing);
        return this;
      },
      removeListener(event: string, handler: (...args: unknown[]) => void) {
        const existing = listeners.get(event) ?? [];
        listeners.set(
          event,
          existing.filter((entry) => entry !== handler),
        );
        return this;
      },
      destroy() {
        this.destroyed = true;
        return this;
      },
    } as IncomingMessage & { emitTest: (event: string, ...args: unknown[]) => void };

    req.emitTest = (event: string, ...args: unknown[]) => {
      const handlers = listeners.get(event) ?? [];
      for (const handler of handlers) {
        handler(...args);
      }
    };

    queueMicrotask(() => {
      if (body) {
        req.emitTest("data", Buffer.from(body));
      }
      req.emitTest("end");
    });

    return req;
  }

  function createRes(): ServerResponse & { headers: Record<string, string>; body: string } {
    const res = {
      statusCode: 200,
      headers: {},
      body: "",
      setHeader(name: string, value: string | number | readonly string[]) {
        res.headers[name] = Array.isArray(value) ? value.join(",") : String(value);
        return res;
      },
      end(
        chunk?: string | Buffer | Uint8Array,
        _encoding?: BufferEncoding | (() => void),
        cb?: () => void,
      ) {
        res.body = chunk ? String(chunk) : "";
        cb?.();
        return res;
      },
    } as ServerResponse & { headers: Record<string, string>; body: string };
    return res;
  }

  function createActionContext(actionId = "approve", channelId = "chan-1") {
    const context = { action_id: actionId, __openclaw_channel_id: channelId };
    return { context, token: generateInteractionToken(context, "acct") };
  }

  function createInteractionBody(params: {
    context: Record<string, unknown>;
    token: string;
    channelId?: string;
    postId?: string;
    userId?: string;
    userName?: string;
  }) {
    return {
      user_id: params.userId ?? "user-1",
      ...(params.userName ? { user_name: params.userName } : {}),
      channel_id: params.channelId ?? "chan-1",
      post_id: params.postId ?? "post-1",
      context: { ...params.context, _token: params.token },
    };
  }

  async function runHandler(
    handler: ReturnType<typeof createMattermostInteractionHandler>,
    params: {
      body: unknown;
      remoteAddress?: string;
      headers?: Record<string, string>;
    },
  ) {
    const req = createReq({
      remoteAddress: params.remoteAddress,
      headers: params.headers,
      body: params.body,
    });
    const res = createRes();
    await handler(req, res);
    return res;
  }

  function expectForbiddenResponse(
    res: ServerResponse & { body: string },
    expectedMessage: string,
  ) {
    expect(res.statusCode).toBe(403);
    expect(res.body).toContain(expectedMessage);
  }

  function expectSuccessfulApprovalUpdate(
    res: ServerResponse & { body: string },
    requestLog?: Array<{ path: string; method?: string }>,
  ) {
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe("{}");
    if (requestLog) {
      expect(requestLog).toEqual([
        { path: "/posts/post-1", method: undefined },
        { path: "/posts/post-1", method: "PUT" },
      ]);
    }
  }

  function createActionPost(params?: {
    actionId?: string;
    actionName?: string;
    channelId?: string;
    rootId?: string;
  }): MattermostPost {
    return {
      id: "post-1",
      channel_id: params?.channelId ?? "chan-1",
      ...(params?.rootId ? { root_id: params.rootId } : {}),
      message: "Choose",
      props: {
        attachments: [
          {
            actions: [
              {
                id: params?.actionId ?? "approve",
                name: params?.actionName ?? "Approve",
              },
            ],
          },
        ],
      },
    };
  }

  function createUnusedInteractionHandler() {
    return createMattermostInteractionHandler({
      client: createMattermostClientMock(async () => ({ message: "unused" })),
      botUserId: "bot",
      accountId: "acct",
    });
  }

  async function runApproveInteraction(params?: {
    actionName?: string;
    allowedSourceIps?: string[];
    trustedProxies?: string[];
    remoteAddress?: string;
    headers?: Record<string, string>;
  }) {
    const { context, token } = createActionContext();
    const requestLog: Array<{ path: string; method?: string }> = [];
    const handler = createMattermostInteractionHandler({
      client: createMattermostClientMock(async (path: string, init?: { method?: string }) => {
        requestLog.push({ path, method: init?.method });
        if (init?.method === "PUT") {
          return { id: "post-1" };
        }
        return createActionPost({ actionName: params?.actionName });
      }),
      botUserId: "bot",
      accountId: "acct",
      allowedSourceIps: params?.allowedSourceIps,
      trustedProxies: params?.trustedProxies,
    });

    const res = await runHandler(handler, {
      remoteAddress: params?.remoteAddress,
      headers: params?.headers,
      body: createInteractionBody({ context, token, userName: "alice" }),
    });
    return { res, requestLog };
  }

  async function runInvalidActionRequest(actionId: string) {
    const { context, token } = createActionContext();
    const handler = createMattermostInteractionHandler({
      client: createMattermostClientMock(async () =>
        createActionPost({ actionId, actionName: actionId }),
      ),
      botUserId: "bot",
      accountId: "acct",
    });

    return await runHandler(handler, {
      body: createInteractionBody({ context, token }),
    });
  }

  it("accepts callback requests from an allowlisted source IP", async () => {
    const { res, requestLog } = await runApproveInteraction({
      allowedSourceIps: ["198.51.100.8"],
      remoteAddress: "198.51.100.8",
    });

    expectSuccessfulApprovalUpdate(res, requestLog);
  });

  it("accepts forwarded Mattermost source IPs from a trusted proxy", async () => {
    const { res } = await runApproveInteraction({
      allowedSourceIps: ["198.51.100.8"],
      trustedProxies: ["127.0.0.1"],
      remoteAddress: "127.0.0.1",
      headers: { "x-forwarded-for": "198.51.100.8" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.body).toBe("{}");
  });

  it("rejects callback requests from non-allowlisted source IPs", async () => {
    const { context, token } = createActionContext();
    const handler = createMattermostInteractionHandler({
      client: createMattermostClientMock(async () => {
        throw new Error("should not fetch post for rejected origins");
      }),
      botUserId: "bot",
      accountId: "acct",
      allowedSourceIps: ["127.0.0.1"],
    });

    const res = await runHandler(handler, {
      remoteAddress: "198.51.100.8",
      body: createInteractionBody({ context, token }),
    });
    expectForbiddenResponse(res, "Forbidden origin");
  });

  it("rejects requests with an invalid interaction token", async () => {
    const handler = createUnusedInteractionHandler();

    const res = await runHandler(handler, {
      body: {
        user_id: "user-1",
        channel_id: "chan-1",
        post_id: "post-1",
        context: { action_id: "approve", _token: "deadbeef" },
      },
    });
    expectForbiddenResponse(res, "Invalid token");
  });

  it("rejects requests when the signed channel does not match the callback payload", async () => {
    const { context, token } = createActionContext();
    const handler = createUnusedInteractionHandler();

    const res = await runHandler(handler, {
      body: createInteractionBody({ context, token, channelId: "chan-2" }),
    });
    expectForbiddenResponse(res, "Channel mismatch");
  });

  it("rejects requests when the fetched post does not belong to the callback channel", async () => {
    const { context, token } = createActionContext();
    const handler = createMattermostInteractionHandler({
      client: createMattermostClientMock(async () => createActionPost({ channelId: "chan-9" })),
      botUserId: "bot",
      accountId: "acct",
    });

    const res = await runHandler(handler, {
      body: createInteractionBody({ context, token }),
    });
    expectForbiddenResponse(res, "Post/channel mismatch");
  });

  it("rejects requests when the action is not present on the fetched post", async () => {
    const res = await runInvalidActionRequest("reject");

    expect(res.statusCode).toBe(403);
    expect(res.body).toContain("Unknown action");
  });

  it("accepts actions when the button name matches the action id", async () => {
    const { res, requestLog } = await runApproveInteraction({
      actionName: "approve",
    });

    expectSuccessfulApprovalUpdate(res, requestLog);
  });

  it("blocks button dispatch when the sender is not allowed for the action", async () => {
    const { context, token } = createActionContext();
    const dispatchButtonClick = vi.fn();
    const handleInteraction = vi.fn();
    const handler = createMattermostInteractionHandler({
      client: createMattermostClientMock(async (_path: string, init?: { method?: string }) =>
        init?.method === "PUT" ? { id: "post-1" } : createActionPost(),
      ),
      botUserId: "bot",
      accountId: "acct",
      authorizeButtonClick: async () => ({
        ok: false,
        response: {
          ephemeral_text: "blocked",
        },
      }),
      handleInteraction,
      dispatchButtonClick,
    });

    const res = await runHandler(handler, {
      body: createInteractionBody({ context, token }),
    });

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("blocked");
    expect(handleInteraction).not.toHaveBeenCalled();
    expect(dispatchButtonClick).not.toHaveBeenCalled();
  });

  it("forwards fetched post threading metadata to session and button callbacks", async () => {
    const enqueueSystemEvent = vi.fn();
    setInteractionRuntime(enqueueSystemEvent);
    const { context, token } = createActionContext();
    const resolveSessionKey = vi.fn().mockResolvedValue("session:thread:root-9");
    const dispatchButtonClick = vi.fn();
    const fetchedPost = createActionPost({ rootId: "root-9" });
    const handler = createMattermostInteractionHandler({
      client: createMattermostClientMock(async (_path: string, init?: { method?: string }) =>
        init?.method === "PUT" ? { id: "post-1" } : fetchedPost,
      ),
      botUserId: "bot",
      accountId: "acct",
      resolveSessionKey,
      dispatchButtonClick,
    });

    const res = await runHandler(handler, {
      body: createInteractionBody({ context, token, userName: "alice" }),
    });
    expect(res.statusCode).toBe(200);
    expect(resolveSessionKey).toHaveBeenCalledWith({
      channelId: "chan-1",
      userId: "user-1",
      post: fetchedPost,
    });
    expect(enqueueSystemEvent).toHaveBeenCalledWith(
      'Mattermost button click: action="approve" by alice in channel chan-1',
      {
        sessionKey: "session:thread:root-9",
        contextKey: "mattermost:interaction:post-1:approve",
      },
    );
    expect(dispatchButtonClick).toHaveBeenCalledWith({
      channelId: "chan-1",
      userId: "user-1",
      userName: "alice",
      actionId: "approve",
      actionName: "Approve",
      postId: "post-1",
      post: fetchedPost,
    });
  });

  it("lets a custom interaction handler short-circuit generic completion updates", async () => {
    const { context, token } = createActionContext("mdlprov");
    const requestLog: Array<{ path: string; method?: string }> = [];
    const handleInteraction = vi.fn().mockResolvedValue({
      ephemeral_text: "Only the original requester can use this picker.",
    });
    const dispatchButtonClick = vi.fn();
    const originalPost = createActionPost({
      actionId: "mdlprov",
      actionName: "Browse providers",
    });
    const handler = createMattermostInteractionHandler({
      client: createMattermostClientMock(async (path: string, init?: { method?: string }) => {
        requestLog.push({ path, method: init?.method });
        return originalPost;
      }),
      botUserId: "bot",
      accountId: "acct",
      handleInteraction,
      dispatchButtonClick,
    });
    const body = createInteractionBody({
      context,
      token,
      userId: "user-2",
      userName: "alice",
    });

    const res = await runHandler(handler, { body });

    expect(res.statusCode).toBe(200);
    expect(res.body).toBe(
      JSON.stringify({
        ephemeral_text: "Only the original requester can use this picker.",
      }),
    );
    expect(requestLog).toEqual([{ path: "/posts/post-1", method: undefined }]);
    expect(handleInteraction).toHaveBeenCalledWith({
      payload: body,
      userName: "alice",
      actionId: "mdlprov",
      actionName: "Browse providers",
      originalMessage: "Choose",
      context,
      post: originalPost,
    });
    expect(dispatchButtonClick).not.toHaveBeenCalled();
  });
});
