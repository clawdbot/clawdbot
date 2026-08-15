// Measures the lobster dismiss menu's internal overflow in the real sidebar
// footer context, with classic (space-taking) scrollbars forced on so the
// Linux run matches what a macOS "Always show scrollbars" operator sees.
import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { BrowserContext, Page } from "playwright";
import { beforeEach, expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI lobster dismiss menu overflow",
  startServerBeforeBrowser: true,
  browserLaunchOptions: {
    args: ["--disable-features=OverlayScrollbar,FluentOverlayScrollbar,FluentScrollbar"],
  },
  unavailableMessage: (executablePath) => `Playwright Chromium cannot start at ${executablePath}`,
});

type BrowserLobsterPet = HTMLElement & {
  mode: "idle" | "busy" | "offline";
  runOutcome: "ok" | "error" | "aborted";
  seed: number;
  visitsEnabled: boolean;
  updateComplete: Promise<unknown>;
};

const artifactDir = path.resolve(
  process.cwd(),
  ".artifacts/control-ui-e2e/lobster-dismiss-menu-overflow",
);

let context: BrowserContext;
let page: Page;

/** Mounts the pet inside the real sidebar footer ledge so production CSS
 *  (`openclaw-lobster-pet { height: 52px; overflow: hidden }`) applies. */
async function mountPetInRealFooter(seed: number) {
  await page.evaluate(async (petSeed) => {
    const footer = document.querySelector(".sidebar-shell__footer");
    if (!footer) {
      throw new Error("sidebar footer ledge not found");
    }
    footer.querySelector("openclaw-lobster-pet")?.remove();
    const pet = document.createElement("openclaw-lobster-pet") as BrowserLobsterPet;
    pet.seed = petSeed;
    pet.mode = "offline";
    pet.runOutcome = "ok";
    pet.visitsEnabled = true;
    footer.append(pet);
    await pet.updateComplete;
  }, seed);
}

/** Reads the geometry that decides whether the popup scrolls. */
async function measureDismissMenu() {
  return await page.evaluate(() => {
    const dropdown = document.querySelector("wa-dropdown.lobster-pet-dismiss-menu");
    if (!dropdown?.shadowRoot) {
      throw new Error("dismiss menu dropdown not found");
    }
    const menu = dropdown.shadowRoot.querySelector<HTMLElement>("#menu");
    const popup = dropdown.shadowRoot.querySelector("wa-popup");
    const popupBox = popup?.shadowRoot?.querySelector<HTMLElement>(".popup") ?? null;
    if (!menu) {
      throw new Error("dismiss menu #menu part not found");
    }
    const menuStyle = getComputedStyle(menu);
    const host = document.querySelector<HTMLElement>("openclaw-lobster-pet");
    const hostStyle = host ? getComputedStyle(host) : null;
    return {
      scrollHeight: menu.scrollHeight,
      clientHeight: menu.clientHeight,
      offsetHeight: menu.offsetHeight,
      overflowPx: menu.scrollHeight - menu.clientHeight,
      scrollbarWidthPx: menu.offsetWidth - menu.clientWidth,
      computedMaxHeight: menuStyle.maxHeight,
      computedOverflowY: menuStyle.overflowY,
      autoSizeAvailableHeight: popup
        ? getComputedStyle(popup).getPropertyValue("--auto-size-available-height").trim()
        : "(no wa-popup)",
      resolvedPlacement: popup?.getAttribute("data-current-placement") ?? "(none)",
      anchorTop: dropdown.querySelector<HTMLElement>('[slot="trigger"]')?.style.top ?? "(none)",
      viewportHeight: window.innerHeight,
      popupIsTopLayer: popupBox ? popupBox.matches(":popover-open") : null,
      menuSurfaceIsTopLayer:
        document.querySelector("openclaw-menu-surface")?.matches(":popover-open") ?? null,
      hostHeight: hostStyle?.height ?? null,
      hostOverflow: hostStyle?.overflow ?? null,
      itemHeights: [...dropdown.querySelectorAll("wa-dropdown-item")].map(
        (item) => (item as HTMLElement).offsetHeight,
      ),
    };
  });
}

suite.define(() => {
  beforeEach(async () => {
    context = await suite.newBrowserContext({ viewport: { width: 1280, height: 900 } });
    page = await context.newPage();
    await page.clock.install({ time: new Date("2026-07-09T12:00:00") });
    await installMockGateway(page);
    await page.goto(suite.server.baseUrl);
    await page.waitForFunction(() => Boolean(customElements.get("openclaw-lobster-pet")));
    const loadedAt = await page.evaluate(() => Date.now());
    await page.clock.pauseAt(loadedAt + 1_000);
    await mkdir(artifactDir, { recursive: true });
  });

  it("does not scroll its two dismissal items in the real sidebar footer", async () => {
    await mountPetInRealFooter(42);
    const sprite = page.locator(".lobster-pet");
    await sprite.waitFor();

    await sprite.click({ button: "right" });
    await page.locator("wa-dropdown.lobster-pet-dismiss-menu").waitFor();
    await page.getByText("Dismiss and don't show again", { exact: true }).waitFor();

    const measurement = await measureDismissMenu();
    await page.screenshot({ path: path.join(artifactDir, "real-footer-context.png") });

    // Asserting on the whole measurement so a regression prints the anchor
    // position and resolved max-height that explain it.
    expect(measurement).toMatchObject({ overflowPx: 0 });
  });

  // Control: the identical menu content, anchored away from the bottom edge.
  // Isolates the anchor position as the cause rather than the menu's content.
  it("has room for the same two items when the ledge is not at the viewport edge", async () => {
    await mountPetInRealFooter(42);
    await page.evaluate(() => {
      const footer = document.querySelector<HTMLElement>(".sidebar-shell__footer");
      if (footer) {
        footer.style.transform = "translateY(-400px)";
      }
    });
    const sprite = page.locator(".lobster-pet");
    await sprite.waitFor();

    await sprite.click({ button: "right" });
    await page.locator("wa-dropdown.lobster-pet-dismiss-menu").waitFor();

    const measurement = await measureDismissMenu();
    await page.screenshot({ path: path.join(artifactDir, "control-away-from-edge.png") });

    expect(measurement).toMatchObject({ overflowPx: 0 });
  });
});
