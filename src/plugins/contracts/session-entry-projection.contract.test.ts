import fs from "node:fs/promises";
import path from "node:path";
import {
  createPluginRegistryFixture,
  registerTestPlugin,
} from "openclaw/plugin-sdk/plugin-test-contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadSessionStore, updateSessionStore, type SessionEntry } from "../../config/sessions.js";
import { withTempConfig } from "../../gateway/test-temp-config.js";
import { resolvePreferredOpenClawTmpDir } from "../../infra/tmp-openclaw-dir.js";
import { cleanupReplacedPluginHostRegistry, runPluginHostCleanup } from "../host-hook-cleanup.js";
import { clearPluginHostRuntimeState } from "../host-hook-runtime.js";
import { patchPluginSessionExtension } from "../host-hook-state.js";
import type { PluginJsonValue } from "../host-hooks.js";
import { createEmptyPluginRegistry } from "../registry-empty.js";
import { setActivePluginRegistry } from "../runtime.js";
import { createPluginRecord } from "../status.test-helpers.js";
import { runTrustedToolPolicies } from "../trusted-tool-policy.js";

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  expect(value, label).toBeTypeOf("object");
  expect(value, label).not.toBeNull();
  return value as Record<string, unknown>;
}

async function expectOkResult(promise: Promise<unknown>, label: string) {
  const result = requireRecord(await promise, label);
  expect(result.ok).toBe(true);
  return result;
}

async function expectNoCleanupFailures(promise: Promise<unknown>, label: string) {
  const result = requireRecord(await promise, label);
  expect(result.failures).toEqual([]);
  return result;
}

function extensionNamespace(entry: Record<string, unknown>, pluginId: string, namespace: string) {
  const extensions = requireRecord(entry.pluginExtensions, "plugin extensions");
  const pluginExtensions = requireRecord(extensions[pluginId], `${pluginId} extensions`);
  return requireRecord(pluginExtensions[namespace], `${pluginId}.${namespace} state`);
}

