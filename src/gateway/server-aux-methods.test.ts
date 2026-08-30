import { describe, expect, it, vi } from "vitest";
import { createGatewayAuxHandlers } from "./server-aux-handlers.js";
import { GATEWAY_AUX_METHODS } from "./server-aux-methods.js";

describe("aux method handler parity", () => {
  it("exposes a handler for every advertised aux method", () => {
    const aux = createGatewayAuxHandlers({
      log: {},
      activateRuntimeSecrets: vi.fn(async () => undefined),
      getPluginMetadata: () => undefined,
      buildReloadPlan: vi.fn(),
      sharedGatewaySessionGenerationState: { current: undefined, required: null },
      resolveSharedGatewaySessionGenerationForConfig: () => undefined,
      clients: [],
      channelManager: {
        startChannel: async () => {},
        stopChannel: async () => {},
        isManuallyStopped: () => false,
        resolveRuntimeAccountId: (_channel: string, accountId: string) => accountId,
      },
      logChannels: { info: vi.fn() },
    } as unknown as Parameters<typeof createGatewayAuxHandlers>[0]); // SAFETY: minimal harness; parity only reads extraHandlers.
    for (const method of GATEWAY_AUX_METHODS) {
      // Advertising a method without a handler yields runtime "unknown method"
      // errors that only surface live; keep the list and the map in lockstep.
      expect(aux.extraHandlers[method], method).toBeDefined();
    }
  });
});
