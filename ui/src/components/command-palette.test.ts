/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionsSearchResult } from "../../../packages/gateway-protocol/src/index.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import type { SessionsListResult } from "../api/types.ts";
import type { RouteId } from "../app-route-paths.ts";
import { createAgentSelectionCapability } from "../app/agent-selection.ts";
import type {
  ApplicationContext,
  ApplicationGateway,
  ApplicationGatewaySnapshot,
} from "../app/context.ts";
import { subscribeNativeOverlayOcclusion } from "../lib/native-overlay-occlusion.ts";
import { installDialogPolyfill } from "../test-helpers/modal-dialog.ts";
import { enterQuery, findPaletteOption, mountPalette } from "./command-palette.test-support.ts";
import "./command-palette.ts";
import {
  CUSTODIAN_PANEL_TOGGLE_EVENT,
  DESKTOP_PANEL_TOGGLE_EVENT,
  type DesktopPanelToggleDetail,
} from "./panel-toggle-contract.ts";

type CustodianPanelToggleDetail = { open?: boolean };

type GatewayHarness = {
  gateway: ApplicationGateway;
  setConnected: (connected: boolean) => void;
  emit: (event: string) => void;
};

function createGateway(
  connected: boolean,
  options: { methods?: string[]; request?: GatewayBrowserClient["request"] } = {},
): GatewayHarness {
  const client = { request: options.request } as GatewayBrowserClient;
  let snapshot: ApplicationGatewaySnapshot = {
    client,
    phase: connected ? "connected" : "reconnecting",
    offlineStable: false,
    canvasPluginSurfaceUrl: null,
    hello: options.methods ? ({ features: { methods: options.methods } } as never) : null,
    assistantAgentId: "main",
    sessionKey: "main",
    lastError: null,
    lastErrorCode: null,
  };
  const listeners = new Set<(next: ApplicationGatewaySnapshot) => void>();
  const events = new Set<Parameters<ApplicationGateway["subscribeEvents"]>[0]>();
  const gateway = {
    get snapshot() {
      return snapshot;
    },
    connection: { gatewayUrl: "ws://localhost", token: "", bootstrapToken: "", password: "" },
    connectionRevision: 0,
    eventLog: [],
    eventLogRevision: 0,
    connect: () => undefined,
    setSessionKey: () => undefined,
    start: () => undefined,
    stop: () => undefined,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    subscribeEventLog: () => () => undefined,
    subscribeEvents(listener) {
      events.add(listener);
      return () => events.delete(listener);
    },
  } satisfies ApplicationGateway;
  return {
    gateway,
    emit(event) {
      for (const listener of events) {
        listener({ type: "event", event, payload: {} });
      }
    },
    setConnected(nextConnected) {
      snapshot = {
        ...snapshot,
        phase: nextConnected ? "connected" : "reconnecting",
      };
      for (const listener of listeners) {
        listener(snapshot);
      }
    },
  };
}

function createContext(
  gateway: ApplicationGateway,
  list: ApplicationContext<RouteId>["sessions"]["list"],
): ApplicationContext<RouteId> {
  return {
    gateway,
    agentSelection: createAgentSelectionCapability(gateway, {
      state: { agentsList: null },
      subscribe: () => () => undefined,
    }),
    agents: {
      ensureList: async () => null,
    },
    sessions: {
      list,
      state: { result: null },
    },
  } as unknown as ApplicationContext<RouteId>;
}

function createSessionResult(key: string, displayName: string): SessionsListResult {
  return {
    ts: 1,
    path: "",
    count: 1,
    defaults: {},
    sessions: [{ key, kind: "direct", displayName, updatedAt: 1 }],
  } as SessionsListResult;
}

