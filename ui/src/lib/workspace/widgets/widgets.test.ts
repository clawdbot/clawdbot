// Data-shape mapping tests for the L4 builtin widgets: each `map*` turns an RPC
// payload fixture into the rendered view model. The render fns are exercised
// separately (empty/populated) to lock the empty/loading/error affordances.

import { render } from "lit";
import { describe, expect, it } from "vitest";
import type { WorkspaceWidget } from "../types.ts";
import { mapActivity, renderActivity } from "./activity.ts";
import { mapCron, renderCron } from "./cron.ts";
import { evaluateEmbedUrl, renderIframeEmbed } from "./iframe-embed.ts";
import { mapInstances, renderInstances } from "./instances.ts";
import { mapMarkdownSource, renderMarkdown } from "./markdown.ts";
import { mapSessions, renderSessions } from "./sessions.ts";
import { mapStatCard, renderStatCard } from "./stat-card.ts";
import { mapTable, renderTable } from "./table.ts";
import type { BuiltinWidgetContext } from "./types.ts";
import { mapUsage, renderUsage } from "./usage.ts";

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
  it("selects a metric from a structured usage.cost payload", () => {
    const model = mapStatCard(
      widget({ title: "Cost Today", props: { metric: "todayCost", format: "usd" } }),
      { totals: { totalCost: 12.5, totalTokens: 4000 } },
    );
    expect(model.display).toBe("$12.50");
  });

  it("formats integer token counts", () => {
    const model = mapStatCard(widget({ props: { metric: "todayTokens", format: "int" } }), {
      totals: { totalTokens: 1234567 },
    });
    expect(model.display).toBe("1,234,567");
  });

  it("drops the inner label when it repeats the widget title (#6 nit)", () => {
    expect(
      mapStatCard(widget({ title: "Revenue", props: { label: "Revenue" } }), 1).label,
    ).toBeNull();
    expect(mapStatCard(widget({ title: "Revenue", props: { label: "Q3" } }), 1).label).toBe("Q3");
  });

  it("falls back to props.value and yields null for missing data", () => {
    expect(mapStatCard(widget({ props: { value: 5, format: "raw" } }), undefined).display).toBe(
      "5",
    );
    expect(mapStatCard(widget(), undefined).display).toBeNull();
  });

  it("renders the value and omits a duplicate label", () => {
    const container = renderToContainer(
      renderStatCard(widget({ title: "Cost", props: { label: "Cost", format: "usd" } }), 9),
    );
    expect(container.querySelector(".workspace-stat__value")?.textContent).toContain("$9");
    expect(container.querySelector(".workspace-stat__label")).toBeNull();
  });
});

describe("markdown mapping", () => {
  it("prefers the binding value, then props.markdown/text", () => {
    expect(mapMarkdownSource(widget(), "# from binding")).toBe("# from binding");
    expect(mapMarkdownSource(widget({ props: { markdown: "# props" } }), undefined)).toBe(
      "# props",
    );
    expect(mapMarkdownSource(widget({ props: { text: "plain" } }), undefined)).toBe("plain");
  });

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

  it("derives columns from the first row and limits rows with a footer count", () => {
    const model = mapTable(widget({ props: { limit: 2 } }), rows);
    expect(model.columns).toEqual(["name", "cost"]);
    expect(model.shown).toBe(2);
    expect(model.total).toBe(3);
  });

  it("honors an explicit columns picklist", () => {
    const model = mapTable(widget({ props: { columns: ["cost"] } }), rows);
    expect(model.columns).toEqual(["cost"]);
  });

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
  it("maps sessions.list rows with a live-run flag and chat link", () => {
    const model = mapSessions(widget(), {
      sessions: [
        { key: "main:1", displayName: "One", hasActiveRun: true, updatedAt: 1000 },
        { key: "main:2", label: "Two", status: "idle", updatedAt: 2000 },
        { key: "" }, // dropped: no key
      ],
    });
    expect(model.rows.map((r) => r.key)).toEqual(["main:1", "main:2"]);
    expect(model.rows[0].active).toBe(true);
    expect(model.rows[1].active).toBe(false);
  });

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
  it("reads today cost + tokens from usage.cost totals", () => {
    const model = mapUsage(widget(), { totals: { totalCost: 3.2, totalTokens: 999 } });
    expect(model.cost).toBe(3.2);
    expect(model.tokens).toBe(999);
  });

  it("defaults to zero on an empty payload", () => {
    const model = mapUsage(widget(), {});
    expect(model.cost).toBe(0);
    expect(model.tokens).toBe(0);
  });

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
  it("maps cron.list jobs to next-run + last-status", () => {
    const model = mapCron(widget(), {
      jobs: [
        {
          id: "j1",
          name: "Nightly",
          enabled: true,
          state: { nextRunAtMs: 5000, lastRunStatus: "ok" },
        },
        { id: "j2", name: "Off", enabled: false, state: { lastStatus: "error" } },
      ],
    });
    expect(model.jobs[0]).toMatchObject({ id: "j1", nextRunAtMs: 5000, lastStatus: "ok" });
    expect(model.jobs[1]).toMatchObject({ id: "j2", enabled: false, lastStatus: "error" });
  });

  it("renders an empty state without jobs", () => {
    const container = renderToContainer(renderCron(widget(), { jobs: [] }));
    expect(container.querySelector(".workspace-widget__placeholder")).not.toBeNull();
  });
});

