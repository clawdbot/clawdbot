// Control UI E2E tests cover session ownership dormancy and owner filtering.
import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { Page } from "playwright";
import { expect as expectBrowser } from "playwright/test";
import { afterEach, expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import {
  openNewSessionPlusMenu,
  replaceGatewayClient,
  selectNewSessionDraft,
} from "./new-session-page.test-support.ts";
import {
  avatarLabelCenterDelta,
  routeAvatarFixtures,
} from "./session-ownership-visuals.test-support.ts";
import {
  openSessionOwnershipMenu as openSidebarSortMenu,
  sessionOwnershipList as sessionsList,
} from "./session-ownership.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI session ownership",
});

const captureUiProofEnabled = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
const uiProofArtifactDir = path.join(process.cwd(), ".artifacts", "control-ui-e2e", "drafts-ux");
const sessionOwnerProofArtifactDir = path.join(
  process.cwd(),
  ".artifacts",
  "control-ui-e2e",
  "session-owner-stack",
);

let page: Page | undefined;
function draftSessionsList() {
  const result = sessionsList(["profile-ada", "profile-bob"]);
  for (const session of result.sessions) {
    Object.assign(session, { visibility: "draft", sharingRole: "admin" });
  }
  return result;
}

function collaborativeSessionsList() {
  const ada = {
    type: "human" as const,
    id: "profile-ada",
    label: "Ada",
    avatarUrl: "/api/users/profile-ada/avatar?v=1",
  };
  const bob = {
    type: "human" as const,
    id: "profile-bob",
    label: "Bob",
    avatarUrl: "/api/users/profile-bob/avatar?v=1",
  };
  const carol = { type: "human" as const, id: "profile-carol", label: "Carol" };
  return {
    count: 3,
    owners: [ada, bob, carol],
    defaults: { contextTokens: null, model: null, modelProvider: null },
    path: "",
    sessions: [
      {
        key: "agent:main:collaboration",
        kind: "direct",
        label: "Fix issue #127689",
        createdActor: ada,
        owner: { actor: ada },
        participants: [bob],
        participantCount: 1,
        updatedAt: 3,
      },
      {
        key: "agent:main:release-planning",
        kind: "direct",
        label: "Release planning",
        createdActor: bob,
        owner: { actor: bob },
        participants: [ada, { type: "agent" as const, id: "research", label: "Research" }],
        participantCount: 2,
        updatedAt: 2,
      },
      {
        key: "agent:main:single-owner",
        kind: "direct",
        label: "Single-owner baseline",
        createdActor: carol,
        owner: { actor: carol },
        updatedAt: 1,
      },
    ],
    ts: 1,
  };
}

async function captureUiProof(targetPage: Page, fileName: string) {
  if (!captureUiProofEnabled) {
    return;
  }
  await mkdir(uiProofArtifactDir, { recursive: true });
  await targetPage.screenshot({
    animations: "disabled",
    fullPage: true,
    path: path.join(uiProofArtifactDir, fileName),
  });
}

async function captureSessionOwnerProof(targetPage: Page, fileName: string) {
  if (!captureUiProofEnabled) {
    return;
  }
  await mkdir(sessionOwnerProofArtifactDir, { recursive: true });
  await targetPage.locator(".sidebar-sessions").screenshot({
    animations: "disabled",
    path: path.join(sessionOwnerProofArtifactDir, fileName),
  });
}

