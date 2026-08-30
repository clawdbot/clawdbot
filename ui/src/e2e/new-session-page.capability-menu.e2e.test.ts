import { expect, it } from "vitest";
import {
  createNewSessionPageE2eSuite,
  installMockGateway,
  openNewSessionModeMenu,
  selectNewSessionMode,
} from "./new-session-page.test-support.ts";

const suite = createNewSessionPageE2eSuite();

suite.define(() => {
  it.each([
    {
      name: "desktop",
      viewport: { width: 1280, height: 900 },
    },
    {
      name: "mobile",
      viewport: { width: 390, height: 844 },
    },
  ])("shows one closed visibility selector on $name", async ({ viewport }) => {
    await suite.withPage({ viewport }, async ({ page }) => {
      await installMockGateway(page, {
        allowedSessionVisibilities: ["shared", "draft"],
        hasMultipleSessionSharingIdentities: true,
        operatorScopes: ["operator.read", "operator.write", "operator.admin"],
      });

      await page.goto(`${suite.server.baseUrl}new`);
      const composer = page.locator(".new-session-page__composer");
      const trigger = page.getByRole("button", { name: "Mode: Default" });
      await expect.poll(() => trigger.count()).toBe(1);
      const modeMenu = await openNewSessionModeMenu(page);
      await expect.poll(() => modeMenu.getByRole("menuitemradio").count()).toBe(3);
      expect(
        await modeMenu.getByRole("menuitemradio", { name: "Default" }).getAttribute("aria-checked"),
      ).toBe("true");
      await modeMenu.getByRole("menuitemradio", { name: "Draft" }).click();
      await page.getByRole("button", { name: "Mode: Draft" }).waitFor();

      await composer.getByRole("button", { name: "Add attachment" }).click();
      expect(await composer.getByRole("menuitem", { name: "Draft" }).count()).toBe(0);
    });
  });

  it("creates the first turn with Draft and selected capabilities atomically", async () => {
    await suite.withPage({ viewport: { width: 555, height: 1200 } }, async ({ page }) => {
      const config = {
        mcp: {
          servers: {
            github: { enabled: true, url: "https://mcp.example.test" },
          },
        },
        tools: { web: { search: { provider: "brave" } } },
      };
      const gateway = await installMockGateway(page, {
        allowedSessionVisibilities: ["shared", "draft"],
        hasMultipleSessionSharingIdentities: true,
        operatorScopes: ["operator.read", "operator.write", "operator.admin"],
        methodResponses: {
          "config.get": {
            raw: JSON.stringify(config),
            hash: "new-session-capabilities",
            sourceConfig: config,
            runtimeConfig: config,
            config,
          },
          "skills.status": {
            workspaceDir: "/tmp/openclaw-e2e/workspace",
            managedSkillsDir: "/tmp/openclaw-e2e/skills",
            skills: [
              {
                name: "Release",
                description: "Prepare a release",
                source: "test",
                filePath: "/tmp/openclaw-e2e/skills/release/SKILL.md",
                baseDir: "/tmp/openclaw-e2e/skills/release",
                skillKey: "release",
                always: false,
                disabled: false,
                blockedByAllowlist: false,
                eligible: true,
                requirements: { anyBins: [], bins: [], env: [], config: [], os: [] },
                missing: { anyBins: [], bins: [], env: [], config: [], os: [] },
                configChecks: [],
                install: [],
              },
            ],
          },
          "sessions.create": {
            key: "agent:main:new-session-capabilities",
            runStarted: true,
          },
        },
      });

      await page.goto(`${suite.server.baseUrl}new`);
      const composer = page.locator(".new-session-page__composer");
      const menu = composer.locator("wa-dropdown.agent-chat__capability-menu");
      await selectNewSessionMode(page, "Draft");
      await composer.getByRole("button", { name: "Add attachment" }).click();
      await expect.poll(() => menu.getAttribute("data-view")).toBe("root");

      await menu.getByRole("menuitem", { name: /^Skills/ }).click();
      await expect.poll(() => menu.getAttribute("data-view")).toBe("skills");
      const release = menu.getByRole("menuitem", { name: "Release" });
      await expect.poll(() => release.isEnabled()).toBe(true);
      await release.click();
      await menu.getByRole("menuitem", { name: "Back" }).click();

      await menu.getByRole("menuitem", { name: /^Connectors/ }).click();
      await expect.poll(() => menu.getAttribute("data-view")).toBe("connectors");
      await menu.getByRole("menuitem", { name: /^github/ }).click();
      await menu.getByRole("menuitem", { name: "Back" }).click();
      await menu.getByRole("menuitemcheckbox", { name: "Web search" }).click();

      await expect
        .poll(async () =>
          (await composer.locator(".new-session-page__selection-status").allTextContents()).map(
            (text) => text.replace(/\s+/g, " ").trim(),
          ),
        )
        .toEqual(["3 overrides"]);
      await page.locator(".new-session-page__message").fill("prepare the release");
      await composer.getByRole("button", { name: "Start session" }).click();

      const create = await gateway.waitForRequest("sessions.create");
      expect(create.params).toMatchObject({
        agentId: "main",
        message: "prepare the release",
        visibility: "draft",
        toolOverrides: {
          mcpServers: { github: false },
          skills: { release: false },
          webSearch: false,
        },
      });
      expect(await gateway.getRequests("sessions.create")).toHaveLength(1);
      expect(await gateway.getRequests("sessions.patch")).toHaveLength(0);
    });
  });
});
