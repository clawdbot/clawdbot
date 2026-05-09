import type { IncomingMessage } from "node:http";
import { describe, expect, it } from "vitest";
import {
  resolveOpenAiCompatibleHttpOperatorScopes,
  resolveOpenAiCompatibleHttpSenderIsOwner,
  resolveGatewayRequestContext,
  resolveHttpSenderIsOwner,
  resolveTrustedHttpOperatorScopes,
} from "./http-utils.js";

function createReq(headers: Record<string, string> = {}): IncomingMessage {
  return { headers } as IncomingMessage;
}

const tokenAuth = { mode: "token" as const };
const noneAuth = { mode: "none" as const };

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
