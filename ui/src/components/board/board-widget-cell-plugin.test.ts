import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApplicationContext } from "../../app/context.ts";
import type { BoardViewWidget } from "../../lib/board/view-types.ts";
import { createApplicationContextProvider } from "../../test-helpers/application-context.ts";
import type { BoardWidgetCellCallbacks } from "./board-widget-cell.ts";
import "./board-widget-cell.ts";

function callbacks(): BoardWidgetCellCallbacks {
  const noAction = vi.fn(async () => undefined);
  return {
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

describe("plugin board widget cells", () => {
  it("renders a removable placeholder when the owning plugin is inactive", async () => {
    const widget: BoardViewWidget = {
      name: "work-item",
      tabId: "main",
      title: "Work item",
      contentKind: "plugin",
      pluginKind: "workboard:card",
      props: { cardId: "card-123" },
      sizeW: 6,
      sizeH: 4,
      position: 0,
      grantState: "none",
      revision: 1,
    };
    const cellCallbacks = callbacks();
    const cell = document.createElement("openclaw-board-widget-cell");
    cell.widget = widget;
    cell.rect = { name: widget.name, x: 0, y: 0, w: 6, h: 4 };
    cell.sessionKey = "agent:main:test";
    cell.callbacks = cellCallbacks;
    document.body.append(cell);
    await cell.updateComplete;

    const placeholder = cell.querySelector('[data-test-id="board-disabled-plugin"]');
    expect(placeholder?.textContent).toContain("Widget from disabled plugin workboard");
    const removeButton = placeholder?.querySelector("button");
    expect(removeButton).not.toBeNull();
    removeButton?.click();
    await vi.waitFor(() => expect(cellCallbacks.remove).toHaveBeenCalledWith(widget));
  });

  it("retries a failed plugin renderer load for the same widget kind", async () => {
    const widget: BoardViewWidget = {
      name: "work-item",
      tabId: "main",
      title: "Work item",
      contentKind: "plugin",
      pluginKind: "workboard:card",
      props: { cardId: "card-123" },
      sizeW: 6,
      sizeH: 4,
      position: 0,
      grantState: "none",
      revision: 1,
    };
    const context = {
      gateway: {
        snapshot: {
          phase: "stopped",
          hello: {
            controlUiWidgetKinds: [
              { pluginId: "workboard", kind: "workboard:card", label: "Workboard card" },
            ],
          },
        },
        subscribe: () => () => undefined,
        subscribeEvents: () => () => undefined,
      },
    } as unknown as ApplicationContext;
    const provider = createApplicationContextProvider(context);
    const cell = document.createElement("openclaw-board-widget-cell");
    cell.widget = widget;
    cell.rect = { name: widget.name, x: 0, y: 0, w: 6, h: 4 };
    cell.sessionKey = "agent:main:test";
    cell.callbacks = callbacks();
    provider.append(cell);
    document.body.append(provider);
    await vi.waitFor(() =>
      expect(cell.querySelector("openclaw-workboard-card-widget")).not.toBeNull(),
    );

    Reflect.set(cell, "pluginRenderer", null);
    Reflect.set(cell, "pluginRendererError", "chunk unavailable");
    cell.requestUpdate();
    await cell.updateComplete;
    const retry = cell.querySelector<HTMLButtonElement>(
      '[data-test-id="board-widget-error"] button',
    );
    expect(retry?.textContent?.trim()).toBe("Retry");
    retry?.click();

    await vi.waitFor(() =>
      expect(cell.querySelector("openclaw-workboard-card-widget")).not.toBeNull(),
    );
    expect(cell.querySelector('[data-test-id="board-widget-error"]')).toBeNull();
  });

  it("passes activity to a retained Workboard plugin element", async () => {
    const context = {
      gateway: {
        snapshot: {
          phase: "stopped",
          hello: {
            controlUiWidgetKinds: [
              { pluginId: "workboard", kind: "workboard:card", label: "Workboard card" },
            ],
          },
        },
        subscribe: () => () => undefined,
        subscribeEvents: () => () => undefined,
      },
    } as unknown as ApplicationContext;
    const widget: BoardViewWidget = {
      name: "work-item",
      tabId: "main",
      title: "Work item",
      contentKind: "plugin",
      pluginKind: "workboard:card",
      props: { cardId: "card-123" },
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
    cell.sessionKey = "agent:main:test";
    cell.callbacks = callbacks();
    provider.append(cell);
    document.body.append(provider);

    await vi.waitFor(() =>
      expect(cell.querySelector("openclaw-workboard-card-widget")).not.toBeNull(),
    );
    const retained = cell.querySelector("openclaw-workboard-card-widget");
    expect(retained?.active).toBe(true);

    cell.active = false;
    await cell.updateComplete;
    expect(cell.querySelector("openclaw-workboard-card-widget")).toBe(retained);
    expect(retained?.active).toBe(false);

    cell.active = true;
    await cell.updateComplete;
    expect(cell.querySelector("openclaw-workboard-card-widget")).toBe(retained);
    expect(retained?.active).toBe(true);
  });

  it.each([
    { name: "read-only board", canMutate: false, widgetReadOnly: false },
    { name: "read-only widget", canMutate: true, widgetReadOnly: true },
  ])(
    "keeps an embedded Workboard card read-only for a $name",
    async ({ canMutate, widgetReadOnly }) => {
      const request = vi.fn(async (method: string) => {
        if (method === "workboard.cards.list") {
          return {
            cards: [
              {
                id: "card-123",
                title: "Read-only embedded card",
                status: "ready",
                priority: "normal",
                labels: [],
                position: 0,
                createdAt: 1,
                updatedAt: 1,
              },
            ],
            statuses: ["ready", "running", "done"],
          };
        }
        throw new Error(`Unexpected method: ${method}`);
      });
      const context = {
        gateway: {
          snapshot: {
            phase: "connected",
            client: { request },
            hello: {
              controlUiWidgetKinds: [
                { pluginId: "workboard", kind: "workboard:card", label: "Workboard card" },
              ],
            },
          },
          subscribe: () => () => undefined,
          subscribeEvents: () => () => undefined,
        },
      } as unknown as ApplicationContext;
      const widget: BoardViewWidget = {
        name: "work-item",
        tabId: "main",
        title: "Work item",
        contentKind: "plugin",
        pluginKind: "workboard:card",
        props: { cardId: "card-123" },
        sizeW: 6,
        sizeH: 4,
        position: 0,
        grantState: "none",
        revision: 1,
      };
      if (widgetReadOnly) {
        Reflect.set(widget, "readOnly", true);
      }
      const provider = createApplicationContextProvider(context);
      const cell = document.createElement("openclaw-board-widget-cell");
      cell.widget = widget;
      cell.rect = { name: widget.name, x: 0, y: 0, w: 6, h: 4 };
      cell.sessionKey = "agent:main:test";
      cell.callbacks = callbacks();
      cell.canMutate = canMutate;
      provider.append(cell);
      document.body.append(provider);

      await vi.waitFor(() =>
        expect(cell.querySelector("openclaw-workboard-card-widget")?.textContent).toContain(
          "Read-only embedded card",
        ),
      );
      const select = cell.querySelector<HTMLSelectElement>("openclaw-workboard-card-widget select");
      expect(select).not.toBeNull();
      expect(select?.disabled).toBe(true);
      if (select) {
        select.value = "running";
        select.dispatchEvent(new Event("change"));
      }
      expect(request).not.toHaveBeenCalledWith("workboard.cards.move", expect.anything());
    },
  );
});
