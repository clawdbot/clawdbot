/* @vitest-environment jsdom */

import { render } from "lit";
import { afterEach, describe, expect, it } from "vitest";
import { icons } from "./icons.ts";

afterEach(() => {
  document.body.replaceChildren();
});

describe("vendored stroke icons", () => {
  it("exposes the shared presentation marker and SVG stroke contract", () => {
    const container = document.createElement("div");
    document.body.append(container);
    render(icons.search, container);

    const svg = container.querySelector("svg");
    expect(svg?.hasAttribute("data-lucide-icon")).toBe(true);
    expect(svg?.getAttribute("fill")).toBe("none");
    expect(svg?.getAttribute("stroke")).toBe("currentColor");
    expect(svg?.getAttribute("stroke-linecap")).toBe("round");
    expect(svg?.getAttribute("stroke-linejoin")).toBe("round");
  });

  it("renders the semantic ellipsis as three solid dots", () => {
    const container = document.createElement("div");
    document.body.append(container);
    render(icons.ellipsis, container);

    const circles = [...container.querySelectorAll("circle")];
    expect(circles).toHaveLength(3);
    expect(circles.every((circle) => circle.getAttribute("fill") === "currentColor")).toBe(true);
    expect(circles.every((circle) => circle.getAttribute("stroke") === "none")).toBe(true);
  });
});
