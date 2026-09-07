import { writeFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { takeControlUiViewportScreenshot } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { controlUiBundledGatewayUrl } from "../test-helpers/control-ui-e2e.ts";
import {
  controlUiSessionUrl,
  createChatFlowE2eSuite,
  expectRequestCountStable,
  installMockGateway,
  requireRecord,
  requireString,
  waitForRequests,
} from "./chat-flow.test-support.ts";

const suite = createChatFlowE2eSuite();
const artifactRoot = ".artifacts/mock-session-owner/outbox-recovery";

suite.define(() => {
  it.each(["retry", "discard", "exact authoritative history proof"] as const)(
    "parks an ACK-lost send for review until %s",
    async (action) => {
      const proofRoot = process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR?.trim();
      const artifactDir = proofRoot
        ? createControlUiE2eArtifactDir("chat-outbox-recovery", proofRoot)
        : undefined;
      await suite.withPage(
        {
          locale: "en-US",
          ...(artifactDir
            ? { recordVideo: { dir: artifactDir, size: { height: 900, width: 1280 } } }
            : {}),
          serviceWorkers: "block",
          viewport: { height: 900, width: 1280 },
        },
        async ({ page }) => {
          const captureProof = async (name: string) => {
            if (artifactDir) {
              await writeFile(
                `${artifactDir}/${name}.png`,
                await takeControlUiViewportScreenshot(page, page.locator(".shell"), [
                  page.locator(".agent-chat__composer-combobox textarea"),
                ]),
              );
            }
          };
          const gateway = await installMockGateway(page, {
            methodResponses: {
              "chat.history": {
                messages: [],
                sessionId: "session:agent:main:main",
                sessionInfo: { hasActiveRun: false, status: "done" },
                thinkingLevel: null,
              },
            },
          });

          await page.goto(`${suite.server.baseUrl}chat`);
          await gateway.deferNext("chat.send");

          const prompt =
            action === "exact authoritative history proof"
              ? "already accepted after the reconnect"
              : "retry with the same key";
          await page.locator(".agent-chat__composer-combobox textarea").fill(prompt);
          await page.getByRole("button", { name: "Send message" }).click();

          const firstRequest = await gateway.waitForRequest("chat.send");
          const firstParams = requireRecord(firstRequest.params);
          const runId = requireString(firstParams.idempotencyKey, "first idempotency key");

          await gateway.closeLatest(1006, "lost ack");

          const deliveryStatus = page.locator('.chat-send-status[data-send-state="unconfirmed"]');
          await deliveryStatus.getByText("Delivery unconfirmed").waitFor({ timeout: 10_000 });
          expect(await page.locator(".chat-queue").count()).toBe(0);
          const userBubble = page.locator(".chat-group.user").getByText(prompt, { exact: true });
          await userBubble.waitFor();
          expect(await gateway.getRequests("chat.send")).toHaveLength(1);

          if (action === "exact authoritative history proof") {
            await captureProof("01-delivery-uncertain");

            await gateway.setHistoryMessages([
              {
                content: "different delivered turn",
                idempotencyKey: "different-run:user",
                role: "user",
                timestamp: Date.now(),
              },
            ]);
            await gateway.emitGatewayEvent("session.message", {
              hasActiveRun: false,
              messageId: "different-history-turn",
              messageSeq: 1,
              sessionKey: "main",
              status: "done",
            });
            await deliveryStatus.getByText("Delivery unconfirmed").waitFor({ timeout: 10_000 });
            expect(await gateway.getRequests("chat.send")).toHaveLength(1);
            await captureProof("02-different-key-still-uncertain");

            await gateway.setHistoryMessages([
              {
                content: prompt,
                idempotencyKey: `${runId}:user`,
                role: "user",
                timestamp: Date.now(),
              },
            ]);
            await gateway.emitGatewayEvent("session.message", {
              clientRunId: runId,
              hasActiveRun: true,
              messageId: "accepted-history-turn",
              messageSeq: 2,
              sessionKey: "main",
              status: "running",
            });

            await deliveryStatus.waitFor({ state: "detached", timeout: 10_000 });
            await userBubble.waitFor({ timeout: 10_000 });
            expect(await userBubble.count()).toBe(1);
            expect(await gateway.getRequests("chat.send")).toHaveLength(1);
            await captureProof("03-delivery-proven");
            return;
          }

          if (action === "discard") {
            await page
              .locator(".agent-chat__composer-combobox textarea")
              .fill("send the next message");
            await page.getByRole("button", { name: "Send message" }).click();
            await page
              .locator(".chat-queue")
              .getByText("send the next message", { exact: true })
              .waitFor();
            await expectRequestCountStable(gateway, "chat.send", 1);
            await captureProof("discard-before");
            await deliveryStatus.getByRole("button", { name: "Discard", exact: true }).click();
          } else {
            await deliveryStatus.getByRole("button", { name: "Retry queued message" }).click();
          }

          const sends = await waitForRequests(gateway, "chat.send", 2);
          const secondParams = requireRecord(sends[1]?.params);
          expect(secondParams.sessionKey).toBe(firstParams.sessionKey);
          if (action === "discard") {
            expect(secondParams.idempotencyKey).not.toBe(runId);
            expect(secondParams.message).toBe("send the next message");
            await userBubble.waitFor({ state: "detached" });
            expect(await gateway.getRequests("chat.abort")).toHaveLength(0);
            expect(await gateway.getRequests("sessions.abort")).toHaveLength(0);
          } else {
            expect(secondParams.idempotencyKey).toBe(runId);
            expect(secondParams.message).toBe(prompt);
          }
          await expectRequestCountStable(gateway, "chat.send", 2);
          await deliveryStatus.waitFor({ state: "detached", timeout: 10_000 });
          if (action === "discard") {
            await captureProof("discard-after");
          }
        },
      );
    },
  );

  it("keeps a legacy uncertain send unsent until destination confirmation and explicit Retry", async () => {
    const artifacts = createControlUiE2eArtifactDir("legacy-send", artifactRoot);
    const context = await suite.newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { width: 1280, height: 900 },
      recordVideo: { dir: artifacts },
    });
    const page = await context.newPage();
    const sessionKey = "agent:main:main";
    const gateway = await installMockGateway(page, { sessionKey });
    const gatewayAddress = controlUiBundledGatewayUrl(suite.server.baseUrl);
    await page.addInitScript(
      ({ gatewayUrl }) => {
        if (sessionStorage.getItem("outbox-recovery-seeded")) {
          return;
        }
        sessionStorage.setItem("outbox-recovery-seeded", "yes");
        sessionStorage.setItem(
          `openclaw.control.chatComposer.v2:${encodeURIComponent(gatewayUrl)}`,
          JSON.stringify({
            version: 2,
            gatewayOwner: gatewayUrl,
            sessions: {
              "global\u0000agent:main": {
                updatedAt: 1,
                queue: [
                  {
                    id: "old-followup",
                    text: "Please check the deployment notes",
                    createdAt: 1,
                    sessionKey: "global",
                    agentId: "main",
                    sendRunId: "old-attempt",
                    sendAttempts: 1,
                    sendState: "unconfirmed",
                  },
                ],
              },
            },
          }),
        );
      },
      { gatewayUrl: gatewayAddress },
    );
    try {
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
      const notice = page.locator(".chat-outbox-recovery");
      await notice.locator("summary").click();
      await notice.getByText("Please check the deployment notes").waitFor();
      await expectRequestCountStable(gateway, "chat.send", 0);
      await page.screenshot({
        animations: "disabled",
        path: `${artifacts}/before-confirmation.png`,
      });
      await notice.getByRole("button", { name: "Restore here for review" }).click();
      const dialog = page.locator("openclaw-modal-dialog");
      await dialog.getByText("agent:main:main (main)", { exact: true }).waitFor();
      await page.screenshot({
        animations: "disabled",
        path: `${artifacts}/destination-confirmation.png`,
      });
      await dialog.getByRole("button", { name: "Restore here for review" }).click();
      await page
        .locator(".chat-group.user")
        .getByText("Please check the deployment notes")
        .waitFor();
      await expectRequestCountStable(gateway, "chat.send", 0);
      await page.reload();
      await page
        .locator(".chat-group.user")
        .getByText("Please check the deployment notes")
        .waitFor();
      await expectRequestCountStable(gateway, "chat.send", 0);
      await page.screenshot({
        animations: "disabled",
        path: `${artifacts}/recovered-paused-after-reload.png`,
      });
      await page.locator(".chat-group.user").getByRole("button", { name: /Retry/i }).click();
      const request = await gateway.waitForRequest("chat.send");
      expect(requireRecord(request.params)).toMatchObject({
        sessionKey,
        message: "Please check the deployment notes",
      });
      expect(
        (await gateway.getRequests("chat.history")).every(
          (historyRequest) => requireRecord(historyRequest.params).sessionKey === sessionKey,
        ),
      ).toBe(true);
    } finally {
      await suite.closeBrowserContext(context);
    }
  });
  it.each(["agent:main:main", "global", "agent:work:workspace"])(
    "keeps exact history and send targets for %s across offline reload and agent navigation",
    async (sessionKey) => {
      const context = await suite.newBrowserContext({ locale: "en-US", serviceWorkers: "block" });
      const page = await context.newPage();
      const otherKey = "agent:other:thread";
      const mainKey = sessionKey.endsWith(":workspace") ? "workspace" : "main";
      const gateway = await installMockGateway(page, {
        sessionKey,
        sessionScope: sessionKey === "global" ? "global" : "agent",
        mainSessionKey: sessionKey === "global" ? "global" : `agent:main:${mainKey}`,
        methodResponses: {
          "agents.list": {
            defaultId: "main",
            mainKey,
            scope: sessionKey === "global" ? "global" : "per-sender",
            agents: ["main", "other", "work"].map((id) => ({
              id,
              name: id,
              model: { primary: "openai/gpt-5.5" },
            })),
          },
        },
        sessions: [sessionKey, otherKey].map((key) => ({
          key,
          kind: key === "global" ? "global" : "direct",
          label: key,
          updatedAt: 1,
          hasActiveRun: false,
          activeRunIds: [],
        })),
      });
      try {
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
        const composer = page.locator(".agent-chat__composer-combobox textarea");
        await composer.waitFor();
        await gateway.setOnline(false);
        await page.locator('.agent-chat__composer-underlaps[data-tone="warn"]').waitFor();
        await composer.fill(`retain destination ${sessionKey}`);
        await page.getByRole("button", { name: "Send message" }).click();
        await page.locator(".chat-queue").getByText("Waiting for reconnect").waitFor();
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, otherKey));
        await gateway.setOnline(true);
        await page.locator(".agent-chat__composer-combobox textarea").waitFor();
        const request = await gateway.waitForRequest("chat.send");
        expect(requireRecord(request.params)).toMatchObject({
          sessionKey,
          message: `retain destination ${sessionKey}`,
          ...(sessionKey === "global" ? { agentId: "main" } : {}),
        });
        const history = (await gateway.getRequests("chat.history"))
          .map((historyRequest) => requireRecord(historyRequest.params))
          .filter((params) => params.limit === 1000);
        expect(history.length).toBeGreaterThan(0);
        expect(
          history.every(
            (params) =>
              params.sessionKey === sessionKey &&
              (sessionKey !== "global" || params.agentId === "main"),
          ),
        ).toBe(true);
      } finally {
        await suite.closeBrowserContext(context);
      }
    },
  );

  it("recovers an ambiguous IndexedDB attachment draft through rendered controls without sending", async () => {
    const artifacts = createControlUiE2eArtifactDir("attachment-draft", artifactRoot);
    const context = await suite.newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { width: 1280, height: 900 },
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page);
    const gatewayAddress = controlUiBundledGatewayUrl(suite.server.baseUrl);
    try {
      // Seed the legacy database before app boot can open the current version.
      await page.route("**/outbox-recovery-seed", (route) =>
        route.fulfill({ contentType: "text/html", body: "Mock recovery seed" }),
      );
      await page.goto(`${suite.server.baseUrl}outbox-recovery-seed`);
      const seededDatabaseVersion = await page.evaluate(async (gatewayOwner) => {
        const request = indexedDB.open("openclaw-control-ui", 1);
        request.addEventListener(
          "upgradeneeded",
          () => {
            const store = request.result.createObjectStore("composerDrafts", { keyPath: "key" });
            store.createIndex("ownerKey", "ownerKey", { unique: false });
          },
          { once: true },
        );
        const db = await new Promise<IDBDatabase>((resolve, reject) => {
          request.addEventListener("success", () => resolve(request.result), { once: true });
          request.addEventListener(
            "error",
            () => reject(request.error ?? new Error("IndexedDB open failed")),
            { once: true },
          );
        });
        const tx = db.transaction("composerDrafts", "readwrite");
        const recoveryScope = "e2e-recovery-scope";
        const scopeKey = "global\u0000agent:main";
        tx.objectStore("composerDrafts").put({
          key: JSON.stringify([gatewayOwner, recoveryScope, scopeKey]),
          ownerKey: JSON.stringify([gatewayOwner, recoveryScope]),
          gatewayOwner,
          recoveryScope,
          scopeKey,
          revision: 42,
          writeId: "legacy-attachment",
          updatedAt: Date.now(),
          text: "Review the attached deployment note",
          attachments: [
            {
              blob: new Blob(["deployment note"], { type: "text/plain" }),
              mimeType: "text/plain",
              fileName: "legacy-note.txt",
              sizeBytes: 15,
            },
          ],
        });
        await new Promise<void>((resolve, reject) => {
          tx.addEventListener("complete", () => resolve(), { once: true });
          tx.addEventListener(
            "error",
            () => reject(tx.error ?? new Error("IndexedDB write failed")),
            { once: true },
          );
        });
        db.close();
        return db.version;
      }, gatewayAddress);
      expect(seededDatabaseVersion).toBe(1);
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, "agent:main:main"));
      const notice = page.locator(".chat-outbox-recovery");
      await notice.locator("summary").click();
      await notice.getByText("legacy-note.txt", { exact: true }).waitFor();
      await notice.getByRole("button", { name: "Restore here for review" }).click();
      await page
        .locator("openclaw-modal-dialog")
        .getByRole("button", { name: "Restore here for review" })
        .click();
      const composer = page.locator(".agent-chat__composer-combobox textarea");
      await expect.poll(() => composer.inputValue()).toBe("Review the attached deployment note");
      await page.screenshot({
        animations: "disabled",
        path: `${artifacts}/attachment-after-confirmation.png`,
      });
      await page
        .locator(".chat-attachments-preview .chat-attachment-file__name")
        .getByText("legacy-note.txt", { exact: true })
        .waitFor();
      await page.reload();
      await expect.poll(() => composer.inputValue()).toBe("Review the attached deployment note");
      await page
        .locator(".chat-attachments-preview .chat-attachment-file__name")
        .getByText("legacy-note.txt", { exact: true })
        .waitFor();
      await page.screenshot({
        animations: "disabled",
        path: `${artifacts}/attachment-recovered-after-reload.png`,
      });
      await expectRequestCountStable(gateway, "chat.send", 0);
    } finally {
      await suite.closeBrowserContext(context);
    }
  });
});
