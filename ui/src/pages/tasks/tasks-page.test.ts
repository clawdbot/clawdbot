import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationContext, ApplicationGatewaySnapshot } from "../../app/context.ts";
import "./tasks-page.ts";

type TasksPageTestElement = HTMLElement & {
  context: ApplicationContext;
  error: string | null;
  cancellingTaskIds: Set<string>;
  cancelTask: (taskId: string) => Promise<void>;
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function createGateway(client: GatewayBrowserClient) {
  const snapshot: ApplicationGatewaySnapshot = {
    client,
    phase: "connected",
    offlineStable: false,
    hello: null,
    assistantAgentId: null,
    sessionKey: "main",
    lastError: null,
    lastErrorCode: null,
  };
  let snapshotListener: ((snapshot: ApplicationGatewaySnapshot) => void) | undefined;
  const gateway = {
    snapshot,
    subscribe(listener: (snapshot: ApplicationGatewaySnapshot) => void) {
      snapshotListener = listener;
      return () => {
        if (snapshotListener === listener) {
          snapshotListener = undefined;
        }
      };
    },
    subscribeEvents: () => () => undefined,
  } as unknown as ApplicationContext["gateway"];
  return {
    emitConnected(connected: boolean) {
      snapshot.phase = connected ? "connected" : "stopped";
      snapshotListener?.(snapshot);
    },
    gateway,
  };
}

function createContext(
  gateway: ApplicationContext["gateway"],
  scopeId: string | null = "main",
): ApplicationContext {
  const subscribe = () => () => undefined;
  return {
    basePath: "",
    gateway,
    agents: {
      state: { agentsList: { defaultId: "main", agents: [{ id: "main" }, { id: "writer" }] } },
      ensureList: vi.fn(async () => undefined),
      subscribe,
    },
    agentSelection: {
      state: { selectedId: scopeId, scopeId },
      set: () => undefined,
      setScope: () => undefined,
      subscribe,
    },
    navigate: vi.fn(),
    preload: vi.fn(async () => undefined),
  } as unknown as ApplicationContext;
}

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("TasksPage cancellation lifecycle", () => {
  it("scopes both active and recent task requests to the selected agent", async () => {
    const request = vi.fn(async () => ({ tasks: [] }));
    const source = createGateway({ request } as unknown as GatewayBrowserClient);
    const page = document.createElement("openclaw-tasks-page") as TasksPageTestElement;
    page.context = createContext(source.gateway, "writer");
    document.body.append(page);

    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    expect(request).toHaveBeenCalledWith(
      "tasks.list",
      expect.objectContaining({ agentId: "writer", status: ["queued", "running"] }),
    );
    expect(request).toHaveBeenCalledWith(
      "tasks.list",
      expect.objectContaining({ agentId: "writer", limit: 200 }),
    );
  });

  it("discards a cancellation response across a same-client reconnect", async () => {
    const pendingCancel = deferred<{ cancelled: false; found: true; reason: string }>();
    const request = vi.fn((method: string) => {
      if (method === "tasks.cancel") {
        return pendingCancel.promise;
      }
      return Promise.resolve({ tasks: [] });
    });
    const client = { request } as unknown as GatewayBrowserClient;
    const source = createGateway(client);
    const page = document.createElement("openclaw-tasks-page") as TasksPageTestElement;
    page.context = createContext(source.gateway);
    document.body.append(page);
    await vi.waitFor(() => expect(request).toHaveBeenCalledWith("tasks.list", expect.anything()));

    const cancelling = page.cancelTask("task-1");
    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledWith("tasks.cancel", { taskId: "task-1" }),
    );
    expect(page.cancellingTaskIds.has("task-1")).toBe(true);

    source.emitConnected(false);
    source.emitConnected(true);
    pendingCancel.resolve({ cancelled: false, found: true, reason: "stale refusal" });
    await cancelling;

    expect(page.error).toBeNull();
    expect(page.cancellingTaskIds.size).toBe(0);
  });
});
