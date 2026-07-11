import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import type { WorkspaceWidget, WidgetManifestView } from "../lib/workspace/types.ts";
import type { BuiltinWidgetContext } from "../lib/workspace/widgets/index.ts";
import {
  displayWidgetTitle,
  renderCustomWidget,
  renderWidgetBody,
  renderWidgetCell,
  type WorkspaceCustomWidgetContext,
  type WorkspaceWidgetCellCallbacks,
} from "./workspace-widget-cell.ts";

const BUILTIN_CONTEXT: BuiltinWidgetContext = {
  basePath: "",
  embed: { embedSandboxMode: "strict", allowExternalEmbedUrls: false },
};

function noopCallbacks(): WorkspaceWidgetCellCallbacks {
  return {
    onToggleCollapse: vi.fn(),
    onToggleMenu: vi.fn(),
    onHide: vi.fn(),
    onRemove: vi.fn(),
    onEditTitle: vi.fn(),
    onMoveToTab: vi.fn(),
    onMovePointerDown: vi.fn(),
    onResizePointerDown: vi.fn(),
    onKeyboardNudge: vi.fn(),
  };
}

function widget(overrides: Partial<WorkspaceWidget> = {}): WorkspaceWidget {
  return {
    id: "w1",
    kind: "builtin:stat-card",
    title: "Revenue",
    grid: { x: 0, y: 0, w: 4, h: 2 },
    collapsed: false,
    ...overrides,
  };
}

function renderToContainer(template: unknown): HTMLElement {
  const container = document.createElement("div");
  render(template as never, container);
  return container;
}

describe("workspace widget cell", () => {
  it("renders the title bar with collapse and menu affordances", () => {
    const container = renderToContainer(
      renderWidgetCell({
        widget: widget(),
        binding: { value: 1000 },
        menuOpen: false,
        pending: false,
        dragging: false,
        builtinContext: BUILTIN_CONTEXT,
        callbacks: noopCallbacks(),
      }),
    );
    expect(container.querySelector(".workspace-widget__title")?.textContent).toContain("Revenue");
    expect(container.querySelector(".workspace-widget__collapse")).not.toBeNull();
    expect(container.querySelector(".workspace-widget__menu-toggle")).not.toBeNull();
    // Not collapsed → body + resize handle present.
    expect(container.querySelector(".workspace-widget__resize")).not.toBeNull();
  });

  it("strips a trailing (custom) suffix from the visible title but keeps the full title attr (#8)", () => {
    const container = renderToContainer(
      renderWidgetCell({
        widget: widget({ title: "Revenue (custom)" }),
        binding: { value: 1 },
        menuOpen: false,
        pending: false,
        dragging: false,
        builtinContext: BUILTIN_CONTEXT,
        callbacks: noopCallbacks(),
      }),
    );
    const title = container.querySelector(".workspace-widget__title");
    expect(title?.textContent?.trim()).toBe("Revenue");
    expect(title?.getAttribute("title")).toBe("Revenue (custom)");
  });

  it("displayWidgetTitle drops only a trailing (custom) suffix (#8)", () => {
    expect(displayWidgetTitle("Notes (custom)")).toBe("Notes");
    expect(displayWidgetTitle("Notes")).toBe("Notes");
    expect(displayWidgetTitle("My (custom) widget")).toBe("My (custom) widget");
    // Degenerate: a bare suffix falls back to the original rather than an empty title.
    expect(displayWidgetTitle("(custom)")).toBe("(custom)");
  });

  it("renders a provenance chip for agent-authored widgets", () => {
    const container = renderToContainer(
      renderWidgetCell({
        widget: widget({ createdBy: "agent:finance" }),
        binding: { value: 1 },
        menuOpen: false,
        pending: false,
        dragging: false,
        builtinContext: BUILTIN_CONTEXT,
        callbacks: noopCallbacks(),
      }),
    );
    const chip = container.querySelector(".workspace-widget__provenance");
    expect(chip).not.toBeNull();
    expect(chip?.getAttribute("title")).toContain("finance");
  });

  it("omits the provenance chip for user-authored widgets", () => {
    const container = renderToContainer(
      renderWidgetCell({
        widget: widget({ createdBy: "user" }),
        binding: { value: 1 },
        menuOpen: false,
        pending: false,
        dragging: false,
        builtinContext: BUILTIN_CONTEXT,
        callbacks: noopCallbacks(),
      }),
    );
    expect(container.querySelector(".workspace-widget__provenance")).toBeNull();
  });

  it("hides the body and resize handle when collapsed", () => {
    const container = renderToContainer(
      renderWidgetCell({
        widget: widget({ collapsed: true }),
        binding: { value: 1 },
        menuOpen: false,
        pending: false,
        dragging: false,
        builtinContext: BUILTIN_CONTEXT,
        callbacks: noopCallbacks(),
      }),
    );
    expect(container.querySelector(".workspace-widget__body")).toBeNull();
    expect(container.querySelector(".workspace-widget__resize")).toBeNull();
  });

  it("opens the kebab menu with hide/remove/edit/move items", () => {
    const container = renderToContainer(
      renderWidgetCell({
        widget: widget(),
        binding: { value: 1 },
        menuOpen: true,
        pending: false,
        dragging: false,
        builtinContext: BUILTIN_CONTEXT,
        callbacks: noopCallbacks(),
      }),
    );
    const items = container.querySelectorAll(".workspace-widget__menu-item");
    expect(items.length).toBe(4);
  });

  it("renders a stat-card value formatted as currency", () => {
    const container = renderToContainer(
      renderWidgetBody(
        widget({ props: { format: "usd", label: "Q3 Revenue" } }),
        { value: 1234 },
        BUILTIN_CONTEXT,
        noopCallbacks(),
      ),
    );
    expect(container.querySelector(".workspace-stat__value")?.textContent).toContain("$1,234");
    expect(container.querySelector(".workspace-stat__label")?.textContent).toContain("Q3 Revenue");
  });

  it("renders markdown widget content", () => {
    const container = renderToContainer(
      renderWidgetBody(
        widget({ kind: "builtin:markdown" }),
        { value: "# Hello" },
        BUILTIN_CONTEXT,
        noopCallbacks(),
      ),
    );
    expect(container.querySelector(".workspace-markdown h1")?.textContent).toContain("Hello");
  });

  it("catches a widget render throw with a per-cell error card", () => {
    // A binding error triggers the error boundary; the card stays mounted.
    const container = renderToContainer(
      renderWidgetBody(widget(), { error: "binding failed" }, BUILTIN_CONTEXT, noopCallbacks()),
    );
    const errorCard = container.querySelector('[data-test-id="workspace-widget-error"]');
    expect(errorCard).not.toBeNull();
    expect(errorCard?.textContent).toContain("binding failed");
  });

  it("renders a placeholder for custom widgets in L3", () => {
    const container = renderToContainer(
      renderWidgetBody(widget({ kind: "custom:chart" }), null, BUILTIN_CONTEXT, noopCallbacks()),
    );
    expect(container.querySelector(".workspace-widget__placeholder")).not.toBeNull();
  });
});

