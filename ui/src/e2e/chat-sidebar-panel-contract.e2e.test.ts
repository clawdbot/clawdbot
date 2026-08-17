import type { Page } from "playwright";
import { expect, it } from "vitest";
import { waitForControlUiGatewayReady } from "../test-helpers/control-ui-e2e-readiness.ts";
import {
  installMockGateway,
  type ControlUiMockGatewayScenario,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "chat sidebar panel contract",
  startServerBeforeBrowser: true,
});

type ColdOpenOutcome = {
  outcome: "content" | "generic-empty";
  emptyStateOffersAction: boolean;
};

const expectedColdOpenOutcomes: Record<string, ColdOpenOutcome> = {
  Review: { outcome: "generic-empty", emptyStateOffersAction: false },
  Terminal: { outcome: "content", emptyStateOffersAction: false },
  Browser: { outcome: "generic-empty", emptyStateOffersAction: true },
  Files: { outcome: "generic-empty", emptyStateOffersAction: false },
  "Side chat": { outcome: "generic-empty", emptyStateOffersAction: false },
  Tasks: { outcome: "generic-empty", emptyStateOffersAction: false },
  Desktop: { outcome: "content", emptyStateOffersAction: false },
  Discussion: { outcome: "generic-empty", emptyStateOffersAction: true },
};

function coldOpenScenario(): ControlUiMockGatewayScenario {
  return {
    featureMethods: [
      "browser.request",
      "chat.metadata",
      "chat.startup",
      "desktop.observe",
      "environments.list",
      "session.discussion.info",
      "session.discussion.open",
      "sessions.diff",
      "sessions.files.list",
      "tasks.list",
      "terminal.open",
    ],
    methodResponses: {
      "browser.request": {
        cases: [
          { match: { method: "GET", path: "/tabs" }, response: { running: false, tabs: [] } },
        ],
      },
      "environments.list": { environments: [] },
      "session.discussion.info": {
        openUrl: "https://discussion.example/session",
        state: "open",
      },
      "sessions.files.list": {
        browser: { entries: [], path: "" },
        files: [],
        gitCheckout: false,
        root: "/tmp/plain-workspace",
        sessionKey: "main",
      },
      "tasks.list": { tasks: [] },
      "terminal.open": {
        agentId: "main",
        confined: false,
        cwd: "/tmp/plain-workspace",
        sessionId: "cold-open-terminal",
        shell: "/bin/zsh",
      },
    },
    terminalEnabled: true,
    workspace: "/tmp/plain-workspace",
    workspaceGit: false,
  };
}

async function openColdSidebar(page: Page) {
  const gateway = await installMockGateway(page, coldOpenScenario());
  await page.goto(`${suite.server.baseUrl}chat`);
  await waitForControlUiGatewayReady(page);
  await gateway.waitForRequest("session.discussion.info");
  await gateway.waitForRequest("sessions.files.list");
  await page.getByRole("button", { name: "Side panel", exact: true }).first().click();
  const choices = page.locator(".side-panel-empty__type");
  await choices.first().waitFor();
  return choices;
}

async function readColdOpenOutcome(page: Page): Promise<ColdOpenOutcome> {
  const activePanel = page.locator(".side-panel__panel:not([hidden])");
  await activePanel.waitFor();
  await activePanel.locator(":scope > *").first().waitFor();
  const emptyState = activePanel.locator("openclaw-panel-empty-state").first();
  const genericEmptyState = (await emptyState.count()) > 0;
  return {
    outcome: genericEmptyState ? "generic-empty" : "content",
    emptyStateOffersAction:
      genericEmptyState && (await emptyState.locator('[slot="action"]').count()) > 0,
  };
}

suite.define(() => {
  it("preserves the production header-action shapes for Side chat and Discussion", async () => {
    const context = await suite.newBrowserContext({ serviceWorkers: "block" });
    const page = await context.newPage();
    const choices = await openColdSidebar(page);

    await choices.filter({ hasText: "Side chat" }).click();
    const contentActions = page.locator(".side-panel__action-group--content");
    const companionMenu = contentActions.locator("wa-dropdown.chat-session-rail__menu");
    await companionMenu.waitFor();
    expect(await companionMenu.count()).toBe(1);
    expect(await contentActions.locator(":scope > button").count()).toBe(0);

    await page.locator(".side-panel-type-menu__trigger").click();
    await page.locator(".side-panel-type-menu__item").filter({ hasText: "Discussion" }).click();
    const discussionAction = contentActions.locator(
      ':scope > a.rail-header__action[target="_blank"]',
    );
    await discussionAction.waitFor();
    expect(await discussionAction.getAttribute("href")).toBe("https://discussion.example/session");

    await suite.closeBrowserContext(context);
  });

  it("accounts for every offered slot when opened cold", async () => {
    const probeContext = await suite.newBrowserContext({ serviceWorkers: "block" });
    const probePage = await probeContext.newPage();
    const choices = await openColdSidebar(probePage);
    const offered = await choices.locator(".side-panel-type-option__label").allTextContents();
    await suite.closeBrowserContext(probeContext);

    expect(offered).toEqual(Object.keys(expectedColdOpenOutcomes));

    const outcomes: Record<string, ColdOpenOutcome> = {};
    for (const label of offered) {
      const context = await suite.newBrowserContext({ serviceWorkers: "block" });
      const page = await context.newPage();
      const coldChoices = await openColdSidebar(page);
      await coldChoices.filter({ hasText: label }).click();
      await expect
        .poll(() => readColdOpenOutcome(page), { message: `${label} cold-open outcome` })
        .toEqual(expectedColdOpenOutcomes[label]);
      outcomes[label] = await readColdOpenOutcome(page);
      await suite.closeBrowserContext(context);
    }

    expect(outcomes).toEqual(expectedColdOpenOutcomes);
  });
});