describe("instances mapping", () => {
  it("maps system-presence entries to health dots", () => {
    const model = mapInstances(widget(), [
      { instanceId: "gw-1", mode: "gateway", lastInputSeconds: 5 },
      { host: "node-2", lastInputSeconds: 600 },
      {}, // dropped: no id
    ]);
    expect(model.instances).toHaveLength(2);
    expect(model.instances[0]).toMatchObject({ id: "gw-1", healthy: true });
    expect(model.instances[1]).toMatchObject({ id: "node-2", healthy: false });
  });

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
  it("maps cron.runs entries to a compact feed", () => {
    const model = mapActivity(widget(), {
      entries: [
        { ts: 1000, jobName: "Nightly", status: "ok", summary: "done" },
        { ts: 2000, jobId: "j2", status: "error", error: "boom" },
      ],
    });
    expect(model.entries[0]).toMatchObject({ title: "Nightly", status: "ok", detail: "done" });
    expect(model.entries[1]).toMatchObject({ title: "j2", status: "error", detail: "boom" });
  });

  it("renders an empty state for no entries", () => {
    const container = renderToContainer(renderActivity(widget(), { entries: [] }));
    expect(container.querySelector(".workspace-widget__placeholder")).not.toBeNull();
  });
});

describe("iframe-embed URL policy", () => {
  const origin = "https://control.example";

  it("allows internal (same-origin / relative) URLs regardless of external policy", () => {
    expect(evaluateEmbedUrl("/report", { allowExternalEmbedUrls: false }, origin)).toEqual({
      status: "ok",
      url: "/report",
      external: false,
    });
    expect(
      evaluateEmbedUrl("https://control.example/x", { allowExternalEmbedUrls: false }, origin),
    ).toMatchObject({ status: "ok", external: false });
  });

  it("blocks external http(s) URLs unless allowExternalEmbedUrls", () => {
    expect(
      evaluateEmbedUrl("https://evil.example", { allowExternalEmbedUrls: false }, origin),
    ).toEqual({ status: "blocked", reason: "external", url: "https://evil.example" });
    expect(
      evaluateEmbedUrl("https://evil.example", { allowExternalEmbedUrls: true }, origin),
    ).toMatchObject({ status: "ok", external: true });
  });

  it("rejects non-http(s) schemes outright", () => {
    expect(
      evaluateEmbedUrl("javascript:alert(1)", { allowExternalEmbedUrls: true }, origin),
    ).toMatchObject({ status: "blocked", reason: "scheme" });
    expect(
      evaluateEmbedUrl("data:text/html,x", { allowExternalEmbedUrls: true }, origin),
    ).toMatchObject({ status: "blocked", reason: "scheme" });
  });

  it("reports missing when no url is set", () => {
    expect(evaluateEmbedUrl(undefined, { allowExternalEmbedUrls: true }, origin)).toEqual({
      status: "missing",
    });
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
