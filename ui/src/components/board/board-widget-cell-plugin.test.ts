import { afterEach, describe, expect, it, vi } from "vitest";
import { GatewayRequestError } from "../../api/gateway.ts";
import type { ApplicationContext } from "../../app/context.ts";
import type { BoardWidget } from "../../lib/board/types.ts";
import { createApplicationContextProvider } from "../../test-helpers/application-context.ts";
import type { BoardWidgetCellCallbacks } from "./board-widget-cell.ts";
import "./board-widget-cell.ts";

function callbacks(): BoardWidgetCellCallbacks {
  const noAction = vi.fn(async () => undefined);
  return {
    appViewGeneration: () => 0,
    grant: noAction,
    movePointerDown: vi.fn(),
    resizePointerDown: vi.fn(),
    moveToTab: noAction,
    resizeTo: noAction,
    setHeightMode: noAction,
    reportContentHeight: vi.fn(),
    remove: noAction,
    nudge: noAction,
    focus: vi.fn(),
    focusChanged: vi.fn(),
    frameLoadFailed: noAction,
    widgetAppView: vi.fn(async () => ({ status: "stale" as const, error: "unused" })),
    refreshWidgetAppView: vi.fn(async () => ({ status: "stale" as const, error: "unused" })),
  };
}

afterEach(() => {
  document.body.replaceChildren();
});

// The session progress element arrives via a lazy chunk; a cold transform can
// exceed vi.waitFor's 1s default on loaded machines, so these waits get a
// real budget instead of flaking.
const CHUNK_LOAD_WAIT = { timeout: 10_000 };

