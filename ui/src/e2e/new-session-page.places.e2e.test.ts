import path from "node:path";
import { expect, it } from "vitest";
import {
  PICKED,
  WORKSPACE,
  captureNewSessionComposerUiProof,
  captureProjectUiProof,
  captureUiProofEnabled,
  controlUiSessionPath,
  createNewSessionPageE2eSuite,
  createdSessionListResult,
  installMockGateway,
  pollLocatorText,
} from "./new-session-page.test-support.ts";

const suite = createNewSessionPageE2eSuite();

suite.define(() => {
  it("keeps the pre-submit draft on the composer and creates exactly one session", async () => {
    const context = await suite.browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
      ...(captureUiProofEnabled
        ? {
            recordVideo: {
              dir: path.join(suite.artifactDir, "new-session-slash-menu"),
              size: { height: 900, width: 1280 },
            },
          }
        : {}),
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      methodResponses: {
        "agents.list": {
          agents: [
            {
              id: "main",
              identity: { name: "Main" },
              name: "Main",
              workspace: WORKSPACE,
              workspaceGit: true,
            },
          ],
          defaultId: "main",
          mainKey: "main",
          scope: "agent",
        },
        "sessions.list": createdSessionListResult("agent:main:existing"),
        "sessions.create": { key: "agent:main:draft-e2e" },
      },
    });

    try {
      await page.goto(`${suite.server.baseUrl}new?agent=main`);
      await page.getByRole("heading", { name: "Main" }).waitFor();
      const message = page.locator(".new-session-page__message");
      await message.waitFor();
      await message.fill("/");
      const slashMenu = page.locator("#chat-new-session-slash-menu-listbox");
      await pollLocatorText(slashMenu).toContain("/status");
      expect(await slashMenu.textContent()).not.toContain("/clear");
      await captureNewSessionComposerUiProof(suite, page, "slash-menu-open.png", {
        surface: slashMenu,
        content: [slashMenu.getByRole("option").first()],
      });
      if (captureUiProofEnabled) {
        await page.waitForTimeout(750);
      }
      await message.fill("fix the flaky draft test");

      // Owner boundary: the New Session page (new-session-page.ts:228) keeps
      // the draft message on DraftSubmissionFlow until the composer submits,
      // so the route, the typed text, and the sidebar's canonical
      // sessions.list row must all stay put with zero sessions.create
      // requests before that happens.
      expect(new URL(page.url()).pathname).toBe("/new");
      expect(new URL(page.url()).search).toBe("?agent=main");
      expect(await message.inputValue()).toBe("fix the flaky draft test");
      expect(
        await page
          .locator('.sidebar-recent-session[data-session-key="agent:main:existing"]')
          .count(),
      ).toBe(1);
      expect(await page.locator(".sidebar-recent-session").count()).toBe(1);
      expect(await gateway.getRequests("sessions.create")).toHaveLength(0);

      await page.getByRole("button", { name: "Start session" }).click();

      const createRequest = await gateway.waitForRequest("sessions.create");
      expect(createRequest.params).toMatchObject({
        agentId: "main",
        message: "fix the flaky draft test",
      });

      // Wait for the same canonical settle signal the neighboring submission
      // test uses (navigation to the created session route) before counting
      // requests: the exactly-once assert must observe the submission flow
      // after it has fully resolved, not mid-flight, or a late duplicate
      // sessions.create could land after a premature pass.
      await expect
        .poll(() => new URL(page.url()).pathname)
        .toBe(controlUiSessionPath("agent:main:draft-e2e"));
      expect(await gateway.getRequests("sessions.create")).toHaveLength(1);
    } finally {
      await context.close();
    }
  });

  it("drafts a session with a browsed folder and creates it on first message", async () => {
    const context = await suite.browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
      ...(captureUiProofEnabled
        ? {
            recordVideo: {
              dir: path.join(suite.artifactDir, "project-registry"),
              size: { height: 900, width: 1280 },
            },
          }
        : {}),
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      workspaceGit: true,
      methodResponses: {
        "agents.list": {
          agents: [
            {
              id: "main",
              identity: { name: "Main" },
              name: "Main",
              workspace: WORKSPACE,
              workspaceGit: true,
            },
            {
              id: "research",
              identity: { name: "Research" },
              name: "Research",
              workspace: "/home/peter/research",
              workspaceGit: true,
            },
          ],
          defaultId: "main",
          mainKey: "main",
          scope: "agent",
        },
        "worktrees.branches": {
          branches: [{ kind: "local", name: "main" }],
          defaultBranch: "main",
          headBranch: "main",
          repositoryStatus: "git",
        },
        "fs.listDir": {
          cases: [
            {
              match: { path: WORKSPACE },
              response: {
                path: WORKSPACE,
                parent: "/home/peter",
                home: "/home/peter",
                entries: [
                  { name: "packages", path: PICKED },
                  { name: "tools", path: `${WORKSPACE}/tools` },
                  { name: ".git", path: `${WORKSPACE}/.git`, hidden: true },
                ],
              },
            },
            {
              match: { path: PICKED },
              response: {
                path: PICKED,
                parent: WORKSPACE,
                home: "/home/peter",
                entries: [],
              },
            },
          ],
        },
        "sessions.create": { key: "agent:main:draft-e2e" },
      },
    });

    try {
      // Deep-link to /new: the page loads agents via agents.list (the sidebar
      // "+" navigates to the same route with ?agent=<id>).
      const response = await page.goto(`${suite.server.baseUrl}new`);
      expect(response?.status()).toBe(200);
      // The draft page shows the start-screen welcome hero for the agent.
      await page.getByRole("heading", { name: "Main" }).waitFor();
      await page.locator(".new-session-page__message").waitFor();

      // Incognito is a page-level choice on the far end of the shell-control
      // centerline, rather than an option inside the composer.
      const incognitoToggle = page.getByRole("switch", { name: "Incognito" });
      const incognitoBox = await incognitoToggle.boundingBox();
      const commandPaletteBox = await page
        .getByRole("button", { name: "Open command palette" })
        .boundingBox();
      expect(incognitoBox).not.toBeNull();
      expect(commandPaletteBox).not.toBeNull();
      const incognitoCenterY = (incognitoBox?.y ?? 0) + (incognitoBox?.height ?? 0) / 2;
      const commandPaletteCenterY =
        (commandPaletteBox?.y ?? 0) + (commandPaletteBox?.height ?? 0) / 2;
      expect(Math.abs(Math.round(incognitoCenterY - commandPaletteCenterY))).toBeLessThanOrEqual(2);
      expect(incognitoBox?.x ?? 0).toBeGreaterThan((commandPaletteBox?.x ?? 0) + 100);
      expect(
        await page
          .locator(".new-session-page__composer")
          .getByRole("switch", { name: "Incognito" })
          .count(),
      ).toBe(0);
      const fastMode = page.locator(".new-session-page__composer [data-chat-speed-toggle]");
      expect(await fastMode.count()).toBe(1);
      expect(await fastMode.getAttribute("aria-checked")).toBe("false");
      expect(
        await fastMode.evaluate((element) =>
          element.classList.contains("chat-controls__speed-toggle"),
        ),
      ).toBe(true);
      expect(await incognitoToggle.getAttribute("aria-checked")).toBe("false");
      await incognitoToggle.click();
      await expect.poll(() => incognitoToggle.getAttribute("aria-checked")).toBe("true");
      await incognitoToggle.click();
      await expect.poll(() => incognitoToggle.getAttribute("aria-checked")).toBe("false");

      // Unified layout: the trigger row (menus above the composer) sits
      // inside the start-screen welcome, below the hero.
      const heroBox = await page.locator(".agent-chat__welcome h2").boundingBox();
      const triggersBox = await page.locator(".new-session-page__triggers").boundingBox();
      const composerBox = await page.locator(".new-session-page__composer").boundingBox();
      const modelBox = await page.locator('[data-chat-model-select="true"]').boundingBox();
      const modelWrapperBox = await page
        .locator(".new-session-page__composer .chat-composer-model-control")
        .boundingBox();
      const footerBox = await page
        .locator(".new-session-page__composer .agent-chat__composer-footer")
        .boundingBox();
      const actionsBox = await page
        .locator(".new-session-page__composer .agent-chat__composer-actions")
        .boundingBox();
      const attachmentButton = page.getByRole("button", { name: "Add attachment" });
      const attachmentBox = await attachmentButton.boundingBox();
      expect(heroBox).not.toBeNull();
      expect(triggersBox).not.toBeNull();
      expect(composerBox).not.toBeNull();
      expect(modelBox).not.toBeNull();
      expect(modelWrapperBox).not.toBeNull();
      expect(footerBox).not.toBeNull();
      expect(actionsBox).not.toBeNull();
      expect(attachmentBox).not.toBeNull();
      expect((heroBox?.y ?? 0) + (heroBox?.height ?? 0)).toBeLessThanOrEqual(
        (triggersBox?.y ?? 0) + 1,
      );
      expect((triggersBox?.y ?? 0) + (triggersBox?.height ?? 0)).toBeLessThanOrEqual(
        (composerBox?.y ?? 0) + 1,
      );
      expect(
        await page.locator(".new-session-page__composer .agent-chat__composer-footer").count(),
      ).toBe(1);
      expect(
        await page
          .locator('[data-chat-model-select="true"]')
          .evaluate((element) => element.closest(".agent-chat__composer-footer") != null),
      ).toBe(true);
      expect(
        await attachmentButton.evaluate(
          (element) => element.closest(".agent-chat__composer-footer") != null,
        ),
      ).toBe(true);
      expect(
        await attachmentButton.evaluate(
          (element) => element.closest(".agent-chat__composer-input-row") == null,
        ),
      ).toBe(true);
      expect(attachmentBox?.x ?? 0).toBeLessThan(modelWrapperBox?.x ?? 0);
      expect(modelWrapperBox?.x ?? 0).toBeGreaterThan(
        (footerBox?.x ?? 0) + (footerBox?.width ?? 0) / 2,
      );
      expect(
        (actionsBox?.x ?? 0) - ((modelWrapperBox?.x ?? 0) + (modelWrapperBox?.width ?? 0)),
      ).toBeLessThanOrEqual(12);
      expect((modelWrapperBox?.x ?? 0) + (modelWrapperBox?.width ?? 0)).toBeLessThanOrEqual(
        actionsBox?.x ?? 0,
      );
      expect((actionsBox?.x ?? 0) + (actionsBox?.width ?? 0)).toBeLessThanOrEqual(
        (footerBox?.x ?? 0) + (footerBox?.width ?? 0) + 1,
      );
      expect(triggersBox?.x).toBeCloseTo(composerBox?.x ?? 0, 0);
      expect(triggersBox?.width).toBeCloseTo(composerBox?.width ?? 0, 0);
      expect(composerBox?.width).toBeCloseTo(48 * 16, 0);
      expect(await page.locator(".new-session-page__message").getAttribute("rows")).toBe("1");
      await captureProjectUiProof(suite, page, "new-session-control-layout.png");

      await page.setViewportSize({ width: 393, height: 852 });
      const mobileModelSettings = page.locator(
        '.new-session-page__composer [data-chat-model-select="true"]',
      );
      const mobilePermission = page.locator(
        '.new-session-page__composer [data-chat-permission-select="true"]',
      );
      const mobilePermissionIcon = mobilePermission.locator(".chat-controls__permission-icon svg");
      const permissionIconCenterError = async () => {
        const [triggerBox, iconBox] = await Promise.all([
          mobilePermission.boundingBox(),
          mobilePermissionIcon.boundingBox(),
        ]);
        if (!triggerBox || !iconBox) {
          return Number.POSITIVE_INFINITY;
        }
        const x = iconBox.x + iconBox.width / 2 - (triggerBox.x + triggerBox.width / 2);
        const y = iconBox.y + iconBox.height / 2 - (triggerBox.y + triggerBox.height / 2);
        return Math.max(Math.abs(x), Math.abs(y));
      };
      await expect.poll(() => mobileModelSettings.isVisible()).toBe(true);
      await expect.poll(permissionIconCenterError).toBeLessThanOrEqual(1);
      const [mobileFooterBox, mobileModelSettingsBox] = await Promise.all([
        page.locator(".new-session-page__composer .agent-chat__composer-footer").boundingBox(),
        mobileModelSettings.boundingBox(),
      ]);
      expect(mobileFooterBox).not.toBeNull();
      expect(mobileModelSettingsBox).not.toBeNull();
      if (!mobileFooterBox || !mobileModelSettingsBox) {
        throw new Error("expected mobile new-session composer controls");
      }
      expect(mobileModelSettingsBox.width).toBeGreaterThanOrEqual(44);
      expect(mobileModelSettingsBox.height).toBeGreaterThanOrEqual(44);
      expect(mobileModelSettingsBox.x).toBeGreaterThanOrEqual(mobileFooterBox.x);
      expect(mobileModelSettingsBox.x + mobileModelSettingsBox.width).toBeLessThanOrEqual(
        mobileFooterBox.x + mobileFooterBox.width,
      );
      await captureProjectUiProof(suite, page, "mobile-new-session-idle.png");
      await mobilePermission.click();
      await page.locator('[data-chat-permission-option="workspace"]').click();
      await expect
        .poll(() => mobilePermission.getAttribute("data-chat-select-value"))
        .toBe("workspace");
      await mobilePermission.click();
      await expect
        .poll(() => page.locator(".chat-controls__permission-option").first().isVisible())
        .toBe(true);
      await captureProjectUiProof(suite, page, "mobile-new-session-permissions-open.png", {
        surface: page.locator('.chat-controls__permission-picker [part="menu"]'),
        content: [page.locator(".chat-controls__permission-option").first()],
      });
      await page.keyboard.press("Escape");
      await mobileModelSettings.click();
      await expect.poll(() => page.locator(".chat-controls__model-menu").isVisible()).toBe(true);
      await captureProjectUiProof(suite, page, "mobile-new-session-model-open.png", {
        surface: page.locator('.chat-controls__model-picker wa-popup [part="popup"]'),
        content: [page.locator("[data-chat-model-option]").first()],
      });
      expect(
        await page
          .locator(".chat-controls__model-menu")
          .getByText(/Effort|Fast mode/)
          .count(),
      ).toBe(0);
      await page.keyboard.press("Escape");
      await page.locator('[data-chat-thinking-select="true"]').click();
      await expect.poll(() => page.locator(".chat-controls__effort-menu").isVisible()).toBe(true);
      await captureProjectUiProof(suite, page, "mobile-new-session-effort-open.png", {
        surface: page.locator('.chat-controls__effort-picker wa-popup [part="popup"]'),
        content: [page.locator('[data-chat-thinking-slider="true"]')],
      });
      await page.keyboard.press("Escape");
      await page.setViewportSize({ width: 1280, height: 900 });

      const agentPicker = page.locator(".new-session-page__select--agent openclaw-agent-select");
      await agentPicker.locator(".agent-select__trigger").click();
      await pollLocatorText(agentPicker.locator(".agent-select__menu-title")).toBe("Agents");
      await captureProjectUiProof(suite, page, "new-session-agent-menu-label.png", {
        surface: agentPicker.locator('wa-dropdown [part="menu"]'),
        content: [agentPicker.locator(".agent-select__menu-title")],
      });
      await page.keyboard.press("Escape");

      const whereSelect = page.locator("wa-popover.new-session-page__where-popover");
      const whereTrigger = page.locator("#new-session-where-trigger");
      await whereTrigger.click();
      await pollLocatorText(whereSelect.locator(".new-session-page__menu-title").first()).toBe(
        "Environments",
      );
      await captureProjectUiProof(suite, page, "new-session-environment-menu-label.png", {
        surface: whereSelect.locator('wa-popup [part="popup"]'),
        content: [whereSelect.locator(".new-session-page__menu-title").first()],
      });
      await page.keyboard.press("Escape");

      const projectSelect = page.locator("wa-popover.new-session-page__project-popover");
      const projectTrigger = page.locator("#new-session-project-trigger");
      const checkoutSelect = page.locator("wa-popover.new-session-page__checkout-popover");
      const checkoutTrigger = page.locator("#new-session-checkout-trigger");
      await pollLocatorText(projectTrigger.locator(".new-session-page__trigger-label")).toBe(
        "openclaw",
      );

      // Browse from the workspace, descend one level, then adopt the folder.
      await projectTrigger.click();
      await pollLocatorText(projectSelect.locator(".new-session-page__menu-title").first()).toBe(
        "Projects",
      );
      await captureProjectUiProof(suite, page, "new-session-project-menu-label.png", {
        surface: projectSelect.locator('wa-popup [part="popup"]'),
        content: [projectSelect.getByRole("button", { name: "Browse folders" })],
      });
      await projectSelect.getByRole("button", { name: "Browse folders" }).click();
      await page.locator(".new-session-page__browser-entry", { hasText: "packages" }).click();
      await expect
        .poll(() => page.locator("input.new-session-page__browser-path").inputValue())
        .toBe(PICKED);
      await page.getByRole("button", { name: "Use this folder" }).click();

      // The adopted folder closes the menu and updates the trigger label.
      await expect.poll(() => projectSelect.getAttribute("open")).toBeNull();
      await expect
        .poll(() => page.evaluate(() => document.activeElement?.id))
        .toBe("new-session-project-trigger");
      await pollLocatorText(projectTrigger.locator(".new-session-page__trigger-label")).toBe(
        "packages",
      );

      // Git-backed custom folders stay direct until the user explicitly chooses isolation.
      await expect.poll(() => checkoutTrigger.getAttribute("data-worktree")).toBe("false");
      await pollLocatorText(checkoutTrigger.locator(".new-session-page__trigger-label")).toBe(
        "main",
      );
      await checkoutTrigger.click();
      await expect.poll(() => checkoutTrigger.getAttribute("aria-expanded")).toBe("true");
      await pollLocatorText(checkoutSelect.locator(".new-session-page__menu-title").first()).toBe(
        "Checkout",
      );
      await captureProjectUiProof(suite, page, "new-session-checkout-menu-label.png", {
        surface: checkoutSelect.locator('wa-popup [part="popup"]'),
        content: [checkoutSelect.locator(".new-session-page__menu-title").first()],
      });
      const currentCheckout = checkoutSelect.locator('[data-value="checkout"]');
      const worktreeItem = checkoutSelect.getByRole("button", {
        name: "New worktree Isolated copy of the repo",
        exact: true,
      });
      await expect.poll(() => currentCheckout.getAttribute("aria-pressed")).toBe("true");
      await expect.poll(() => worktreeItem.getAttribute("aria-pressed")).toBe("false");
      expect(await worktreeItem.isEnabled()).toBe(true);
      await worktreeItem.click();
      await expect.poll(() => checkoutTrigger.getAttribute("data-worktree")).toBe("true");
      await expect.poll(() => currentCheckout.getAttribute("aria-pressed")).toBe("false");
      await pollLocatorText(checkoutTrigger.locator(".new-session-page__trigger-label")).toBe(
        "New worktree from main",
      );
      await checkoutSelect.getByLabel("From").waitFor();
      await checkoutSelect.getByLabel("Name", { exact: true }).waitFor();
      await checkoutSelect
        .getByText("Creates branch openclaw/<name> in a separate checkout.", { exact: true })
        .waitFor();
      await page.keyboard.press("Escape");
      await expect.poll(() => checkoutTrigger.getAttribute("aria-expanded")).toBe("false");
      await expect
        .poll(() => page.evaluate(() => document.activeElement?.id))
        .toBe("new-session-checkout-trigger");

      // Pointer light-dismiss still retires the unified popover after its
      // asynchronous hide animation completes.
      await checkoutTrigger.click();
      const afterPointerHide = checkoutSelect.evaluate(
        (element) =>
          new Promise<void>((resolve) => {
            element.addEventListener("wa-after-hide", () => resolve(), { once: true });
          }),
      );
      await page.locator(".agent-chat__welcome h2").click();
      await afterPointerHide;
      await expect.poll(() => checkoutSelect.getAttribute("open")).toBeNull();

      const message = page.locator(".new-session-page__message");
      await message.fill("fix the flaky test");
      await page.getByRole("button", { name: "Start session" }).click();

      const createRequest = await gateway.waitForRequest("sessions.create");
      expect(createRequest.params).toMatchObject({
        agentId: "main",
        message: "fix the flaky test",
        worktree: true,
        worktreeBaseRef: "main",
        cwd: PICKED,
      });

      await expect
        .poll(() => new URL(page.url()).pathname)
        .toBe(controlUiSessionPath("agent:main:draft-e2e"));
    } finally {
      await context.close();
    }
  });

  it("selects a registered project and submits its id at write scope", async () => {
    const context = await suite.browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      ...(captureUiProofEnabled
        ? {
            recordVideo: {
              dir: path.join(suite.artifactDir, "project-registry"),
              size: { height: 900, width: 1280 },
            },
            viewport: { height: 900, width: 1280 },
          }
        : {}),
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      workspace: WORKSPACE,
      workspaceGit: true,
      featureMethods: [
        "chat.metadata",
        "chat.startup",
        "sessions.create",
        "sessions.dispatch",
        "projects.list",
        "environments.list",
        "worktrees.branches",
      ],
      methodResponses: {
        "projects.list": {
          projects: [
            {
              id: "workspace:main",
              displayName: "openclaw",
              repoRoot: WORKSPACE,
              source: "workspace",
              agentId: "main",
            },
            {
              id: "recorded-openclaw",
              displayName: "Recorded OpenClaw",
              repoRoot: "/recorded/openclaw",
              source: "registered",
            },
          ],
        },
        "environments.list": {
          environments: [],
          profiles: [],
        },
        "worktrees.branches": {
          branches: [{ kind: "local", name: "main" }],
          defaultBranch: "main",
          repositoryStatus: "git",
        },
        "sessions.create": { key: "agent:main:project-e2e" },
      },
    });

    try {
      await page.goto(`${suite.server.baseUrl}new`);
      await gateway.waitForRequest("projects.list");
      const trigger = page.locator("#new-session-project-trigger");
      const place = page.locator("wa-popover.new-session-page__project-popover");
      await trigger.click();
      await place.getByRole("button", { name: "Recorded OpenClaw", exact: true }).click();
      await pollLocatorText(trigger.locator(".new-session-page__trigger-label")).toBe(
        "Recorded OpenClaw",
      );
      expect(await trigger.getAttribute("data-project-id")).toBe("recorded-openclaw");
      await expect
        .poll(async () => (await gateway.getRequests("worktrees.branches")).at(-1)?.params)
        .toEqual({ repoRoot: "/recorded/openclaw", includeRepositoryStatus: true });

      await page.locator("#new-session-checkout-trigger").click();
      await page
        .locator("wa-popover.new-session-page__checkout-popover")
        .getByRole("button", { name: "New worktree Isolated copy of the repo", exact: true })
        .click();
      const checkout = page.locator("wa-popover.new-session-page__checkout-popover");
      await captureProjectUiProof(suite, page, "project-selected.png", {
        surface: checkout.locator('wa-popup [part="popup"]'),
        content: [checkout.getByLabel("From")],
      });
      await page.keyboard.press("Escape");
      await page.locator(".new-session-page__message").fill("inspect the project");
      await page.getByRole("button", { name: "Start session" }).click();

      const create = await gateway.waitForRequest("sessions.create");
      expect(create.params).toMatchObject({
        agentId: "main",
        message: "inspect the project",
        projectId: "recorded-openclaw",
        worktree: true,
        worktreeBaseRef: "main",
      });
      expect(create.params).not.toHaveProperty("cwd");
      expect(create.params).not.toHaveProperty("execNode");
    } finally {
      await context.close();
    }
  });

  it("filters folders live without reloading and opens the highlighted match", async () => {
    const context = await suite.browser.newContext({ locale: "en-US", serviceWorkers: "block" });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      workspace: WORKSPACE,
      workspaceGit: true,
      methodResponses: {
        "fs.listDir": {
          cases: [
            {
              match: { path: WORKSPACE },
              response: {
                path: WORKSPACE,
                home: WORKSPACE,
                entries: [
                  { name: "packages", path: PICKED },
                  { name: "tools", path: `${WORKSPACE}/tools` },
                  { name: ".git", path: `${WORKSPACE}/.git`, hidden: true },
                ],
              },
            },
            {
              match: { path: PICKED },
              response: { path: PICKED, parent: WORKSPACE, home: WORKSPACE, entries: [] },
            },
          ],
        },
      },
    });

    try {
      await page.goto(`${suite.server.baseUrl}new`);
      const place = page.locator("wa-popover.new-session-page__project-popover");
      await page.locator("#new-session-project-trigger").click();
      await place.getByRole("button", { name: "Browse folders" }).click();
      await gateway.waitForRequest("fs.listDir");
      const input = place.locator("input.new-session-page__browser-path");
      await expect.poll(() => input.inputValue()).toBe(WORKSPACE);
      const requestsBefore = await gateway.getRequests("fs.listDir");
      await input.fill(`${WORKSPACE}/pa`);
      await expect
        .poll(() => place.locator(".new-session-page__browser-entry").allTextContents())
        .toEqual([expect.stringMatching(/^\s*packages\s*$/)]);
      await page.screenshot({ path: path.join(suite.artifactDir, "folder-live-prefix.png") });
      expect(await gateway.getRequests("fs.listDir")).toHaveLength(requestsBefore.length);
      await input.press("Enter");
      await gateway.waitForRequest("fs.listDir", { match: { path: PICKED } });
      await expect.poll(() => input.inputValue()).toBe(PICKED);
      await input.fill(`${WORKSPACE}/zzz`);
      await place.getByText("No matching folders", { exact: true }).waitFor();
      await page.screenshot({ path: path.join(suite.artifactDir, "folder-live-no-matches.png") });
    } finally {
      await context.close();
    }
  });

  it("returns from the browse root to the place menu", async () => {
    const context = await suite.browser.newContext({ locale: "en-US", serviceWorkers: "block" });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      workspace: WORKSPACE,
      workspaceGit: true,
      methodResponses: {
        "fs.listDir": {
          path: WORKSPACE,
          home: WORKSPACE,
          entries: [],
        },
        "worktrees.branches": {
          branches: [{ kind: "local", name: "main" }],
          defaultBranch: "main",
          repositoryStatus: "git",
        },
      },
    });

    try {
      await page.goto(`${suite.server.baseUrl}new`);
      const trigger = page.locator("#new-session-project-trigger");
      const place = page.locator("wa-popover.new-session-page__project-popover");
      await trigger.click();
      await place.getByRole("button", { name: "Browse folders" }).click();
      await gateway.waitForRequest("fs.listDir");
      await place.getByRole("button", { name: "Parent folder" }).click();
      await place.getByRole("button", { name: "Browse folders" }).waitFor();
      expect(await place.getAttribute("open")).not.toBeNull();

      await place.getByRole("button", { name: "Browse folders" }).click();
      await page.locator("input.new-session-page__browser-path").press("Escape");
      await place.getByRole("button", { name: "Browse folders" }).waitFor();
      expect(await place.getAttribute("open")).not.toBeNull();
    } finally {
      await context.close();
    }
  });
});
