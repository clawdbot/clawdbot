// Data-shape mapping tests for the L4 builtin widgets: each `map*` turns an RPC
// payload fixture into the rendered view model. The render fns are exercised
// separately (empty/populated) to lock the empty/loading/error affordances.

import { render } from "lit";
import { describe, expect, it } from "vitest";
import type { WorkspaceWidget } from "../types.ts";
import { renderActivity } from "./activity.ts";
import { renderCron } from "./cron.ts";
import { renderIframeEmbed } from "./iframe-embed.ts";
import { renderInstances } from "./instances.ts";
import { renderMarkdown } from "./markdown.ts";
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
};

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
