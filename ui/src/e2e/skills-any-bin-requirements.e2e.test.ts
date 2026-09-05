// Control UI coverage proves alternative skill binaries remain diagnosable and installable.
import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI alternative skill binary requirements",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) => `Playwright Chromium is unavailable at ${executablePath}`,
});

function codingAgentSkill(missingAnyBins: string[]) {
  return {
    name: "Coding Agent",
    description: "Delegate coding work to an available coding CLI.",
    source: "openclaw-bundled",
    bundled: true,
    filePath: "/tmp/openclaw-e2e/skills/coding-agent/SKILL.md",
    baseDir: "/tmp/openclaw-e2e/skills/coding-agent",
    skillKey: "coding-agent",
    always: false,
    disabled: false,
    blockedByAllowlist: false,
    blockedByAgentFilter: false,
    eligible: missingAnyBins.length === 0,
    platformIncompatible: false,
    modelVisible: missingAnyBins.length === 0,
    userInvocable: true,
    commandVisible: missingAnyBins.length === 0,
    requirements: {
      bins: [],
      anyBins: ["claude", "codex", "opencode"],
      env: [],
      config: [],
      os: [],
    },
    missing: {
      bins: [],
      anyBins: missingAnyBins,
      env: [],
      config: [],
      os: [],
    },
    configChecks: [],
    install: [
      {
        id: "node-codex",
        kind: "node",
        label: "Install Codex CLI (npm)",
        bins: ["codex"],
      },
    ],
  };
}

suite.define(() => {
  it("explains alternative missing binaries and installs one through the Gateway", async () => {
    await suite.withPage(
      {
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 900, width: 1280 },
      },
      async ({ page }) => {
        const gateway = await installMockGateway(page, {
          featureMethods: ["chat.metadata", "chat.startup", "skills.install"],
          methodResponses: {
            "skills.status": {
              workspaceDir: "/tmp/openclaw-e2e/workspace",
              managedSkillsDir: "/tmp/openclaw-e2e/skills",
              skills: [codingAgentSkill(["claude", "codex", "opencode"])],
            },
            "skills.install": { message: "Installed Codex CLI" },
          },
        });

        const response = await page.goto(`${suite.server.baseUrl}skills`);
        expect(response?.status()).toBe(200);
        await page.getByRole("button", { name: "Open Coding Agent details" }).click();

        const dialog = page.locator("openclaw-modal-dialog", { hasText: "Coding Agent" });
        await expect.poll(async () => await dialog.count()).toBe(1);
        expect(await dialog.textContent()).toContain("bin:any of (claude, codex, opencode)");
        await dialog.getByRole("button", { name: "Install Codex CLI (npm)" }).click();

        const request = await gateway.waitForRequest("skills.install");
        expect(request.params).toMatchObject({
          name: "Coding Agent",
          installId: "node-codex",
          dangerouslyForceUnsafeInstall: false,
        });
      },
    );
  });

  it("does not show missing alternatives or an installer for an eligible skill", async () => {
    await suite.withPage(
      {
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 900, width: 1280 },
      },
      async ({ page }) => {
        await installMockGateway(page, {
          methodResponses: {
            "skills.status": {
              workspaceDir: "/tmp/openclaw-e2e/workspace",
              managedSkillsDir: "/tmp/openclaw-e2e/skills",
              skills: [codingAgentSkill([])],
            },
          },
        });

        const response = await page.goto(`${suite.server.baseUrl}skills`);
        expect(response?.status()).toBe(200);
        await page.getByRole("button", { name: "Open Coding Agent details" }).click();

        const dialog = page.locator("openclaw-modal-dialog", { hasText: "Coding Agent" });
        await expect.poll(async () => await dialog.count()).toBe(1);
        expect(await dialog.getByText("bin:any of", { exact: false }).count()).toBe(0);
        expect(await dialog.getByRole("button", { name: "Install Codex CLI (npm)" }).count()).toBe(
          0,
        );
      },
    );
  });
});
