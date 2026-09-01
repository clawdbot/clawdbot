import { render } from "lit";
import { afterEach, describe, expect, it } from "vitest";
import type { ApplicationContext } from "../app/context.ts";
import "../test-helpers/load-styles.ts";
import "../styles/hub-tabs.css";
import "../styles/sidebar-attention-floating.css";
import "../styles/sidebar-issues.css";
import "./web-awesome-tabs.ts";
// Upgrade the real element: the floating layout once regressed because a base
// class stamped inline `display: contents`, which only a live upgrade reveals.
import "./sidebar-attention.ts";
import type { SidebarInboxEntry } from "./sidebar-attention-entries.ts";
import { renderSidebarAttentionPanel } from "./sidebar-attention-panel.runtime.ts";

afterEach(() => {
  document.body.replaceChildren();
  document.documentElement.classList.remove(
    "openclaw-native-nav",
    "openclaw-native-macos",
    "openclaw-native-web-chrome",
  );
});

describe.runIf("__vitest_browser__" in globalThis)("Inbox panel layout", () => {
  it("keeps the header and tabs fixed when the selected category is empty", async () => {
    const entry: SidebarInboxEntry = {
      type: "attention",
      category: "system",
      dismissal: { kind: "modelAuthExpired", signature: "expired-profile" },
      requiresAction: true,
      severity: "warning",
      kind: "modelAuthExpired",
      icon: "plug",
      label: "Auth expired",
      detail: "Reconnect the provider.",
      action: { kind: "navigate", routeId: "config" },
      signature: "expired-profile",
    };
    const context = {
      basePath: "",
      gateway: { snapshot: undefined },
    } as unknown as ApplicationContext;

    for (const mobile of [false, true]) {
      const shell = document.createElement("div");
      shell.className = mobile ? "shell shell--mobile-nav" : "shell";
      document.body.append(shell);
      const renderPanel = (selectedTab: "all" | "approvals") => {
        render(
          renderSidebarAttentionPanel({
            context,
            entries: [entry],
            onApprovalDecision: () => {},
            onClose: () => {},
            onDismiss: () => {},
            onKeydown: () => {},
            onNavigate: () => {},
            onOpen: () => {},
            onScroll: () => {},
            onSelectTab: () => {},
            overflowAbove: false,
            overflowBelow: false,
            panelPosition: { left: 0, anchor: "top", top: 0 },
            selectedTab,
          }),
          shell,
        );
      };

      renderPanel("all");
      await customElements.whenDefined("wa-tab-group");
      const populatedHeader = shell.querySelector<HTMLElement>(".sidebar-issues-panel__header")!;
      const populatedTabs = shell.querySelector<HTMLElement>(".sidebar-issues-panel__tabs")!;
      const headerHeight = populatedHeader.getBoundingClientRect().height;
      const tabsTop = populatedTabs.getBoundingClientRect().top;

      renderPanel("approvals");
      const placeholder = shell.querySelector<HTMLButtonElement>(
        ".sidebar-issues-panel__dismiss-shown",
      )!;
      expect(placeholder.disabled).toBe(true);
      expect(placeholder.getAttribute("aria-hidden")).toBe("true");
      expect(getComputedStyle(placeholder).visibility).toBe("hidden");
      expect(
        shell.querySelector(".sidebar-issues-panel__header")!.getBoundingClientRect().height,
      ).toBe(headerHeight);
      expect(shell.querySelector(".sidebar-issues-panel__tabs")!.getBoundingClientRect().top).toBe(
        tabsTop,
      );
      shell.remove();
    }
  });

  it("positions collapsed sidebar attention beyond chrome controls", () => {
    const shell = document.createElement("div");
    shell.className = "shell shell--nav-collapsed";
    shell.innerHTML = `
      <div class="shell-chrome-controls">
        <button class="shell-chrome-controls__button"></button>
        <button class="shell-chrome-controls__button"></button>
        <button class="shell-chrome-controls__button"></button>
        <button class="shell-chrome-controls__button shell-chrome-controls__custodian"></button>
        <button class="shell-chrome-controls__button shell-chrome-controls__home"></button>
      </div>
      <nav class="macos-titlebar-controls">
        ${Array.from(
          { length: 5 },
          () => '<button class="topbar-icon-btn macos-titlebar-controls__button"></button>',
        ).join("")}
      </nav>
      <main class="content">
        <openclaw-sidebar-attention class="sidebar-attention--floating">
          <button class="sidebar-issues-button"></button>
        </openclaw-sidebar-attention>
      </main>
    `;
    document.body.append(shell);

    const attention = shell.querySelector<HTMLElement>("openclaw-sidebar-attention")!;
    const chrome = shell.querySelector<HTMLElement>(".shell-chrome-controls")!;
    const nativeChrome = shell.querySelector<HTMLElement>(".macos-titlebar-controls")!;
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
    expect(
      attention.getBoundingClientRect().left - nativeChrome.getBoundingClientRect().right,
    ).toBe(4);
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
    const shell = document.createElement("div");
    shell.className = "shell shell--mobile-nav";
    shell.append(fixture);
    document.body.append(shell);

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
    const tabs = Array.from(fixture.querySelectorAll<HTMLElement>("wa-tab.hub-tab"));

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
    const tabWidth = tabs[0]!.getBoundingClientRect().width;
    expect(tabs.every((tab) => Math.abs(tab.getBoundingClientRect().width - tabWidth) < 1)).toBe(
      true,
    );
    expect(tabs[0]!.getBoundingClientRect().left).toBeCloseTo(
      track!.getBoundingClientRect().left,
      1,
    );
    expect(tabs.at(-1)!.getBoundingClientRect().right).toBeCloseTo(
      track!.getBoundingClientRect().right,
      1,
    );
    // Count badges render as pills separated from the tab label.
    expect(badge).not.toBeNull();
    expect(getComputedStyle(badge!).borderRadius).not.toBe("0px");
    expect(getComputedStyle(summary!).paddingBlock).toBe("8px");
    expect(item!.getBoundingClientRect().right).toBeCloseTo(list!.getBoundingClientRect().right, 1);
  });

  it("keeps mobile controls touch-sized and the sheet header visually continuous", () => {
    const shell = document.createElement("div");
    shell.className = "shell shell--mobile-nav";
    shell.innerHTML = `
      <section class="sidebar-issues-panel">
        <div class="sidebar-issues-panel__grabber"></div>
        <header class="sidebar-issues-panel__header">
          <button class="sidebar-issues-panel__dismiss-shown" type="button">Dismiss shown</button>
          <button class="sidebar-brand__icon sidebar-issues-panel__mobile-close" type="button">
            Close
          </button>
        </header>
        <div class="sidebar-issues-panel__list-wrap"></div>
        <div class="sidebar-issues-panel__summary">
          <button class="sidebar-issues-panel__dismiss" type="button">Dismiss</button>
        </div>
      </section>
    `;
    document.body.append(shell);

    const dismiss = shell.querySelector<HTMLElement>(".sidebar-issues-panel__dismiss")!;
    const dismissShown = shell.querySelector<HTMLElement>(".sidebar-issues-panel__dismiss-shown")!;
    const close = shell.querySelector<HTMLElement>(".sidebar-issues-panel__mobile-close")!;
    const panel = shell.querySelector<HTMLElement>(".sidebar-issues-panel")!;
    const header = shell.querySelector<HTMLElement>(".sidebar-issues-panel__header")!;
    const list = shell.querySelector<HTMLElement>(".sidebar-issues-panel__list-wrap")!;
    const style = getComputedStyle(dismiss);

    expect(style.opacity).toBe("1");
    expect(style.pointerEvents).not.toBe("none");
    expect(dismiss.getBoundingClientRect().width).toBeGreaterThanOrEqual(40);
    expect(dismiss.getBoundingClientRect().height).toBeGreaterThanOrEqual(40);
    expect(dismissShown.getBoundingClientRect().height).toBeGreaterThanOrEqual(40);
    expect(close.getBoundingClientRect().width).toBe(36);
    expect(close.getBoundingClientRect().height).toBe(36);
    expect(getComputedStyle(close).borderTopWidth).toBe("1px");
    expect(getComputedStyle(close).borderRadius).toBe("9999px");
    expect(getComputedStyle(close).backgroundColor).not.toBe("rgba(0, 0, 0, 0)");
    expect(getComputedStyle(panel).backgroundColor).toBe(getComputedStyle(header).backgroundColor);
    expect(getComputedStyle(header).backgroundColor).not.toBe(
      getComputedStyle(list).backgroundColor,
    );
  });
});
