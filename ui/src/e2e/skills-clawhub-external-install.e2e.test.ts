import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI external ClawHub skill install E2E",
  startServerBeforeBrowser: true,
});

const emptyStatus = {
  workspaceDir: "/tmp/openclaw-e2e/workspace",
  managedSkillsDir: "/tmp/openclaw-e2e/skills",
  skills: [],
};

const installedStatus = {
  ...emptyStatus,
  skills: [
    {
      name: "pdf",
      description: "PDF tools",
      source: "clawhub",
      filePath: "/tmp/openclaw-e2e/skills/pdf/SKILL.md",
      baseDir: "/tmp/openclaw-e2e/skills/pdf",
      skillKey: "pdf",
      always: false,
      disabled: false,
      blockedByAllowlist: false,
      eligible: true,
      requirements: { anyBins: [], bins: [], env: [], config: [], os: [] },
      missing: { anyBins: [], bins: [], env: [], config: [], os: [] },
      configChecks: [],
      install: [],
      clawhub: {
        status: "linked",
        valid: true,
        registry: "https://clawhub.ai",
        slug: "pdf",
        requestedReference: "skills-sh:openai/skills/pdf",
        installedVersion: "0.0.0",
        installedAt: 1,
      },
    },
  ],
};

suite.define(() => {
  it("searches, installs the exact skills.sh reference, and renders installed state", async () => {
    await suite.withPage({ serviceWorkers: "block" }, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        featureMethods: [
          "chat.metadata",
          "chat.startup",
          "skills.status",
          "skills.search",
          "skills.detail",
          "skills.install",
        ],
        methodResponses: {
          "skills.status": emptyStatus,
          "skills.search": {
            results: [
              {
                score: 1,
                slug: "pdf",
                installRef: "skills-sh:openai/skills/pdf",
                installOnly: true,
                trustState: "not-scanned-by-clawhub",
                displayName: "Pdf",
              },
            ],
          },
          "skills.install": { message: "Installed pdf" },
        },
      });

      const response = await page.goto(`${suite.server.baseUrl}skills`);
      expect(response?.status()).toBe(200);
      await gateway.waitForRequest("skills.status");

      await page.locator('input[name="clawhub-search"]').fill("pdf");
      await gateway.waitForRequest("skills.search");
      const row = page.locator(".plugins-item", { hasText: "skills-sh:openai/skills/pdf" });
      const install = row.getByRole("button", { name: "Install", exact: true });
      await install.waitFor();

      await gateway.deferNext("skills.install");
      await install.click();
      const installRequest = await gateway.waitForRequest("skills.install");
      expect(installRequest.params).toEqual(
        expect.objectContaining({
          source: "clawhub",
          slug: "skills-sh:openai/skills/pdf",
        }),
      );

      await gateway.setMethodResponse("skills.status", installedStatus);
      await gateway.resolveDeferred("skills.install", { message: "Installed pdf" });

      const installed = row.getByRole("button", { name: "Installed", exact: true });
      await installed.waitFor();
      expect(await installed.isDisabled()).toBe(true);
    });
  });
});
