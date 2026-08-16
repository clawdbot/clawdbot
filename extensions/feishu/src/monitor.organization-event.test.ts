import {
  createInboundDebouncer,
  resolveInboundDebounceMs,
} from "openclaw/plugin-sdk/channel-inbound-debounce";
import { hasControlCommand, isControlCommandMessage } from "openclaw/plugin-sdk/command-detection";
// Feishu tests cover organization-event monitor registration behavior.
import { createNonExitingRuntimeEnv } from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import type { ClawdbotConfig, PluginRuntime } from "../runtime-api.js";
import { monitorSingleAccount } from "./monitor.account.js";
import { subscribeFeishuOrganizationEvents } from "./organization-event-bridge.js";
import type { ResolvedFeishuAccount } from "./types.js";

const createEventDispatcherMock = vi.hoisted(() => vi.fn());
const monitorWebSocketMock = vi.hoisted(() => vi.fn(async () => {}));
const monitorWebhookMock = vi.hoisted(() => vi.fn(async () => {}));
const createFeishuThreadBindingManagerMock = vi.hoisted(() => vi.fn(() => ({ stop: vi.fn() })));

vi.mock("./client.js", () => ({ createEventDispatcher: createEventDispatcherMock }));
vi.mock("./monitor.transport.js", () => ({
  monitorWebSocket: monitorWebSocketMock,
  monitorWebhook: monitorWebhookMock,
}));
vi.mock("./thread-bindings.js", () => ({
  createFeishuThreadBindingManager: createFeishuThreadBindingManagerMock,
}));

let registeredHandlers: Record<string, (data: unknown) => Promise<void>> = {};
const unsubscribeCallbacks: Array<() => void> = [];

afterEach(() => {
  for (const unsubscribe of unsubscribeCallbacks.splice(0)) {
    unsubscribe();
  }
  createEventDispatcherMock.mockReset();
  monitorWebSocketMock.mockClear();
  monitorWebhookMock.mockClear();
  createFeishuThreadBindingManagerMock.mockClear();
  registeredHandlers = {};
});

afterAll(() => {
  vi.doUnmock("./client.js");
  vi.doUnmock("./monitor.transport.js");
  vi.doUnmock("./thread-bindings.js");
  vi.resetModules();
});

function setupDispatcher() {
  createEventDispatcherMock.mockReturnValue({
    register: vi.fn((handlers: Record<string, (data: unknown) => Promise<void>>) => {
      registeredHandlers = handlers;
    }),
  });
}

async function startMonitor() {
  await monitorSingleAccount({
    cfg: { channels: { feishu: { enabled: true } } } as ClawdbotConfig,
    account: {
      accountId: "fabricos",
      enabled: true,
      configured: true,
      appId: "cli_test",
      appSecret: "secret_test", // pragma: allowlist secret
      domain: "feishu",
      config: { enabled: true, connectionMode: "websocket" },
    } as ResolvedFeishuAccount,
    channelRuntime: {
      inbound: { run: vi.fn() },
      debounce: { createInboundDebouncer, resolveInboundDebounceMs },
      commands: { isControlCommandMessage },
      text: { hasControlCommand },
    } as unknown as PluginRuntime["channel"],
    runtime: createNonExitingRuntimeEnv(),
    botOpenIdSource: { kind: "prefetched", botOpenId: "ou_bot" },
  });
}

describe("Feishu organization-event monitor registration", () => {
  it("does not register contact handlers without a subscriber", async () => {
    setupDispatcher();

    await startMonitor();

    expect(registeredHandlers).not.toHaveProperty("contact.user.updated_v3");
    expect(registeredHandlers).not.toHaveProperty("contact.department.updated_v3");
  });

  it("registers and delivers contact handlers when a subscriber exists at startup", async () => {
    const listener = vi.fn();
    unsubscribeCallbacks.push(subscribeFeishuOrganizationEvents(listener));
    setupDispatcher();

    await startMonitor();
    await registeredHandlers["contact.department.updated_v3"]?.({ event_id: "evt_department_1" });

    expect(registeredHandlers).toHaveProperty("contact.user.created_v3");
    expect(registeredHandlers).toHaveProperty("contact.department.deleted_v3");
    expect(listener).toHaveBeenCalledWith({
      accountId: "fabricos",
      eventId: "evt_department_1",
      eventType: "contact.department.updated_v3",
      data: { event_id: "evt_department_1" },
    });
  });
});
