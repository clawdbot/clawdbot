import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApplicationContext } from "../../../app/context.ts";
import { createApplicationContextProvider } from "../../../test-helpers/application-context.ts";
import type { BoardViewWidget } from "../view-types.ts";
import "./workboard-card.ts";
import "./workboard-mini.ts";

const cards = [
  {
    id: "card-ready",
    title: "Ready card",
    status: "ready",
    priority: "high",
    labels: [],
    position: 1000,
    createdAt: 1,
    updatedAt: 1,
    agentId: "agent-a",
    metadata: { automation: { boardId: "ops" } },
  },
  {
    id: "card-running",
    title: "Running card",
    status: "running",
    priority: "normal",
    labels: [],
    position: 2000,
    createdAt: 1,
    updatedAt: 1,
    metadata: { automation: { boardId: "ops" } },
  },
  {
    id: "card-done",
    title: "Done card",
    status: "done",
    priority: "low",
    labels: [],
    position: 3000,
    createdAt: 1,
    updatedAt: 1,
    metadata: { automation: { boardId: "ops" } },
  },
] as const;

function pluginWidget(pluginKind: string, props: Record<string, unknown>): BoardViewWidget {
  return {
    name: pluginKind.replace(":", "-"),
    tabId: "main",
    contentKind: "plugin",
    pluginKind,
    props,
    sizeW: 6,
    sizeH: 4,
    position: 0,
    grantState: "none",
    revision: 1,
  };
}

