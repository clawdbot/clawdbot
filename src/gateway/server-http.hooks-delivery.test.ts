import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
// Hook HTTP delivery tests prove target binding before detached work is accepted.
import type { createSubsystemLogger } from "../logging/subsystem.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { createChannelTestPluginBase, createTestRegistry } from "../test-utils/channel-plugins.js";
import type { HookMappingResolved } from "./hooks-mapping.js";
import { createHooksConfig } from "./hooks-test-helpers.js";
import type { HookAgentDispatchPayload, HooksConfigResolved } from "./hooks.js";
import { createHookRequest, createResponse } from "./server-http.test-harness.js";
import { createHooksRequestHandler } from "./server/hooks-request-handler.js";

const { readJsonBodyMock } = vi.hoisted(() => ({
  readJsonBodyMock: vi.fn(),
}));
const emptyRegistry = createTestRegistry([]);
const deliveryRegistry = createTestRegistry([
  {
    pluginId: "delivery-test",
    source: "test",
    plugin: createChannelTestPluginBase({
      id: "delivery-test",
      label: "Delivery Test",
      docsPath: "/channels/delivery-test",
    }),
  },
]);

vi.mock("./hooks.js", async () => {
  const actual = await vi.importActual<typeof import("./hooks.js")>("./hooks.js");
  return {
    ...actual,
    readJsonBody: readJsonBodyMock,
  };
});

function createDeliveryHandler(params?: {
  mappings?: HookMappingResolved[];
  agentPolicy?: Partial<HooksConfigResolved["agentPolicy"]>;
}) {
  const dispatchWakeHook = vi.fn(() => ({ eventOutcome: "queued" as const }));
  const dispatchAgentHook = vi.fn((_value: HookAgentDispatchPayload) => ({
    ok: true as const,
    runId: "run-1",
    completion: Promise.resolve({ status: "ok" as const, replyDisposition: "empty" as const }),
  }));
  const canonicalConfig = createHooksConfig();
  const hooksConfig = {
    ...canonicalConfig,
    mappings: params?.mappings ?? [],
    agentPolicy: { ...canonicalConfig.agentPolicy, ...params?.agentPolicy },
  };
  const handler = createHooksRequestHandler({
    getHooksConfig: () => hooksConfig,
    bindHost: "127.0.0.1",
    port: 18789,
    logHooks: {
      warn: vi.fn(),
      debug: vi.fn(),
      info: vi.fn(),
      error: vi.fn(),
    } as unknown as ReturnType<typeof createSubsystemLogger>,
    dispatchWakeHook,
    dispatchAgentHook,
  });
  return { handler, dispatchAgentHook, dispatchWakeHook };
}

async function dispatchPayload(params: {
  handler: ReturnType<typeof createHooksRequestHandler>;
  path: string;
  payload: Record<string, unknown>;
}) {
  readJsonBodyMock.mockResolvedValueOnce({ ok: true, value: params.payload });
  const req = createHookRequest({ url: params.path });
  const response = createResponse();
  await params.handler(req, response.res);
  return response;
}

