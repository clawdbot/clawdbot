/**
 * Tests HTTP request context extraction for gateway auth and routing.
 */
import type { IncomingMessage } from "node:http";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveHttpSenderIsOwner } from "./http-auth-utils.js";
import {
  authorizeOpenAiCompatibleHttpModelOverride,
  resolveOpenAiCompatibleHttpOperatorScopes,
  resolveOpenAiCompatibleHttpSenderIsOwner,
  resolveGatewayRequestContext,
  resolveTrustedHttpOperatorScopes,
} from "./http-utils.js";

const sessionEntries = vi.hoisted(() => new Map<string, Record<string, unknown>>());

vi.mock("../config/sessions/session-accessor.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/sessions/session-accessor.js")>();
  return {
    ...actual,
    resolveSessionEntryAccessTarget: (params: { sessionKey: string }) => ({
      entry: sessionEntries.get(params.sessionKey),
    }),
  };
});

function createReq(headers: Record<string, string> = {}): IncomingMessage {
  return { headers } as IncomingMessage;
}

const tokenAuth = { mode: "token" as const };
const noneAuth = { mode: "none" as const };

beforeEach(() => sessionEntries.clear());

describe("resolveGatewayRequestContext", () => {
  it("uses normalized x-openclaw-message-channel when enabled", () => {
    const result = resolveGatewayRequestContext({
      req: createReq({ "x-openclaw-message-channel": " Custom-Channel " }),
      model: "openclaw",
      sessionPrefix: "openai",
      defaultMessageChannel: "webchat",
      useMessageChannelHeader: true,
    });

    expect(result.messageChannel).toBe("custom-channel");
  });

  it("uses default messageChannel when header support is disabled", () => {
    const result = resolveGatewayRequestContext({
      req: createReq({ "x-openclaw-message-channel": "custom-channel" }),
      model: "openclaw",
      sessionPrefix: "openresponses",
      defaultMessageChannel: "webchat",
      useMessageChannelHeader: false,
    });

    expect(result.messageChannel).toBe("webchat");
  });

  it("includes session prefix and user in generated session key", () => {
    const result = resolveGatewayRequestContext({
      req: createReq(),
      model: "openclaw",
      user: "alice",
      sessionPrefix: "openresponses",
      defaultMessageChannel: "webchat",
    });

    expect(result.sessionKey).toContain("openresponses-user:alice");
  });

  it("preserves normal explicit session-key overrides", () => {
    const result = resolveGatewayRequestContext({
      req: createReq({ "x-openclaw-session-key": "customer-case-42" }),
      model: "openclaw",
      sessionPrefix: "openai",
      defaultMessageChannel: "webchat",
    });

    expect(result.sessionKey).toBe("customer-case-42");
  });

  it.each([
    "subagent:worker",
    "cron:daily",
    "acp:run-1",
    "harness:codex:supervision:native-thread",
    "agent:main:subagent:worker",
    "agent:main:cron:daily",
    "agent:main:acp:run-1",
    "agent:main:harness:codex:supervision:native-thread",
  ])("rejects reserved internal session-key override %s", (sessionKey) => {
    expect(() =>
      resolveGatewayRequestContext({
        req: createReq({ "x-openclaw-session-key": sessionKey }),
        model: "openclaw",
        sessionPrefix: "openai",
        defaultMessageChannel: "webchat",
      }),
    ).toThrow(/reserved internal session namespaces/u);
  });

  it("preserves an existing unlocked legacy harness-prefixed override", () => {
    const sessionKey = "agent:main:harness:legacy-notes";
    sessionEntries.set(sessionKey, { sessionId: "legacy-session", modelSelectionLocked: false });

    const result = resolveGatewayRequestContext({
      req: createReq({ "x-openclaw-session-key": sessionKey }),
      model: "openclaw",
      sessionPrefix: "openai",
      defaultMessageChannel: "webchat",
    });

    expect(result.sessionKey).toBe(sessionKey);
  });

  it("rejects an existing locked harness-prefixed override", () => {
    const sessionKey = "agent:main:harness:codex:supervision:native-thread";
    sessionEntries.set(sessionKey, {
      sessionId: "locked-session",
      agentHarnessId: "codex",
      modelSelectionLocked: true,
    });

    expect(() =>
      resolveGatewayRequestContext({
        req: createReq({ "x-openclaw-session-key": sessionKey }),
        model: "openclaw",
        sessionPrefix: "openai",
        defaultMessageChannel: "webchat",
      }),
    ).toThrow(/reserved internal session namespaces/u);
  });

  it("does not build session state for explicit unknown agent ids", () => {
    expect(() =>
      resolveGatewayRequestContext({
        req: createReq({ "x-openclaw-agent-id": "missing-agent" }),
        model: "openclaw",
        sessionPrefix: "openai",
        defaultMessageChannel: "webchat",
      }),
    ).toThrow(/Unknown agent/);

    expect(() =>
      resolveGatewayRequestContext({
        req: createReq(),
        model: "openclaw/missing-agent",
        sessionPrefix: "openai",
        defaultMessageChannel: "webchat",
      }),
    ).toThrow(/Unknown agent/);

    expect(() =>
      resolveGatewayRequestContext({
        req: createReq({ "x-openclaw-agent-id": "!!!" }),
        model: "openclaw",
        sessionPrefix: "openai",
        defaultMessageChannel: "webchat",
      }),
    ).toThrow("Unknown agent '!!!'.");
  });
});

