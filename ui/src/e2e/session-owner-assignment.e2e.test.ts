import path from "node:path";
import type { Page } from "playwright";
import { expect as expectBrowser } from "playwright/test";
import { beforeEach, expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import {
  controlUiBundledGatewayUrl,
  controlUiSessionUrl,
  installMockGateway,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { readThemedPopupPaint } from "./popup-theme.test-support.ts";
import { openSessionMenuSubmenu } from "./session-management.test-support.ts";
import { routeAvatarFixtures } from "./session-ownership-visuals.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI session owner assignment mocked Gateway E2E",
  startServerBeforeBrowser: true,
});
const sessionKey = "agent:main:owner-outcome";
const proofPhase = process.env.OPENCLAW_OWNER_ASSIGNMENT_PROOF_PHASE;
let proofDir: string;
beforeEach(() => {
  if (proofPhase) {
    proofDir = createControlUiE2eArtifactDir("session-owner-assignment");
  }
});

function sessionsListResponse() {
  return {
    count: 2,
    owners: [
      { type: "human" as const, id: "profile-ada", label: "Ada" },
      { type: "human" as const, id: "profile-bob", label: "Bob" },
      { type: "human" as const, id: "profile-carol", label: "Carol" },
    ],
    defaults: { contextTokens: null, model: null, modelProvider: null },
    path: "",
    sessions: [
      {
        key: "agent:main:ada-research",
        kind: "direct",
        label: "Ada research",
        createdActor: { type: "human", id: "profile-ada", label: "Ada" },
        owner: { actor: { type: "human", id: "profile-ada", label: "Ada" } },
        updatedAt: 2,
      },
      {
        key: sessionKey,
        kind: "direct",
        label: "Owner outcome",
        createdActor: { type: "human", id: "profile-bob", label: "Bob" },
        owner: { actor: { type: "human", id: "profile-bob", label: "Bob" } },
        updatedAt: 1,
      },
    ],
    ts: 1,
  };
}

async function installOwnerGateway(page: Page) {
  await routeAvatarFixtures(page, [{ id: "profile-ada", background: "#7c3aed", label: "A" }]);
  const gateway = await installMockGateway(page, {
    featureMethods: ["chat.startup", "sessions.assignOwner"],
    historyMessages: [{ role: "assistant", content: "Owner assignment outcome proof." }],
    methodResponses: { "sessions.list": sessionsListResponse() },
    operatorScopes: ["operator.read", "operator.write"],
    presenceUsers: [
      {
        self: true,
        id: "profile-ada",
        name: "Ada",
        avatarUrl: "/api/users/profile-ada/avatar?v=1",
      },
    ],
    sessionKey,
  });
  await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
  await page.getByText("Owner assignment outcome proof.", { exact: true }).waitFor();
  await gateway.deferNext("sessions.assignOwner");
  return gateway;
}

async function expectAssignmentRequest(
  gateway: Awaited<ReturnType<typeof installOwnerGateway>>,
  ownerId = "profile-ada",
  after?: number,
): Promise<void> {
  const request = await gateway.waitForRequest("sessions.assignOwner", { after });
  expect(request.params).toEqual({
    agentId: "main",
    key: sessionKey,
    owner: { type: "human", id: ownerId },
  });
}

async function captureProof(page: Page, surface: string): Promise<void> {
  if (!proofPhase) {
    return;
  }
  await page.screenshot({
    animations: "disabled",
    fullPage: true,
    path: path.join(proofDir, `${surface}-${proofPhase}.png`),
  });
}

async function chooseMe(page: Page): Promise<void> {
  await page.getByRole("menuitem", { name: "Assign to…", exact: true }).hover();
  const action = page.getByRole("menuitemradio", { name: "Me", exact: true });
  await action.waitFor({ state: "visible" });
  await action.click();
}

