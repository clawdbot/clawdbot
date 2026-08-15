// Control UI E2E tests cover real-browser lobster pet timing and pointer cancellation.
import type { BrowserContext, Page } from "playwright";
import { afterEach, beforeEach, expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI lobster pet",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) => `Playwright Chromium cannot start at ${executablePath}`,
});

type BrowserLobsterPet = HTMLElement & {
  mode: "idle" | "busy" | "offline";
  runOutcome: "ok" | "error" | "aborted";
  seed: number;
  updateComplete: Promise<unknown>;
};

let context: BrowserContext;
let page: Page;
async function mountPet(params: {
  mode: BrowserLobsterPet["mode"];
  outcome: BrowserLobsterPet["runOutcome"];
  seed: number;
}) {
  await page.evaluate(async (fixture) => {
    const pet = document.createElement("openclaw-lobster-pet") as BrowserLobsterPet;
    pet.seed = fixture.seed;
    pet.mode = fixture.mode;
    pet.runOutcome = fixture.outcome;
    document.body.replaceChildren(pet);
    await pet.updateComplete;
  }, params);
}

async function settlePet() {
  await page.evaluate(
    () => (document.querySelector("openclaw-lobster-pet") as BrowserLobsterPet).updateComplete,
  );
}

suite.define(() => {
  beforeEach(async () => {
    context = await suite.browser.newContext({ hasTouch: true });
    page = await context.newPage();
    await page.clock.install({ time: new Date("2026-07-09T12:00:00") });
    await installMockGateway(page);
    await page.goto(suite.server.baseUrl);
    await page.waitForFunction(() => Boolean(customElements.get("openclaw-lobster-pet")));
    const loadedAt = await page.evaluate(() => Date.now());
    await page.clock.pauseAt(loadedAt + 1_000);
  });

  afterEach(async () => {
    await context.close();
  });

  it("keeps a vigil-only failure present through droop and sweep before leaving", async () => {
    await mountPet({ mode: "busy", outcome: "error", seed: 0 });
    const sprite = page.locator(".lobster-pet");
    await expect.poll(() => sprite.count()).toBe(0);

    await page.clock.fastForward(600_500);
    await settlePet();
    expect(await page.locator(".lobster-pet--vigil").count()).toBe(1);
    await page.evaluate(async () => {
      const pet = document.querySelector("openclaw-lobster-pet") as BrowserLobsterPet;
      pet.mode = "idle";
      await pet.updateComplete;
    });

    const droop = page.locator(".lobster-pet--act-droop");
    expect(await droop.count()).toBe(1);
    await page.clock.runFor(1_599);
    await settlePet();
    expect(await droop.count()).toBe(1);
    await page.clock.runFor(1);
    await settlePet();

    const sweep = page.locator(".lobster-pet--act-sweep");
    expect(await sweep.count()).toBe(1);
    await page.clock.runFor(1_799);
    await settlePet();
    expect(await sweep.count()).toBe(1);
    await page.clock.runFor(1);
    await settlePet();

    expect(await page.locator(".lobster-pet--away").count()).toBe(1);
    await page.clock.runFor(350);
    await expect.poll(() => sprite.count()).toBe(0);
  });

  it("does not pet after Chromium cancels a sub-threshold touch hold", async () => {
    await mountPet({ mode: "offline", outcome: "ok", seed: 42 });
    const sprite = page.locator(".lobster-pet");
    await sprite.waitFor();

    await sprite.dispatchEvent("pointerdown", { pointerId: 1, pointerType: "touch" });
    await page.clock.runFor(300);
    await sprite.dispatchEvent("pointercancel", { pointerId: 1, pointerType: "touch" });
    await page.clock.runFor(400);

    await expect.poll(() => page.locator(".lobster-pet--act-pet").count()).toBe(0);
  });
});
