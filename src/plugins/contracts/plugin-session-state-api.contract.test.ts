import fs from "node:fs/promises";
import path from "node:path";
import {
  createPluginRegistryFixture,
  registerTestPlugin,
} from "openclaw/plugin-sdk/plugin-test-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "../../config/sessions.js";
import {
  replaceSessionEntry,
  resolveSessionEntryAccessTarget,
} from "../../config/sessions/session-accessor.js";
import { withTempConfig } from "../../gateway/test-temp-config.js";
import { resolvePreferredOpenClawTmpDir } from "../../infra/tmp-openclaw-dir.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { createEmptyPluginRegistry } from "../registry-empty.js";
import { setActivePluginRegistry, stageActivePluginRegistry } from "../runtime.js";
import { createPluginRecord } from "../status.test-fixtures.js";
import type { OpenClawPluginApi } from "../types.js";

describe("plugin session state API contract", () => {
  afterEach(() => setActivePluginRegistry(createEmptyPluginRegistry()));

  it("isolates ownership, publishes writes, and rejects retained retired APIs", async () => {
    const stateDir = await fs.mkdtemp(
      path.join(resolvePreferredOpenClawTmpDir(), "openclaw-plugin-session-state-api-"),
    );
    const storePath = path.join(stateDir, "sessions.json");
    const config = {
      agents: { entries: { main: { default: true } } },
      session: { store: storePath },
    };
    const sessionChanged = vi.fn();
    const { registry } = createPluginRegistryFixture(config, {
      hostServices: { sessionChanged },
    });
    let ownerApi: OpenClawPluginApi | undefined;
    let otherApi: OpenClawPluginApi | undefined;
    for (const [id, capture] of [
      ["owner-plugin", (api: OpenClawPluginApi) => (ownerApi = api)],
      ["other-plugin", (api: OpenClawPluginApi) => (otherApi = api)],
    ] as const) {
      registerTestPlugin({
        registry,
        config,
        record: createPluginRecord({ id, name: id }),
        register(api) {
          capture(api);
          api.session.state.registerSessionExtension({
            namespace: "workflow",
            description: `${id} workflow`,
          });
        },
      });
    }
    setActivePluginRegistry(registry.registry);
    try {
      await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () =>
        withTempConfig({
          cfg: config,
          run: async () => {
            await replaceSessionEntry({ sessionKey: "agent:main:main", storePath }, {
              sessionId: "session-id",
              updatedAt: Date.now(),
            } as SessionEntry);
            const extension = { sessionKey: "agent:main:main", namespace: "workflow" };
            expect("getSessionExtension" in (ownerApi as object)).toBe(false);
            expect("setSessionExtension" in (ownerApi as object)).toBe(false);
            expect("clearSessionExtension" in (ownerApi as object)).toBe(false);
            await expect(
              ownerApi?.session.state.setSessionExtension({
                ...extension,
                namespace: " workflow ",
                value: { checkpoint: "PR117" },
              }),
            ).resolves.toEqual({ checkpoint: "PR117" });
            expect(ownerApi?.session.state.getSessionExtension(extension)).toEqual({
              checkpoint: "PR117",
            });
            expect(otherApi?.session.state.getSessionExtension(extension)).toBeUndefined();
            expect(sessionChanged).toHaveBeenLastCalledWith({
              sessionKey: "agent:main:main",
              reason: "plugin-patch",
            });
            await expect(
              ownerApi?.session.state.clearSessionExtension(extension),
            ).resolves.toBeUndefined();
            expect(sessionChanged).toHaveBeenCalledTimes(2);

            setActivePluginRegistry(createEmptyPluginRegistry());
            expect(() => ownerApi?.session.state.getSessionExtension(extension)).toThrow(
              "plugin session state API is no longer active: owner-plugin",
            );
            await expect(
              ownerApi?.session.state.setSessionExtension({ ...extension, value: { stale: true } }),
            ).rejects.toThrow("plugin session state API is no longer active: owner-plugin");
            await expect(ownerApi?.session.state.clearSessionExtension(extension)).rejects.toThrow(
              "plugin session state API is no longer active: owner-plugin",
            );
          },
        }),
      );
    } finally {
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });

  it("rejects a retained closure during staged replacement and again at the commit edge", async () => {
    const stateDir = await fs.mkdtemp(
      path.join(resolvePreferredOpenClawTmpDir(), "openclaw-plugin-session-state-generation-"),
    );
    const storePath = path.join(stateDir, "sessions.json");
    const config = {
      agents: { entries: { main: { default: true } } },
      session: { store: storePath },
    };
    const original = createPluginRegistryFixture(config);
    const replacement = createPluginRegistryFixture(config);
    let originalApi: OpenClawPluginApi | undefined;
    let stageReplacementDuringProjection = false;
    registerTestPlugin({
      registry: original.registry,
      config,
      record: createPluginRecord({ id: "owner-plugin", name: "Owner" }),
      register(api) {
        originalApi = api;
        api.session.state.registerSessionExtension({
          namespace: "workflow",
          description: "owner workflow",
          sessionEntrySlotKey: "approvalSnapshot",
          sessionEntrySlotSchema: { type: "object" },
          project: (context) => {
            if (stageReplacementDuringProjection) {
              stageActivePluginRegistry(replacement.registry.registry, null, "default");
            }
            return context.state;
          },
        });
      },
    });
    registerTestPlugin({
      registry: replacement.registry,
      config,
      record: createPluginRecord({ id: "owner-plugin", name: "Owner replacement" }),
      register(api) {
        api.session.state.registerSessionExtension({
          namespace: "workflow",
          description: "replacement owner workflow",
        });
      },
    });
    setActivePluginRegistry(original.registry.registry);
    try {
      await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () =>
        withTempConfig({
          cfg: config,
          run: async () => {
            await replaceSessionEntry({ sessionKey: "agent:main:main", storePath }, {
              sessionId: "session-id",
              updatedAt: Date.now(),
            } as SessionEntry);
            const extension = { sessionKey: "agent:main:main", namespace: "workflow" };
            stageReplacementDuringProjection = true;
            await expect(
              originalApi?.session.state.setSessionExtension({
                ...extension,
                value: { stale: true },
              }),
            ).rejects.toThrow("plugin session state API is no longer active: owner-plugin");
            const persisted = resolveSessionEntryAccessTarget({
              cfg: config,
              sessionKey: extension.sessionKey,
            }).entry;
            expect(persisted?.pluginExtensions?.["owner-plugin"]).toBeUndefined();
            expect(
              (persisted as (SessionEntry & Record<string, unknown>) | undefined)?.approvalSnapshot,
            ).toBeUndefined();
            expect(() => originalApi?.session.state.getSessionExtension(extension)).toThrow(
              "plugin session state API is no longer active: owner-plugin",
            );
          },
        }),
      );
    } finally {
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });
});
