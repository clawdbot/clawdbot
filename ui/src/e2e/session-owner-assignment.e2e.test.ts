import path from "node:path";
import type { Page } from "playwright";
import { expect as expectBrowser } from "playwright/test";
import { beforeEach, expect, it } from "vitest";
import type { UsersListResult } from "../../../packages/gateway-protocol/src/schema/users.js";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import {
  controlUiBundledGatewayUrl,
  controlUiSessionUrl,
  installMockGateway,
} from "../test-helpers/control-ui-e2e.ts";
import {
  createControlUiE2eContextOptions,
  createControlUiE2eSuite,
} from "./control-ui-e2e-suite.test-support.ts";
import { readThemedPopupPaint } from "./popup-theme.test-support.ts";
import { openSessionMenuSubmenu } from "./session-management.test-support.ts";
import { routeAvatarFixtures } from "./session-ownership-visuals.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI session owner assignment mocked Gateway E2E",
  startServerBeforeBrowser: true,
});
const sessionKey = "agent:main:dashboard:owner-outcome";
const proofPhase = process.env.OPENCLAW_OWNER_ASSIGNMENT_PROOF_PHASE;
let proofDir: string;
beforeEach(() => {
  if (proofPhase) {
    proofDir = createControlUiE2eArtifactDir("session-owner-assignment");
  }
});

function sessionsListResponse(archived = false) {
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
        archived,
        createdActor: { type: "human", id: "profile-bob", label: "Bob" },
        owner: { actor: { type: "human", id: "profile-bob", label: "Bob" } },
        updatedAt: 1,
      },
    ],
    ts: 1,
  };
}

function directoryResponse(extraNames: string[]): UsersListResult {
  return {
    profiles: ["Ada", "Bob", "Carol", ...extraNames].map((displayName) => ({
      id: `profile-${displayName.toLowerCase().replaceAll(" ", "-")}`,
      displayName,
      avatarMime: displayName === "Ada" ? "image/png" : null,
      mergedInto: null,
      createdAt: 1,
      updatedAt: 1,
      emails: [],
      githubIdentity: null,
      hasAvatar: displayName === "Ada",
    })),
  };
}

