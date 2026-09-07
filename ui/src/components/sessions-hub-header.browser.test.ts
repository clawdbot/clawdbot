import { html, render } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "../i18n/index.ts";
import "../styles.css";
import { renderSessionsHubHeader } from "./sessions-hub-header.ts";

const hasBrowserLayout = !navigator.userAgent.toLowerCase().includes("jsdom");

async function useViewport(width: number, height = 800) {
  const { page } = await import("vitest/browser");
  await page.viewport(width, height);
}

async function mount(
  active: "sessions" | "worktrees",
  withActions: boolean,
  onSelect: (tab: "sessions" | "worktrees") => void = () => undefined,
) {
  const container = document.createElement("div");
  container.style.width = "calc(100vw - 32px)";
  container.style.maxWidth = "1120px";
  document.body.append(container);
  render(
    renderSessionsHubHeader({
      active,
      title: "Sessions",
      actions: withActions ? html`<div style="width: 240px">Agent selector</div>` : undefined,
      onSelect,
    }),
    container,
  );
  const group = container.querySelector<HTMLElement & { updateComplete: Promise<boolean> }>(
    "wa-tab-group",
  );
  await group?.updateComplete;
  return container;
}

function overlaps(left: DOMRect, right: DOMRect): boolean {
  return !(
    left.right <= right.left ||
    left.left >= right.right ||
    left.bottom <= right.top ||
    left.top >= right.bottom
  );
}

describe.skipIf(!hasBrowserLayout)("Sessions hub header browser layout", () => {
  beforeEach(async () => {
    await i18n.setLocale("en");
  });

  afterEach(() => {
    document.body.replaceChildren();
  });

  it.each([1280, 820])(
    "keeps the tab strip fixed without overlap at a %dpx viewport",
    async (width) => {
      await useViewport(width);
      const sessions = await mount("sessions", true);
      const sessionsTitle = sessions.querySelector<HTMLElement>(".hub-page-header__title");
      const sessionsTabs = sessions.querySelector<HTMLElement>(".sessions-hub-tabs");
      const sessionsActions = sessions.querySelector<HTMLElement>(".hub-page-header__actions");
      const sessionsLeft = sessionsTabs?.getBoundingClientRect().left;
      expect(sessionsLeft).toBeTypeOf("number");
      expect(sessionsTabs?.getBoundingClientRect().width).toBeGreaterThan(0);
      expect(sessionsActions?.childElementCount).toBe(1);
      expect(
        overlaps(sessionsTitle!.getBoundingClientRect(), sessionsTabs!.getBoundingClientRect()),
      ).toBe(false);
      expect(
        overlaps(sessionsActions!.getBoundingClientRect(), sessionsTabs!.getBoundingClientRect()),
      ).toBe(false);
      sessions.remove();

      const worktrees = await mount("worktrees", false);
      const worktreesTabs = worktrees.querySelector<HTMLElement>(".sessions-hub-tabs");
      const worktreesLeft = worktreesTabs?.getBoundingClientRect().left;
      expect(worktreesLeft).toBeTypeOf("number");
      expect(worktrees.querySelector(".hub-page-header__actions")?.childElementCount).toBe(0);
      expect(Math.abs((sessionsLeft ?? 0) - (worktreesLeft ?? 0))).toBeLessThanOrEqual(1);
    },
  );

  it("keeps session navigation and operational headers available on mobile", async () => {
    await useViewport(414, 800);
    const onSelect = vi.fn();
    const sessions = await mount("sessions", true, onSelect);
    const header = sessions.querySelector<HTMLElement>(".hub-page-header");
    const title = sessions.querySelector<HTMLElement>(".page-title");
    const tabs = sessions.querySelector<HTMLElement>(".sessions-hub-tabs");
    const actions = sessions.querySelector<HTMLElement>(".hub-page-header__actions");
    expect(getComputedStyle(header!).display).toBe("grid");
    expect(title?.getBoundingClientRect().width).toBeGreaterThan(0);
    expect(tabs?.getBoundingClientRect().width).toBeGreaterThan(0);
    expect(actions?.getBoundingClientRect().width).toBeGreaterThan(0);

    const worktreesTab = sessions.querySelector<HTMLElement>("#sessions-tab-worktrees");
    expect(worktreesTab?.getBoundingClientRect().width).toBeGreaterThan(0);
    worktreesTab?.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
    expect(onSelect).toHaveBeenCalledWith("worktrees");

    const operationalHeader = document.createElement("section");
    operationalHeader.className = "content-header";
    operationalHeader.innerHTML = '<button type="button">Refresh</button>';
    document.body.append(operationalHeader);
    expect(getComputedStyle(operationalHeader).display).toBe("flex");
    expect(
      operationalHeader.querySelector("button")?.getBoundingClientRect().width,
    ).toBeGreaterThan(0);

    const chatContent = document.createElement("main");
    chatContent.className = "content content--chat";
    chatContent.innerHTML = '<section class="content-header"></section>';
    document.body.append(chatContent);
    expect(getComputedStyle(chatContent.querySelector(".content-header")!).display).toBe("none");
  });
});