describe("plugin session extension SessionEntry projection", () => {
  beforeEach(() => {
    setActivePluginRegistry(createEmptyPluginRegistry());
    clearPluginHostRuntimeState();
  });

  afterEach(() => {
    setActivePluginRegistry(createEmptyPluginRegistry());
    clearPluginHostRuntimeState();
  });

  it("mirrors projected values to SessionEntry[slotKey] and clears them on unset", async () => {
    const { config, registry } = createPluginRegistryFixture();
    registerTestPlugin({
      registry,
      config,
      record: createPluginRecord({ id: "promoted-plugin", name: "Promoted" }),
      register(api) {
        api.registerSessionExtension({
          namespace: "workflow",
          description: "promoted workflow",
          sessionEntrySlotKey: "approvalSnapshot",
          sessionEntrySlotSchema: { type: "object" },
          project: (ctx) => {
            if (!ctx.state || typeof ctx.state !== "object" || Array.isArray(ctx.state)) {
              return undefined;
            }
            const state = ctx.state as Record<string, PluginJsonValue>;
            return { state: state.state ?? null, title: state.title ?? null };
          },
        });
      },
    });
    setActivePluginRegistry(registry.registry);

    const stateDir = await fs.mkdtemp(
      path.join(resolvePreferredOpenClawTmpDir(), "openclaw-host-hooks-slot-"),
    );
    const storePath = path.join(stateDir, "sessions.json");
    const tempConfig = { session: { store: storePath } };
    const previousStateDir = process.env.OPENCLAW_STATE_DIR;
    try {
      process.env.OPENCLAW_STATE_DIR = stateDir;
      await withTempConfig({
        cfg: tempConfig,
        run: async () => {
          await updateSessionStore(storePath, (store) => {
            store["agent:main:main"] = {
              sessionId: "session-id",
              updatedAt: Date.now(),
            } as unknown as SessionEntry;
          });

          const patchResult = await patchPluginSessionExtension({
            cfg: tempConfig as never,
            sessionKey: "agent:main:main",
            pluginId: "promoted-plugin",
            namespace: "workflow",
            value: { state: "executing", title: "Deploy approval", internal: 7 },
          });
          expect(patchResult.ok).toBe(true);
          const afterPatch = loadSessionStore(storePath, { skipCache: true });
          expect(
            (afterPatch["agent:main:main"] as unknown as Record<string, unknown>).approvalSnapshot,
          ).toEqual({ state: "executing", title: "Deploy approval" });

          const unsetResult = await patchPluginSessionExtension({
            cfg: tempConfig as never,
            sessionKey: "agent:main:main",
            pluginId: "promoted-plugin",
            namespace: "workflow",
            unset: true,
          });
          expect(unsetResult.ok).toBe(true);
          const afterUnset = loadSessionStore(storePath, { skipCache: true });
          expect(
            (afterUnset["agent:main:main"] as unknown as Record<string, unknown>).approvalSnapshot,
          ).toBeUndefined();
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

  it("clears promoted SessionEntry slots when projectors fail", async () => {
    const { config, registry } = createPluginRegistryFixture();
    registerTestPlugin({
      registry,
      config,
      record: createPluginRecord({ id: "failing-promoted-plugin", name: "Failing" }),
      register(api) {
        api.registerSessionExtension({
          namespace: "workflow",
          description: "promoted workflow",
          sessionEntrySlotKey: "approvalSnapshot",
          sessionEntrySlotSchema: { type: "object" },
          project: (ctx) => {
            const state = ctx.state as Record<string, PluginJsonValue>;
            if (state.fail === "throw") {
              throw new Error("projection failed");
            }
            if (state.fail === "promise") {
              return Promise.resolve({ state: "async" }) as never;
            }
            return { state: state.state ?? null };
          },
        });
      },
    });
    setActivePluginRegistry(registry.registry);

    const stateDir = await fs.mkdtemp(
      path.join(resolvePreferredOpenClawTmpDir(), "openclaw-host-hooks-slot-projector-fail-"),
    );
    const storePath = path.join(stateDir, "sessions.json");
    const tempConfig = { session: { store: storePath } };
    const previousStateDir = process.env.OPENCLAW_STATE_DIR;
    try {
      process.env.OPENCLAW_STATE_DIR = stateDir;
      await withTempConfig({
        cfg: tempConfig,
        run: async () => {
          await updateSessionStore(storePath, (store) => {
            store["agent:main:main"] = {
              sessionId: "session-id",
              updatedAt: Date.now(),
            } as unknown as SessionEntry;
          });

          await expectOkResult(
            patchPluginSessionExtension({
              cfg: tempConfig as never,
              sessionKey: "agent:main:main",
              pluginId: "failing-promoted-plugin",
              namespace: "workflow",
              value: { state: "ready" },
            }),
            "ready patch result",
          );
          expect(
            (
              loadSessionStore(storePath, { skipCache: true })[
                "agent:main:main"
              ] as unknown as Record<string, unknown>
            ).approvalSnapshot,
          ).toEqual({ state: "ready" });

          await expectOkResult(
            patchPluginSessionExtension({
              cfg: tempConfig as never,
              sessionKey: "agent:main:main",
              pluginId: "failing-promoted-plugin",
              namespace: "workflow",
              value: { state: "bad", fail: "throw" },
            }),
            "throwing projector patch result",
          );
          const afterThrow = loadSessionStore(storePath, { skipCache: true })[
            "agent:main:main"
          ] as unknown as Record<string, unknown>;
          expect(afterThrow.approvalSnapshot).toBeUndefined();
          expect(extensionNamespace(afterThrow, "failing-promoted-plugin", "workflow")).toEqual({
            state: "bad",
            fail: "throw",
          });

          await expectOkResult(
            patchPluginSessionExtension({
              cfg: tempConfig as never,
              sessionKey: "agent:main:main",
              pluginId: "failing-promoted-plugin",
              namespace: "workflow",
              value: { state: "ready-again" },
            }),
            "ready-again patch result",
          );
          expect(
            (
              loadSessionStore(storePath, { skipCache: true })[
                "agent:main:main"
              ] as unknown as Record<string, unknown>
            ).approvalSnapshot,
          ).toEqual({ state: "ready-again" });

          await expectOkResult(
            patchPluginSessionExtension({
              cfg: tempConfig as never,
              sessionKey: "agent:main:main",
              pluginId: "failing-promoted-plugin",
              namespace: "workflow",
              value: { state: "async-bad", fail: "promise" },
            }),
            "promise projector patch result",
          );
          const afterPromise = loadSessionStore(storePath, { skipCache: true })[
            "agent:main:main"
          ] as unknown as Record<string, unknown>;
          expect(afterPromise.approvalSnapshot).toBeUndefined();
          expect(extensionNamespace(afterPromise, "failing-promoted-plugin", "workflow")).toEqual({
            state: "async-bad",
            fail: "promise",
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

  it("rejects sessionEntrySlotKey values that collide with SessionEntry fields", () => {
    const { config, registry } = createPluginRegistryFixture();
    registerTestPlugin({
      registry,
      config,
      record: createPluginRecord({ id: "slot-collision", name: "Slot Collision" }),
      register(api) {
        api.registerSessionExtension({
          namespace: "workflow",
          description: "bad slot",
          sessionEntrySlotKey: "updatedAt",
        });
        api.registerSessionExtension({
          namespace: "recovery",
          description: "bad fresh-main slot",
          sessionEntrySlotKey: "subagentRecovery",
        });
      },
    });

    expect(registry.registry.sessionExtensions ?? []).toHaveLength(0);
    expect(
      registry.registry.diagnostics.map(({ pluginId, message }) => ({ pluginId, message })),
    ).toContainEqual({
      pluginId: "slot-collision",
      message: "sessionEntrySlotKey is reserved by SessionEntry: updatedAt",
    });
    expect(
      registry.registry.diagnostics.map(({ pluginId, message }) => ({ pluginId, message })),
    ).toContainEqual({
      pluginId: "slot-collision",
      message: "sessionEntrySlotKey is reserved by SessionEntry: subagentRecovery",
    });
  });

  it("rejects sessionEntrySlotKey values inherited from Object.prototype", () => {
    const { config, registry } = createPluginRegistryFixture();
    registerTestPlugin({
      registry,
      config,
      record: createPluginRecord({ id: "object-slot-collision", name: "Object Slot Collision" }),
      register(api) {
        api.registerSessionExtension({
          namespace: "to-string",
          description: "bad object slot",
          sessionEntrySlotKey: "toString",
        });
        api.registerSessionExtension({
          namespace: "has-own",
          description: "bad object slot",
          sessionEntrySlotKey: "hasOwnProperty",
        });
        api.registerSessionExtension({
          namespace: "value-of",
          description: "bad object slot",
          sessionEntrySlotKey: "valueOf",
        });
      },
    });

    expect(registry.registry.sessionExtensions ?? []).toHaveLength(0);
    const diagnostics = registry.registry.diagnostics.map(({ pluginId, message }) => ({
      pluginId,
      message,
    }));
    expect(diagnostics).toContainEqual({
      pluginId: "object-slot-collision",
      message: "sessionEntrySlotKey is reserved by Object: toString",
    });
    expect(diagnostics).toContainEqual({
      pluginId: "object-slot-collision",
      message: "sessionEntrySlotKey is reserved by Object: hasOwnProperty",
    });
    expect(diagnostics).toContainEqual({
      pluginId: "object-slot-collision",
      message: "sessionEntrySlotKey is reserved by Object: valueOf",
    });
  });

  it("rejects duplicate promoted SessionEntry slot keys across registrations", () => {
    const { config, registry } = createPluginRegistryFixture();
    registerTestPlugin({
      registry,
      config,
      record: createPluginRecord({ id: "slot-owner", name: "Slot Owner" }),
      register(api) {
        api.registerSessionExtension({
          namespace: "workflow",
          description: "first promoted slot",
          sessionEntrySlotKey: "approvalSnapshot",
        });
        api.registerSessionExtension({
          namespace: "recovery",
          description: "same plugin duplicate slot",
          sessionEntrySlotKey: " approvalSnapshot ",
        });
      },
    });
    registerTestPlugin({
      registry,
      config,
      record: createPluginRecord({ id: "slot-colliding-plugin", name: "Slot Colliding" }),
      register(api) {
        api.registerSessionExtension({
          namespace: "workflow",
          description: "cross-plugin duplicate slot",
          sessionEntrySlotKey: "approvalSnapshot",
        });
      },
    });

    expect(registry.registry.sessionExtensions ?? []).toHaveLength(1);
    expect(registry.registry.sessionExtensions?.[0]?.extension.sessionEntrySlotKey).toBe(
      "approvalSnapshot",
    );
    const diagnostics = registry.registry.diagnostics.map(({ pluginId, message }) => ({
      pluginId,
      message,
    }));
    expect(diagnostics).toContainEqual({
      pluginId: "slot-owner",
      message: "sessionEntrySlotKey already registered: approvalSnapshot",
    });
    expect(diagnostics).toContainEqual({
      pluginId: "slot-colliding-plugin",
      message: "sessionEntrySlotKey already registered: approvalSnapshot",
    });
  });

  it("clears promoted SessionEntry slots with plugin-owned session state", async () => {
    const { config, registry } = createPluginRegistryFixture();
    registerTestPlugin({
      registry,
      config,
      record: createPluginRecord({ id: "cleanup-promoted-plugin", name: "Cleanup" }),
      register(api) {
        api.registerSessionExtension({
          namespace: "workflow",
          description: "promoted workflow",
          sessionEntrySlotKey: "approvalSnapshot",
        });
      },
    });
    setActivePluginRegistry(registry.registry);

    const stateDir = await fs.mkdtemp(
      path.join(resolvePreferredOpenClawTmpDir(), "openclaw-host-hooks-slot-cleanup-"),
    );
    const storePath = path.join(stateDir, "sessions.json");
    const tempConfig = { session: { store: storePath } };
    const previousStateDir = process.env.OPENCLAW_STATE_DIR;
    try {
      process.env.OPENCLAW_STATE_DIR = stateDir;
      await withTempConfig({
        cfg: tempConfig,
        run: async () => {
          await updateSessionStore(storePath, (store) => {
            store["agent:main:main"] = {
              sessionId: "session-id",
              updatedAt: Date.now(),
            } as unknown as SessionEntry;
          });
          await expectOkResult(
            patchPluginSessionExtension({
              cfg: tempConfig as never,
              sessionKey: "agent:main:main",
              pluginId: "cleanup-promoted-plugin",
              namespace: "workflow",
              value: { state: "waiting" },
            }),
            "cleanup patch result",
          );

          await expectNoCleanupFailures(
            runPluginHostCleanup({
              cfg: tempConfig as never,
              registry: registry.registry,
              pluginId: "cleanup-promoted-plugin",
              reason: "delete",
            }),
            "cleanup result",
          );

          const stored = loadSessionStore(storePath, { skipCache: true });
          const entry = stored["agent:main:main"] as unknown as Record<string, unknown>;
          expect(entry.pluginExtensions).toBeUndefined();
          expect(entry.approvalSnapshot).toBeUndefined();
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

  it("uses the active registry to clear promoted slots when cleanup omits registry", async () => {
    const { config, registry } = createPluginRegistryFixture();
    registerTestPlugin({
      registry,
      config,
      record: createPluginRecord({ id: "active-cleanup-promoted-plugin", name: "Cleanup" }),
      register(api) {
        api.registerSessionExtension({
          namespace: "workflow",
          description: "promoted workflow",
          sessionEntrySlotKey: "approvalSnapshot",
        });
      },
    });
    setActivePluginRegistry(registry.registry);

    const stateDir = await fs.mkdtemp(
      path.join(resolvePreferredOpenClawTmpDir(), "openclaw-host-hooks-slot-active-cleanup-"),
    );
    const storePath = path.join(stateDir, "sessions.json");
    const tempConfig = { session: { store: storePath } };
    const previousStateDir = process.env.OPENCLAW_STATE_DIR;
    try {
      process.env.OPENCLAW_STATE_DIR = stateDir;
      await withTempConfig({
        cfg: tempConfig,
        run: async () => {
          await updateSessionStore(storePath, (store) => {
            store["agent:main:main"] = {
              sessionId: "session-id",
              updatedAt: Date.now(),
            } as unknown as SessionEntry;
          });
          await expectOkResult(
            patchPluginSessionExtension({
              cfg: tempConfig as never,
              sessionKey: "agent:main:main",
              pluginId: "active-cleanup-promoted-plugin",
              namespace: "workflow",
              value: { state: "waiting" },
            }),
            "active cleanup patch result",
          );

          await expectNoCleanupFailures(
            runPluginHostCleanup({
              cfg: tempConfig as never,
              pluginId: "active-cleanup-promoted-plugin",
              reason: "delete",
            }),
            "active cleanup result",
          );

          const stored = loadSessionStore(storePath, { skipCache: true });
          const entry = stored["agent:main:main"] as unknown as Record<string, unknown>;
          expect(entry.pluginExtensions).toBeUndefined();
          expect(entry.approvalSnapshot).toBeUndefined();
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

  it("clears stale promoted SessionEntry slots on plugin restart without deleting extension state", async () => {
    const previousFixture = createPluginRegistryFixture();
    registerTestPlugin({
      registry: previousFixture.registry,
      config: previousFixture.config,
      record: createPluginRecord({ id: "restart-promoted-plugin", name: "Restart" }),
      register(api) {
        api.registerSessionExtension({
          namespace: "workflow",
          description: "promoted workflow",
          sessionEntrySlotKey: "approvalSnapshot",
        });
      },
    });
    const nextFixture = createPluginRegistryFixture();
    registerTestPlugin({
      registry: nextFixture.registry,
      config: nextFixture.config,
      record: createPluginRecord({ id: "restart-promoted-plugin", name: "Restart" }),
      register(api) {
        api.registerSessionExtension({
          namespace: "workflow",
          description: "promoted workflow",
        });
      },
    });
    setActivePluginRegistry(previousFixture.registry.registry);

    const stateDir = await fs.mkdtemp(
      path.join(resolvePreferredOpenClawTmpDir(), "openclaw-host-hooks-slot-restart-cleanup-"),
    );
    const storePath = path.join(stateDir, "sessions.json");
    const tempConfig = { session: { store: storePath } };
    const previousStateDir = process.env.OPENCLAW_STATE_DIR;
    try {
      process.env.OPENCLAW_STATE_DIR = stateDir;
      await withTempConfig({
        cfg: tempConfig,
        run: async () => {
          await updateSessionStore(storePath, (store) => {
            store["agent:main:main"] = {
              sessionId: "session-id",
              updatedAt: Date.now(),
            } as unknown as SessionEntry;
          });
          await expectOkResult(
            patchPluginSessionExtension({
              cfg: tempConfig as never,
              sessionKey: "agent:main:main",
              pluginId: "restart-promoted-plugin",
              namespace: "workflow",
              value: { state: "waiting" },
            }),
            "restart patch result",
          );

          await expectNoCleanupFailures(
            cleanupReplacedPluginHostRegistry({
              cfg: tempConfig as never,
              previousRegistry: previousFixture.registry.registry,
              nextRegistry: nextFixture.registry.registry,
            }),
            "restart cleanup result",
          );

          const stored = loadSessionStore(storePath, { skipCache: true });
          const entry = stored["agent:main:main"] as unknown as Record<string, unknown>;
          expect(entry.approvalSnapshot).toBeUndefined();
          expect(entry.pluginExtensionSlotKeys).toBeUndefined();
          expect(entry.pluginExtensions).toEqual({
            "restart-promoted-plugin": {
              workflow: { state: "waiting" },
            },
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

  it("clears only stale promoted SessionEntry slots on mixed plugin restart", async () => {
    const previousFixture = createPluginRegistryFixture();
    registerTestPlugin({
      registry: previousFixture.registry,
      config: previousFixture.config,
      record: createPluginRecord({ id: "restart-mixed-plugin", name: "Restart" }),
      register(api) {
        api.registerSessionExtension({
          namespace: "workflow",
          description: "promoted workflow",
          sessionEntrySlotKey: "approvalSnapshot",
        });
        api.registerSessionExtension({
          namespace: "legacy",
          description: "legacy promoted workflow",
          sessionEntrySlotKey: "legacyApprovalSnapshot",
        });
      },
    });
    const nextFixture = createPluginRegistryFixture();
    registerTestPlugin({
      registry: nextFixture.registry,
      config: nextFixture.config,
      record: createPluginRecord({ id: "restart-mixed-plugin", name: "Restart" }),
      register(api) {
        api.registerSessionExtension({
          namespace: "workflow",
          description: "promoted workflow",
          sessionEntrySlotKey: "approvalSnapshot",
        });
        api.registerSessionExtension({
          namespace: "legacy",
          description: "legacy workflow",
        });
      },
    });
    setActivePluginRegistry(previousFixture.registry.registry);

    const stateDir = await fs.mkdtemp(
      path.join(resolvePreferredOpenClawTmpDir(), "openclaw-host-hooks-slot-restart-mixed-"),
    );
    const storePath = path.join(stateDir, "sessions.json");
    const tempConfig = { session: { store: storePath } };
    const previousStateDir = process.env.OPENCLAW_STATE_DIR;
    try {
      process.env.OPENCLAW_STATE_DIR = stateDir;
      await withTempConfig({
        cfg: tempConfig,
        run: async () => {
          await updateSessionStore(storePath, (store) => {
            store["agent:main:main"] = {
              sessionId: "session-id",
              updatedAt: Date.now(),
            } as unknown as SessionEntry;
          });
          await expectOkResult(
            patchPluginSessionExtension({
              cfg: tempConfig as never,
              sessionKey: "agent:main:main",
              pluginId: "restart-mixed-plugin",
              namespace: "workflow",
              value: { state: "waiting" },
            }),
            "mixed restart workflow patch result",
          );
          await expectOkResult(
            patchPluginSessionExtension({
              cfg: tempConfig as never,
              sessionKey: "agent:main:main",
              pluginId: "restart-mixed-plugin",
              namespace: "legacy",
              value: { state: "legacy" },
            }),
            "mixed restart legacy patch result",
          );

          await expectNoCleanupFailures(
            cleanupReplacedPluginHostRegistry({
              cfg: tempConfig as never,
              previousRegistry: previousFixture.registry.registry,
              nextRegistry: nextFixture.registry.registry,
            }),
            "mixed restart cleanup result",
          );

          const stored = loadSessionStore(storePath, { skipCache: true });
          const entry = stored["agent:main:main"] as unknown as Record<string, unknown>;
          expect(entry.approvalSnapshot).toEqual({ state: "waiting" });
          expect(entry.legacyApprovalSnapshot).toBeUndefined();
          expect(entry.pluginExtensionSlotKeys).toEqual({
            "restart-mixed-plugin": {
              workflow: "approvalSnapshot",
            },
          });
          expect(entry.pluginExtensions).toEqual({
            "restart-mixed-plugin": {
              workflow: { state: "waiting" },
              legacy: { state: "legacy" },
            },
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

  it("preserves promoted SessionEntry slots on plugin restart when the slot is still declared", async () => {
    const previousFixture = createPluginRegistryFixture();
    registerTestPlugin({
      registry: previousFixture.registry,
      config: previousFixture.config,
      record: createPluginRecord({ id: "restart-preserved-plugin", name: "Restart" }),
      register(api) {
        api.registerSessionExtension({
          namespace: "workflow",
          description: "promoted workflow",
          sessionEntrySlotKey: "approvalSnapshot",
        });
      },
    });
    const nextFixture = createPluginRegistryFixture();
    registerTestPlugin({
      registry: nextFixture.registry,
      config: nextFixture.config,
      record: createPluginRecord({ id: "restart-preserved-plugin", name: "Restart" }),
      register(api) {
        api.registerSessionExtension({
          namespace: "workflow",
          description: "promoted workflow",
          sessionEntrySlotKey: "approvalSnapshot",
        });
      },
    });
    setActivePluginRegistry(previousFixture.registry.registry);

    const stateDir = await fs.mkdtemp(
      path.join(resolvePreferredOpenClawTmpDir(), "openclaw-host-hooks-slot-restart-preserve-"),
    );
    const storePath = path.join(stateDir, "sessions.json");
    const tempConfig = { session: { store: storePath } };
    const previousStateDir = process.env.OPENCLAW_STATE_DIR;
    try {
      process.env.OPENCLAW_STATE_DIR = stateDir;
      await withTempConfig({
        cfg: tempConfig,
        run: async () => {
          await updateSessionStore(storePath, (store) => {
            store["agent:main:main"] = {
              sessionId: "session-id",
              updatedAt: Date.now(),
            } as unknown as SessionEntry;
          });
          await expectOkResult(
            patchPluginSessionExtension({
              cfg: tempConfig as never,
              sessionKey: "agent:main:main",
              pluginId: "restart-preserved-plugin",
              namespace: "workflow",
              value: { state: "waiting" },
            }),
            "preserved restart patch result",
          );

          await expectNoCleanupFailures(
            cleanupReplacedPluginHostRegistry({
              cfg: tempConfig as never,
              previousRegistry: previousFixture.registry.registry,
              nextRegistry: nextFixture.registry.registry,
            }),
            "preserved restart cleanup result",
          );

          const stored = loadSessionStore(storePath, { skipCache: true });
          const entry = stored["agent:main:main"] as unknown as Record<string, unknown>;
          expect(entry.approvalSnapshot).toEqual({ state: "waiting" });
          expect(entry.pluginExtensionSlotKeys).toEqual({
            "restart-preserved-plugin": {
              workflow: "approvalSnapshot",
            },
          });
          expect(entry.pluginExtensions).toEqual({
            "restart-preserved-plugin": {
              workflow: { state: "waiting" },
            },
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

  it("clears persisted promoted slots when registry metadata is unavailable", async () => {
    setActivePluginRegistry(createEmptyPluginRegistry());
    const stateDir = await fs.mkdtemp(
      path.join(resolvePreferredOpenClawTmpDir(), "openclaw-host-hooks-slot-metadata-cleanup-"),
    );
    const storePath = path.join(stateDir, "sessions.json");
    const tempConfig = { session: { store: storePath } };
    const previousStateDir = process.env.OPENCLAW_STATE_DIR;
    try {
      process.env.OPENCLAW_STATE_DIR = stateDir;
      await withTempConfig({
        cfg: tempConfig,
        run: async () => {
          await updateSessionStore(storePath, (store) => {
            store["agent:main:main"] = {
              sessionId: "session-id",
              updatedAt: Date.now(),
              pluginExtensions: {
                "removed-promoted-plugin": {
                  workflow: { state: "stale" },
                },
              },
              pluginExtensionSlotKeys: {
                "removed-promoted-plugin": {
                  workflow: "approvalSnapshot",
                },
              },
              approvalSnapshot: { state: "stale" },
            } as unknown as SessionEntry;
          });

          await expectNoCleanupFailures(
            runPluginHostCleanup({
              cfg: tempConfig as never,
              pluginId: "removed-promoted-plugin",
              reason: "delete",
            }),
            "metadata cleanup result",
          );

          const stored = loadSessionStore(storePath, { skipCache: true });
          const entry = stored["agent:main:main"] as unknown as Record<string, unknown>;
          expect(entry.approvalSnapshot).toBeUndefined();
          expect(entry.pluginExtensionSlotKeys).toBeUndefined();
          expect(entry.pluginExtensions).toBeUndefined();
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

  it("exposes scoped session extension reads to trusted tool policies", async () => {
    const seen: unknown[] = [];
    const seenConfig: unknown[] = [];
    const { config, registry } = createPluginRegistryFixture();
    registerTestPlugin({
      registry,
      config,
      record: createPluginRecord({
        id: "policy-plugin",
        name: "Policy Plugin",
        origin: "bundled",
      }),
      register(api) {
        api.registerSessionExtension({
          namespace: "policy",
          description: "policy state",
        });
        api.registerSessionExtension({
          namespace: "second",
          description: "second policy state",
        });
        api.registerTrustedToolPolicy({
          id: "inspect-session-state",
          description: "inspect session extension",
          evaluate(_event, ctx) {
            seen.push(ctx.getSessionExtension?.("policy"));
            seen.push(ctx.getSessionExtension?.("second"));
            seen.push(ctx.getSessionExtension?.("missing"));
            seenConfig.push((ctx as { config?: unknown }).config);
            return undefined;
          },
        });
      },
    });
    setActivePluginRegistry(registry.registry);

    const stateDir = await fs.mkdtemp(
      path.join(resolvePreferredOpenClawTmpDir(), "openclaw-host-hooks-policy-read-"),
    );
    const storePath = path.join(stateDir, "sessions.json");
    const tempConfig = { session: { store: storePath } };
    const previousStateDir = process.env.OPENCLAW_STATE_DIR;
    try {
      process.env.OPENCLAW_STATE_DIR = stateDir;
      await withTempConfig({
        cfg: tempConfig,
        run: async () => {
          await updateSessionStore(storePath, (store) => {
            store["agent:main:main"] = {
              sessionId: "session-id",
              updatedAt: Date.now(),
            } as unknown as SessionEntry;
          });
          await expectOkResult(
            patchPluginSessionExtension({
              cfg: tempConfig as never,
              sessionKey: "agent:main:main",
              pluginId: "policy-plugin",
              namespace: "policy",
              value: { gate: "open" },
            }),
            "policy patch result",
          );
          await expectOkResult(
            patchPluginSessionExtension({
              cfg: tempConfig as never,
              sessionKey: "agent:main:main",
              pluginId: "policy-plugin",
              namespace: "second",
              value: { gate: "second" },
            }),
            "second policy patch result",
          );

          await expect(
            runTrustedToolPolicies(
              { toolName: "apply_patch", params: {} },
              {
                toolName: "apply_patch",
                sessionKey: "agent:main:main",
              },
              { config: tempConfig as never },
            ),
          ).resolves.toBeUndefined();

          await expect(
            runTrustedToolPolicies(
              { toolName: "apply_patch", params: {} },
              {
                toolName: "apply_patch",
                sessionKey: "agent:main:main",
              },
            ),
          ).resolves.toBeUndefined();
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

    expect(seen).toEqual([
      { gate: "open" },
      { gate: "second" },
      undefined,
      { gate: "open" },
      { gate: "second" },
      undefined,
    ]);
    expect(seenConfig).toEqual([undefined, undefined]);
  });

  it("does not touch top-level SessionEntry slots when sessionEntrySlotKey is omitted", async () => {
    const { config, registry } = createPluginRegistryFixture();
    registerTestPlugin({
      registry,
      config,
      record: createPluginRecord({ id: "non-promoted-plugin", name: "Non" }),
      register(api) {
        api.registerSessionExtension({
          namespace: "workflow",
          description: "non-promoted workflow",
        });
      },
    });
    setActivePluginRegistry(registry.registry);

    const stateDir = await fs.mkdtemp(
      path.join(resolvePreferredOpenClawTmpDir(), "openclaw-host-hooks-slot-noop-"),
    );
    const storePath = path.join(stateDir, "sessions.json");
    const tempConfig = { session: { store: storePath } };
    const previousStateDir = process.env.OPENCLAW_STATE_DIR;
    try {
      process.env.OPENCLAW_STATE_DIR = stateDir;
      await withTempConfig({
        cfg: tempConfig,
        run: async () => {
          await updateSessionStore(storePath, (store) => {
            store["agent:main:main"] = {
              sessionId: "session-id",
              updatedAt: Date.now(),
            } as unknown as SessionEntry;
          });
          const result = await patchPluginSessionExtension({
            cfg: tempConfig as never,
            sessionKey: "agent:main:main",
            pluginId: "non-promoted-plugin",
            namespace: "workflow",
            value: { state: "executing" },
          });
          expect(result.ok).toBe(true);
          const stored = loadSessionStore(storePath, { skipCache: true });
          const entry = stored["agent:main:main"] as unknown as Record<string, unknown>;
          expect(entry.approvalSnapshot).toBeUndefined();
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
