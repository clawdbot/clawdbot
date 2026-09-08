import { describe, expect, it, vi } from "vitest";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { listCoreGatewayMethodNames } from "./methods/core-descriptors.js";
import { createGatewayAuxHandlers } from "./server-aux-handlers.js";
import { coreGatewayHandlers } from "./server-methods/core-handlers.js";
import type { GatewayRequestHandlers } from "./server-methods/types.js";

describe("core and auxiliary method handler parity", () => {
  it("wires a dispatchable core or auxiliary handler for every core descriptor", async () => {
    const fixture = await createOpenClawTestState({ label: "gateway-aux-methods" });
    const aux = createGatewayAuxHandlers({
      log: {},
      activateRuntimeSecrets: async () => {
        throw new Error("unexpected secrets reload");
      },
      sharedGatewaySessionGenerationState: { current: undefined, required: null },
      resolveSharedGatewaySessionGenerationForConfig: () => undefined,
      clients: [],
      channelManager: {
        startChannel: async () => new Map(),
        stopChannel: async () => {},
        isManuallyStopped: () => false,
        resolveRuntimeAccountId: (_channel: string, accountId: string) => accountId,
      },
      logChannels: { info: vi.fn() },
    });
    try {
      // Check the real construction maps, not an auxiliary exemption list.
      // Assistant media is served by the separate Control UI handler.
      const handlers: GatewayRequestHandlers = { ...coreGatewayHandlers, ...aux.extraHandlers };
      const missing = listCoreGatewayMethodNames()
        .filter((method) => method !== "assistant.media.get")
        .filter((method) => typeof handlers[method] !== "function");
      expect(missing).toEqual([]);
    } finally {
      await aux.stopOperatorInteractions();
      await fixture.cleanup();
    }
  });
});
