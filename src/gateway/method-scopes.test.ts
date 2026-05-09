import { afterEach, describe, expect, it } from "vitest";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import {
  authorizeOperatorScopesForMethod,
  isGatewayMethodClassified,
  resolveLeastPrivilegeOperatorScopesForMethod,
} from "./method-scopes.js";
import { listGatewayMethods } from "./server-methods-list.js";
import { coreGatewayHandlers } from "./server-methods.js";

const RESERVED_ADMIN_PLUGIN_METHOD = "config.plugin.inspect";

function setPluginGatewayMethodScope(
  method: string,
  scope: "operator.read" | "operator.write" | "operator.admin",
) {
  const registry = createEmptyPluginRegistry();
  registry.gatewayMethodScopes = {
    [method]: scope,
  };
  setActivePluginRegistry(registry);
}

afterEach(() => {
  setActivePluginRegistry(createEmptyPluginRegistry());
});

describe("method scope resolution", () => {
  it.each([
    ["sessions.resolve", ["operator.read"]],
    ["tasks.list", ["operator.read"]],
    ["tasks.get", ["operator.read"]],
    ["config.schema.lookup", ["operator.read"]],
    ["sessions.create", ["operator.write"]],
    ["sessions.send", ["operator.write"]],
    ["sessions.abort", ["operator.write"]],
    ["tasks.cancel", ["operator.write"]],
    ["tools.invoke", ["operator.write"]],
    ["sessions.messages.subscribe", ["operator.read"]],
    ["sessions.messages.unsubscribe", ["operator.read"]],
    ["environments.list", ["operator.read"]],
    ["environments.status", ["operator.read"]],
    ["diagnostics.stability", ["operator.read"]],
    ["node.pair.approve", ["operator.pairing"]],
    ["poll", ["operator.write"]],
    ["talk.client.create", ["operator.write"]],
    ["talk.client.toolCall", ["operator.write"]],
    ["talk.session.create", ["operator.write"]],
    ["talk.session.join", ["operator.write"]],
    ["talk.session.appendAudio", ["operator.write"]],
    ["talk.session.startTurn", ["operator.write"]],
    ["talk.session.endTurn", ["operator.write"]],
    ["talk.session.cancelTurn", ["operator.write"]],
    ["talk.session.cancelOutput", ["operator.write"]],
    ["talk.session.submitToolResult", ["operator.write"]],
    ["talk.session.close", ["operator.write"]],
    ["update.status", ["operator.admin"]],
    ["config.patch", ["operator.admin"]],
    ["nativeHook.invoke", ["operator.admin"]],
    ["wizard.start", ["operator.admin"]],
    ["update.run", ["operator.admin"]],
  ])("resolves least-privilege scopes for %s", (method, expected) => {
    expect(resolveLeastPrivilegeOperatorScopesForMethod(method)).toEqual(expected);
  });

  it("leaves node-only pending drain outside operator scopes", () => {
    expect(resolveLeastPrivilegeOperatorScopesForMethod("node.pending.drain")).toStrictEqual([]);
  });

  it("returns empty scopes for unknown methods", () => {
    expect(resolveLeastPrivilegeOperatorScopesForMethod("totally.unknown.method")).toStrictEqual(
      [],
    );
  });

  it("reads plugin-registered gateway method scopes from the active plugin registry", () => {
    const registry = createEmptyPluginRegistry();
    registry.gatewayMethodScopes = {
      "browser.request": "operator.admin",
    };
    setActivePluginRegistry(registry);

    expect(resolveLeastPrivilegeOperatorScopesForMethod("browser.request")).toEqual([
      "operator.admin",
    ]);
  });

  it("keeps reserved admin namespaces admin-only even if a plugin scope is narrower", () => {
    setPluginGatewayMethodScope(RESERVED_ADMIN_PLUGIN_METHOD, "operator.read");

    expect(resolveLeastPrivilegeOperatorScopesForMethod(RESERVED_ADMIN_PLUGIN_METHOD)).toEqual([
      "operator.admin",
    ]);
  });
});