function createContext(
  request: ReturnType<typeof vi.fn>,
  events?: { listener?: Parameters<ApplicationContext["gateway"]["subscribeEvents"]>[0] },
): ApplicationContext {
  const subscribe = () => () => undefined;
  return {
    basePath: "/control",
    gateway: {
      snapshot: {
        client: { request } as never,
        phase: "connected",
        hello: null,
        assistantAgentId: null,
        sessionKey: "agent:main:test",
        lastError: null,
        lastErrorCode: null,
      },
      subscribe,
      subscribeEvents: (
        listener: Parameters<ApplicationContext["gateway"]["subscribeEvents"]>[0],
      ) => {
        if (events) {
          events.listener = listener;
        }
        return () => undefined;
      },
    } as unknown as ApplicationContext["gateway"],
  } as unknown as ApplicationContext;
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

async function mount<T extends HTMLElement>(
  element: T,
  context: ApplicationContext,
  request: ReturnType<typeof vi.fn>,
): Promise<T> {
  const provider = createApplicationContextProvider(context);
  provider.append(element);
  document.body.append(provider);
  await vi.waitFor(() => expect(request).toHaveBeenCalledWith("workboard.cards.list", {}));
  await (element as T & { updateComplete: Promise<boolean> }).updateComplete;
  await vi.waitFor(() => expect(element.textContent).not.toContain("Loading Workboard"));
  return element;
}

afterEach(() => {
  document.body.replaceChildren();
  vi.clearAllMocks();
});

describe("Workboard plugin widgets", () => {
  it("shares the initial card load between widgets on the same gateway", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "workboard.cards.list") {
        return { cards, statuses: ["ready", "running", "done"] };
      }
      throw new Error(`Unexpected method: ${method}`);
    });
    const mini = document.createElement("openclaw-workboard-mini-widget");
    mini.widget = pluginWidget("workboard:mini", { boardId: "ops" });
    const card = document.createElement("openclaw-workboard-card-widget");
    card.widget = pluginWidget("workboard:card", { cardId: "card-ready" });
    const context = createContext(request);
    const unsubscribeEvents = vi.fn();
    const subscribeEvents = vi.fn(() => unsubscribeEvents);
    Reflect.set(context.gateway, "subscribeEvents", subscribeEvents);
    const provider = createApplicationContextProvider(context);
    provider.append(mini, card);
    document.body.append(provider);

    await vi.waitFor(() => {
      expect(mini.textContent).toContain("Running card");
      expect(card.textContent).toContain("Ready card");
    });

    expect(request.mock.calls.filter(([method]) => method === "workboard.cards.list")).toHaveLength(
      1,
    );
    expect(subscribeEvents).toHaveBeenCalledOnce();

    mini.remove();
    expect(unsubscribeEvents).not.toHaveBeenCalled();
    card.remove();
    expect(unsubscribeEvents).toHaveBeenCalledOnce();
  });

  it("deduplicates concurrent moves of the same card across widgets", async () => {
    const pendingMove = deferred<unknown>();
    const request = vi.fn(async (method: string) => {
      if (method === "workboard.cards.list") {
        return { cards, statuses: ["ready", "running", "done"] };
      }
      if (method === "workboard.cards.move") {
        return await pendingMove.promise;
      }
      throw new Error(`Unexpected method: ${method}`);
    });
    const first = document.createElement("openclaw-workboard-card-widget");
    first.widget = pluginWidget("workboard:card", { cardId: "card-ready" });
    const second = document.createElement("openclaw-workboard-card-widget");
    second.widget = pluginWidget("workboard:card", { cardId: "card-ready" });
    const provider = createApplicationContextProvider(createContext(request));
    provider.append(first, second);
    document.body.append(provider);

    await vi.waitFor(() => {
      expect(first.querySelector("select")).not.toBeNull();
      expect(second.querySelector("select")).not.toBeNull();
    });

    for (const widget of [first, second]) {
      const select = widget.querySelector("select")!;
      select.value = "running";
      select.dispatchEvent(new Event("change"));
    }

    try {
      expect(
        request.mock.calls.filter(([method]) => method === "workboard.cards.move"),
      ).toHaveLength(1);
    } finally {
      pendingMove.resolve({
        card: { ...cards[0], status: "running", position: 3000 },
      });
    }
  });

  it("broadcasts a post-change refresh to widgets sharing an older in-flight load", async () => {
    const staleLoad = deferred<unknown>();
    const freshCards = cards.map((card) =>
      card.id === "card-ready" ? { ...card, title: "Updated ready card" } : card,
    );
    const request = vi.fn(async (method: string) => {
      if (method !== "workboard.cards.list") {
        throw new Error(`Unexpected method: ${method}`);
      }
      if (request.mock.calls.length === 2) {
        return await staleLoad.promise;
      }
      return {
        cards: request.mock.calls.length === 1 ? cards : freshCards,
        statuses: ["ready", "running", "done"],
      };
    });
    const events: {
      listener?: Parameters<ApplicationContext["gateway"]["subscribeEvents"]>[0];
    } = {};
    const mini = document.createElement("openclaw-workboard-mini-widget");
    mini.widget = pluginWidget("workboard:mini", { boardId: "ops" });
    const card = document.createElement("openclaw-workboard-card-widget");
    card.widget = pluginWidget("workboard:card", { cardId: "card-ready" });
    const provider = createApplicationContextProvider(createContext(request, events));
    provider.append(mini, card);
    document.body.append(provider);

    await vi.waitFor(() => {
      expect(mini.textContent).toContain("Ready card");
      expect(card.textContent).toContain("Ready card");
    });

    (Reflect.get(mini, "retryLoad") as () => void).call(mini);
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    events.listener?.({
      type: "event",
      event: "plugin.workboard.changed",
      payload: { epoch: "epoch-shared", revision: 2 },
    });
    staleLoad.resolve({ cards, statuses: ["ready", "running", "done"] });

    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(3));
    await vi.waitFor(() => {
      expect(mini.textContent).toContain("Updated ready card");
      expect(card.textContent).toContain("Updated ready card");
    });
  });

  it("renders a card and moves it through the shared mutation helper", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "workboard.cards.list") {
        return { cards, statuses: ["ready", "running", "done"] };
      }
      if (method === "workboard.cards.move") {
        return { card: { ...cards[0], status: "running", position: 3000 } };
      }
      throw new Error(`Unexpected method: ${method}`);
    });
    const element = document.createElement("openclaw-workboard-card-widget");
    element.widget = pluginWidget("workboard:card", { cardId: "card-ready" });
    element.sessionKey = "agent:main:test";
    await mount(element, createContext(request), request);

    expect(element.textContent).toContain("Ready card");
    expect(element.textContent).toContain("agent-a");
    const select = element.querySelector("select") as HTMLSelectElement;
    select.value = "running";
    select.dispatchEvent(new Event("change"));

    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledWith("workboard.cards.move", {
        id: "card-ready",
        status: "running",
        position: 3000,
      }),
    );
  });

  it.each([
    {
      name: "starts an empty destination at the canonical position",
      listedCards: [cards[0], cards[2]],
      position: 1000,
    },
    {
      name: "ignores higher positions on another board",
      listedCards: [
        ...cards,
        {
          ...cards[1],
          id: "product-running",
          title: "Product run",
          position: 9000,
          metadata: { automation: { boardId: "product" } },
        },
      ],
      position: 3000,
    },
    {
      name: "preserves hidden archived positions on the same board",
      listedCards: [
        ...cards,
        {
          ...cards[1],
          id: "archived-ops-running",
          title: "Archived Operations run",
          position: 9000,
          metadata: { archivedAt: 10, automation: { boardId: "ops" } },
        },
      ],
      position: 10000,
    },
  ])("$name", async ({ listedCards, position }) => {
    const request = vi.fn(async (method: string) => {
      if (method === "workboard.cards.list") {
        return { cards: listedCards, statuses: ["ready", "running", "done"] };
      }
      if (method === "workboard.cards.move") {
        return { card: { ...cards[0], status: "running", position } };
      }
      throw new Error(`Unexpected method: ${method}`);
    });
    const element = document.createElement("openclaw-workboard-card-widget");
    element.widget = pluginWidget("workboard:card", { cardId: "card-ready" });
    element.sessionKey = "agent:main:test";

    await mount(element, createContext(request), request);

    const select = element.querySelector("select");
    expect(select).not.toBeNull();
    select!.value = "running";
    select!.dispatchEvent(new Event("change"));

    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledWith("workboard.cards.move", {
        id: "card-ready",
        status: "running",
        position,
      }),
    );
    expect(element.textContent).not.toContain("Archived Operations run");
  });

  it("does not offer or issue status changes for a read-only card widget", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "workboard.cards.list") {
        return { cards, statuses: ["ready", "running", "done"] };
      }
      throw new Error(`Unexpected method: ${method}`);
    });
    const element = document.createElement("openclaw-workboard-card-widget");
    element.widget = pluginWidget("workboard:card", { cardId: "card-ready" });
    element.sessionKey = "agent:main:test";
    Reflect.set(element, "canMutate", false);

    await mount(element, createContext(request), request);

    const select = element.querySelector("select");
    expect(select).not.toBeNull();
    expect(select?.disabled).toBe(true);
    if (select) {
      select.value = "running";
      select.dispatchEvent(new Event("change"));
    }
    expect(request).not.toHaveBeenCalledWith("workboard.cards.move", expect.anything());
  });

  it("ignores a stale card move after the gateway connection changes", async () => {
    const staleMove = deferred<unknown>();
    const staleRequest = vi.fn(async (method: string) => {
      if (method === "workboard.cards.list") {
        return { cards, statuses: ["ready", "running", "done"] };
      }
      if (method === "workboard.cards.move") {
        return await staleMove.promise;
      }
      throw new Error(`Unexpected method: ${method}`);
    });
    const currentCard = { ...cards[0], title: "Current connection card" };
    const currentRequest = vi.fn(async (method: string) => {
      if (method === "workboard.cards.list") {
        return { cards: [currentCard], statuses: ["ready", "running", "done"] };
      }
      if (method === "workboard.cards.move") {
        return { card: { ...currentCard, status: "running", position: 1000 } };
      }
      throw new Error(`Unexpected method: ${method}`);
    });
    const element = document.createElement("openclaw-workboard-card-widget");
    element.widget = pluginWidget("workboard:card", { cardId: "card-ready" });
    element.sessionKey = "agent:main:test";
    const provider = createApplicationContextProvider(createContext(staleRequest));
    provider.append(element);
    document.body.append(provider);
    await vi.waitFor(() => expect(element.textContent).toContain("Ready card"));

    const select = element.querySelector("select");
    expect(select).not.toBeNull();
    if (select) {
      select.value = "running";
      select.dispatchEvent(new Event("change"));
    }
    await vi.waitFor(() =>
      expect(staleRequest).toHaveBeenCalledWith("workboard.cards.move", {
        id: "card-ready",
        status: "running",
        position: 3000,
      }),
    );
    const moveCallIndex = staleRequest.mock.calls.findIndex(
      ([method]) => method === "workboard.cards.move",
    );
    const pendingMove = staleRequest.mock.results[moveCallIndex]?.value as Promise<unknown>;

    provider.setContext(createContext(currentRequest));
    await vi.waitFor(() => expect(element.textContent).toContain("Current connection card"));
    const currentSelect = element.querySelector("select");
    expect(currentSelect).not.toBeNull();
    if (currentSelect) {
      currentSelect.value = "running";
      currentSelect.dispatchEvent(new Event("change"));
    }
    await vi.waitFor(() =>
      expect(currentRequest).toHaveBeenCalledWith("workboard.cards.move", {
        id: "card-ready",
        status: "running",
        position: 1000,
      }),
    );
    staleMove.resolve({
      card: { ...cards[0], title: "Stale connection card", status: "running", position: 3000 },
    });
    await pendingMove;
    await Promise.resolve();
    await element.updateComplete;

    expect(element.textContent).toContain("Current connection card");
    expect(element.textContent).not.toContain("Stale connection card");
    expect(element.querySelector("select")?.value).toBe("running");
  });

  it("does not render or move an archived card", async () => {
    const archivedCard = {
      ...cards[0],
      title: "Archived ready card",
      metadata: { ...cards[0].metadata, archivedAt: 10 },
    };
    const request = vi.fn(async () => ({
      cards: [archivedCard],
      statuses: ["ready", "running", "done"],
    }));
    const element = document.createElement("openclaw-workboard-card-widget");
    element.widget = pluginWidget("workboard:card", { cardId: archivedCard.id });
    element.sessionKey = "agent:main:test";

    await mount(element, createContext(request), request);

    expect(element.querySelector(".workboard-widget__state")).not.toBeNull();
    expect(element.textContent).not.toContain(archivedCard.title);
    expect(element.querySelector("select")).toBeNull();
    expect(request).not.toHaveBeenCalledWith("workboard.cards.move", expect.anything());
  });

  it("renders per-status board counts and the top ready/running cards", async () => {
    const request = vi.fn(async () => ({ cards, statuses: ["ready", "running", "done"] }));
    const element = document.createElement("openclaw-workboard-mini-widget");
    element.widget = pluginWidget("workboard:mini", { boardId: "ops", limit: 2 });
    element.sessionKey = "agent:main:test";
    await mount(element, createContext(request), request);

    const counts = [...element.querySelectorAll(".workboard-widget-mini__counts span")].map(
      (entry) => entry.textContent?.replace(/\s+/g, " ").trim(),
    );
    expect(counts).toContain("1 Ready");
    expect(counts).toContain("1 Running");
    expect(counts).toContain("1 Done");
    expect(element.textContent).toContain("Running card");
    expect(element.textContent).toContain("Ready card");
    expect(element.querySelector("a")?.getAttribute("href")).toBe("/control/workboard?board=ops");
  });

  it("excludes archived running cards from board counts and active cards", async () => {
    const archivedCard = {
      ...cards[1],
      id: "card-archived",
      title: "Archived running card",
      metadata: { ...cards[1].metadata, archivedAt: 10 },
    };
    const request = vi.fn(async () => ({
      cards: [...cards, archivedCard],
      statuses: ["ready", "running", "done"],
    }));
    const element = document.createElement("openclaw-workboard-mini-widget");
    element.widget = pluginWidget("workboard:mini", { boardId: "ops", limit: 5 });
    element.sessionKey = "agent:main:test";

    await mount(element, createContext(request), request);

    const counts = [...element.querySelectorAll(".workboard-widget-mini__counts span")].map(
      (entry) => entry.textContent?.replace(/\s+/g, " ").trim(),
    );
    expect(counts).toContain("1 Ready");
    expect(counts).toContain("1 Running");
    expect(counts).toContain("1 Done");
    expect(element.textContent).toContain("Running card");
    expect(element.textContent).not.toContain(archivedCard.title);
  });

  it("aggregates every board when no boardId prop is set", async () => {
    const mixedCards = [
      ...cards,
      {
        id: "card-unscoped",
        title: "Unscoped card",
        status: "running",
        priority: "normal",
        labels: [],
        position: 3,
        createdAt: 1,
        updatedAt: 1,
      },
    ];
    const request = vi.fn(async () => ({
      cards: mixedCards,
      statuses: ["ready", "running", "done"],
    }));
    const element = document.createElement("openclaw-workboard-mini-widget");
    element.widget = pluginWidget("workboard:mini", {});
    element.sessionKey = "agent:main:test";
    await mount(element, createContext(request), request);

    const counts = [...element.querySelectorAll(".workboard-widget-mini__counts span")].map(
      (entry) => entry.textContent?.replace(/\s+/g, " ").trim(),
    );
    expect(counts).toContain("2 Running");
    expect(element.querySelector("header strong")?.textContent).toBe("All boards");
    expect(element.textContent).toContain("Unscoped card");
    expect(element.querySelector("a")?.getAttribute("href")).toBe("/control/workboard");
  });

  it("retries a transient initial list failure without reconnecting", async () => {
    const request = vi
      .fn()
      .mockRejectedValueOnce(new Error("temporary failure"))
      .mockResolvedValueOnce({ cards, statuses: ["ready", "running", "done"] });
    const element = document.createElement("openclaw-workboard-mini-widget");
    element.widget = pluginWidget("workboard:mini", { boardId: "ops" });
    element.sessionKey = "agent:main:test";
    await mount(element, createContext(request), request);

    expect(element.textContent).toContain("temporary failure");
    const retry = element.querySelector("button");
    expect(retry?.textContent?.trim()).toBe("Retry");
    retry?.click();

    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(element.textContent).toContain("Running card"));
  });

  it("queues a second refresh when a change arrives during an active list request", async () => {
    const firstList = deferred<unknown>();
    const request = vi.fn(async (method: string) => {
      if (method !== "workboard.cards.list") {
        throw new Error(`Unexpected method: ${method}`);
      }
      return request.mock.calls.length === 1
        ? await firstList.promise
        : { cards, statuses: ["ready", "running", "done"] };
    });
    const events: {
      listener?: Parameters<ApplicationContext["gateway"]["subscribeEvents"]>[0];
    } = {};
    const element = document.createElement("openclaw-workboard-mini-widget");
    element.widget = pluginWidget("workboard:mini", { boardId: "ops" });
    const provider = createApplicationContextProvider(createContext(request, events));
    provider.append(element);
    document.body.append(provider);
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));

    events.listener?.({
      type: "event",
      event: "plugin.workboard.changed",
      payload: { epoch: "epoch-a", revision: 2 },
    });
    firstList.resolve({ cards: [], statuses: ["ready", "running", "done"] });

    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
  });

  it("restarts loading after reconnecting while the previous request is pending", async () => {
    const firstList = deferred<unknown>();
    const request = vi.fn(async (method: string) => {
      if (method !== "workboard.cards.list") {
        throw new Error(`Unexpected method: ${method}`);
      }
      return request.mock.calls.length === 1
        ? await firstList.promise
        : { cards, statuses: ["ready", "running", "done"] };
    });
    const element = document.createElement("openclaw-workboard-mini-widget");
    element.widget = pluginWidget("workboard:mini", { boardId: "ops" });
    const provider = createApplicationContextProvider(createContext(request));
    provider.append(element);
    document.body.append(provider);
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));

    element.remove();
    provider.append(element);

    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(element.textContent).toContain("Running card"));
    firstList.resolve({ cards: [], statuses: ["ready", "running", "done"] });
  });

  it("keeps a queued refresh owned by the current gateway generation", async () => {
    const staleList = deferred<unknown>();
    const currentList = deferred<unknown>();
    const staleRequest = vi.fn(async () => await staleList.promise);
    const currentRequest = vi.fn(async (method: string) => {
      if (method !== "workboard.cards.list") {
        throw new Error(`Unexpected method: ${method}`);
      }
      return currentRequest.mock.calls.length === 1
        ? await currentList.promise
        : { cards, statuses: ["ready", "running", "done"] };
    });
    const currentEvents: {
      listener?: Parameters<ApplicationContext["gateway"]["subscribeEvents"]>[0];
    } = {};
    const element = document.createElement("openclaw-workboard-mini-widget");
    element.widget = pluginWidget("workboard:mini", { boardId: "ops" });
    const provider = createApplicationContextProvider(createContext(staleRequest));
    provider.append(element);
    document.body.append(provider);
    await vi.waitFor(() => expect(staleRequest).toHaveBeenCalledTimes(1));

    provider.setContext(createContext(currentRequest, currentEvents));
    await vi.waitFor(() => expect(currentRequest).toHaveBeenCalledTimes(1));
    currentEvents.listener?.({
      type: "event",
      event: "plugin.workboard.changed",
      payload: { epoch: "epoch-current", revision: 2 },
    });
    staleList.resolve({ cards: [], statuses: ["ready", "running", "done"] });
    await Promise.resolve();
    currentList.resolve({ cards: [], statuses: ["ready", "running", "done"] });

    await vi.waitFor(() => expect(currentRequest).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(element.textContent).toContain("Running card"));
  });
});
