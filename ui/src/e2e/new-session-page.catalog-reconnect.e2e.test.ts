import { expect, it } from "vitest";
import {
  REFRESHED_RESEARCH_WORKSPACE,
  SESSION_LIST_DEFAULTS,
  WORKSPACE,
  controlUiSessionPath,
  createNewSessionPageE2eSuite,
  installMockGateway,
  pollLocatorText,
} from "./new-session-page.test-support.ts";

const suite = createNewSessionPageE2eSuite();

suite.define(() => {
  it("shows metadata failure truthfully and recovers the full catalog on retry", async () => {
    const context = await suite.browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const models = [
      {
        available: true,
        id: "gpt-5.6-luna",
        name: "GPT-5.6 Luna",
        provider: "openai",
      },
      {
        available: true,
        id: "gpt-5.6-sol",
        name: "GPT-5.6 Sol",
        provider: "openai",
      },
      {
        available: true,
        id: "gpt-5.6-terra",
        name: "GPT-5.6 Terra",
        provider: "openai",
      },
    ];
    const gateway = await installMockGateway(page, {
      agentModel: "openai/gpt-5.6-luna",
      methodResponses: {
        "chat.metadata": {
          sequence: [
            {
              __mockError: {
                code: "UNAVAILABLE",
                message: "metadata request timed out",
              },
            },
            { commands: [], models },
          ],
        },
      },
      models,
    });

    try {
      await page.goto(`${suite.server.baseUrl}new`);
      await gateway.waitForRequest("chat.metadata");

      const modelSelect = page.locator('[data-chat-model-select="true"]');
      await expect.poll(() => modelSelect.textContent()).toContain("Models unavailable");
      await modelSelect.click();
      await expect
        .poll(() => page.locator('[data-chat-model-catalog-state="error"]').isVisible())
        .toBe(true);
      expect(await page.locator("[data-chat-model-option]").count()).toBe(0);

      await page.locator('[data-chat-model-catalog-retry="true"]').click();

      await expect.poll(async () => (await gateway.getRequests("chat.metadata")).length).toBe(2);
      await expect.poll(() => page.locator("[data-chat-model-option]").count()).toBe(3);
      expect(await page.locator('[data-chat-model-catalog-state="error"]').count()).toBe(0);
    } finally {
      await context.close();
    }
  });

  it("restores the model picker after startup-sidecars metadata becomes available", async () => {
    const context = await suite.browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const recoveredModel = {
      available: true,
      id: "gpt-5.6-luna",
      name: "Recovered GPT-5.6 Luna",
      provider: "openai",
      reasoning: true,
    };
    const gateway = await installMockGateway(page, {
      methodResponses: {
        "chat.metadata": {
          sequence: [
            {
              __mockError: {
                code: "UNAVAILABLE",
                details: { reason: "startup-sidecars" },
                message: "gateway startup sidecars are still initializing",
                retryable: true,
                retryAfterMs: 100,
              },
            },
            { commands: [], models: [recoveredModel] },
          ],
        },
      },
    });

    try {
      await page.goto(`${suite.server.baseUrl}new`);
      await expect.poll(async () => (await gateway.getRequests("chat.metadata")).length).toBe(2);

      const modelSelect = page.locator(
        '.new-session-page__composer [data-chat-model-select="true"]',
      );
      await modelSelect.click();
      await page.locator('[data-chat-model-provider="openai"]').click();
      await expect
        .poll(() => page.locator('[data-chat-model-option="openai/gpt-5.6-luna"]').textContent())
        .toContain(recoveredModel.name);

      expect(await gateway.getRequests("chat.metadata")).toEqual([
        expect.objectContaining({ params: { agentId: "main" } }),
        expect.objectContaining({ params: { agentId: "main" } }),
      ]);
    } finally {
      await context.close();
    }
  });

  it("creates a catalog-targeted draft with its advertised model", async () => {
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
          repositoryStatus: "git",
        },
        "sessions.catalog.list": {
          catalogs: [
            {
              id: "claude",
              label: "Claude Code",
              capabilities: {
                continueSession: true,
                archive: false,
                createSession: { model: "anthropic/claude-opus-4-8" },
              },
              hosts: [],
            },
          ],
        },
        "sessions.create": { key: "agent:main:claude-draft" },
      },
    });

    try {
      const model = "anthropic/claude-opus-4-8";
      await page.goto(
        `${suite.server.baseUrl}new?agent=Research&catalog=claude&model=${encodeURIComponent("openai/gpt-5")}&label=Spoofed`,
      );

      const catalogRequest = await gateway.waitForRequest("sessions.catalog.list");
      expect(catalogRequest.params).toMatchObject({
        agentId: "research",
        catalogId: "claude",
      });
      const runtime = page.locator(".new-session-page__runtime");
      await pollLocatorText(runtime).toContain("Claude Code");
      expect(await runtime.getAttribute("title")).toBe(model);
      expect(await page.locator('.new-session-page__trigger[title="Agent"]').count()).toBe(0);
      expect(await page.locator('[data-chat-model-select="true"]').count()).toBe(0);

      await page.locator(".new-session-page__message").fill("use Claude Code");
      await page.getByRole("button", { name: "Start thread" }).click();

      const create = await gateway.waitForRequest("sessions.create");
      expect(create.params).toMatchObject({
        agentId: "research",
        message: "use Claude Code",
        catalogId: "claude",
      });
      expect(create.params).not.toHaveProperty("model");
    } finally {
      await context.close();
    }
  });

  it("navigates to a created session while canonical session refresh is pending", async () => {
    const context = await suite.browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const sessionKey = "agent:main:refresh-overlap-e2e";
    const listResponse = {
      count: 0,
      defaults: SESSION_LIST_DEFAULTS,
      path: "",
      sessions: [],
      ts: Date.now(),
    };
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
        "sessions.create": { key: sessionKey },
        "sessions.list": listResponse,
        "worktrees.branches": {
          branches: [{ kind: "local", name: "main" }],
          defaultBranch: "main",
          repositoryStatus: "git",
        },
      },
    });

    try {
      await page.goto(`${suite.server.baseUrl}new`);
      const message = page.locator(".new-session-page__message");
      await message.waitFor({ state: "visible", timeout: 10_000 });
      const listCalls = (await gateway.getRequests("sessions.list")).length;

      await gateway.deferNext("sessions.list");
      await gateway.emitGatewayEvent("sessions.changed", {
        key: "agent:main:other-client",
        kind: "direct",
        reason: "update",
        sessionKey: "agent:main:other-client",
        updatedAt: Date.now(),
      });
      await expect
        .poll(async () => (await gateway.getRequests("sessions.list")).length)
        .toBe(listCalls + 1);

      await message.fill("create during refresh");
      await page.getByRole("button", { name: "Start thread" }).click();
      const create = await gateway.waitForRequest("sessions.create");
      expect(create.params).toMatchObject({
        agentId: "main",
        message: "create during refresh",
      });
      await expect.poll(() => new URL(page.url()).pathname).toBe(controlUiSessionPath(sessionKey));

      await gateway.resolveDeferred("sessions.list", listResponse);
    } finally {
      await context.close();
    }
  });

  it("resolves a pending catalog target after reconnect without clearing the draft", async () => {
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
          repositoryStatus: "git",
        },
        "sessions.catalog.list": {
          catalogs: [
            {
              id: "claude",
              label: "Claude Code",
              capabilities: {
                continueSession: true,
                archive: false,
                createSession: { model: "anthropic/claude-opus-4-8" },
              },
              hosts: [],
            },
          ],
        },
        "sessions.create": { key: "agent:research:claude-reconnect" },
      },
    });

    try {
      await page.goto(`${suite.server.baseUrl}new?agent=research`);
      await page.getByRole("heading", { name: "Research" }).waitFor();
      await gateway.setOnline(false);
      await page.locator(".sidebar-identity-card__subtitle").waitFor({ timeout: 10_000 });

      await page.evaluate(() => {
        history.pushState(null, "", "new?agent=research&catalog=claude");
        dispatchEvent(new PopStateEvent("popstate"));
      });

      const message = page.locator(".new-session-page__message");
      await message.fill("keep this reconnect draft");
      await pollLocatorText(page.locator(".new-session-page__runtime")).toContain("claude");
      await expect
        .poll(() => page.getByRole("button", { name: "Start thread" }).isEnabled())
        .toBe(false);
      expect(await gateway.getRequests("sessions.catalog.list")).toHaveLength(0);

      await gateway.deferNext("sessions.catalog.list");
      await gateway.setOnline(true);
      await gateway.waitForRequest("sessions.catalog.list");
      await gateway.deferNext("sessions.catalog.list");
      await gateway.rejectDeferred("sessions.catalog.list", {
        code: "UNAVAILABLE",
        message: "catalog warming up",
        retryable: true,
      });
      await expect
        .poll(async () => (await gateway.getRequests("sessions.catalog.list")).length)
        .toBe(2);
      await gateway.resolveDeferred("sessions.catalog.list", { catalogs: [] });
      await expect
        .poll(async () => (await gateway.getRequests("sessions.catalog.list")).length, {
          timeout: 10_000,
        })
        .toBe(3);
      await pollLocatorText(page.locator(".new-session-page__runtime")).toContain("Claude Code");
      await expect.poll(() => message.inputValue()).toBe("keep this reconnect draft");
      await pollLocatorText(page.getByRole("heading").first()).toContain("Research");

      await page.getByRole("button", { name: "Start thread" }).click();
      const create = await gateway.waitForRequest("sessions.create");
      expect(create.params).toMatchObject({
        agentId: "research",
        message: "keep this reconnect draft",
        catalogId: "claude",
      });
      expect(create.params).not.toHaveProperty("model");
      expect(create.params).not.toHaveProperty("cwd");
    } finally {
      await context.close();
    }
  });

  it("preserves a manually selected agent across a same-client reconnect", async () => {
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
          repositoryStatus: "git",
        },
        "sessions.create": { key: "agent:research:manual-reconnect" },
      },
    });

    try {
      await page.goto(`${suite.server.baseUrl}new`);
      await page.getByRole("heading", { name: "Main" }).waitFor();
      await gateway.waitForRequest("worktrees.branches");
      const agentPicker = page.locator(".new-session-page__select--agent openclaw-agent-select");
      await agentPicker.locator(".agent-select__trigger").click();
      await agentPicker
        .locator("wa-dropdown-item[data-agent-option]")
        .filter({ hasText: "Research" })
        .click();
      await page.getByRole("heading", { name: "Research" }).waitFor();

      const message = page.locator(".new-session-page__message");
      await message.fill("keep my selected agent");
      const agentRequestsBefore = (await gateway.getRequests("agents.list")).length;
      const branchRequestsBefore = (await gateway.getRequests("worktrees.branches")).length;

      await gateway.setOnline(false);
      await page.locator(".sidebar-identity-card__subtitle").waitFor({ timeout: 10_000 });
      await gateway.setMethodResponse("agents.list", {
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
            workspace: REFRESHED_RESEARCH_WORKSPACE,
            workspaceGit: true,
          },
        ],
        defaultId: "main",
        mainKey: "main",
        scope: "agent",
      });
      await gateway.setOnline(true);

      await expect
        .poll(async () => (await gateway.getRequests("agents.list")).length)
        .toBe(agentRequestsBefore + 1);
      await expect.poll(() => message.inputValue()).toBe("keep my selected agent");
      await pollLocatorText(page.getByRole("heading").first()).toContain("Research");
      await pollLocatorText(
        page.locator("#new-session-place-trigger .new-session-page__trigger-label"),
      ).toBe("research-next");
      await expect
        .poll(async () => (await gateway.getRequests("worktrees.branches")).length)
        .toBe(branchRequestsBefore + 1);
      expect((await gateway.getRequests("worktrees.branches")).at(-1)?.params).toEqual({
        repoRoot: REFRESHED_RESEARCH_WORKSPACE,
        includeRepositoryStatus: true,
      });

      const placeSelect = page.locator("wa-popover.new-session-page__place-popover");
      const placeTrigger = page.locator("#new-session-place-trigger");
      await placeTrigger.click();
      const worktreeItem = placeSelect.getByRole("button", { name: "Worktree" });
      await worktreeItem.click();
      const baseInput = page.getByLabel("Base branch");
      await expect.poll(() => baseInput.inputValue()).toBe("main");
      await page.keyboard.press("Escape");

      await gateway.deferNext("worktrees.branches");
      const branchesBeforeSameWorkspaceReconnect = (await gateway.getRequests("worktrees.branches"))
        .length;
      await gateway.setOnline(false);
      await page.locator(".sidebar-identity-card__subtitle").waitFor({ timeout: 10_000 });
      await gateway.setOnline(true);

      await expect
        .poll(async () => (await gateway.getRequests("worktrees.branches")).length)
        .toBe(branchesBeforeSameWorkspaceReconnect + 1);
      expect((await gateway.getRequests("worktrees.branches")).at(-1)?.params).toEqual({
        repoRoot: REFRESHED_RESEARCH_WORKSPACE,
        includeRepositoryStatus: true,
      });
      expect(await baseInput.inputValue()).toBe("");
      expect(await baseInput.getAttribute("placeholder")).toBe("Loading…");
      await placeTrigger.click();
      await baseInput.fill("feature-choice");
      await gateway.resolveDeferred("worktrees.branches", {
        branches: [{ kind: "local", name: "beta" }],
        defaultBranch: "beta",
        repositoryStatus: "git",
      });
      await expect.poll(() => baseInput.inputValue()).toBe("feature-choice");

      await page.getByRole("button", { name: "Start thread" }).click();
      const create = await gateway.waitForRequest("sessions.create");
      expect(create.params).toMatchObject({
        agentId: "research",
        message: "keep my selected agent",
        worktree: true,
        worktreeBaseRef: "feature-choice",
      });
      expect(create.params).not.toHaveProperty("cwd");
    } finally {
      await context.close();
    }
  });
});
