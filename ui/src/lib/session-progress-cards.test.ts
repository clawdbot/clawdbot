import { MAX_DATE_TIMESTAMP_MS } from "@openclaw/normalization-core/number-coercion";
import { describe, expect, it, vi } from "vitest";
import type { ApplicationGateway } from "../app/gateway.ts";
import { sessionProgressCardsForGateway } from "./session-progress-cards.ts";

const sessionKey = "agent:main:progress-date-boundary";

function createProgressCard(updatedAt: number) {
  return { sessionKey, revision: 1, updatedAt, markdown: "Progress update" };
}

function createGateway() {
  const request = vi.fn();
  const gateway = {
    snapshot: {
      client: { request },
      phase: "connected",
      hello: { features: { methods: ["progressCard.get", "progressCard.put"] } },
    },
    subscribe: () => () => undefined,
    subscribeEvents: () => () => undefined,
  } as unknown as ApplicationGateway;
  return { gateway, request };
}

describe("session progress card Gateway response boundary", () => {
  it.each([-MAX_DATE_TIMESTAMP_MS, MAX_DATE_TIMESTAMP_MS])(
    "accepts the inclusive JavaScript Date boundary %i",
    async (updatedAt) => {
      const { gateway, request } = createGateway();
      request.mockResolvedValueOnce({ card: createProgressCard(updatedAt) });

      const store = sessionProgressCardsForGateway(gateway);
      await expect(store.load(sessionKey)).resolves.toMatchObject({ updatedAt });
      expect(store.get(sessionKey)?.updatedAt).toBe(updatedAt);
    },
  );

  it.each([-MAX_DATE_TIMESTAMP_MS - 1, MAX_DATE_TIMESTAMP_MS + 1])(
    "rejects an out-of-range timestamp from progressCard.get: %i",
    async (updatedAt) => {
      const { gateway, request } = createGateway();
      request.mockResolvedValueOnce({ card: createProgressCard(updatedAt) });

      const store = sessionProgressCardsForGateway(gateway);
      await expect(store.load(sessionKey)).rejects.toThrow(
        "Progress card response did not match the requested session",
      );
      expect(store.get(sessionKey)).toBeUndefined();
      expect(store.getError(sessionKey)).toBe("unavailable");
    },
  );

  it.each([-MAX_DATE_TIMESTAMP_MS - 1, MAX_DATE_TIMESTAMP_MS + 1])(
    "rejects an out-of-range timestamp from progressCard.put: %i",
    async (updatedAt) => {
      const { gateway, request } = createGateway();
      const existingCard = createProgressCard(Date.now());
      request
        .mockResolvedValueOnce({ card: existingCard })
        .mockResolvedValueOnce({ card: createProgressCard(updatedAt) });

      const store = sessionProgressCardsForGateway(gateway);
      await store.load(sessionKey);
      await expect(store.dismiss(existingCard)).rejects.toThrow(
        "Progress card response did not match the requested session",
      );
      expect(store.get(sessionKey)?.updatedAt).toBe(existingCard.updatedAt);
    },
  );
});
