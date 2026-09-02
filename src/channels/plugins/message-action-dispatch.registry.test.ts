import { afterEach, describe, expect, it, vi } from "vitest";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import { withPluginRuntimeRegistryScope } from "../../plugins/runtime/gateway-request-scope.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";
import { dispatchChannelMessageAction } from "./message-action-dispatch.js";

const receipt = { content: [{ type: "text" as const, text: "delivered" }], details: { ok: true } };

afterEach(() => resetPluginRuntimeStateForTest());

describe("message action registration ownership", () => {
  it.each([true, false])(
    "uses only the selected scoped action capability (present=%s)",
    async (present) => {
      const handleRootAction = vi.fn(async () => receipt);
      const handleScopedAction = vi.fn(async () => receipt);
      const base = createChannelTestPluginBase({ id: "scoped-delivery" });
      const root = { ...base, actions: { handleAction: handleRootAction } };
      const scoped = {
        ...base,
        ...(present ? { actions: { handleAction: handleScopedAction } } : {}),
      };
      setActivePluginRegistry(
        createTestRegistry([{ pluginId: "root", source: "root", origin: "bundled", plugin: root }]),
      );
      const registry = createTestRegistry([
        { pluginId: "scoped", source: "scoped", origin: "config", plugin: scoped },
      ]);

      const result = await withPluginRuntimeRegistryScope(registry, () =>
        dispatchChannelMessageAction({
          cfg: {},
          channel: base.id,
          action: "send",
          params: { to: "recipient", message: "hello" },
        }),
      );

      expect(result).toEqual(present ? receipt : null);
      expect(handleRootAction).not.toHaveBeenCalled();
      expect(handleScopedAction).toHaveBeenCalledTimes(present ? 1 : 0);
    },
  );
  it("keeps scoped channel read authority external beside a bundled same-id registration", async () => {
    const handleRootAction = vi.fn(async () => receipt);
    const handleScopedAction = vi.fn(async () => receipt);
    const base = createChannelTestPluginBase({ id: "scoped-delivery" });
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "root",
          source: "root",
          origin: "bundled",
          plugin: {
            ...base,
            actions: { providerOwnedReadGates: true, handleAction: handleRootAction },
          },
        },
      ]),
    );
    const registry = createTestRegistry([
      {
        pluginId: "scoped",
        source: "scoped",
        origin: "config",
        plugin: {
          ...base,
          actions: { providerOwnedReadGates: true, handleAction: handleScopedAction },
        },
      },
    ]);
    const context = { cfg: {}, channel: base.id, action: "read", params: { to: "recipient" } };

    await withPluginRuntimeRegistryScope(registry, async () => {
      await expect(
        dispatchChannelMessageAction({
          ...context,
          conversationReadOrigin: "delegated",
        }),
      ).rejects.toThrow("requires the exact current conversation and account");
      expect(handleScopedAction).not.toHaveBeenCalled();
      expect(handleRootAction).not.toHaveBeenCalled();

      expect(
        await dispatchChannelMessageAction({
          ...context,
          conversationReadOrigin: "direct-operator",
        }),
      ).toBe(receipt);
      expect(
        await dispatchChannelMessageAction({
          ...context,
          conversationReadOrigin: "delegated",
          accountId: "ops",
          requesterAccountId: "ops",
          toolContext: { currentChannelProvider: base.id, currentChannelId: "recipient" },
        }),
      ).toBe(receipt);
      expect(handleScopedAction).toHaveBeenCalledTimes(2);
      expect(handleRootAction).not.toHaveBeenCalled();
    });
  });
});
