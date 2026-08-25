import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import {
  waitForControlUiGatewayReady,
  waitForControlUiGatewayReconnecting,
} from "../test-helpers/control-ui-e2e-readiness.ts";
import {
  REFRESHED_RESEARCH_WORKSPACE,
  SESSION_LIST_DEFAULTS,
  WORKSPACE,
  controlUiSessionPath,
  createNewSessionPageE2eSuite,
  installMockGateway,
  navigateInApp,
  pollLocatorText,
} from "./new-session-page.test-support.ts";

const suite = createNewSessionPageE2eSuite();
const captureCliAgentsProof = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
const cliAgentsProofDir = path.join(
  process.cwd(),
  ".artifacts",
  "control-ui-e2e",
  "cli-agents-picker",
);

function requestHasParam(request: { params?: unknown }, key: string, value: unknown): boolean {
  return Boolean(
    request.params &&
    typeof request.params === "object" &&
    !Array.isArray(request.params) &&
    (request.params as Record<string, unknown>)[key] === value,
  );
}

const TERMINAL_START_FEATURE_METHODS = [
  "chat.metadata",
  "chat.startup",
  "sessions.catalog.list",
  "sessions.catalog.startTerminal",
  "sessions.create",
  "sessions.dispatch",
  "terminal.open",
  "worktrees.create",
] as const;

function cliAgentCatalog(startTerminal: boolean) {
  return {
    id: "claude",
    label: "Claude Code",
    capabilities: {
      continueSession: true,
      archive: false,
      createSession: {
        model: "anthropic/claude-opus-4-8",
        ...(startTerminal ? { startTerminal: true } : {}),
      },
    },
    hosts: [],
  };
}

