// Feishu tests cover the organization-event bridge plugin behavior.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createFeishuOrganizationEventHandlers,
  subscribeFeishuOrganizationEvents,
  type FeishuOrganizationEventType,
} from "./organization-event-bridge.js";

const ORGANIZATION_EVENT_TYPES = [
  "contact.user.created_v3",
  "contact.user.updated_v3",
  "contact.user.deleted_v3",
  "contact.department.created_v3",
  "contact.department.updated_v3",
  "contact.department.deleted_v3",
] as const satisfies readonly FeishuOrganizationEventType[];

const unsubscribeCallbacks: Array<() => void> = [];

afterEach(() => {
  for (const unsubscribe of unsubscribeCallbacks.splice(0)) {
    unsubscribe();
  }
});

function subscribe(listener: Parameters<typeof subscribeFeishuOrganizationEvents>[0]) {
  const unsubscribe = subscribeFeishuOrganizationEvents(listener);
  unsubscribeCallbacks.push(unsubscribe);
  return unsubscribe;
}

describe("Feishu organization-event bridge", () => {
  it("does not register contact handlers without a subscriber", () => {
    expect(
      createFeishuOrganizationEventHandlers({ accountId: "default", onConsumerError: vi.fn() }),
    ).toEqual({});
  });

  it.each(ORGANIZATION_EVENT_TYPES)("delivers %s with its stable envelope", async (eventType) => {
    const listener = vi.fn();
    subscribe(listener);
    const handlers = createFeishuOrganizationEventHandlers({
      accountId: "fabricos",
      onConsumerError: vi.fn(),
    });
    const data = { event_id: `evt_${eventType}`, field: "current-value" };

    await handlers[eventType]?.(data);

    expect(listener).toHaveBeenCalledWith({
      accountId: "fabricos",
      eventId: `evt_${eventType}`,
      eventType,
      data,
    });
  });

  it("isolates a failing subscriber and continues delivery", async () => {
    const failure = new Error("consumer failed");
    const failingListener = vi.fn(async () => {
      throw failure;
    });
    const healthyListener = vi.fn();
    const onConsumerError = vi.fn();
    subscribe(failingListener);
    subscribe(healthyListener);
    const handlers = createFeishuOrganizationEventHandlers({
      accountId: "fabricos",
      onConsumerError,
    });

    await handlers["contact.user.updated_v3"]?.({ event_id: "evt_1" });

    expect(onConsumerError).toHaveBeenCalledWith(failure, "contact.user.updated_v3");
    expect(healthyListener).toHaveBeenCalledWith({
      accountId: "fabricos",
      eventId: "evt_1",
      eventType: "contact.user.updated_v3",
      data: { event_id: "evt_1" },
    });
  });

  it("removes a stopped subscriber before the next monitor registration", () => {
    const unsubscribe = subscribe(vi.fn());

    expect(
      Object.keys(
        createFeishuOrganizationEventHandlers({ accountId: "default", onConsumerError: vi.fn() }),
      ),
    ).toHaveLength(6);

    unsubscribe();

    expect(
      createFeishuOrganizationEventHandlers({ accountId: "default", onConsumerError: vi.fn() }),
    ).toEqual({});
  });
});
