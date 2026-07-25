import { mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium, type Browser, type BrowserContext } from "playwright";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
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
const captureUiProof = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
const proofDir = path.join(
  process.cwd(),
  ".artifacts",
  "control-ui-e2e",
  "session-discussion-toggle",
);

let server: ControlUiE2eServer;
let browser: Browser;
const openContexts = new Set<BrowserContext>();

async function closeOpenContexts(): Promise<void> {
  const contexts = Array.from(openContexts);
  openContexts.clear();
  await Promise.all(contexts.map((context) => context.close()));
}

describeControlUiE2e("session discussion toggle", () => {
  beforeAll(async () => {
    if (!chromiumAvailable) {
      throw new Error(`Playwright Chromium is unavailable at ${chromiumExecutablePath}`);
    }
    browser = await chromium.launch({ executablePath: chromiumExecutablePath });
    server = await startControlUiE2eServer();
    if (captureUiProof) {
      await mkdir(proofDir, { recursive: true });
    }
  });

  afterEach(closeOpenContexts);

  afterAll(async () => {
    await closeOpenContexts();
    await browser?.close();
    await server?.close();
  });

  it("opens and closes the sidebar from the same header action", async () => {
    const context = await browser.newContext({
      ...(captureUiProof
        ? { recordVideo: { dir: proofDir, size: { height: 720, width: 1280 } } }
        : {}),
      viewport: { height: 720, width: 1280 },
    });
    openContexts.add(context);
    const page = await context.newPage();
    const sessionKey = "agent:main:discussion-proof";
    const gateway = await installMockGateway(page, {
      featureMethods: ["session.discussion.info", "session.discussion.open"],
      historyMessages: [
        {
          content: [{ type: "text", text: "Discussion toggle proof." }],
          role: "assistant",
          timestamp: Date.now(),
        },
      ],
      methodResponses: {
        "session.discussion.info": { state: "available" },
        "session.discussion.open": {
          openUrl: "https://discussion.example/session",
          state: "open",
        },
      },
      sessionKey,
    });

    await page.goto(`${server.baseUrl}chat?session=${encodeURIComponent(sessionKey)}`);
    await gateway.waitForRequest("session.discussion.info");

    const showDiscussion = page.getByRole("button", { name: "Show discussion" });
    await expect.poll(() => showDiscussion.isVisible()).toBe(true);
    await expect.poll(() => showDiscussion.getAttribute("aria-pressed")).toBe("false");

    await showDiscussion.click();

    const hideDiscussion = page.getByRole("button", { name: "Hide discussion" });
    const closeSidebar = page.getByRole("button", { name: "Close sidebar" });
    await expect.poll(() => hideDiscussion.getAttribute("aria-pressed")).toBe("true");
    await expect.poll(() => closeSidebar.isVisible()).toBe(true);
    expect(await gateway.getRequests("session.discussion.open")).toHaveLength(1);
    if (captureUiProof) {
      await page.screenshot({ path: path.join(proofDir, "discussion-open.png") });
    }

    await hideDiscussion.click();

    await expect.poll(() => closeSidebar.isVisible()).toBe(false);
    await expect.poll(() => showDiscussion.getAttribute("aria-pressed")).toBe("false");
    expect(await gateway.getRequests("session.discussion.open")).toHaveLength(1);
    if (captureUiProof) {
      await page.screenshot({ path: path.join(proofDir, "discussion-closed.png") });
    }
  });
});
