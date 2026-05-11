import {
  createPluginRegistryFixture,
  registerTestPlugin,
} from "openclaw/plugin-sdk/plugin-test-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { APPROVALS_SCOPE, READ_SCOPE, WRITE_SCOPE } from "../../gateway/operator-scopes.js";
import { handleGatewayRequest } from "../../gateway/server-methods.js";
import { pluginHostHookHandlers } from "../../gateway/server-methods/plugin-host-hooks.js";
import type { GatewayClient, RespondFn } from "../../gateway/server-methods/types.js";
import { onAgentEvent, resetAgentEventsForTest } from "../../infra/agent-events.js";
import { createEmptyPluginRegistry } from "../registry-empty.js";
import { createPluginRegistry } from "../registry.js";
import { setActivePluginRegistry } from "../runtime.js";
import { createPluginRecord } from "../status.test-helpers.js";
import type { OpenClawPluginApi } from "../types.js";

const MAIN_SESSION_KEY = "agent:main:main";

type HookResponse = { ok: boolean; payload?: unknown; error?: unknown };

function sessionActionBody(
  pluginId: string,
  actionId: string,
  extra?: Record<string, unknown>,
): Record<string, unknown> {
  return {
    pluginId,
    actionId,
    ...extra,
  };
}

async function callPluginSessionActionForTest(params: {
  body: Record<string, unknown>;
  scopes?: string[];
}): Promise<HookResponse> {
  let response: HookResponse | undefined;
  const respond: RespondFn = (ok, payload, error) => {
    response = { ok, payload, error };
  };
  await pluginHostHookHandlers["plugins.sessionAction"]({
    req: { id: "test", type: "req", method: "plugins.sessionAction", params: params.body },
    params: params.body,
    client: {
      connId: "test-client",
      connect: { scopes: params.scopes ?? [WRITE_SCOPE] },
    } as GatewayClient,
    isWebchatConnect: () => false,
    respond,
    context: {} as never,
  });
  return response ?? { ok: false, error: new Error("handler did not respond") };
}

async function callRegisteredSessionActionForTest(params: {
  pluginId: string;
  actionId: string;
  extra?: Record<string, unknown>;
  scopes?: string[];
}): Promise<HookResponse> {
  return callPluginSessionActionForTest({
    body: sessionActionBody(params.pluginId, params.actionId, params.extra),
    ...(params.scopes ? { scopes: params.scopes } : {}),
  });
}

async function callPluginSessionActionThroughGatewayForTest(params: {
  body: Record<string, unknown>;
  scopes?: string[];
}): Promise<HookResponse> {
  let response: HookResponse | undefined;
  const respond: RespondFn = (ok, payload, error) => {
    response = { ok, payload, error };
  };
  await handleGatewayRequest({
    req: { id: "test", type: "req", method: "plugins.sessionAction", params: params.body },
    respond,
    client: {
      connId: "test-client",
      connect: {
        role: "operator",
        scopes: params.scopes ?? [],
      },
    } as GatewayClient,
    isWebchatConnect: () => false,
    context: {
      logGateway: {
        warn() {},
      },
    } as unknown as Parameters<typeof handleGatewayRequest>[0]["context"],
  });
  return response ?? { ok: false, error: new Error("handler did not respond") };
}

async function callRegisteredSessionActionThroughGatewayForTest(params: {
  pluginId: string;
  actionId: string;
  extra?: Record<string, unknown>;
  scopes?: string[];
}): Promise<HookResponse> {
  return callPluginSessionActionThroughGatewayForTest({
    body: sessionActionBody(params.pluginId, params.actionId, params.extra),
    ...(params.scopes ? { scopes: params.scopes } : {}),
  });
}

function requireHookError(response: HookResponse): { code?: unknown; message?: unknown } {
  expect(response.ok).toBe(false);
  const error = response.error as { code?: unknown; message?: unknown } | undefined;
  if (!error) {
    throw new Error("expected hook error");
  }
  return error;
}

