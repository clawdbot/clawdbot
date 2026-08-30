import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { Page } from "playwright";
import { expect as expectBrowser } from "playwright/test";
import { expect, it } from "vitest";
import {
  controlUiBundledGatewayUrl,
  controlUiSessionUrl,
  installMockGateway,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { readThemedPopupPaint } from "./popup-theme.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI session owner assignment mocked Gateway E2E",
  startServerBeforeBrowser: true,
});
const sessionKey = "agent:main:owner-outcome";
const proofPhase = process.env.OPENCLAW_OWNER_ASSIGNMENT_PROOF_PHASE;
const proofDir = path.resolve(".artifacts/control-ui-e2e/session-owner-assignment");

function sessionsListResponse() {
  return {
    count: 2,
    owners: [
      { type: "human" as const, id: "profile-ada", label: "Ada" },
      { type: "human" as const, id: "profile-bob", label: "Bob" },
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
  const gateway = await installMockGateway(page, {
    featureMethods: ["chat.startup", "sessions.assignOwner"],
    historyMessages: [{ role: "assistant", content: "Owner assignment outcome proof." }],
    methodResponses: { "sessions.list": sessionsListResponse() },
    operatorScopes: ["operator.read", "operator.write"],
    presenceUsers: [{ self: true, id: "profile-ada", name: "Ada" }],
    sessionKey,
  });
  await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
  await page.getByText("Owner assignment outcome proof.", { exact: true }).waitFor();
  await gateway.deferNext("sessions.assignOwner");
  return gateway;
}

async function expectAssignmentRequest(
  gateway: Awaited<ReturnType<typeof installOwnerGateway>>,
): Promise<void> {
  const request = await gateway.waitForRequest("sessions.assignOwner");
  expect(request.params).toEqual({
    agentId: "main",
    key: sessionKey,
    owner: { type: "human", id: "profile-ada" },
  });
}

async function captureProof(page: Page, surface: string): Promise<void> {
  if (!proofPhase) {
    return;
  }
  await mkdir(proofDir, { recursive: true });
  await page.screenshot({
    animations: "disabled",
    fullPage: true,
    path: path.join(proofDir, `${surface}-${proofPhase}.png`),
  });
}

async function chooseAssignToMe(page: Page): Promise<void> {
  const action = page.locator('wa-dropdown-item[value="assign-owner:human:profile-ada"]:visible');
  await action.waitFor({ state: "visible" });
  await action.click();
}

suite.define(() => {
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
        await assignTo
          .locator('wa-dropdown-item[slot="submenu"][value="assign-owner:human:profile-ada"]')
          .waitFor();

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
        const menuTrigger = activePane.getByRole("button", {
          name: "Chat options for Owner outcome",
        });
        await menuTrigger.press("Enter");
        await chooseAssignToMe(page);
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
        await chooseAssignToMe(page);
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
