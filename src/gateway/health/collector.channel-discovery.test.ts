import { afterEach, describe, expect, it, vi } from "vitest";
import * as persistedAuth from "../../channels/plugins/persisted-auth-state.js";
import * as configRuntime from "../../config/config.js";
import {
  createPluginMetadataSnapshot,
  makeRegistry,
} from "../../config/plugin-auto-enable.test-helpers.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { setGatewayPluginMetadataSnapshot } from "../../plugins/current-plugin-metadata-snapshot.js";
import { clearPluginMetadataLifecycleCaches } from "../../plugins/plugin-metadata-lifecycle.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import { createPluginRecord } from "../../plugins/status.test-fixtures.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { collectGatewayHealthSnapshot } from "./collector.js";

let state: OpenClawTestState | undefined;

afterEach(async () => {
  vi.restoreAllMocks();
  resetPluginRuntimeStateForTest();
  clearPluginMetadataLifecycleCaches();
  await state?.cleanup();
  state = undefined;
});

describe("Gateway health channel discovery", () => {
  it.each(["missing", "empty"] as const)(
    "uses admitted channels and configured failures without credential discovery (%s runtime snapshot)",
    async (runtime) => {
      state = await createOpenClawTestState({ label: "health-channel-discovery" });
      const config: OpenClawConfig = {
        agents: { ownership: "explicit", entries: { main: {} } },
        channels: {
          "failed-chat": {
            accounts: { default: { enabled: true }, disabled: { enabled: false } },
          },
        },
      };
      vi.spyOn(configRuntime, "getRuntimeConfig").mockReturnValue(config);
      setGatewayPluginMetadataSnapshot(
        createPluginMetadataSnapshot({
          config,
          manifestRegistry: makeRegistry([
            {
              id: "failed-owner",
              origin: "bundled",
              channels: ["failed-chat"],
              channelConfigs: { "failed-chat": { schema: { type: "object" } } },
            },
          ]),
        }),
        { config },
      );
      const account = { accountId: "default", enabled: true, configured: true, linked: true };
      const probeAccount = vi.fn(async () => ({ ok: true }));
      const registered = createChannelTestPluginBase({
        id: "linked-chat",
        config: { resolveAccount: () => account, inspectAccount: () => account },
      });
      const registry = createTestRegistry([
        {
          pluginId: "linked-owner",
          plugin: { ...registered, status: { probeAccount } },
          source: "fixture",
        },
      ]);
      registry.plugins.push(
        createPluginRecord({
          id: "failed-owner",
          enabled: true,
          activated: true,
          status: "error",
          failurePhase: "load",
          channelIds: ["failed-chat"],
          error: "fixture channel runtime failed to load",
        }),
      );
      setActivePluginRegistry(registry);

      // The real read-only resolver must not enter this synchronous cold-loader boundary.
      vi.spyOn(persistedAuth, "listBundledChannelIdsWithPersistedAuthState").mockReturnValue([
        "dormant-chat",
      ]);
      const checkPersistedAuth = vi
        .spyOn(persistedAuth, "hasBundledChannelPersistedAuthState")
        .mockImplementation(() => {
          throw new Error("health attempted dormant credential discovery");
        });
      const snapshot = await collectGatewayHealthSnapshot({
        audience: "admin",
        probe: true,
        ...(runtime === "empty" ? { runtimeSnapshot: { channels: {}, channelAccounts: {} } } : {}),
      });

      expect(checkPersistedAuth).not.toHaveBeenCalled();
      expect(snapshot.channelOrder.toSorted()).toEqual(["failed-chat", "linked-chat"]);
      expect(snapshot.channels["linked-chat"]).toMatchObject({
        configured: true,
        linked: true,
        probe: { ok: true },
      });
      expect(probeAccount).toHaveBeenCalledOnce();
      expect(snapshot.channels["failed-chat"]?.accounts).toMatchObject({
        default: { enabled: true, configured: true, running: false, lifecycle: "blocked" },
        disabled: { enabled: false, configured: true, running: false, lifecycle: "blocked" },
      });
      expect(snapshot.plugins?.errors).toEqual([
        expect.objectContaining({
          id: "failed-owner",
          error: expect.stringContaining("failed to load"),
        }),
      ]);
    },
  );
});
