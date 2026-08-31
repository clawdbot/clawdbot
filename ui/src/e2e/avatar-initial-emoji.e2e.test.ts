// Control UI E2E: grapheme-aware avatar initials remain intact across every
// live agent-avatar fallback surface.
import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { Page } from "playwright";
import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI grapheme-aware avatar initials",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) =>
    `Playwright Chromium is not available at ${executablePath}`,
});

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

suite.define(() => {
  it("renders the emoji grapheme initial in the sidebar chip and agent menu row", async () => {
    await suite.withPage(
      {
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 900, width: 1440 },
      },
      async ({ page }) => {
        const gateway = await installMockGateway(page, {
          defaultAgentId: "main",
          methodResponses: {
            "agent.identity.get": agentIdentities,
            "agents.list": agentsList,
            "chat.startup": {
              agentsList,
              messages: [],
              metadata: { models: [] },
              sessionId: "session:agent:main:main",
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

        const response = await page.goto(`${suite.server.baseUrl}usage`);
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
          .poll(() =>
            menuAvatar.evaluate((element) => getComputedStyle(element, "::before").content),
          )
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
      },
    );
  });

  it("renders the emoji grapheme initial in the agent selector dropdown", async () => {
    await suite.withPage(
      {
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 900, width: 1440 },
      },
      async ({ page }) => {
        const gateway = await installMockGateway(page, {
          defaultAgentId: "main",
          methodResponses: {
            "agent.identity.get": agentIdentities,
            "agents.list": agentsList,
          },
        });

        const response = await page.goto(`${suite.server.baseUrl}agents`);
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
      },
    );
  });

  it("renders the emoji grapheme initial in the agents overview identity editor", async () => {
    await suite.withPage(
      {
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 900, width: 1440 },
      },
      async ({ page }) => {
        const config = { agents: { list: [{ id: "main" }, { id: "emoji" }] } };
        const hydratedEmojiAgent = { id: "emoji", identity: { name: "Rocket" }, name: "Rocket" };
        const gateway = await installMockGateway(page, {
          defaultAgentId: "main",
          methodResponses: {
            "agent.identity.get": {
              cases: [
                {
                  match: { agentId: "emoji" },
                  response: {
                    agentId: "emoji",
                    avatar: "",
                    avatarStatus: "none",
                    emoji: emojiGrapheme,
                    name: "Rocket",
                  },
                },
                agentIdentities.cases[1],
              ],
            },
            "agents.list": { ...agentsList, agents: [asciiAgent, hydratedEmojiAgent] },
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

        const response = await page.goto(`${suite.server.baseUrl}settings/agents/main/tools`);
        expect(response?.status()).toBe(200);
        await gateway.waitForRequest("agents.list");
        await gateway.waitForRequest("config.get");
        const agentSelect = page.locator("openclaw-agents-page openclaw-agent-select");
        await agentSelect.locator(".agent-select__trigger").click();
        await agentSelect.getByRole("menuitemradio", { name: "Rocket", exact: true }).click();
        await expect.poll(() => new URL(page.url()).pathname).toBe("/settings/agents/emoji/tools");
        await page.getByRole("tab", { name: "Overview", exact: true }).click();
        await expect
          .poll(() => new URL(page.url()).pathname)
          .toBe("/settings/agents/emoji/overview");
        await expect
          .poll(() => page.locator(".agent-identity-editor__emoji input").inputValue())
          .toBe(emojiGrapheme);
        await screenshot(
          page,
          `03-agents-overview-${process.env.OPENCLAW_UI_PROOF_LABEL ?? "emoji"}.png`,
        );
        await expect
          .poll(() => page.locator(".agent-identity-editor__avatar-text").textContent())
          .toBe(emojiGrapheme);
      },
    );
  });
});
