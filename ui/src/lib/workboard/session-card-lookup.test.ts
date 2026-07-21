import { describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { acquireWorkboardSessionCardLookup } from "./session-card-lookup.ts";

function createClient(responses: unknown[]) {
  let gatewayListener: ((event: { event: string; payload?: unknown }) => void) | undefined;
  const removeListener = vi.fn();
  const request = vi.fn(async (method: string) => {
    if (method !== "workboard.cards.list") {
      throw new Error(`unexpected request: ${method}`);
    }
    return responses.shift() ?? { cards: [] };
  });
  const client = {
    request,
    addEventListener: vi.fn((listener: typeof gatewayListener) => {
      gatewayListener = listener;
      return removeListener;
    }),
  } as unknown as GatewayBrowserClient;
  return {
    client,
    request,
    removeListener,
    emitChanged: () => gatewayListener?.({ event: "plugin.workboard.changed" }),
  };
}

function card(overrides: Record<string, unknown> = {}) {
  return {
    id: "card-1",
    title: "Ship dashboard stitch",
    status: "running",
    priority: "normal",
    labels: [],
    position: 1,
    createdAt: 1,
    updatedAt: 2,
    sessionKey: "agent:main:workboard-card",
    metadata: { automation: { boardId: "platform" } },
    ...overrides,
  };
}

describe("Workboard session card lookup", () => {
  it("coalesces subscribers and refreshes cached matches after Workboard changes", async () => {
    const { client, request, removeListener, emitChanged } = createClient([
      { cards: [card()] },
      { cards: [card({ status: "review", updatedAt: 3 })] },
    ]);
    const firstLease = acquireWorkboardSessionCardLookup(client);
    const secondLease = acquireWorkboardSessionCardLookup(client);
    const first = vi.fn();
    const second = vi.fn();
    const unsubscribeFirst = firstLease.subscribe("agent:main:workboard-card", first);
    const unsubscribeSecond = secondLease.subscribe("agent:main:workboard-card", second);

    await vi.waitFor(() =>
      expect(first).toHaveBeenCalledWith(expect.objectContaining({ status: "running" })),
    );
    expect(second).toHaveBeenCalledWith(expect.objectContaining({ cardId: "card-1" }));
    expect(request).toHaveBeenCalledTimes(1);

    emitChanged();
    await vi.waitFor(() =>
      expect(first).toHaveBeenCalledWith(expect.objectContaining({ status: "review" })),
    );
    expect(request).toHaveBeenCalledTimes(2);

    unsubscribeFirst();
    unsubscribeSecond();
    firstLease.release();
    expect(removeListener).not.toHaveBeenCalled();
    secondLease.release();
    expect(removeListener).toHaveBeenCalledOnce();
  });

  it("indexes historical attempt sessions and returns no match for unrelated sessions", async () => {
    const { client } = createClient([
      {
        cards: [
          card({
            sessionKey: "agent:main:newest",
            metadata: {
              automation: { boardId: "quality" },
              attempts: [
                { id: "attempt-1", status: "failed", startedAt: 1, sessionKey: "agent:main:older" },
              ],
            },
          }),
        ],
      },
    ]);
    const lease = acquireWorkboardSessionCardLookup(client);
    const historical = vi.fn();
    const unrelated = vi.fn();
    const unsubscribeHistorical = lease.subscribe("agent:main:older", historical);
    const unsubscribeUnrelated = lease.subscribe("agent:main:unrelated", unrelated);

    await vi.waitFor(() =>
      expect(historical).toHaveBeenCalledWith(expect.objectContaining({ boardId: "quality" })),
    );
    expect(unrelated).toHaveBeenCalledWith(null);

    unsubscribeHistorical();
    unsubscribeUnrelated();
    lease.release();
  });

  it("scans omitted run history sequentially for subscribers added after a warm cache", async () => {
    const request = vi.fn(async (method: string, params?: { id?: string }) => {
      if (method === "workboard.cards.list") {
        return {
          cards: [
            card({
              id: "card-new",
              sessionKey: "agent:main:direct",
              runId: "run-new",
              metadata: undefined,
              updatedAt: 3,
            }),
            card({
              id: "card-old",
              sessionKey: undefined,
              runId: "run-old",
              metadata: undefined,
              updatedAt: 2,
            }),
          ],
        };
      }
      if (method === "workboard.cards.runs" && params?.id === "card-new") {
        return {
          attempts: [
            {
              id: "attempt-1",
              status: "running",
              startedAt: 1,
              sessionKey: "agent:main:runs-fallback",
            },
          ],
        };
      }
      throw new Error(`unexpected request: ${method}`);
    });
    const client = {
      request,
      addEventListener: vi.fn(() => () => {}),
    } as unknown as GatewayBrowserClient;
    const lease = acquireWorkboardSessionCardLookup(client);
    const direct = vi.fn();
    const unsubscribeDirect = lease.subscribe("agent:main:direct", direct);

    await vi.waitFor(() =>
      expect(direct).toHaveBeenCalledWith(expect.objectContaining({ cardId: "card-new" })),
    );
    expect(request.mock.calls.filter(([method]) => method === "workboard.cards.runs")).toHaveLength(
      0,
    );

    const historical = vi.fn();
    const unsubscribeHistorical = lease.subscribe("agent:main:runs-fallback", historical);

    await vi.waitFor(() =>
      expect(historical).toHaveBeenCalledWith(expect.objectContaining({ cardId: "card-new" })),
    );
    expect(request.mock.calls.filter(([method]) => method === "workboard.cards.runs")).toEqual([
      ["workboard.cards.runs", { id: "card-new" }],
    ]);

    unsubscribeDirect();
    unsubscribeHistorical();
    lease.release();
  });

  it("bounds an unmatched older-gateway run scan to the most recent cards", async () => {
    const cards = Array.from({ length: 24 }, (_, index) =>
      card({
        id: `card-${index}`,
        sessionKey: undefined,
        runId: `run-${index}`,
        metadata: undefined,
        updatedAt: 100 - index,
      }),
    );
    const request = vi.fn(async (method: string) => {
      if (method === "workboard.cards.list") {
        return { cards };
      }
      if (method === "workboard.cards.runs") {
        return { attempts: [] };
      }
      throw new Error(`unexpected request: ${method}`);
    });
    const client = {
      request,
      addEventListener: vi.fn(() => () => {}),
    } as unknown as GatewayBrowserClient;
    const lease = acquireWorkboardSessionCardLookup(client);
    const listener = vi.fn();
    const unsubscribe = lease.subscribe("agent:main:not-a-workboard-run", listener);

    await vi.waitFor(() =>
      expect(
        request.mock.calls.filter(([method]) => method === "workboard.cards.runs"),
      ).toHaveLength(16),
    );
    expect(listener).toHaveBeenCalledWith(null);

    unsubscribe();
    lease.release();
  });
});
