import fs from "node:fs/promises";
import path from "node:path";
import {
  createPluginRegistryFixture,
  registerTestPlugin,
} from "openclaw/plugin-sdk/plugin-test-contracts";
import { afterEach, describe, expect, it } from "vitest";
import { loadSessionStore, updateSessionStore, type SessionEntry } from "../../config/sessions.js";
import { APPROVALS_SCOPE, READ_SCOPE, WRITE_SCOPE } from "../../gateway/operator-scopes.js";
import {
  validatePluginsUiDescriptorsParams,
  validateSessionsPluginPatchParams,
} from "../../gateway/protocol/index.js";
import { buildGatewaySessionRow } from "../../gateway/session-utils.js";
import { withTempConfig } from "../../gateway/test-temp-config.js";
import { emitAgentEvent, resetAgentEventsForTest } from "../../infra/agent-events.js";
import { resolvePreferredOpenClawTmpDir } from "../../infra/tmp-openclaw-dir.js";
import { executePluginCommand, validatePluginCommandDefinition } from "../commands.js";
import { createHookRunner } from "../hooks.js";
import {
  cleanupReplacedPluginHostRegistry,
  clearPluginOwnedSessionState,
  runPluginHostCleanup,
} from "../host-hook-cleanup.js";
import {
  clearPluginHostRuntimeState,
  getPluginRunContext,
  listPluginSessionSchedulerJobs,
  setPluginRunContext,
} from "../host-hook-runtime.js";
import {
  drainPluginNextTurnInjections,
  enqueuePluginNextTurnInjection,
  patchPluginSessionExtension,
  projectPluginSessionExtensions,
  projectPluginSessionExtensionsSync,
} from "../host-hook-state.js";
import { buildPluginAgentTurnPrepareContext, isPluginJsonValue } from "../host-hooks.js";
import { createEmptyPluginRegistry } from "../registry-empty.js";
import { createPluginRegistry } from "../registry.js";
import { setActivePluginRegistry } from "../runtime.js";
import type { PluginRuntime } from "../runtime/types.js";
import { createPluginRecord } from "../status.test-helpers.js";
import { runTrustedToolPolicies } from "../trusted-tool-policy.js";
import { registerHostHookFixture, registerTrustedHostHookFixture } from "./host-hook-fixture.js";

async function waitForPluginEventHandlers(): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
}

