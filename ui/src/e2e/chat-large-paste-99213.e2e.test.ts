// Control UI regression proof for #99213: paste a large screenshot-like PNG through the
// real chat composer and verify chat.send receives it without overflowing base64 handling.
import { copyFile, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
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
const describeControlUiE2e = chromiumAvailable || !allowMissingChromium ? describe : describe.skip;
const artifactDir = path.resolve(process.cwd(), ".artifacts/control-ui-e2e/chat-large-paste-99213");
const viewport = { height: 900, width: 1280 };

let server: ControlUiE2eServer;

type RecordedPage = {
  browser: Browser;
  context: BrowserContext;
  page: Page;
  rawVideoDir: string;
};

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Expected ${label} to be an object`);
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value) {
    throw new Error(`Expected non-empty ${label}`);
  }
  return value;
}

function requireArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`Expected ${label} to be an array`);
  }
  return value;
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function uint32(value: number): Uint8Array {
  return Uint8Array.of(
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff,
  );
}

function ascii(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function chunk(type: string, payload: Uint8Array): Uint8Array {
  const typeBytes = ascii(type);
  const crcInput = new Uint8Array(typeBytes.length + payload.length);
  crcInput.set(typeBytes, 0);
  crcInput.set(payload, typeBytes.length);
  const result = new Uint8Array(12 + payload.length);
  result.set(uint32(payload.length), 0);
  result.set(typeBytes, 4);
  result.set(payload, 8);
  result.set(uint32(crc32(crcInput)), 8 + payload.length);
  return result;
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

function createLargePngBytes(targetBytes: number): Uint8Array {
  const signature = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
  const ihdr = chunk("IHDR", Uint8Array.of(0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0));
  const idat = chunk(
    "IDAT",
    Uint8Array.of(0x78, 0x9c, 0x63, 0xf8, 0xcf, 0xc0, 0xf0, 0x1f, 0x00, 0x05, 0x00, 0x01, 0xff),
  );
  const iend = chunk("IEND", new Uint8Array());
  const fixedBytes = signature.length + ihdr.length + idat.length + iend.length + 12;
  const payload = new Uint8Array(Math.max(0, targetBytes - fixedBytes));
  for (let i = 0; i < payload.length; i += 1) {
    payload[i] = 0x41 + (i % 26);
  }
  return concatBytes([signature, ihdr, chunk("tEXt", payload), idat, iend]);
}

function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

async function newRecordedPage(label: string): Promise<RecordedPage> {
  await mkdir(artifactDir, { recursive: true });
  const rawVideoDir = path.join(artifactDir, `${label}-raw`);
  await rm(rawVideoDir, { force: true, recursive: true });
  await mkdir(rawVideoDir, { recursive: true });
  const browser = await chromium.launch({ executablePath: chromiumExecutablePath });
  let context: BrowserContext | undefined;
  let page: Page | undefined;
  try {
    context = await browser.newContext({
      locale: "en-US",
      permissions: ["clipboard-read", "clipboard-write"],
      recordVideo: {
        dir: rawVideoDir,
        size: viewport,
      },
      serviceWorkers: "block",
      viewport,
    });
    page = await context.newPage();
    page.setDefaultTimeout(10_000);
    return { browser, context, page, rawVideoDir };
  } catch (error) {
    await page?.close().catch(() => {});
    await context?.close().catch(() => {});
    await browser.close().catch(() => {});
    await rm(rawVideoDir, { force: true, recursive: true });
    throw error;
  }
}

async function closeRecordedPage(recorded: RecordedPage, label: string): Promise<string[]> {
  const video = recorded.page.video();
  const videos: string[] = [];
  try {
    await recorded.context.close();
    if (video) {
      const rawVideoPath = await video.path();
      const videoPath = path.join(artifactDir, `${label}.webm`);
      await copyFile(rawVideoPath, videoPath);
      videos.push(videoPath);
    }
  } finally {
    await recorded.browser.close().catch(() => {});
    await rm(recorded.rawVideoDir, { force: true, recursive: true });
  }
  return videos;
}

describeControlUiE2e("Control UI #99213 large screenshot paste proof", () => {
  beforeAll(async () => {
    if (!chromiumAvailable) {
      throw new Error(
        `Playwright Chromium is not installed or cannot start at ${chromiumExecutablePath}. Run \`pnpm --dir ui exec playwright install --with-deps chromium\`, set PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH to a compatible browser, or set OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM=1 only when intentionally skipping this lane.`,
      );
    }
    server = await startControlUiE2eServer();
  });

  afterAll(async () => {
    await server?.close();
  });

  it("sends a roughly 2 MB PNG without overlapping transcript rows", async () => {
    await rm(artifactDir, { force: true, recursive: true });
    await mkdir(artifactDir, { recursive: true });
    const pngBytes = createLargePngBytes(1_901_669);
    const imageBase64 = toBase64(pngBytes);
    const dataUrl = `data:image/png;base64,${imageBase64}`;
    const prompt = "proof: large Control UI clipboard image";
    const recorded = await newRecordedPage("large-paste");
    const screenshots: string[] = [];
    let videos: string[];

    try {
      const gateway = await installMockGateway(recorded.page, {
        historyMessages: [
          {
            content: [
              {
                text: [
                  "The existing assistant reply is taller than the virtualizer estimate.",
                  "",
                  "- First line of the existing answer.",
                  "- Second line of the existing answer.",
                  "- Third line of the existing answer.",
                  "- Fourth line of the existing answer.",
                  "- Fifth line of the existing answer.",
                ].join("\n"),
                type: "text",
              },
            ],
            role: "assistant",
            timestamp: Date.now(),
          },
        ],
      });

      await recorded.page.goto(`${server.baseUrl}chat`);
      await recorded.page
        .getByText("The existing assistant reply is taller than the virtualizer estimate.")
        .waitFor({ timeout: 10_000 });

      const composer = recorded.page.locator(".agent-chat__composer-combobox textarea");
      await composer.focus();
      await recorded.page.evaluate(async (text) => {
        await navigator.clipboard.writeText(text);
      }, dataUrl);
      await composer.press(process.platform === "darwin" ? "Meta+V" : "Control+V");

      await recorded.page.locator(".chat-attachment-thumb").waitFor({ state: "visible" });
      await composer.fill(prompt);
      const pasteScreenshot = path.join(artifactDir, "01-pasted-large-image.png");
      await recorded.page.screenshot({ fullPage: true, path: pasteScreenshot });
      screenshots.push(pasteScreenshot);

      await recorded.page.getByRole("button", { name: "Send message" }).click();
      const sendRequest = await gateway.waitForRequest("chat.send");
      const params = requireRecord(sendRequest.params, "chat.send params");
      const attachments = requireArray(params.attachments, "chat.send attachments");
      expect(params.message).toBe(prompt);
      expect(attachments).toHaveLength(1);
      const attachment = requireRecord(attachments[0], "chat.send attachment");
      expect(attachment.type).toBe("image");
      expect(attachment.mimeType).toBe("image/png");
      expect(attachment.fileName).toBe("pasted-image.png");
      expect(requireString(attachment.content, "attachment content")).toBe(imageBase64);

      const assistantRow = recorded.page
        .getByText("The existing assistant reply is taller than the virtualizer estimate.")
        .locator("xpath=ancestor::div[contains(@class, 'chat-virtual-row')]");
      const userRow = recorded.page
        .getByText(prompt)
        .locator("xpath=ancestor::div[contains(@class, 'chat-virtual-row')]");
      await expect
        .poll(async () => {
          const [assistantBounds, userBounds] = await Promise.all([
            assistantRow.boundingBox(),
            userRow.boundingBox(),
          ]);
          if (!assistantBounds || !userBounds) {
            return Number.NEGATIVE_INFINITY;
          }
          return Math.round(userBounds.y - (assistantBounds.y + assistantBounds.height));
        })
        .toBeGreaterThanOrEqual(0);

      const runId = requireString(params.idempotencyKey, "chat send idempotency key");
      await gateway.emitChatFinal({ runId, text: "Large screenshot paste proof received." });
      await recorded.page
        .locator(".chat-thread-inner")
        .getByText("Large screenshot paste proof received.")
        .waitFor({ timeout: 10_000 });
      const sentScreenshot = path.join(artifactDir, "02-sent-large-image.png");
      await recorded.page.screenshot({ fullPage: true, path: sentScreenshot });
      screenshots.push(sentScreenshot);
    } finally {
      videos = await closeRecordedPage(recorded, "large-paste");
    }

    const summary = {
      base64Chars: imageBase64.length,
      dataUrlChars: dataUrl.length,
      pngBytes: pngBytes.length,
      screenshots,
      videos,
    };
    await writeFile(
      path.join(artifactDir, "summary.json"),
      `${JSON.stringify(summary, null, 2)}\n`,
    );
  });
});
