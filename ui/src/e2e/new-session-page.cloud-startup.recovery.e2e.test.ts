import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import {
  SESSION_LIST_DEFAULTS,
  WORKSPACE,
  controlUiSessionPath,
  createNewSessionPageE2eSuite,
  installMockGateway,
  ONE_PIXEL_PNG_B64,
  pastePng,
  pollLocatorText,
  replaceGatewayClient,
  waitForCommittedChatRoute,
} from "./new-session-page.test-support.ts";

const suite = createNewSessionPageE2eSuite();
const captureUiProof = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
const proofDir = path.resolve(
  process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR?.trim() || ".artifacts/control-ui-e2e",
  "cloud-session-recovery",
);

suite.define(() => {
  it("retries an ambiguous cloud create with the same session key and machine class", async () => {
    const context = await suite.browser.newContext({ locale: "en-US", serviceWorkers: "block" });
    const page = await context.newPage();
    const message = "recover the cloud create";
    const gateway = await installMockGateway(page, {
      deferredMethods: ["sessions.create"],
      agentModel: "openai/gpt-5.6-luna",
      models: [
        {
          id: "gpt-5.6-luna",
          provider: "openai",
          name: "Luna",
          reasoning: true,
          effectiveFastMode: true,
        },
      ],
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
        "sessions.describe": { session: { sessionId: "session-create-recovery" } },
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
      await pastePng(page.locator(".new-session-page__message"));
      await page.locator('[data-chat-thinking-select="true"]').click();
      const fastMode = page.locator("[data-chat-speed-toggle]");
      await expect.poll(() => fastMode.getAttribute("aria-checked")).toBe("true");
      await fastMode.click();
      await expect.poll(() => fastMode.getAttribute("aria-checked")).toBe("false");
      await page.keyboard.press("Escape");
      await page.getByRole("button", { name: "Start session" }).click();
      const firstCreate = await gateway.waitForRequest("sessions.create");
      expect(firstCreate.params).toMatchObject({ fastMode: false });
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
      expect(retryCreate.params).toMatchObject({
        key: firstKey,
        message: "",
        worktree: true,
        fastMode: false,
      });
      expect(await gateway.getRequests("sessions.dispatch")).toHaveLength(0);
      await gateway.deferNext("sessions.dispatch");
      await gateway.resolveDeferred("sessions.create", { key: firstKey });

      expect(await gateway.waitForRequest("sessions.dispatch")).toMatchObject({
        params: { key: firstKey, agentId: "cloud", profileId: "aws", machineClass: "fast" },
      });
      expect(await gateway.getRequests("sessions.send")).toHaveLength(0);
      await gateway.resolveDeferred("sessions.dispatch");
      expect(await gateway.waitForRequest("sessions.send")).toMatchObject({
        params: {
          key: firstKey,
          agentId: "cloud",
          message,
          attachments: [{ fileName: "pixel.png", content: ONE_PIXEL_PNG_B64 }],
        },
      });
      expect(await gateway.getRequests("sessions.create")).toHaveLength(1);
      expect(await gateway.getRequests("sessions.dispatch")).toHaveLength(1);
      expect(await gateway.getRequests("sessions.send")).toHaveLength(1);
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

  it.each([
    { name: "successful", cleanupError: undefined },
    { name: "failed", cleanupError: "cleanup unavailable" },
  ])(
    "keeps the replacement cloud task intact after $name late cleanup",
    async ({ cleanupError }) => {
      const viewport = { height: 900, width: 1_280 };
      const context = await suite.browser.newContext({
        locale: "en-US",
        serviceWorkers: "block",
        viewport,
        ...(captureUiProof ? { recordVideo: { dir: proofDir, size: viewport } } : {}),
      });
      const page = await context.newPage();
      const message = "restart this interrupted cloud task";
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
            profiles: [{ id: "aws", providerId: "crabbox" }],
          },
          "worktrees.branches": {
            branches: [{ kind: "local", name: "main" }],
            defaultBranch: "main",
            repositoryStatus: "git",
          },
          "sessions.describe": { session: { sessionId: "session-abandoned-create" } },
          "sessions.patch": { ok: true },
          "sessions.delete": { deleted: true },
          "sessions.dispatch": {
            placement: { state: "active", environmentId: "worker-replacement-create" },
          },
          "sessions.send": { runId: "run-replacement-create", status: "started" },
        },
      });
      const readRecovery = () =>
        page.evaluate(() => {
          const key = Object.keys(sessionStorage).find((candidate) =>
            candidate.startsWith("openclaw.new-session.session-placement-recovery.v1:"),
          );
          return key
            ? (JSON.parse(sessionStorage.getItem(key) ?? "null") as {
                sessionKey: string;
                message: string;
                messageId: string;
                phase: string;
                target: { kind: string; profileId: string };
              })
            : null;
        });

      try {
        await page.goto(`${suite.server.baseUrl}new`);
        await gateway.waitForRequest("environments.list");
        await page.locator("#new-session-where-trigger").click();
        await page
          .locator("wa-popover.new-session-page__where-popover")
          .getByRole("button", { name: "Cloud · aws" })
          .click();
        const composer = page.locator(".new-session-page__message");
        await composer.fill(message);
        const start = page.getByRole("button", { name: "Start session" });
        await start.click();
        const firstCreate = await gateway.waitForRequest("sessions.create");
        const abandonedKey = String((firstCreate.params as { key?: string }).key);

        await page.evaluate(() => {
          history.pushState(null, "", "new?agent=cloud");
          dispatchEvent(new PopStateEvent("popstate"));
        });
        const interrupted = page.getByRole("alert").filter({ hasText: "interrupted" });
        await interrupted.waitFor();
        await expect.poll(() => composer.isDisabled()).toBe(true);
        await expect.poll(() => start.isDisabled()).toBe(true);
        if (captureUiProof) {
          await mkdir(proofDir, { recursive: true });
          await page.screenshot({
            path: path.join(proofDir, "01-interrupted.png"),
            fullPage: true,
          });
        }
        const reset = interrupted.getByRole("button", { name: "Reset", exact: true });
        expect(await reset.count()).toBe(1);
        await reset.click();

        await expect.poll(() => interrupted.count()).toBe(0);
        await expect.poll(() => composer.isEnabled()).toBe(true);
        await expect.poll(() => composer.inputValue()).toBe(message);
        await expect.poll(() => start.isEnabled()).toBe(true);
        expect(await readRecovery()).toBeNull();
        if (captureUiProof) {
          await page.screenshot({ path: path.join(proofDir, "02-recovered.png"), fullPage: true });
        }

        const previousCreateCount = (await gateway.getRequests("sessions.create")).length;
        await gateway.deferNext("sessions.create");
        await start.click();
        const nextCreate = await gateway.waitForRequest("sessions.create", {
          after: previousCreateCount,
        });
        const nextKey = String((nextCreate.params as { key?: string }).key);
        expect(nextKey).not.toBe(abandonedKey);
        const nextRecovery = await readRecovery();
        expect(nextRecovery).toMatchObject({
          sessionKey: nextKey,
          message,
          phase: "creating",
          target: { kind: "profile", profileId: "aws" },
        });

        await gateway.deferNext("sessions.delete");
        await gateway.resolveDeferred("sessions.create", { key: abandonedKey });
        const deleted = await gateway.waitForRequest("sessions.delete");
        expect(deleted.params).toMatchObject({
          key: abandonedKey,
          archivedOnly: true,
          expectedSessionId: "session-abandoned-create",
        });
        if (cleanupError) {
          await gateway.rejectDeferred("sessions.delete", {
            code: "UNAVAILABLE",
            message: cleanupError,
          });
          await pollLocatorText(
            page.locator(".new-session-page__error").filter({ hasText: cleanupError }),
          ).toContain(cleanupError);
        } else {
          await gateway.resolveDeferred("sessions.delete", { deleted: true });
        }
        await expect.poll(readRecovery).toMatchObject({
          sessionKey: nextKey,
          messageId: nextRecovery?.messageId,
          message,
          phase: "creating",
        });

        await gateway.resolveDeferred("sessions.create", { key: nextKey });
        expect(await gateway.waitForRequest("sessions.dispatch")).toMatchObject({
          params: { key: nextKey, agentId: "cloud", profileId: "aws" },
        });
        expect(await gateway.waitForRequest("sessions.send")).toMatchObject({
          params: { key: nextKey, agentId: "cloud", message },
        });
        await page.waitForURL((url) => url.pathname === controlUiSessionPath(nextKey), {
          timeout: 30_000,
        });
      } finally {
        await context.close();
      }
    },
  );

  it("checks an unconfirmed cloud turn without replay when composer storage is unavailable", async () => {
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
      await pastePng(page.locator(".new-session-page__message"));
      await page.getByRole("button", { name: "Start session" }).click();
      const firstSend = await gateway.waitForRequest("sessions.send");
      await waitForCommittedChatRoute(page);
      await gateway.rejectDeferred("sessions.send", {
        code: "UNAVAILABLE",
        message: "send outcome unknown",
      });

      const alert = page.getByRole("alert").filter({ hasText: "send outcome unknown" });
      await pollLocatorText(alert).toContain("send outcome unknown");
      expect(new URL(page.url()).pathname).toBe(controlUiSessionPath(sessionKey));
      await replaceGatewayClient(page);
      const retainedTurn = page.locator(".chat-group.user", { hasText: message });
      const checkDelivery = retainedTurn.getByRole("button", {
        name: "Check delivery",
        exact: true,
      });
      await checkDelivery.waitFor({ state: "visible" });
      const historyCount = (await gateway.getRequests("chat.history")).length;
      await checkDelivery.click();
      expect(await gateway.waitForRequest("chat.history", { after: historyCount })).toMatchObject({
        params: { sessionKey, limit: 1000 },
      });
      await pollLocatorText(page.getByRole("alert")).toContain("No matching user message");
      await retainedTurn
        .locator(`img[src="data:image/png;base64,${ONE_PIXEL_PNG_B64}"]`)
        .waitFor({ state: "visible" });
      await expect
        .poll(() => page.locator(".agent-chat__composer-combobox textarea").isDisabled())
        .toBe(true);
      const recovery = await page.evaluate(() => {
        const key = Object.keys(sessionStorage).find((candidate) =>
          candidate.startsWith("openclaw.new-session.session-placement-recovery.v1:"),
        );
        return key ? JSON.parse(sessionStorage.getItem(key) ?? "null") : null;
      });
      expect(recovery).toMatchObject({
        phase: "paused",
        reason: "unconfirmed",
        messageId: (firstSend.params as { idempotencyKey: string }).idempotencyKey,
        sessionKey,
        message,
        attachments: [{ fileName: "pixel.png", content: ONE_PIXEL_PNG_B64 }],
        target: { kind: "profile", profileId: "aws" },
      });
      expect(await gateway.getRequests("sessions.create")).toHaveLength(1);
      expect(await gateway.getRequests("sessions.send")).toHaveLength(1);
      expect(await gateway.getRequests("sessions.dispatch")).toHaveLength(1);
      expect(await gateway.getRequests("sessions.reclaim")).toHaveLength(0);
    } finally {
      await context.close();
    }
  });
});
