// Control UI E2E tests cover composable skill references in the chat composer.
import path from "node:path";
import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI skill references",
});

suite.define(() => {
  it("references multiple skills inside a normal prompt and sends their raw names", async () => {
    const artifactDir = process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR?.trim();
    await suite.withPage(
      {
        viewport: { width: 1280, height: 900 },
        ...(artifactDir
          ? { recordVideo: { dir: artifactDir, size: { width: 1280, height: 900 } } }
          : {}),
      },
      async ({ page }) => {
        const commands = [
          {
            acceptsArgs: true,
            description: "Pre-commit and ship code review.",
            name: "autoreview",
            skillDisplayName: "Auto Review",
            scope: "both",
            source: "skill",
            skillModelVisible: true,
            textAliases: ["/autoreview"],
          },
          {
            acceptsArgs: true,
            description: "Build and review technical documentation.",
            name: "technical_documentation",
            skillDisplayName: "Technical Documentation",
            scope: "both",
            source: "skill",
            skillModelVisible: true,
            textAliases: ["/technical_documentation"],
          },
          {
            acceptsArgs: true,
            description: "Prepare a detailed status report.",
            name: "status_report",
            skillDisplayName: "Status Report",
            scope: "both",
            source: "skill",
            skillModelVisible: true,
            textAliases: ["/status_report"],
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

        await page.goto(`${suite.server.baseUrl}chat`);
        await gateway.waitForRequest("chat.startup");
        const composer = page.locator(".agent-chat__composer-combobox textarea");
        await composer.fill("Review this with $auto");

        const picker = page.getByRole("listbox", { name: "Skill references" });
        await picker.waitFor({ state: "visible" });
        await expect.poll(() => picker.getByRole("option").count()).toBe(1);
        await expect
          .poll(() => picker.getByRole("option").first().textContent())
          .toContain("Auto Review");
        if (artifactDir) {
          await page.screenshot({
            path: path.join(artifactDir, "skill-reference-picker.png"),
            fullPage: true,
          });
        }
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
        await expect.poll(() => page.getByRole("option", { name: /\/status/u }).count()).toBe(2);

        const slashOptions = page
          .getByRole("listbox", { name: "Slash commands" })
          .getByRole("option");
        await composer.fill("/sta");
        await expect
          .poll(async () => {
            const names = await slashOptions.locator(".slash-menu-name").allTextContents();
            return { first: names[0], last: names.at(-1) };
          })
          .toEqual({ first: "/status", last: "/status_report" });
        await composer.press("Tab");
        await expect.poll(() => composer.inputValue()).toBe("/status");
      },
    );
  });
});
