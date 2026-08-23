import { afterEach, describe, expect, it } from "vitest";
import "../styles/sidebar-issues.css";
import "./web-awesome-tabs.ts";

afterEach(() => document.body.replaceChildren());

describe.runIf("__vitest_browser__" in globalThis)("Inbox panel layout", () => {
  it("keeps tabs compact and item rails flush with the scrollport", async () => {
    const fixture = document.createElement("section");
    fixture.className = "sidebar-issues-panel";
    fixture.style.position = "static";
    fixture.style.width = "390px";
    fixture.style.height = "220px";
    fixture.innerHTML = `
      <wa-tab-group class="sidebar-issues-panel__tabs" without-scroll-controls>
        ${["All", "Approvals", "Automations", "System"]
          .map(
            (label, index) => `<wa-tab
              slot="nav"
              class="sidebar-issues-panel__tab"
              panel="tab-${index}"
              ${index === 0 ? "active" : ""}
            ><span>${label}</span><span class="sidebar-issues-panel__tab-count">${index}</span></wa-tab>`,
          )
          .join("")}
      </wa-tab-group>
      <div class="sidebar-issues-panel__list-wrap">
        <div class="sidebar-issues-panel__list">
          ${Array.from(
            { length: 6 },
            (_, index) => `<div data-attention-kind="cronFailed">
              <div class="sidebar-issues-panel__summary">Inbox item ${index}</div>
            </div>`,
          ).join("")}
        </div>
      </div>
    `;
    document.body.append(fixture);

    await customElements.whenDefined("wa-tab-group");
    const group = fixture.querySelector<HTMLElement & { updateComplete: Promise<unknown> }>(
      ".sidebar-issues-panel__tabs",
    );
    const tab = fixture.querySelector<HTMLElement & { updateComplete: Promise<unknown> }>(
      ".sidebar-issues-panel__tab",
    );
    expect(group).not.toBeNull();
    expect(tab).not.toBeNull();
    await group?.updateComplete;
    await tab?.updateComplete;

    const base = tab?.shadowRoot?.querySelector<HTMLElement>("[part='base']");
    const label = tab?.querySelector<HTMLElement>("span:first-child");
    const count = tab?.querySelector<HTMLElement>(".sidebar-issues-panel__tab-count");
    const list = fixture.querySelector<HTMLElement>(".sidebar-issues-panel__list");
    const item = fixture.querySelector<HTMLElement>("[data-attention-kind]");
    const summary = fixture.querySelector<HTMLElement>(".sidebar-issues-panel__summary");

    expect(group?.scrollWidth).toBe(group?.clientWidth);
    expect(getComputedStyle(group!).overflowX).toBe("hidden");
    expect(getComputedStyle(base!).padding).toBe("4px 8px");
    expect(
      count!.getBoundingClientRect().left - label!.getBoundingClientRect().right,
    ).toBeGreaterThan(4);
    expect(getComputedStyle(summary!).paddingBlock).toBe("8px");
    expect(item!.getBoundingClientRect().right).toBeCloseTo(list!.getBoundingClientRect().right, 1);
  });
});
