/* @vitest-environment jsdom */

import { render } from "lit";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "../../i18n/index.ts";
import { renderApps } from "./view.ts";

const EXPECTED_EXTERNAL_HREFS = [
  "https://apps.apple.com/app/openclaw-ai-that-does-things/id6780396132",
  "https://docs.openclaw.ai/platforms/ios",
  "https://play.google.com/store/apps/details?id=ai.openclaw.app",
  "https://docs.openclaw.ai/platforms/android",
  "https://docs.openclaw.ai/platforms/ios",
  "https://docs.openclaw.ai/platforms/android",
  "https://github.com/openclaw/openclaw/releases",
  "https://docs.openclaw.ai/platforms/macos",
  "https://github.com/openclaw/openclaw-windows-node/releases/latest",
  "https://docs.openclaw.ai/platforms/windows",
  "https://github.com/openclaw/openclaw/releases",
  "https://docs.openclaw.ai/platforms/linux",
  "https://docs.openclaw.ai/tools/chrome-extension",
  "https://clawhub.ai",
  "https://discord.gg/clawd",
  "https://docs.openclaw.ai",
];

describe("renderApps", () => {
  beforeEach(async () => {
    document.body.innerHTML = "";
    await i18n.setLocale("en");
  });

  function renderIntoContainer(onNavigate = vi.fn(), onPairDevice?: () => void) {
    const container = document.createElement("div");
    render(renderApps({ onNavigate, onPairDevice }), container);
    return container;
  }

  it("renders the hero and one heading per section", () => {
    const container = renderIntoContainer();
    expect(container.querySelector(".apps-hero__title")?.textContent).toBe(
      "Take OpenClaw everywhere",
    );
    expect(container.querySelector(".apps-hero__tagline")?.textContent).toContain(
      "Companion apps for your phone",
    );
    const headings = Array.from(container.querySelectorAll(".apps-section__heading")).map(
      (heading) => heading.textContent,
    );
    expect(headings).toEqual([
      "On your phone",
      "On your wrist",
      "On your desktop",
      "In your browser",
      "Community",
    ]);
  });

  it("renders every external link in order with safe target and rel", () => {
    const container = renderIntoContainer();
    const anchors = Array.from(container.querySelectorAll<HTMLAnchorElement>("a[href]"));
    expect(anchors.map((anchor) => anchor.getAttribute("href"))).toEqual(EXPECTED_EXTERNAL_HREFS);
    for (const anchor of anchors) {
      expect(anchor.getAttribute("target")).toBe("_blank");
      expect(anchor.getAttribute("rel")).toContain("noopener");
      expect(anchor.getAttribute("rel")).toContain("noreferrer");
    }
  });

  it("navigates to the in-app Plugins hub from the plugins card", () => {
    const onNavigate = vi.fn();
    const container = renderIntoContainer(onNavigate);
    const buttons = Array.from(
      container.querySelectorAll<HTMLButtonElement>("button.apps-card__cta"),
    );
    expect(buttons).toHaveLength(1);
    expect(buttons[0]?.textContent).toContain("Open Plugins");
    buttons[0]?.click();
    expect(onNavigate).toHaveBeenCalledExactlyOnceWith("plugins");
  });

  it("offers device pairing from the phone section only when permitted", () => {
    const withoutPair = renderIntoContainer();
    expect(withoutPair.querySelector(".apps-pair-hint")).toBeNull();

    const onPairDevice = vi.fn();
    const container = renderIntoContainer(vi.fn(), onPairDevice);
    const hint = container.querySelector(".apps-pair-hint");
    expect(hint?.textContent).toContain("Already have the app?");
    hint?.querySelector("button")?.click();
    expect(onPairDevice).toHaveBeenCalledOnce();
  });

  it("badges the watch apps as bundled with their phone apps", () => {
    const container = renderIntoContainer();
    const badges = Array.from(container.querySelectorAll(".apps-card__badge")).map(
      (badge) => badge.textContent?.trim(),
    );
    expect(badges).toEqual(["Included with the iOS app", "Included with the Android app"]);
  });

  it("renders decorative lazy card art with a per-theme variant for every card", () => {
    const container = renderIntoContainer();
    const images = Array.from(container.querySelectorAll<HTMLImageElement>(".apps-card__art img"));
    expect(images).toHaveLength(18);
    for (const image of images) {
      expect(image.getAttribute("alt")).toBe("");
      expect(image.getAttribute("loading")).toBe("lazy");
    }
    const lightSrcs = images
      .filter((image) => image.classList.contains("apps-card__art-img--light"))
      .map((image) => image.getAttribute("src"));
    const darkSrcs = images
      .filter((image) => image.classList.contains("apps-card__art-img--dark"))
      .map((image) => image.getAttribute("src"));
    expect(lightSrcs).toHaveLength(9);
    for (const src of lightSrcs) {
      expect(src).toMatch(/^\/app-art\/[a-z-]+\.webp$/);
    }
    expect(darkSrcs).toEqual(lightSrcs.map((src) => src?.replace(/\.webp$/, "-dark.webp")));
  });
});
