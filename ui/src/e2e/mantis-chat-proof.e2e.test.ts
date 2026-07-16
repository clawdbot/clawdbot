// Control UI Mantis proof covers the focused web chat browser path.
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium, type Browser, type BrowserContext } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
const describeMantisWebUiChat =
  chromiumAvailable || !allowMissingChromium ? describe : describe.skip;
const artifactDir = path.resolve(
  process.env.OPENCLAW_MANTIS_WEB_UI_CHAT_OUTPUT_DIR ??
    path.join(process.cwd(), ".artifacts", "qa-e2e", "mantis", "web-ui-chat-proof"),
);

let server: ControlUiE2eServer;
const contextBrowsers = new WeakMap<BrowserContext, Browser>();

async function newBrowserContext(options: Parameters<Browser["newContext"]>[0]) {
  const browser = await chromium.launch({ executablePath: chromiumExecutablePath });
  try {
    const context = await browser.newContext(options);
    contextBrowsers.set(context, browser);
    return context;
  } catch (error) {
    await browser.close().catch(() => {});
    throw error;
  }
}

async function closeBrowserContext(context: BrowserContext): Promise<void> {
  const browser = contextBrowsers.get(context);
  contextBrowsers.delete(context);
  await context.close().catch(() => {});
  await browser?.close().catch(() => {});
}

describeMantisWebUiChat("Mantis Control UI web chat proof", () => {
  beforeAll(async () => {
    if (!chromiumAvailable) {
      throw new Error(
        `Playwright Chromium is not installed or cannot start at ${chromiumExecutablePath}. Run \`pnpm --dir ui exec playwright install --with-deps chromium\`, set PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH to a compatible browser, or set OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM=1 only when intentionally skipping this lane.`,
      );
    }
    await mkdir(artifactDir, { recursive: true });
    server = await startControlUiE2eServer();
  });

  afterAll(async () => {
    await server?.close();
  });

  it("sends a chat message and captures visible browser proof", async () => {
    const rawVideoDir = path.join(artifactDir, "raw-video");
    await mkdir(rawVideoDir, { recursive: true });
    const context = await newBrowserContext({
      locale: "en-US",
      recordVideo: { dir: rawVideoDir, size: { height: 900, width: 1280 } },
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    await page.clock.install();
    const gateway = await installMockGateway(page, {
      historyMessages: [
        {
          role: "system",
          timestamp: Date.now() - 1_000,
          __openclaw: {
            kind: "compaction",
            id: "mantis-compaction-entry",
            tokensBefore: 900_000,
            tokensAfter: 24_700,
          },
        },
        {
          content: [{ text: "Mantis web UI proof is ready.", type: "text" }],
          role: "assistant",
          timestamp: Date.now(),
        },
      ],
    });
    const prompt = "capture a Mantis web UI chat proof";
    const reply = "Mantis web UI chat proof rendered.";
    const startedAt = new Date().toISOString();

    try {
      await page.goto(`${server.baseUrl}chat`);
      await page.getByText("Mantis web UI proof is ready.").waitFor({ timeout: 10_000 });
      await page.locator(".agent-chat__composer-combobox textarea").fill(prompt);
      await page.getByRole("button", { name: "Send message" }).click();

      const sendRequest = await gateway.waitForRequest("chat.send");
      expect(sendRequest.params).toMatchObject({
        deliver: false,
        message: prompt,
        sessionKey: "main",
      });
      const params = sendRequest.params as { idempotencyKey?: string };
      expect(params.idempotencyKey).toEqual(expect.any(String));

      await page.getByText("saved 875.3k tokens", { exact: true }).waitFor();
      await page.locator(".chat-working-indicator").waitFor();
      const workingLabel = page.locator(".chat-working-indicator__status > .agent-chat__sr-only");
      expect(await workingLabel.textContent()).toBe("Working…");
      expect(
        await page
          .locator(".chat-working-indicator__status > span:not(.agent-chat__sr-only)")
          .count(),
      ).toBe(0);
      await page.clock.runFor(177_000);
      await expect
        .poll(() => page.locator(".chat-working-indicator__elapsed").textContent())
        .toBe("2m 57s");
      await page.screenshot({ fullPage: true, path: path.join(artifactDir, "web-ui-chat.png") });

      await gateway.emitChatFinal({ runId: params.idempotencyKey ?? "", text: reply });
      await page.locator(".chat-thread-inner").getByText(reply).waitFor({ timeout: 10_000 });
      await writeFile(
        path.join(artifactDir, "web-ui-chat-proof.json"),
        `${JSON.stringify(
          {
            finishedAt: new Date().toISOString(),
            prompt,
            reply,
            startedAt,
            status: "pass",
          },
          null,
          2,
        )}\n`,
      );
    } finally {
      const video = page.video();
      await closeBrowserContext(context);
      const videoPath = await video?.path().catch(() => undefined);
      if (videoPath) {
        await copyFile(videoPath, path.join(artifactDir, "web-ui-chat.webm"));
      }
    }
  });
});
