import { expect, it } from "vitest";
import {
  EXEC_ONLY_PICKED,
  NODE_HOME,
  NODE_PICKED,
  NODE_UNC,
  PICKED,
  WORKSPACE,
  captureProjectUiProof,
  captureUiProofEnabled,
  controlUiSessionPath,
  createNewSessionPageE2eSuite,
  createdSessionListResult,
  installMockGateway,
  pollLocatorText,
  prepareProjectUiProof,
  projectProofArtifactDir,
} from "./new-session-page.test-support.ts";

const suite = createNewSessionPageE2eSuite();

suite.define(() => {
  it("keeps the pre-submit draft on the composer and creates exactly one session", async () => {
    const context = await suite.browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
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
          ],
          defaultId: "main",
          mainKey: "main",
          scope: "agent",
        },
        "worktrees.branches": {
          branches: [{ kind: "local", name: "main" }],
          defaultBranch: "main",
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

      // Incognito is a page-level choice on the far end of the same top rail
      // as the shell controls, rather than an option inside the composer.
      const incognitoToggle = page.getByRole("switch", { name: "Incognito" });
      const incognitoBox = await incognitoToggle.boundingBox();
      const commandPaletteBox = await page
        .getByRole("button", { name: "Open command palette" })
        .boundingBox();
      expect(incognitoBox).not.toBeNull();
      expect(commandPaletteBox).not.toBeNull();
      expect(incognitoBox?.y).toBeCloseTo(commandPaletteBox?.y ?? 0, 0);
      expect(incognitoBox?.x ?? 0).toBeGreaterThan((commandPaletteBox?.x ?? 0) + 100);
      expect(await page.locator('.new-session-page__composer [role="switch"]').count()).toBe(0);
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
      const attachmentButton = page.getByRole("button", { name: "Add attachment" });
      const attachmentBox = await attachmentButton.boundingBox();
      expect(heroBox).not.toBeNull();
      expect(triggersBox).not.toBeNull();
      expect(composerBox).not.toBeNull();
      expect(modelBox).not.toBeNull();
      expect(modelWrapperBox).not.toBeNull();
      expect(footerBox).not.toBeNull();
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
        (footerBox?.x ?? 0) +
          (footerBox?.width ?? 0) -
          ((modelWrapperBox?.x ?? 0) + (modelWrapperBox?.width ?? 0)),
      ).toBeLessThanOrEqual(12);
      expect(triggersBox?.x).toBeCloseTo(composerBox?.x ?? 0, 0);
      expect(triggersBox?.width).toBeCloseTo(composerBox?.width ?? 0, 0);
      expect(composerBox?.width).toBeCloseTo(48 * 16, 0);
      expect(await page.locator(".new-session-page__message").getAttribute("rows")).toBe("1");
      await captureProjectUiProof(page, "new-session-control-layout.png");

      const projectSelect = page.locator("wa-popover.new-session-page__project-popover");
      const projectTrigger = page.locator("#new-session-project-trigger");
      const detailSelect = page.locator("wa-popover.new-session-page__detail-popover");
      const detailTrigger = page.locator("#new-session-detail-trigger");
      await pollLocatorText(projectTrigger.locator(".new-session-page__trigger-label")).toBe(
        "openclaw",
      );

      // Browse from the workspace, descend one level, then adopt the folder.
      await projectTrigger.click();
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
      await expect.poll(() => detailTrigger.getAttribute("data-worktree")).toBe("false");
      await detailTrigger.click();
      await expect.poll(() => detailTrigger.getAttribute("aria-expanded")).toBe("true");
      const worktreeItem = detailSelect.getByRole("button", { name: "Worktree" });
      await expect.poll(() => worktreeItem.getAttribute("aria-pressed")).toBe("false");
      expect(await worktreeItem.isEnabled()).toBe(true);
      await worktreeItem.click();
      await expect.poll(() => detailTrigger.getAttribute("data-worktree")).toBe("true");
      await page.keyboard.press("Escape");
      await expect.poll(() => detailTrigger.getAttribute("aria-expanded")).toBe("false");
      await expect
        .poll(() => page.evaluate(() => document.activeElement?.id))
        .toBe("new-session-detail-trigger");

      // Pointer light-dismiss still retires the unified popover after its
      // asynchronous hide animation completes.
      await detailTrigger.click();
      const afterPointerHide = detailSelect.evaluate(
        (element) =>
          new Promise<void>((resolve) => {
            element.addEventListener("wa-after-hide", () => resolve(), { once: true });
          }),
      );
      await page.locator(".agent-chat__welcome h2").click();
      await afterPointerHide;
      await expect.poll(() => detailSelect.getAttribute("open")).toBeNull();

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
    await prepareProjectUiProof();
    const context = await suite.browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      ...(captureUiProofEnabled
        ? {
            recordVideo: {
              dir: projectProofArtifactDir,
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
        "node.list",
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
        "node.list": {
          nodes: [
            {
              nodeId: "macbook",
              displayName: "MacBook",
              connected: true,
              commands: ["system.run", "fs.listDir"],
            },
          ],
        },
        "environments.list": {
          environments: [{ id: "node:macbook", type: "node", status: "available" }],
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
      const whereTrigger = page.locator("#new-session-where-trigger");
      const where = page.locator("wa-popover.new-session-page__where-popover");
      await whereTrigger.click();
      await expect.poll(() => whereTrigger.getAttribute("aria-expanded")).toBe("true");
      await where.getByRole("button", { name: "MacBook" }).click();
      await expect.poll(() => whereTrigger.getAttribute("aria-expanded")).toBe("false");
      await pollLocatorText(
        page.locator("#new-session-detail-trigger .new-session-page__trigger-label"),
      ).toBe("Node path");
      await expect
        .poll(() => page.evaluate(() => document.activeElement?.id))
        .toBe("new-session-where-trigger");
      await whereTrigger.click();
      await where.getByRole("button", { name: "Local" }).click();

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

      await page.locator("#new-session-detail-trigger").click();
      await page
        .locator("wa-popover.new-session-page__detail-popover")
        .getByRole("button", { name: "Worktree" })
        .click();
      await captureProjectUiProof(page, "project-selected.png");
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

  it("browses capable nodes and accepts manual paths for exec-only nodes", async () => {
    const context = await suite.browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
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
        "node.list": {
          nodes: [
            {
              nodeId: "macbook",
              displayName: "MacBook",
              connected: true,
              commands: ["system.run", "fs.listDir"],
            },
            {
              nodeId: "old-node",
              displayName: "Old node",
              connected: true,
              commands: ["system.run"],
            },
            {
              nodeId: "offline-node",
              displayName: "Offline node",
              connected: false,
              commands: ["system.run", "fs.listDir"],
            },
          ],
        },
        "fs.listDir": {
          cases: [
            {
              match: { nodeId: "macbook", path: NODE_UNC },
              response: {
                path: NODE_UNC,
                parent: "\\\\server\\share",
                home: "C:\\Users\\peter",
                entries: [],
              },
            },
            {
              match: { nodeId: "macbook", path: NODE_PICKED },
              response: {
                path: NODE_PICKED,
                parent: NODE_HOME,
                home: NODE_HOME,
                entries: [],
              },
            },
            {
              match: { nodeId: "macbook" },
              response: {
                path: NODE_HOME,
                home: NODE_HOME,
                entries: [{ name: "Projects", path: NODE_PICKED }],
              },
            },
          ],
        },
        "sessions.create": { key: "agent:main:node-draft-e2e" },
        "sessions.list": createdSessionListResult("agent:main:node-draft-e2e"),
      },
    });

    try {
      await page.goto(`${suite.server.baseUrl}new`);
      await page.locator(".new-session-page__message").waitFor();
      const whereSelect = page.locator("wa-popover.new-session-page__where-popover");
      const whereTrigger = page.locator("#new-session-where-trigger");
      const whereLabel = whereTrigger.locator(".new-session-page__trigger-label");
      const projectSelect = page.locator("wa-popover.new-session-page__project-popover");
      const projectTrigger = page.locator("#new-session-project-trigger");
      const projectLabel = projectTrigger.locator(".new-session-page__trigger-label");
      const detailSelect = page.locator("wa-popover.new-session-page__detail-popover");
      const detailTrigger = page.locator("#new-session-detail-trigger");
      const browserEntries = page.locator(".new-session-page__browser-list");

      // Pick the node from Your devices.
      await whereTrigger.click();
      await whereSelect.getByRole("button", { name: "MacBook" }).click();
      await pollLocatorText(whereLabel).toBe("MacBook");
      await pollLocatorText(detailTrigger.locator(".new-session-page__trigger-label")).toBe(
        "Node path",
      );
      await detailTrigger.click();
      expect(await detailSelect.getByRole("button", { name: "Worktree" }).count()).toBe(0);
      await detailSelect.getByLabel("Working directory").waitFor();
      await page.keyboard.press("Escape");

      // Manual path entry in the browser head preserves UNC paths; these
      // cannot be rediscovered by starting at the node home directory.
      await projectTrigger.click();
      await projectSelect.getByRole("button", { name: "Browse folders" }).click();
      const pathInput = page.locator("input.new-session-page__browser-path");
      await expect.poll(() => pathInput.inputValue()).toBe(NODE_HOME);
      await pathInput.fill(NODE_UNC);
      await pathInput.press("Enter");
      await expect.poll(() => pathInput.inputValue()).toBe(NODE_UNC);
      // Escape returns to the picker root without applying or closing it.
      await page.keyboard.press("Escape");
      await expect
        .poll(() =>
          projectSelect.evaluate((element) => (element as HTMLElement & { open: boolean }).open),
        )
        .toBe(true);
      await projectSelect.getByRole("button", { name: "Browse folders" }).waitFor();

      // Destination selection stays in Where; browsing remains fixed to the selected target.
      await page.keyboard.press("Escape");
      await whereTrigger.click();
      await whereSelect.getByRole("button", { name: "Local" }).click();
      await pollLocatorText(whereLabel).toBe("Local");
      await whereTrigger.click();
      expect(await whereSelect.getByRole("button", { name: "Offline node" }).count()).toBe(0);
      await whereSelect.getByRole("button", { name: "MacBook" }).click();
      await projectTrigger.click();
      await projectSelect.getByRole("button", { name: "Browse folders" }).click();
      await browserEntries.getByRole("button", { name: "Projects" }).click();
      await page.getByRole("button", { name: "Use this folder" }).click();

      // Using a node folder retargets the draft to that node.
      await pollLocatorText(whereLabel).toBe("MacBook");
      await pollLocatorText(projectLabel).toBe("Projects");

      // A node cwd belongs to the selected agent's draft and must not leak
      // across an agent change, even though the execution node stays selected.
      const agentPicker = page.locator(".new-session-page__select--agent openclaw-agent-select");
      await agentPicker.locator(".agent-select__trigger").click();
      await agentPicker
        .locator("wa-dropdown-item[data-agent-option]")
        .filter({ hasText: "Research" })
        .click();
      await page.getByRole("heading", { name: "Research" }).waitFor();
      await pollLocatorText(whereLabel).toBe("MacBook");
      await pollLocatorText(projectLabel).toBe("research");

      // Clearing the path applies the node's default directory (empty folder),
      // the state the replaced clearable folder textbox could express.
      await projectTrigger.click();
      await projectSelect.getByRole("button", { name: "Browse folders" }).click();
      await expect.poll(() => pathInput.inputValue()).toBe(NODE_HOME);
      await pathInput.fill("");
      await page.getByRole("button", { name: "Use this folder" }).click();
      await pollLocatorText(projectLabel).toBe("research");

      // Browse back to the custom folder, then retarget to the exec-only node
      // with a manual absolute path for the final create assertion.
      await projectTrigger.click();
      await projectSelect.getByRole("button", { name: "Browse folders" }).click();
      await browserEntries.getByRole("button", { name: "Projects" }).click();
      await page.getByRole("button", { name: "Use this folder" }).click();
      await pollLocatorText(projectLabel).toBe("Projects");

      await whereTrigger.click();
      await whereSelect.getByRole("button", { name: "Old node" }).click();
      await detailTrigger.click();
      const nodeCwd = detailSelect.getByLabel("Working directory");
      await expect.poll(() => nodeCwd.inputValue()).toBe("");
      await nodeCwd.fill(EXEC_ONLY_PICKED);
      await nodeCwd.press("Enter");
      expect(
        (await gateway.getRequests("fs.listDir")).filter(
          (request) => (request.params as { nodeId?: string } | undefined)?.nodeId === "old-node",
        ),
      ).toHaveLength(0);
      await page.keyboard.press("Escape");
      await pollLocatorText(whereLabel).toBe("Old node");
      await pollLocatorText(projectLabel).toBe("repo");

      await page.locator(".new-session-page__message").fill("inspect the remote checkout");
      await page.getByRole("button", { name: "Start session" }).click();
      const createRequest = await gateway.waitForRequest("sessions.create");
      expect(createRequest.params).toMatchObject({
        agentId: "research",
        message: "inspect the remote checkout",
        execNode: "old-node",
        cwd: EXEC_ONLY_PICKED,
      });
      expect(createRequest.params).not.toHaveProperty("worktree");
    } finally {
      await context.close();
    }
  });
});