describe("hook request delivery normalization", () => {
  beforeEach(() => {
    readJsonBodyMock.mockReset();
    setActivePluginRegistry(deliveryRegistry);
  });

  afterEach(() => {
    setActivePluginRegistry(emptyRegistry);
  });

  test("binds direct delivery only to a concrete channel and recipient", async () => {
    const { handler, dispatchAgentHook } = createDeliveryHandler();

    const omitted = await dispatchPayload({
      handler,
      path: "/hooks/agent",
      payload: { message: "No coordinates" },
    });
    expect(omitted.res.statusCode).toBe(200);
    expect(dispatchAgentHook.mock.calls[0]?.[0]).toMatchObject({
      channel: "last",
      to: undefined,
      delivery: { mode: "none" },
    });

    const recipientOnly = await dispatchPayload({
      handler,
      path: "/hooks/agent",
      payload: { message: "Recipient only", to: "sensitive-recipient" },
    });
    expect(recipientOnly.res.statusCode).toBe(400);
    expect(recipientOnly.getBody()).toContain("channel and to must be set together");

    const malformedRecipient = await dispatchPayload({
      handler,
      path: "/hooks/agent",
      payload: { message: "Malformed recipient", to: 123 },
    });
    expect(malformedRecipient.res.statusCode).toBe(400);
    expect(malformedRecipient.getBody()).toContain("to must be a non-empty string");

    const channelOnly = await dispatchPayload({
      handler,
      path: "/hooks/agent",
      payload: { message: "Channel only", channel: "delivery-test" },
    });
    expect(channelOnly.res.statusCode).toBe(400);
    expect(channelOnly.getBody()).toContain("channel and to must be set together");
    expect(dispatchAgentHook).toHaveBeenCalledTimes(1);

    const optedOutChannelOnly = await dispatchPayload({
      handler,
      path: "/hooks/agent",
      payload: {
        message: "Opted out channel only",
        deliver: false,
        channel: "stale-channel",
        to: "sensitive-recipient",
      },
    });
    expect(optedOutChannelOnly.res.statusCode).toBe(200);
    expect(dispatchAgentHook.mock.calls[1]?.[0]).toMatchObject({
      deliver: false,
      channel: "last",
      to: undefined,
      delivery: { mode: "none" },
    });

    const explicit = await dispatchPayload({
      handler,
      path: "/hooks/agent",
      payload: {
        message: "Explicit",
        channel: "delivery-test",
        to: "123456",
        accountId: "work",
      },
    });
    expect(explicit.res.statusCode).toBe(200);
    expect(dispatchAgentHook.mock.calls[2]?.[0]).toMatchObject({
      accountId: "work",
      delivery: {
        mode: "announce",
        channel: "delivery-test",
        to: "123456",
        accountId: "work",
      },
    });
  });

  test("preserves mapped delivery semantics while binding the CronJob target", async () => {
    const mapped = createDeliveryHandler({
      mappings: [
        {
          id: "channel-only",
          matchPath: "channel-only",
          action: "agent",
          wakeMode: "now",
          messageTemplate: "Mapped",
          channel: "delivery-test",
        },
        {
          id: "recipient-only",
          matchPath: "recipient-only",
          action: "agent",
          wakeMode: "now",
          messageTemplate: "Mapped",
          to: "123456",
        },
      ],
    });

    const channelOnly = await dispatchPayload({
      handler: mapped.handler,
      path: "/hooks/channel-only",
      payload: {},
    });
    const recipientOnly = await dispatchPayload({
      handler: mapped.handler,
      path: "/hooks/recipient-only",
      payload: {},
    });

    expect(channelOnly.res.statusCode).toBe(200);
    expect(recipientOnly.res.statusCode).toBe(200);
    expect(mapped.dispatchAgentHook.mock.calls[0]?.[0]).toMatchObject({
      delivery: { mode: "announce", channel: "delivery-test", to: undefined },
    });
    expect(mapped.dispatchAgentHook.mock.calls[1]?.[0]).toMatchObject({
      delivery: { mode: "announce", channel: "last", to: "123456" },
    });

    const optedOut = createDeliveryHandler({
      mappings: [
        {
          id: "channel-only",
          matchPath: "channel-only",
          action: "agent",
          wakeMode: "now",
          messageTemplate: "Mapped",
          deliver: false,
          channel: "delivery-test",
        },
      ],
    });
    const optedOutResponse = await dispatchPayload({
      handler: optedOut.handler,
      path: "/hooks/channel-only",
      payload: {},
    });

    expect(optedOutResponse.res.statusCode).toBe(200);
    expect(optedOut.dispatchAgentHook).toHaveBeenCalledWith(
      expect.objectContaining({
        deliver: false,
        channel: "delivery-test",
        delivery: { mode: "none" },
      }),
    );
  });

  test.each([
    ["/hooks/agent", { message: "Direct", agentId: "  " }],
    ["/hooks/wake", { text: "Wake", agentId: "  " }],
  ])("rejects a blank direct agentId on %s without dispatch", async (path, payload) => {
    const { handler, dispatchAgentHook, dispatchWakeHook } = createDeliveryHandler();

    const response = await dispatchPayload({ handler, path, payload });

    expect(response.res.statusCode).toBe(400);
    expect(response.getBody()).toContain("agentId must be a non-empty string");
    expect(dispatchAgentHook).not.toHaveBeenCalled();
    expect(dispatchWakeHook).not.toHaveBeenCalled();
  });

  test("preserves config-mapping fallback for an unrepresentable agentId", async () => {
    const { handler, dispatchAgentHook } = createDeliveryHandler({
      mappings: [
        {
          id: "mapped-unknown-agent",
          matchPath: "mapped-unknown-agent",
          action: "agent",
          agentId: "!!!",
          messageTemplate: "Mapped fallback",
        },
      ],
    });

    const mapping = await dispatchPayload({
      handler,
      path: "/hooks/mapped-unknown-agent",
      payload: {},
    });
    expect(mapping.res.statusCode).toBe(200);
    expect(dispatchAgentHook).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "main", effectiveAgentId: "main" }),
    );
  });

  test.each([
    {
      owner: { kind: "configured" as const, agentId: "ops" },
      error: 'agentId \\"research\\" conflicts with global session-store owner \\"ops\\"',
    },
    {
      owner: { kind: "retired" as const, agentId: "retired" },
      error: 'global session-store owner \\"retired\\" is no longer configured',
    },
  ])("reports $owner.kind global session-store ownership", async ({ owner, error }) => {
    const { handler, dispatchAgentHook } = createDeliveryHandler({
      agentPolicy: {
        globalSessionStoreOwner: owner,
        knownAgentIds: new Set(["ops", "research"]),
      },
    });

    const response = await dispatchPayload({
      handler,
      path: "/hooks/agent",
      payload: { message: "Direct", agentId: "research" },
    });
    expect(response.res.statusCode).toBe(400);
    expect(response.getBody()).toContain(error);
    expect(response.getBody()).not.toContain("agentId is required");
    expect(dispatchAgentHook).not.toHaveBeenCalled();
  });
});
