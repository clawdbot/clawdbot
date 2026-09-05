import { render } from "lit";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import type { MentionInboxItem } from "../../../packages/gateway-protocol/src/index.js";
import type { ApplicationContext } from "../app/context.ts";
import "../test-helpers/load-styles.ts";
import "../styles/hub-tabs.css";
import "../styles/sidebar-attention-floating.css";
import "../styles/sidebar-issues.css";
import "./web-awesome-tabs.ts";
// Upgrade the real element: the floating layout once regressed because a base
// class stamped inline `display: contents`, which only a live upgrade reveals.
import "./sidebar-attention.ts";
import {
  buildSidebarInboxEntries,
  type SidebarAttentionItem,
  type SidebarInboxEntry,
} from "./sidebar-attention-entries.ts";
import { renderSidebarAttentionPanel } from "./sidebar-attention-panel.runtime.ts";
import layoutCss from "../styles/layout.css?inline";
import floatingCss from "../styles/sidebar-attention-floating.css?inline";

const authWarning: SidebarAttentionItem = {
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

function inboxMention(id: string): MentionInboxItem {
  return {
    id,
    senderProfileId: "profile-riley",
    senderLabel: "Riley",
    sessionKey: "agent:writer:chat:12345678-90ab-cdef-1234-567890abcdef",
    agentId: "writer",
    sessionTitle: "Release notes",
    messageId: `message-${id}`,
    createdAt: 1_780_000_000_000,
    expiresAt: 1_780_003_600_000,
    excerpt: "Can you review the release notes?",
  };
}

function panelParams(
  entries: readonly SidebarInboxEntry[],
): Parameters<typeof renderSidebarAttentionPanel>[0] {
  return {
    context: {
      basePath: "",
      navigate: vi.fn(),
      gateway: { snapshot: undefined },
    } as unknown as ApplicationContext,
    mentions: {
      snapshot: {
        phase: "ready",
        items: entries.flatMap((entry) => (entry.type === "mention" ? [entry.mention] : [])),
        dismissing: [],
        error: null,
      },
      refresh: vi.fn().mockResolvedValue(undefined),
      dismiss: vi.fn().mockResolvedValue(undefined),
      subscribe: () => () => undefined,
      dispose: () => undefined,
    },
    entries,
    onApprovalDecision: () => {},
    onClose: () => {},
    onDismiss: vi.fn(),
    onKeydown: () => {},
    onNavigate: () => {},
    onOpen: () => {},
    onScroll: () => {},
    onSelectTab: () => {},
    overflowAbove: false,
    overflowBelow: false,
    panelPosition: { left: 0, anchor: "top", top: 0 },
    selectedTab: "all",
  };
}

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
    const params = panelParams([authWarning]);

    for (const mobile of [false, true]) {
      const shell = document.createElement("div");
      shell.className = mobile ? "shell shell--mobile-nav" : "shell";
      document.body.append(shell);
      const renderPanel = (selectedTab: "all" | "approvals") => {
        render(
          renderSidebarAttentionPanel({
            ...params,
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

  it.each(["system", "mentions", "all"] as const)(
    "dismisses only the selected %s tab without mixing mentions and local snoozes",
    (selectedTab) => {
      const entries = buildSidebarInboxEntries({
        approvals: [],
        attention: [authWarning],
        mentions: [inboxMention("mention-a"), inboxMention("mention-b")],
        scopeUpgrade: null,
        update: null,
      });
      const params = panelParams(entries);
      params.mentions.snapshot.dismissing = ["mention-b"];
      const shell = document.body.appendChild(document.createElement("div"));
      render(renderSidebarAttentionPanel({ ...params, selectedTab }), shell);

      expect(
        Array.from(shell.querySelectorAll("[data-mention-id]"), (row) =>
          row.getAttribute("data-mention-id"),
        ),
      ).toEqual(selectedTab === "system" ? [] : ["mention-a", "mention-b"]);
      shell.querySelector<HTMLButtonElement>(".sidebar-issues-panel__dismiss-shown")!.click();

      if (selectedTab === "system") {
        expect(params.mentions.dismiss).not.toHaveBeenCalled();
      } else {
        expect(params.mentions.dismiss).toHaveBeenCalledExactlyOnceWith(["mention-a"]);
      }
      if (selectedTab === "mentions") {
        expect(params.onDismiss).not.toHaveBeenCalled();
      } else {
        expect(params.onDismiss).toHaveBeenCalledExactlyOnceWith(authWarning.dismissal);
      }
    },
  );

  it("keeps existing mentions visible with a refresh action after a request fails", () => {
    const entries = buildSidebarInboxEntries({
      approvals: [],
      attention: [],
      mentions: [inboxMention("mention-a")],
      scopeUpgrade: null,
      update: null,
    });
    const params = panelParams(entries);
    params.mentions.snapshot.phase = "error";
    params.mentions.snapshot.error = "Connection interrupted";
    const shell = document.body.appendChild(document.createElement("div"));
    render(renderSidebarAttentionPanel({ ...params, selectedTab: "mentions" }), shell);

    expect(shell.querySelector('[data-mention-id="mention-a"]')).not.toBeNull();
    expect(shell.querySelector(".sidebar-issues-panel__empty")).toBeNull();
    const error = shell.querySelector('.sidebar-issues-panel__mentions-note[role="status"]')!;
    expect(error.textContent).toContain("Connection interrupted");
    const refresh = error.querySelector<HTMLButtonElement>("button")!;
    expect(refresh.textContent?.trim()).toBe("Refresh mentions");
    refresh.click();
    expect(params.mentions.refresh).toHaveBeenCalledOnce();
  });

  it.each(["base-first", "base-last"])(
    "positions collapsed sidebar attention beyond chrome controls (%s)",
    async (order) => {
      // Entry CSS and the lazy component may arrive in either order. Use both
      // complete owners so this also catches resets introduced in the base sheet.
      const sheets = (
        order === "base-first" ? [layoutCss, floatingCss] : [floatingCss, layoutCss]
      ).map((css) => {
        const sheet = document.createElement("style");
        sheet.textContent = css;
        document.head.append(sheet);
        return sheet;
      });
      onTestFinished(() => sheets.forEach((sheet) => sheet.remove()));
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

      const attention = shell.querySelector<HTMLElement & { updateComplete: Promise<unknown> }>(
        "openclaw-sidebar-attention",
      )!;
      const chrome = shell.querySelector<HTMLElement>(".shell-chrome-controls")!;
      const nativeChrome = shell.querySelector<HTMLElement>(".macos-titlebar-controls")!;
      const inbox = attention.querySelector<HTMLElement>(".sidebar-issues-button")!;

      // The real shell mounts this row only in native web-chrome mode.
      nativeChrome.remove();
      await attention.updateComplete;
      attention.append(inbox);

      expect(getComputedStyle(attention).position).toBe("fixed");
      expect(getComputedStyle(attention).display).toBe("flex");
      expect(attention.getBoundingClientRect().left).toBeGreaterThanOrEqual(
        chrome.getBoundingClientRect().right + 8,
      );
      const paint = () => ({
        border: getComputedStyle(inbox).borderTopWidth,
        background: getComputedStyle(inbox).backgroundColor,
      });
      expect(Number.parseFloat(paint().border)).toBeGreaterThan(0);
      const resting = paint();
      expect(resting.background).not.toBe("rgba(0, 0, 0, 0)");
      expect(getComputedStyle(inbox).boxShadow).not.toBe("none");
      expect(getComputedStyle(inbox).backdropFilter).toBe("blur(10px)");
      const { page } = await import("vitest/browser");
      await page.elementLocator(inbox).hover();
      const hovered = paint();
      expect(hovered.border).toBe(resting.border);
      expect(hovered.background).not.toBe(resting.background);
      await page.elementLocator(chrome.querySelector("button")!).hover();
      inbox.setAttribute("aria-expanded", "true");
      expect(paint()).toEqual(hovered);
      inbox.setAttribute("aria-expanded", "false");
      expect(paint()).toEqual(resting);

      document.documentElement.classList.add("openclaw-native-nav");
      expect(attention.getBoundingClientRect().left).toBeGreaterThanOrEqual(8);

      document.documentElement.classList.add("openclaw-native-macos");
      expect(getComputedStyle(attention).top).toBe("52px");

      shell.append(nativeChrome);
      document.documentElement.classList.add("openclaw-native-web-chrome");
      expect(
        attention.getBoundingClientRect().left - nativeChrome.getBoundingClientRect().right,
      ).toBe(4);
      attention.classList.remove("sidebar-attention--floating");
      expect(paint()).toEqual({ border: "0px", background: "rgba(0, 0, 0, 0)" });
      expect(getComputedStyle(inbox).boxShadow).toBe("none");
      expect(getComputedStyle(inbox).backdropFilter).toBe("none");
    },
  );

  it.each([
    { mobile: false, width: 390, textScale: 1 },
    { mobile: true, width: 390, textScale: 1 },
    { mobile: true, width: 320, textScale: 1 },
    { mobile: true, width: 320, textScale: 1.5 },
  ])(
    "keeps Inbox tabs readable and reachable ($width px, $textScale scale, mobile: $mobile)",
    async ({ mobile, width, textScale }) => {
      const { userEvent } = await import("vitest/browser");
      const rootStyle = document.documentElement.style;
      const previousTextScale = rootStyle.getPropertyValue("--control-ui-text-scale");
      onTestFinished(() => rootStyle.setProperty("--control-ui-text-scale", previousTextScale));
      rootStyle.setProperty("--control-ui-text-scale", String(textScale));
      const fixture = document.createElement("section");
      fixture.className = "sidebar-issues-panel";
      fixture.style.position = "static";
      fixture.style.width = `${width}px`;
      fixture.style.height = "220px";
      fixture.innerHTML = `
      <wa-tab-group class="hub-tabs hub-tabs--sub sidebar-issues-panel__tabs" activation="manual" without-scroll-controls>
        ${["All", "Approvals", "Mentions", "Automations", "System"]
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
      shell.className = mobile ? "shell shell--mobile-nav" : "shell";
      shell.append(fixture);
      document.body.append(shell);

      await customElements.whenDefined("wa-tab-group");
      const group = fixture.querySelector<HTMLElement & { updateComplete: Promise<unknown> }>(
        ".sidebar-issues-panel__tabs",
      );
      const header = document.createElement("header");
      header.className = "sidebar-issues-panel__header";
      fixture.prepend(header);
      const tabs = Array.from(
        fixture.querySelectorAll<HTMLElement & { updateComplete: Promise<unknown> }>(
          "wa-tab.hub-tab",
        ),
      );
      const badgeTab = tabs[1];
      expect(group).not.toBeNull();
      expect(badgeTab).not.toBeNull();
      await group?.updateComplete;
      await Promise.all(tabs.map((tab) => tab.updateComplete));
      // Web Awesome selects and scrolls its first visible tab after Lit finishes rendering.
      await expect.poll(() => group!.getAttribute("active")).toBe("tab-0");

      const badge = badgeTab!.querySelector<HTMLElement>(".hub-tab__badge");
      const list = fixture.querySelector<HTMLElement>(".sidebar-issues-panel__list");
      const item = fixture.querySelector<HTMLElement>("[data-attention-kind]");
      const summary = fixture.querySelector<HTMLElement>(".sidebar-issues-panel__summary");
      const track = group!.shadowRoot?.querySelector<HTMLElement>(".tabs");
      const nav = group!.shadowRoot!.querySelector<HTMLElement>(".nav")!;

      expect(group?.scrollWidth).toBe(group?.clientWidth);
      expect(getComputedStyle(group!).overflowX).toBe("hidden");
      expect(getComputedStyle(group!).backgroundColor).toBe(
        getComputedStyle(header).backgroundColor,
      );
      expect(getComputedStyle(group!).backgroundColor).not.toBe(
        getComputedStyle(list!).backgroundColor,
      );
      // The track hairline is the header/list separator; it must span the panel.
      expect(track).not.toBeNull();
      expect(Number.parseFloat(getComputedStyle(track!).borderBottomWidth)).toBeGreaterThan(0);
      expect(track!.getBoundingClientRect().width).toBeGreaterThanOrEqual(
        nav.getBoundingClientRect().width - 1,
      );
      expect(getComputedStyle(nav).overflowX).toBe("auto");
      if (width === 320) {
        expect(nav.scrollWidth).toBeGreaterThan(nav.clientWidth);
      }
      for (const [index, tab] of tabs.entries()) {
        const label = Array.from(tab.childNodes).find(
          (node) => node.nodeType === Node.TEXT_NODE && node.textContent?.trim(),
        )!;
        const range = document.createRange();
        range.selectNodeContents(label);
        const labelBounds = range.getBoundingClientRect();
        const tabBounds = tab.getBoundingClientRect();
        if (index > 0) {
          expect(tabBounds.left).toBeGreaterThanOrEqual(
            tabs[index - 1]!.getBoundingClientRect().right - 1,
          );
        }
        expect(labelBounds.width).toBeGreaterThan(0);
        expect(
          labelBounds.left,
          `${label.textContent} starts inside its tab`,
        ).toBeGreaterThanOrEqual(tabBounds.left - 1);
        expect(labelBounds.right, `${label.textContent} fits inside its tab`).toBeLessThanOrEqual(
          tabBounds.right + 1,
        );
        const tabBadge = tab.querySelector<HTMLElement>(".hub-tab__badge");
        if (tabBadge) {
          const badgeBounds = tabBadge.getBoundingClientRect();
          expect(
            badgeBounds.left,
            `${label.textContent} does not overlap its count`,
          ).toBeGreaterThanOrEqual(labelBounds.right - 1);
          expect(
            badgeBounds.right,
            `${label.textContent} count fits inside its tab`,
          ).toBeLessThanOrEqual(tabBounds.right + 1);
        }
      }
      tabs[0]!.focus();
      for (const [key, tab] of [
        ["End", tabs.at(-1)!],
        ["Home", tabs[0]!],
      ] as const) {
        const openingTransform = getComputedStyle(fixture).transform;
        await userEvent.keyboard(`{${key}}`);
        expect(document.activeElement).toBe(tab);
        await expect
          .poll(
            () => {
              const bounds = tab.getBoundingClientRect();
              const viewport = nav.getBoundingClientRect();
              return Math.max(viewport.left - bounds.left, bounds.right - viewport.right);
            },
            {
              message: `${key} keeps the focused tab inside its scrollport during ${openingTransform}`,
            },
          )
          .toBeLessThanOrEqual(1);
        const viewport = nav.getBoundingClientRect();
        const separator = track!.getBoundingClientRect();
        expect(separator.left).toBeLessThanOrEqual(viewport.left + 1);
        expect(separator.right).toBeGreaterThanOrEqual(viewport.right - 1);
      }
      // Count badges render as pills separated from the tab label.
      expect(badge).not.toBeNull();
      expect(getComputedStyle(badge!).borderRadius).not.toBe("0px");
      expect(getComputedStyle(summary!).paddingBlock).toBe("8px");
      expect(item!.getBoundingClientRect().right).toBeCloseTo(
        list!.getBoundingClientRect().right,
        1,
      );
    },
  );

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