suite.define(() => {
  it("waits for the current roster before loading the CLI catalog", async () => {
    const context = await suite.browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      assistantAgentId: "roboclaw",
      assistantName: "Roboclaw",
      cliAgentsEnabled: true,
      defaultAgentId: "roboclaw",
      deferredMethods: ["agents.list"],
      featureMethods: [...TERMINAL_START_FEATURE_METHODS],
      methodResponses: {
        "sessions.catalog.list": { catalogs: [cliAgentCatalog(false)] },
      },
    });

    try {
      await page.goto(`${suite.server.baseUrl}new`);
      await gateway.waitForRequest("agents.list");
      await page.locator(".new-session-page__message").waitFor({ state: "visible" });
      expect(
        (await gateway.getRequests("sessions.catalog.list"))
          .filter((request) => requestHasParam(request, "limitPerHost", 1))
          .map((request) => request.params),
      ).toEqual([]);

      await gateway.resolveDeferred("agents.list");

      await page.getByRole("heading", { name: "Roboclaw" }).waitFor();
      await expect
        .poll(async () =>
          (await gateway.getRequests("sessions.catalog.list")).filter((request) =>
            requestHasParam(request, "limitPerHost", 1),
          ),
        )
        .toHaveLength(1);
      const catalogRequest = (await gateway.getRequests("sessions.catalog.list")).find((request) =>
        requestHasParam(request, "limitPerHost", 1),
      );
      expect(catalogRequest?.params).toEqual({
        agentId: "roboclaw",
        limitPerHost: 1,
      });

      await page.locator('[data-chat-model-select="true"]').click();
      const cliGroup = page.locator('[data-chat-model-target-group="cliAgents"]');
      await expect.poll(() => cliGroup.isVisible()).toBe(true);
      await pollLocatorText(cliGroup).toContain("Claude Code");
    } finally {
      await context.close();
    }
  });

  it("routes a Labs-enabled CLI agent picker row through catalog-target mode", async () => {
    if (captureCliAgentsProof) {
      await mkdir(cliAgentsProofDir, { recursive: true });
    }
    const context = await suite.browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
      ...(captureCliAgentsProof
        ? { recordVideo: { dir: cliAgentsProofDir, size: { height: 900, width: 1280 } } }
        : {}),
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      cliAgentsEnabled: true,
      featureMethods: [
        "chat.metadata",
        "chat.startup",
        "sessions.create",
        "sessions.dispatch",
        "sessions.catalog.list",
      ],
      methodResponses: {
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
            {
              id: "history-only",
              label: "History only",
              capabilities: { continueSession: true, archive: false },
              hosts: [],
            },
          ],
        },
      },
    });

    try {
      await page.goto(`${suite.server.baseUrl}new`);
      await expect
        .poll(async () =>
          (await gateway.getRequests("sessions.catalog.list")).find((request) =>
            requestHasParam(request, "limitPerHost", 1),
          ),
        )
        .toMatchObject({ params: { agentId: "main", limitPerHost: 1 } });

      await page.locator('[data-chat-model-select="true"]').click();
      const cliGroup = page.locator('[data-chat-model-target-group="cliAgents"]');
      await expect.poll(() => cliGroup.isVisible()).toBe(true);
      await pollLocatorText(cliGroup).toContain("CLI agents");
      await pollLocatorText(cliGroup).toContain("Claude Code");
      expect(await cliGroup.textContent()).not.toContain("History only");
      if (captureCliAgentsProof) {
        await page.screenshot({
          animations: "disabled",
          fullPage: true,
          path: path.join(cliAgentsProofDir, "picker-group.png"),
        });
      }

      await cliGroup.getByRole("option", { name: "Claude Code" }).click();
      await expect.poll(() => new URL(page.url()).searchParams.get("catalog")).toBe("claude");
      await expect
        .poll(async () =>
          (await gateway.getRequests("sessions.catalog.list")).find((request) =>
            requestHasParam(request, "catalogId", "claude"),
          ),
        )
        .toMatchObject({ params: { agentId: "main", catalogId: "claude" } });
      await pollLocatorText(page.locator(".new-session-page__runtime")).toContain("Claude Code");
      expect(await page.locator('[data-chat-model-select="true"]').count()).toBe(0);
      if (captureCliAgentsProof) {
        await page.screenshot({
          animations: "disabled",
          fullPage: true,
          path: path.join(cliAgentsProofDir, "catalog-target.png"),
        });
      }
    } finally {
      await context.close();
    }
  });

  it.each([
    {
      label: "CLI agents gate is off",
      cliAgentsEnabled: false,
      terminalEnabled: true,
      startTerminal: true,
    },
    {
      label: "terminal gate is off",
      cliAgentsEnabled: true,
      terminalEnabled: false,
      startTerminal: true,
    },
    {
      label: "catalog capability is absent",
      cliAgentsEnabled: true,
      terminalEnabled: true,
      startTerminal: false,
    },
  ])("keeps the plain Start control when $label", async (testCase) => {
    const context = await suite.browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    await installMockGateway(page, {
      cliAgentsEnabled: testCase.cliAgentsEnabled,
      terminalEnabled: testCase.terminalEnabled,
      workspace: WORKSPACE,
      workspaceGit: true,
      featureMethods: [...TERMINAL_START_FEATURE_METHODS],
      methodResponses: {
        "sessions.catalog.list": {
          catalogs: [cliAgentCatalog(testCase.startTerminal)],
        },
        "worktrees.branches": {
          branches: [{ kind: "local", name: "main" }],
          defaultBranch: "main",
          repositoryStatus: "git",
        },
      },
    });

    try {
      await page.goto(`${suite.server.baseUrl}new?catalog=claude`);
      await pollLocatorText(page.locator(".new-session-page__runtime")).toContain("Claude Code");

      expect(await page.locator(".new-session-page__start-split").count()).toBe(0);
      await page.locator(".new-session-page__message").fill("keep the normal path");
      await expect
        .poll(() => page.getByRole("button", { name: "Start session" }).isEnabled())
        .toBe(true);
      expect(await page.locator(".chat-send-btn").count()).toBe(1);
    } finally {
      await context.close();
    }
  });

  it("creates a worktree, starts the catalog session, and opens its terminal", async () => {
    if (captureCliAgentsProof) {
      await mkdir(cliAgentsProofDir, { recursive: true });
    }
    const context = await suite.browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
      ...(captureCliAgentsProof
        ? { recordVideo: { dir: cliAgentsProofDir, size: { height: 900, width: 1280 } } }
        : {}),
    });
    const page = await context.newPage();
    await page.addInitScript(() => {
      const proofWindow = window as typeof window & { terminalToggleProof?: unknown[] };
      proofWindow.terminalToggleProof = [];
      window.addEventListener("openclaw:terminal-toggle", (event) => {
        proofWindow.terminalToggleProof?.push((event as CustomEvent).detail);
      });
    });
    const worktreePath = "/home/peter/.openclaw/worktrees/terminal-e2e";
    const config = { tools: { web: { search: { provider: "brave" } } } };
    const gateway = await installMockGateway(page, {
      cliAgentsEnabled: true,
      terminalEnabled: true,
      operatorScopes: ["operator.read", "operator.write", "operator.admin"],
      workspace: WORKSPACE,
      workspaceGit: true,
      featureMethods: [...TERMINAL_START_FEATURE_METHODS],
      methodResponses: {
        "config.get": {
          raw: JSON.stringify(config),
          hash: "terminal-capability-overrides",
          sourceConfig: config,
          runtimeConfig: config,
          config,
        },
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
              workspace: WORKSPACE,
              workspaceGit: true,
            },
          ],
          defaultId: "main",
          mainKey: "main",
          scope: "agent",
        },
        "sessions.catalog.list": { catalogs: [cliAgentCatalog(true)] },
        "worktrees.branches": {
          branches: [{ kind: "local", name: "main" }],
          defaultBranch: "main",
          repositoryStatus: "git",
        },
        "worktrees.create": {
          id: "terminal-e2e",
          name: "terminal-task",
          repoFingerprint: "0123456789abcdef",
          repoRoot: WORKSPACE,
          path: worktreePath,
          branch: "openclaw/terminal-task",
          baseRef: "main",
          ownerKind: "manual",
          createdAt: 1,
          lastActiveAt: 1,
        },
        "sessions.catalog.startTerminal": {
          sessionId: "terminal-cli-1",
          agentId: "research",
          shell: "/bin/zsh",
          cwd: worktreePath,
          confined: false,
          title: "Claude Code",
        },
      },
    });

    try {
      await page.goto(`${suite.server.baseUrl}new?agent=research&catalog=claude`);
      await pollLocatorText(page.locator(".new-session-page__runtime")).toContain("Claude Code");
      await expect.poll(() => page.locator(".new-session-page__start-split").count()).toBe(1);

      await page.locator("#new-session-detail-trigger").click();
      const placePopover = page.locator("wa-popover.new-session-page__detail-popover");
      const worktreeButton = placePopover.getByRole("button", { name: "Worktree" });
      await worktreeButton.waitFor({ state: "visible" });
      const initialBranchRequestCount = (await gateway.getRequests("worktrees.branches")).length;
      await worktreeButton.click();
      await expect.poll(() => placePopover.getByLabel("Base branch").inputValue()).toBe("main");
      await placePopover.getByLabel("Worktree name").fill("terminal-task");
      await page.locator("#new-session-detail-trigger").click();
      await page.locator(".new-session-page__message").fill("  inspect the checkout  ");

      const composer = page.locator(".new-session-page__composer");
      const capabilityMenu = composer.locator("wa-dropdown.agent-chat__capability-menu");
      await composer.getByRole("button", { name: "Add attachment" }).click();
      await capabilityMenu.getByRole("menuitemcheckbox", { name: "Web search" }).click();
      await page.keyboard.press("Escape");
      const terminalTrigger = page.getByRole("button", { name: "Start in terminal" });
      await expect.poll(() => terminalTrigger.isDisabled()).toBe(true);
      const terminalTooltip = page.locator("openclaw-tooltip").filter({ has: terminalTrigger });
      await expect
        .poll(() => terminalTooltip.evaluate((element) => element.getAttribute("content")))
        .toBe("Clear session capability overrides before starting in a terminal.");
      expect(await gateway.getRequests("sessions.catalog.startTerminal")).toHaveLength(0);
      await composer.getByRole("button", { name: /session options/ }).click();
      await capabilityMenu.getByRole("menuitemcheckbox", { name: "Web search" }).click();
      await page.keyboard.press("Escape");
      await expect.poll(() => terminalTrigger.isEnabled()).toBe(true);

      if (captureCliAgentsProof) {
        await page.screenshot({
          animations: "disabled",
          fullPage: true,
          path: path.join(cliAgentsProofDir, "terminal-split.png"),
        });
      }

      await page.getByRole("button", { name: "Start in terminal" }).click();
      await page.getByRole("menuitem", { name: "Start in terminal" }).click();

      const worktreeRequest = await gateway.waitForRequest("worktrees.create");
      expect(worktreeRequest.params).toEqual({
        repoRoot: WORKSPACE,
        name: "terminal-task",
        baseRef: "main",
      });
      const terminalRequest = await gateway.waitForRequest("sessions.catalog.startTerminal");
      expect(terminalRequest.params).toEqual({
        catalogId: "claude",
        agentId: "research",
        cwd: worktreePath,
        initialMessage: "inspect the checkout",
      });
      expect(await gateway.getRequests("worktrees.branches")).toHaveLength(
        initialBranchRequestCount,
      );
      const requests = await gateway.getRequests();
      const methods = requests.map((request) => request.method);
      expect(methods.indexOf("worktrees.create")).toBeLessThan(
        methods.indexOf("sessions.catalog.startTerminal"),
      );
      await expect.poll(() => page.locator(".new-session-page__message").inputValue()).toBe("");
      await expect
        .poll(() =>
          page.evaluate(() => {
            const proofWindow = window as typeof window & { terminalToggleProof?: unknown[] };
            return proofWindow.terminalToggleProof;
          }),
        )
        .toContainEqual({ open: true, terminalSessionId: "terminal-cli-1" });

      await expect
        .poll(() => page.getByRole("button", { name: "Start in terminal" }).isEnabled())
        .toBe(true);
      await page.getByRole("button", { name: "Start in terminal" }).click();
      await page.getByRole("menuitem", { name: "Start in terminal" }).click();
      await expect
        .poll(async () => {
          const currentRequests = await gateway.getRequests();
          return currentRequests.filter(
            (request) => request.method === "sessions.catalog.startTerminal",
          ).length;
        })
        .toBe(2);
      const repeatedRequests = await gateway.getRequests();
      const emptyMessageRequest = repeatedRequests.findLast(
        (request) => request.method === "sessions.catalog.startTerminal",
      );
      expect(emptyMessageRequest?.params).toEqual({
        catalogId: "claude",
        agentId: "research",
        cwd: worktreePath,
      });
    } finally {
      await context.close();
    }
  });

  it("shows the terminal-start server error without rewriting it", async () => {
    const context = await suite.browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const serverMessage = "cwd is no longer available; choose another folder and retry";
    await installMockGateway(page, {
      cliAgentsEnabled: true,
      terminalEnabled: true,
      workspace: WORKSPACE,
      workspaceGit: true,
      featureMethods: [...TERMINAL_START_FEATURE_METHODS],
      methodResponses: {
        "sessions.catalog.list": { catalogs: [cliAgentCatalog(true)] },
        "worktrees.branches": {
          branches: [{ kind: "local", name: "main" }],
          defaultBranch: "main",
          repositoryStatus: "git",
        },
        "sessions.catalog.startTerminal": {
          __mockError: { code: "INVALID_REQUEST", message: serverMessage },
        },
      },
    });

    try {
      await page.goto(`${suite.server.baseUrl}new?catalog=claude`);
      await pollLocatorText(page.locator(".new-session-page__runtime")).toContain("Claude Code");
      await page.locator(".new-session-page__message").fill("keep this draft");
      await page.getByRole("button", { name: "Start in terminal" }).click();
      await page.getByRole("menuitem", { name: "Start in terminal" }).click();

      await expect
        .poll(() => page.locator(".new-session-page__alert-message").textContent())
        .toBe(serverMessage);
      expect(await page.locator(".new-session-page__message").inputValue()).toBe("keep this draft");
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
      await page.getByRole("button", { name: "Start session" }).click();

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
      await page.getByRole("button", { name: "Start session" }).click();
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
      await waitForControlUiGatewayReconnecting(page);

      await page.evaluate(() => {
        history.pushState(null, "", "new?agent=research&catalog=claude");
        dispatchEvent(new PopStateEvent("popstate"));
      });

      const message = page.locator(".new-session-page__message");
      await message.fill("keep this reconnect draft");
      await pollLocatorText(page.locator(".new-session-page__runtime")).toContain("claude");
      await expect.poll(() => message.inputValue()).toBe("keep this reconnect draft");
      await expect
        .poll(() => page.getByRole("button", { name: "Start session" }).isEnabled())
        .toBe(false);
      expect(await gateway.getRequests("sessions.catalog.list")).toHaveLength(0);

      await gateway.deferNext("sessions.catalog.list");
      await gateway.setOnline(true);
      await waitForControlUiGatewayReady(page);
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

      await page.getByRole("button", { name: "Start session" }).click();
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

  it("clears the draft after a genuine new-session route navigation settles", async () => {
    const context = await suite.browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    await installMockGateway(page, {
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
              workspace: REFRESHED_RESEARCH_WORKSPACE,
              workspaceGit: true,
            },
          ],
          defaultId: "main",
          mainKey: "main",
          scope: "agent",
        },
      },
    });

    try {
      await page.goto(`${suite.server.baseUrl}new?agent=research`);
      await page.getByRole("heading", { name: "Research" }).waitFor();
      const message = page.locator(".new-session-page__message");
      await message.fill("discard on real navigation");

      await navigateInApp(page, "new-session", "?agent=main");

      await page.getByRole("heading", { name: "Main" }).waitFor();
      await expect.poll(() => message.inputValue()).toBe("");
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
      await waitForControlUiGatewayReconnecting(page);
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
      await waitForControlUiGatewayReady(page);

      await expect
        .poll(async () => (await gateway.getRequests("agents.list")).length)
        .toBe(agentRequestsBefore + 1);
      await expect.poll(() => message.inputValue()).toBe("keep my selected agent");
      await pollLocatorText(page.getByRole("heading").first()).toContain("Research");
      await pollLocatorText(
        page.locator("#new-session-project-trigger .new-session-page__trigger-label"),
      ).toBe("research-next");
      await expect
        .poll(async () => (await gateway.getRequests("worktrees.branches")).length)
        .toBe(branchRequestsBefore + 1);
      expect((await gateway.getRequests("worktrees.branches")).at(-1)?.params).toEqual({
        repoRoot: REFRESHED_RESEARCH_WORKSPACE,
        includeRepositoryStatus: true,
      });

      const placeSelect = page.locator("wa-popover.new-session-page__detail-popover");
      const placeTrigger = page.locator("#new-session-detail-trigger");
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
      await waitForControlUiGatewayReconnecting(page);
      await gateway.setOnline(true);
      await waitForControlUiGatewayReady(page);

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

      await page.getByRole("button", { name: "Start session" }).click();
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
