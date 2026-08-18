// Control UI E2E tests cover session ownership dormancy and owner filtering.
import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { Page } from "playwright";
import { expect as expectBrowser } from "playwright/test";
import { afterEach, expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI session ownership",
});

const captureUiProofEnabled = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
const uiProofArtifactDir = path.join(process.cwd(), ".artifacts", "control-ui-e2e", "drafts-ux");

let page: Page | undefined;
function sessionsList(owners: [string, string]) {
  const ownerFacet = [
    { type: "human" as const, id: owners[0], label: "Ada" },
    ...(owners[1] === owners[0] ? [] : [{ type: "human" as const, id: owners[1], label: "Bob" }]),
  ];
  return {
    count: 2,
    owners: ownerFacet,
    defaults: { contextTokens: null, model: null, modelProvider: null },
    path: "",
    sessions: [
      {
        key: "agent:main:ada",
        kind: "direct",
        label: "Ada research",
        category: "Research",
        createdActor: { type: "human", id: owners[0], label: "Ada" },
        owner: { actor: { type: "human", id: owners[0], label: "Ada" } },
        updatedAt: 2,
      },
      {
        key: "agent:main:bob",
        kind: "direct",
        label: "Bob operations",
        category: "Operations",
        createdActor: {
          type: "human",
          id: owners[1],
          label: owners[1] === owners[0] ? "Ada" : "Bob",
        },
        owner: {
          actor: {
            type: "human",
            id: owners[1],
            label: owners[1] === owners[0] ? "Ada" : "Bob",
          },
        },
        updatedAt: 1,
      },
    ],
    ts: 1,
  };
}

function draftSessionsList() {
  const result = sessionsList(["profile-ada", "profile-bob"]);
  for (const session of result.sessions) {
    Object.assign(session, { visibility: "draft", sharingRole: "admin" });
  }
  return result;
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

async function openSidebarSortMenu(targetPage: Page) {
  const filterAndSort = targetPage.getByRole("button", { name: "Filter & sort" });
  await expect.poll(() => filterAndSort.count(), { timeout: 2_000 }).toBe(1);
  await filterAndSort.click();
  const menu = targetPage.locator(".sidebar-session-sort-menu");
  await menu.waitFor();
  return menu;
}

async function replaceGatewayClient(targetPage: Page) {
  await targetPage.evaluate(() => {
    const app = document.querySelector("openclaw-app") as HTMLElement & {
      runtime?: { context: { gateway: { connect: () => void } } };
    };
    if (!app.runtime) {
      throw new Error("OpenClaw application runtime is unavailable");
    }
    app.runtime.context.gateway.connect();
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

  it("shows permanent owner chips and filters existing custom groups", async () => {
    const context = await suite.browser.newContext({ viewport: { height: 800, width: 1200 } });
    const currentPage = await context.newPage();
    page = currentPage;
    const gateway = await installMockGateway(currentPage, {
      hasMultipleSessionSharingIdentities: true,
      sessionKey: "agent:main:ada",
      historyMessages: [{ role: "assistant", content: [{ type: "text", text: "Ready." }] }],
      methodResponses: { "sessions.list": sessionsList(["profile-ada", "profile-bob"]) },
    });

    await currentPage.goto(`${suite.server?.baseUrl ?? ""}chat`);
    await currentPage.getByText("Ada research", { exact: true }).first().waitFor();
    await currentPage.getByText("Bob operations", { exact: true }).first().waitFor();
    await currentPage.locator('[data-session-key="agent:main:ada"] a').click();
    await currentPage.getByText("Ready.", { exact: true }).waitFor();
    await expect.poll(() => currentPage.locator("openclaw-session-owner-chip").count()).toBe(3);

    const ownerMenu = await openSidebarSortMenu(currentPage);
    await ownerMenu.locator('[value="sort:people"]').waitFor();
    await captureUiProof(currentPage, "00-people-sort-available.png");
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
    // Playwright check()/isChecked() support role="switch" buttons via aria-checked.
    const draftToggle = currentPage.getByRole("switch", { name: "Draft", exact: true });
    await draftToggle.waitFor();
    await captureUiProof(currentPage, "02-create-draft-available.png");
    await draftToggle.check();
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
    const alert = currentPage.getByRole("alert").filter({ hasText: message });
    await expectBrowser(alert).toBeVisible();

    await currentPage.getByRole("button", { name: "Session sharing" }).click();
    await expectBrowser(dropdown.locator(".chat-pane__sharing-status--error")).toBeVisible();
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
    const draftToggle = currentPage.getByRole("switch", { name: "Draft", exact: true });
    await draftToggle.check();
    await gateway.setSessionSharingPolicy({
      allowedSessionVisibilities: ["shared"],
      hasMultipleSessionSharingIdentities: false,
    });
    await replaceGatewayClient(currentPage);
    await expect.poll(() => draftToggle.count()).toBe(0);

    await gateway.setSessionSharingPolicy({
      allowedSessionVisibilities: ["shared", "draft"],
      hasMultipleSessionSharingIdentities: true,
    });
    await replaceGatewayClient(currentPage);
    await draftToggle.waitFor();
    expect(await draftToggle.isChecked()).toBe(false);
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
    await currentPage.locator(".new-session-page__message").waitFor();
    expect(await currentPage.getByRole("switch", { name: "Draft", exact: true }).count()).toBe(0);
  });
});