async function installOwnerGateway(page: Page, archived = false, extraNames: string[] = []) {
  await routeAvatarFixtures(page, [{ id: "profile-ada", background: "#7c3aed", label: "A" }]);
  const result = sessionsListResponse(archived);
  const gateway = await installMockGateway(page, {
    featureMethods: ["chat.startup", "sessions.assignOwner", "users.list"],
    historyMessages: [{ role: "assistant", content: "Owner assignment outcome proof." }],
    methodResponses: {
      "sessions.list": archived
        ? { ...result, count: 1, sessions: result.sessions.filter((row) => row.key !== sessionKey) }
        : result,
      "users.list": directoryResponse(extraNames),
    },
    operatorScopes: ["operator.read", "operator.write"],
    presenceUsers: [
      {
        self: true,
        id: "profile-ada",
        name: "Ada",
        avatarUrl: "/api/users/profile-ada/avatar?v=1",
      },
    ],
    sessions: result.sessions,
    sessionArchiveFiltering: true,
    sessionKey,
  });
  await page.goto(
    archived
      ? `${suite.server.baseUrl}chat?session=${encodeURIComponent(sessionKey)}`
      : controlUiSessionUrl(suite.server.baseUrl, sessionKey),
  );
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
    await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
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
    });
  });

  it("assigns named and self owners through one keyboard-accessible submenu", async () => {
    await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
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
      await captureProof(page, "assignment-submenu");
      await expectBrowser(ownerItems).toHaveText(["Me", "OpenClaw", "Bob", "Carol"]);
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
    });
  });

  it.each([
    { surface: "sidebar", width: 1280 },
    { surface: "header", width: 1280 },
    { surface: "compact header", width: 390 },
  ])(
    "assigns an archived session to an offline teammate from the $surface",
    async ({ surface, width }) => {
      await suite.withPage(
        {
          locale: "en-US",
          serviceWorkers: "block",
          viewport: { height: 900, width },
        },
        async ({ page }) => {
          const extraNames =
            surface === "sidebar"
              ? Array.from(
                  { length: 30 },
                  (_, index) => `Teammate ${String(index + 1).padStart(2, "0")}`,
                )
              : [];
          const gateway = await installOwnerGateway(page, true, extraNames);
          const activePane = page.locator("openclaw-chat-pane.chat-pane-cache__pane--active");
          await expectBrowser(activePane.locator(".agent-chat__disabled-banner")).toContainText(
            "This session is archived.",
          );
          if (surface === "sidebar") {
            const row = page.locator(`[data-session-key="${sessionKey}"]`);
            await row.hover();
            await row
              .getByRole("button", { name: "Open session menu: Owner outcome", exact: true })
              .click();
          } else {
            await activePane.getByRole("button", { name: "Actions for Owner outcome" }).click();
          }
          const assignTo = page.getByRole("menuitem", { name: "Assign to…", exact: true });
          if (surface === "compact header") {
            await assignTo.click();
          } else {
            await assignTo.hover();
          }
          await page.getByRole("menuitemradio", { name: "Me", exact: true }).waitFor();
          await captureProof(page, `archived-${surface.replaceAll(" ", "-")}`);
          await expectBrowser(
            page.getByRole("menuitemradio").locator(":scope > .session-menu__text"),
          ).toHaveText(["Me", "OpenClaw", "Bob", "Carol", ...extraNames]);
          const target = extraNames.at(-1) ?? "Carol";
          const owner = page.getByRole("menuitemradio", { name: target, exact: true });
          await owner.scrollIntoViewIfNeeded();
          await expectBrowser(owner).toBeInViewport();
          await captureProof(page, `archived-${surface.replaceAll(" ", "-")}-selected`);
          await owner.click();
          await expectAssignmentRequest(
            gateway,
            `profile-${target.toLowerCase().replaceAll(" ", "-")}`,
          );
        },
      );
    },
  );

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

  it("retries the header directory in place and keeps a rejected assignment visible", async () => {
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
        await gateway.deferNext("users.list");
        await menuTrigger.press("Enter");
        const assignTo = page.getByRole("menuitem", { name: "Assign to…", exact: true });
        await assignTo.hover();
        await gateway.waitForRequest("users.list");
        const expectCurrentOwner = async (phase: string) => {
          await captureProof(page, `header-directory-${phase}`);
          expect
            .soft(
              await assignTo.getByRole("menuitemradio", { name: "Bob", exact: true }).isVisible(),
            )
            .toBe(true);
          const selectedOwners = await assignTo
            .getByRole("menuitemradio", { checked: true })
            .evaluateAll((owners) =>
              owners.map((owner) => ({
                label: owner.querySelector(".session-menu__text")?.textContent?.trim(),
                disabled: owner.hasAttribute("disabled"),
              })),
            );
          expect.soft(selectedOwners).toEqual([{ label: "Bob", disabled: true }]);
        };
        await expectBrowser(assignTo).toContainText("Loading");
        await expectCurrentOwner("pending");
        const directoryError = "The team directory is temporarily unavailable.";
        await gateway.rejectDeferred("users.list", {
          code: "UNAVAILABLE",
          message: directoryError,
        });
        await expectBrowser(assignTo.getByRole("alert")).toContainText(directoryError);
        await expectCurrentOwner("failed");
        await assignTo.getByRole("menuitem", { name: "Retry", exact: true }).click();
        await expectBrowser(menuTrigger).toHaveAttribute("aria-expanded", "true");
        await expectBrowser(
          assignTo.getByRole("menuitemradio", { name: "Carol", exact: true }),
        ).toBeVisible();
        await expectBrowser(assignTo.getByRole("menuitemradio")).toHaveCount(4);
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
    await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
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
    });
  });
});