function requireObservedEvent(
  observed: unknown[],
  index: number,
): { runId?: unknown; sessionKey?: unknown; stream?: unknown; data?: Record<string, unknown> } {
  const event = observed[index] as
    | { runId?: unknown; sessionKey?: unknown; stream?: unknown; data?: Record<string, unknown> }
    | undefined;
  if (!event) {
    throw new Error(`expected observed event #${index + 1}`);
  }
  return event;
}

function registerActionFixture(params: {
  id: string;
  name?: string;
  register: (api: OpenClawPluginApi) => void;
}) {
  const { config, registry } = createPluginRegistryFixture();
  registerTestPlugin({
    registry,
    config,
    record: createPluginRecord({
      id: params.id,
      name: params.name ?? params.id,
    }),
    register: params.register,
  });
  return { config, registry };
}

describe("plugin session actions", () => {
  afterEach(() => {
    setActivePluginRegistry(createEmptyPluginRegistry());
    resetAgentEventsForTest();
  });

  it("initializes and registers typed session actions", () => {
    expect(createEmptyPluginRegistry().sessionActions).toEqual([]);

    const { registry } = registerActionFixture({
      id: "session-action-fixture",
      name: "Session Action Fixture",
      register(api) {
        api.registerSessionAction({
          id: "approve",
          description: "Approve the current workflow",
          requiredScopes: [APPROVALS_SCOPE],
          handler: () => ({ ok: true, result: { accepted: true } }),
        });
      },
    });

    expect(registry.registry.sessionActions).toHaveLength(1);
    const actionEntry = registry.registry.sessionActions?.[0];
    expect(actionEntry?.pluginId).toBe("session-action-fixture");
    expect(actionEntry?.pluginName).toBe("Session Action Fixture");
    expect(actionEntry?.action.id).toBe("approve");
    expect(actionEntry?.action.description).toBe("Approve the current workflow");
    expect(actionEntry?.action.requiredScopes).toEqual([APPROVALS_SCOPE]);
  });

  it("rejects invalid or duplicate session action registrations", () => {
    const { registry } = registerActionFixture({
      id: "invalid-session-actions",
      name: "Invalid Session Actions",
      register(api) {
        for (const action of [
          { id: "dup" },
          { id: "dup" },
          { id: "bad-scope", requiredScopes: ["not-a-scope"] as never },
          { id: "bad-schema-shape", schema: "not-an-object" as never },
          { id: "bad-schema-compile", schema: { type: "not-a-json-schema-type" } as never },
          { id: "" },
        ]) {
          api.registerSessionAction({
            ...action,
            handler: () => ({ ok: true }),
          });
        }
      },
    });

    expect(registry.registry.sessionActions?.map((entry) => entry.action.id)).toEqual(["dup"]);
    const diagnosticMessages = registry.registry.diagnostics?.map((diagnostic) => {
      expect(diagnostic.pluginId).toBe("invalid-session-actions");
      return diagnostic.message;
    });
    expect(diagnosticMessages).toHaveLength(5);
    expect(diagnosticMessages).toContain("session action already registered: dup");
    expect(diagnosticMessages).toContain(
      "session action requiredScopes contains unknown operator scope: not-a-scope",
    );
    expect(diagnosticMessages).toContain(
      "session action schema must be a JSON schema object or boolean: bad-schema-shape",
    );
    expect(
      diagnosticMessages?.some((message) =>
        message.includes("session action schema is not valid JSON Schema: bad-schema-compile"),
      ),
    ).toBe(true);
    expect(diagnosticMessages).toContain(
      "session action registration requires id, handler, and valid optional fields",
    );
  });

  it("validates payload schemas and typed action results", async () => {
    const callSchemaAction = (
      actionId: string,
      extra?: Record<string, unknown>,
    ): Promise<{ ok: boolean; payload?: unknown; error?: unknown }> =>
      callRegisteredSessionActionForTest({
        pluginId: "schema-action-fixture",
        actionId,
        ...(extra ? { extra } : {}),
      });
    const handlerCalls: unknown[] = [];
    const { registry } = registerActionFixture({
      id: "schema-action-fixture",
      name: "Schema Action Fixture",
      register(api) {
        api.registerSessionAction({
          id: "approve",
          schema: {
            type: "object",
            additionalProperties: false,
            required: ["version"],
            properties: {
              version: { type: "string" },
            },
          },
          handler: ({ payload, sessionKey, client }) => {
            handlerCalls.push({ payload, sessionKey, scopes: client?.scopes ?? [] });
            return {
              result: { accepted: true, ...(sessionKey ? { sessionKey } : {}) },
              continueAgent: true,
              reply: { text: "approved" },
            };
          },
        });
        api.registerSessionAction({
          id: "typed-error",
          handler: () => ({
            ok: false,
            error: "needs operator input",
            code: "needs_input",
            details: { field: "version" },
          }),
        });
        api.registerSessionAction({
          id: "allow-any",
          schema: true,
          handler: ({ payload }) => ({ result: { payload: payload ?? null } }),
        });
        api.registerSessionAction({
          id: "deny-all",
          schema: false,
          handler: () => ({ result: { unreachable: true } }),
        });
      },
    });
    setActivePluginRegistry(registry.registry);

    const rejected = await callPluginSessionActionForTest({
      body: sessionActionBody("schema-action-fixture", "approve", { payload: { version: 1 } }),
    });
    const rejectedError = requireHookError(rejected);
    expect(rejectedError.code).toBe("INVALID_REQUEST");
    expect(String(rejectedError.message)).toContain(
      "plugin session action payload does not match schema",
    );
    expect(handlerCalls).toEqual([]);

    await expect(
      callSchemaAction("approve", {
        sessionKey: MAIN_SESSION_KEY,
        payload: { version: "2026.05.01" },
      }),
    ).resolves.toEqual({
      ok: true,
      payload: {
        ok: true,
        result: { accepted: true, sessionKey: MAIN_SESSION_KEY },
        continueAgent: true,
        reply: { text: "approved" },
      },
      error: undefined,
    });
    expect(handlerCalls).toEqual([
      {
        payload: { version: "2026.05.01" },
        sessionKey: MAIN_SESSION_KEY,
        scopes: [WRITE_SCOPE],
      },
    ]);

    await expect(callSchemaAction("typed-error")).resolves.toEqual({
      ok: true,
      payload: {
        ok: false,
        error: "needs operator input",
        code: "needs_input",
        details: {
          field: "version",
        },
      },
      error: undefined,
    });

    await expect(
      callSchemaAction("allow-any", { payload: { any: ["json", true] } }),
    ).resolves.toEqual({
      ok: true,
      payload: {
        ok: true,
        result: { payload: { any: ["json", true] } },
      },
      error: undefined,
    });

    const denyAll = await callSchemaAction("deny-all", { payload: { rejected: true } });
    expect(requireHookError(denyAll).code).toBe("INVALID_REQUEST");
  });

  it("validates plugin session action results before returning gateway payloads", async () => {
    const callValidationAction = (
      actionId: string,
    ): Promise<{ ok: boolean; payload?: unknown; error?: unknown }> =>
      callRegisteredSessionActionForTest({
        pluginId: "session-action-validation-fixture",
        actionId,
      });
    const { registry } = registerActionFixture({
      id: "session-action-validation-fixture",
      name: "Session Action Validation Fixture",
      register(api) {
        const handlers = {
          "bad-result": () => ({ result: 1n as never }),
          "bad-reply": () => ({ reply: { text: "ok", extra: () => undefined } as never }),
          "primitive-result": () => "not-an-object" as never,
          "typed-error": () => ({
            ok: false,
            error: "needs operator input",
            code: "needs_input",
            details: { field: "version" },
          }),
          "bad-ok": () =>
            ({
              ok: "false",
              error: "must not masquerade as success",
            }) as never,
          "error-shaped-success": () =>
            ({
              error: "must declare ok false",
            }) as never,
          "bad-error-details": () => ({
            ok: false,
            error: "bad details",
            details: { value: 1n } as never,
          }),
          "bad-continue-agent": () => ({ continueAgent: "yes" as never }),
          "mixed-branch-fields": () =>
            ({
              ok: false,
              error: "stop",
              continueAgent: true,
              result: { leaked: true },
            }) as never,
          "unknown-success-field": () =>
            ({
              result: { accepted: true },
              extra: "unexpected",
            }) as never,
          "throws-secret": () => {
            throw new Error("fixture action failed");
          },
        };
        for (const [id, handler] of Object.entries(handlers)) {
          api.registerSessionAction({ id, handler: handler as never });
        }
      },
    });
    setActivePluginRegistry(registry.registry);

    const expectValidationError = async (
      actionId: string,
      message: { exact: string } | { includes: string },
    ) => {
      const response = await callValidationAction(actionId);
      const error = requireHookError(response);
      expect(error.code).toBe("INVALID_REQUEST");
      if ("exact" in message) {
        expect(error.message).toBe(message.exact);
      } else {
        expect(String(error.message)).toContain(message.includes);
      }
    };

    await expectValidationError("bad-result", {
      exact: "plugin session action result must be JSON-compatible",
    });
    await expectValidationError("bad-reply", {
      exact: "plugin session action reply must be JSON-compatible",
    });
    const primitiveResult = await callValidationAction("primitive-result");
    const primitiveResultError = requireHookError(primitiveResult);
    expect(primitiveResultError.code).toBe("INVALID_REQUEST");
    expect(primitiveResultError.message).toBe("plugin session action result must be an object");
    await expect(callValidationAction("typed-error")).resolves.toEqual({
      ok: true,
      payload: {
        ok: false,
        error: "needs operator input",
        code: "needs_input",
        details: {
          field: "version",
        },
      },
      error: undefined,
    });
    await expectValidationError("bad-ok", { includes: "/ok: must be boolean" });
    await expectValidationError("error-shaped-success", {
      includes: "unexpected property 'error'",
    });
    await expectValidationError("bad-error-details", {
      exact: "plugin session action details must be JSON-compatible",
    });
    await expectValidationError("bad-continue-agent", {
      includes: "/continueAgent: must be boolean",
    });
    await expectValidationError("mixed-branch-fields", {
      includes: "unexpected property 'continueAgent'",
    });
    await expectValidationError("unknown-success-field", {
      includes: "unexpected property 'extra'",
    });
    const throwsSecret = await callValidationAction("throws-secret");
    const throwsSecretError = requireHookError(throwsSecret);
    expect(throwsSecretError.code).toBe("UNAVAILABLE");
    expect(throwsSecretError.message).toBe("plugin session action failed");
  });

  it("authorizes session actions through the gateway by action-declared scopes", async () => {
    const callApprovalAction = (params: {
      actionId: string;
      extra?: Record<string, unknown>;
      scopes?: string[];
    }): Promise<{ ok: boolean; payload?: unknown; error?: unknown }> =>
      callRegisteredSessionActionThroughGatewayForTest({
        pluginId: "approval-action-fixture",
        actionId: params.actionId,
        ...(params.extra ? { extra: params.extra } : {}),
        ...(params.scopes ? { scopes: params.scopes } : {}),
      });
    const handlerCalls: unknown[] = [];
    const { registry } = registerActionFixture({
      id: "approval-action-fixture",
      name: "Approval Action Fixture",
      register(api) {
        api.registerSessionAction({
          id: "approve",
          requiredScopes: [APPROVALS_SCOPE],
          handler: ({ client, sessionKey }) => {
            handlerCalls.push({ scopes: client?.scopes ?? [], sessionKey });
            return {
              result: { approved: true, ...(sessionKey ? { sessionKey } : {}) },
              continueAgent: true,
            };
          },
        });
        api.registerSessionAction({
          id: "view",
          requiredScopes: [READ_SCOPE],
          handler: ({ client }) => {
            handlerCalls.push({ scopes: client?.scopes ?? [], action: "view" });
            return { result: { visible: true }, continueAgent: false };
          },
        });
      },
    });
    setActivePluginRegistry(registry.registry);

    await expect(
      callApprovalAction({
        actionId: "approve",
        scopes: [APPROVALS_SCOPE],
      }),
    ).resolves.toEqual({
      ok: true,
      payload: { ok: true, result: { approved: true }, continueAgent: true },
      error: undefined,
    });

    await expect(
      callApprovalAction({
        actionId: "view",
        scopes: [WRITE_SCOPE],
      }),
    ).resolves.toEqual({
      ok: true,
      payload: { ok: true, result: { visible: true }, continueAgent: false },
      error: undefined,
    });

    const missingApprovalScope = await callApprovalAction({
      actionId: "approve",
      scopes: [READ_SCOPE],
    });
    const missingApprovalScopeError = requireHookError(missingApprovalScope);
    expect(missingApprovalScopeError.code).toBe("INVALID_REQUEST");
    expect(missingApprovalScopeError.message).toBe(`missing scope: ${APPROVALS_SCOPE}`);
    expect(handlerCalls).toEqual([
      { scopes: [APPROVALS_SCOPE], sessionKey: undefined },
      { scopes: [WRITE_SCOPE], action: "view" },
    ]);

    await expect(
      callApprovalAction({
        actionId: "approve",
        extra: { sessionKey: ` ${MAIN_SESSION_KEY} ` },
        scopes: [APPROVALS_SCOPE],
      }),
    ).resolves.toEqual({
      ok: true,
      payload: {
        ok: true,
        result: { approved: true, sessionKey: MAIN_SESSION_KEY },
        continueAgent: true,
      },
      error: undefined,
    });

    await expect(
      callApprovalAction({
        actionId: "view",
        scopes: [READ_SCOPE],
      }),
    ).resolves.toEqual({
      ok: true,
      payload: { ok: true, result: { visible: true }, continueAgent: false },
      error: undefined,
    });

    const blankPluginId = await callPluginSessionActionThroughGatewayForTest({
      body: {
        pluginId: "   ",
        actionId: "approve",
      },
      scopes: [APPROVALS_SCOPE],
    });
    const blankPluginIdError = requireHookError(blankPluginId);
    expect(blankPluginIdError.code).toBe("INVALID_REQUEST");
    expect(blankPluginIdError.message).toBe(
      "plugins.sessionAction pluginId and actionId must be non-empty",
    );
    expect(handlerCalls).toEqual([
      { scopes: [APPROVALS_SCOPE], sessionKey: undefined },
      { scopes: [WRITE_SCOPE], action: "view" },
      { scopes: [APPROVALS_SCOPE], sessionKey: MAIN_SESSION_KEY },
      { scopes: [READ_SCOPE], action: "view" },
    ]);
  });

  it("passes a defensive copy of client scopes to session action handlers", async () => {
    const registry = createEmptyPluginRegistry();
    let response: { ok: boolean; payload?: unknown; error?: unknown } | undefined;
    let handlerScopes: string[] | undefined;
    const originalScopes = [READ_SCOPE];
    registry.sessionActions = [
      {
        pluginId: "scope-copy-fixture",
        pluginName: "Scope Copy Fixture",
        source: "test",
        action: {
          id: "mutate",
          requiredScopes: [READ_SCOPE],
          handler: ({ client }) => {
            handlerScopes = client?.scopes;
            client?.scopes.push(APPROVALS_SCOPE);
            return { result: { ok: true } };
          },
        },
      },
    ];
    registry.plugins = [createPluginRecord({ id: "scope-copy-fixture" })];
    setActivePluginRegistry(registry);

    await pluginHostHookHandlers["plugins.sessionAction"]({
      req: {
        id: "scope-copy",
        type: "req",
        method: "plugins.sessionAction",
        params: { pluginId: "scope-copy-fixture", actionId: "mutate" },
      },
      params: { pluginId: "scope-copy-fixture", actionId: "mutate" },
      client: {
        connId: "scope-copy-client",
        connect: { scopes: originalScopes },
      } as GatewayClient,
      isWebchatConnect: () => false,
      respond: (ok, payload, error) => {
        response = { ok, payload, error };
      },
      context: {} as never,
    });

    expect(response).toEqual({
      ok: true,
      payload: { ok: true, result: { ok: true } },
      error: undefined,
    });
    expect(handlerScopes).toEqual([READ_SCOPE, APPROVALS_SCOPE]);
    expect(handlerScopes).not.toBe(originalScopes);
    expect(originalScopes).toEqual([READ_SCOPE]);
  });

  it("does not dispatch session actions for plugins that are not loaded", async () => {
    const handler = vi.fn(() => ({ result: { stale: true } }));
    const registry = createEmptyPluginRegistry();
    registry.sessionActions = [
      {
        pluginId: "failed-action-plugin",
        pluginName: "Failed Action Plugin",
        source: "test",
        action: {
          id: "stale",
          requiredScopes: [READ_SCOPE],
          handler,
        },
      },
    ];
    registry.plugins = [
      createPluginRecord({
        id: "failed-action-plugin",
        name: "Failed Action Plugin",
        status: "error",
      }),
    ];
    setActivePluginRegistry(registry);

    const staleAction = await callPluginSessionActionThroughGatewayForTest({
      body: {
        pluginId: "failed-action-plugin",
        actionId: "stale",
      },
      scopes: [READ_SCOPE],
    });
    const staleActionError = requireHookError(staleAction);
    expect(staleActionError.code).toBe("UNAVAILABLE");
    expect(staleActionError.message).toBe(
      "unknown plugin session action: failed-action-plugin/stale",
    );
    expect(handler).not.toHaveBeenCalled();
  });

  it("emits plugin-attributed agent events through the plugin API", () => {
    const observed: unknown[] = [];
    const unsubscribe = onAgentEvent((event) => observed.push(event));
    const { config, registry } = createPluginRegistryFixture();
    let bundledApi: OpenClawPluginApi | undefined;
    let workspaceApi: OpenClawPluginApi | undefined;
    registerTestPlugin({
      registry,
      config,
      record: createPluginRecord({
        id: "event-plugin",
        name: "Event Plugin",
        origin: "bundled",
      }),
      register(api) {
        bundledApi = api;
      },
    });
    registerTestPlugin({
      registry,
      config,
      record: createPluginRecord({
        id: "workspace-event-plugin",
        name: "Workspace Event Plugin",
        origin: "workspace",
      }),
      register(api) {
        workspaceApi = api;
      },
    });
    setActivePluginRegistry(registry.registry);

    try {
      expect(
        bundledApi?.agent?.events.emitAgentEvent({
          runId: "run-emit",
          sessionKey: " agent:main:main ",
          stream: "approval",
          data: { state: "queued" },
        }),
      ).toEqual({ emitted: true, stream: "approval" });
      expect(
        workspaceApi?.emitAgentEvent({
          runId: "run-emit",
          stream: "lifecycle",
          data: { phase: "end" },
        }),
      ).toEqual({ emitted: false, reason: "stream lifecycle is reserved for bundled plugins" });
      expect(
        workspaceApi?.emitAgentEvent({
          runId: "run-emit",
          stream: "assistant",
          data: { text: "spoofed assistant output" },
        }),
      ).toEqual({ emitted: false, reason: "stream assistant is reserved for bundled plugins" });
      expect(
        workspaceApi?.emitAgentEvent({
          runId: "run-emit",
          stream: "other-plugin.workflow",
          data: { state: "queued" },
        }),
      ).toEqual({
        emitted: false,
        reason: "stream other-plugin.workflow must be scoped to plugin workspace-event-plugin",
      });
      expect(
        workspaceApi?.emitAgentEvent({
          runId: "run-emit",
          stream: "workspace-event-plugin.workflow",
          data: { state: "queued" },
        }),
      ).toEqual({ emitted: true, stream: "workspace-event-plugin.workflow" });
      expect(
        bundledApi?.emitAgentEvent({
          runId: "run-emit",
          stream: "approval",
          data: 1n as never,
        }),
      ).toEqual({ emitted: false, reason: "event data must be JSON-compatible" });
    } finally {
      unsubscribe();
    }

    expect(observed).toHaveLength(2);
    const bundledEvent = requireObservedEvent(observed, 0);
    expect(bundledEvent.runId).toBe("run-emit");
    expect(bundledEvent.sessionKey).toBe("agent:main:main");
    expect(bundledEvent.stream).toBe("approval");
    expect(bundledEvent.data).toEqual({
      state: "queued",
      pluginId: "event-plugin",
      pluginName: "Event Plugin",
    });
    const workspaceEvent = requireObservedEvent(observed, 1);
    expect(workspaceEvent.runId).toBe("run-emit");
    expect(workspaceEvent.sessionKey).toBeUndefined();
    expect(workspaceEvent.stream).toBe("workspace-event-plugin.workflow");
    expect(workspaceEvent.data).toEqual({
      state: "queued",
      pluginId: "workspace-event-plugin",
      pluginName: "Workspace Event Plugin",
    });
  });

  it("blocks agent events from stale and non-activating plugin API closures", () => {
    const observed: unknown[] = [];
    const unsubscribe = onAgentEvent((event) => observed.push(event));
    const { config, registry } = createPluginRegistryFixture();
    let capturedApi: OpenClawPluginApi | undefined;
    registerTestPlugin({
      registry,
      config,
      record: createPluginRecord({
        id: "stale-event-plugin",
        name: "Stale Event Plugin",
        origin: "bundled",
      }),
      register(api) {
        capturedApi = api;
      },
    });
    setActivePluginRegistry(registry.registry);
    setActivePluginRegistry(createEmptyPluginRegistry());

    try {
      expect(
        capturedApi?.emitAgentEvent({
          runId: "stale-run",
          stream: "approval",
          data: { stale: true },
        }),
      ).toEqual({ emitted: false, reason: "plugin is not loaded" });

      const neverActiveRegistry = createPluginRegistry({
        logger: {
          info() {},
          warn() {},
          error() {},
          debug() {},
        },
        runtime: {} as never,
      });
      let neverActiveApi: OpenClawPluginApi | undefined;
      registerTestPlugin({
        registry: neverActiveRegistry,
        config,
        record: createPluginRecord({
          id: "never-active-event-plugin",
          name: "Never Active Event Plugin",
          origin: "bundled",
        }),
        register(api) {
          neverActiveApi = api;
        },
      });
      expect(
        neverActiveApi?.emitAgentEvent({
          runId: "never-active-run",
          stream: "approval",
          data: { inactive: true },
        }),
      ).toEqual({ emitted: false, reason: "plugin is not loaded" });

      const inactiveRegistry = createPluginRegistry({
        logger: {
          info() {},
          warn() {},
          error() {},
          debug() {},
        },
        runtime: {} as never,
        activateGlobalSideEffects: false,
      });
      let inactiveApi: OpenClawPluginApi | undefined;
      registerTestPlugin({
        registry: inactiveRegistry,
        config,
        record: createPluginRecord({
          id: "inactive-event-plugin",
          name: "Inactive Event Plugin",
          origin: "bundled",
        }),
        register(api) {
          inactiveApi = api;
        },
      });
      expect(
        inactiveApi?.emitAgentEvent({
          runId: "inactive-run",
          stream: "approval",
          data: { inactive: true },
        }),
      ).toEqual({ emitted: false, reason: "global side effects disabled" });
    } finally {
      unsubscribe();
    }

    expect(observed).toEqual([]);
  });

  it("allows reactivated cached registries to emit agent events again", () => {
    const observed: unknown[] = [];
    const unsubscribe = onAgentEvent((event) => observed.push(event));
    const { config, registry } = createPluginRegistryFixture();
    let capturedApi: OpenClawPluginApi | undefined;
    registerTestPlugin({
      registry,
      config,
      record: createPluginRecord({
        id: "reactivated-event-plugin",
        name: "Reactivated Event Plugin",
        origin: "bundled",
      }),
      register(api) {
        capturedApi = api;
      },
    });

    setActivePluginRegistry(registry.registry);
    setActivePluginRegistry(createEmptyPluginRegistry());
    setActivePluginRegistry(registry.registry);

    try {
      expect(
        capturedApi?.emitAgentEvent({
          runId: "reactivated-run",
          stream: "approval",
          data: { active: true },
        }),
      ).toEqual({ emitted: true, stream: "approval" });
    } finally {
      unsubscribe();
    }

    expect(observed).toHaveLength(1);
    const reactivatedEvent = requireObservedEvent(observed, 0);
    expect(reactivatedEvent.runId).toBe("reactivated-run");
    expect(reactivatedEvent.sessionKey).toBeUndefined();
    expect(reactivatedEvent.stream).toBe("approval");
    expect(reactivatedEvent.data).toEqual({
      active: true,
      pluginId: "reactivated-event-plugin",
      pluginName: "Reactivated Event Plugin",
    });
  });
});
