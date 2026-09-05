import { describe, expect, it, vi } from "vitest";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createGatewayAuxHandlers } from "./server-aux-handlers.js";
import { GATEWAY_AUX_METHODS } from "./server-aux-methods.js";

describe("aux method handler parity", () => {
  it("exposes a handler for every advertised aux method", async () => {
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
      for (const method of GATEWAY_AUX_METHODS) {
        // Advertising a method without a handler yields runtime "unknown method"
        // errors that only surface live; keep the list and the map in lockstep.
        expect(aux.extraHandlers[method], method).toBeDefined();
      }
    } finally {
      await aux.stopOperatorInteractions();
      await fixture.cleanup();
    }
  });
});
