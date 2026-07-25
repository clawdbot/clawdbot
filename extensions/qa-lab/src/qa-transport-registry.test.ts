// Qa Lab tests cover qa transport registry plugin behavior.
import { describe, expect, it, vi } from "vitest";
import { createQaBusState } from "./bus-state.js";
import {
  createQaTransportAdapter,
  normalizeQaTransportId,
  type QaTransportAdapterFactory,
  type QaTransportFactoryContext,
} from "./qa-transport-registry.js";
import type { QaTransportAdapter } from "./qa-transport.js";

function createAdapterDefinition(
  cleanup?: () => Promise<void>,
  cleanupAfterGatewayStop?: () => Promise<void>,
) {
  const state = createQaBusState();
  return {
    id: "selected",
    label: "Selected",
    accountId: "sut",
    requiredPluginIds: [],
    supportedActions: [],
    async sendInbound(input: Parameters<QaTransportAdapter["sendInbound"]>[0]) {
      return state.addInboundMessage(input);
    },
    createGatewayConfig: () => ({}),
    async waitReady() {},
    buildAgentDelivery: ({ target }: { target: string }) => ({
      channel: "selected",
      to: target,
      replyChannel: "selected",
      replyTo: target,
    }),
    async handleAction() {},
    createReportNotes: () => [],
    ...(cleanup ? { cleanup } : {}),
    ...(cleanupAfterGatewayStop ? { cleanupAfterGatewayStop } : {}),
  };
}

function createFactoryContext(
  overrides: Partial<QaTransportFactoryContext> = {},
): QaTransportFactoryContext {
  return {
    channelId: "qa-channel",
    driver: "qa-channel",
    outputDir: ".artifacts/qa-e2e/transport-contract-test",
    state: createQaBusState(),
    ...overrides,
  };
}

describe("qa transport registry", () => {
  it("rejects inherited prototype keys as unsupported transport ids", () => {
    expect(() => normalizeQaTransportId("toString")).toThrow("unsupported QA transport: toString");
    expect(() => normalizeQaTransportId("__proto__")).toThrow(
      "unsupported QA transport: __proto__",
    );
  });

  it("creates QA Channel through the default async registry", async () => {
    const created = await createQaTransportAdapter(createFactoryContext());

    expect(created.adapter.id).toBe("qa-channel");
    await created.cleanupWithoutGateway();
  });

  it("selects an injected matching factory", async () => {
    const definition = createAdapterDefinition();
    const skippedCreate = vi.fn(async () => definition);
    const selectedCreate = vi.fn(async () => definition);
    const factories: QaTransportAdapterFactory[] = [
      { id: "skipped", matches: () => false, create: skippedCreate },
      { id: "selected", matches: () => true, create: selectedCreate },
    ];
    const created = await createQaTransportAdapter(
      createFactoryContext({ channelId: "selected", driver: "live" }),
      factories,
    );

    expect(created.adapter).toMatchObject({
      id: definition.id,
      label: definition.label,
      state: expect.any(Object),
    });
    expect(skippedCreate).not.toHaveBeenCalled();
    expect(selectedCreate).toHaveBeenCalledOnce();
  });

  it("returns cleanup owned by the selected adapter", async () => {
    const cleanup = vi.fn(async () => undefined);
    const cleanupAfterGatewayStop = vi.fn(async () => undefined);
    const definition = createAdapterDefinition(cleanup, cleanupAfterGatewayStop);
    const factory: QaTransportAdapterFactory = {
      id: "cleanup",
      matches: () => true,
      async create() {
        return definition;
      },
    };
    const created = await createQaTransportAdapter(
      createFactoryContext({ channelId: "cleanup", driver: "live" }),
      [factory],
    );

    await created.cleanupBeforeGatewayStop();

    expect(cleanup).toHaveBeenCalledOnce();
    expect(cleanupAfterGatewayStop).not.toHaveBeenCalled();

    await created.cleanupAfterGatewayStop();
    await created.cleanupWithoutGateway();

    expect(cleanup).toHaveBeenCalledOnce();
    expect(cleanupAfterGatewayStop).toHaveBeenCalledOnce();
  });

  it("runs post-gateway cleanup when gateway-less pre-cleanup fails", async () => {
    const cleanup = vi.fn(async () => {
      throw new Error("pre-cleanup failed");
    });
    const cleanupAfterGatewayStop = vi.fn(async () => undefined);
    const definition = createAdapterDefinition(cleanup, cleanupAfterGatewayStop);
    const created = await createQaTransportAdapter(
      createFactoryContext({ channelId: "cleanup", driver: "live" }),
      [
        {
          id: "cleanup",
          matches: () => true,
          async create() {
            return definition;
          },
        },
      ],
    );

    await expect(created.cleanupWithoutGateway()).rejects.toThrow("pre-cleanup failed");
    expect(cleanupAfterGatewayStop).toHaveBeenCalledOnce();
  });

  it("aggregates failures from both gateway-less cleanup phases", async () => {
    const definition = createAdapterDefinition(
      async () => {
        throw new Error("pre-cleanup failed");
      },
      async () => {
        throw new Error("post-cleanup failed");
      },
    );
    const created = await createQaTransportAdapter(
      createFactoryContext({ channelId: "cleanup", driver: "live" }),
      [
        {
          id: "cleanup",
          matches: () => true,
          async create() {
            return definition;
          },
        },
      ],
    );

    const cleanupError = await created.cleanupWithoutGateway().catch((error: unknown) => error);
    expect(cleanupError).toBeInstanceOf(AggregateError);
    expect((cleanupError as AggregateError).errors).toEqual([
      expect.objectContaining({ message: "pre-cleanup failed" }),
      expect.objectContaining({ message: "post-cleanup failed" }),
    ]);
  });

  it("reports no-match and startup failures with transport context", async () => {
    const context = createFactoryContext({ channelId: "missing", driver: "live" });
    await expect(createQaTransportAdapter(context, [])).rejects.toThrow(
      "no QA transport factory for live:missing",
    );

    await expect(
      createQaTransportAdapter(context, [
        {
          id: "broken",
          matches: () => true,
          async create() {
            throw new Error("provider boot failed");
          },
        },
      ]),
    ).rejects.toThrow("failed to create QA transport live:missing: provider boot failed");
  });
});
