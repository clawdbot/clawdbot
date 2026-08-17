// Control UI regression coverage for inherited agent skill allowlists.
import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "PR #124429 inherited skill allowlist proof",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) =>
    `Chromium unavailable at ${executablePath}; exact-head Control UI proof cannot run locally.`,
});

const config = {
  agents: {
    defaults: { skills: ["github"] },
    entries: { main: { default: true } },
  },
};

const skill = (name: string, blockedByAgentFilter: boolean) => ({
  name,
  description: `${name} skill`,
  source: "openclaw-managed",
  bundled: false,
  filePath: `/tmp/skills/${name}/SKILL.md`,
  baseDir: `/tmp/skills/${name}`,
  skillKey: name,
  always: false,
  disabled: false,
  blockedByAllowlist: false,
  blockedByAgentFilter,
  eligible: true,
  requirements: { bins: [], anyBins: [], env: [], config: [], os: [] },
  missing: { bins: [], anyBins: [], env: [], config: [], os: [] },
  configChecks: [],
  install: [],
});

suite.define(() => {
  it("renders inherited filtering in the bundled Control UI", async () => {
    await suite.withPage(
      { locale: "en-US", serviceWorkers: "block", viewport: { height: 900, width: 1440 } },
      async ({ page }) => {
        const gateway = await installMockGateway(page, {
          methodResponses: {
            "agents.list": {
              agents: [{ id: "main", identity: { name: "Main" }, name: "Main" }],
              defaultId: "main",
              mainKey: "main",
              scope: "agent",
            },
            "config.get": {
              config,
              sourceConfig: config,
              runtimeConfig: config,
              hash: "pr-124429-proof-1",
              issues: [],
              raw: JSON.stringify(config),
              valid: true,
            },
            "skills.status": {
              agentId: "main",
              agentSkillFilter: ["github"],
              workspaceDir: "/tmp/workspace",
              managedSkillsDir: "/tmp/skills",
              skills: [skill("github", false), skill("weather", true)],
            },
          },
        });

        try {
          const response = await page.goto(`${suite.server.baseUrl}settings/agents/main/skills`);
          expect(response?.status()).toBe(200);
          await gateway.waitForRequest("skills.status");

          await expect
            .poll(() => page.locator(".callout.info").first().textContent())
            .toContain("inherits the default skill allowlist");

          const rows = page.locator(".agent-skill-row");
          const github = rows.filter({ hasText: "github skill" }).locator("wa-switch");
          const weather = rows.filter({ hasText: "weather skill" }).locator("wa-switch");
          await expect.poll(() => rows.count()).toBe(2);
          await expect
            .poll(() => github.evaluate((element) => (element as { checked: boolean }).checked))
            .toBe(true);
          await expect
            .poll(() => weather.evaluate((element) => (element as { checked: boolean }).checked))
            .toBe(false);

          const section = page.locator(".settings-section", { hasText: "Skills" }).first();
          await expect
            .poll(() => section.getByRole("button", { name: "Enable All" }).count())
            .toBe(0);
          await expect
            .poll(() => section.getByRole("button", { name: "Disable All" }).isDisabled())
            .toBe(false);
          await expect
            .poll(() => section.getByRole("button", { name: "Reset" }).isDisabled())
            .toBe(true);
        } finally {
          await suite.closeBrowserContext(page.context());
        }
      },
    );
  });
});
