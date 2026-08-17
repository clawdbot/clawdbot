import { Buffer } from "node:buffer";
import type { Page } from "playwright";
import { expect, it } from "vitest";
import { waitForControlUiGatewayReady } from "../test-helpers/control-ui-e2e-readiness.ts";
import {
  installMockGateway,
  type ControlUiMockGatewayScenario,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "chat sidebar cold-open invariant",
  startServerBeforeBrowser: true,
});

const ONE_PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nPcAAAAASUVORK5CYII=",
  "base64",
);

type ColdOpenOutcome = {
  outcome: "content" | "generic-empty";
  emptyStateOffersAction: boolean;
};

const offeredSlotLabels = [
  "Review",
  "Terminal",
  "Browser",
  "Files",
  "Side chat",
  "Tasks",
  "Desktop",
  "Discussion",
] as const;

type OfferedSlotLabel = (typeof offeredSlotLabels)[number];

const actionlessEmptyStateAllowlist = new Set<OfferedSlotLabel>([
  // Review: no git checkout, nothing to diff.
  "Review",
  // Tasks: no background tasks, nothing to inspect.
  "Tasks",
]);

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
      "sessions.companion.state",
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

function populatedColdOpenScenario(): ControlUiMockGatewayScenario {
  const sparse = coldOpenScenario();
  return {
    ...sparse,
    methodResponses: {
      ...sparse.methodResponses,
      "browser.request": {
        cases: [
          {
            match: { method: "GET", path: "/tabs" },
            response: {
              running: true,
              tabs: [
                {
                  targetId: "target-1",
                  tabId: "tab-1",
                  title: "OpenClaw",
                  url: "https://example.test/",
                },
              ],
            },
          },
          {
            match: { method: "POST", path: "/screenshot" },
            response: {
              path: "/proof/browser.png",
              targetId: "target-1",
              url: "https://example.test/",
            },
          },
        ],
      },
      "environments.list": {
        environments: [{ id: "gateway", type: "local", status: "available", desktop: true }],
      },
      "session.discussion.info": {
        embedUrl: "https://discussion.example/embed/thread/session",
        openUrl: "https://discussion.example/session",
        state: "open",
      },
      "sessions.companion.state": {
        exchanges: [
          {
            question: "What changed?",
            answer: "Every offered panel now opens with useful content.",
            ts: Date.now() - 1_000,
          },
        ],
      },
      "sessions.diff": {
        additions: 1,
        baseRef: "main",
        branch: "feature/sidebar-invariant",
        deletions: 0,
        files: [
          {
            additions: 1,
            deletions: 0,
            patch: [
              "diff --git a/README.md b/README.md",
              "--- a/README.md",
              "+++ b/README.md",
              "@@ -1 +1,2 @@",
              " OpenClaw",
              "+Cold-open invariant",
              "",
            ].join("\n"),
            path: "README.md",
            status: "modified",
          },
        ],
        root: "/tmp/checkout",
        sessionKey: "main",
      },
      "sessions.files.list": {
        browser: {
          entries: [{ kind: "file", name: "README.md", path: "README.md" }],
          path: "",
        },
        files: [
          {
            kind: "modified",
            missing: false,
            name: "README.md",
            path: "/tmp/checkout/README.md",
            size: 128,
          },
        ],
        gitCheckout: true,
        root: "/tmp/checkout",
        sessionKey: "main",
      },
      "tasks.list": {
        tasks: [
          {
            agentId: "main",
            createdAt: Date.now() - 2_000,
            id: "task-sidebar-invariant",
            kind: "subagent",
            ownerKey: "main",
            progressSummary: "Checking every offered panel",
            runtime: "subagent",
            startedAt: Date.now() - 1_000,
            status: "running",
            taskId: "task-sidebar-invariant",
            title: "Verify cold-open behavior",
            updatedAt: Date.now(),
          },
        ],
      },
      "terminal.open": {
        agentId: "main",
        confined: false,
        cwd: "/tmp/checkout",
        sessionId: "cold-open-terminal",
        shell: "/bin/zsh",
      },
    },
    workspace: "/tmp/checkout",
    workspaceGit: true,
  };
}

async function openColdSidebar(page: Page, scenario = coldOpenScenario()) {
  await page.route("**/__openclaw__/assistant-media?*", (route) =>
    route.fulfill({ body: ONE_PIXEL_PNG, contentType: "image/png" }),
  );
  const gateway = await installMockGateway(page, scenario);
  await page.goto(`${suite.server.baseUrl}chat`);
  await waitForControlUiGatewayReady(page);
  await gateway.waitForRequest("session.discussion.info");
  await gateway.waitForRequest("sessions.companion.state");
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
      genericEmptyState &&
      (await activePanel.locator('[slot="action"], a[href], button:not([disabled])').count()) > 0,
  };
}

async function offeredLabels(page: Page, scenario: ControlUiMockGatewayScenario) {
  const choices = await openColdSidebar(page, scenario);
  return choices.locator(".side-panel-type-option__label").allTextContents();
}

async function readSlotColdOpenOutcome(
  label: OfferedSlotLabel,
  scenario: ControlUiMockGatewayScenario,
  expectedOutcome?: ColdOpenOutcome["outcome"],
): Promise<ColdOpenOutcome> {
  const context = await suite.newBrowserContext({ serviceWorkers: "block" });
  try {
    const page = await context.newPage();
    const choices = await openColdSidebar(page, scenario);
    await choices.filter({ hasText: label }).click();
    if (expectedOutcome) {
      await expect
        .poll(() => readColdOpenOutcome(page), { message: `${label} cold-open outcome` })
        .toMatchObject({ outcome: expectedOutcome });
    } else {
      await page.evaluate(
        () =>
          new Promise<void>((resolve) => {
            requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
          }),
      );
    }
    return await readColdOpenOutcome(page);
  } finally {
    await suite.closeBrowserContext(context);
  }
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

  it("renders content for every offered slot with backing data", async () => {
    const probeContext = await suite.newBrowserContext({ serviceWorkers: "block" });
    try {
      const offered = await offeredLabels(
        await probeContext.newPage(),
        populatedColdOpenScenario(),
      );
      expect(offered).toEqual(offeredSlotLabels);
    } finally {
      await suite.closeBrowserContext(probeContext);
    }

    for (const label of offeredSlotLabels) {
      expect(
        await readSlotColdOpenOutcome(label, populatedColdOpenScenario(), "content"),
        `${label} must render content when its backing capability has data`,
      ).toEqual({ outcome: "content", emptyStateOffersAction: false });
    }
  });

  it("keeps generic empty states actionable or explicitly allowlisted", async () => {
    const probeContext = await suite.newBrowserContext({ serviceWorkers: "block" });
    try {
      const offered = await offeredLabels(await probeContext.newPage(), coldOpenScenario());
      expect(offered).toEqual(offeredSlotLabels);
    } finally {
      await suite.closeBrowserContext(probeContext);
    }

    const observedActionlessEmptyStates: OfferedSlotLabel[] = [];
    for (const label of offeredSlotLabels) {
      const outcome = await readSlotColdOpenOutcome(label, coldOpenScenario());
      if (outcome.outcome !== "generic-empty" || outcome.emptyStateOffersAction) {
        continue;
      }
      expect(
        actionlessEmptyStateAllowlist.has(label),
        `${label} renders the generic empty state without an action`,
      ).toBe(true);
      observedActionlessEmptyStates.push(label);
    }

    expect(observedActionlessEmptyStates).toEqual([...actionlessEmptyStateAllowlist]);
  });
});
