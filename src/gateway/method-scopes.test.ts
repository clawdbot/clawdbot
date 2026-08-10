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
    ["audit.activity.list", ["operator.read"]],
    ["audit.run.inspect", ["operator.read"]],
    ["audit.list", ["operator.read"]],
    ["users.list", ["operator.read"]],
    ["users.self", ["operator.write"]],
    ["users.linkEmail", ["operator.admin"]],
    ["users.setDisplayName", ["operator.write"]],
    ["users.setAvatar", ["operator.write"]],
    ["tasks.get", ["operator.read"]],
    ["taskSuggestions.list", ["operator.read"]],
    ["taskSuggestions.create", ["operator.write"]],
    ["taskSuggestions.accept", ["operator.admin"]],
    ["taskSuggestions.dismiss", ["operator.write"]],
    ["config.schema.lookup", ["operator.read"]],
    ["sessions.create", ["operator.write"]],
    ["sessions.dispatch", ["operator.admin"]],
    ["sessions.reclaim", ["operator.admin"]],
    ["sessions.send", ["operator.write"]],
    ["sessions.abort", ["operator.write"]],
    ["sessions.patchMany", ["operator.write"]],
    ["tasks.cancel", ["operator.write"]],
    ["tasks.retry", ["operator.write"]],
    ["tasks.dismiss", ["operator.write"]],
    ["tools.invoke", ["operator.write"]],
    ["sessions.messages.subscribe", ["operator.read"]],
    ["sessions.messages.unsubscribe", ["operator.read"]],
    ["environments.list", ["operator.read"]],
    ["environments.create", ["operator.admin"]],
    ["environments.destroy", ["operator.admin"]],
    ["worktrees.list", ["operator.read"]],
    ["worktrees.branches", ["operator.write"]],
    ["worktrees.create", ["operator.admin"]],
    ["sessions.groups.list", ["operator.read"]],
    ["sessions.groups.put", ["operator.write"]],
    ["sessions.groups.rename", ["operator.write"]],
    ["sessions.groups.delete", ["operator.write"]],
    ["sessions.catalog.list", ["operator.read"]],
    ["sessions.catalog.read", ["operator.read"]],
    ["sessions.catalog.continue", ["operator.write"]],
    ["sessions.catalog.archive", ["operator.write"]],
    ["sessions.catalog.startTerminal", ["operator.admin"]],
    ["session.discussion.info", ["operator.read"]],
    ["session.discussion.open", ["operator.write"]],
    ["environments.status", ["operator.read"]],
    ["diagnostics.stability", ["operator.read"]],
    ["gateway.restart.preflight", ["operator.read"]],
    ["skills.curator.status", ["operator.read"]],
    ["hooks.status", ["operator.read"]],
    ["skills.curator.pin", ["operator.admin"]],
    ["skills.curator.unpin", ["operator.admin"]],
    ["skills.curator.restore", ["operator.admin"]],
    ["node.pair.approve", ["operator.pairing"]],
    ["poll", ["operator.write"]],
    ["talk.client.create", ["operator.talk"]],
    ["talk.client.transcript", ["operator.talk"]],
    ["talk.client.close", ["operator.talk"]],
    ["talk.client.toolCall", ["operator.talk"]],
    ["talk.client.steer", ["operator.talk"]],
    ["talk.session.create", ["operator.talk"]],
    ["talk.session.appendAudio", ["operator.talk"]],
    ["talk.session.cancelOutput", ["operator.talk"]],
    ["talk.session.acknowledgeMark", ["operator.talk"]],
    ["talk.session.submitToolResult", ["operator.talk"]],
    ["talk.session.steer", ["operator.talk"]],
    ["talk.session.close", ["operator.talk"]],
    ["update.status", ["operator.admin"]],
    ["update.hold", ["operator.admin"]],
    ["config.schema", ["operator.admin"]],
    ["config.patch", ["operator.admin"]],
    ["nativeHook.invoke", ["operator.admin"]],
    ["wizard.start", ["operator.admin"]],
    ["update.run", ["operator.admin"]],
    ["exec.approvals.get", ["operator.admin"]],
    ["exec.approvals.set", ["operator.admin"]],
    ["exec.approvals.node.get", ["operator.admin"]],
    ["exec.approvals.node.set", ["operator.admin"]],
    ["conversations.list", ["operator.admin"]],
    ["conversations.send", ["operator.admin"]],
    ["conversations.turn", ["operator.admin"]],
    ["conversations.turn.cancel", ["operator.admin"]],
  ])("resolves least-privilege scopes for %s", (method, expected) => {
    expect(resolveLeastPrivilegeOperatorScopesForMethod(method)).toEqual(expected);
  });

  it("leaves node-only pending drain outside operator scopes", () => {
    expect(resolveLeastPrivilegeOperatorScopesForMethod("node.pending.drain")).toStrictEqual([]);
  });

  it("raises agent reset commands from write to admin scope", () => {
    expect(resolveLeastPrivilegeOperatorScopesForMethod("agent", { message: "hello" })).toEqual([
      "operator.write",
    ]);
    expect(resolveLeastPrivilegeOperatorScopesForMethod("agent", { message: "/reset" })).toEqual([
      "operator.admin",
    ]);
    expect(
      resolveLeastPrivilegeOperatorScopesForMethod("agent", { message: "/new follow up" }),
    ).toEqual(["operator.admin"]);
    expect(
      authorizeOperatorScopesForMethod("agent", ["operator.write"], { message: "/reset" }),
    ).toEqual({ allowed: false, missingScope: "operator.admin" });
  });

  it("raises host-sensitive node commands from write to admin scope", () => {
    expect(
      resolveLeastPrivilegeOperatorScopesForMethod("node.invoke", { command: "device.info" }),
    ).toEqual(["operator.write"]);
    expect(
      resolveLeastPrivilegeOperatorScopesForMethod("node.invoke", { command: "browser.proxy" }),
    ).toEqual(["operator.admin"]);
    expect(
      resolveLeastPrivilegeOperatorScopesForMethod("node.invoke", {
        command: "browser.proxy.upload.v1",
      }),
    ).toEqual(["operator.admin"]);
    expect(
      authorizeOperatorScopesForMethod("node.invoke", ["operator.write"], {
        command: "fs.listDir",
      }),
    ).toEqual({ allowed: false, missingScope: "operator.admin" });
    expect(
      resolveLeastPrivilegeOperatorScopesForMethod("node.invoke", {
        command: "browser.proxy.upload.v1",
        params: { method: "POST", path: "/profiles/create" },
      }),
    ).toEqual(["operator.write"]);
  });

  it("adds talk secret scope only when unredacted config is requested", () => {
    expect(resolveLeastPrivilegeOperatorScopesForMethod("talk.config", {})).toEqual([
      "operator.read",
    ]);
    expect(
      resolveLeastPrivilegeOperatorScopesForMethod("talk.config", { includeSecrets: true }),
    ).toEqual(["operator.read", "operator.talk.secrets"]);
    expect(
      authorizeOperatorScopesForMethod("talk.config", ["operator.read"], {
        includeSecrets: true,
      }),
    ).toEqual({ allowed: false, missingScope: "operator.talk.secrets" });
    expect(
      authorizeOperatorScopesForMethod("talk.config", ["operator.read", "operator.talk.secrets"], {
        includeSecrets: true,
      }),
    ).toEqual({ allowed: true });
  });

  it("accepts dedicated Talk access and preserves operator.write compatibility", () => {
    expect(authorizeOperatorScopesForMethod("talk.client.create", ["operator.talk"])).toEqual({
      allowed: true,
    });
    expect(authorizeOperatorScopesForMethod("talk.client.create", ["operator.write"])).toEqual({
      allowed: true,
    });
    expect(authorizeOperatorScopesForMethod("talk.client.create", ["operator.read"])).toEqual({
      allowed: false,
      missingScope: "operator.talk",
    });
  });

  it("requires admin only when DM pairing approval bootstraps a command owner", () => {
    expect(resolveLeastPrivilegeOperatorScopesForMethod("channels.pairing.approve", {})).toEqual([
      "operator.pairing",
    ]);
    expect(
      resolveLeastPrivilegeOperatorScopesForMethod("channels.pairing.approve", {
        bootstrapCommandOwner: true,
      }),
    ).toEqual(["operator.pairing", "operator.admin"]);
    expect(
      authorizeOperatorScopesForMethod("channels.pairing.approve", ["operator.pairing"], {
        bootstrapCommandOwner: true,
      }),
    ).toEqual({ allowed: false, missingScope: "operator.admin" });
    expect(
      authorizeOperatorScopesForMethod(
        "channels.pairing.approve",
        ["operator.pairing", "operator.admin"],
        { bootstrapCommandOwner: true },
      ),
    ).toEqual({ allowed: true });
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
      "operator.questions",
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
        boardFace: "dashboard",
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

  it("defers Gateway cwd containment to sessions.create while keeping node cwd admin-only", () => {
    expect(
      resolveLeastPrivilegeOperatorScopesForMethod("sessions.create", { worktree: true }),
    ).toEqual(["operator.write"]);
    expect(
      resolveLeastPrivilegeOperatorScopesForMethod("sessions.create", { cwd: "/other/repo" }),
    ).toEqual(["operator.write"]);
    expect(
      authorizeOperatorScopesForMethod("sessions.create", ["operator.write"], {
        cwd: "/other/repo",
      }),
    ).toEqual({ allowed: true });
    expect(
      resolveLeastPrivilegeOperatorScopesForMethod("sessions.create", {
        worktree: true,
        cwd: "/other/repo",
      }),
    ).toEqual(["operator.write"]);
    expect(
      authorizeOperatorScopesForMethod("sessions.create", ["operator.write"], {
        worktree: true,
        cwd: "/other/repo",
      }),
    ).toEqual({ allowed: true });
    expect(
      resolveLeastPrivilegeOperatorScopesForMethod("sessions.create", {
        execNode: "macbook",
        cwd: "/other/repo",
      }),
    ).toEqual(["operator.admin"]);
  });

  it("keeps Gateway fs.listDir write-scoped and node browsing admin-only", () => {
    expect(resolveLeastPrivilegeOperatorScopesForMethod("fs.listDir", {})).toEqual([
      "operator.write",
    ]);
    expect(
      authorizeOperatorScopesForMethod("fs.listDir", ["operator.write"], {
        path: "/configured/workspace",
      }),
    ).toEqual({ allowed: true });
    expect(
      resolveLeastPrivilegeOperatorScopesForMethod("fs.listDir", { nodeId: "macbook" }),
    ).toEqual(["operator.admin"]);
    expect(
      authorizeOperatorScopesForMethod("fs.listDir", ["operator.write"], {
        nodeId: "macbook",
      }),
    ).toEqual({ allowed: false, missingScope: "operator.admin" });
  });

  it("requires admin for incognito session creation and inheritance", () => {
    const incognitoKey = "agent:main:dashboard:incognito-parent";
    for (const params of [
      { agentId: "main", incognito: true },
      { key: incognitoKey },
      { parentSessionKey: incognitoKey },
      { parentSessionKey: incognitoKey, fork: true },
      { parentSessionKey: incognitoKey, spawnDepth: 1 },
      { parentSessionKey: incognitoKey, succeedsParent: false, emitCommandHooks: true },
    ]) {
      expect(resolveLeastPrivilegeOperatorScopesForMethod("sessions.create", params)).toEqual([
        "operator.admin",
      ]);
      expect(
        authorizeOperatorScopesForMethod("sessions.create", ["operator.write"], params),
      ).toEqual({ allowed: false, missingScope: "operator.admin" });
      expect(
        authorizeOperatorScopesForMethod("sessions.create", ["operator.admin"], params),
      ).toEqual({ allowed: true });
    }
    expect(
      resolveLeastPrivilegeOperatorScopesForMethod("sessions.create", { incognito: false }),
    ).toEqual(["operator.write"]);
  });

  it("keeps keyed sessions.create model selection at write scope for handler-state checks", () => {
    expect(
      resolveLeastPrivilegeOperatorScopesForMethod("sessions.create", {
        agentId: "main",
        label: "Dashboard",
        model: "openai/gpt-5.5",
      }),
    ).toEqual(["operator.write"]);
    expect(
      resolveLeastPrivilegeOperatorScopesForMethod("sessions.create", {
        key: "agent:main:dashboard:existing",
        label: "Dashboard",
      }),
    ).toEqual(["operator.write"]);
    expect(
      resolveLeastPrivilegeOperatorScopesForMethod("sessions.create", {
        key: "agent:main:dashboard:existing",
        model: "openai/gpt-5.5",
      }),
    ).toEqual(["operator.write"]);
    expect(
      resolveLeastPrivilegeOperatorScopesForMethod("sessions.create", {
        key: "agent:main:dashboard:existing",
        thinkingLevel: "high",
      }),
    ).toEqual(["operator.write"]);

    for (const params of [
      { key: "agent:main:dashboard:existing", model: "openai/gpt-5.5" },
      { key: "agent:main:dashboard:existing", thinkingLevel: "high" },
      {
        key: "agent:main:dashboard:existing",
        label: "Dashboard",
        model: "openai/gpt-5.5",
        thinkingLevel: "high",
      },
    ]) {
      expect(
        authorizeOperatorScopesForMethod("sessions.create", ["operator.write"], params),
      ).toEqual({
        allowed: true,
      });
      expect(
        authorizeOperatorScopesForMethod("sessions.create", ["operator.admin"], params),
      ).toEqual({
        allowed: true,
      });
    }
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
    expect(
      authorizeOperatorScopesForMethod("sessions.create", ["operator.write"], {
        execNode: "macbook",
        cwd: "/Users/peter/Projects/openclaw",
      }),
    ).toEqual({ allowed: false, missingScope: "operator.admin" });
  });

  it("delegates effort patches to the admin-scoped session policy", () => {
    const params = { key: "agent:main:ios-1", thinkingLevel: "high" };
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

  it("delegates model patches to the write-scoped session policy", () => {
    const params = { key: "agent:main:ios-1", model: "anthropic/claude-sonnet-5" };
    expect(resolveLeastPrivilegeOperatorScopesForMethod("sessions.patch", params)).toEqual([
      "operator.write",
    ]);
    expect(authorizeOperatorScopesForMethod("sessions.patch", ["operator.write"], params)).toEqual({
      allowed: true,
    });
    expect(authorizeOperatorScopesForMethod("sessions.patch", ["operator.read"], params)).toEqual({
      allowed: false,
      missingScope: "operator.write",
    });
    expect(authorizeOperatorScopesForMethod("sessions.patch", ["operator.admin"], params)).toEqual({
      allowed: true,
    });
  });

  it("delegates sessions.patchMany from its patch fields", () => {
    expect(
      resolveLeastPrivilegeOperatorScopesForMethod("sessions.patchMany", {
        targets: [
          {
            key: "agent:main:ios-1",
            agentId: "main",
            expectedSessionId: "session-1",
            expectedLifecycleRevision: "revision-1",
          },
        ],
        patch: { model: "openai/gpt-5.6-luna" },
      }),
    ).toEqual(["operator.write"]);
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
      "operator.questions",
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

  it("authorizes execution identity inspection with operator.read and rejects unrelated scopes", () => {
    expect(authorizeOperatorScopesForMethod("audit.run.inspect", ["operator.read"])).toEqual({
      allowed: true,
    });
    expect(authorizeOperatorScopesForMethod("audit.run.inspect", ["operator.approvals"])).toEqual({
      allowed: false,
      missingScope: "operator.read",
    });
  });

  it("requires operator.write for write methods", () => {
    expect(authorizeOperatorScopesForMethod("send", ["operator.read"])).toEqual({
      allowed: false,
      missingScope: "operator.write",
    });
  });

  it("allows operator.talk and legacy operator.write clients to use unified Talk sessions", () => {
    for (const method of [
      "talk.client.create",
      "talk.client.transcript",
      "talk.client.close",
      "talk.client.toolCall",
      "talk.client.steer",
      "talk.session.create",
      "talk.session.appendAudio",
      "talk.session.cancelOutput",
      "talk.session.acknowledgeMark",
      "talk.session.submitToolResult",
      "talk.session.steer",
      "talk.session.close",
    ]) {
      expect(authorizeOperatorScopesForMethod(method, ["operator.talk"])).toEqual({
        allowed: true,
      });
      expect(authorizeOperatorScopesForMethod(method, ["operator.write"])).toEqual({
        allowed: true,
      });
      expect(authorizeOperatorScopesForMethod(method, ["operator.read"])).toEqual({
        allowed: false,
        missingScope: "operator.talk",
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

  it.each([
    "approval.get",
    "approval.history",
    "approval.resolve",
    "exec.approval.get",
    "exec.approval.list",
    "exec.approval.resolve",
  ])("requires approvals scope for %s", (method) => {
    expect(authorizeOperatorScopesForMethod(method, ["operator.write"])).toEqual({
      allowed: false,
      missingScope: "operator.approvals",
    });
    expect(authorizeOperatorScopesForMethod(method, ["operator.approvals"])).toEqual({
      allowed: true,
    });
  });

  it.each([
    "question.request",
    "question.waitAnswer",
    "question.resolve",
    "question.get",
    "question.list",
  ])("requires questions scope for %s", (method) => {
    expect(authorizeOperatorScopesForMethod(method, ["operator.write"])).toEqual({
      allowed: false,
      missingScope: "operator.questions",
    });
    expect(authorizeOperatorScopesForMethod(method, ["operator.questions"])).toEqual({
      allowed: true,
    });
  });

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
    expect(isGatewayMethodClassified("node.pluginTools.update")).toBe(true);
    expect(isGatewayMethodClassified("node.skills.update")).toBe(true);
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
    for (const method of [
      "skills.proposals.list",
      "skills.proposals.events.list",
      "skills.proposals.inspect",
      "skills.proposals.historyStatus",
    ]) {
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
      "skills.proposals.evaluate",
      "skills.proposals.historyScan",
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
    expect(CLI_DEFAULT_OPERATOR_SCOPES).toContain("operator.questions");
  });
});
