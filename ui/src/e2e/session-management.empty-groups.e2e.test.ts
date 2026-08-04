import { expect, it } from "vitest";
import {
  activateMenuItem,
  captureUiProof,
  createSessionManagementE2eSuite,
  installMockGateway,
  requireRecord,
  sessionRow,
  sessionsListResponse,
} from "./session-management.test-support.ts";

const suite = createSessionManagementE2eSuite();

suite.define(() => {
  it("recovers an empty group catalog after a transient load failure", async () => {
    const context = await suite.browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      deferredMethods: ["sessions.groups.list"],
      featureMethods: ["chat.metadata", "chat.startup", "sessions.groups.list"],
      methodResponses: {
        "sessions.list": sessionsListResponse([]),
      },
      sessionGroups: ["Recovered group"],
    });

    try {
      await page.goto(`${suite.server.baseUrl}chat`);
      await gateway.waitForRequest("sessions.groups.list");
      await gateway.rejectDeferred("sessions.groups.list", {
        code: "UNAVAILABLE",
        message: "temporary catalog failure",
        retryable: true,
      });

      await expect
        .poll(async () => (await gateway.getRequests("sessions.groups.list")).length, {
          timeout: 10_000,
        })
        .toBe(2);
      await page.locator('[data-session-section="category:Recovered group"]').waitFor({
        state: "visible",
      });
    } finally {
      await context.close();
    }
  });

  it("keeps a new empty group visible before the first saved session", async () => {
    const context = await suite.browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      methodResponses: {
        "sessions.list": sessionsListResponse([]),
      },
      featureMethods: [
        "chat.metadata",
        "chat.startup",
        "sessions.groups.list",
        "sessions.groups.put",
      ],
      sessionKey: "agent:main:main",
      // Stored-but-empty catalog groups stay visible as sections/move targets.
      sessionGroups: ["First group"],
    });

    try {
      await page.goto(`${suite.server.baseUrl}chat`);
      const firstGroup = page.locator('[data-session-section="category:First group"]');
      await firstGroup.waitFor({ state: "visible" });

      // A header-menu-created group starts empty and still gets a section.
      await firstGroup.locator(".sidebar-recent-sessions__head").hover();
      await firstGroup.getByRole("button", { name: "Group options for First group" }).click();
      page.once("dialog", (dialog) => void dialog.accept("Second group"));
      await activateMenuItem(page.getByRole("menuitem", { name: "New group…" }));
      await page.locator('[data-session-section="category:Second group"]').waitFor({
        state: "visible",
      });
      const putRequest = await gateway.waitForRequest("sessions.groups.put");
      expect(requireRecord(putRequest.params)).toMatchObject({
        names: ["First group", "Second group"],
      });
    } finally {
      await context.close();
    }
  });

  it("explains empty gateway groups for the selected agent", async () => {
    const context = await suite.browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      assistantName: "Ivan",
      defaultAgentId: "ivan",
      featureMethods: ["chat.metadata", "chat.startup", "sessions.groups.list"],
      methodResponses: {
        "sessions.list": {
          cases: [
            {
              match: { agentId: "ivan" },
              response: sessionsListResponse([
                sessionRow("agent:ivan:main", "Ivan", Date.parse("2026-07-28T18:00:00.000Z")),
              ]),
            },
            {
              match: { agentId: "main" },
              response: sessionsListResponse([
                sessionRow("agent:main:email", "Email intake", 1, { category: "Email intake" }),
                sessionRow("agent:main:replies", "Customer replies", 1, {
                  category: "Customer replies",
                }),
              ]),
            },
          ],
        },
      },
      sessionGroups: ["Email intake", "Customer replies"],
      sessionKey: "agent:ivan:main",
    });

    try {
      await page.goto(`${suite.server.baseUrl}chat`);
      await expect
        .poll(async () =>
          (await gateway.getRequests("sessions.list")).some(
            (request) => requireRecord(request.params).agentId === "ivan",
          ),
        )
        .toBe(true);

      const emptyGroups = page.locator('[data-session-section^="category:"]');
      await expect.poll(() => emptyGroups.count()).toBe(2);
      await captureUiProof(page, "sidebar-empty-cross-agent-groups.png");
      await expect
        .poll(() => emptyGroups.locator(".sidebar-session-empty-placeholder").allTextContents())
        .toEqual(["No sessions found for this agent", "No sessions found for this agent"]);
      const firstEmptyGroup = emptyGroups.first();
      const textLeft = (selector: string) =>
        firstEmptyGroup.locator(selector).evaluate((element) => {
          const range = document.createRange();
          range.selectNodeContents(element);
          return range.getBoundingClientRect().x;
        });
      const [titleLeft, placeholderLeft] = await Promise.all([
        textLeft(".sidebar-recent-sessions__label-text"),
        textLeft(".sidebar-session-empty-placeholder"),
      ]);
      expect(placeholderLeft).toBeCloseTo(titleLeft, 0);
    } finally {
      await context.close();
    }
  });
});
