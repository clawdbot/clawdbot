/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

function createGateway(connected: boolean): GatewayHarness {
  const client = {} as GatewayBrowserClient;
  let snapshot: ApplicationGatewaySnapshot = {
    client,
    phase: connected ? "connected" : "reconnecting",
    offlineStable: false,
    canvasPluginSurfaceUrl: null,
    hello: null,
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
    sessions: {
      list,
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
    await vi.advanceTimersByTimeAsync(250);
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
    await vi.advanceTimersByTimeAsync(250);
    expect(list).toHaveBeenCalledOnce();

    harness.setConnected(false);
    stale.resolve(createSessionResult("agent:main:stale", "Stale chat"));
    await Promise.resolve();
    expect(palette.textContent).not.toContain("Stale chat");

    harness.setConnected(true);
    await palette.updateComplete;
    await vi.advanceTimersByTimeAsync(250);
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
    await vi.advanceTimersByTimeAsync(250);
    expect(initialList).toHaveBeenCalledOnce();

    stale.resolve(createSessionResult("agent:main:stale", "Stale chat"));
    provider.setContext(createContext(replacement.gateway, replacementList));
    await palette.updateComplete;
    await vi.advanceTimersByTimeAsync(250);
    await palette.updateComplete;

    expect(replacementList).toHaveBeenCalledOnce();
    expect(palette.textContent).toContain("Fresh chat");
    expect(palette.textContent).not.toContain("Stale chat");
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
    await vi.advanceTimersByTimeAsync(250);
    await palette.updateComplete;

    expect(list).toHaveBeenCalledOnce();
    expect(palette.textContent).toContain("Chat search failed");
    expect(palette.textContent).not.toContain("No results");

    // A new keystroke clears the failure state and retries cleanly.
    await enterQuery(palette, "zz");
    await palette.updateComplete;
    expect(palette.textContent).not.toContain("Chat search failed");
    await vi.advanceTimersByTimeAsync(250);
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
