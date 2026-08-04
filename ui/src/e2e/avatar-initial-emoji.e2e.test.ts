// Control UI E2E: grapheme-aware avatar initials remain intact across every
// live agent-avatar fallback surface.
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium, type Browser, type Page } from "playwright";
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
const captureUiProof = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
const proofDir = path.join(process.cwd(), ".artifacts", "control-ui-e2e", "avatar-initial-emoji");

const emojiAgent = { id: "emoji", identity: { name: "🚀Rocket" }, name: "🚀Rocket" };
const asciiAgent = { id: "main", identity: { name: "Main" }, name: "Main" };
const emojiGrapheme = "🚀";
const agentsList = {
  defaultId: "main",
  mainKey: "main",
  scope: "agent",
  agents: [asciiAgent, emojiAgent],
};
const agentIdentities = {
  cases: [
    {
      match: { agentId: "emoji" },
      response: { agentId: "emoji", avatar: "", avatarStatus: "none", name: "🚀Rocket" },
    },
    {
      match: { agentId: "main" },
      response: { agentId: "main", avatar: "", avatarStatus: "none", name: "Main" },
    },
  ],
};

let browser: Browser;
let server: ControlUiE2eServer;

async function screenshot(page: Page, name: string) {
  if (!captureUiProof) {
    return;
  }
  await mkdir(proofDir, { recursive: true });
  await page.screenshot({
    animations: "disabled",
    fullPage: true,
    path: path.join(proofDir, name),
  });
}

describeControlUiE2e("Control UI grapheme-aware avatar initials", () => {
  beforeAll(async () => {
    if (!chromiumAvailable) {
      throw new Error(`Playwright Chromium is not available at ${chromiumExecutablePath}`);
    }
    server = await startControlUiE2eServer();
    browser = await chromium.launch({ executablePath: chromiumExecutablePath });
  });

  afterAll(async () => {
    await browser?.close();
    await server?.close();
  });

  it("renders the emoji grapheme initial in the sidebar chip and agent menu row", async () => {
    const context = await browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1440 },
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      defaultAgentId: "main",
      methodResponses: {
        "agent.identity.get": agentIdentities,
        "agents.list": agentsList,
        "chat.startup": {
          agentsList,
          messages: [],
          metadata: { models: [] },
          sessionId: "control-ui-e2e-session",
          thinkingLevel: null,
        },
        "sessions.list": {
          count: 0,
          defaults: { contextTokens: null, model: null, modelProvider: null },
          path: "",
          sessions: [],
          ts: Date.now(),
        },
      },
    });

    try {
      const response = await page.goto(`${server.baseUrl}usage`);
      expect(response?.status()).toBe(200);
      await gateway.waitForRequest("agents.list");
      const sidebar = page.locator("openclaw-app-sidebar");

      await sidebar.getByRole("button", { name: /Switch agent/ }).click();
      const emojiRow = sidebar
        .locator("wa-dropdown.sidebar-agent-menu")
        .getByRole("menuitemradio", { name: "🚀Rocket", exact: true });
      const menuAvatar = emojiRow.locator(".agent-select__avatar--text");
      await expect.poll(() => menuAvatar.getAttribute("data-avatar")).toBe(emojiGrapheme);
      // The shared picker paints its text through CSS, not a text node.
      await expect
        .poll(() => menuAvatar.evaluate((element) => getComputedStyle(element, "::before").content))
        .toContain(emojiGrapheme);
      await screenshot(page, "01-sidebar-menu-emoji.png");

      await emojiRow.click();
      await expect
        .poll(async () =>
          (await gateway.getRequests("sessions.list")).some(
            (request) =>
              request.params && (request.params as { agentId?: string }).agentId === "emoji",
          ),
        )
        .toBe(true);
      await expect
        .poll(() => sidebar.locator(".sidebar-agent-card__avatar-text").textContent())
        .toBe(emojiGrapheme);
      await screenshot(page, "01-sidebar-chip-emoji.png");
    } finally {
      await context.close();
    }
  });

  it("renders the emoji grapheme initial in the agent selector dropdown", async () => {
    const context = await browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1440 },
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      defaultAgentId: "main",
      methodResponses: {
        "agent.identity.get": agentIdentities,
        "agents.list": agentsList,
      },
    });

    try {
      const response = await page.goto(`${server.baseUrl}agents`);
      expect(response?.status()).toBe(200);
      await gateway.waitForRequest("agents.list");
      const agentSelect = page.locator("openclaw-agents-page openclaw-agent-select");
      await agentSelect.locator(".agent-select__trigger").click();
      const emojiItem = agentSelect.getByRole("menuitemradio", {
        name: "🚀Rocket",
        exact: true,
      });
      const pickerAvatar = emojiItem.locator(".agent-select__avatar--text");
      await expect.poll(() => pickerAvatar.getAttribute("data-avatar")).toBe(emojiGrapheme);
      await expect
        .poll(() =>
          pickerAvatar.evaluate((element) => getComputedStyle(element, "::before").content),
        )
        .toContain(emojiGrapheme);
      await screenshot(page, "02-agent-selector-emoji.png");
    } finally {
      await context.close();
    }
  });

  it("renders the emoji grapheme initial in the agents overview identity editor", async () => {
    const context = await browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1440 },
    });
    const page = await context.newPage();
    const config = { agents: { list: [{ id: "main" }, { id: "emoji" }] } };
    const gateway = await installMockGateway(page, {
      defaultAgentId: "main",
      methodResponses: {
        "agent.identity.get": agentIdentities,
        "agents.list": agentsList,
        "config.get": {
          config,
          sourceConfig: config,
          hash: "hash-1",
          issues: [],
          raw: JSON.stringify(config),
          valid: true,
        },
      },
    });

    try {
      const response = await page.goto(`${server.baseUrl}settings/agents/main/tools`);
      expect(response?.status()).toBe(200);
      await gateway.waitForRequest("agents.list");
      await gateway.waitForRequest("config.get");
      const agentSelect = page.locator("openclaw-agents-page openclaw-agent-select");
      await agentSelect.locator(".agent-select__trigger").click();
      await agentSelect.getByRole("menuitemradio", { name: "🚀Rocket", exact: true }).click();
      await expect.poll(() => new URL(page.url()).pathname).toBe("/settings/agents/emoji/tools");
      await page.getByRole("tab", { name: "Overview", exact: true }).click();
      await expect.poll(() => new URL(page.url()).pathname).toBe("/settings/agents/emoji/overview");
      await expect
        .poll(() => page.locator(".agent-identity-editor__avatar-text").textContent())
        .toBe(emojiGrapheme);
      await screenshot(page, "03-agents-overview-emoji.png");
    } finally {
      await context.close();
    }
  });
});
