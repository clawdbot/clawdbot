import type { BrowserContextOptions, Page } from "playwright";
import { expect, it } from "vitest";
import {
  MOVED_WORKSPACE,
  PICKED,
  TARGET_REPO,
  WORKSPACE,
  captureUiProof,
  choosePackagesFolder,
  createNewSessionPageE2eSuite,
  installMockGateway,
  navigateInApp,
  pollLocatorText,
  waitForCommittedChatRoute,
} from "./new-session-page.test-support.ts";

const suite = createNewSessionPageE2eSuite();
const BASE_CONTEXT: BrowserContextOptions = { locale: "en-US", serviceWorkers: "block" };
const DESKTOP_CONTEXT: BrowserContextOptions = {
  ...BASE_CONTEXT,
  viewport: { height: 900, width: 1280 },
};
const MOBILE_CONTEXT: BrowserContextOptions = {
  ...BASE_CONTEXT,
  viewport: { height: 568, width: 320 },
};
const MODELS = [
  { id: "gpt-5.5", name: "GPT 5.5", provider: "openai" },
  { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", provider: "anthropic" },
];
const GIT_BRANCHES = {
  branches: [{ kind: "local", name: "main" }],
  defaultBranch: "main",
  repositoryStatus: "git",
};
const FOLDER_LISTINGS = {
  cases: [
    {
      match: { path: WORKSPACE },
      response: {
        path: WORKSPACE,
        parent: "/home/peter",
        home: "/home/peter",
        entries: [{ name: "packages", path: PICKED }],
      },
    },
    {
      match: { path: PICKED },
      response: { path: PICKED, parent: WORKSPACE, home: "/home/peter", entries: [] },
    },
  ],
};

function mainAgentList(workspace = WORKSPACE, workspaceGit = true) {
  return {
    agents: [
      {
        id: "main",
        identity: { name: "Main" },
        name: "Main",
        workspace,
        workspaceGit,
      },
    ],
    defaultId: "main",
    mainKey: "main",
    scope: "agent",
  };
}

async function readMainPreference(page: Page): Promise<Record<string, unknown> | null> {
  return page.evaluate(() => {
    const key = Array.from({ length: localStorage.length }, (_, index) =>
      localStorage.key(index),
    ).find((candidate) => candidate?.startsWith("openclaw.new-session.preferences.v1:"));
    const value = key
      ? (JSON.parse(localStorage.getItem(key) ?? "null") as {
          agents?: Record<string, Record<string, unknown>>;
        } | null)
      : null;
    return value?.agents?.main ?? null;
  });
}

async function withNewSessionPage(
  options: BrowserContextOptions,
  run: (page: Page) => Promise<void>,
): Promise<void> {
  const context = await suite.browser.newContext(options);
  try {
    await run(await context.newPage());
  } finally {
    await context.close();
  }
}

suite.define(() => {
  it("keeps the mobile footer controls separated and reveals session modes on hover or focus", async () => {
    await withNewSessionPage(MOBILE_CONTEXT, async (page) => {
      await installMockGateway(page, {
        models: [{ id: "gpt-5.6-sol", name: "GPT 5.6 Sol", provider: "openai" }],
        hasMultipleSessionSharingIdentities: true,
      });
      await page.goto(`${suite.server.baseUrl}new`);
      const footer = page.locator(".new-session-page__composer .agent-chat__composer-footer");
      const attach = page.getByRole("button", { name: "Add attachment" });
      const takePhoto = page.getByRole("menuitem", { name: "Take photo" });
      const draft = page.getByRole("switch", { name: "Draft" });
      const incognito = page.getByRole("switch", { name: "Incognito" });
      const model = page.locator(".new-session-page__composer .chat-composer-model-control");
      const message = page.locator(".new-session-page__message");
      await Promise.all([
        footer.waitFor(),
        attach.waitFor(),
        draft.waitFor({ state: "attached" }),
        incognito.waitFor(),
        model.waitFor(),
      ]);

      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
      await page.mouse.move(0, 0);
      await expect
        .poll(() => incognito.evaluate((element) => getComputedStyle(element).opacity))
        .toBe("0");
      await footer.hover();
      await expect
        .poll(() => incognito.evaluate((element) => getComputedStyle(element).opacity))
        .toBe("1");
      await page.mouse.move(0, 0);
      await expect
        .poll(() => incognito.evaluate((element) => getComputedStyle(element).opacity))
        .toBe("0");
      await message.focus();
      await expect
        .poll(() => incognito.evaluate((element) => getComputedStyle(element).opacity))
        .toBe("1");

      const [footerBox, attachBox, draftBox, incognitoBox, modelBox] = await Promise.all([
        footer.boundingBox(),
        attach.boundingBox(),
        draft.boundingBox(),
        incognito.boundingBox(),
        model.boundingBox(),
      ]);
      expect(footerBox).not.toBeNull();
      expect(attachBox).not.toBeNull();
      expect(draftBox).not.toBeNull();
      expect(incognitoBox).not.toBeNull();
      expect(modelBox).not.toBeNull();
      expect((attachBox?.x ?? 0) + (attachBox?.width ?? 0)).toBeLessThanOrEqual(draftBox?.x ?? 0);
      expect((draftBox?.x ?? 0) + (draftBox?.width ?? 0)).toBeLessThanOrEqual(incognitoBox?.x ?? 0);
      expect((incognitoBox?.x ?? 0) + (incognitoBox?.width ?? 0)).toBeLessThanOrEqual(
        modelBox?.x ?? 0,
      );
      for (const control of [attachBox, draftBox, incognitoBox, modelBox]) {
        expect(control?.x ?? 0).toBeGreaterThanOrEqual(footerBox?.x ?? 0);
        expect((control?.x ?? 0) + (control?.width ?? 0)).toBeLessThanOrEqual(
          (footerBox?.x ?? 0) + (footerBox?.width ?? 0),
        );
      }
      // The new-session footer keeps flex (not the shared chat mobile grid), so
      // all four controls share one 320px row; wrap or overflow here means the
      // new-session.css mobile override regressed.
      const controlsOverflow = await footer.evaluate(
        (element) => element.scrollWidth - element.clientWidth,
      );
      expect(controlsOverflow).toBe(0);

      await attach.click();
      await expect.poll(() => takePhoto.isVisible()).toBe(true);
      await page.keyboard.press("Escape");
      await incognito.click();
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
      await page.mouse.move(0, 0);
      await expect
        .poll(() => incognito.evaluate((element) => getComputedStyle(element).opacity))
        .toBe("1");
    });
  });

  it("selects the model for a plain new session", async () => {
    await withNewSessionPage(DESKTOP_CONTEXT, async (page) => {
      const gateway = await installMockGateway(page, {
        models: MODELS,
        methodResponses: {
          "sessions.create": { key: "agent:main:model-draft", runStarted: true },
        },
      });
      await page.goto(`${suite.server.baseUrl}new`);
      const modelSelect = page.locator('[data-chat-model-select="true"]');
      await modelSelect.waitFor();
      expect(
        await page.locator('.new-session-page__composer [data-chat-model-select="true"]').count(),
      ).toBe(1);
      expect(
        await page.locator('.new-session-page__triggers [data-chat-model-select="true"]').count(),
      ).toBe(0);
      await modelSelect.click();
      const pickerOpen = () =>
        modelSelect.evaluate(
          (element) => element.closest("details")?.hasAttribute("open") ?? false,
        );
      const modelTriggerBox = await modelSelect.boundingBox();
      const modelMenuBox = await page.locator(".chat-controls__model-menu").boundingBox();
      expect(modelTriggerBox).not.toBeNull();
      expect(modelMenuBox).not.toBeNull();
      expect(modelMenuBox?.x ?? 0).toBeLessThanOrEqual(modelTriggerBox?.x ?? 0);
      expect((modelMenuBox?.x ?? 0) + (modelMenuBox?.width ?? 0)).toBeLessThanOrEqual(
        await page.evaluate(() => window.innerWidth),
      );
      await expect.poll(pickerOpen).toBe(true);
      await page.locator('[data-chat-model-option="anthropic/claude-sonnet-4-6"]').click();
      // Model selection commits immediately and closes the model popover.
      await expect.poll(pickerOpen).toBe(false);
      await expect
        .poll(() => modelSelect.evaluate((element) => element === document.activeElement))
        .toBe(true);
      await modelSelect.click();
      await expect.poll(pickerOpen).toBe(true);
      await page.mouse.click(8, 8);
      await expect.poll(pickerOpen).toBe(false);
      await page.locator(".new-session-page__message").fill("use this model");
      await page.getByRole("button", { name: "Start session" }).click();

      const create = await gateway.waitForRequest("sessions.create");
      expect(create.params).toMatchObject({
        message: "use this model",
        model: "anthropic/claude-sonnet-4-6",
      });
    });
  });

  it("restores valid preferences and repairs a worktree rejected by workspace metadata", async () => {
    await withNewSessionPage(DESKTOP_CONTEXT, async (page) => {
      const gateway = await installMockGateway(page, {
        workspaceGit: true,
        models: MODELS,
        methodResponses: {
          "agents.list": mainAgentList(),
          "worktrees.branches": GIT_BRANCHES,
          "fs.listDir": FOLDER_LISTINGS,
        },
      });
      await page.goto(`${suite.server.baseUrl}new`);
      const placeTrigger = page.locator("#new-session-place-trigger");
      await choosePackagesFolder(page);
      await placeTrigger.click();
      await page.getByRole("button", { name: "Worktree" }).click();
      await page.keyboard.press("Escape");

      const modelSelect = page.locator('[data-chat-model-select="true"]');
      await modelSelect.click();
      await page.locator('[data-chat-model-option="anthropic/claude-sonnet-4-6"]').click();
      const effortSelect = page.locator('[data-chat-thinking-select="true"]');
      await effortSelect.click();
      const thinkingSlider = page.locator('[data-chat-thinking-slider="true"]');
      await thinkingSlider.press("End");
      await expect.poll(() => effortSelect.getAttribute("data-chat-thinking-value")).toBe("high");

      await page.goto(`${suite.server.baseUrl}new`);
      await pollLocatorText(placeTrigger.locator(".new-session-page__trigger-label")).toBe(
        "packages",
      );
      await expect.poll(() => placeTrigger.getAttribute("data-worktree")).toBe("true");
      await expect
        .poll(() => modelSelect.getAttribute("data-chat-select-value"))
        .toBe("anthropic/claude-sonnet-4-6");
      await expect.poll(() => effortSelect.getAttribute("data-chat-thinking-value")).toBe("high");
      await captureUiProof(page, "new-session-preferences-restored.png");

      const branchRequests = await gateway.getRequests("worktrees.branches");
      expect(branchRequests.at(-1)?.params).toMatchObject({ repoRoot: PICKED });

      await page.evaluate((workspace) => {
        const key = Array.from({ length: localStorage.length }, (_, index) =>
          localStorage.key(index),
        ).find((candidate) => candidate?.startsWith("openclaw.new-session.preferences.v1:"));
        if (!key) {
          throw new Error("missing new-session preference");
        }
        const value = JSON.parse(localStorage.getItem(key) ?? "null") as {
          agents?: Record<string, { folder?: string; workspace?: string }>;
        };
        const main = value.agents?.main;
        if (!main) {
          throw new Error("missing main-agent preference");
        }
        main.folder = workspace;
        main.workspace = workspace;
        localStorage.setItem(key, JSON.stringify(value));
      }, WORKSPACE);
      await gateway.setMethodResponse("agents.list", mainAgentList(WORKSPACE, false));
      await page.reload();
      await expect.poll(() => placeTrigger.getAttribute("data-worktree")).toBe("false");
      const storedWorktree = (await readMainPreference(page))?.worktree;
      expect(storedWorktree).toBe(false);
    });
  });

  it("blocks an immediate submit until remembered model and worktree choices validate", async () => {
    await withNewSessionPage(BASE_CONTEXT, async (page) => {
      const models = MODELS;
      const branches = GIT_BRANCHES;
      const gateway = await installMockGateway(page, {
        workspaceGit: true,
        models,
        methodResponses: {
          "agents.list": mainAgentList(),
          "worktrees.branches": branches,
          "fs.listDir": FOLDER_LISTINGS,
          "sessions.create": { key: "agent:main:restored-fast-submit", runStarted: true },
        },
      });
      await page.goto(`${suite.server.baseUrl}new`);
      await choosePackagesFolder(page);
      const placeTrigger = page.locator("#new-session-place-trigger");
      await placeTrigger.click();
      await page.getByRole("button", { name: "Worktree" }).click();
      await page.keyboard.press("Escape");
      const modelSelect = page.locator('[data-chat-model-select="true"]');
      await modelSelect.click();
      await page.locator('[data-chat-model-option="anthropic/claude-sonnet-4-6"]').click();

      await navigateInApp(page, "chat");
      await waitForCommittedChatRoute(page);
      const metadataRequests = (await gateway.getRequests("chat.metadata")).length;
      const branchRequests = (await gateway.getRequests("worktrees.branches")).length;
      await gateway.deferNext("chat.metadata");
      await gateway.deferNext("worktrees.branches");
      await navigateInApp(page, "new-session");
      await expect.poll(() => new URL(page.url()).pathname).toBe("/new");
      await expect
        .poll(async () => (await gateway.getRequests("chat.metadata")).length)
        .toBe(metadataRequests + 1);
      await expect
        .poll(async () => (await gateway.getRequests("worktrees.branches")).length)
        .toBe(branchRequests + 1);

      await page.locator(".new-session-page__message").fill("keep both remembered choices");
      const start = page.getByRole("button", { name: "Start session" });
      await expect.poll(() => start.isDisabled()).toBe(true);

      await gateway.resolveDeferred("chat.metadata", { models });
      await expect.poll(() => start.isDisabled()).toBe(true);
      await gateway.rejectDeferred("worktrees.branches", {
        code: "UNAVAILABLE",
        message: "branch lookup unavailable",
      });
      // A failed lookup disables the worktree toggle, so restoring the stored
      // choice would strand the draft behind a control the user cannot clear.
      // The draft drops it and stays submittable; storage keeps the preference.
      await expect.poll(() => placeTrigger.getAttribute("data-worktree")).toBe("false");
      await expect.poll(() => start.isDisabled()).toBe(false);

      await page.reload();
      await page.locator(".new-session-page__message").fill("keep both remembered choices");
      await expect
        .poll(() => modelSelect.getAttribute("data-chat-select-value"))
        .toBe("anthropic/claude-sonnet-4-6");
      await expect.poll(() => placeTrigger.getAttribute("data-worktree")).toBe("true");
      await expect.poll(() => start.isDisabled()).toBe(false);
      await start.click();

      const create = await gateway.waitForRequest("sessions.create");
      expect(create.params).toMatchObject({
        cwd: PICKED,
        message: "keep both remembered choices",
        model: "anthropic/claude-sonnet-4-6",
        worktree: true,
      });
    });
  });

  it("repairs a remembered default folder when the agent workspace moves", async () => {
    await withNewSessionPage(BASE_CONTEXT, async (page) => {
      const gateway = await installMockGateway(page, {
        workspaceGit: true,
        models: MODELS,
        methodResponses: {
          "agents.list": mainAgentList(),
          "worktrees.branches": GIT_BRANCHES,
          "fs.listDir": {
            path: WORKSPACE,
            parent: "/home/peter",
            home: "/home/peter",
            entries: [],
          },
        },
      });
      await page.goto(`${suite.server.baseUrl}new`);
      const placeTrigger = page.locator("#new-session-place-trigger");
      await placeTrigger.click();
      await page.getByRole("button", { name: "Browse folders" }).click();
      await page.getByRole("button", { name: "Use this folder" }).click();
      await navigateInApp(page, "chat");
      await page.waitForURL((url) => url.pathname.endsWith("/chat"));

      await gateway.setMethodResponse("agents.list", mainAgentList(MOVED_WORKSPACE));
      await page.reload();
      await navigateInApp(page, "new-session");
      await pollLocatorText(placeTrigger.locator(".new-session-page__trigger-label")).toBe(
        "openclaw-next",
      );

      const modelSelect = page.locator('[data-chat-model-select="true"]');
      await modelSelect.click();
      await page.locator('[data-chat-model-option="anthropic/claude-sonnet-4-6"]').click();
      const storedPreference = await readMainPreference(page);
      expect(storedPreference).toMatchObject({
        workspace: MOVED_WORKSPACE,
        folder: MOVED_WORKSPACE,
        model: "anthropic/claude-sonnet-4-6",
      });
    });
  });

  it("falls back to the current workspace when the remembered folder is gone", async () => {
    await withNewSessionPage(BASE_CONTEXT, async (page) => {
      const gateway = await installMockGateway(page, {
        workspace: WORKSPACE,
        workspaceGit: true,
        operatorScopes: ["operator.read", "operator.write"],
        featureMethods: [
          "chat.metadata",
          "chat.startup",
          "fs.listDir",
          "sessions.create",
          "worktrees.branches",
        ],
        methodResponses: {
          "agents.list": mainAgentList(),
          "worktrees.branches": GIT_BRANCHES,
          "fs.listDir": FOLDER_LISTINGS,
          "sessions.create": { key: "agent:main:stale-folder-fallback", runStarted: true },
        },
      });
      await page.goto(`${suite.server.baseUrl}new`);
      await choosePackagesFolder(page);

      await navigateInApp(page, "chat");
      await waitForCommittedChatRoute(page);
      const validationRequests = (await gateway.getRequests("fs.listDir")).length;
      await gateway.deferNext("fs.listDir");
      await navigateInApp(page, "new-session");
      await expect
        .poll(async () => (await gateway.getRequests("fs.listDir")).length)
        .toBeGreaterThan(validationRequests);
      const message = page.locator(".new-session-page__message");
      await message.fill("use a safe folder");
      await expect
        .poll(() => page.getByRole("button", { name: "Start session" }).isDisabled())
        .toBe(true);

      await gateway.rejectDeferred("fs.listDir", {
        code: "INVALID_REQUEST",
        message: `Error: ENOENT: no such file or directory, scandir '${PICKED}'`,
      });
      const placeTrigger = page.locator("#new-session-place-trigger");
      await pollLocatorText(placeTrigger.locator(".new-session-page__trigger-label")).toBe(
        "openclaw",
      );

      const pickedListRequests = (await gateway.getRequests("fs.listDir")).filter(
        (request) =>
          typeof request.params === "object" &&
          request.params != null &&
          "path" in request.params &&
          request.params.path === PICKED,
      ).length;
      await navigateInApp(page, "chat");
      await waitForCommittedChatRoute(page);
      await navigateInApp(page, "new-session");
      await pollLocatorText(placeTrigger.locator(".new-session-page__trigger-label")).toBe(
        "openclaw",
      );
      await expect.poll(() => placeTrigger.getAttribute("data-worktree")).toBe("false");
      await expect
        .poll(
          async () =>
            (await gateway.getRequests("fs.listDir")).filter(
              (request) =>
                typeof request.params === "object" &&
                request.params != null &&
                "path" in request.params &&
                request.params.path === PICKED,
            ).length,
        )
        .toBe(pickedListRequests);

      await message.fill("use the repaired preference");
      await expect
        .poll(() => page.getByRole("button", { name: "Start session" }).isDisabled())
        .toBe(false);
      await page.getByRole("button", { name: "Start session" }).click();
      const create = await gateway.waitForRequest("sessions.create");
      expect(create.params).not.toHaveProperty("cwd");
    });
  });

  it("keeps a newer folder choice when remembered-folder validation finishes late", async () => {
    await withNewSessionPage(BASE_CONTEXT, async (page) => {
      const gateway = await installMockGateway(page, {
        workspace: WORKSPACE,
        workspaceGit: true,
        methodResponses: {
          "agents.list": mainAgentList(),
          "worktrees.branches": GIT_BRANCHES,
          "fs.listDir": FOLDER_LISTINGS,
          "sessions.create": { key: "agent:main:newer-folder-wins", runStarted: true },
        },
      });
      await page.goto(`${suite.server.baseUrl}new`);
      await choosePackagesFolder(page);

      await navigateInApp(page, "chat");
      await waitForCommittedChatRoute(page);
      const validationRequests = (await gateway.getRequests("fs.listDir")).length;
      await gateway.deferNext("fs.listDir");
      await navigateInApp(page, "new-session");
      await expect
        .poll(async () => (await gateway.getRequests("fs.listDir")).length)
        .toBeGreaterThan(validationRequests);

      const placeTrigger = page.locator("#new-session-place-trigger");
      await placeTrigger.click();
      await page
        .locator('wa-popover.new-session-page__place-popover [data-value="workspace"]')
        .click();
      await gateway.resolveDeferred("fs.listDir", {
        path: PICKED,
        parent: WORKSPACE,
        home: "/home/peter",
        entries: [],
      });
      await pollLocatorText(placeTrigger.locator(".new-session-page__trigger-label")).toBe(
        "openclaw",
      );

      await page.locator(".new-session-page__message").fill("keep the newer choice");
      await page.getByRole("button", { name: "Start session" }).click();
      const create = await gateway.waitForRequest("sessions.create");
      expect(create.params).not.toHaveProperty("cwd");
    });
  });

  it("keeps a folder chosen before the agent roster finishes loading submit-ready", async () => {
    await withNewSessionPage(BASE_CONTEXT, async (page) => {
      const gateway = await installMockGateway(page, {
        deferredMethods: ["agents.list"],
        workspaceGit: true,
        methodResponses: {
          "agents.list": mainAgentList(),
          "fs.listDir": { path: TARGET_REPO, home: "/home/peter", entries: [] },
          "worktrees.branches": GIT_BRANCHES,
        },
      });
      await page.goto(`${suite.server.baseUrl}new`);
      const trigger = page.locator("#new-session-place-trigger");
      await trigger.click();
      await page.getByRole("button", { name: "Browse folders" }).click();
      const browserPath = page.locator("input.new-session-page__browser-path");
      // Resolve the browser listing without resolving the deferred agent roster;
      // otherwise its initial path update can race Playwright's folder input.
      await expect.poll(() => browserPath.inputValue()).toBe(TARGET_REPO);
      await browserPath.fill(TARGET_REPO);
      await page.getByRole("button", { name: "Use this folder" }).click();
      await gateway.resolveDeferred("agents.list", mainAgentList());

      await page.locator(".new-session-page__message").fill("keep my early folder choice");
      await expect
        .poll(() => page.getByRole("button", { name: "Start session" }).isDisabled())
        .toBe(false);
      await pollLocatorText(trigger.locator(".new-session-page__trigger-label")).toContain(
        "target-repo",
      );
      const storedPreference = await readMainPreference(page);
      expect(storedPreference).toMatchObject({ folder: TARGET_REPO });
    });
  });
});
