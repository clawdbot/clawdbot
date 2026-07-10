/**
 * Gateway method-scope policy tests.
 */
import { afterEach, describe, expect, it } from "vitest";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import {
  authorizeOperatorScopesForMethod,
  isGatewayMethodClassified,
  resolveLeastPrivilegeOperatorScopesForMethod,
} from "./method-scopes.js";
import { createPluginGatewayMethodDescriptor } from "./methods/registry.js";
import { listGatewayMethods } from "./server-methods-list.js";
import { coreGatewayHandlers } from "./server-methods.js";
import type { GatewayRequestHandler } from "./server-methods/types.js";

const RESERVED_ADMIN_PLUGIN_METHOD = "config.plugin.inspect";
const pluginHandler: GatewayRequestHandler = ({ respond }) => respond(true, {});

function setPluginGatewayMethodScope(
  method: string,
  scope: "operator.read" | "operator.write" | "operator.admin",
) {
  const registry = createEmptyPluginRegistry();
  registry.gatewayHandlers[method] = pluginHandler;
  registry.gatewayMethodDescriptors.push(
    createPluginGatewayMethodDescriptor({
      pluginId: "test",
      name: method,
      handler: pluginHandler,
      scope,
    }),
  );
  setActivePluginRegistry(registry);
}

afterEach(() => {
  setActivePluginRegistry(createEmptyPluginRegistry());
});

