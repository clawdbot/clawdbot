import { spawn, type ChildProcessByStdio } from "node:child_process";
import { once } from "node:events";
import { type AddressInfo, createServer } from "node:net";
import path from "node:path";
import type { Readable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  canRunPlaywrightChromium,
  resolvePlaywrightChromiumExecutablePath,
} from "../test-helpers/control-ui-e2e.ts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const chromiumExecutablePath = resolvePlaywrightChromiumExecutablePath(chromium.executablePath());
const chromiumAvailable = canRunPlaywrightChromium(chromiumExecutablePath);
const allowMissingChromium = process.env.OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM === "1";
const describeStandaloneMockServer =
  chromiumAvailable || !allowMissingChromium ? describe : describe.skip;

type FixtureProcess = ChildProcessByStdio<null, Readable, Readable>;

type FixtureServer = {
  child: FixtureProcess;
  url: string;
  output: () => string;
};

async function reservePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  return port;
}

async function startFixtureServer(): Promise<FixtureServer> {
  const port = await reservePort();
  const url = `http://127.0.0.1:${port}/__fixtures/board/`;
  const child = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      "scripts/control-ui-mock-dev.ts",
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
    ],
    {
      cwd: repoRoot,
      env: { ...process.env, CI: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let output = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    output += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    output += chunk;
  });

  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`Control UI mock server exited before startup\n${output}`);
    }
    try {
      const response = await fetch(url);
      if (response.ok) {
        return { child, url, output: () => output };
      }
    } catch {}
    await delay(100);
  }

  child.kill("SIGTERM");
  throw new Error(`timed out waiting for Control UI mock server\n${output}`);
}

async function stopFixtureServer(server: FixtureServer | undefined): Promise<void> {
  if (!server || server.child.exitCode !== null || server.child.signalCode !== null) {
    return;
  }
  const exited = once(server.child, "exit");
  server.child.kill("SIGTERM");
  await Promise.race([exited, delay(5_000)]);
  if (server.child.exitCode === null && server.child.signalCode === null) {
    server.child.kill("SIGKILL");
    await exited;
  }
}

function colorChannelToLinear(channel: number): number {
  const value = channel / 255;
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

function colorLuminance(color: string): number {
  const match = color.match(/^rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)$/);
  if (!match) {
    throw new Error(`unsupported computed color: ${color}`);
  }
  if (match[4] !== undefined && Number(match[4]) !== 1) {
    throw new Error(`transparent computed color requires compositing: ${color}`);
  }
  const channels = match.slice(1, 4).map(Number);
  return (
    0.2126 * colorChannelToLinear(channels[0]!) +
    0.7152 * colorChannelToLinear(channels[1]!) +
    0.0722 * colorChannelToLinear(channels[2]!)
  );
}

function colorContrast(foreground: string, background: string): number {
  const lighter = Math.max(colorLuminance(foreground), colorLuminance(background));
  const darker = Math.min(colorLuminance(foreground), colorLuminance(background));
  return (lighter + 0.05) / (darker + 0.05);
}

async function openWidgetMenu(page: Page): Promise<void> {
  const widget = page.locator('[data-test-id="board-widget"]').first();
  await widget.focus();
  await widget.locator(".board-widget__menu-trigger").click();
  await page.locator(".board-widget__menu[open]").waitFor();
}

async function readMenuColors(page: Page): Promise<{ background: string; foreground: string }> {
  return page.evaluate(() => {
    const dropdown = document.querySelector(".board-widget__menu");
    const item = dropdown?.querySelector("wa-dropdown-item:not(.board-widget__menu-danger)");
    const menu = dropdown?.shadowRoot?.querySelector('[part~="menu"]');
    if (!(item instanceof HTMLElement) || !(menu instanceof HTMLElement)) {
      throw new Error("board fixture menu did not expose its surface and first item");
    }
    return {
      background: getComputedStyle(menu).backgroundColor,
      foreground: getComputedStyle(item).color,
    };
  });
}

let browser: Browser;
let fixtureServer: FixtureServer;