suite.define(() => {
  afterEach(async () => {
    await page
      ?.context()
      .close()
      .catch(() => {});
    page = undefined;
  });

  it("keeps collaborative owner stacks legible without shifting session rows", async () => {
    const context = await suite.browser.newContext({ viewport: { height: 800, width: 1200 } });
    const currentPage = await context.newPage();
    page = currentPage;
    await routeAvatarFixtures(context, currentPage, [
      { id: "profile-ada", background: "#3f6f76", label: "A" },
      { id: "profile-bob", background: "#985b42", label: "B" },
    ]);
    await installMockGateway(currentPage, {
      hasMultipleSessionSharingIdentities: true,
      sessionKey: "agent:main:collaboration",
      historyMessages: [{ role: "assistant", content: [{ type: "text", text: "Ready." }] }],
      methodResponses: { "sessions.list": collaborativeSessionsList() },
    });

    await currentPage.goto(`${suite.server?.baseUrl ?? ""}chat`);
    const collaborativeRow = currentPage.locator('[data-session-key="agent:main:collaboration"]');
    const overflowRow = currentPage.locator('[data-session-key="agent:main:release-planning"]');
    const singleOwnerRow = currentPage.locator('[data-session-key="agent:main:single-owner"]');
    await collaborativeRow.waitFor();
    await overflowRow.waitFor();
    await singleOwnerRow.waitFor();
    await expect.poll(() => collaborativeRow.locator(".session-owner-stack img").count()).toBe(2);
    await expect
      .poll(() =>
        collaborativeRow
          .locator(".session-owner-stack img")
          .evaluateAll((images) =>
            images.every(
              (image) =>
                image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0,
            ),
          ),
      )
      .toBe(true);

    const geometry = await collaborativeRow.evaluate((row) => {
      const stack = row.querySelector<HTMLElement>(".session-owner-stack");
      const back = row.querySelector<HTMLElement>(".session-owner-stack__back .viewer-avatar");
      const front = row.querySelector<HTMLElement>(".session-owner-stack__front");
      const slot = row.querySelector<HTMLElement>(".sidebar-session-indicator");
      const text = row.querySelector<HTMLElement>(".sidebar-recent-session__text");
      if (!stack || !back || !front || !slot || !text) {
        throw new Error("expected complete collaborative session row");
      }
      const stackBounds = stack.getBoundingClientRect();
      const backBounds = back.getBoundingClientRect();
      const frontBounds = front.getBoundingClientRect();
      const slotBounds = slot.getBoundingClientRect();
      const textBounds = text.getBoundingClientRect();
      return {
        backSize: [backBounds.width, backBounds.height],
        centerDelta:
          stackBounds.left + stackBounds.width / 2 - (slotBounds.left + slotBounds.width / 2),
        frontSize: [frontBounds.width, frontBounds.height],
        overlap: backBounds.right - frontBounds.left,
        reveal: frontBounds.left - backBounds.left,
        slotWidth: slotBounds.width,
        stackSize: [stackBounds.width, stackBounds.height],
        textGap: textBounds.left - stackBounds.right,
      };
    });
    expect(geometry).toEqual({
      backSize: [18, 18],
      centerDelta: 0,
      frontSize: [18, 18],
      overlap: 8,
      reveal: 10,
      slotWidth: 20,
      stackSize: [28, 20],
      textGap: 4,
    });
    await expectBrowser(overflowRow.locator(".session-owner-stack__overflow")).toHaveText("+2");
    const rowHeights = await Promise.all([
      collaborativeRow.evaluate((row) => row.getBoundingClientRect().height),
      singleOwnerRow.evaluate((row) => row.getBoundingClientRect().height),
    ]);
    expect(rowHeights[0]).toBeCloseTo(rowHeights[1] ?? 0, 5);
    const titleLefts = await Promise.all(
      [collaborativeRow, singleOwnerRow].map((row) =>
        row
          .locator(".sidebar-recent-session__text")
          .evaluate((text) => text.getBoundingClientRect().left),
      ),
    );
    expect(titleLefts[0]).toBeCloseTo(titleLefts[1] ?? 0, 5);

    if (captureUiProofEnabled) {
      const legacyStyles = await currentPage.addStyleTag({
        content: `
          .session-owner-stack { width: 24px; }
          .session-owner-stack__back { width: 14px; height: 14px; }
          .session-owner-stack__back .viewer-avatar,
          .session-owner-stack__overflow { width: 14px; height: 14px; font-size: 7px; }
          .session-owner-stack__front { width: 20px; height: 20px; }
        `,
      });
      await captureSessionOwnerProof(currentPage, "00-before-light.png");
      await currentPage.evaluate(() =>
        document.documentElement.setAttribute("data-theme-mode", "dark"),
      );
      await captureSessionOwnerProof(currentPage, "01-before-dark.png");
      await legacyStyles.evaluate((style) => style.parentNode?.removeChild(style));
      await captureSessionOwnerProof(currentPage, "02-after-dark.png");
      await currentPage.evaluate(() =>
        document.documentElement.setAttribute("data-theme-mode", "light"),
      );
      await captureSessionOwnerProof(currentPage, "03-after-light.png");
    }
  });

  it("shows permanent owner chips and filters existing custom groups", async () => {
    const context = await suite.browser.newContext({ viewport: { height: 800, width: 1200 } });
    const currentPage = await context.newPage();
    page = currentPage;
    await routeAvatarFixtures(context, currentPage, [
      { id: "profile-patrick", background: "#27496d", label: "P" },
      { id: "profile-ada", background: "#3f6f76", label: "A" },
      { id: "profile-bob", background: "#985b42", label: "B" },
    ]);
    const gateway = await installMockGateway(currentPage, {
      hasMultipleSessionSharingIdentities: true,
      sessionKey: "agent:main:ada",
      presenceUsers: [
        {
          self: true,
          id: "profile-patrick",
          name: "Patrick",
          avatarUrl: "/api/users/profile-patrick/avatar?v=1",
        },
      ],
      historyMessages: [{ role: "assistant", content: [{ type: "text", text: "Ready." }] }],
      methodResponses: { "sessions.list": sessionsList(["profile-ada", "profile-bob"], true) },
    });

    await currentPage.goto(`${suite.server?.baseUrl ?? ""}chat`);
    await currentPage.getByText("Ada research", { exact: true }).first().waitFor();
    await currentPage.getByText("Bob operations", { exact: true }).first().waitFor();
    await currentPage.locator('[data-session-key="agent:main:ada"] a').click();
    await currentPage.getByText("Ready.", { exact: true }).waitFor();
    await expect.poll(() => currentPage.locator("openclaw-session-owner-chip").count()).toBe(3);

    const ownerMenu = await openSidebarSortMenu(currentPage);
    await ownerMenu.locator('[value="sort:people"]').waitFor();
    const ownerRows = ownerMenu.locator('wa-dropdown-item[value^="owner:"]:not([value="owner:"])');
    await expectBrowser(ownerRows).toHaveCount(3);
    await expectBrowser(ownerRows.first()).toHaveAttribute("value", "owner:profile-patrick");
    await expectBrowser(ownerRows.first()).toContainText("Patrick (You)");
    await expectBrowser(ownerRows.locator("openclaw-session-owner-chip img")).toHaveCount(3);
    const firstOwnerCenterDelta = await avatarLabelCenterDelta(ownerRows.first());
    await captureUiProof(currentPage, "00-people-sort-available.png");
    expect(firstOwnerCenterDelta).toBeLessThanOrEqual(0.5);
    await ownerMenu.evaluate((element) =>
      element.dispatchEvent(
        new CustomEvent("wa-select", {
          bubbles: true,
          detail: { item: { value: "sort:people" } },
        }),
      ),
    );
    const peopleMenu = await openSidebarSortMenu(currentPage);
    await expectBrowser(peopleMenu.locator('[value="sort:people"]')).toHaveAttribute(
      "aria-checked",
      "true",
    );
    await captureUiProof(currentPage, "01-people-sort-selected.png");
    await peopleMenu.locator('[value="owner:profile-ada"]').waitFor();
    await peopleMenu.evaluate((element) =>
      element.dispatchEvent(
        new CustomEvent("wa-select", {
          bubbles: true,
          detail: { item: { value: "owner:profile-ada" } },
        }),
      ),
    );
    await currentPage.getByText("Ada research", { exact: true }).first().waitFor();
    await expect
      .poll(() => currentPage.locator('[data-session-key="agent:main:bob"]').count())
      .toBe(0);
    expect(await currentPage.locator('[data-session-section="category:Research"]').count()).toBe(1);
    expect(await currentPage.locator('[data-session-section="category:Operations"]').count()).toBe(
      0,
    );
    await expect
      .poll(async () =>
        (await gateway.getRequests("sessions.list")).some(
          (request) =>
            (request.params as { ownerId?: unknown } | undefined)?.ownerId === "profile-ada",
        ),
      )
      .toBe(true);

    const initialConnections = (await gateway.getRequests("connect")).length;
    await gateway.closeLatest(1012, "owner filter reconnect proof");
    await expect
      .poll(async () => (await gateway.getRequests("connect")).length)
      .toBeGreaterThan(initialConnections);
    await expect
      .poll(async () => (await gateway.getRequests("sessions.list")).at(-1)?.params)
      .toMatchObject({ ownerId: "profile-ada" });
    await expect
      .poll(() => currentPage.locator('[data-session-key="agent:main:bob"]').count())
      .toBe(0);
    const reconnectedMenu = await openSidebarSortMenu(currentPage);
    await expectBrowser(reconnectedMenu.locator('[value="owner:profile-ada"]')).toHaveAttribute(
      "aria-checked",
      "true",
    );
  });

  it("keeps unrelated active sessions out of the involving-me filter", async () => {
    if (captureUiProofEnabled) {
      await mkdir(sessionOwnerProofArtifactDir, { recursive: true });
    }
    const context = await suite.browser.newContext({
      viewport: { height: 800, width: 1200 },
      ...(captureUiProofEnabled
        ? {
            recordVideo: {
              dir: sessionOwnerProofArtifactDir,
              size: { height: 800, width: 1200 },
            },
          }
        : {}),
    });
    const currentPage = await context.newPage();
    page = currentPage;
    const allSessions = sessionsList(["profile-ada", "profile-bob"]);
    const gateway = await installMockGateway(currentPage, {
      hasMultipleSessionSharingIdentities: true,
      sessionKey: "agent:main:ada",
      presenceUsers: [{ self: true, id: "profile-ada", name: "Ada" }],
      historyMessages: [{ role: "assistant", content: [{ type: "text", text: "Ready." }] }],
      methodResponses: { "sessions.list": allSessions },
    });

    await currentPage.goto(`${suite.server?.baseUrl ?? ""}chat`);
    await currentPage.getByText("Bob operations", { exact: true }).first().waitFor();
    await gateway.setMethodResponse("sessions.list", {
      ...allSessions,
      count: 1,
      sessions: allSessions.sessions.filter((session) => session.key === "agent:main:ada"),
    });
    const menu = await openSidebarSortMenu(currentPage);
    await menu.evaluate((element) =>
      element.dispatchEvent(
        new CustomEvent("wa-select", {
          bubbles: true,
          detail: { item: { value: "involving-me" } },
        }),
      ),
    );
    await expect
      .poll(() => currentPage.locator('[data-session-key="agent:main:bob"]').count())
      .toBe(0);
    await expect
      .poll(async () =>
        (await gateway.getRequests("sessions.list")).some(
          (request) =>
            (request.params as { involvingMe?: unknown } | undefined)?.involvingMe === true,
        ),
      )
      .toBe(true);
    await captureSessionOwnerProof(currentPage, "02-involving-me-before-active-event.png");

    await gateway.emitGatewayEvent("session.message", {
      sessionKey: "agent:main:bob",
      key: "agent:main:bob",
      kind: "direct",
      updatedAt: 3,
      archived: false,
      hasActiveRun: true,
      status: "running",
      owner: { actor: { type: "human", id: "profile-bob", label: "Bob" } },
      participants: [],
      participantCount: 0,
    });

    await expect
      .poll(() => currentPage.locator('[data-session-key="agent:main:bob"]').count())
      .toBe(0);
    await expectBrowser(currentPage.locator('[data-session-key="agent:main:ada"]')).toBeVisible();
    const filteredMenu = await openSidebarSortMenu(currentPage);
    await expectBrowser(filteredMenu.locator('[value="involving-me"]')).toHaveAttribute(
      "aria-checked",
      "true",
    );
    await captureSessionOwnerProof(currentPage, "03-involving-me-after-active-event.png");
  });

  it("renders zero ownership chrome for a single owner", async () => {
    const context = await suite.browser.newContext({ viewport: { height: 800, width: 1200 } });
    const currentPage = await context.newPage();
    page = currentPage;
    await installMockGateway(currentPage, {
      sessionKey: "agent:main:ada",
      historyMessages: [{ role: "assistant", content: [{ type: "text", text: "Ready." }] }],
      methodResponses: { "sessions.list": sessionsList(["profile-ada", "profile-ada"]) },
    });

    await currentPage.goto(`${suite.server?.baseUrl ?? ""}chat`);
    await currentPage.getByText("Ada research", { exact: true }).first().waitFor();
    await currentPage.getByText("Bob operations", { exact: true }).first().waitFor();
    await currentPage.locator('[data-session-key="agent:main:ada"] a').click();
    await currentPage.getByText("Ready.", { exact: true }).waitFor();
    const ownerMenu = await openSidebarSortMenu(currentPage);
    await captureUiProof(currentPage, "00-people-sort-hidden.png");
    expect(
      await ownerMenu.locator(".sidebar-session-sort-menu__title", { hasText: "People" }).count(),
    ).toBe(0);
    expect(await ownerMenu.locator('[value^="owner:"]').count()).toBe(0);
    expect(await currentPage.locator("openclaw-session-owner-chip").count()).toBe(0);
  });

  it("keeps global session actions accessible to keyboard users", async () => {
    const context = await suite.browser.newContext({ viewport: { height: 800, width: 1200 } });
    const currentPage = await context.newPage();
    page = currentPage;
    await installMockGateway(currentPage, {
      sessionKey: "agent:main:ada",
      featureMethods: ["chat.metadata", "chat.startup", "sessions.create"],
      historyMessages: [{ role: "assistant", content: [{ type: "text", text: "Ready." }] }],
      methodResponses: { "sessions.list": sessionsList(["profile-ada", "profile-ada"]) },
    });

    await currentPage.goto(`${suite.server?.baseUrl ?? ""}chat`);
    await currentPage.getByText("Ada research", { exact: true }).first().waitFor();
    await currentPage.getByText("Bob operations", { exact: true }).first().waitFor();

    const filterAndSort = currentPage.getByRole("button", { name: "Filter & sort" });
    await filterAndSort.focus();
    await currentPage.keyboard.press("Enter");

    const menu = currentPage.locator(".sidebar-session-sort-menu");
    await menu.waitFor();
    expect(await menu.locator('[value^="owner:"]').count()).toBe(0);
    await menu.getByRole("menuitemradio", { name: "None" }).click();

    await expect
      .poll(() => currentPage.locator('[data-session-section^="category:"]').count())
      .toBe(0);
    const threads = currentPage.locator('[data-session-section="ungrouped"]');
    await expect.poll(() => threads.locator(".sidebar-recent-session").count()).toBe(2);

    const newThread = currentPage
      .locator(".sidebar-session-toolbar")
      .getByRole("button", { name: "New session" });
    await newThread.focus();
    await currentPage.keyboard.press("Enter");
    await expect.poll(() => new URL(currentPage.url()).pathname).toBe("/new");
  });

  it("keeps own drafts subtle and fades admin-visible drafts from other people", async () => {
    if (captureUiProofEnabled) {
      await mkdir(uiProofArtifactDir, { recursive: true });
    }
    const context = await suite.browser.newContext({
      viewport: { height: 800, width: 1200 },
      ...(captureUiProofEnabled
        ? { recordVideo: { dir: uiProofArtifactDir, size: { height: 800, width: 1200 } } }
        : {}),
    });
    const currentPage = await context.newPage();
    page = currentPage;
    await installMockGateway(currentPage, {
      sessionKey: "agent:main:ada",
      presenceUsers: [{ self: true, id: "profile-ada", name: "Ada" }],
      methodResponses: { "sessions.list": draftSessionsList() },
    });

    await currentPage.goto(`${suite.server?.baseUrl ?? ""}chat`);
    const ownDraft = currentPage.locator('[data-session-key="agent:main:ada"]');
    const otherDraft = currentPage.locator('[data-session-key="agent:main:bob"]');
    await ownDraft.waitFor();
    await otherDraft.waitFor();
    await expect
      .poll(() => ownDraft.getAttribute("class"))
      .toContain("session-row-host--draft-owner");
    await expect
      .poll(() => otherDraft.getAttribute("class"))
      .toContain("session-row-host--draft-other");
    expect(await currentPage.locator(".session-row-draft-indicator").count()).toBe(2);
    await captureUiProof(currentPage, "01-sidebar-draft-treatment.png");
    await currentPage.evaluate(() =>
      document.documentElement.setAttribute("data-theme-mode", "dark"),
    );
    await captureUiProof(currentPage, "01-sidebar-draft-treatment-dark.png");
  });

  it("creates a draft atomically from the multi-person new-session flow", async () => {
    if (captureUiProofEnabled) {
      await mkdir(uiProofArtifactDir, { recursive: true });
    }
    const context = await suite.browser.newContext({
      viewport: { height: 800, width: 1200 },
      ...(captureUiProofEnabled
        ? { recordVideo: { dir: uiProofArtifactDir, size: { height: 800, width: 1200 } } }
        : {}),
    });
    const currentPage = await context.newPage();
    page = currentPage;
    const gateway = await installMockGateway(currentPage, {
      allowedSessionVisibilities: ["shared", "draft"],
      featureMethods: ["chat.metadata", "chat.startup", "sessions.create"],
      hasMultipleSessionSharingIdentities: true,
      methodResponses: {
        "sessions.list": sessionsList(["profile-ada", "profile-bob"]),
        "sessions.create": { key: "agent:main:new-draft", runStarted: true },
      },
    });

    await currentPage.goto(`${suite.server?.baseUrl ?? ""}new`);
    const menu = await openNewSessionPlusMenu(currentPage);
    await menu.getByRole("menuitem", { name: "Draft" }).waitFor();
    await captureUiProof(currentPage, "02-create-draft-available.png");
    await menu.getByRole("menuitem", { name: "Draft" }).click();
    await currentPage.keyboard.press("Escape");
    await currentPage.getByRole("button", { name: "Draft", exact: true }).waitFor();
    await currentPage.locator(".new-session-page__message").fill("work privately first");
    await captureUiProof(currentPage, "03-create-draft-selected.png");
    await currentPage.getByRole("button", { name: "Start session" }).click();

    const create = await gateway.waitForRequest("sessions.create");
    expect(create.params).toMatchObject({
      agentId: "main",
      message: "work privately first",
      visibility: "draft",
    });
  });

  it("publishes a draft through the header sharing menu", async () => {
    if (captureUiProofEnabled) {
      await mkdir(uiProofArtifactDir, { recursive: true });
    }
    const context = await suite.browser.newContext({
      viewport: { height: 800, width: 1200 },
      ...(captureUiProofEnabled
        ? { recordVideo: { dir: uiProofArtifactDir, size: { height: 800, width: 1200 } } }
        : {}),
    });
    const currentPage = await context.newPage();
    page = currentPage;
    const sessions = draftSessionsList();
    const ownerSession = sessions.sessions[0];
    if (!ownerSession) {
      throw new Error("expected owner draft fixture");
    }
    Object.assign(ownerSession, { sharingRole: "owner" });
    const gateway = await installMockGateway(currentPage, {
      sessionKey: "agent:main:ada",
      featureMethods: [
        "chat.metadata",
        "chat.startup",
        "session.visibility.set",
        "session.members.list",
        "session.members.add",
        "session.members.remove",
      ],
      operatorScopes: ["operator.write"],
      historyMessages: [{ role: "assistant", content: [{ type: "text", text: "Ready." }] }],
      methodResponses: {
        "sessions.list": sessions,
        "session.members.list": {
          sessionKey: "agent:main:ada",
          members: [],
          identities: [],
          role: "owner",
          allowedVisibilities: ["shared", "draft"],
        },
        "session.visibility.set": {
          ok: true,
          sessionKey: "agent:main:ada",
          visibility: "shared",
        },
      },
    });

    await currentPage.goto(`${suite.server?.baseUrl ?? ""}chat`);
    await currentPage.getByText("Ready.", { exact: true }).waitFor();
    await currentPage.getByLabel("Session sharing").click();
    const publish = currentPage.getByText("Publish draft", { exact: true });
    await publish.waitFor();
    await captureUiProof(currentPage, "04-publish-draft-action.png");
    await publish.click();

    const request = await gateway.waitForRequest("session.visibility.set");
    expect(request.params).toMatchObject({
      sessionKey: "agent:main:ada",
      visibility: "shared",
    });
    expect(await gateway.getRequests("session.visibility.set")).toHaveLength(1);
  });

  it("keeps rejected visibility-only sharing changes visible after the menu closes", async () => {
    const context = await suite.browser.newContext({ viewport: { height: 800, width: 1200 } });
    const currentPage = await context.newPage();
    page = currentPage;
    const sessions = draftSessionsList();
    const ownerSession = sessions.sessions[0];
    if (!ownerSession) {
      throw new Error("expected owner draft fixture");
    }
    Object.assign(ownerSession, { sharingRole: "owner" });
    const gateway = await installMockGateway(currentPage, {
      sessionKey: "agent:main:ada",
      allowedSessionVisibilities: ["shared", "draft"],
      deferredMethods: ["session.visibility.set"],
      featureMethods: ["chat.metadata", "chat.startup", "session.visibility.set"],
      operatorScopes: ["operator.write"],
      historyMessages: [{ role: "assistant", content: [{ type: "text", text: "Ready." }] }],
      methodResponses: { "sessions.list": sessions },
    });

    await currentPage.goto(`${suite.server?.baseUrl ?? ""}chat`);
    await currentPage.getByText("Ready.", { exact: true }).waitFor();
    await currentPage.getByRole("button", { name: "Session sharing" }).click();
    const dropdown = currentPage.locator(".chat-pane__sharing-menu");
    await expect.poll(() => dropdown.getAttribute("open")).not.toBeNull();
    expect(await dropdown.locator(".chat-pane__sharing-title").count()).toBe(1);
    await currentPage.getByText("Publish draft", { exact: true }).click();
    await gateway.waitForRequest("session.visibility.set");
    await expect.poll(() => dropdown.getAttribute("open")).toBeNull();
    expect(await gateway.getRequests("session.members.list")).toHaveLength(0);

    const message = "visibility change rejected";
    await gateway.rejectDeferred("session.visibility.set", {
      code: "INVALID_REQUEST",
      message,
    });
    const alert = currentPage.locator(".chat-error[role=alert]").filter({ hasText: message });
    await expectBrowser(alert).toBeVisible();

    await currentPage.getByRole("button", { name: "Session sharing" }).click();
    await expectBrowser(dropdown.getByRole("alert").filter({ hasText: message })).toBeVisible();
  });

  it("lets a read-scoped owner inspect sharing but blocks mutations", async () => {
    const context = await suite.browser.newContext({ viewport: { height: 800, width: 1200 } });
    const currentPage = await context.newPage();
    page = currentPage;
    const sessions = draftSessionsList();
    const ownerSession = sessions.sessions[0];
    if (!ownerSession) {
      throw new Error("expected owner draft fixture");
    }
    Object.assign(ownerSession, { sharingRole: "owner" });
    const gateway = await installMockGateway(currentPage, {
      sessionKey: "agent:main:ada",
      featureMethods: [
        "chat.metadata",
        "chat.startup",
        "session.visibility.set",
        "session.members.list",
        "session.members.add",
        "session.members.remove",
      ],
      operatorScopes: ["operator.read"],
      historyMessages: [{ role: "assistant", content: [{ type: "text", text: "Ready." }] }],
      methodResponses: {
        "sessions.list": sessions,
        "session.members.list": {
          sessionKey: "agent:main:ada",
          members: [],
          identities: [{ type: "human", id: "profile-bob", label: "Bob" }],
          role: "owner",
          allowedVisibilities: ["shared", "draft"],
        },
      },
    });

    await currentPage.goto(`${suite.server?.baseUrl ?? ""}chat`);
    await currentPage.getByText("Ready.", { exact: true }).waitFor();
    await currentPage.getByLabel("Session sharing").click();
    await gateway.waitForRequest("session.members.list");
    const dropdown = currentPage.locator(".chat-pane__sharing-menu");
    const publish = dropdown.locator('wa-dropdown-item[value="visibility:shared"]');
    await publish.waitFor();
    expect(await publish.getAttribute("disabled")).not.toBeNull();

    await dropdown.evaluate((element) => {
      element.dispatchEvent(
        new CustomEvent("wa-select", {
          detail: { item: { value: "visibility:shared" } },
        }),
      );
      element.dispatchEvent(
        new CustomEvent("wa-select", {
          detail: { item: { value: "member:profile-bob" } },
        }),
      );
    });

    expect(await gateway.getRequests("session.visibility.set")).toHaveLength(0);
    expect(await gateway.getRequests("session.members.add")).toHaveLength(0);
  });

  it("scrolls high-volume sharing through one compact menu", async () => {
    const context = await suite.browser.newContext({ viewport: { height: 800, width: 1280 } });
    const currentPage = await context.newPage();
    page = currentPage;
    const sessions = sessionsList(["profile-ada", "profile-bob"]);
    const activeSession = sessions.sessions[0];
    if (!activeSession) {
      throw new Error("expected active session fixture");
    }
    Object.assign(activeSession, { visibility: "shared", sharingRole: "owner" });
    sessions.count = 1;
    sessions.owners = [{ type: "human", id: "profile-ada", label: "Ada" }];
    sessions.sessions = [activeSession];
    const longMemberLabel =
      "Alexandria Montgomery-Santiago from the International Collaboration Working Group";
    const longMemberId = `profile:${"member-without-a-display-name-".repeat(6)}`;
    const humanIdentities = [
      { type: "human" as const, id: "profile-long-name", label: longMemberLabel },
      { type: "human" as const, id: longMemberId },
      ...Array.from({ length: 28 }, (_, index) => ({
        type: "human" as const,
        id: `profile-member-${index}`,
        label: `Member ${index + 1}`,
      })),
    ];
    const nonHumanIdentities = [
      { type: "agent" as const, id: "agent-design", label: "Design" },
      { type: "system" as const, id: "system-operations", label: "Operations" },
    ];
    const gateway = await installMockGateway(currentPage, {
      sessionKey: "agent:main:ada",
      hasMultipleSessionSharingIdentities: true,
      featureMethods: [
        "chat.metadata",
        "chat.startup",
        "session.members.list",
        "session.members.add",
        "session.members.remove",
        "session.visibility.set",
      ],
      operatorScopes: ["operator.read", "operator.write"],
      historyMessages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "Share the launch review with the design and operations groups, then summarize the open decisions.",
            },
          ],
        },
        {
          role: "assistant",
          content: [
            {
              type: "text",
              text: "I prepared the rollout summary, linked the review notes, and kept the workspace visible to collaborators.",
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "Add the remaining members and confirm the sharing policy before the handoff.",
            },
          ],
        },
        { role: "assistant", content: [{ type: "text", text: "Ready." }] },
      ],
      methodResponses: {
        "sessions.list": sessions,
        "session.members.list": {
          sessionKey: "agent:main:ada",
          members: [{ identityId: longMemberId, addedBy: "profile-ada", addedAt: 1 }],
          identities: [...humanIdentities, ...nonHumanIdentities],
          role: "owner",
          allowedVisibilities: ["shared", "read-only", "suggest", "draft"],
        },
      },
    });

    await currentPage.goto(`${suite.server?.baseUrl ?? ""}chat`);
    await currentPage.getByText("Ready.", { exact: true }).waitFor();
    await currentPage.locator(".chat-pane__sharing-trigger").click();
    await gateway.waitForRequest("session.members.list");
    const dropdown = currentPage.locator(".chat-pane__sharing-menu");
    await dropdown.locator('wa-dropdown-item[value="member:profile-member-0"]').waitFor();
    await dropdown.evaluate(async (element) => {
      const menu = element.shadowRoot?.querySelector<HTMLElement>('[part="menu"]');
      const animations = [...element.getAnimations(), ...(menu?.getAnimations() ?? [])];
      await Promise.all(animations.map((animation) => animation.finished.catch(() => {})));
    });
    const longNameItem = dropdown.locator('wa-dropdown-item[value="member:profile-long-name"]');
    const longIdItem = dropdown.locator(`wa-dropdown-item[value="member:${longMemberId}"]`);

    await longIdItem.scrollIntoViewIfNeeded();
    const selectedIndicator = longIdItem.locator('[slot="details"]');
    await expectBrowser(selectedIndicator).toBeVisible();
    const selectedIndicatorContained = await longIdItem.evaluate((item) => {
      const indicator = item.querySelector<HTMLElement>('[slot="details"]');
      const itemRect = item.getBoundingClientRect();
      const indicatorRect = indicator?.getBoundingClientRect();
      return Boolean(
        indicatorRect &&
        indicatorRect.left >= itemRect.left &&
        indicatorRect.right <= itemRect.right,
      );
    });
    expect(selectedIndicatorContained).toBe(true);

    const beforeScroll = await dropdown.evaluate((element) => {
      const menu = element.shadowRoot?.querySelector<HTMLElement>('[part="menu"]');
      if (menu) {
        menu.scrollTop = 0;
      }
      const visibilityTitle = element.querySelector<HTMLElement>(
        ".chat-pane__sharing-visibility-title",
      );
      const visibilityItems = [
        ...element.querySelectorAll<HTMLElement>(".chat-pane__sharing-visibility-item"),
      ];
      const membersTitle = element.querySelector<HTMLElement>(".chat-pane__sharing-members-title");
      const firstMember = element.querySelector<HTMLElement>(".chat-pane__sharing-member");
      const longLabels = [
        ...element.querySelectorAll<HTMLElement>(".chat-pane__sharing-member-label"),
      ].slice(0, 2);
      const menuRect = menu?.getBoundingClientRect();
      const previousVisibilityRect = visibilityItems.at(-2)?.getBoundingClientRect();
      const lastVisibilityRect = visibilityItems.at(-1)?.getBoundingClientRect();
      const membersTitleRect = membersTitle?.getBoundingClientRect();
      return {
        menuHeight: menu?.getBoundingClientRect().height ?? 0,
        menuTop: menu?.getBoundingClientRect().top ?? 0,
        scrollHeight: menu?.scrollHeight ?? 0,
        clientHeight: menu?.clientHeight ?? 0,
        scrollWidth: menu?.scrollWidth ?? 0,
        clientWidth: menu?.clientWidth ?? 0,
        longLabelsContained: longLabels.every((label) => {
          const rect = label.getBoundingClientRect();
          return menuRect ? rect.left >= menuRect.left && rect.right <= menuRect.right : false;
        }),
        longLabelsOverflow: longLabels.every((label) => label.scrollWidth > label.clientWidth),
        firstMemberTop: firstMember?.getBoundingClientRect().top ?? 0,
        groupGap:
          membersTitleRect && lastVisibilityRect
            ? membersTitleRect.top - lastVisibilityRect.bottom
            : 0,
        rowGap:
          previousVisibilityRect && lastVisibilityRect
            ? lastVisibilityRect.top - previousVisibilityRect.bottom
            : 0,
        membersTitleInset: Number.parseFloat(
          membersTitle ? getComputedStyle(membersTitle).paddingInlineStart : "0",
        ),
        firstMemberInset: Number.parseFloat(
          firstMember ? getComputedStyle(firstMember).paddingInlineStart : "0",
        ),
        visibilityTitlePosition: visibilityTitle ? getComputedStyle(visibilityTitle).position : "",
        membersTitlePosition: membersTitle ? getComputedStyle(membersTitle).position : "",
        nestedScrollers: [...element.children].filter((child) => {
          const node = child as HTMLElement;
          return (
            node.scrollHeight > node.clientHeight &&
            ["auto", "scroll"].includes(getComputedStyle(node).overflowY)
          );
        }).length,
      };
    });
    const afterScroll = await dropdown.evaluate(async (element) => {
      const menu = element.shadowRoot?.querySelector<HTMLElement>('[part="menu"]');
      const visibilityTitle = element.querySelector<HTMLElement>(
        ".chat-pane__sharing-visibility-title",
      );
      const membersTitle = element.querySelector<HTMLElement>(".chat-pane__sharing-members-title");
      const firstMember = element.querySelector<HTMLElement>(".chat-pane__sharing-member");
      if (menu) {
        menu.scrollTop = menu.scrollHeight;
      }
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => resolve());
      });
      return {
        scrollTop: menu?.scrollTop ?? 0,
        visibilityTitleBottom: visibilityTitle?.getBoundingClientRect().bottom ?? 0,
        membersTitleTop: membersTitle?.getBoundingClientRect().top ?? 0,
        firstMemberTop: firstMember?.getBoundingClientRect().top ?? 0,
      };
    });

    expect(beforeScroll.menuHeight).toBeLessThanOrEqual(421);
    expect(beforeScroll.scrollHeight).toBeGreaterThan(beforeScroll.clientHeight);
    expect(beforeScroll.scrollWidth).toBe(beforeScroll.clientWidth);
    expect(beforeScroll.longLabelsContained).toBe(true);
    expect(beforeScroll.longLabelsOverflow).toBe(true);
    expect(beforeScroll.membersTitleInset).toBe(beforeScroll.firstMemberInset);
    expect(beforeScroll.groupGap).toBeGreaterThanOrEqual(8);
    expect(beforeScroll.groupGap).toBeGreaterThan(beforeScroll.rowGap + 6);
    expect(beforeScroll.visibilityTitlePosition).not.toBe("sticky");
    expect(beforeScroll.membersTitlePosition).not.toBe("sticky");
    expect(beforeScroll.nestedScrollers).toBe(0);
    expect(afterScroll.scrollTop).toBeGreaterThan(0);
    expect(afterScroll.visibilityTitleBottom).toBeLessThan(beforeScroll.menuTop);
    expect(afterScroll.membersTitleTop).toBeLessThan(beforeScroll.menuTop);
    expect(afterScroll.firstMemberTop).toBeLessThan(beforeScroll.firstMemberTop);
    await expectBrowser(
      dropdown.locator(".chat-pane__sharing-member openclaw-session-owner-chip"),
    ).toHaveCount(30);
    // Agent and system identities render the non-human icon from identity.type,
    // not from an ID-string heuristic; owner-chip presentation is human-only.
    await expectBrowser(dropdown.locator(".chat-pane__sharing-member-icon > svg")).toHaveCount(2);
    expect(
      await longNameItem.locator(".chat-pane__sharing-member-label").getAttribute("title"),
    ).toBe(longMemberLabel);
    expect(await longIdItem.locator(".chat-pane__sharing-member-label").getAttribute("title")).toBe(
      longMemberId,
    );
    await expectBrowser(selectedIndicator).toHaveCount(1);
    expect(await selectedIndicator.getAttribute("aria-label")).not.toBeNull();
  });

  it("clears a selected draft mode when sharing policy becomes unavailable", async () => {
    const context = await suite.browser.newContext({ viewport: { height: 800, width: 1200 } });
    const currentPage = await context.newPage();
    page = currentPage;
    const gateway = await installMockGateway(currentPage, {
      allowedSessionVisibilities: ["shared", "draft"],
      hasMultipleSessionSharingIdentities: true,
      methodResponses: { "sessions.list": sessionsList(["profile-ada", "profile-bob"]) },
    });

    await currentPage.goto(`${suite.server?.baseUrl ?? ""}new`);
    await selectNewSessionDraft(currentPage);
    await gateway.setSessionSharingPolicy({
      allowedSessionVisibilities: ["shared"],
      hasMultipleSessionSharingIdentities: false,
    });
    await replaceGatewayClient(currentPage);
    await expect
      .poll(() => currentPage.getByRole("button", { name: "Draft", exact: true }).count())
      .toBe(0);

    await gateway.setSessionSharingPolicy({
      allowedSessionVisibilities: ["shared", "draft"],
      hasMultipleSessionSharingIdentities: true,
    });
    await replaceGatewayClient(currentPage);
    const menu = await openNewSessionPlusMenu(currentPage);
    await menu.getByRole("menuitem", { name: "Draft" }).waitFor();
    expect(await currentPage.getByRole("button", { name: "Draft", exact: true }).count()).toBe(0);
  });

  it("keeps create-as-draft dormant for one owner", async () => {
    const context = await suite.browser.newContext({ viewport: { height: 800, width: 1200 } });
    const currentPage = await context.newPage();
    page = currentPage;
    await installMockGateway(currentPage, {
      allowedSessionVisibilities: ["shared", "draft"],
      hasMultipleSessionSharingIdentities: false,
      methodResponses: { "sessions.list": sessionsList(["profile-ada", "profile-ada"]) },
    });

    await currentPage.goto(`${suite.server?.baseUrl ?? ""}new`);
    const menu = await openNewSessionPlusMenu(currentPage);
    expect(await menu.getByRole("menuitem", { name: "Draft" }).count()).toBe(0);
  });
});
