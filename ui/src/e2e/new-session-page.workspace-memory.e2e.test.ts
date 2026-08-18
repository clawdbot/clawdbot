import { gatewayOriginScope } from "@openclaw/gateway-client/browser";
import type { BrowserContextOptions, Page } from "playwright";
import { expect, it } from "vitest";
import {
  MOVED_WORKSPACE,
  PICKED,
  SESSION_LIST_DEFAULTS,
  TARGET_REPO,
  WORKSPACE,
  captureProjectUiProof,
  captureUiProof,
  captureUiProofEnabled,
  choosePackagesFolder,
  createNewSessionPageE2eSuite,
  installMockGateway,
  navigateInApp,
  pollLocatorText,
  projectProofArtifactDir,
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
  viewport: { height: 740, width: 364 },
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
  it("keeps rail privacy visible and reveals the mobile footer mode on hover or focus", async () => {
    await withNewSessionPage(MOBILE_CONTEXT, async (page) => {
      await installMockGateway(page, {
        models: [
          {
            id: "gpt-5.6-luna",
            name: "GPT 5.6 Luna",
            provider: "openai",
            contextWindow: 400_000,
          },
          {
            id: "claude-sonnet-4-6",
            name: "Claude Sonnet 4.6",
            provider: "anthropic",
            contextWindow: 200_000,
          },
        ],
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
        .toBe("1");
      await expect
        .poll(() => draft.evaluate((element) => getComputedStyle(element).opacity))
        .toBe("0");
      await footer.hover();
      await expect
        .poll(() => draft.evaluate((element) => getComputedStyle(element).opacity))
        .toBe("1");
      await page.mouse.move(0, 0);
      await expect
        .poll(() => draft.evaluate((element) => getComputedStyle(element).opacity))
        .toBe("0");
      await message.focus();
      await expect
        .poll(() => draft.evaluate((element) => getComputedStyle(element).opacity))
        .toBe("1");
      expect(
        await incognito.evaluate(
          (element) => element.closest(".new-session-page__incognito-rail") != null,
        ),
      ).toBe(true);

      const [footerBox, attachBox, draftBox, modelBox] = await Promise.all([
        footer.boundingBox(),
        attach.boundingBox(),
        draft.boundingBox(),
        model.boundingBox(),
      ]);
      expect(footerBox).not.toBeNull();
      expect(attachBox).not.toBeNull();
      expect(draftBox).not.toBeNull();
      expect(modelBox).not.toBeNull();
      expect((attachBox?.x ?? 0) + (attachBox?.width ?? 0)).toBeLessThanOrEqual(draftBox?.x ?? 0);
      for (const control of [attachBox, draftBox, modelBox]) {
        expect(control?.x ?? 0).toBeGreaterThanOrEqual(footerBox?.x ?? 0);
        expect((control?.x ?? 0) + (control?.width ?? 0)).toBeLessThanOrEqual(
          (footerBox?.x ?? 0) + (footerBox?.width ?? 0),
        );
      }
      // The new-session footer keeps flex (not the shared chat mobile grid), so
      // its transient mode switches can wrap before the model picker overflows.
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
      const modelMenu = page.locator(".chat-controls__model-menu");
      await expect.poll(() => modelMenu.isVisible()).toBe(true);
      const modelTriggerBox = await modelSelect.boundingBox();
      const modelMenuBox = await modelMenu.boundingBox();
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

  it("separates model shortcuts from numeric search input by focus", async () => {
    await withNewSessionPage(DESKTOP_CONTEXT, async (page) => {
      await installMockGateway(page, { models: MODELS });
      await page.goto(`${suite.server.baseUrl}new`);

      const modelSelect = page.locator('[data-chat-model-select="true"]');
      const picker = page.locator(".chat-controls__model-picker");
      const search = page.locator('[data-chat-model-search="true"]');
      const firstModel = page.locator('[data-chat-model-option="openai/gpt-5.5"]');
      const secondModel = page.locator('[data-chat-model-option="anthropic/claude-sonnet-4-6"]');

      await modelSelect.click();
      await expect.poll(() => picker.getAttribute("open")).toBe("");
      await expect
        .poll(() => modelSelect.evaluate((element) => element === document.activeElement))
        .toBe(true);
      const secondShortcut = secondModel.locator('[data-chat-model-shortcut-number="2"]');
      await expect.poll(() => secondShortcut.count()).toBe(1);
      const menuBoxBeforeFocus = await page.locator(".chat-controls__model-menu").boundingBox();
      const actionBoxBeforeFocus = await secondModel
        .locator(".chat-controls__model-option-action")
        .boundingBox();
      expect(menuBoxBeforeFocus).not.toBeNull();
      expect(actionBoxBeforeFocus).not.toBeNull();
      await expect
        .poll(() => secondShortcut.evaluate((element) => getComputedStyle(element).opacity))
        .toBe("1");

      await search.focus();
      await expect
        .poll(() => search.evaluate((element) => element === document.activeElement))
        .toBe(true);
      await expect
        .poll(() => secondShortcut.evaluate((element) => getComputedStyle(element).opacity))
        .toBe("0");
      expect(await page.locator(".chat-controls__model-menu").boundingBox()).toEqual(
        menuBoxBeforeFocus,
      );
      expect(
        await secondModel.locator(".chat-controls__model-option-action").boundingBox(),
      ).toEqual(actionBoxBeforeFocus);
      await search.press("1");
      await expect.poll(() => search.inputValue()).toBe("1");
      await expect.poll(() => picker.getAttribute("open")).toBe("");

      await search.fill("anthropic");
      await expect.poll(() => firstModel.isVisible()).toBe(false);
      await expect.poll(() => secondModel.isVisible()).toBe(true);
      await modelSelect.focus();
      const filteredShortcut = secondModel.locator('[data-chat-model-shortcut-number="1"]');
      await expect
        .poll(() => filteredShortcut.evaluate((element) => getComputedStyle(element).opacity))
        .toBe("1");
      await page.keyboard.press("1");
      await expect.poll(() => picker.getAttribute("open")).toBe(null);
      await expect.poll(() => modelSelect.textContent()).toContain("Claude Sonnet 4.6");
    });
  });

  it("keeps the effort label, slider stop, and create payload aligned after a model switch", async () => {
    await withNewSessionPage(DESKTOP_CONTEXT, async (page) => {
      const levels = (ids: string[]) => ids.map((id) => ({ id, label: id }));
      const kimiLevels = levels([
        "off",
        "minimal",
        "low",
        "medium",
        "high",
        "xhigh",
        "max",
        "ultra",
      ]);
      const gateway = await installMockGateway(page, {
        agentModel: "kimi/k3",
        models: [
          {
            id: "k3",
            name: "Kimi K3",
            provider: "kimi",
            reasoning: true,
            thinkingLevels: kimiLevels,
            thinkingDefault: "high",
          },
          {
            id: "gpt-5.6-sol",
            name: "GPT 5.6 Sol",
            provider: "openai",
            reasoning: true,
            thinkingLevels: levels(["off", "minimal", "low", "medium", "high", "xhigh", "max"]),
            thinkingDefault: "medium",
          },
        ],
        methodResponses: {
          "agents.list": {
            ...mainAgentList(),
            agents: [
              {
                id: "main",
                name: "Main",
                identity: { name: "Main" },
                model: { primary: "kimi/k3" },
                thinkingLevels: kimiLevels,
                thinkingDefault: "high",
              },
            ],
          },
          "sessions.create": { key: "agent:main:thinking-model-switch", runStarted: true },
        },
      });
      await page.goto(`${suite.server.baseUrl}new`);

      const effortSelect = page.locator('[data-chat-thinking-select="true"]');
      await effortSelect.click();
      const thinkingSlider = page.locator('[data-chat-thinking-slider="true"]');
      await thinkingSlider.evaluate((element) => {
        const input = element as HTMLInputElement;
        input.value = "5";
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
      });
      await expect.poll(() => effortSelect.getAttribute("data-chat-thinking-value")).toBe("xhigh");

      const modelSelect = page.locator('[data-chat-model-select="true"]');
      await modelSelect.click();
      await page.locator('[data-chat-model-option="openai/gpt-5.6-sol"]').click();
      await effortSelect.click();

      await expect
        .poll(() => thinkingSlider.getAttribute("data-chat-thinking-values"))
        .toBe("off,minimal,low,medium,high,xhigh,max");
      await expect.poll(() => thinkingSlider.inputValue()).toBe("5");
      expect(await thinkingSlider.getAttribute("max")).toBe("6");
      expect(await thinkingSlider.getAttribute("aria-valuetext")).toBe("Extra high");
      expect(
        Number.parseFloat(
          await thinkingSlider.evaluate((element) =>
            (element as HTMLElement).style.getPropertyValue("--reasoning-fill"),
          ),
        ),
      ).toBeCloseTo(83.33, 1);

      await effortSelect.click();
      await page.locator(".new-session-page__message").fill("keep the selected effort");
      await page.getByRole("button", { name: "Start session" }).click();
      const create = await gateway.waitForRequest("sessions.create");
      expect(create.params).toMatchObject({
        message: "keep the selected effort",
        model: "openai/gpt-5.6-sol",
        thinkingLevel: "xhigh",
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
      const placeTrigger = page.locator("#new-session-detail-trigger");
      const projectTrigger = page.locator("#new-session-project-trigger");
      await choosePackagesFolder(page);
      await placeTrigger.click();
      await page.getByRole("button", { name: "Worktree" }).click();
      await page.getByLabel("Base branch").fill("release/next");
      await page.getByLabel("Worktree name").fill("remembered-task");
      await page.keyboard.press("Escape");

      const modelSelect = page.locator('[data-chat-model-select="true"]');
      await modelSelect.click();
      await page.locator('[data-chat-model-option="anthropic/claude-sonnet-4-6"]').click();
      const effortSelect = page.locator('[data-chat-thinking-select="true"]');
      await effortSelect.click();
      const thinkingSlider = page.locator('[data-chat-thinking-slider="true"]');
      await expect.poll(() => thinkingSlider.isVisible()).toBe(true);
      await thinkingSlider.press("End");
      await expect.poll(() => effortSelect.getAttribute("data-chat-thinking-value")).toBe("high");

      await page.goto(`${suite.server.baseUrl}new`);
      await pollLocatorText(projectTrigger.locator(".new-session-page__trigger-label")).toBe(
        "packages",
      );
      await pollLocatorText(
        page.locator("#new-session-where-trigger .new-session-page__trigger-label"),
      ).toBe("Local");
      await expect.poll(() => placeTrigger.getAttribute("data-worktree")).toBe("true");
      await placeTrigger.click();
      await expect.poll(() => page.getByLabel("Base branch").inputValue()).toBe("release/next");
      await expect
        .poll(() => page.getByLabel("Worktree name").inputValue())
        .toBe("remembered-task");
      await page.keyboard.press("Escape");
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
      await expect.poll(async () => (await readMainPreference(page))?.worktree).toBe(false);
      await expect.poll(() => placeTrigger.count()).toBe(0);
    });
  });

  it("uses identity-scoped server recents without duplicating registered projects", async () => {
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
      presenceUsers: [{ self: true, id: "profile-alice", name: "Alice" }],
      featureMethods: [
        "chat.metadata",
        "chat.startup",
        "projects.list",
        "sessions.create",
        "users.prefs.get",
        "users.prefs.set",
      ],
      methodResponses: {
        "projects.list": {
          projects: [{ id: "registered", displayName: "Registered", source: "registered" }],
          recents: [
            { kind: "project", projectId: "registered", displayName: "Registered" },
            {
              kind: "folder",
              folder: `${WORKSPACE}/scratch`,
              displayName: "scratch",
            },
          ],
        },
        "sessions.list": {
          count: 1,
          defaults: SESSION_LIST_DEFAULTS,
          path: "",
          sessions: [
            { key: "agent:main:shared", kind: "direct", updatedAt: 99, execCwd: "/shared" },
          ],
          ts: Date.now(),
        },
        "sessions.create": { key: "agent:main:identity-project" },
        "users.prefs.get": { status: "ok", entries: {} },
        "users.prefs.set": { status: "ok" },
      },
    });

    try {
      await page.goto(`${suite.server.baseUrl}new`);
      const trigger = page.locator("#new-session-project-trigger");
      await trigger.click();
      expect(await page.locator('[data-value="recent::/shared"]').count()).toBe(0);
      expect(await page.locator('[data-value="recent-project:registered"]').count()).toBe(0);
      const project = page.locator('[data-value="project:registered"]');
      const recentFolder = page.locator(`[data-value="recent::${WORKSPACE}/scratch"]`);
      await project.waitFor();
      await recentFolder.waitFor();
      await captureProjectUiProof(page, "identity-project-recents-after.png");
      await project.click();
      await page.locator(".new-session-page__message").fill("continue registered work");
      await page.getByRole("button", { name: "Start session" }).click();
      const create = await gateway.waitForRequest("sessions.create");
      expect(create.params).toMatchObject({
        projectId: "registered",
        message: "continue registered work",
      });
    } finally {
      await context.close();
    }
  });

  it("migrates identity preferences once and mirrors gateway-first writes", async () => {
    await withNewSessionPage(
      {
        ...DESKTOP_CONTEXT,
        ...(captureUiProofEnabled
          ? {
              recordVideo: {
                dir: projectProofArtifactDir,
                size: { height: 900, width: 1280 },
              },
            }
          : {}),
      },
      async (page) => {
        const appUrl = new URL(suite.server.baseUrl);
        const gatewayUrl = `${appUrl.protocol === "https:" ? "wss:" : "ws:"}//${appUrl.host}`;
        const storageKey = `openclaw.new-session.preferences.v1:${gatewayOriginScope(gatewayUrl)}`;
        await page.addInitScript(
          ({ key, folder, workspace }) => {
            localStorage.setItem(
              key,
              JSON.stringify({
                agents: {
                  main: {
                    folder,
                    workspace,
                    worktree: true,
                    model: "anthropic/claude-sonnet-4-6",
                  },
                },
              }),
            );
          },
          { key: storageKey, folder: PICKED, workspace: WORKSPACE },
        );
        const gateway = await installMockGateway(page, {
          workspaceGit: true,
          models: MODELS,
          presenceUsers: [{ self: true, id: "profile-alice", name: "Alice" }],
          featureMethods: [
            "chat.metadata",
            "chat.startup",
            "fs.listDir",
            "projects.list",
            "sessions.create",
            "users.prefs.get",
            "users.prefs.set",
            "worktrees.branches",
          ],
          methodResponses: {
            "agents.list": mainAgentList(),
            "fs.listDir": FOLDER_LISTINGS,
            "projects.list": { projects: [], recents: [] },
            "users.prefs.get": {
              sequence: [
                { status: "ok", entries: {} },
                {
                  status: "ok",
                  entries: {
                    "new-session.migration.v1": true,
                    "new-session.v1:main": {
                      folder: PICKED,
                      workspace: WORKSPACE,
                      worktree: true,
                      model: "anthropic/claude-sonnet-4-6",
                    },
                  },
                },
              ],
            },
            "users.prefs.set": { status: "ok" },
            "worktrees.branches": GIT_BRANCHES,
          },
        });
        await page.goto(`${suite.server.baseUrl}new`);
        const migrated = await gateway.waitForRequest("users.prefs.set");
        expect(migrated.params).toMatchObject({
          entries: {
            "new-session.v1:main": {
              folder: PICKED,
              workspace: WORKSPACE,
              worktree: true,
              model: "anthropic/claude-sonnet-4-6",
            },
          },
        });
        const trigger = page.locator("#new-session-project-trigger");
        const detailTrigger = page.locator("#new-session-detail-trigger");
        await pollLocatorText(trigger.locator(".new-session-page__trigger-label")).toBe("packages");
        await expect.poll(() => detailTrigger.getAttribute("data-worktree")).toBe("true");
        await captureProjectUiProof(page, "identity-preferences-migrated.png");

        await navigateInApp(page, "chat");
        await waitForCommittedChatRoute(page);
        await navigateInApp(page, "new-session");
        await expect
          .poll(async () => (await gateway.getRequests("users.prefs.get")).length)
          .toBe(2);
        await expect
          .poll(async () => (await gateway.getRequests("users.prefs.set")).length)
          .toBe(1);

        await gateway.deferNext("users.prefs.set");
        const modelSelect = page.locator('[data-chat-model-select="true"]');
        await modelSelect.click();
        await page.locator('[data-chat-model-option="openai/gpt-5.5"]').click();
        await expect
          .poll(async () => (await gateway.getRequests("users.prefs.set")).length)
          .toBe(2);
        expect((await gateway.getRequests("users.prefs.set")).at(-1)?.params).toMatchObject({
          entries: { "new-session.v1:main": { model: "" } },
        });
        expect((await readMainPreference(page))?.model).toBe("anthropic/claude-sonnet-4-6");
        await gateway.resolveDeferred("users.prefs.set", { status: "ok" });
        await expect.poll(async () => (await readMainPreference(page))?.model).toBeUndefined();
      },
    );
  });

  it("resumes a partial multi-batch identity preference migration", async () => {
    await withNewSessionPage(BASE_CONTEXT, async (page) => {
      const appUrl = new URL(suite.server.baseUrl);
      const gatewayUrl = `${appUrl.protocol === "https:" ? "wss:" : "ws:"}//${appUrl.host}`;
      const storageKey = `openclaw.new-session.preferences.v1:${gatewayOriginScope(gatewayUrl)}`;
      const agentIds = ["main", ...Array.from({ length: 32 }, (_, index) => `agent${index + 1}`)];
      const browserAgents = Object.fromEntries(
        agentIds.map((agentId) => [agentId, { workspace: WORKSPACE, folder: WORKSPACE }]),
      );
      const remoteEntries = Object.fromEntries(
        agentIds
          .slice(0, 32)
          .map((agentId) => [`new-session.v1:${agentId}`, browserAgents[agentId]]),
      );
      await page.addInitScript(
        ({ key, agents }) => {
          localStorage.setItem(key, JSON.stringify({ agents }));
        },
        { key: storageKey, agents: browserAgents },
      );
      const gateway = await installMockGateway(page, {
        presenceUsers: [{ self: true, id: "profile-alice", name: "Alice" }],
        featureMethods: [
          "chat.metadata",
          "chat.startup",
          "sessions.create",
          "users.prefs.get",
          "users.prefs.set",
        ],
        methodResponses: {
          "agents.list": mainAgentList(),
          "users.prefs.get": { status: "ok", entries: remoteEntries },
          "users.prefs.set": { status: "ok" },
        },
      });

      await page.goto(`${suite.server.baseUrl}new`);
      const resumed = await gateway.waitForRequest("users.prefs.set");
      expect(resumed.params).toEqual({
        entries: {
          "new-session.v1:agent32": { workspace: WORKSPACE, folder: WORKSPACE },
          "new-session.migration.v1": true,
        },
      });
      await expect.poll(async () => (await gateway.getRequests("users.prefs.set")).length).toBe(1);
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
      const placeTrigger = page.locator("#new-session-detail-trigger");
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
      await expect.poll(() => placeTrigger.count()).toBe(0);
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
      const placeTrigger = page.locator("#new-session-project-trigger");
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
      const placeTrigger = page.locator("#new-session-project-trigger");
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
      await expect
        .poll(() => page.locator("#new-session-detail-trigger").getAttribute("data-worktree"))
        .toBe("false");
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

      const placeTrigger = page.locator("#new-session-project-trigger");
      await placeTrigger.click();
      await page
        .locator('wa-popover.new-session-page__project-popover [data-value="workspace"]')
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
      const trigger = page.locator("#new-session-project-trigger");
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
