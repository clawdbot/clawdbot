// Focused renderer tests for builtin data shapes and empty/error affordances.

import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import type { WorkspaceWidget } from "../types.ts";
import { renderActivity } from "./activity.ts";
import { renderAgentStatus } from "./agent-status.ts";
import { renderChart } from "./chart.ts";
import { renderCron } from "./cron.ts";
import {
  buildCustomWidgetApprovalsSource,
  renderCustomWidgetApprovals,
} from "./custom-widget-approvals.ts";
import { renderIframeEmbed } from "./iframe-embed.ts";
import { renderInstances } from "./instances.ts";
import { renderMarkdown } from "./markdown.ts";
import { renderPreview } from "./preview.ts";
import { renderSessions } from "./sessions.ts";
import { renderStatCard } from "./stat-card.ts";
import { renderTable } from "./table.ts";
import type { BuiltinWidgetContext } from "./types.ts";
import { renderUsage } from "./usage.ts";

function widget(overrides: Partial<WorkspaceWidget> = {}): WorkspaceWidget {
  return {
    id: "w1",
    kind: "builtin:stat-card",
    title: "Widget",
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

const STRICT_EMBED: BuiltinWidgetContext = {
  basePath: "",
  embed: { embedSandboxMode: "strict", allowExternalEmbedUrls: false },
  preview: { getViewport: (_widgetId, fallback) => fallback, setViewport: vi.fn() },
};

describe("agent-status mapping", () => {
  it("maps only keyed sessions and clamps goal progress", () => {
    const container = renderToContainer(
      renderAgentStatus(widget({ props: { limit: 2 } }), {
        sessions: [
          {
            key: "agent:one",
            displayName: "One",
            hasActiveRun: true,
            goal: { objective: "Ship the workspace", tokensUsed: 125, tokenBudget: 100 },
          },
          { key: "agent:two", status: "idle" },
          { displayName: "missing key" },
        ],
      }),
    );
    expect(container.querySelectorAll(".workspace-list__row")).toHaveLength(2);
    expect(container.textContent).toContain("Ship the workspace");
    expect(container.textContent).toContain("100");
    expect(container.textContent).not.toContain("missing key");
  });

  it("renders accessible status text and an empty state", () => {
    const populated = renderToContainer(
      renderAgentStatus(widget(), { sessions: [{ key: "agent:one", hasActiveRun: true }] }),
    );
    expect(
      populated.querySelector("[data-test-id='workspace-agent-status']")?.textContent,
    ).toContain("Busy");
    const empty = renderToContainer(renderAgentStatus(widget(), { sessions: [] }));
    expect(empty.querySelector(".workspace-widget__placeholder")).not.toBeNull();
  });
});

describe("custom-widget-approvals mapping", () => {
  it("exposes only pending custom-widget registry entries", () => {
    const decisions: Array<[string, "approved" | "rejected"]> = [];
    const source = buildCustomWidgetApprovalsSource(
      {
        schemaVersion: 1,
        workspaceVersion: 3,
        tabs: [],
        prefs: { tabOrder: [] },
        widgetsRegistry: {
          pending: { status: "pending", createdBy: "agent:builder" },
          approved: { status: "approved", createdBy: "agent:builder" },
        },
      },
      new Set(),
      (name, decision) => decisions.push([name, decision]),
    );
    expect(source.pending).toEqual([
      { id: "pending", title: "pending", requestedBy: "builder", deciding: false },
    ]);
    source.onDecide?.(source.pending[0]!, "reject");
    expect(decisions).toEqual([["pending", "rejected"]]);
  });

  it("limits rows and renders permission-aware decision controls", () => {
    const source = {
      pending: [
        { id: "one", title: "one", requestedBy: null, deciding: false },
        { id: "two", title: "two", requestedBy: "builder", deciding: false },
      ],
      onDecide: () => undefined,
    };
    const container = renderToContainer(
      renderCustomWidgetApprovals(widget({ props: { limit: 1 } }), undefined, {
        ...STRICT_EMBED,
        customWidgetApprovals: source,
      }),
    );
    expect(container.querySelectorAll(".workspace-list__row")).toHaveLength(1);
    expect(container.querySelectorAll("button")).toHaveLength(2);
    expect(container.querySelector("button")?.disabled).toBe(false);
    expect(container.textContent).toContain("Approve");
    expect(container.textContent).toContain("Reject");

    const restricted = renderToContainer(
      renderCustomWidgetApprovals(widget(), undefined, {
        ...STRICT_EMBED,
        customWidgetApprovals: { pending: source.pending },
      }),
    );
    expect(
      Array.from(restricted.querySelectorAll("button")).every((button) => button.disabled),
    ).toBe(true);
    expect(restricted.textContent).toContain("Approval permission required");
  });
});

describe("stat-card mapping", () => {
  it("renders the value and omits a duplicate label", () => {
    const container = renderToContainer(
      renderStatCard(widget({ title: "Cost", props: { label: "Cost", format: "usd" } }), 9),
    );
    expect(container.querySelector(".workspace-stat__value")?.textContent).toContain("$9");
    expect(container.querySelector(".workspace-stat__label")).toBeNull();
  });
});

describe("markdown mapping", () => {
  it("renders an empty state when there is no content", () => {
    const container = renderToContainer(renderMarkdown(widget(), ""));
    expect(container.querySelector(".workspace-widget__placeholder")).not.toBeNull();
  });
});

describe("table mapping", () => {
  const rows = [
    { name: "a", cost: 1 },
    { name: "b", cost: 2 },
    { name: "c", cost: 3 },
  ];

  it("accepts { rows } payloads and renders a +N more footer", () => {
    const container = renderToContainer(renderTable(widget({ props: { limit: 2 } }), { rows }));
    expect(container.querySelector(".workspace-table__footer")?.textContent).toContain("1");
  });

  it("renders an empty state for no rows", () => {
    const container = renderToContainer(renderTable(widget(), []));
    expect(container.querySelector(".workspace-widget__placeholder")).not.toBeNull();
  });
});

describe("sessions mapping", () => {
  it("renders a link per session and an empty state", () => {
    const populated = renderToContainer(
      renderSessions(widget(), { sessions: [{ key: "main:1", displayName: "One" }] }, "/openclaw"),
    );
    expect(populated.querySelector(".workspace-list__link")?.getAttribute("href")).toBe(
      "/openclaw/chat?session=main%3A1",
    );
    const empty = renderToContainer(renderSessions(widget(), { sessions: [] }));
    expect(empty.querySelector(".workspace-widget__placeholder")).not.toBeNull();
  });
});

describe("usage mapping", () => {
  it("renders both cost and token metrics", () => {
    const container = renderToContainer(
      renderUsage(widget(), { totals: { totalCost: 5, totalTokens: 2000 } }),
    );
    const values = [...container.querySelectorAll(".workspace-usage__value")].map(
      (n) => n.textContent,
    );
    expect(values).toHaveLength(2);
  });
});

describe("cron mapping", () => {
  it("renders an empty state without jobs", () => {
    const container = renderToContainer(renderCron(widget(), { jobs: [] }));
    expect(container.querySelector(".workspace-widget__placeholder")).not.toBeNull();
  });
});

describe("instances mapping", () => {
  it("accepts a { presence } wrapper and renders an empty state", () => {
    const populated = renderToContainer(
      renderInstances(widget(), { presence: [{ instanceId: "gw-1" }] }),
    );
    expect(populated.querySelector(".workspace-instances")).not.toBeNull();
    const empty = renderToContainer(renderInstances(widget(), []));
    expect(empty.querySelector(".workspace-widget__placeholder")).not.toBeNull();
  });
});

describe("activity mapping", () => {
  it("renders an empty state for no entries", () => {
    const container = renderToContainer(renderActivity(widget(), { entries: [] }));
    expect(container.querySelector(".workspace-widget__placeholder")).not.toBeNull();
  });
});

describe("chart mapping", () => {
  it("renders single-point and constant series visibly", () => {
    const line = renderToContainer(renderChart(widget({ props: { type: "line" } }), [5]));
    expect(line.querySelector(".workspace-chart__point")).not.toBeNull();

    const bars = renderToContainer(renderChart(widget({ props: { type: "bar" } }), [5, 5]));
    expect(
      [...bars.querySelectorAll(".workspace-chart__bars rect")].every(
        (bar) => Number(bar.getAttribute("height")) > 0.5,
      ),
    ).toBe(true);

    const zeroBars = renderToContainer(renderChart(widget({ props: { type: "bar" } }), [0, 0]));
    expect(
      [...zeroBars.querySelectorAll(".workspace-chart__bars rect")].every(
        (bar) => Number(bar.getAttribute("height")) === 0,
      ),
    ).toBe(true);
  });

  it("keeps extreme finite ranges within valid SVG coordinates", () => {
    const container = renderToContainer(
      renderChart(widget(), [-Number.MAX_VALUE, Number.MAX_VALUE]),
    );
    const points = container.querySelector("polyline")?.getAttribute("points") ?? "";
    expect(points).not.toMatch(/NaN|Infinity/);

    const constant = renderToContainer(renderChart(widget(), [Number.MAX_VALUE]));
    expect(constant.querySelector("circle")?.outerHTML).not.toMatch(/NaN|Infinity/);

    const gauge = renderToContainer(
      renderChart(widget({ props: { type: "gauge" } }), [-Number.MAX_VALUE, Number.MAX_VALUE]),
    );
    expect(gauge.querySelector(".workspace-chart__gauge")?.outerHTML).not.toMatch(/NaN|Infinity/);

    const bounded = renderToContainer(renderChart(widget({ props: { min: 0, max: 1 } }), [1e308]));
    expect(bounded.querySelector("svg")?.outerHTML).not.toMatch(/NaN|Infinity/);

    const subnormalMin = renderToContainer(
      renderChart(widget({ props: { min: Number.MIN_VALUE } }), [Number.MIN_VALUE]),
    );
    expect(subnormalMin.querySelector("svg")?.outerHTML).not.toMatch(/NaN|Infinity/);

    const subnormalMax = renderToContainer(
      renderChart(widget({ props: { max: -Number.MIN_VALUE } }), [-Number.MIN_VALUE]),
    );
    expect(subnormalMax.querySelector("svg")?.outerHTML).not.toMatch(/NaN|Infinity/);

    for (const [props, values] of [
      [{ min: 10 }, [1, 2]],
      [{ max: -10 }, [-2, -1]],
    ] as const) {
      const oneSided = renderToContainer(renderChart(widget({ props }), values));
      expect(oneSided.querySelector("svg")?.outerHTML).not.toMatch(/NaN|Infinity/);
      expect(oneSided.querySelector('[data-test-id="workspace-chart-error"]')).toBeNull();
    }
  });

  it("announces data extrema rather than configured axis bounds", () => {
    const container = renderToContainer(
      renderChart(widget({ title: "Revenue", props: { min: 0, max: 10 } }), [2, 7]),
    );
    expect(container.querySelector("svg")?.getAttribute("aria-label")).toContain(
      "ranging from 2 to 7",
    );
  });

  it("renders responsive accessible line, bar, area, sparkline, and gauge charts", () => {
    for (const type of ["line", "bar", "area", "sparkline", "gauge"] as const) {
      const container = renderToContainer(
        renderChart(widget({ title: "Revenue", props: { type, min: 0, max: 10 } }), [2, 7]),
      );
      const svg = container.querySelector('[data-test-id="workspace-chart"]');
      expect(svg?.getAttribute("role")).toBe("img");
      expect(svg?.getAttribute("aria-label")).toContain("Revenue");
      expect(svg?.getAttribute("viewBox")).toBe("0 0 100 40");
      expect(container.querySelector(`.workspace-chart--${type}`)).not.toBeNull();
    }
  });

  it("renders localized empty and invalid-data states without an svg", () => {
    const empty = renderToContainer(renderChart(widget(), []));
    expect(empty.querySelector('[data-test-id="workspace-chart-empty"]')).not.toBeNull();
    expect(empty.querySelector("svg")).toBeNull();

    for (const props of [{ min: "bad" }, { min: 10, max: 2 }, { min: 4, max: 4 }]) {
      const invalidEmpty = renderToContainer(renderChart(widget({ props }), []));
      expect(invalidEmpty.querySelector('[data-test-id="workspace-chart-error"]')).not.toBeNull();
      expect(invalidEmpty.querySelector("svg")).toBeNull();
    }

    const invalid = renderToContainer(renderChart(widget(), [1, "bad"]));
    expect(invalid.querySelector('[data-test-id="workspace-chart-error"]')).not.toBeNull();
    expect(invalid.querySelector("svg")).toBeNull();

    for (const [configuredWidget, value] of [
      [widget({ props: { type: "pie" } }), [1]],
      [widget({ props: { type: null } }), [1]],
      [widget({ props: { min: 10, max: 2 } }), [4]],
      [widget(), { points: [{ label: "missing value" }] }],
      [widget(), { points: Array.from({ length: 501 }, () => 1) }],
    ] as const) {
      const error = renderToContainer(renderChart(configuredWidget, value));
      expect(error.querySelector('[data-test-id="workspace-chart-error"]')).not.toBeNull();
      expect(error.querySelector("svg")).toBeNull();
    }
  });

  it("accepts the documented point shapes through the 500-point limit", () => {
    const wrapped = renderToContainer(
      renderChart(widget(), { points: [1, { y: 2 }, { value: 3 }] }),
    );
    expect(wrapped.querySelector('[data-test-id="workspace-chart"]')).not.toBeNull();

    const capped = renderToContainer(
      renderChart(
        widget(),
        Array.from({ length: 500 }, () => 1),
      ),
    );
    expect(capped.querySelector('[data-test-id="workspace-chart"]')).not.toBeNull();

    const denseBars = renderToContainer(
      renderChart(
        widget({ props: { type: "bar" } }),
        Array.from({ length: 500 }, (_, index) => index % 2),
      ),
    );
    const slotWidth = (100 - 2 * 2) / 500;
    expect(
      [...denseBars.querySelectorAll("rect")].every(
        (bar) => Number(bar.getAttribute("width")) <= slotWidth,
      ),
    ).toBe(true);
  });
});

describe("iframe-embed render × sandbox mode", () => {
  it("emits a sandboxed frame for an allowed URL (strict → empty sandbox attr)", () => {
    const container = renderToContainer(
      renderIframeEmbed(widget({ props: { url: "/preview" } }), null, STRICT_EMBED),
    );
    const frame = container.querySelector<HTMLIFrameElement>(
      '[data-test-id="workspace-embed-frame"]',
    );
    expect(frame).not.toBeNull();
    expect(frame?.getAttribute("sandbox")).toBe("");
  });

  it("scripts mode grants allow-scripts", () => {
    const container = renderToContainer(
      renderIframeEmbed(widget({ props: { url: "/preview" } }), null, {
        basePath: "",
        embed: { embedSandboxMode: "scripts", allowExternalEmbedUrls: false },
        preview: STRICT_EMBED.preview,
      }),
    );
    const frame = container.querySelector<HTMLIFrameElement>(
      '[data-test-id="workspace-embed-frame"]',
    );
    expect(frame?.getAttribute("sandbox")).toBe("allow-scripts");
  });

  it("never grants allow-same-origin, even when the operator trusts chat embeds", () => {
    // `props.url` is agent-authored and a builtin needs no approval, so a
    // same-origin scripted frame would hand the widget the parent's origin.
    const container = renderToContainer(
      renderIframeEmbed(widget({ props: { url: "/preview" } }), null, {
        basePath: "",
        embed: { embedSandboxMode: "trusted", allowExternalEmbedUrls: false },
        preview: STRICT_EMBED.preview,
      }),
    );
    const frame = container.querySelector<HTMLIFrameElement>(
      '[data-test-id="workspace-embed-frame"]',
    );
    expect(frame?.getAttribute("sandbox")).toBe("allow-scripts");
    expect(frame?.getAttribute("sandbox")).not.toContain("allow-same-origin");
  });

  it("shows a blocked placeholder for an external URL under strict policy", () => {
    const container = renderToContainer(
      renderIframeEmbed(widget({ props: { url: "https://evil.example" } }), null, STRICT_EMBED),
    );
    expect(container.querySelector('[data-test-id="workspace-embed-blocked"]')).not.toBeNull();
    expect(container.querySelector('[data-test-id="workspace-embed-frame"]')).toBeNull();
  });
});

describe("preview widget", () => {
  it("renders its URL with the workspace embed sandbox ceiling", () => {
    const container = renderToContainer(
      renderPreview(widget({ props: { url: "/preview" } }), undefined, {
        basePath: "",
        embed: { embedSandboxMode: "trusted", allowExternalEmbedUrls: false },
        preview: STRICT_EMBED.preview,
      }),
    );
    const frame = container.querySelector<HTMLIFrameElement>(
      '[data-test-id="workspace-preview-frame"]',
    );
    expect(frame?.getAttribute("src")).toBe("/preview");
    expect(frame?.getAttribute("sandbox")).toBe("allow-scripts");
    expect(frame?.getAttribute("sandbox")).not.toContain("allow-same-origin");
    expect(frame?.getAttribute("referrerpolicy")).toBe("no-referrer");
  });

  it("reloads the mounted frame without reading its content window", () => {
    const container = renderToContainer(
      renderPreview(widget({ props: { url: "/preview" } }), undefined, STRICT_EMBED),
    );
    const frame = container.querySelector<HTMLIFrameElement>(
      '[data-test-id="workspace-preview-frame"]',
    );
    expect(frame).not.toBeNull();
    const setAttribute = vi.spyOn(frame!, "setAttribute");
    container
      .querySelector<HTMLButtonElement>('[data-test-id="workspace-preview-reload"]')
      ?.click();
    expect(setAttribute).toHaveBeenCalledWith("src", "/preview");
  });

  it("exposes labeled controls and updates the selected viewport state", () => {
    let selected: "desktop" | "tablet" | "mobile" | undefined;
    const context: BuiltinWidgetContext = {
      ...STRICT_EMBED,
      preview: {
        getViewport: (_widgetId, fallback) => selected ?? fallback,
        setViewport: (_widgetId, viewport) => {
          selected = viewport;
        },
      },
    };
    const previewWidget = widget({ props: { url: "/preview", defaultViewport: "tablet" } });
    const container = renderToContainer(renderPreview(previewWidget, undefined, context));
    expect(container.querySelector('[role="toolbar"]')?.getAttribute("aria-label")).toBeTruthy();
    expect(container.querySelector('[role="group"]')?.getAttribute("aria-label")).toBeTruthy();
    const tablet = container.querySelector<HTMLButtonElement>(
      '[data-test-id="workspace-preview-viewport-tablet"]',
    );
    const mobile = container.querySelector<HTMLButtonElement>(
      '[data-test-id="workspace-preview-viewport-mobile"]',
    );
    expect(tablet?.getAttribute("aria-pressed")).toBe("true");
    expect(mobile?.getAttribute("aria-pressed")).toBe("false");
    mobile?.click();
    expect(selected).toBe("mobile");
    render(renderPreview(previewWidget, undefined, context), container);
    expect(
      container
        .querySelector('[data-test-id="workspace-preview-viewport-tablet"]')
        ?.getAttribute("aria-pressed"),
    ).toBe("false");
    expect(
      container
        .querySelector('[data-test-id="workspace-preview-viewport-mobile"]')
        ?.getAttribute("aria-pressed"),
    ).toBe("true");
    expect(container.querySelector(".workspace-preview__frame-wrap")?.className).toContain(
      "workspace-preview__frame-wrap--mobile",
    );
  });

  it.each(["bogus", 42])("defaults malformed viewport prop %j to desktop", (defaultViewport) => {
    const container = renderToContainer(
      renderPreview(
        widget({ props: { url: "/preview", defaultViewport } }),
        undefined,
        STRICT_EMBED,
      ),
    );

    expect(container.querySelector(".workspace-preview__frame-wrap")?.className).toContain(
      "workspace-preview__frame-wrap--desktop",
    );
  });

  it("uses a bound URL instead of props and does not hide malformed binding data", () => {
    const bound = renderToContainer(
      renderPreview(
        widget({
          props: { url: "/stale" },
          bindings: { value: { source: "static", value: "/bound" } },
        }),
        "/bound",
        STRICT_EMBED,
      ),
    );
    expect(
      bound.querySelector('[data-test-id="workspace-preview-frame"]')?.getAttribute("src"),
    ).toBe("/bound");

    const malformed = renderToContainer(
      renderPreview(
        widget({
          props: { url: "/fallback" },
          bindings: { value: { source: "static", value: 42 } },
        }),
        42,
        STRICT_EMBED,
      ),
    );
    expect(malformed.querySelector('[data-test-id="workspace-preview-frame"]')).toBeNull();

    const missing = renderToContainer(
      renderPreview(
        widget({
          props: { url: "/fallback" },
          bindings: { value: { source: "static" } },
        }),
        undefined,
        STRICT_EMBED,
      ),
    );
    expect(missing.querySelector('[data-test-id="workspace-preview-frame"]')).toBeNull();

    const unrelated = renderToContainer(
      renderPreview(
        widget({
          props: { url: "/configured" },
          bindings: { other: { source: "static", value: "/ignored" } },
        }),
        "/ignored",
        STRICT_EMBED,
      ),
    );
    expect(
      unrelated.querySelector('[data-test-id="workspace-preview-frame"]')?.getAttribute("src"),
    ).toBe("/configured");
  });

  it("allows policy-approved external URLs and blocks external or unsafe URLs by default", () => {
    const allowed = renderToContainer(
      renderPreview(
        widget({
          bindings: {
            value: { source: "static", value: "https://preview.example" },
          },
        }),
        "https://preview.example",
        {
          ...STRICT_EMBED,
          embed: { embedSandboxMode: "strict", allowExternalEmbedUrls: true },
        },
      ),
    );
    expect(
      allowed.querySelector('[data-test-id="workspace-preview-frame"]')?.getAttribute("src"),
    ).toBe("https://preview.example");

    for (const value of [undefined, 42, "https://evil.example", "javascript:alert(1)"]) {
      const container = renderToContainer(
        renderPreview(
          widget({ bindings: { value: { source: "static", value } } }),
          value,
          STRICT_EMBED,
        ),
      );
      expect(container.querySelector('[data-test-id="workspace-preview-frame"]')).toBeNull();
      expect(container.querySelector(".workspace-widget__placeholder")).not.toBeNull();
    }
  });
});