describeStandaloneMockServer("standalone Control UI mock server", () => {
  beforeAll(async () => {
    fixtureServer = await startFixtureServer();
    browser = await chromium.launch({ executablePath: chromiumExecutablePath, headless: true });
  });

  afterAll(async () => {
    await browser?.close();
    await stopFixtureServer(fixtureServer);
  });

  for (const mode of ["dark", "light"] as const) {
    it(`themes dropdown items and widget frames in ${mode} mode`, async () => {
      const context = await browser.newContext({ colorScheme: mode });
      try {
        const page = await context.newPage();
        await page.goto(fixtureServer.url, { waitUntil: "networkidle" });
        await expect
          .poll(() =>
            page.locator("html").evaluate((root) => ({
              classes: [...root.classList],
              theme: (root as HTMLElement).dataset.theme,
              themeMode: (root as HTMLElement).dataset.themeMode,
            })),
          )
          .toEqual({ classes: [`wa-${mode}`], theme: mode, themeMode: mode });

        await openWidgetMenu(page);
        const colors = await readMenuColors(page);
        expect(colorContrast(colors.foreground, colors.background)).toBeGreaterThanOrEqual(4.5);

        const widgetBackgrounds = await page
          .locator('[data-test-id="board-widget"]')
          .first()
          .evaluate((widget) => {
            const frame = widget.querySelector(".board-widget__frame");
            if (!(frame instanceof HTMLIFrameElement)) {
              throw new Error("board widget frame is missing");
            }
            return {
              frame: getComputedStyle(frame).backgroundColor,
              widget: getComputedStyle(widget).backgroundColor,
            };
          });
        expect(widgetBackgrounds.frame).toBe(widgetBackgrounds.widget);
        expect(widgetBackgrounds.frame).not.toBe("rgba(0, 0, 0, 0)");

        await expect
          .poll(() => page.frames().some((frame) => frame.url().startsWith("data:text/html")))
          .toBe(true);
        const widgetFrame = page.frames().find((frame) => frame.url().startsWith("data:text/html"));
        expect(widgetFrame).toBeDefined();
        await expect
          .poll(() =>
            widgetFrame!.evaluate(() => getComputedStyle(document.documentElement).colorScheme),
          )
          .toBe(mode);
      } finally {
        await context.close();
      }
    });
  }

  it("follows live system color-scheme changes", async () => {
    const context = await browser.newContext({ colorScheme: "dark" });
    try {
      const page = await context.newPage();
      await page.goto(fixtureServer.url, { waitUntil: "networkidle" });
      await page.emulateMedia({ colorScheme: "light" });
      await expect.poll(() => page.locator("html").getAttribute("data-theme-mode")).toBe("light");
      await expect.poll(() => page.locator("html").getAttribute("class")).toBe("wa-light");
    } finally {
      await context.close();
    }
  });

  it("opens a visible catalog session with its transcript in chronological order", async () => {
    const page = await browser.newPage();
    try {
      await page.goto(new URL("/chat", fixtureServer.url).toString(), { waitUntil: "networkidle" });
      await page.getByText("Release checklist sweep", { exact: true }).click();

      const transcript = [
        "Please sweep the release checklist for anything we missed.",
        "The release checklist is complete and ready for review.",
      ];
      await Promise.all(transcript.map((text) => page.getByText(text, { exact: true }).waitFor()));

      await expect
        .poll(() =>
          page
            .locator(".chat-pane-cache__pane--active .chat-thread .chat-bubble")
            .allTextContents()
            .then((messages) => messages.map((message) => message.trim())),
        )
        .toEqual(transcript);
      expect(
        await page
          .getByText("Cannot read properties of undefined (reading 'toReversed')", { exact: false })
          .count(),
      ).toBe(0);
    } finally {
      await page.close();
    }
  });

  it("opens an idle generic session for ordinary sends", async () => {
    const page = await browser.newPage();
    try {
      await page.goto(new URL("/chat", fixtureServer.url).toString(), { waitUntil: "networkidle" });
      await page.getByText("OpenClaw work checkout", { exact: true }).click();

      await page.getByRole("button", { name: "Write a message to send." }).waitFor();
      expect(await page.getByRole("button", { name: "Stop" }).count()).toBe(0);
    } finally {
      await page.close();
    }
  });

  it("renders a deterministic reply after generic chat.send", async () => {
    const page = await browser.newPage();
    try {
      await page.goto(new URL("/chat", fixtureServer.url).toString(), { waitUntil: "networkidle" });
      await page.getByText("OpenClaw work checkout", { exact: true }).click();
      await page.getByRole("button", { name: "Write a message to send." }).waitFor();

      const prompt = "generic mock send probe";
      const composer = page.locator(
        ".chat-pane-cache__pane--active .agent-chat__composer-combobox textarea",
      );
      await composer.fill(prompt);
      await page.getByRole("button", { name: "Send message" }).click();

      await page
        .locator(".chat-thread-inner")
        .getByText(`Mock reply: ${prompt}`, { exact: true })
        .waitFor();
      expect(await composer.inputValue()).toBe("");
    } finally {
      await page.close();
    }
  });
});
