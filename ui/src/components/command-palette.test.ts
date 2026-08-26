/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionsSearchResult } from "../../../packages/gateway-protocol/src/index.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import type { SessionsListResult } from "../api/types.ts";
import type { RouteId } from "../app-route-paths.ts";
import type {
  ApplicationContext,
  ApplicationGateway,
  ApplicationGatewaySnapshot,
} from "../app/context.ts";
import { createApplicationContextProvider } from "../test-helpers/application-context.ts";
import { installDialogPolyfill } from "../test-helpers/modal-dialog.ts";
import { CommandPalette } from "./command-palette.ts";
import {
  CUSTODIAN_PANEL_TOGGLE_EVENT,
  DESKTOP_PANEL_TOGGLE_EVENT,
  type DesktopPanelToggleDetail,
} from "./panel-toggle-contract.ts";

type CustodianPanelToggleDetail = { open?: boolean };

type GatewayHarness = {
  gateway: ApplicationGateway;
  setConnected: (connected: boolean) => void;
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
  const gateway = {
    get snapshot() {
      return snapshot;
    },
    connection: { gatewayUrl: "ws://localhost", token: "", bootstrapToken: "", password: "" },
    connectionRevision: 0,
    eventLog: [],
    connect: () => undefined,
    setSessionKey: () => undefined,
    start: () => undefined,
    stop: () => undefined,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    subscribeEventLog: () => () => undefined,
    subscribeEvents: () => () => undefined,
  } satisfies ApplicationGateway;
  return {
    gateway,
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

async function mountPalette(context: ApplicationContext<RouteId>) {
  const provider = createApplicationContextProvider(context);
  const palette = document.createElement("openclaw-command-palette") as CommandPalette;
  palette.onNavigate = vi.fn();
  palette.onSelectSession = vi.fn();
  provider.append(palette);
  document.body.append(provider);
  await palette.updateComplete;
  return { palette, provider };
}

async function enterQuery(palette: CommandPalette, query: string) {
  palette.openPalette();
  await palette.updateComplete;
  const input = palette.querySelector<HTMLInputElement>(".cmd-palette__input");
  if (!input) {
    throw new Error("Expected command palette input");
  }
  input.value = query;
  input.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
  await palette.updateComplete;
}

describe("CommandPalette lifecycle", () => {
  let restoreDialogPolyfill: () => void;

  beforeEach(() => {
    vi.useFakeTimers();
    restoreDialogPolyfill = installDialogPolyfill();
  });

  afterEach(() => {
    document.body.replaceChildren();
    restoreDialogPolyfill();
    vi.useRealTimers();
    vi.restoreAllMocks();
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

  it("merges full-context matches after metadata matches without adding another search field", async () => {
    const metadata = createSessionResult("agent:main:metadata", "needle");
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
  });

  it("searches a bare default session key in the selected agent scope", async () => {
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
    const { palette } = await mountPalette(createContext(gateway, list));

    await enterQuery(palette, "needle");
    await vi.advanceTimersByTimeAsync(50);
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
    await palette.updateComplete;

    expect(request).toHaveBeenCalledWith("sessions.search", {
      agentId: "main",
      sessionKeys: ["main"],
      query: "needle",
      limit: 25,
    });
    expect(palette.textContent).toContain("Default chat");
    expect(palette.textContent).toContain("needle is in the default chat body");
  });

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

    const metadataItem = palette.querySelector<HTMLElement>(
      "#cmd-palette-option-session-agent-main-metadata",
    );
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
    const item = palette.querySelector<HTMLElement>(
      "#cmd-palette-option-automation-nightly-invoices",
    );
    item?.click();
    expect(palette.onNavigate).toHaveBeenCalledWith("cron");

    await enterQuery(palette, "invoices");
    await vi.advanceTimersByTimeAsync(50);
    await vi.waitFor(() => expect(palette.textContent).toContain("Nightly invoices"));
    expect(request.mock.calls.filter(([method]) => method === "cron.list")).toHaveLength(1);
  });

  it("waits for two characters before searching sessions", async () => {
    const { gateway } = createGateway(true, { methods: ["sessions.search"] });
    const list = vi.fn(async () => createSessionResult("agent:main:test", "Test"));
    const { palette } = await mountPalette(createContext(gateway, list));

    await enterQuery(palette, "n");
    await vi.advanceTimersByTimeAsync(50);

    expect(list).not.toHaveBeenCalled();
  });

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

  it("shows a search failure instead of a false empty result", async () => {
    const { gateway } = createGateway(true);
    const list = vi
      .fn<ApplicationContext<RouteId>["sessions"]["list"]>()
      .mockRejectedValueOnce(new Error("store needs doctor migration"))
      .mockResolvedValueOnce(createSessionResult("agent:main:zz", "Recovered chat"));
    const { palette } = await mountPalette(createContext(gateway, list));
    // The query matches no navigation item, so a swallowed search failure
    // would render the plain "No results" empty state.
    await enterQuery(palette, "zzz-unmatched");
    await vi.advanceTimersByTimeAsync(50);
    await palette.updateComplete;

    expect(list).toHaveBeenCalledOnce();
    expect(palette.textContent).toContain("Chat search failed");
    expect(palette.textContent).not.toContain("No results");

    // A new keystroke clears the failure state and retries cleanly.
    await enterQuery(palette, "zz");
    await palette.updateComplete;
    expect(palette.textContent).not.toContain("Chat search failed");
    await vi.advanceTimersByTimeAsync(50);
    await palette.updateComplete;
    expect(palette.textContent).toContain("Recovered chat");
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

    const item = palette.querySelector<HTMLButtonElement>("#cmd-palette-option-nav-plugins");
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

      expect(palette.querySelectorAll("#cmd-palette-option-panel-desktop")).toHaveLength(
        expectedCount,
      );
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
      palette.querySelector<HTMLElement>("#cmd-palette-option-panel-desktop")?.click();
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

      expect(palette.querySelectorAll("#cmd-palette-option-panel-custodian")).toHaveLength(
        expectedCount,
      );
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
      palette.querySelector<HTMLElement>("#cmd-palette-option-panel-custodian")?.click();
    } finally {
      window.removeEventListener(CUSTODIAN_PANEL_TOGGLE_EVENT, listener);
    }

    expect(events).toHaveLength(1);
    expect(events[0]?.detail).toEqual({ open: true });
  });
});