describe("host-hook fixture plugin contract", () => {
  afterEach(() => {
    setActivePluginRegistry(createEmptyPluginRegistry());
    clearPluginHostRuntimeState();
    resetAgentEventsForTest();
  });

  it("registers generic SDK seams without Plan Mode business logic", () => {
    const { config, registry } = createPluginRegistryFixture();
    registerTestPlugin({
      registry,
      config,
      record: createPluginRecord({
        id: "host-hook-fixture",
        name: "Host Hook Fixture",
        origin: "workspace",
      }),
      register: registerHostHookFixture,
    });

    expect(registry.registry.sessionExtensions ?? []).toHaveLength(1);
    expect(registry.registry.toolMetadata ?? []).toHaveLength(1);
    expect(registry.registry.controlUiDescriptors ?? []).toHaveLength(1);
    expect(registry.registry.runtimeLifecycles ?? []).toHaveLength(1);
    expect(registry.registry.agentEventSubscriptions ?? []).toHaveLength(1);
    expect(registry.registry.sessionSchedulerJobs ?? []).toHaveLength(1);
    expect(registry.registry.commands.map((entry) => entry.command.name)).toEqual([
      "host-hook-fixture",
    ]);
    expect(registry.registry.typedHooks.map((entry) => entry.hookName).toSorted()).toEqual([
      "agent_turn_prepare",
      "heartbeat_prompt_contribution",
    ]);
  });

  it("rejects external plugins from trusted policy and reserved command ownership", () => {
    const { config, registry } = createPluginRegistryFixture();
    registerTestPlugin({
      registry,
      config,
      record: createPluginRecord({
        id: "external-policy",
        name: "External Policy",
        origin: "workspace",
      }),
      register(api) {
        api.registerTrustedToolPolicy({
          id: "deny",
          description: "Should not be accepted",
          evaluate: () => undefined,
        });
        api.registerCommand({
          name: "status",
          description: "Should not be accepted",
          ownership: "reserved",
          handler: async () => ({ text: "no" }),
        });
      },
    });

    expect(registry.registry.trustedToolPolicies ?? []).toHaveLength(0);
    expect(registry.registry.commands).toHaveLength(0);
    expect(registry.registry.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          pluginId: "external-policy",
          message: expect.stringContaining("only bundled plugins can register trusted tool"),
        }),
        expect.objectContaining({
          pluginId: "external-policy",
          message: expect.stringContaining("only bundled plugins can claim reserved command"),
        }),
      ]),
    );
  });

  it("rejects reserved command ownership for non-reserved bundled command names", () => {
    const { config, registry } = createPluginRegistryFixture();
    registerTestPlugin({
      registry,
      config,
      record: createPluginRecord({
        id: "bundled-command",
        name: "Bundled Command",
        origin: "bundled",
      }),
      register(api) {
        api.registerCommand({
          name: "workflow",
          description: "Should not need reserved ownership",
          ownership: "reserved",
          handler: async () => ({ text: "no" }),
        });
      },
    });

    expect(registry.registry.commands).toHaveLength(0);
    expect(registry.registry.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          pluginId: "bundled-command",
          message: "reserved command ownership requires a reserved command name: workflow",
        }),
      ]),
    );
  });

  it("lets bundled fixture policies run before normal before_tool_call hooks", async () => {
    const { config, registry } = createPluginRegistryFixture();
    registerTestPlugin({
      registry,
      config,
      record: createPluginRecord({
        id: "trusted-fixture",
        name: "Trusted Fixture",
        origin: "bundled",
      }),
      register: registerTrustedHostHookFixture,
    });
    setActivePluginRegistry(registry.registry);

    await expect(
      runTrustedToolPolicies(
        { toolName: "blocked_fixture_tool", params: {} },
        { toolName: "blocked_fixture_tool" },
      ),
    ).resolves.toMatchObject({
      block: true,
      blockReason: "blocked by fixture policy",
    });
  });

  it("lets later trusted policy blocks override earlier approval requests", async () => {
    const registry = createEmptyPluginRegistry();
    registry.trustedToolPolicies = [
      {
        pluginId: "trusted-a",
        pluginName: "Trusted A",
        source: "test",
        policy: {
          id: "approval",
          description: "approval",
          evaluate: () => ({
            requireApproval: {
              title: "Review",
              description: "Review the call",
            },
          }),
        },
      },
      {
        pluginId: "trusted-b",
        pluginName: "Trusted B",
        source: "test",
        policy: {
          id: "block",
          description: "block",
          evaluate: () => ({ block: true, blockReason: "blocked by later policy" }),
        },
      },
    ];
    setActivePluginRegistry(registry);

    await expect(
      runTrustedToolPolicies({ toolName: "exec", params: {} }, { toolName: "exec" }),
    ).resolves.toEqual({
      block: true,
      blockReason: "blocked by later policy",
    });
  });

  it("passes adjusted trusted policy params to later trusted policies", async () => {
    const seenParams: Record<string, unknown>[] = [];
    const registry = createEmptyPluginRegistry();
    registry.trustedToolPolicies = [
      {
        pluginId: "trusted-a",
        pluginName: "Trusted A",
        source: "test",
        policy: {
          id: "params",
          description: "params",
          evaluate: () => ({ params: { command: "patched" } }),
        },
      },
      {
        pluginId: "trusted-b",
        pluginName: "Trusted B",
        source: "test",
        policy: {
          id: "inspect",
          description: "inspect",
          evaluate: (event) => {
            seenParams.push(event.params);
            return undefined;
          },
        },
      },
    ];
    setActivePluginRegistry(registry);

    await expect(
      runTrustedToolPolicies(
        { toolName: "exec", params: { command: "original" } },
        { toolName: "exec" },
      ),
    ).resolves.toEqual({ params: { command: "patched" } });
    expect(seenParams).toEqual([{ command: "patched" }]);
  });

  it("validates plugin-owned JSON values as plain JSON-compatible data", () => {
    expect(
      isPluginJsonValue({
        state: "waiting",
        attempts: 1,
        nested: [{ ok: true }, null],
      }),
    ).toBe(true);
    expect(isPluginJsonValue({ value: Number.NaN })).toBe(false);
    expect(isPluginJsonValue({ value: undefined })).toBe(false);
    expect(isPluginJsonValue(new Date(0))).toBe(false);
    expect(isPluginJsonValue(new Map([["state", "waiting"]]))).toBe(false);
    expect(isPluginJsonValue({ value: "x".repeat(70 * 1024) })).toBe(false);
  });

  it("rejects non-JSON descriptor schemas before projecting Control UI descriptors", () => {
    const { config, registry } = createPluginRegistryFixture();
    registerTestPlugin({
      registry,
      config,
      record: createPluginRecord({
        id: "descriptor-fixture",
        name: "Descriptor Fixture",
      }),
      register(api) {
        api.registerControlUiDescriptor({
          id: "bad-schema",
          surface: "session",
          label: "Bad schema",
          schema: new Date(0) as never,
        });
      },
    });

    expect(registry.registry.controlUiDescriptors ?? []).toHaveLength(0);
    expect(registry.registry.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          pluginId: "descriptor-fixture",
          message: "control UI descriptor schema must be JSON-compatible: bad-schema",
        }),
      ]),
    );
  });

  it("projects registered session extensions into gateway session rows", () => {
    const { config, registry } = createPluginRegistryFixture();
    registerTestPlugin({
      registry,
      config,
      record: createPluginRecord({
        id: "host-hook-fixture",
        name: "Host Hook Fixture",
      }),
      register: registerHostHookFixture,
    });
    setActivePluginRegistry(registry.registry);

    const row = buildGatewaySessionRow({
      cfg: config,
      storePath: "/tmp/sessions.json",
      store: {},
      key: "agent:main:main",
      entry: {
        sessionId: "session-1",
        updatedAt: 1,
        pluginExtensions: {
          "host-hook-fixture": {
            workflow: { state: "waiting" },
          },
        },
      },
    });

    expect(row.pluginExtensions).toEqual([
      {
        pluginId: "host-hook-fixture",
        namespace: "workflow",
        value: { state: "waiting" },
      },
    ]);
  });

  it("projects sync session extension projectors into gateway rows without exposing raw state", () => {
    const { config, registry } = createPluginRegistryFixture();
    registerTestPlugin({
      registry,
      config,
      record: createPluginRecord({
        id: "projector-fixture",
        name: "Projector Fixture",
      }),
      register(api) {
        api.registerSessionExtension({
          namespace: "workflow",
          description: "Projected workflow state",
          project: ({ state }) => {
            if (!state || typeof state !== "object" || Array.isArray(state)) {
              return undefined;
            }
            const workflowState = (state as { state?: unknown }).state;
            return typeof workflowState === "string" ? { state: workflowState } : undefined;
          },
        });
      },
    });
    setActivePluginRegistry(registry.registry);

    const entry: SessionEntry = {
      sessionId: "session-1",
      updatedAt: 1,
      pluginExtensions: {
        "projector-fixture": {
          workflow: { state: "waiting", privateToken: "secret" },
        },
      },
    };
    expect(projectPluginSessionExtensionsSync({ sessionKey: "agent:main:main", entry })).toEqual([
      {
        pluginId: "projector-fixture",
        namespace: "workflow",
        value: { state: "waiting" },
      },
    ]);

    const row = buildGatewaySessionRow({
      cfg: config,
      storePath: "/tmp/sessions.json",
      store: {},
      key: "agent:main:main",
      entry,
    });
    expect(row.pluginExtensions).toEqual([
      {
        pluginId: "projector-fixture",
        namespace: "workflow",
        value: { state: "waiting" },
      },
    ]);
  });

  it("rejects async session extension projectors because gateway rows are synchronous", () => {
    const { config, registry } = createPluginRegistryFixture();
    registerTestPlugin({
      registry,
      config,
      record: createPluginRecord({
        id: "async-projector-fixture",
        name: "Async Projector Fixture",
      }),
      register(api) {
        api.registerSessionExtension({
          namespace: "workflow",
          description: "Async workflow state",
          project: (async () => ({ state: "late" })) as unknown as () => undefined,
        });
      },
    });

    expect(registry.registry.sessionExtensions ?? []).toHaveLength(0);
    expect(registry.registry.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          pluginId: "async-projector-fixture",
          message: "session extension projector must be synchronous",
        }),
      ]),
    );
  });

  it("reports specific diagnostics for malformed session extension callbacks", () => {
    const { config, registry } = createPluginRegistryFixture();
    registerTestPlugin({
      registry,
      config,
      record: createPluginRecord({
        id: "bad-session-extension-fixture",
        name: "Bad Session Extension Fixture",
      }),
      register(api) {
        api.registerSessionExtension({
          namespace: "projector",
          description: "Bad projector",
          project: "not-a-function" as never,
        });
        api.registerSessionExtension({
          namespace: "cleanup",
          description: "Bad cleanup",
          cleanup: "not-a-function" as never,
        });
      },
    });

    expect(registry.registry.sessionExtensions ?? []).toHaveLength(0);
    expect(registry.registry.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          pluginId: "bad-session-extension-fixture",
          message: "session extension projector must be a function",
        }),
        expect.objectContaining({
          pluginId: "bad-session-extension-fixture",
          message: "session extension cleanup must be a function",
        }),
      ]),
    );
  });

  it("rejects duplicate runtime lifecycle and agent event subscription ids", () => {
    const { config, registry } = createPluginRegistryFixture();
    registerTestPlugin({
      registry,
      config,
      record: createPluginRecord({
        id: "duplicate-host-hook-fixture",
        name: "Duplicate Host Hook Fixture",
      }),
      register(api) {
        api.registerRuntimeLifecycle({ id: "cleanup", cleanup: () => undefined });
        api.registerRuntimeLifecycle({ id: "cleanup", cleanup: () => undefined });
        api.registerRuntimeLifecycle({
          id: "bad-cleanup",
          cleanup: "not-a-function" as never,
        });
        api.registerAgentEventSubscription({
          id: "events",
          streams: ["tool"],
          handle: () => undefined,
        });
        api.registerAgentEventSubscription({
          id: "events",
          streams: ["error"],
          handle: () => undefined,
        });
        api.registerAgentEventSubscription({
          id: "missing-handler",
          streams: ["tool"],
          handle: "not-a-function" as never,
        });
        api.registerAgentEventSubscription({
          id: "bad-streams",
          streams: { length: 1, 0: "tool" } as never,
          handle: () => undefined,
        });
        api.registerSessionSchedulerJob({
          id: "bad-scheduler-cleanup",
          sessionKey: "agent:main:main",
          kind: "monitor",
          cleanup: "not-a-function" as never,
        });
      },
    });

    expect(registry.registry.runtimeLifecycles ?? []).toHaveLength(1);
    expect(registry.registry.agentEventSubscriptions ?? []).toHaveLength(1);
    expect(registry.registry.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          pluginId: "duplicate-host-hook-fixture",
          message: "runtime lifecycle already registered: cleanup",
        }),
        expect.objectContaining({
          pluginId: "duplicate-host-hook-fixture",
          message: "runtime lifecycle cleanup must be a function: bad-cleanup",
        }),
        expect.objectContaining({
          pluginId: "duplicate-host-hook-fixture",
          message: "agent event subscription already registered: events",
        }),
        expect.objectContaining({
          pluginId: "duplicate-host-hook-fixture",
          message: "agent event subscription registration requires id and handle",
        }),
        expect.objectContaining({
          pluginId: "duplicate-host-hook-fixture",
          message: "agent event subscription streams must be an array of strings: bad-streams",
        }),
        expect.objectContaining({
          pluginId: "duplicate-host-hook-fixture",
          message: "session scheduler job cleanup must be a function: bad-scheduler-cleanup",
        }),
      ]),
    );
  });

  it("defensively ignores promise-like session projections from untyped plugins", async () => {
    const { config, registry } = createPluginRegistryFixture();
    registerTestPlugin({
      registry,
      config,
      record: createPluginRecord({
        id: "promise-projector-fixture",
        name: "Promise Projector Fixture",
      }),
      register(api) {
        api.registerSessionExtension({
          namespace: "workflow",
          description: "Promise workflow state",
          project: (() =>
            Promise.reject(
              new Error("projectors must be synchronous"),
            )) as unknown as () => undefined,
        });
      },
    });
    setActivePluginRegistry(registry.registry);
    const entry: SessionEntry = {
      sessionId: "session-1",
      updatedAt: 1,
      pluginExtensions: {
        "promise-projector-fixture": {
          workflow: { state: "waiting" },
        },
      },
    };

    expect(projectPluginSessionExtensionsSync({ sessionKey: "agent:main:main", entry })).toEqual(
      [],
    );
    await expect(
      projectPluginSessionExtensions({ sessionKey: "agent:main:main", entry }),
    ).resolves.toEqual([]);
  });

  it("skips throwing session extension projectors without losing other projections", () => {
    const { config, registry } = createPluginRegistryFixture();
    registerTestPlugin({
      registry,
      config,
      record: createPluginRecord({
        id: "throwing-projector-fixture",
        name: "Throwing Projector Fixture",
      }),
      register(api) {
        api.registerSessionExtension({
          namespace: "workflow",
          description: "Throwing workflow state",
          project: () => {
            throw new Error("projection failed");
          },
        });
      },
    });
    registerTestPlugin({
      registry,
      config,
      record: createPluginRecord({
        id: "healthy-projector-fixture",
        name: "Healthy Projector Fixture",
      }),
      register(api) {
        api.registerSessionExtension({
          namespace: "workflow",
          description: "Healthy workflow state",
          project: ({ state }) => state,
        });
      },
    });
    setActivePluginRegistry(registry.registry);
    const entry: SessionEntry = {
      sessionId: "session-1",
      updatedAt: 1,
      pluginExtensions: {
        "throwing-projector-fixture": {
          workflow: { state: "hidden" },
        },
        "healthy-projector-fixture": {
          workflow: { state: "visible" },
        },
      },
    };

    expect(projectPluginSessionExtensionsSync({ sessionKey: "agent:main:main", entry })).toEqual([
      {
        pluginId: "healthy-projector-fixture",
        namespace: "workflow",
        value: { state: "visible" },
      },
    ]);
    const row = buildGatewaySessionRow({
      cfg: config,
      storePath: "/tmp/sessions.json",
      store: {},
      key: "agent:main:main",
      entry,
    });
    expect(row.pluginExtensions).toEqual([
      {
        pluginId: "healthy-projector-fixture",
        namespace: "workflow",
        value: { state: "visible" },
      },
    ]);
  });

  it("requires explicit unset to remove plugin session extension state", async () => {
    const { config, registry } = createPluginRegistryFixture();
    registerTestPlugin({
      registry,
      config,
      record: createPluginRecord({
        id: "patch-fixture",
        name: "Patch Fixture",
      }),
      register(api) {
        api.registerSessionExtension({
          namespace: "workflow",
          description: "Patch workflow state",
        });
      },
    });
    setActivePluginRegistry(registry.registry);

    const stateDir = await fs.mkdtemp(
      path.join(resolvePreferredOpenClawTmpDir(), "openclaw-host-hooks-patch-"),
    );
    const storePath = path.join(stateDir, "sessions.json");
    const tempConfig = {
      session: { store: storePath },
    };
    const previousStateDir = process.env.OPENCLAW_STATE_DIR;
    try {
      process.env.OPENCLAW_STATE_DIR = stateDir;
      await withTempConfig({
        cfg: tempConfig,
        run: async () => {
          await updateSessionStore(storePath, (store) => {
            store["agent:main:main"] = {
              sessionId: "session-1",
              updatedAt: Date.now(),
              pluginExtensions: {
                "patch-fixture": { workflow: { state: "waiting" } },
              },
            };
            return undefined;
          });

          await expect(
            patchPluginSessionExtension({
              cfg: tempConfig,
              sessionKey: "agent:main:main",
              pluginId: "patch-fixture",
              namespace: "workflow",
            }),
          ).resolves.toEqual({
            ok: false,
            error: "plugin session extension value is required unless unset is true",
          });
          expect(
            loadSessionStore(storePath)["agent:main:main"]?.pluginExtensions?.["patch-fixture"]
              ?.workflow,
          ).toEqual({ state: "waiting" });

          await expect(
            patchPluginSessionExtension({
              cfg: tempConfig,
              sessionKey: "agent:main:main",
              pluginId: "patch-fixture",
              namespace: "workflow",
              value: { state: "ambiguous" },
              unset: true,
            }),
          ).resolves.toEqual({
            ok: false,
            error: "plugin session extension cannot specify both unset and value",
          });
          expect(
            loadSessionStore(storePath)["agent:main:main"]?.pluginExtensions?.["patch-fixture"]
              ?.workflow,
          ).toEqual({ state: "waiting" });

          await expect(
            patchPluginSessionExtension({
              cfg: tempConfig,
              sessionKey: "agent:main:main",
              pluginId: "patch-fixture",
              namespace: "workflow",
              value: { state: "approved" },
            }),
          ).resolves.toEqual({
            ok: true,
            key: "agent:main:main",
            value: { state: "approved" },
          });

          await expect(
            patchPluginSessionExtension({
              cfg: tempConfig,
              sessionKey: "agent:main:main",
              pluginId: "patch-fixture",
              namespace: "workflow",
              unset: true,
            }),
          ).resolves.toEqual({
            ok: true,
            key: "agent:main:main",
            value: undefined,
          });
          expect(loadSessionStore(storePath)["agent:main:main"]?.pluginExtensions).toBeUndefined();
        },
      });
    } finally {
      if (previousStateDir === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = previousStateDir;
      }
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });

  it("models queued next-turn injections and agent_turn_prepare as one prompt context", async () => {
    const { config, registry } = createPluginRegistryFixture();
    registerTestPlugin({
      registry,
      config,
      record: createPluginRecord({
        id: "host-hook-fixture",
        name: "Host Hook Fixture",
      }),
      register: registerHostHookFixture,
    });
    const runner = createHookRunner(registry.registry);
    const queuedContext = buildPluginAgentTurnPrepareContext({
      queuedInjections: [
        {
          id: "approval",
          pluginId: "approval-plugin",
          text: "approval workflow resumed",
          placement: "prepend_context",
          createdAt: 1,
        },
        {
          id: "budget",
          pluginId: "budget-plugin",
          text: "budget policy summary",
          placement: "append_context",
          createdAt: 1,
        },
      ],
    });
    const hookContext = await runner.runAgentTurnPrepare(
      {
        prompt: "continue",
        messages: [],
        queuedInjections: [],
      },
      { sessionKey: "agent:main:main" },
    );

    expect(
      [queuedContext.prependContext, queuedContext.appendContext, hookContext?.prependContext]
        .filter(Boolean)
        .join("\n\n"),
    ).toContain("approval workflow resumed");
    expect(hookContext?.prependContext).toBe("fixture turn context");
  });

  it("skips malformed persisted next-turn injection records during prompt assembly", () => {
    const queuedContext = buildPluginAgentTurnPrepareContext({
      queuedInjections: [
        {
          id: "bad-text",
          pluginId: "approval-plugin",
          text: 123,
          placement: "prepend_context",
          createdAt: 1,
        } as never,
        {
          id: "bad-placement",
          pluginId: "approval-plugin",
          text: "wrong placement",
          placement: "middle_context",
          createdAt: 1,
        } as never,
        {
          id: "valid",
          pluginId: "approval-plugin",
          text: "  approval workflow resumed  ",
          placement: "append_context",
          createdAt: 1,
        },
      ],
    });

    expect(queuedContext).toEqual({ appendContext: "approval workflow resumed" });
  });

  it("rejects malformed next-turn injection input before persisting records", async () => {
    await expect(
      enqueuePluginNextTurnInjection({
        cfg: {},
        pluginId: "approval-fixture",
        injection: {
          sessionKey: "agent:main:main",
          text: "invalid placement",
          placement: "middle_context",
        } as never,
      }),
    ).resolves.toEqual({ enqueued: false, id: "", sessionKey: "agent:main:main" });

    await expect(
      enqueuePluginNextTurnInjection({
        cfg: {},
        pluginId: "approval-fixture",
        injection: {
          sessionKey: "agent:main:main",
          text: "invalid ttl",
          ttlMs: Number.POSITIVE_INFINITY,
        },
      }),
    ).resolves.toEqual({ enqueued: false, id: "", sessionKey: "agent:main:main" });

    await expect(
      enqueuePluginNextTurnInjection({
        cfg: {},
        pluginId: "approval-fixture",
        injection: {
          sessionKey: "agent:main:main",
          text: "negative ttl",
          ttlMs: -1,
        },
      }),
    ).resolves.toEqual({ enqueued: false, id: "", sessionKey: "agent:main:main" });
  });

  it("reports duplicate next-turn injections as not newly enqueued", async () => {
    const stateDir = await fs.mkdtemp(
      path.join(resolvePreferredOpenClawTmpDir(), "openclaw-host-hooks-injection-"),
    );
    const storePath = path.join(stateDir, "sessions.json");
    const tempConfig = {
      session: { store: storePath },
    };
    const previousStateDir = process.env.OPENCLAW_STATE_DIR;
    try {
      process.env.OPENCLAW_STATE_DIR = stateDir;
      await withTempConfig({
        cfg: tempConfig,
        run: async () => {
          await updateSessionStore(storePath, (store) => {
            store["agent:main:main"] = {
              sessionId: "session-1",
              updatedAt: Date.now(),
            };
            return undefined;
          });
          const now = Date.now();

          const first = await enqueuePluginNextTurnInjection({
            cfg: tempConfig,
            pluginId: "approval-fixture",
            injection: {
              sessionKey: "agent:main:main",
              text: "resume approval workflow",
              placement: "prepend_context",
              idempotencyKey: "approval:resume",
            },
            now,
          });
          const duplicate = await enqueuePluginNextTurnInjection({
            cfg: tempConfig,
            pluginId: "approval-fixture",
            injection: {
              sessionKey: "agent:main:main",
              text: "resume approval workflow again",
              placement: "prepend_context",
              idempotencyKey: "approval:resume",
            },
            now: now + 1,
          });

          expect(first.enqueued).toBe(true);
          expect(duplicate).toEqual({
            enqueued: false,
            id: first.id,
            sessionKey: "agent:main:main",
          });
          const stored = loadSessionStore(storePath, { skipCache: true });
          expect(
            stored["agent:main:main"]?.pluginNextTurnInjections?.["approval-fixture"],
          ).toHaveLength(1);
        },
      });
    } finally {
      if (previousStateDir === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = previousStateDir;
      }
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });

  it("suppresses stale next-turn injections from plugins that are no longer loaded", async () => {
    const registry = createEmptyPluginRegistry();
    registry.plugins.push(
      createPluginRecord({
        id: "active-injector",
        name: "Active Injector",
        status: "loaded",
      }),
      createPluginRecord({
        id: "disabled-injector",
        name: "Disabled Injector",
        status: "disabled",
      }),
      createPluginRecord({
        id: "policy-blocked-injector",
        name: "Policy Blocked Injector",
        status: "loaded",
      }),
    );
    setActivePluginRegistry(registry);
    const stateDir = await fs.mkdtemp(
      path.join(resolvePreferredOpenClawTmpDir(), "openclaw-host-hooks-stale-"),
    );
    const storePath = path.join(stateDir, "sessions.json");
    const tempConfig = {
      session: { store: storePath },
      plugins: {
        entries: {
          "policy-blocked-injector": {
            hooks: { allowPromptInjection: false },
          },
        },
      },
    };
    const previousStateDir = process.env.OPENCLAW_STATE_DIR;
    try {
      process.env.OPENCLAW_STATE_DIR = stateDir;
      await withTempConfig({
        cfg: tempConfig,
        run: async () => {
          await updateSessionStore(storePath, (store) => {
            store["agent:main:main"] = {
              sessionId: "session-1",
              updatedAt: Date.now(),
              pluginNextTurnInjections: {
                "active-injector": [
                  {
                    id: "active",
                    pluginId: "active-injector",
                    text: "active prompt contribution",
                    placement: "append_context",
                    createdAt: 1,
                  },
                ],
                "disabled-injector": [
                  {
                    id: "stale",
                    pluginId: "disabled-injector",
                    text: "stale prompt contribution",
                    placement: "prepend_context",
                    createdAt: 1,
                  },
                ],
                "policy-blocked-injector": [
                  {
                    id: "policy-blocked",
                    pluginId: "policy-blocked-injector",
                    text: "policy blocked prompt contribution",
                    placement: "prepend_context",
                    createdAt: 1,
                  },
                ],
              },
            };
            return undefined;
          });

          await expect(
            drainPluginNextTurnInjections({
              cfg: tempConfig,
              sessionKey: "agent:main:main",
              now: 2,
            }),
          ).resolves.toEqual([
            expect.objectContaining({
              id: "active",
              pluginId: "active-injector",
              text: "active prompt contribution",
            }),
          ]);
          const stored = loadSessionStore(storePath, { skipCache: true });
          expect(stored["agent:main:main"]?.pluginNextTurnInjections).toBeUndefined();
        },
      });
    } finally {
      if (previousStateDir === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = previousStateDir;
      }
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });

  it("preserves global enqueue order when draining live next-turn injections", async () => {
    const registry = createEmptyPluginRegistry();
    registry.plugins.push(
      createPluginRecord({
        id: "injector-a",
        name: "Injector A",
        status: "loaded",
      }),
      createPluginRecord({
        id: "injector-b",
        name: "Injector B",
        status: "loaded",
      }),
    );
    setActivePluginRegistry(registry);
    const stateDir = await fs.mkdtemp(
      path.join(resolvePreferredOpenClawTmpDir(), "openclaw-host-hooks-order-"),
    );
    const storePath = path.join(stateDir, "sessions.json");
    const tempConfig = {
      session: { store: storePath },
    };
    const previousStateDir = process.env.OPENCLAW_STATE_DIR;
    try {
      process.env.OPENCLAW_STATE_DIR = stateDir;
      await withTempConfig({
        cfg: tempConfig,
        run: async () => {
          await updateSessionStore(storePath, (store) => {
            store["agent:main:main"] = {
              sessionId: "session-1",
              updatedAt: Date.now(),
              pluginNextTurnInjections: {
                "injector-a": [
                  {
                    id: "a1",
                    pluginId: "injector-a",
                    text: "first",
                    placement: "append_context",
                    createdAt: 1,
                  },
                  {
                    id: "a2",
                    pluginId: "injector-a",
                    text: "third",
                    placement: "append_context",
                    createdAt: 3,
                  },
                ],
                "injector-b": [
                  {
                    id: "b1",
                    pluginId: "injector-b",
                    text: "second",
                    placement: "append_context",
                    createdAt: 2,
                  },
                ],
              },
            };
            return undefined;
          });

          await expect(
            drainPluginNextTurnInjections({
              cfg: tempConfig,
              sessionKey: "agent:main:main",
              now: 4,
            }),
          ).resolves.toEqual([
            expect.objectContaining({ id: "a1", text: "first" }),
            expect.objectContaining({ id: "b1", text: "second" }),
            expect.objectContaining({ id: "a2", text: "third" }),
          ]);
        },
      });
    } finally {
      if (previousStateDir === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = previousStateDir;
      }
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });

  it("validates gateway protocol envelopes for plugin patch and UI descriptors", () => {
    expect(
      validateSessionsPluginPatchParams({
        key: "agent:main:main",
        pluginId: "approval-plugin",
        namespace: "workflow",
        value: { state: "waiting" },
      }),
    ).toBe(true);
    expect(
      validateSessionsPluginPatchParams({
        key: "agent:main:main",
        pluginId: "approval-plugin",
        namespace: "workflow",
        value: { state: "waiting" },
        accidentalPlanModeRootField: true,
      }),
    ).toBe(false);
    expect(validatePluginsUiDescriptorsParams({})).toBe(true);
    expect(validatePluginsUiDescriptorsParams({ pluginId: "host-hook-fixture" })).toBe(false);
  });

  it("enforces command requiredScopes for gateway clients while preserving text command continuations", async () => {
    const handlerCalls: string[] = [];
    const { config, registry } = createPluginRegistryFixture();
    registerTestPlugin({
      registry,
      config,
      record: createPluginRecord({
        id: "approval-command-fixture",
        name: "Approval Command Fixture",
      }),
      register(api) {
        api.registerCommand({
          name: "approval-fixture",
          description: "Continue the agent after approval.",
          requiredScopes: [APPROVALS_SCOPE],
          acceptsArgs: true,
          handler: async (ctx) => {
            handlerCalls.push(ctx.args ?? "");
            return { text: "approval queued", continueAgent: true };
          },
        });
      },
    });
    const registration = registry.registry.commands[0];
    expect(registration).toBeTruthy();
    const command = {
      ...registration.command,
      pluginId: registration.pluginId,
      pluginName: registration.pluginName,
      pluginRoot: registration.rootDir,
    };
    expect(
      validatePluginCommandDefinition({
        name: "invalid-scopes-fixture",
        description: "Invalid scopes.",
        requiredScopes: "operator.approvals" as never,
        handler: () => ({ text: "unused" }),
      }),
    ).toBe("Command requiredScopes must be an array of operator scopes");
    expect(
      validatePluginCommandDefinition({
        name: "unknown-scopes-fixture",
        description: "Unknown scopes.",
        requiredScopes: ["operator.unknown" as never],
        handler: () => ({ text: "unused" }),
      }),
    ).toBe("Command requiredScopes contains unknown operator scope: operator.unknown");

    await expect(
      executePluginCommand({
        command,
        args: "resume-text",
        senderId: "owner",
        channel: "whatsapp",
        isAuthorizedSender: true,
        sessionKey: "agent:main:main",
        commandBody: "/approval-fixture resume-text",
        config,
      }),
    ).resolves.toEqual({ text: "approval queued", continueAgent: true });
    expect(handlerCalls).toEqual(["resume-text"]);

    await expect(
      executePluginCommand({
        command,
        args: "resume",
        senderId: "owner",
        channel: "whatsapp",
        isAuthorizedSender: true,
        gatewayClientScopes: [READ_SCOPE, WRITE_SCOPE],
        sessionKey: "agent:main:main",
        commandBody: "/approval-fixture resume",
        config,
      }),
    ).resolves.toEqual({
      text: `⚠️ This command requires gateway scope: ${APPROVALS_SCOPE}.`,
    });
    expect(handlerCalls).toEqual(["resume-text"]);

    await expect(
      executePluginCommand({
        command,
        args: "resume",
        senderId: "owner",
        channel: "whatsapp",
        isAuthorizedSender: true,
        gatewayClientScopes: [APPROVALS_SCOPE],
        sessionKey: "agent:main:main",
        commandBody: "/approval-fixture resume",
        config,
      }),
    ).resolves.toEqual({ text: "approval queued", continueAgent: true });
    expect(handlerCalls).toEqual(["resume-text", "resume"]);
  });

  it("dispatches sanitized agent events and clears plugin run context on run end", async () => {
    const { config, registry } = createPluginRegistryFixture();
    registerTestPlugin({
      registry,
      config,
      record: createPluginRecord({
        id: "host-hook-fixture",
        name: "Host Hook Fixture",
      }),
      register: registerHostHookFixture,
    });
    setActivePluginRegistry(registry.registry);

    emitAgentEvent({
      runId: "run-1",
      stream: "tool",
      data: { name: "approval_fixture_tool" },
    });
    await Promise.resolve();

    expect(
      getPluginRunContext({
        pluginId: "host-hook-fixture",
        get: { runId: "run-1", namespace: "lastToolEvent" },
      }),
    ).toEqual({ runId: "run-1", seen: true });

    emitAgentEvent({
      runId: "run-1",
      stream: "lifecycle",
      data: { phase: "end" },
    });
    await waitForPluginEventHandlers();

    expect(
      getPluginRunContext({
        pluginId: "host-hook-fixture",
        get: { runId: "run-1", namespace: "lastToolEvent" },
      }),
    ).toBeUndefined();
  });

  it("clears run context on terminal events even when no plugin subscribes to agent events", async () => {
    setActivePluginRegistry(createEmptyPluginRegistry());
    expect(
      setPluginRunContext({
        pluginId: "context-only-plugin",
        patch: { runId: "run-no-subscribers", namespace: "state", value: { ok: true } },
      }),
    ).toBe(true);

    emitAgentEvent({
      runId: "run-no-subscribers",
      stream: "lifecycle",
      data: { phase: "end" },
    });
    await waitForPluginEventHandlers();

    expect(
      getPluginRunContext({
        pluginId: "context-only-plugin",
        get: { runId: "run-no-subscribers", namespace: "state" },
      }),
    ).toBeUndefined();
  });

  it("does not let delayed non-terminal subscriptions resurrect closed run context", async () => {
    let releaseToolHandler: (() => void) | undefined;
    const { config, registry } = createPluginRegistryFixture();
    registerTestPlugin({
      registry,
      config,
      record: createPluginRecord({
        id: "delayed-subscription",
        name: "Delayed Subscription",
      }),
      register(api) {
        api.registerAgentEventSubscription({
          id: "delayed",
          streams: ["tool"],
          async handle(_event, ctx) {
            await new Promise<void>((resolve) => {
              releaseToolHandler = resolve;
            });
            ctx.setRunContext("late", { resurrected: true });
          },
        });
      },
    });
    setActivePluginRegistry(registry.registry);

    emitAgentEvent({
      runId: "run-delayed-subscription",
      stream: "tool",
      data: { name: "approval_fixture_tool" },
    });
    await Promise.resolve();

    emitAgentEvent({
      runId: "run-delayed-subscription",
      stream: "lifecycle",
      data: { phase: "end" },
    });
    releaseToolHandler?.();
    await waitForPluginEventHandlers();

    expect(
      getPluginRunContext({
        pluginId: "delayed-subscription",
        get: { runId: "run-delayed-subscription", namespace: "late" },
      }),
    ).toBeUndefined();
  });

  it("continues agent event dispatch and terminal cleanup when one subscription throws", async () => {
    const { config, registry } = createPluginRegistryFixture();
    registerTestPlugin({
      registry,
      config,
      record: createPluginRecord({
        id: "throwing-subscription",
        name: "Throwing Subscription",
      }),
      register(api) {
        api.registerAgentEventSubscription({
          id: "throws",
          streams: ["tool"],
          handle() {
            throw new Error("subscription failed");
          },
        });
      },
    });
    registerTestPlugin({
      registry,
      config,
      record: createPluginRecord({
        id: "healthy-subscription",
        name: "Healthy Subscription",
      }),
      register(api) {
        api.registerAgentEventSubscription({
          id: "records",
          streams: ["tool"],
          handle(event, ctx) {
            ctx.setRunContext("seen", { runId: event.runId });
          },
        });
      },
    });
    setActivePluginRegistry(registry.registry);

    emitAgentEvent({
      runId: "run-throws",
      stream: "tool",
      data: { name: "approval_fixture_tool" },
    });
    await Promise.resolve();

    expect(
      getPluginRunContext({
        pluginId: "healthy-subscription",
        get: { runId: "run-throws", namespace: "seen" },
      }),
    ).toEqual({ runId: "run-throws" });

    emitAgentEvent({
      runId: "run-throws",
      stream: "lifecycle",
      data: { phase: "end" },
    });
    await waitForPluginEventHandlers();

    expect(
      getPluginRunContext({
        pluginId: "healthy-subscription",
        get: { runId: "run-throws", namespace: "seen" },
      }),
    ).toBeUndefined();
  });

  it("preserves run context until async terminal event subscriptions settle", async () => {
    let releaseTerminalHandler: (() => void) | undefined;
    let terminalHandlerSawContext: unknown;
    const { config, registry } = createPluginRegistryFixture();
    registerTestPlugin({
      registry,
      config,
      record: createPluginRecord({
        id: "async-terminal-subscription",
        name: "Async Terminal Subscription",
      }),
      register(api) {
        api.registerAgentEventSubscription({
          id: "records",
          streams: ["tool", "lifecycle"],
          async handle(event, ctx) {
            if (event.stream === "tool") {
              ctx.setRunContext("seen", { runId: event.runId });
              return;
            }
            if (event.data?.phase !== "end") {
              return;
            }
            await new Promise<void>((resolve) => {
              releaseTerminalHandler = resolve;
            });
            terminalHandlerSawContext = ctx.getRunContext("seen");
          },
        });
      },
    });
    setActivePluginRegistry(registry.registry);

    emitAgentEvent({
      runId: "run-async-terminal",
      stream: "tool",
      data: { name: "approval_fixture_tool" },
    });
    await Promise.resolve();

    emitAgentEvent({
      runId: "run-async-terminal",
      stream: "lifecycle",
      data: { phase: "end" },
    });
    await Promise.resolve();

    expect(
      getPluginRunContext({
        pluginId: "async-terminal-subscription",
        get: { runId: "run-async-terminal", namespace: "seen" },
      }),
    ).toEqual({ runId: "run-async-terminal" });

    releaseTerminalHandler?.();
    await waitForPluginEventHandlers();

    expect(terminalHandlerSawContext).toEqual({ runId: "run-async-terminal" });
    expect(
      getPluginRunContext({
        pluginId: "async-terminal-subscription",
        get: { runId: "run-async-terminal", namespace: "seen" },
      }),
    ).toBeUndefined();
  });

  it("covers the non-Plan plugin archetypes promised by the host-hook fixture", () => {
    const archetypes = [
      {
        name: "approval workflow",
        seams: [
          "session extension",
          "command continuation",
          "next-turn injection",
          "UI descriptor",
        ],
      },
      {
        name: "budget/workspace policy gate",
        seams: ["trusted tool policy", "tool metadata", "session projection"],
      },
      {
        name: "background lifecycle monitor",
        seams: ["agent event subscription", "scheduler cleanup", "heartbeat prompt contribution"],
      },
    ];

    expect(archetypes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "approval workflow" }),
        expect.objectContaining({ name: "budget/workspace policy gate" }),
        expect.objectContaining({ name: "background lifecycle monitor" }),
      ]),
    );
    expect(archetypes.flatMap((entry) => entry.seams)).toEqual(
      expect.arrayContaining([
        "session extension",
        "trusted tool policy",
        "agent event subscription",
        "scheduler cleanup",
      ]),
    );
  });

  it("proves every #71676 Plan Mode entry-point class has a generic host seam", () => {
    const parityMap = [
      ["session state + sessions.patch", "session extensions + sessions.pluginPatch"],
      [
        "pending injections + approval resumes",
        "durable next-turn injections + agent_turn_prepare",
      ],
      ["mutation gates around tools", "trusted tool policy before before_tool_call"],
      ["slash/native command continuations", "requiredScopes + reserved ownership + continueAgent"],
      ["Control UI mode/cards/status", "Control UI descriptor projection"],
      [
        "plan snapshots, nudges, subagent follow-ups, heartbeat",
        "agent events + run context + scheduler cleanup + heartbeat contribution",
      ],
      ["tool catalog display metadata", "plugin tool metadata projection"],
      ["disable/reset/delete/restart cleanup", "runtime lifecycle cleanup"],
    ];

    expect(parityMap).toHaveLength(8);
    for (const [entryPoint, seam] of parityMap) {
      expect(entryPoint).toBeTruthy();
      expect(seam).toBeTruthy();
      expect(seam).not.toContain("Plan Mode");
    }
  });

  it("cleans plugin-owned session state and lifecycle resources on reset/disable", async () => {
    const cleanupEvents: string[] = [];
    const { config, registry } = createPluginRegistryFixture();
    registerTestPlugin({
      registry,
      config,
      record: createPluginRecord({
        id: "cleanup-fixture",
        name: "Cleanup Fixture",
      }),
      register(api) {
        api.registerSessionExtension({
          namespace: "workflow",
          description: "cleanup test",
          cleanup: ({ reason, sessionKey }) => {
            cleanupEvents.push(`session:${reason}:${sessionKey ?? ""}`);
          },
        });
        api.registerRuntimeLifecycle({
          id: "monitor",
          cleanup: ({ reason, sessionKey }) => {
            cleanupEvents.push(`runtime:${reason}:${sessionKey ?? ""}`);
          },
        });
        api.registerSessionSchedulerJob({
          id: "nudge",
          sessionKey: "agent:main:main",
          kind: "monitor",
          cleanup: ({ reason, sessionKey }) => {
            cleanupEvents.push(`scheduler:${reason}:${sessionKey}`);
          },
        });
      },
    });

    const entry: SessionEntry = {
      sessionId: "session-1",
      updatedAt: 1,
      pluginExtensions: {
        "cleanup-fixture": { workflow: { state: "waiting" } },
        "other-plugin": { workflow: { state: "keep" } },
      },
      pluginNextTurnInjections: {
        "cleanup-fixture": [
          {
            id: "resume",
            pluginId: "cleanup-fixture",
            text: "resume",
            placement: "prepend_context" as const,
            createdAt: 1,
          },
        ],
        "other-plugin": [
          {
            id: "keep",
            pluginId: "other-plugin",
            text: "keep",
            placement: "append_context" as const,
            createdAt: 1,
          },
        ],
      },
    };
    clearPluginOwnedSessionState(entry, "cleanup-fixture");
    expect(entry.pluginExtensions).toEqual({
      "other-plugin": { workflow: { state: "keep" } },
    });
    expect(entry.pluginNextTurnInjections).toEqual({
      "other-plugin": [
        {
          id: "keep",
          pluginId: "other-plugin",
          text: "keep",
          placement: "append_context",
          createdAt: 1,
        },
      ],
    });

    const stateDir = await fs.mkdtemp(
      path.join(resolvePreferredOpenClawTmpDir(), "openclaw-host-hooks-state-"),
    );
    const tempConfig = {
      session: { store: path.join(stateDir, "sessions.json") },
    };
    const previousStateDir = process.env.OPENCLAW_STATE_DIR;
    try {
      process.env.OPENCLAW_STATE_DIR = stateDir;
      await withTempConfig({
        cfg: tempConfig,
        run: async () => {
          await runPluginHostCleanup({
            cfg: tempConfig,
            registry: registry.registry,
            pluginId: "cleanup-fixture",
            reason: "reset",
            sessionKey: "agent:main:main",
          });
          await cleanupReplacedPluginHostRegistry({
            cfg: tempConfig,
            previousRegistry: registry.registry,
            nextRegistry: createEmptyPluginRegistry(),
          });
        },
      });
    } finally {
      if (previousStateDir === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = previousStateDir;
      }
      await fs.rm(stateDir, { recursive: true, force: true });
    }

    expect(cleanupEvents).toEqual([
      "session:reset:agent:main:main",
      "runtime:reset:agent:main:main",
      "scheduler:reset:agent:main:main",
      "session:disable:",
      "runtime:disable:",
    ]);
    expect(listPluginSessionSchedulerJobs("cleanup-fixture")).toEqual([]);
  });

  it("keeps scheduler job records when cleanup fails so cleanup can retry", async () => {
    const { config, registry } = createPluginRegistryFixture();
    registerTestPlugin({
      registry,
      config,
      record: createPluginRecord({
        id: "cleanup-failure-fixture",
        name: "Cleanup Failure Fixture",
      }),
      register(api) {
        api.registerSessionSchedulerJob({
          id: "retryable-job",
          sessionKey: "agent:main:main",
          kind: "monitor",
          cleanup: () => {
            throw new Error("cleanup failed");
          },
        });
      },
    });

    await expect(
      runPluginHostCleanup({
        cfg: config,
        registry: registry.registry,
        pluginId: "cleanup-failure-fixture",
        reason: "disable",
      }),
    ).resolves.toMatchObject({
      failures: [
        expect.objectContaining({
          pluginId: "cleanup-failure-fixture",
          hookId: "scheduler:retryable-job",
        }),
      ],
    });
    expect(listPluginSessionSchedulerJobs("cleanup-failure-fixture")).toEqual([
      {
        id: "retryable-job",
        pluginId: "cleanup-failure-fixture",
        sessionKey: "agent:main:main",
        kind: "monitor",
      },
    ]);
  });

  it("preserves restarted scheduler jobs while cleaning the replaced registry", async () => {
    const cleanupEvents: string[] = [];
    const previous = createEmptyPluginRegistry();
    previous.plugins.push(
      createPluginRecord({
        id: "restart-fixture",
        name: "Restart Fixture",
        status: "loaded",
      }),
    );
    previous.sessionSchedulerJobs = [
      {
        pluginId: "restart-fixture",
        pluginName: "Restart Fixture",
        job: {
          id: "shared-job",
          sessionKey: "agent:main:main",
          kind: "monitor",
          cleanup: ({ reason, jobId }) => {
            cleanupEvents.push(`${reason}:${jobId}`);
          },
        },
        source: "/virtual/restart-fixture/index.ts",
        rootDir: "/virtual/restart-fixture",
      },
    ];
    const next = createEmptyPluginRegistry();
    next.plugins.push(
      createPluginRecord({
        id: "restart-fixture",
        name: "Restart Fixture",
        status: "loaded",
      }),
    );
    next.sessionSchedulerJobs = [
      {
        pluginId: "restart-fixture",
        pluginName: "Restart Fixture",
        job: {
          id: "shared-job",
          sessionKey: "agent:main:main",
          kind: "monitor",
          cleanup: () => undefined,
        },
        source: "/virtual/restart-fixture/index.ts",
        rootDir: "/virtual/restart-fixture",
      },
    ];
    const { config, registry } = createPluginRegistryFixture();
    registerTestPlugin({
      registry,
      config,
      record: createPluginRecord({
        id: "restart-fixture",
        name: "Restart Fixture",
      }),
      register(api) {
        api.registerSessionSchedulerJob({
          id: "shared-job",
          sessionKey: "agent:main:main",
          kind: "monitor",
        });
      },
    });

    await expect(
      cleanupReplacedPluginHostRegistry({
        cfg: config,
        previousRegistry: previous,
        nextRegistry: next,
      }),
    ).resolves.toMatchObject({ failures: [] });
    expect(cleanupEvents).toEqual([]);
    expect(listPluginSessionSchedulerJobs("restart-fixture")).toEqual([
      {
        id: "shared-job",
        pluginId: "restart-fixture",
        sessionKey: "agent:main:main",
        kind: "monitor",
      },
    ]);
  });

  it("does not let stale scheduler cleanup delete a newer job generation", async () => {
    let releaseCleanup: (() => void) | undefined;
    let markCleanupStarted!: () => void;
    const cleanupStartedPromise = new Promise<void>((resolve) => {
      markCleanupStarted = resolve;
    });
    const previousFixture = createPluginRegistryFixture();
    registerTestPlugin({
      registry: previousFixture.registry,
      config: previousFixture.config,
      record: createPluginRecord({
        id: "scheduler-race",
        name: "Scheduler Race",
      }),
      register(api) {
        api.registerSessionSchedulerJob({
          id: "shared-job",
          sessionKey: "agent:main:main",
          kind: "monitor",
          cleanup: async () => {
            markCleanupStarted();
            await new Promise<void>((resolve) => {
              releaseCleanup = resolve;
            });
          },
        });
      },
    });

    const cleanupPromise = cleanupReplacedPluginHostRegistry({
      cfg: previousFixture.config,
      previousRegistry: previousFixture.registry.registry,
      nextRegistry: createEmptyPluginRegistry(),
    });
    await cleanupStartedPromise;

    const replacementFixture = createPluginRegistryFixture();
    registerTestPlugin({
      registry: replacementFixture.registry,
      config: replacementFixture.config,
      record: createPluginRecord({
        id: "scheduler-race",
        name: "Scheduler Race",
      }),
      register(api) {
        api.registerSessionSchedulerJob({
          id: "shared-job",
          sessionKey: "agent:main:main",
          kind: "monitor",
        });
      },
    });

    releaseCleanup?.();
    await expect(cleanupPromise).resolves.toMatchObject({ failures: [] });
    expect(listPluginSessionSchedulerJobs("scheduler-race")).toEqual([
      {
        id: "shared-job",
        pluginId: "scheduler-race",
        sessionKey: "agent:main:main",
        kind: "monitor",
      },
    ]);
  });

  it("does not register scheduler jobs globally during non-activating registry loads", () => {
    const registry = createPluginRegistry({
      logger: {
        info() {},
        warn() {},
        error() {},
        debug() {},
      },
      runtime: {} as PluginRuntime,
      activateGlobalSideEffects: false,
    });
    const config = {};
    let handle:
      | {
          id: string;
          pluginId: string;
          sessionKey: string;
          kind: string;
        }
      | undefined;
    registerTestPlugin({
      registry,
      config,
      record: createPluginRecord({
        id: "snapshot-fixture",
        name: "Snapshot Fixture",
      }),
      register(api) {
        handle = api.registerSessionSchedulerJob({
          id: "snapshot-job",
          sessionKey: "agent:main:main",
          kind: "monitor",
        });
      },
    });

    expect(handle).toEqual({
      id: "snapshot-job",
      pluginId: "snapshot-fixture",
      sessionKey: "agent:main:main",
      kind: "monitor",
    });
    expect(registry.registry.sessionSchedulerJobs).toEqual([
      expect.objectContaining({
        pluginId: "snapshot-fixture",
        job: expect.objectContaining({
          id: "snapshot-job",
          sessionKey: "agent:main:main",
          kind: "monitor",
        }),
      }),
    ]);
    expect(listPluginSessionSchedulerJobs("snapshot-fixture")).toEqual([]);
  });

  it("removes persistent plugin-owned session state and pending injections during cleanup", async () => {
    const { config, registry } = createPluginRegistryFixture();
    registerTestPlugin({
      registry,
      config,
      record: createPluginRecord({
        id: "cleanup-fixture",
        name: "Cleanup Fixture",
      }),
      register(api) {
        api.registerSessionExtension({
          namespace: "workflow",
          description: "cleanup test",
        });
      },
    });

    const stateDir = await fs.mkdtemp(
      path.join(resolvePreferredOpenClawTmpDir(), "openclaw-host-hooks-store-"),
    );
    const storePath = path.join(stateDir, "sessions.json");
    const tempConfig = {
      session: { store: storePath },
    };
    const previousStateDir = process.env.OPENCLAW_STATE_DIR;
    try {
      process.env.OPENCLAW_STATE_DIR = stateDir;
      await withTempConfig({
        cfg: tempConfig,
        run: async () => {
          await updateSessionStore(storePath, (store) => {
            store["agent:main:main"] = {
              sessionId: "session-1",
              updatedAt: Date.now(),
              pluginExtensions: {
                "cleanup-fixture": { workflow: { state: "waiting" } },
                "other-plugin": { workflow: { state: "keep" } },
              },
              pluginNextTurnInjections: {
                "cleanup-fixture": [
                  {
                    id: "resume",
                    pluginId: "cleanup-fixture",
                    text: "resume",
                    placement: "prepend_context",
                    createdAt: 1,
                  },
                ],
                "other-plugin": [
                  {
                    id: "keep",
                    pluginId: "other-plugin",
                    text: "keep",
                    placement: "append_context",
                    createdAt: 1,
                  },
                ],
              },
            };
            return undefined;
          });

          await expect(
            runPluginHostCleanup({
              cfg: tempConfig,
              registry: registry.registry,
              pluginId: "cleanup-fixture",
              reason: "disable",
            }),
          ).resolves.toMatchObject({ failures: [] });

          const stored = loadSessionStore(storePath, { skipCache: true });
          expect(stored["agent:main:main"]).toEqual(
            expect.objectContaining({
              pluginExtensions: {
                "other-plugin": { workflow: { state: "keep" } },
              },
              pluginNextTurnInjections: {
                "other-plugin": [
                  {
                    id: "keep",
                    pluginId: "other-plugin",
                    text: "keep",
                    placement: "append_context",
                    createdAt: 1,
                  },
                ],
              },
            }),
          );
        },
      });
    } finally {
      if (previousStateDir === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = previousStateDir;
      }
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });

  it("does not clear unrelated run context during session-scoped cleanup", async () => {
    const registry = createEmptyPluginRegistry();
    expect(
      setPluginRunContext({
        pluginId: "plugin-a",
        patch: { runId: "run-a", namespace: "state", value: { keep: "a" } },
      }),
    ).toBe(true);
    expect(
      setPluginRunContext({
        pluginId: "plugin-b",
        patch: { runId: "run-b", namespace: "state", value: { keep: "b" } },
      }),
    ).toBe(true);

    const stateDir = await fs.mkdtemp(
      path.join(resolvePreferredOpenClawTmpDir(), "openclaw-host-hooks-run-context-"),
    );
    const tempConfig = {
      session: { store: path.join(stateDir, "sessions.json") },
    };
    const previousStateDir = process.env.OPENCLAW_STATE_DIR;
    try {
      process.env.OPENCLAW_STATE_DIR = stateDir;
      await withTempConfig({
        cfg: tempConfig,
        run: async () => {
          await runPluginHostCleanup({
            cfg: tempConfig,
            registry,
            reason: "reset",
            sessionKey: "agent:main:main",
          });
        },
      });
    } finally {
      if (previousStateDir === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = previousStateDir;
      }
      await fs.rm(stateDir, { recursive: true, force: true });
    }

    expect(
      getPluginRunContext({
        pluginId: "plugin-a",
        get: { runId: "run-a", namespace: "state" },
      }),
    ).toEqual({ keep: "a" });
    expect(
      getPluginRunContext({
        pluginId: "plugin-b",
        get: { runId: "run-b", namespace: "state" },
      }),
    ).toEqual({ keep: "b" });
  });

  it("preserves durable plugin session state during plugin restart cleanup", async () => {
    const { config, registry } = createPluginRegistryFixture();
    registerTestPlugin({
      registry,
      config,
      record: createPluginRecord({
        id: "restart-state-fixture",
        name: "Restart State Fixture",
      }),
      register(api) {
        api.registerSessionExtension({
          namespace: "workflow",
          description: "restart state test",
        });
      },
    });

    const stateDir = await fs.mkdtemp(
      path.join(resolvePreferredOpenClawTmpDir(), "openclaw-host-hooks-restart-state-"),
    );
    const storePath = path.join(stateDir, "sessions.json");
    const tempConfig = {
      session: { store: storePath },
    };
    const previousStateDir = process.env.OPENCLAW_STATE_DIR;
    try {
      process.env.OPENCLAW_STATE_DIR = stateDir;
      await withTempConfig({
        cfg: tempConfig,
        run: async () => {
          await updateSessionStore(storePath, (store) => {
            store["agent:main:main"] = {
              sessionId: "session-1",
              updatedAt: Date.now(),
              pluginExtensions: {
                "restart-state-fixture": { workflow: { state: "waiting" } },
              },
              pluginNextTurnInjections: {
                "restart-state-fixture": [
                  {
                    id: "resume",
                    pluginId: "restart-state-fixture",
                    text: "resume",
                    placement: "prepend_context",
                    createdAt: 1,
                  },
                ],
              },
            };
            return undefined;
          });

          await expect(
            runPluginHostCleanup({
              cfg: tempConfig,
              registry: registry.registry,
              pluginId: "restart-state-fixture",
              reason: "restart",
            }),
          ).resolves.toMatchObject({ failures: [] });

          const stored = loadSessionStore(storePath, { skipCache: true });
          expect(stored["agent:main:main"]?.pluginExtensions).toEqual({
            "restart-state-fixture": { workflow: { state: "waiting" } },
          });
          expect(stored["agent:main:main"]?.pluginNextTurnInjections).toEqual({
            "restart-state-fixture": [
              {
                id: "resume",
                pluginId: "restart-state-fixture",
                text: "resume",
                placement: "prepend_context",
                createdAt: 1,
              },
            ],
          });
        },
      });
    } finally {
      if (previousStateDir === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = previousStateDir;
      }
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });

  it("cleans pending injections for plugins that registered no host-hook callbacks", async () => {
    const previousRegistry = createEmptyPluginRegistry();
    previousRegistry.plugins.push(
      createPluginRecord({
        id: "injection-only-fixture",
        name: "Injection Only Fixture",
        status: "loaded",
      }),
    );
    const stateDir = await fs.mkdtemp(
      path.join(resolvePreferredOpenClawTmpDir(), "openclaw-host-hooks-injection-only-"),
    );
    const storePath = path.join(stateDir, "sessions.json");
    const tempConfig = {
      session: { store: storePath },
    };
    const previousStateDir = process.env.OPENCLAW_STATE_DIR;
    try {
      process.env.OPENCLAW_STATE_DIR = stateDir;
      await withTempConfig({
        cfg: tempConfig,
        run: async () => {
          await updateSessionStore(storePath, (store) => {
            store["agent:main:main"] = {
              sessionId: "session-1",
              updatedAt: Date.now(),
              pluginNextTurnInjections: {
                "injection-only-fixture": [
                  {
                    id: "resume",
                    pluginId: "injection-only-fixture",
                    text: "resume",
                    placement: "prepend_context",
                    createdAt: 1,
                  },
                ],
              },
            };
            return undefined;
          });

          await expect(
            cleanupReplacedPluginHostRegistry({
              cfg: tempConfig,
              previousRegistry,
              nextRegistry: createEmptyPluginRegistry(),
            }),
          ).resolves.toMatchObject({ failures: [] });

          const stored = loadSessionStore(storePath, { skipCache: true });
          expect(stored["agent:main:main"]?.pluginNextTurnInjections).toBeUndefined();
        },
      });
    } finally {
      if (previousStateDir === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = previousStateDir;
      }
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });
});
