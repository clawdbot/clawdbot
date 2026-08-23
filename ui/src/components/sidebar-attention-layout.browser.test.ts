import { afterEach, describe, expect, it } from "vitest";
import "../test-helpers/load-styles.ts";
import "../styles/hub-tabs.css";
import "../styles/sidebar-issues.css";
import "./web-awesome-tabs.ts";

afterEach(() => document.body.replaceChildren());

describe.runIf("__vitest_browser__" in globalThis)("Inbox panel layout", () => {
  it("keeps hub tabs compact and item rails flush with the scrollport", async () => {
    const fixture = document.createElement("section");
    fixture.className = "sidebar-issues-panel";
    fixture.style.position = "static";
    fixture.style.width = "390px";
    fixture.style.height = "220px";
    fixture.innerHTML = `
      <wa-tab-group class="hub-tabs hub-tabs--sub sidebar-issues-panel__tabs" without-scroll-controls>
        ${["All", "Approvals", "Automations", "System"]
          .map(
            (label, index) => `<wa-tab
              slot="nav"
              class="hub-tab"
              panel="tab-${index}"
              ${index === 0 ? "active" : ""}
            >${label}${index > 0 ? `<span class="hub-tab__badge hub-tab__badge--count">${index}</span>` : ""}</wa-tab>`,
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
    const header = document.createElement("header");
    header.className = "sidebar-issues-panel__header";
    fixture.prepend(header);
    const badgeTab = fixture.querySelectorAll<HTMLElement & { updateComplete: Promise<unknown> }>(
      ".hub-tab",
    )[1];
    expect(group).not.toBeNull();
    expect(badgeTab).not.toBeNull();
    await group?.updateComplete;
    await badgeTab?.updateComplete;

    const badge = badgeTab!.querySelector<HTMLElement>(".hub-tab__badge");
    const list = fixture.querySelector<HTMLElement>(".sidebar-issues-panel__list");
    const item = fixture.querySelector<HTMLElement>("[data-attention-kind]");
    const summary = fixture.querySelector<HTMLElement>(".sidebar-issues-panel__summary");
    const track = group!.shadowRoot?.querySelector<HTMLElement>(".tabs");

    expect(group?.scrollWidth).toBe(group?.clientWidth);
    expect(getComputedStyle(group!).overflowX).toBe("hidden");
    expect(getComputedStyle(group!).backgroundColor).toBe(getComputedStyle(header).backgroundColor);
    expect(getComputedStyle(group!).backgroundColor).not.toBe(
      getComputedStyle(list!).backgroundColor,
    );
    // The track hairline is the header/list separator; it must span the panel.
    expect(track).not.toBeNull();
    expect(Number.parseFloat(getComputedStyle(track!).borderBottomWidth)).toBeGreaterThan(0);
    expect(track!.getBoundingClientRect().width).toBeCloseTo(
      group!.getBoundingClientRect().width,
      1,
    );
    // Count badges render as pills separated from the tab label.
    expect(badge).not.toBeNull();
    expect(getComputedStyle(badge!).borderRadius).not.toBe("0px");
    expect(getComputedStyle(summary!).paddingBlock).toBe("8px");
    expect(item!.getBoundingClientRect().right).toBeCloseTo(list!.getBoundingClientRect().right, 1);
  });
});
