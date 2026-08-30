import { mkdir } from "node:fs/promises";
import { expect, it } from "vitest";
import { controlUiBundledGatewayUrl } from "../test-helpers/control-ui-e2e.ts";
import {
  controlUiSessionUrl,
  createChatFlowE2eSuite,
  expectRequestCountStable,
  installMockGateway,
  requireRecord,
} from "./chat-flow.test-support.ts";

const suite = createChatFlowE2eSuite();
const artifacts = ".artifacts/mock-session-owner/outbox-recovery";

suite.define(() => {
  it("keeps a legacy uncertain send unsent until destination confirmation and explicit Retry", async () => {
    await mkdir(artifacts, { recursive: true });
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
    const context = await suite.newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { width: 1280, height: 900 },
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page);
    const gatewayAddress = controlUiBundledGatewayUrl(suite.server.baseUrl);
    try {
      await page.goto(`${suite.server.baseUrl}settings`);
      await page.evaluate(async (gatewayOwner) => {
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
      }, gatewayAddress);
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
