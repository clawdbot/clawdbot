// Control UI E2E tests cover composable skill references in the chat composer.
import path from "node:path";
import { chromium, type Browser } from "playwright";
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

let server: ControlUiE2eServer;
let browser: Browser;

describeControlUiE2e("Control UI skill references", () => {
  beforeAll(async () => {
    browser = await chromium.launch({ executablePath: chromiumExecutablePath });
    try {
      server = await startControlUiE2eServer();
    } catch (error) {
      await browser.close();
      throw error;
    }
  });

  afterAll(async () => {
    await browser?.close();
    await server?.close();
  });

  it("references multiple skills inside a normal prompt and sends the visible tokens", async () => {
    const artifactDir = process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR?.trim();
    const context = await browser.newContext({
      viewport: { width: 1280, height: 900 },
      ...(artifactDir
        ? { recordVideo: { dir: artifactDir, size: { width: 1280, height: 900 } } }
        : {}),
    });
    const page = await context.newPage();
    const commands = [
      {
        acceptsArgs: true,
        description: "Pre-commit and ship code review.",
        name: "autoreview",
        scope: "both",
        source: "skill",
        skillModelVisible: true,
        textAliases: ["/autoreview"],
      },
      {
        acceptsArgs: true,
        description: "Build and review technical documentation.",
        name: "technical_documentation",
        scope: "both",
        source: "skill",
        skillModelVisible: true,
        textAliases: ["/technical_documentation"],
      },
      {
        acceptsArgs: false,
        description: "Show gateway status.",
        name: "status",
        scope: "both",
        source: "native",
        textAliases: ["/status"],
      },
    ];
    const gateway = await installMockGateway(page, {
      deferredMethods: ["chat.send"],
      methodResponses: {
        "chat.startup": {
          agentsList: {
            agents: [{ id: "main", name: "OpenClaw" }],
            defaultId: "main",
            mainKey: "main",
            scope: "agent",
          },
          messages: [],
          metadata: { commands, models: [] },
          sessionId: "skill-reference-session",
          thinkingLevel: null,
        },
        "commands.list": { commands },
      },
    });

    try {
      await page.goto(`${server.baseUrl}chat`);
      await gateway.waitForRequest("chat.startup");
      const composer = page.locator(".agent-chat__composer-combobox textarea");
      await composer.fill("Review this with $auto");

      const picker = page.getByRole("listbox", { name: "Skill references" });
      await picker.waitFor({ state: "visible" });
      await expect.poll(() => picker.getByRole("option").count()).toBe(1);
      await expect
        .poll(() => picker.getByRole("option").first().textContent())
        .toContain("$autoreview");
      await composer.press("Enter");
      await expect.poll(() => composer.inputValue()).toBe("Review this with $autoreview ");

      await composer.fill(`${await composer.inputValue()}and $technical`);
      await expect.poll(() => picker.getByRole("option").count()).toBe(1);
      await composer.press("Tab");
      await expect
        .poll(() => composer.inputValue())
        .toBe("Review this with $autoreview and $technical_documentation ");

      if (artifactDir) {
        await page.screenshot({
          path: path.join(artifactDir, "skill-references-selected.png"),
          fullPage: true,
        });
      }

      await page.getByRole("button", { name: "Send message" }).click();
      const request = await gateway.waitForRequest("chat.send");
      expect((request.params as { message?: unknown }).message).toBe(
        "Review this with $autoreview and $technical_documentation",
      );

      await composer.fill("Print $HOME");
      await expect.poll(() => picker.count()).toBe(0);
      await composer.fill("/");
      await page.getByRole("listbox", { name: "Slash commands" }).waitFor({ state: "visible" });
      await expect.poll(() => page.getByRole("option", { name: /\/status/u }).count()).toBe(1);
    } finally {
      await context.close();
    }
  });
});
