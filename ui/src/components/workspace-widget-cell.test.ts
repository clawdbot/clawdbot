import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import type { WorkspaceBindingResult } from "../lib/workspace/index.ts";
import type { WorkspaceWidget, WidgetManifestView } from "../lib/workspace/types.ts";
import type { BuiltinWidgetContext } from "../lib/workspace/widgets/index.ts";
import {
  renderWidgetCell,
  type WorkspaceCustomWidgetContext,
  type WorkspaceWidgetCellCallbacks,
} from "./workspace-widget-cell.ts";

const BUILTIN_CONTEXT: BuiltinWidgetContext = {
  basePath: "",
  embed: { embedSandboxMode: "strict", allowExternalEmbedUrls: false },
  preview: { getViewport: (_widgetId, fallback) => fallback, setViewport: vi.fn() },
};

function callbacks(): WorkspaceWidgetCellCallbacks {
  return {
    onToggleCollapse: vi.fn(),
    onToggleMenu: vi.fn(),
    onCloseMenu: vi.fn(),
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

function renderCell(params: {
  widget?: WorkspaceWidget;
  binding?: WorkspaceBindingResult | null;
  custom?: WorkspaceCustomWidgetContext;
  menuOpen?: boolean;
}) {
  const container = document.createElement("div");
  render(
    renderWidgetCell({
      widget: params.widget ?? widget(),
      binding: params.binding ?? { value: 1000 },
      menuOpen: params.menuOpen ?? false,
      pending: false,
      dragging: false,
      builtinContext: BUILTIN_CONTEXT,
      callbacks: callbacks(),
      custom: params.custom,
    }),
    container,
  );
  return container;
}

describe("renderWidgetCell", () => {
  it("renders title, provenance, menu, body, and resize affordances", () => {
    const container = renderCell({
      widget: widget({ title: "Revenue (custom)", createdBy: "agent:finance" }),
      menuOpen: true,
    });
    const title = container.querySelector(".workspace-widget__title");
    expect(title?.textContent?.trim()).toBe("Revenue");
    expect(title?.getAttribute("title")).toBe("Revenue (custom)");
    expect(
      container.querySelector(".workspace-widget__provenance")?.getAttribute("title"),
    ).toContain("finance");
    expect(container.querySelectorAll(".workspace-widget__menu-item")).toHaveLength(4);
    expect(container.querySelector(".workspace-stat__value")?.textContent).toContain("1,000");
    expect(container.querySelector(".workspace-widget__resize")).not.toBeNull();
  });

  it("hides the body and resize handle when collapsed", () => {
    const container = renderCell({ widget: widget({ collapsed: true }) });
    expect(container.querySelector(".workspace-widget__body")).toBeNull();
    expect(container.querySelector(".workspace-widget__resize")).toBeNull();
  });

  it("contains binding failures inside the affected cell", () => {
    const container = renderCell({ binding: { error: "binding failed" } });
    expect(
      container.querySelector('[data-test-id="workspace-widget-error"]')?.textContent,
    ).toContain("binding failed");
  });

  it("renders approved custom widgets only after their manifest loads", () => {
    expect(
      renderCell({
        widget: widget({ kind: "custom:chart" }),
        custom: customContext(),
      })
        .querySelector("iframe")
        ?.getAttribute("sandbox"),
    ).toBe("allow-scripts");
    const loading = renderCell({
      widget: widget({ kind: "custom:chart" }),
      custom: customContext({ manifest: null }),
    });
    expect(loading.querySelector("iframe")).toBeNull();
    expect(loading.querySelector('[data-test-id="workspace-custom-loading"]')).not.toBeNull();
  });

  it("keeps pending widgets inert and routes approval actions", () => {
    const onApprove = vi.fn();
    const onReject = vi.fn();
    const candidate = widget({ kind: "custom:chart", createdBy: "agent:layout" });
    const container = renderCell({
      widget: candidate,
      custom: customContext({
        status: "pending",
        createdBy: "agent:scaffold",
        manifest: null,
        onApprove,
        onReject,
      }),
    });
    expect(container.querySelector("iframe")).toBeNull();
    expect(
      container.querySelector('[data-test-id="workspace-custom-pending"]')?.textContent,
    ).toContain("scaffold");
    container
      .querySelector<HTMLButtonElement>('[data-test-id="workspace-custom-approve"]')
      ?.click();
    container.querySelector<HTMLButtonElement>('[data-test-id="workspace-custom-reject"]')?.click();
    expect(onApprove).toHaveBeenCalledWith(candidate);
    expect(onReject).toHaveBeenCalledWith(candidate);
  });

  it("keeps rejected custom widgets iframe-free", () => {
    const container = renderCell({
      widget: widget({ kind: "custom:chart" }),
      custom: customContext({ status: "rejected", manifest: customManifest() }),
    });

    expect(container.querySelector("iframe")).toBeNull();
    expect(container.querySelector('[data-test-id="workspace-custom-rejected"]')).not.toBeNull();
  });
});