describe("CommandPalette lifecycle", () => {
  let restoreDialogPolyfill: () => void;
  let scrollIntoViewDescriptor: PropertyDescriptor | undefined;

  beforeEach(() => {
    vi.useFakeTimers();
    restoreDialogPolyfill = installDialogPolyfill();
    scrollIntoViewDescriptor = Object.getOwnPropertyDescriptor(Element.prototype, "scrollIntoView");
    Object.defineProperty(Element.prototype, "scrollIntoView", {
      configurable: true,
      value: vi.fn(),
    });
  });

  afterEach(() => {
    document.body.replaceChildren();
    restoreDialogPolyfill();
    if (scrollIntoViewDescriptor) {
      Object.defineProperty(Element.prototype, "scrollIntoView", scrollIntoViewDescriptor);
    } else {
      delete (Element.prototype as Partial<Element>).scrollIntoView;
    }
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("hides native browser overlays while the palette is open and releases on close or disconnect", async () => {
    vi.stubGlobal("webkit", {
      messageHandlers: { openclawBrowser: { postMessage: vi.fn() } },
    });
    const { gateway } = createGateway(true);
    const { palette } = await mountPalette(
      createContext(
        gateway,
        vi.fn(async () => null),
      ),
    );
    const changes = vi.fn();
    const unsubscribe = subscribeNativeOverlayOcclusion(changes);
    try {
      palette.openPalette();
      await palette.updateComplete;
      await palette.querySelector("openclaw-modal-dialog")?.updateComplete;
      expect(changes.mock.calls).toEqual([[false], [true]]);

      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      await palette.updateComplete;
      expect(changes).toHaveBeenLastCalledWith(false);
      palette.openPalette();
      await palette.updateComplete;
      await palette.querySelector("openclaw-modal-dialog")?.updateComplete;
      expect(changes).toHaveBeenLastCalledWith(true);
      palette.remove();
      expect(changes).toHaveBeenLastCalledWith(false);
    } finally {
      unsubscribe();
    }
  });

  it("closes and clears its query before a retained element reconnects", async () => {
    const { gateway } = createGateway(true);
    const list = vi.fn(async () => createSessionResult("agent:main:old", "Old chat"));
    const { palette, provider } = await mountPalette(createContext(gateway, list));
    await enterQuery(palette, "old");
    await vi.advanceTimersByTimeAsync(50);
    await palette.updateComplete;
    expect(palette.textContent).toContain("Old chat");

    palette.remove();
    provider.append(palette);
    const modal = palette.querySelector("openclaw-modal-dialog");
    const dialog = modal?.shadowRoot
      ?.querySelector("wa-dialog")
      ?.shadowRoot?.querySelector("dialog");
    expect(dialog?.open).toBe(false);
    await palette.updateComplete;

    expect(palette.querySelector("dialog")).toBeNull();
    palette.openPalette();
    await palette.updateComplete;
    expect(palette.querySelector<HTMLInputElement>(".cmd-palette__input")?.value).toBe("");
    expect(palette.textContent).not.toContain("Old chat");
  });

  it("retries the pending query after the gateway reconnects", async () => {
    const harness = createGateway(true);
    const stale = createDeferred<SessionsListResult | null>();
    const list = vi
      .fn<ApplicationContext<RouteId>["sessions"]["list"]>()
      .mockImplementationOnce(() => stale.promise)
      .mockResolvedValueOnce(createSessionResult("agent:main:retry", "Retry chat"));
    const { palette } = await mountPalette(createContext(harness.gateway, list));
    await enterQuery(palette, "retry");
    await vi.advanceTimersByTimeAsync(50);
    expect(list).toHaveBeenCalledOnce();

    harness.setConnected(false);
    stale.resolve(createSessionResult("agent:main:stale", "Stale chat"));
    await Promise.resolve();
    expect(palette.textContent).not.toContain("Stale chat");

    harness.setConnected(true);
    await palette.updateComplete;
    await vi.advanceTimersByTimeAsync(50);
    await palette.updateComplete;

    expect(list).toHaveBeenCalledTimes(2);
    expect(list).toHaveBeenLastCalledWith(expect.objectContaining({ search: "retry" }));
    expect(palette.textContent).toContain("Retry chat");
  });

  it("drops an old provider response and searches the replacement context", async () => {
    const initial = createGateway(true);
    const replacement = createGateway(true);
    const stale = createDeferred<SessionsListResult | null>();
    const initialList = vi.fn(() => stale.promise);
    const replacementList = vi.fn(async () =>
      createSessionResult("agent:main:fresh", "Fresh chat"),
    );
    const { palette, provider } = await mountPalette(createContext(initial.gateway, initialList));
    await enterQuery(palette, "chat");
    await vi.advanceTimersByTimeAsync(50);
    expect(initialList).toHaveBeenCalledOnce();

    stale.resolve(createSessionResult("agent:main:stale", "Stale chat"));
    provider.setContext(createContext(replacement.gateway, replacementList));
    await palette.updateComplete;
    await vi.advanceTimersByTimeAsync(50);
    await palette.updateComplete;

    expect(replacementList).toHaveBeenCalledOnce();
    expect(palette.textContent).toContain("Fresh chat");
    expect(palette.textContent).not.toContain("Stale chat");
  });

  it.each([false, true])(
    "keeps transcript snippets with a server metadata match: %s",
    async (serverMatch) => {
      const metadata = createSessionResult("agent:main:metadata", "needle");
      const contextOnly = createSessionResult("agent:main:context", "Unrelated title");
      const roster = {
        ...metadata,
        count: 2,
        totalCount: 2,
        sessions: [...metadata.sessions, ...contextOnly.sessions],
      } as SessionsListResult;
      const list = vi.fn<ApplicationContext<RouteId>["sessions"]["list"]>(async (options) =>
        options?.search && !serverMatch ? metadata : roster,
      );
      const searchResult: SessionsSearchResult = {
        results: [
          {
            sessionKey: "agent:main:context",
            sessionId: "context",
            messageId: "message-context",
            role: "assistant",
            timestamp: 42,
            snippet: "The needle appears only in the conversation body.",
            score: 10,
          },
        ],
      };
      const request = vi.fn(async () => searchResult);
      const { gateway } = createGateway(true, {
        methods: ["sessions.search"],
        request: request as GatewayBrowserClient["request"],
      });
      const { palette } = await mountPalette(createContext(gateway, list));

      await enterQuery(palette, "needle");
      await vi.advanceTimersByTimeAsync(50);
      await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
      await palette.updateComplete;

      expect(request).toHaveBeenCalledWith("sessions.search", {
        agentId: "main",
        sessionKeys: ["agent:main:metadata", "agent:main:context"],
        query: "needle",
        limit: 25,
      });
      const chatItems = [...palette.querySelectorAll<HTMLElement>(".cmd-palette__item")];
      expect(chatItems).toHaveLength(2);
      expect(chatItems[0]?.textContent).toContain("needle");
      expect(chatItems[1]?.textContent).toContain("Unrelated title");
      expect(chatItems[1]?.textContent).toContain("needle appears only in the conversation body");
      expect(palette.querySelectorAll(".cmd-palette__input")).toHaveLength(1);
    },
  );

  it.each(["main", "reviewer"])(
    "searches a bare default session key in selected agent %s",
    async (agentId) => {
      const roster = createSessionResult("main", "Default chat");
      const list = vi.fn<ApplicationContext<RouteId>["sessions"]["list"]>(async (options) =>
        options?.search ? { ...roster, count: 0, sessions: [] } : roster,
      );
      const request = vi.fn(async () => ({
        results: [
          {
            sessionKey: "main",
            sessionId: "default",
            messageId: "message-default",
            role: "assistant" as const,
            timestamp: 42,
            snippet: "The needle is in the default chat body.",
            score: 10,
          },
        ],
      }));
      const { gateway } = createGateway(true, {
        methods: ["sessions.search"],
        request: request as GatewayBrowserClient["request"],
      });
      const context = createContext(gateway, list);
      context.agentSelection.set(agentId);
      const { palette } = await mountPalette(context);

      await enterQuery(palette, "needle");
      await vi.advanceTimersByTimeAsync(50);
      await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
      await palette.updateComplete;

      expect(request).toHaveBeenCalledWith("sessions.search", {
        agentId,
        sessionKeys: ["main"],
        query: "needle",
        limit: 25,
      });
      expect(palette.textContent).toContain("Default chat");
      expect(palette.textContent).toContain("needle is in the default chat body");
    },
  );

  it("keeps metadata matches selectable when transcript search fails", async () => {
    const metadata = createSessionResult("agent:main:metadata", "Needle planning");
    const list = vi.fn<ApplicationContext<RouteId>["sessions"]["list"]>(async () => metadata);
    const request = vi.fn(async () => {
      throw new Error("transcript index unavailable");
    });
    const { gateway } = createGateway(true, {
      methods: ["sessions.search"],
      request: request as GatewayBrowserClient["request"],
    });
    const { palette } = await mountPalette(createContext(gateway, list));

    await enterQuery(palette, "needle");
    await vi.advanceTimersByTimeAsync(50);
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
    await palette.updateComplete;

    const metadataItem = findPaletteOption(palette, "Needle planning");
    expect(metadataItem?.textContent).toContain("Needle planning");
    metadataItem?.click();
    expect(palette.onSelectSession).toHaveBeenCalledWith("agent:main:metadata");
    expect(palette.textContent).toContain(
      "Transcript search unavailable — showing chat titles and metadata",
    );
    expect(palette.textContent).not.toContain("Chat search failed");
  });

  it.each([
    { state: "indexing", response: { indexing: true } },
    { state: "truncated", response: { truncated: true } },
  ])("shows a partial-search notice when transcript results are $state", async ({ response }) => {
    const metadata = createSessionResult("agent:main:metadata", "Needle planning");
    const contextOnly = createSessionResult("agent:main:context", "Unrelated title");
    const roster = {
      ...metadata,
      count: 2,
      totalCount: 2,
      sessions: [...metadata.sessions, ...contextOnly.sessions],
    } as SessionsListResult;
    const list = vi.fn<ApplicationContext<RouteId>["sessions"]["list"]>(async (options) =>
      options?.search ? metadata : roster,
    );
    const request = vi.fn(async () => ({
      results: [
        {
          sessionKey: "agent:main:context",
          sessionId: "context",
          messageId: "message-context",
          role: "assistant" as const,
          timestamp: 42,
          snippet: "The needle also appears in this transcript.",
          score: 10,
        },
      ],
      ...response,
    }));
    const { gateway } = createGateway(true, {
      methods: ["sessions.search"],
      request: request as GatewayBrowserClient["request"],
    });
    const { palette } = await mountPalette(createContext(gateway, list));

    await enterQuery(palette, "needle");
    await vi.advanceTimersByTimeAsync(50);
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
    await palette.updateComplete;

    expect(palette.textContent).toContain(
      "Transcript matches may be incomplete — indexing or search limits apply",
    );
    expect(palette.textContent).toContain("Needle planning");
    expect(palette.textContent).toContain("Unrelated title");
    expect(palette.textContent).toContain("needle also appears in this transcript");
  });

  it("lazily searches automation names and descriptions once per connection", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "cron.list") {
        return {
          jobs: [
            {
              id: "nightly-invoices",
              name: "Nightly invoices",
              description: "Reconciles customer billing",
            },
          ],
        };
      }
      throw new Error(`Unexpected method: ${method}`);
    });
    const { gateway } = createGateway(true, {
      methods: ["cron.list"],
      request: request as GatewayBrowserClient["request"],
    });
    const empty = { ...createSessionResult("agent:main:none", "None"), sessions: [] };
    const { palette } = await mountPalette(
      createContext(
        gateway,
        vi.fn(async () => empty),
      ),
    );

    await enterQuery(palette, "reconciles");
    await vi.advanceTimersByTimeAsync(50);
    await vi.waitFor(() => expect(palette.textContent).toContain("Nightly invoices"));
    const item = findPaletteOption(palette, "Nightly invoices");
    item?.click();
    expect(palette.onNavigate).toHaveBeenCalledWith("cron");

    await enterQuery(palette, "invoices");
    await vi.advanceTimersByTimeAsync(50);
    await vi.waitFor(() => expect(palette.textContent).toContain("Nightly invoices"));
    expect(request.mock.calls.filter(([method]) => method === "cron.list")).toHaveLength(1);
  });

  it("shows a failed acquisition without appending old rows to the successful response", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        models: [
          { provider: "ollama", id: "retained", name: "Needle retained" },
          { provider: "ollama", id: "obsolete", name: "Needle obsolete" },
        ],
      })
      .mockResolvedValueOnce({
        models: [{ provider: "ollama", id: "retained", name: "Needle retained" }],
        providerOutcomes: [{ provider: "ollama", status: "unavailable" }],
      })
      .mockResolvedValueOnce({
        models: [],
        providerOutcomes: [{ provider: "ollama", status: "ready" }],
      });
    const harness = createGateway(true, { methods: ["models.list"], request });
    const { palette } = await mountPalette(createContext(harness.gateway, async () => null));
    await enterQuery(palette, "needle");
    await vi.advanceTimersByTimeAsync(50);
    await palette.updateComplete;
    expect(findPaletteOption(palette, "Needle obsolete")).toBeDefined();

    harness.emit("chat.metadata.changed");
    await vi.advanceTimersByTimeAsync(50);
    await palette.updateComplete;
    expect(findPaletteOption(palette, "Needle obsolete")).toBeUndefined();
    expect(palette.querySelectorAll('[role="option"]')).toHaveLength(1);
    expect(palette.querySelector('[role="status"]')?.textContent).toContain(
      "Some models could not be refreshed. Open Models to try again.",
    );

    harness.emit("chat.metadata.changed");
    await vi.advanceTimersByTimeAsync(50);
    await palette.updateComplete;
    expect(findPaletteOption(palette, "Needle retained")).toBeUndefined();
    expect(palette.querySelector('[role="status"]')).toBeNull();
  });

  it("retains model results during a failed publication read and retries on input", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({ models: [{ provider: "fixture", id: "old", name: "Needle old" }] })
      .mockRejectedValueOnce(new Error("catalog unavailable"))
      .mockResolvedValueOnce({ models: [{ provider: "fixture", id: "new", name: "Needle new" }] });
    const harness = createGateway(true, { methods: ["models.list"], request });
    const { palette } = await mountPalette(createContext(harness.gateway, async () => null));
    await enterQuery(palette, "needle");
    await vi.advanceTimersByTimeAsync(50);
    await palette.updateComplete;
    expect(findPaletteOption(palette, "Needle old")).toBeDefined();

    harness.emit("chat.metadata.changed");
    await vi.advanceTimersByTimeAsync(50);
    await palette.updateComplete;
    expect(palette.querySelector('[role="status"]')?.textContent).toContain(
      "Model search unavailable",
    );
    expect(findPaletteOption(palette, "Needle old")).toBeDefined();

    await enterQuery(palette, "needle");
    await vi.advanceTimersByTimeAsync(50);
    await palette.updateComplete;
    expect(findPaletteOption(palette, "Needle new")).toBeDefined();
    expect(findPaletteOption(palette, "Needle old")).toBeUndefined();
    expect(palette.querySelector('[role="status"]')).toBeNull();
  });

  it.each(["agent", "source", "connection", "detach", "publication", "closed"])(
    "fences retained and pending catalog rows on %s replacement",
    async (replacement) => {
      const stale = createDeferred<{ models: { provider: string; id: string; name: string }[] }>();
      const request = vi
        .fn()
        .mockResolvedValueOnce({ models: [{ provider: "fixture", id: "old", name: "Needle old" }] })
        .mockReturnValueOnce(stale.promise)
        .mockResolvedValue({ models: [{ provider: "fixture", id: "new", name: "Needle new" }] });
      const harness = createGateway(true, { methods: ["models.list"], request });
      const context = createContext(harness.gateway, async () => null);
      const { palette, provider } = await mountPalette(context);
      await enterQuery(palette, "needle");
      await vi.advanceTimersByTimeAsync(50);
      await palette.updateComplete;
      expect(findPaletteOption(palette, "Needle old")).toBeDefined();
      harness.emit("config.changed");
      await vi.advanceTimersByTimeAsync(50);
      if (replacement === "agent") {
        context.agentSelection.set("reviewer");
      } else if (replacement === "source") {
        const next = createGateway(true, { methods: ["models.list"], request });
        provider.setContext(createContext(next.gateway, async () => null));
      } else if (replacement === "connection") {
        harness.setConnected(false);
      } else if (replacement === "detach") {
        palette.remove();
      } else if (replacement === "closed") {
        palette.togglePalette();
        harness.emit("chat.metadata.changed");
      } else {
        harness.emit("chat.metadata.changed");
      }
      await palette.updateComplete;
      if (replacement !== "publication") {
        expect(findPaletteOption(palette, "Needle old")).toBeUndefined();
      }
      if (replacement === "connection") {
        harness.setConnected(true);
      } else if (replacement === "detach") {
        provider.append(palette);
        await enterQuery(palette, "needle");
      } else if (replacement === "closed") {
        await enterQuery(palette, "needle");
      }
      await vi.advanceTimersByTimeAsync(50);
      stale.resolve({ models: [{ provider: "fixture", id: "stale", name: "Needle stale" }] });
      await vi.advanceTimersByTimeAsync(50);
      await palette.updateComplete;
      expect(findPaletteOption(palette, "Needle new")).toBeDefined();
      expect(findPaletteOption(palette, "Needle stale")).toBeUndefined();
      if (replacement === "agent") {
        expect(request).toHaveBeenLastCalledWith("models.list", {
          view: "configured",
          agentId: "reviewer",
          preparedOnly: true,
        });
      }
    },
  );

  it("waits for two characters before searching sessions", async () => {
    const { gateway } = createGateway(true, { methods: ["sessions.search"] });
    const list = vi.fn(async () => createSessionResult("agent:main:test", "Test"));
    const { palette } = await mountPalette(createContext(gateway, list));

    await enterQuery(palette, "n");
    await vi.advanceTimersByTimeAsync(50);

    expect(list).not.toHaveBeenCalled();
  });

  it.each(["click", "keyboard"])(
    "opens the selected catalog agent's encoded route by %s",
    async (method) => {
      const { gateway } = createGateway(true);
      const context = createContext(
        gateway,
        vi.fn(async () => null),
      );
      const { palette } = await mountPalette({
        ...context,
        basePath: "/openclaw",
        agents: {
          ...context.agents,
          ensureList: async () => ({
            defaultId: "main",
            mainKey: "main",
            scope: "per-sender",
            agents: [{ id: "reviewer.team", name: "Reviewer" }],
          }),
        },
      });
      await enterQuery(palette, "Reviewer");
      await vi.advanceTimersByTimeAsync(50);
      await palette.updateComplete;
      const item = palette.querySelector<HTMLElement>('[role="option"]');
      expect(item?.textContent).toContain("Reviewer");
      if (method === "click") {
        item?.click();
      } else {
        palette
          .querySelector("input")
          ?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      }
      expect(palette.onNavigate).toHaveBeenCalledWith("agents", {
        pathname: "/openclaw/settings/agents/reviewer%2Eteam",
      });
      expect(palette.isOpen).toBe(false);
    },
  );

  it("moves the keyboard selection through catalog groups in visible order", async () => {
    const { gateway } = createGateway(true, {
      methods: ["cron.list"],
      request: vi.fn(async () => ({
        jobs: [{ id: "bravo", name: "Needle Bravo" }],
      })) as GatewayBrowserClient["request"],
    });
    const context = createContext(
      gateway,
      vi.fn(async () => null),
    );
    const { palette } = await mountPalette({
      ...context,
      agents: {
        ...context.agents,
        ensureList: async () => ({
          defaultId: "alpha",
          mainKey: "main",
          scope: "per-sender",
          agents: [
            { id: "alpha", name: "Needle Alpha" },
            { id: "charlie", name: "Needle Charlie" },
          ],
        }),
      },
    });
    await enterQuery(palette, "Needle");
    await vi.advanceTimersByTimeAsync(50);
    await palette.updateComplete;
    const items = [...palette.querySelectorAll<HTMLElement>('[role="option"]')];
    expect(items.map((item) => item.textContent?.replace(/\s+/g, " ").trim())).toEqual([
      "Needle Alpha alpha",
      "Needle Charlie charlie",
      "Needle Bravo",
    ]);
    for (const expectedIndex of [1, 2, 0]) {
      palette
        .querySelector("input")
        ?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
      await palette.updateComplete;
      expect(palette.querySelector('[aria-selected="true"]')).toBe(items[expectedIndex]);
    }
  });

  it.each(["retain", "navigate"])(
    "keeps selection actionable when a chosen session disappears and returns (%s)",
    async (interaction) => {
      const { gateway, setConnected } = createGateway(true);
      const { palette } = await mountPalette(
        createContext(
          gateway,
          vi.fn(async () => ({
            ...createSessionResult("agent:main:qa-0", "Agent QA 0"),
            count: 10,
            sessions: Array.from(
              { length: 10 },
              (_, index) =>
                createSessionResult(`agent:main:qa-${index}`, `Agent QA ${index}`).sessions[0]!,
            ),
          })),
        ),
      );
      await enterQuery(palette, "agent");
      await vi.advanceTimersByTimeAsync(50);
      await palette.updateComplete;
      const session = findPaletteOption(palette, "Agent QA 9")!;
      const sessionText = session.textContent;
      session.dispatchEvent(new MouseEvent("mouseenter"));
      await palette.updateComplete;

      setConnected(false);
      await palette.updateComplete;
      expect(findPaletteOption(palette, "Agent QA 9")).toBeUndefined();
      const first = palette.querySelector('[role="option"]');
      expect(palette.querySelector('[aria-selected="true"]')).toBe(first);
      const input = palette.querySelector("input")!;
      expect(document.getElementById(input.getAttribute("aria-activedescendant")!)).toBe(first);
      if (interaction === "navigate") {
        input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
        await palette.updateComplete;
      }
      const offlineSelection = palette.querySelector('[aria-selected="true"]')?.textContent;

      setConnected(true);
      await palette.updateComplete;
      await vi.advanceTimersByTimeAsync(50);
      await palette.updateComplete;
      const active = palette.querySelector('[aria-selected="true"]');
      expect(active?.textContent).toEqual(
        interaction === "retain" ? sessionText : offlineSelection,
      );
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      expect(palette.isOpen).toBe(false);
      if (interaction === "retain") {
        expect(palette.onSelectSession).toHaveBeenCalledWith("agent:main:qa-9");
      } else {
        expect(palette.onSelectSession).not.toHaveBeenCalled();
        expect(palette.onNavigate).toHaveBeenCalledOnce();
      }
    },
  );

  it.each(["removed", "retained"])(
    "resolves the selected catalog item after a shrinking refresh (%s)",
    async (selection) => {
      const { gateway } = createGateway(true);
      const context = createContext(
        gateway,
        vi.fn(async () => null),
      );
      const roster = {
        defaultId: "a",
        mainKey: "main",
        scope: "per-sender" as const,
        agents: [
          { id: "a", name: "Review Alpha" },
          { id: "b", name: "Review Bravo" },
          { id: "c", name: "Review Charlie" },
        ],
      };
      const refresh = createDeferred<typeof roster>();
      const ensureList = vi.fn().mockResolvedValueOnce(roster).mockReturnValueOnce(refresh.promise);
      const { palette } = await mountPalette({
        ...context,
        agents: { ...context.agents, ensureList },
      });
      await enterQuery(palette, "review");
      await vi.advanceTimersByTimeAsync(50);
      await palette.updateComplete;
      vi.setSystemTime(Date.now() + 30_001);
      const input = palette.querySelector("input")!;
      input.value = "review ";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      await vi.advanceTimersByTimeAsync(50);
      await palette.updateComplete;
      for (let i = 0; i < 2; i++) {
        input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
        await palette.updateComplete;
      }
      expect(palette.querySelector('[aria-selected="true"]')?.textContent).toContain(
        "Review Charlie",
      );
      refresh.resolve({
        ...roster,
        agents: selection === "removed" ? roster.agents.slice(0, 1) : roster.agents.slice(2),
      });
      await vi.waitFor(() => expect(palette.querySelectorAll('[role="option"]')).toHaveLength(1));
      await palette.updateComplete;
      const remaining = palette.querySelector('[role="option"]');
      expect(palette.querySelector('[aria-selected="true"]')).toBe(remaining);
      expect(document.getElementById(input.getAttribute("aria-activedescendant")!)).toBe(remaining);
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      expect(palette.onNavigate).toHaveBeenCalledWith("agents", {
        pathname: `/settings/agents/${selection === "removed" ? "a" : "c"}`,
      });
      expect(palette.isOpen).toBe(false);
    },
  );

  it("distinguishes model choices with hyphenated provider and model IDs", async () => {
    const { gateway } = createGateway(true, {
      methods: ["models.list"],
      request: vi.fn(async () => ({
        models: [
          { provider: "qa", id: "custom-model", name: "Needle Alpha" },
          { provider: "qa-custom", id: "model", name: "Needle Bravo" },
        ],
      })) as GatewayBrowserClient["request"],
    });
    const { palette } = await mountPalette(
      createContext(
        gateway,
        vi.fn(async () => null),
      ),
    );
    await enterQuery(palette, "needle");
    await vi.advanceTimersByTimeAsync(50);
    await palette.updateComplete;
    palette
      .querySelector("input")!
      .dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    await palette.updateComplete;
    expect(palette.querySelector('[aria-selected="true"]')?.textContent).toContain("Needle Bravo");
  });

  it.each(["agent:main:topic:thread", "agent:main:topic:\ud800"])(
    "keeps the active descendant bound for session key %j",
    async (key) => {
      const { gateway } = createGateway(true);
      const colon = createSessionResult(key, "Needle colon");
      const hyphen = createSessionResult("agent:main:topic-thread", "Needle hyphen");
      const { palette } = await mountPalette(
        createContext(
          gateway,
          vi.fn(async () => ({
            ...colon,
            count: 2,
            sessions: [...colon.sessions, ...hyphen.sessions],
          })),
        ),
      );
      await enterQuery(palette, "Needle");
      await vi.advanceTimersByTimeAsync(50);
      await palette.updateComplete;
      palette
        .querySelector("input")
        ?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
      await palette.updateComplete;
      const active = palette.querySelector('[aria-selected="true"]');
      expect(active?.textContent).toContain("Needle hyphen");
      const activeId = palette.querySelector("input")?.getAttribute("aria-activedescendant");
      expect(document.getElementById(activeId ?? "")).toBe(active);
    },
  );

  it("keeps bounded metadata pagination when transcript search is unavailable", async () => {
    const list = vi.fn<ApplicationContext<RouteId>["sessions"]["list"]>(async (options) => {
      const offset = options?.offset ?? 0;
      return {
        ...createSessionResult(`agent:main:hidden-${offset}`, `Hidden ${offset}`),
        totalCount: 250,
        hasMore: true,
        nextOffset: offset + 50,
        sessions: [
          {
            key: `agent:main:hidden-${offset}`,
            kind: "direct",
            displayName: `Hidden ${offset}`,
            spawnedBy: "agent:main:main",
            updatedAt: 1,
          },
        ],
      } as SessionsListResult;
    });
    const { gateway } = createGateway(true);
    const { palette } = await mountPalette(createContext(gateway, list));

    await enterQuery(palette, "hidden");
    await vi.advanceTimersByTimeAsync(50);
    await vi.waitFor(() => expect(list).toHaveBeenCalledTimes(4));

    expect(list.mock.calls.map(([options]) => options?.offset ?? 0)).toEqual([0, 50, 100, 150]);
  });

  it("matches category metadata from the full visible roster", async () => {
    const categorized = createSessionResult("agent:main:categorized", "Unrelated title");
    const categorizedRow = categorized.sessions.at(0);
    if (!categorizedRow) {
      throw new Error("Expected categorized session fixture");
    }
    categorized.sessions[0] = { ...categorizedRow, category: "Tak" };
    const empty = { ...categorized, count: 0, sessions: [] } as SessionsListResult;
    const list = vi.fn<ApplicationContext<RouteId>["sessions"]["list"]>(async (options) =>
      options?.search ? empty : categorized,
    );
    const request = vi.fn(async () => ({ results: [] }) satisfies SessionsSearchResult);
    const { gateway } = createGateway(true, {
      methods: ["sessions.search"],
      request: request as GatewayBrowserClient["request"],
    });
    const { palette } = await mountPalette(createContext(gateway, list));

    await enterQuery(palette, "tak");
    await vi.advanceTimersByTimeAsync(50);
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
    await palette.updateComplete;

    expect(palette.textContent).toContain("Unrelated title");
  });

  it.each(["zzz-unmatched", "plugins"])("shows a chat search failure for %s", async (query) => {
    const { gateway } = createGateway(true);
    const list = vi
      .fn<ApplicationContext<RouteId>["sessions"]["list"]>()
      .mockRejectedValueOnce(new Error("store needs doctor migration"))
      .mockResolvedValueOnce(createSessionResult("agent:main:zz", "Recovered chat"));
    const { palette } = await mountPalette(createContext(gateway, list));
    await enterQuery(palette, query);
    await vi.advanceTimersByTimeAsync(50);
    await palette.updateComplete;

    expect(list).toHaveBeenCalledOnce();
    expect(palette.textContent).toContain("Chat search failed");
    expect(palette.textContent).not.toContain("No results");
    if (query === "plugins") {
      expect(findPaletteOption(palette, "Plugins")).toBeDefined();
    }

    // A new keystroke clears the failure state and retries cleanly.
    await enterQuery(palette, "zz");
    await palette.updateComplete;
    expect(palette.textContent).not.toContain("Chat search failed");
    await vi.advanceTimersByTimeAsync(50);
    await palette.updateComplete;
    expect(palette.textContent).toContain("Recovered chat");
  });

  it("opens the capture section from the palette without losing its deep link", async () => {
    const { gateway } = createGateway(true, { methods: [] });
    gateway.snapshot.hello!.auth = { role: "operator", scopes: ["operator.admin"] };
    const { palette } = await mountPalette(
      createContext(
        gateway,
        vi.fn(async () => createSessionResult("agent:main:test", "Test")),
      ),
    );
    await enterQuery(palette, "meeting capture");
    const item = findPaletteOption(palette, "Meeting capture");
    expect(item).toBeDefined();
    item!.click();
    expect(palette.onNavigate).toHaveBeenCalledWith("communications", {
      search: "?section=transcripts",
      hash: "#settings-communications-meeting-capture",
    });
  });

  it("navigates to the plugin manager from search", async () => {
    const { gateway } = createGateway(true);
    const { palette } = await mountPalette(
      createContext(
        gateway,
        vi.fn(async () => createSessionResult("agent:main:test", "Test")),
      ),
    );
    await enterQuery(palette, "plugins");

    const item = findPaletteOption(palette, "Plugins");
    expect(item?.textContent).toContain("Plugins");
    item?.click();

    expect(palette.onNavigate).toHaveBeenCalledWith("plugins");
  });

  it.each([
    { available: true, expectedCount: 1 },
    { available: false, expectedCount: 0 },
  ])(
    "shows the desktop action only when availability is $available",
    async ({ available, expectedCount }) => {
      const { gateway } = createGateway(true);
      const { palette } = await mountPalette(
        createContext(
          gateway,
          vi.fn(async () => createSessionResult("agent:main:test", "Test")),
        ),
      );
      palette.desktopAvailable = available;
      await enterQuery(palette, "desktop");

      expect(findPaletteOption(palette, "Desktop", true) ? 1 : 0).toBe(expectedCount);
    },
  );

  it("opens the desktop panel from its palette action", async () => {
    const { gateway } = createGateway(true);
    const { palette } = await mountPalette(
      createContext(
        gateway,
        vi.fn(async () => createSessionResult("agent:main:test", "Test")),
      ),
    );
    palette.desktopAvailable = true;
    await enterQuery(palette, "desktop");
    const events: CustomEvent<DesktopPanelToggleDetail>[] = [];
    const listener = (event: Event) => events.push(event as CustomEvent<DesktopPanelToggleDetail>);
    window.addEventListener(DESKTOP_PANEL_TOGGLE_EVENT, listener);
    try {
      findPaletteOption(palette, "Desktop", true)?.click();
    } finally {
      window.removeEventListener(DESKTOP_PANEL_TOGGLE_EVENT, listener);
    }

    expect(events).toHaveLength(1);
    expect(events[0]?.detail).toEqual({ open: true });
  });

  it.each([
    { available: true, expectedCount: 1 },
    { available: false, expectedCount: 0 },
  ])(
    "shows Ask OpenClaw only when availability is $available",
    async ({ available, expectedCount }) => {
      const { gateway } = createGateway(true);
      const { palette } = await mountPalette(
        createContext(
          gateway,
          vi.fn(async () => createSessionResult("agent:main:test", "Test")),
        ),
      );
      palette.custodianAvailable = available;
      await enterQuery(palette, "openclaw");

      expect(findPaletteOption(palette, "Ask OpenClaw", true) ? 1 : 0).toBe(expectedCount);
    },
  );

  it("opens Ask OpenClaw from its palette action", async () => {
    const { gateway } = createGateway(true);
    const { palette } = await mountPalette(
      createContext(
        gateway,
        vi.fn(async () => createSessionResult("agent:main:test", "Test")),
      ),
    );
    palette.custodianAvailable = true;
    await enterQuery(palette, "openclaw");
    const events: CustomEvent<CustodianPanelToggleDetail>[] = [];
    const listener = (event: Event) =>
      events.push(event as CustomEvent<CustodianPanelToggleDetail>);
    window.addEventListener(CUSTODIAN_PANEL_TOGGLE_EVENT, listener);
    try {
      findPaletteOption(palette, "Ask OpenClaw", true)?.click();
    } finally {
      window.removeEventListener(CUSTODIAN_PANEL_TOGGLE_EVENT, listener);
    }

    expect(events).toHaveLength(1);
    expect(events[0]?.detail).toEqual({ open: true });
  });
});
