// Control UI E2E tests cover session ownership dormancy and creator filtering.
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  canRunPlaywrightChromium,
  installMockGateway,
  resolvePlaywrightChromiumExecutablePath,
  startControlUiE2eServer,
  type ControlUiE2eServer,
} from "../test-helpers/control-ui-e2e.ts";

const chromiumExecutablePath = resolvePlaywrightChromiumExecutablePath(chromium.executablePath());
const chromiumAvailable = canRunPlaywrightChromium(chromiumExecutablePath);
const allowMissingChromium = process.env.OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM === "1";
const describeControlUiE2e = chromiumAvailable || !allowMissingChromium ? describe : describe.skip;
const captureUiProofEnabled = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
const uiProofArtifactDir = path.join(process.cwd(), ".artifacts", "control-ui-e2e", "drafts-ux");

let browser: Browser;
let page: Page | undefined;
let server: ControlUiE2eServer | undefined;

function sessionsList(creators: [string, string]) {
  const creatorFacet = [
    { id: creators[0], label: "Ada" },
    ...(creators[1] === creators[0] ? [] : [{ id: creators[1], label: "Bob" }]),
  ];
  return {
    count: 2,
    creators: creatorFacet,
    defaults: { contextTokens: null, model: null, modelProvider: null },
    path: "",
    sessions: [
      {
        key: "agent:main:ada",
        kind: "direct",
        label: "Ada research",
        category: "Research",
        createdActor: { type: "human", id: creators[0], label: "Ada" },
        updatedAt: 2,
      },
      {
        key: "agent:main:bob",
        kind: "direct",
        label: "Bob operations",
        category: "Operations",
        createdActor: {
          type: "human",
          id: creators[1],
          label: creators[1] === creators[0] ? "Ada" : "Bob",
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

describeControlUiE2e("Control UI session ownership", () => {
  beforeAll(async () => {
    browser = await chromium.launch({ executablePath: chromiumExecutablePath });
    try {
      server = await startControlUiE2eServer();
    } catch (error) {
      await browser.close();
      throw error;
    }
  });

  afterEach(async () => {
    await page
      ?.context()
      .close()
      .catch(() => {});
    page = undefined;
  });

  afterAll(async () => {
    await browser?.close().catch(() => {});
    await server?.close();
  });

  it("shows permanent owner chips and filters existing custom groups", async () => {
    const context = await browser.newContext({ viewport: { height: 800, width: 1200 } });
    const currentPage = await context.newPage();
    page = currentPage;
    const gateway = await installMockGateway(currentPage, {
      sessionKey: "agent:main:ada",
      historyMessages: [{ role: "assistant", content: [{ type: "text", text: "Ready." }] }],
      methodResponses: { "sessions.list": sessionsList(["profile-ada", "profile-bob"]) },
    });

    await currentPage.goto(`${server?.baseUrl ?? ""}chat`);
    await currentPage.getByText("Ada research", { exact: true }).first().waitFor();
    await currentPage.getByText("Bob operations", { exact: true }).first().waitFor();
    await currentPage.locator('[data-session-key="agent:main:ada"] a').click();
    await currentPage.getByText("Ready.", { exact: true }).waitFor();
    await expect.poll(() => currentPage.locator("openclaw-session-owner-chip").count()).toBe(3);

    await currentPage.locator(".sidebar-session-sort").click();
    const creatorMenu = currentPage.locator(".sidebar-session-sort-menu");
    await creatorMenu.locator('[value="creator:profile-ada"]').waitFor();
    await creatorMenu.evaluate((element) =>
      element.dispatchEvent(
        new CustomEvent("wa-select", {
          bubbles: true,
          detail: { item: { value: "creator:profile-ada" } },
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
            (request.params as { creatorId?: unknown } | undefined)?.creatorId === "profile-ada",
        ),
      )
      .toBe(true);
  });

  it("renders zero ownership chrome for a single creator", async () => {
    const context = await browser.newContext({ viewport: { height: 800, width: 1200 } });
    const currentPage = await context.newPage();
    page = currentPage;
    await installMockGateway(currentPage, {
      sessionKey: "agent:main:ada",
      historyMessages: [{ role: "assistant", content: [{ type: "text", text: "Ready." }] }],
      methodResponses: { "sessions.list": sessionsList(["profile-ada", "profile-ada"]) },
    });

    await currentPage.goto(`${server?.baseUrl ?? ""}chat`);
    await currentPage.getByText("Ada research", { exact: true }).first().waitFor();
    await currentPage.getByText("Bob operations", { exact: true }).first().waitFor();
    await currentPage.locator('[data-session-key="agent:main:ada"] a').click();
    await currentPage.getByText("Ready.", { exact: true }).waitFor();
    await currentPage.locator(".sidebar-session-sort").click();
    const creatorMenu = currentPage.locator(".sidebar-session-sort-menu");
    await creatorMenu.waitFor();
    expect(
      await creatorMenu.locator(".sidebar-session-sort-menu__title", { hasText: "People" }).count(),
    ).toBe(0);
    expect(await creatorMenu.locator('[value^="creator:"]').count()).toBe(0);
    expect(await currentPage.locator("openclaw-session-owner-chip").count()).toBe(0);
  });

  it("keeps own drafts subtle and fades admin-visible drafts from other people", async () => {
    if (captureUiProofEnabled) {
      await mkdir(uiProofArtifactDir, { recursive: true });
    }
    const context = await browser.newContext({
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

    await currentPage.goto(`${server?.baseUrl ?? ""}chat`);
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
    const context = await browser.newContext({
      viewport: { height: 800, width: 1200 },
      ...(captureUiProofEnabled
        ? { recordVideo: { dir: uiProofArtifactDir, size: { height: 800, width: 1200 } } }
        : {}),
    });
    const currentPage = await context.newPage();
    page = currentPage;
    const gateway = await installMockGateway(currentPage, {
      allowedSessionVisibilities: ["shared", "draft"],
      hasMultipleSessionSharingIdentities: true,
      methodResponses: {
        "sessions.list": sessionsList(["profile-ada", "profile-bob"]),
        "sessions.create": { key: "agent:main:new-draft", runStarted: true },
      },
    });

    await currentPage.goto(`${server?.baseUrl ?? ""}new`);
    const draftToggle = currentPage.getByLabel("Start as draft");
    await draftToggle.waitFor();
    await captureUiProof(currentPage, "02-create-draft-available.png");
    await draftToggle.check();
    await currentPage.locator(".new-session-page__message").fill("work privately first");
    await captureUiProof(currentPage, "03-create-draft-selected.png");
    await currentPage.getByRole("button", { name: "Start thread" }).click();

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
    const context = await browser.newContext({
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
      featureMethods: ["chat.metadata", "chat.startup", "session.visibility.set"],
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

    await currentPage.goto(`${server?.baseUrl ?? ""}chat`);
    await currentPage.getByText("Ready.", { exact: true }).waitFor();
    await currentPage.getByLabel("Thread sharing").click();
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

  it("clears a selected draft mode when sharing policy becomes unavailable", async () => {
    const context = await browser.newContext({ viewport: { height: 800, width: 1200 } });
    const currentPage = await context.newPage();
    page = currentPage;
    const gateway = await installMockGateway(currentPage, {
      allowedSessionVisibilities: ["shared", "draft"],
      hasMultipleSessionSharingIdentities: true,
      methodResponses: { "sessions.list": sessionsList(["profile-ada", "profile-bob"]) },
    });

    await currentPage.goto(`${server?.baseUrl ?? ""}new`);
    const draftToggle = currentPage.getByLabel("Start as draft");
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

  it("keeps create-as-draft dormant for one creator", async () => {
    const context = await browser.newContext({ viewport: { height: 800, width: 1200 } });
    const currentPage = await context.newPage();
    page = currentPage;
    await installMockGateway(currentPage, {
      allowedSessionVisibilities: ["shared", "draft"],
      hasMultipleSessionSharingIdentities: false,
      methodResponses: { "sessions.list": sessionsList(["profile-ada", "profile-ada"]) },
    });

    await currentPage.goto(`${server?.baseUrl ?? ""}new`);
    await currentPage.locator(".new-session-page__message").waitFor();
    expect(await currentPage.getByLabel("Start as draft").count()).toBe(0);
  });
});
