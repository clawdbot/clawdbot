// Feishu plugin module owns organization-event subscriptions.
import { isRecord, readStringValue } from "openclaw/plugin-sdk/string-coerce-runtime";

export const FEISHU_ORGANIZATION_EVENT_TYPES = [
  "contact.user.created_v3",
  "contact.user.updated_v3",
  "contact.user.deleted_v3",
  "contact.department.created_v3",
  "contact.department.updated_v3",
  "contact.department.deleted_v3",
] as const;

export type FeishuOrganizationEventType = (typeof FEISHU_ORGANIZATION_EVENT_TYPES)[number];

export type FeishuOrganizationEvent = {
  accountId: string;
  eventId: string;
  eventType: FeishuOrganizationEventType;
  data: unknown;
};

export type FeishuOrganizationEventListener = (
  event: FeishuOrganizationEvent,
) => void | Promise<void>;

type FeishuOrganizationEventHandlers = Partial<
  Record<FeishuOrganizationEventType, (data: unknown) => Promise<void>>
>;

const listeners = new Set<FeishuOrganizationEventListener>();

/**
 * Subscribe before the Feishu channel starts so its sole EventDispatcher can
 * opt into the six organization event handlers for the current Gateway run.
 */
export function subscribeFeishuOrganizationEvents(
  listener: FeishuOrganizationEventListener,
): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function readEventId(data: unknown): string | undefined {
  if (!isRecord(data)) {
    return undefined;
  }
  const eventId = readStringValue(data.event_id)?.trim();
  return eventId || undefined;
}

async function dispatchFeishuOrganizationEvent(params: {
  accountId: string;
  eventType: FeishuOrganizationEventType;
  data: unknown;
  onConsumerError: (cause: unknown, eventType: FeishuOrganizationEventType) => void;
}): Promise<void> {
  const eventId = readEventId(params.data);
  if (!eventId) {
    params.onConsumerError(
      new Error("Feishu organization event is missing event_id"),
      params.eventType,
    );
    return;
  }
  const event: FeishuOrganizationEvent = {
    accountId: params.accountId,
    eventId,
    eventType: params.eventType,
    data: params.data,
  };
  for (const listener of listeners) {
    try {
      await listener(event);
    } catch (cause) {
      params.onConsumerError(cause, params.eventType);
    }
  }
}

export function createFeishuOrganizationEventHandlers(params: {
  accountId: string;
  onConsumerError: (cause: unknown, eventType: FeishuOrganizationEventType) => void;
}): FeishuOrganizationEventHandlers {
  if (listeners.size === 0) {
    return {};
  }
  return Object.fromEntries(
    FEISHU_ORGANIZATION_EVENT_TYPES.map((eventType) => [
      eventType,
      async (data: unknown) => {
        await dispatchFeishuOrganizationEvent({ ...params, eventType, data });
      },
    ]),
  ) as FeishuOrganizationEventHandlers;
}
