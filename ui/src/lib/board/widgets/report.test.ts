// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import type { BoardReport } from "../../../../../src/boards/board-report.ts";
import type { BoardWidget } from "../types.ts";
import "./report.ts";

function widget(props: Record<string, unknown>): BoardWidget {
  return {
    name: "report",
    tabId: "main",
    title: "Weekly report",
    contentKind: "plugin",
    pluginKind: "session:report",
    props,
    sizeW: 12,
    sizeH: 8,
    position: 0,
    grantState: "none",
    revision: 1,
  };
}

async function mount(props: Record<string, unknown>) {
  const element = document.createElement("openclaw-report-widget");
  element.widget = widget(props);
  document.body.append(element);
  await element.updateComplete;
  return element;
}

afterEach(() => document.body.replaceChildren());

describe("native report widget", () => {
  it("renders escaped report data with accessible metrics, tables, charts, and links", async () => {
    const markup = '<img src="https://example.com/tracker"> stays text.';
    const report = {
      blocks: [
        { type: "text", title: "Summary", text: markup },
        { type: "metrics", items: [{ label: "Resolved", value: "24", detail: "Up by six" }] },
        {
          type: "table",
          title: "Teams",
          columns: ["Team", "Count"],
          rows: [
            ["Core", "17"],
            ["UI", "7"],
          ],
        },
        {
          type: "chart",
          title: "Trend",
          style: "line",
          points: [
            { label: "Before", value: -3 },
            { label: "After", value: 6 },
          ],
        },
        {
          type: "links",
          title: "References",
          items: [
            { label: "Details", url: "https://example.com/report", detail: "Read the source" },
          ],
        },
      ],
    } satisfies BoardReport;
    const element = await mount(report);
    expect(element.querySelector("article")?.getAttribute("aria-label")).toBe("Weekly report");
    expect(element.textContent).toContain(markup);
    expect(element.querySelector("script,img,iframe,style")).toBeNull();
    expect(element.querySelector(".board-report__metrics dt")?.textContent).toBe("Resolved");
    expect(element.querySelector(".board-report__metrics dd")?.textContent).toBe("24");
    expect(element.querySelector("caption")?.textContent?.trim()).toBe("Teams");
    expect([...element.querySelectorAll("th[scope=col]")].map((cell) => cell.textContent)).toEqual([
      "Team",
      "Count",
    ]);
    expect([...element.querySelectorAll("tbody td")].map((cell) => cell.textContent)).toEqual([
      "Core",
      "17",
      "UI",
      "7",
    ]);
    expect(element.querySelector("polyline")?.namespaceURI).toBe("http://www.w3.org/2000/svg");
    expect(
      [...element.querySelectorAll(".board-report__values dd")].map((value) => value.textContent),
    ).toEqual(["-3", "6"]);
    const link = element.querySelector("a");
    expect(link?.href).toBe("https://example.com/report");
    expect(link?.target).toBe("_blank");
    expect(link?.rel).toBe("noopener noreferrer");
  });

  it.each([
    { style: "bar", values: [0] },
    { style: "bar", values: [-5, 0, 10] },
    { style: "line", values: [0] },
    { style: "line", values: [-Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER] },
  ] as const)("keeps $style geometry finite for $values", async ({ style, values }) => {
    const element = await mount({
      blocks: [
        {
          type: "chart",
          style,
          points: values.map((value, index) => ({ label: `Point ${index + 1}`, value })),
        },
      ],
    });
    const svg = element.querySelector("svg");
    expect(svg).not.toBeNull();
    expect(svg?.outerHTML).not.toMatch(/NaN|Infinity/);
    expect(element.querySelectorAll(style === "bar" ? "rect" : "circle")).toHaveLength(
      values.length,
    );
  });

  it("updates saved data and contains invalid report content without executing it", async () => {
    const element = await mount({ blocks: [{ type: "text", text: "Original" }] });
    element.widget = widget({ blocks: [{ type: "text", text: "Updated" }] });
    await element.updateComplete;
    expect(element.textContent).toContain("Updated");
    expect(element.textContent).not.toContain("Original");
    element.widget = widget({
      blocks: [{ type: "links", items: [{ label: "Unsafe", url: "javascript:alert(1)" }] }],
    });
    await element.updateComplete;
    expect(element.querySelector('[role="alert"]')).not.toBeNull();
    expect(element.querySelector("a,iframe,script")).toBeNull();
  });
});