function customManifest(): WidgetManifestView {
  return {
    name: "chart",
    frameToken: "11111111-1111-4111-8111-111111111111",
    entrypoint: "index.html",
    bindings: { value: { source: "static", value: null } },
    capabilities: ["data:read"],
  };
}

function customContext(
  overrides: Partial<WorkspaceCustomWidgetContext> = {},
): WorkspaceCustomWidgetContext {
  return {
    status: "approved",
    createdBy: "user",
    manifest: customManifest(),
    host: { client: null, basePath: "", sessionKey: "main" },
    onApprove: vi.fn(),
    onReject: vi.fn(),
    ...overrides,
  };
}

describe("renderCustomWidget (L5 dispatch)", () => {
  it("renders the sandboxed iframe host for an approved widget", () => {
    const container = renderToContainer(
      renderCustomWidget(widget({ kind: "custom:chart" }), customContext()),
    );
    const iframe = container.querySelector("iframe");
    expect(iframe?.getAttribute("sandbox")).toBe("allow-scripts");
  });

  it("holds without an iframe when approved but the manifest has not loaded", () => {
    const container = renderToContainer(
      renderCustomWidget(widget({ kind: "custom:chart" }), customContext({ manifest: null })),
    );
    expect(container.querySelector("iframe")).toBeNull();
    expect(container.querySelector('[data-test-id="workspace-custom-loading"]')).not.toBeNull();
  });

  it("renders the pending approval card with Approve/Reject and NO iframe", () => {
    const onApprove = vi.fn();
    const onReject = vi.fn();
    const container = renderToContainer(
      renderCustomWidget(
        widget({ kind: "custom:chart", createdBy: "agent:layout" }),
        customContext({
          status: "pending",
          createdBy: "agent:scaffold",
          manifest: null,
          onApprove,
          onReject,
        }),
      ),
    );
    expect(container.querySelector("iframe")).toBeNull();
    const pending = container.querySelector('[data-test-id="workspace-custom-pending"]');
    expect(pending).not.toBeNull();
    expect(pending?.textContent).toContain("scaffold");
    expect(pending?.textContent).not.toContain("layout");
    container
      .querySelector<HTMLButtonElement>('[data-test-id="workspace-custom-approve"]')
      ?.click();
    container.querySelector<HTMLButtonElement>('[data-test-id="workspace-custom-reject"]')?.click();
    expect(onApprove).toHaveBeenCalledOnce();
    expect(onReject).toHaveBeenCalledOnce();
  });

  it("renders a neutral placeholder (no iframe) for a rejected widget", () => {
    const container = renderToContainer(
      renderCustomWidget(widget({ kind: "custom:chart" }), customContext({ status: "rejected" })),
    );
    expect(container.querySelector("iframe")).toBeNull();
    expect(container.querySelector('[data-test-id="workspace-custom-rejected"]')).not.toBeNull();
  });

  it("never builds an iframe for a pending widget even via the full cell", () => {
    const container = renderToContainer(
      renderWidgetCell({
        widget: widget({ kind: "custom:chart" }),
        binding: null,
        builtinContext: BUILTIN_CONTEXT,
        menuOpen: false,
        pending: false,
        dragging: false,
        callbacks: noopCallbacks(),
        custom: customContext({ status: "pending", manifest: null }),
      }),
    );
    expect(container.querySelector("iframe")).toBeNull();
    expect(container.querySelector('[data-test-id="workspace-custom-pending"]')).not.toBeNull();
  });
});
