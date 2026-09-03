import path from "node:path";
import { expect, it } from "vitest";
import {
  CHAT_SNAPSHOT_DB_NAME,
  CHAT_SNAPSHOT_STORE_NAME,
} from "../pages/chat/session-snapshot-database.ts";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import {
  createChatFlowE2eSuite,
  installMockGateway,
  requireRecord,
  waitForChatScrollIdle,
  waitForRequests,
} from "./chat-flow.test-support.ts";

const suite = createChatFlowE2eSuite();
const sessionId = "durable-geometry-session";

function historyMessage(seq: number, text: string) {
  return {
    __openclaw: { id: `durable-geometry-${seq}`, seq },
    content: [{ type: seq % 2 === 0 ? "output_text" : "input_text", text }],
    role: seq % 2 === 0 ? "assistant" : "user",
    timestamp: 1_800_000_000_000 + seq,
  };
}

suite.define(() => {
  it("discards stale transcript geometry before restored history bootstrap", async () => {
    const artifactRoot = process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR?.trim();
    const artifactDir = artifactRoot
      ? createControlUiE2eArtifactDir("chat-history-stale-geometry", artifactRoot)
      : undefined;
    const context = await suite.newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 600, width: 520 },
      ...(artifactDir
        ? { recordVideo: { dir: artifactDir, size: { height: 600, width: 520 } } }
        : {}),
    });
    const page = await context.newPage();
    const proofVideo = page.video();
    const recentMessages = Array.from({ length: 16 }, (_, index) =>
      historyMessage(
        index + 3,
        `Restored message ${index + 3}: ${"prior narrow presentation text ".repeat(18)}`,
      ),
    );
    const compactRecentMessages = recentMessages.map((message, index) =>
      historyMessage(index + 3, `Restored message ${index + 3}`),
    );
    const olderMessages = [historyMessage(1, "Older 1"), historyMessage(2, "Older 2")];
    const totalMessages = compactRecentMessages.length + olderMessages.length;
    const gateway = await installMockGateway(page, {
      methodResponses: {
        "chat.startup": {
          hasMore: false,
          messages: recentMessages,
          sessionId,
          totalMessages: recentMessages.length,
        },
      },
      sessionKey: "agent:main:main",
      sessions: [{ key: "agent:main:main", sessionId }],
    });

    try {
      await page.goto(`${suite.server.baseUrl}chat`);
      await page.getByText("Restored message 18:", { exact: false }).waitFor({ timeout: 10_000 });
      const rowKeys = await page.locator(".chat-virtual-row").evaluateAll((rows) =>
        rows.flatMap((row) => {
          const key = (row as HTMLElement).dataset.virtualRowKey;
          return key ? [key] : [];
        }),
      );
      expect(rowKeys.length).toBeGreaterThan(0);
      if (artifactDir) {
        await page.screenshot({
          path: path.join(artifactDir, "00-prior-narrow-transcript.png"),
          fullPage: true,
        });
      }
      await expect
        .poll(
          () =>
            page.evaluate(
              async ({ databaseName, keys, storeName }) => {
                const database = await new Promise<IDBDatabase>((resolve, reject) => {
                  const request = indexedDB.open(databaseName);
                  request.addEventListener("success", () => resolve(request.result));
                  request.addEventListener("error", () =>
                    reject(new Error(request.error?.message ?? "snapshot database open failed")),
                  );
                });
                const transaction = database.transaction(storeName, "readwrite");
                const store = transaction.objectStore(storeName);
                const record = await new Promise<unknown>((resolve, reject) => {
                  const request = store.get("agent:main:main");
                  request.addEventListener("success", () => resolve(request.result));
                  request.addEventListener("error", () =>
                    reject(new Error(request.error?.message ?? "snapshot record read failed")),
                  );
                });
                if (!record || typeof record !== "object") {
                  database.close();
                  return false;
                }
                (record as Record<string, unknown>).rowHeights = new Map(
                  keys.map((key) => [key, 1_000]),
                );
                store.put(record);
                await new Promise<void>((resolve, reject) => {
                  transaction.addEventListener("complete", () => resolve());
                  transaction.addEventListener("error", () =>
                    reject(new Error(transaction.error?.message ?? "snapshot write failed")),
                  );
                  transaction.addEventListener("abort", () =>
                    reject(new Error(transaction.error?.message ?? "snapshot write aborted")),
                  );
                });
                database.close();
                return true;
              },
              {
                databaseName: CHAT_SNAPSHOT_DB_NAME,
                keys: rowKeys,
                storeName: CHAT_SNAPSHOT_STORE_NAME,
              },
            ),
          { timeout: 10_000 },
        )
        .toBe(true);

      await gateway.setMethodResponse("chat.startup", {
        hasMore: true,
        messages: compactRecentMessages,
        nextOffset: compactRecentMessages.length,
        sessionId,
        totalMessages,
      });
      await gateway.setMethodResponse("chat.history", {
        cases: [
          {
            match: { offset: compactRecentMessages.length, sessionKey: "agent:main:main" },
            response: { hasMore: false, messages: olderMessages, sessionId, totalMessages },
          },
        ],
      });
      const historyRequestsBeforeReload = (await gateway.getRequests("chat.history")).length;
      await page.setViewportSize({ height: 2_400, width: 1_400 });
      await page.reload();

      const requests = await waitForRequests(
        gateway,
        "chat.history",
        historyRequestsBeforeReload + 1,
      );
      expect(requireRecord(requests.at(-1)?.params)).toMatchObject({
        offset: compactRecentMessages.length,
        sessionKey: "agent:main:main",
      });
      await expect
        .poll(() =>
          page.locator(".chat-pane-cache__pane--active").evaluate((element) => {
            const pane = element as HTMLElement & { state?: { chatMessages?: unknown[] } };
            return pane.state?.chatMessages?.length ?? 0;
          }),
        )
        .toBe(totalMessages);
      await waitForChatScrollIdle(page);
      await page.getByText("Older 1", { exact: true }).waitFor();
      await page.getByText("Restored message 3", { exact: true }).waitFor();
      await expect
        .poll(() =>
          page.locator(".chat-pane-cache__pane--active .chat-thread").evaluate((element) => {
            const thread = element as HTMLElement;
            return thread.scrollHeight - thread.clientHeight;
          }),
        )
        .toBeLessThanOrEqual(1);
      if (artifactDir) {
        await page.screenshot({
          path: path.join(artifactDir, "01-restored-without-phantom-gap.png"),
          fullPage: true,
        });
      }
    } finally {
      await suite.closeBrowserContext(context);
      if (artifactDir && proofVideo) {
        await proofVideo.saveAs(path.join(artifactDir, "stale-transcript-geometry.webm"));
      }
    }
  }, 120_000);
});