describe("operator scope authorization", () => {
  it.each([
    ["health", ["operator.read"], { allowed: true }],
    ["health", ["operator.write"], { allowed: true }],
    ["config.schema.lookup", ["operator.read"], { allowed: true }],
    ["config.patch", ["operator.admin"], { allowed: true }],
  ])("authorizes %s for scopes %j", (method, scopes, expected) => {
    expect(authorizeOperatorScopesForMethod(method, scopes)).toEqual(expected);
  });

  it("requires operator.write for write methods", () => {
    expect(authorizeOperatorScopesForMethod("send", ["operator.read"])).toEqual({
      allowed: false,
      missingScope: "operator.write",
    });
  });

  it("allows operator.write clients to use unified Talk sessions", () => {
    for (const method of [
      "talk.client.create",
      "talk.client.toolCall",
      "talk.session.create",
      "talk.session.join",
      "talk.session.appendAudio",
      "talk.session.startTurn",
      "talk.session.endTurn",
      "talk.session.cancelTurn",
      "talk.session.cancelOutput",
      "talk.session.submitToolResult",
      "talk.session.close",
    ]) {
      expect(authorizeOperatorScopesForMethod(method, ["operator.write"])).toEqual({
        allowed: true,
      });
      expect(authorizeOperatorScopesForMethod(method, ["operator.read"])).toEqual({
        allowed: false,
        missingScope: "operator.write",
      });
    }
  });

  it("requires admin for browser.request", () => {
    setPluginGatewayMethodScope("browser.request", "operator.admin");

    expect(authorizeOperatorScopesForMethod("browser.request", ["operator.write"])).toEqual({
      allowed: false,
      missingScope: "operator.admin",
    });
    expect(authorizeOperatorScopesForMethod("browser.request", ["operator.admin"])).toEqual({
      allowed: true,
    });
  });

  it("requires pairing scope for node pairing approvals", () => {
    expect(authorizeOperatorScopesForMethod("node.pair.approve", ["operator.pairing"])).toEqual({
      allowed: true,
    });
    expect(authorizeOperatorScopesForMethod("node.pair.approve", ["operator.write"])).toEqual({
      allowed: false,
      missingScope: "operator.pairing",
    });
  });

  it.each(["exec.approval.get", "exec.approval.list", "exec.approval.resolve"])(
    "requires approvals scope for %s",
    (method) => {
      expect(authorizeOperatorScopesForMethod(method, ["operator.write"])).toEqual({
        allowed: false,
        missingScope: "operator.approvals",
      });
      expect(authorizeOperatorScopesForMethod(method, ["operator.approvals"])).toEqual({
        allowed: true,
      });
    },
  );

  it.each([
    "plugin.approval.list",
    "plugin.approval.request",
    "plugin.approval.waitDecision",
    "plugin.approval.resolve",
  ])("requires approvals scope for %s", (method) => {
    expect(authorizeOperatorScopesForMethod(method, ["operator.write"])).toEqual({
      allowed: false,
      missingScope: "operator.approvals",
    });
    expect(authorizeOperatorScopesForMethod(method, ["operator.approvals"])).toEqual({
      allowed: true,
    });
  });

  it("requires admin for unknown methods", () => {
    expect(authorizeOperatorScopesForMethod("unknown.method", ["operator.read"])).toEqual({
      allowed: false,
      missingScope: "operator.admin",
    });
  });

  it("requires admin for reserved admin namespaces even if a plugin registered a narrower scope", () => {
    setPluginGatewayMethodScope(RESERVED_ADMIN_PLUGIN_METHOD, "operator.read");

    expect(
      authorizeOperatorScopesForMethod(RESERVED_ADMIN_PLUGIN_METHOD, ["operator.read"]),
    ).toEqual({
      allowed: false,
      missingScope: "operator.admin",
    });
  });
});

describe("plugin approval method registration", () => {
  it("lists all plugin approval methods", () => {
    const methods = listGatewayMethods();
    expect(methods).toContain("plugin.approval.list");
    expect(methods).toContain("plugin.approval.request");
    expect(methods).toContain("plugin.approval.waitDecision");
    expect(methods).toContain("plugin.approval.resolve");
  });

  it("classifies plugin approval methods", () => {
    expect(isGatewayMethodClassified("plugin.approval.list")).toBe(true);
    expect(isGatewayMethodClassified("plugin.approval.request")).toBe(true);
    expect(isGatewayMethodClassified("plugin.approval.waitDecision")).toBe(true);
    expect(isGatewayMethodClassified("plugin.approval.resolve")).toBe(true);
  });
});

describe("core gateway method classification", () => {
  it("treats node-role methods as classified even without operator scopes", () => {
    expect(isGatewayMethodClassified("node.pending.drain")).toBe(true);
    expect(isGatewayMethodClassified("node.pending.pull")).toBe(true);
    expect(isGatewayMethodClassified("node.pluginSurface.refresh")).toBe(true);
  });

  it("classifies every exposed core gateway handler method", () => {
    const unclassified = Object.keys(coreGatewayHandlers).filter(
      (method) => !isGatewayMethodClassified(method),
    );
    expect(unclassified).toStrictEqual([]);
  });

  it("classifies every listed gateway method name", () => {
    const unclassified = listGatewayMethods().filter(
      (method) => !isGatewayMethodClassified(method),
    );
    expect(unclassified).toStrictEqual([]);
  });
});

describe("CLI default operator scopes", () => {
  it("includes operator.talk.secrets for node-role device pairing approvals", async () => {
    const { CLI_DEFAULT_OPERATOR_SCOPES } = await import("./method-scopes.js");
    expect(CLI_DEFAULT_OPERATOR_SCOPES).toContain("operator.talk.secrets");
  });
});