describe("method scope resolution", () => {
  it.each([
    ["sessions.resolve", ["operator.read"]],
    ["tasks.list", ["operator.read"]],
    ["audit.list", ["operator.read"]],
    ["tasks.get", ["operator.read"]],
    ["taskSuggestions.list", ["operator.read"]],
    ["taskSuggestions.create", ["operator.write"]],
    ["taskSuggestions.accept", ["operator.admin"]],
    ["taskSuggestions.dismiss", ["operator.write"]],
    ["config.schema.lookup", ["operator.read"]],
    ["sessions.create", ["operator.write"]],
    ["sessions.send", ["operator.write"]],
    ["sessions.abort", ["operator.write"]],
    ["tasks.cancel", ["operator.write"]],
    ["tools.invoke", ["operator.write"]],
    ["sessions.messages.subscribe", ["operator.read"]],
    ["sessions.messages.unsubscribe", ["operator.read"]],
    ["environments.list", ["operator.read"]],
    ["worktrees.list", ["operator.read"]],
    ["worktrees.branches", ["operator.write"]],
    ["worktrees.create", ["operator.admin"]],
    ["sessions.groups.list", ["operator.read"]],
    ["sessions.groups.put", ["operator.write"]],
    ["sessions.groups.rename", ["operator.write"]],
    ["sessions.groups.delete", ["operator.write"]],
    ["environments.status", ["operator.read"]],
    ["diagnostics.stability", ["operator.read"]],
    ["skills.curator.status", ["operator.read"]],
    ["skills.curator.pin", ["operator.admin"]],
    ["skills.curator.unpin", ["operator.admin"]],
    ["skills.curator.restore", ["operator.admin"]],
    ["node.pair.approve", ["operator.pairing"]],
    ["poll", ["operator.write"]],
    ["talk.client.create", ["operator.write"]],
    ["talk.client.toolCall", ["operator.write"]],
    ["talk.client.steer", ["operator.write"]],
    ["talk.session.create", ["operator.write"]],
    ["talk.session.join", ["operator.write"]],
    ["talk.session.appendAudio", ["operator.write"]],
    ["talk.session.startTurn", ["operator.write"]],
    ["talk.session.endTurn", ["operator.write"]],
    ["talk.session.cancelTurn", ["operator.write"]],
    ["talk.session.cancelOutput", ["operator.write"]],
    ["talk.session.submitToolResult", ["operator.write"]],
    ["talk.session.steer", ["operator.write"]],
    ["talk.session.close", ["operator.write"]],
    ["update.status", ["operator.admin"]],
    ["config.schema", ["operator.admin"]],
    ["config.patch", ["operator.admin"]],
    ["nativeHook.invoke", ["operator.admin"]],
    ["wizard.start", ["operator.admin"]],
    ["update.run", ["operator.admin"]],
    ["exec.approvals.get", ["operator.admin"]],
    ["exec.approvals.set", ["operator.admin"]],
    ["exec.approvals.node.get", ["operator.admin"]],
    ["exec.approvals.node.set", ["operator.admin"]],
  ])("resolves least-privilege scopes for %s", (method, expected) => {
    expect(resolveLeastPrivilegeOperatorScopesForMethod(method)).toEqual(expected);
  });

  it("leaves node-only pending drain outside operator scopes", () => {
    expect(resolveLeastPrivilegeOperatorScopesForMethod("node.pending.drain")).toStrictEqual([]);
  });

  it("classifies plugin session actions with a CLI-safe default operator scope", () => {
    expect(resolveLeastPrivilegeOperatorScopesForMethod("plugins.sessionAction")).toEqual([
      "operator.write",
    ]);
    expect(isGatewayMethodClassified("plugins.sessionAction")).toBe(true);
    expect(authorizeOperatorScopesForMethod("plugins.sessionAction", ["operator.read"])).toEqual({
      allowed: false,
      missingScope: "operator.write",
    });
  });

  it("derives least-privilege scopes from registered plugin session action params", () => {
    const registry = createEmptyPluginRegistry();
    registry.sessionActions = [
      {
        pluginId: "scope-plugin",
        pluginName: "Scope Plugin",
        source: "test",
        action: {
          id: "approve",
          requiredScopes: ["operator.approvals"],
          handler: () => ({ result: { ok: true } }),
        },
      },
      {
        pluginId: "scope-plugin",
        pluginName: "Scope Plugin",
        source: "test",
        action: {
          id: "view",
          requiredScopes: ["operator.read"],
          handler: () => ({ result: { ok: true } }),
        },
      },
      {
        pluginId: "scope-plugin",
        pluginName: "Scope Plugin",
        source: "test",
        action: {
          id: "default-write",
          handler: () => ({ result: { ok: true } }),
        },
      },
    ];
    setActivePluginRegistry(registry);

    expect(
      resolveLeastPrivilegeOperatorScopesForMethod("plugins.sessionAction", {
        pluginId: "scope-plugin",
        actionId: "approve",
      }),
    ).toEqual(["operator.approvals"]);
    expect(
      resolveLeastPrivilegeOperatorScopesForMethod("plugins.sessionAction", {
        pluginId: " scope-plugin ",
        actionId: " view ",
      }),
    ).toEqual(["operator.read"]);
    expect(
      resolveLeastPrivilegeOperatorScopesForMethod("plugins.sessionAction", {
        pluginId: "scope-plugin",
        actionId: "default-write",
      }),
    ).toEqual(["operator.write"]);
    expect(
      resolveLeastPrivilegeOperatorScopesForMethod("plugins.sessionAction", {
        pluginId: "scope-plugin",
        actionId: "missing",
      }),
    ).toEqual([
      "operator.admin",
      "operator.read",
      "operator.write",
      "operator.approvals",
      "operator.pairing",
      "operator.talk.secrets",
    ]);
    expect(
      authorizeOperatorScopesForMethod("plugins.sessionAction", ["operator.approvals"], {
        pluginId: "scope-plugin",
        actionId: "approve",
      }),
    ).toEqual({ allowed: true });
    expect(
      authorizeOperatorScopesForMethod("plugins.sessionAction", ["operator.write"], {
        pluginId: "scope-plugin",
        actionId: "approve",
      }),
    ).toEqual({ allowed: false, missingScope: "operator.approvals" });
  });

  it("resolves sessions.patch to write scope for chat-organization fields only", () => {
    expect(
      resolveLeastPrivilegeOperatorScopesForMethod("sessions.patch", {
        key: "agent:main:ios-1",
        label: "Trip planning",
        pinned: true,
        archived: false,
      }),
    ).toEqual(["operator.write"]);
    expect(
      resolveLeastPrivilegeOperatorScopesForMethod("sessions.patch", {
        key: "agent:main:ios-1",
        agentId: "main",
        category: "Travel",
        unread: true,
      }),
    ).toEqual(["operator.write"]);
    expect(isGatewayMethodClassified("sessions.patch")).toBe(true);
  });

  it("requires admin only when sessions.create targets an explicit cwd", () => {
    expect(
      resolveLeastPrivilegeOperatorScopesForMethod("sessions.create", { worktree: true }),
    ).toEqual(["operator.write"]);
    expect(
      resolveLeastPrivilegeOperatorScopesForMethod("sessions.create", {
        worktree: true,
        cwd: "/other/repo",
      }),
    ).toEqual(["operator.admin"]);
    expect(
      authorizeOperatorScopesForMethod("sessions.create", ["operator.write"], {
        worktree: true,
        cwd: "/other/repo",
      }),
    ).toEqual({ allowed: false, missingScope: "operator.admin" });
  });

  it("keeps worktree target params at write scope but execNode at admin", () => {
    expect(
      resolveLeastPrivilegeOperatorScopesForMethod("sessions.create", {
        worktree: true,
        worktreeBaseRef: "origin/main",
        worktreeName: "my-task",
      }),
    ).toEqual(["operator.write"]);
    expect(
      resolveLeastPrivilegeOperatorScopesForMethod("sessions.create", {
        execNode: "macbook",
      }),
    ).toEqual(["operator.admin"]);
    expect(
      authorizeOperatorScopesForMethod("sessions.create", ["operator.write"], {
        execNode: "macbook",
      }),
    ).toEqual({ allowed: false, missingScope: "operator.admin" });
  });

  it.each([
    ["model", { key: "agent:main:ios-1", model: "anthropic/claude-sonnet-5" }],
    ["sendPolicy", { key: "agent:main:ios-1", sendPolicy: "deny" }],
    ["inheritedToolAllow", { key: "agent:main:ios-1", inheritedToolAllow: ["exec"] }],
    ["spawnedBy", { key: "agent:main:ios-1", spawnedBy: "agent:main:main" }],
    ["mixed with safe fields", { key: "agent:main:ios-1", label: "x", execHost: "node-1" }],
    ["unknown fields", { key: "agent:main:ios-1", futureField: true }],
  ])("keeps sessions.patch admin-only when params include %s", (_name, params) => {
    expect(resolveLeastPrivilegeOperatorScopesForMethod("sessions.patch", params)).toEqual([
      "operator.admin",
    ]);
    expect(authorizeOperatorScopesForMethod("sessions.patch", ["operator.write"], params)).toEqual({
      allowed: false,
      missingScope: "operator.admin",
    });
    expect(authorizeOperatorScopesForMethod("sessions.patch", ["operator.admin"], params)).toEqual({
      allowed: true,
    });
  });

  it("authorizes write-scoped sessions.patch for chat-organization fields and denies read scope", () => {
    const params = { key: "agent:main:ios-1", label: "Trip planning", pinned: true };
    expect(authorizeOperatorScopesForMethod("sessions.patch", ["operator.write"], params)).toEqual({
      allowed: true,
    });
    expect(authorizeOperatorScopesForMethod("sessions.patch", ["operator.read"], params)).toEqual({
      allowed: false,
      missingScope: "operator.write",
    });
  });

  it("lets malformed sessions.patch params through to handler validation at write scope", () => {
    // Malformed params cannot mutate anything; the handler rejects them with a
    // precise validation error instead of a misleading missing-scope error.
    expect(authorizeOperatorScopesForMethod("sessions.patch", ["operator.write"])).toEqual({
      allowed: true,
    });
    expect(resolveLeastPrivilegeOperatorScopesForMethod("sessions.patch")).toEqual([
      "operator.write",
    ]);
  });

  it("grants write-scope sessions.delete only with the archivedOnly opt-in", () => {
    // Internal callers (subagent cleanup, fallback synthetic dispatch, CLI
    // minting) never set archivedOnly and keep requiring admin; the handler
    // enforces that archivedOnly targets are actually archived.
    expect(resolveLeastPrivilegeOperatorScopesForMethod("sessions.delete")).toEqual([
      "operator.admin",
    ]);
    expect(
      resolveLeastPrivilegeOperatorScopesForMethod("sessions.delete", {
        key: "agent:main:old",
        deleteTranscript: true,
      }),
    ).toEqual(["operator.admin"]);
    expect(
      resolveLeastPrivilegeOperatorScopesForMethod("sessions.delete", {
        key: "agent:main:old",
        archivedOnly: true,
      }),
    ).toEqual(["operator.write"]);
    const archivedParams = { key: "agent:main:old", archivedOnly: true };
    expect(
      authorizeOperatorScopesForMethod("sessions.delete", ["operator.write"], archivedParams),
    ).toEqual({ allowed: true });
    expect(
      authorizeOperatorScopesForMethod("sessions.delete", ["operator.read"], archivedParams),
    ).toEqual({ allowed: false, missingScope: "operator.write" });
    expect(
      authorizeOperatorScopesForMethod("sessions.delete", ["operator.write"], {
        key: "agent:main:old",
      }),
    ).toEqual({ allowed: false, missingScope: "operator.admin" });
    expect(
      authorizeOperatorScopesForMethod("sessions.delete", ["operator.write"], {
        key: "agent:main:old",
        archivedOnly: "yes",
      }),
    ).toEqual({ allowed: false, missingScope: "operator.admin" });
    // Internal-only controls must not ride along on the write-scope path.
    expect(
      authorizeOperatorScopesForMethod("sessions.delete", ["operator.write"], {
        key: "agent:main:old",
        archivedOnly: true,
        emitLifecycleHooks: false,
      }),
    ).toEqual({ allowed: false, missingScope: "operator.admin" });
    expect(
      authorizeOperatorScopesForMethod("sessions.delete", ["operator.write"], {
        key: "agent:main:old",
        archivedOnly: true,
        expectedSessionId: "sess-1",
      }),
    ).toEqual({ allowed: false, missingScope: "operator.admin" });
    expect(
      resolveLeastPrivilegeOperatorScopesForMethod("sessions.delete", {
        key: "agent:main:old",
        archivedOnly: true,
        emitLifecycleHooks: false,
      }),
    ).toEqual(["operator.admin"]);
    expect(authorizeOperatorScopesForMethod("sessions.delete", ["operator.admin"])).toEqual({
      allowed: true,
    });
  });

  it("falls back to broad operator scopes when a dynamic session action is not locally registered", () => {
    expect(
      resolveLeastPrivilegeOperatorScopesForMethod("plugins.sessionAction", {
        pluginId: "remote-plugin",
        actionId: "approve",
      }),
    ).toEqual([
      "operator.admin",
      "operator.read",
      "operator.write",
      "operator.approvals",
      "operator.pairing",
      "operator.talk.secrets",
    ]);
  });

  it("returns empty scopes for unknown methods", () => {
    expect(resolveLeastPrivilegeOperatorScopesForMethod("totally.unknown.method")).toStrictEqual(
      [],
    );
  });

  it("reads plugin-registered gateway method scopes from the active plugin registry", () => {
    const registry = createEmptyPluginRegistry();
    registry.gatewayHandlers["browser.request"] = pluginHandler;
    registry.gatewayMethodDescriptors.push(
      createPluginGatewayMethodDescriptor({
        pluginId: "browser",
        name: "browser.request",
        handler: pluginHandler,
        scope: "operator.admin",
      }),
    );
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
    ["config.schema", ["operator.read"], { allowed: false, missingScope: "operator.admin" }],
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
      "talk.client.steer",
      "talk.session.create",
      "talk.session.join",
      "talk.session.appendAudio",
      "talk.session.startTurn",
      "talk.session.endTurn",
      "talk.session.cancelTurn",
      "talk.session.cancelOutput",
      "talk.session.submitToolResult",
      "talk.session.steer",
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
    "exec.approvals.get",
    "exec.approvals.set",
    "exec.approvals.node.get",
    "exec.approvals.node.set",
  ])("requires admin scope for exec approval policy method %s", (method) => {
    expect(authorizeOperatorScopesForMethod(method, ["operator.approvals"])).toEqual({
      allowed: false,
      missingScope: "operator.admin",
    });
    expect(authorizeOperatorScopesForMethod(method, ["operator.admin"])).toEqual({
      allowed: true,
    });
  });

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

  it("exposes skill proposal methods through the core gateway registry", () => {
    for (const method of ["skills.proposals.list", "skills.proposals.inspect"]) {
      expect(listGatewayMethods()).toContain(method);
      expect(coreGatewayHandlers).toHaveProperty(method);
      expect(resolveLeastPrivilegeOperatorScopesForMethod(method)).toEqual(["operator.read"]);
      expect(authorizeOperatorScopesForMethod(method, ["operator.read"])).toEqual({
        allowed: true,
      });
    }

    for (const method of [
      "skills.proposals.create",
      "skills.proposals.update",
      "skills.proposals.revise",
      "skills.proposals.apply",
      "skills.proposals.reject",
      "skills.proposals.quarantine",
    ]) {
      expect(listGatewayMethods()).toContain(method);
      expect(coreGatewayHandlers).toHaveProperty(method);
      expect(resolveLeastPrivilegeOperatorScopesForMethod(method)).toEqual(["operator.admin"]);
      expect(authorizeOperatorScopesForMethod(method, ["operator.write"])).toEqual({
        allowed: false,
        missingScope: "operator.admin",
      });
      expect(authorizeOperatorScopesForMethod(method, ["operator.admin"])).toEqual({
        allowed: true,
      });
    }
  });
});

describe("CLI default operator scopes", () => {
  it("includes operator.talk.secrets for node-role device pairing approvals", async () => {
    const { CLI_DEFAULT_OPERATOR_SCOPES } = await import("./method-scopes.js");
    expect(CLI_DEFAULT_OPERATOR_SCOPES).toContain("operator.talk.secrets");
  });
});
