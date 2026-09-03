import type { BrowserContextOptions, Page } from "playwright";
import { expect, it } from "vitest";
import type { ApplicationContext } from "../app/context.ts";
import {
  waitForControlUiGatewayReady,
  waitForControlUiGatewayReconnecting,
} from "../test-helpers/control-ui-e2e-readiness.ts";
import { holdModuleResponse, tooltipTitleText } from "./control-ui-e2e-suite.test-support.ts";
import {
  SOURCE_REPO,
  TARGET_REPO,
  WORKSPACE,
  captureUiProofEnabled,
  controlUiSessionPath,
  createNewSessionPageE2eSuite,
  installMockGateway,
  pollLocatorText,
  replaceGatewayClient,
  waitForGatewayRecoveryScope,
} from "./new-session-page.test-support.ts";

const suite = createNewSessionPageE2eSuite();
const BASE_CONTEXT: BrowserContextOptions = { locale: "en-US", serviceWorkers: "block" };
const DESKTOP_CONTEXT: BrowserContextOptions = {
  ...BASE_CONTEXT,
  viewport: { height: 900, width: 1280 },
};

function mainAgentList(name = "Main", workspace = WORKSPACE) {
  return {
    agents: [
      {
        id: "main",
        identity: { name },
        name,
        workspace,
        workspaceGit: true,
      },
    ],
    defaultId: "main",
    mainKey: "main",
    scope: "agent",
  };
}

function branchList(name = "main") {
  return {
    branches: [{ kind: "local", name }],
    defaultBranch: name,
    repositoryStatus: "git",
    allocationStatus: "available",
  };
}

