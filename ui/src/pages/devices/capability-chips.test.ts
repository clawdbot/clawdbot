/* @vitest-environment jsdom */
import { render } from "lit";
import { describe, expect, it } from "vitest";
import { renderCapabilityChips } from "./capability-chips.ts";

function renderChips(caps: string[]) {
  const container = document.createElement("div");
  render(renderCapabilityChips(caps), container);
  return container;
}

describe("device capability chips", () => {
  it("renders a known capability with its explanation and a visible SVG icon", () => {
    const container = renderChips(["browser"]);
    const chip = container.querySelector('[role="listitem"]');

    expect(chip?.textContent?.trim()).toBe("Browser");
    expect(chip?.getAttribute("title")).toBe("Browse and interact with web pages.");
    expect(chip?.querySelector("svg")?.getAttribute("stroke")).toBe("currentColor");
    expect(chip?.querySelector("svg circle")?.namespaceURI).toBe("http://www.w3.org/2000/svg");
  });

  it("collapses session runtimes into one chip listing each supported runtime once", () => {
    const runtimeCaps = [
      "claude-sessions",
      "codex-cli-sessions",
      "codex-app-server-threads",
      "opencode-sessions",
      "pi-sessions",
    ];
    const container = renderChips(["browser", ...runtimeCaps, "pi-sessions"]);
    const chips = Array.from(container.querySelectorAll('[role="listitem"]'));
    const runtimeChip = chips.find((chip) => chip.textContent?.trim() === "5 runtimes");

    expect(chips).toHaveLength(2);
    expect(runtimeChip?.getAttribute("title")).toBe(runtimeCaps.join(", "));
  });

  it.each(["custom-tools", "__proto__", "constructor"])(
    "preserves unknown capability %s as a generic chip",
    (cap) => {
      const container = renderChips([cap]);
      const chip = container.querySelector('[role="listitem"]');

      expect(chip?.textContent?.trim()).toBe(cap);
      expect(chip?.getAttribute("title")).toBe(cap);
      expect(chip?.querySelector("svg")).not.toBeNull();
    },
  );

  it.each([
    { runtimes: [], overflow: 4 },
    { runtimes: ["claude-sessions", "pi-sessions"], overflow: 5 },
  ])("bounds the grouped chip list and reports overflow: %j", ({ runtimes, overflow }) => {
    const capabilities = Array.from({ length: 20 }, (_, index) => `custom-${index}`);
    const container = renderChips([...runtimes, ...capabilities]);
    const chips = Array.from(container.querySelectorAll('[role="listitem"]'));

    expect(chips).toHaveLength(17);
    expect(chips.at(-1)?.textContent?.trim()).toBe(`+${overflow}`);
    expect(chips.at(-1)?.getAttribute("title")).toBe(`${overflow} more capabilities`);
    expect(container.textContent).toContain("custom-0");
    expect(container.textContent).not.toContain("custom-19");
  });

  it("omits the capability group when no capabilities are advertised", () => {
    expect(renderChips([]).querySelector('[role="list"]')).toBeNull();
  });
});
