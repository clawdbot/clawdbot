import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Developer Mode Tool mode" });
const proofDir = path.join(process.cwd(), ".artifacts", "control-ui-e2e", "developer-mode");

const toolModes = [
  {
    pluginId: "developer-mode",
    pluginName: "Developer Mode",
    id: "standard",
    label: "Standard",
    description: "Best for most work",
    controlLabel: "Tool mode",
    default: true,
    toolProfile: "coding",
    codeMode: "direct",
  },
  {
    pluginId: "developer-mode",
    pluginName: "Developer Mode",
    id: "code",
    label: "Code",
    description: "Combine several actions efficiently",
    controlLabel: "Tool mode",
    toolProfile: "coding",
    codeMode: "code",
  },
  {
    pluginId: "developer-mode",
    pluginName: "Developer Mode",
    id: "minimal",
    label: "Minimal",
    description: "Use a smaller, focused toolset",
    controlLabel: "Tool mode",
    toolProfile: "minimal",
    codeMode: "direct",
  },
];

suite.define(() => {
  it("selects Tool mode from the chat plus menu", async () => {
    await suite.withPage({ viewport: { width: 1440, height: 1000 } }, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        methodResponses: {
          "plugins.uiDescriptors": { ok: true, descriptors: [], toolModes },
          "sessions.list": {
            count: 1,
            defaults: { contextTokens: 200_000, model: "gpt-5.5", modelProvider: "openai" },
            path: "",
            sessions: [
              {
                key: "main",
                kind: "direct",
                model: "gpt-5.5",
                modelProvider: "openai",
                status: "done",
                updatedAt: 1,
                agentRuntime: { id: "openclaw" },
              },
            ],
            ts: 1,
          },
        },
      });
      await page.goto(`${suite.server.baseUrl}chat`);
      await gateway.waitForRequest("chat.startup");
      await gateway.waitForRequest("plugins.uiDescriptors");

      const sessionMenu = page.locator("openclaw-chat-header-session-menu");
      await expect
        .poll(() => sessionMenu.getByRole("menuitem", { name: "Tool mode" }).count())
        .toBe(0);

      const plusMenu = page.locator("wa-dropdown.agent-chat__capability-menu");
      await plusMenu.evaluate((element) => {
        element.setAttribute("data-proof-state", "opening");
        element.addEventListener(
          "wa-after-show",
          () => element.setAttribute("data-proof-state", "open"),
          { once: true },
        );
      });
      await page.locator(".agent-chat__input-btn--attach").click();
      await expect.poll(() => plusMenu.getAttribute("data-proof-state")).toBe("open");
      const toolMode = page.getByRole("menuitem", { name: "Tool mode" });
      await toolMode.waitFor();
      if (process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR) {
        await mkdir(proofDir, { recursive: true });
        await page.screenshot({ path: path.join(proofDir, "chat-plus-menu-code.png") });
      }
      await toolMode.hover();
      await page.getByRole("menuitemradio", { name: "Code" }).click();

      const patch = await gateway.waitForRequest("sessions.patch");
      expect(patch.params).toMatchObject({
        toolMode: { pluginId: "developer-mode", modeId: "code" },
      });
    });
  });

  it("selects Tool mode from the New Session plus menu", async () => {
    await suite.withPage({ viewport: { width: 1440, height: 1000 } }, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        methodResponses: {
          "plugins.uiDescriptors": { ok: true, descriptors: [], toolModes },
        },
      });
      await page.goto(`${suite.server.baseUrl}new`);
      await gateway.waitForRequest("plugins.uiDescriptors");
      const plusMenu = page.locator(
        ".new-session-page__composer wa-dropdown.agent-chat__capability-menu",
      );
      await plusMenu.evaluate((element) => {
        element.setAttribute("data-proof-state", "opening");
        element.addEventListener(
          "wa-after-show",
          () => element.setAttribute("data-proof-state", "open"),
          { once: true },
        );
      });
      await page.locator(".new-session-page__composer .agent-chat__input-btn--attach").click();
      await expect.poll(() => plusMenu.getAttribute("data-proof-state")).toBe("open");
      const toolMode = page.getByRole("menuitem", { name: "Tool mode" });
      await toolMode.waitFor();
      if (process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR) {
        await mkdir(proofDir, { recursive: true });
        await page.screenshot({ path: path.join(proofDir, "new-session-plus-menu.png") });
      }
      await toolMode.hover();
      await page.getByRole("menuitemradio", { name: "Minimal" }).click();
      await page.locator(".new-session-page__message").fill("Start a focused session");
      await page.getByRole("button", { name: "Start session" }).click();

      const create = await gateway.waitForRequest("sessions.create");
      expect(create.params).toMatchObject({
        toolMode: { pluginId: "developer-mode", modeId: "minimal" },
      });
    });
  });
});
