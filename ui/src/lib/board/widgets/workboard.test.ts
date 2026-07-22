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
    position: 0,
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
    position: 1,
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
    position: 2,
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
        connected: true,
        reconnecting: false,
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
  it("renders a card and moves it through the shared mutation helper", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "workboard.cards.list") {
        return { cards, statuses: ["ready", "running", "done"] };
      }
      if (method === "workboard.cards.move") {
        return { card: { ...cards[0], status: "running", position: 2 } };
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
        position: 2,
      }),
    );
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