describe("resolveTrustedHttpOperatorScopes", () => {
  it("drops self-asserted scopes for bearer-authenticated requests", () => {
    const scopes = resolveTrustedHttpOperatorScopes(
      createReq({
        authorization: "Bearer secret",
        "x-openclaw-scopes": "operator.admin, operator.write",
      }),
      tokenAuth,
    );

    expect(scopes).toStrictEqual([]);
  });

  it("keeps declared scopes for non-bearer HTTP requests", () => {
    const scopes = resolveTrustedHttpOperatorScopes(
      createReq({
        "x-openclaw-scopes": "operator.admin, operator.write",
      }),
      noneAuth,
    );

    expect(scopes).toEqual(["operator.admin", "operator.write"]);
  });

  it("keeps declared scopes when auth mode is not shared-secret even if auth headers are forwarded", () => {
    const scopes = resolveTrustedHttpOperatorScopes(
      createReq({
        authorization: "Bearer upstream-idp-token",
        "x-openclaw-scopes": "operator.admin, operator.write",
      }),
      noneAuth,
    );

    expect(scopes).toEqual(["operator.admin", "operator.write"]);
  });

  it("drops declared scopes when request auth resolved to a shared-secret method", () => {
    const scopes = resolveTrustedHttpOperatorScopes(
      createReq({
        authorization: "Bearer upstream-idp-token",
        "x-openclaw-scopes": "operator.admin, operator.write",
      }),
      { trustDeclaredOperatorScopes: false },
    );

    expect(scopes).toStrictEqual([]);
  });
});

describe("resolveHttpSenderIsOwner", () => {
  it("requires operator.admin on a trusted HTTP scope-bearing request", () => {
    expect(
      resolveHttpSenderIsOwner(createReq({ "x-openclaw-scopes": "operator.admin" }), noneAuth),
    ).toBe(true);
    expect(
      resolveHttpSenderIsOwner(createReq({ "x-openclaw-scopes": "operator.write" }), noneAuth),
    ).toBe(false);
  });

  it("returns false for bearer requests even with operator.admin in headers", () => {
    expect(
      resolveHttpSenderIsOwner(
        createReq({
          authorization: "Bearer secret",
          "x-openclaw-scopes": "operator.admin",
        }),
        tokenAuth,
      ),
    ).toBe(false);
  });
});

describe("resolveOpenAiCompatibleHttpOperatorScopes", () => {
  it("restores default operator scopes for shared-secret bearer auth", () => {
    const scopes = resolveOpenAiCompatibleHttpOperatorScopes(
      createReq({
        authorization: "Bearer secret",
        "x-openclaw-scopes": "operator.approvals",
      }),
      { authMethod: "token", trustDeclaredOperatorScopes: false },
    );

    expect(scopes).toEqual([
      "operator.admin",
      "operator.read",
      "operator.write",
      "operator.approvals",
      "operator.questions",
      "operator.pairing",
      "operator.talk.secrets",
    ]);
  });

  it("keeps declared scopes for trusted HTTP identity-bearing requests", () => {
    const scopes = resolveOpenAiCompatibleHttpOperatorScopes(
      createReq({
        "x-openclaw-scopes": "operator.write",
      }),
      { authMethod: "trusted-proxy", trustDeclaredOperatorScopes: true },
    );

    expect(scopes).toEqual(["operator.write"]);
  });
});

describe("resolveOpenAiCompatibleHttpSenderIsOwner", () => {
  it("treats shared-secret bearer auth as owner on the compat surface", () => {
    expect(
      resolveOpenAiCompatibleHttpSenderIsOwner(
        createReq({
          authorization: "Bearer secret",
          "x-openclaw-scopes": "operator.approvals",
        }),
        { authMethod: "token", trustDeclaredOperatorScopes: false },
      ),
    ).toBe(true);
  });

  it("still requires operator.admin for trusted scope-bearing requests", () => {
    expect(
      resolveOpenAiCompatibleHttpSenderIsOwner(
        createReq({ "x-openclaw-scopes": "operator.write" }),
        { authMethod: "trusted-proxy", trustDeclaredOperatorScopes: true },
      ),
    ).toBe(false);
    expect(
      resolveOpenAiCompatibleHttpSenderIsOwner(
        createReq({ "x-openclaw-scopes": "operator.admin" }),
        { authMethod: "trusted-proxy", trustDeclaredOperatorScopes: true },
      ),
    ).toBe(true);
  });
});

describe("authorizeOpenAiCompatibleHttpModelOverride", () => {
  it("allows shared-secret bearer callers to use x-openclaw-model", () => {
    expect(
      authorizeOpenAiCompatibleHttpModelOverride(
        createReq({ authorization: "Bearer secret", "x-openclaw-model": "openai/gpt-5.4" }),
        { authMethod: "token", trustDeclaredOperatorScopes: false },
      ),
    ).toEqual({ allowed: true });
  });

  it("allows trusted admin callers to use x-openclaw-model", () => {
    expect(
      authorizeOpenAiCompatibleHttpModelOverride(
        createReq({
          "x-openclaw-scopes": "operator.admin, operator.write",
          "x-openclaw-model": "openai/gpt-5.4",
        }),
        { authMethod: "trusted-proxy", trustDeclaredOperatorScopes: true },
      ),
    ).toEqual({ allowed: true });
  });

  it("rejects trusted write-only callers that try to use x-openclaw-model", () => {
    expect(
      authorizeOpenAiCompatibleHttpModelOverride(
        createReq({
          "x-openclaw-scopes": "operator.write",
          "x-openclaw-model": "openai/gpt-5.4",
        }),
        { authMethod: "trusted-proxy", trustDeclaredOperatorScopes: true },
      ),
    ).toEqual({ allowed: false, missingScope: "operator.admin" });
  });
});
