import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { PluginRuntime } from "openclaw/plugin-sdk/core";
import type {
  OpenKeyedStoreOptions,
  PluginStateSyncKeyedStore,
} from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  createPluginStateSyncKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { describe, expect, it, vi } from "vitest";
import type { ClickClackClient } from "../http-client.js";
import type { ClickClackChannel } from "../types.js";
import type { ClickClackDiscussionBinding } from "./binding-store.js";
import { createHarness, testExternalRef } from "./service-test-support.js";

function legacyCreateResponse(
  input: Parameters<ClickClackClient["createChannel"]>[1],
): ClickClackChannel {
  const response: ClickClackChannel = {
    id: "chn_discussion",
    route_id: "discussion-route",
    workspace_id: "wsp_team",
    ...input,
    kind: "public",
    created_at: "2026-07-19T00:00:00.000Z",
  };
  Reflect.deleteProperty(response, "display_title");
  return response;
}

describe("ClickClack discussion state persistence", () => {
  it("persists legacy create responses through the production plugin-state store", async () => {
    resetPluginStateStoreForTests();
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-clickclack-state-"));
    const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
    const stores = new Map<string, PluginStateSyncKeyedStore<unknown>>();
    const openSyncKeyedStore = (<T>(options: OpenKeyedStoreOptions) => {
      const created = createPluginStateSyncKeyedStoreForTests<T>("clickclack", {
        ...options,
        env,
      });
      stores.set(options.namespace, created as PluginStateSyncKeyedStore<unknown>);
      return created;
    }) as PluginRuntime["state"]["openSyncKeyedStore"];

    try {
      const harness = createHarness({ label: "Persisted legacy title" }, { openSyncKeyedStore });
      const sessionKey = "agent:main:persisted-legacy-title";
      vi.mocked(harness.createChannel).mockImplementationOnce(async (_workspaceId, input) =>
        legacyCreateResponse(input),
      );

      await expect(harness.service.open(sessionKey)).resolves.toMatchObject({ state: "open" });

      const binding = stores
        .get("discussion-bindings")
        ?.lookup(sessionKey) as ClickClackDiscussionBinding;
      expect(binding).toMatchObject({ channelId: "chn_discussion" });
      expect(binding).not.toHaveProperty("displayTitle");
    } finally {
      resetPluginStateStoreForTests();
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("clears stale display title confirmation when a patch response omits the field", async () => {
    const harness = createHarness({ label: "Original title" });
    const sessionKey = "agent:main:stale-title-confirmation";
    await harness.service.open(sessionKey);
    expect(harness.store.lookup(sessionKey)).toMatchObject({ displayTitle: "Original title" });

    harness.setSessionEntry({ label: "Updated title" });
    vi.mocked(harness.updateChannel).mockImplementationOnce(async (_channelId, patch) => ({
      id: "chn_discussion",
      route_id: "discussion-route",
      workspace_id: "wsp_team",
      name: patch.name ?? "updated-title",
      kind: "public",
      external_managed: true,
      external_ref: testExternalRef(sessionKey),
      external_url: "https://control.example/control/chat/main/stale-title-confirmation",
      sidebar_section: "Sessions",
      created_at: "2026-07-19T00:00:00.000Z",
    }));

    await harness.service.reconcile(sessionKey);

    expect(harness.store.lookup(sessionKey)).not.toHaveProperty("displayTitle");
  });
});
