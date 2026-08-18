import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it } from "vitest";
import "../../styles/config.css";

const hasBrowserLayout = !navigator.userAgent.toLowerCase().includes("jsdom");
const layoutTolerancePx = 1;
let host: HTMLDivElement | undefined;

afterEach(() => {
  host?.remove();
  host = undefined;
});

describe.skipIf(!hasBrowserLayout)("Memory page browser layout", () => {
  it("keeps the hero fixed when a subview changes scrollbar state", async () => {
    host = document.createElement("div");
    host.className = "shell shell--settings";
    host.innerHTML = `
      <main class="content" style="box-sizing: border-box; width: 1152px; height: 600px; overflow-y: auto">
        <section class="memory-page">
          <section class="content-header content-header--page hub-page-header">
            <div class="hub-page-header__title">Memory</div>
            <div class="hub-page-header__tabs">Overview Memories Dreams Settings</div>
            <div class="hub-page-header__actions">Agent</div>
          </section>
          <div class="memory-page__panel" style="height: 200px"></div>
        </section>
      </main>
    `;
    document.body.append(host);

    const content = expectDefined(host.querySelector<HTMLElement>(".content"), "content");
    const header = expectDefined(
      host.querySelector<HTMLElement>(".hub-page-header"),
      "Memory header",
    );
    const tabs = expectDefined(
      host.querySelector<HTMLElement>(".hub-page-header__tabs"),
      "Memory tabs",
    );
    const before = {
      clientWidth: content.clientWidth,
      header: header.getBoundingClientRect(),
      tabs: tabs.getBoundingClientRect(),
    };

    const panel = expectDefined(
      host.querySelector<HTMLElement>(".memory-page__panel"),
      "Memory panel",
    );
    panel.style.height = "1200px";
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

    const after = {
      clientWidth: content.clientWidth,
      header: header.getBoundingClientRect(),
      tabs: tabs.getBoundingClientRect(),
    };
    expect(getComputedStyle(content).scrollbarGutter).toBe("stable");
    expect(after.clientWidth).toBe(before.clientWidth);
    expect(Math.abs(after.header.left - before.header.left)).toBeLessThanOrEqual(layoutTolerancePx);
    expect(Math.abs(after.header.right - before.header.right)).toBeLessThanOrEqual(
      layoutTolerancePx,
    );
    expect(Math.abs(after.tabs.left - before.tabs.left)).toBeLessThanOrEqual(layoutTolerancePx);
    expect(Math.abs(after.tabs.top - before.tabs.top)).toBeLessThanOrEqual(layoutTolerancePx);
  });
});
