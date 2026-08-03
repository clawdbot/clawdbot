/**
 * Plugin route runtime-scope regression tests for trusted-proxy headers.
 */
import type { IncomingMessage } from "node:http";
import { describe, expect, it } from "vitest";
import { resolvePluginRouteRuntimeOperatorScopes } from "./plugin-route-runtime-scopes.js";

function createReq(headers: Record<string, string> = {}): IncomingMessage {
  return { headers } as IncomingMessage;
}

describe("resolvePluginRouteRuntimeOperatorScopes", () => {
  it("preserves declared trusted-proxy scopes when the header is present", () => {
    expect(
      resolvePluginRouteRuntimeOperatorScopes(createReq({ "x-openclaw-scopes": "operator.read" }), {
        authMethod: "trusted-proxy",
        trustDeclaredOperatorScopes: true,
      }),
    ).toEqual(["operator.read"]);
  });

  it("keeps trusted-proxy plugin routes on write scope when the header is absent", () => {
    expect(
      resolvePluginRouteRuntimeOperatorScopes(createReq(), {
        authMethod: "trusted-proxy",
        trustDeclaredOperatorScopes: true,
      }),
    ).toEqual(["operator.write"]);
  });

  it("keeps shared-secret bearer plugin routes on write scope even when scopes are declared", () => {
    expect(
      resolvePluginRouteRuntimeOperatorScopes(
        createReq({
          authorization: "Bearer secret",
          "x-openclaw-scopes": "operator.admin,operator.write",
        }),
        { authMethod: "token", trustDeclaredOperatorScopes: false },
      ),
    ).toEqual(["operator.write"]);
  });

  it("does not trust caller-declared admin scopes on plugin routes for mode=none requests", () => {
    expect(
      resolvePluginRouteRuntimeOperatorScopes(
        createReq({ "x-openclaw-scopes": "operator.admin,operator.write" }),
        { authMethod: "none", trustDeclaredOperatorScopes: true },
      ),
    ).toEqual(["operator.write"]);
  });

  it("restores trusted default operator scopes for shared-secret bearer routes opting into trusted-operator surface", () => {
    expect(
      resolvePluginRouteRuntimeOperatorScopes(
        createReq({
          authorization: "Bearer secret",
        }),
        { authMethod: "token", trustDeclaredOperatorScopes: false },
        "trusted-operator",
      ),
    ).toEqual([
      "operator.admin",
      "operator.read",
      "operator.write",
      "operator.approvals",
      "operator.questions",
      "operator.pairing",
      "operator.talk.secrets",
    ]);
  });

  it("restores trusted default operator scopes for trusted-proxy routes opting into trusted-operator when scopes header is absent", () => {
    expect(
      resolvePluginRouteRuntimeOperatorScopes(
        createReq(),
        { authMethod: "trusted-proxy", trustDeclaredOperatorScopes: true },
        "trusted-operator",
      ),
    ).toEqual([
      "operator.admin",
      "operator.read",
      "operator.write",
      "operator.approvals",
      "operator.questions",
      "operator.pairing",
      "operator.talk.secrets",
    ]);
  });

  it("preserves trusted-proxy declared scopes for routes opting into trusted-operator surface", () => {
    expect(
      resolvePluginRouteRuntimeOperatorScopes(
        createReq({ "x-openclaw-scopes": "operator.admin,operator.write" }),
        { authMethod: "trusted-proxy", trustDeclaredOperatorScopes: true },
        "trusted-operator",
      ),
    ).toEqual(["operator.admin", "operator.write"]);
  });
});