suite.define(() => {
  it("marks exactly one target when the session is assigned to self", async () => {
    await suite.withPage(
      {
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 900, width: 1280 },
      },
      async ({ page }) => {
        await installOwnerGateway(page);
        const row = page.locator('[data-session-key="agent:main:ada-research"]');
        await row.hover();
        await row
          .getByRole("button", { name: "Open session menu: Ada research", exact: true })
          .click();
        const assignTo = page.getByRole("menuitem", { name: "Assign to…", exact: true });
        await assignTo.hover();

        const checked = assignTo.locator(
          ':scope > wa-dropdown-item[slot="submenu"][aria-checked="true"]',
        );
        await expectBrowser(checked).toHaveCount(1);
        await expectBrowser(checked.locator(":scope > .session-menu__text")).toHaveText("Me");
        await expectBrowser(
          assignTo.locator(':scope > wa-dropdown-item[slot="submenu"] > .session-menu__text'),
        ).toHaveText(["Me", "OpenClaw", "Bob", "Carol"]);
      },
    );
  });

  it("assigns named and self owners through one keyboard-accessible submenu", async () => {
    await suite.withPage(
      {
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 900, width: 1280 },
      },
      async ({ page }) => {
        const gateway = await installOwnerGateway(page);
        const row = page.locator(`[data-session-key="${sessionKey}"]`);
        await row.hover();
        const trigger = row.getByRole("button", {
          name: "Open session menu: Owner outcome",
          exact: true,
        });
        await trigger.click();

        const menu = page.locator("openclaw-session-menu");
        const rootAssignmentLabels = await menu
          .locator(":scope > wa-dropdown > wa-dropdown-item > .session-menu__text")
          .allTextContents();
        expect(rootAssignmentLabels.filter((label) => label.startsWith("Assign to"))).toEqual([
          "Assign to…",
        ]);
        const assignTo = menu.getByRole("menuitem", {
          name: "Assign to…",
          exact: true,
        });
        await assignTo.hover();
        const ownerItems = assignTo.locator(
          ':scope > wa-dropdown-item[slot="submenu"] > .session-menu__text',
        );
        await expectBrowser(ownerItems).toHaveText(["Me", "OpenClaw", "Bob", "Carol"]);
        await captureProof(page, "assignment-submenu");
        const selfAvatar = assignTo
          .getByRole("menuitemradio", { name: "Me", exact: true })
          .locator("openclaw-viewer-avatar img");
        await expectBrowser(selfAvatar).toHaveCount(1);
        await expect
          .poll(() => selfAvatar.evaluate((image) => (image as HTMLImageElement).naturalWidth))
          .toBeGreaterThan(0);
        const avatarSizes = await assignTo
          .locator(':scope > wa-dropdown-item[slot="submenu"] .viewer-avatar')
          .evaluateAll((avatars) =>
            avatars.map((avatar) => {
              const bounds = avatar.getBoundingClientRect();
              const style = getComputedStyle(avatar);
              return {
                height: bounds.height,
                width: bounds.width,
                cssHeight: style.height,
                cssWidth: style.width,
              };
            }),
          );
        expect(avatarSizes.length).toBeGreaterThan(0);
        expect(
          avatarSizes.every(
            ({ width, height, cssWidth, cssHeight }) =>
              Math.abs(width - height) < 0.01 && cssWidth === "14px" && cssHeight === "14px",
          ),
        ).toBe(true);
        await assignTo.getByRole("menuitemradio", { name: "Carol", exact: true }).click();
        await expectAssignmentRequest(gateway, "profile-carol");
        await gateway.resolveDeferred("sessions.assignOwner", {
          ok: true,
          key: sessionKey,
          owner: { actor: { type: "human", id: "profile-carol", label: "Carol" } },
        });

        await gateway.deferNext("sessions.assignOwner");
        await row.hover();
        await trigger.press("Enter");
        await openSessionMenuSubmenu(page, "Assign to…");
        const keyboardAssignTo = page.getByRole("menuitem", {
          name: "Assign to…",
          exact: true,
        });
        await expectBrowser(
          page.getByRole("menuitemradio", { name: "Me", exact: true }),
        ).toBeFocused();
        await page.keyboard.press("Escape");
        await expectBrowser(trigger).toHaveAttribute("aria-expanded", "false");
        await trigger.press("Enter");
        await openSessionMenuSubmenu(page, "Assign to…");
        await expectBrowser(keyboardAssignTo).toHaveAttribute("aria-expanded", "true");
        await expectBrowser(
          page.getByRole("menuitemradio", { name: "Me", exact: true }),
        ).toBeFocused();
        await page.keyboard.press("Enter");
        await expectAssignmentRequest(gateway, "profile-ada", 1);
      },
    );
  });

  it("themes the assignee submenu with the active palette", async () => {
    await suite.withPage(
      {
        colorScheme: "dark",
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 900, width: 1280 },
      },
      async ({ page }) => {
        await page.addInitScript(
          ({ gatewayUrl }) => {
            localStorage.setItem(
              `openclaw.control.settings.v1:${gatewayUrl}`,
              JSON.stringify({ gatewayUrl, theme: "dash", themeMode: "dark" }),
            );
          },
          { gatewayUrl: controlUiBundledGatewayUrl(suite.server.baseUrl) },
        );
        await installOwnerGateway(page);
        await expect.poll(() => page.locator("html").getAttribute("data-theme")).toBe("dash");

        const row = page.locator(`[data-session-key="${sessionKey}"]`);
        await row.hover();
        await row
          .getByRole("button", { name: "Open session menu: Owner outcome", exact: true })
          .click();
        const assignTo = page.getByRole("menuitem", { name: "Assign to…", exact: true });
        await assignTo.hover();
        await assignTo.getByRole("menuitemradio", { name: "Me", exact: true }).waitFor();

        const paint = await readThemedPopupPaint(assignTo, "submenu");
        await captureProof(page, "assignee-submenu");
        expect(paint.actual).toEqual(paint.expected);
      },
    );
  });

  it("keeps a rejected header owner assignment visible", async () => {
    await suite.withPage(
      {
        colorScheme: "dark",
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 900, width: 1280 },
      },
      async ({ page }) => {
        const gateway = await installOwnerGateway(page);
        const activePane = page.locator("openclaw-chat-pane.chat-pane-cache__pane--active");
        const menuTrigger = activePane.getByRole("button", { name: "Actions for Owner outcome" });
        await menuTrigger.press("Enter");
        await chooseMe(page);
        await expectAssignmentRequest(gateway);

        const message = "Owner assignment rejected for visible outcome proof.";
        await gateway.rejectDeferred("sessions.assignOwner", {
          code: "INVALID_REQUEST",
          message,
        });
        await captureProof(page, "header");

        await expectBrowser(
          activePane.getByRole("alert").filter({ hasText: message }),
        ).toBeVisible();
        await expectBrowser(
          activePane.getByRole("img", { name: "Created by Bob", exact: true }),
        ).toHaveCount(1);
      },
    );
  });

  it("keeps a rejected sidebar owner assignment visible", async () => {
    await suite.withPage(
      {
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 900, width: 1280 },
      },
      async ({ page }) => {
        const gateway = await installOwnerGateway(page);
        const row = page.locator(`[data-session-key="${sessionKey}"]`);
        await row.hover();
        await row
          .getByRole("button", { name: "Open session menu: Owner outcome", exact: true })
          .click();
        await chooseMe(page);
        await expectAssignmentRequest(gateway);

        const message = "Sidebar owner assignment rejected for visible outcome proof.";
        await gateway.rejectDeferred("sessions.assignOwner", {
          code: "INVALID_REQUEST",
          message,
        });

        await expectBrowser(page.getByRole("alert").filter({ hasText: message })).toBeVisible();
        await expectBrowser(
          row.getByRole("img", { name: "Created by Bob", exact: true }),
        ).toHaveCount(1);
      },
    );
  });
});
