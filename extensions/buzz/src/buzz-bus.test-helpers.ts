import type { Event, Filter } from "nostr-tools";
import { vi } from "vitest";

export const relayMocks = {
  connect: vi.fn<() => Promise<void>>(),
  auth: vi.fn<() => Promise<string>>(),
  publish: vi.fn<(event: Event) => Promise<string>>(),
  send: vi.fn<(message: string) => Promise<void>>(),
  close: vi.fn(),
  connected: true,
  stallProfileQueryEose: false,
  stallRoomEoseChannelId: undefined as string | undefined,
  membershipEvents: [] as Event[],
  roomMetadataEvents: [] as Event[],
  profileEvents: [] as Event[],
  roomHistoryEvents: [] as Event[],
  beforeRoomHistoryEvent: undefined as ((event: Event) => void) | undefined,
  subscriptions: [] as Array<{
    filter: Filter;
    filters: Filter[];
    handlers: {
      onevent: (event: Event) => void;
      oneose?: () => void;
      onclose: (reason: string) => void;
    };
    close: ReturnType<typeof vi.fn>;
  }>,
};

export function mockBuzzRelay() {
  return {
    Relay: class {
      onauth?: (template: unknown) => Promise<unknown>;
      idleSince: number | undefined;
      ongoingOperations = 0;
      get connected() {
        return relayMocks.connected;
      }
      connect = relayMocks.connect;
      auth = relayMocks.auth;
      publish = relayMocks.publish;
      send = relayMocks.send;
      close = relayMocks.close;
      scheduleIdleClose = vi.fn();

      prepareSubscription(
        filters: Filter[],
        handlers: {
          onevent: (event: Event) => void;
          oneose?: () => void;
          onclose: (reason: string) => void;
        },
      ) {
        const filter = filters[0] ?? {};
        const close = vi.fn();
        relayMocks.subscriptions.push({ filter, filters, handlers, close });
        if (filter.kinds?.includes(39002)) {
          for (const event of relayMocks.membershipEvents) {
            handlers.onevent(event);
          }
          handlers.oneose?.();
        } else if (filter.kinds?.includes(40099) || filter.kinds?.includes(9002)) {
          const roomId = filter["#h"]?.[0];
          for (const currentFilter of filters) {
            for (const event of relayMocks.roomHistoryEvents) {
              const eventRoomId = event.tags.find((tag) => tag[0] === "h")?.[1];
              if (
                currentFilter.kinds?.includes(event.kind) &&
                currentFilter["#h"]?.includes(eventRoomId ?? "")
              ) {
                relayMocks.beforeRoomHistoryEvent?.(event);
                handlers.onevent(event);
              }
            }
          }
          if (roomId !== relayMocks.stallRoomEoseChannelId) {
            handlers.oneose?.();
          }
        } else if (filter.kinds?.includes(39000)) {
          for (const event of relayMocks.roomMetadataEvents) {
            const roomId = event.tags.find((tag) => tag[0] === "d")?.[1];
            if (!filter["#d"] || (roomId && filter["#d"]?.includes(roomId))) {
              handlers.onevent(event);
            }
          }
          handlers.oneose?.();
        } else if (filter.kinds?.includes(0)) {
          for (const event of relayMocks.profileEvents) {
            if (!filter.authors || filter.authors.includes(event.pubkey)) {
              handlers.onevent(event);
            }
          }
          const isProfileSyncQuery = filters.some((entry) => entry.kinds?.includes(10_100));
          if (!isProfileSyncQuery || !relayMocks.stallProfileQueryEose) {
            handlers.oneose?.();
          }
        }
        return {
          id: `sub:${relayMocks.subscriptions.length}`,
          close,
          closed: false,
        };
      }
    },
  };
}
