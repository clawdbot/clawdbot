import path from "node:path";
import type { Page } from "playwright";
import { expect, it } from "vitest";
import {
  chatSessionListResponse,
  createChatFlowE2eSuite,
  installMockGateway,
} from "./chat-flow.test-support.ts";
import { createControlUiE2eContextOptions } from "./control-ui-e2e-suite.test-support.ts";

const suite = createChatFlowE2eSuite();

async function captureHistoryIssuanceProof(page: Page, name: string): Promise<void> {
  const artifactDir = process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR?.trim()
    ? suite.artifactDir
    : undefined;
  if (!artifactDir) {
    return;
  }
  await page.screenshot({ fullPage: true, path: path.join(artifactDir, `${name}.png`) });
}

suite.define(() => {
  it.each(["named", "short"] as const)(
    "retains deferred history across %s chat canonicalization",
    async (reference) => {
      const context = await suite.newBrowserContext(createControlUiE2eContextOptions());
      const page = await context.newPage();
      const sessionKey = "agent:main:dashboard:12345678-90ab-cdef-1234-567890abcdef";
      const marker = "The selected conversation survived canonical navigation.";
      const gateway = await installMockGateway(page, {
        sessionKey: "agent:main:main",
        historyMessages: [{ role: "assistant", content: "Initial conversation." }],
        sessionTranscripts: {
          [sessionKey]: { messages: [{ role: "assistant", content: marker }] },
        },
        methodResponses: {
          "sessions.list": chatSessionListResponse([
            {
              key: sessionKey,
              kind: "direct",
              label: "Canonical history",
              displayName: "Canonical history",
              updatedAt: 1,
            },
          ]),
          "sessions.resolve": {
            ok: true,
            key: sessionKey,
            agentId: "main",
            displayName: "Canonical history",
          },
        },
      });
      const referencePath = `chat/main/${reference === "named" ? "canonical-history" : "old-name-12345678"}`;
      const canonicalPath = new URL("chat/main/canonical-history-12345678", suite.server.baseUrl)
        .pathname;
      try {
        await page.goto(`${suite.server.baseUrl}chat/main`, { waitUntil: "domcontentloaded" });
        await page
          .locator(".chat-thread")
          .getByText("Initial conversation.")
          .waitFor({ state: "visible" });
        const initialStartups = (await gateway.getRequests("chat.startup")).length;
        await gateway.deferNext("chat.startup");
        await page.evaluate((pathname) => {
          const app = document.querySelector("openclaw-app") as HTMLElement & {
            runtime: {
              context: { navigate: (routeId: string, options: { pathname: string }) => void };
            };
          };
          app.runtime.context.navigate("chat", { pathname });
        }, new URL(referencePath, suite.server.baseUrl).pathname);
        await gateway.waitForRequest("chat.startup", { after: initialStartups });
        if (reference === "named") {
          await page.waitForURL((url) => url.pathname === canonicalPath, {
            waitUntil: "domcontentloaded",
          });
          expect(await gateway.getRequests("chat.startup")).toHaveLength(initialStartups + 1);
        }
        await gateway.resolveDeferred("chat.startup");
        await page.waitForURL((url) => url.pathname === canonicalPath, {
          waitUntil: "domcontentloaded",
        });
        await page
          .locator(".chat-pane-cache__pane--active .chat-thread")
          .getByText(marker)
          .waitFor({ state: "visible" });
        await page.waitForFunction(
          (key) =>
            [...document.querySelectorAll<HTMLElement>("openclaw-chat-pane")].some(
              (pane) =>
                pane.classList.contains("chat-pane-cache__pane--visible") &&
                (pane as HTMLElement & { sessionKey?: string }).sessionKey === key,
            ),
          sessionKey,
        );
        expect(await gateway.getRequests("chat.startup")).toHaveLength(initialStartups + 1);
        expect(await gateway.getRequests("sessions.resolve")).toHaveLength(
          reference === "named" ? 1 : 0,
        );
        await captureHistoryIssuanceProof(page, `canonical-${reference}-history`);
      } finally {
        await suite.closeBrowserContext(context);
      }
    },
  );

  it("renders a failed history load in the transcript and retries it", async () => {
    const context = await suite.newBrowserContext(createControlUiE2eContextOptions());
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      deferredMethods: ["chat.startup"],
      historyMessages: [
        {
          content: [{ text: "Transcript recovered after retry.", type: "text" }],
          role: "assistant",
          timestamp: Date.now(),
        },
      ],
    });

    try {
      await page.goto(`${suite.server.baseUrl}chat`);
      await gateway.waitForRequest("chat.startup");
      await gateway.rejectDeferred("chat.startup", {
        code: "GATEWAY_UNAVAILABLE",
        message: "Chat history is temporarily unavailable.",
      });

      const historyError = page.locator(".chat-history-error");
      await historyError.waitFor({ state: "visible", timeout: 5_000 });
      expect(await historyError.textContent()).toContain(
        "Chat history is temporarily unavailable.",
      );
      expect(await gateway.getRequests("chat.startup")).toHaveLength(1);
      await captureHistoryIssuanceProof(page, "01-history-load-failed");

      await gateway.deferNext("chat.startup");
      await historyError.getByRole("button", { name: "Retry" }).click();
      await gateway.waitForRequest("chat.startup", { after: 1 });
      await historyError.waitFor({ state: "detached" });
      await page
        .locator('.chat-thread openclaw-panel-loading-skeleton[data-panel-skeleton="chat"]')
        .waitFor({ state: "visible" });
      await gateway.resolveDeferred("chat.startup");
      await page
        .locator(".chat-thread")
        .getByText("Transcript recovered after retry.")
        .waitFor({ state: "visible" });

      expect(await gateway.getRequests("chat.startup")).toHaveLength(2);
      expect(await page.locator(".chat-history-error").count()).toBe(0);
      await captureHistoryIssuanceProof(page, "02-history-load-retried");
    } finally {
      await suite.closeBrowserContext(context);
    }
  });

  it("automatically resumes retryable history failures once after reconnect", async () => {
    const context = await suite.newBrowserContext(createControlUiE2eContextOptions());
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      deferredMethods: ["chat.startup"],
      historyMessages: [
        {
          content: [{ text: "Transcript recovered after reconnect.", type: "text" }],
          role: "assistant",
          timestamp: Date.now(),
        },
      ],
    });

    try {
      await page.goto(`${suite.server.baseUrl}chat`);
      await gateway.waitForRequest("chat.startup");
      await gateway.rejectDeferred("chat.startup", {
        code: "GATEWAY_UNAVAILABLE",
        message: "Chat history will recover after reconnect.",
        retryable: true,
      });

      const historyError = page.locator(".chat-history-error");
      await historyError.waitFor({ state: "visible", timeout: 5_000 });
      expect(await historyError.textContent()).toContain(
        "Chat history will recover after reconnect.",
      );
      expect(await gateway.getRequests("chat.startup")).toHaveLength(1);

      await gateway.setOnline(false);
      expect(await gateway.getRequests("chat.startup")).toHaveLength(1);
      await gateway.setOnline(true);
      await gateway.waitForRequest("chat.startup", { after: 1 });
      await page
        .locator(".chat-thread")
        .getByText("Transcript recovered after reconnect.")
        .waitFor({ state: "visible" });

      expect(await gateway.getRequests("chat.startup")).toHaveLength(2);
      expect(await page.locator(".chat-history-error").count()).toBe(0);
      await captureHistoryIssuanceProof(page, "03-history-load-auto-resumed");
    } finally {
      await suite.closeBrowserContext(context);
    }
  });
  it("keeps cached history visible and actionable when a refresh fails", async () => {
    const context = await suite.newBrowserContext(createControlUiE2eContextOptions());
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      historyMessages: [
        {
          content: [{ text: "Cached transcript stays visible.", type: "text" }],
          role: "assistant",
          timestamp: Date.now(),
        },
      ],
    });

    try {
      await page.goto(`${suite.server.baseUrl}chat`);
      const cachedMessage = page
        .locator(".chat-thread")
        .getByText("Cached transcript stays visible.");
      await cachedMessage.waitFor({ state: "visible" });

      await gateway.deferNext("chat.startup");
      await gateway.setOnline(false);
      await gateway.setOnline(true);
      await gateway.waitForRequest("chat.startup", { after: 1 });
      await gateway.rejectDeferred("chat.startup", {
        code: "GATEWAY_ERROR",
        message: "History refresh failed.",
        retryable: false,
      });

      const inlineError = page.locator(".chat-history-error--inline");
      await inlineError.waitFor({ state: "visible", timeout: 5_000 });
      expect(await inlineError.textContent()).toContain("History refresh failed.");
      // The stale transcript must not be displaced by the failure surface.
      await cachedMessage.waitFor({ state: "visible" });
      await captureHistoryIssuanceProof(page, "04-history-refresh-failed-cached");

      const startupCount = (await gateway.getRequests("chat.startup")).length;
      await inlineError.getByRole("button", { name: "Retry" }).click();
      await gateway.waitForRequest("chat.startup", { after: startupCount });
      await inlineError.waitFor({ state: "hidden", timeout: 5_000 });
      await cachedMessage.waitFor({ state: "visible" });
    } finally {
      await suite.closeBrowserContext(context);
    }
  });
});
