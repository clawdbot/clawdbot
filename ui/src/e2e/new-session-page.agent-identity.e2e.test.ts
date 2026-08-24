import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { BrowserContextOptions, Locator, Page } from "playwright";
import { expect, it } from "vitest";
import {
  createNewSessionPageE2eSuite,
  installMockGateway,
  pollLocatorText,
} from "./new-session-page.test-support.ts";

const suite = createNewSessionPageE2eSuite();
const captureProof = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
const proofStage = process.env.OPENCLAW_AGENT_IDENTITY_PROOF_STAGE ?? "after";
const captureBefore = proofStage === "before";
const proofDir = path.join(
  process.cwd(),
  ".artifacts",
  "control-ui-e2e",
  "new-session-agent-identity",
);

const agentsList = {
  agents: [
    { id: "main", workspace: "/home/operator/pacino", workspaceGit: true },
    { id: "research", workspace: "/home/operator/research", workspaceGit: true },
    { id: "release", workspace: "/home/operator/release", workspaceGit: true },
  ],
  defaultId: "main",
  mainKey: "main",
  scope: "agent",
};

const agentIdentities = {
  cases: [
    {
      match: { agentId: "main" },
      response: {
        agentId: "main",
        avatar: "🎬",
        avatarStatus: "none",
        name: "Pacino",
        nameSource: "workspace",
      },
    },
    {
      match: { agentId: "research" },
      response: {
        agentId: "research",
        avatar: "A",
        avatarStatus: "none",
        name: "Assistant",
        nameSource: "default",
      },
    },
    {
      match: { agentId: "release" },
      response: {
        agentId: "release",
        avatar: "R",
        avatarStatus: "none",
        name: "Deployment Safety and Release Verification Agent",
        nameSource: "agent",
      },
    },
  ],
};

const CONTEXT: BrowserContextOptions = {
  locale: "en-US",
  serviceWorkers: "block",
  viewport: { height: 900, width: 1440 },
};

async function setTheme(page: Page, mode: "dark" | "light") {
  await page.emulateMedia({ colorScheme: mode });
  await page.evaluate((nextMode) => {
    const root = document.documentElement;
    root.dataset.themeMode = nextMode;
    root.dataset.themeResolved = nextMode;
    root.classList.toggle("wa-light", nextMode === "light");
    root.classList.toggle("wa-dark", nextMode === "dark");
    root.style.colorScheme = nextMode;
  }, mode);
}

async function capture(page: Page, name: string) {
  if (!captureProof) {
    return;
  }
  await mkdir(proofDir, { recursive: true });
  await page.screenshot({
    animations: "disabled",
    fullPage: true,
    path: path.join(proofDir, `${proofStage}-${name}`),
  });
}

async function captureElement(locator: Locator, name: string) {
  if (!captureProof) {
    return;
  }
  await mkdir(proofDir, { recursive: true });
  await locator.screenshot({
    animations: "disabled",
    path: path.join(proofDir, `${proofStage}-${name}`),
  });
}

suite.define(() => {
  it.each(["dark", "light"] as const)(
    "uses resolved identity in the New Session hero and picker in %s mode",
    async (theme) => {
      const context = await suite.browser.newContext(CONTEXT);
      const page = await context.newPage();
      const gateway = await installMockGateway(page, {
        defaultAgentId: "main",
        methodResponses: {
          "agent.identity.get": agentIdentities,
          "agents.list": agentsList,
          "sessions.list": {
            count: 2,
            defaults: { contextTokens: null, model: null, modelProvider: null },
            path: "",
            sessions: [
              {
                key: "agent:main:refactor-plan",
                kind: "direct",
                displayName: "Review the auth refactor plan",
                updatedAt: Date.now() - 90_000,
              },
              {
                key: "agent:main:test-matrix",
                kind: "direct",
                displayName: "Build the release test matrix",
                updatedAt: Date.now() - 300_000,
              },
            ],
            ts: Date.now(),
          },
        },
      });

      try {
        await setTheme(page, theme);
        await page.goto(`${suite.server.baseUrl}new?agent=main`);
        await gateway.waitForRequest("agent.identity.get");

        const hero = page.locator(".agent-chat__welcome h2");
        const picker = page.locator(".new-session-page__select--agent openclaw-agent-select");
        const sidebar = page.locator("openclaw-app-sidebar");
        await pollLocatorText(sidebar.locator(".sidebar-agent-card__name")).toContain("Pacino");
        await hero.waitFor();
        await picker.locator(".agent-select__label").waitFor();
        await picker.locator(".agent-select__trigger").click();
        await capture(page, `${theme}-named-picker-open.png`);
        await captureElement(
          picker.locator(".agent-select__trigger"),
          `${theme}-named-trigger-crop.png`,
        );
        if (captureBefore) {
          expect(await hero.textContent()).toBe("main");
          expect(await picker.locator(".agent-select__label").textContent()).toBe("main");
          return;
        }
        await pollLocatorText(hero).toBe("Pacino");
        await pollLocatorText(picker.locator(".agent-select__label")).toBe("Pacino");
        const selectedAgent = picker.locator("wa-dropdown-item[data-agent-option][data-selected]");
        await pollLocatorText(selectedAgent).toContain("Pacino");
        await expect
          .poll(() => selectedAgent.evaluate((element) => document.activeElement === element))
          .toBe(true);
        await captureElement(selectedAgent, `${theme}-selected-focus.png`);
        const unnamedAgent = picker.getByRole("menuitemradio", {
          name: "research",
          exact: true,
        });
        await pollLocatorText(unnamedAgent).toContain("research");
        const longNameAgent = picker.getByRole("menuitemradio", {
          name: "Deployment Safety and Release Verification Agent",
          exact: true,
        });
        await pollLocatorText(longNameAgent).toContain(
          "Deployment Safety and Release Verification Agent",
        );
        await longNameAgent.hover();
        await captureElement(longNameAgent, `${theme}-long-name-hover.png`);

        await unnamedAgent.click();
        await pollLocatorText(hero).toBe("research");
        await pollLocatorText(picker.locator(".agent-select__label")).toBe("research");
        await capture(page, `${theme}-unnamed-id-fallback.png`);
        await picker.evaluate((element) => {
          (element as HTMLElement & { disabled: boolean }).disabled = true;
        });
        await expect.poll(() => picker.locator(".agent-select__trigger").isDisabled()).toBe(true);
        await captureElement(picker, `${theme}-disabled.png`);
      } finally {
        await context.close();
      }
    },
  );
});