describe("plugin board widget cells", () => {
  it.each([false, true])(
    "preserves a removable unavailable widget (Labs disabled: %s)",
    async (labsDisabled) => {
      const widget: BoardWidget = {
        name: "work-item",
        tabId: "main",
        title: "Work item",
        contentKind: "plugin",
        pluginKind: "custom-review:card",
        props: { cardId: "card-123" },
        sizeW: 6,
        sizeH: 4,
        position: 0,
        grantState: "none",
        revision: 1,
      };
      const cellCallbacks = callbacks();
      const navigate = vi.fn();
      const provider = createApplicationContextProvider({
        basePath: "/console",
        navigate,
        gateway: { snapshot: { phase: "connected" } },
        plugins: {
          errors: labsDisabled
            ? [
                {
                  pluginId: "custom-review",
                  code: "custom-plugin-ui-disabled",
                  message: "Disabled",
                },
              ]
            : [],
          registrations: () => [],
          isLoading: () => false,
          subscribe: () => () => undefined,
        },
      } as unknown as ApplicationContext);
      const cell = document.createElement("openclaw-board-widget-cell");
      cell.widget = widget;
      cell.rect = { name: widget.name, x: 0, y: 0, w: 6, h: 4 };
      cell.sessionKey = "agent:main:test";
      cell.callbacks = cellCallbacks;
      provider.append(cell);
      document.body.append(provider);
      await cell.updateComplete;

      const placeholder = cell.querySelector('[data-test-id="board-disabled-plugin"]');
      expect(placeholder?.textContent).toContain(
        labsDisabled ? "Custom plugin UI is off" : "Widget from disabled plugin custom-review",
      );
      expect(cell.widget).toBe(widget);
      expect(cellCallbacks.remove).not.toHaveBeenCalled();
      const labsLink = placeholder?.querySelector<HTMLAnchorElement>(
        'a[href="/console/settings/labs"]',
      );
      if (labsDisabled) {
        expect(labsLink?.textContent?.trim()).toBe("Open Labs");
        labsLink?.click();
        expect(navigate).toHaveBeenCalledExactlyOnceWith("labs");
        expect(cellCallbacks.remove).not.toHaveBeenCalled();
      } else {
        expect(labsLink).toBeNull();
      }
      const removeButton = placeholder?.querySelector("button");
      expect(removeButton).not.toBeNull();
      removeButton?.click();
      await vi.waitFor(() => expect(cellCallbacks.remove).toHaveBeenCalledWith(widget));
    },
  );

  it("renders an advertised session progress card and its empty state", async () => {
    const dashboardSessionKey = "agent:main:dashboard";
    const targetSessionKey = "agent:main:target";
    const responses = [
      {
        props: { sessionKey: targetSessionKey },
        response: {
          card: {
            sessionKey: targetSessionKey,
            revision: 1,
            updatedAt: 1,
            markdown: "**Release** validation is active.",
            steps: [{ step: "Run focused checks", status: "in_progress" }],
          },
        },
        text: "Run focused checks",
        requestedSessionKey: targetSessionKey,
      },
      {
        props: undefined,
        response: { card: null },
        text: "No progress card yet",
        requestedSessionKey: dashboardSessionKey,
      },
    ] as const;

    for (const [index, scenario] of responses.entries()) {
      const request = vi.fn(async () => scenario.response);
      const context = {
        gateway: {
          snapshot: {
            phase: "connected",
            client: { request },
            hello: {
              features: { methods: ["progressCard.get"] },
              controlUiWidgetKinds: [
                { pluginId: "session", kind: "session:progress", label: "Session progress" },
              ],
            },
          },
          subscribe: () => () => undefined,
          subscribeEvents: () => () => undefined,
        },
      } as unknown as ApplicationContext;
      const widget: BoardWidget = {
        name: `session-progress-${index}`,
        tabId: "main",
        title: "Session progress",
        contentKind: "plugin",
        pluginKind: "session:progress",
        ...(scenario.props ? { props: scenario.props } : {}),
        sizeW: 6,
        sizeH: 4,
        position: index,
        grantState: "none",
        revision: 1,
      };
      const provider = createApplicationContextProvider(context);
      const cell = document.createElement("openclaw-board-widget-cell");
      cell.widget = widget;
      cell.rect = { name: widget.name, x: 0, y: index * 4, w: 6, h: 4 };
      cell.sessionKey = dashboardSessionKey;
      cell.active = index !== 0;
      cell.callbacks = callbacks();
      provider.append(cell);
      document.body.append(provider);

      if (index === 0) {
        await cell.updateComplete;
        expect(request).not.toHaveBeenCalled();
        cell.active = true;
      }

      await vi.waitFor(
        () =>
          expect(cell.querySelector("openclaw-session-progress-widget")?.textContent).toContain(
            scenario.text,
          ),
        CHUNK_LOAD_WAIT,
      );
      expect(request).toHaveBeenCalledWith("progressCard.get", {
        sessionKey: scenario.requestedSessionKey,
      });
    }
  });

  it("surfaces a failed session progress read and retries it", async () => {
    const sessionKey = "agent:main:protected";
    let attempts = 0;
    const deniedSessionKey = "agent:main:private";
    const request = vi.fn(async (_method: string, params: { sessionKey: string }) => {
      if (params.sessionKey === deniedSessionKey) {
        throw new GatewayRequestError({
          code: "INVALID_REQUEST",
          message: "session is private for this connection",
          details: { code: "SESSION_PARTICIPATION_REQUIRED" },
        });
      }
      attempts += 1;
      if (attempts === 1) {
        throw new Error("session not shared");
      }
      return {
        card: {
          sessionKey,
          revision: 1,
          updatedAt: 1,
          steps: [{ step: "Recovered progress", status: "in_progress" }],
        },
      };
    });
    const context = {
      gateway: {
        snapshot: {
          phase: "connected",
          client: { request },
          hello: {
            features: { methods: ["progressCard.get"] },
            controlUiWidgetKinds: [
              { pluginId: "session", kind: "session:progress", label: "Session progress" },
            ],
          },
        },
        subscribe: () => () => undefined,
        subscribeEvents: () => () => undefined,
      },
    } as unknown as ApplicationContext;
    const widget: BoardWidget = {
      name: "protected-session-progress",
      tabId: "main",
      title: "Session progress",
      contentKind: "plugin",
      pluginKind: "session:progress",
      props: { sessionKey },
      sizeW: 6,
      sizeH: 4,
      position: 0,
      grantState: "none",
      revision: 1,
    };
    const provider = createApplicationContextProvider(context);
    const cell = document.createElement("openclaw-board-widget-cell");
    cell.widget = widget;
    cell.rect = { name: widget.name, x: 0, y: 0, w: 6, h: 4 };
    cell.sessionKey = "agent:main:dashboard";
    cell.callbacks = callbacks();
    provider.append(cell);
    document.body.append(provider);

    await vi.waitFor(
      () => expect(cell.querySelector('[data-test-id="session-progress-error"]')).not.toBeNull(),
      CHUNK_LOAD_WAIT,
    );
    cell
      .querySelector<HTMLButtonElement>('[data-test-id="session-progress-error"] button')
      ?.click();

    await vi.waitFor(
      () =>
        expect(cell.querySelector("openclaw-session-progress-widget")?.textContent).toContain(
          "Recovered progress",
        ),
      CHUNK_LOAD_WAIT,
    );
    expect(request).toHaveBeenCalledTimes(2);

    cell.widget = { ...widget, props: { sessionKey: deniedSessionKey } };
    await vi.waitFor(
      () =>
        expect(
          cell.querySelector('[data-test-id="session-progress-error"]')?.textContent,
        ).toContain("Select a session you can access or change sharing for this session."),
      CHUNK_LOAD_WAIT,
    );
    expect(cell.querySelector('[data-test-id="session-progress-error"] button')).toBeNull();
    expect(request).toHaveBeenCalledTimes(3);
  });
});
