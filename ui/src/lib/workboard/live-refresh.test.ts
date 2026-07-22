// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import { normalizeWorkboardChange } from "./change-payload.ts";
import {
  configureWorkboardLiveRefresh,
  handleWorkboardChanged,
  resumeWorkboardLiveRefresh,
} from "./live-refresh.ts";
import { loadWorkboard } from "./loading.ts";
import { stopWorkboardLiveRefresh } from "./runtime.ts";
import { getWorkboardState } from "./runtime.ts";

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function createClient(run: (method: string) => unknown) {
  return { request: vi.fn(async (method: string) => run(method)) };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("Workboard live refresh", () => {
  it("validates the bounded invalidation payload", () => {
    expect(normalizeWorkboardChange({ epoch: "epoch-a", revision: 1 })).toEqual({
      epoch: "epoch-a",
      revision: 1,
    });
    expect(normalizeWorkboardChange({ epoch: "", revision: 1 })).toBeNull();
    expect(normalizeWorkboardChange({ epoch: "epoch-a", revision: 0 })).toBeNull();
    expect(normalizeWorkboardChange({ epoch: "epoch-a", revision: Number.NaN })).toBeNull();
    expect(normalizeWorkboardChange({ epoch: "epoch-a", revision: 1, cards: [] })).toBeNull();
  });

  it("rereads canonical cards and ignores stale revisions", async () => {
    const host = {};
    const client = createClient((method) =>
      method === "workboard.cards.list"
        ? {
            cards: [
              {
                id: "card-1",
                title: "Updated elsewhere",
                status: "todo",
                priority: "normal",
                labels: [],
                position: 1,
                createdAt: 1,
                updatedAt: 2,
              },
            ],
            statuses: ["todo", "done"],
          }
        : { tasks: [] },
    );
    configureWorkboardLiveRefresh({ host, client: client as never });

    expect(handleWorkboardChanged(host, { epoch: "epoch-a", revision: 2 })).toBe(true);
    await waitForFast(() =>
      expect(getWorkboardState(host).cards[0]?.title).toBe("Updated elsewhere"),
    );
    expect(handleWorkboardChanged(host, { epoch: "epoch-a", revision: 1 })).toBe(false);
    expect(
      client.request.mock.calls.filter(([method]) => method === "workboard.cards.list"),
    ).toHaveLength(1);
    expect(client.request).not.toHaveBeenCalledWith(
      "workboard.cards.diagnostics.refresh",
      expect.anything(),
    );
  });

  it("requests one canonical reload for each newly installed client", () => {
    const host = {};
    const first = createClient(() => ({ cards: [], statuses: ["todo", "done"] }));
    const second = createClient(() => ({ cards: [], statuses: ["todo", "done"] }));

    expect(configureWorkboardLiveRefresh({ host, client: first as never })).toBe(true);
    expect(configureWorkboardLiveRefresh({ host, client: first as never })).toBe(false);
    expect(configureWorkboardLiveRefresh({ host, client: second as never })).toBe(true);
  });

  it("coalesces revisions that arrive during a canonical read", async () => {
    const host = {};
    const firstList = createDeferred<unknown>();
    let listCalls = 0;
    const client = createClient((method) => {
      if (method === "workboard.cards.list") {
        listCalls += 1;
        return listCalls === 1 ? firstList.promise : { cards: [], statuses: ["todo", "done"] };
      }
      return { tasks: [] };
    });
    configureWorkboardLiveRefresh({ host, client: client as never });

    handleWorkboardChanged(host, { epoch: "epoch-a", revision: 1 });
    await waitForFast(() => expect(listCalls).toBe(1));
    handleWorkboardChanged(host, { epoch: "epoch-a", revision: 2 });
    handleWorkboardChanged(host, { epoch: "epoch-a", revision: 3 });
    firstList.resolve({ cards: [], statuses: ["todo", "done"] });

    await waitForFast(() => expect(listCalls).toBe(2));
    await Promise.resolve();
    expect(listCalls).toBe(2);
  });

  it("defers during edits and resumes after the local draft closes", async () => {
    const host = {};
    const requestUpdate = vi.fn();
    const client = createClient((method) =>
      method === "workboard.cards.list" ? { cards: [], statuses: ["todo", "done"] } : { tasks: [] },
    );
    const state = getWorkboardState(host);
    state.draftOpen = true;
    state.editingCardId = "card-1";
    configureWorkboardLiveRefresh({ host, client: client as never, requestUpdate });

    handleWorkboardChanged(host, { epoch: "epoch-a", revision: 1 });
    await Promise.resolve();
    expect(client.request).not.toHaveBeenCalled();
    expect(requestUpdate).not.toHaveBeenCalled();

    state.draftOpen = false;
    state.editingCardId = null;
    resumeWorkboardLiveRefresh(host);
    await waitForFast(() =>
      expect(client.request).toHaveBeenCalledWith("workboard.cards.list", {}),
    );
  });

  it("retries transient failures and treats a new epoch as authoritative", async () => {
    vi.useFakeTimers();
    const host = {};
    let fail = true;
    const client = createClient((method) => {
      if (method !== "workboard.cards.list") {
        return { tasks: [] };
      }
      if (fail) {
        throw new Error("temporarily unavailable");
      }
      return { cards: [], statuses: ["todo", "done"] };
    });
    configureWorkboardLiveRefresh({ host, client: client as never });

    handleWorkboardChanged(host, { epoch: "epoch-a", revision: 9 });
    await waitForFast(() =>
      expect(client.request).toHaveBeenCalledWith("workboard.cards.list", {}),
    );
    resumeWorkboardLiveRefresh(host);
    configureWorkboardLiveRefresh({ host, client: client as never });
    await Promise.resolve();
    expect(
      client.request.mock.calls.filter(([method]) => method === "workboard.cards.list"),
    ).toHaveLength(1);
    fail = false;
    await vi.advanceTimersByTimeAsync(1000);
    expect(
      client.request.mock.calls.filter(([method]) => method === "workboard.cards.list"),
    ).toHaveLength(2);

    expect(handleWorkboardChanged(host, { epoch: "epoch-b", revision: 1 })).toBe(true);
    await waitForFast(() =>
      expect(
        client.request.mock.calls.filter(([method]) => method === "workboard.cards.list"),
      ).toHaveLength(3),
    );
    stopWorkboardLiveRefresh(host);
  });

  it("discards a live read that completes after teardown", async () => {
    const host = {};
    const list = createDeferred<unknown>();
    const client = createClient((method) =>
      method === "workboard.cards.list" ? list.promise : { tasks: [] },
    );
    configureWorkboardLiveRefresh({ host, client: client as never });
    handleWorkboardChanged(host, { epoch: "epoch-a", revision: 1 });
    await waitForFast(() =>
      expect(client.request).toHaveBeenCalledWith("workboard.cards.list", {}),
    );

    stopWorkboardLiveRefresh(host);
    list.resolve({
      cards: [
        {
          id: "stale-card",
          title: "Must not apply",
          status: "todo",
          priority: "normal",
          labels: [],
          position: 1,
          createdAt: 1,
          updatedAt: 2,
        },
      ],
      statuses: ["todo", "done"],
    });
    await list.promise;
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });

    expect(getWorkboardState(host).cards).toEqual([]);
  });

  it("discards a direct canonical read that completes after teardown", async () => {
    const host = {};
    const list = createDeferred<unknown>();
    const client = createClient((method) =>
      method === "workboard.cards.list" ? list.promise : { tasks: [] },
    );
    configureWorkboardLiveRefresh({ host, client: client as never });
    const loading = loadWorkboard({ host, client: client as never, force: true });
    await waitForFast(() =>
      expect(client.request).toHaveBeenCalledWith("workboard.cards.list", {}),
    );

    stopWorkboardLiveRefresh(host);
    list.resolve({
      cards: [
        {
          id: "stale-card",
          title: "Must not apply",
          status: "todo",
          priority: "normal",
          labels: [],
          position: 1,
          createdAt: 1,
          updatedAt: 2,
        },
      ],
      statuses: ["todo", "done"],
    });

    await expect(loading).resolves.toBe(false);
    expect(getWorkboardState(host).cards).toEqual([]);
    expect(getWorkboardState(host).loading).toBe(false);
  });
});
