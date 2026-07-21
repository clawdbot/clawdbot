import { describe, expect, it, vi } from "vitest";
import type { BoardSnapshot } from "../../../packages/gateway-protocol/src/index.js";
import { registerPluginDashboardCapabilities } from "../../plugins/dashboard-capabilities.js";
import { createPluginRecord } from "../../plugins/loader-records.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import {
  getActivePluginRegistry,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "../../plugins/runtime.js";
import { createPluginGatewayMethodDescriptor } from "../methods/registry.js";
import { createBoardHarness } from "./board.test-support.js";
import type { GatewayRequestHandlers } from "./types.js";

describe("board plugin capabilities", () => {
  it("routes granted bindings and actions only while their plugin registry is active", async () => {
    const previousRegistry = getActivePluginRegistry();
    const registry = createEmptyPluginRegistry();
    const readHandler = vi.fn<GatewayRequestHandlers[string]>(async ({ params, respond }) => {
      respond(true, { items: [params.filter ?? "all"] });
    });
    const actionHandler = vi.fn<GatewayRequestHandlers[string]>(async ({ params, respond }) => {
      respond(true, { refreshed: params.force });
    });
    registry.gatewayHandlers["workboard.cards.list"] = readHandler;
    registry.gatewayHandlers["workboard.cards.dispatch"] = actionHandler;
    registry.gatewayMethodDescriptors.push(
      createPluginGatewayMethodDescriptor({
        pluginId: "workboard",
        name: "workboard.cards.list",
        handler: readHandler,
        scope: "operator.read",
      }),
      createPluginGatewayMethodDescriptor({
        pluginId: "workboard",
        name: "workboard.cards.dispatch",
        handler: actionHandler,
        scope: "operator.write",
      }),
    );
    const plugin = createPluginRecord({
      id: "workboard",
      source: "workboard-stub-plugin-fixture",
      origin: "bundled",
      enabled: true,
      configSchema: false,
      dashboard: {
        dataBindings: [
          {
            id: "cards.list",
            method: "workboard.cards.list",
            description: "List fixture cards",
          },
        ],
        actionVerbs: [
          {
            id: "dispatch",
            method: "workboard.cards.dispatch",
            description: "Dispatch fixture cards",
            paramShape: {
              type: "object",
              additionalProperties: false,
              required: ["force"],
              properties: { force: { type: "boolean" } },
            },
          },
        ],
      },
    });
    registerPluginDashboardCapabilities({ record: plugin, registry });
    registry.plugins.push(plugin);
    setActivePluginRegistry(registry);

    try {
      const { invoke, store } = createBoardHarness();
      const put = await invoke("board.widget.put", {
        sessionKey: "session",
        name: "plugin-widget",
        content: { kind: "html", html: "plugin" },
        declared: { tools: ["workboard.cards.list", "workboard.dispatch"] },
      });
      expect(put.mock.calls[0]?.[1]).toMatchObject({
        widgets: [
          {
            declaredSummary: [
              "Tool access: workboard.cards.list",
              "Tool access: workboard.dispatch",
            ],
          },
        ],
      });
      await invoke("board.widget.grant", {
        sessionKey: "session",
        name: "plugin-widget",
        decision: "granted",
        revision: 1,
        instanceId: store.getSnapshot("session").widgets[0]?.instanceId,
      });
      const board = await invoke("board.get", { sessionKey: "session" });
      const snapshot = board.mock.calls[0]?.[1] as BoardSnapshot;
      const ticket = snapshot.widgets[0]?.viewTicket;

      const read = await invoke("board.data.read", {
        ticket,
        bindingId: "workboard.cards.list",
        params: { filter: "ready" },
      });
      expect(read.mock.calls[0]?.[1]).toEqual({ items: ["ready"] });
      expect(readHandler).toHaveBeenCalledOnce();

      const invalidAction = await invoke("board.action", {
        ticket,
        action: "workboard.dispatch",
        params: { force: "yes" },
      });
      expect(invalidAction.mock.calls[0]?.[0]).toBe(false);
      expect(actionHandler).not.toHaveBeenCalled();

      const action = await invoke("board.action", {
        ticket,
        action: "workboard.dispatch",
        params: { force: true },
      });
      expect(action.mock.calls[0]?.[1]).toEqual({ refreshed: true });
      expect(actionHandler).toHaveBeenCalledOnce();

      setActivePluginRegistry(createEmptyPluginRegistry());
      const unavailable = await invoke("board.data.read", {
        ticket,
        bindingId: "workboard.cards.list",
      });
      expect(unavailable.mock.calls[0]?.[0]).toBe(false);
      expect(unavailable.mock.calls[0]?.[2]?.message).toContain("not allowed");
    } finally {
      if (previousRegistry) {
        setActivePluginRegistry(previousRegistry);
      } else {
        resetPluginRuntimeStateForTest();
      }
    }
  });
});