function deviceEnvironment(nodeId: string) {
  return {
    id: `node:${nodeId}`,
    type: "node",
    label: nodeId
      .split("-")
      .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
      .join(" "),
    status: "available",
    sessionHost: true,
    workerSlots: { total: 1, available: 1 },
  };
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

type MockGateway = Awaited<ReturnType<typeof installMockGateway>>;

async function chooseCustomFolder(page: Page, gateway: MockGateway) {
  const trigger = page.locator("#new-session-project-trigger");
  const place = page.locator("wa-popover.new-session-page__project-popover");
  await trigger.click();
  await place.getByRole("button", { name: "Browse folders" }).click();
  await page.locator("input.new-session-page__browser-path").fill(TARGET_REPO);
  await page.getByRole("button", { name: "Use this folder" }).click();
  await expect
    .poll(async () =>
      (await gateway.getRequests("worktrees.branches")).some((request) => {
        const params = request.params as Record<string, unknown>;
        return (
          params.repoRoot === TARGET_REPO &&
          params.includeRepositoryStatus === true &&
          params.includeAllocationStatus === undefined
        );
      }),
    )
    .toBe(true);
}

async function reconnectForBranchRediscovery(page: Page, gateway: MockGateway) {
  const branchRequests = (await gateway.getRequests("worktrees.branches")).length;
  await gateway.setOnline(false);
  await waitForControlUiGatewayReconnecting(page);
  await gateway.setOnline(true);
  await waitForControlUiGatewayReady(page);
  await expect
    .poll(async () => (await gateway.getRequests("worktrees.branches")).length)
    .toBe(branchRequests + 1);
}

async function expectPendingNewSession(page: Page, message: string) {
  const startup = page.locator(".new-session-page__starting");
  const submittedPrompt = startup.locator(".chat-group.user");
  await expect.poll(() => submittedPrompt.isVisible()).toBe(true);
  await pollLocatorText(submittedPrompt).toContain(message);
  await pollLocatorText(startup.locator('.chat-working-indicator[role="status"]')).toContain(
    "Starting…",
  );
  expect(await page.locator(".new-session-page__message").isVisible()).toBe(false);
}

suite.define(() => {
  it.each([
    { viewportName: "desktop", viewport: { height: 900, width: 1280 } },
    { viewportName: "mobile", viewport: { height: 844, width: 390 } },
  ])(
    "surfaces insufficient worktree capacity before selection on $viewportName",
    async ({ viewportName, viewport }) => {
      await withNewSessionPage(
        {
          ...BASE_CONTEXT,
          viewport,
          ...(captureUiProofEnabled
            ? { recordVideo: { dir: suite.artifactDir, size: viewport } }
            : {}),
        },
        async (page) => {
          const gateway = await installMockGateway(page, {
            workspace: WORKSPACE,
            workspaceGit: true,
            methodResponses: {
              "worktrees.branches": {
                ...branchList(),
                allocationStatus: "insufficient-space",
              },
            },
          });
          await page.goto(`${suite.server.baseUrl}new`);
          await gateway.waitForRequest("worktrees.branches");

          const trigger = page.locator("#new-session-checkout-trigger");
          await pollLocatorText(trigger).toContain("No space");
          await trigger.click();
          const place = page.locator("wa-popover.new-session-page__checkout-popover");
          const worktree = place.getByRole("button", {
            name: "New worktree Isolated copy of the repo",
            exact: true,
          });
          expect(await worktree.isDisabled()).toBe(true);
          await pollLocatorText(place.locator(".new-session-page__capacity-warning")).toContain(
            "No space for a worktree",
          );
          if (captureUiProofEnabled) {
            await page.screenshot({
              path: `${suite.artifactDir}/worktree-capacity-${viewportName}.png`,
              fullPage: true,
              animations: "disabled",
            });
          }

          await place.getByRole("button", { name: /Managed Worktrees/ }).click();
          await page.waitForURL((url) => url.pathname === "/worktrees");
          expect(await gateway.getRequests("sessions.create")).toHaveLength(0);
        },
      );
    },
  );

  it("blocks a selected workspace worktree when branch rediscovery is unavailable until cleared", async () => {
    await withNewSessionPage(BASE_CONTEXT, async (page) => {
      const gateway = await installMockGateway(page, {
        workspace: WORKSPACE,
        workspaceGit: true,
        methodResponses: {
          "worktrees.branches": branchList(),
          "sessions.create": { key: "agent:main:worktree-unavailable" },
        },
      });
      await page.goto(`${suite.server.baseUrl}new`);
      await gateway.waitForRequest("worktrees.branches");
      const trigger = page.locator("#new-session-checkout-trigger");
      const place = page.locator("wa-popover.new-session-page__checkout-popover");
      await trigger.click();
      await place
        .getByRole("button", { name: "New worktree Isolated copy of the repo", exact: true })
        .click();
      await page.keyboard.press("Escape");
      await expect.poll(() => trigger.getAttribute("data-worktree")).toBe("true");

      const branchRequests = (await gateway.getRequests("worktrees.branches")).length;
      await gateway.deferNext("worktrees.branches");
      await gateway.setOnline(false);
      await waitForControlUiGatewayReconnecting(page);
      await gateway.setOnline(true);
      await waitForControlUiGatewayReady(page);
      await expect
        .poll(async () => (await gateway.getRequests("worktrees.branches")).length)
        .toBe(branchRequests + 1);
      await gateway.rejectDeferred("worktrees.branches", {
        code: "UNAVAILABLE",
        message: "branch lookup unavailable",
      });

      await expect.poll(() => trigger.getAttribute("data-worktree")).toBe("true");
      await trigger.click();
      const worktree = place.getByRole("button", {
        name: "New worktree Isolated copy of the repo",
        exact: true,
      });
      await expect.poll(() => worktree.getAttribute("aria-pressed")).toBe("true");
      expect(await worktree.isDisabled()).toBe(true);
      await page.keyboard.press("Escape");

      await page.locator(".new-session-page__message").fill("keep this task isolated");
      const start = page.getByRole("button", { name: "Start session" });
      await expect.poll(() => start.isDisabled()).toBe(true);
      expect(await gateway.getRequests("sessions.create")).toHaveLength(0);
      await trigger.click();
      await place.getByRole("button", { name: "Current checkout" }).click();
      await expect.poll(() => trigger.count()).toBe(0);
      await page.keyboard.press("Escape");
      await start.click();
      const create = await gateway.waitForRequest("sessions.create");
      expect(create.params).toMatchObject({
        agentId: "main",
        message: "keep this task isolated",
      });
      expect(create.params).not.toHaveProperty("worktree");
    });
  });

  it("clears a custom worktree when the folder becomes confirmed non-Git", async () => {
    await withNewSessionPage(BASE_CONTEXT, async (page) => {
      const gateway = await installMockGateway(page, {
        workspace: WORKSPACE,
        workspaceGit: true,
        methodResponses: {
          "fs.listDir": { path: WORKSPACE, home: "/home/peter", entries: [] },
          "worktrees.branches": branchList(),
          "sessions.create": { key: "agent:main:custom-now-direct" },
        },
      });
      await page.goto(`${suite.server.baseUrl}new`);
      await chooseCustomFolder(page, gateway);
      const trigger = page.locator("#new-session-checkout-trigger");
      const place = page.locator("wa-popover.new-session-page__checkout-popover");
      await trigger.click();
      await place
        .getByRole("button", { name: "New worktree Isolated copy of the repo", exact: true })
        .click();
      await page.keyboard.press("Escape");
      await expect.poll(() => trigger.getAttribute("data-worktree")).toBe("true");

      await gateway.setMethodResponse("worktrees.branches", {
        branches: [],
        repositoryStatus: "not_git",
      });
      await reconnectForBranchRediscovery(page, gateway);

      await expect.poll(() => trigger.count()).toBe(0);
      const storedWorktree = await page.evaluate(() => {
        const key = Array.from({ length: localStorage.length }, (_, index) =>
          localStorage.key(index),
        ).find((candidate) => candidate?.startsWith("openclaw.new-session.preferences.v1:"));
        const value = key
          ? (JSON.parse(localStorage.getItem(key) ?? "null") as {
              agents?: Record<string, { worktree?: boolean }>;
            } | null)
          : null;
        return value?.agents?.main?.worktree;
      });
      expect(storedWorktree).toBe(false);
      await page.locator(".new-session-page__message").fill("continue directly");
      await page.getByRole("button", { name: "Start session" }).click();
      const create = await gateway.waitForRequest("sessions.create");
      expect(create.params).toMatchObject({ cwd: TARGET_REPO, message: "continue directly" });
      expect(create.params).not.toHaveProperty("worktree");
    });
  });

  it("allows clearing a custom worktree when Git rediscovery is unavailable", async () => {
    await withNewSessionPage(BASE_CONTEXT, async (page) => {
      const gateway = await installMockGateway(page, {
        workspace: WORKSPACE,
        workspaceGit: true,
        methodResponses: {
          "fs.listDir": { path: WORKSPACE, home: "/home/peter", entries: [] },
          "worktrees.branches": branchList(),
          "sessions.create": { key: "agent:main:custom-worktree-cleared" },
        },
      });
      await page.goto(`${suite.server.baseUrl}new`);
      await chooseCustomFolder(page, gateway);
      const trigger = page.locator("#new-session-checkout-trigger");
      const place = page.locator("wa-popover.new-session-page__checkout-popover");
      await trigger.click();
      await place
        .getByRole("button", { name: "New worktree Isolated copy of the repo", exact: true })
        .click();
      await page.keyboard.press("Escape");
      await expect.poll(() => trigger.getAttribute("data-worktree")).toBe("true");

      await gateway.setMethodResponse("worktrees.branches", {
        branches: [],
        repositoryStatus: "unavailable",
      });
      await reconnectForBranchRediscovery(page, gateway);

      await expect.poll(() => trigger.getAttribute("data-worktree")).toBe("true");
      await page.locator(".new-session-page__message").fill("do not run directly");
      const start = page.getByRole("button", { name: "Start session" });
      await expect.poll(() => start.isDisabled()).toBe(true);
      await trigger.click();
      const worktree = place.getByRole("button", {
        name: "New worktree Isolated copy of the repo",
        exact: true,
      });
      expect(await worktree.isDisabled()).toBe(true);
      await expect
        .poll(() => tooltipTitleText(worktree))
        .toBe("Couldn't verify Git for this folder. Choose it again to retry.");
      await place.getByRole("button", { name: "Current checkout" }).click();
      await expect.poll(() => trigger.count()).toBe(0);
      await expect.poll(() => start.isEnabled()).toBe(true);
      await page.keyboard.press("Escape");

      await start.click();
      const create = await gateway.waitForRequest("sessions.create");
      expect(create.params).toMatchObject({
        agentId: "main",
        cwd: TARGET_REPO,
        message: "do not run directly",
      });
      expect(create.params).not.toHaveProperty("worktree");
    });
  });

  it("blocks a custom cloud worktree when Git rediscovery is unavailable", async () => {
    await withNewSessionPage(BASE_CONTEXT, async (page) => {
      const gateway = await installMockGateway(page, {
        workspace: WORKSPACE,
        workspaceGit: true,
        methodResponses: {
          "environments.list": {
            environments: [],
            profiles: [{ id: "aws", providerId: "crabbox" }],
          },
          "fs.listDir": { path: WORKSPACE, home: "/home/peter", entries: [] },
          "worktrees.branches": branchList(),
        },
      });
      await page.goto(`${suite.server.baseUrl}new`);
      await gateway.waitForRequest("environments.list");
      await chooseCustomFolder(page, gateway);
      const whereTrigger = page.locator("#new-session-where-trigger");
      const where = page.locator("wa-popover.new-session-page__where-popover");
      const checkoutTrigger = page.locator("#new-session-checkout-trigger");
      await whereTrigger.click();
      await where.getByRole("button", { name: "Cloud · aws" }).click();
      await expect.poll(() => whereTrigger.getAttribute("data-cloud-profile")).toBe("aws");
      await expect.poll(() => checkoutTrigger.getAttribute("data-worktree")).toBe("true");

      await gateway.setMethodResponse("worktrees.branches", {
        branches: [],
        repositoryStatus: "unavailable",
      });
      await reconnectForBranchRediscovery(page, gateway);

      await expect.poll(() => whereTrigger.getAttribute("data-cloud-profile")).toBe("aws");
      await expect.poll(() => checkoutTrigger.getAttribute("data-worktree")).toBe("true");
      await page.locator(".new-session-page__message").fill("do not run directly");
      const start = page.getByRole("button", { name: "Start session" });
      await expect.poll(() => start.isDisabled()).toBe(true);
      await whereTrigger.click();
      const cloud = where.getByRole("button", { name: "Cloud · aws" });
      expect(await cloud.isDisabled()).toBe(true);
      await expect
        .poll(() => tooltipTitleText(cloud))
        .toBe("Couldn't verify Git for this folder. Choose it again to retry.");
      await page.keyboard.press("Escape");
      await checkoutTrigger.click();
      const checkout = page.locator("wa-popover.new-session-page__checkout-popover");
      expect(await checkout.locator('[data-value="checkout"]').isDisabled()).toBe(true);
      await checkout.getByLabel("From").waitFor();
      await checkout.getByLabel("Name", { exact: true }).waitFor();
      expect(await gateway.getRequests("sessions.create")).toHaveLength(0);
    });
  });

  it("rediscovers Gateway-owned draft state when the app replaces its client", async () => {
    await withNewSessionPage(DESKTOP_CONTEXT, async (page) => {
      const gateway = await installMockGateway(page, {
        methodResponses: {
          "agents.list": mainAgentList("Original agent", SOURCE_REPO),
          "environments.list": {
            environments: [deviceEnvironment("old-device")],
            profiles: [],
          },
          "worktrees.branches": branchList("alpha"),
        },
      });
      await page.goto(`${suite.server.baseUrl}new`);
      await page.getByRole("heading", { name: "Original agent" }).waitFor();
      await gateway.waitForRequest("environments.list");
      await gateway.waitForRequest("worktrees.branches");

      const message = page.locator(".new-session-page__message");
      const whereSelect = page.locator("wa-popover.new-session-page__where-popover");
      const whereTrigger = page.locator("#new-session-where-trigger");
      const projectSelect = page.locator("wa-popover.new-session-page__project-popover");
      const projectTrigger = page.locator("#new-session-project-trigger");
      await message.fill("preserve this replacement draft");
      await whereTrigger.click();
      await whereSelect.getByRole("button", { name: "Old device" }).click();

      // Keep an old-client browser request in flight. Replacement must close
      // its menu and prevent its eventual completion from reviving old state.
      await gateway.deferNext("fs.listDir");
      await projectTrigger.click();
      await projectSelect.getByRole("button", { name: "Browse folders" }).click();
      await gateway.waitForRequest("fs.listDir");

      await gateway.setMethodResponse(
        "agents.list",
        mainAgentList("Replacement agent", TARGET_REPO),
      );
      await gateway.setMethodResponse("environments.list", {
        environments: [deviceEnvironment("new-device")],
        profiles: [],
      });
      await gateway.setMethodResponse("worktrees.branches", branchList("beta"));
      const socketsBefore = await gateway.getSocketCount();
      const environmentsBefore = (await gateway.getRequests("environments.list")).length;
      const branchesBefore = (await gateway.getRequests("worktrees.branches")).length;

      await replaceGatewayClient(page);

      await expect.poll(() => gateway.getSocketCount()).toBe(socketsBefore + 1);
      await expect
        .poll(async () => (await gateway.getRequests("environments.list")).length)
        .toBe(environmentsBefore + 1);
      await expect
        .poll(async () =>
          (await gateway.getRequests("worktrees.branches"))
            .slice(branchesBefore)
            .map((request) => request.params),
        )
        .toEqual([
          { repoRoot: TARGET_REPO, includeRepositoryStatus: true },
          { repoRoot: TARGET_REPO, baseRef: "beta", includeAllocationStatus: true },
        ]);
      await page.getByRole("heading", { name: "Replacement agent" }).waitFor();
      await expect.poll(() => message.inputValue()).toBe("preserve this replacement draft");
      await expect
        .poll(() =>
          projectSelect.evaluate((element) => (element as HTMLElement & { open: boolean }).open),
        )
        .toBe(false);
      await pollLocatorText(projectTrigger.locator(".new-session-page__trigger-label")).toBe(
        "target-repo",
      );

      const branchRequests = await gateway.getRequests("worktrees.branches");
      expect(branchRequests.at(-1)?.params).toEqual({
        repoRoot: TARGET_REPO,
        baseRef: "beta",
        includeAllocationStatus: true,
      });
      await whereTrigger.click();
      await whereSelect.getByRole("button", { name: "New device" }).waitFor();
      expect(await whereSelect.getByRole("button", { name: "Old device" }).count()).toBe(0);
      await page.keyboard.press("Escape");
      await page.locator("#new-session-checkout-trigger").click();
      const checkout = page.locator("wa-popover.new-session-page__checkout-popover");
      await expect.poll(() => checkout.getByLabel("From").inputValue()).toBe("beta");
      await page.keyboard.press("Escape");

      await gateway.resolveDeferred("fs.listDir", {
        path: "/stale-device-path",
        home: "/stale-device-path",
        entries: [],
      });
      await expect
        .poll(() =>
          projectSelect.evaluate((element) => (element as HTMLElement & { open: boolean }).open),
        )
        .toBe(false);
      await expect.poll(() => message.inputValue()).toBe("preserve this replacement draft");
    });
  });

  it.each(["before acceptance", "during chat preparation"] as const)(
    "keeps a local start owned when recovery scope hydrates %s",
    async (hydration) => {
      await withNewSessionPage(DESKTOP_CONTEXT, async (page) => {
        await page.addInitScript(() => {
          const digest = crypto.subtle.digest.bind(crypto.subtle);
          const ready = new Promise<void>((resolve) => {
            window.addEventListener("test-release-recovery-scope", () => resolve(), { once: true });
          });
          crypto.subtle.digest = async (algorithm, data) => {
            if (new TextDecoder().decode(data) === "e2e-device-token") {
              await ready;
            }
            return digest(algorithm, data);
          };
        });
        const chatModule = await holdModuleResponse(page, /\/assets\/chat-page-[^/]+\.js/);
        const sessionKey = "agent:main:late-recovery-scope";
        const gateway = await installMockGateway(page, {
          deferredMethods: ["sessions.create"],
          methodResponses: {
            "sessions.create": { key: sessionKey, runStarted: true, runId: "late-scope-run" },
          },
        });
        try {
          await page.goto(`${suite.server.baseUrl}new`);
          const message = page.locator(".new-session-page__message");
          const start = page.locator("button.new-session-page__start-submit");
          await message.fill("keep this admitted task");
          await waitForGatewayRecoveryScope(page, false);
          await start.click();
          await gateway.waitForRequest("sessions.create");
          if (hydration === "during chat preparation") {
            await gateway.resolveDeferred("sessions.create");
            // Navigation selects the accepted session before awaiting route preparation.
            await expect
              .poll(() =>
                page.locator("openclaw-app").evaluate((element) => {
                  const app = element as HTMLElement & {
                    runtime: { context: ApplicationContext };
                  };
                  return app.runtime.context.gateway.snapshot.sessionKey;
                }),
              )
              .toBe(sessionKey);
            await chatModule.request;
          }

          await page.evaluate(() => window.dispatchEvent(new Event("test-release-recovery-scope")));
          await waitForGatewayRecoveryScope(page);
          await page.locator("openclaw-new-session-page").evaluate(async (element) => {
            await (element as HTMLElement & { updateComplete: Promise<unknown> }).updateComplete;
          });
          expect(await page.locator(".new-session-page__error").allTextContents()).toEqual([]);
          await expectPendingNewSession(page, "keep this admitted task");
          expect(await gateway.getSocketCount()).toBe(1);
          expect(await gateway.getRequests("sessions.create")).toHaveLength(1);

          if (hydration === "before acceptance") {
            await gateway.resolveDeferred("sessions.create");
          }
          chatModule.release();
          await page.waitForURL((url) => url.pathname === controlUiSessionPath(sessionKey));
        } finally {
          chatModule.release();
        }
      });
    },
  );

  for (const reconnectKind of ["same-client reconnect", "client replacement"] as const) {
    it(`automatically resumes an idempotent session creation after ${reconnectKind}`, async () => {
      await withNewSessionPage(DESKTOP_CONTEXT, async (page) => {
        const sessionKey = `agent:main:resumed-${reconnectKind.replaceAll(" ", "-")}`;
        const gateway = await installMockGateway(page, {
          methodResponses: {
            "agents.list": mainAgentList("Original agent", SOURCE_REPO),
            "worktrees.branches": branchList(),
            "sessions.create": { key: sessionKey },
          },
        });
        await page.goto(`${suite.server.baseUrl}new`);
        await page.getByRole("heading", { name: "Original agent" }).waitFor();
        const message = page.locator(".new-session-page__message");
        const start = page.locator("button.new-session-page__start-submit");
        const submittedMessage = "retry this draft after reconnect";
        await message.fill(submittedMessage);
        await gateway.deferNext("sessions.create");
        await start.click();
        const originalCreate = await gateway.waitForRequest("sessions.create");
        await expectPendingNewSession(page, submittedMessage);
        await gateway.deferNext("sessions.create");
        const agentRequestsBefore = (await gateway.getRequests("agents.list")).length;

        if (reconnectKind === "client replacement") {
          await gateway.setMethodResponse(
            "agents.list",
            mainAgentList("Replacement agent", TARGET_REPO),
          );
          const socketsBefore = await gateway.getSocketCount();
          await replaceGatewayClient(page);
          await expect.poll(() => gateway.getSocketCount()).toBe(socketsBefore + 1);
          await waitForControlUiGatewayReady(page);
        } else {
          await gateway.setOnline(false);
          await waitForControlUiGatewayReconnecting(page);
          await expectPendingNewSession(page, submittedMessage);
          await gateway.setOnline(true);
          await waitForControlUiGatewayReady(page);
        }
        await expect
          .poll(async () => (await gateway.getRequests("agents.list")).length)
          .toBe(agentRequestsBefore + 1);
        await expect
          .poll(async () => (await gateway.getRequests("sessions.create")).length)
          .toBe(2);
        const resumedCreate = (await gateway.getRequests("sessions.create")).at(-1);
        expect(originalCreate.params).toMatchObject({
          idempotencyKey: expect.any(String),
          message: submittedMessage,
        });
        expect(resumedCreate?.params).toEqual(originalCreate.params);
        await expectPendingNewSession(page, submittedMessage);
        await gateway.resolveDeferred("sessions.create", { key: sessionKey });
        await gateway.resolveDeferred("sessions.create", { key: sessionKey });
        await page.waitForURL((url) => url.pathname === controlUiSessionPath(sessionKey));
      });
    });
  }

  it.each(["process restarts", "recovery owner changes", "recovery owner disappears"] as const)(
    "keeps an interrupted creation fail-closed after the Gateway %s",
    async (change) => {
      await withNewSessionPage(DESKTOP_CONTEXT, async (page) => {
        const gateway = await installMockGateway(page, {
          methodResponses: {
            "agents.list": mainAgentList(),
            "worktrees.branches": branchList(),
          },
        });
        await page.goto(`${suite.server.baseUrl}new`);
        await page.getByRole("heading", { name: "Main" }).waitFor();
        await waitForGatewayRecoveryScope(page);
        await page.locator(".new-session-page__message").fill("do not duplicate this task");
        await gateway.deferNext("sessions.create");
        await page.getByRole("button", { name: "Start session" }).click();
        await gateway.waitForRequest("sessions.create");
        await expectPendingNewSession(page, "do not duplicate this task");

        if (change === "process restarts") {
          await gateway.setGatewayBootId("different-gateway-process");
        } else {
          const hello = await page.evaluate(() => {
            const app = document.querySelector("openclaw-app") as HTMLElement & {
              runtime: { context: ApplicationContext };
            };
            return app.runtime.context.gateway.snapshot.hello;
          });
          await gateway.setMethodResponse("connect", {
            ...hello,
            auth: {
              role: hello?.auth?.role,
              scopes: hello?.auth?.scopes,
              ...(change === "recovery owner changes"
                ? { recoveryScope: "different-recovery-owner" }
                : {}),
            },
          });
        }
        await gateway.setOnline(false);
        await waitForControlUiGatewayReconnecting(page);
        await gateway.setOnline(true);
        await waitForControlUiGatewayReady(page);
        await waitForGatewayRecoveryScope(page);

        await page
          .getByRole("alert")
          .filter({
            hasText:
              "The Gateway changed while this session was starting. Check recent sessions before starting this task again.",
          })
          .waitFor();
        // Restarts keep the same draft owner; changed or missing owners cannot inherit its text.
        const expectedMessage = change === "process restarts" ? "do not duplicate this task" : "";
        await expect
          .poll(() => page.locator(".new-session-page__message").inputValue())
          .toBe(expectedMessage);
        expect(await page.locator(".new-session-page__starting").isVisible()).toBe(false);
        expect(await page.getByRole("button", { name: "Start session" }).isDisabled()).toBe(true);
        expect(await gateway.getRequests("sessions.create")).toHaveLength(1);
        expect(new URL(page.url()).pathname).toBe("/new");
      });
    },
  );

  it("resets agent-derived workspace state when retargeted to a catalog", async () => {
    await withNewSessionPage(DESKTOP_CONTEXT, async (page) => {
      const gateway = await installMockGateway(page, {
        cliAgentsEnabled: true,
        terminalEnabled: true,
        featureMethods: [
          "sessions.catalog.list",
          "sessions.catalog.startTerminal",
          "terminal.open",
        ],
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
          "worktrees.branches": branchList(),
          "sessions.catalog.list": {
            catalogs: [
              {
                id: "claude",
                label: "Claude Code",
                capabilities: {
                  continueSession: true,
                  archive: false,
                  startTerminal: true,
                },
                hosts: [
                  {
                    hostId: "gateway:local",
                    label: "Local Claude Code",
                    kind: "gateway",
                    connected: true,
                    canStartTerminal: true,
                    sessions: [],
                  },
                ],
              },
            ],
          },
          "sessions.catalog.startTerminal": { sessionId: "claude-retarget" },
        },
      });
      await page.goto(`${suite.server.baseUrl}new?agent=research`);
      const folderLabel = page.locator(
        "#new-session-project-trigger .new-session-page__trigger-label",
      );
      await pollLocatorText(folderLabel).toBe("research");

      await page.evaluate(() => {
        history.pushState(null, "", "new?agent=main&catalog=claude");
        dispatchEvent(new PopStateEvent("popstate"));
      });

      await pollLocatorText(page.locator(".new-session-page__runtime")).toContain("Claude Code");
      await pollLocatorText(folderLabel).toBe("openclaw");
      await page.locator(".new-session-page__message").fill("retarget this draft");
      await page.getByRole("button", { name: "Start in terminal" }).click();

      const create = await gateway.waitForRequest("sessions.catalog.startTerminal");
      expect(create.params).toMatchObject({
        agentId: "main",
        initialMessage: "retarget this draft",
        catalogId: "claude",
      });
      expect(create.params).not.toHaveProperty("model");
      expect(create.params).toHaveProperty("cwd", WORKSPACE);
    });
  });
});
