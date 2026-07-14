import type { PersistedWorkboardNotificationSubscription } from "./persistence-types.js";
import {
  cardRunId,
  cardSessionKey,
  compareNotifications,
  notificationSequence,
} from "./store-card-helpers.js";
import type {
  WorkboardNotificationEventsInput,
  WorkboardNotificationListOptions,
  WorkboardNotificationSubscribeInput,
} from "./store-inputs.js";
import {
  normalizeBoardId,
  normalizeBoundedString,
  normalizeNotificationSubscription,
} from "./store-normalizers.js";
import { WorkboardWorkflowStore } from "./store-workflow.js";
import type { WorkboardNotification, WorkboardNotificationSubscription } from "./types.js";

export class WorkboardNotificationStore extends WorkboardWorkflowStore {
  async subscribeNotifications(
    input: WorkboardNotificationSubscribeInput,
  ): Promise<WorkboardNotificationSubscription> {
    return await this.enqueueMutation(async () => {
      const subscription = normalizeNotificationSubscription(input);
      await this.subscriptionStore.register(subscription.id, { version: 1, subscription });
      return subscription;
    });
  }

  async listNotificationSubscriptions(
    input: WorkboardNotificationListOptions = {},
  ): Promise<{ subscriptions: WorkboardNotificationSubscription[] }> {
    const boardId = normalizeBoardId(input.boardId);
    const cardId = normalizeBoundedString(input.cardId, undefined, 120, "card id");
    const subscriptions = (await this.subscriptionStore.entries())
      .map((entry) => entry.value)
      .filter(
        (entry): entry is PersistedWorkboardNotificationSubscription =>
          entry?.version === 1 && Boolean(entry.subscription?.id),
      )
      .map((entry) => entry.subscription)
      .filter((subscription) => !boardId || subscription.boardId === boardId)
      .filter((subscription) => !cardId || subscription.cardId === cardId)
      .toSorted((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
    return { subscriptions };
  }

  async deleteNotificationSubscription(id: string): Promise<{ deleted: boolean }> {
    return { deleted: await this.subscriptionStore.delete(id.trim()) };
  }

  private async collectNotificationEvents(input: WorkboardNotificationEventsInput = {}): Promise<{
    subscription?: WorkboardNotificationSubscription;
    events: WorkboardNotification[];
  }> {
    const subscriptionId = normalizeBoundedString(
      input.subscriptionId,
      undefined,
      120,
      "subscription id",
    );
    const boardId = normalizeBoardId(input.boardId);
    const cardId = normalizeBoundedString(input.cardId, undefined, 120, "card id");
    const limit =
      typeof input.limit === "number" && Number.isFinite(input.limit)
        ? Math.max(1, Math.min(200, Math.trunc(input.limit)))
        : 50;
    const subscriptionEntry = subscriptionId
      ? await this.subscriptionStore.lookup(subscriptionId)
      : undefined;
    if (subscriptionId && !subscriptionEntry?.subscription) {
      throw new Error(`notification subscription not found: ${subscriptionId}`);
    }
    const subscription = subscriptionEntry?.subscription;
    const effectiveCardId = subscription?.cardId ?? cardId;
    const effectiveBoardId = effectiveCardId ? undefined : (subscription?.boardId ?? boardId);
    const effectiveSessionKey = subscription?.sessionKey;
    const effectiveRunId = subscription?.runId;
    const events: WorkboardNotification[] = [];
    for (const card of await this.list({ boardId: effectiveBoardId })) {
      if (effectiveCardId && card.id !== effectiveCardId) {
        continue;
      }
      const stale = card.metadata?.stale;
      const notifications = [
        ...(card.metadata?.notifications ?? []),
        ...(stale
          ? [
              {
                id: `stale:${card.id}:${stale.detectedAt}`,
                kind: "stale" as const,
                createdAt: stale.detectedAt,
                sequence: stale.detectedAt * 1000,
                message: stale.reason,
                ...(cardSessionKey(card) ? { sessionKey: cardSessionKey(card) } : {}),
                ...(cardRunId(card) ? { runId: cardRunId(card) } : {}),
              },
            ]
          : []),
      ];
      for (const event of notifications) {
        const eventSessionKey = event.sessionKey ?? cardSessionKey(card);
        const eventRunId = event.runId ?? cardRunId(card);
        if (effectiveSessionKey && eventSessionKey !== effectiveSessionKey) {
          continue;
        }
        if (effectiveRunId && eventRunId !== effectiveRunId) {
          continue;
        }
        if (subscription?.eventKinds?.length && !subscription.eventKinds.includes(event.kind)) {
          continue;
        }
        const eventSequence = notificationSequence(event);
        if (subscription?.lastEventSequence && eventSequence !== undefined) {
          if (
            eventSequence < subscription.lastEventSequence ||
            (eventSequence === subscription.lastEventSequence &&
              event.id <= (subscription.lastEventId ?? ""))
          ) {
            continue;
          }
        } else if (
          subscription?.lastEventAt &&
          (event.createdAt < subscription.lastEventAt ||
            (event.createdAt === subscription.lastEventAt &&
              event.id <= (subscription.lastEventId ?? "")))
        ) {
          continue;
        }
        events.push(event);
      }
    }
    const sorted = events.toSorted(compareNotifications).slice(0, limit);
    return { ...(subscription ? { subscription } : {}), events: sorted };
  }

  async notificationEvents(input: WorkboardNotificationEventsInput = {}): Promise<{
    subscription?: WorkboardNotificationSubscription;
    events: WorkboardNotification[];
  }> {
    return await this.collectNotificationEvents(input);
  }

  async advanceNotificationEvents(input: WorkboardNotificationEventsInput = {}): Promise<{
    subscription?: WorkboardNotificationSubscription;
    events: WorkboardNotification[];
  }> {
    const subscriptionId = normalizeBoundedString(
      input.subscriptionId,
      undefined,
      120,
      "subscription id",
    );
    if (!subscriptionId) {
      throw new Error("subscriptionId is required to advance notification events.");
    }
    return await this.enqueueMutation(async () => {
      const result = await this.collectNotificationEvents({ ...input, subscriptionId });
      if (!result.subscription || !result.events.length) {
        return result;
      }
      const last = result.events.at(-1)!;
      const lastSequence = notificationSequence(last);
      const subscription: WorkboardNotificationSubscription = {
        ...result.subscription,
        lastEventAt: last.createdAt,
        lastEventId: last.id,
        ...(lastSequence !== undefined ? { lastEventSequence: lastSequence } : {}),
        updatedAt: Date.now(),
      };
      delete subscription.deliveredEventIds;
      if (lastSequence === undefined) {
        delete subscription.lastEventSequence;
      }
      await this.subscriptionStore.register(subscription.id, {
        version: 1,
        subscription,
      });
      return { subscription, events: result.events };
    });
  }
}
