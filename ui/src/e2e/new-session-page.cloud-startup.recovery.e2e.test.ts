import { expect, it } from "vitest";
import {
  SESSION_LIST_DEFAULTS,
  WORKSPACE,
  controlUiSessionPath,
  createNewSessionPageE2eSuite,
  installMockGateway,
  pollLocatorText,
  replaceGatewayClient,
} from "./new-session-page.test-support.ts";

const suite = createNewSessionPageE2eSuite();

suite.define(() => {
  it("retries an ambiguous cloud create with the same session key and machine class", async () => {
    const context = await suite.browser.newContext({ locale: "en-US", serviceWorkers: "block" });
    const page = await context.newPage();
    const message = "recover the cloud create";
    const gateway = await installMockGateway(page, {
      deferredMethods: ["sessions.create"],
      workspaceGit: true,
      methodResponses: {
        "agents.list": {
          agents: [
            {
              id: "cloud",
              identity: { name: "Cloud" },
              name: "Cloud",
              workspace: WORKSPACE,
              workspaceGit: true,
            },
          ],
          defaultId: "cloud",
          mainKey: "main",
          scope: "agent",
        },
        "environments.list": {
          environments: [],
          profiles: [
            {
              id: "aws",
              providerId: "crabbox",
              machines: [
                { id: "standard", label: "Standard", default: true },
                { id: "fast", label: "Fast" },
              ],
            },
          ],
        },
        "worktrees.branches": {
          branches: [{ kind: "local", name: "main" }],
          defaultBranch: "main",
          repositoryStatus: "git",
        },
        "sessions.dispatch": {
          placement: { state: "active", environmentId: "worker-create-recovery" },
        },
        "sessions.send": { runId: "run-create-recovery", status: "started" },
      },
    });

    try {
      await page.goto(`${suite.server.baseUrl}new`);
      await gateway.waitForRequest("environments.list");
      await page.locator("#new-session-where-trigger").click();
      await page
        .locator("wa-popover.new-session-page__where-popover")
        .getByRole("button", { name: "Cloud · aws" })
        .click();
      await page.locator("#new-session-where-trigger").click();
      await page.locator('[data-value="machine:fast"]').click();
      await expect
        .poll(() => page.locator("#new-session-where-trigger").getAttribute("data-machine-class"))
        .toBe("fast");
      await page.locator(".new-session-page__message").fill(message);
      await page.getByRole("button", { name: "Start session" }).click();
      const firstCreate = await gateway.waitForRequest("sessions.create");
      const firstKey = (firstCreate.params as { key?: string }).key;
      if (!firstKey) {
        throw new Error("expected the first recovery create to include a session key");
      }
      expect(firstKey).toMatch(/^agent:cloud:dashboard:/);

      await gateway.setMethodResponse("environments.list", {
        environments: [],
        profiles: [{ id: "aws", providerId: "crabbox" }],
      });
      await page.reload();
      await gateway.waitForRequest("environments.list");
      await expect
        .poll(() => page.locator(".new-session-page__message").inputValue())
        .toBe(message);
      await pollLocatorText(
        page.locator("#new-session-where-trigger .new-session-page__trigger-label"),
      ).toBe("aws · fast");
      await page.getByRole("button", { name: "Start session" }).click();
      const retryCreate = await gateway.waitForRequest("sessions.create");
      expect(retryCreate.params).toMatchObject({ key: firstKey, message: "", worktree: true });
      await gateway.resolveDeferred("sessions.create", { key: firstKey });

      expect(await gateway.waitForRequest("sessions.dispatch")).toMatchObject({
        params: { key: firstKey, agentId: "cloud", profileId: "aws", machineClass: "fast" },
      });
      expect(await gateway.waitForRequest("sessions.send")).toMatchObject({
        params: { key: firstKey, agentId: "cloud", message },
      });
      await page.waitForURL((url) => url.pathname === controlUiSessionPath(firstKey), {
        timeout: 30_000,
      });
    } finally {
      await context.close();
    }
  });

  it("keeps the original recovery identity when a cloud create settles after reset", async () => {
    const context = await suite.browser.newContext({ locale: "en-US", serviceWorkers: "block" });
    const page = await context.newPage();
    const message = "preserve this late cloud create";
    const gateway = await installMockGateway(page, {
      deferredMethods: ["sessions.create", "sessions.delete"],
      workspaceGit: true,
      methodResponses: {
        "agents.list": {
          agents: [
            {
              id: "cloud",
              identity: { name: "Cloud" },
              name: "Cloud",
              workspace: WORKSPACE,
              workspaceGit: true,
            },
          ],
          defaultId: "cloud",
          mainKey: "main",
          scope: "agent",
        },
        "environments.list": {
          environments: [],
          profiles: [{ id: "aws", providerId: "crabbox" }],
        },
        "sessions.describe": {
          session: { sessionId: "session-late-cloud-create" },
        },
        "sessions.patch": { ok: true },
        "worktrees.branches": {
          branches: [{ kind: "local", name: "main" }],
          defaultBranch: "main",
          repositoryStatus: "git",
        },
      },
    });

    const readRecovery = () =>
      page.evaluate(() => {
        const key = Object.keys(sessionStorage).find((candidate) =>
          candidate.startsWith("openclaw.new-session.session-placement-recovery.v1:"),
        );
        return key ? (JSON.parse(sessionStorage.getItem(key) ?? "null") as unknown) : null;
      });

    try {
      await page.goto(`${suite.server.baseUrl}new`);
      await gateway.waitForRequest("environments.list");
      await page.locator("#new-session-where-trigger").click();
      await page
        .locator("wa-popover.new-session-page__where-popover")
        .getByRole("button", { name: "Cloud · aws" })
        .click();
      await page.locator(".new-session-page__message").fill(message);
      await page.getByRole("button", { name: "Start session" }).click();
      const create = await gateway.waitForRequest("sessions.create");
      const sessionKey = (create.params as { key: string }).key;
      const staged = await readRecovery();

      await page.evaluate(() => {
        history.pushState(null, "", "new?agent=cloud");
        dispatchEvent(new PopStateEvent("popstate"));
      });
      await gateway.resolveDeferred("sessions.create", { key: sessionKey });
      const archive = await gateway.waitForRequest("sessions.patch");
      expect(archive.params).toMatchObject({
        key: sessionKey,
        agentId: "cloud",
        archived: true,
        expectedSessionId: "session-late-cloud-create",
      });
      await gateway.waitForRequest("sessions.delete");
      await gateway.rejectDeferred("sessions.delete", {
        code: "UNAVAILABLE",
        message: "cleanup unavailable",
      });
      await expect
        .poll(async () =>
          (await gateway.getRequests("sessions.patch")).some(
            (request) => (request.params as { archived?: unknown }).archived === false,
          ),
        )
        .toBe(true);

      await pollLocatorText(
        page.locator(".new-session-page__error").filter({ hasText: "cleanup unavailable" }),
      ).toContain("cleanup unavailable");
      const stagedIdentity = staged as {
        messageId: string;
        target: { kind: "profile"; profileId: string };
        agentId: string;
      };
      expect(await readRecovery()).toMatchObject({
        sessionKey,
        messageId: stagedIdentity.messageId,
        message,
        target: stagedIdentity.target,
        agentId: stagedIdentity.agentId,
        phase: "dispatching",
      });
    } finally {
      await context.close();
    }
  });

  it("retries an unpersisted cloud turn with its original recovery identity", async () => {
    const context = await suite.browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const sessionKey = "agent:cloud:storage-recovery";
    const message = "keep this cloud recovery task";
    const gateway = await installMockGateway(page, {
      deferredMethods: ["sessions.send"],
      workspaceGit: true,
      methodResponses: {
        "agents.list": {
          agents: [
            {
              id: "cloud",
              identity: { name: "Cloud" },
              name: "Cloud",
              workspace: WORKSPACE,
              workspaceGit: true,
            },
          ],
          defaultId: "cloud",
          mainKey: "main",
          scope: "agent",
        },
        "environments.list": {
          environments: [],
          profiles: [{ id: "aws", providerId: "crabbox" }],
        },
        "worktrees.branches": {
          branches: [{ kind: "local", name: "main" }],
          defaultBranch: "main",
          repositoryStatus: "git",
        },
        "sessions.create": { key: sessionKey },
        "sessions.dispatch": {
          ok: true,
          key: sessionKey,
          sessionId: "session-storage-recovery",
          placement: {
            state: "active",
            generation: 1,
            createdAtMs: 1,
            updatedAtMs: 2,
            stateChangedAtMs: 2,
            environmentId: "worker-storage-recovery",
            activeOwnerEpoch: 1,
            workerBundleHash: "a".repeat(64),
            workspaceBaseManifestRef: "manifest-storage-recovery",
            remoteWorkspaceDir: "/workspace",
          },
        },
        "sessions.list": {
          count: 1,
          defaults: SESSION_LIST_DEFAULTS,
          path: "",
          sessions: [{ key: sessionKey, kind: "direct", updatedAt: Date.now() }],
          ts: Date.now(),
        },
        "chat.history": {
          messages: [],
          sessionId: "session-storage-recovery",
          sessionInfo: { hasActiveRun: false, key: sessionKey, status: "done" },
        },
      },
    });

    try {
      await page.goto(`${suite.server.baseUrl}new`);
      await gateway.waitForRequest("environments.list");
      await page.locator("#new-session-where-trigger").click();
      await page
        .locator("wa-popover.new-session-page__where-popover")
        .getByRole("button", { name: "Cloud · aws" })
        .click();
      await page.evaluate(() => {
        const originalSetItem = sessionStorage.setItem.bind(sessionStorage);
        Storage.prototype.setItem = function (key: string, value: string) {
          if (
            key.startsWith("openclaw.new-session.session-placement-recovery.v1:") ||
            key.startsWith("openclaw.control-ui-e2e.")
          ) {
            originalSetItem(key, value);
            return;
          }
          throw new DOMException("composer storage disabled", "SecurityError");
        };
      });
      await page.locator(".new-session-page__message").fill(message);
      await page.getByRole("button", { name: "Start session" }).click();
      const firstSend = await gateway.waitForRequest("sessions.send");
      await gateway.rejectDeferred("sessions.send", {
        code: "UNAVAILABLE",
        message: "send outcome unknown",
      });

      await page.waitForURL((url) => url.pathname === controlUiSessionPath(sessionKey));
      await pollLocatorText(page.locator(".chat-cloud-startup-error")).toContain(
        "send outcome unknown",
      );
      await replaceGatewayClient(page);
      await expect.poll(async () => (await gateway.getRequests("sessions.send")).length).toBe(2);

      const sends = await gateway.getRequests("sessions.send");
      expect(sends).toHaveLength(2);
      expect(sends[1]?.params).toMatchObject({
        idempotencyKey: (firstSend.params as { idempotencyKey: string }).idempotencyKey,
        key: sessionKey,
        message,
      });
      expect(await gateway.getRequests("sessions.create")).toHaveLength(1);
      const dispatches = await gateway.getRequests("sessions.dispatch");
      expect(dispatches).toHaveLength(2);
      expect(dispatches[1]?.params).toMatchObject({ profileId: "aws" });
    } finally {
      await context.close();
    }
  });
});
