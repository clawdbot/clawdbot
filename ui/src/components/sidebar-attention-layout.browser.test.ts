import { afterEach, describe, expect, it } from "vitest";
import "../test-helpers/load-styles.ts";
import "../styles/hub-tabs.css";
import "../styles/sidebar-footer-update.css";
import "../styles/sidebar-issues.css";
import "./web-awesome-tabs.ts";
// Upgrade the real element: the floating layout once regressed because a base
// class stamped inline `display: contents`, which only a live upgrade reveals.
import "./sidebar-attention.ts";

afterEach(() => {
  document.body.replaceChildren();
  document.documentElement.classList.remove(
    "openclaw-native-nav",
    "openclaw-native-macos",
    "openclaw-native-web-chrome",
  );
});

describe.runIf("__vitest_browser__" in globalThis)("Inbox panel layout", () => {
  it("positions collapsed sidebar attention beyond chrome controls", () => {
    const shell = document.createElement("div");
    shell.className = "shell shell--nav-collapsed";
    shell.innerHTML = `
      <div class="shell-chrome-controls">
        <button class="shell-chrome-controls__button"></button>
        <button class="shell-chrome-controls__button"></button>
        <button class="shell-chrome-controls__button"></button>
        <button class="shell-chrome-controls__button shell-chrome-controls__custodian"></button>
      </div>
      <main class="content">
        <openclaw-sidebar-attention class="sidebar-attention--floating">
          <button class="sidebar-issues-button"></button>
        </openclaw-sidebar-attention>
      </main>
    `;
    document.body.append(shell);

    const attention = shell.querySelector<HTMLElement>("openclaw-sidebar-attention")!;
    const chrome = shell.querySelector<HTMLElement>(".shell-chrome-controls")!;
    const inbox = attention.querySelector<HTMLElement>(".sidebar-issues-button")!;

    expect(getComputedStyle(attention).position).toBe("fixed");
    expect(getComputedStyle(attention).display).toBe("flex");
    expect(attention.getBoundingClientRect().left).toBeGreaterThanOrEqual(
      chrome.getBoundingClientRect().right + 8,
    );
    expect(Number.parseFloat(getComputedStyle(inbox).borderTopWidth)).toBeGreaterThan(0);

    document.documentElement.classList.add("openclaw-native-nav");
    expect(attention.getBoundingClientRect().left).toBeGreaterThanOrEqual(8);

    document.documentElement.classList.add("openclaw-native-macos");
    expect(getComputedStyle(attention).top).toBe("52px");

    document.documentElement.classList.add("openclaw-native-web-chrome");
    expect(getComputedStyle(attention).left).toBe("16px");
  });

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

  it("keeps mobile dismiss actions visible and touch-sized", () => {
    const shell = document.createElement("div");
    shell.className = "shell shell--mobile-nav";
    shell.innerHTML = `
      <section class="sidebar-issues-panel">
        <header class="sidebar-issues-panel__header">
          <button class="sidebar-issues-panel__dismiss-shown" type="button">Dismiss shown</button>
        </header>
        <div class="sidebar-issues-panel__summary">
          <button class="sidebar-issues-panel__dismiss" type="button">Dismiss</button>
        </div>
      </section>
    `;
    document.body.append(shell);

    const dismiss = shell.querySelector<HTMLElement>(".sidebar-issues-panel__dismiss")!;
    const dismissShown = shell.querySelector<HTMLElement>(".sidebar-issues-panel__dismiss-shown")!;
    const style = getComputedStyle(dismiss);

    expect(style.opacity).toBe("1");
    expect(style.pointerEvents).not.toBe("none");
    expect(dismiss.getBoundingClientRect().width).toBeGreaterThanOrEqual(40);
    expect(dismiss.getBoundingClientRect().height).toBeGreaterThanOrEqual(40);
    expect(dismissShown.getBoundingClientRect().height).toBeGreaterThanOrEqual(40);
  });
});
