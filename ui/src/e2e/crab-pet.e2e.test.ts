// Control UI E2E tests cover real-browser crab pet timing and pointer cancellation.
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  canRunPlaywrightChromium,
  installMockGateway,
  resolvePlaywrightChromiumExecutablePath,
  startControlUiE2eServer,
  type ControlUiE2eServer,
} from "../test-helpers/control-ui-e2e.ts";

const chromiumExecutablePath = resolvePlaywrightChromiumExecutablePath(chromium.executablePath());
const chromiumAvailable = canRunPlaywrightChromium(chromiumExecutablePath);
const allowMissingChromium = process.env.OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM === "1";
const describeControlUiE2e = chromiumAvailable || !allowMissingChromium ? describe : describe.skip;

type BrowserCrabPet = HTMLElement & {
  mode: "idle" | "busy" | "offline";
  runOutcome: "ok" | "error" | "aborted";
  seed: number;
  updateComplete: Promise<unknown>;
};

let browser: Browser;
let context: BrowserContext;
let page: Page;
let server: ControlUiE2eServer;

async function mountPet(params: {
  mode: BrowserCrabPet["mode"];
  outcome: BrowserCrabPet["runOutcome"];
  seed: number;
}) {
  await page.evaluate(async (fixture) => {
    const pet = document.createElement("openclaw-crab-pet") as BrowserCrabPet;
    pet.seed = fixture.seed;
    pet.mode = fixture.mode;
    pet.runOutcome = fixture.outcome;
    document.body.replaceChildren(pet);
    await pet.updateComplete;
  }, params);
}

async function settlePet() {
  await page.evaluate(
    () => (document.querySelector("openclaw-crab-pet") as BrowserCrabPet).updateComplete,
  );
}

describeControlUiE2e("Control UI crab pet", () => {
  beforeAll(async () => {
    if (!chromiumAvailable) {
      throw new Error(`Playwright Chromium cannot start at ${chromiumExecutablePath}`);
    }
    server = await startControlUiE2eServer();
    browser = await chromium.launch({ executablePath: chromiumExecutablePath });
  });

  beforeEach(async () => {
    context = await browser.newContext({ hasTouch: true });
    page = await context.newPage();
    await page.clock.install({ time: new Date("2026-07-09T12:00:00") });
    await installMockGateway(page);
    await page.goto(server.baseUrl);
    await page.waitForFunction(() => Boolean(customElements.get("openclaw-crab-pet")));
    const loadedAt = await page.evaluate(() => Date.now());
    await page.clock.pauseAt(loadedAt + 1_000);
  });

  afterEach(async () => {
    await context.close();
  });

  afterAll(async () => {
    await browser?.close();
    await server?.close();
  });

  it("keeps a vigil-only failure present through droop and sweep before leaving", async () => {
    await mountPet({ mode: "busy", outcome: "error", seed: 0 });
    const sprite = page.locator(".crab-pet");
    await expect.poll(() => sprite.count()).toBe(0);

    await page.clock.fastForward(600_500);
    await settlePet();
    expect(await page.locator(".crab-pet--vigil").count()).toBe(1);
    await page.evaluate(async () => {
      const pet = document.querySelector("openclaw-crab-pet") as BrowserCrabPet;
      pet.mode = "idle";
      await pet.updateComplete;
    });

    const droop = page.locator(".crab-pet--act-droop");
    expect(await droop.count()).toBe(1);
    await page.clock.runFor(1_599);
    await settlePet();
    expect(await droop.count()).toBe(1);
    await page.clock.runFor(1);
    await settlePet();

    const sweep = page.locator(".crab-pet--act-sweep");
    expect(await sweep.count()).toBe(1);
    await page.clock.runFor(1_799);
    await settlePet();
    expect(await sweep.count()).toBe(1);
    await page.clock.runFor(1);
    await settlePet();

    expect(await page.locator(".crab-pet--away").count()).toBe(1);
    await page.clock.runFor(350);
    await expect.poll(() => sprite.count()).toBe(0);
  });

  it("does not pet after Chromium cancels a sub-threshold touch hold", async () => {
    await mountPet({ mode: "offline", outcome: "ok", seed: 42 });
    const sprite = page.locator(".crab-pet");
    await sprite.waitFor();

    await sprite.dispatchEvent("pointerdown", { pointerId: 1, pointerType: "touch" });
    await page.clock.runFor(300);
    await sprite.dispatchEvent("pointercancel", { pointerId: 1, pointerType: "touch" });
    await page.clock.runFor(400);

    await expect.poll(() => page.locator(".crab-pet--act-pet").count()).toBe(0);
  });
});
